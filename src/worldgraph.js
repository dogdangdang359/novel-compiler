'use strict';

// 世界观图谱推导（纯函数）：从 canon 推导实体关系网络 + 悬念开合 + 时间线流动。
// 零依赖、确定性、无副作用 —— 供 /api/worldgraph 端点与测试共用。
//
// 关系边定义（保守、确定性）：
//   · 共现边：同一 knowledge 条目的 holders 中任意两实体之间一条关系（count=共同知识条数）。
//   · 地点-实体桥：timeline.location 是 entities 里的地点 id 时，该地点按 timeline 出现章节
//     排序；不额外制造跨类型边（避免噪声），地点关联由前端按类型分簇展示。
// 节点重要度 = degree（关联边数），用于前端节点半径与排序。

const asArray = (x) => (Array.isArray(x) ? x : []);
const clamp1 = (n) => (Number.isFinite(n) ? n : 1);

/**
 * 估算实体出现章节范围：优先取实体的 appears_from_chapter；缺失时在 knowledge 的
 * known_from_chapter 与 holders 里兜底。全缺返回 [1, null]。
 */
function chapterSpanFor(id, canon) {
  let from = null;
  let to = null;
  for (const e of asArray(canon.entities)) {
    if (e.id === id) {
      const f = e.appears_from_chapter;
      if (f != null) from = to = f;
      break;
    }
  }
  for (const k of asArray(canon.knowledge)) {
    if (k.id === id || asArray(k.holders).includes(id)) {
      const kf = k.known_from_chapter;
      if (kf != null) { if (from == null || kf < from) from = kf; if (to == null || kf > to) to = kf; }
    }
  }
  return [from == null ? 1 : from, to];
}

/**
 * 从 canon 推导世界观图谱。
 * @param {object} canon - canon.json（含 entities/knowledge/suspense/timeline/meta）
 * @returns {{meta, nodes, edges, suspense, timeline}}
 */
function buildWorldGraph(canon) {
  const entities = asArray(canon.entities);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nameOf = (id) => (byId.get(id) || {}).name || id;

  // ① 共现边聚合：知识 holder 两两成边
  const edgeMap = new Map(); // `a|b` -> { a, b, count, via:Set }
  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const k of asArray(canon.knowledge)) {
    const hs = [...new Set(asArray(k.holders).filter((h) => byId.has(h)))].sort();
    if (hs.length < 2) continue;
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length; j++) {
        const key = edgeKey(hs[i], hs[j]);
        if (!edgeMap.has(key)) edgeMap.set(key, { a: hs[i], b: hs[j], count: 0, via: new Set() });
        const e = edgeMap.get(key);
        e.count += 1;
        if (k.id) e.via.add(k.id);
      }
    }
  }

  // 孤立实体也保留为节点（无关系但有存在感）
  const nodes = entities.map((e) => {
    const [from, to] = chapterSpanFor(e.id, canon);
    return {
      id: e.id,
      name: e.name || e.id,
      type: e.type || 'entity',
      aliases: asArray(e.aliases),
      fromChapter: from,
      toChapter: to == null ? from : to,
      degree: 0, // 下面填
    };
  });
  const degreeBy = new Map();
  const edges = [...edgeMap.values()].map((e) => {
    const cnt = degreeBy.get(e.a) || 0; degreeBy.set(e.a, cnt + 1);
    const cnt2 = degreeBy.get(e.b) || 0; degreeBy.set(e.b, cnt2 + 1);
    return { a: e.a, b: e.b, count: e.count, via: [...e.via] };
  });
  for (const n of nodes) n.degree = degreeBy.get(n.id) || 0;

  // ② 悬念开合状态。规范化口径（与编译风险的"悬置/已回收"一致）：
  //   · resolved：有 resoved_in_chapter
  //   · open：预计此刻就该收（存在 expected_resolve_chapter）却仍未收
  //   · planned：设了埋点，有明确预期落点（expected > 埋点）且未到——仍在路上
  const suspense = asArray(canon.suspense).map((s) => {
    const hasExpected = s.expected_resolve_chapter != null;
    const overdue = hasExpected && s.expected_resolve_chapter <= (s.planted_in_chapter || 1) + 0;
    const status = s.resolved_in_chapter != null
      ? 'resolved'
      : (hasExpected && !overdue ? 'planned' : 'open');
    return {
      id: s.id,
      name: s.name || s.id,
      planted: s.planted_in_chapter,
      expected: s.expected_resolve_chapter,
      resolved: s.resolved_in_chapter,
      status,
    };
  });

  // ③ 时间线流动：按章节排序的地点序列（去重连续重复），供前端画出"地点足迹"
  const tl = asArray(canon.timeline)
    .slice()
    .sort((a, b) => (a.chapter - b.chapter) || (a.day - b.day));
  const timeline = tl.map((t) => ({
    chapter: t.chapter,
    day: t.day,
    locationId: t.location,
    locationName: nameOf(t.location),
  }));

  const chapterSpan = tl.length ? [tl[0].chapter, tl[tl.length - 1].chapter] : [1, 1];
  return {
    meta: {
      title: (canon.meta && canon.meta.title) || '未命名',
      chapterCount: chapterSpan[1] - chapterSpan[0] + 1,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      openSuspense: suspense.filter((s) => s.status === 'open').length,
      types: Object.entries(nodes.reduce((acc, n) => { acc[n.type] = (acc[n.type] || 0) + 1; return acc; }, {})),
    },
    nodes: nodes.sort((a, b) => b.degree - a.degree),
    edges,
    suspense,
    timeline,
  };
}

module.exports = { buildWorldGraph, chapterSpanFor };