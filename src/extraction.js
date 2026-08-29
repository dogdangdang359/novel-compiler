'use strict';

// 提取器：正文章节 -> 提议 canon（LLM），含逐条证据（行号锚点）与确定性校验
// 校验是反幻觉的关键：quote 必须逐字命中对应行、行号必须在章范围内、非基线条目必须有证据。

const { validateCanon } = require('./validate');
const { parseManuscript, scanMentions, isSuppressLine, normalizeSuppressBlocks } = require('./extract');
const { estimateTokens } = require('./llm');
const { hasChanges } = require('./fields');
const { chapterKey } = require('./incremental');
const { CANON_SECTIONS, asArray } = require('./canon');

// 给手稿每行加行号前缀，作为证据锚点（豁免注释行不发给 LLM；跨行豁免注释的续行
// 先归一化为豁免行，避免续行被当作正文发给模型）
function numberLines(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  normalizeSuppressBlocks(lines);
  return lines.map((l, i) => (isSuppressLine(l) ? null : `${i + 1}|${l}`)).filter(Boolean).join('\n');
}

// 范围化：只保留 [from, to] 章的行，行号保持手稿原始编号（证据锚点不变）
function numberLinesForChapters(text, from, to) {
  const parsed = parseManuscript(text);
  const sel = parsed.chapters.filter((c) => c.number !== null && c.number >= from && c.number <= to);
  return assembleNumbered(parsed.lines, sel);
}

// 范围化（显式章集合，增量提取用；支持非连续脏章）。
// 脏章键：编号章用章号；尾声/番外/后记（number=null）用 's'+标题哈希（见 incremental.chapterKey，
// 标题是稳定身份，不随章节增删位移）
function numberLinesForChaptersSet(text, chapters) {
  const parsed = parseManuscript(text);
  const set = new Set(chapters);
  const sel = parsed.chapters.filter((c) => set.has(chapterKey(c)));
  return assembleNumbered(parsed.lines, sel);
}

// 章行号对照表（确定性文本，注入提示词）：行号化正文不含任何「第N章」标记，模型只能按
// 剧情语义猜章归属（v0.4.3 真实分块回归：11 条章归属漂移，重试无法自查修正）。对照表把
// 行号区间显式锚定到章；尾声/番外（number=null）无章号，按标题列出（校验器对 null 章
// 本就只做行号锚定）。
function chapterLineMapText(sel) {
  return sel
    .filter((c) => c.endLine >= c.startLine)
    .map((c) => `${c.number === null ? c.title : `第${c.number}章`}:行${c.startLine}-${c.endLine}`)
    .join('；');
}

const CHAPTER_MAP_NOTE = '（证据的 chapter 必须按行号所在章填写，不要按剧情语义猜章号）';

function assembleNumbered(lines, sel) {
  const out = [];
  for (const ch of sel) {
    // 章标题行按原始行号一并输出：行号化正文此前裁掉了标题行，模型在正文里看不到任何
    // 章边界，只能单靠单行对照表做「行号→章」查找（长表条目错位 1-5）。标题紧邻章首
    // 正文行出现后归章直接可见，无需查表（与全稿模式 numberLines 全行输出口径一致）。
    const hi = ch.headingLine - 1;
    if (ch.headingLine >= 1 && lines[hi] !== undefined && !isSuppressLine(lines[hi])) {
      out.push(`${ch.headingLine}|${lines[hi]}`);
    }
    for (let li = ch.startLine - 1; li < ch.endLine; li++) {
      if (isSuppressLine(lines[li])) continue; // 豁免注释行不发给 LLM
      out.push(`${li + 1}|${lines[li]}`);
    }
  }
  return { numbered: out.join('\n'), chapterNumbers: sel.map((c) => c.number), chapterMap: chapterLineMapText(sel) };
}

