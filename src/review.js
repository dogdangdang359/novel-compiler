'use strict';

// 审阅模块：提议 canon vs 基线 -> 条目级 diff（供 IDE 审阅 UI）
// applyReview: 按审阅决定（接受/拒绝/编辑）把提议合并进基线 canon

const { unwrapEnvelope } = require('./canonio');
const { fieldsChanged } = require('./fields');
const { CANON_SECTIONS, asArray } = require('./canon');

function canonOf(x) {
  return unwrapEnvelope(x);
}
function evidenceOf(x) {
  return x && x.evidence && typeof x.evidence === 'object' ? x.evidence : {};
}

/**
 * 审阅 diff：新增/修改/未变 分组（含证据引文）
 * @returns {{sections, counts}}
 */
function reviewProposal(baseline, proposal) {
  const p = canonOf(proposal);
  const ev = evidenceOf(proposal);
  const sections = {};
  const counts = { added: 0, modified: 0, unchanged: 0, retired: 0 };

  for (const section of CANON_SECTIONS) {
    const bm = new Map(asArray(baseline[section]).map((x) => [x.id, x]));
    // 名称索引跳过无名字段，避免 Map.get(undefined) 误匹配
    const byName = new Map();
    for (const x of asArray(baseline[section])) {
      if (typeof x.name === 'string') byName.set(x.name, x);
    }
    const added = [];
    const modified = [];
    const unchanged = [];
    for (const item of asArray(p[section])) {
      const b = bm.get(item.id) || (typeof item.name === 'string' ? byName.get(item.name) : undefined);
      if (!b) {
        added.push({ id: item.id, name: item.name, item, evidence: asArray(ev[section] && ev[section][item.id]) });
        continue;
      }
      const changed = fieldsChanged(b, item);
      if (Object.keys(changed).length) {
        modified.push({ id: item.id, name: item.name, changed, item, evidence: asArray(ev[section] && ev[section][item.id]) });
      } else {
        unchanged.push(item.id);
      }
    }
    sections[section] = { added, modified, unchanged };
    counts.added += added.length;
    counts.modified += modified.length;
    counts.unchanged += unchanged.length;
  }

  const btl = new Map(asArray(baseline.timeline).map((t) => [t.chapter, t]));
  const tlAdded = [];
  const tlModified = [];
  const tlUnchanged = [];
  for (const t of asArray(p.timeline)) {
    const b = btl.get(t.chapter);
    if (!b) { tlAdded.push(t); continue; }
    const changed = fieldsChanged(b, t);
    if (Object.keys(changed).length) tlModified.push({ chapter: t.chapter, changed });
    else tlUnchanged.push(t.chapter);
  }
  sections.timeline = { added: tlAdded, modified: tlModified, unchanged: tlUnchanged };
  counts.added += tlAdded.length;
  counts.modified += tlModified.length;
  counts.unchanged += tlUnchanged.length;

  // 退役建议：信封 retired.suspense（模型建议删除的基线条目——canon 中仍存在，删不删由作者裁决）。
  // 注意：不能靠"基线有 / 提议无"推导（validateExtraction 强制回显全部基线条目，提议永不缺基线项），
  // 只能以模型显式声明的 retired 为准
  const retired = Array.isArray(proposal.retired && proposal.retired.suspense)
    ? proposal.retired.suspense
        .map((id) => {
          const b = asArray(baseline.suspense).find((x) => x.id === id);
          return b ? { id, name: b.name, item: b, evidence: asArray(ev.suspense && ev.suspense[id]) } : null;
        })
        .filter(Boolean)
    : [];
  counts.retired = retired.length;

  return { sections, counts, retired };
}

/**
 * 按审阅决定合并。decisions: [{ section, id|chapter, action: accept|reject|edit, value? }]
 * 未出现在 decisions 中的提议条目一律不采纳（默认拒绝，基线优先）。
 * edit 路径：value 必须是普通对象（排除数组），且强制保持身份字段
 * （实体/知识/悬念 id、时间线 chapter 与决定 key 一致）——编辑不能改变条目的身份，
 * 防止无 id / id 漂移条目进入 canon（合并后由调用方再做整体 schema 校验）。
 */
