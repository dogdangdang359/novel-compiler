'use strict';

// 剧情健康度雷达舱（纯函数）：从 canon 推导章节结构记分卡。
// 零依赖、确定性、无副作用 —— 供 /api/health 端点与测试共用。
//
// 指标口径（与世界观图谱/编译风险一致）：
//   · resolved  有 resolved_in_chapter
//   · overdue   已设 expected_resolve_chapter 却仍未收（expected <= planted）
//   · in-flight 设了埋点、有明确预期落点（expected > planted）、尚未回收
//   · dangling  未设预期落点、尚未回收
//
// 六维雷达（每维 0..1）：
//   resolve    悬念回收充分度 resolved/total
//   overdue    无过期未收堆积（过期越多越低）
//   inFlight   悬念"有据可依"占比（已回收或在飞，即无悬空无过期）
//   cast       活角色聚集度（实体规模，满 5 位为佳）
//   world      世界观铺陈（knowledge 条数，满 6 条为佳）
//   coverage   时间线章节覆盖（覆盖章节数/总章节数）

const asArray = (x) => (Array.isArray(x) ? x : []);
const fin = (n) => Number.isFinite(n);
const min = Math.min, max = Math.max, round = Math.round;

function chapterRange(canon) {
  let lo = Infinity, hi = -Infinity;
  const feed = (n) => { if (fin(n)) { if (n < lo) lo = n; if (n > hi) hi = n; } };
  for (const e of asArray(canon.entities)) feed(e.appears_from_chapter);
  for (const k of asArray(canon.knowledge)) feed(k.known_from_chapter);
  for (const s of asArray(canon.suspense)) { feed(s.planted_in_chapter); feed(s.expected_resolve_chapter); feed(s.resolved_in_chapter); }
  for (const t of asArray(canon.timeline)) feed(t.chapter);
  return [fin(lo) ? lo : 1, fin(hi) ? hi : 1];
}

/**
 * 从 canon 推导剧情健康度报告。
 * @param {object} canon - canon.json（含 entities/knowledge/suspense/timeline/meta）
 * @returns {object} 健康度报告（评分、六维雷达、逐章序列、警戒清单）
 */
