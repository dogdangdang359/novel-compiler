'use strict';

// 机械比对器：预测 canon vs 实际 canon -> 偏差 problems（纯函数，无 LLM）
// 同构原则：模拟器输出 canon schema，实际写作维护的也是 canon schema，逐字段可机械比对。
// 匹配策略：先按 id，id 未命中时按 name 兜底对齐（id 差异报 info 级 diff/entity-id-drift）。

const { asArray } = require('./canon');

function toMap(arr, key) {
  const m = new Map();
  for (const item of asArray(arr)) if (item && item[key] !== undefined) m.set(item[key], item);
  return m;
}

function indexByName(arr) {
  const m = new Map();
  for (const it of asArray(arr)) if (it && typeof it.name === 'string') m.set(it.name, it);
  return m;
}

function maxTimelineChapter(canon) {
  return asArray(canon.timeline).reduce((mx, t) => Math.max(mx, t.chapter), 0);
}

const TYPE_LABEL = { character: '角色', location: '地点', item: '物件' };
const typeLabel = (e) => TYPE_LABEL[e && e.type] || '实体';

/**
 * @param {object} predicted 预测 canon（已通过 schema 校验）
 * @param {object} actual    实际 canon（已通过 schema 校验）
 * @returns {Array<{rule, severity, line, chapter, message, detail}>}
 * line 语义：diff 是 canon 条目级比对，没有正文行号——统一用 null 表示"无正文锚点"
 * （旧实现硬编码 1，JSON 消费者会误以为指向手稿第 1 行）。
 */
