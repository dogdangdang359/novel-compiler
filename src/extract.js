'use strict';

// 手稿解析：章节检测、行号映射、实体提及扫描、引号平衡
// 「提取器」——后续 LLM 提取层将以相同接口替换/增强这里的启发式实现

// 章节标题：支持 Markdown（# 第1章 …）与纯文本（第1章 … / 第 1 章 / 第一章 / 楔子）
// 纯文本（无 # 前缀）标题要求整行较短且不以句读结尾，避免误判正文行
const HEADING_RE = /^#{0,6}\s*第\s*([0-9]+|[零一二三四五六七八九十百千万]+)\s*章/;
const SPECIAL_RE = /^#{0,6}\s*(楔子|序章|尾声|番外|后记)/;
const { asArray } = require('./canon');
const ZH = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const PLAIN_MAX_LEN = 40;

function isPlainHeading(line) {
  return line.length <= PLAIN_MAX_LEN && !/[。！？；，,]$/.test(line.trim());
}

// 中文数字 → 整数（支持 十/百/千/万；"一万零三百" 中的零跳过）
// 万的处理：万前值 = 已累积的 section + num（如 十二万 = 10+2；十万 = 10+0），
// 万后（section 已是万级）继续累加十/百/千（如 十二万三千 = 120000 + 3000）
function cnToInt(str) {
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  let section = 0;
  let num = 0;
  for (const ch of str) {
    if (ZH[ch] !== undefined) num = ZH[ch];
    else if (ch === '十') { section += (num || 1) * 10; num = 0; }
    else if (ch === '百') { section += (num || 1) * 100; num = 0; }
    else if (ch === '千') { section += (num || 1) * 1000; num = 0; }
    else if (ch === '万') {
      const before = section + num;
      section = (before > 0 ? before : 1) * 10000;
      num = 0;
    }
    else return null;
  }
  const v = section + num;
  return v > 0 ? v : null;
}

// 章节结构：number=null 表示无法编号的章节（尾声/番外等）
function parseManuscript(text) {
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = rawLines.slice();
  normalizeSuppressBlocks(lines);
  const chapters = [];
  let cur = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    const m = line.match(HEADING_RE);
    const sp = line.match(SPECIAL_RE);
    const hasHash = /^#/.test(line.trimStart());
    const isHeading = (m || sp) && (hasHash || isPlainHeading(line));
    if (isHeading) {
      if (cur) cur.endLine = n - 1;
      const number = m
        ? cnToInt(m[1].replace(/\s/g, ''))
        : (sp && (sp[1] === '楔子' || sp[1] === '序章') ? 0 : null);
      cur = {
        index: chapters.length,
        number,
        title: line.replace(/^#+\s*/, ''),
        headingLine: n,
        startLine: n + 1,
        endLine: lines.length,
        text: '',
        charCount: 0,
      };
      chapters.push(cur);
    }
  });
  for (const ch of chapters) {
    // 豁免注释行是元数据而非正文：不计入正文文本与字数（也不参与后续扫描/统计）
    const body = lines.slice(ch.startLine - 1, ch.endLine).filter((l) => !isSuppressLine(l));
    ch.text = body.join('\n');
    ch.charCount = countChars(ch.text);
  }
  return { lines, rawLines, chapters };
}

// 跨行豁免注释块归一化：<!-- wj-suppress: ... 理由跨行 ... --> 的续行没有行首前缀，
// 不处理会被当成正文参与提及/引号/字数统计（豁免注释是元数据，任何行都不应进入正文）。
// 续行替换为满足 isSuppressLine 前缀的占位行（行号保持不变，证据锚点不受影响）。
const SUPPRESS_CONT = '<!-- wj-suppress: (多行注释续行 · 元数据不计入正文) -->';
function normalizeSuppressBlocks(lines) {
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      lines[i] = SUPPRESS_CONT;
      if (line.includes('-->')) inBlock = false;
      continue;
    }
    if (/^\s*<!--\s*wj-suppress:/.test(line) && !line.includes('-->')) inBlock = true;
  }
}

function countChars(text) {
  return text.replace(/[#*`>_~]/g, '').replace(/\s/g, '').length;
}

// 最后一个已编号章节的章号（跳过尾声/番外/后记等 number=null 章；无编号章时回退 0）。
// 注意不能用 chapters[last].number ?? chapters.length 兜底——末尾是番外且前面跳号时
// （如第 1、2、5 章 + 番外）会得到 4 而真实末章是 5，导致 timeline/planned 误报、悬念状态误判。
function lastChapterNumber(chapters) {
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (chapters[i].number !== null) return chapters[i].number;
  }
  return 0;
}

// 实体提及扫描：按「行」统计（每行命中计 1），支持别名
function scanMentions(chapters, entities, lines) {
  const out = new Map();
  for (const e of asArray(entities)) {
    const names = [...new Set([e.name, ...asArray(e.aliases)].filter((x) => typeof x === 'string' && x))]
      .sort((a, b) => b.length - a.length);
    const byChapter = new Map();          // 章 index -> 命中行数
    const firstLineByChapter = new Map(); // 章 index -> 首个命中行号
    let total = 0;
    for (const ch of chapters) {
      let cnt = 0;
      let first = 0;
      for (let li = ch.startLine - 1; li < ch.endLine; li++) {
        const line = lines[li];
        if (isSuppressLine(line)) continue; // 豁免注释中的实体名不算正文提及
        if (names.some((nm) => line.includes(nm))) {
          cnt += 1;
          total += 1;
          if (!first) first = li + 1;
        }
      }
      byChapter.set(ch.index, cnt);
      firstLineByChapter.set(ch.index, first);
    }
    out.set(e.id, { total, byChapter, firstLineByChapter });
  }
  return out;
}

const PAIRS = [['“', '”'], ['「', '」']];

// 豁免注释行（不参与正文处理，但保留在原文中供 compile 解析）
const SUPPRESS_LINE_RE = /^\s*<!--\s*wj-suppress:/;
function isSuppressLine(line) {
  return SUPPRESS_LINE_RE.test(line);
}

// 引号平衡统计：每章每种引号对的开闭计数 + 首个失衡行号（供 problems 精确定位）
function quoteStats(chapters, lines) {
  const out = [];
  for (const ch of chapters) {
    const count = { '“': 0, '”': 0, '「': 0, '」': 0 };
    let firstBadLine = 0;
    for (let li = ch.startLine - 1; li < ch.endLine; li++) {
      const line = lines[li];
      if (isSuppressLine(line)) continue; // 豁免注释中的标点不计入正文统计
      for (const [open, close] of PAIRS) {
        count[open] += line.split(open).length - 1;
        count[close] += line.split(close).length - 1;
      }
      if (!firstBadLine) {
        for (const [open, close] of PAIRS) {
          if (count[open] !== count[close]) { firstBadLine = li + 1; break; }
        }
      }
    }
    out.push({ count, firstBadLine });
  }
  return out;
}

module.exports = { parseManuscript, scanMentions, quoteStats, PAIRS, cnToInt, isSuppressLine, normalizeSuppressBlocks, lastChapterNumber };
