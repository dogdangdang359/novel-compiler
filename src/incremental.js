'use strict';

// 增量提取核心（纯函数，供 extract-llm 与测试使用）：
//   章节哈希 -> 脏章节检测 -> 合并 canon / 合并 evidence
// 合并判据（重要）：不看"条目所属章节是否脏"，而是看"提取结果相对基线的字段级变化"。
// 例：悬念 s1 埋设@2（干净）但在脏章 8 回收 —— 提取器更新 resolved_in_chapter=8，
//     合并按字段变化应用该更新，不会因 planted_in_chapter=2 不在脏列表而漏掉。

const { parseManuscript } = require('./extract');
const { hasChanges } = require('./fields');
const { CANON_SECTIONS, CANON_SECTIONS_ALL, asArray } = require('./canon');

// FNV-1a 32-bit
function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// 章节的稳定哈希键：编号章（含楔子 0）用章号；尾声/番外/后记（number=null）用 's' + 标题哈希。
// 不能用 index——章节增删会使番外的 index 位移，内容没变却误报脏（浪费一次重提取）。
// 标题是番外的自然身份：改名算脏（合理），内容变化走值比较，同名番外共键（罕见，最多误报不漏报）。
function chapterKey(ch) {
  return ch.number !== null ? ch.number : `s${hashText(ch.title)}`;
}

// 当前所有章节的哈希（标题 + 正文；换标题也算脏）。
// 旧实现完全跳过 number=null 章节，导致修改番外不触发增量提取（静默盲区）。
function chapterHashes(manuscript) {
  const { chapters } = parseManuscript(manuscript);
  const out = {};
  for (const ch of chapters) {
    out[chapterKey(ch)] = hashText(`${ch.title}\n${ch.text}`);
  }
  return out;
}

// 脏章节 = 当前哈希与上次不一致 + 新增章节；被删除的章节自动从新哈希中消失
// 返回 (number|string)[]：编号章为章号数字，番外/尾声为 's<hex>' 字符串
function dirtyChapters(current, old) {
  const dirty = [];
  for (const [n, h] of Object.entries(current)) {
    if (old[n] !== h) dirty.push(/^\d+$/.test(n) ? Number(n) : n);
  }
  return dirty.sort((a, b) => {
    const na = typeof a === 'number' ? a : Infinity;
    const nb = typeof b === 'number' ? b : Infinity;
    return na - nb || String(a).localeCompare(String(b));
  });
}

/**
 * 输出信封的 chapter_hashes：范围运行时只写已提取章的哈希，未提取章沿用旧哈希；
 * 无旧哈希则不写键——dirtyChapters 对缺失键天然判脏。
 * 防止"范围提取/检查点写入全文哈希 → 未提取章被洗白为干净 → 永远不提取"
 * （canon 永久缺失未提取章的实体/知识/悬念且无任何报错）。
 * @param {object} current 当前全文哈希（chapterHashes 输出）
 * @param {object|null} old 上次提取的 chapter_hashes（可 null）
 * @param {Set|null} extractedKeys 本次实际提取的哈希键集合；null = 提取了全部（直接返回 current）
 */
function mergeOutputHashes(current, old, extractedKeys) {
  if (extractedKeys === null) return current;
  // 键比较双保险：对象键是字符串（'1'），调用方可能放入数字（dirtyChapters 的 Number）
  const has = (k) => extractedKeys.has(k) || extractedKeys.has(Number(k));
  const out = {};
  for (const [k, v] of Object.entries(current)) {
    if (has(k)) out[k] = v;
    else if (old && k in old) out[k] = old[k];
    // 否则：从未提取过该章 → 不写键，下次增量判脏（安全侧）
  }
  return out;
}

// 可选字段集合：LLM 输出省略这些字段时，合并保留基线值（省略 = "未变更"，不是"删除"）。
// 在 union 语义的字段比较下，提议缺失键会判为变化并整条替换——CLI 增量路径无人把关，
// 会把基线中模型恰好省略的可选字段（如 aliases、location）静默丢掉。
const OPTIONAL_FIELDS = new Set([
  'type', 'aliases', 'appears_from_chapter',
  'terms', 'holders', 'known_from_chapter',
  'expected_resolve_chapter', 'resolved_in_chapter',
  'location',
]);

/** 合并单个条目：提议为底，基线有而提议缺失的可选字段保留基线值（深拷贝）。 */
function mergeItemFields(base, item) {
  const copy = JSON.parse(JSON.stringify(item));
  if (base && typeof base === 'object') {
    for (const k of Object.keys(base)) {
      if (OPTIONAL_FIELDS.has(k) && !(k in copy)) copy[k] = JSON.parse(JSON.stringify(base[k]));
    }
  }
  return copy;
}

