#!/usr/bin/env node
'use strict';

// 文检 novel-compiler · 提取器 —— 正文 -> 提议 canon（含逐条行号证据，反幻觉校验）
// 用法: node extract-llm.js <手稿.md> [--canon <baseline.json>] [--reader ...] [--out <proposed.json>] [--json] [--dry-run] [--model ...]
// 退出码: 0 = 成功 · 1 = 校验重试后仍失败 · 2 = 输入/环境错误

const fs = require('fs');
const path = require('path');
const { chatJSONValidated } = require('./src/llm');
const { estimateTokens, INPUT_BUDGET_TOKENS, HARD_INPUT_LIMIT, assertInputWithinHardLimit } = require('./src/llm');
const { loadLLMEnv } = require('./src/env');
const { missingKeyHint } = require('./src/providers');
const { validateCanon, configFor, READERS } = require('./src/validate');
const { buildExtractPrompt, validateExtraction, summarizeChanges, purgeStale, planExtractionChunks } = require('./src/extraction');
const { chapterHashes, dirtyChapters, mergeCanon, mergeEvidence, mergeOutputHashes } = require('./src/incremental');
const { parseManuscript } = require('./src/extract');
const { atomicWrite, writeChunkCheckpoint, clearChunkCheckpoint, acquireFileLocks } = require('./src/fsutil');
const { takeValue } = require('./src/cli');
const { asArray } = require('./src/canon');
const { VERSION } = require('./src/version');

function usage() {
  return [
    `文检 novel-compiler v${VERSION} · 提取器`,
    '',
    '用法: node extract-llm.js <手稿.md> [选项]',
    '',
    '选项:',
    '  --canon <canon.json>                基线 canon：提取必须保留其全部条目 id/name，并按正文修正字段值',
    '  --from <章号> --to <章号>            手动范围提取：只提取指定章节范围（范围外条目一律按基线保留）',
    '  --incremental                       增量提取：自动检测脏章节（对比 --merge-with 的 chapter_hashes），只提取脏章并与上次结果合并',
    '  --merge-with <信封.json>            上次提取的信封（提供 chapter_hashes/evidence/旧 canon）；缺失或首次运行自动退化为全量提取',
    '                                    增量与 --from/--to 范围模式都读取：输出哈希只写已提取章，',
    '                                    未提取章沿用旧哈希（无旧哈希则下次增量判脏），防止未提取章被"洗白"为干净',
    '                                    缺省取 canon 同目录的 last-extract.json（按项目隔离，多项目互不污染）',
    '  --resume                            断点续跑：从 <out>.partial 分块检查点继续（跳过已完成且未变更的章，需 --out；',
    '                                    检查点由分块提取每批完成时自动写入，失败/中断后原命令加 --resume 重跑即可）',
    '  --retire-stale                       全量提取后清理僵尸设定：正文零提及且已到期的实体/知识自动移除（防止换作品后旧故事残留）',
    '  --title <书名>                       强制 meta.title',
    '  --reader <webnovel|genre|published> 读者向（缺省 genre）',
    '  --out <file.json>                   提议 canon 写入文件（信封：canon + evidence）',
    '  --canon-out <canon.json>            原始 canon（不含证据信封）写入该文件（重构流水线用，原子写）',
    '  --json                              打印完整提取 JSON',
    '  --dry-run                           只打印将发送的提示词，不调用 LLM',
    '  --model <model>                     覆盖模型（默认 DEEPSEEK_MODEL 或 deepseek-chat）',
    '  -h, --help                          帮助',
    '',
    '环境变量: DEEPSEEK_API_KEY（必填）· DEEPSEEK_BASE_URL · DEEPSEEK_MODEL · LLM_INPUT_BUDGET_TOKENS（输入预算，缺省 48000）· LLM_MODEL_CONTEXT_TOKENS（模型上下文上限，缺省 128000，硬护栏不越此值）',
    '自动分块: 全量提取（无 --from/--to、无 --incremental）且已有基线时，正文+基线估算超输入预算',
    '         （LLM_INPUT_BUDGET_TOKENS，缺省 48000）自动按章分批调用并逐批合并（meta.auto_chunked 记录批次）。',
    '输出说明: 每条新增设定都带行号证据（quote 逐字命中验证，防幻觉）；',
    '         提取出的提议 canon 可直接喂给 compile.js 做自动检查（compile 已支持信封输入）。',
    '退出码: 0 = 成功 · 1 = 输出未通过校验（已自动重试）· 2 = 输入/环境错误',
  ].join('\n');
}

