#!/usr/bin/env node
'use strict';

// 文检 novel-compiler —— 小说「编译器」MVP
// 用法: node compile.js <手稿.md> <canon.json> [--reader ...] [--json]
// 退出码: 0 = 无 error · 1 = 存在 error 级问题 · 2 = 输入 / 校验错误

const fs = require('fs');
const { validateCanon, configFor, READERS } = require('./src/validate');
const { parseManuscript, scanMentions, quoteStats } = require('./src/extract');
const { runChecks } = require('./src/rules');
const { renderText, renderJson, buildSnapshot, countsOf } = require('./src/report');
const { VERSION } = require('./src/version');
const { unwrapEnvelope } = require('./src/canonio');
const { takeValue } = require('./src/cli');
const { asArray } = require('./src/canon');
const { checkFileLocked } = require('./src/fsutil');

function usage() {
  return [
    `文检 novel-compiler v${VERSION} —— 手稿 + canon → 带行号的 problems 报告`,
    '',
    '用法: node compile.js <手稿.md> <canon.json> [选项]',
    '',
    '选项:',
    '  --reader <webnovel|genre|published>  读者向（默认取 canon.meta.target_reader，缺省 genre）',
    '  --json                               输出 JSON（供 UI / 管道消费）',
    '  -h, --help                           显示帮助',
    '',
    '手稿格式: Markdown，用 "# 第N章 标题"（或 楔子/序章）分章',
    'canon 格式: 见 README.md「canon 格式」',
    '',
    '退出码: 0 = 无 error · 1 = 存在 error 级问题 · 2 = 输入 / 校验错误',
  ].join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  let reader = null;
  let json = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--reader') { reader = takeValue(args, i, '--reader', '<webnovel|genre|published>'); i++; }
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else pos.push(a);
  }

  if (pos.length < 2) { console.error(usage()); process.exit(2); }
  if (reader !== null && !READERS.includes(reader)) {
    console.error(`✗ --reader 必须是 ${READERS.join(' / ')} 之一，当前为 "${reader}"`);
    process.exit(2);
  }
  const [msPath, canonPath] = pos;

  // 读协调：compile 是只读分析，不参与写锁，但在消费共享输入前感知在途写者——
  // 原子写保证读不到半截文件，但写者「读-改-写」长窗口内磁盘是写入前的旧快照，
  // 本次编译基于它，写者完成后即过期。警告不阻断（对当前快照的分析仍有效）。
  for (const p of [msPath, canonPath]) {
    const lk = checkFileLocked(p);
    if (lk.locked) console.error(`⚠ 输入文件正被其他进程写入（${lk.lockPath}）——本次编译基于写入前的快照，结果可能过期；请等待写入完成后再编译`);
  }

  let msText;
  try { msText = fs.readFileSync(msPath, 'utf8'); }
  catch (e) { console.error(`✗ 无法读取手稿: ${msPath}（${e.message}）`); process.exit(2); }

  let canon;
  try { canon = JSON.parse(fs.readFileSync(canonPath, 'utf8')); }
  catch (e) { console.error(`✗ 无法解析 canon JSON: ${canonPath}（${e.message}）`); process.exit(2); }
  // 信封支持：接受提取器（extract-llm）与模拟器（simulate）的输出，自动取其中的 canon
  canon = unwrapEnvelope(canon);

  const v = validateCanon(canon);
  if (!v.ok) {
    console.error(`✗ canon 校验失败（${v.errors.length} 处）:`);
    v.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(2);
  }

  const parsed = parseManuscript(msText);
  if (!parsed.chapters.length) {
    console.error(`✗ 手稿中未检测到章节标题: ${msPath}`);
    console.error('  支持两种分章格式："# 第1章 标题" 或纯文本"第1章 标题"（也支持 楔子/序章/尾声/番外）');
    process.exit(2);
  }

  const effectiveReader = reader || (canon.meta && canon.meta.target_reader) || 'genre';
  const { loadWjrc, applyWjrc, applyRuleOverrides } = require('./src/wjrc');
  const { parseSuppressions, applySuppressions } = require('./src/suppress');
  // .wjrc.json 查找锚点：手稿目录优先，canon 目录兜底（与 simulate 口径一致）
  const wj = loadWjrc([msPath, canonPath]);
  const { cfg, overrides, invalidRules, invalidThresholds } = applyWjrc(configFor(effectiveReader), wj);
  const mentions = scanMentions(parsed.chapters, asArray(canon.entities), parsed.lines);
  const quotes = quoteStats(parsed.chapters, parsed.lines);
  const rawProblems = runChecks({ canon, parsed, mentions, quotes, cfg, file: msPath });
  const problems0 = applyRuleOverrides(rawProblems, overrides);
  // 豁免解析用原始行（含多行注释原文，供跨行注释检测）；正文扫描用 parsed.lines（已归一化）
  const supp = parseSuppressions(parsed.rawLines, parsed.chapters);
  const { kept: problems, suppressed, unused } = applySuppressions(problems0, supp);

  const manifest = {
    version: VERSION,
    manuscript: msPath,
    canon: canonPath,
    chapters: parsed.chapters.length,
    chars: parsed.chapters.reduce((s, c) => s + c.charCount, 0),
    entities: asArray(canon.entities).length,
    knowledge: asArray(canon.knowledge).length,
    suspense: asArray(canon.suspense).length,
    reader: effectiveReader,
    wjrc: wj ? wj.file : null,
    wjrcInvalid: invalidRules.length || invalidThresholds.length
      ? { rules: invalidRules, thresholds: invalidThresholds }
      : undefined,
  };
  const counts = countsOf(problems);
  const snapshot = buildSnapshot(canon, parsed, mentions);

  if (json) {
    process.stdout.write(renderJson({
      manifest, problems, counts, snapshot, cfg,
      suppressed, unused_suppressions: unused,
    }) + '\n');
  } else {
    process.stdout.write(renderText({
      manifest, problems, counts, snapshot, cfg,
      suppressed, unused_suppressions: unused,
    }));
  }
  process.exit(counts.error > 0 ? 1 : 0);
}

main(process.argv);
