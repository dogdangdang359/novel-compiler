'use strict';

// 豁免机制：在正文中用 HTML 注释声明"这是故意的"，对应问题不再计入错误/退出码。
//   <!-- wj-suppress: rule-id 理由 -->          行级：应用于下一个内容行（必须单行）
//   <!-- wj-suppress: rule-id @chapter 理由 --> 章级：应用于所在章（含第0章楔子、尾声/番外）
//   <!-- wj-suppress: rule-id @global 理由 -->  全稿级：应用于该规则所有无章归属（chapter=null）的问题
// 豁免的问题进入独立分组（带理由，可审计）；未命中的豁免（规则+位置没有对应问题）单独报告。
// 反馈准确性是豁免可信度的地基：机制无法生效的注释（多行注释、注释后无目标行、
// 章级注释不在任何章节内）会明确标记，不会伪装成"没有对应问题"。

const SUPPRESS_RE = /<!--\s*wj-suppress:\s*([A-Za-z0-9_./-]+)(?:\s+(@chapter|@global))?(?:\s+([\s\S]*?))?\s*-->/;
const SUPPRESS_LINE_RE = /^\s*<!--\s*wj-suppress:/;
// 跨行注释检测：行首是豁免注释但该行未闭合（真正的豁免注释必须单行——SUPPRESS_RE 按行匹配）
const MULTILINE_RE = /^\s*<!--\s*wj-suppress:\s*([A-Za-z0-9_./-]+)(?:\s+(@chapter|@global))?(?:\s+.*)?$/;

function isSuppressLine(line) {
  return SUPPRESS_LINE_RE.test(line);
}

/**
 * 从手稿行解析豁免条目。
 * @param {string[]} lines - 原始行（未做跨行注释归一化，以便完整解析；compile 传 parsed.rawLines）
 * @param {Array<{index, number, startLine, endLine}>} chapters - parseManuscript 的章节（含行号区间）
 * @returns {{byLine: Map, byChapter: Map, byGlobal: Set, entries: Array}}
 * entries 条目字段：{ rule, atLine, target, chapterScoped, globalScoped, reason, multiline?, unresolvable? }
 */
function parseSuppressions(lines, chapters) {
  const byLine = new Map();      // rule -> Set<行号>
  const byChapter = new Map();   // rule -> Set<章号>
  const byGlobal = new Set();    // rule -> true（@global 全稿级豁免）
  const entries = [];
  const chapterOfLine = (n) => chapters.find((c) => c.startLine - 1 <= n - 1 && n - 1 < c.endLine);
  // 章级豁免的目标章号：编号章用章号；尾声/番外/后记（number=null）用 index+1
  // （compile 问题的 chapter 字段也是 number ?? index+1，保证能对上——旧实现此处静默失效）
  const chapterKeyOf = (ch) => (ch ? (ch.number !== null ? ch.number : (ch.index !== undefined ? ch.index + 1 : null)) : null);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(SUPPRESS_RE);
    if (!m) {
      // 跨行豁免注释（行首是 wj-suppress 但该行未闭合）：机制不支持多行，明确报告而非静默
      const ml = line.match(MULTILINE_RE);
      if (ml) {
        entries.push({
          rule: ml[1],
          atLine: i + 1,
          target: null,
          chapterScoped: ml[2] === '@chapter',
          globalScoped: ml[2] === '@global',
          reason: (line.slice(line.indexOf('wj-suppress:') + 'wj-suppress:'.length).trim() || '').replace(/\s*-->.*$/, '').trim(),
          multiline: true,
        });
      }
      continue;
    }
    const rule = m[1];
    const chapterScoped = m[2] === '@chapter';
    const globalScoped = m[2] === '@global';
    const reason = (m[3] || '').trim();
    const atLine = i + 1;
    let target = null;

    if (chapterScoped) {
      const ch = chapterOfLine(atLine);
      target = chapterKeyOf(ch);
      if (target !== null) {
        if (!byChapter.has(rule)) byChapter.set(rule, new Set());
        byChapter.get(rule).add(target);
      }
    } else if (globalScoped) {
      // 全稿级：无需目标行/章，声明即生效（豁免该规则所有 chapter=null 的问题）
      byGlobal.add(rule);
    } else {
      // 行级：应用到下一个非空、非豁免注释的行
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t) continue;
        if (isSuppressLine(t)) continue;
        target = j + 1;
        break;
      }
      if (target !== null) {
        if (!byLine.has(rule)) byLine.set(rule, new Set());
        byLine.get(rule).add(target);
      }
    }
    entries.push({ rule, atLine, target, chapterScoped, globalScoped, reason, unresolvable: !globalScoped && target === null });
  }
  return { byLine, byChapter, byGlobal, entries };
}

/**
 * 应用豁免：problems -> { kept, suppressed, unused }
 * suppressed 每条附带 suppress_reason（首个命中条目的理由）。
 */
function applySuppressions(problems, supp) {
  const { byLine, byChapter, byGlobal, entries } = supp;
  const kept = [];
  const suppressed = [];
  for (const p of problems) {
    const lineHit = byLine.has(p.rule) && byLine.get(p.rule).has(p.line);
    const chHit = p.chapter !== undefined && p.chapter !== null
      && byChapter.has(p.rule) && byChapter.get(p.rule).has(p.chapter);
    // 全稿级问题（chapter=null，如 entity/missing 的「从未出场」提示）没有章可归，
    // 只能被显式 @global 豁免声明覆盖。旧实现"任一 @chapter 即视为全局豁免"属规则级
    // 豁免过度：为某一章的章级问题豁免时，全稿所有同类提示被连带静默
    const globalHit = (p.chapter === null || p.chapter === undefined) && byGlobal.has(p.rule);
    if (lineHit || chHit || globalHit) {
      const e = entries.find((x) => x.rule === p.rule
        && (x.chapterScoped ? x.target === p.chapter
          : x.globalScoped ? (p.chapter === null || p.chapter === undefined)
            : x.target === p.line));
      suppressed.push({ ...p, suppress_reason: e ? e.reason : '' });
    } else {
      kept.push(p);
    }
  }
  // 未命中：该豁免条目没有对应问题（可能是规则已改、位置已移、或 typo）
  // multiline/unresolvable 条目不可能命中，原样带出供准确反馈（不会伪装成"没有对应问题"）
  const unused = [];
  for (const e of entries) {
    if (e.multiline || e.unresolvable) {
      unused.push({ rule: e.rule, line: e.atLine, reason: e.reason, chapterScoped: e.chapterScoped, globalScoped: !!e.globalScoped, multiline: !!e.multiline, unresolvable: !!e.unresolvable });
      continue;
    }
    const hit = suppressed.some((p) => p.rule === e.rule && (e.chapterScoped
      ? p.chapter === e.target
      : e.globalScoped
        ? (p.chapter === null || p.chapter === undefined)
        : p.line === e.target));
    if (!hit) {
      // 章级豁免未命中但该规则存在全稿级问题：用户多半想豁免后者——给出改用 @global 的具体指引
      const globalOfRule = e.chapterScoped
        && problems.some((p) => p.rule === e.rule && (p.chapter === null || p.chapter === undefined));
      unused.push({ rule: e.rule, line: e.target ?? e.atLine, reason: e.reason, chapterScoped: e.chapterScoped, globalScoped: !!e.globalScoped, globalHint: globalOfRule });
    }
  }
  return { kept, suppressed, unused };
}

module.exports = { parseSuppressions, applySuppressions, isSuppressLine, SUPPRESS_RE };
