#!/usr/bin/env node
'use strict';

// 文检 novel-compiler · 重构 —— 文稿先行：从正文逆推并重写 canon / outline / premise（敏捷开发工具，为后续 编译/审阅/比对/重规划 服务）
// 用法: node refactor.js <手稿.md> <canon.json> <outline.md> <premise.md> [--reader ...] [--model ...] [--extract-out <信封.json>] [--dry-run]
// 流水线：① canon（extract-llm 基线保留 + 僵尸清理）→ ② 大纲回写 → ③ 前提回写；写文件前自动备份（.bak-<时间戳>），全部原子写。
// 退出码: 0 = 成功 · 1 = 校验重试后仍失败 · 2 = 输入/环境/LLM 错误

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadLLMEnv } = require('./src/env');
const { chatTextValidated } = require('./src/llm');
const { estimateTokens, INPUT_BUDGET_TOKENS, assertInputWithinHardLimit } = require('./src/llm');
const { configFor, READERS } = require('./src/validate');
const { buildOutlinePrompt, validateOutline, buildPremisePrompt, validatePremise, syncReport } = require('./src/outline');
const { atomicWrite, pruneBackups, TOOL_TIMEOUT_MS, acquireFileLocks, acquireFileLock } = require('./src/fsutil');
const { VERSION } = require('./src/version');
const { takeValue } = require('./src/cli');

function usage() {
  return [
    `文检 novel-compiler v${VERSION} · 重构（文稿先行：逆推并重写 canon/outline/premise）`,
    '',
    '用法: node refactor.js <手稿.md> <canon.json> <outline.md> <premise.md> [选项]',
    '',
    '选项:',
    '  --reader <webnovel|genre|published> 读者向（缺省 genre）',
    '  --model <model>                     覆盖模型',
    '  --title <书名>                      强制书名（同步写入 canon meta / 大纲 / 前提）',
    '  --extract-out <信封.json>           ①段的提议信封（含证据）额外写入该文件（供 IDE 审阅）',
    '  --backup-keep <N>                   每个文件的 .bak-* 备份保留数量（缺省 5，超出自动清理）',
    '  --dry-run                           只打印三段提示词与将执行的命令，不调 LLM',
    '  -h, --help                          帮助',
    '',
    '流水线: ① canon <- extract-llm（基线保留+僵尸清理）· ② outline <- 大纲回写 · ③ premise <- 设定回写',
    '安全: 写文件前自动备份为 <文件>.bak-<时间戳>；全部原子写（临时文件 + rename）。',
    '环境变量: DEEPSEEK_API_KEY（--dry-run 除外必填）',
    '退出码: 0 = 成功 · 1 = 输出未通过校验 · 2 = 输入/环境/LLM 错误',
  ].join('\n');
}