function buildHealthReport(canon) {
  const entities = asArray(canon.entities);
  const knowledge = asArray(canon.knowledge);
  const suspense = asArray(canon.suspense).map((s) => ({
    id: s.id, name: s.name || s.id,
    planted: s.planted_in_chapter,
    expected: s.expected_resolve_chapter,
    resolved: s.resolved_in_chapter,
  }));
  const timeline = asArray(canon.timeline);

  // ① 悬念分类
  const cat = { resolved: [], overdue: [], inflight: [], dangling: [] };
  for (const s of suspense) {
    if (s.resolved != null) cat.resolved.push(s);
    else if (s.expected != null && s.expected <= (s.planted || 1)) cat.overdue.push(s);
    else if (s.expected != null) cat.inflight.push(s);
    else cat.dangling.push(s);
  }
  const total = suspense.length;
  const resolved = cat.resolved.length;
  const resolveRate = total ? resolved / total : (min(1, knowledge.length / 6));

  // 已回收条目的平均延迟（回收章 - 埋点章）
  const lags = cat.resolved.map((s) => (s.resolved - (s.planted || 1) + 1)).filter((n) => n >= 1);
  const avgResolutionLag = lags.length ? round(lags.reduce((a, b) => a + b, 0) / lags.length * 10) / 10 : 0;

  // ② 逐章序列（章节范围由实体/知识/悬念/时间线共同界定）
  const [lo, hi] = chapterRange(canon);
  const span = [lo, hi];
  const chapters = [];
  let cpl = 0, crs = 0, act = 0;
  for (let c = lo; c <= hi; c++) {
    const planted = suspense.filter((s) => s.planted === c).length;
    const rslvd = suspense.filter((s) => s.resolved === c).length;
    cpl += planted; crs += rslvd;
    chapters.push({
      chapter: c,
      planted, resolved: rslvd,
      backlog: cpl - crs,                    // 悬念堆积（未收净量）
      activeEntities: act += entities.filter((e) => e.appears_from_chapter === c).length, // 累计在役
      newEntities: entities.filter((e) => e.appears_from_chapter === c).length,
      newKnowledge: knowledge.filter((k) => k.known_from_chapter === c).length,
      timelineEntries: timeline.filter((t) => t.chapter === c).length,
    });
  }

  const backlogPeak = chapters.reduce((m, x) => max(m, x.backlog), 0);
  const coveredChapters = chapters.filter((c) => c.timelineEntries > 0).length;
  const coverage = chapters.length ? coveredChapters / chapters.length : 0;
  const lastEntityChapter = entities.length ? max.apply(null, entities.map((e) => e.appears_from_chapter || 1)) : lo;

  // ③ 六维雷达（各 0..1）
  const dimensions = {
    resolve: min(1, resolveRate),
    overdue: cat.overdue.length === 0 ? 1 : max(0, 1 - cat.overdue.length * 0.2),
    inFlight: total ? (resolved + cat.inflight.length) / total : min(1, knowledge.length / 6),
    cast: min(1, entities.length / 5),
    world: min(1, knowledge.length / 6),
    coverage: min(1, coverage),
  };

  // ④ 综合评分（风险维加权更高）
  const score = round(100 * (
    dimensions.resolve * 0.30 +
    dimensions.overdue * 0.25 +
    dimensions.inFlight * 0.15 +
    dimensions.cast * 0.10 +
    dimensions.world * 0.10 +
    dimensions.coverage * 0.10
  ));
  const verdict = score >= 85 ? '优秀' : score >= 70 ? '健康' : score >= 50 ? '需打磨' : '需大修';

  // ⑤ 警戒清单
  const issues = [];
  if (!total) issues.push({ level: 'info', code: 'no-suspense', text: '尚未登记任何悬念，建议为关键冲突埋设伏笔' });
  if (cat.overdue.length) for (const s of cat.overdue) {
    issues.push({ level: 'warn', code: 'overdue-suspense', text: `悬念「${s.name}」第 ${s.planted} 章埋点，已到预期落点 ${s.expected} 章仍未回收` });
  }
  if (cat.dangling.length) for (const s of cat.dangling) {
    issues.push({ level: 'info', code: 'dangling-suspense', text: `悬念「${s.name}」未设预期落点，可能成为开放式伏笔` });
  }
  if (chapters.length && coveredChapters < chapters.length) {
    const gap = chapters.filter((c) => c.timelineEntries === 0).map((c) => c.chapter).join('、');
    issues.push({ level: 'info', code: 'timeline-gap', text: `第 ${gap} 章缺时间线记录，世界流动感断档` });
  }
  if (resolved < total) issues.push({ level: 'info', code: 'unresolved', text: `仍有 ${total - resolved} 条悬念未回收（回收率 ${round(resolveRate * 100)}%）` });

  return {
    meta: {
      title: (canon.meta && canon.meta.title) || '未命名',
      chapterCount: hi - lo + 1,
      entityCount: entities.length,
      knowledgeCount: knowledge.length,
      suspenseCount: total,
      score, verdict,
      dimensions,
    },
    suspense: {
      total, resolved, overdue: cat.overdue.length, inflight: cat.inflight.length,
      dangling: cat.dangling.length, resolveRate: round(resolveRate * 100) / 100,
      avgResolutionLag,
    },
    chapters,
    curves: { backlogPeak, backlogPeakAt: backlogPeak > 0 ? chapters.reduce((m, x, i) => (x.backlog === backlogPeak ? i : m), -1) : -1, lastEntityChapter },
    span,
    issues,
  };
}

module.exports = { buildHealthReport };