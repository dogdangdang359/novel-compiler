#!/usr/bin/env node
'use strict';

// 文检 novel-compiler · 模拟器 —— AI 先行：大纲 + 前提 + 读者向 -> 预测 canon + 风险登记册
// 用法: node simulate.js <outline.md> [--premise <premise.md>] [--reader ...] [--out <file.json>] [--json] [--dry-run] [--model <model>]
// 退出码: 0 = 成功 · 1 = 校验重试后仍失败 · 2 = 输入/环境错误

const fs = require('fs');
const path = require('path');
const { chatJSONValidated } = require('./src/llm');
const { estimateTokens, INPUT_BUDGET_TOKENS, assertInputWithinHardLimit } = require('./src/llm');
const { buildSimulatePrompt } = require('./src/prompts');
const { validateCanon, configFor, READERS } = require('./src/validate');
const { loadLLMEnv } = require('./src/env');
const { missingKeyHint } = require('./src/providers');
const { loadWjrc, applyWjrc } = require('./src/wjrc');
const { atomicWrite, acquireFileLocks, checkFileLocked } = require('./src/fsutil');
const { VERSION } = require('./src/version');
const { takeValue } = require('./src/cli');
const { CANON_SECTIONS, asArray } = require('./src/canon');

function usage() {
  return [
    `文检 novel-compiler v${VERSION} · 模拟器`,
    '',
    '用法: node simulate.js <outline.md> [选项]',
    '',
    '选项:',
    '  --premise <premise.md>              前提设定（世界规则/角色初始/风格基线）',
    '  --canon <canon.json>                已有 canon（权威基线）：预测必须保留其中所有条目的 id/name，只做补全/修正/增补',
    '  --reader <webnovel|genre|published> 读者向（缺省取 canon.meta.target_reader，再缺省 genre）',
    '  --out <file.json>                   预测结果写入文件',
    '  --json                              打印完整预测 JSON',
    '  --dry-run                           只打印将发送的提示词，不调用 LLM',
    '  --model <model>                     覆盖模型（默认 DEEPSEEK_MODEL 或 deepseek-chat）',
    '  -h, --help                          帮助',
    '',
    '环境变量: DEEPSEEK_API_KEY（必填）· DEEPSEEK_BASE_URL · DEEPSEEK_MODEL',
    '模型: 默认 deepseek-chat（快速、JSON 原生）；推理模型（deepseek-v4-flash）也可用但较慢，',
    '      可用 DEEPSEEK_MODEL=deepseek-v4-flash 或 --model 切换（预算不足会自动升级）',
    '退出码: 0 = 成功 · 1 = 输出未通过校验（已自动重试）· 2 = 输入/环境错误',
  ].join('\n');
}

const RISK_KINDS = ['motivation', 'continuity', 'pacing', 'suspense', 'world', 'information'];

function lightValidate(pred) {
  const errors = [];
  if (!pred || typeof pred !== 'object') return ['输出不是 JSON 对象'];
  if (!pred.canon || typeof pred.canon !== 'object') errors.push('缺少 canon 对象');
  if (!Array.isArray(pred.risk_register)) errors.push('risk_register 必须是数组');
  else pred.risk_register.forEach((r, i) => {
    if (!r || typeof r !== 'object') return errors.push(`risk_register[${i}] 必须是对象`);
    for (const f of ['id', 'risk']) if (typeof r[f] !== 'string' || !r[f]) errors.push(`risk_register[${i}].${f} 必填字符串`);
    if (!['high', 'medium', 'low'].includes(r.severity)) errors.push(`risk_register[${i}].severity 必须是 high/medium/low`);
    if (typeof r.probability !== 'number' || r.probability < 0 || r.probability > 1) errors.push(`risk_register[${i}].probability 必须是 0-1 数字`);
    if (r.chapter !== undefined && (!Number.isInteger(r.chapter) || r.chapter < 0)) errors.push(`risk_register[${i}].chapter 必须是非负整数`);
    if (r.kind !== undefined && !RISK_KINDS.includes(r.kind)) errors.push(`risk_register[${i}].kind 必须是 ${RISK_KINDS.join('/')} 之一`);
    for (const f of ['trigger', 'mitigation']) if (r[f] !== undefined && typeof r[f] !== 'string') errors.push(`risk_register[${i}].${f} 必须是字符串`);
  });
  if (!Array.isArray(pred.simulation_notes)) errors.push('simulation_notes 必须是数组');
  return errors;
}