function applyReview(baseline, proposal, decisions) {
  const p = canonOf(proposal);
  const out = JSON.parse(JSON.stringify(baseline));
  // timeline 决定的 key 标准化：兼容 { chapter: 章号 } 与 { id: 章号 } 两种形态（API 一致性），
  // 但必须是有效非负整数——否则旧实现会拼出 `timeline|undefined` 静默当拒绝（用户以为接受了却没生效）
  const decKey = (d) => {
    if (d.section === 'timeline') {
      const raw = d.chapter !== undefined ? d.chapter : d.id;
      // 兼容数字/数字字符串（前端 id=number、测试曾用 id='1'），但 null/空串/非数字必须拒绝——
      // 否则旧实现会拼出 `timeline|undefined` 静默当拒绝（用户以为接受了却没生效）
      if (raw === null || raw === undefined || raw === '') throw new Error(`时间线审阅决定缺少 chapter，当前为 "${raw}"`);
      const ch = Number(raw);
      if (!Number.isInteger(ch) || ch < 0) throw new Error(`时间线审阅决定必须携带非负整数 chapter，当前为 "${raw}"`);
      return `timeline|${ch}`;
    }
    if (d.id === undefined || d.id === null || d.id === '') throw new Error(`审阅决定缺少 id（${d.section}）`);
    return `${d.section}|${d.id}`;
  };
  const dec = new Map(decisions.map((d) => [decKey(d), d]));
  // 退役建议集：信封 retired.suspense 中仍存在于基线的悬念 id。
  // 这些条目也必然出现在 proposal.canon（提取强制回显基线），普通循环不能按 accept 处理
  //（那会把"建议删除"当成"接受模型保留值"）——删不删由退役决定单独裁决。
  const retiredSuspense = new Set(Array.isArray(proposal.retired && proposal.retired.suspense)
    ? proposal.retired.suspense : []);
  // 退役条目不接受编辑（编辑=保留并修改，与"建议删除"语义冲突）——显式抛错而非静默按保留处理
  for (const id of retiredSuspense) {
    const d = dec.get(`suspense|${id}`);
    if (d && d.action === 'edit') {
      throw new Error(`退役条目 suspense|${id} 不支持编辑，请选择保留（reject）或退役（accept）`);
    }
  }
  // 非法 action 直接抛错（不能静默当 reject——前端拼错 action 会被无声吞掉，用户以为接受了实际被拒绝）
  const VALID_ACTIONS = new Set(['accept', 'reject', 'edit']);
  const actionOf = (section, id) => {
    const d = dec.get(`${section}|${id}`);
    if (!d) return 'reject';
    if (!VALID_ACTIONS.has(d.action)) throw new Error(`非法审阅决定 action: "${d.action}"（${section}|${id}，可选 accept/reject/edit）`);
    return d.action;
  };
  const valueOf = (section, id) => {
    const d = dec.get(`${section}|${id}`);
    return d && d.value !== undefined ? d.value : null;
  };
  // 编辑值防御：空对象 {} 是"无意义编辑"（清空编辑框的结果）——忽略（保持基线）；
  // 数组/null/非对象同样忽略；路由层另有 400 前置校验给用户明确反馈
  const editValue = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (Object.keys(v).length === 0) return null;
    return v;
  };

  for (const section of CANON_SECTIONS) {
    // 缺字段/非数组基线防御：baseline 的 section 必须是数组，否则补空
    out[section] = asArray(out[section]);
    const idx = new Map(out[section].map((x, i) => [x.id, i]));
    // 名称索引跳过无名字段，避免 Map.get(undefined) 误匹配
    const nameIdx = new Map();
    for (let j = 0; j < out[section].length; j++) {
      const x = out[section][j];
      if (typeof x.name === 'string') nameIdx.set(x.name, j);
    }
    for (const item of asArray(p[section])) {
      // 退役条目不走普通更新：由退役决定单独裁决（accept=删 / reject 或未决定=保留）
      if (section === 'suspense' && retiredSuspense.has(item.id)) continue;
      const i = idx.get(item.id) !== undefined ? idx.get(item.id) : (typeof item.name === 'string' ? nameIdx.get(item.name) : undefined);
      const action = actionOf(section, item.id);
      if (action === 'accept') {
        const copy = JSON.parse(JSON.stringify(item));
        if (i === undefined) out[section].push(copy);
        else out[section][i] = copy;
      } else if (action === 'edit') {
        const v = editValue(valueOf(section, item.id));
        if (v) {
          const copy = JSON.parse(JSON.stringify(v));
          copy.id = item.id; // 身份键以决定 key 为准，用户编辑不得改写
          if (i === undefined) out[section].push(copy);
          else out[section][i] = copy;
        }
      }
      // reject（含默认）：保持基线
    }
  }

  out.timeline = asArray(out.timeline);
  for (const t of asArray(p.timeline)) {
    const action = actionOf('timeline', t.chapter);
    if (action === 'accept') {
      const i = out.timeline.findIndex((x) => x.chapter === t.chapter);
      const copy = JSON.parse(JSON.stringify(t));
      if (i === -1) out.timeline.push(copy);
      else out.timeline[i] = copy;
    } else if (action === 'edit') {
      const v = editValue(valueOf('timeline', t.chapter));
      if (v) {
        const i = out.timeline.findIndex((x) => x.chapter === t.chapter);
        const copy = JSON.parse(JSON.stringify(v));
        copy.chapter = t.chapter; // 时间线身份键同理
        if (i === -1) out.timeline.push(copy);
        else out.timeline[i] = copy;
      }
    }
  }
  // 退役裁决：accept → 从基线删除（作者确认该伏笔已无回收价值）；reject / 未决定 → 保留
  if (retiredSuspense.size) {
    out.suspense = asArray(out.suspense);
    for (const id of retiredSuspense) {
      if (actionOf('suspense', id) === 'accept') {
        out.suspense = out.suspense.filter((s) => s.id !== id);
      }
    }
  }
  // 输出 timeline 按 chapter 排序：baseline 不连续（如 1,3,5）时 accept 新增章会追加到尾部破坏顺序
  out.timeline.sort((a, b) => a.chapter - b.chapter);
  return out;
}

module.exports = { reviewProposal, applyReview, canonOf, evidenceOf };