async function main(argv) {
  const args = argv.slice(2);
  let msPath = null;
  let canonPath = null;
  let reader = null;
  let outFile = null;
  let canonOut = null;
  let json = false;
  let dryRun = false;
  let modelArg = null;
  let from = null;
  let to = null;
  let retireStale = false;
  let titleArg = null;
  let incremental = false;
  let mergeWithPath = null;
  let resume = false;

  // 章号必须是非负整数字符串（parseInt 会容忍 "2abc" 这类尾部垃圾，这里严格校验）
  const parseChapter = (s) => (/^\d+$/.test(s) ? parseInt(s, 10) : NaN);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--canon') { canonPath = takeValue(args, i, '--canon', '<canon.json>'); i++; }
    else if (a === '--from') { from = parseChapter(takeValue(args, i, '--from', '<章号>')); i++; }
    else if (a === '--to') { to = parseChapter(takeValue(args, i, '--to', '<章号>')); i++; }
    else if (a === '--retire-stale') retireStale = true;
    else if (a === '--title') { titleArg = takeValue(args, i, '--title', '<书名>'); i++; }
    else if (a === '--incremental') incremental = true;
    else if (a === '--resume') resume = true;
    else if (a === '--merge-with') { mergeWithPath = takeValue(args, i, '--merge-with', '<信封.json>'); i++; }
    else if (a === '--reader') { reader = takeValue(args, i, '--reader', '<webnovel|genre|published>'); i++; }
    else if (a === '--out') { outFile = takeValue(args, i, '--out', '<file.json>'); i++; }
    else if (a === '--canon-out') { canonOut = takeValue(args, i, '--canon-out', '<canon.json>'); i++; }
    else if (a === '--json') json = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--model') { modelArg = takeValue(args, i, '--model', '<模型名>'); i++; }
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else if (msPath === null) msPath = a;
    else { console.error(usage()); process.exit(2); }
  }
  if (!msPath) { console.error(usage()); process.exit(2); }
  if (reader !== null && !READERS.includes(reader)) {
    console.error(`✗ --reader 必须是 ${READERS.join(' / ')} 之一，当前为 "${reader}"`);
    process.exit(2);
  }
  if ((from !== null && Number.isNaN(from)) || (to !== null && Number.isNaN(to))) {
    console.error('✗ --from / --to 必须是正整数章号（如 --from 3 --to 5）');
    process.exit(2);
  }
  if ((from !== null && from < 1) || (to !== null && to < 1)) {
    console.error('✗ --from / --to 章号必须 ≥ 1');
    process.exit(2);
  }
  if (from !== null && to !== null && from > to) {
    console.error(`✗ --from（${from}）不能大于 --to（${to}）`);
    process.exit(2);
  }
  if (resume) {
    if (!outFile) { console.error('✗ --resume 需要 --out（分块检查点位于 <out>.partial）'); process.exit(2); }
    if (canonPath) { console.error('✗ --resume 与 --canon 互斥：续跑基线来自检查点本身'); process.exit(2); }
    if (incremental) { console.error('✗ --resume 与 --incremental 互斥'); process.exit(2); }
    if (from !== null || to !== null) { console.error('✗ --resume 与 --from/--to 互斥（续跑范围由检查点自动推导）'); process.exit(2); }
  }
  // 跨进程写锁（读-改-写全周期持锁）：extract 的基线 canon（--canon）与合并源（--merge-with）
  // 通常正是本次输出（--canon-out / --out，如重构子进程 --canon X --canon-out X、IDE 增量
  // --merge-with last-extract.json --out last-extract.json）。锁若只在"准备写"时才拿，基线读取
  // 就落在协议之外：另一写者在「读基线 → 拿锁」窗口内完成写入后，本进程会基于过期基线合并再
  // 覆盖——静默丢更新。因此输出锁必须先于任何输入读取（含分块检查点）。后到者快速失败并给出
  // 明确提示；进程退出时经 exit 钩子释放，崩溃遗留的陈旧锁由后续获取者按 mtime 超时回收（见 src/fsutil.js）。
  let releaseOutLock = null;
  if ((outFile || canonOut) && !dryRun) {
    // 批量锁：--out 信封与 --canon-out 原始 canon 都可能被多进程并发写（重构流水线/IDE/CLI），
    // 两者都纳入保护；路径去重（极端下同一文件），任一失败快速退出
    const lockTargets = [];
    if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); lockTargets.push(outFile); }
    if (canonOut && canonOut !== outFile) { fs.mkdirSync(path.dirname(canonOut), { recursive: true }); lockTargets.push(canonOut); }
    try {
      releaseOutLock = acquireFileLocks(lockTargets);
      process.on('exit', () => { if (releaseOutLock) releaseOutLock(); });
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(2);
    }
  }
  let manuscript, baseline = null;
  let checkpointEnv = null;   // --resume：分块检查点信封（canon/evidence/已完成章键集）
  const checkpointPath = resume ? `${outFile}.partial` : null;
  try { manuscript = fs.readFileSync(msPath, 'utf8'); }
  catch (e) { console.error(`✗ 无法读取手稿: ${msPath}（${e.message}）`); process.exit(2); }
  if (resume) {
    let cp = null;
    try { cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); }
    catch { console.error(`✗ 未找到可续跑的分块检查点: ${checkpointPath}（检查点由分块提取失败时自动写入）`); process.exit(2); }
    if (!cp || !cp.meta || !cp.meta.partial) {
      console.error(`✗ ${checkpointPath} 不是分块检查点（缺少 meta.partial）——--resume 仅接受本工具写出的 <out>.partial`);
      process.exit(2);
    }
    if (!Array.isArray(cp.meta.partial.done_keys)) {
      console.error(`✗ 检查点缺少 done_keys（旧版本产物），不支持 --resume。可手动续跑：node extract-llm.js ${msPath} --canon ${checkpointPath} --from <失败批起> --to <失败批止> --out ${outFile}`);
      process.exit(2);
    }
    const srcMs = cp.meta.source_manuscript;
    if (srcMs && path.resolve(srcMs) !== path.resolve(msPath)) {
      console.warn(`⚠ 检查点记录的手稿为 ${srcMs}，与当前 ${msPath} 不同——以章节哈希校验为准，哈希不一致的章将重新提取`);
    }
    checkpointEnv = cp;
    baseline = cp.canon;
    const v = validateCanon(baseline);
    if (!v.ok) {
      console.error('✗ 检查点 canon 校验失败:');
      v.errors.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
      process.exit(2);
    }
  } else if (canonPath) {
    try { baseline = JSON.parse(fs.readFileSync(canonPath, 'utf8')); }
    catch (e) { console.error(`✗ 无法解析基线 canon: ${canonPath}（${e.message}）`); process.exit(2); }
    const v = validateCanon(baseline);
    if (!v.ok) {
      console.error('✗ 基线 canon 校验失败:');
      v.errors.slice(0, 10).forEach((e) => console.error(`  - ${e}`));
      process.exit(2);
    }
  }

  // ---------- 增量/范围模式：脏章节检测与旧哈希 ----------
  let mergeSrc = null;
  let dirty = null;
  let oldHashes = null;
  // 默认合并源按项目推导：canon 同目录的 last-extract.json（CLI 多项目各自独立）。
  // 旧全局默认（app/predictions/last-extract.json）会被多项目 CLI 用户互相覆盖——
  // 项目 A 的哈希/证据被误当项目 B 的基线，导致脏章误判与证据错配（数据污染）。
  // 无 --canon 时（增量模式必填基线，理论不可达）回退全局路径。
  const mergeWithUsed = mergeWithPath
    || (canonPath ? path.join(path.dirname(path.resolve(canonPath)), 'last-extract.json') : path.join(__dirname, 'app', 'predictions', 'last-extract.json'));
  if (incremental) {
    if (!baseline) { console.error('✗ 增量模式需要 --canon 基线'); process.exit(2); }
    if (from !== null || to !== null) { console.error('✗ --incremental 与 --from/--to 互斥'); process.exit(2); }
  }
  // mergeSrc：增量模式（脏检测/证据合并）与手动范围模式（哈希继承）都读取——
  // 范围运行输出哈希只写已提取章，未提取章沿用旧哈希，防止被"洗白"为干净
  if (incremental || from !== null || to !== null) {
    try { mergeSrc = JSON.parse(fs.readFileSync(mergeWithUsed, 'utf8')); }
    catch {
      if (incremental) console.warn(`⚠ 未找到上次提取（${mergeWithUsed}），退化为全量提取`);
      mergeSrc = null;
    }
  }
  if (resume) {
    // 续跑：检查点即合并源（输出哈希继承检查点值——未重跑章保持干净，编辑过的章下次增量判脏）
    mergeSrc = checkpointEnv;
    oldHashes = (checkpointEnv.meta && checkpointEnv.meta.chapter_hashes) || null;
  }

  // 章节哈希：全量/增量都记录（全量记录后，下一次增量才能只提取真正改动的章节）
  const currentHashes = chapterHashes(manuscript);
  if (mergeSrc && (incremental || from !== null || to !== null)) {
    oldHashes = (mergeSrc.meta && mergeSrc.meta.chapter_hashes) || null;
    if (incremental && !oldHashes) {
      console.warn(`⚠ 上次提取（${mergeWithUsed}）缺少 chapter_hashes（旧版本产物），本次全部章节视为脏章（等效全量提取）；本次输出将记录哈希，之后恢复正常增量`);
    }
    if (incremental) dirty = dirtyChapters(currentHashes, oldHashes || {});
  }

  const range = incremental && dirty
    ? { chapters: dirty }
    : (from !== null || to !== null
      ? { from: from ?? 1, to: to ?? Number.MAX_SAFE_INTEGER }
      : null);

  // 全量提取自动分块：正文+基线估算超预算且已有基线时，按章分批调用并逐批合并
  // （分块需要基线背书：无基线时模型看不到范围外章节，无法满足时间线完整性校验）。
  // 覆盖三类"等效全量"：普通全量、增量退化（无 mergeSrc / 旧版无哈希）——
  // 旧实现增量退化后走单次全量调用，长稿静默超上下文，与分块功能直接冲突。
  const isRealIncremental = incremental && mergeSrc && dirty && dirty.length > 0 && oldHashes;
  let autoChunks = (from === null && to === null && baseline && !isRealIncremental)
    ? planExtractionChunks({ manuscript, baseline, maxTokens: INPUT_BUDGET_TOKENS })
    : null;
  if (autoChunks) {
    // 单章过大（含头部开销）超预算时无法再拆——提醒输出预算升级可能撞上下文上限
    const over = autoChunks.filter((c) => c.tokens > INPUT_BUDGET_TOKENS);
    if (over.length) {
      console.warn(`⚠ ${over.length} 个批次估算超预算（单章过大无法再拆）：${over.map((c) => `第${c.from}-${c.to}章≈${c.tokens} tokens`).join('、')}——输出预算升级时可能超出上下文上限，建议拆分该章或提高 LLM_INPUT_BUDGET_TOKENS 前先确认模型上下文`);
    }
    // 批次超硬上限 = 必败调用（预算配得比模型上下文还大时，规划器照样按预算打包），
    // 规划期即可判定，直接拒绝——否则逐批调用逐批 400，白烧钱
    const doomed = autoChunks.filter((c) => c.tokens > HARD_INPUT_LIMIT);
    if (doomed.length) {
      console.error(`✗ ${doomed.length} 个批次估算超硬上限（${doomed.map((c) => `第${c.from}-${c.to}章≈${c.tokens} tokens`).join('、')} > ${HARD_INPUT_LIMIT}，单章无法再拆）——调用必然失败，请拆分该章、分卷管理，或确认 LLM_INPUT_BUDGET_TOKENS / LLM_MODEL_CONTEXT_TOKENS 配置`);
      process.exit(2);
    }
    // 分块范围仅覆盖编号章：手稿含番外/尾声（number=null）时明确警告——
    // 单次全量（numberLines 含番外）与分块全量（numberLinesForChapters 排除番外）行为不一致，
    // 静默漏提会让新增番外内容不进提议 canon（IDE 增量走脏章集合支持番外，不受影响）
    const extraChapters = parseManuscript(manuscript).chapters.filter((c) => c.number === null);
    if (extraChapters.length) {
      console.warn(`⚠ 分块范围仅覆盖编号章：手稿含 ${extraChapters.length} 个无编号章节（${extraChapters.map((c) => c.title).join('、')}）不在本次分块提取范围内`);
      console.warn('  番外/尾声内容不会进入本次提议 canon；如需提取，请改用 --incremental 增量提取（脏章集合支持番外）');
    }
  }

  // ---------- --resume：按检查点裁剪剩余批（不重提取已完成且未变更的章） ----------
  // done 判据 = done_keys 命中 + 哈希一致：检查点后手稿被改的章不算 done，会被重新提取。
  // 重规划而非沿用旧批边界（检查点 canon 变大后边界自然变化），只做首部整批跳过 + from 裁剪
  let resumeInfo = null;
  if (resume) {
    if (!autoChunks) {
      console.warn('⚠ 续跑重规划后单批即可容纳全部章节，将单次提取（检查点已完成的工作会被覆盖重提取）');
    } else {
      const cpHashes = checkpointEnv.meta.chapter_hashes || {};
      const doneKeys = new Set(checkpointEnv.meta.partial.done_keys.map(Number));
      const editedDone = [];
      for (const k of doneKeys) {
        const cur = currentHashes[String(k)];
        if (cur === undefined) continue; // 该章已删除：新规划不含它，自然处理
        if (cpHashes[String(k)] !== cur) editedDone.push(k);
      }
      if (editedDone.length) console.warn(`⚠ 检查点后手稿有修改：第${editedDone.join('、')}章将重新提取`);
      const done = (n) => doneKeys.has(n) && cpHashes[String(n)] === currentHashes[String(n)];
      let skipped = 0;
      const remaining = [];
      for (const b of autoChunks) {
        let pendingFrom = null;
        for (let n = b.from; n <= b.to; n++) {
          if (!done(n)) { pendingFrom = n; break; }
        }
        if (pendingFrom === null) { skipped++; continue; }
        remaining.push(pendingFrom === b.from ? b : { ...b, from: pendingFrom });
      }
      autoChunks = remaining;
      resumeInfo = { skipped_batches: skipped, done_keys: checkpointEnv.meta.partial.done_keys, checkpoint: checkpointPath };
      if (!autoChunks.length) {
        console.log(`续跑：检查点显示全部 ${skipped} 批已完成且手稿未变——直接从检查点收尾输出，不调 LLM`);
      } else {
        console.log(`续跑：跳过已完成的 ${skipped} 批，本次提取 ${autoChunks.length} 批（第${autoChunks[0].from}-第${autoChunks[autoChunks.length - 1].to}章）`);
      }
    }
  }

  // 输出哈希的"已提取键集合"：范围运行时只写已提取章，未提取章沿用旧哈希
  // （无旧哈希则不写键 → 下次增量判脏）——防止未提取章被"洗白"为干净。
  // null = 提取了全部；空 Set = 无提取（快速路径）。
  let extractedKeys = null;
  if (incremental && dirty && dirty.length > 0) {
    extractedKeys = new Set(dirty);
  } else if (incremental && mergeSrc && dirty && dirty.length === 0) {
    extractedKeys = new Set(); // 快速路径：不提取任何章
  } else if (from !== null || to !== null) {
    const lo = from ?? 1;
    const hi = to ?? Number.MAX_SAFE_INTEGER;
    extractedKeys = new Set();
    for (const k of Object.keys(currentHashes)) {
      if (/^\d+$/.test(k) && Number(k) >= lo && Number(k) <= hi) extractedKeys.add(Number(k));
    }
  }
  // 分块路径：循环内按批累积已提取键（检查点/最终输出用）
  let chunkKeys = new Set();
  const finalHashes = () => mergeOutputHashes(currentHashes, oldHashes,
    autoChunks ? chunkKeys : extractedKeys);

  // 无脏章节快速路径：不调 LLM、不需要密钥，直接输出基线 + 旧证据（哈希沿用旧值）
  if (incremental && mergeSrc && dirty.length === 0) {
    const canon = JSON.parse(JSON.stringify(baseline));
    if (titleArg) canon.meta = { ...canon.meta, title: titleArg };
    const envelope = {
      tool: 'novel-compiler/extract-llm',
      version: VERSION,
      meta: {
        title: canon.meta && canon.meta.title,
        target_reader: canon.meta && canon.meta.target_reader,
        genre: canon.meta && canon.meta.genre,
        model: '（快速路径：无脏章节，未调 LLM）',
        extracted_at: new Date().toISOString(),
        source_manuscript: msPath,
        source_canon: canonPath || null,
        chapter_hashes: finalHashes(),
        incremental: { merged_from: mergeWithUsed, dirty_chapters: [] },
      },
      canon,
      evidence: mergeSrc.evidence || {},
      retired: null,
      extraction_notes: ['无脏章节，跳过提取（快速路径）。'],
    };
    const lines = [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `  文检 novel-compiler v${VERSION} · 提取完成（增量）`,
      `  对象     : ${canon.meta.title}（${canon.meta.target_reader} · ${canon.meta.genre || '未知题材'}）`,
      '  增量     : 无脏章节（快速路径，未调 LLM）',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ];
    if (json) console.log(JSON.stringify(envelope, null, 2));
    else console.log(lines.join('\n'));
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      atomicWrite(outFile, JSON.stringify(envelope, null, 2) + '\n');
      if (!json) console.log(`\n提议已写入: ${outFile}`);
    }
    if (canonOut) {
      fs.mkdirSync(path.dirname(canonOut), { recursive: true });
      atomicWrite(canonOut, JSON.stringify(canon, null, 2) + '\n');
      if (!json) console.log(`提议 canon（原始）已写入: ${canonOut}`);
    }
    process.exit(0);
  }

  const cfg = configFor(reader || (baseline && baseline.meta && baseline.meta.target_reader) || 'genre');

  // 无基线全量 + 估算超预算：无法自动分块，给出明确提示（不截断，交由用户决策）
  if (!baseline && !incremental && from === null && to === null && !dryRun) {
    const est = estimateTokens(manuscript) + estimateTokens(JSON.stringify(cfg));
    if (est > INPUT_BUDGET_TOKENS) {
      console.warn(`⚠ 正文估算约 ${est} tokens，超出输入预算（${INPUT_BUDGET_TOKENS}）。`);
      console.warn('  自动分块需要 --canon 基线背书；建议：先建立最小 canon 基线，或用 --from/--to 分次提取（每次用上次输出做基线）。');
    }
  }

  if (dryRun) {
    if (autoChunks) {
      if (autoChunks.length === 0) {
        console.log('自动分块（续跑）：检查点显示全部批次已完成且手稿未变——重跑将直接从检查点收尾输出，不调 LLM');
        process.exit(0);
      }
      const head = resume
        ? `自动分块（续跑）：跳过已完成的 ${resumeInfo.skipped_batches} 批，本次将提取 ${autoChunks.length} 批（每批携带检查点 canon，逐批合并）：`
        : `自动分块：正文+基线估算超预算，将分 ${autoChunks.length} 批提取（每批携带完整基线，逐批合并）：`;
      console.log(head);
      autoChunks.forEach((c, i) => console.log(`  批 ${i + 1}: 第${c.from}-${c.to}章（估算 ${c.tokens} tokens）`));
      const first = buildExtractPrompt({ manuscript, baseline, cfg, range: autoChunks[0] });
      console.log('════ 批 1 系统提示词 ════');
      console.log(first.system);
      console.log('════ 批 1 用户提示词（节选前 2000 字）════');
      console.log(first.user.slice(0, 2000));
      console.log(`\n…（批 1 用户提示词共 ${first.user.length} 字）`);
      process.exit(0);
    }
    const { system, user } = buildExtractPrompt({ manuscript, baseline, cfg, range });
    console.log('════ 系统提示词 ════');
    console.log(system);
    console.log('════ 用户提示词（节选前 2000 字）════');
    console.log(user.slice(0, 2000));
    console.log(`\n…（共 ${user.length} 字）`);
    process.exit(0);
  }

  const env = loadLLMEnv();
  if (!env.apiKey) {
    console.error(`✗ ${missingKeyHint(env.provider)}`);
    process.exit(2);
  }
  const model = modelArg || env.model;

  // 输入硬护栏：估算超上限的调用必败，直接拒绝（不调 LLM 白烧钱）
  if (autoChunks) {
    // 分块模式：每批都要携带完整基线——基线本身超预算时无法有效分块
    const baseTokens = estimateTokens(baseline ? JSON.stringify(baseline, null, 2) : '') + 1500;
    if (baseTokens > INPUT_BUDGET_TOKENS) {
      console.warn(`⚠ 基线 canon 估算约 ${baseTokens} tokens，接近/超过单批预算（${INPUT_BUDGET_TOKENS}）——每批都携带完整基线，分块效果有限；建议精简基线。`);
    }
    try { assertInputWithinHardLimit('提取器（基线）', baseTokens); }
    catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  } else {
    const estOnce = estimateTokens(manuscript)
      + estimateTokens(baseline ? JSON.stringify(baseline, null, 2) : '') + 1500;
    try { assertInputWithinHardLimit('提取器', estOnce); }
    catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  }

  // 单次提取调用（批内与单次路径共用同一校验与重试）
  const runExtraction = async (ms, base, rng) => {
    const { system: s, user: u } = buildExtractPrompt({ manuscript: ms, baseline: base, cfg, range: rng });
    return chatJSONValidated({
      apiKey: env.apiKey, baseUrl: env.baseUrl, model,
      messages: [{ role: 'system', content: s }, { role: 'user', content: u }],
      validate: (r) => validateExtraction(r, { baseline: base, manuscript: ms, range: rng }),
      temperature: 0.3, // 提取是事实还原，低温减少发散
    });
  };
  const failExit = (e) => {
    if (e.validationErrors) {
      console.error('✗ 提取输出未通过校验，放弃：');
      e.validationErrors.slice(0, 20).forEach((x) => console.error(`  - ${x}`));
      process.exit(1);
    }
    console.error(`✗ LLM 调用失败: ${e.message}`);
    process.exit(2);
  };

  let raw;
  let chunkMeta = null;
  if (autoChunks) {
    // ---------- 自动分块：逐批提取并合并（字段级合并语义与增量提取一致） ----------
    let merged = JSON.parse(JSON.stringify(baseline));
    // 续跑：证据链从检查点继续（本 run 前的批次证据已在检查点里）
    let mergedEv = resume && checkpointEnv.evidence
      ? JSON.parse(JSON.stringify(checkpointEnv.evidence)) : {};
    // 续跑的"全部已完成章"基集（检查点 done_keys）：批累积在此基础上，供再次续跑判定
    const doneKeysBase = resume
      ? new Set(checkpointEnv.meta.partial.done_keys.map(Number)) : new Set();
    const batchBase0 = resumeInfo ? resumeInfo.skipped_batches : 0; // 已跳过批计入进度
    let checkpoint = resume ? checkpointPath : null;
    for (let i = 0; i < autoChunks.length; i++) {
      const rng = autoChunks[i];
      console.log(`[分块 ${i + 1}/${autoChunks.length}] 提取第${rng.from}-${rng.to}章（基线为前序合并结果）…`);
      // 累积已提取批的哈希键（检查点/最终输出只写已提取章，防未提取章被洗白）
      for (const k of Object.keys(currentHashes)) {
        if (/^\d+$/.test(k) && Number(k) >= rng.from && Number(k) <= rng.to) chunkKeys.add(Number(k));
      }
      let r;
      try { r = await runExtraction(manuscript, merged, rng); }
      catch (e) {
        // 检查点：已完成批次的合并结果不丢，可 --resume 从失败批续跑
        if (checkpoint && outFile) {
          console.error(`⚠ 第 ${i + 1}/${autoChunks.length} 批（第${rng.from}-${rng.to}章）失败；已完成批次的合并结果在 ${checkpoint}`);
          console.error(`  可续跑：node extract-llm.js ${msPath} --out ${outFile} --resume`);
        }
        failExit(e);
      }
      const batchBase = merged;
      merged = mergeCanon(batchBase, r.canon);
      mergedEv = mergeEvidence(mergedEv, r.evidence, batchBase, r.canon);
      // 分块模式下不采纳任何批的 retired（单批看不到全文，无法可靠判断"正文完全没有对应内容"）
      if (r.retired && Array.isArray(r.retired.suspense) && r.retired.suspense.length) {
        console.warn(`⚠ 批 ${i + 1} 提议退役悬念 [${r.retired.suspense.join(', ')}] 已忽略（分块模式不做跨批退役判断，请在 IDE 中逐条处理）`);
      }
      // 每批完成写检查点（原子写；chapter_hashes 只含已提取批 + 旧哈希继承，供续跑/续传）
      // 检查点（<out>.partial）不纳入 lockTargets：任何写检查点的进程必然已在入口持有 outFile 写锁
      // （见上方锁注释——锁先于一切输入读取），outFile 锁互斥即间接串行化检查点的读写，
      // 不存在"无锁写 .partial"的路径；加独立锁反而会在崩溃残留陈旧 .partial.lock 时
      // 于 30min 内挡住自己的 --resume，无收益。并发写冲突回归见 run-tests.js 场景 52 ⑤。
      if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        checkpoint = writeChunkCheckpoint(outFile, {
          tool: 'novel-compiler/extract-llm',
          version: VERSION,
          meta: {
            title: merged.meta && merged.meta.title,
            target_reader: merged.meta && merged.meta.target_reader,
            genre: merged.meta && merged.meta.genre,
            model: '（分块检查点）',
            extracted_at: new Date().toISOString(),
            source_manuscript: msPath,
            source_canon: canonPath || null,
            chapter_hashes: finalHashes(),
            partial: {
              done_batches: batchBase0 + i + 1,
              of: batchBase0 + autoChunks.length,
              // 全部已完成章（含续跑跳过的）——--resume 的跳过判据（配合哈希校验）
              done_keys: [...new Set([...doneKeysBase, ...chunkKeys])].sort((a, b) => a - b),
            },
          },
          canon: merged,
          evidence: mergedEv,
          extraction_notes: [`分块检查点：已完成 ${batchBase0 + i + 1}/${batchBase0 + autoChunks.length} 批（含续跑跳过）。`],
        });
      }
    }
    // 检查点清理移至成功写出之后：校验失败/中途崩溃时检查点保留，--resume 可收尾
    const v = validateCanon(merged);
    if (!v.ok) {
      console.error(`✗ 分块合并后 canon 校验失败: ${v.errors[0]}（自动分块中止）`);
      process.exit(1);
    }
    // 全稿时间线完整性兜底：逐批范围校验 + 链式合并逻辑上已保证覆盖，此处防御合并缺陷
    const msCh = parseManuscript(manuscript).chapters.filter((c) => c.number !== null).map((c) => c.number);
    const haveTl = new Set(asArray(merged.timeline).map((t) => t.chapter));
    const missingCh = msCh.filter((n) => !haveTl.has(n));
    if (missingCh.length) {
      console.error(`✗ 分块合并后时间线缺少第${missingCh.join('、')}章（逐批校验应已覆盖，疑似合并缺陷）`);
      process.exit(1);
    }
    raw = {
      canon: merged,
      evidence: mergedEv,
      extraction_notes: [
        autoChunks.length
          ? `自动分块提取：${autoChunks.length} 批（第${autoChunks[0].from}-第${autoChunks[autoChunks.length - 1].to}章），逐批合并${resume ? `；续跑跳过已完成 ${resumeInfo.skipped_batches} 批` : ''}；合并后按 --retire-stale 执行僵尸清理。`
          : '续跑收尾：检查点显示全部批次已完成且手稿未变，直接输出检查点合并结果。',
      ],
    };
    chunkMeta = {
      auto_chunked: {
        batches: autoChunks.length,
        ranges: autoChunks,
        ...(resume ? { resumed: { skipped_batches: resumeInfo.skipped_batches, from: checkpointPath } } : {}),
      },
    };
  } else {
    const { system, user } = buildExtractPrompt({ manuscript, baseline, cfg, range });
    try {
      raw = await chatJSONValidated({
        apiKey: env.apiKey, baseUrl: env.baseUrl, model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        validate: (r) => validateExtraction(r, { baseline, manuscript, range }),
        temperature: 0.3, // 提取是事实还原，低温减少发散
      });
    } catch (e) { failExit(e); }
  }

  // ---------- 增量合并 / 全量路径 ----------
  let retired = null;
  let canon;
  let evidence;
  let extraMeta = null;
  // LLM 退役建议（悬念名不字面出现在正文，无法确定性清理，只能由模型按上下文判断）：
  // 过滤只保留基线真实存在的悬念 id（模型可能编造）；全量单次 + --retire-stale 自动应用，
  // 其余模式透传信封供 IDE 审阅逐条裁决（作者是唯一生产设备——退役=删除，必须人工确认）
  const baseS = new Set(asArray(baseline ? baseline.suspense : null).map((s) => s.id));
  const retiredSuspense = raw.retired && Array.isArray(raw.retired.suspense)
    ? raw.retired.suspense.filter((id) => baseS.has(id))
    : [];
  const isIncrementalRun = incremental && mergeSrc && dirty && dirty.length > 0 && oldHashes;
  if (isIncrementalRun) {
    // 增量合并：字段级变更判据（见 src/incremental.js）——
    // 悬念埋设章干净但回收章脏也能正确更新（不看 planted_in_chapter，看字段是否变化）
    canon = mergeCanon(baseline, raw.canon);
    evidence = mergeEvidence(mergeSrc.evidence || {}, raw.evidence, baseline, raw.canon);
    const v = validateCanon(canon);
    if (!v.ok) {
      console.error(`✗ 合并后 canon 校验失败: ${v.errors[0]}（增量合并中止）`);
      process.exit(1);
    }
    extraMeta = {
      incremental: { merged_from: mergeWithUsed, dirty_chapters: dirty },
    };
    if (retiredSuspense.length) {
      // 增量只见脏章，退役判断可能不完整——透传交作者裁决并明确警告，不自动删
      retired = { entities: [], knowledge: [], timeline: [], suspense: retiredSuspense };
      console.warn(`⚠ 增量提取建议退役悬念 [${retiredSuspense.join(', ')}] 已透传信封，请在 IDE 审阅中逐条裁决（增量仅见脏章，判断可能不完整）`);
    }
    console.log(`✓ 增量合并完成: 脏章节 [${dirty.join(', ')}] · 合并后 ${canon.entities.length} 实体 / ${canon.knowledge.length} 知识 / ${canon.suspense.length} 悬念 / ${canon.timeline.length} 章时间线`);
  } else {
    if (titleArg) raw.canon.meta = { ...raw.canon.meta, title: titleArg };

    // 僵尸清理（全量提取）：正文零提及且已到期的实体/知识自动移除（依赖感知，见 purgeStale）；
    // 悬念退役由模型在同一轮输出 retired.suspense 判断（悬念名不会字面出现在正文，无法确定性清理）
    // 自动分块路径同样执行——合并后 canon 已是全稿（编号章），purgeStale 基于全文提及统计不会误伤
    if (retireStale && !range && baseline) {
      const purged = purgeStale(raw.canon, manuscript);
      if (!purged.reverted) {
        retired = { entities: purged.removed.entities, knowledge: purged.removed.knowledge, timeline: purged.removed.timeline, suspense: retiredSuspense };
        raw.canon = purged.canon;
      } else {
        console.warn(`⚠ 僵尸清理后 canon 校验失败（${purged.reason}），本次跳过清理（保留全部基线条目）`);
        retired = { entities: [], knowledge: [], timeline: [], suspense: retiredSuspense };
      }
      if (retiredSuspense.length) {
        raw.canon.suspense = asArray(raw.canon.suspense).filter((s) => !retiredSuspense.includes(s.id));
      }
    } else if (!range && retiredSuspense.length) {
      // 全量（未自动清理）：透传退役建议（不自动删，交作者在 IDE 审阅中裁决）；
      // 手动范围/分块单批看不到全文，退役判断不可靠，不透传（与分块路径的忽略一致）
      retired = { entities: [], knowledge: [], timeline: [], suspense: retiredSuspense };
    }
    canon = raw.canon;
    // 手动范围（--from/--to）：范围外章的旧证据继承（与哈希继承同理——范围推进后
    // 旧章的 evidence 引文不能丢，否则审阅/信封的证据链永久缺失，削弱反幻觉可审计性）
    evidence = (from !== null || to !== null) && mergeSrc
      ? mergeEvidence(mergeSrc.evidence || {}, raw.evidence, baseline, raw.canon)
      : raw.evidence;
  }
  if (titleArg && canon.meta) canon.meta = { ...canon.meta, title: titleArg };

  const changes = summarizeChanges(baseline, canon);

  const envelope = {
    tool: 'novel-compiler/extract-llm',
    version: VERSION,
    meta: {
      title: canon.meta && canon.meta.title,
      target_reader: canon.meta && canon.meta.target_reader,
      genre: canon.meta && canon.meta.genre,
      model,
      extracted_at: new Date().toISOString(),
      source_manuscript: msPath,
      source_canon: canonPath || null,
      extraction_range: range
        ? (Array.isArray(range.chapters) ? { chapters: range.chapters } : { from: range.from, to: range.to })
        : null,
      chapter_hashes: finalHashes(),
      ...(extraMeta || {}),
      ...(chunkMeta || {}),
    },
    canon,
    evidence,
    retired,
    extraction_notes: raw.extraction_notes,
  };

  const lines = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`  文检 novel-compiler v${VERSION} · 提取完成${isIncrementalRun ? '（增量）' : chunkMeta ? '（自动分块）' : ''}`);
  if (isIncrementalRun) lines.push(`  增量     : 脏章节 [${dirty.join(', ')}]`);
  if (chunkMeta) {
    const r = chunkMeta.auto_chunked.ranges;
    if (r.length) {
      const resumedTag = chunkMeta.auto_chunked.resumed ? `（续跑，跳过已完成 ${chunkMeta.auto_chunked.resumed.skipped_batches} 批）` : '';
      lines.push(`  分块     : ${chunkMeta.auto_chunked.batches} 批（第${r[0].from}-第${r[r.length - 1].to}章，逐批合并）${resumedTag}`);
    } else {
      lines.push('  分块     : 续跑收尾（全部批次已在检查点中完成）');
    }
  }
  lines.push(`  对象     : ${canon.meta.title}（${canon.meta.target_reader} · ${canon.meta.genre || '未知题材'}）`);
  if (retired && (retired.entities.length || retired.knowledge.length || retired.suspense.length || retired.timeline.length)) {
    lines.push(`  僵尸清理 : 移除实体 ${retired.entities.length} · 知识 ${retired.knowledge.length} · 悬念 ${retired.suspense ? retired.suspense.length : 0} · 时间线 ${retired.timeline.length}`);
    if (retired.entities.length) lines.push(`    -实体 ${retired.entities.join(' ')}`);
    if (retired.knowledge.length) lines.push(`    -知识 ${retired.knowledge.join(' ')}`);
    if (retired.suspense && retired.suspense.length) lines.push(`    -悬念 ${retired.suspense.join(' ')}`);
    if (retired.timeline.length) lines.push(`    -时间线 第${retired.timeline.join('、')}章`);
  }
  lines.push(`  canon    : ${canon.entities.length} 实体 · ${canon.knowledge.length} 知识 · ${canon.suspense.length} 悬念 · ${canon.timeline.length} 章时间线`);
  lines.push(`  模型     : ${model}`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  const addCount = changes.added.entities.length + changes.added.knowledge.length + changes.added.suspense.length;
  lines.push(`变更摘要（vs 基线${canonPath ? '' : '（无基线）'}）`);
  lines.push(`  新增条目 : ${addCount}（实体 ${changes.added.entities.length} · 知识 ${changes.added.knowledge.length} · 悬念 ${changes.added.suspense.length}）`);
  if (changes.added.entities.length) lines.push(`    ${changes.added.entities.map((id) => `+${id}`).join(' ')}`);
  if (changes.added.knowledge.length) lines.push(`    ${changes.added.knowledge.map((id) => `+${id}`).join(' ')}`);
  if (changes.added.suspense.length) lines.push(`    ${changes.added.suspense.map((id) => `+${id}`).join(' ')}`);
  lines.push(`  字段修正 : ${changes.modified.length} 条`);
  for (const m of changes.modified.slice(0, 12)) {
    const parts = Object.entries(m.changed).map(([k, [a, b]]) => `${k}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    lines.push(`    ${m.section}.${m.id}: ${parts.join(' · ')}`);
  }
  lines.push('');
  lines.push('证据已通过确定性校验（行号/引文/章号逐字验证）。');
  lines.push('下一步: 用提议 canon 自动检查正文 ——');
  lines.push(`  node compile.js ${msPath} ${outFile || '<提取输出.json>'}`);
  if (raw.extraction_notes && raw.extraction_notes.length) {
    lines.push('');
    lines.push('提取备注');
    raw.extraction_notes.slice(0, 8).forEach((n) => lines.push(`  · ${n}`));
  }

  if (json) console.log(JSON.stringify(envelope, null, 2));
  else console.log(lines.join('\n'));

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    atomicWrite(outFile, JSON.stringify(envelope, null, 2) + '\n');
    if (!json) console.log(`\n提议 canon 已写入: ${outFile}`);
    // 全部完成：删除分块检查点（无检查点时为幂等 no-op）。
    // 放在成功写出之后——校验失败/崩溃时检查点保留，--resume 可从检查点收尾
    clearChunkCheckpoint(outFile);
  }
  if (canonOut) {
    fs.mkdirSync(path.dirname(canonOut), { recursive: true });
    atomicWrite(canonOut, JSON.stringify(canon, null, 2) + '\n');
    if (!json) console.log(`提议 canon（原始）已写入: ${canonOut}`);
  }
  process.exit(0);
}

main(process.argv).catch((e) => {
  console.error(`✗ 提取失败: ${e && e.message ? e.message : String(e)}`);
  process.exit(2);
});
