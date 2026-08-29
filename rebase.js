#!/usr/bin/env node
'use strict';

// 文检 novel-compiler · rebase 自动化 —— 预测 vs 实际 → 漂移检测 → 自动以实际 canon 重新模拟
// 用法: node rebase.js <预测.json> <实际.json> [选项]
// 预测文件可以是 simulate.js 的信封输出（推荐：自动推导大纲/前提路径）或纯 canon。
// 退出码: 0 = 无警告级漂移（预测仍有效，未执行） · 1 = 检测到漂移，rebase 成功（新预测已写出，需评审）
//        2 = 输入/校验/LLM 错误 · --dry-run 下始终 0（预览不执行）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateCanon, READERS } = require('./src/validate');
const { diffCanons, maxTimelineChapter } = require('./src/diff');
const { TOOL_TIMEOUT_MS, atomicWrite, pruneBackups, acquireFileLock, checkFileLocked } = require('./src/fsutil');
const { VERSION } = require('./src/version');
const { loadEnvelopeOrCanon } = require('./src/canonio');
const { takeValue } = require('./src/cli');
const { loadLLMEnv } = require('./src/env');
const { missingKeyHint } = require('./src/providers');

const SIM = path.join(__dirname, 'simulate.js');

function usage() {
  return [
    `文检 novel-compiler v${VERSION} · rebase 自动化`,
    '',
    '用法: node rebase.js <预测.json> <实际.json> [选项]',
    '',
    '选项:',
    '  --out <file.json>                  新预测写入位置（缺省 <预测.json>.rebase.json；若指向预测文件本身，旧预测先备份 .bak-* 再覆盖）',
    '  --force                            无漂移也强制以实际 canon 重规划',
    '  --dry-run                          只打印漂移摘要与将执行的命令，不调 LLM',
    '  --outline <file.md>                大纲（缺省自动取预测 meta.source_outline）',
    '  --premise <file.md>                前提设定（缺省自动取预测 meta.source_premise）',
    '  --reader <webnovel|genre|published> 读者向（缺省取预测 meta.target_reader 或 genre）',
    '  --model <model>                    覆盖模型',
    '  -h, --help                         帮助',
    '',
    '语义: 漂移 = 已写章节范围内预测与实际 canon 的警告级偏差。',
    '      有漂移 → 自动以「实际 canon」为基线重新模拟（rebase），新预测元信息记录本次漂移。',
    '环境变量: DEEPSEEK_API_KEY（有漂移且未 --dry-run 时必填）',
    '退出码: 0 = 无需 rebase（或 dry-run 预览）· 1 = 漂移已处理，rebase 成功 · 2 = 错误',
  ].join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const pos = [];
  let outFile = null;
  let force = false;
  let dryRun = false;
  let outlineArg = null;
  let premiseArg = null;
  let readerArg = null;
  let modelArg = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') { outFile = takeValue(args, i, '--out', '<file.json>'); i++; }
    else if (a === '--force') force = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--outline') { outlineArg = takeValue(args, i, '--outline', '<大纲.md>'); i++; }
    else if (a === '--premise') { premiseArg = takeValue(args, i, '--premise', '<前提.md>'); i++; }
    else if (a === '--reader') { readerArg = takeValue(args, i, '--reader', '<webnovel|genre|published>'); i++; }
    else if (a === '--model') { modelArg = takeValue(args, i, '--model', '<模型名>'); i++; }
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else pos.push(a);
  }
  if (pos.length < 2) { console.error(usage()); process.exit(2); }
  if (readerArg !== null && !READERS.includes(readerArg)) {
    console.error(`✗ --reader 必须是 ${READERS.join(' / ')} 之一，当前为 "${readerArg}"`);
    process.exit(2);
  }
  const [predPath, actualPath] = pos;

  // 读协调：rebase 的漂移判定基于 pred/actual 的写入前快照，消费前感知在途写者——
  // 若其中一份正被 extract-llm/refactor 等写者更新，本次漂移判定与随后的自动 rebase 可能基于过期数据。
  // 警告不阻断。与 compile/compare/simulate 读协调口径一致。
  for (const p of [predPath, actualPath]) {
    const lk = checkFileLocked(p);
    if (lk.locked) console.error(`⚠ 输入文件正被其他进程写入（${lk.lockPath}）——本次 rebase 基于写入前的快照，漂移判定可能过期；请等待写入完成后再执行`);
  }

  let pred, actual, predEnv;
  try { ({ envelope: predEnv, canon: pred } = loadEnvelopeOrCanon(predPath)); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  try { ({ canon: actual } = loadEnvelopeOrCanon(actualPath)); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

  const vp = validateCanon(pred);
  if (!vp.ok) {
    console.error('✗ 预测 canon 校验失败:');
    vp.errors.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
    process.exit(2);
  }
  const va = validateCanon(actual);
  if (!va.ok) {
    console.error('✗ 实际 canon 校验失败:');
    va.errors.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
    process.exit(2);
  }

  const problems = diffCanons(pred, actual);
  const warnings = problems.filter((p) => p.severity === 'warning');
  const infos = problems.filter((p) => p.severity === 'info');
  const lastWritten = maxTimelineChapter(actual);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  文检 novel-compiler v${VERSION} · rebase 自动化`);
  console.log(`  预测 : ${predPath}（${pred.meta && pred.meta.title}）`);
  console.log(`  实际 : ${actualPath}（${actual.meta && actual.meta.title}）· 已写至第${lastWritten}章`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`漂移检测：${warnings.length} 处警告级偏差，${infos.length} 处提示级差异`);
  for (const w of warnings.slice(0, 12)) {
    console.log(`  [${w.rule}] ${w.message}`);
  }
  if (warnings.length > 12) console.log(`  …（其余 ${warnings.length - 12} 条见 compare.js 完整报告）`);

  if (!force && warnings.length === 0) {
    console.log('');
    console.log('结论：无警告级漂移，预测仍有效，无需 rebase。');
    console.log('如仍想以当前实际 canon 重规划，请加 --force。');
    process.exit(0);
  }

  // 推导 rebase 输入（优先命令行参数，其次预测信封的 meta）
  const meta = predEnv && predEnv.meta ? predEnv.meta : {};
  // 兼容三级：新信封 meta.source_* 是绝对路径；相对路径旧信封存的是 ROOT 相对路径，
  // 而更老的信封可能是预测文件同目录相对路径——两个候选都尝试。
  // 旧实现存在 cwd 兜底：相对路径在预测文件目录解析不到就静默按当前 cwd 解析，若 cwd
  // 恰好有同名文件会错用错误大纲/前提（系统性预测偏差且无告警）。现改为：命中唯一候选
  // 才用；多个候选是不同文件 → 不猜直接报错；一个都没有 → 返回 null 交调用方提示显式指定。
  const resolveFrom = (p) => {
    if (!p) return null;
    if (path.isAbsolute(p)) return p;
    const candidates = new Set([path.resolve(path.dirname(predPath), p), path.resolve(p)]);
    const found = [...candidates].filter((c) => fs.existsSync(c));
    if (found.length > 1) {
      console.error(`✗ 相对路径「${p}」在多个位置解析到不同文件，无法判定用哪个；请改用绝对路径或 --outline/--premise 显式指定：`);
      found.forEach((f) => console.error(`  - ${f}`));
      process.exit(2);
    }
    return found.length ? found[0] : null;
  };
  const outline = outlineArg || resolveFrom(meta.source_outline);
  if (!outline) {
    console.error('✗ 无法推导大纲路径：预测文件缺少 meta.source_outline，请用 --outline 指定');
    process.exit(2);
  }
  const premise = premiseArg !== null && premiseArg !== undefined ? premiseArg : resolveFrom(meta.source_premise);
  const reader = readerArg || meta.target_reader || 'genre';
  const target = outFile || `${predPath}.rebase.json`;

  if (!dryRun) {
    const env = loadLLMEnv();
    if (!env.apiKey) {
      console.error(`✗ 检测到漂移需要 rebase，但 ${missingKeyHint(env.provider)}`);
      process.exit(2);
    }
  }

  // 覆盖式 rebase（--out 指向预测文件本身，IDE 缺省走此路径）：旧预测先备份再覆盖——
  // 漂移判定已使其失效，但不应静默销毁（与 apply-review 的备份哲学一致；pruneBackups 保留 5 份）
  // 路径同一性用 realpath 规范化比较（识别符号链接/..折叠等别名形式）；
  // Windows 文件系统大小写不敏感但 realpathSync 保留输入大小写（实测 Node v22 不归一），
  // 故 win32 下叠加小写归一——否则 --out 与预测文件仅大小写不同时 same=false 会跳过备份
  const normPath = (p) => {
    let real;
    try { real = fs.realpathSync(p); } catch { real = path.resolve(p); }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  if (!dryRun && normPath(target) === normPath(predPath)) {
    const backup = `${predPath}.bak-${Date.now()}`;
    try {
      fs.copyFileSync(predPath, backup);
    } catch (e) {
      // 备份失败（权限/占用/磁盘）：中止覆盖——预测文件保持原样，不静默销毁
      // copyFileSync 非原子，中途失败可能残留截断的 .bak：清理掉，避免被当作可恢复的历史版本
      try { fs.unlinkSync(backup); } catch { /* 忽略 */ }
      console.error(`✗ 旧预测备份失败，中止覆盖（预测文件保持原样）: ${e.message}`);
      process.exit(2);
    }
    // 备份已成：prune 失败（如目录竞争）只降级为清理告警，不影响覆盖流程
    try { pruneBackups(predPath); } catch (e) { console.warn(`  备份轮换清理失败（不影响流程）: ${e.message}`); }
    console.log(`  旧预测已备份: ${backup}`);
  }

  const simArgs = [SIM, outline];
  if (premise) simArgs.push('--premise', premise);
  simArgs.push('--canon', actualPath, '--reader', reader, '--out', target);
  if (modelArg) simArgs.push('--model', modelArg);
  if (dryRun) simArgs.push('--dry-run');

  console.log('');
  console.log(`执行 rebase：node ${simArgs.join(' ')}`);
  const r = spawnSync(process.execPath, simArgs, { stdio: 'inherit', env: process.env, timeout: TOOL_TIMEOUT_MS });
  if (r.error || r.status === null) {
    console.error(`✗ rebase 模拟超时或执行失败（超过 ${Math.round(TOOL_TIMEOUT_MS / 1000)}s，可用 TOOL_TIMEOUT_MS 调整）: ${r.error ? r.error.message : '进程被终止'}`);
    process.exit(2);
  }
  if (r.status !== 0) {
    console.error(`✗ rebase 模拟失败（exit ${r.status}）`);
    process.exit(2);
  }
  if (dryRun) {
    console.log('\n（--dry-run 预览结束，未执行真实 rebase）');
    process.exit(0);
  }

  // 注入 rebase 元信息（历史可追溯；原子写）。
  // 锁：target 由子进程 simulate 持锁写入（simulate 已加跨进程锁），此处父进程追加元信息前
  // 临时获取同一锁——拿不到（其他进程正在写同一 target）时降级跳过注入，模拟结果已落盘不受影响。
  let releaseMetaLock = null;
  try {
    releaseMetaLock = acquireFileLock(target);
    const envp = JSON.parse(fs.readFileSync(target, 'utf8'));
    envp.meta = envp.meta || {};
    envp.meta.rebase = {
      of: predPath,
      drift_warnings: warnings.length,
      drift_infos: infos.length,
      at: new Date().toISOString(),
      reason: 'auto-rebase',
    };
    atomicWrite(target, JSON.stringify(envp, null, 2) + '\n');
  } catch (e) {
    console.warn(`⚠ 注入 rebase 元信息失败（不影响模拟结果）: ${e.message}`);
  } finally {
    if (releaseMetaLock) releaseMetaLock();
  }
  console.log('');
  console.log(`✓ rebase 完成，新预测已写入: ${target}`);
  console.log('  基线已切换为实际 canon；请评审新预测（尤其风险登记册），并把后续比对指向该文件。');
  process.exit(1);
}

main(process.argv);