const SYSTEM_PROMPT = `你是「小说提取器」：把正文转成结构化设定库（canon），只提取文本中明确呈现的事实，不推测、不脑补。
你只输出一个 JSON 对象：{ "canon": {...}, "evidence": {...}, "extraction_notes": [...] }。

## canon schema（与模拟器/手写 canon 同一 schema）
{
  "meta": { "title": "书名", "target_reader": "webnovel|genre|published", "genre": "题材" },
  "entities": [ { "id": "小写字母或下划线id", "name": "名称", "aliases": ["别名"], "type": "character|location|item", "appears_from_chapter": 1 } ],
  "knowledge": [ { "id": "k1", "name": "信息名称", "terms": ["知识专属特征词"], "holders": ["实体id"], "known_from_chapter": 3 } ],
  "suspense": [ { "id": "s1", "name": "悬念名称", "planted_in_chapter": 1, "expected_resolve_chapter": 5, "resolved_in_chapter": 5 } ],
  "timeline": [ { "chapter": 1, "day": 1, "location": "实体id" } ]
}

## 提取规则
0. meta 必须与正文一致：title 与 genre 根据正文判断（书名从正文首行标题或故事主题得出），**不得沿用基线 meta 的旧书名/旧题材**。
1. entities：只收录正文中实际出现或明确提及的角色、地点、物件；appears_from_chapter = 首次出现的章号。
2. knowledge：正文中跨越章节的关键信息（秘密、地点、身份、真相、关键物件位置）。known_from_chapter = 该信息在正文中首次被角色使用/得知的章号；holders = 到该章为止已经知道它的角色 id；terms 用「知情者得知后才说/用的话」，必须能在正文中找到原文。
3. suspense：正文中埋设（出现疑问/悬念）与回收（给出答案/揭晓）的悬念；resolved_in_chapter 未回收则为 null。
4. timeline：每章一条。day = 剧情内第几天（依据"第二天/天没亮/第三天"等时间词推断；正文无时间词则沿用上一章）；location = 本章主要场景对应的 location 实体 id（无匹配则新建 location 实体）。
5. 证据：canon 中每条【新增条目】（非基线条目）与每条 timeline 都必须给出证据数组 [{ "chapter": 章号, "line": 行号, "quote": "该行正文片段" }]。line 必须是手稿中的真实行号；quote 必须逐字出现在该行中（不含行号前缀）。
6. 基线保留：若提供了已有 canon（基线），其中所有条目的 id 与 name 必须原样保留（不得删除、不得改名），允许按正文修正字段值（如 known_from_chapter）。
7. 基线条目的任何字段修正都必须附证据（evidence 中给出该条目），且证据必须落在提取范围内；范围外条目一律按基线原样保留。
8. 若基线中的某些条目（尤其是悬念）在正文中完全没有对应内容（旧故事残留），请在顶层输出 retired 字段列出其 id：{ "retired": { "suspense": ["id", ...] } }。只列基线中存在且确实无对应内容的悬念 id；实体与知识不要列在这里（由确定性清理处理）。

## evidence 结构
{ "entities": { "实体id": [{chapter,line,quote}...] }, "knowledge": { "知识id": [...] }, "suspense": { "悬念id": [...] }, "timeline": { "章号": [{chapter,line,quote}...] } }
`;

function buildExtractPrompt({ manuscript, baseline, cfg, range }) {
  const rangeNote = range
    ? `【提取范围】仅第${range.from} 至 第${range.to} 章。范围外章节的条目一律按基线原样保留，不得修正字段；对基线条目的任何字段修正必须附上范围内证据。`
    : '【提取范围】全文。';
  const isSet = range && Array.isArray(range.chapters);
  let body;
  let chapterMap;
  if (range) {
    const assembled = isSet ? numberLinesForChaptersSet(manuscript, range.chapters) : numberLinesForChapters(manuscript, range.from, range.to);
    body = assembled.numbered;
    chapterMap = assembled.chapterMap;
  } else {
    body = numberLines(manuscript);
    chapterMap = chapterLineMapText(parseManuscript(manuscript).chapters);
  }
  const mapNote = chapterMap ? `【章行号对照】${chapterMap}\n${CHAPTER_MAP_NOTE}` : '';
  const user = [
    `【目标读者】${cfg.label}`,
    rangeNote,
    ...(mapNote ? [mapNote] : []),
    baseline
      ? `【已有 canon（基线，必须保留其全部条目的 id 与 name）】\n${JSON.stringify(baseline, null, 2)}`
      : '【已有 canon】无',
    `【正文（行号|内容，行号即证据锚点）${range ? `· 仅第${isSet ? range.chapters.join('、') : `${range.from}-${range.to}`}章` : ''}】`,
    '```',
    body,
    '```',
    '【要求】只输出 JSON：{ "canon": {...}, "evidence": {...}, "extraction_notes": [...] }',
  ].join('\n\n');
  return { system: SYSTEM_PROMPT, user };
}