async function main(argv) {
  const args = argv.slice(2);
  let outlinePath = null;
  let premisePath = null;
  let canonPath = null;
  let reader = null;
  let outFile = null;
  let json = false;
  let dryRun = false;
  let modelArg = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--premise') { premisePath = takeValue(args, i, '--premise', '<前提.md>'); i++; }
    else if (a === '--canon') { canonPath = takeValue(args, i, '--canon', '<canon.json>'); i++; }
    else if (a === '--reader') { reader = takeValue(args, i, '--reader', '<webnovel|genre|published>'); i++; }
    else if (a === '--out') { outFile = takeValue(args, i, '--out', '<file.json>'); i++; }
    else if (a === '--json') json = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--model') { modelArg = takeValue(args, i, '--model', '<模型名>'); i++; }
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else if (outlinePath === null) outlinePath = a;
    else { console.error(usage()); process.exit(2); }
  }
  if (!outlinePath) { console.error(usage()); process.exit(2); }
  if (reader !== null && !READERS.includes(reader)) {
    console.error(`✗ --reader 必须是 ${READERS.join(' / ')} 之一，当前为 "${reader}"`);
    process.exit(2);
  }

  // 读协调：simulate 是全量长计算（提示词 + LLM 分钟级），消费共享输入前感知在途写者——
  // 原子写保证读不到半截文件，但写者「读-改-写」长窗口内磁盘是写入前的旧快照，本次模拟基于它、
  // 写者完成后即过期。警告不阻断（对当前快照的模拟仍有效）。与 compile.js 读协调口径一致。
  for (const p of [outlinePath, premisePath, canonPath].filter(Boolean)) {
    const lk = checkFileLocked(p);
    if (lk.locked) console.error(`⚠ 输入文件正被其他进程写入（${lk.lockPath}）——本次模拟基于写入前的快照，结果可能过期；请等待写入完成后再模拟`);
  }

  let outline, premise, existingCanon;
  try { outline = fs.readFileSync(outlinePath, 'utf8'); }
  catch (e) { console.error(`✗ 无法读取大纲: ${outlinePath}（${e.message}）`); process.exit(2); }
  if (premisePath) {
    try { premise = fs.readFileSync(premisePath, 'utf8'); }
    catch (e) { console.error(`✗ 无法读取前提: ${premisePath}（${e.message}）`); process.exit(2); }
  }
  if (canonPath) {
    try { existingCanon = JSON.parse(fs.readFileSync(canonPath, 'utf8')); }
    catch (e) { console.error(`✗ 无法解析已有 canon: ${canonPath}（${e.message}）`); process.exit(2); }
    const v = validateCanon(existingCanon);
    if (!v.ok) {
      console.error(`✗ 已有 canon 校验失败:`);
      v.errors.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
      process.exit(2);
    }
  }

  // 读者向缺省口径与 compile 一致：命令行 > canon.meta.target_reader > genre
  const effectiveReader = reader || (existingCanon && existingCanon.meta && existingCanon.meta.target_reader) || 'genre';
  // .wjrc.json 查找锚点：大纲目录优先，canon 目录兜底（与 compile 口径一致）
  const wj = loadWjrc([outlinePath, canonPath]);
  const { cfg } = applyWjrc(configFor(effectiveReader), wj);
  const { system, user } = buildSimulatePrompt({ outline, premise, reader: effectiveReader, cfg, existingCanon });

  if (dryRun) {
    console.log('════ 系统提示词 ════');
    console.log(system);
    console.log('════ 用户提示词 ════');
    console.log(user);
    process.exit(0);
  }

  // 跨进程写锁（与 extract-llm 同机制）：CLI 直跑 simulate 与 IDE（spawn 同一 CLI）或
  // 另一 CLI 并发写同一 --out（如 last-pred.json）时，后到者快速失败而非白算后静默覆盖。
  // rebase 的 target 由本工具的子进程路径持锁写入，此处一并覆盖。
  let releaseOutLock = null;
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    try {
      releaseOutLock = acquireFileLocks([outFile]);
      process.on('exit', () => { if (releaseOutLock) releaseOutLock(); });
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(2);
    }
  }

  // 输入预算警告（模拟是全量输入，超预算大概率输出截断/失败；不截断，交由用户决策）
  const est = estimateTokens(system) + estimateTokens(user);
  if (est > INPUT_BUDGET_TOKENS) {
    console.warn(`⚠ 提示词估算约 ${est} tokens，超出输入预算（${INPUT_BUDGET_TOKENS}）。`);
    console.warn('  模拟需要全局一致性，不做自动分块；建议精简大纲/前提，或拆分故事线分段模拟（每次以已有 canon 为基线）。');
  }
  // 硬护栏：估算超上限的调用必败，直接拒绝
  try { assertInputWithinHardLimit('模拟器', est); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

  const env = loadLLMEnv();
  if (!env.apiKey) {
    console.error(`✗ ${missingKeyHint(env.provider)}`);
    process.exit(2);
  }
  const model = modelArg || env.model;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const validate = (raw) => {
    const errors = [...lightValidate(raw)];
    if (errors.length === 0) {
      const v = validateCanon(raw.canon);
      if (v.ok && existingCanon) {
        // 权威基线保留检查：已有 canon 的全部条目（按 id）必须出现在预测中
        for (const section of CANON_SECTIONS) {
          const existing = new Set(asArray(existingCanon[section]).map((x) => x.id));
          const predIds = new Set(asArray(raw.canon[section]).map((x) => x.id));
          for (const id of existing) if (!predIds.has(id)) errors.push(`canon.${section}: 已有条目 "${id}" 在预测中缺失（不得删除基线条目）`);
        }
      }
      if (!v.ok) errors.push(...v.errors.map((x) => `canon: ${x}`));
    }
    return errors;
  };

  let pred;
  try {
    pred = await chatJSONValidated({
      apiKey: env.apiKey, baseUrl: env.baseUrl, model, messages,
      validate, temperature: 0.7,
    });
  } catch (e) {
    if (e.validationErrors) {
      console.error(`✗ 模拟输出未通过校验，放弃：`);
      e.validationErrors.slice(0, 20).forEach((x) => console.error(`  - ${x}`));
      process.exit(1);
    }
    console.error(`✗ LLM 调用失败: ${e.message}`);
    process.exit(2);
  }

  const canon = pred.canon;
  const risks = pred.risk_register;
  const notes = pred.simulation_notes;
  const sevCount = { high: 0, medium: 0, low: 0 };
  risks.forEach((r) => { if (sevCount[r.severity] !== undefined) sevCount[r.severity] += 1; });

  const envelope = {
    tool: 'novel-compiler/simulate',
    version: VERSION,
    meta: {
      title: canon.meta && canon.meta.title,
      target_reader: canon.meta && canon.meta.target_reader,
      genre: canon.meta && canon.meta.genre,
      model,
      simulated_at: new Date().toISOString(),
      // 绝对路径：信封会被 rebase 从任意 cwd 读取（相对路径会导致跨目录解析错误）
      source_outline: path.resolve(outlinePath),
      source_premise: premisePath ? path.resolve(premisePath) : null,
      source_canon: canonPath ? path.resolve(canonPath) : null,
    },
    canon,
    risk_register: risks,
    simulation_notes: notes,
  };

  const lines = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`  文检 novel-compiler v${VERSION} · 模拟完成`);
  lines.push(`  对象     : ${canon.meta.title}（${canon.meta.target_reader} · ${canon.meta.genre || '未知题材'}）`);
  if (canonPath) lines.push(`  基线     : ${canonPath}（已有条目已并入并保留）`);
  lines.push(`  canon    : ${canon.entities.length} 实体 · ${canon.knowledge.length} 知识 · ${canon.suspense.length} 悬念 · ${canon.timeline.length} 章时间线`);
  lines.push(`  风险登记 : ${risks.length} 条（high ${sevCount.high} · medium ${sevCount.medium} · low ${sevCount.low}）`);
  lines.push(`  模型     : ${model}`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (risks.length) {
    lines.push('');
    lines.push('风险登记册');
    for (const r of risks) {
      const ch = r.chapter !== undefined && r.chapter !== null ? r.chapter : '?';
      const kind = r.kind || '';
      const trigger = r.trigger || '';
      const mitigation = r.mitigation || '';
      lines.push(`  [${r.id} · ${r.severity} · 第${ch}章 · ${kind}] ${r.risk}`);
      lines.push(`    概率 ${r.probability.toFixed(2)} · 触发: ${trigger}`);
      lines.push(`    对策: ${mitigation}`);
    }
  }
  if (notes && notes.length) {
    lines.push('');
    lines.push('模拟假设');
    notes.forEach((n) => lines.push(`  · ${n}`));
  }
  lines.push('');
  lines.push('预测 canon 已通过 schema 校验；写完后用 compare.js 与实际 canon 比对（防漂移）。');

  if (json) console.log(JSON.stringify(envelope, null, 2));
  else console.log(lines.join('\n'));

  if (outFile) {
    // 原子写（与 extract-llm 一致）：先写临时文件再 rename 替换，避免半写状态
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    atomicWrite(outFile, JSON.stringify(envelope, null, 2) + '\n');
    if (!json) console.log(`预测已写入: ${outFile}`);
  }
  process.exit(0);
}

main(process.argv).catch((e) => {
  console.error(`✗ 模拟失败: ${e && e.message ? e.message : String(e)}`);
  process.exit(2);
});