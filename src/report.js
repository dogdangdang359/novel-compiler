'use strict';

// 报告输出：文本模式（人读）+ JSON 模式（管道/UI 消费）
// 文本模式末尾附「状态快照」—— 对应未来编辑器左侧 dashboard 的数据预览

const { lastChapterNumber } = require('./extract');
const { asArray } = require('./canon');

const SEV_ORDER = ['error', 'warning', 'info'];
const SEV_LABEL = { error: '错误', warning: '警告', info: '提示' };
const SEV_GLYPH = { error: '✗', warning: '⚠', info: 'ℹ' };

function countsOf(problems) {
  const c = { error: 0, warning: 0, info: 0 };
  // 防御：非法 severity 不计入（避免 undefined + 1 = NaN 污染计数）
  for (const p of problems) if (c[p.severity] !== undefined) c[p.severity] += 1;
  return c;
}

function buildSnapshot(canon, parsed, mentions) {
  const chapters = parsed.chapters;
  const lastNumber = lastChapterNumber(chapters);
  const entities = asArray(canon.entities).map((e) => {
    const m = mentions.get(e.id);
    const activeChapters = m ? [...m.byChapter.values()].filter((c) => c > 0).length : 0;
    return {
      id: e.id,
      name: e.name,
      type: e.type,
      activeChapters,
      totalChapters: chapters.length,
      present: activeChapters > 0,
    };
  });
  const suspense = asArray(canon.suspense).map((s) => ({
    id: s.id,
    name: s.name,
    planted: s.planted_in_chapter,
    expected: s.expected_resolve_chapter,
    resolved: s.resolved_in_chapter,
    status:
      s.resolved_in_chapter !== undefined && s.resolved_in_chapter !== null && s.resolved_in_chapter <= lastNumber
        ? 'resolved'
        : ((s.resolved_in_chapter !== undefined && s.resolved_in_chapter !== null)
          || (s.expected_resolve_chapter !== undefined && s.expected_resolve_chapter !== null)
          ? 'planned'
          : 'dangling'),
  }));
  const timeline = asArray(canon.timeline)
    .slice()
    .sort((a, b) => a.chapter - b.chapter)
    .map((t) => ({ chapter: t.chapter, day: t.day, location: t.location }));
  return { entities, suspense, timeline };
}

function renderText({ manifest, problems, counts, snapshot, cfg, suppressed, unused_suppressions }) {
  const L = [];
  const push = (s = '') => L.push(s);
  push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  push(`  文检 novel-compiler v${manifest.version} · 手稿编译检查`);
  push(`  手稿   : ${manifest.manuscript}（${manifest.chapters} 章 · ${manifest.chars} 字）`);
  push(`  canon  : ${manifest.canon}（${manifest.entities} 实体 · ${manifest.knowledge} 知识 · ${manifest.suspense} 悬念）`);
  push(`  读者向 : ${cfg.label}（悬置阈值 ${cfg.overdueLimit} 章 · 文末悬置=${cfg.danglingSeverity}）`);
  push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  push();

  for (const sev of SEV_ORDER) {
    const list = problems.filter((p) => p.severity === sev);
    if (!list.length) continue;
    push(`${SEV_GLYPH[sev]} ${SEV_LABEL[sev]} (${list.length})`);
    for (const p of list) {
      const loc = p.chapter !== null && p.chapter !== undefined ? `（第${p.chapter}章）` : '';
      push(`  [${p.rule}] ${p.file}:${p.line}${loc}`);
      push(`    ${p.message}`);
      if (p.detail) push(`    ${p.detail}`);
    }
    push();
  }

  // 已豁免（故意违规，不计入计数与退出码）
  if (suppressed && suppressed.length) {
    push(`⊘ 已豁免 (${suppressed.length})`);
    for (const p of suppressed) {
      const loc = p.chapter !== null && p.chapter !== undefined ? `（第${p.chapter}章）` : '';
      push(`  [${p.rule}] ${p.file}:${p.line}${loc} —— 理由: ${p.suppress_reason || '（未注明）'}`);
      push(`    ${p.message}`);
    }
    push();
  }
  if (unused_suppressions && unused_suppressions.length) {
    push(`ℹ 未命中的豁免 (${unused_suppressions.length})`);
    for (const u of unused_suppressions) {
      const cause = u.multiline
        ? '（豁免注释必须是单行 —— 多行注释不产生豁免，请合并为一行）'
        : (u.unresolvable
          ? (u.chapterScoped ? '（章级豁免注释不在任何章节内，无法定位目标章）' : '（行级豁免注释后没有正文行可应用，请移到有正文的位置）')
          : u.globalHint
            ? '（章级豁免不覆盖全稿级问题：该规则存在 chapter=null 的问题，如需豁免请改用 @global）'
            : u.globalScoped
              ? '（该规则没有全稿级问题，@global 只豁免 chapter=null 的问题）'
              : '（没有对应问题，检查规则 id 或位置）');
      const scope = u.chapterScoped ? '（章级）' : u.globalScoped ? '（全稿级）' : '';
      push(`  [${u.rule}] 第${u.line}行${scope} —— ${u.reason || '（未注明）'}${cause}`);
    }
    push();
  }

  push('状态快照（state snapshot）');
  const entRows = snapshot.entities
    .map((e) => {
      const flag = e.present ? '' : ' ⚠';
      return `${e.name} ${e.activeChapters}/${e.totalChapters}章${flag}`;
    })
    .join(' · ');
  push(`  实体出场  ${entRows || '（无）'}`);
  for (const s of snapshot.suspense) {
    const head = `${s.name} 埋设@${s.planted ?? '?'}`;
    let row;
    if (s.status === 'resolved') row = `${head} → 回收@${s.resolved}（预期@${s.expected ?? '?'}）✓`;
    else if (s.status === 'planned') row = `${head} → 未回收（预期@${s.expected ?? '?'}）`;
    else row = `${head} → 悬置中（预期@${s.expected ?? '?'}）…`;
    push(`  悬念台账  ${row}`);
  }
  const tl = snapshot.timeline.map((t) => `第${t.chapter}章:第${t.day}天`).join(' → ');
  push(`  时间线    ${tl || '（无）'}`);
  push();
  push(`编译结果：${counts.error} 错误 / ${counts.warning} 警告 / ${counts.info} 提示${suppressed && suppressed.length ? ` / ${suppressed.length} 已豁免` : ''}   （exit ${counts.error > 0 ? 1 : 0}）`);
  return L.join('\n') + '\n';
}

function renderJson({ manifest, problems, counts, snapshot, cfg, suppressed, unused_suppressions }) {
  return JSON.stringify({
    tool: 'novel-compiler',
    version: manifest.version,
    manifest,
    counts: { ...counts, suppressed: asArray(suppressed).length },
    problems,
    suppressed: asArray(suppressed),
    unused_suppressions: asArray(unused_suppressions),
    snapshot,
  }, null, 2);
}

module.exports = { countsOf, buildSnapshot, renderText, renderJson, SEV_ORDER, SEV_LABEL, SEV_GLYPH };