function baseIdsOf(baseline) {
  const out = { entities: new Set(), knowledge: new Set(), suspense: new Set() };
  if (baseline) {
    for (const section of Object.keys(out)) {
      asArray(baseline[section]).forEach((x) => out[section].add(x.id));
    }
  }
  return out;
}

/**
 * 确定性校验（反幻觉）：
 * - canon schema 合法
 * - 基线保留：基线所有条目 id 必须存在
 * - 证据：非基线条目必须有证据；quote 逐字命中对应行；行号与声明章号一致
 * - timeline：每条都要证据，行号必须落在该章范围内
 */
function validateExtraction(raw, { baseline, manuscript, range }) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return ['输出不是 JSON 对象'];
  if (!raw.canon || typeof raw.canon !== 'object') errors.push('缺少 canon');
  if (!raw.evidence || typeof raw.evidence !== 'object') errors.push('缺少 evidence');
  if (!Array.isArray(raw.extraction_notes)) errors.push('extraction_notes 必须是数组');
  if (errors.length) return errors;

  const v = validateCanon(raw.canon);
  errors.push(...v.errors.map((x) => `canon: ${x}`));

  const baseIds = baseIdsOf(baseline);
  for (const section of CANON_SECTIONS) {
    const got = new Set(asArray(raw.canon[section]).map((x) => x.id));
    for (const id of baseIds[section]) if (!got.has(id)) errors.push(`canon.${section}: 基线条目 "${id}" 缺失（不得删除基线）`);
  }

  // 时间线完整性：必须覆盖手稿全部章节；基线时间线的章节也不得丢失（范围外靠基线携带）。
  // range 模式（分块批/手动范围/增量脏章）只强制覆盖范围内章——模型看不到范围外章节，
  // 空基线时范围外无携带来源，若仍要求全稿覆盖则首批必然失败（结构性错误，重试无解）；
  // 全稿覆盖由「每批范围完整性 + 批间链式合并（前批输出成为后批基线，L137 保证不丢）」累积保证
  const inRangeCh = (n) => !range
    || (Array.isArray(range.chapters) ? range.chapters.includes(n) : (n >= range.from && n <= range.to));
  const msChapters = parseManuscript(manuscript).chapters.filter((c) => c.number !== null && inRangeCh(c.number)).map((c) => c.number);
  const haveTl = new Set(asArray(raw.canon.timeline).map((t) => t.chapter));
  for (const n of msChapters) if (!haveTl.has(n)) errors.push(`canon.timeline: 缺少正文已有的第${n}章（时间线必须每章一条）`);
  // 基线时间线完整性：范围内章必须出现在模型输出中；范围外章由基线携带（merge 阶段补回），
  // 不要求模型输出——模型看不到范围外章节，强制要求会产生不可解的结构性错误。
  if (baseline) for (const t of asArray(baseline.timeline)) if (inRangeCh(t.chapter) && !haveTl.has(t.chapter)) errors.push(`canon.timeline: 缺少基线已有的第${t.chapter}章`);

  // retired 校验：只能列出基线中真实存在的悬念 id
  if (raw.retired !== undefined) {
    if (!raw.retired || typeof raw.retired !== 'object' || !Array.isArray(raw.retired.suspense)) {
      errors.push('retired.suspense 必须是数组');
    } else {
      const baseS = new Set(baseIds.suspense);
      for (const id of raw.retired.suspense) if (!baseS.has(id)) errors.push(`retired.suspense: "${id}" 不是基线条目`);
    }
  }

  if (errors.length) return errors;

  // 行号归属（范围纪律与证据检查共用；提前定义，evInRange 也需要）
  const parsed = parseManuscript(manuscript);
  const lines = parsed.lines;
  const chapterOfLine = (n) => parsed.chapters.find((c) => c.headingLine <= n && n <= c.endLine);

  // 范围纪律（增量提取）：证据必须在范围内；基线条目字段修正必须有范围内证据背书
  // range 支持 { from, to } 或 { chapters: [] }（显式脏章集合，含 's'+标题哈希 的番外键）
  const inRange = (ch) => Number.isInteger(ch) && (
    Array.isArray(range.chapters) ? range.chapters.includes(ch) : (ch >= range.from && ch <= range.to)
  );
  if (range) {
    // 证据在范围内判定：编号章按章号；番外/尾声（chapter=null）按行号归属章 + 脏番外键
    // （旧实现 Number.isInteger 直接拒掉 null 章证据——脏番外里修正基线条目会被误拒并重试到死）
    const evInRange = (section, id) => {
      const list = raw.evidence[section] && raw.evidence[section][id];
      if (!Array.isArray(list)) return false;
      return list.some((e) => {
        if (inRange(e.chapter)) return true;
        if (e.chapter !== null && e.chapter !== undefined) return false;
        if (!Array.isArray(range.chapters) || !Number.isInteger(e.line)) return false;
        const ch = chapterOfLine(e.line);
        return !!ch && ch.number === null && range.chapters.includes(chapterKey(ch));
      });
    };
    for (const section of CANON_SECTIONS) {
      const bm = new Map(asArray(baseline ? baseline[section] : null).map((x) => [x.id, x]));
      for (const item of asArray(raw.canon[section])) {
        const b = bm.get(item.id);
        if (!b) continue;
        const changed = Object.keys(item).some((k) => JSON.stringify(b[k]) !== JSON.stringify(item[k]));
        if (changed && !evInRange(section, item.id)) {
          errors.push(`range: ${section}.${item.id} 的字段被修正但证据不在提取范围内（范围外条目不修正）`);
        }
      }
    }
    const btl = new Map(asArray(baseline ? baseline.timeline : null).map((t) => [t.chapter, t]));
    for (const t of asArray(raw.canon.timeline)) {
      const b = btl.get(t.chapter);
      if (!b) {
        if (!inRange(t.chapter)) errors.push(`range: 范围外新增 timeline 第${t.chapter}章`);
        continue;
      }
      const changed = Object.keys(t).some((k) => JSON.stringify(b[k]) !== JSON.stringify(t[k]));
      if (changed && !inRange(t.chapter)) errors.push(`range: timeline 第${t.chapter}章被修正但不在提取范围内`);
    }
  }

  // 引文匹配：先字面，再"去引号/空白/星号"规范化（模型常省略或改写引号字符——
  // JSON 模式下会把正文的直双引号 " 转写为 ' 规避转义，也会丢弃 markdown 加粗 **——
  // 引号风格与排版标记不算字词差异，但字词必须逐字一致）
  const norm = (s) => s.replace(/[“”「」‘’"'\s*]/g, '');
  // 归一化模糊锚定的最短有效字词长度：不足 3 字的引文（单字/双字）不参与归一化子串匹配——
  // 过短串在任意行命中概率高，配合同章行号自动修复会放行"词对但行错"的弱证据；
  // 字面匹配（含行号前缀）不受此限（逐字命中即真证据）。3 字是「**沉剑**阁」类加粗打断
  // 的最小锚定长度（真实回归需要它，见场景 17b）
  const MIN_ANCHOR_LEN = 3;
  const quoteHits = (quote, lineNo) => {
    if (typeof quote !== 'string' || !quote) return false;
    const rawLine = lines[lineNo - 1];
    const nq = norm(quote);
    if (!nq) return false; // 引号/空白/星号全剥后无字词可锚定（如引文只是 " * * * "）——不能命中任意行
    return rawLine.includes(quote) || `${lineNo}|${rawLine}`.includes(quote) || (nq.length >= MIN_ANCHOR_LEN && norm(rawLine).includes(nq));
  };
  // quote 未命中所引行时，用同一匹配语义在全文定位实际行号（最多列 3 处，余量报总数）：
  // 模型对「某词在第几行」没有可靠记忆——真实回归实测引对场景但行号差 1-4 行，只回该行原文时
  // 模型无从搜起；校验方持全文，报实际位置（或明示全文未出现）重试才能一轮收敛
  const locateQuote = (quote) => {
    if (typeof quote !== 'string' || !quote) return [];
    const nq = norm(quote);
    if (!nq) return [];
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = String(lines[i]);
      if (raw.includes(quote) || `${i + 1}|${raw}`.includes(quote) || (nq.length >= MIN_ANCHOR_LEN && norm(raw).includes(nq))) hits.push(i + 1);
    }
    return hits;
  };
  const quoteLocateNote = (quote) => {
    const hits = locateQuote(quote);
    if (!hits.length) return '；quote 全文未出现，请从所引行原文逐字摘取，或改引 quote 真实出现的行';
    const shown = hits.slice(0, 3).join('、');
    return `；quote 实际出现在第 ${shown} 行${hits.length > 3 ? `（共 ${hits.length} 处）` : ''}`;
  };
  // 同章行号漂移自动修复：quote 未命中所引行、且行实际属于声明章（章归属正确，仅行号在
  // 同章内漂移）时，在该章行区间内用同一匹配语义（quoteHits）查找，命中则确定性改指章内
  // 首个命中行。回归来源：章漂移修复后真实回归 run7/run8 连续两轮仅剩 1 条同型错误
  // （xue_lian_wu 引第731行、quote「血莲坞」实际在 633/637/683 行且声明章内 683 行逐字
  // 命中）——跨 run 逐字复现排除方差，是确定性锚定偏差：模型引对词但把行号锚在叙事时刻
  // 而非词面所在行，重试反馈（附实际行号、3 次机会）不收敛。校验方持全文，直接修复比重试
  // 更收敛；行不在声明章（章漂移）或章内无命中（真幻觉）仍报错——修复不得掩盖章归属错误
  const fixLineInChapter = (quote, chapterNo) => {
    if (!Number.isInteger(chapterNo)) return null;
    const ch = parsed.chapters.find((c) => c.number === chapterNo);
    if (!ch) return null;
    for (let n = ch.headingLine; n <= ch.endLine; n++) {
      if (quoteHits(quote, n)) return n;
    }
    return null;
  };
  // 修复留痕：分块模式的 extraction_notes 会被批间覆盖合并丢弃（不保证透传），但修复本身
  // 突变 raw.evidence（按引用透传到最终输出），留痕丢失只影响可观测性、不影响正确性
  const noteFix = (where, from, to, quote) => {
    if (Array.isArray(raw.extraction_notes)) {
      raw.extraction_notes.push(`[校验自动修复] ${where}: 证据行号 ${from} → ${to}（quote「${quote}」同章逐字命中）`);
    }
  };

  // 基线条目 vs 提议条目的字段级比较（证据强制判据：字段被修正的基线条目必须附证据，
  // 与提示词规则 7 一致——全量模式下同样强制，反幻觉校验不留口子）
  const baseItemOf = (section, id) => {
    if (!baseline || !Array.isArray(baseline[section])) return null;
    return baseline[section].find((x) => x.id === id) || null;
  };

  const checkOne = (section, id, item, list) => {
    const isBase = baseIds[section].has(id);
    if (isBase) {
      const b = baseItemOf(section, id);
      if (b && !hasChanges(b, item)) return; // 基线条目且未修正：不强制证据（作者权威）
    }
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`evidence.${section}["${id}"]: ${isBase ? '基线条目字段被修正但缺少证据' : '新增条目缺少证据'}`);
      return;
    }
    list.forEach((e, i) => {
      if (!e || typeof e !== 'object') return errors.push(`evidence.${section}["${id}"][${i}]: 证据必须是对象`);
      const { quote, chapter } = e;
      let line = e.line;
      if (!Number.isInteger(line) || line < 1 || line > lines.length) {
        return errors.push(`evidence.${section}["${id}"][${i}]: line 越界（${line}，手稿共 ${lines.length} 行）`);
      }
      if (!quoteHits(quote, line)) {
        // 同章行号漂移自动修复：行实际属于声明章时在该章区间内找首个逐字命中行；
        // 行不在声明章（章漂移）或章内无命中（真幻觉）仍报错——修复不得掩盖章归属错误
        const lineCh = chapterOfLine(line);
        const fixed = lineCh && lineCh.number !== null && lineCh.number === chapter
          ? fixLineInChapter(quote, chapter)
          : null;
        if (fixed) {
          noteFix(`evidence.${section}["${id}"][${i}]`, line, fixed, quote);
          e.line = fixed;
          line = fixed;
        } else {
          // 错误反馈附该行原文（截断 60 字）+ quote 实际所在行号（或明示全文未出现）：
          // 模型拿不到全文检索能力，只回「未命中」无从自查，报实际位置才能定向修正
          errors.push(`evidence.${section}["${id}"][${i}]: quote 未逐字命中第${line}行（quote："${quote}"；第${line}行原文："${String(lines[line - 1]).slice(0, 60)}"${quoteLocateNote(quote)}）`);
        }
      }
      if (chapter !== undefined) {
        const ch = chapterOfLine(line);
        if (!ch) {
          errors.push(`evidence.${section}["${id}"][${i}]: 第${line}行不属于任何章节`);
        } else if (ch.number !== null && ch.number !== chapter) {
          // 编号章（含楔子 0）：章号必须与证据声明一致
          errors.push(`evidence.${section}["${id}"][${i}]: 第${line}行属于第${ch.number}章，与声明的第${chapter}章不符`);
        } else if (ch.number !== null && range && !inRange(chapter)) {
          errors.push(`evidence.${section}["${id}"][${i}]: 证据在第${chapter}章，不在提取范围内`);
        }
        // 尾声/番外（number=null）：无章号可校验，行号锚定已足够（范围纪律按行号隐式成立）
      }
    });
  };

  for (const e of asArray(raw.canon.entities)) checkOne('entities', e.id, e, raw.evidence.entities && raw.evidence.entities[e.id]);
  for (const k of asArray(raw.canon.knowledge)) checkOne('knowledge', k.id, k, raw.evidence.knowledge && raw.evidence.knowledge[k.id]);
  for (const s of asArray(raw.canon.suspense)) checkOne('suspense', s.id, s, raw.evidence.suspense && raw.evidence.suspense[s.id]);

  for (const t of asArray(raw.canon.timeline)) {
    // 范围外章节：基线原样携带，不要求证据（范围纪律检查已保证未被修改）
    if (range && !inRange(t.chapter)) continue;
    const list = raw.evidence.timeline && raw.evidence.timeline[String(t.chapter)];
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`evidence.timeline[第${t.chapter}章]: 缺少证据`);
      continue;
    }
    list.forEach((e, i) => {
      if (!e || typeof e !== 'object') return errors.push(`evidence.timeline[第${t.chapter}章][${i}]: 证据必须是对象`);
      const { quote } = e;
      let line = e.line;
      if (!Number.isInteger(line) || line < 1 || line > lines.length) {
        return errors.push(`evidence.timeline[第${t.chapter}章][${i}]: line 越界（${line}）`);
      }
      if (!quoteHits(quote, line)) {
        // 同章行号漂移自动修复（与 checkOne 同纪律）：行实际属于该章时才修复，
        // 章漂移与真幻觉仍报错
        const lineCh = chapterOfLine(line);
        const fixed = lineCh && lineCh.number === t.chapter ? fixLineInChapter(quote, t.chapter) : null;
        if (fixed) {
          noteFix(`evidence.timeline[第${t.chapter}章][${i}]`, line, fixed, quote);
          e.line = fixed;
          line = fixed;
        } else {
          errors.push(`evidence.timeline[第${t.chapter}章][${i}]: quote 未命中第${line}行（quote："${quote}"；第${line}行原文："${String(lines[line - 1]).slice(0, 60)}"${quoteLocateNote(quote)}）`);
        }
      }
      const ch = chapterOfLine(line);
      if (!ch || ch.number !== t.chapter) {
        // 错误反馈附实际章号：章归属漂移类错误（声明章 ≠ 行实际章）模型才能定向修正
        const actual = ch ? (ch.number === null ? `「${ch.title}」（无编号章）` : `第${ch.number}章`) : '任何章（该行不属于正文）';
        errors.push(`evidence.timeline[第${t.chapter}章][${i}]: 第${line}行不在第${t.chapter}章范围内（实际属于${actual}）`);
      }
    });
  }
  return errors;
}