function readOptional(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function backup(p) {
  if (!fs.existsSync(p)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${p}.bak-${ts}`;
  try { fs.copyFileSync(p, target); return target; } catch { return null; }
}

async function main(argv) {
  const args = argv.slice(2);
  const pos = [];
  let reader = null;
  let modelArg = null;
  let extractOut = null;
  let dryRun = false;
  let titleArg = null;
  let backupKeep = 5;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--reader') { reader = takeValue(args, i, '--reader', '<webnovel|genre|published>'); i++; }
    else if (a === '--model') { modelArg = takeValue(args, i, '--model', '<模型名>'); i++; }
    else if (a === '--title') { titleArg = takeValue(args, i, '--title', '<书名>'); i++; }
    else if (a === '--backup-keep') { backupKeep = parseInt(takeValue(args, i, '--backup-keep', '<N>'), 10) || 5; i++; }
    else if (a === '--extract-out') { extractOut = takeValue(args, i, '--extract-out', '<信封.json>'); i++; }
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else pos.push(a);
  }
  if (pos.length < 4) { console.error(usage()); process.exit(2); }
  if (reader !== null && !READERS.includes(reader)) {
    console.error(`✗ --reader 必须是 ${READERS.join(' / ')} 之一，当前为 "${reader}"`);
    process.exit(2);
  }
  const [msPath, canonPath, outlinePath, premisePath] = pos;

  let manuscript;
  try { manuscript = fs.readFileSync(msPath, 'utf8'); }
  catch (e) { console.error(`✗ 无法读取手稿: ${msPath}（${e.message}）`); process.exit(2); }
  const existingCanon = readOptional(canonPath);
  const existingOutline = readOptional(outlinePath);
  const existingPremise = readOptional(premisePath);
  // 读者向缺省口径与 compile/simulate 一致：命令行 > canon.meta.target_reader > genre
  let effectiveReader = reader;
  if (!effectiveReader && existingCanon !== null) {
    try {
      const c = JSON.parse(existingCanon);
      if (c && c.meta && c.meta.target_reader) effectiveReader = c.meta.target_reader;
    } catch { /* canon 不可解析时保持默认 */ }
  }
  effectiveReader = effectiveReader || 'genre';
  const cfg = configFor(effectiveReader);
  const model = modelArg || process.env.DEEPSEEK_MODEL || 'deepseek-chat';

  // ---------- dry-run ----------
  if (dryRun) {
    const extractCmd = ['extract-llm.js', msPath, '--canon', canonPath, '--reader', effectiveReader, '--canon-out', canonPath];
    if (extractOut) extractCmd.push('--out', extractOut);
    console.log('════ ① canon（将执行）════');
    console.log(`node ${extractCmd.join(' ')}`);
    const o = buildOutlinePrompt({ manuscript, existingOutline, premise: existingPremise, cfg, title: titleArg });
    console.log('════ ② 大纲回写 · 系统提示词 ════');
    console.log(o.system);
    console.log('════ ② 大纲回写 · 用户提示词（节选）════');
    console.log(o.user.slice(0, 1200));
    const p = buildPremisePrompt({ manuscript, existingPremise, outline: '（将由 ② 生成）', cfg, title: titleArg });
    console.log('════ ③ 前提回写 · 系统提示词 ════');
    console.log(p.system);
    console.log('════ ③ 前提回写 · 用户提示词（节选）════');
    console.log(p.user.slice(0, 1200));
    process.exit(0);
  }

  const env = loadLLMEnv();
  if (!env.apiKey) {
    console.error('✗ 缺少 DEEPSEEK_API_KEY 环境变量（可读取 .dsh-home/.credentials.yaml 中的同名项注入）');
    process.exit(2);
  }

  // 跨进程写锁：父进程直写 outline/premise（全程持有，覆盖 ① 的 LLM 长调用窗口）。
  // 只对目录已存在的目标加锁：目录不存在（如前提路径拼错）时该文件必然写入失败并走回滚路径，
  // 无需防并发覆盖；且此处 mkdir 会掩盖"写失败→回滚"的既有语义（测试依赖该语义验证回滚）。
  // canon 不在此持有——子进程 extract-llm 会经 --canon-out 拿 canon 锁、--out 拿 extractOut 锁，
  // 父进程若同时持有 canon 锁会让子进程必然失败（父子锁冲突）；书名对齐阶段（子进程已退出）
  // 再临时拿 canon 锁（见下）。锁机制与 extract-llm/simulate 一致，详见 src/fsutil.js。
  let releaseOutLock = null;
  {
    const lockTargets = [outlinePath, premisePath].filter((p) => fs.existsSync(path.dirname(p)));
    if (lockTargets.length) {
      try {
        releaseOutLock = acquireFileLocks(lockTargets);
        process.on('exit', () => { if (releaseOutLock) releaseOutLock(); });
      } catch (e) {
        console.error(`✗ ${e.message}`);
        process.exit(2);
      }
    }
  }
  // 父进程全程持有的锁目标（outline/premise）——回滚这些文件时锁已在握，无需重取；
  // canon 锁随子进程 extract-llm 退出而释放，回滚时需临时重取（见 rollbackFile）。
  const heldLockTargets = new Set([outlinePath, premisePath].filter((p) => fs.existsSync(path.dirname(p))));

  // 回滚：锁内原子恢复。回滚发生在子进程 extract-llm 退出之后——canon 锁已随子进程释放，
  // 若直接 copyFileSync 覆写，会与并发写者竞争：既非原子（读者可能读到半截文件），
  // 又可能在在途写者持锁时强行覆盖其内容。此处对未持有的目标（canon）临时持锁，
  // 用「临时文件+rename」原子替换；对已持有的目标（outline/premise）直接原子恢复。
  // 锁冲突（并发写者进行中）时放弃回滚、保留备份供手动恢复，而不是强行覆盖。
  function rollbackFile(backupPath, targetPath, label) {
    if (!backupPath) return;
    const restore = () => {
      const content = fs.readFileSync(backupPath, 'utf8');
      atomicWrite(targetPath, content);
      console.error(`  ✓ 已回滚 ${label}（恢复备份）`);
    };
    if (heldLockTargets.has(targetPath)) {
      try { restore(); } catch (e) { console.error(`  ✗ 回滚 ${label} 失败: ${e.message}（备份仍在 ${backupPath}，可手动恢复）`); }
      return;
    }
    let releaseLock = null;
    try { releaseLock = acquireFileLock(targetPath); }
    catch (e) { console.error(`  ✗ 回滚 ${label} 跳过（${targetPath} 正被其他进程写入，备份保留在 ${backupPath}）: ${e.message}`); return; }
    try { restore(); }
    catch (e) { console.error(`  ✗ 回滚 ${label} 失败: ${e.message}（备份仍在 ${backupPath}，可手动恢复）`); }
    finally { releaseLock(); }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  文检 novel-compiler v${VERSION} · 重构`);
  console.log(`  手稿 : ${msPath}`);
  console.log(`  目标 : canon=${canonPath} · outline=${outlinePath} · premise=${premisePath}`);
  console.log(`  模型 : ${model}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 备份（自动清理：每个文件只保留最近 backupKeep 个 .bak-*）
  const b1 = backup(canonPath);
  const b2 = backup(outlinePath);
  const b3 = backup(premisePath);
  if (b1 || b2 || b3) {
    console.log('备份:');
    if (b1) console.log(`  canon    -> ${b1}`);
    if (b2) console.log(`  outline  -> ${b2}`);
    if (b3) console.log(`  premise  -> ${b3}`);
  }
  const pruned = pruneBackups(canonPath, backupKeep) + pruneBackups(outlinePath, backupKeep) + pruneBackups(premisePath, backupKeep);
  if (pruned) console.log(`备份清理: 移除旧备份 ${pruned} 个（每个文件保留最近 ${backupKeep} 个）`);

  // ---------- ① canon ----------
  console.log('\n[1/3] 提取 canon（基线保留 + 僵尸清理）…');
  const extractArgs = [path.join(__dirname, 'extract-llm.js'), msPath, '--canon', canonPath, '--reader', effectiveReader, '--model', model];
  if (existingCanon === null) extractArgs.splice(extractArgs.indexOf('--canon'), 2); // 无基线
  extractArgs.push('--retire-stale'); // 全量提取：正文零提及的旧条目自动移除
  if (titleArg) extractArgs.push('--title', titleArg);
  extractArgs.push('--canon-out', canonPath);
  if (extractOut) extractArgs.push('--out', extractOut);
  const r1 = spawnSync(process.execPath, extractArgs, { stdio: 'inherit', env: process.env, timeout: TOOL_TIMEOUT_MS });
  if (r1.error || r1.status === null) {
    console.error(`✗ ① canon 提取超时或执行失败（超过 ${Math.round(TOOL_TIMEOUT_MS / 1000)}s，可用 TOOL_TIMEOUT_MS 调整）: ${r1.error ? r1.error.message : '进程被终止'}`);
    process.exit(2);
  }
  if (r1.status !== 0) {
    console.error(`✗ ① canon 提取失败（exit ${r1.status}），重构中止（未改动 outline/premise）`);
    process.exit(2);
  }

  // ---------- ② 大纲回写 ----------
  console.log('\n[2/3] 回写大纲（as-built）…');
  {
    const o = buildOutlinePrompt({ manuscript, existingOutline, premise: existingPremise, cfg, title: titleArg });
    const est = estimateTokens(o.system) + estimateTokens(o.user);
    if (est > INPUT_BUDGET_TOKENS) {
      console.warn(`⚠ 大纲回写提示词估算约 ${est} tokens，超出输入预算（${INPUT_BUDGET_TOKENS}）——超长正文可能导致输出截断。`);
    }
    try { assertInputWithinHardLimit('大纲回写', est); }
    catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  }
  let outline;
  try {
    const o = buildOutlinePrompt({ manuscript, existingOutline, premise: existingPremise, cfg, title: titleArg });
    outline = await chatTextValidated({
      apiKey: env.apiKey, baseUrl: env.baseUrl, model,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
      validate: (t) => validateOutline(t, manuscript),
      temperature: 0.5,
    });
  } catch (e) {
    if (e.validationErrors) {
      console.error('✗ 大纲回写未通过校验，放弃：');
      e.validationErrors.slice(0, 10).forEach((x) => console.error(`  - ${x}`));
    } else console.error(`✗ 大纲回写失败: ${e.message}`);
    // ②失败但 ①已落盘：回滚 canon，避免「新 canon + 旧 outline」不一致状态残留
    rollbackFile(b1, canonPath, 'canon');
    process.exit(1);
  }
  if (titleArg) outline = outline.replace(/^#\s*.*$/m, `# ${titleArg} · 分章大纲`);
  try {
    atomicWrite(outlinePath, outline);
    console.log(`✓ 大纲已写入: ${outlinePath}（${outline.length} 字）`);
  } catch (e) {
    // ② 落盘失败但 ① 已落盘：回滚 canon（outline 未被改动——atomicWrite 失败不碰原文件），
    // 避免「新 canon + 旧 outline/premise」不一致状态残留。与 ③ 前提落盘失败的回滚对称。
    console.error(`✗ 大纲写入失败: ${e.message}`);
    rollbackFile(b1, canonPath, 'canon');
    process.exit(1);
  }

  // ---------- ③ 前提回写 ----------
  console.log('\n[3/3] 回写前提（as-built）…');
  {
    const p0 = buildPremisePrompt({ manuscript, existingPremise, outline, cfg, title: titleArg });
    const est = estimateTokens(p0.system) + estimateTokens(p0.user);
    if (est > INPUT_BUDGET_TOKENS) {
      console.warn(`⚠ 前提回写提示词估算约 ${est} tokens，超出输入预算（${INPUT_BUDGET_TOKENS}）——超长正文可能导致输出截断。`);
    }
    try { assertInputWithinHardLimit('前提回写', est); }
    catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  }
  let premise;
  try {
    const p = buildPremisePrompt({ manuscript, existingPremise, outline, cfg, title: titleArg });
    premise = await chatTextValidated({
      apiKey: env.apiKey, baseUrl: env.baseUrl, model,
      messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.user }],
      validate: validatePremise,
      temperature: 0.4,
    });
  } catch (e) {
    if (e.validationErrors) {
      console.error('✗ 前提回写未通过校验，放弃：');
      e.validationErrors.slice(0, 10).forEach((x) => console.error(`  - ${x}`));
    } else console.error(`✗ 前提回写失败: ${e.message}`);
    // ③失败但 ①②已落盘：回滚 outline + canon，避免三文件不一致
    rollbackFile(b2, outlinePath, 'outline');
    rollbackFile(b1, canonPath, 'canon');
    process.exit(1);
  }
  if (titleArg) premise = premise.replace(/^#\s*.*$/m, `# ${titleArg} · 前提设定`);
  try {
    atomicWrite(premisePath, premise);
    console.log(`✓ 前提已写入: ${premisePath}（${premise.length} 字）`);
  } catch (e) {
    // ③ 写入失败但 ①② 已落盘：回滚 outline + canon（premise 未被改动——atomicWrite 失败不碰原文件）
    console.error(`✗ 前提写入失败: ${e.message}`);
    rollbackFile(b2, outlinePath, 'outline');
    rollbackFile(b1, canonPath, 'canon');
    process.exit(1);
  }

  // ---------- 书名对齐（确定性） ----------
  // 先无锁预读：用于对齐判定，且供末尾同步检查使用（syncReport 需要 canon）。
  let canonNow = null;
  try { canonNow = JSON.parse(fs.readFileSync(canonPath, 'utf8')); } catch { /* 提示缺失 */ }
  const coreTitle = (s) => s.replace(/·.*$/, '').replace(/《|》/g, '').trim();
  const outlineH1 = (() => { const m = outline && outline.match(/^#\s*(.+)$/m); return m ? m[1].trim() : null; })();
  if (canonNow && canonNow.meta && outlineH1 && coreTitle(canonNow.meta.title) !== coreTitle(outlineH1)) {
    // 临时拿 canon 锁：子进程 extract-llm 已退出（其锁已释放），此处覆盖式改 canon 前防另一进程并发写
    let releaseCanonLock = null;
    try { releaseCanonLock = acquireFileLock(canonPath); }
    catch (e) { console.warn(`⚠ 书名对齐跳过（canon 被其他进程占用）: ${e.message}`); }
    if (releaseCanonLock) {
      try {
        // 锁内重读再判定：预读与拿锁之间的并发写入以最新内容为准——消除「预读 → 拿锁 → 写」
        // 窗口内基于陈旧快照覆盖并发写者新内容的 TOCTOU（读改写全周期都在锁内）
        let fresh = null;
        try { fresh = JSON.parse(fs.readFileSync(canonPath, 'utf8')); } catch { /* 保留预读值 */ }
        if (fresh && fresh.meta && coreTitle(fresh.meta.title) !== coreTitle(outlineH1)) {
          const old = fresh.meta.title;
          fresh.meta.title = coreTitle(outlineH1);
          atomicWrite(canonPath, JSON.stringify(fresh, null, 2) + '\n');
          console.log(`\n书名对齐: canon meta.title「${old}」→「${fresh.meta.title}」（以大纲为准）`);
        }
        if (fresh) canonNow = fresh; // 同步检查基于最新 canon（即使本次未写入，也避免用过期预读值）
      } finally { releaseCanonLock(); }
    }
  }

  // ---------- 同步检查 ----------
  const syncIssues = syncReport({ manuscript, canon: canonNow, outline, premise });
  console.log('\n同步检查:');
  if (!syncIssues.length) console.log('  ✓ 正文 / canon / 大纲 / 前提 章节集合与标题一致');
  else syncIssues.forEach((s) => console.log(`  ${s}`));

  console.log('\n✓ 重构完成：canon / outline / premise 已从正文逆推并重写。');
  console.log('  原文件备份在 .bak-* 中；如需逐条审阅 canon 变更请使用 IDE ⑤ 审阅。');
  process.exit(0);
}

main(process.argv).catch((e) => {
  console.error(`✗ 重构失败: ${e && e.message ? e.message : String(e)}`);
  process.exit(2);
});
