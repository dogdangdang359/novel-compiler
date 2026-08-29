#!/usr/bin/env node
'use strict';

// 文检 novel-compiler · 比对器 —— 预测 canon vs 实际 canon -> 偏差报告（防漂移）
// 用法: node compare.js <预测.json> <实际.json> [--json]
// 预测文件可以是 simulate.js 的完整输出（含 canon 字段）或纯 canon JSON。
// 退出码: 0 = 无警告级偏差 · 1 = 存在警告级偏差（需决定 rebase 或修复）· 2 = 输入/校验错误

const { validateCanon } = require('./src/validate');
const { diffCanons } = require('./src/diff');
const { VERSION } = require('./src/version');
const { loadCanonFile } = require('./src/canonio');
const { checkFileLocked } = require('./src/fsutil');

const SEV_LABEL = { warning: '警告', info: '提示' };
const SEV_GLYPH = { warning: '⚠', info: 'ℹ' };

function usage() {
  return [
    `文检 novel-compiler v${VERSION} · 比对器（预测 vs 实际）`,
    '',
    '用法: node compare.js <预测.json> <实际.json> [--json]',
    '',
    '预测文件: simulate.js 的完整输出（含 canon 字段）或纯 canon JSON',
    '实际文件: 作者维护的 canon JSON',
    '',
    '退出码: 0 = 无警告级偏差 · 1 = 存在警告级偏差 · 2 = 输入/校验错误',
  ].join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const pos = [];
  let json = false;
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else pos.push(a);
  }
  if (pos.length < 2) { console.error(usage()); process.exit(2); }

  // 读协调：比对基于预测（last-pred.json，simulate/rebase 在途写）与实际 canon
  // （extract/refactor/审阅写回在途写）做漂移判定。两者都可能是写者长窗口内的旧快照，
  // 警告不阻断（比对结果对当前快照仍成立），但提示用户结果可能随写入完成而过期。
  for (const p of pos) {
    const lk = checkFileLocked(p);
    if (lk.locked) console.error(`⚠ 输入文件正被其他进程写入（${lk.lockPath}）——本次比对基于写入前的快照，结果可能过期；请等待写入完成后再比对`);
  }

  let predicted, actual;
  try { predicted = loadCanonFile(pos[0]); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  try { actual = loadCanonFile(pos[1]); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

  const vp = validateCanon(predicted);
  if (!vp.ok) {
    console.error(`✗ 预测 canon 校验失败:`);
    vp.errors.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
    process.exit(2);
  }
  const va = validateCanon(actual);
  if (!va.ok) {
    console.error(`✗ 实际 canon 校验失败:`);
    va.errors.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
    process.exit(2);
  }

  const problems = diffCanons(predicted, actual);
  const warnings = problems.filter((p) => p.severity === 'warning').length;
  const infos = problems.filter((p) => p.severity === 'info').length;

  if (json) {
    console.log(JSON.stringify({
      tool: 'novel-compiler/compare',
      version: VERSION,
      predicted: pos[0],
      actual: pos[1],
      counts: { warning: warnings, info: infos },
      problems,
    }, null, 2));
  } else {
    const lines = [];
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`  文检 novel-compiler v${VERSION} · 预测 vs 实际`);
    lines.push(`  预测 : ${pos[0]}（${predicted.meta && predicted.meta.title}）`);
    lines.push(`  实际 : ${pos[1]}（${actual.meta && actual.meta.title}）`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    for (const sev of ['warning', 'info']) {
      const list = problems.filter((p) => p.severity === sev);
      if (!list.length) continue;
      lines.push(`${SEV_GLYPH[sev]} ${SEV_LABEL[sev]} (${list.length})`);
      for (const p of list) {
        const loc = p.chapter !== null && p.chapter !== undefined ? `（第${p.chapter}章）` : '';
        lines.push(`  [${p.rule}] ${loc} ${p.message}`);
        if (p.detail) lines.push(`    ${p.detail}`);
      }
      lines.push('');
    }
    lines.push(`结论：${warnings} 处警告级偏差。`);
    lines.push('处理：1) 实际是笔误/遗漏 → 修正实际 canon；2) 实际是有意改动 → rebase（以实际为准重新模拟）。');
    lines.push(`（exit ${warnings > 0 ? 1 : 0}）`);
    console.log(lines.join('\n'));
  }
  process.exit(warnings > 0 ? 1 : 0);
}

main(process.argv);