// 全量提取的分块规划（纯函数）：当「正文 + 完整基线 canon」估算超预算时，按章切成连续批次。
// 每批的提示词携带该批行号化文本 + 完整基线（批次间以合并后的 canon 作为下一批基线，保证
// 批内「基线保留 + 字段修正须有证据」纪律与单次提取一致）。
// 返回 [{from, to, tokens}, ...]；≤1 批返回 null（不分块，走单次调用）。
// 注意：分块要求已有基线（无基线时模型看不到范围外章节，无法满足时间线完整性校验）。
// 估算口径与实际提示词一致：章节按行号化文本（行号前缀 N| 计入），头部含 SYSTEM_PROMPT——
// 旧实现按裸章节文本估算且漏系统提示词，2569 行约低估 4~5k tokens，导致 47.7k 估成
// "未超 48k 预算"不分块、实际提示词 51.6k 贴上下文上限（输出预算升级即 HTTP 400）
function planExtractionChunks({ manuscript, baseline, maxTokens }) {
  const parsed = parseManuscript(manuscript);
  const chapters = parsed.chapters.filter((c) => c.number !== null);
  if (!chapters.length) return null;
  const budget = maxTokens || 48000;
  // 头部含 SYSTEM_PROMPT 与章行号对照表（对照表按全稿章节估算——分块批只带批内章的子集，
  // 全稿口径保守高估，只会提前分块不会漏分）
  const headTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(
    `【目标读者】webnovel【提取范围】仅第 1 至 9999 章【已有 canon（基线，必须保留其全部条目的 id 与 name）】`
    + (baseline ? JSON.stringify(baseline, null, 2) : '')
    + `【章行号对照】${chapterLineMapText(parsed.chapters)}\n${CHAPTER_MAP_NOTE}`
    + `【正文（行号|内容，行号即证据锚点）】【要求】只输出 JSON：{ "canon": {...}, "evidence": {...}, "extraction_notes": [...] }`,
  );
  const chunks = [];
  let cur = null;
  for (const ch of chapters) {
    // 复用 assembleNumbered（与实际发送的正文完全同口径），行号前缀与换行都计入估算
    const chTokens = estimateTokens(assembleNumbered(parsed.lines, [ch]).numbered);
    if (!cur) cur = { from: ch.number, to: ch.number, tokens: headTokens + chTokens };
    else if (cur.tokens + chTokens <= budget) { cur.to = ch.number; cur.tokens += chTokens; }
    else {
      chunks.push({ from: cur.from, to: cur.to, tokens: cur.tokens });
      cur = { from: ch.number, to: ch.number, tokens: headTokens + chTokens };
    }
  }
  if (cur) chunks.push({ from: cur.from, to: cur.to, tokens: cur.tokens });
  return chunks.length > 1 ? chunks : null;
}