/**
 * 合并 canon：基线为底 + 提取结果。
 * - 新条目：加入
 * - 基线条目：字段有变化则应用提取结果（证据已由范围纪律背书），无变化保持基线；
 *   提议缺失的可选字段保留基线值（防 LLM 省略导致字段静默丢失）
 * - timeline：逐条按章合并（同样保留缺失的可选字段如 location）
 * - meta：保留基线
 */
function mergeCanon(baseline, proposal) {
  const out = JSON.parse(JSON.stringify(baseline));
  for (const sec of CANON_SECTIONS) {
    out[sec] = asArray(out[sec]); // 先修复为真数组（后续 push/下标赋值需要）
    const idx = new Map(out[sec].map((x, i) => [x.id, i]));
    // 名称索引跳过无名字段（name 非字符串），避免 Map.get(undefined) 误匹配其他无名条目
    const nameIdx = new Map();
    for (let j = 0; j < out[sec].length; j++) {
      const x = out[sec][j];
      if (typeof x.name === 'string') nameIdx.set(x.name, j);
    }
    for (const item of asArray(proposal[sec])) {
      const i = idx.get(item.id) !== undefined ? idx.get(item.id) : (typeof item.name === 'string' ? nameIdx.get(item.name) : undefined);
      const copy = i !== undefined ? mergeItemFields(out[sec][i], item) : JSON.parse(JSON.stringify(item));
      if (i === undefined) {
        out[sec].push(copy);
      } else if (hasChanges(out[sec][i], copy)) {
        out[sec][i] = copy;
      }
    }
  }
  out.timeline = asArray(out.timeline);
  const btl = new Map(out.timeline.map((t) => [t.chapter, t]));
  const propTl = asArray(proposal.timeline);
  if (propTl.length > 0) {
    // timeline 按章 union：基线章全保留，proposal 覆盖同章（mergeItemFields 保留基线可选字段），
    // 再排序。范围/增量提取时模型只回显脏章，若用 propTl.map 整体替换会把非脏章时间线
    // 静默丢弃（校验层只强制范围内章，extraction.js 注释"范围外章由 merge 携带"须在此兑现）
    const mergedTl = new Map(btl);
    for (const t of propTl) {
      const b = btl.get(t.chapter);
      mergedTl.set(t.chapter, b ? mergeItemFields(b, t) : JSON.parse(JSON.stringify(t)));
    }
    out.timeline = [...mergedTl.values()].sort((a, b) => a.chapter - b.chapter);
  }
  // proposal.timeline 为空：保留基线时间线（调用方校验本应保证完整性，这里是函数级防呆——
  // 空数组替换会把基线时间线清空，后续 compile 报 timeline/missing 洪泛且数据静默丢失）
  out.meta = JSON.parse(JSON.stringify(baseline.meta || {}));
  return out;
}

/**
 * 合并 evidence：旧证据为底；新条目/字段变化的条目用新证据替换；脏章 timeline 证据替换。
 */
function mergeEvidence(baseEv, newEv, baselineCanon, newCanon) {
  const out = {};
  for (const sec of CANON_SECTIONS_ALL) {
    out[sec] = { ...((baseEv && baseEv[sec]) || {}) };
  }
  for (const sec of CANON_SECTIONS) {
    const bm = new Map(asArray(baselineCanon[sec]).map((x) => [x.id, x]));
    // 名称索引跳过无名字段，避免 Map.get(undefined) 误匹配
    const byName = new Map();
    for (const x of asArray(baselineCanon[sec])) {
      if (typeof x.name === 'string') byName.set(x.name, x);
    }
    for (const item of asArray(newCanon[sec])) {
      const b = bm.get(item.id) || (typeof item.name === 'string' ? byName.get(item.name) : undefined);
      const isNew = !b;
      const changed = b && hasChanges(b, item);
      if ((isNew || changed) && newEv && newEv[sec] && newEv[sec][item.id]) {
        out[sec][item.id] = newEv[sec][item.id];
      }
    }
  }
  if (newEv && newEv.timeline) {
    for (const [k, v] of Object.entries(newEv.timeline)) out.timeline[k] = v;
  }
  return out;
}

module.exports = { hashText, chapterKey, chapterHashes, dirtyChapters, mergeOutputHashes, mergeCanon, mergeEvidence, fieldsChanged: hasChanges };