function diffCanons(predicted, actual) {
  const problems = [];
  const add = (rule, severity, chapter, message, detail = '') =>
    problems.push({ rule, severity, line: null, chapter, message, detail });

  const lastWritten = maxTimelineChapter(actual);
  const scope = (ch) => ch !== undefined && ch !== null && ch <= lastWritten;

  // 实际时间线为空（schema 允许 timeline: []）时 lastWritten=0，所有章级比对静默跳过——
  // 预测与实际再不一致也恒报"无偏差"，rebase 永不触发（假阴性）。预测有时间线而实际没有
  // 时明确报 warning：写作进度无从判定本身就是需要处理的偏差
  if (!asArray(actual.timeline).length && asArray(predicted.timeline).length) {
    add('diff/timeline-empty-actual', 'warning', null,
      `实际 canon 时间线为空（预测覆盖 ${asArray(predicted.timeline).length} 章），无法确定写作进度，章级比对全部跳过`,
      '若为漏登记：补全 actual canon 的 timeline（compile 会按手稿报缺章）；若确以实际为准：rebase 后重规划');
  }

  // ---- 实体 ----
  const pe = toMap(predicted.entities, 'id');
  const ae = toMap(actual.entities, 'id');
  const aeByName = indexByName(actual.entities);
  const peByName = indexByName(predicted.entities);
  const nameMatched = new Set();
  for (const [id, e] of pe) {
    const a = ae.get(id) || aeByName.get(e.name);
    if (!a) {
      if (scope(e.appears_from_chapter)) {
        add('diff/entity-absent-in-actual', 'warning', e.appears_from_chapter,
          `模拟预测的${typeLabel(e)}「${e.name}」不在实际设定中（应于第${e.appears_from_chapter}章出场）`,
          '若写作时删掉了该设定：rebase（以实际为准重新模拟）；若只是没写进 canon：补进 actual canon');
      }
      continue;
    }
    if (a.id !== id) {
      nameMatched.add(a.id);
      add('diff/entity-id-drift', 'info', e.appears_from_chapter ?? a.appears_from_chapter ?? 0,
        `${typeLabel(e)}「${e.name}」id 与预测不一致（预测 ${id} → 实际 ${a.id}），已按名称对齐比对`);
    }
    if (scope(e.appears_from_chapter) && scope(a.appears_from_chapter) && e.appears_from_chapter !== a.appears_from_chapter) {
      add('diff/entity-appears-drift', 'warning', a.appears_from_chapter,
        `「${e.name}」出场章漂移：预测第${e.appears_from_chapter}章 → 实际第${a.appears_from_chapter}章`,
        '若为有意调整：rebase；若为笔误：修正 actual canon');
    }
  }
  for (const [id, e] of ae) {
    if (pe.has(id) || nameMatched.has(id) || peByName.has(e.name)) continue;
    add('diff/entity-added-in-actual', 'info', e.appears_from_chapter ?? 0,
      `实际新增了模拟未预测的${typeLabel(e)}「${e.name}」`,
      '作者扩展（正常）；若影响主线，建议在下次模拟时补充到大纲');
  }

  // ---- 知识 ----
  const pk = toMap(predicted.knowledge, 'id');
  const ak = toMap(actual.knowledge, 'id');
  const akByName = indexByName(actual.knowledge);
  const pkByName = indexByName(predicted.knowledge);
  const kNameMatched = new Set();
  for (const [id, k] of pk) {
    const a = ak.get(id) || akByName.get(k.name);
    if (!a) {
      if (scope(k.known_from_chapter)) {
        add('diff/knowledge-absent-in-actual', 'warning', k.known_from_chapter,
          `模拟预测的知识「${k.name}」未出现在实际 canon（预期第${k.known_from_chapter}章获知）`,
          '若写作时删掉了该设定：rebase；若遗漏：补进 actual canon');
      }
      continue;
    }
    if (a.id !== id) {
      kNameMatched.add(a.id);
      add('diff/knowledge-id-drift', 'info', a.known_from_chapter ?? 0,
        `知识「${k.name}」id 与预测不一致（预测 ${id} → 实际 ${a.id}），已按名称对齐比对`);
    }
    if (scope(k.known_from_chapter) && scope(a.known_from_chapter) && k.known_from_chapter !== a.known_from_chapter) {
      add('diff/knowledge-known-drift', 'warning', a.known_from_chapter,
        `知识「${k.name}」获知章漂移：预测第${k.known_from_chapter}章 → 实际第${a.known_from_chapter}章`,
        '若为有意调整信息差节奏：rebase；若为笔误：修正 actual canon');
    }
    const ph = new Set(asArray(k.holders));
    const ah = new Set(asArray(a.holders));
    const diff = [...ph].filter((x) => !ah.has(x)).concat([...ah].filter((x) => !ph.has(x)));
    if (diff.length) {
      add('diff/knowledge-holders-drift', 'info', a.known_from_chapter,
        `知识「${k.name}」知情者与预测不一致（差异: ${diff.join(', ')}）`);
    }
  }
  for (const [id, k] of ak) {
    if (pk.has(id) || kNameMatched.has(id) || pkByName.has(k.name)) continue;
    add('diff/knowledge-added-in-actual', 'info', k.known_from_chapter ?? 0,
      `实际新增了模拟未预测的知识「${k.name}」`,
      '作者扩展（正常）；若影响主线，建议在下次模拟时补充到大纲');
  }

  // ---- 悬念 ----
  const ps = toMap(predicted.suspense, 'id');
  const as = toMap(actual.suspense, 'id');
  const asByName = indexByName(actual.suspense);
  const psByName = indexByName(predicted.suspense);
  const sNameMatched = new Set();
  for (const [id, s] of ps) {
    const a = as.get(id) || asByName.get(s.name);
    if (!a) {
      if (scope(s.planted_in_chapter)) {
        add('diff/suspense-absent-in-actual', 'warning', s.planted_in_chapter,
          `模拟预测的悬念「${s.name}」未出现在实际 canon（第${s.planted_in_chapter}章埋设）`,
          '若写作时删掉了该伏笔：rebase；若只是没登记：补进 actual canon');
      }
      continue;
    }
    if (a.id !== id) {
      sNameMatched.add(a.id);
      add('diff/suspense-id-drift', 'info', a.planted_in_chapter ?? 0,
        `悬念「${s.name}」id 与预测不一致（预测 ${id} → 实际 ${a.id}），已按名称对齐比对`);
    }
    if (scope(s.planted_in_chapter) && scope(a.planted_in_chapter) && s.planted_in_chapter !== a.planted_in_chapter) {
      add('diff/suspense-planted-drift', 'warning', a.planted_in_chapter,
        `悬念「${s.name}」埋设章漂移：预测第${s.planted_in_chapter}章 → 实际第${a.planted_in_chapter}章`);
    }
    if (s.expected_resolve_chapter !== a.expected_resolve_chapter) {
      add('diff/suspense-expected-drift', 'info', a.planted_in_chapter,
        `悬念「${s.name}」预期回收章漂移：预测第${s.expected_resolve_chapter ?? '?'}章 → 实际第${a.expected_resolve_chapter ?? '?'}章`,
        '预期回收是规划值，调整属正常（记录以便观察悬置节奏变化）');
    }
    const pResolved = s.resolved_in_chapter ?? null;
    const aResolved = a.resolved_in_chapter ?? null;
    if (pResolved !== aResolved) {
      const aDone = aResolved !== null && aResolved <= lastWritten;
      if (aDone) {
        add('diff/suspense-resolve-drift', 'warning', aResolved,
          `悬念「${s.name}」回收状态漂移：预测${pResolved === null ? '未回收' : `第${pResolved}章回收`} → 实际${aResolved === null ? '未回收' : `第${aResolved}章回收`}`,
          '实际已写完的回收与预测不一致：若有意为之（如延后悬念），rebase；若为漏写回收，回正文补');
      } else {
        add('diff/suspense-resolve-drift', 'info', a.planted_in_chapter,
          `悬念「${s.name}」回收规划与预测不同（预测${pResolved === null ? '未回收' : `第${pResolved}章`}，实际预期${aResolved === null ? '未回收' : `第${aResolved}章`}）`);
      }
    }
  }
  for (const [id, s] of as) {
    if (ps.has(id) || sNameMatched.has(id) || psByName.has(s.name)) continue;
    add('diff/suspense-added-in-actual', 'info', s.planted_in_chapter ?? 0,
      `实际新增了模拟未预测的悬念「${s.name}」`,
      '作者扩展（正常）；若影响主线，建议在下次模拟时补充到大纲');
  }

  // ---- 时间线 ----
  const pt = toMap(predicted.timeline, 'chapter');
  const at = toMap(actual.timeline, 'chapter');
  for (const [ch, a] of at) {
    const p = pt.get(ch);
    if (!p) {
      if (ch <= lastWritten) {
        add('diff/timeline-unplanned-chapter', 'info', ch,
          `实际第${ch}章的剧情时间线未在预测中出现`,
          '写作新增/改写了章节：rebase 时纳入');
      }
      continue;
    }
    if (p.day !== a.day) {
      add('diff/timeline-day-drift', 'warning', ch,
        `第${ch}章时间漂移：预测第${p.day}天 → 实际第${a.day}天`,
        '若为写作时的时间改动：rebase；若为笔误（如时间回退）：修正 actual canon（compile 会报 timeline/regression）');
    }
    if (p.location !== a.location) {
      add('diff/timeline-location-drift', 'warning', ch,
        `第${ch}章地点漂移：预测「${p.location}」→ 实际「${a.location}」`);
    }
  }
  for (const [ch, p] of pt) {
    if (!at.has(ch)) {
      if (ch > lastWritten) {
        add('diff/timeline-planned-ahead', 'info', ch,
          `预测覆盖到第${ch}章，当前实际进度第${lastWritten}章（未到期，不比对）`);
      } else {
        // 预测有、实际无、且已写章范围内：实际 timeline 缺章（漏登记或删章后未同步）
        add('diff/timeline-missing-in-actual', 'warning', ch,
          `实际时间线缺少预测的第${ch}章（预测 day=${p.day}${p.location ? `、地点「${p.location}」` : ''}）`,
          '若为删章：rebase（以实际为准）或从预测中删除该章；若为漏登记：补进 actual canon 的 timeline');
      }
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  problems.sort((x, y) => (order[x.severity] - order[y.severity]) || x.rule.localeCompare(y.rule) || x.chapter - y.chapter);
  return problems;
}

module.exports = { diffCanons, maxTimelineChapter };