// 僵尸清理：正文中完全没有出现、且不是"未来出场/未来获知"设定的条目
// 解决「换作品/大改后，基线保留导致旧故事条目永远残留」的同步问题。
// 依赖感知（迭代直到稳定）：
//   实体   - 名称+别名全稿零提及 且 (无 appears_from_chapter 或 已到期) → 移除
//           时间线引用的地点实体豁免（它在使用中，哪怕名字不是连续字符串）
//   知识   - 特征词全部未在正文出现 且 (无 known_from_chapter 或 已到期) → 移除
//           或 holders 引用了被移除的实体（主体已消失）→ 移除
//   时间线 - 条目永不删除（保证每章一条）；location 引用被移除实体时仅清空 location 字段
// 若清理后 canon 无法通过 schema 校验 → 整体回退（保守：不清理）
// 返回 { removed: {entities[], knowledge[], timeline[]}, canon: 新 canon, reverted: bool }
function purgeStale(canon, manuscript) {
  const parsed = parseManuscript(manuscript);
  const last = parsed.chapters.reduce((mx, c) => (c.number !== null ? Math.max(mx, c.number) : mx), 0);
  // 豁免注释是元数据而非正文：术语/holder 提及必须按「可见文本」统计，
  // 否则豁免块里出现的术语会误保知识（scanMentions 对实体已跳过豁免行，术语必须一致）
  const visibleText = parsed.lines.filter((l) => !isSuppressLine(l)).join('\n');
  const mentions = scanMentions(parsed.chapters, asArray(canon.entities), parsed.lines);
  const out = JSON.parse(JSON.stringify(canon));
  const removed = { entities: [], knowledge: [], timeline: [] };

  let changed = true;
  while (changed) {
    changed = false;
    const protectedLocations = new Set(asArray(out.timeline).map((t) => t.location).filter((x) => x !== undefined));
    // 依赖感知（反向）：术语仍在正文出现（活跃）或未到期的知识，其 holders 实体受保护。
    // 否则「实体零提及被删 → 活跃知识因 holderGone 连带删除」会误伤仍在正文中活跃的知识
    // （例：知识「蛊毒」术语在正文出现，但 holder 角色全稿未被命名——知识活、实体死，不该互相拖累）
    const protectedHolders = new Set();
    if (Array.isArray(out.knowledge)) {
      for (const k of out.knowledge) {
        const terms = asArray(k.terms).filter((t) => t);
        const due = k.known_from_chapter === undefined || k.known_from_chapter <= last;
        const active = !due || !terms.length || terms.some((t) => visibleText.includes(t));
        if (active) for (const h of asArray(k.holders)) protectedHolders.add(h);
      }
    }
    if (Array.isArray(out.entities)) {
      const before = out.entities.length;
      out.entities = out.entities.filter((e) => {
        const m = mentions.get(e.id);
        const inUse = protectedLocations.has(e.id) || protectedHolders.has(e.id);
        const keep = inUse || (m && m.total > 0) || (e.appears_from_chapter !== undefined && e.appears_from_chapter > last);
        if (!keep) removed.entities.push(e.id);
        return keep;
      });
      if (out.entities.length !== before) changed = true;
    }
    const goneIds = new Set(removed.entities);
    if (Array.isArray(out.knowledge)) {
      const before = out.knowledge.length;
      out.knowledge = out.knowledge.filter((k) => {
        const terms = asArray(k.terms).filter((t) => t);
        const termAbsent = (!terms.length) ? false : !terms.some((t) => visibleText.includes(t));
        const holderGone = asArray(k.holders).some((h) => goneIds.has(h));
        const due = k.known_from_chapter === undefined || k.known_from_chapter <= last;
        const keep = !(holderGone || (termAbsent && due));
        if (!keep) removed.knowledge.push(k.id);
        return keep;
      });
      if (out.knowledge.length !== before) changed = true;
    }
    if (Array.isArray(out.timeline)) {
      for (const t of out.timeline) {
        if (t.location !== undefined && goneIds.has(t.location)) {
          removed.timeline.push(t.chapter);
          delete t.location; // 保条目（时间线完整性），只清空失效 location
          changed = true;
        }
      }
    }
  }

  const v = validateCanon(out);
  if (!v.ok) {
    return { removed: { entities: [], knowledge: [], timeline: [] }, canon: JSON.parse(JSON.stringify(canon)), reverted: true, reason: v.errors[0] };
  }
  return { removed, canon: out, reverted: false };
}

// 提取结果 vs 基线的变更摘要（作者审阅用）
function summarizeChanges(baseline, canon) {
  const out = { added: { entities: [], knowledge: [], suspense: [] }, modified: [] };
  for (const section of CANON_SECTIONS) {
    const bm = new Map();
    if (baseline) asArray(baseline[section]).forEach((x) => bm.set(x.id, x));
    for (const item of asArray(canon[section])) {
      const b = bm.get(item.id);
      if (!b) { out.added[section].push(item.id); continue; }
      const changed = {};
      for (const key of Object.keys(item)) {
        if (JSON.stringify(b[key]) !== JSON.stringify(item[key])) changed[key] = [b[key], item[key]];
      }
      if (Object.keys(changed).length) out.modified.push({ section, id: item.id, changed });
    }
  }
  return out;
}

module.exports = { buildExtractPrompt, validateExtraction, summarizeChanges, purgeStale, numberLines, numberLinesForChapters, numberLinesForChaptersSet, assembleNumbered, planExtractionChunks, SYSTEM_PROMPT };
