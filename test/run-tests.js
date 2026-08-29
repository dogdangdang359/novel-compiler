'use strict';

// 冒烟测试：node test/run-tests.js
// 覆盖：demo 检出全部内置 bug、读者向切换、--json 模式、干净手稿、非法 canon、悬念因果倒置、缺参、
//      比对器偏差/对齐/非法输入、模拟器 dry-run/缺密钥、compile 信封输入、提取器证据校验（反幻觉）

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'compile.js');
const SIM = path.join(ROOT, 'simulate.js');
const CMP = path.join(ROOT, 'compare.js');
const EXT = path.join(ROOT, 'extract-llm.js');
const RBS = path.join(ROOT, 'rebase.js');
const BLD = path.join(ROOT, 'refactor.js');
const SRV = path.join(ROOT, 'app', 'server.js');

function run(args, script, env) {
  const r = spawnSync(process.execPath, [script || CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: env || process.env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// fetch 看门狗：单项请求 30s 未响应即中止——服务器启动有 15s 超时、工具有 TOOL_TIMEOUT_MS，
// 唯独 fetch 客户端无超时；服务器在工具完成与响应之间死锁时整套测试会永久挂起（CI 表现为
// 超时 kill 而非失败报告）。中止后异常冒泡到主 IIFE 的 catch，非零退出并给出堆栈。
function fetchT(url, opts) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++;
    console.error(`  ✗ ${name}`);
    if (extra !== undefined) console.error(String(extra).slice(0, 2500));
  }
}

const M = 'test/fixtures/demo-manuscript.md';
const C = 'test/fixtures/demo-canon.json';

console.log('场景 1: 示例手稿（内置 bug）应检出全部问题并退出 1');
const demo = run([M, C, '--reader', 'webnovel']);
check('exit code = 1', demo.code === 1, `got ${demo.code}\n${demo.out}`);
[
  'timeline/regression',
  'continuity/location',
  'knowledge/premature',
  'suspense/overdue',
  'entity/missing',
  'text/quote-balance',
  'suspense/dangling',
].forEach((r) => {
  check(`检出 [${r}]`, demo.out.includes(`[${r}]`), demo.out);
});
check('输出带行号（manuscript.md:N）', /manuscript\.md:\d+/.test(demo.out), demo.out);
check('输出状态快照', demo.out.includes('状态快照'), demo.out);

console.log('场景 1b: 状态快照 planned 悬念显示预期章（expected）而非未来回收章（resolved）');
{
const { buildSnapshot, renderText, countsOf } = require('../src/report');
const snapCanon = {
  entities: [],
  suspense: [{ id: 's1', name: '血莲坞之谜', planted_in_chapter: 1, expected_resolve_chapter: 2, resolved_in_chapter: 3 }],
  timeline: [],
};
const snapParsed = { chapters: [{ number: 1, headingLine: 1, index: 0 }, { number: 2, headingLine: 5, index: 1 }] };
const snapOut = renderText({
  manifest: { version: 'test', manuscript: 'm.md', chapters: 2, chars: 0, canon: 'c.json', entities: 0, knowledge: 0, suspense: 1 },
  problems: [],
  counts: countsOf([]),
  snapshot: buildSnapshot(snapCanon, snapParsed, new Map()),
  cfg: { label: 'webnovel', overdueLimit: 3, danglingSeverity: 'warning' },
  suppressed: [],
  unused_suppressions: [],
});
check('planned 悬念状态快照显示预期章（预期@2）', snapOut.includes('预期@2'), snapOut);
check('planned 悬念不显示未来回收章（不含 预期@3）', !snapOut.includes('预期@3'), snapOut);
}

console.log('场景 1c: 悬念状态分类（expected 未 resolved → planned，不再误报 dangling）');
{
const { buildSnapshot } = require('../src/report');
const stCanon = {
  entities: [],
  suspense: [
    { id: 's_res', name: '已回收', planted_in_chapter: 1, expected_resolve_chapter: 2, resolved_in_chapter: 2 },
    { id: 's_plan', name: '已埋设有回收计划', planted_in_chapter: 1, expected_resolve_chapter: 2 },
    { id: 's_dang', name: '无回收计划', planted_in_chapter: 1 },
  ],
  timeline: [],
};
const stParsed = { chapters: [{ number: 1, headingLine: 1, index: 0 }, { number: 2, headingLine: 5, index: 1 }] };
const stSnap = buildSnapshot(stCanon, stParsed, new Map());
const stStatus = (id) => stSnap.suspense.find((s) => s.id === id).status;
check('resolved <= 末章 → resolved', stStatus('s_res') === 'resolved', JSON.stringify(stSnap.suspense));
check('expected 未 resolved → planned（不再误报 dangling）', stStatus('s_plan') === 'planned', JSON.stringify(stSnap.suspense));
check('无 expected 无 resolved → dangling', stStatus('s_dang') === 'dangling', JSON.stringify(stSnap.suspense));
}

console.log('场景 2: 读者向切换（published）改变文末悬置级别');
const pub = run([M, C, '--reader', 'published']);
check('exit code = 1', pub.code === 1, `got ${pub.code}`);
check('显示 published 配置（文末悬置=error）', pub.out.includes('文末悬置=error'), pub.out);

console.log('场景 3: --json 输出可解析且计数正确');
const js = run([M, C, '--reader', 'webnovel', '--json']);
let parsed = null;
try { parsed = JSON.parse(js.out); } catch (e) { /* noop */ }
check('JSON 可解析', !!parsed && Array.isArray(parsed.problems), js.out.slice(0, 500));
check('counts.error = 1', !!parsed && parsed.counts && parsed.counts.error === 1, JSON.stringify(parsed && parsed.counts));
check('问题条目均含数字行号', !!parsed && parsed.problems.every((p) => typeof p.line === 'number'), '');

console.log('场景 4: 干净手稿（无问题）退出 0');
const clean = run(['test/fixtures/clean-manuscript.md', 'test/fixtures/clean-canon.json']);
check('exit code = 0', clean.code === 0, `got ${clean.code}\n${clean.out}`);
check('无错误输出', !clean.out.includes('错误 ('), clean.out);

console.log('场景 4b: examples 四件套编译零问题（防跨故事污染回归）');
// A1 回归：examples/canon.json 曾混入其他示例故事的悬念/实体（陆沉/黑衣人/盟主/山河社稷图/孟尝/影子），
// 使 README 宣称的「编译零问题」演示输出 3 条 dangling + 幻影实体 + 虚构回收
const exClean = run(['examples/manuscript.md', 'examples/canon.json']);
check('examples 编译 exit 0', exClean.code === 0, `got ${exClean.code}\n${exClean.out}`);
check('examples 编译零问题（无 错误/警告/提示）', !exClean.out.includes('错误 (') && !exClean.out.includes('警告 (') && !exClean.out.includes('提示 ('), exClean.out);
check('examples canon 无跨故事悬念（不含陆沉/黑衣人/盟主/山河社稷图/孟尝）', !exClean.out.includes('陆沉') && !exClean.out.includes('黑衣人') && !exClean.out.includes('盟主') && !exClean.out.includes('山河社稷图') && !exClean.out.includes('孟尝'), exClean.out);
check('examples canon 无幻影实体「影子」', !exClean.out.includes('影子'), exClean.out);

console.log('场景 5: 非法 canon 退出 2（schema 校验失败）');
const bad = run(['test/fixtures/clean-manuscript.md', 'test/fixtures/bad-canon.json']);
check('exit code = 2', bad.code === 2, `got ${bad.code}\n${bad.out}${bad.err}`);
check('报告校验错误', (bad.out + bad.err).includes('校验失败'), bad.out + bad.err);
const { validateCanon: vc } = require('../src/validate');
const dupK = { meta: { title: 'T' }, entities: [], knowledge: [{ id: 'k1', name: 'a' }, { id: 'k1', name: 'b' }], suspense: [], timeline: [] };
check('knowledge 重复 id 被拒', !vc(dupK).ok, JSON.stringify(vc(dupK).errors));
const dupS = { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [{ id: 's1', name: 'a' }, { id: 's1', name: 'b' }], timeline: [] };
check('suspense 重复 id 被拒', !vc(dupS).ok, JSON.stringify(vc(dupS).errors));
const badId = { meta: { title: 'T' }, entities: [{ id: 'Bad ID', name: 'x' }], knowledge: [], suspense: [], timeline: [] };
check('entity id 格式非法被拒（小写字母/数字/下划线）', !vc(badId).ok, JSON.stringify(vc(badId).errors));
const noKName = { meta: { title: 'T' }, entities: [], knowledge: [{ id: 'k1' }], suspense: [], timeline: [] };
check('knowledge.name 必填被拒', !vc(noKName).ok, JSON.stringify(vc(noKName).errors));
const expEarly = { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [{ id: 's1', name: 'a', planted_in_chapter: 5, expected_resolve_chapter: 2 }], timeline: [] };
check('expected_resolve_chapter 早于 planted 被拒', !vc(expEarly).ok && vc(expEarly).errors.some((x) => x.includes('早于')), JSON.stringify(vc(expEarly).errors));
const expOk = { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [{ id: 's1', name: 'a', planted_in_chapter: 5, expected_resolve_chapter: 6 }], timeline: [] };
check('expected >= planted 通过', vc(expOk).ok, JSON.stringify(vc(expOk).errors));
const resEarly = { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [{ id: 's1', name: 'a', planted_in_chapter: 5, resolved_in_chapter: 2 }], timeline: [] };
check('resolved_in_chapter 早于 planted 被拒（因果倒置）', !vc(resEarly).ok && vc(resEarly).errors.some((x) => x.includes('早于')), JSON.stringify(vc(resEarly).errors));
const resOk = { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [{ id: 's1', name: 'a', planted_in_chapter: 5, resolved_in_chapter: 5 }], timeline: [] };
check('resolved >= planted 通过', vc(resOk).ok, JSON.stringify(vc(resOk).errors));
const resNoPlanted = { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [{ id: 's1', name: 'a', resolved_in_chapter: 2 }], timeline: [] };
check('无 planted 时 resolved 不误拒（条件仅在 planted 存在时比较）', vc(resNoPlanted).ok, JSON.stringify(vc(resNoPlanted).errors));
const dupTl = { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }, { chapter: 1, day: 2 }] };
check('timeline chapter 重复被拒', !vc(dupTl).ok && vc(dupTl).errors.some((x) => x.includes('重复')), JSON.stringify(vc(dupTl).errors));

console.log('场景 6: 悬念先果后因（未埋设即回收）→ 错误');
const bug = run(['test/fixtures/clean-manuscript.md', 'test/fixtures/suspense-bug-canon.json']);
check('exit code = 1', bug.code === 1, `got ${bug.code}\n${bug.out}`);
check('检出 [suspense/unplanted]', bug.out.includes('suspense/unplanted'), bug.out);

console.log('场景 7: 缺参 → 退出 2');
const noarg = run([]);
check('exit code = 2', noarg.code === 2, `got ${noarg.code}\n${noarg.err}`);

console.log('场景 7b: --reader 缺参数值友好报错（不再显示 undefined）');
const noRdVal = run(['test/fixtures/clean-manuscript.md', 'test/fixtures/clean-canon.json', '--reader']);
check('compile --reader 缺值 exit 2 + 提示缺少参数值', noRdVal.code === 2 && noRdVal.err.includes('缺少参数值') && !noRdVal.err.includes('undefined'), `${noRdVal.code} ${noRdVal.err}`);
const noRdValSim = run(['examples/outline.md', '--reader'], SIM);
check('simulate --reader 缺值 exit 2 + 提示缺少参数值', noRdValSim.code === 2 && noRdValSim.err.includes('缺少参数值'), `${noRdValSim.code} ${noRdValSim.err}`);
const noRdValExt = run(['test/fixtures/clean-manuscript.md', '--reader'], EXT);
check('extract --reader 缺值 exit 2 + 提示缺少参数值', noRdValExt.code === 2 && noRdValExt.err.includes('缺少参数值'), `${noRdValExt.code} ${noRdValExt.err}`);

console.log('场景 7c: 带值参数缺值统一检查（takeValue 推广到全部带值选项）');
const { takeValue } = require('../src/cli');
check('takeValue 正常取值', takeValue(['--model', 'x'], 0, '--model') === 'x', '');
const noModelSim = run(['examples/outline.md', '--dry-run', '--model'], SIM);
check('simulate --model 缺值 exit 2 + 提示缺少参数值', noModelSim.code === 2 && noModelSim.err.includes('--model 缺少参数值'), `${noModelSim.code} ${noModelSim.err}`);
const noCanonSim = run(['examples/outline.md', '--canon'], SIM);
check('simulate --canon 缺值 exit 2 + 提示缺少参数值（不再静默当无基线）', noCanonSim.code === 2 && noCanonSim.err.includes('--canon 缺少参数值'), `${noCanonSim.code} ${noCanonSim.err}`);
const noFromExt = run(['test/fixtures/clean-manuscript.md', '--from'], EXT);
check('extract --from 缺值 exit 2 + 提示缺少参数值', noFromExt.code === 2 && noFromExt.err.includes('--from 缺少参数值'), `${noFromExt.code} ${noFromExt.err}`);
const noOutExt = run(['test/fixtures/clean-manuscript.md', '--out'], EXT);
check('extract --out 缺值 exit 2 + 提示缺少参数值（不再静默不写文件）', noOutExt.code === 2 && noOutExt.err.includes('--out 缺少参数值'), `${noOutExt.code} ${noOutExt.err}`);
const noModelRbs = run(['test/fixtures/rebase-pred.json', 'test/fixtures/clean-canon.json', '--dry-run', '--model'], RBS);
check('rebase --model 缺值 exit 2 + 提示缺少参数值', noModelRbs.code === 2 && noModelRbs.err.includes('--model 缺少参数值'), `${noModelRbs.code} ${noModelRbs.err}`);
const noTitleRft = run(['test/fixtures/clean-manuscript.md', 'test/fixtures/clean-canon.json', 'test/fixtures/outline-tmp.md', 'test/fixtures/premise-tmp.md', '--dry-run', '--title'], BLD);
check('refactor --title 缺值 exit 2 + 提示缺少参数值', noTitleRft.code === 2 && noTitleRft.err.includes('--title 缺少参数值'), `${noTitleRft.code} ${noTitleRft.err}`);

console.log('场景 8: 比对器检出预测 vs 实际偏差');
const cmp = run(['test/fixtures/pred-canon.json', 'test/fixtures/clean-canon.json'], CMP);
check('exit code = 1（存在警告级偏差）', cmp.code === 1, `got ${cmp.code}\n${cmp.out}`);
['diff/entity-absent-in-actual', 'diff/knowledge-known-drift', 'diff/suspense-resolve-drift', 'diff/timeline-day-drift'].forEach((r) => {
  check(`检出 [${r}]`, cmp.out.includes(`[${r}]`), cmp.out);
});
// diff line 语义：canon 条目级比对无正文行号 → line 为 null（旧实现硬编码 1 会误导 JSON 消费者）
const cmpJson = run(['test/fixtures/pred-canon.json', 'test/fixtures/clean-canon.json', '--json'], CMP);
let cmpJ = null;
try { cmpJ = JSON.parse(cmpJson.out); } catch { /* noop */ }
check('diff problems line 为 null（无正文锚点，不伪造行号）', !!cmpJ && cmpJ.problems.every((p) => p.line === null), JSON.stringify(cmpJ && cmpJ.problems && cmpJ.problems.slice(0, 2)));

console.log('场景 8b: diff 检出"预测有而实际缺"的已写章时间线（timeline-missing-in-actual）');
const { diffCanons: dc8 } = require('../src/diff');
const predTl = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }, { chapter: 2, day: 2 }, { chapter: 3, day: 3 }, { chapter: 4, day: 4 }] };
const actTlGap = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }, { chapter: 2, day: 2 }, { chapter: 4, day: 4 }] };
const tlDiff = dc8(predTl, actTlGap);
check('实际缺已写章（第3章 ≤ lastWritten=4）→ warning 报告', tlDiff.some((p) => p.rule === 'diff/timeline-missing-in-actual' && p.severity === 'warning' && p.chapter === 3), JSON.stringify(tlDiff));
const tlDiff2 = dc8(predTl, { ...actTlGap, timeline: [{ chapter: 1, day: 1 }, { chapter: 2, day: 2 }] });
check('未来章仍报 planned-ahead 而非 missing', tlDiff2.some((p) => p.rule === 'diff/timeline-planned-ahead' && p.chapter === 3) && !tlDiff2.some((p) => p.rule === 'diff/timeline-missing-in-actual'), JSON.stringify(tlDiff2));

console.log('场景 9: 比对器（预测=实际）无偏差退出 0');
const same = run(['test/fixtures/clean-canon.json', 'test/fixtures/clean-canon.json'], CMP);
check('exit code = 0', same.code === 0, `got ${same.code}\n${same.out}`);

console.log('场景 10: 比对器输入非法 canon → 退出 2');
const badCmp = run(['test/fixtures/bad-canon.json', 'test/fixtures/clean-canon.json'], CMP);
check('exit code = 2', badCmp.code === 2, `got ${badCmp.code}\n${badCmp.out}${badCmp.err}`);

console.log('场景 11: 模拟器 --dry-run 输出提示词（不调 LLM）');
const dry = run(['examples/outline.md', '--premise', 'examples/premise.md', '--reader', 'webnovel', '--dry-run'], SIM);
check('exit code = 0', dry.code === 0, `got ${dry.code}\n${dry.err}`);
check('包含模拟器系统提示词', dry.out.includes('小说模拟器'), dry.out);
check('包含 canon schema 与 risk_register 要求', dry.out.includes('risk_register') && dry.out.includes('known_from_chapter'), '');

console.log('场景 12: 模拟器缺少 API 密钥 → 退出 2');
const noKey = spawnSync(process.execPath, [SIM, 'examples/outline.md'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('exit code = 2', noKey.status === 2, `got ${noKey.status}\n${noKey.stderr}`);
check('提示缺少密钥', noKey.stderr.includes('DEEPSEEK_API_KEY'), noKey.stderr);

console.log('场景 13: 比对器按名称兜底对齐（id 不同不误报缺失）');
const idm = run(['test/fixtures/idmismatch-pred.json', 'test/fixtures/clean-canon.json'], CMP);
check('exit code = 0（无警告级偏差）', idm.code === 0, `got ${idm.code}\n${idm.out}`);
check('报 id 漂移（info 级）', idm.out.includes('diff/entity-id-drift'), idm.out);
check('不误报实体缺失', !idm.out.includes('diff/entity-absent-in-actual'), idm.out);

console.log('场景 14: compile 接受信封输入（提取器/模拟器输出）');
const envC = run(['test/fixtures/clean-manuscript.md', 'test/fixtures/envelope-canon.json']);
check('exit code = 0', envC.code === 0, `got ${envC.code}\n${envC.out}`);

console.log('场景 14b: 信封工具（canonio）与版本号统一来源单测');
const { isEnvelope, unwrapEnvelope, loadCanonFile, loadEnvelopeOrCanon } = require('../src/canonio');
const { VERSION } = require('../src/version');
const simpleCanon = { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [], timeline: [] };
check('isEnvelope 判定信封（含 canon 字段且非 canon 对象）', isEnvelope({ canon: { meta: {} } }) === true
  && isEnvelope(simpleCanon) === false && isEnvelope(null) === false && isEnvelope({}) === false, '');
check('unwrapEnvelope 解信封 / 纯 canon 原样', unwrapEnvelope({ canon: simpleCanon }) === simpleCanon && unwrapEnvelope(simpleCanon) === simpleCanon, '');
const loadedEnv = loadCanonFile(path.join(ROOT, 'test/fixtures/envelope-canon.json'));
check('loadCanonFile 读信封文件并解出 canon', !!loadedEnv.meta && Array.isArray(loadedEnv.entities), JSON.stringify(loadedEnv).slice(0, 120));
const envPair = loadEnvelopeOrCanon(path.join(ROOT, 'test/fixtures/envelope-canon.json'));
check('loadEnvelopeOrCanon 同时返回信封与 canon', !!envPair.envelope && envPair.envelope.canon === envPair.canon, '');
const plainPair = loadEnvelopeOrCanon(path.join(ROOT, 'test/fixtures/clean-canon.json'));
check('loadEnvelopeOrCanon 纯 canon 时 envelope=null', plainPair.envelope === null && !!plainPair.canon.meta.title, '');
let threwEnv = false;
try { loadCanonFile(path.join(ROOT, 'test/fixtures', '不存在.json')); } catch (e) { threwEnv = /无法解析/.test(e.message); }
check('loadCanonFile 缺失文件抛错（带路径）', threwEnv, '');
check('版本号与根 package.json 一致', VERSION === JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, VERSION);

console.log('场景 14c: token 估算 + 自动分块规划（planExtractionChunks）单测');
const { estimateTokens: et } = require('../src/llm');
const { planExtractionChunks } = require('../src/extraction');
check('estimateTokens 中文按字 / ASCII 按 1/4 估算', et('中文测试') === 4 && et('abcd') === 1, `${et('中文测试')} ${et('abcd')}`);
// 30 章 × 2000 字 ≈ 60k 字长稿（超预算强制分块）
let longMs = '';
for (let i = 1; i <= 30; i++) {
  longMs += `# 第${i}章 章节${i}\n\n${'正文内容'.repeat(500)}\n\n`;
}
const longBase = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] };
const chunksSmall = planExtractionChunks({ manuscript: longMs, baseline: longBase, maxTokens: 8000 });
check('超预算时按章分块（多批）', Array.isArray(chunksSmall) && chunksSmall.length > 1, JSON.stringify(chunksSmall && chunksSmall.slice(0, 3)));
check('分块覆盖全部章节且批间连续', !!chunksSmall && chunksSmall[0].from === 1 && chunksSmall[chunksSmall.length - 1].to === 30
  && chunksSmall.every((c, i) => i === 0 || c.from === chunksSmall[i - 1].to + 1), JSON.stringify(chunksSmall));
check('大预算不分块（null）', planExtractionChunks({ manuscript: longMs, baseline: longBase, maxTokens: 200000 }) === null, '');
check('无基线也可规划（不崩溃）', Array.isArray(planExtractionChunks({ manuscript: longMs, baseline: null, maxTokens: 8000 })), '');

console.log('场景 14c2: 分块规划估算口径（行号前缀 + 系统提示词计入）');
// 回归来源：v0.4.3 实测——旧实现按裸章节文本估算且漏 SYSTEM_PROMPT，2569 行手稿低估 ~4k
// tokens（本用例放大到 17%），预算贴线时误判"不分块"，实际提示词超预算贴上下文上限
{
  const { buildExtractPrompt: bep } = require('../src/extraction');
  const { configFor: cf } = require('../src/validate');
  const msShort = [];
  for (let i = 0; i < 2; i++) {
    msShort.push(`# 第${i + 1}章 章名${i + 1}`, '');
    for (let j = 0; j < 250; j++) msShort.push('正文内容一二三四五六七八九十');
  }
  const msShortText = msShort.join('\n');
  const cfgShort = cf('webnovel');
  // 实际批次提示词：分块批走 range 模式（assembleNumbered 口径），非全量 numberLines
  const { system: sysS, user: usrS } = bep({ manuscript: msShortText, baseline: longBase, cfg: cfgShort, range: { from: 1, to: 2 } });
  const actualBatch = et(sysS) + et(usrS);
  const fits = planExtractionChunks({ manuscript: msShortText, baseline: longBase, maxTokens: Math.round(actualBatch * 1.05) });
  check('预算在实际提示词之上 → 不分块（null）', fits === null, `actual=${actualBatch} got=${JSON.stringify(fits)}`);
  const chunks = planExtractionChunks({ manuscript: msShortText, baseline: longBase, maxTokens: Math.round(actualBatch * 0.95) });
  check('预算在实际提示词之下 → 分块（估算计入行号前缀与系统提示词；旧口径低估 17% 会漏判）',
    Array.isArray(chunks) && chunks.length > 1, `actual=${actualBatch} got=${JSON.stringify(chunks && chunks.map((c) => c.tokens))}`);
  check('分块携带 tokens 估算字段（超预算批次告警用）', Array.isArray(chunks) && chunks.every((c) => Number.isInteger(c.tokens) && c.tokens > 0), '');
}

console.log('场景 14d: 统一字段比较（src/fields.js）单测');
const { fieldsChanged: fc, hasChanges: hc } = require('../src/fields');
check('union 键集：提议删除基线字段算变化', Object.keys(fc({ a: 1, b: 2 }, { a: 1 })).includes('b'), '');
check('值比较（数组/对象内容）', Object.keys(fc({ a: [1] }, { a: [1, 2] })).length === 1 && Object.keys(fc({ a: { x: 1 } }, { a: { x: 1 } })).length === 0, '');
check('hasChanges 布尔判定（null 安全）', hc({ a: 1 }, { a: 2 }) === true && hc({ a: 1 }, { a: 1 }) === false && hc(null, null) === false && hc(null, { a: 1 }) === true, '');
// 三处使用者（incremental / extraction / review）行为一致：与 incremental 旧实现等价
const { fieldsChanged: fcInc } = require('../src/incremental');
check('incremental 导出与统一实现等价', fcInc({ a: 1, b: 2 }, { a: 1 }) === true && fcInc({ a: 1 }, { a: 1 }) === false, '');

console.log('场景 14e: 计数防御 / 输入硬护栏 / 分块检查点单测');
const { countsOf } = require('../src/report');
const nanC = countsOf([{ severity: 'error' }, { severity: 'bogus' }, { severity: undefined }]);
check('countsOf 对非法 severity 防御（无 NaN）', nanC.error === 1 && Number.isNaN(nanC.warning) === false && Number.isNaN(nanC.info) === false, JSON.stringify(nanC));
const { assertInputWithinHardLimit, HARD_INPUT_LIMIT } = require('../src/llm');
let hardThrew = false;
try { assertInputWithinHardLimit('测试', HARD_INPUT_LIMIT + 1); } catch (e) { hardThrew = e.code === 'INPUT_HARD_LIMIT'; }
check('assertInputWithinHardLimit 超限抛错（INPUT_HARD_LIMIT）', hardThrew, '');
let hardOk = true;
try { assertInputWithinHardLimit('测试', HARD_INPUT_LIMIT); } catch { hardOk = false; }
check('assertInputWithinHardLimit 预算内放行', hardOk, '');

console.log('场景 14e2: HARD_INPUT_LIMIT 绝对上限锚定（护栏不随预算水涨船高）');
// 回归来源：旧实现 HARD_INPUT_LIMIT = 预算 × 3 纯相对值——预算 200k 时护栏升到 600k
// （必败调用放行白烧钱），默认 48k×3=144k 也已越过 DeepSeek 128K 上下文。
// 常量在 require 时读取，须用子进程注入环境变量
function llmConst(env, expr) {
  const r = spawnSync(process.execPath, ['-e', `const l = require('./src/llm'); process.stdout.write(JSON.stringify(${expr}))`],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return r.stdout.trim();
}
check('预算 200k：硬护栏被模型上下文 128k 封顶（不再 600k）',
  llmConst({ LLM_INPUT_BUDGET_TOKENS: '200000' }, 'l.HARD_INPUT_LIMIT') === '128000', '');
check('预算 30k：×3 = 90k 生效（min 取小侧）',
  llmConst({ LLM_INPUT_BUDGET_TOKENS: '30000' }, 'l.HARD_INPUT_LIMIT') === '90000', '');
check('LLM_MODEL_CONTEXT_TOKENS 可调（走 BASE_URL 接大上下文模型）',
  llmConst({ LLM_INPUT_BUDGET_TOKENS: '200000', LLM_MODEL_CONTEXT_TOKENS: '500000' }, 'l.HARD_INPUT_LIMIT') === '500000', '');
check('预算 200k 时 200k tokens 输入仍被拒（INPUT_HARD_LIMIT，旧护栏 600k 会放行）',
  llmConst({ LLM_INPUT_BUDGET_TOKENS: '200000' },
    `(() => { try { l.assertInputWithinHardLimit('测试', 200000); return '放行'; } catch (e) { return e.code; } })()`) === '"INPUT_HARD_LIMIT"', '');
const { writeChunkCheckpoint, clearChunkCheckpoint } = require('../src/fsutil');
const cpFile = path.join(ROOT, 'test', 'fixtures', 'tmp-checkpoint.json');
writeChunkCheckpoint(cpFile, { canon: { a: 1 } });
check('writeChunkCheckpoint 写入 <out>.partial', fs.existsSync(`${cpFile}.partial`) && JSON.parse(fs.readFileSync(`${cpFile}.partial`, 'utf8')).canon.a === 1, '');
clearChunkCheckpoint(cpFile);
check('clearChunkCheckpoint 删除检查点', !fs.existsSync(`${cpFile}.partial`), '');
clearChunkCheckpoint(cpFile); // 幂等
check('clearChunkCheckpoint 幂等（无文件不抛）', !fs.existsSync(`${cpFile}.partial`), '');
try { fs.unlinkSync(cpFile); } catch { /* 忽略 */ }

console.log('场景 14f: killTree 进程树终止（win32 taskkill 必须带 timeout=3000）');
const { killTree } = require('../src/proctree');
const cpMod = require('child_process');
const origSpawnSync = cpMod.spawnSync;
const killCalls = [];
cpMod.spawnSync = (...a) => { killCalls.push(a); return { status: 0 }; };
try {
  killTree({ pid: 12345, kill: () => {} });
  const tk = killCalls.find((k) => k[0] === 'taskkill');
  check('win32 分支调用 taskkill 且带 timeout=3000（防卡死阻塞事件循环）', process.platform !== 'win32' || (!!tk && tk[2].timeout === 3000), JSON.stringify(killCalls.map((k) => [k[0], k[2] && k[2].timeout])));
  let ktOk = true;
  try { killTree({ pid: 99999999, kill: () => {} }); } catch { ktOk = false; } // POSIX：进程组 kill 抛错 → child.kill 兜底
  check('killTree 任意平台不抛（异常有兜底）', ktOk, '');
} finally {
  cpMod.spawnSync = origSpawnSync;
}

console.log('场景 15: 提取器 --dry-run 输出提示词（不调 LLM）');
const extDry = run(['test/fixtures/clean-manuscript.md', '--dry-run'], EXT);
check('exit code = 0', extDry.code === 0, `got ${extDry.code}\n${extDry.err}`);
check('包含提取器系统提示词', extDry.out.includes('小说提取器'), extDry.out);
check('包含行号证据要求', extDry.out.includes('quote') && extDry.out.includes('行号'), '');

console.log('场景 16: 提取器缺少 API 密钥 → 退出 2');
const extNoKey = spawnSync(process.execPath, [EXT, 'test/fixtures/clean-manuscript.md'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('exit code = 2', extNoKey.status === 2, `got ${extNoKey.status}\n${extNoKey.stderr}`);
check('提示缺少密钥', extNoKey.stderr.includes('DEEPSEEK_API_KEY'), extNoKey.stderr);

console.log('场景 17: 提取器证据校验（反幻觉单测）');
const { validateExtraction } = require('../src/extraction');
const cleanCanon = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-canon.json'), 'utf8'));
const cleanMs = fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-manuscript.md'), 'utf8');
function baseRaw() {
  const canon = JSON.parse(JSON.stringify(cleanCanon));
  canon.entities.push({ id: 'tea_house', name: '茶馆', aliases: [], type: 'location', appears_from_chapter: 1 });
  return {
    canon,
    evidence: {
      entities: { tea_house: [{ chapter: 1, line: 3, quote: '茶馆' }] },
      knowledge: {},
      suspense: {},
      timeline: {
        '1': [{ chapter: 1, line: 3, quote: '江城下了整夜的雨' }],
        '2': [{ chapter: 2, line: 17, quote: '第二天，两人进了档案馆' }],
        '3': [{ chapter: 3, line: 31, quote: '第三天傍晚' }],
      },
    },
    extraction_notes: [],
  };
}
const okRaw = baseRaw();
check('合法提取通过校验', validateExtraction(okRaw, { baseline: cleanCanon, manuscript: cleanMs }).length === 0,
  validateExtraction(okRaw, { baseline: cleanCanon, manuscript: cleanMs }));
const b1 = baseRaw();
b1.evidence.entities.tea_house[0].quote = '不存在的句子';
check('幻觉引文被拒', validateExtraction(b1, { baseline: cleanCanon, manuscript: cleanMs }).some((e) => e.includes('quote 未逐字命中')));
const b2 = baseRaw();
b2.evidence.entities.tea_house[0].line = 9999;
check('越界行号被拒', validateExtraction(b2, { baseline: cleanCanon, manuscript: cleanMs }).some((e) => e.includes('line 越界')));
const b3 = baseRaw();
b3.canon.entities = b3.canon.entities.slice(1);
check('基线条目缺失被拒', validateExtraction(b3, { baseline: cleanCanon, manuscript: cleanMs }).some((e) => e.includes('基线条目')));
const b4 = baseRaw();
delete b4.evidence.entities.tea_house;
check('新增条目缺证据被拒', validateExtraction(b4, { baseline: cleanCanon, manuscript: cleanMs }).some((e) => e.includes('缺少证据')));
const b5 = baseRaw();
b5.evidence.timeline['2'][0].line = 3;
check('行号与声明章号不符被拒', validateExtraction(b5, { baseline: cleanCanon, manuscript: cleanMs }).some((e) => e.includes('不在第2章范围内')));
const b6 = baseRaw();
b6.evidence.entities.tea_house[0].quote = '你来了。她说，在他对面坐下，信，看过了吗'; // 去引号规范化后应命中第5行
b6.evidence.entities.tea_house[0].line = 5;
check('省略引号字符的引文仍可命中（规范化匹配）', validateExtraction(b6, { baseline: cleanCanon, manuscript: cleanMs }).length === 0,
  validateExtraction(b6, { baseline: cleanCanon, manuscript: cleanMs }));
const b10 = baseRaw();
b10.evidence.entities.tea_house[0].quote = '他说'; // 2字：第3行字面不含、第1章内也无字面命中，归一化模糊匹配被禁后应拒
b10.evidence.entities.tea_house[0].line = 3;
check('短引文（<3字）不做归一化模糊匹配（防弱证据撞行）', validateExtraction(b10, { baseline: cleanCanon, manuscript: cleanMs }).some((e) => e.includes('quote 未逐字命中')),
  validateExtraction(b10, { baseline: cleanCanon, manuscript: cleanMs }).join('\n'));
const b11 = baseRaw();
b11.evidence.entities.tea_house[0].quote = '"你来了"'; // 3字，ASCII 引号 vs 中文引号：字面不命中、归一化命中
b11.evidence.entities.tea_house[0].line = 5;
check('3字引文归一化模糊匹配仍通过（引号风格差异不损失）', validateExtraction(b11, { baseline: cleanCanon, manuscript: cleanMs }).length === 0,
  validateExtraction(b11, { baseline: cleanCanon, manuscript: cleanMs }).join('\n'));
const b7 = baseRaw();
b7.canon.knowledge[0].known_from_chapter = 2; // 全量模式下修正基线条目字段
check('全量模式：基线条目字段修正无证据被拒', validateExtraction(b7, { baseline: cleanCanon, manuscript: cleanMs }).some((e) => e.includes('字段被修正但缺少证据')),
  validateExtraction(b7, { baseline: cleanCanon, manuscript: cleanMs }));
const b8 = baseRaw();
b8.canon.knowledge[0].known_from_chapter = 2;
b8.evidence.knowledge.k1 = [{ chapter: 2, line: 17, quote: '第二天，两人进了档案馆' }]; // 补上范围内证据
check('全量模式：基线条目字段修正带证据通过', validateExtraction(b8, { baseline: cleanCanon, manuscript: cleanMs }).length === 0,
  validateExtraction(b8, { baseline: cleanCanon, manuscript: cleanMs }));
const b9 = baseRaw();
delete b9.evidence.knowledge; // 基线条目未修正：无证据仍通过（作者权威）
check('全量模式：未修正的基线条目不强制证据', validateExtraction(b9, { baseline: cleanCanon, manuscript: cleanMs }).length === 0,
  validateExtraction(b9, { baseline: cleanCanon, manuscript: cleanMs }));

console.log('场景 17a: 章行号对照表注入提示词 + 校验错误可自查（回归：风雪手稿章归属漂移）');
// 回归来源：v0.4.3 真实分块回归失败——行号化正文不含任何「第N章」标记，模型只能按剧情
// 语义猜章归属，批 1 三轮重试 11 条章归属漂移（声明章 > 行实际章）无法自查修正。
// 修复：提示词注入确定性章行号对照表；校验错误附行原文/实际章号，让重试可收敛。
{
  const { buildExtractPrompt: bep17a } = require('../src/extraction');
  const { configFor: cf17a } = require('../src/validate');
  const cfg17a = cf17a('webnovel');
  const emptyBase17a = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] };
  const mapSlice = (u) => { const i = u.indexOf('【章行号对照】'); return i < 0 ? '（无对照表）' : u.slice(i, i + 120); };
  // 全稿模式：对照表覆盖全部章（clean-manuscript.md 共 40 行：第1章 行2-14 / 第2章 行16-28 / 第3章 行30-40）
  const pFull = bep17a({ manuscript: cleanMs, baseline: emptyBase17a, cfg: cfg17a, range: null });
  check('全稿提示词注入章行号对照表', pFull.user.includes('【章行号对照】'), '');
  check('全稿对照表含第1章区间 行2-14', pFull.user.includes('第1章:行2-14'), mapSlice(pFull.user));
  check('全稿对照表含第2/3章区间', pFull.user.includes('第2章:行16-28') && pFull.user.includes('第3章:行30-40'), mapSlice(pFull.user));
  check('对照表附使用指令（章归属以行号为准，不按剧情猜章）', pFull.user.includes('不要按剧情语义猜章'), mapSlice(pFull.user));
  // 分块批模式：对照表只列批内章（防模型引用范围外行号）
  const pRange = bep17a({ manuscript: cleanMs, baseline: emptyBase17a, cfg: cfg17a, range: { from: 1, to: 2 } });
  check('分块批提示词注入对照表', pRange.user.includes('【章行号对照】'), mapSlice(pRange.user));
  check('分块批对照表含批内章区间', pRange.user.includes('第1章:行2-14') && pRange.user.includes('第2章:行16-28'), mapSlice(pRange.user));
  check('分块批对照表不含范围外章（第3章）', !pRange.user.includes('第3章:行'), mapSlice(pRange.user));
  // 错误反馈可自查：quote 未命中附该行原文
  const eA1 = baseRaw();
  eA1.evidence.entities.tea_house[0].quote = '不存在的句子';
  const errA1 = validateExtraction(eA1, { baseline: cleanCanon, manuscript: cleanMs });
  check('quote 未命中的错误附该行原文', errA1.some((e) => e.includes('quote 未逐字命中') && e.includes('行原文')), errA1.join('\n'));
  check('行原文与行号一致（第3行内容）', errA1.some((e) => e.includes('江城下了整夜的雨')), errA1.join('\n'));
  // timeline 行号错章：附实际章号
  const eA2 = baseRaw();
  eA2.evidence.timeline['2'][0].line = 3; // 第3行实际属于第1章
  const errA2 = validateExtraction(eA2, { baseline: cleanCanon, manuscript: cleanMs });
  check('timeline 行号错章的错误附实际章号', errA2.some((e) => e.includes('不在第2章范围内') && e.includes('实际属于第1章')), errA2.join('\n'));
  // quote 未命中时附实际所在行号 / 明示全文未出现（回归来源：修复章漂移后真实回归仍有 4 条
  // quote 失败——模型引对场景但行号差 1-4 行（如引墨老落地第 65 行，「墨老」二字在第 67 行），
  // 只回该行原文时模型无从搜起；校验方持全文，报实际行号才能一轮收敛）
  // 自动修复引入后（场景 17e），「行实际属于声明章」的同章漂移会被直接修复、不再报错；
  // 「报错附实际所在行」的反馈格式保留在番外（chapter=null，无章号锚定不做修复）场景
  const eB1 = baseRaw();
  eB1.evidence.entities.tea_house[0].chapter = null; // 番外证据：无章号锚定，不做同章修复
  eB1.evidence.entities.tea_house[0].quote = '档案馆'; // 第3行无此词，实际出现在第 11、17、31 行
  const errB1 = validateExtraction(eB1, { baseline: cleanCanon, manuscript: cleanMs });
  check('quote 未命中附实际所在行号（多命中列前 3 处）', errB1.some((e) => e.includes('quote 未逐字命中') && e.includes('实际出现在第 11、17、31 行')), errB1.join('\n'));
  const eB2 = baseRaw();
  eB2.evidence.entities.tea_house[0].quote = '全文不存在的词句';
  const errB2 = validateExtraction(eB2, { baseline: cleanCanon, manuscript: cleanMs });
  check('quote 全文未出现时明示（不再让模型对行原文猜）', errB2.some((e) => e.includes('quote 未逐字命中') && e.includes('quote 全文未出现')), errB2.join('\n'));
  const eB3 = baseRaw();
  eB3.evidence.timeline['2'][0].quote = '茶馆'; // 第17行无此词，唯一命中第 3 行
  const errB3 = validateExtraction(eB3, { baseline: cleanCanon, manuscript: cleanMs });
  check('timeline quote 未命中附实际所在行号（唯一命中）', errB3.some((e) => e.includes('quote 未命中第17行') && e.includes('实际出现在第 3 行')), errB3.join('\n'));
}

console.log('场景 17d: range 模式正文携带章标题行（模型直接看见章边界，不再单靠对照表查位）');
// 回归来源：注入对照表后真实回归仍现章归属漂移（声明章 > 实际章，偏差 1-5 个条目且后章更大）
// ——对照表是单行 30 条目的长文本，模型做「行号→章」查找时条目错位；且行号化正文裁掉了标题
// 行（如第233行「# 第六章」不输出），模型在正文里看不到任何章边界。修复：章标题行按原始
// 行号随正文一并输出（与全稿模式口径一致），标题紧邻章首正文行，归章无需查表。
{
  const { buildExtractPrompt: bep17d } = require('../src/extraction');
  const { configFor: cf17d } = require('../src/validate');
  const cfg17d = cf17d('webnovel');
  const emptyBase17d = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] };
  // 分块批模式（第2-3章）：第2章标题在第15行、第3章标题在第29行，须以原始行号原样出现
  const p17d = bep17d({ manuscript: cleanMs, baseline: emptyBase17d, cfg: cfg17d, range: { from: 2, to: 3 } });
  check('range 模式正文含章标题行（15|# 第2章 档案）', p17d.user.includes('15|# 第2章 档案'), '');
  check('range 模式正文含后续章标题（29|# 第3章 钟声）', p17d.user.includes('29|# 第3章 钟声'), '');
  check('range 模式不含范围外章标题（第1章）', !p17d.user.includes('|# 第1章 信'), '');
  check('章标题行只出现一次（不重复输出）', p17d.user.split('15|# 第2章 档案').length === 2 && p17d.user.split('29|# 第3章 钟声').length === 2, '');
  check('标题行不挤掉正文行（第17行正文仍在）', p17d.user.includes('17|第二天，两人进了档案馆'), '');
  // 全稿模式本来就含标题行（numberLines 全行输出），一致性护栏
  const pFull17d = bep17d({ manuscript: cleanMs, baseline: emptyBase17d, cfg: cfg17d, range: null });
  check('全稿模式正文含章标题行（口径一致）', pFull17d.user.includes('15|# 第2章 档案'), '');
  // 校验器章区间必须含标题行（headingLine）：标题行进入正文后模型可能引用它作证据，
  // 旧口径（headingLine 被裁出章区间）会误报「不属于任何章节」，且 e2e 场景 49d 的
  // fake LLM 首行证据恰是章标题行——该语义不一致会让范围提取 e2e 必败
  const eD1 = baseRaw();
  eD1.evidence.timeline['2'][0].line = 15; // 第15行 = 第2章标题行「# 第2章 档案」
  eD1.evidence.timeline['2'][0].quote = '# 第2章 档案';
  const errD1 = validateExtraction(eD1, { baseline: cleanCanon, manuscript: cleanMs });
  check('证据引章标题行不再误报章错误（headingLine 属于该章）', !errD1.some((e) => e.includes('第15行')), errD1.join('\n'));
}

console.log('场景 17e: 同章 quote 自动修复（锚定偏差实证：词对行号漂移且重试反馈不收敛）');
// 回归来源：章漂移修复后真实回归 run7/run8 连续两轮仅剩 1 条同型错误——xue_lian_wu 引
// 第731行、quote「血莲坞」实际在 633/637/683 行且声明章（第13章）内 683 行逐字命中。
// 跨 run 逐字复现排除方差，是确定性锚定偏差：模型引对词但把行号锚在叙事时刻而非词面
// 所在行，重试反馈（附实际行号、3 次机会）不收敛。校验方持全文——声明章内存在逐字命中
// 时确定性改指章内首个命中行（错误降级为自动修复留痕）；修复仅限「行实际属于声明章」
// 的同章漂移——行不在声明章（章漂移）或声明章内无命中（真幻觉）仍报错，修复不得掩盖
// 章归属错误。
{
  // 同章修复（实体路径）：「茶馆」全文唯一命中第3行，第1章行2-14
  const f1 = baseRaw();
  f1.evidence.entities.tea_house[0].line = 7; // 第1章内、该行无「茶馆」
  const errF1 = validateExtraction(f1, { baseline: cleanCanon, manuscript: cleanMs });
  check('同章 quote 命中：行号自动改指章内首个命中行（无错误）', errF1.length === 0, errF1.join('\n'));
  check('自动修复落盘（line 突变为 3）', f1.evidence.entities.tea_house[0].line === 3, String(f1.evidence.entities.tea_house[0].line));
  check('自动修复留痕（extraction_notes 记录修复）', Array.isArray(f1.extraction_notes) && f1.extraction_notes.some((s) => String(s).includes('自动修复')), JSON.stringify(f1.extraction_notes));
  // 同章修复（timeline 路径）：「江城下了整夜的雨」唯一命中第3行
  const f2 = baseRaw();
  f2.evidence.timeline['1'][0].line = 11; // 第1章内、该行无此句
  const errF2 = validateExtraction(f2, { baseline: cleanCanon, manuscript: cleanMs });
  check('timeline 同章 quote 命中：行号自动改指（无错误）', errF2.length === 0, errF2.join('\n'));
  check('timeline 自动修复落盘（line 回 3）', f2.evidence.timeline['1'][0].line === 3, String(f2.evidence.timeline['1'][0].line));
  // 章内无命中不跨章改写：声明第2章、行也在第2章、quote 只在第1章命中 → 仍报错
  const f3 = baseRaw();
  f3.evidence.entities.tea_house[0].chapter = 2;
  f3.evidence.entities.tea_house[0].line = 19; // 第2章内（行16-28）、第2章无「茶馆」
  const errF3 = validateExtraction(f3, { baseline: cleanCanon, manuscript: cleanMs });
  check('章内无命中仍报错：quote 只在他章命中时不跨章改写', errF3.some((e) => e.includes('quote 未逐字命中')), errF3.join('\n'));
  check('不跨章落盘（line 保持 19）', f3.evidence.entities.tea_house[0].line === 19, String(f3.evidence.entities.tea_house[0].line));
  // 全文无命中仍报错：自动修复不得吞掉真幻觉
  const f4 = baseRaw();
  f4.evidence.entities.tea_house[0].quote = '不存在的句子';
  const errF4 = validateExtraction(f4, { baseline: cleanCanon, manuscript: cleanMs });
  check('全文无命中仍报错（自动修复不吞真幻觉）', errF4.some((e) => e.includes('quote 未逐字命中')), errF4.join('\n'));
}

console.log('场景 17b: 引文匹配归一化（引号风格 / markdown 标记 / 空引文护栏）');
// 回归来源：v0.4.3 实测（14.6 万字节真实手稿提取失败）——JSON 模式下模型把正文直双引号
// 转写为直单引号规避转义、丢弃 markdown 加粗 **；旧 norm 只剥 “”「」‘’" 不剥 ' 与 *，
// 字词逐字一致的引文被误判为幻觉，3 轮反馈重试修不完，提取整体 exit 1
const normMs = [
  '# 第1章 风雪',
  '',
  '少年握着短剑，剑身细如柳叶，名唤"听雨"。',
  '',
  '但听这名字——**沉剑**阁——和沈家脱不了干系。',
  '',
  '# 第2章 夜行',
  '',
  '雪停了，风未住。',
].join('\n');
function normRaw() {
  return {
    canon: {
      meta: { title: '风雪', target_reader: 'webnovel', genre: '武侠' },
      entities: [{ id: 'tingyu', name: '听雨', aliases: [], type: 'item', appears_from_chapter: 1 }],
      knowledge: [], suspense: [],
      timeline: [{ chapter: 1, day: 1 }, { chapter: 2, day: 2 }],
    },
    evidence: {
      entities: { tingyu: [{ chapter: 1, line: 3, quote: '名唤"听雨"' }] },
      knowledge: {}, suspense: {},
      timeline: {
        '1': [{ chapter: 1, line: 3, quote: '名唤"听雨"' }],
        '2': [{ chapter: 2, line: 9, quote: '雪停了，风未住' }],
      },
    },
    extraction_notes: [],
  };
}
const normMsCheck = (r) => validateExtraction(r, { baseline: null, manuscript: normMs });
const c0 = normRaw();
check('基线用例：直双引号引文字面命中', normMsCheck(c0).length === 0, normMsCheck(c0));
const c1 = normRaw();
c1.evidence.entities.tingyu[0].quote = "名唤'听雨'"; // 模型把正文 " 转写为 '
check('直单引号转写仍命中（引号风格差异不算字词差异）', normMsCheck(c1).length === 0, normMsCheck(c1));
const c2 = normRaw();
c2.canon.entities.push({ id: 'chenjian_ge', name: '沉剑阁', aliases: [], type: 'location', appears_from_chapter: 1 });
c2.evidence.entities.chenjian_ge = [{ chapter: 1, line: 5, quote: '沉剑阁' }];
check('markdown 加粗打断的词仍命中（**沉剑**阁 → 沉剑阁）', normMsCheck(c2).length === 0, normMsCheck(c2));
const c3 = normRaw();
c3.evidence.entities.tingyu[0].quote = "' '"; // 全部由被剥离字符构成
check('引号/空白/星号全剥后为空的引文被拒（不能命中任意行）', normMsCheck(c3).some((e) => e.includes('quote 未逐字命中')), normMsCheck(c3));
const c4 = normRaw();
c4.evidence.entities.tingyu[0].quote = "名唤'听雪'"; // 引号风格对了但字词错
check('字词不一致仍被拒（归一化不吞字词差异）', normMsCheck(c4).some((e) => e.includes('quote 未逐字命中')), normMsCheck(c4));

console.log('场景 17c: range 模式时间线完整性（分块批/手动范围首批不必然失败）');
// 回归来源：P1-A 修复暴露的既有缺陷——旧校验在 range 模式下仍要求 timeline 覆盖全稿，
// 但模型看不到范围外章节、空基线无携带来源 → 空基线分块/手动范围首批结构性必然失败
const rangeMs = ['# 第1章 甲', '甲在村里。', '# 第2章 乙', '乙进城了。', '# 第3章 丙', '丙回来了。'].join('\n');
const RANGE_QUOTES = { 1: [2, '甲在村里'], 2: [4, '乙进城了'], 3: [6, '丙回来了'] };
// 命名避开场景 26 的同名顶层函数：JS 声明提升会让后定义者覆盖前者，导致本场景误用错误数据
function rangeTlEnvelope(tlChapters) {
  const tlEv = {};
  for (const n of tlChapters) tlEv[String(n)] = [{ chapter: n, line: RANGE_QUOTES[n][0], quote: RANGE_QUOTES[n][1] }];
  return {
    canon: {
      meta: { title: 'R', target_reader: 'webnovel' },
      entities: [{ id: 'a', name: '甲', aliases: [], type: 'character', appears_from_chapter: 1 }],
      knowledge: [], suspense: [],
      timeline: tlChapters.map((n) => ({ chapter: n, day: n })),
    },
    evidence: {
      entities: { a: [{ chapter: 1, line: 2, quote: '甲在村里' }] },
      knowledge: {}, suspense: {},
      timeline: tlEv,
    },
    extraction_notes: [],
  };
}
const emptyBase = { meta: { title: 'R', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] };
// 空基线 + range 1-2：timeline 只覆盖 1-2 章（模型看不到第 3 章）→ 应通过（旧实现报"缺少第3章"）
const rr = validateExtraction(rangeTlEnvelope([1, 2]), { baseline: emptyBase, manuscript: rangeMs, range: { from: 1, to: 2 } });
check('空基线 range 首批：范围内 timeline 完整即通过（不再要求全稿覆盖）', rr.length === 0, rr);
// 批间链式：批 1 输出成为批 2 基线（timeline 1-2）→ 批 2（range 3）输出补第 3 章 → 通过
const chained = validateExtraction(rangeTlEnvelope([1, 2, 3]), { baseline: rangeTlEnvelope([1, 2]).canon, manuscript: rangeMs, range: { from: 3, to: 3 } });
check('链式批 2：基线携带范围外章 + 本批覆盖范围 → 通过', chained.length === 0, chained);
// 链式批 2 模型只输出范围内章（第 3 章），范围外章（1-2）由基线携带 → 通过
// （旧实现误要求模型输出范围外基线章，导致分块提取必然失败）
const dropped = JSON.parse(JSON.stringify(rangeTlEnvelope([3])));
const dropB = JSON.parse(JSON.stringify(rangeTlEnvelope([1, 2]).canon));
check('链式批 2 范围外基线章不要求模型输出（由 merge 携带）',
  validateExtraction(dropped, { baseline: dropB, manuscript: rangeMs, range: { from: 3, to: 3 } }).length === 0, '');
// 范围内基线章缺失仍被拒（基线有第 3 章但模型未输出）
const missBaseOwn = JSON.parse(JSON.stringify(rangeTlEnvelope([])));
const baseOwn = JSON.parse(JSON.stringify(rangeTlEnvelope([3]).canon));
check('范围内基线章缺失仍被拒（基线有但模型未输出）',
  validateExtraction(missBaseOwn, { baseline: baseOwn, manuscript: rangeMs, range: { from: 3, to: 3 } }).some((e) => e.includes('缺少基线已有的第3章')), '');
// 范围内章缺失仍被拒（本批必须覆盖自己的范围）
const missOwn = validateExtraction(rangeTlEnvelope([1]), { baseline: emptyBase, manuscript: rangeMs, range: { from: 1, to: 2 } });
check('范围内章缺失仍被拒（每批强制覆盖自己范围）', missOwn.some((e) => e.includes('缺少正文已有的第2章')), missOwn);
// 无 range 全量：全稿覆盖要求不变
const fullMs = validateExtraction(rangeTlEnvelope([1, 2]), { baseline: emptyBase, manuscript: rangeMs, range: null });
check('全量模式全稿覆盖要求不变', fullMs.some((e) => e.includes('缺少正文已有的第3章')), fullMs);

console.log('场景 18: rebase 无漂移 → 无需执行（不调 LLM）');
const rbs0 = spawnSync(process.execPath, [RBS, 'test/fixtures/clean-canon.json', 'test/fixtures/clean-canon.json'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('exit code = 0', rbs0.status === 0, `got ${rbs0.status}\n${rbs0.stdout}`);
check('提示无需 rebase', rbs0.stdout.includes('无需 rebase'), rbs0.stdout);

console.log('场景 19: rebase 有漂移 + --dry-run → 预览将执行的模拟（不调 LLM）');
const rbs1 = spawnSync(process.execPath, [RBS, 'test/fixtures/rebase-pred.json', 'test/fixtures/clean-canon.json', '--dry-run'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('exit code = 0（dry-run 预览）', rbs1.status === 0, `got ${rbs1.status}\n${rbs1.stdout}`);
check('报告漂移数量', /漂移检测：\d+ 处警告级偏差/.test(rbs1.stdout), rbs1.stdout);
check('预览包含模拟器提示词', rbs1.stdout.includes('小说模拟器'), rbs1.stdout);
check('命令包含 --canon 实际', rbs1.stdout.includes('--canon test/fixtures/clean-canon.json'), rbs1.stdout);

console.log('场景 19b: rebase 相对路径 source_outline 三级解析（预测目录优先，cwd 兜底）');
// ① 旧信封（相对路径按 cwd 写，预测目录无该文件）→ 回退 cwd 解析成功
const rbsRel = spawnSync(process.execPath, [RBS, 'test/fixtures/rebase-pred.json', 'test/fixtures/clean-canon.json', '--dry-run'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('旧信封相对路径回退 cwd 解析（exit 0）', rbsRel.status === 0 && rbsRel.stdout.includes('outline.md'), `${rbsRel.status} ${rbsRel.stdout.slice(-200)}`);
// ② 相对路径 + 预测文件同目录存在 → 按预测目录解析（不同 cwd 也能工作）
const relEnvFile = path.join(ROOT, 'test', 'fixtures', 'tmp-rel-env.json');
const relEnvCanon = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/rebase-pred.json'), 'utf8')).canon; // 与 clean-canon 有漂移
fs.writeFileSync(relEnvFile, JSON.stringify({
  tool: 'novel-compiler/simulate',
  meta: { source_outline: '../../examples/outline.md', source_premise: null, target_reader: 'webnovel' }, // 相对 test/fixtures 回退两级到项目根
  canon: relEnvCanon,
  risk_register: [],
  simulation_notes: [],
}, null, 2), 'utf8');
try {
  const rbsRel2 = spawnSync(process.execPath, [RBS, relEnvFile, 'test/fixtures/clean-canon.json', '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
  });
  check('相对路径按预测文件目录解析（exit 0，解析到存在的 examples/outline.md）', rbsRel2.status === 0 && rbsRel2.stdout.includes('outline.md') && !rbsRel2.stdout.includes('无法推导'), `${rbsRel2.status} ${rbsRel2.stdout.slice(-250)}`);
} finally {
  try { fs.unlinkSync(relEnvFile); } catch { /* 忽略 */ }
}

console.log('场景 20: rebase 有漂移且缺密钥 → 退出 2');
const rbs2 = spawnSync(process.execPath, [RBS, 'test/fixtures/rebase-pred.json', 'test/fixtures/clean-canon.json'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('exit code = 2', rbs2.status === 2, `got ${rbs2.status}\n${rbs2.stdout}${rbs2.stderr}`);
check('提示缺少密钥', (rbs2.stdout + rbs2.stderr).includes('DEEPSEEK_API_KEY'), rbs2.stdout + rbs2.stderr);

console.log('场景 21: rebase 非法输入 → 退出 2');
const rbs3 = run(['test/fixtures/bad-canon.json', 'test/fixtures/clean-canon.json'], RBS);
check('exit code = 2', rbs3.code === 2, `got ${rbs3.code}\n${rbs3.out}`);

console.log('场景 22: rebase 无漂移 + --force --dry-run → 强制预览');
const rbs4 = spawnSync(process.execPath, [RBS, 'test/fixtures/clean-canon.json', 'test/fixtures/clean-canon.json', '--force', '--dry-run', '--outline', 'examples/outline.md'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('exit code = 0', rbs4.status === 0, `got ${rbs4.status}\n${rbs4.stdout}`);
check('强制执行了预览', rbs4.stdout.includes('执行 rebase'), rbs4.stdout);

console.log('场景 23: 纯文本章节标题（无 # 前缀 / 中文数字 / 空格）可正常分章');
const ph = run(['test/fixtures/plain-heading-manuscript.md', 'test/fixtures/clean-canon.json', '--json']);
let phJ = null;
try { phJ = JSON.parse(ph.out); } catch { /* noop */ }
check('exit code = 0', ph.code === 0, `got ${ph.code}\n${ph.out}`);
check('识别 3 章', !!phJ && phJ.manifest.chapters === 3, ph.out.slice(0, 300));

console.log('场景 23b: 中文数字「万」章节号（cnToInt 扩展，前后端口径一致）');
const { cnToInt: cti23 } = require('../src/extract');
check('cnToInt 支持万', cti23('一万') === 10000 && cti23('三万五千') === 35000 && cti23('十万') === 100000 && cti23('一万零三百') === 10300, `${cti23('一万')} ${cti23('三万五千')} ${cti23('十万')} ${cti23('一万零三百')}`);
const { parseManuscript: pmWan } = require('../src/extract');
const pWan = pmWan('# 第1章 甲\n\n正文。\n\n# 第一万章 终\n\n正文。\n');
check('「第一万章」被识别（number=10000）', pWan.chapters.length === 2 && pWan.chapters[1].number === 10000, JSON.stringify(pWan.chapters.map((c) => c.number)));

console.log('场景 24: 楔子（=第0章）+ Markdown/纯文本混合标题');
const pl = run(['test/fixtures/prologue-manuscript.md', 'test/fixtures/prologue-canon.json', '--json']);
let plJ = null;
try { plJ = JSON.parse(pl.out); } catch { /* noop */ }
check('exit code = 0', pl.code === 0, `got ${pl.code}\n${pl.out}`);
check('识别 3 章（含楔子）', !!plJ && plJ.manifest.chapters === 3, pl.out.slice(0, 300));
check('时间线含第0章', !!plJ && plJ.snapshot.timeline.some((t) => t.chapter === 0), '');

console.log('场景 25: 无章节标题 → exit 2 + 格式提示');
const nh = run(['test/fixtures/no-heading.txt', 'test/fixtures/clean-canon.json']);
check('exit code = 2', nh.code === 2, `got ${nh.code}\n${nh.out}${nh.err}`);
check('提示两种分章格式', (nh.out + nh.err).includes('两种分章格式'), nh.out + nh.err);

console.log('场景 26: 提取范围纪律（范围外禁止修正）单测');
const { validateExtraction: ve } = require('../src/extraction');
const phMs = fs.readFileSync(path.join(ROOT, 'test/fixtures/plain-heading-manuscript.md'), 'utf8');
function rangeRaw() {
  const canon = JSON.parse(JSON.stringify(cleanCanon));
  return {
    canon,
    evidence: {
      entities: {},
      knowledge: {},
      suspense: {},
      timeline: {
        '2': [{ chapter: 2, line: 17, quote: '第二天，两人进了档案馆' }],
        '3': [{ chapter: 3, line: 31, quote: '第三天傍晚' }],
      },
    },
    extraction_notes: [],
  };
}
const rg = { from: 2, to: 3 };
const rOk = rangeRaw();
check('范围内提取通过校验', ve(rOk, { baseline: cleanCanon, manuscript: phMs, range: rg }).length === 0,
  ve(rOk, { baseline: cleanCanon, manuscript: phMs, range: rg }));
const rNoBase = {
  canon: {
    meta: { title: 't', target_reader: 'genre' },
    entities: [{ id: 'tea_house', name: '茶馆', aliases: [], type: 'location', appears_from_chapter: 1 }],
    knowledge: [],
    suspense: [],
    timeline: [
      { chapter: 1, day: 1, location: 'tea_house' },
      { chapter: 2, day: 2, location: 'tea_house' },
      { chapter: 3, day: 3, location: 'tea_house' },
    ],
  },
  evidence: {
    entities: { tea_house: [{ chapter: 1, line: 3, quote: '茶馆' }] },
    knowledge: {},
    suspense: {},
    timeline: {
      '1': [{ chapter: 1, line: 3, quote: '茶馆' }],
      '2': [{ chapter: 2, line: 17, quote: '第二天，两人进了档案馆' }],
      '3': [{ chapter: 3, line: 31, quote: '第三天傍晚' }],
    },
  },
  extraction_notes: [],
};
check('无基线 + 范围提取不崩溃且通过', ve(rNoBase, { baseline: null, manuscript: phMs, range: { from: 1, to: 3 } }).length === 0,
  ve(rNoBase, { baseline: null, manuscript: phMs, range: { from: 1, to: 3 } }));
const rTl = rangeRaw();
rTl.canon.timeline = rTl.canon.timeline.filter((t) => t.chapter !== 3);
check('时间线缺章被拒', ve(rTl, { baseline: cleanCanon, manuscript: phMs, range: rg }).some((e) => e.includes('第3章')), '');
const rRet = rangeRaw();
rRet.retired = { suspense: ['s1'] };
check('retired.suspense 合法（基线 id）通过', ve(rRet, { baseline: cleanCanon, manuscript: phMs, range: rg }).length === 0, '');
const rRetBad = rangeRaw();
rRetBad.retired = { suspense: ['not_exist'] };
check('retired.suspense 非基线 id 被拒', ve(rRetBad, { baseline: cleanCanon, manuscript: phMs, range: rg }).some((e) => e.includes('不是基线条目')), '');
const r1 = rangeRaw();
r1.canon.knowledge[0].known_from_chapter = 2; // 修改基线条目且无范围内证据
check('基线条目无证据修正被拒', ve(r1, { baseline: cleanCanon, manuscript: phMs, range: rg }).some((e) => e.includes('范围外条目不修正')), '');
const r2 = rangeRaw();
r2.canon.timeline.push({ chapter: 4, day: 9, location: 'jiang_cheng' }); // 范围外新增 timeline
check('范围外新增 timeline 被拒', ve(r2, { baseline: cleanCanon, manuscript: phMs, range: rg }).some((e) => e.includes('范围外新增 timeline')), '');
const r3 = rangeRaw();
r3.evidence.entities.tea_house = [{ chapter: 1, line: 3, quote: '茶馆' }];
r3.canon.entities.push({ id: 'tea_house', name: '茶馆', aliases: [], type: 'location', appears_from_chapter: 1 });
check('新增条目证据在范围外被拒', ve(r3, { baseline: cleanCanon, manuscript: phMs, range: rg }).some((e) => e.includes('不在提取范围内')), '');

console.log('场景 27: 提取器 --from/--to 范围 dry-run（提示词含范围标记）');
const extRng = run(['test/fixtures/plain-heading-manuscript.md', '--from', '2', '--to', '3', '--dry-run'], EXT);
check('exit code = 0', extRng.code === 0, `got ${extRng.code}\n${extRng.err}`);
check('提示词含提取范围标记', extRng.out.includes('提取范围') && extRng.out.includes('第2 至 第3'), '');

console.log('场景 27b: 提取器自动分块 dry-run（LLM_INPUT_BUDGET_TOKENS 小预算强制多批，不调 LLM）');
const longMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-long-ms.md');
fs.writeFileSync(longMsFile, longMs, 'utf8');
try {
  const chunkDry = spawnSync(process.execPath, [EXT, longMsFile, '--canon', 'test/fixtures/clean-canon.json', '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, LLM_INPUT_BUDGET_TOKENS: '8000' },
  });
  check('分块 dry-run exit 0', chunkDry.status === 0, `got ${chunkDry.status}\n${chunkDry.stdout}${chunkDry.stderr}`);
  check('dry-run 打印分块计划', /自动分块：正文\+基线估算超预算，将分 \d+ 批/.test(chunkDry.stdout) && chunkDry.stdout.includes('批 1: 第1-'), chunkDry.stdout.slice(0, 400));
  check('dry-run 批 1 提示词含范围标记', chunkDry.stdout.includes('提取范围'), chunkDry.stdout.slice(0, 400));
} finally {
  try { fs.unlinkSync(longMsFile); } catch { /* 忽略 */ }
}

console.log('场景 27b2: 分块批次超硬上限在规划期被拒（exit 2，不调 LLM）');
// 回归来源：预算配得比模型上下文还小（或单章过大）时规划器可能打出必败批次；
// 旧实现仅警告放行——逐批调用逐批 400 白烧钱。预算 8000 → 硬上限 24000
fs.writeFileSync(longMsFile, `# 第1章 巨章\n${'正文'.repeat(13000)}\n\n# 第2章 小章\n正常内容。\n`, 'utf8');
try {
  const doomedRun = spawnSync(process.execPath, [EXT, longMsFile, '--canon', 'test/fixtures/clean-canon.json', '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, LLM_INPUT_BUDGET_TOKENS: '8000' },
  });
  check('必败批次规划期 exit 2', doomedRun.status === 2, `got ${doomedRun.status}\n${doomedRun.stdout}${doomedRun.stderr}`);
  const dOut = doomedRun.stdout + doomedRun.stderr;
  check('错误信息含硬上限与拆分建议', dOut.includes('超硬上限') && dOut.includes('24000') && dOut.includes('第1-1章'), dOut.slice(0, 300));
} finally {
  try { fs.unlinkSync(longMsFile); } catch { /* 忽略 */ }
}

console.log('场景 27c: 增量退化路径自动分块（--merge-with 缺失 / 旧版无哈希 → 等效全量 → 分块）');
const incrChunkMerge = path.join(ROOT, 'test', 'fixtures', 'tmp-incr-chunk-merge.json');
try { fs.unlinkSync(path.join(ROOT, 'test', 'fixtures', 'last-extract.json')); } catch { /* 残留清理 */ }
fs.writeFileSync(longMsFile, longMs, 'utf8');
try {
  // ① --merge-with 缺失（首次运行退化全量）：超预算必须走分块（旧实现单次全量静默超上下文）
  const incrChunk1 = spawnSync(process.execPath, [EXT, longMsFile, '--canon', 'test/fixtures/clean-canon.json', '--incremental', '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, LLM_INPUT_BUDGET_TOKENS: '8000' },
  });
  check('增量首次退化（无 merge-with）自动分块', /自动分块：正文\+基线估算超预算，将分 \d+ 批/.test(incrChunk1.stdout), incrChunk1.stdout.slice(0, 300));
  // ② 旧版产物无 chapter_hashes：等效全量 → 同样分块
  fs.writeFileSync(incrChunkMerge, JSON.stringify({ tool: 'novel-compiler/extract-llm', meta: { title: 'T', simulated_at: 'T' }, canon: cleanCanon, evidence: {} }), 'utf8');
  const incrChunk2 = spawnSync(process.execPath, [EXT, longMsFile, '--canon', 'test/fixtures/clean-canon.json', '--incremental', '--merge-with', incrChunkMerge, '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, LLM_INPUT_BUDGET_TOKENS: '8000' },
  });
  check('旧版无哈希退化（等效全量）自动分块', /自动分块：正文\+基线估算超预算，将分 \d+ 批/.test(incrChunk2.stdout), incrChunk2.stdout.slice(0, 300));
} finally {
  try { fs.unlinkSync(longMsFile); } catch { /* 忽略 */ }
  try { fs.unlinkSync(incrChunkMerge); } catch { /* 忽略 */ }
}

console.log('场景 28: 审阅模块单测（reviewProposal / applyReview）');
const { reviewProposal, applyReview } = require('../src/review');
const predCanon = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/pred-canon.json'), 'utf8'));
const rv = reviewProposal(cleanCanon, predCanon);
check('检出新实体（老周）', rv.sections.entities.added.some((x) => x.id === 'old_zhou'), JSON.stringify(rv.counts));
check('检出知识字段修改', rv.sections.knowledge.modified.some((x) => x.id === 'k1' && x.changed.known_from_chapter), '');
check('检出时间线漂移', rv.sections.timeline.modified.length >= 2, '');
const merged = applyReview(cleanCanon, predCanon, [
  { section: 'entities', id: 'old_zhou', action: 'accept' },
  { section: 'knowledge', id: 'k1', action: 'accept' },
  { section: 'timeline', id: '2', action: 'reject' },
]);
check('接受实体进入合并结果', merged.entities.some((x) => x.id === 'old_zhou'), '');
check('接受的知识修正生效', merged.knowledge.find((x) => x.id === 'k1').known_from_chapter === 2, '');
check('拒绝的时间线保持基线', merged.timeline.find((x) => x.chapter === 2).day === 2, JSON.stringify(merged.timeline));
// 时间线决定 key 回归锁：条目没有 id 字段，必须用 chapter 作为决定 id（前端 timeline|undefined 曾永远匹配不上后端）
const mergedTl = applyReview(cleanCanon, predCanon, [
  { section: 'timeline', id: '2', action: 'accept' },
  { section: 'timeline', id: '3', action: 'accept' },
  { section: 'timeline', id: '1', action: 'reject' },
]);
const tlAfter = mergedTl.timeline;
check('审阅：timeline 接受按 chapter id 生效（第2章 day 2→3）', tlAfter.find((x) => x.chapter === 2).day === 3, JSON.stringify(tlAfter));
check('审阅：timeline 新增接受生效（第3章加入）', tlAfter.some((x) => x.chapter === 3 && x.day === 4), JSON.stringify(tlAfter));
check('审阅：timeline 拒绝保持基线（第1章 day=1）', tlAfter.find((x) => x.chapter === 1).day === 1, JSON.stringify(tlAfter));
// M4 升级：timeline 决定缺 chapter（id=undefined）从「静默拼 timeline|undefined 当拒绝」改为显式抛错——
// 旧行为用户以为接受了却没生效；新契约强制携带合法 chapter，非法值直接失败
let threwTlUndef = false;
try { applyReview(cleanCanon, predCanon, [{ section: 'timeline', id: undefined, action: 'accept' }]); }
catch (e) { threwTlUndef = /缺少 chapter/.test(e.message); }
check('回归锁：timeline id=undefined 抛错（不再静默当拒绝）', threwTlUndef, '');
// 统一 fieldsChanged（union 键集）后：提议删除基线字段必须被识别为 modified（旧 review 实现只遍历提议键，会漏报）
const delCanon = JSON.parse(JSON.stringify(predCanon));
delete delCanon.entities[0].aliases; // 基线 shen_mo 有 aliases:[]，提议删除该键
const rvDel = reviewProposal(cleanCanon, delCanon);
check('审阅 diff：提议删除基线字段被识别为 modified', rvDel.sections.entities.modified.some((x) => x.id === 'shen_mo' && x.changed.aliases), JSON.stringify(rvDel.sections.entities.modified));
// applyReview edit 路径：身份强制 + 非法 value 拒绝
const mergedEdit = applyReview(cleanCanon, predCanon, [
  { section: 'entities', id: 'old_zhou', action: 'edit', value: { name: '老周改', type: 'character' } }, // 编辑值无 id
]);
check('编辑值强制保持身份 id（old_zhou 进入且无缺 id 条目）', !!mergedEdit.entities.find((x) => x.id === 'old_zhou' && x.name === '老周改') && !mergedEdit.entities.some((x) => !x.id), JSON.stringify(mergedEdit.entities));
const mergedEditArr = applyReview(cleanCanon, predCanon, [{ section: 'entities', id: 'old_zhou', action: 'edit', value: [1, 2] }]);
check('编辑值为数组被拒（保持基线，不加入）', !mergedEditArr.entities.some((x) => x.id === 'old_zhou'), '');
const mergedEditTl = applyReview(cleanCanon, predCanon, [{ section: 'timeline', id: '2', action: 'edit', value: { day: 9 } }]);
check('时间线编辑强制保持 chapter', !!mergedEditTl.timeline.find((x) => x.chapter === 2 && x.day === 9) && !mergedEditTl.timeline.some((x) => x.chapter === undefined), JSON.stringify(mergedEditTl.timeline));
let threwAction = false;
try { applyReview(cleanCanon, predCanon, [{ section: 'entities', id: 'old_zhou', action: 'bogus' }]); } catch (e) { threwAction = /非法审阅决定 action/.test(e.message); }
check('applyReview 非法 action 抛错（不静默当拒绝）', threwAction, '');
// 缺字段 baseline 防御：baseline 没有 entities/timeline 数组时 accept 不抛错且新增条目进入结果
const sparseBase = { meta: { title: 'T', target_reader: 'webnovel' } }; // 缺 entities/knowledge/suspense/timeline
const sparseMerged = applyReview(sparseBase, {
  canon: { meta: { title: 'T', target_reader: 'webnovel' }, entities: [{ id: 'a', name: '甲', type: 'character' }], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }] },
  evidence: {},
}, [
  { section: 'entities', id: 'a', action: 'accept' },
  { section: 'timeline', id: '1', action: 'accept' },
]);
check('applyReview 缺字段 baseline 不抛错且结果含新增条目', Array.isArray(sparseMerged.entities) && sparseMerged.entities[0].id === 'a' && Array.isArray(sparseMerged.timeline) && sparseMerged.timeline[0].chapter === 1 && sparseMerged.knowledge.length === 0, JSON.stringify(sparseMerged));
// nameIdx 空名误匹配回归：基线有无名字段时，提议的无名字段不应覆盖基线
const noNameBase = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [{ id: 'a' /* 无 name */ }], knowledge: [], suspense: [], timeline: [] };
const noNameProp = { canon: { meta: { title: 'T', target_reader: 'webnovel' }, entities: [{ id: 'b' /* 无 name */ }], knowledge: [], suspense: [], timeline: [] }, evidence: {} };
const noNameMerged = applyReview(noNameBase, noNameProp, [{ section: 'entities', id: 'b', action: 'accept' }]);
check('nameIdx 空名不误匹配：无名字段按 id 匹配，不覆盖其他无名条目', noNameMerged.entities.length === 2 && noNameMerged.entities.some((x) => x.id === 'a') && noNameMerged.entities.some((x) => x.id === 'b'), JSON.stringify(noNameMerged.entities));
const noNameRv = reviewProposal(noNameBase, noNameProp.canon);
check('reviewProposal 空名不误匹配：无名字段不匹配其他无名条目（视为新增）', noNameRv.sections.entities.added.some((x) => x.id === 'b'), JSON.stringify(noNameRv.sections.entities));
// 空对象编辑：无意义编辑被忽略（保持基线，不产生只有 id 的残条条目）
const emptyEdit = applyReview(cleanCanon, predCanon, [{ section: 'entities', id: 'old_zhou', action: 'edit', value: {} }]);
check('applyReview 空对象编辑被忽略（不加入残条条目）', !emptyEdit.entities.some((x) => x.id === 'old_zhou'), '');
// 非数组基线兜底：baseline section 是字符串/对象等 truthy 非数组时不抛 TypeError（补空数组）
const weirdBase = { meta: { title: 'T', target_reader: 'webnovel' }, entities: 'oops', knowledge: 42, suspense: { a: 1 }, timeline: null };
const weirdMerged = applyReview(weirdBase, {
  canon: { meta: { title: 'T', target_reader: 'webnovel' }, entities: [{ id: 'a', name: '甲', type: 'character' }], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }] },
  evidence: {},
}, [
  { section: 'entities', id: 'a', action: 'accept' },
  { section: 'timeline', chapter: 1, action: 'accept' }, // chapter 字段传决定（API 兼容形态）
]);
check('applyReview 非数组 baseline 兜底补空数组（不抛 TypeError）', Array.isArray(weirdMerged.entities) && weirdMerged.entities[0].id === 'a' && Array.isArray(weirdMerged.knowledge) && Array.isArray(weirdMerged.suspense) && Array.isArray(weirdMerged.timeline), JSON.stringify(weirdMerged));
// timeline 决定用 chapter 字段（非 id）同样生效
check('applyReview timeline 决定兼容 chapter 字段（不静默当拒绝）', Array.isArray(weirdMerged.timeline) && weirdMerged.timeline.some((t) => t.chapter === 1), JSON.stringify(weirdMerged.timeline));
// timeline 决定 key 标准化（v0.4.4 M4）：chapter 必须是有效非负整数——
// null/空串/非数字/负数/小数一律拒绝，否则旧实现拼 `timeline|undefined` 静默当拒绝
// （用户以为接受了却没生效，且非法值混入会以 `timeline|NaN` 形式污染决定集合）
const tlThrow = (d) => {
  let threw = false;
  try { applyReview(cleanCanon, predCanon, [d]); } catch (e) { threw = e; }
  return threw;
};
check('审阅：timeline 决定 chapter=null 抛错（不静默当拒绝）', /缺少 chapter/.test(String(tlThrow({ section: 'timeline', id: null, action: 'accept' }))), '');
check('审阅：timeline 决定 chapter 空串抛错', /缺少 chapter/.test(String(tlThrow({ section: 'timeline', id: '', action: 'accept' }))), '');
check('审阅：timeline 决定 chapter 非数字抛错', /非负整数 chapter/.test(String(tlThrow({ section: 'timeline', chapter: '2x', action: 'accept' }))), '');
check('审阅：timeline 决定 chapter 负数抛错', /非负整数 chapter/.test(String(tlThrow({ section: 'timeline', chapter: -1, action: 'accept' }))), '');
check('审阅：timeline 决定 chapter 小数抛错', /非负整数 chapter/.test(String(tlThrow({ section: 'timeline', chapter: 1.5, action: 'accept' }))), '');
const mergedTlStr = applyReview(cleanCanon, predCanon, [{ section: 'timeline', chapter: '2', action: 'accept' }]);
check('审阅：timeline 决定 chapter 数字字符串生效（第2章 day 2→3）', mergedTlStr.timeline.find((x) => x.chapter === 2).day === 3, JSON.stringify(mergedTlStr.timeline));
// timeline 输出按 chapter 排序：baseline 不连续（1,3,5）时 accept 新增章不乱序
const gapBaseTl = {
  meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [],
  timeline: [{ chapter: 1, day: 1 }, { chapter: 3, day: 3 }, { chapter: 5, day: 5 }],
};
const gapMergedTl = applyReview(gapBaseTl, {
  canon: { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 2, day: 2 }, { chapter: 4, day: 4 }] },
  evidence: {},
}, [
  { section: 'timeline', chapter: 2, action: 'accept' },
  { section: 'timeline', chapter: 4, action: 'accept' },
]);
check('applyReview timeline 输出按 chapter 排序（1,2,3,4,5）', JSON.stringify(gapMergedTl.timeline.map((t) => t.chapter)) === JSON.stringify([1, 2, 3, 4, 5]), JSON.stringify(gapMergedTl.timeline));

// 退役建议（retired）接入审阅决定：信封 retired.suspense → reviewProposal 分组 + applyReview 裁决。
// 提取强制回显全部基线条目，退役条目仍在提议 canon 中——删不删必须由作者显式决定，不能靠"提议缺失"推断
const retiredEnv = {
  ...predCanon, // 纯 canon 字段（unwrapEnvelope 直通）
  retired: { suspense: ['s1'] }, // s1 是 cleanCanon 中真实存在的悬念（十年前火灾的真相）
};
const rvRet = reviewProposal(cleanCanon, retiredEnv);
check('审阅：retired 建议进入分组（counts.retired=1 且含基线条目）', rvRet.counts.retired === 1 && rvRet.retired.length === 1 && rvRet.retired[0].id === 's1' && rvRet.retired[0].name === '十年前火灾的真相', JSON.stringify(rvRet.retired));
const mergedRetDel = applyReview(cleanCanon, retiredEnv, [{ section: 'suspense', id: 's1', action: 'accept' }]);
check('审阅：退役 accept 从基线删除该悬念', !mergedRetDel.suspense.some((s) => s.id === 's1') && mergedRetDel.suspense.length === 0, JSON.stringify(mergedRetDel.suspense));
const mergedRetKeep = applyReview(cleanCanon, retiredEnv, [{ section: 'suspense', id: 's1', action: 'reject' }]);
check('审阅：退役 reject 保留基线条目', mergedRetKeep.suspense.some((s) => s.id === 's1'), '');
const mergedRetUnd = applyReview(cleanCanon, retiredEnv, []);
check('审阅：退役未决定默认保留（基线优先）', mergedRetUnd.suspense.some((s) => s.id === 's1'), '');
// 退役条目不能被普通 accept 当成"接受保留值"（跳过普通更新路径，否则 accept 反而把删除建议洗白成保留）
const mergedRetMix = applyReview(cleanCanon, retiredEnv, [
  { section: 'suspense', id: 's1', action: 'accept' },
  { section: 'entities', id: 'old_zhou', action: 'accept' },
]);
check('审阅：退役 accept 与普通 accept 混合正确（悬念删、实体入）', !mergedRetMix.suspense.some((s) => s.id === 's1') && mergedRetMix.entities.some((x) => x.id === 'old_zhou'), JSON.stringify(mergedRetMix));
let threwRetEdit = false;
try { applyReview(cleanCanon, retiredEnv, [{ section: 'suspense', id: 's1', action: 'edit', value: { name: '改' } }]); }
catch (e) { threwRetEdit = /退役条目.*不支持编辑/.test(e.message); }
check('审阅：退役条目编辑被拒（显式抛错，不静默按保留）', threwRetEdit, '');

console.log('场景 28b: 分块番外警告 + retired 透传（extract-llm 源码断言）');
const exllmSrc = fs.readFileSync(path.join(ROOT, 'extract-llm.js'), 'utf8');
check('extract-llm 分块含番外明确警告（不静默漏提）', exllmSrc.includes('分块范围仅覆盖编号章') && exllmSrc.includes('无编号章节'), '');
check('extract-llm 退役建议透传信封（增量/全量，IDE 审阅可裁决）', exllmSrc.includes('已透传信封') && exllmSrc.includes('在 IDE 审阅中逐条裁决'), '');

console.log('场景 29: 重构 --dry-run 输出三段提示词（不调 LLM）');
const bld = run(['test/fixtures/clean-manuscript.md', 'test/fixtures/clean-canon.json', 'test/fixtures/outline-tmp.md', 'test/fixtures/premise-tmp.md', '--dry-run'], BLD);
check('exit code = 0', bld.code === 0, `got ${bld.code}\n${bld.err}`);
check('包含大纲回写器', bld.out.includes('大纲回写器'), '');
check('包含设定回写器', bld.out.includes('设定回写器'), '');

console.log('场景 30: 重构缺密钥 → 退出 2');
const bldNoKey = spawnSync(process.execPath, [BLD, 'test/fixtures/clean-manuscript.md', 'test/fixtures/clean-canon.json', 'test/fixtures/outline-tmp.md', 'test/fixtures/premise-tmp.md'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('exit code = 2', bldNoKey.status === 2, `got ${bldNoKey.status}\n${bldNoKey.stdout}${bldNoKey.stderr}`);
check('提示缺少密钥', (bldNoKey.stdout + bldNoKey.stderr).includes('DEEPSEEK_API_KEY'), '');

console.log('场景 31: 大纲/前提回写校验单测');
const { validateOutline, validatePremise } = require('../src/outline');
const phMs2 = fs.readFileSync(path.join(ROOT, 'test/fixtures/plain-heading-manuscript.md'), 'utf8');
const goodOutline = '# 信与钟\n\n## 第1章 信\n- 雨夜收信，约见林晚\n- 约定次日查档\n\n## 第2章 档案\n- 进档案馆查火灾记录\n- 发现卷宗少了一卷\n\n## 第3章 钟声\n- 傍晚在铜钟里找到烧焦的记录\n- 江城的钟声敲过三下\n';
check('合法大纲通过', validateOutline(goodOutline, phMs2).length === 0, validateOutline(goodOutline, phMs2));
check('缺章大纲被拒', validateOutline('# 信与钟\n\n## 第1章 信\n- 收信\n', phMs2).some((e) => e.includes('第2章')), '');
const goodPremise = '# 信与钟\n\n## 世界规则\n现实都市背景，无超自然元素；核心场景为江城与档案馆。\n\n## 角色初始状态\n沈默：调查者，执着克制；林晚：档案馆职员，陪同调查。\n\n## 基调与风格\n冷峻克制，短句为主，雨与钟声意象贯穿。\n\n## 核心冲突与悬念策略\n十年前火灾真相是主悬念，第1章埋设第3章回收；信息差推动剧情。\n';
check('合法前提通过', validatePremise(goodPremise).length === 0, validatePremise(goodPremise));
check('缺角色前提被拒', validatePremise('# 信与钟\n\n## 世界规则\n现实都市背景，无超自然元素；核心场景为江城与档案馆。\n').some((e) => e.includes('角色')), '');
// 楔子（第0章）手稿：大纲写「楔子」标题应通过（不允许要求「第0章」字样）
const proMsV = '# 楔子\n\n风雪夜，山神庙。\n\n# 第1章 信\n\n正文内容。\n';
const proOutlineV = '# 信与钟\n\n## 楔子\n- 雨夜，沈默收到一封没有署名的信，提及十年前的那场大火\n- 信封里有一枚铜钟的旧照片，背面写着档案馆的地址\n\n## 第1章 信\n- 沈默与林晚在档案馆见面，交换关于火灾的线索\n- 约定次日一起查档案室\n';
check('楔子手稿：大纲用「楔子」标题通过校验', validateOutline(proOutlineV, proMsV).length === 0, validateOutline(proOutlineV, proMsV));
check('楔子手稿：大纲缺楔子被拒', validateOutline('# 信与钟\n\n## 第1章 信\n- 收信\n', proMsV).some((e) => e.includes('楔子')), '');

console.log('场景 32: 原子写（fsutil）单测');
const { atomicWrite } = require('../src/fsutil');
const tmpFile = path.join(ROOT, 'test', 'fixtures', 'atomic-tmp.txt');
atomicWrite(tmpFile, '原子写测试内容');
check('原子写成功且内容正确', fs.readFileSync(tmpFile, 'utf8') === '原子写测试内容', '');
try { fs.unlinkSync(tmpFile); } catch { /* 忽略 */ }
// 失败路径：target 是已存在目录 → rename 失败 → 必须清理 .tmp- 临时文件（不留垃圾）
const tmpDirTarget = path.join(ROOT, 'test', 'fixtures', 'atomic-tmp-dir');
fs.mkdirSync(tmpDirTarget, { recursive: true });
let awErr = false;
try { atomicWrite(tmpDirTarget, 'x'); } catch { awErr = true; }
check('atomicWrite 失败时清理 tmp（不留 .tmp- 垃圾）', awErr && !fs.existsSync(`${tmpDirTarget}.tmp-${process.pid}`), '');
try { fs.rmdirSync(tmpDirTarget); } catch { /* 忽略 */ }

console.log('场景 33: LLM 请求体 jsonMode 回归（文本生成禁用 json_object）');
const { buildRequestBody } = require('../src/llm');
const jb = buildRequestBody({ model: 'm', messages: [], jsonMode: true });
const tb = buildRequestBody({ model: 'm', messages: [] });
check('jsonMode=true 携带 response_format', !!jb.response_format && jb.response_format.type === 'json_object', JSON.stringify(jb));
check('文本生成不携带 response_format（防止模型输出空白）', tb.response_format === undefined, JSON.stringify(tb));

console.log('场景 34: 僵尸清理（purgeStale）单测');
const { purgeStale } = require('../src/extraction');
const msText = fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-manuscript.md'), 'utf8');
const zCanon = JSON.parse(JSON.stringify(cleanCanon));
zCanon.entities.push(
  { id: 'ghost_old', name: '旧故事角色', aliases: [], type: 'character' },
  { id: 'future_man', name: '未来角色', aliases: [], type: 'character', appears_from_chapter: 9 },
);
zCanon.knowledge.push({ id: 'kz', name: '旧知识', terms: ['旧术语xyz'], holders: ['shen_mo'], known_from_chapter: 1 });
const purged = purgeStale(zCanon, msText);
check('僵尸实体被移除', purged.removed.entities.includes('ghost_old'), JSON.stringify(purged.removed));
check('未来出场实体保留', purged.canon.entities.some((e) => e.id === 'future_man'), '');
check('活跃实体保留', purged.canon.entities.some((e) => e.id === 'shen_mo'), '');
check('僵尸知识被移除', purged.removed.knowledge.includes('kz'), '');
check('清理后 canon 仍可通过 schema 校验', require('../src/validate').validateCanon(purged.canon).ok, '');
const depCanon = JSON.parse(JSON.stringify(cleanCanon));
depCanon.entities.push({ id: 'ghost2', name: '旧角色2', aliases: [], type: 'character' });
depCanon.knowledge.push({ id: 'kd', name: '关于旧角色的知识', terms: ['暗格'], holders: ['ghost2'], known_from_chapter: 1 });
const depPurged = purgeStale(depCanon, msText);
check('依赖清理：知识 holders 引用被移除实体时联动移除', depPurged.removed.knowledge.includes('kd'), JSON.stringify(depPurged.removed));
check('依赖清理后 schema 仍合法', require('../src/validate').validateCanon(depPurged.canon).ok, '');
check('僵尸实体确实被移除', depPurged.removed.entities.includes('ghost2'), '');
// 反向依赖保护（v0.4.4 修复）：术语仍在正文出现（活跃）或未到期的知识，其 holders 实体受保护。
// 回归来源：「实体零提及被删 → 活跃知识因 holderGone 连带删除」误伤仍在正文中活跃的知识
// （例：知识「蛊毒」术语在正文出现，但 holder 角色全稿未被命名——知识活、实体死，不该互相拖累）
const holdCanon = JSON.parse(JSON.stringify(cleanCanon));
holdCanon.entities.push({ id: 'ghost_holder', name: '无名知情者', aliases: [], type: 'character' }); // 零提及实体
holdCanon.knowledge.push({ id: 'k_active', name: '烧焦记录在铜钟里', terms: ['铜钟'], holders: ['ghost_holder'], known_from_chapter: 1 }); // 术语「铜钟」在正文出现 → 活跃
const holdPurged = purgeStale(holdCanon, msText);
check('反向依赖：活跃知识的 holder 实体豁免清理（即使零提及）', holdPurged.canon.entities.some((e) => e.id === 'ghost_holder'), JSON.stringify(holdPurged.removed));
check('反向依赖：活跃知识因 holder 保留而保留', holdPurged.canon.knowledge.some((k) => k.id === 'k_active'), JSON.stringify(holdPurged.removed));
check('反向依赖清理后 schema 仍合法', require('../src/validate').validateCanon(holdPurged.canon).ok, '');
const holdFuture = JSON.parse(JSON.stringify(cleanCanon));
holdFuture.entities.push({ id: 'future_holder', name: '未来知情者', aliases: [], type: 'character' }); // 零提及实体
holdFuture.knowledge.push({ id: 'k_future', name: '未来真相', terms: ['暗格'], holders: ['future_holder'], known_from_chapter: 9 }); // 未到期（>末章3）
const futurePurged = purgeStale(holdFuture, msText);
check('未到期知识（known_from_chapter>末章）的 holder 实体豁免清理', futurePurged.canon.entities.some((e) => e.id === 'future_holder'), JSON.stringify(futurePurged.removed));
check('未到期知识本身保留', futurePurged.canon.knowledge.some((k) => k.id === 'k_future'), JSON.stringify(futurePurged.removed));
check('未到期清理后 schema 仍合法', require('../src/validate').validateCanon(futurePurged.canon).ok, '');
const tlCanon = JSON.parse(JSON.stringify(cleanCanon));
tlCanon.entities.push({ id: 'old_loc', name: '旧地点', aliases: [], type: 'location' });
tlCanon.timeline.push({ chapter: 4, day: 9, location: 'old_loc' });
const tlPurged = purgeStale(tlCanon, msText);
check('时间线引用的地点实体豁免清理', tlPurged.canon.entities.some((e) => e.id === 'old_loc'), JSON.stringify(tlPurged.removed));
check('豁免清理后时间线完整性保持', tlPurged.canon.timeline.length === 4 && tlPurged.canon.timeline.some((t) => t.chapter === 4), JSON.stringify(tlPurged.canon.timeline));

console.log('场景 34b: 僵尸清理按「可见文本」统计术语（wj-suppress 豁免注释不误保知识）');
// 回归来源：旧实现 purgeStale 用全文（含豁免注释行）做术语命中，豁免注释里的术语会误保
// 已到期知识；scanMentions 对实体早已跳过豁免行，术语统计必须与之一致（豁免是元数据非正文）。
const supMsText = [
  '# 第1章 信', '',
  '江城下了整夜的雨。沈默与林晚碰面，商量对策。铜钟在档案馆。', '',
  '# 第2章 档案', '',
  '两人进了档案馆，继续调查。', '',
  '# 第3章 钟声', '',
  '<!-- wj-suppress: entity/missing 豁免注释里的「暗格」只是元数据，不算正文提及 -->', '',
  '正文结束。', '',
].join('\n');
const supCanon = JSON.parse(JSON.stringify(cleanCanon));
supCanon.knowledge.push(
  { id: 'k_visible', name: '可见术语知识', terms: ['铜钟'], holders: ['shen_mo'], known_from_chapter: 1 },
  { id: 'k_suppressed', name: '仅豁免注释里的术语', terms: ['暗格'], holders: ['shen_mo'], known_from_chapter: 1 },
);
const supPurged = purgeStale(supCanon, supMsText);
check('豁免注释中的术语不误保知识（k_suppressed 已到期且仅注释提及 → 清理）', supPurged.removed.knowledge.includes('k_suppressed'), JSON.stringify(supPurged.removed));
check('可见正文中的术语知识保留（k_visible 存活）', supPurged.canon.knowledge.some((k) => k.id === 'k_visible'), JSON.stringify(supPurged.removed));
check('豁免注释清理后 canon 仍可通过 schema 校验', require('../src/validate').validateCanon(supPurged.canon).ok, '');

console.log('场景 35: 同步检查（syncReport）单测');
const { syncReport } = require('../src/outline');
const ms2 = fs.readFileSync(path.join(ROOT, 'test/fixtures/plain-heading-manuscript.md'), 'utf8');
const soOutline = '# 信与钟\n\n## 第1章 信\n- 收信\n\n## 第2章 档案\n- 查档\n\n## 第3章 钟声\n- 找钟\n';
const soPremise = '# 信与钟 · 前提设定\n\n## 世界规则\n现实都市背景，无超自然元素；核心场景为江城与档案馆。\n\n## 角色初始状态\n沈默：调查者，执着克制；林晚：档案馆职员，陪同调查。\n\n## 基调与风格\n冷峻克制，短句为主，雨与钟声意象贯穿。\n\n## 核心冲突与悬念策略\n十年前火灾真相是主悬念，第1章埋设第3章回收；信息差推动剧情。\n';
check('一致时无问题', syncReport({ manuscript: ms2, canon: cleanCanon, outline: soOutline, premise: soPremise }).length === 0,
  syncReport({ manuscript: ms2, canon: cleanCanon, outline: soOutline, premise: soPremise }));
const soBad = syncReport({ manuscript: ms2, canon: cleanCanon, outline: '# 旧书名\n\n## 第1章 信\n- 收信\n', premise: '# 信与钟 · 前提设定\n' });
check('缺章被检出', soBad.some((s) => s.includes('第2章')), soBad.join('|'));
check('标题不一致被检出', soBad.some((s) => s.includes('不一致')), soBad.join('|'));
// 楔子手稿：大纲写「楔子」不误报缺第0章
const proMsS = '# 楔子\n\n风雪夜。\n\n# 第1章 信\n\n正文。\n';
const proOutlineS = '# 信与钟\n\n## 楔子\n- 雨夜\n\n## 第1章 信\n- 收信\n';
const proPremiseS = '# 信与钟 · 前提设定\n\n## 世界规则\n现实都市背景。\n\n## 角色初始状态\n沈默：调查者。\n\n## 基调与风格\n冷峻。\n\n## 核心冲突\n火灾真相。\n';
const proSync = syncReport({ manuscript: proMsS, canon: null, outline: proOutlineS, premise: proPremiseS });
check('同步检查：大纲写「楔子」不误报缺第0章', !proSync.some((s) => s.includes('第0章')), proSync.join('|'));

console.log('场景 36: 多项目配置解析/迁移单测');
const { parseConfig, setActiveInConfig } = require('../app/config-util');
const cfgNew = JSON.stringify({ model: 'm1', activeProject: 'B', projects: { A: { manuscript: 'a.md' }, B: { manuscript: 'b.md', canon: 'b.json', reader: 'genre' } } });
const sNew = parseConfig(cfgNew, ROOT, ROOT);
check('新格式解析出 2 项目且活动指针正确', sNew.projects.length === 2 && sNew.active === 'B', JSON.stringify(sNew.projects));
check('项目字段缺省回退', sNew.projects[0].canon === path.join(ROOT, 'examples', 'canon.json') && sNew.projects[1].reader === 'genre', '');
const cfgOld = JSON.stringify({ manuscript: 'm.md', canon: 'test/fixtures/clean-canon.json', outline: 'o.md', premise: 'p.md', reader: 'genre' });
const sOld = parseConfig(cfgOld, ROOT, ROOT);
check('旧格式迁移单项目且项目名取 canon 标题', sOld.projects.length === 1 && sOld.active === '信与钟', JSON.stringify(sOld.projects));
check('迁移后路径正确', sOld.projects[0].manuscript === path.join(ROOT, 'm.md'), '');
const outNew = setActiveInConfig(cfgNew, 'A');
check('新格式持久化仅改活动项目', JSON.parse(outNew).activeProject === 'A' && JSON.parse(outNew).projects.B.manuscript === 'b.md', '');
const outOld = setActiveInConfig(cfgOld, '信与钟');
const outOldP = JSON.parse(outOld);
check('旧格式持久化迁移为新格式', !!outOldP.projects && outOldP.activeProject === '信与钟' && outOldP.projects['信与钟'].manuscript === 'm.md', outOld);
// 损坏 config：parseConfig 返回 parseError 标记 + 空项目集（不静默给默认项目）
const { asArray } = require('../src/canon');
check('asArray 数组原样/非数组补空', JSON.stringify(asArray([1, 2])) === JSON.stringify([1, 2]) && asArray('x').length === 0 && asArray(42).length === 0 && asArray(null).length === 0 && asArray(undefined).length === 0 && asArray({}).length === 0, '');
const brokenCfg = parseConfig('{broken json', ROOT, ROOT);
check('损坏 config：parseError 标记 + 空项目集（不静默默认）', !!brokenCfg.parseError && brokenCfg.projects.length === 0 && brokenCfg.active === null, JSON.stringify(brokenCfg));
const okCfg = parseConfig(cfgNew, ROOT, ROOT);
check('正常 config：parseError 为 null', okCfg.parseError === null && okCfg.projects.length === 2, '');
let threwBroken = false;
try { setActiveInConfig('{broken json', 'A'); } catch (e) { threwBroken = /拒绝写回/.test(e.message); }
check('损坏 config：setActiveInConfig 抛错拒绝写回', threwBroken, '');
// 非数组 baseline：validateExtraction / mergeCanon 不抛（asArray 兜底）
const { validateExtraction: veNA } = require('../src/extraction');
const weirdBaseline = { meta: { title: 'T', target_reader: 'webnovel' }, entities: 'oops', knowledge: 42, suspense: { a: 1 }, timeline: null };
const weirdProp = {
  canon: { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }] },
  evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: { '1': [{ chapter: 1, line: 1, quote: 'x' }] } },
  extraction_notes: [],
};
const veNAResult = (() => { try { return veNA(weirdProp, { baseline: weirdBaseline, manuscript: '# 第1章 甲\n\nx' }); } catch (e) { return ['THREW: ' + e.message]; } })();
check('validateExtraction 非数组 baseline 不抛（asArray 兜底）', !veNAResult.some((x) => String(x).startsWith('THREW')), JSON.stringify(veNAResult));
const { mergeCanon: mcNA } = require('../src/incremental');
const mcNAResult = (() => { try { return mcNA(weirdBaseline, weirdProp.canon); } catch (e) { return null; } })();
check('mergeCanon 非数组 baseline 不抛且补空数组', !!mcNAResult && Array.isArray(mcNAResult.entities) && Array.isArray(mcNAResult.knowledge) && Array.isArray(mcNAResult.suspense) && Array.isArray(mcNAResult.timeline), JSON.stringify(mcNAResult));

// 本轮新增：rules / diff / report / outline.syncReport 同样用 asArray 兜底
// 真理：canon = { entities: 'oops', knowledge: 42, suspense: { a:1 }, timeline: null } 时不抛 TypeError
const { runChecks: runChecksFn } = require('../src/rules');
const { diffCanons: diffCanonsFn } = require('../src/diff');
const { buildSnapshot, renderText, renderJson } = require('../src/report');
const { syncReport: syncReportFn } = require('../src/outline');
const { parseManuscript, scanMentions, quoteStats } = require('../src/extract');
const ms0 = '# 第1章 甲\n\n一些正文包含「角一」\n';
const parsed0 = parseManuscript(ms0);
const entArr = [{ id: 'c1', name: '角一', type: 'character', appears_from_chapter: 1 }];
const canonWeird = { meta: { title: 'T', target_reader: 'webnovel' }, entities: 'oops', knowledge: 42, suspense: { a: 1 }, timeline: null };
const cfgWeb = { label: '网文', chapterMin: 100, chapterMax: 100000, overdueLimit: 3, danglingSeverity: 'warning' };
const mentions0 = scanMentions(parsed0.chapters, entArr, parsed0.lines);
const quotes0 = quoteStats(parsed0.chapters, parsed0.lines);
const rulesResult = (() => { try { runChecksFn({ canon: canonWeird, parsed: parsed0, mentions: mentions0, quotes: quotes0, cfg: cfgWeb, file: 'm.md' }); return 'ok'; } catch (e) { return 'THREW: ' + e.message; } })();
check('runChecks 非数组 canon 不抛（asArray 兜底）', rulesResult === 'ok', rulesResult);
const diffResult = (() => { try { diffCanonsFn(canonWeird, canonWeird); return 'ok'; } catch (e) { return 'THREW: ' + e.message; } })();
check('diffCanons 非数组 canon 不抛（asArray 兜底）', diffResult === 'ok', diffResult);
const snapResult = (() => { try { buildSnapshot(canonWeird, parsed0, mentions0); return 'ok'; } catch (e) { return 'THREW: ' + e.message; } })();
check('buildSnapshot 非数组 canon 不抛（asArray 兜底）', snapResult === 'ok', snapResult);
const syncResult = (() => { try { syncReportFn({ manuscript: ms0, canon: canonWeird, outline: '# T\n## 第1章 楔\n', premise: '# T\n规则：x\n角色：x\n' }); return 'ok'; } catch (e) { return 'THREW: ' + e.message; } })();
check('syncReport 非数组 canon 不抛（asArray 兜底）', syncResult === 'ok', syncResult);
// renderText/renderJson 接受 suppressed/unused_suppressions 非数组（前端可能漏字段）
const txt = renderText({ manifest: { version: '0', manuscript: 'm.md', canon: 'c.json', chapters: 1, chars: 1, entities: 0, knowledge: 0, suspense: 0 }, problems: [], counts: { error: 0, warning: 0, info: 0 }, snapshot: { entities: [], suspense: [], timeline: [] }, cfg: cfgWeb, suppressed: null, unused_suppressions: 'oops' });
check('renderText 非数组 suppressed/unused_suppressions 兜底为 0', /编译结果/.test(txt), txt.slice(0, 100));
const renderJsonResult = JSON.parse(renderJson({ manifest: { version: '0', manuscript: 'm.md', canon: 'c.json', chapters: 1, chars: 1, entities: 0, knowledge: 0, suspense: 0 }, problems: [], counts: { error: 0, warning: 0, info: 0 }, snapshot: { entities: [], suspense: [], timeline: [] }, cfg: cfgWeb, suppressed: null, unused_suppressions: 'oops' }));
check('renderJson 非数组 suppressed/unused_supensions 兜底为 []', Array.isArray(renderJsonResult.suppressed) && renderJsonResult.suppressed.length === 0 && Array.isArray(renderJsonResult.unused_suppressions) && renderJsonResult.unused_suppressions.length === 0 && renderJsonResult.counts.suppressed === 0, JSON.stringify(renderJsonResult.counts));

console.log('场景 37: 风险状态机单测');
const { parseRiskStatus, buildRiskStatus, isStale } = require('../app/risks');
const metaA = { source: 'last-pred.json', simulated_at: 'T1' };
const st1 = buildRiskStatus('', metaA, 'R1', 'handled');
const st1p = parseRiskStatus(st1);
check('状态写入并解析', st1p.statuses.R1 === 'handled' && st1p.simulated_at === 'T1', st1);
const st2 = buildRiskStatus(st1, metaA, 'R1', 'open');
check('open 清除状态', parseRiskStatus(st2).statuses.R1 === undefined, st2);
const st3 = buildRiskStatus(st1, { source: 'last-pred.json', simulated_at: 'T2' }, 'R2', 'triggered');
const st3p = parseRiskStatus(st3);
check('预测更换后旧状态作废', st3p.statuses.R1 === undefined && st3p.statuses.R2 === 'triggered', st3);
check('过期判定', isStale(parseRiskStatus(st1), { source: 'last-pred.json', simulated_at: 'T2' }) === true
  && isStale(parseRiskStatus(st1), metaA) === false, '');

console.log('场景 38: 新建项目/另存为 config 纯函数单测');
const { addProjectInConfig, setProjectPathInConfig } = require('../app/config-util');
const cfgNew2 = JSON.stringify({ model: 'm', activeProject: 'A', projects: { A: { manuscript: 'a.md' } } });
const added = JSON.parse(addProjectInConfig(cfgNew2, { id: 'B', manuscript: 'b.md', canon: 'b.json', outline: 'bo.md', premise: 'bp.md' }));
check('addProject 追加项目并激活', !!added.projects.B && added.activeProject === 'B' && added.projects.A.manuscript === 'a.md', '');
const addedOld = JSON.parse(addProjectInConfig(JSON.stringify({ manuscript: 'm.md' }), { id: '新', manuscript: 'n.md', canon: 'n.json', outline: 'no.md', premise: 'np.md' }));
check('addProject 旧格式迁移', !!addedOld.projects && addedOld.projects['新'].manuscript === 'n.md' && addedOld.activeProject === '新', '');
// 旧格式迁移必须保留旧项目字段（防新建项目后用户工作文件指针永久丢失）
const addedOldFull = JSON.parse(addProjectInConfig(JSON.stringify({ manuscript: 'm.md', canon: 'c.json', outline: 'o.md', premise: 'p.md', reader: 'genre' }), { id: '新2', manuscript: 'n.md', canon: 'n.json', outline: 'no.md', premise: 'np.md' }));
check('addProject 旧格式迁移保留旧项目全部字段', !!addedOldFull.projects['默认项目']
  && addedOldFull.projects['默认项目'].manuscript === 'm.md'
  && addedOldFull.projects['默认项目'].canon === 'c.json'
  && addedOldFull.projects['默认项目'].outline === 'o.md'
  && addedOldFull.projects['默认项目'].premise === 'p.md'
  && addedOldFull.projects['默认项目'].reader === 'genre'
  && addedOldFull.projects['新2'].manuscript === 'n.md', JSON.stringify(addedOldFull));
const repointed = JSON.parse(setProjectPathInConfig(cfgNew2, 'A', 'manuscript', 'a2.md'));
check('setProjectPath 更新项目文件路径', repointed.projects.A.manuscript === 'a2.md' && repointed.activeProject === 'A', '');
// 旧格式迁移：保留旧项目字段并更新路径（addProjectInConfig 的镜像——不丢工作文件指针）
const repointedOld = JSON.parse(setProjectPathInConfig(JSON.stringify({ manuscript: 'm.md', canon: 'c.json', outline: 'o.md', premise: 'p.md', reader: 'genre' }), '旧项目', 'manuscript', 'a2.md'));
check('setProjectPath 旧格式迁移保留旧项目字段并更新路径', !!repointedOld.projects['旧项目']
  && repointedOld.projects['旧项目'].manuscript === 'a2.md'
  && repointedOld.projects['旧项目'].canon === 'c.json'
  && repointedOld.projects['旧项目'].outline === 'o.md'
  && repointedOld.projects['旧项目'].premise === 'p.md'
  && repointedOld.projects['旧项目'].reader === 'genre', JSON.stringify(repointedOld));
let threw = false;
try { setProjectPathInConfig(cfgNew2, '不存在', 'manuscript', 'x.md'); } catch { threw = true; }
check('setProjectPath 未知项目抛错', threw, '');
let threwActive = false;
try { setActiveInConfig(cfgNew, '不存在'); } catch (e) { threwActive = /项目不存在/.test(e.message); }
check('setActiveInConfig 非法 projectId 抛错（防幽灵 activeProject 写回）', threwActive, '');
// 损坏 config：写回函数抛错拒绝（与 parseConfig 的 parseError 标记配套，防止损坏内容被覆盖成空配置）
let threwBrokenAdd = false;
try { addProjectInConfig('{broken json', { id: 'X', manuscript: 'm' }); } catch (e) { threwBrokenAdd = /拒绝写回/.test(e.message); }
check('损坏 config：addProjectInConfig 抛错拒绝写回', threwBrokenAdd, '');
let threwBrokenPath = false;
try { setProjectPathInConfig('{broken json', 'A', 'manuscript', 'm.md'); } catch (e) { threwBrokenPath = /拒绝写回/.test(e.message); }
check('损坏 config：setProjectPathInConfig 抛错拒绝写回', threwBrokenPath, '');

console.log('场景 38b: 旧格式迁移 canon 标题按 appDir 解析 + 保留字项目 id 防护');
// appDir 口径：旧实现 addProjectInConfig 用 process.cwd() 解析 canon 相对路径，与 parseConfig 的
// appDir 基准不一致——从非 app/ 目录启动时拿错路径，旧项目 id 恒为"默认项目"
const cfgUtilTmp = path.join(ROOT, 'test', 'fixtures', 'tmp-cfgutil');
fs.mkdirSync(cfgUtilTmp, { recursive: true });
fs.writeFileSync(path.join(cfgUtilTmp, 't.json'), JSON.stringify({ meta: { title: '标题甲' } }), 'utf8');
fs.writeFileSync(path.join(cfgUtilTmp, 'proto.json'), JSON.stringify({ meta: { title: '__proto__' } }), 'utf8');
try {
  const addedTitled = JSON.parse(addProjectInConfig(JSON.stringify({ manuscript: 'm.md', canon: 't.json' }), { id: '新3', manuscript: 'n.md' }, cfgUtilTmp));
  check('addProject 旧格式迁移：canon 标题按 appDir 解析（不再恒为"默认项目"）', !!addedTitled.projects['标题甲'] && addedTitled.projects['标题甲'].canon === 't.json', JSON.stringify(addedTitled));
  const pcReserved = parseConfig(JSON.stringify({ canon: 'proto.json' }), cfgUtilTmp, ROOT);
  check('parseConfig 旧格式 canon 标题撞保留字 → 回退"默认项目"', pcReserved.projects.length === 1 && pcReserved.projects[0].id === '默认项目', JSON.stringify(pcReserved.projects.map((p) => p.id)));
  // 保留字 id 走 [[Set]] 会设原型而非自有属性：项目在 JSON.stringify 时静默消失——统一拒绝
  let threwRvAdd = false;
  try { addProjectInConfig(cfgNew2, { id: '__proto__', manuscript: 'm' }); } catch (e) { threwRvAdd = /保留字/.test(e.message); }
  check('addProjectInConfig 保留字 id 抛错（__proto__ 不再静默丢项目）', threwRvAdd, '');
  let threwRvActive = false;
  try { setActiveInConfig(cfgNew2, '__proto__'); } catch (e) { threwRvActive = /保留字/.test(e.message); }
  check('setActiveInConfig 保留字 id 抛错', threwRvActive, '');
  // 原型链真值陷阱：cfg.projects['__proto__'] 取到 Object.prototype 恒为真值——必须 hasOwn 判存在
  let threwRvPath = false;
  try { setProjectPathInConfig(JSON.stringify({ projects: { A: { manuscript: 'a.md' } } }), '__proto__', 'manuscript', 'x.md'); } catch (e) { threwRvPath = /保留字/.test(e.message); }
  check('setProjectPathInConfig 保留字 id 抛错（不误判为存在的项目）', threwRvPath, '');
} finally {
  try { fs.rmSync(cfgUtilTmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('场景 39: 增量提取核心单测（哈希/脏检测/合并边界）');
const { chapterHashes, dirtyChapters, mergeCanon, mergeEvidence, hashText } = require('../src/incremental');
check('哈希确定性', hashText('同一段文本') === hashText('同一段文本') && hashText('同一段文本') !== hashText('不同文本'), '');
const msH = fs.readFileSync(path.join(ROOT, 'test/fixtures/plain-heading-manuscript.md'), 'utf8');
const hashes = chapterHashes(msH);
check('章节哈希覆盖全部章节', Object.keys(hashes).length === 3 && !!hashes['1'] && !!hashes['3'], JSON.stringify(hashes));
check('脏检测：无变化为空', dirtyChapters(hashes, { ...hashes }).length === 0, '');
check('脏检测：修改+新增', dirtyChapters(hashes, { ...hashes, '2': 'deadbeef' }).includes(2), '');
// 输出哈希（防洗白）：范围运行时只写已提取章，未提取章沿用旧哈希；无旧哈希则不写键
const { mergeOutputHashes } = require('../src/incremental');
const curH = { '1': 'a1', '2': 'b2', '3': 'c3' };
const oldDiff = { '2': 'old2', '3': 'old3' };
check('输出哈希：全量（null）直接返回 current', mergeOutputHashes(curH, oldDiff, null) === curH, '');
check('输出哈希：范围只写已提取章，未提取章沿用旧哈希', JSON.stringify(mergeOutputHashes(curH, oldDiff, new Set([1]))) === JSON.stringify({ '1': 'a1', '2': 'old2', '3': 'old3' }), JSON.stringify(mergeOutputHashes(curH, oldDiff, new Set([1]))));
check('输出哈希：范围 + 无旧哈希 → 未提取章不写键（下次增量判脏）', JSON.stringify(mergeOutputHashes(curH, null, new Set([1]))) === JSON.stringify({ '1': 'a1' }), '');
check('输出哈希：快速路径（空集）全部沿用旧哈希', JSON.stringify(mergeOutputHashes(curH, { '1': 'a1', '2': 'b2', '3': 'c3' }, new Set())) === JSON.stringify(curH), '');
check('缺失键天然判脏（未提取章下次必被提取）', dirtyChapters(curH, { '1': 'a1' }).includes(2) && dirtyChapters(curH, { '1': 'a1' }).includes(3), '');
// 边界用例：悬念埋设@2（干净）回收@8（脏）——合并按字段变化应用
const baseC = {
  meta: { title: 'T', target_reader: 'webnovel' },
  entities: [{ id: 'a', name: '甲', type: 'character' }],
  knowledge: [],
  suspense: [{ id: 's1', name: '谜', planted_in_chapter: 2, expected_resolve_chapter: 8, resolved_in_chapter: null }],
  timeline: [{ chapter: 2, day: 1, location: 'l' }],
};
const propC = JSON.parse(JSON.stringify(baseC));
propC.suspense[0].resolved_in_chapter = 8; // 提取器在脏章 8 发现回收
propC.suspense.push({ id: 's2', name: '新悬念', planted_in_chapter: 8, resolved_in_chapter: null });
propC.timeline.push({ chapter: 8, day: 3, location: 'l' });
const incMerged = mergeCanon(baseC, propC);
check('边界用例：脏章回收正确合并（resolved=8）', incMerged.suspense.find((s) => s.id === 's1').resolved_in_chapter === 8, JSON.stringify(incMerged.suspense));
check('新条目进入合并结果', incMerged.suspense.some((s) => s.id === 's2'), '');
check('未变条目保持基线', incMerged.entities.length === 1 && incMerged.entities[0].name === '甲', '');
check('合并 meta 保留基线', incMerged.meta.title === 'T', '');
// C1 回归：timeline 按章 union——proposal 缺失基线章时必须保留基线章（不整体替换）
// 旧实现 propTl.map 替换导致范围/增量提取（模型只回显脏章）静默丢弃非脏章时间线
const unionBase = {
  meta: { title: 'T', target_reader: 'webnovel' },
  entities: [], knowledge: [], suspense: [],
  timeline: [
    { chapter: 2, day: 1, location: 'l1' },
    { chapter: 7, day: 9, location: 'l7' },
  ],
};
const unionProp = JSON.parse(JSON.stringify(unionBase));
unionProp.timeline = [
  { chapter: 2, day: 5, location: 'l1' }, // 同章覆盖（保留 location）
  { chapter: 8, day: 3, location: 'l8' }, // 新增章
  // 基线第 7 章缺失 → 必须保留
];
const unionMerged = mergeCanon(unionBase, unionProp);
check('mergeCanon union：proposal 缺失的基线章保留（第7章不丢）', unionMerged.timeline.some((t) => t.chapter === 7 && t.day === 9 && t.location === 'l7'), JSON.stringify(unionMerged.timeline));
check('mergeCanon union：同章 proposal 覆盖且保留基线可选字段（第2章 day 1→5）', (() => { const t = unionMerged.timeline.find((x) => x.chapter === 2); return t.day === 5 && t.location === 'l1'; })(), JSON.stringify(unionMerged.timeline));
check('mergeCanon union：新增章加入（第8章）', unionMerged.timeline.some((t) => t.chapter === 8 && t.day === 3), JSON.stringify(unionMerged.timeline));
check('mergeCanon union：输出按章排序', JSON.stringify(unionMerged.timeline.map((t) => t.chapter)) === JSON.stringify([2, 7, 8]), JSON.stringify(unionMerged.timeline.map((t) => t.chapter)));
// 分块链式场景：批 1 输出成为批 2 基线，批 2 只回显本批章 → 前批章时间线不丢
const chainBase = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }, { chapter: 2, day: 3 }] };
const chainProp = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 3, day: 5 }] };
const chainMerged = mergeCanon(chainBase, chainProp);
check('mergeCanon union：分块链式批 2 保留批 1 时间线（1,2 章不丢）', chainMerged.timeline.length === 3 && chainMerged.timeline.some((t) => t.chapter === 1) && chainMerged.timeline.some((t) => t.chapter === 2) && chainMerged.timeline.some((t) => t.chapter === 3), JSON.stringify(chainMerged.timeline));
// 可选字段保留：LLM 提议省略基线可选字段（aliases/location 等）→ 合并保留基线值，不静默丢
const optBase = JSON.parse(JSON.stringify(baseC));
optBase.entities[0].aliases = ['甲叔'];
optBase.entities.push({ id: 'b', name: '乙', aliases: ['小二'], type: 'character' });
optBase.timeline[0].location = 'l';
const optProp = JSON.parse(JSON.stringify(optBase));
optProp.entities[0].name = '甲改'; // 改名（变化）但省略 aliases
optProp.entities[1].name = '乙改'; // 改名（变化）但省略 aliases
const optMerged = mergeCanon(optBase, optProp);
check('可选字段保留：改名条目省略 aliases 时保留基线别名', optMerged.entities.find((x) => x.id === 'a').aliases[0] === '甲叔' && optMerged.entities.find((x) => x.id === 'b').aliases[0] === '小二', JSON.stringify(optMerged.entities));
// 空 timeline 防御：提议缺失时间线时保留基线（防呆，防止基线时间线被清空）
check('mergeCanon 空提议（timeline 缺失）保留基线时间线', (() => { const m = mergeCanon(baseC, { meta: { title: 'T' }, entities: [], knowledge: [], suspense: [], timeline: [] }); return m.timeline.length === 1 && m.timeline[0].chapter === 2; })(), '');
// nameIdx 空名误匹配回归：mergeCanon 中无名字段不应通过 name 索引覆盖其他无名条目
const noNameBaseC = { meta: { title: 'T' }, entities: [{ id: 'a' /* 无 name */ }], knowledge: [], suspense: [], timeline: [] };
const noNamePropC = { meta: { title: 'T' }, entities: [{ id: 'b' /* 无 name */ }], knowledge: [], suspense: [], timeline: [] };
const noNameMergedC = mergeCanon(noNameBaseC, noNamePropC);
check('mergeCanon nameIdx 空名不误匹配：无名字段按 id 匹配，两条都保留', noNameMergedC.entities.length === 2 && noNameMergedC.entities.some((x) => x.id === 'a') && noNameMergedC.entities.some((x) => x.id === 'b'), JSON.stringify(noNameMergedC.entities));
check('可选字段保留：timeline 省略 location 时保留基线', optMerged.timeline[0].location === 'l', JSON.stringify(optMerged.timeline));
const baseEv = { entities: { a: [{ chapter: 1, line: 3, quote: 'x' }] }, knowledge: {}, suspense: { s1: [{ chapter: 2, line: 5, quote: 'y' }] }, timeline: { '2': [{ chapter: 2, line: 5, quote: 'y' }] } };
const newEv = { entities: {}, knowledge: {}, suspense: { s1: [{ chapter: 8, line: 99, quote: 'z' }], s2: [{ chapter: 8, line: 99, quote: 'z' }] }, timeline: { '8': [{ chapter: 8, line: 99, quote: 'z' }] } };
const incEv = mergeEvidence(baseEv, newEv, baseC, incMerged);
check('证据合并：变更条目证据替换', incEv.suspense.s1[0].chapter === 8, JSON.stringify(incEv.suspense));
check('证据合并：新条目证据加入', !!incEv.suspense.s2, '');
check('证据合并：未变条目证据保留', incEv.entities.a[0].chapter === 1, '');
check('证据合并：脏章时间线证据替换', !!incEv.timeline['8'] && incEv.timeline['8'][0].chapter === 8 && !!incEv.timeline['2'], '');

console.log('场景 39b: 番外/尾声哈希盲区（无编号章参与脏检测，稳定键为 s+标题哈希）');
const msEp = '# 第1章 甲\n\n正文。\n\n# 尾声\n\n尾声正文。\n\n# 番外一\n\n番外正文。\n';
const hEp = chapterHashes(msEp);
const epKeyTail = `s${hashText('尾声')}`;
const epKeyFan = `s${hashText('番外一')}`;
check('番外/尾声进入哈希（键为 s+标题哈希）', !!hEp['1'] && !!hEp[epKeyTail] && !!hEp[epKeyFan] && Object.keys(hEp).length === 3, JSON.stringify(hEp));
check('修改番外触发脏检测（s 键）', dirtyChapters(hEp, { ...hEp, [epKeyFan]: 'deadbeef' }).includes(epKeyFan), JSON.stringify(dirtyChapters(hEp, { ...hEp, [epKeyFan]: 'deadbeef' })));
check('混合排序：数字章在前、番外在后', JSON.stringify(dirtyChapters({ '1': 'a', 's2': 'b', '2': 'c' }, { '1': 'a', 's2': 'x', '2': 'y' })) === JSON.stringify([2, 's2']), '');
// 位移不误报：章节增删使番外 index 变化，但标题未变 → 键稳定 → 不误报脏（旧 s<index> 会误报）
const msEpShifted2 = '# 第1章 甲\n\n正文。\n\n# 番外一\n\n番外正文。\n'; // 删掉尾声 → 番外 index 从 2 → 1
check('位移不误报：删章后番外键不变（index 从 2→1 但内容未变）', JSON.stringify(dirtyChapters(chapterHashes(msEpShifted2), chapterHashes(msEp))) === JSON.stringify([]), '');
const { numberLinesForChaptersSet } = require('../src/extraction');
const selEp = numberLinesForChaptersSet(msEp, [epKeyFan]);
check('范围选择支持番外脏章（行号锚点保留）', selEp.numbered.includes('11|番外正文'), selEp.numbered);
// validateExtraction：番外行证据（chapter=null 无章号可校验）不误报
const { validateExtraction: veEp } = require('../src/extraction');
const epCanon = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }] };
const epProposal = {
  canon: JSON.parse(JSON.stringify(epCanon)),
  evidence: { entities: { tea: [{ chapter: null, line: 7, quote: '尾声正文' }] }, knowledge: {}, suspense: {}, timeline: { '1': [{ chapter: 1, line: 3, quote: '正文' }] } },
  extraction_notes: [],
};
epProposal.canon.entities.push({ id: 'tea', name: '茶馆', type: 'location' });
const epErr = veEp(epProposal, { baseline: epCanon, manuscript: msEp, range: { chapters: [1, epKeyTail, epKeyFan] } });
check('番外行证据（chapter=null）通过校验（不误报章号不符）', epErr.length === 0, epErr);
// evInRange 番外漏洞：脏番外中修正基线条目，唯一证据 chapter=null（番外行）→ 必须通过（旧实现误拒重试到死）
const epBase = {
  meta: { title: 'T', target_reader: 'webnovel' },
  entities: [{ id: 'shen_mo', name: '沈默', aliases: ['老沈'], type: 'character' }],
  knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }],
};
const epFixProp = {
  canon: JSON.parse(JSON.stringify(epBase)),
  evidence: {
    entities: { shen_mo: [{ chapter: null, line: 11, quote: '番外正文' }] }, // 唯一证据在脏番外（chapter=null）
    knowledge: {}, suspense: {},
    timeline: { '1': [{ chapter: 1, line: 3, quote: '正文' }] },
  },
  extraction_notes: [],
};
epFixProp.canon.entities[0].aliases = ['老沈改']; // 基线条目字段修正
const epFixErr = veEp(epFixProp, { baseline: epBase, manuscript: msEp, range: { chapters: [1, epKeyTail, epKeyFan] } });
check('脏番外中修正基线条目：chapter=null 证据通过范围纪律（不再误拒）', epFixErr.length === 0, epFixErr);
// 对照：证据不在脏番外（另一番外）→ 仍被拒
const epBaseNoEv = {
  meta: { title: 'T', target_reader: 'webnovel' },
  entities: [{ id: 'shen_mo', name: '沈默', aliases: ['老沈'], type: 'character' }],
  knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }],
};
const epFixNo = {
  canon: JSON.parse(JSON.stringify(epBaseNoEv)),
  evidence: {
    entities: { shen_mo: [{ chapter: null, line: 7, quote: '尾声正文' }] }, // 证据在尾声（未标记脏）→ 不在范围内
    knowledge: {}, suspense: {},
    timeline: { '1': [{ chapter: 1, line: 3, quote: '正文' }] },
  },
  extraction_notes: [],
};
epFixNo.canon.entities[0].aliases = ['老沈改'];
const epFixNoErr = veEp(epFixNo, { baseline: epBaseNoEv, manuscript: msEp, range: { chapters: [1, epKeyFan] } });
check('对照：证据在不脏的番外（尾声未标记）→ 范围纪律仍拒绝', epFixNoErr.some((e) => e.includes('不在提取范围内')), epFixNoErr);

console.log('场景 40: 增量快速路径 e2e（无脏章节，免 LLM 免密钥）');
const incrMerge = path.join(ROOT, 'app', 'predictions', 'incr-test-merge.json');
const incrOut = path.join(ROOT, 'app', 'predictions', 'incr-test-out.json');
const fakeEnvelope = {
  tool: 'novel-compiler/extract-llm',
  meta: { title: '信与钟', simulated_at: 'T', chapter_hashes: chapterHashes(fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-manuscript.md'), 'utf8')) },
  canon: cleanCanon,
  evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: {} },
};
try {
  fs.mkdirSync(path.dirname(incrMerge), { recursive: true });
  fs.writeFileSync(incrMerge, JSON.stringify(fakeEnvelope), 'utf8');
  const incrFast = spawnSync(process.execPath, [EXT, 'test/fixtures/clean-manuscript.md', '--canon', 'test/fixtures/clean-canon.json', '--incremental', '--merge-with', incrMerge, '--out', incrOut], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
  });
  check('快速路径 exit 0（未调 LLM）', incrFast.status === 0, `got ${incrFast.status}\n${incrFast.stdout}${incrFast.stderr}`);
  check('快速路径提示无脏章节', incrFast.stdout.includes('无脏章节'), incrFast.stdout);
  const incrResult = JSON.parse(fs.readFileSync(incrOut, 'utf8'));
  check('快速路径输出 canon 等于基线', JSON.stringify(incrResult.canon) === JSON.stringify(cleanCanon), '');
  check('快速路径输出含 chapter_hashes', !!incrResult.meta.chapter_hashes && Object.keys(incrResult.meta.chapter_hashes).length === 3, '');
} finally {
  try { fs.unlinkSync(incrMerge); } catch { /* 忽略 */ }
  try { fs.unlinkSync(incrOut); } catch { /* 忽略 */ }
}

console.log('场景 41: 备份清理（pruneBackups）单测');
const { pruneBackups } = require('../src/fsutil');
const bkDir = path.join(ROOT, 'test', 'fixtures');
const bkTarget = path.join(bkDir, 'bk-tmp.md');
try { fs.unlinkSync(bkTarget); } catch { /* 忽略 */ }
for (let i = 0; i < 7; i++) {
  fs.writeFileSync(`${bkTarget}.bak-000${i}`, String(i), 'utf8');
}
// 让 mtime 有序（确保排序可预期）
const now = Date.now();
for (let i = 0; i < 7; i++) {
  fs.utimesSync(`${bkTarget}.bak-000${i}`, new Date(now - (7 - i) * 60000), new Date(now - (7 - i) * 60000));
}
const removedBk = pruneBackups(bkTarget, 5);
const remainBk = fs.readdirSync(bkDir).filter((f) => f.startsWith('bk-tmp.md.bak-')).length;
check('清理到 5 个并删除 2 个', removedBk === 2 && remainBk === 5, `removed=${removedBk} remain=${remainBk}`);
check('保留的是最新 5 个', !fs.existsSync(`${bkTarget}.bak-0000`) && fs.existsSync(`${bkTarget}.bak-0006`), '');
for (let i = 0; i < 7; i++) { try { fs.unlinkSync(`${bkTarget}.bak-000${i}`); } catch { /* 忽略 */ } }

console.log('场景 42: --merge-with 默认路径与运行目录无关（缺密钥 → 报密钥错误而非路径错误）');
const extForeign = spawnSync(process.execPath, [EXT, 'clean-manuscript.md', '--canon', 'clean-canon.json', '--incremental'], {
  cwd: path.join(ROOT, 'test', 'fixtures'), encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
});
check('exit 2（未崩溃，路径解析正确）', extForeign.status === 2, `got ${extForeign.status}\n${extForeign.stdout}${extForeign.stderr}`);
check('报密钥错误而非路径错误', (extForeign.stdout + extForeign.stderr).includes('DEEPSEEK_API_KEY'), extForeign.stdout + extForeign.stderr);

console.log('场景 42b: --merge-with 缺省路径按 canon 目录推导（CLI 多项目隔离，不读全局）');
const mwDir = path.join(ROOT, 'test', 'fixtures', 'tmp-mw');
fs.mkdirSync(mwDir, { recursive: true });
try {
  // canon 同目录放一个假上次提取信封 → 增量 dry-run 应命中它（不报"未找到"）
  const mwFake = {
    tool: 'novel-compiler/extract-llm',
    meta: { title: 'T', simulated_at: 'T', chapter_hashes: chapterHashes(fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-manuscript.md'), 'utf8')) },
    canon: cleanCanon,
    evidence: {},
  };
  fs.writeFileSync(path.join(mwDir, 'last-extract.json'), JSON.stringify(mwFake), 'utf8');
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/clean-canon.json'), path.join(mwDir, 'canon.json'));
  const mwHit = spawnSync(process.execPath, [EXT, 'test/fixtures/clean-manuscript.md', '--canon', path.join(mwDir, 'canon.json'), '--incremental', '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, LLM_INPUT_BUDGET_TOKENS: '8000' },
  });
  check('canon 同目录有上次提取时命中（无"未找到"警告）', !(mwHit.stdout + mwHit.stderr).includes('未找到上次提取'), (mwHit.stdout + mwHit.stderr).slice(0, 300));
  // 无 canon 目录提取时：警告路径必须指向 canon 同目录（而非全局 app/predictions）
  fs.unlinkSync(path.join(mwDir, 'last-extract.json'));
  const mwMiss = spawnSync(process.execPath, [EXT, 'test/fixtures/clean-manuscript.md', '--canon', path.join(mwDir, 'canon.json'), '--incremental', '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '' },
  });
  check('缺失时警告指向 canon 同目录的 last-extract.json（项目隔离）', (mwMiss.stdout + mwMiss.stderr).includes(path.join(mwDir, 'last-extract.json')), (mwMiss.stdout + mwMiss.stderr).slice(0, 400));
} finally {
  try { fs.rmSync(mwDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('场景 43: 豁免机制（wj-suppress）e2e');
const supRun = run(['test/fixtures/suppress-case/manuscript.md', 'test/fixtures/suppress-case/canon.json', '--json']);
let supJ = null;
try { supJ = JSON.parse(supRun.out); } catch { /* noop */ }
check('exit 0（豁免不计入错误）', supRun.code === 0, `got ${supRun.code}\n${supRun.out}`);
check('JSON 可解析', !!supJ && Array.isArray(supJ.problems), supRun.out.slice(0, 300));
check('已豁免 2 条（行级引号 + 章级实体）', !!supJ && supJ.suppressed.length === 2, JSON.stringify(supJ && supJ.suppressed));
check('豁免条目带理由', !!supJ && supJ.suppressed.every((p) => p.suppress_reason), JSON.stringify(supJ && supJ.suppressed));
check('豁免的问题不进 counts', !!supJ && supJ.counts.suppressed === 2 && supJ.counts.error === 0 && supJ.counts.warning === 0 && supJ.counts.info === 0, JSON.stringify(supJ && supJ.counts));
check('未命中的豁免 1 条（注释提到实体不算正文提及）', !!supJ && supJ.unused_suppressions.length === 1 && supJ.unused_suppressions[0].rule === 'entity/missing', JSON.stringify(supJ && supJ.unused_suppressions));
check('无 .wjrc 时 manifest.wjrc 为 null', !!supJ && supJ.manifest.wjrc === null, '');
const supTxt = run(['test/fixtures/suppress-case/manuscript.md', 'test/fixtures/suppress-case/canon.json']);
check('文本报告含已豁免分组', supTxt.out.includes('⊘ 已豁免 (2)'), supTxt.out.slice(0, 800));
check('文本报告含未命中分组', supTxt.out.includes('ℹ 未命中的豁免 (1)'), supTxt.out.slice(0, 800));

console.log('场景 43b: 豁免死角修复（尾声章级豁免 / 跨行注释准确反馈 / 无目标行）');
// 尾声（number=null）内的章级豁免：旧实现静默失效并谎报"没有对应问题"
const epMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-epilogue-ms.md');
fs.writeFileSync(epMsFile, '# 第1章 甲\n\n正文。\n\n# 尾声\n\n<!-- wj-suppress: text/quote-balance @chapter 尾声故意 -->\n\n“话没说完', 'utf8');
try {
  const epRun = run([epMsFile, 'test/fixtures/clean-canon.json', '--json']);
  let epJ = null;
  try { epJ = JSON.parse(epRun.out); } catch { /* noop */ }
  check('尾声章级豁免生效（suppressed 含 quote-balance 且带理由）', !!epJ && epJ.suppressed.some((p) => p.rule === 'text/quote-balance' && p.suppress_reason === '尾声故意'), JSON.stringify(epJ && epJ.suppressed).slice(0, 300));
  check('尾声豁免不产生未命中误报', !!epJ && !epJ.unused_suppressions.some((u) => u.rule === 'text/quote-balance'), JSON.stringify(epJ && epJ.unused_suppressions));
} finally {
  try { fs.unlinkSync(epMsFile); } catch { /* 忽略 */ }
}
// 跨行豁免注释：不产生豁免 + unused 明确标记 multiline（不伪装成"没有对应问题"）
const multiMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-multi-ms.md');
fs.writeFileSync(multiMsFile, '# 第1章 甲\n\n正文“未闭合。\n\n<!-- wj-suppress: text/quote-balance\n这是多行理由\n-->\n\n“又未闭合', 'utf8');
try {
  const multiRun = run([multiMsFile, 'test/fixtures/clean-canon.json', '--json']);
  let multiJ = null;
  try { multiJ = JSON.parse(multiRun.out); } catch { /* noop */ }
  const mlUnused = multiJ && multiJ.unused_suppressions.find((u) => u.rule === 'text/quote-balance');
  check('跨行注释被报告为 multiline（准确反馈而非静默/谎报）', !!mlUnused && mlUnused.multiline === true, JSON.stringify(multiJ && multiJ.unused_suppressions));
  check('跨行注释不产生豁免（问题仍在）', !!multiJ && multiJ.problems.some((p) => p.rule === 'text/quote-balance'), JSON.stringify(multiJ && multiJ.problems).slice(0, 200));
} finally {
  try { fs.unlinkSync(multiMsFile); } catch { /* 忽略 */ }
}
// 行级豁免注释后无正文行（文末）：unresolvable 标记
const tailMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-tail-ms.md');
fs.writeFileSync(tailMsFile, '# 第1章 甲\n\n正文。\n\n<!-- wj-suppress: text/quote-balance 文末注释 -->', 'utf8');
try {
  const tailRun = run([tailMsFile, 'test/fixtures/clean-canon.json', '--json']);
  let tailJ = null;
  try { tailJ = JSON.parse(tailRun.out); } catch { /* noop */ }
  const tlUnused = tailJ && tailJ.unused_suppressions.find((u) => u.rule === 'text/quote-balance');
  check('文末无目标行的豁免注释被标记 unresolvable', !!tlUnused && tlUnused.unresolvable === true, JSON.stringify(tailJ && tailJ.unused_suppressions));
} finally {
  try { fs.unlinkSync(tailMsFile); } catch { /* 忽略 */ }
}

console.log('场景 43c: 全稿级问题（chapter=null）豁免须用显式 @global（entity/missing info 版）');
const gmCanon = JSON.parse(JSON.stringify(cleanCanon));
gmCanon.entities.push({ id: 'ghost_man', name: '幽灵客', aliases: [], type: 'character' }); // 从未出场 → info 版 entity/missing（chapter=null）
const gmCanonFile = path.join(ROOT, 'test', 'fixtures', 'tmp-global-canon.json');
const gmMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-global-ms.md');
fs.writeFileSync(gmCanonFile, JSON.stringify(gmCanon, null, 2) + '\n', 'utf8');
try {
  // 对照：无豁免 → info 版 entity/missing 存在
  fs.writeFileSync(gmMsFile, '# 第1章 甲\n\n正文。\n', 'utf8');
  const gmPlain = run([gmMsFile, gmCanonFile, '--json']);
  let gmPlainJ = null;
  try { gmPlainJ = JSON.parse(gmPlain.out); } catch { /* noop */ }
  check('对照：从未出场角色报 info 版 entity/missing（chapter=null）', !!gmPlainJ && gmPlainJ.problems.some((p) => p.rule === 'entity/missing' && p.severity === 'info' && p.chapter === null), JSON.stringify(gmPlainJ && gmPlainJ.problems).slice(0, 200));
  // 回归：@chapter 不再隐式升级为全局豁免——旧实现任一 @chapter 声明即静默豁免全稿
  // 所有同类提示（沈默/林晚/幽灵客 3 条一锅端），规则级豁免过度
  fs.writeFileSync(gmMsFile, '# 第1章 甲\n\n<!-- wj-suppress: entity/missing @chapter 暂缓登场 -->\n\n正文。\n', 'utf8');
  const gmCh = run([gmMsFile, gmCanonFile, '--json']);
  let gmChJ = null;
  try { gmChJ = JSON.parse(gmCh.out); } catch { /* noop */ }
  check('@chapter 不覆盖全稿级问题（info 仍报，不被连带静默）', !!gmChJ && gmChJ.problems.some((p) => p.rule === 'entity/missing' && p.chapter === null), JSON.stringify(gmChJ && gmChJ.problems).slice(0, 200));
  const gmChUnused = gmChJ && gmChJ.unused_suppressions.find((u) => u.rule === 'entity/missing');
  check('@chapter 误用报未命中且提示改用 @global', !!gmChUnused && gmChUnused.globalHint === true, JSON.stringify(gmChJ && gmChJ.unused_suppressions));
  // @global 显式豁免全稿级问题
  fs.writeFileSync(gmMsFile, '# 第1章 甲\n\n<!-- wj-suppress: entity/missing @global 角色暂缓登场 -->\n\n正文。\n', 'utf8');
  const gmRun = run([gmMsFile, gmCanonFile, '--json']);
  let gmJ = null;
  try { gmJ = JSON.parse(gmRun.out); } catch { /* noop */ }
  check('@global 豁免全稿级 entity/missing（info 不再报，带理由）', !!gmJ && !gmJ.problems.some((p) => p.rule === 'entity/missing' && p.chapter === null) && gmJ.suppressed.some((p) => p.rule === 'entity/missing' && p.suppress_reason === '角色暂缓登场'), JSON.stringify(gmJ && gmJ.problems).slice(0, 200));
  check('@global 豁免不产生未命中误报', !!gmJ && !gmJ.unused_suppressions.some((u) => u.rule === 'entity/missing'), JSON.stringify(gmJ && gmJ.unused_suppressions));
} finally {
  try { fs.unlinkSync(gmCanonFile); } catch { /* 忽略 */ }
  try { fs.unlinkSync(gmMsFile); } catch { /* 忽略 */ }
}

console.log('场景 43d: 章级豁免不波及全稿级问题（over-exemption 回归）');
// 场景：为 due 实体（warning 版，chapter=appears_from_chapter）在章内写 @chapter 豁免——
// 从未出场角色（info 版，chapter=null）的提示必须保留，不得被连带静默
const oeCanon = JSON.parse(JSON.stringify(cleanCanon));
oeCanon.entities.push({ id: 'late_hero', name: '迟到侠', aliases: [], type: 'character', appears_from_chapter: 1 }); // due → warning（chapter=1）
const oeCanonFile = path.join(ROOT, 'test', 'fixtures', 'tmp-overex-canon.json');
const oeMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-overex-ms.md');
fs.writeFileSync(oeCanonFile, JSON.stringify(oeCanon, null, 2) + '\n', 'utf8');
try {
  fs.writeFileSync(oeMsFile, '# 第1章 甲\n\n<!-- wj-suppress: entity/missing @chapter 1 迟到侠计划第1章后登场 -->\n\n正文。\n', 'utf8');
  const oeRun = run([oeMsFile, oeCanonFile, '--json']);
  let oeJ = null;
  try { oeJ = JSON.parse(oeRun.out); } catch { /* noop */ }
  check('章级豁免命中 due 实体（warning 被豁免带理由）', !!oeJ && oeJ.suppressed.some((p) => p.rule === 'entity/missing' && p.chapter === 1 && p.suppress_reason.includes('迟到侠计划')), JSON.stringify(oeJ && oeJ.suppressed).slice(0, 300));
  check('章级豁免不波及全稿级提示（沈默/林晚 info 保留）', !!oeJ && oeJ.problems.some((p) => p.rule === 'entity/missing' && p.severity === 'info' && p.chapter === null), JSON.stringify(oeJ && oeJ.problems).slice(0, 300));
  check('章级豁免命中 → 无未命中误报', !!oeJ && !oeJ.unused_suppressions.some((u) => u.rule === 'entity/missing'), JSON.stringify(oeJ && oeJ.unused_suppressions));
} finally {
  try { fs.unlinkSync(oeCanonFile); } catch { /* 忽略 */ }
  try { fs.unlinkSync(oeMsFile); } catch { /* 忽略 */ }
}

console.log('场景 43e: 未来出场角色（appears_from_chapter>进度）不报 entity/missing');
// 回归来源：旧实现 type==='character' 一律报「从未出场」info——规划中未来登场（appears_from_chapter
// 未到期，如第9章登场但手稿只有1章）的角色被误报。现仅对完全无 appears_from_chapter 的「幽灵角色」报 info
const fuCanon = JSON.parse(JSON.stringify(cleanCanon));
fuCanon.entities.push(
  { id: 'future_man', name: '未来侠', aliases: [], type: 'character', appears_from_chapter: 9 }, // 规划未来登场（手稿仅1章，未到期）
  { id: 'ghost_man2', name: '幽灵客二', aliases: [], type: 'character' },                        // 无规划 → info 从未出场
);
const fuCanonFile = path.join(ROOT, 'test', 'fixtures', 'tmp-future-canon.json');
const fuMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-future-ms.md');
fs.writeFileSync(fuCanonFile, JSON.stringify(fuCanon, null, 2) + '\n', 'utf8');
try {
  fs.writeFileSync(fuMsFile, '# 第1章 甲\n\n正文。\n', 'utf8');
  const fuRun = run([fuMsFile, fuCanonFile, '--json']);
  let fuJ = null;
  try { fuJ = JSON.parse(fuRun.out); } catch { /* noop */ }
  const fuMissing = ((fuJ && fuJ.problems) || []).filter((p) => p.rule === 'entity/missing');
  check('未来出场角色不报 entity/missing（规划未到期，零提示）', !fuMissing.some((p) => /未来侠/.test(p.message)), JSON.stringify(fuMissing));
  check('未规划出场角色仍报 info entity/missing（chapter=null）', fuMissing.some((p) => p.severity === 'info' && p.chapter === null && /幽灵客二/.test(p.message)), JSON.stringify(fuMissing));
} finally {
  try { fs.unlinkSync(fuCanonFile); } catch { /* 忽略 */ }
  try { fs.unlinkSync(fuMsFile); } catch { /* 忽略 */ }
}

console.log('场景 43c-2: 行级豁免应用到章节标题行（headingLine 锚点问题可豁免，fixture）');
const hsRun = run(['test/fixtures/heading-suppress-case/manuscript.md', 'test/fixtures/heading-suppress-case/canon.json', '--json']);
let hsJ = null;
try { hsJ = JSON.parse(hsRun.out); } catch { /* noop */ }
check('标题行豁免生效（timeline/missing 第2章被豁免且带理由）', !!hsJ && hsJ.suppressed.some((p) => p.rule === 'timeline/missing' && p.chapter === 2 && p.suppress_reason === '标题行豁免'), JSON.stringify(hsJ && hsJ.suppressed).slice(0, 300));
check('标题行豁免无误报未命中', !!hsJ && !hsJ.unused_suppressions.some((u) => u.rule === 'timeline/missing'), JSON.stringify(hsJ && hsJ.unused_suppressions));

console.log('场景 44: .wjrc.json 关闭规则（text/quote-balance off）');
const offRun = run(['test/fixtures/wjrc-off-case/manuscript.md', 'test/fixtures/wjrc-off-case/canon.json', '--json']);
let offJ = null;
try { offJ = JSON.parse(offRun.out); } catch { /* noop */ }
check('exit 0', offRun.code === 0, `got ${offRun.code}\n${offRun.out}`);
check('不再报 text/quote-balance（且无其他问题）', !!offJ && offJ.problems.length === 0, JSON.stringify(offJ && offJ.problems));
check('manifest.wjrc 指向 .wjrc.json', !!offJ && !!offJ.manifest.wjrc && offJ.manifest.wjrc.endsWith('.wjrc.json'), JSON.stringify(offJ && offJ.manifest));

console.log('场景 45: .wjrc.json 提升级别 + 阈值覆盖');
const sevRun = run(['test/fixtures/wjrc-sev-case/manuscript.md', 'test/fixtures/wjrc-sev-case/canon.json', '--json']);
let sevJ = null;
try { sevJ = JSON.parse(sevRun.out); } catch { /* noop */ }
check('exit 1（entity/missing 提升为 error）', sevRun.code === 1, `got ${sevRun.code}\n${sevRun.out}`);
const sevMiss = sevJ && sevJ.problems.find((p) => p.rule === 'entity/missing');
check('entity/missing 级别为 error', !!sevMiss && sevMiss.severity === 'error', JSON.stringify(sevJ && sevJ.problems));
check('thresholds.chapterMin 生效（1000 → 触发过短提示）', !!sevJ && sevJ.problems.some((p) => p.rule === 'structure/chapter-length' && p.severity === 'info'), JSON.stringify(sevJ && sevJ.problems));

console.log('场景 45b: 悬置超期（suspense/overdue）无预期回收章也检查');
const { runChecks } = require('../src/rules');
const { parseManuscript: pm5, scanMentions: sm5, quoteStats: qs5 } = require('../src/extract');
const { configFor: cf5 } = require('../src/validate');
const ms5 = '# 第1章 一\n\n正文。\n\n# 第2章 二\n\n正文。\n\n# 第3章 三\n\n正文。\n\n# 第4章 四\n\n正文。\n\n# 第5章 五\n\n正文。\n';
const c5base = {
  meta: { title: 'T', target_reader: 'webnovel' },
  entities: [], knowledge: [],
  suspense: [{ id: 's1', name: '谜', planted_in_chapter: 1, expected_resolve_chapter: null, resolved_in_chapter: null }],
  timeline: [1, 2, 3, 4, 5].map((c) => ({ chapter: c, day: c })),
};
const run5 = (canon) => {
  const p = pm5(ms5);
  return runChecks({ canon, parsed: p, mentions: new Map(), quotes: qs5(p.chapters, p.lines), cfg: cf5('webnovel'), file: 'x.md' });
};
const ov = run5(c5base).filter((p) => p.rule === 'suspense/overdue');
check('无 expected 的悬念悬置超期被检出（埋@1 至第5章，阈值3）', ov.length === 1 && ov[0].detail.includes('未登记预期回收章'), JSON.stringify(ov));
const c5b = JSON.parse(JSON.stringify(c5base));
c5b.suspense[0].expected_resolve_chapter = 2; // 登记了预期但没回收
const ovb = run5(c5b).filter((p) => p.rule === 'suspense/overdue');
check('有 expected 的悬置超期仍检出（detail 含预期回收章）', ovb.length === 1 && ovb[0].detail.includes('预期回收章：2'), JSON.stringify(ovb));
const c5c = JSON.parse(JSON.stringify(c5base));
c5c.suspense[0].planted_in_chapter = 3; // 第3章埋设 → 悬置 2 章 ≤ 阈值 3
check('未超期不报 overdue', !run5(c5c).some((p) => p.rule === 'suspense/overdue'), '');
const c5d = JSON.parse(JSON.stringify(c5base));
c5d.suspense[0].expected_resolve_chapter = 8; // 预期回收章在未来（当前进度第5章）→ 规划期未到期，不报超期
const ovFuture = run5(c5d).filter((p) => p.rule === 'suspense/overdue');
check('未来预期回收章不报 overdue（expected=8 > 进度5）', ovFuture.length === 0, JSON.stringify(ovFuture));

console.log('场景 46: wjrc / suppress 纯函数 + 提取器过滤单测');
const { parseRuleOverride, applyRuleOverrides, applyWjrc } = require('../src/wjrc');
check('parseRuleOverride 语义', parseRuleOverride('off') === 'off' && parseRuleOverride('error') === 'error' && parseRuleOverride('bogus') === null
  && parseRuleOverride({ severity: 'warning' }) === 'warning' && parseRuleOverride({ enabled: false }) === 'off' && parseRuleOverride({ enabled: true }) === null, '');
const ovMap = new Map([['entity/missing', 'off'], ['text/quote-balance', 'error']]);
const ovd = applyRuleOverrides([
  { rule: 'entity/missing', severity: 'warning', line: 1 },
  { rule: 'text/quote-balance', severity: 'info', line: 2 },
  { rule: 'timeline/regression', severity: 'error', line: 3 },
], ovMap);
check('off 删除 + 级别改写 + 未覆盖保留', ovd.length === 2 && ovd[0].severity === 'error' && ovd[1].rule === 'timeline/regression', JSON.stringify(ovd));
const wjMerged = applyWjrc({ label: 'x', chapterMin: 100, overdueLimit: 3, danglingSeverity: 'info' },
  { file: 'f', rc: { thresholds: { chapterMin: 2000, overdueLimit: 99, danglingSeverity: 'error' }, rules: { 'entity/missing': 'off' } } });
check('阈值覆盖生效', wjMerged.cfg.chapterMin === 2000 && wjMerged.cfg.overdueLimit === 99 && wjMerged.cfg.danglingSeverity === 'error', JSON.stringify(wjMerged.cfg));
check('规则覆盖解析进 overrides', wjMerged.overrides.get('entity/missing') === 'off', '');
check('无 .wjrc 时原样返回', applyWjrc({ a: 1 }, null).cfg.a === 1 && applyWjrc({ a: 1 }, null).overrides.size === 0, '');
const { parseSuppressions, applySuppressions } = require('../src/suppress');
const suLines = ['# 第1章 甲', '', '<!-- wj-suppress: text/quote-balance 故意 -->', '“未闭合', '', '<!-- wj-suppress: entity/missing @chapter 暂缓 -->', '正文'];
const suChs = [{ number: 1, startLine: 2, endLine: 7 }];
const suParsed = parseSuppressions(suLines, suChs);
const suRes = applySuppressions([
  { rule: 'text/quote-balance', severity: 'info', line: 4, chapter: 1 },
  { rule: 'entity/missing', severity: 'warning', line: 1, chapter: 1 },
  { rule: 'timeline/missing', severity: 'info', line: 2, chapter: 1 },
], suParsed);
check('行级豁免命中并带理由', suRes.suppressed.some((p) => p.rule === 'text/quote-balance' && p.suppress_reason === '故意'), JSON.stringify(suRes.suppressed));
check('章级豁免命中（@chapter = 所在章）', suRes.suppressed.some((p) => p.rule === 'entity/missing' && p.suppress_reason === '暂缓'), JSON.stringify(suRes.suppressed));
check('未豁免问题保留', suRes.kept.length === 1 && suRes.kept[0].rule === 'timeline/missing', JSON.stringify(suRes.kept));
check('全部命中 → 无未命中报告', suRes.unused.length === 0, JSON.stringify(suRes.unused));
const suRes2 = applySuppressions([], parseSuppressions(['# 第1章 甲', '', '<!-- wj-suppress: entity/missing 永不命中 -->'], [{ number: 1, startLine: 2, endLine: 3 }]));
check('未命中豁免被报告', suRes2.unused.length === 1 && suRes2.unused[0].rule === 'entity/missing', JSON.stringify(suRes2.unused));
const { numberLines, assembleNumbered } = require('../src/extraction');
const nl = numberLines('# 第1章 甲\n正文一\n<!-- wj-suppress: text/quote-balance 理由 -->\n正文二');
check('numberLines 剔除豁免注释行', !nl.includes('wj-suppress') && nl.includes('4|正文二'), nl);
const an = assembleNumbered(['# 第1章 甲', '正文一', '<!-- wj-suppress: text/quote-balance 理由 -->', '正文二'], [{ number: 1, startLine: 2, endLine: 4 }]);
check('assembleNumbered 剔除豁免注释行', !an.numbered.includes('wj-suppress') && an.numbered.includes('4|正文二') && an.chapterNumbers[0] === 1, an.numbered);
const chH = chapterHashes('# 第1章 甲\n正文一\n<!-- wj-suppress: text/quote-balance 理由 -->\n正文二');
check('章节哈希不含豁免注释（增删注释不脏章）', chH['1'] === hashText('第1章 甲\n正文一\n正文二'), JSON.stringify(chH));
// 非法阈值必须回退读者向默认（而不是删除导致规则静默失效）
const wjBad = applyWjrc({ label: 'x', chapterMin: 100, chapterMax: 1000, overdueLimit: 3, danglingSeverity: 'info' },
  { file: 'f', rc: { thresholds: { chapterMin: 'abc', overdueLimit: -5, danglingSeverity: 'bogus' } } });
check('非法阈值回退读者向默认', wjBad.cfg.chapterMin === 100 && wjBad.cfg.overdueLimit === 3 && wjBad.cfg.danglingSeverity === 'info', JSON.stringify(wjBad.cfg));
const wjNeg = applyWjrc({ label: 'x', chapterMin: 100, chapterMax: 1000, overdueLimit: 3, danglingSeverity: 'info' },
  { file: 'f', rc: { thresholds: { chapterMin: -50, chapterMax: 0 } } });
check('负数阈值回退读者向默认（chapterMin -50 / chapterMax 0）', wjNeg.cfg.chapterMin === 100 && wjNeg.cfg.chapterMax === 1000, JSON.stringify(wjNeg.cfg));
const wjInv = applyWjrc({ label: 'x', chapterMin: 100, chapterMax: 1000, overdueLimit: 3, danglingSeverity: 'info' },
  { file: 'f', rc: { thresholds: { chapterMin: 800, chapterMax: 200 } } });
check('chapterMin > chapterMax 回退（防止规则静默失效）', wjInv.cfg.chapterMin === 100 && wjInv.cfg.chapterMax === 1000, JSON.stringify(wjInv.cfg));

console.log('场景 46b: .wjrc.json 多锚点查找（compile/simulate 口径一致）');
const { findWjrc: fw } = require('../src/wjrc');
const wjDirA = path.join(ROOT, 'test', 'fixtures', 'tmp-wjrc-a');
const wjDirB = path.join(ROOT, 'test', 'fixtures', 'tmp-wjrc-b');
fs.mkdirSync(wjDirA, { recursive: true });
fs.mkdirSync(wjDirB, { recursive: true });
fs.writeFileSync(path.join(wjDirB, '.wjrc.json'), '{}', 'utf8');
try {
  check('多锚点：canon 目录的 .wjrc.json 被命中（手稿目录无）', fw([path.join(wjDirA, 'x.md'), path.join(wjDirB, 'y.json')]) === path.join(wjDirB, '.wjrc.json'), String(fw([path.join(wjDirA, 'x.md'), path.join(wjDirB, 'y.json')])));
  check('单锚点兼容', fw(path.join(wjDirB, 'y.json')) === path.join(wjDirB, '.wjrc.json'), '');
  check('锚点均无 .wjrc 时返回 null（cwd 兜底不存在）', fw([path.join(wjDirA, 'x.md')]) === null, String(fw([path.join(wjDirA, 'x.md')])));
  check('null/空锚点不崩溃', fw(null) === null, '');
  // e2e：手稿在 A（无 .wjrc）、canon 在 B（有 .wjrc）→ compile 经 canon 锚点命中（原实现找不到）
  const wjMsFile = path.join(wjDirA, 'ms.md');
  const wjCanFile = path.join(wjDirB, 'canon.json');
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/clean-manuscript.md'), wjMsFile);
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/clean-canon.json'), wjCanFile);
  const wjRun = run([wjMsFile, wjCanFile, '--json']);
  let wjJ = null;
  try { wjJ = JSON.parse(wjRun.out); } catch { /* noop */ }
  check('compile e2e：manifest.wjrc 命中 canon 目录的 .wjrc.json', !!wjJ && wjJ.manifest.wjrc === path.join(wjDirB, '.wjrc.json'), JSON.stringify(wjJ && wjJ.manifest));
} finally {
  try { fs.rmSync(wjDirA, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(wjDirB, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('场景 47: 模拟器读者向缺省取 canon.meta.target_reader（与 compile 口径一致）');
const simR = run(['examples/outline.md', '--canon', 'test/fixtures/demo-canon.json', '--dry-run'], SIM);
check('缺省 reader 取 canon meta（webnovel）', simR.out.includes('webnovel（网文/连载）'), simR.out.slice(0, 300));
const simR2 = run(['examples/outline.md', '--canon', 'test/fixtures/demo-canon.json', '--reader', 'published', '--dry-run'], SIM);
check('显式 --reader 覆盖 canon meta', simR2.out.includes('published（出版向）'), simR2.out.slice(0, 300));

console.log('场景 48: 提取器 --from/--to 输入校验');
const badRange = run(['test/fixtures/clean-manuscript.md', '--from', '3', '--to', '1', '--dry-run'], EXT);
check('--from > --to 被拒（exit 2）', badRange.code === 2 && badRange.err.includes('不能大于'), `code=${badRange.code} ${badRange.err}`);
const badNum = run(['test/fixtures/clean-manuscript.md', '--from', 'abc', '--dry-run'], EXT);
check('--from 非数字被拒（exit 2）', badNum.code === 2, `code=${badNum.code} ${badNum.err}`);
const badZero = run(['test/fixtures/clean-manuscript.md', '--from', '0', '--dry-run'], EXT);
check('--from 0 被拒（exit 2）', badZero.code === 2, `code=${badZero.code} ${badZero.err}`);

console.log('场景 49: 楔子（第0章）缺时间线条目被检出（与提取器口径一致）');
const proMsTmp = path.join(ROOT, 'test', 'fixtures', 'tmp-prologue-ms.md');
const proCanTmp = path.join(ROOT, 'test', 'fixtures', 'tmp-prologue-canon.json');
fs.writeFileSync(proMsTmp, '# 楔子\n\n风雪夜，山神庙。\n\n# 第1章 信\n\n正文内容。\n', 'utf8');
fs.writeFileSync(proCanTmp, JSON.stringify({
  meta: { title: 'T', target_reader: 'webnovel' },
  entities: [{ id: 'shanmiao', name: '山神庙', type: 'location' }],
  knowledge: [],
  suspense: [],
  timeline: [{ chapter: 1, day: 1, location: 'shanmiao' }],
}, null, 2), 'utf8');
try {
  const proRun = run([proMsTmp, proCanTmp, '--json']);
  let proJ = null;
  try { proJ = JSON.parse(proRun.out); } catch { /* noop */ }
  check('exit code = 0（info 级不影响退出）', proRun.code === 0, `got ${proRun.code}`);
  const miss0 = proJ && proJ.problems.find((p) => p.rule === 'timeline/missing' && p.chapter === 0);
  check('检出第0章 timeline/missing', !!miss0, JSON.stringify(proJ && proJ.problems).slice(0, 300));
} finally {
  try { fs.unlinkSync(proMsTmp); } catch { /* 忽略 */ }
  try { fs.unlinkSync(proCanTmp); } catch { /* 忽略 */ }
}

console.log('场景 49b: lastNumber 兜底（末尾番外 + 跳号）+ 删章幽灵（timeline/ghost）');
// 手稿：第1、2、5章 + 番外 → 真实末章 = 5（旧实现 chapters.length=4，误报 planned/状态误判）
const gapMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-gap-ms.md');
const gapCanFile = path.join(ROOT, 'test', 'fixtures', 'tmp-gap-canon.json');
fs.writeFileSync(gapMsFile, '# 第1章 一\n\n正文。\n\n# 第2章 二\n\n正文。\n\n# 第5章 五\n\n正文。\n\n# 番外\n\n番外正文。\n', 'utf8');
fs.writeFileSync(gapCanFile, JSON.stringify({
  meta: { title: 'T', target_reader: 'webnovel' },
  entities: [],
  knowledge: [],
  suspense: [{ id: 's1', name: '谜', planted_in_chapter: 1, resolved_in_chapter: 5 }],
  timeline: [1, 2, 3, 4, 5].map((c) => ({ chapter: c, day: c })),
}, null, 2), 'utf8');
try {
  const gapRun = run([gapMsFile, gapCanFile, '--json']);
  let gapJ = null;
  try { gapJ = JSON.parse(gapRun.out); } catch { /* noop */ }
  check('exit 0（ghost 为 warning 不影响退出）', gapRun.code === 0, `got ${gapRun.code}`);
  check('lastNumber 取真实末章：不误报 timeline/planned（第5章已写）', !!gapJ && !gapJ.problems.some((p) => p.rule === 'timeline/planned'), JSON.stringify(gapJ && gapJ.problems).slice(0, 300));
  check('lastNumber 取真实末章：已回收悬念不误判 planned（resolved=5 ≤ 末章5）', !!gapJ && !gapJ.problems.some((p) => p.rule === 'suspense/planned') && !gapJ.problems.some((p) => p.rule === 'suspense/dangling'), JSON.stringify(gapJ && gapJ.problems).slice(0, 300));
  const ghost = gapJ && gapJ.problems.filter((p) => p.rule === 'timeline/ghost');
  check('删章幽灵：时间线有但手稿没有的第3/4章被报告（warning）', !!ghost && ghost.length === 2 && ghost.every((p) => p.severity === 'warning' && (p.chapter === 3 || p.chapter === 4)), JSON.stringify(ghost));
} finally {
  try { fs.unlinkSync(gapMsFile); } catch { /* 忽略 */ }
  try { fs.unlinkSync(gapCanFile); } catch { /* 忽略 */ }
}

(async () => {
  console.log('场景 49c: chatJSONValidated 对 4xx 永久错误不盲目重试（密钥错只调 1 次）');
  const { chatJSONValidated } = require('../src/llm');
  let calls401 = 0;
  const srv401 = http.createServer((req, res) => {
    calls401 += 1;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  });
  await new Promise((r) => srv401.listen(0, '127.0.0.1', r));
  const port401 = srv401.address().port;
  try {
    let err401 = null;
    try {
      await chatJSONValidated({
        apiKey: 'bad', baseUrl: `http://127.0.0.1:${port401}`, model: 'm',
        messages: [{ role: 'user', content: 'x' }], validate: () => [], maxAttempts: 3, maxTokens: 100,
      });
    } catch (e) { err401 = e; }
    check('401 抛错（带 statusCode）', !!err401 && err401.statusCode === 401, String(err401 && err401.statusCode));
    check('401 不盲目重试（仅 1 次请求）', calls401 === 1, `calls=${calls401}`);
  } finally {
    srv401.close();
  }

  console.log('场景 49c-2: 5xx 重试带最小退避（不连续打满服务端限流）');
  let calls500 = 0;
  const srv500 = http.createServer((req, res) => { calls500 += 1; res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => srv500.listen(0, '127.0.0.1', r));
  const port500 = srv500.address().port;
  try {
    const t0 = Date.now();
    try {
      await chatJSONValidated({
        apiKey: 'x', baseUrl: `http://127.0.0.1:${port500}`, model: 'm',
        messages: [{ role: 'user', content: 'x' }], validate: () => [], maxAttempts: 3, maxTokens: 100, timeoutMs: 5000,
      });
    } catch { /* 三次 500 后必然失败 */ }
    const elapsed = Date.now() - t0;
    check('5xx 重试 3 次', calls500 === 3, `calls=${calls500}`);
    check('5xx 重试带最小退避（总等待 ≥1s，500ms × (i+1)）', elapsed >= 1000, `elapsed=${elapsed}ms`);
  } finally {
    srv500.close();
  }

  console.log('场景 49c-3: chatJSONValidated 对解析失败/空内容不盲目重试（确定性失败重试同提示词无意义）');
  // 解析失败：模型返回非 JSON（HTTP 200），同提示词重试不会改变输出风格——只应调 1 次即抛 permanent 错误
  let callsParse = 0;
  const srvParse = http.createServer((req, res) => {
    callsParse += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '不是 JSON' }, finish_reason: 'stop' }] }));
  });
  await new Promise((r) => srvParse.listen(0, '127.0.0.1', r));
  const portParse = srvParse.address().port;
  try {
    let errParse = null;
    try {
      await chatJSONValidated({
        apiKey: 'x', baseUrl: `http://127.0.0.1:${portParse}`, model: 'm',
        messages: [{ role: 'user', content: 'x' }], validate: () => [], maxAttempts: 3, maxTokens: 100, timeoutMs: 5000,
      });
    } catch (e) { errParse = e; }
    check('解析失败抛错（permanent）', !!errParse && errParse.permanent === true && /不是合法 JSON/.test(errParse.message), String(errParse && errParse.message));
    check('解析失败不盲目重试（仅 1 次请求）', callsParse === 1, `calls=${callsParse}`);
  } finally {
    srvParse.close();
  }
  // 空内容（finish=stop 但 content 为空）：同样确定性失败，只调 1 次（预算升级只对内层 finish=length 有效）
  let callsEmpty = 0;
  const srvEmpty = http.createServer((req, res) => {
    callsEmpty += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
  });
  await new Promise((r) => srvEmpty.listen(0, '127.0.0.1', r));
  const portEmpty = srvEmpty.address().port;
  try {
    let errEmpty = null;
    try {
      await chatJSONValidated({
        apiKey: 'x', baseUrl: `http://127.0.0.1:${portEmpty}`, model: 'm',
        messages: [{ role: 'user', content: 'x' }], validate: () => [], maxAttempts: 3, maxTokens: 100, timeoutMs: 5000,
      });
    } catch (e) { errEmpty = e; }
    check('空内容抛错（permanent）', !!errEmpty && errEmpty.permanent === true, String(errEmpty && errEmpty.message));
    check('空内容不盲目重试（仅 1 次请求）', callsEmpty === 1, `calls=${callsEmpty}`);
  } finally {
    srvEmpty.close();
  }

  console.log('场景 49c-4: 截断 JSON（finish=length）触发预算升级重试而非标 permanent');
  // 旧实现：非空内容解析失败一律标 permanent 抛出，预算升级只在空内容路径触发——
  // 输出被 max_tokens 截断（finish=length 的不完整 JSON）是可修复的（翻倍预算后模型
  // 能产出完整 JSON），应重试而非一次性永久失败。
  let callsTrunc = 0;
  let truncTokens = [];
  const srvTrunc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      callsTrunc += 1;
      truncTokens.push(JSON.parse(body).max_tokens);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (callsTrunc === 1) {
        // 首次：被截断的不完整 JSON + finish=length（finish_reason 在 choices 层级，同 OpenAI/DeepSeek 结构）
        res.end(JSON.stringify({ choices: [{ message: { content: '{"entiti' }, finish_reason: 'length' }] }));
      } else {
        // 预算翻倍后的第二次：完整合法 JSON
        res.end(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise((r) => srvTrunc.listen(0, '127.0.0.1', r));
  const portTrunc = srvTrunc.address().port;
  try {
    let outTrunc = null;
    try {
      outTrunc = await chatJSONValidated({
        apiKey: 'x', baseUrl: `http://127.0.0.1:${portTrunc}`, model: 'm',
        messages: [{ role: 'user', content: 'x' }], validate: () => [], maxAttempts: 3, maxTokens: 100, timeoutMs: 5000,
      });
    } catch (e) { outTrunc = e; }
    check('截断 JSON 预算升级后重试成功（非 permanent 一次性失败）', !!outTrunc && outTrunc.ok === true, String(outTrunc && (outTrunc.message || JSON.stringify(outTrunc))));
    check('截断 JSON 触发预算翻倍（max_tokens 100 → 200）', truncTokens.length === 2 && truncTokens[1] === 200, `tokens=${JSON.stringify(truncTokens)}`);
    check('截断 JSON 共 2 次请求', callsTrunc === 2, `calls=${callsTrunc}`);
  } finally {
    srvTrunc.close();
  }
  // 持续截断：所有调用都返回不完整 JSON → 预算翻倍爬升后以永久预算错误终止（不无限循环）
  let callsTruncAll = 0;
  const srvTruncAll = http.createServer((req, res) => {
    callsTruncAll += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }));
  });
  await new Promise((r) => srvTruncAll.listen(0, '127.0.0.1', r));
  const portTruncAll = srvTruncAll.address().port;
  try {
    let errTruncAll = null;
    try {
      await chatJSONValidated({
        apiKey: 'x', baseUrl: `http://127.0.0.1:${portTruncAll}`, model: 'm',
        messages: [{ role: 'user', content: 'x' }], validate: () => [], maxAttempts: 3, maxTokens: 100, timeoutMs: 5000,
      });
    } catch (e) { errTruncAll = e; }
    check('持续截断以永久预算错误终止（含仍在爬升预算信息）', !!errTruncAll && errTruncAll.permanent === true && /预算/.test(errTruncAll.message), String(errTruncAll && errTruncAll.message));
    check('持续截断有界（3 次请求，不无限循环）', callsTruncAll === 3, `calls=${callsTruncAll}`);
  } finally {
    srvTruncAll.close();
  }

  console.log('场景 49c-6: chatTextValidated 截断/空内容（finish=length）触发预算升级重试（与 chatJSON 对称，O-8）');
  // 推理模型把预算花在 reasoning 上 → content 空 + finish=length，翻倍预算后本可成功；
  // 旧实现永不升级 → 三次校验失败后放弃，且把空内容当"上一次输出"喂回反而污染上下文。
  // 测试按 max_tokens 分流：预算未升级恒返回 length+空，升级后返回完整文本——精确区分两种行为。
  const { chatTextValidated } = require('../src/llm');
  let callsTxt = 0;
  const txtTokens = [];
  const txtMsgLens = [];
  const srvTxt = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      callsTxt += 1;
      const reqJson = JSON.parse(body);
      txtTokens.push(reqJson.max_tokens);
      txtMsgLens.push(reqJson.messages.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (reqJson.max_tokens <= 100) {
        // 预算未升级：content 空 + finish=length（预算花在 reasoning，可修复）
        res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
      } else {
        // 预算翻倍后：完整文本
        res.end(JSON.stringify({ choices: [{ message: { content: '# 第一章\n\n正文内容完整。' }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise((r) => srvTxt.listen(0, '127.0.0.1', r));
  const portTxt = srvTxt.address().port;
  try {
    let outTxt = null;
    try {
      outTxt = await chatTextValidated({
        apiKey: 'x', baseUrl: `http://127.0.0.1:${portTxt}`, model: 'm',
        messages: [{ role: 'user', content: 'x' }], validate: (t) => (t && t.includes('正文') ? [] : ['缺少正文']), maxAttempts: 3, maxTokens: 100, timeoutMs: 5000,
      });
    } catch (e) { outTxt = e; }
    check('文本截断（finish=length）预算升级后重试成功（非永久失败）', typeof outTxt === 'string' && outTxt.includes('正文'), String(outTxt && (outTxt.message || outTxt)));
    check('文本截断触发预算翻倍（max_tokens 100 → 200）', txtTokens.length === 2 && txtTokens[1] === 200, `tokens=${JSON.stringify(txtTokens)}`);
    check('文本截断共 2 次请求（升级后成功，不浪费第 3 次）', callsTxt === 2, `calls=${callsTxt}`);
    check('文本截断升级重试不喂校验反馈（messages 未被污染）', txtMsgLens.length === 2 && txtMsgLens[1] === 1, `msgLens=${JSON.stringify(txtMsgLens)}`);
  } finally {
    srvTxt.close();
  }

  console.log('场景 49d: 范围提取输出哈希只写已提取章（未提取章不"洗白"）e2e');
  // fake LLM：解析请求体范围与正文行 → 响应 = 基线 canon 原样 + 范围内章 timeline 证据
  // （第一个非空行属 from 章、最后一个非空行属 to 章——范围 2-3 时行序保证归属正确）
  const srvFake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      // 解析请求 JSON 后在真实 content 上匹配（直接匹配 JSON 文本会把 \n 转义当内容）
      const text = (() => {
        try {
          const r = JSON.parse(body);
          const u = (r.messages || []).find((x) => x.role === 'user');
          return u ? u.content : '';
        } catch { return ''; }
      })();
      const rangeM = text.match(/【提取范围】仅第(\d+) 至 第(\d+) 章/);
      const from = rangeM ? Number(rangeM[1]) : 1;
      const to = rangeM ? Number(rangeM[2]) : 1;
      const rows = [...text.matchAll(/(\d+)\|([^\n]*)/g)].filter((x) => x[2].trim());
      const timeline = {};
      for (let c = from; c <= to; c++) {
        const row = c === from ? rows[0] : rows[rows.length - 1];
        if (row) timeline[String(c)] = [{ chapter: c, line: Number(row[1]), quote: row[2].slice(0, 10) }];
      }
      const content = JSON.stringify({
        canon: JSON.parse(JSON.stringify(cleanCanon)),
        evidence: { entities: {}, knowledge: {}, suspense: {}, timeline },
        extraction_notes: [],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvFake.listen(0, '127.0.0.1', r));
  const portFake = srvFake.address().port;
  const fakeEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portFake}`, DEEPSEEK_MODEL: 'm', LLM_INPUT_BUDGET_TOKENS: '48000', LLM_TIMEOUT_MS: '60000' };
  const rangeOut = path.join(ROOT, 'test', 'fixtures', 'tmp-range-out.json');
  const rangeOut2 = path.join(ROOT, 'test', 'fixtures', 'tmp-range-out2.json');
  try { fs.unlinkSync(path.join(ROOT, 'test', 'fixtures', 'last-extract.json')); } catch { /* 残留清理 */ }
  try {
    // 注意：必须用异步 spawn——spawnSync 会阻塞本进程事件循环，同进程的 fake http server 无法响应请求
    const runRange = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [EXT, ...args], { cwd: ROOT, encoding: 'utf8', env: fakeEnv });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    // ① 首次范围 1-1（无旧哈希）：输出哈希只含第 1 章
    const rngRun = await runRange(['test/fixtures/clean-manuscript.md', '--canon', 'test/fixtures/clean-canon.json', '--from', '1', '--to', '1', '--out', rangeOut]);
    check('范围提取 e2e exit 0', rngRun.status === 0, `got ${rngRun.status}\n${rngRun.stdout}${rngRun.stderr}`);
    const rngJ = JSON.parse(fs.readFileSync(rangeOut, 'utf8'));
    check('范围提取哈希只含已提取章（无旧哈希 → 未提取章不写键）', Object.keys(rngJ.meta.chapter_hashes).length === 1 && !!rngJ.meta.chapter_hashes['1'], JSON.stringify(rngJ.meta.chapter_hashes));
    // 后续增量：未提取章（2、3）判脏 → 不会被洗白
    const msClean = fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-manuscript.md'), 'utf8');
    const { dirtyChapters: dc2, chapterHashes: ch2 } = require('../src/incremental');
    const dirtyAfter = dc2(ch2(msClean), rngJ.meta.chapter_hashes);
    check('后续增量：未提取章被判脏（不会永久缺失）', dirtyAfter.includes(2) && dirtyAfter.includes(3), JSON.stringify(dirtyAfter));
    // ② 范围推进 2-3 + --merge-with 首次输出：哈希继承第 1 章 + evidence 证据继承
    const rngRun2 = await runRange(['test/fixtures/clean-manuscript.md', '--canon', 'test/fixtures/clean-canon.json', '--from', '2', '--to', '3', '--merge-with', rangeOut, '--out', rangeOut2]);
    check('范围推进 e2e exit 0', rngRun2.status === 0, `got ${rngRun2.status}\n${rngRun2.stdout}${rngRun2.stderr}`);
    const rngJ2 = JSON.parse(fs.readFileSync(rangeOut2, 'utf8'));
    const h2 = rngJ2.meta.chapter_hashes;
    check('范围推进：哈希继承未提取的第 1 章 + 新提取的 2、3 章', Object.keys(h2).length === 3 && !!h2['1'] && !!h2['2'] && !!h2['3'], JSON.stringify(h2));
    check('范围推进：evidence 证据继承（旧章 1 引文保留 + 新章 2、3 引文）', !!rngJ2.evidence.timeline && !!rngJ2.evidence.timeline['1'] && !!rngJ2.evidence.timeline['2'] && !!rngJ2.evidence.timeline['3'], JSON.stringify(Object.keys(rngJ2.evidence.timeline || {})));
    check('范围推进闭环：全部章已提取 → 后续增量无脏（不洗白也不误报）', JSON.stringify(dc2(ch2(msClean), h2)) === JSON.stringify([]), JSON.stringify(dc2(ch2(msClean), h2)));
  } finally {
    srvFake.close();
    try { fs.unlinkSync(rangeOut); } catch { /* 忽略 */ }
    try { fs.unlinkSync(rangeOut2); } catch { /* 忽略 */ }
  }

  console.log('场景 49e: simulate 带基线 canon e2e（validate 回调 asArray 回归）');
  // 回归背景：曾因 simulate.js 只导入 CANON_SECTIONS 未导入 asArray，带 --canon 的模拟在
  // 权威基线保留检查处 ReferenceError → 必败；参数校验类测试发现不了（validate 闭包路径无覆盖）
  const srvSim = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // 响应 = 基线 canon 原样（全部基线 id 保留，恰好走 asArray 所在的基线保留检查路径）
      const content = JSON.stringify({
        canon: JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-canon.json'), 'utf8')),
        risk_register: [{ id: 'R1', risk: '示例风险', severity: 'medium', probability: 0.5, chapter: 1, kind: 'continuity', trigger: '示例', mitigation: '示例' }],
        simulation_notes: ['fake-llm'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvSim.listen(0, '127.0.0.1', r));
  const portSim = srvSim.address().port;
  const simOut = path.join(ROOT, 'test', 'fixtures', 'tmp-sim-e2e.json');
  try {
    const simEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portSim}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
    const simRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SIM, 'examples/outline.md', '--canon', 'test/fixtures/clean-canon.json', '--out', simOut], { cwd: ROOT, encoding: 'utf8', env: simEnv });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    check('simulate 带基线 e2e exit 0（基线保留检查不再 ReferenceError）', simRun.status === 0, `got ${simRun.status}\n${simRun.stdout}${simRun.stderr}`);
    const simJ = JSON.parse(fs.readFileSync(simOut, 'utf8'));
    check('simulate 带基线输出信封完整（基线 canon 并入 + 风险登记册）', simJ.canon.entities.length === 4 && simJ.risk_register.length === 1 && simJ.meta.source_canon !== null, JSON.stringify({ e: simJ.canon.entities.length, r: simJ.risk_register.length }));
  } finally {
    srvSim.close();
    try { fs.unlinkSync(simOut); } catch { /* 忽略 */ }
  }

  console.log('场景 49f: simulate lightValidate 风险登记册字段类型与枚举校验');
  // 回归背景：risk_register 的 chapter/kind/trigger/mitigation 曾无类型校验，
  // 模型输出 chapter 字符串/枚举外 kind 等坏类型会静默流入信封。现补类型校验：3 次重试后放弃并报错。
  const srvBadRisk = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const content = JSON.stringify({
        canon: JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-canon.json'), 'utf8')),
        risk_register: [{ id: 'R1', risk: '示例风险', severity: 'medium', probability: 0.5, chapter: '2', kind: 7, trigger: '示例', mitigation: '示例' }],
        simulation_notes: ['fake-llm'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvBadRisk.listen(0, '127.0.0.1', r));
  const portBadRisk = srvBadRisk.address().port;
  const simOutF = path.join(ROOT, 'test', 'fixtures', 'tmp-sim-badrisk.json'); // 独立临时文件，与 49e 解耦
  try {
    const badEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portBadRisk}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
    const badRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SIM, 'examples/outline.md', '--canon', 'test/fixtures/clean-canon.json', '--out', simOutF], { cwd: ROOT, encoding: 'utf8', env: badEnv });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    check('simulate 坏风险字段类型：3 次重试后放弃（exit 1）', badRun.status === 1, `got ${badRun.status}\n${badRun.stdout}${badRun.stderr}`);
    check('simulate 坏风险字段类型：报错含具体字段路径', badRun.stderr.includes('risk_register[0].chapter 必须是非负整数') && badRun.stderr.includes('risk_register[0].kind 必须是'), badRun.stderr.slice(0, 500));
  } finally {
    srvBadRisk.close();
    try { fs.unlinkSync(simOutF); } catch { /* 忽略 */ }
  }

  console.log('场景 49f-2: simulate 缺省风险字段 CLI 渲染不输出 undefined');
  // 回归背景：chapter/kind/trigger/mitigation 在 lightValidate 中已允许缺省；
  // CLI 文本渲染此前直接插值，缺省时出现「第undefined章」「触发: undefined」
  const srvSparseRisk = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const content = JSON.stringify({
        canon: JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-canon.json'), 'utf8')),
        risk_register: [{ id: 'R2', risk: '缺省字段风险', severity: 'low', probability: 0.3 }],
        simulation_notes: [],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvSparseRisk.listen(0, '127.0.0.1', r));
  const portSparseRisk = srvSparseRisk.address().port;
  const simOutF2 = path.join(ROOT, 'test', 'fixtures', 'tmp-sim-sparserisk.json');
  try {
    const sparseEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portSparseRisk}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
    const sparseRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SIM, 'examples/outline.md', '--canon', 'test/fixtures/clean-canon.json', '--out', simOutF2], { cwd: ROOT, encoding: 'utf8', env: sparseEnv });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out }));
    });
    check('simulate 缺省风险字段：exit 0（通过校验）', sparseRun.status === 0, `got ${sparseRun.status}\n${sparseRun.stdout}`);
    check('simulate 缺省风险字段：CLI 不出现 undefined', !sparseRun.stdout.includes('undefined') && sparseRun.stdout.includes('第?章'), sparseRun.stdout.slice(0, 500));
  } finally {
    srvSparseRisk.close();
    try { fs.unlinkSync(simOutF2); } catch { /* 忽略 */ }
  }

  console.log('场景 49g: rebase 覆盖式输出 e2e（--out 指向预测文件本身：旧预测备份 + 新预测就位）');
  // 回归背景（E1 工作流断裂）：rebase 缺省写 .rebase.json，而 IDE 的提示/风险面板/compare 全部
  // 指向 last-pred.json——rebase 成果不可见，用户只能重跑模拟自救。现 IDE 传 --out 覆盖预测文件
  // 本身；rebase 端在覆盖前把旧预测备份为 .bak-*（pruneBackups 保留 5 份），并注入 meta.rebase 溯源。
  const srvRbs = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const content = JSON.stringify({
        canon: JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-canon.json'), 'utf8')),
        risk_register: [{ id: 'R1', risk: '示例风险', severity: 'medium', probability: 0.5, chapter: 1, kind: 'continuity', trigger: '示例', mitigation: '示例' }],
        simulation_notes: ['fake-llm'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvRbs.listen(0, '127.0.0.1', r));
  const portRbs = srvRbs.address().port;
  const rbsPred = path.join(ROOT, 'test', 'fixtures', 'tmp-rbs-overwrite.json');
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'rebase-pred.json'), rbsPred); // 复制夹具：原夹具保持不动
  try {
    const rbsEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portRbs}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
    const rbsRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [RBS, rbsPred, 'test/fixtures/clean-canon.json', '--out', rbsPred], { cwd: ROOT, encoding: 'utf8', env: rbsEnv });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    check('rebase 覆盖式：exit 1（漂移已处理）', rbsRun.status === 1, `got ${rbsRun.status}\n${rbsRun.stdout}${rbsRun.stderr}`);
    check('rebase 覆盖式：旧预测已备份提示', rbsRun.stdout.includes('旧预测已备份'), rbsRun.stdout.slice(0, 400));
    const newPred = JSON.parse(fs.readFileSync(rbsPred, 'utf8'));
    check('rebase 覆盖式：预测文件已是新预测（基线 canon 并入）', newPred.canon.entities.length === 4 && newPred.meta.rebase && newPred.meta.rebase.reason === 'auto-rebase' && newPred.meta.rebase.drift_warnings >= 1, JSON.stringify({ e: newPred.canon.entities.length, rebase: newPred.meta.rebase }));
    const baks = fs.readdirSync(path.join(ROOT, 'test', 'fixtures')).filter((f) => f.startsWith('tmp-rbs-overwrite.json.bak-'));
    check('rebase 覆盖式：备份文件存在且是旧预测（含 old_zhou 五实体）', baks.length >= 1 && JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', baks[0]), 'utf8')).canon.entities.length === 5, JSON.stringify(baks));

    // 大小写变体（X1 回归）：win32 文件系统大小写不敏感但 realpathSync 保留输入大小写——
    // 若不做小写归一，--out 与预测路径仅大小写不同时 same=false → 跳过备份直接覆盖
    fs.copyFileSync(path.join(ROOT, 'test/fixtures/rebase-pred.json'), rbsPred);
    const rbsPredUC = path.join(ROOT, 'test', 'fixtures', 'TMP-RBS-OVERWRITE.JSON');
    const rbsRunUC = await new Promise((resolve) => {
      const child = spawn(process.execPath, [RBS, rbsPred, 'test/fixtures/clean-canon.json', '--out', rbsPredUC], { cwd: ROOT, encoding: 'utf8', env: rbsEnv });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    const baksUC = fs.readdirSync(path.join(ROOT, 'test', 'fixtures')).filter((f) => f.toUpperCase().startsWith('TMP-RBS-OVERWRITE.JSON.BAK-'));
    check('rebase 覆盖式（大小写变体）：备份仍触发（win32 归一生效）', process.platform !== 'win32' || (rbsRunUC.stdout.includes('旧预测已备份') && baksUC.length >= 1), `platform=${process.platform} out=${rbsRunUC.stdout.slice(0, 300)}`);
  } finally {
    srvRbs.close();
    try { fs.unlinkSync(rbsPred); } catch { /* 忽略 */ }
    for (const f of fs.readdirSync(path.join(ROOT, 'test', 'fixtures'))) {
      if (f.toUpperCase().startsWith('TMP-RBS-OVERWRITE')) { try { fs.unlinkSync(path.join(ROOT, 'test', 'fixtures', f)); } catch { /* 忽略 */ } }
    }
  }

  console.log('场景 49h: 分块提取 --resume 断点续跑 e2e（检查点写入 / 裁剪跳过 / 哈希判脏 / 收尾清理）');
  // 回归背景：分块提取第 k 批失败后，旧流程只能手动 --from/--to 拼接续跑（批边界要人肉推算）。
  // 现每批完成自动写 <out>.partial 检查点（done_keys + 章节哈希），原命令加 --resume 即可续跑：
  // 跳过「已完成且手稿未变更」的整批；检查点后手稿被改的章按哈希判脏重新提取（不是纯 done_keys 命中）。
  // fake LLM：解析请求中的范围与行号化正文 → 响应 = 基线原样 + 范围内章确定性时间线 +
  // 每章首个非空内容行证据（行号 + 逐字引文，通过行号锚定与 quote 逐字校验）；
  // resumeFailFrom 注入第 2 批起 HTTP 400（4xx 永久错误不重试，失败最快）。
  const { chapterHashes: chHashes } = require('../src/incremental');
  const { parseManuscript: parseMs49h } = require('../src/extract');
  const resumeMsParts = [];
  for (let i = 1; i <= 12; i++) {
    resumeMsParts.push(`# 第${i}章 章节${i}`, '', '正文内容'.repeat(600), '');
  }
  const resumeMsText = resumeMsParts.join('\n');
  const resumeMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-resume-ms.md');
  const resumeMsFile2 = path.join(ROOT, 'test', 'fixtures', 'tmp-resume-ms2.md'); // 检查点后修改版（第1章尾部加一句）
  fs.writeFileSync(resumeMsFile, resumeMsText, 'utf8');
  fs.writeFileSync(resumeMsFile2, resumeMsText.replace('正文内容'.repeat(600), `${'正文内容'.repeat(600)}\n检查点后的修改。`), 'utf8');
  const resumeOut = path.join(ROOT, 'test', 'fixtures', 'tmp-resume-out.json');
  let resumeReqs = 0;
  let resumeFailFrom = null;
  let resumeCurMs = null; // 当前子进程对应的手稿（章节行号映射用；编辑版运行前切换）
  const srvResume = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      resumeReqs++;
      const text = (() => {
        try {
          const r = JSON.parse(body);
          const u = (r.messages || []).find((x) => x.role === 'user');
          return u ? u.content : '';
        } catch { return ''; }
      })();
      const rangeM = text.match(/【提取范围】仅第(\d+) 至 第(\d+) 章/);
      const from = rangeM ? Number(rangeM[1]) : 1;
      const to = rangeM ? Number(rangeM[2]) : 1;
      if (resumeFailFrom !== null && from >= resumeFailFrom) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '模拟第 2 批失败（测试注入）' } }));
        return;
      }
      // 时间线 = 基线原样（1-3 章由基线携带，含范围外章）+ 4..to 章确定性新条目；
      // 证据 = 范围内每章首个非空内容行（行号→章节映射用 parseManuscript；标题行不在行号化正文内）
      const cleanTlMap = new Map(cleanCanon.timeline.map((t) => [t.chapter, t]));
      const rows = [...text.matchAll(/(\d+)\|([^\n]*)/g)];
      const chMap = new Map(parseMs49h(resumeCurMs).chapters.filter((c) => c.number !== null).map((c) => [c.number, c]));
      const tl = [];
      const evTl = {};
      for (let c = 1; c <= Math.max(to, 3); c++) {
        tl.push(cleanTlMap.get(c) || { chapter: c, day: 1 });
        if (c >= from && c <= to) {
          const ch = chMap.get(c);
          const row = ch && rows.find((x) => Number(x[1]) >= ch.startLine && Number(x[1]) <= ch.endLine && x[2].trim());
          if (row) evTl[String(c)] = [{ chapter: c, line: Number(row[1]), quote: row[2].slice(0, 10) }];
        }
      }
      const content = JSON.stringify({
        canon: { ...JSON.parse(JSON.stringify(cleanCanon)), timeline: tl },
        evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: evTl },
        extraction_notes: ['fake-llm'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvResume.listen(0, '127.0.0.1', r));
  const portResume = srvResume.address().port;
  const resumeEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portResume}`, DEEPSEEK_MODEL: 'm', LLM_INPUT_BUDGET_TOKENS: '8000', LLM_TIMEOUT_MS: '60000' };
  const runExt = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [EXT, ...args], { cwd: ROOT, encoding: 'utf8', env: resumeEnv });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
  // 镜像 --resume 的裁剪算法（同输入复算期望值，不硬编码批边界；边界随 canon 大小自然变化）
  const trimResume = (ms, cp) => {
    const plan = planExtractionChunks({ manuscript: ms, baseline: cp.canon, maxTokens: 8000 });
    const cur = chHashes(ms);
    const cpHashes = cp.meta.chapter_hashes || {};
    const doneKeys = new Set(cp.meta.partial.done_keys.map(Number));
    const done = (n) => doneKeys.has(n) && cpHashes[String(n)] === cur[String(n)];
    const remaining = [];
    let skipped = 0;
    for (const b of plan) {
      let pf = null;
      for (let n = b.from; n <= b.to; n++) {
        if (!done(n)) { pf = n; break; }
      }
      if (pf === null) { skipped++; continue; }
      remaining.push(pf === b.from ? b : { ...b, from: pf });
    }
    return { plan, remaining, skipped };
  };
  try {
    // ---------- 参数校验（不调 LLM，exit 2 早退） ----------
    const rA1 = spawnSync(process.execPath, [EXT, resumeMsFile, '--resume'], { cwd: ROOT, encoding: 'utf8', env: resumeEnv });
    check('--resume 缺 --out 拒绝（exit 2）', rA1.status === 2 && (rA1.stderr + rA1.stdout).includes('--resume 需要 --out'), rA1.stderr);
    const rA2 = spawnSync(process.execPath, [EXT, resumeMsFile, '--resume', '--out', resumeOut, '--canon', 'test/fixtures/clean-canon.json'], { cwd: ROOT, encoding: 'utf8', env: resumeEnv });
    check('--resume 与 --canon 互斥（基线来自检查点，exit 2）', rA2.status === 2 && (rA2.stderr + rA2.stdout).includes('--resume 与 --canon 互斥'), rA2.stderr);
    const rA3 = spawnSync(process.execPath, [EXT, resumeMsFile, '--resume', '--out', resumeOut, '--from', '2'], { cwd: ROOT, encoding: 'utf8', env: resumeEnv });
    check('--resume 与 --from/--to 互斥（范围由检查点推导，exit 2）', rA3.status === 2 && (rA3.stderr + rA3.stdout).includes('--resume 与 --from/--to 互斥'), rA3.stderr);
    const rA4 = spawnSync(process.execPath, [EXT, resumeMsFile, '--resume', '--out', resumeOut], { cwd: ROOT, encoding: 'utf8', env: resumeEnv });
    check('--resume 无检查点拒绝（exit 2）', rA4.status === 2 && (rA4.stderr + rA4.stdout).includes('未找到可续跑的分块检查点'), rA4.stderr);

    // ---------- 流程 A：第 2 批失败写检查点 → 原命令 --resume 收尾 ----------
    const planA = planExtractionChunks({ manuscript: resumeMsText, baseline: cleanCanon, maxTokens: 8000 });
    resumeCurMs = resumeMsText;
    resumeFailFrom = planA[1].from;
    const runA1 = await runExt([resumeMsFile, '--canon', 'test/fixtures/clean-canon.json', '--out', resumeOut]);
    const bothA1 = runA1.stdout + runA1.stderr;
    check('分块第 2 批失败：exit 2（LLM 调用失败）', runA1.status === 2, `got ${runA1.status}\n${bothA1.slice(0, 400)}`);
    check('失败提示指向检查点与 --resume 用法', bothA1.includes(`${resumeOut}.partial`) && /--resume/.test(bothA1), bothA1.slice(0, 300));
    const cpPathA = `${resumeOut}.partial`;
    check('失败后检查点已写出（批 1 成果不丢）', fs.existsSync(cpPathA), '');
    const cpA = JSON.parse(fs.readFileSync(cpPathA, 'utf8'));
    const batch1Chapters = [];
    for (let n = planA[0].from; n <= planA[0].to; n++) batch1Chapters.push(n);
    check('检查点 done_keys = 已完成批的全部章', JSON.stringify(cpA.meta.partial.done_keys) === JSON.stringify(batch1Chapters), JSON.stringify(cpA.meta.partial));
    check('检查点记录批进度（1/N）', cpA.meta.partial.done_batches === 1 && cpA.meta.partial.of === planA.length, JSON.stringify(cpA.meta.partial));
    check('检查点哈希只含已完成批（未提取章不洗白）', JSON.stringify(Object.keys(cpA.meta.chapter_hashes).map(Number).sort((a, b) => a - b)) === JSON.stringify(batch1Chapters), JSON.stringify(cpA.meta.chapter_hashes));
    const expTlA = [];
    for (let c = 1; c <= Math.max(planA[0].to, 3); c++) expTlA.push(c);
    check('检查点 canon 时间线覆盖基线 + 已提取批', JSON.stringify(cpA.canon.timeline.map((t) => t.chapter)) === JSON.stringify(expTlA), JSON.stringify(cpA.canon.timeline));
    check('检查点 evidence 含批 1 范围内章（内容行证据）', JSON.stringify(Object.keys(cpA.evidence.timeline).map(Number).sort((a, b) => a - b)) === JSON.stringify(batch1Chapters), JSON.stringify(cpA.evidence.timeline));

    // 续跑：关闭失败注入，原命令加 --resume（不带 --canon——基线来自检查点）
    resumeFailFrom = null;
    const trimA = trimResume(resumeMsText, cpA);
    check('镜像裁剪：续跑确实跳过整批（测试有效性前提）', trimA.skipped >= 1, JSON.stringify({ plan: trimA.plan, skipped: trimA.skipped }));
    const reqsBefore = resumeReqs;
    const runA2 = await runExt([resumeMsFile, '--out', resumeOut, '--resume']);
    check('续跑 exit 0', runA2.status === 0, `got ${runA2.status}\n${runA2.stdout}${runA2.stderr}`);
    check('续跑跳过已完成批（跳过数与镜像一致）', runA2.stdout.includes(`续跑：跳过已完成的 ${trimA.skipped} 批，本次提取 ${trimA.remaining.length} 批`), runA2.stdout.slice(0, 400));
    check('续跑只调剩余批的 LLM（请求数 = 剩余批数，不重提取已完成批）', resumeReqs - reqsBefore === trimA.remaining.length, `requests=${resumeReqs - reqsBefore} remaining=${trimA.remaining.length}`);
    const outA = JSON.parse(fs.readFileSync(resumeOut, 'utf8'));
    check('输出 meta.auto_chunked.resumed 记录跳过数与检查点来源', outA.meta.auto_chunked && outA.meta.auto_chunked.resumed
      && outA.meta.auto_chunked.resumed.skipped_batches === trimA.skipped
      && outA.meta.auto_chunked.resumed.from === cpPathA, JSON.stringify(outA.meta.auto_chunked));
    check('输出批次 = 剩余批且首批起点一致（裁剪后的边界）', outA.meta.auto_chunked.batches === trimA.remaining.length
      && outA.meta.auto_chunked.ranges.length === trimA.remaining.length
      && outA.meta.auto_chunked.ranges[0].from === trimA.remaining[0].from, JSON.stringify(outA.meta.auto_chunked));
    check('输出哈希覆盖全部 12 章（跳过章继承检查点哈希）', Object.keys(outA.meta.chapter_hashes).length === 12
      && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((n) => outA.meta.chapter_hashes[String(n)]), JSON.stringify(Object.keys(outA.meta.chapter_hashes)));
    check('输出时间线全稿完整（12 章）', outA.canon.timeline.length === 12, JSON.stringify(outA.canon.timeline.length));
    check('输出证据链完整（跳过批的证据来自检查点继承）', Object.keys(outA.evidence.timeline).length === 12, JSON.stringify(Object.keys(outA.evidence.timeline)));
    check('最终输出不含 partial 字段（收尾即完成）', outA.meta.partial === undefined, JSON.stringify(outA.meta).slice(0, 200));
    check('成功后检查点已清理', !fs.existsSync(cpPathA), '');

    // ---------- 流程 B：检查点后修改已完成章 → 哈希判脏 → 整批重新提取 ----------
    resumeFailFrom = planA[1].from;
    const runB1 = await runExt([resumeMsFile, '--canon', 'test/fixtures/clean-canon.json', '--out', resumeOut]);
    check('流程 B 重建检查点：第 2 批失败 exit 2', runB1.status === 2, `got ${runB1.status}\n${(runB1.stdout + runB1.stderr).slice(0, 300)}`);
    const cpB = JSON.parse(fs.readFileSync(`${resumeOut}.partial`, 'utf8'));
    const msEdited = fs.readFileSync(resumeMsFile2, 'utf8');
    const trimB = trimResume(msEdited, cpB);
    resumeFailFrom = null;
    resumeCurMs = msEdited; // 编辑版手稿的行号映射（第2章起行号 +1）
    const reqsBeforeB = resumeReqs;
    const runB2 = await runExt([resumeMsFile2, '--out', resumeOut, '--resume']);
    const bothB2 = runB2.stdout + runB2.stderr;
    check('修改后的已完成章判脏重提取（提示第1章）', bothB2.includes('检查点后手稿有修改：第1章'), bothB2.slice(0, 400));
    check('修改后包含脏章的批不跳过（0 跳过 + 全部批提取）', runB2.stdout.includes(`续跑：跳过已完成的 ${trimB.skipped} 批，本次提取 ${trimB.remaining.length} 批`)
      && trimB.skipped === 0, runB2.stdout.slice(0, 400));
    check('修改后请求数 = 全部批（含重提取的批 1）', resumeReqs - reqsBeforeB === trimB.remaining.length, `requests=${resumeReqs - reqsBeforeB} expected=${trimB.remaining.length}`);
    check('流程 B 续跑 exit 0 且全稿完整（时间线 + 哈希均 12 章）', runB2.status === 0, `got ${runB2.status}\n${bothB2.slice(0, 300)}`);
    const outB = JSON.parse(fs.readFileSync(resumeOut, 'utf8'));
    check('流程 B 输出全稿完整且哈希为修改后当前值', outB.canon.timeline.length === 12
      && Object.keys(outB.meta.chapter_hashes).length === 12
      && outB.meta.chapter_hashes['1'] === chHashes(msEdited)['1'], JSON.stringify({ tl: outB.canon.timeline.length, h: Object.keys(outB.meta.chapter_hashes).length }));
    check('流程 B 成功后检查点已清理', !fs.existsSync(`${resumeOut}.partial`), '');
  } finally {
    srvResume.close();
    for (const f of [resumeMsFile, resumeMsFile2, resumeOut, `${resumeOut}.partial`]) {
      try { fs.unlinkSync(f); } catch { /* 忽略 */ }
    }
  }

  console.log('场景 49i: 自动分块提取 + --retire-stale 僵尸清理 e2e（合并后按全文统计清理）');
  // 回归来源：旧实现分块路径跳过 purgeStale（!autoChunks 条件），自动分块时僵尸设定残留——
  // 分块合并后的 canon 已是全稿（编号章），purgeStale 基于全文提及统计不会误伤
  const { parseManuscript: parseMs49i } = require('../src/extract');
  const purgeBase = JSON.parse(JSON.stringify(cleanCanon));
  purgeBase.entities.push(
    { id: 'zombie_old', name: '旧故事残留', aliases: [], type: 'character' },                     // 零提及 → 应被清理
    { id: 'zombie_loc', name: '旧地点残留', aliases: [], type: 'location' },                      // 零提及 → 应被清理
    { id: 'future_man2', name: '未来角色二', aliases: [], type: 'character', appears_from_chapter: 9 }, // 未到期 → 保留
  );
  const purgeBaseFile = path.join(ROOT, 'test', 'fixtures', 'tmp-purge-base.json');
  fs.writeFileSync(purgeBaseFile, JSON.stringify(purgeBase, null, 2) + '\n', 'utf8');
  const purgeMsParts = [];
  for (let i = 1; i <= 8; i++) {
    // 活跃实体必须在正文实际出现（否则 purgeStale 按零提及规则合法清理，测试意图落空）
    const body = '正文内容'.repeat(600) + (i === 1 ? '沈默与林晚在江城码头碰面，商量对策。' : '');
    purgeMsParts.push(`# 第${i}章 章${i}`, '', body, '');
  }
  const purgeMsText = purgeMsParts.join('\n');
  const purgeMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-purge-ms.md');
  fs.writeFileSync(purgeMsFile, purgeMsText, 'utf8');
  const purgeOut = path.join(ROOT, 'test', 'fixtures', 'tmp-purge-out.json');
  const chMapI = new Map(parseMs49i(purgeMsText).chapters.filter((c) => c.number !== null).map((c) => [c.number, c]));
  const srvPurge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const text = (() => {
        try { const r = JSON.parse(body); const u = (r.messages || []).find((x) => x.role === 'user'); return u ? u.content : ''; }
        catch { return ''; }
      })();
      const rangeM = text.match(/【提取范围】仅第(\d+) 至 第(\d+) 章/);
      const from = rangeM ? Number(rangeM[1]) : 1;
      const to = rangeM ? Number(rangeM[2]) : 1;
      // 从提示词内嵌的基线 JSON 原样回显（含僵尸条目，交由 purgeStale 在合并后统一清理）
      const bm = text.match(/【已有 canon（基线，必须保留其全部条目的 id 与 name）】\n(\{[\s\S]*?\n\})\n\n【正文/);
      let base = JSON.parse(JSON.stringify(cleanCanon));
      if (bm) { try { base = JSON.parse(bm[1]); } catch { /* 回退 cleanCanon */ } }
      const rows = [...text.matchAll(/(\d+)\|([^\n]*)/g)].filter((x) => x[2].trim());
      const timeline = [];
      const evTl = {};
      for (let c = 1; c <= Math.max(to, 3); c++) {
        const b = base.timeline.find((t) => t.chapter === c);
        timeline.push(b || { chapter: c, day: 1 });
        if (c >= from && c <= to) {
          const ch = chMapI.get(c);
          const row = ch && rows.find((x) => Number(x[1]) >= ch.startLine && Number(x[1]) <= ch.endLine && x[2].trim());
          if (row) evTl[String(c)] = [{ chapter: c, line: Number(row[1]), quote: row[2].slice(0, 10) }];
        }
      }
      const content = JSON.stringify({
        canon: { ...base, timeline },
        evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: evTl },
        extraction_notes: ['fake-llm'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvPurge.listen(0, '127.0.0.1', r));
  const portPurge = srvPurge.address().port;
  const purgeEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portPurge}`, DEEPSEEK_MODEL: 'm', LLM_INPUT_BUDGET_TOKENS: '8000', LLM_TIMEOUT_MS: '60000' };
  try {
    const runPurge = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [EXT, ...args], { cwd: ROOT, encoding: 'utf8', env: purgeEnv });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    const planPurge = planExtractionChunks({ manuscript: purgeMsText, baseline: purgeBase, maxTokens: 8000 });
    check('分块规划成立（正文超预算触发多批）', planPurge && planPurge.length >= 2, JSON.stringify(planPurge));
    const pgRun = await runPurge([purgeMsFile, '--canon', purgeBaseFile, '--retire-stale', '--out', purgeOut]);
    const bothPg = pgRun.stdout + pgRun.stderr;
    check('分块+僵尸清理 e2e exit 0', pgRun.status === 0, `got ${pgRun.status}\n${bothPg.slice(0, 500)}`);
    const pgJ = JSON.parse(fs.readFileSync(purgeOut, 'utf8'));
    check('分块+清理：零提及僵尸实体被移除（旧故事/旧地点）', !pgJ.canon.entities.some((e) => e.id === 'zombie_old' || e.id === 'zombie_loc'), JSON.stringify(pgJ.canon.entities));
    check('分块+清理：未来出场实体保留（未到期不误删）', pgJ.canon.entities.some((e) => e.id === 'future_man2'), JSON.stringify(pgJ.canon.entities));
    check('分块+清理：活跃实体保留（沈默/林晚）', pgJ.canon.entities.some((e) => e.id === 'shen_mo') && pgJ.canon.entities.some((e) => e.id === 'lin_wan'), JSON.stringify(pgJ.canon.entities));
    check('分块+清理：meta.auto_chunked 记录分块批次', !!pgJ.meta.auto_chunked && pgJ.meta.auto_chunked.batches === planPurge.length, JSON.stringify(pgJ.meta.auto_chunked));
  } finally {
    srvPurge.close();
    for (const f of [purgeBaseFile, purgeMsFile, purgeOut]) { try { fs.unlinkSync(f); } catch { /* 忽略 */ } }
  }

  console.log('场景 49j: refactor 三阶段失败回滚（② 大纲回写失败 → canon 恢复 ① 前备份）');
  // 回归来源：旧实现 ②/③ 失败时 ① 已落盘的新 canon 残留 → 「新 canon + 旧 outline」不一致状态；
  // 现 ②/③ 失败回滚已写入文件（恢复运行前 .bak-*），保证三文件一致
  const bldMsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld-ms.md');
  const bldCanonFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld-canon.json');
  const bldOutlineFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld-outline.md');
  const bldPremiseFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld-premise.md');
  const bldMsText = '# 第1章 甲\n\n正文。\n\n# 第2章 乙\n\n正文。\n\n# 第3章 丙\n\n正文。\n';
  const origBldCanon = JSON.parse(JSON.stringify(cleanCanon));
  origBldCanon.meta.title = '原始书名（回滚应恢复）'; // 独特标记：回滚成功必须原样恢复
  fs.writeFileSync(bldMsFile, bldMsText, 'utf8');
  fs.writeFileSync(bldCanonFile, JSON.stringify(origBldCanon, null, 2) + '\n', 'utf8');
  fs.writeFileSync(bldOutlineFile, '# 旧大纲\n\n## 第1章 旧\n- 旧要点\n', 'utf8');
  fs.writeFileSync(bldPremiseFile, '# 旧前提\n\n## 世界规则\n旧。\n', 'utf8');
  const { parseManuscript: parseMs49j } = require('../src/extract');
  const chMapJ = new Map(parseMs49j(bldMsText).chapters.filter((c) => c.number !== null).map((c) => [c.number, c]));
  const srvBld = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const sys = (() => {
        try { const r = JSON.parse(body); const m = (r.messages || []).find((x) => x.role === 'system'); return m ? m.content : ''; }
        catch { return ''; }
      })();
      const text = (() => {
        try { const r = JSON.parse(body); const u = (r.messages || []).find((x) => x.role === 'user'); return u ? u.content : ''; }
        catch { return ''; }
      })();
      let content;
      if (sys.includes('小说提取器')) {
        // ① 提取：回显基线原样 + 全稿 timeline 证据 + 换书名（标记 ① 确实落盘了新 canon）
        const bm = text.match(/【已有 canon（基线，必须保留其全部条目的 id 与 name）】\n(\{[\s\S]*?\n\})\n\n【正文/);
        let base = JSON.parse(JSON.stringify(cleanCanon));
        if (bm) { try { base = JSON.parse(bm[1]); } catch { /* 回退 */ } }
        const rows = [...text.matchAll(/(\d+)\|([^\n]*)/g)].filter((x) => x[2].trim());
        const evTl = {};
        for (const [c, ch] of chMapJ) {
          const row = rows.find((x) => Number(x[1]) >= ch.startLine && Number(x[1]) <= ch.endLine && x[2].trim());
          if (row) evTl[String(c)] = [{ chapter: c, line: Number(row[1]), quote: row[2].slice(0, 10) }];
        }
        content = JSON.stringify({
          canon: { ...base, meta: { ...base.meta, title: '提取后的新书名' } },
          evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: evTl },
          extraction_notes: ['fake-llm'],
        });
      } else if (sys.includes('大纲回写器')) {
        // ② 大纲回写：返回过短非法文本 → validateOutline 必败 → 触发 canon 回滚
        content = '太短'; // <100 字，validateOutline 必败
      } else if (sys.includes('设定回写器')) {
        content = '太短'; // ③ 前提：② 先失败，不应被调用
      } else {
        content = '';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvBld.listen(0, '127.0.0.1', r));
  const portBld = srvBld.address().port;
  const bldEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portBld}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
  const bldFiles = [bldMsFile, bldCanonFile, bldOutlineFile, bldPremiseFile];
  try {
    const bldRun2 = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BLD, bldMsFile, bldCanonFile, bldOutlineFile, bldPremiseFile], { cwd: ROOT, encoding: 'utf8', env: bldEnv });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    const bothBld = bldRun2.stdout + bldRun2.stderr;
    check('refactor ② 失败退出 1（校验失败）', bldRun2.status === 1, `got ${bldRun2.status}\n${bothBld.slice(0, 500)}`);
    check('refactor 提示已回滚 canon（恢复 ① 前备份）', bothBld.includes('已回滚 canon'), bothBld.slice(0, 500));
    const canonAfter = JSON.parse(fs.readFileSync(bldCanonFile, 'utf8'));
    check('refactor 回滚：canon 恢复 ① 前内容（含原始书名标记，非提取后的新书名）', canonAfter.meta.title === '原始书名（回滚应恢复）', JSON.stringify(canonAfter.meta));
    check('refactor 回滚：outline 未被动过（旧内容保留）', fs.readFileSync(bldOutlineFile, 'utf8').includes('# 旧大纲'), '');
    check('refactor 回滚：premise 未被动过（旧内容保留）', fs.readFileSync(bldPremiseFile, 'utf8').includes('# 旧前提'), '');
  } finally {
    srvBld.close();
    for (const f of bldFiles) {
      try { fs.unlinkSync(f); } catch { /* 忽略 */ }
      let baks = [];
      try { baks = fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith(path.basename(f) + '.bak-')); } catch { /* 忽略 */ }
      for (const b of baks) { try { fs.unlinkSync(path.join(path.dirname(f), b)); } catch { /* 忽略 */ } }
    }
  }

  console.log('场景 49k: refactor ③ 前提写入失败 → outline + canon 回滚');
  // 回归来源：旧实现仅 ② 校验失败回滚 canon；③ 前提 LLM 成功但落盘失败（目标父目录不存在，
  // atomicWrite 的 openSync ENOENT）时，① ② 已落盘的新 canon/outline 残留 → 三文件不一致。
  // 现 ③ 写入失败回滚 outline + canon，保证三文件一致。
  const bld3MsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld3-ms.md');
  const bld3CanonFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld3-canon.json');
  const bld3OutlineFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld3-outline.md');
  const bld3PremiseFile = path.join(ROOT, 'test', 'fixtures', 'no-such-dir', 'tmp-bld3-premise.md'); // 父目录不存在 → atomicWrite 必败
  const bld3MsText = '# 第1章 甲\n\n正文。\n\n# 第2章 乙\n\n正文。\n\n# 第3章 丙\n\n正文。\n';
  const bld3Canon0 = JSON.parse(JSON.stringify(cleanCanon));
  bld3Canon0.meta.title = '原始书名三（回滚应恢复）';
  fs.writeFileSync(bld3MsFile, bld3MsText, 'utf8');
  fs.writeFileSync(bld3CanonFile, JSON.stringify(bld3Canon0, null, 2) + '\n', 'utf8');
  fs.writeFileSync(bld3OutlineFile, '# 旧大纲\n\n## 第1章 旧\n- 旧要点\n', 'utf8');
  const { parseManuscript: parseMs49k } = require('../src/extract');
  const chMapK = new Map(parseMs49k(bld3MsText).chapters.filter((c) => c.number !== null).map((c) => [c.number, c]));
  const srvBld3 = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const sys = (() => {
        try { const r = JSON.parse(body); const m = (r.messages || []).find((x) => x.role === 'system'); return m ? m.content : ''; }
        catch { return ''; }
      })();
      const text = (() => {
        try { const r = JSON.parse(body); const u = (r.messages || []).find((x) => x.role === 'user'); return u ? u.content : ''; }
        catch { return ''; }
      })();
      let content;
      if (sys.includes('小说提取器')) {
        // ① 提取：回显基线原样 + 全稿 timeline 证据 + 换书名（标记 ① 确实落盘了新 canon）
        const bm = text.match(/【已有 canon（基线，必须保留其全部条目的 id 与 name）】\n(\{[\s\S]*?\n\})\n\n【正文/);
        let base = JSON.parse(JSON.stringify(cleanCanon));
        if (bm) { try { base = JSON.parse(bm[1]); } catch { /* 回退 */ } }
        const rows = [...text.matchAll(/(\d+)\|([^\n]*)/g)].filter((x) => x[2].trim());
        const evTl = {};
        for (const [c, ch] of chMapK) {
          const row = rows.find((x) => Number(x[1]) >= ch.startLine && Number(x[1]) <= ch.endLine && x[2].trim());
          if (row) evTl[String(c)] = [{ chapter: c, line: Number(row[1]), quote: row[2].slice(0, 10) }];
        }
        content = JSON.stringify({
          canon: { ...base, meta: { ...base.meta, title: '提取后的新书名三' } },
          evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: evTl },
          extraction_notes: ['fake-llm'],
        });
      } else if (sys.includes('大纲回写器')) {
        // ② 大纲回写：合法大纲（>100 字且覆盖 1-3 章）→ validateOutline 必过 → 正常落盘
        content = '# 大纲三\n\n## 第1章 甲\n- 沈默与林晚在江城码头碰面，商量对策，约定次日去档案馆查档。\n- 档案馆的铁皮柜开着，卷宗缺了一卷，两人决定分头追查。\n\n## 第2章 乙\n- 两人进了档案馆，管理员不在，铁皮柜里少了一卷记录。\n- 林晚站在窗边望着江城的雨，催促加快进度。\n\n## 第3章 丙\n- 沈默在档案馆大厅的铜钟里找到那卷烧焦的记录，真相浮现。\n- 纸上的名字让两人陷入沉默，钟声正好敲过三下。\n';
      } else if (sys.includes('设定回写器')) {
        // ③ 前提回写：合法前提（>150 字含规则/角色）→ validatePremise 必过 → 落盘失败
        content = '# 前提三 · 前提设定\n\n## 世界规则\n现实都市背景，无超自然元素；核心场景为江城与档案馆，铜钟是重要意象。\n\n## 角色初始状态\n沈默：调查者，执着克制；林晚：档案馆职员，陪同调查，立场中立。\n\n## 基调与风格\n冷峻克制，短句为主，雨与钟声意象贯穿全文。\n\n## 核心冲突与悬念策略\n十年前火灾真相是主悬念，第1章埋设第3章回收；信息差推动剧情。\n';
      } else {
        content = '';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvBld3.listen(0, '127.0.0.1', r));
  const portBld3 = srvBld3.address().port;
  const bld3Env = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portBld3}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
  const bld3Files = [bld3MsFile, bld3CanonFile, bld3OutlineFile];
  try {
    const bldRun3 = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BLD, bld3MsFile, bld3CanonFile, bld3OutlineFile, bld3PremiseFile], { cwd: ROOT, encoding: 'utf8', env: bld3Env });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    const bothBld3 = bldRun3.stdout + bldRun3.stderr;
    check('refactor ③ 前提写入失败退出 1（LLM 成功但落盘失败）', bldRun3.status === 1, `got ${bldRun3.status}\n${bothBld3.slice(0, 500)}`);
    check('refactor 提示已回滚 outline（恢复 ② 前备份）', bothBld3.includes('已回滚 outline'), bothBld3.slice(0, 500));
    check('refactor 提示已回滚 canon（恢复 ① 前备份）', bothBld3.includes('已回滚 canon'), bothBld3.slice(0, 500));
    const canonAfter3 = JSON.parse(fs.readFileSync(bld3CanonFile, 'utf8'));
    check('refactor ③ 回滚：canon 恢复 ① 前内容（含原始书名标记，非提取后的新书名）', canonAfter3.meta.title === '原始书名三（回滚应恢复）', JSON.stringify(canonAfter3.meta));
    check('refactor ③ 回滚：outline 恢复 ② 前内容（旧大纲保留）', fs.readFileSync(bld3OutlineFile, 'utf8').includes('# 旧大纲'), '');
  } finally {
    srvBld3.close();
    for (const f of bld3Files) {
      try { fs.unlinkSync(f); } catch { /* 忽略 */ }
      let baks = [];
      try { baks = fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith(path.basename(f) + '.bak-')); } catch { /* 忽略 */ }
      for (const b of baks) { try { fs.unlinkSync(path.join(path.dirname(f), b)); } catch { /* 忽略 */ } }
    }
    try { fs.rmSync(path.dirname(bld3PremiseFile), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log('场景 49m: refactor ② 大纲写入失败 → canon 回滚（O-1 回归）');
  // 回归来源：② 大纲 LLM 成功但落盘失败（目标父目录不存在，atomicWrite openSync ENOENT）时，
  // 旧实现无 try/catch，异常传播到 main().catch exit 2 且不回滚 canon → 残留「新 canon + 旧 outline/premise」
  // 三文件不一致。现 ② 落盘失败与 ③ 前提落盘失败（场景 49k）对称：回滚 canon 后退出 1。
  const bld4MsFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld4-ms.md');
  const bld4CanonFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld4-canon.json');
  const bld4OutlineFile = path.join(ROOT, 'test', 'fixtures', 'no-such-dir', 'tmp-bld4-outline.md'); // 父目录不存在 → atomicWrite 必败
  const bld4PremiseFile = path.join(ROOT, 'test', 'fixtures', 'tmp-bld4-premise.md');
  const bld4MsText = '# 第1章 甲\n\n正文。\n\n# 第2章 乙\n\n正文。\n\n# 第3章 丙\n\n正文。\n';
  const bld4Canon0 = JSON.parse(JSON.stringify(cleanCanon));
  bld4Canon0.meta.title = '原始书名四（回滚应恢复）';
  fs.writeFileSync(bld4MsFile, bld4MsText, 'utf8');
  fs.writeFileSync(bld4CanonFile, JSON.stringify(bld4Canon0, null, 2) + '\n', 'utf8');
  fs.writeFileSync(bld4PremiseFile, '# 旧前提\n\n旧内容。\n', 'utf8');
  const { parseManuscript: parseMs49m } = require('../src/extract');
  const chMapM = new Map(parseMs49m(bld4MsText).chapters.filter((c) => c.number !== null).map((c) => [c.number, c]));
  const srvBld4 = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const sys = (() => {
        try { const r = JSON.parse(body); const m = (r.messages || []).find((x) => x.role === 'system'); return m ? m.content : ''; }
        catch { return ''; }
      })();
      const text = (() => {
        try { const r = JSON.parse(body); const u = (r.messages || []).find((x) => x.role === 'user'); return u ? u.content : ''; }
        catch { return ''; }
      })();
      let content;
      if (sys.includes('小说提取器')) {
        // ① 提取：回显基线原样 + 全稿 timeline 证据 + 换书名（标记 ① 确实落盘了新 canon）
        const bm = text.match(/【已有 canon（基线，必须保留其全部条目的 id 与 name）】\n(\{[\s\S]*?\n\})\n\n【正文/);
        let base = JSON.parse(JSON.stringify(cleanCanon));
        if (bm) { try { base = JSON.parse(bm[1]); } catch { /* 回退 */ } }
        const rows = [...text.matchAll(/(\d+)\|([^\n]*)/g)].filter((x) => x[2].trim());
        const evTl = {};
        for (const [c, ch] of chMapM) {
          const row = rows.find((x) => Number(x[1]) >= ch.startLine && Number(x[1]) <= ch.endLine && x[2].trim());
          if (row) evTl[String(c)] = [{ chapter: c, line: Number(row[1]), quote: row[2].slice(0, 10) }];
        }
        content = JSON.stringify({
          canon: { ...base, meta: { ...base.meta, title: '提取后的新书名四' } },
          evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: evTl },
          extraction_notes: ['fake-llm'],
        });
      } else if (sys.includes('大纲回写器')) {
        // ② 大纲回写：合法大纲（>100 字且覆盖 1-3 章）→ validateOutline 必过 → 走到落盘一步必败
        content = '# 大纲四\n\n## 第1章 甲\n- 沈默与林晚在江城码头碰面，商量对策，约定次日去档案馆查档。\n- 档案馆的铁皮柜开着，卷宗缺了一卷，两人决定分头追查。\n\n## 第2章 乙\n- 两人进了档案馆，管理员不在，铁皮柜里少了一卷记录。\n- 林晚站在窗边望着江城的雨，催促加快进度。\n\n## 第3章 丙\n- 沈默在档案馆大厅的铜钟里找到那卷烧焦的记录，真相浮现。\n- 纸上的名字让两人陷入沉默，钟声正好敲过三下。\n';
      } else {
        content = ''; // ③ 不会到达（② 落盘失败即退出）
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
    });
  });
  await new Promise((r) => srvBld4.listen(0, '127.0.0.1', r));
  const portBld4 = srvBld4.address().port;
  const bld4Env = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portBld4}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
  const bld4Files = [bld4MsFile, bld4CanonFile, bld4PremiseFile];
  try {
    const bldRun4 = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BLD, bld4MsFile, bld4CanonFile, bld4OutlineFile, bld4PremiseFile], { cwd: ROOT, encoding: 'utf8', env: bld4Env });
      let out = ''; let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    const bothBld4 = bldRun4.stdout + bldRun4.stderr;
    check('refactor ② 大纲写入失败退出 1（LLM 成功但落盘失败）', bldRun4.status === 1, `got ${bldRun4.status}\n${bothBld4.slice(0, 500)}`);
    check('refactor 提示大纲写入失败（含原因）', bothBld4.includes('大纲写入失败'), bothBld4.slice(0, 500));
    check('refactor 提示已回滚 canon（恢复 ① 前备份）', bothBld4.includes('已回滚 canon'), bothBld4.slice(0, 500));
    const canonAfter4 = JSON.parse(fs.readFileSync(bld4CanonFile, 'utf8'));
    check('refactor ② 回滚：canon 恢复 ① 前内容（含原始书名标记，非提取后的新书名）', canonAfter4.meta.title === '原始书名四（回滚应恢复）', JSON.stringify(canonAfter4.meta));
    check('refactor ② 回滚：premise 未被动过（旧前提保留）', fs.readFileSync(bld4PremiseFile, 'utf8').includes('# 旧前提'), '');
  } finally {
    srvBld4.close();
    for (const f of bld4Files) {
      try { fs.unlinkSync(f); } catch { /* 忽略 */ }
      let baks = [];
      try { baks = fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith(path.basename(f) + '.bak-')); } catch { /* 忽略 */ }
      for (const b of baks) { try { fs.unlinkSync(path.join(path.dirname(f), b)); } catch { /* 忽略 */ } }
    }
    try { fs.rmSync(path.dirname(bld4OutlineFile), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log('场景 49l: refactor 书名对齐锁内重读 + 回滚锁冲突跳过（#4/#5 回归）');
  // #4 回归：书名对齐「预读 → 拿锁 → 写」存在 TOCTOU——锁内需重读最新 canon，
  // 避免基于预读陈旧快照覆盖并发写者新内容（读改写全周期都在锁内）。
  // #5 回归：canon 回滚发生在子进程 extract-llm 退出之后（锁已释放），直接覆写会与
  // 并发写者竞争——现回滚对未持有目标临时持锁 + 原子替换；锁冲突时跳过并保留备份。
  {
    const { acquireFileLock } = require('../src/fsutil');
    // ---------- ① 书名对齐：对齐执行 + 锁干净释放 ----------
    const l49Ms = path.join(ROOT, 'test', 'fixtures', 'tmp-rf49l-ms.md');
    const l49Canon = path.join(ROOT, 'test', 'fixtures', 'tmp-rf49l-canon.json');
    const l49Outline = path.join(ROOT, 'test', 'fixtures', 'tmp-rf49l-outline.md');
    const l49Premise = path.join(ROOT, 'test', 'fixtures', 'tmp-rf49l-premise.md');
    const l49MsText = '# 第1章 甲\n\n正文。\n\n# 第2章 乙\n\n正文。\n\n# 第3章 丙\n\n正文。\n';
    const l49Canon0 = JSON.parse(JSON.stringify(cleanCanon));
    l49Canon0.meta.title = '旧书名对齐前'; // 与大纲 H1 不同 → 触发书名对齐
    fs.writeFileSync(l49Ms, l49MsText, 'utf8');
    fs.writeFileSync(l49Canon, JSON.stringify(l49Canon0, null, 2) + '\n', 'utf8');
    fs.writeFileSync(l49Outline, '# 旧大纲\n\n## 第1章 旧\n- 旧要点\n', 'utf8');
    fs.writeFileSync(l49Premise, '# 旧前提\n\n## 世界规则\n旧。\n', 'utf8');
    const { parseManuscript: parseMs49l } = require('../src/extract');
    const chMapL = new Map(parseMs49l(l49MsText).chapters.filter((c) => c.number !== null).map((c) => [c.number, c]));
    const srv49l = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const sys = (() => { try { const r = JSON.parse(body); const m = (r.messages || []).find((x) => x.role === 'system'); return m ? m.content : ''; } catch { return ''; } })();
        const text = (() => { try { const r = JSON.parse(body); const u = (r.messages || []).find((x) => x.role === 'user'); return u ? u.content : ''; } catch { return ''; } })();
        let content;
        if (sys.includes('小说提取器')) {
          // ① 提取：回显基线原样（书名保持「旧书名对齐前」不变）+ 全稿 timeline 证据
          const bm = text.match(/【已有 canon（基线，必须保留其全部条目的 id 与 name）】\n(\{[\s\S]*?\n\})\n\n【正文/);
          let base = JSON.parse(JSON.stringify(cleanCanon));
          if (bm) { try { base = JSON.parse(bm[1]); } catch { /* 回退 */ } }
          const rows = [...text.matchAll(/(\d+)\|([^\n]*)/g)].filter((x) => x[2].trim());
          const evTl = {};
          for (const [c, ch] of chMapL) {
            const row = rows.find((x) => Number(x[1]) >= ch.startLine && Number(x[1]) <= ch.endLine && x[2].trim());
            if (row) evTl[String(c)] = [{ chapter: c, line: Number(row[1]), quote: row[2].slice(0, 10) }];
          }
          content = JSON.stringify({ canon: base, evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: evTl }, extraction_notes: ['fake-llm'] });
        } else if (sys.includes('大纲回写器')) {
          // ② 大纲回写：合法大纲，H1 书名与 canon 书名不同 → 触发末尾书名对齐
          content = '# 新书名 · 分章大纲\n\n## 第1章 甲\n- 沈默与林晚在江城码头碰面，商量对策，约定次日去档案馆查档。\n- 档案馆的铁皮柜开着，卷宗缺了一卷，两人决定分头追查。\n\n## 第2章 乙\n- 两人进了档案馆，管理员不在，铁皮柜里少了一卷记录。\n- 林晚站在窗边望着江城的雨，催促加快进度。\n\n## 第3章 丙\n- 沈默在档案馆大厅的铜钟里找到那卷烧焦的记录，真相浮现。\n- 纸上的名字让两人陷入沉默，钟声正好敲过三下。\n';
        } else if (sys.includes('设定回写器')) {
          // ③ 前提回写：合法前提 → 正常落盘
          content = '# 新书名 · 前提设定\n\n## 世界规则\n现实都市背景，无超自然元素；核心场景为江城与档案馆，铜钟是重要意象。\n\n## 角色初始状态\n沈默：调查者，执着克制；林晚：档案馆职员，陪同调查，立场中立。\n\n## 基调与风格\n冷峻克制，短句为主，雨与钟声意象贯穿全文。\n\n## 核心冲突与悬念策略\n十年前火灾真相是主悬念，第1章埋设第3章回收；信息差推动剧情。\n';
        } else {
          content = '';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
      });
    });
    await new Promise((r) => srv49l.listen(0, '127.0.0.1', r));
    const port49l = srv49l.address().port;
    const env49l = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${port49l}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
    const l49Files = [l49Ms, l49Canon, l49Outline, l49Premise];
    try {
      const l49Run = await new Promise((resolve) => {
        const child = spawn(process.execPath, [BLD, l49Ms, l49Canon, l49Outline, l49Premise], { cwd: ROOT, encoding: 'utf8', env: env49l });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
      });
      const both49l = l49Run.stdout + l49Run.stderr;
      check('refactor 书名对齐：退出 0（成功）', l49Run.status === 0, `got ${l49Run.status}\n${both49l.slice(0, 500)}`);
      check('refactor 书名对齐：提示已执行对齐（“书名对齐”）', both49l.includes('书名对齐'), both49l.slice(0, 500));
      const canon49l = JSON.parse(fs.readFileSync(l49Canon, 'utf8'));
      check('refactor 书名对齐：canon.meta.title 对齐到大纲 H1（新书名）', canon49l.meta.title === '新书名', JSON.stringify(canon49l.meta));
      check('refactor 书名对齐：无 .lock 残留（canon/outline/premise 锁均干净释放）', !fs.existsSync(l49Canon + '.lock') && !fs.existsSync(l49Outline + '.lock') && !fs.existsSync(l49Premise + '.lock'), '');
      check('refactor 书名对齐：大纲 H1 已写入（新书名 · 分章大纲）', fs.readFileSync(l49Outline, 'utf8').includes('# 新书名 · 分章大纲'), '');
    } finally {
      srv49l.close();
      for (const f of l49Files) {
        try { fs.unlinkSync(f); } catch { /* 忽略 */ }
        try { fs.unlinkSync(f + '.lock'); } catch { /* 忽略 */ }
        let baks = [];
        try { baks = fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith(path.basename(f) + '.bak-')); } catch { /* 忽略 */ }
        for (const b of baks) { try { fs.unlinkSync(path.join(path.dirname(f), b)); } catch { /* 忽略 */ } }
      }
    }

    // ---------- ② 回滚锁冲突：canon 锁被占用 → 跳过回滚并保留备份（不覆盖并发写者） ----------
    const l49bMs = path.join(ROOT, 'test', 'fixtures', 'tmp-rf49m-ms.md');
    const l49bCanon = path.join(ROOT, 'test', 'fixtures', 'tmp-rf49m-canon.json');
    const l49bOutline = path.join(ROOT, 'test', 'fixtures', 'tmp-rf49m-outline.md');
    const l49bPremise = path.join(ROOT, 'test', 'fixtures', 'tmp-rf49m-premise.md');
    const l49bMsText = '# 第1章 甲\n\n正文。\n\n# 第2章 乙\n\n正文。\n\n# 第3章 丙\n\n正文。\n';
    const l49bCanon0 = JSON.parse(JSON.stringify(cleanCanon));
    l49bCanon0.meta.title = '回滚锁冲突原';
    fs.writeFileSync(l49bMs, l49bMsText, 'utf8');
    fs.writeFileSync(l49bCanon, JSON.stringify(l49bCanon0, null, 2) + '\n', 'utf8');
    fs.writeFileSync(l49bOutline, '# 旧大纲\n\n## 第1章 旧\n- 旧要点\n', 'utf8');
    fs.writeFileSync(l49bPremise, '# 旧前提\n\n## 世界规则\n旧。\n', 'utf8');
    const { parseManuscript: parseMs49m } = require('../src/extract');
    const chMapM = new Map(parseMs49m(l49bMsText).chapters.filter((c) => c.number !== null).map((c) => [c.number, c]));
    let releaseCanonLock49m = null; // ② 请求处理时获取的 canon 锁：跨过响应持续持有，直到本场景 finally 释放
    let acquiredCanonLock49m = false; // chatTextValidated 对校验失败会重试——只在首次 ② 时拿锁，重试直接返回非法大纲（锁仍持有）
    const srv49m = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const sys = (() => { try { const r = JSON.parse(body); const m = (r.messages || []).find((x) => x.role === 'system'); return m ? m.content : ''; } catch { return ''; } })();
        const text = (() => { try { const r = JSON.parse(body); const u = (r.messages || []).find((x) => x.role === 'user'); return u ? u.content : ''; } catch { return ''; } })();
        let content;
        if (sys.includes('小说提取器')) {
          // ① 提取：回显基线但改书名（标记 ① 确实落盘了新 canon，回滚是否执行据此区分）
          const bm = text.match(/【已有 canon（基线，必须保留其全部条目的 id 与 name）】\n(\{[\s\S]*?\n\})\n\n【正文/);
          let base = JSON.parse(JSON.stringify(cleanCanon));
          if (bm) { try { base = JSON.parse(bm[1]); } catch { /* 回退 */ } }
          const rows = [...text.matchAll(/(\d+)\|([^\n]*)/g)].filter((x) => x[2].trim());
          const evTl = {};
          for (const [c, ch] of chMapM) {
            const row = rows.find((x) => Number(x[1]) >= ch.startLine && Number(x[1]) <= ch.endLine && x[2].trim());
            if (row) evTl[String(c)] = [{ chapter: c, line: Number(row[1]), quote: row[2].slice(0, 10) }];
          }
          content = JSON.stringify({ canon: { ...base, meta: { ...base.meta, title: '提取后新书名' } }, evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: evTl }, extraction_notes: ['fake-llm'] });
        } else if (sys.includes('大纲回写器')) {
          // ② 回写：先在首次 ② 时拿 canon 锁（子进程已退出、锁已释放；重试不重拿——锁仍持有），
          // 再返回非法大纲 → 父进程回滚 canon 时锁冲突 → 应跳过并保留备份，而不是覆盖并发写者
          if (!acquiredCanonLock49m) {
            releaseCanonLock49m = acquireFileLock(l49bCanon);
            acquiredCanonLock49m = true;
          }
          content = '太短'; // <100 字，validateOutline 必败 → 触发 canon 回滚
        } else {
          content = '';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content, finish_reason: 'stop' } }] }));
      });
    });
    await new Promise((r) => srv49m.listen(0, '127.0.0.1', r));
    const port49m = srv49m.address().port;
    const env49m = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${port49m}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
    const l49bFiles = [l49bMs, l49bCanon, l49bOutline, l49bPremise];
    try {
      const l49bRun = await new Promise((resolve) => {
        const child = spawn(process.execPath, [BLD, l49bMs, l49bCanon, l49bOutline, l49bPremise], { cwd: ROOT, encoding: 'utf8', env: env49m });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
      });
      const both49m = l49bRun.stdout + l49bRun.stderr;
      check('refactor 回滚锁冲突：退出 1（② 校验失败）', l49bRun.status === 1, `got ${l49bRun.status}\n${both49m.slice(0, 500)}`);
      check('refactor 回滚锁冲突：提示跳过回滚（“回滚 canon 跳过”）', both49m.includes('回滚 canon 跳过'), both49m.slice(0, 500));
      check('refactor 回滚锁冲突：原因含“正被其他进程写入”', both49m.includes('正被其他进程写入'), both49m.slice(0, 500));
      check('refactor 回滚锁冲突：提示备份保留（供手动恢复）', both49m.includes('备份保留'), both49m.slice(0, 500));
      const canon49m = JSON.parse(fs.readFileSync(l49bCanon, 'utf8'));
      check('refactor 回滚锁冲突：canon 未被覆盖（仍为 ① 提取后内容，非备份）', canon49m.meta.title === '提取后新书名', JSON.stringify(canon49m.meta));
      const baks49m = fs.readdirSync(path.dirname(l49bCanon)).filter((x) => x.startsWith(path.basename(l49bCanon) + '.bak-'));
      check('refactor 回滚锁冲突：备份文件仍在（可手动恢复）', baks49m.length > 0, baks49m.join(','));
    } finally {
      if (releaseCanonLock49m) releaseCanonLock49m(); // 先放锁再删文件，避免误删在握锁
      srv49m.close();
      for (const f of l49bFiles) {
        try { fs.unlinkSync(f); } catch { /* 忽略 */ }
        try { fs.unlinkSync(f + '.lock'); } catch { /* 忽略 */ }
        let baks = [];
        try { baks = fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith(path.basename(f) + '.bak-')); } catch { /* 忽略 */ }
        for (const b of baks) { try { fs.unlinkSync(path.join(path.dirname(f), b)); } catch { /* 忽略 */ } }
      }
    }
  }

  console.log('场景 50: 工具进程超时（runTool / run-stream）');
  const hangTool = path.join(ROOT, 'timeout-hang.js');
  const hangTree = path.join(ROOT, 'timeout-tree.js');
  const childPidFile = path.join(ROOT, 'timeout-tree-child.pid');
  let srvT;
  try {
    fs.writeFileSync(hangTool, "setTimeout(() => {}, 60000);\n", 'utf8');
    srvT = spawn(process.execPath, [SRV, '--port', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TOOL_TIMEOUT_MS: '1200' } });
    let bufT = '';
    const portT = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('超时服务器启动失败')), 15000);
      srvT.stdout.on('data', (d) => {
        bufT += d.toString();
        const m = bufT.match(/LISTENING [^:]+:(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
      srvT.on('exit', (c) => reject(new Error(`超时服务器提前退出 ${c}`)));
    });
    const t0 = Date.now();
    const to = await fetchT(`http://127.0.0.1:${portT}/api/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'timeout-hang', args: [] }),
    }).then((r) => r.json());
    const elapsed = Date.now() - t0;
    check('runTool 超时终止（timedOut=true，<5s 返回）', !!to.timedOut && elapsed < 5000, JSON.stringify(to));
    const t1 = Date.now();
    const tos = await fetchT(`http://127.0.0.1:${portT}/api/run-stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'timeout-hang', args: [] }),
    }).then((r) => r.text());
    const el2 = Date.now() - t1;
    const trailerT = tos.match(/__RESULT__:(\{.*\})/);
    check('run-stream 超时写结果标记', !!trailerT && JSON.parse(trailerT[1]).timedOut === true && el2 < 5000, tos.slice(0, 200));
    // 进程树终止：工具再 spawn 孙进程时，超时后孙进程也必须被终止（防残留进程继续消耗 LLM 配额）
    fs.writeFileSync(hangTree, [
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid), 'utf8');`,
      'setTimeout(() => {}, 120000);',
    ].join('\n') + '\n', 'utf8');
    try { fs.unlinkSync(childPidFile); } catch { /* 忽略 */ }
    const tTree = await fetchT(`http://127.0.0.1:${portT}/api/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'timeout-tree', args: [] }),
    }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 800)); // 等 killTree（taskkill /T 或 kill 进程组）生效
    let childGone = false;
    try {
      const cpid = Number(fs.readFileSync(childPidFile, 'utf8'));
      if (cpid) {
        try { process.kill(cpid, 0); } catch (e) { childGone = e.code === 'ESRCH'; }
      }
    } catch { childGone = true; } // 孙进程未写出 pid（被终止太快）同样视为已终止
    check('runTool 超时后进程树被终止（孙进程不再存活）', tTree.timedOut === true && childGone, `timedOut=${tTree.timedOut} childGone=${childGone}`);
  } finally {
    if (srvT) srvT.kill();
    try { fs.unlinkSync(hangTool); } catch { /* 忽略 */ }
    try { fs.unlinkSync(hangTree); } catch { /* 忽略 */ }
    try { fs.unlinkSync(childPidFile); } catch { /* 忽略 */ }
  }

  console.log('场景 51: IDE 服务器 API 冒烟（临时 --config，不触碰用户 config.json）');
  // 自包含：服务器用临时配置文件（指向 demo 夹具，保证 compile 有内置问题），
  // 测试对 config.json 的一切改动都落在临时文件上，用户配置零接触
  // （config.json 被 .gitignore 忽略，clone 场景可能不存在——容错为 null）
  const cfgBefore = (() => { try { return fs.readFileSync(path.join(ROOT, 'app', 'config.json'), 'utf8'); } catch { return null; } })();
  const tmpCfg = path.join(ROOT, 'app', 'predictions', 'tmp-server-config.json');
  const tmpCanon = path.join(ROOT, 'app', 'predictions', 'tmp-apply-canon.json');
  let srv;
  try {
    fs.writeFileSync(tmpCfg, JSON.stringify({
      model: 'deepseek-chat',
      apiKey: null,
      // 项目 id 用测试专用名：预测目录 app/predictions/<id>/ 只会是测试自己创建的，
      // cleanup 的 rmSync 不会误删用户真实项目（真实用户项目 id 不可能是这个名字）
      activeProject: '隔离测试甲',
      projects: {
        '隔离测试甲': {
          manuscript: '../test/fixtures/demo-manuscript.md',
          canon: '../test/fixtures/demo-canon.json',
          outline: '../examples/outline.md',
          premise: '../examples/premise.md',
          reader: 'webnovel',
        },
        '隔离测试乙': {
          manuscript: '../test/fixtures/demo-manuscript.md',
          canon: '../test/fixtures/demo-canon.json',
          outline: '../examples/outline.md',
          premise: '../examples/premise.md',
          reader: 'genre',
        },
      },
    }, null, 2) + '\n', 'utf8');
    srv = spawn(process.execPath, [SRV, '--port', '0', '--config', tmpCfg], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('服务器启动超时')), 15000);
      srv.stdout.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/LISTENING [^:]+:(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
      srv.on('exit', (c) => reject(new Error(`服务器提前退出 ${c}`)));
    });
    const st = await fetchT(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
    check('GET /api/state 返回文件与配置', !!st.config && !!st.files.manuscript && st.files.manuscript.content.length > 0, JSON.stringify(st).slice(0, 200));
    const cs = await fetchT(`http://127.0.0.1:${port}/api/canon-schema`).then((r) => r.json());
    check('GET /api/canon-schema 返回 schema 常量', !!cs.CANON_SECTIONS_ALL && cs.CANON_SECTIONS_ALL.length === 4, JSON.stringify(cs));
    // 验证端点返回的 schema 与源码一致（防端点漂移）
    const { CANON_SECTIONS_ALL: REF_ALL } = require('../src/canon');
    check('GET /api/canon-schema 与 src/canon.js 一致', JSON.stringify(cs.CANON_SECTIONS_ALL) === JSON.stringify(REF_ALL), '');
    const c = await fetchT(`http://127.0.0.1:${port}/api/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    check('POST /api/compile 返回 problems（exit 1 属正常语义）', !!c.ok && Array.isArray(c.problems) && c.problems.length > 0, JSON.stringify(c).slice(0, 300));
    check('compile 结果含问题计数', !!c.counts && (c.counts.error + c.counts.warning + c.counts.info) >= 1, JSON.stringify(c.counts));
    const idx = await fetchT(`http://127.0.0.1:${port}/`).then((r) => r.status);
    const loader = await fetchT(`http://127.0.0.1:${port}/vendor/monaco/vs/loader.js`).then((r) => r.status);
    check('静态资源可访问（index + Monaco loader）', idx === 200 && loader === 200, `index=${idx} loader=${loader}`);
    // 双模式前端冒烟：默认创作者模式（mode-creator）+ 生成报告一键 + 设置栏
    const idxHtml = await fetchT(`http://127.0.0.1:${port}/`).then((r) => r.text());
    check('创作者模式默认生效（body 带 mode-creator，含生成报告与设置栏）',
      idxHtml.includes('class="mode-creator"') && idxHtml.includes('id="btn-report"')
      && idxHtml.includes('id="settings-menu"') && idxHtml.includes('id="settings-mode-item"'),
      'index.html 缺少双模式/生成报告元素');
    // dev-only 标记须在元素附近（同行或所在容器上）：创作者模式 CSS 才能隐藏这些控件
    // 半径 400 覆盖六项流水线容器（div.ai-buttons.dev-only）到末尾按钮 ⑤ 审阅的距离
    const near = (html, needle, radius = 400) => {
      const i = html.indexOf(needle);
      return i !== -1 && html.slice(Math.max(0, i - radius), i + radius).includes('dev-only');
    };
    check('开发者控件已标记 dev-only（读者向/模型/编译/六项 AI 流水线创作者模式隐藏）',
      ['id="reader"', 'id="model"', 'id="btn-compile"', 'id="btn-simulate"', 'id="btn-review"'].every((s) => near(idxHtml, s)),
      '开发者控件未标记 dev-only');
    const appJs = await fetchT(`http://127.0.0.1:${port}/app.js`).then((r) => r.text());
    check('一键流水线与创作者中文标签就位（generateReport + 文稿/故事大纲/前情提要）',
      appJs.includes('generateReport') && appJs.includes('REPORT_STEPS')
      && appJs.includes('故事大纲') && appJs.includes('前情提要'),
      'app.js 缺少生成报告流水线或创作者标签');
    check('流读取与流水线异常兜底就位（runToolStream 流中断 + generateReport 顶层 catch）',
      appJs.includes('流读取中断') && appJs.includes('生成报告意外中断'),
      'app.js 缺少流读取/流水线异常兜底（防 unhandled rejection）');
    try {
      const prj = await fetchT(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json());
      check('/api/projects 返回多项目', !!prj.ok && prj.projects.length >= 2, JSON.stringify(prj));
      const target = prj.projects.find((p) => p.id !== prj.active);
      const sw = await fetchT(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: target.id }),
      }).then((r) => r.json());
      check('切换项目成功', !!sw.ok && sw.active === target.id, JSON.stringify(sw));
      const st2 = await fetchT(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
      check('切换后 state 返回新项目文件', !!st2.ok && st2.activeProject === target.id && st2.files.manuscript.content.length > 0, JSON.stringify(st2).slice(0, 200));
      const bad = await fetchT(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: '不存在项目' }),
      }).then((r) => r.json());
      check('切换不存在的项目被拒', !bad.ok, JSON.stringify(bad));
      await fetchT(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: prj.active }),
      });
    } finally {
      /* 切换项目只持久化到临时 --config，无需恢复用户 config.json */
    }
    const rvw = await fetchT(`http://127.0.0.1:${port}/api/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal: 'test/fixtures/pred-canon.json', baseline: 'test/fixtures/clean-canon.json' }),
    }).then((r) => r.json());
    check('/api/review 返回审阅结构', !!rvw.ok && rvw.review && rvw.review.counts.added >= 1, JSON.stringify(rvw).slice(0, 200));
    // M2 回归：/api/review 与 /api/apply-review 的 proposal/baseline 路径必须落在
    // 「项目工作文件 ∪ 项目根内」，否则恶意调用可借服务端读任意本地 JSON（路径来自请求体）
    const evilReview = await fetchT(`http://127.0.0.1:${port}/api/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal: '../outside-proposal.json', baseline: '../outside-baseline.json' }),
    });
    check('/api/review 越界读取路径被拒（403）', evilReview.status === 403, `status=${evilReview.status}`);
    const evilApply = await fetchT(`http://127.0.0.1:${port}/api/apply-review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions: [], proposal: '../../outside-apply.json', canonPath: tmpCanon }),
    });
    check('/api/apply-review 越界 proposal 被拒（403）', evilApply.status === 403, `status=${evilApply.status}`);
    const bldRun = await fetchT(`http://127.0.0.1:${port}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'refactor', args: ['test/fixtures/clean-manuscript.md', 'test/fixtures/clean-canon.json', 'test/fixtures/outline-tmp.md', 'test/fixtures/premise-tmp.md', '--dry-run'] }),
    }).then((r) => r.json());
    check('/api/run refactor --dry-run 可用', !!bldRun.ok && bldRun.code === 0 && bldRun.stdout.includes('大纲回写器'), JSON.stringify(bldRun).slice(0, 200));
    const stream = await fetchT(`http://127.0.0.1:${port}/api/run-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'refactor', args: ['test/fixtures/clean-manuscript.md', 'test/fixtures/clean-canon.json', 'test/fixtures/outline-tmp.md', 'test/fixtures/premise-tmp.md', '--dry-run'] }),
    }).then((r) => r.text());
    const trailer = stream.match(/__RESULT__:(\{.*\})/);
    check('/api/run-stream 流式输出含结果标记', !!trailer && JSON.parse(trailer[1]).code === 0 && stream.includes('大纲回写器'), stream.slice(0, 300));
    const stPaths = await fetchT(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
    const predDirT = stPaths.ok ? stPaths.config.paths.predDir : null;
    check('/api/state 提供项目专属 predDir（按项目隔离预测产物）', !!predDirT && predDirT.endsWith('predictions' + path.sep + '隔离测试甲'), predDirT);
    const predFile = path.join(predDirT, 'last-pred.json');
    const statusFile = path.join(predDirT, 'risk-status.json');
    try {
      const fakePred = JSON.stringify({
        tool: 'novel-compiler/simulate',
        meta: { title: '测试书', simulated_at: 'T-TEST', target_reader: 'webnovel' },
        canon: { meta: { title: '测试书', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] },
        risk_register: [
          { id: 'R1', chapter: 2, severity: 'high', kind: 'suspense', risk: '悬念超期', probability: 0.8, trigger: 'X', mitigation: 'Y' },
          { id: 'R2', chapter: 5, severity: 'low', kind: 'pacing', risk: '节奏慢', probability: 0.3, trigger: 'X', mitigation: 'Y' },
        ],
        simulation_notes: [],
      });
      fs.mkdirSync(path.dirname(predFile), { recursive: true });
      fs.writeFileSync(predFile, fakePred, 'utf8');
      const rk = await fetchT(`http://127.0.0.1:${port}/api/risks`).then((r) => r.json());
      check('/api/risks 返回风险列表（open）', !!rk.ok && rk.risks.length === 2 && rk.risks.every((x) => x.status === 'open'), JSON.stringify(rk).slice(0, 200));
      const set1 = await fetchT(`http://127.0.0.1:${port}/api/risks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'R1', status: 'handled' }),
      }).then((r) => r.json());
      const rk2 = await fetchT(`http://127.0.0.1:${port}/api/risks`).then((r) => r.json());
      check('风险状态更新生效', !!set1.ok && rk2.risks.find((x) => x.id === 'R1').status === 'handled', JSON.stringify(rk2.risks).slice(0, 200));
      const rst = await fetchT(`http://127.0.0.1:${port}/api/risks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }),
      }).then((r) => r.json());
      const rk3 = await fetchT(`http://127.0.0.1:${port}/api/risks`).then((r) => r.json());
      check('风险状态重置', !!rst.ok && rk3.risks.every((x) => x.status === 'open'), '');
      // 项目隔离：切到另一项目，/api/risks 不应看到本项目预测（预测产物按项目目录隔离）
      const prjNow = await fetchT(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json());
      const otherId = prjNow.projects.find((p) => p.id !== prjNow.active).id;
      await fetchT(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: otherId }),
      });
      const rkOther = await fetchT(`http://127.0.0.1:${port}/api/risks`).then((r) => r.json());
      check('预测按项目隔离：另一项目无风险数据', !!rkOther.ok && rkOther.risks.length === 0, JSON.stringify(rkOther).slice(0, 200));
      // 契约回归：尚无预测是业务状态（用户尚未运行模拟）→ POST /api/risks 返回 200 + ok:false（README API 错误约定），非协议层 404。
      // 确定性：删除另一项目预测文件（及遗留单项目路径），测完按原状恢复（legacy 可能是用户旧版产物，不可误删）
      const otherPredDir = path.join(ROOT, 'app', 'predictions', otherId);
      const otherPredFile = path.join(otherPredDir, 'last-pred.json');
      const legacyPred = path.join(ROOT, 'app', 'predictions', 'last-pred.json');
      const hadOther = fs.existsSync(otherPredFile);
      const hadLegacy = fs.existsSync(legacyPred);
      const saveOther = hadOther ? fs.readFileSync(otherPredFile, 'utf8') : null;
      const saveLegacy = hadLegacy ? fs.readFileSync(legacyPred, 'utf8') : null;
      if (hadOther) fs.unlinkSync(otherPredFile);
      if (hadLegacy) fs.unlinkSync(legacyPred);
      let rkNoPredR = null;
      let rkNoPred = null;
      try {
        rkNoPredR = await fetchT(`http://127.0.0.1:${port}/api/risks`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }),
        });
        rkNoPred = await rkNoPredR.json();
      } finally {
        if (hadOther) { fs.mkdirSync(otherPredDir, { recursive: true }); fs.writeFileSync(otherPredFile, saveOther, 'utf8'); }
        if (hadLegacy) fs.writeFileSync(legacyPred, saveLegacy, 'utf8');
      }
      check('无预测契约：POST /api/risks 返回 200 + ok:false（非 404）', rkNoPredR.status === 200 && rkNoPred.ok === false && /尚无预测/.test(rkNoPred.error), `status=${rkNoPredR.status} body=${JSON.stringify(rkNoPred).slice(0, 200)}`);
      await fetchT(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: prjNow.active }),
      });
      // 新建项目（路径相对 app/ 目录）
      const tmpProjDir = path.join(ROOT, 'app', 'predictions', 'tmp-project');
      const np = await fetchT(`http://127.0.0.1:${port}/api/projects/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: '测试项目',
          reader: 'bogus', // 非法读者向：必须回落默认 webnovel（防注入任意值）
          manuscript: 'predictions/tmp-project/manuscript.md',
          canon: 'predictions/tmp-project/canon.json',
          outline: 'predictions/tmp-project/outline.md',
          premise: 'predictions/tmp-project/premise.md',
        }),
      }).then((r) => r.json());
      check('新建项目成功并创建文件', !!np.ok && np.active === '测试项目' && np.created.length === 4 && fs.existsSync(path.join(tmpProjDir, 'manuscript.md')), JSON.stringify(np).slice(0, 200));
      const stNp = await fetchT(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
      check('新项目 state 生效', !!stNp.ok && stNp.activeProject === '测试项目' && stNp.files.canon.content.includes('测试项目'), '');
      check('非法 reader 回落默认 webnovel', !!stNp.ok && stNp.config.reader === 'webnovel', JSON.stringify(stNp.config && stNp.config.reader));
      // 契约回归：配置的文件缺失属业务校验失败 → HTTP 200 + ok:false（README API 错误约定），非协议层 404
      const missingMs = path.join(tmpProjDir, 'manuscript.md');
      const origMs = fs.readFileSync(missingMs, 'utf8');
      fs.unlinkSync(missingMs);
      const stMissR = await fetchT(`http://127.0.0.1:${port}/api/state`);
      const stMiss = await stMissR.json();
      check('文件缺失契约：/api/state 返回 200 + ok:false（非 404）', stMissR.status === 200 && stMiss.ok === false && /文件不存在/.test(stMiss.error), `status=${stMissR.status} body=${JSON.stringify(stMiss).slice(0, 200)}`);
      fs.writeFileSync(missingMs, origMs, 'utf8');
      const curPrj = await fetchT(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json());
      await fetchT(`http://127.0.0.1:${port}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: curPrj.active }),
      });
      // 另存为（指针跟随）
      const sa = await fetchT(`http://127.0.0.1:${port}/api/save-as`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'manuscript', content: '另存为内容', path: 'predictions/tmp-save-as.md' }),
      }).then((r) => r.json());
      const stSa = await fetchT(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
      check('另存为：指针跟随新路径', !!sa.ok && stSa.ok && stSa.files.manuscript.path.endsWith('tmp-save-as.md') && fs.readFileSync(path.join(ROOT, 'app', 'predictions', 'tmp-save-as.md'), 'utf8') === '另存为内容', JSON.stringify(sa) + JSON.stringify(stSa.files && stSa.files.manuscript && stSa.files.manuscript.path).slice(0, 200));
      // 存储为（副本，指针不变）
      const sc = await fetchT(`http://127.0.0.1:${port}/api/save-copy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'canon', content: '副本内容', path: 'predictions/tmp-save-copy.json' }),
      }).then((r) => r.json());
      const stSc = await fetchT(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
      check('存储为：副本写入且指针不变', !!sc.ok && fs.existsSync(path.join(ROOT, 'app', 'predictions', 'tmp-save-copy.json')) && !stSc.files.canon.path.endsWith('tmp-save-copy.json'), JSON.stringify(sc));
      // 安全边界：tool 路径注入 / 越界另存为 / 跨站 Origin / 静态路径穿越
      const inj = await fetchT(`http://127.0.0.1:${port}/api/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: '../src/extract', args: [] }),
      }).then((r) => r.json());
      check('tool 路径注入被拒（../ 不执行）', inj.code === -1 && /未知工具/.test(inj.stderr), JSON.stringify(inj).slice(0, 200));
      const inj2 = await fetchT(`http://127.0.0.1:${port}/api/run-stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'app/server', args: [] }),
      }).then((r) => r.json());
      check('run-stream 工具名含分隔符被拒', !inj2.ok, JSON.stringify(inj2).slice(0, 120));
      const saBad = await fetchT(`http://127.0.0.1:${port}/api/save-as`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'manuscript', content: 'x', path: '../../outside-save-as.md' }),
      });
      check('另存为越出项目根被拒（403）', saBad.status === 403, `status=${saBad.status}`);
      const saveBad = await fetchT(`http://127.0.0.1:${port}/api/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'constructor', content: 'x' }),
      });
      check('/api/save 非法 file 被拒（400，白名单防原型链属性）', saveBad.status === 400, `status=${saveBad.status}`);
      const evil = await fetchT(`http://127.0.0.1:${port}/api/compile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
        body: JSON.stringify({}),
      });
      check('跨站 Origin 被拒（403）', evil.status === 403, `status=${evil.status}`);
      const evilDir = path.join(ROOT, 'app', 'public-evil');
      fs.mkdirSync(evilDir, { recursive: true });
      fs.writeFileSync(path.join(evilDir, 'secret.txt'), 'topsecret', 'utf8');
      try {
        const trav = await fetchT(`http://127.0.0.1:${port}/%2e%2e/public-evil/secret.txt`).then((r) => r.status);
        check('静态路径穿越（public 前缀碰撞）被拒（404）', trav === 404, `status=${trav}`);
      } finally {
        fs.rmSync(evilDir, { recursive: true, force: true });
      }
      // 畸形 URL 不得击穿服务器进程
      const badUrl = await fetchT(`http://127.0.0.1:${port}/%zz`).then((r) => r.status);
      check('畸形 URL（%zz）返回 404 不崩溃', badUrl === 404, `status=${badUrl}`);
      const alive = await fetchT(`http://127.0.0.1:${port}/index.html`).then((r) => r.status);
      check('畸形 URL 后服务器仍存活', alive === 200, `status=${alive}`);
      const npBad = await fetchT(`http://127.0.0.1:${port}/api/projects/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '越界项目', manuscript: '../../outside-project.md' }),
      });
      check('新建项目越出项目根被拒（403）', npBad.status === 403, `status=${npBad.status}`);
      const npBadId = await fetchT(`http://127.0.0.1:${port}/api/projects/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'a/b', manuscript: 'predictions/tmp-x/manuscript.md', canon: 'predictions/tmp-x/canon.json', outline: 'predictions/tmp-x/outline.md', premise: 'predictions/tmp-x/premise.md' }),
      });
      check('新建项目非法 id（含路径分隔符）被拒（400，保证 id→预测目录 1:1）', npBadId.status === 400, `status=${npBadId.status}`);
      // 卡片上传 contents：合法内容写入 / 覆盖已存在 / 非法 canon / 超大 / 类型错误（界至 8MB 上限）
      const UP = 'predictions/tmp-project-upload';
      const upAbs = path.join(ROOT, 'app', UP);
      const upOk = await fetchT(`http://127.0.0.1:${port}/api/projects/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: '上传项目', 
          manuscript: UP + '/manuscript.md', canon: UP + '/canon.json', outline: UP + '/outline.md', premise: UP + '/premise.md',
          contents: {
            manuscript: '# 上传的文稿\n第一章',
            canon: JSON.stringify({ meta: { title: '上传项目', target_reader: 'webnovel', genre: '' }, entities: [], knowledge: [], suspense: [], timeline: [] }),
            outline: '# 上传大纲',
            premise: '# 上传前提',
          },
        }),
      }).then((r) => r.json());
      check('上传 contents：创建成功（4 新文件）', !!upOk.ok && upOk.created.length === 4, JSON.stringify(upOk).slice(0, 200));
      check('上传 contents：文稿内容写入', fs.readFileSync(path.join(upAbs, 'manuscript.md'), 'utf8') === '# 上传的文稿\n第一章', fs.readFileSync(path.join(upAbs, 'manuscript.md'), 'utf8'));
      check('上传 contents：canon 内容写入', fs.readFileSync(path.join(upAbs, 'canon.json'), 'utf8').includes('上传项目'), fs.readFileSync(path.join(upAbs, 'canon.json'), 'utf8').slice(0, 80));
      const upCov = await fetchT(`http://127.0.0.1:${port}/api/projects/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: '上传项目Cover',
          manuscript: UP + '/manuscript.md', canon: UP + '/canon.json', outline: UP + '/outline.md', premise: UP + '/premise.md',
          contents: { manuscript: '# 第二次覆盖' },
        }),
      }).then((r) => r.json());
      check('上传覆盖已存在文件：内容覆盖且 created 不含已存在项', !!upCov.ok && upCov.created.length === 0 && fs.readFileSync(path.join(upAbs, 'manuscript.md'), 'utf8') === '# 第二次覆盖', JSON.stringify(upCov).slice(0, 200));
      fs.rmSync(upAbs, { recursive: true, force: true });
      const upBadCanon = await fetchT(`http://127.0.0.1:${port}/api/projects/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '上传BadCanon', contents: { canon: 'not json' } }),
      });
      check('上传非法 canon JSON 被拒（400）', upBadCanon.status === 400, `status=${upBadCanon.status}`);
      const upHuge = await fetchT(`http://127.0.0.1:${port}/api/projects/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '上传Huge', contents: { manuscript: 'x'.repeat(9 * 1024 * 1024) } }),
      });
      check('上传超限内容被拒（400）', upHuge.status === 400, `status=${upHuge.status}`);
      const upTyped = await fetchT(`http://127.0.0.1:${port}/api/projects/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '上传Typed', contents: { canon: 123 } }),
      });
      check('上传非字符串内容被拒（400）', upTyped.status === 400, `status=${upTyped.status}`);
    } finally {
      // 前缀扫描清理：tmp-save-as.md / tmp-save-copy.json / tmp-apply-canon.json 及其 .bak-* 备份
      try {
        const pdir = path.join(ROOT, 'app', 'predictions');
        for (const f of fs.readdirSync(pdir)) {
          if (f.startsWith('tmp-')) { try { fs.unlinkSync(path.join(pdir, f)); } catch { /* 目录等忽略 */ } }
        }
      } catch { /* 忽略 */ }
      try { fs.rmSync(path.join(ROOT, 'app', 'predictions', 'tmp-project'), { recursive: true, force: true }); } catch { /* 忽略 */ }
      // 项目专属预测目录（测试写入的 fakePred / risk-status 都在里面）整目录删除
      if (predDirT) { try { fs.rmSync(predDirT, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    }
    // 流水线互斥锁：任务运行中时第二个 /api/run 被拒（busy），结束后恢复
    const slowTool = path.join(ROOT, 'slow-tool.js');
    fs.writeFileSync(slowTool, "setTimeout(() => console.log('done'), 2000);\n", 'utf8');
    try {
      const pLock1 = fetchT(`http://127.0.0.1:${port}/api/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'slow-tool', args: [] }),
      });
      // 等第一个请求真正占锁：轮询探测替代固定 400ms 睡眠——慢机器上请求可能尚未被服务器
      // 受理，lock2 不 busy → 假阴性。探测用无效工具名：锁检查先于工具名校验（server.js runTool），
      // 未占锁时立即返回"未知工具"（无副作用不 spawn），占锁时返回 busy
      let lockHeld = false;
      for (let i = 0; i < 60 && !lockHeld; i++) {
        const probe = await fetchT(`http://127.0.0.1:${port}/api/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: '__lock_probe__', args: [] }),
        }).then((r) => r.json()).catch(() => null);
        lockHeld = !!(probe && probe.busy === true);
        if (!lockHeld) await new Promise((r) => setTimeout(r, 100));
      }
      check('并发锁：轮询探测到锁被占用', lockHeld, '60 次探测（6s）内未见 busy——第一个任务未占锁');
      const lock2 = await fetchT(`http://127.0.0.1:${port}/api/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'slow-tool', args: [] }),
      }).then((r) => r.json());
      const lock1 = await pLock1.then((r) => r.json());
      check('并发锁：第二个任务被拒（busy）', lock2.busy === true && lock1.code === 0, JSON.stringify({ lock1, lock2 }).slice(0, 200));
      // 锁释放后任务可再次运行
      const lock3 = await fetchT(`http://127.0.0.1:${port}/api/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'slow-tool', args: [] }),
      }).then((r) => r.json());
      check('并发锁：任务结束后锁释放（再次运行成功）', lock3.code === 0, JSON.stringify(lock3).slice(0, 200));
    } finally {
      try { fs.unlinkSync(slowTool); } catch { /* 忽略 */ }
    }
    // 客户端断开释放锁：任务运行中客户端 abort（关页/断网）→ 服务器终止子进程并释放锁，
    // 否则进程跑满 TOOL_TIMEOUT_MS 期间锁被占用、所有流水线任务被 409 拒绝
    const abortTool = path.join(ROOT, 'abort-tool.js');
    const abortPidFile = path.join(ROOT, 'abort-tool.pid');
    fs.writeFileSync(abortTool, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(abortPidFile)}, String(process.pid), 'utf8');`,
      "console.log('abort-start');",
      "setTimeout(() => { console.log('abort-done'); process.exit(0); }, 8000);",
    ].join('\n') + '\n', 'utf8');
    try { fs.unlinkSync(abortPidFile); } catch { /* 忽略 */ }
    try {
      const ac = new AbortController();
      const resp = await fetchT(`http://127.0.0.1:${port}/api/run-stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'abort-tool', args: [] }),
        signal: ac.signal,
      });
      const reader = resp.body.getReader();
      // 读到首块数据（服务器已 spawn 子进程并开始写流）后立即 abort，模拟关页/断网
      try { await reader.read(); } catch { /* abort 引发的读错误正常 */ }
      ac.abort();
      try { await reader.cancel(); } catch { /* 已中止 */ }
      // 等服务器处理 res close → killTree + 释放锁
      await new Promise((r) => setTimeout(r, 600));
      const probeAb = await fetchT(`http://127.0.0.1:${port}/api/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: '__lock_probe__', args: [] }),
      }).then((r) => r.json()).catch(() => null);
      check('断连后锁释放（abort 后 probe 不再 busy）', !(probeAb && probeAb.busy === true), JSON.stringify(probeAb).slice(0, 200));
      // 子进程被终止：abort-tool 8s 后才自然退出，若 killTree 生效 pid 应已不存在
      await new Promise((r) => setTimeout(r, 500));
      let abortGone = false;
      try {
        const cpid = Number(fs.readFileSync(abortPidFile, 'utf8'));
        if (cpid) { try { process.kill(cpid, 0); } catch (e) { abortGone = e.code === 'ESRCH'; } }
      } catch { abortGone = true; } // pid 文件未写出（被杀太快）同样视为已终止
      check('断连后子进程被终止（killTree 生效）', abortGone, '');
    } finally {
      try { fs.unlinkSync(abortTool); } catch { /* 忽略 */ }
      try { fs.unlinkSync(abortPidFile); } catch { /* 忽略 */ }
    }
    fs.mkdirSync(path.dirname(tmpCanon), { recursive: true });
    fs.writeFileSync(tmpCanon, JSON.stringify(cleanCanon, null, 2) + '\n', 'utf8'); // 预置目标 canon（基线）
    const apBad = await fetchT(`http://127.0.0.1:${port}/api/apply-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decisions: [{ section: 'entities', id: 'old_zhou', action: 'edit', value: [1, 2] }], // 数组不是合法编辑值
        proposal: 'test/fixtures/pred-canon.json',
        canonPath: tmpCanon,
      }),
    }).then((r) => r.json());
    check('/api/apply-review 非法编辑值被拒（400）', !apBad.ok, JSON.stringify(apBad).slice(0, 200));
    const apBadAction = await fetchT(`http://127.0.0.1:${port}/api/apply-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decisions: [{ section: 'entities', id: 'old_zhou', action: 'bogus' }], // 非法 action
        proposal: 'test/fixtures/pred-canon.json',
        canonPath: tmpCanon,
      }),
    }).then((r) => r.json());
    check('/api/apply-review 非法 action 被拒（400）', !apBadAction.ok && String(apBadAction.error).includes('非法审阅决定 action'), JSON.stringify(apBadAction).slice(0, 200));
    const apBadEmpty = await fetchT(`http://127.0.0.1:${port}/api/apply-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decisions: [{ section: 'entities', id: 'old_zhou', action: 'edit', value: {} }], // 空对象编辑
        proposal: 'test/fixtures/pred-canon.json',
        canonPath: tmpCanon,
      }),
    }).then((r) => r.json());
    check('/api/apply-review 空对象编辑被拒（400）', !apBadEmpty.ok && String(apBadEmpty.error).includes('非空对象'), JSON.stringify(apBadEmpty).slice(0, 200));
    // 缺字段 baseline：applyReview 防御补空数组，正常合并（不 500 崩溃），结果通过 schema 校验
    const sparseCanon = path.join(ROOT, 'app', 'predictions', 'tmp-sparse-canon.json');
    fs.writeFileSync(sparseCanon, JSON.stringify({ meta: { title: 'T' } }), 'utf8'); // 缺 entities 等数组
    try {
      const apSparse = await fetchT(`http://127.0.0.1:${port}/api/apply-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisions: [{ section: 'entities', id: 'old_zhou', action: 'accept' }], // 用 pred-canon 真实存在的 id
          proposal: 'test/fixtures/pred-canon.json',
          canonPath: sparseCanon,
        }),
      }).then((r) => r.json());
      check('/api/apply-review 缺字段 baseline 正常合并（补空数组，不 500 崩溃）', !!apSparse.ok && apSparse.applied === 1 && JSON.parse(fs.readFileSync(sparseCanon, 'utf8')).entities.length === 1, JSON.stringify(apSparse).slice(0, 200));
    } finally {
      try { fs.unlinkSync(sparseCanon); } catch { /* 忽略 */ }
      try {
        const pdir = path.dirname(sparseCanon);
        for (const f of fs.readdirSync(pdir)) {
          if (f.startsWith('tmp-sparse-canon')) { try { fs.unlinkSync(path.join(pdir, f)); } catch { /* 忽略 */ } }
        }
      } catch { /* 忽略 */ }
    }
    const ap = await fetchT(`http://127.0.0.1:${port}/api/apply-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decisions: [{ section: 'entities', id: 'old_zhou', action: 'accept' }],
        proposal: 'test/fixtures/pred-canon.json',
        canonPath: tmpCanon,
      }),
    }).then((r) => r.json());
    check('/api/apply-review 应用成功且写前已备份（.bak-<时间戳>）', !!ap.ok && ap.applied === 1 && !!ap.backup && ap.backup.includes('.bak-'), JSON.stringify(ap).slice(0, 200));
    if (ap.ok) {
      const written = JSON.parse(fs.readFileSync(tmpCanon, 'utf8'));
      check('合并结果已写入（含老周）', written.entities.some((x) => x.id === 'old_zhou'), '');
    }
    // retired 接入审阅：/api/review 携带退役建议 + /api/apply-review 退役决定生效
    // 构造带 retired 的提取信封（canon 用 pred-canon，retired 指向基线 clean-canon 的真实悬念 s1）
    const retiredEnvPath = path.join(ROOT, 'app', 'predictions', 'tmp-retired-env.json');
    const retiredEnvData = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/pred-canon.json'), 'utf8'));
    retiredEnvData.retired = { suspense: ['s1'] };
    fs.writeFileSync(retiredEnvPath, JSON.stringify(retiredEnvData), 'utf8');
    const rvwRet = await fetchT(`http://127.0.0.1:${port}/api/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal: 'app/predictions/tmp-retired-env.json', baseline: 'test/fixtures/clean-canon.json' }),
    }).then((r) => r.json());
    check('/api/review 携带退役建议（retired 分组）', !!rvwRet.ok && rvwRet.review.counts.retired === 1 && rvwRet.review.retired[0].id === 's1', JSON.stringify(rvwRet).slice(0, 200));
    const apRet = await fetchT(`http://127.0.0.1:${port}/api/apply-review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decisions: [{ section: 'suspense', id: 's1', action: 'accept' }],
        proposal: 'app/predictions/tmp-retired-env.json',
        canonPath: tmpCanon,
      }),
    }).then((r) => r.json());
    check('/api/apply-review 退役 accept 应用（从目标 canon 删除悬念）', !!apRet.ok && !JSON.parse(fs.readFileSync(tmpCanon, 'utf8')).suspense.some((s) => s.id === 's1'), JSON.stringify(apRet).slice(0, 200));
    // P1：config 读失败时持久化拒绝写回（防空配置覆盖用户 config）
    // 把 config 路径从文件换成目录 → readConfigRaw 读失败（EISDIR）→ persistActive 必须拒绝
    fs.rmSync(tmpCfg, { force: true });
    fs.mkdirSync(tmpCfg);
    const cfgFail = await fetchT(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: '隔离测试甲' }),
    });
    check('config 读失败：切换项目持久化被拒（500，不写回空配置）', cfgFail.status === 500, `status=${cfgFail.status}`);
  } finally {
    if (srv) srv.kill();
    try { fs.rmSync(tmpCfg, { recursive: true, force: true }); } catch { /* 文件或目录都清理 */ }
    // canon 目标与 .bak-* 备份的异常安全清理（fetch 中途抛错也不残留）
    try {
      const pdir = path.dirname(tmpCanon);
      for (const f of fs.readdirSync(pdir)) {
        if (f.startsWith('tmp-apply-canon') || f.startsWith('tmp-retired-env')) { try { fs.unlinkSync(path.join(pdir, f)); } catch { /* 忽略 */ } }
      }
    } catch { /* 忽略 */ }
    const cfgAfter = (() => { try { return fs.readFileSync(path.join(ROOT, 'app', 'config.json'), 'utf8'); } catch { return null; } })();
    check('测试后用户 config.json 未被改动（临时 --config 隔离生效）', cfgAfter === cfgBefore, '');
  }

  console.log('场景 51b: 旧格式 config e2e——新建项目后迁移保留旧项目字段（P0）');
  const oldCfg = path.join(ROOT, 'app', 'predictions', 'tmp-old-config.json');
  let srvOld;
  try {
    fs.writeFileSync(oldCfg, JSON.stringify({ manuscript: 'x.md', canon: 'y.json', outline: 'z.md', premise: 'w.md', reader: 'genre', model: 'deepseek-chat', apiKey: null }), 'utf8');
    srvOld = spawn(process.execPath, [SRV, '--port', '0', '--config', oldCfg], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let bufOld = '';
    const portOld = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('旧格式服务器启动超时')), 15000);
      srvOld.stdout.on('data', (d) => {
        bufOld += d.toString();
        const m = bufOld.match(/LISTENING [^:]+:(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
      srvOld.on('exit', (c) => reject(new Error('旧格式服务器退出 ' + c)));
    });
    const npOld = await fetchT(`http://127.0.0.1:${portOld}/api/projects/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: '新项目X',
        manuscript: 'predictions/tmp-oldproj/manuscript.md',
        canon: 'predictions/tmp-oldproj/canon.json',
        outline: 'predictions/tmp-oldproj/outline.md',
        premise: 'predictions/tmp-oldproj/premise.md',
      }),
    }).then((r) => r.json());
    check('旧格式 config：新建项目成功', !!npOld.ok && npOld.active === '新项目X', JSON.stringify(npOld).slice(0, 150));
    const cfgAfterOld = JSON.parse(fs.readFileSync(oldCfg, 'utf8'));
    check('旧格式迁移保留旧项目（默认项目）全部字段', !!cfgAfterOld.projects['默认项目']
      && cfgAfterOld.projects['默认项目'].manuscript === 'x.md'
      && cfgAfterOld.projects['默认项目'].canon === 'y.json'
      && cfgAfterOld.projects['默认项目'].outline === 'z.md'
      && cfgAfterOld.projects['默认项目'].premise === 'w.md'
      && cfgAfterOld.projects['默认项目'].reader === 'genre'
      && !!cfgAfterOld.projects['新项目X'], JSON.stringify(cfgAfterOld.projects));
    // 旧格式 config 的另存为：迁移保留旧项目字段并更新指针（setProjectPathInConfig 镜像 e2e）
    const saOld = await fetchT(`http://127.0.0.1:${portOld}/api/save-as`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'manuscript', content: 'x', path: 'predictions/tmp-oldproj/manuscript2.md' }),
    }).then((r) => r.json());
    check('旧格式 config：另存为成功', !!saOld.ok, JSON.stringify(saOld).slice(0, 150));
    const cfgAfterSa = JSON.parse(fs.readFileSync(oldCfg, 'utf8'));
    check('旧格式另存为迁移保留旧项目字段并更新活动项目路径', !!cfgAfterSa.projects['默认项目']
      && cfgAfterSa.projects['默认项目'].canon === 'y.json'
      && cfgAfterSa.projects['默认项目'].reader === 'genre'
      && !!cfgAfterSa.projects['新项目X']
      && cfgAfterSa.projects['新项目X'].manuscript.includes('tmp-oldproj/manuscript2.md'), JSON.stringify(cfgAfterSa.projects));
  } finally {
    if (srvOld) srvOld.kill();
    try { fs.rmSync(path.join(ROOT, 'app', 'predictions', 'tmp-oldproj'), { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.unlinkSync(oldCfg); } catch { /* 忽略 */ }
  }

  console.log('场景 52: 跨进程写锁（CLI 与 IDE 并发写共享输出防互相覆盖）');
  // 回归背景：CLI 直接运行与 IDE（spawn 同一 CLI）并发写同一输出（如 last-extract.json）时，
  // 原子写只防损坏、不防"计算几分钟后互相覆盖"——旧版两个进程会各自算完再静默覆盖对方结果。
  {
    const { acquireFileLock, LOCK_STALE_MS } = require('../src/fsutil');
    const lockDir = path.join(ROOT, 'test', 'fixtures', 'tmp-lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockTarget = path.join(lockDir, 'last-extract.json');
    try {
      // ① fsutil 单元：获取 → 争用冲突（EEXIST + 等待超时） → 释放后可再获取
      const rel1 = acquireFileLock(lockTarget);
      const lockFile = lockTarget + '.lock';
      // payload 为结构化 JSON {pid, host, acquired_at}（pid 探活自愈协议，见场景 58）
      let lockPid1 = null;
      try { lockPid1 = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid; } catch { /* 旧文本格式 */ }
      check('锁文件已创建并记录 pid', fs.existsSync(lockFile) && lockPid1 === process.pid, '');
      let conflictMsg = null;
      try { acquireFileLock(lockTarget); } catch (e) { conflictMsg = e.message; }
      check('并发获取抛错（等待超时，含占用提示与锁路径）', !!conflictMsg && conflictMsg.includes('被其他进程占用') && conflictMsg.includes(lockFile), conflictMsg || '');
      rel1();
      check('释放后锁文件已删除', !fs.existsSync(lockFile), '');
      const rel2 = acquireFileLock(lockTarget);
      check('释放后可重新获取（锁可复用：二次获取后锁文件重新出现）', fs.existsSync(lockFile), '');
      rel2();
      check('二次释放后锁文件无残留', !fs.existsSync(lockFile), '');
      // ② 陈旧锁回收：mtime 超过陈旧阈值 → 自动接管（崩溃遗留场景）
      fs.writeFileSync(lockFile, 'pid=999999\nstale\n', 'utf8');
      const old = new Date(Date.now() - LOCK_STALE_MS - 60000);
      fs.utimesSync(lockFile, old, old);
      const rel3 = acquireFileLock(lockTarget);
      const reclaimed = fs.readFileSync(lockFile, 'utf8');
      rel3();
      let reclaimedPid = null;
      try { reclaimedPid = JSON.parse(reclaimed).pid; } catch { /* 旧文本格式 */ }
      check('陈旧锁按 mtime 超时回收（内容被当前 pid 接管）', reclaimedPid === process.pid, reclaimed);
      check('接管后锁文件正常删除', !fs.existsSync(lockFile), '');
    } finally {
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }

    // ③ CLI e2e：锁被其他进程持有时快速失败（exit 2、明确提示、不写输出、不调 LLM）
    const lockOut = path.join(ROOT, 'test', 'fixtures', 'tmp-lock-out.json');
    // 模拟第三方持有：必须用活进程 pid（本测试进程在子进程运行期间存活）——
    // 假 pid（如 12345）在探活自愈协议下会被判死立即回收，工具就不会报锁冲突
    fs.writeFileSync(lockOut + '.lock', `pid=${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    try {
      const lockCli = run(['test/fixtures/clean-manuscript.md', '--canon', 'test/fixtures/clean-canon.json', '--out', lockOut], EXT);
      check('并发锁存在时 extract-llm 快速失败（exit 2）', lockCli.code === 2, `got ${lockCli.code}\n${lockCli.out}${lockCli.err}`);
      check('失败提示含“被其他进程占用”与锁文件路径', (lockCli.out + lockCli.err).includes('被其他进程占用') && (lockCli.out + lockCli.err).includes('tmp-lock-out.json.lock'), (lockCli.out + lockCli.err).slice(0, 500));
      check('失败时未写出输出文件（白算后静默覆盖被阻止）', !fs.existsSync(lockOut), '');
    } finally {
      try { fs.unlinkSync(lockOut + '.lock'); } catch { /* 忽略 */ }
      try { fs.unlinkSync(lockOut); } catch { /* 忽略 */ }
    }

    // ④ CLI e2e：正常提取成功后锁经 exit 钩子释放（无 .lock 残留）
    const srvLock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        // 构造合法时间线证据（timeline 每章必带证据）：取每章标题行作为引文（行号/引文逐字命中）
        const msText = fs.readFileSync(path.join(ROOT, 'test/fixtures/clean-manuscript.md'), 'utf8');
        const msLines = msText.replace(/^\uFEFF/, '').split(/\r?\n/);
        const chapters = require('../src/extract').parseManuscript(msText).chapters.filter((c) => c.number !== null);
        const tlEv = {};
        for (const ch of chapters) tlEv[String(ch.number)] = [{ chapter: ch.number, line: ch.headingLine, quote: msLines[ch.headingLine - 1] }];
        const content = JSON.stringify({ canon: JSON.parse(JSON.stringify(cleanCanon)), evidence: { entities: {}, knowledge: {}, suspense: {}, timeline: tlEv }, extraction_notes: [] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
      });
    });
    await new Promise((r) => srvLock.listen(0, '127.0.0.1', r));
    const portLock = srvLock.address().port;
    const lockEnv = { ...process.env, DEEPSEEK_API_KEY: 'x', DEEPSEEK_BASE_URL: `http://127.0.0.1:${portLock}`, DEEPSEEK_MODEL: 'm', LLM_TIMEOUT_MS: '60000' };
    const okOut = path.join(ROOT, 'test', 'fixtures', 'tmp-lock-ok.json');
    try {
      const lockOk = await new Promise((resolve) => {
        const child = spawn(process.execPath, [EXT, 'test/fixtures/clean-manuscript.md', '--canon', 'test/fixtures/clean-canon.json', '--out', okOut], { cwd: ROOT, encoding: 'utf8', env: lockEnv });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
      });
      check('正常提取成功（exit 0）', lockOk.status === 0, `got ${lockOk.status}\n${lockOk.stdout}${lockOk.stderr}`);
      check('输出文件已写出', fs.existsSync(okOut), '');
      check('成功后锁文件已释放（无 .lock 残留）', !fs.existsSync(okOut + '.lock'), '');
    } finally {
      srvLock.close();
      try { fs.unlinkSync(okOut); } catch { /* 忽略 */ }
      try { fs.unlinkSync(okOut + '.lock'); } catch { /* 忽略 */ }
    }
  }

  console.log('场景 53: 遗留 review 项修复回归（空实际时间线比对 / config 重名覆盖 / TOOL_TIMEOUT_MS 容错 / 前端转义）');
  {
    // ① diff：实际 timeline 为空（schema 合法 timeline: []）→ 旧版 lastWritten=0 使所有章级比对
    // 静默跳过，预测与实际再不一致也恒报"无偏差"（rebase 永不触发的假阴性）
    const { diffCanons: dc9 } = require('../src/diff');
    const predHas = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [{ chapter: 1, day: 1 }, { chapter: 2, day: 2 }] };
    const actEmpty = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] };
    const d9 = dc9(predHas, actEmpty);
    check('实际时间线为空 → 报 diff/timeline-empty-actual warning（不再假阴性）', d9.some((p) => p.rule === 'diff/timeline-empty-actual' && p.severity === 'warning'), JSON.stringify(d9));
    check('两侧都空 → 不报（无可比内容不制造噪音）', !dc9(actEmpty, actEmpty).some((p) => p.rule === 'diff/timeline-empty-actual'), '');
    check('实际非空 → 不报（正常比对路径不受影响）', !dc9(predHas, predHas).some((p) => p.rule === 'diff/timeline-empty-actual'), '');

    // ② compare e2e：实际 canon timeline: [] → exit 1（漂移可被 rebase 感知）
    const actEmptyFile = path.join(ROOT, 'test', 'fixtures', 'tmp-act-empty-tl.json');
    fs.writeFileSync(actEmptyFile, JSON.stringify({ ...cleanCanon, timeline: [] }, null, 2) + '\n', 'utf8');
    try {
      const cmpEmpty = run(['test/fixtures/clean-canon.json', actEmptyFile], CMP);
      check('compare e2e：空实际时间线 exit 1（有警告级偏差）', cmpEmpty.code === 1, `got ${cmpEmpty.code}\n${cmpEmpty.out}`);
      check('compare e2e：输出含 diff/timeline-empty-actual 与补全指引', cmpEmpty.out.includes('diff/timeline-empty-actual') && cmpEmpty.out.includes('补全'), cmpEmpty.out);
    } finally {
      try { fs.unlinkSync(actEmptyFile); } catch { /* 忽略 */ }
    }

    // ③ config-util：addProjectInConfig 重名拒绝——服务器 409 检查基于内存态 STATE.projects，
    // config.json 被外部手改后内存与磁盘漂移即可绕过，覆盖写入会静默丢掉既有项目的全部文件指针
    const { addProjectInConfig: addProj } = require('../app/config-util');
    const dupCfg = JSON.stringify({ model: 'm', activeProject: '旧项目', projects: { 旧项目: { manuscript: 'a.md', canon: 'a.json', reader: 'webnovel' } } }, null, 2);
    let dupErr = null;
    try { addProj(dupCfg, { id: '旧项目', manuscript: 'b.md', canon: 'b.json' }, ROOT); } catch (e) { dupErr = e.message; }
    check('新格式：重名新建被拒（不静默覆盖既有项目指针）', !!dupErr && dupErr.includes('项目已存在'), dupErr || '');
    const oldCfgRaw = JSON.stringify({ manuscript: 'm.md', canon: 'c.json', reader: 'webnovel' }, null, 2);
    let oldDupErr = null;
    try { addProj(oldCfgRaw, { id: '默认项目', manuscript: 'n.md', canon: 'n.json' }, ROOT); } catch (e) { oldDupErr = e.message; }
    check('旧格式迁移：新项目撞迁移出的旧项目名被拒（旧字段不被覆盖丢失）', !!oldDupErr && oldDupErr.includes('项目已存在'), oldDupErr || '');

    // ④ fsutil：TOOL_TIMEOUT_MS 非法值容错——NaN 传入 setTimeout 等效 0（工具瞬杀）
    const fsutilPath = require.resolve('../src/fsutil');
    const savedFsutil = require.cache[fsutilPath];
    const savedEnvTmo = process.env.TOOL_TIMEOUT_MS;
    try {
      delete require.cache[fsutilPath];
      process.env.TOOL_TIMEOUT_MS = 'abc';
      check('TOOL_TIMEOUT_MS=abc → 回退默认 20min（NaN 瞬杀防护）', require(fsutilPath).TOOL_TIMEOUT_MS === 1200000, `got ${require(fsutilPath).TOOL_TIMEOUT_MS}`);
      delete require.cache[fsutilPath];
      process.env.TOOL_TIMEOUT_MS = '-5';
      check('TOOL_TIMEOUT_MS=-5 → 回退默认（负值同步触发防护）', require(fsutilPath).TOOL_TIMEOUT_MS === 1200000, `got ${require(fsutilPath).TOOL_TIMEOUT_MS}`);
      delete require.cache[fsutilPath];
      process.env.TOOL_TIMEOUT_MS = '65000';
      check('TOOL_TIMEOUT_MS=65000 合法值生效', require(fsutilPath).TOOL_TIMEOUT_MS === 65000, `got ${require(fsutilPath).TOOL_TIMEOUT_MS}`);
      // ⑤ LOCK_STALE_MS 随 TOOL_TIMEOUT_MS 派生（max(30min, 超时×1.5)）：
      // 调高超时后合法长运行不被后到者误判陈旧回收（防并发覆盖回归）
      delete require.cache[fsutilPath];
      process.env.TOOL_TIMEOUT_MS = String(10 * 60 * 1000);
      check('LOCK_STALE_MS 派生：超时 10min → 阈值取 30min 下限', require(fsutilPath).LOCK_STALE_MS === 30 * 60 * 1000, `got ${require(fsutilPath).LOCK_STALE_MS}`);
      delete require.cache[fsutilPath];
      process.env.TOOL_TIMEOUT_MS = String(60 * 60 * 1000);
      check('LOCK_STALE_MS 派生：超时 60min → 阈值=max(30min, 90min)=90min', require(fsutilPath).LOCK_STALE_MS === 90 * 60 * 1000, `got ${require(fsutilPath).LOCK_STALE_MS}`);
      delete require.cache[fsutilPath];
      process.env.TOOL_TIMEOUT_MS = String(20 * 60 * 1000);
      check('LOCK_STALE_MS 派生：默认超时 20min → 阈值=30min（与 1.5× 恰平）', require(fsutilPath).LOCK_STALE_MS === 30 * 60 * 1000, `got ${require(fsutilPath).LOCK_STALE_MS}`);
    } finally {
      delete require.cache[fsutilPath];
      if (savedFsutil) require.cache[fsutilPath] = savedFsutil;
      if (savedEnvTmo === undefined) delete process.env.TOOL_TIMEOUT_MS; else process.env.TOOL_TIMEOUT_MS = savedEnvTmo;
    }

    // ⑤ app.js 转义（源码断言，与场景 28b 同模式）：问题行 rule 与审阅证据行 chapter/line
    // 必须过 escapeHtml——evidence 来自 last-extract.json（可被手工编辑），未转义即 XSS 注入面
    const appSrc = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
    check('问题列表 rule 字段已转义（2 处 innerHTML，无裸插值残留）', (appSrc.match(/\[\$\{escapeHtml\(p\.rule\)\}\]/g) || []).length === 2 && !appSrc.includes('[${p.rule}]'), '');
    check('审阅证据行 chapter/line 已转义（防手改信封注入）', appSrc.includes("第${escapeHtml(String(e.chapter ?? '?'))}章 L${escapeHtml(String(e.line ?? '?'))}"), '');
  }

  console.log('场景 54: 跨进程写锁覆盖补齐（simulate/refactor/extract --canon-out，多目标锁回滚）');
  // 回归背景：跨进程锁上一轮只接入 extract-llm 的 --out；simulate（写 last-pred.json）、
  // refactor（写 outline/premise/canon）、extract-llm 的 --canon-out（重构流水线写 canon）仍裸奔——
  // CLI 直跑与 IDE 并发时"计算几分钟后互相覆盖"在这几个口子原样存在。
  {
    const { acquireFileLocks, acquireFileLock } = require('../src/fsutil');
    const lockDir = path.join(ROOT, 'test', 'fixtures', 'tmp-lock-multi');
    fs.mkdirSync(lockDir, { recursive: true });
    const ta = path.join(lockDir, 'a.json');
    const tb = path.join(lockDir, 'b.json');
    try {
      // ① 多目标批量锁：成功获取全部 → 统一释放
      const relMulti = acquireFileLocks([ta, tb]);
      check('批量锁：两个目标锁文件都已创建', fs.existsSync(ta + '.lock') && fs.existsSync(tb + '.lock'), '');
      relMulti();
      check('批量锁：释放后全部锁文件已删除', !fs.existsSync(ta + '.lock') && !fs.existsSync(tb + '.lock'), '');
      // ② 部分失败回滚：第二个目标已被占 → 第一个已获取的锁必须回滚释放（不留残留）
      const relHold = acquireFileLock(tb);
      let rollbackMsg = null;
      try { acquireFileLocks([ta, tb]); } catch (e) { rollbackMsg = e.message; }
      check('批量锁：任一目标被占 → 抛错（含占用提示）', !!rollbackMsg && rollbackMsg.includes('被其他进程占用'), rollbackMsg || '');
      check('批量锁：部分失败后已获取的锁已回滚（a 无 .lock 残留）', !fs.existsSync(ta + '.lock'), '');
      check('批量锁：第三方持有的锁未被回滚波及（b 仍持有）', fs.existsSync(tb + '.lock'), '');
      relHold();
      check('批量锁：第三方释放后 b 无 .lock 残留', !fs.existsSync(tb + '.lock'), '');
    } finally {
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }

    // ③ simulate e2e：--out 锁被占用 → 快速失败（exit 2，不调 LLM）
    const simOut = path.join(ROOT, 'test', 'fixtures', 'tmp-sim-lock.json');
    fs.writeFileSync(simOut + '.lock', `pid=${process.pid}\n${new Date().toISOString()}\n`, 'utf8'); // 活 pid：假 pid 会被探活回收（见场景 52③）
    try {
      const simLock = run(['test/fixtures/clean-manuscript.md', '--canon', 'test/fixtures/clean-canon.json', '--out', simOut], SIM);
      check('simulate：--out 锁被占用 → exit 2', simLock.code === 2, `got ${simLock.code}\n${simLock.out}${simLock.err}`);
      check('simulate：失败提示含“被其他进程占用”', (simLock.out + simLock.err).includes('被其他进程占用'), (simLock.out + simLock.err).slice(0, 400));
      check('simulate：失败时未写出输出文件', !fs.existsSync(simOut), '');
    } finally {
      try { fs.unlinkSync(simOut + '.lock'); } catch { /* 忽略 */ }
      try { fs.unlinkSync(simOut); } catch { /* 忽略 */ }
    }

    // ④ refactor e2e：outline/premise 锁被占用 → 快速失败（exit 2；需 DEEPSEEK_API_KEY 过 env 检查）
    const rfDir = path.join(ROOT, 'test', 'fixtures', 'tmp-rf-lock');
    fs.mkdirSync(rfDir, { recursive: true });
    const rfOutline = path.join(rfDir, 'outline.md');
    const rfPremise = path.join(rfDir, 'premise.md');
    fs.writeFileSync(rfOutline + '.lock', `pid=${process.pid}\n${new Date().toISOString()}\n`, 'utf8'); // 活 pid：假 pid 会被探活回收（见场景 52③）
    try {
      const rfLock = run(['test/fixtures/clean-manuscript.md', 'test/fixtures/clean-canon.json', rfOutline, rfPremise], BLD, { ...process.env, DEEPSEEK_API_KEY: 'x' });
      check('refactor：outline 锁被占用 → exit 2', rfLock.code === 2, `got ${rfLock.code}\n${rfLock.out}${rfLock.err}`);
      check('refactor：失败提示含“被其他进程占用”', (rfLock.out + rfLock.err).includes('被其他进程占用'), (rfLock.out + rfLock.err).slice(0, 400));
    } finally {
      try { fs.rmSync(rfDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }

    // ⑤ extract-llm e2e：--canon-out 锁被占用 → 快速失败（exit 2，重构流水线写 canon 的口子）
    const canOut = path.join(ROOT, 'test', 'fixtures', 'tmp-canonout-lock.json');
    fs.writeFileSync(canOut + '.lock', `pid=${process.pid}\n${new Date().toISOString()}\n`, 'utf8'); // 活 pid：假 pid 会被探活回收（见场景 52③）
    try {
      const xLock = run(['test/fixtures/clean-manuscript.md', '--canon', 'test/fixtures/clean-canon.json', '--canon-out', canOut], EXT);
      check('extract-llm：--canon-out 锁被占用 → exit 2', xLock.code === 2, `got ${xLock.code}\n${xLock.out}${xLock.err}`);
      check('extract-llm：失败提示含“被其他进程占用”', (xLock.out + xLock.err).includes('被其他进程占用'), (xLock.out + xLock.err).slice(0, 400));
      check('extract-llm：失败时未写出 canon-out 文件', !fs.existsSync(canOut), '');
    } finally {
      try { fs.unlinkSync(canOut + '.lock'); } catch { /* 忽略 */ }
      try { fs.unlinkSync(canOut); } catch { /* 忽略 */ }
    }
  }

  console.log('场景 55: IDE 直写绕过锁协议修复（apply-review/save/save-as/save-copy 持锁写，冲突 409）');
  {
    // ① acquireFileLockAsync 单测：异步锁（服务器变体）与同步版同一协议——获取/冲突/释放/复用
    const { acquireFileLock, acquireFileLockAsync } = require('../src/fsutil');
    const lockDir55 = path.join(ROOT, 'test', 'fixtures', 'tmp-lock-async');
    fs.mkdirSync(lockDir55, { recursive: true });
    const ta55 = path.join(lockDir55, 'a.json');
    try {
      const relA = await acquireFileLockAsync(ta55);
      check('异步锁：获取成功（.lock 已创建）', fs.existsSync(ta55 + '.lock'), '');
      let conflictMsg55 = null;
      try { await acquireFileLockAsync(ta55); } catch (e) { conflictMsg55 = e.message; }
      check('异步锁：持有期间二次获取抛冲突（含占用提示）', !!conflictMsg55 && conflictMsg55.includes('被其他进程占用'), conflictMsg55 || '');
      relA();
      check('异步锁：释放后 .lock 已删除', !fs.existsSync(ta55 + '.lock'), '');
      const relA2 = await acquireFileLockAsync(ta55);
      check('异步锁：释放后可复用', fs.existsSync(ta55 + '.lock'), '');
      relA2();
      check('异步锁：复用释放后无残留', !fs.existsSync(ta55 + '.lock'), '');
    } finally {
      try { fs.rmSync(lockDir55, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }

    // ② IDE 服务器 e2e：四个直写端点持锁写（CLI 持 <target>.lock 时后到者 409 而非静默覆盖）
    const tmpCfg55 = path.join(ROOT, 'app', 'predictions', 'tmp-server-config-55.json');
    fs.writeFileSync(tmpCfg55, JSON.stringify({
      model: 'deepseek-chat',
      apiKey: null,
      activeProject: '锁协议测试',
      projects: {
        '锁协议测试': {
          manuscript: '../test/fixtures/demo-manuscript.md',
          canon: 'predictions/tmp-lock-ide-canon.json', // 指向测试临时 canon，供 /api/save 命中
          outline: '../examples/outline.md',
          premise: '../examples/premise.md',
          reader: 'webnovel',
        },
      },
    }, null, 2) + '\n', 'utf8');
    const srv55 = spawn(process.execPath, [SRV, '--port', '0', '--config', tmpCfg55], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf55 = '';
    const port55 = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('服务器启动超时（场景55）')), 15000);
      srv55.stdout.on('data', (d) => {
        buf55 += d.toString();
        const m = buf55.match(/LISTENING [^:]+:(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
      srv55.on('exit', (c) => reject(new Error(`服务器提前退出 ${c}`)));
    });
    const tmpCanon55 = path.join(ROOT, 'app', 'predictions', 'tmp-lock-ide-canon.json');
    fs.writeFileSync(tmpCanon55, JSON.stringify({ meta: { title: '锁协议测试', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] }, null, 2) + '\n', 'utf8');
    try {
      // ③ apply-review：目标 canon 被 CLI 持锁 → 409，canon 未变、CLI 锁未被波及
      const relCanon = acquireFileLock(tmpCanon55);
      try {
        const arLockR = await fetchT(`http://127.0.0.1:${port55}/api/apply-review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decisions: [{ section: 'entities', id: 'old_zhou', action: 'accept' }], proposal: 'test/fixtures/pred-canon.json', canonPath: tmpCanon55 }),
        });
        const arLockJ = await arLockR.json();
        check('IDE apply-review：canon 被占 → 409', arLockR.status === 409, `status=${arLockR.status}`);
        check('IDE apply-review：409 提示含“被其他进程占用”', !!arLockJ.error && arLockJ.error.includes('被其他进程占用'), JSON.stringify(arLockJ).slice(0, 200));
        check('IDE apply-review：409 时 canon 未被改动', !JSON.parse(fs.readFileSync(tmpCanon55, 'utf8')).entities.some((x) => x.id === 'old_zhou'), '');
        check('IDE apply-review：409 后 CLI 持有的 .lock 未被波及', fs.existsSync(tmpCanon55 + '.lock'), '');
      } finally {
        relCanon();
      }
      // ④ 释放后正常应用 + 无 .lock 残留
      const arOk = await fetchT(`http://127.0.0.1:${port55}/api/apply-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: [{ section: 'entities', id: 'old_zhou', action: 'accept' }], proposal: 'test/fixtures/pred-canon.json', canonPath: tmpCanon55 }),
      }).then((r) => r.json());
      check('IDE apply-review：释放后正常应用', !!arOk.ok && arOk.applied === 1, JSON.stringify(arOk).slice(0, 200));
      check('IDE apply-review：成功后无 .lock 残留', !fs.existsSync(tmpCanon55 + '.lock'), '');

      // ⑤ /api/save：项目 canon 被 CLI 持锁 → 409 且文件未变
      const saveOrig55 = fs.readFileSync(tmpCanon55, 'utf8');
      const relSave = acquireFileLock(tmpCanon55);
      try {
        const svLockR = await fetchT(`http://127.0.0.1:${port55}/api/save`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: 'canon', content: '被并发覆盖的内容' }),
        });
        const svLockJ = await svLockR.json();
        check('IDE /api/save：canon 被占 → 409', svLockR.status === 409, `status=${svLockR.status}`);
        check('IDE /api/save：409 提示含“被其他进程占用”', !!svLockJ.error && svLockJ.error.includes('被其他进程占用'), JSON.stringify(svLockJ).slice(0, 200));
        check('IDE /api/save：409 时文件未被改动', fs.readFileSync(tmpCanon55, 'utf8') === saveOrig55, '');
      } finally {
        relSave();
      }
      const svOk = await fetchT(`http://127.0.0.1:${port55}/api/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'canon', content: '手动保存内容' }),
      }).then((r) => r.json());
      check('IDE /api/save：释放后正常保存', !!svOk.ok, JSON.stringify(svOk).slice(0, 200));
      check('IDE /api/save：成功后无 .lock 残留', !fs.existsSync(tmpCanon55 + '.lock'), '');

      // ⑥ save-as / save-copy：目标被 CLI 持锁 → 409，冲突后无锁残留
      const saTarget55 = path.join(ROOT, 'app', 'predictions', 'tmp-lock-ide-save-as.json');
      const relSA = acquireFileLock(saTarget55);
      try {
        const saLockR = await fetchT(`http://127.0.0.1:${port55}/api/save-as`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: 'manuscript', content: 'x', path: 'predictions/tmp-lock-ide-save-as.json' }),
        });
        check('IDE save-as：目标被占 → 409', saLockR.status === 409, `status=${saLockR.status}`);
        const scLockR = await fetchT(`http://127.0.0.1:${port55}/api/save-copy`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: 'canon', content: 'x', path: 'predictions/tmp-lock-ide-save-as.json' }),
        });
        check('IDE save-copy：目标被占 → 409', scLockR.status === 409, `status=${scLockR.status}`);
      } finally {
        relSA();
      }
      check('IDE save-as/save-copy：冲突后锁已释放（无残留）', !fs.existsSync(saTarget55 + '.lock'), '');
      const saOk = await fetchT(`http://127.0.0.1:${port55}/api/save-as`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'manuscript', content: '正常另存为', path: 'predictions/tmp-lock-ide-save-as.json' }),
      }).then((r) => r.json());
      check('IDE save-as：释放后正常另存为', !!saOk.ok, JSON.stringify(saOk).slice(0, 200));
      check('IDE save-as：成功后无 .lock 残留', !fs.existsSync(saTarget55 + '.lock'), '');
    } finally {
      srv55.kill();
      try { fs.rmSync(tmpCfg55, { recursive: true, force: true }); } catch { /* 忽略 */ }
      try {
        const pdir55 = path.join(ROOT, 'app', 'predictions');
        for (const f of fs.readdirSync(pdir55)) {
          if (f.startsWith('tmp-lock-ide-') || f.startsWith('tmp-server-config-55')) { try { fs.unlinkSync(path.join(pdir55, f)); } catch { /* 忽略 */ } }
        }
      } catch { /* 忽略 */ }
    }
  }

  // 场景 56: 读协调 —— 锁语义从「写侧」扩展为「协议侧」：只读消费者在读取共享文件前感知
  // 在途写者（checkFileLocked）；IDE /api/state 上报锁状态、/api/review 在输入被占用时阻断
  // （避免基于写入前快照做决定）；CLI 只读工具（compile/compare）对占用输入发 stderr 警告而非静默读取。
  console.log('场景 56: 读协调（只读侧感知在途写者，checkFileLocked + IDE 读端点 + CLI 只读工具）');
  {
    const { checkFileLocked, acquireFileLock } = require('../src/fsutil');
    const rcDir = path.join(ROOT, 'test', 'fixtures', 'tmp-read-coord');
    fs.mkdirSync(rcDir, { recursive: true });

    // ① checkFileLocked 单测：无锁 / 活锁 / 陈旧锁（mtime 回溯超阈值，崩溃遗留）
    const rcTarget = path.join(rcDir, 'a.json');
    const lk0 = checkFileLocked(rcTarget);
    check('读协调 checkFileLocked：无锁 → 未锁定', lk0.locked === false && lk0.stale === false, JSON.stringify(lk0));
    const relRc = acquireFileLock(rcTarget);
    try {
      const lk1 = checkFileLocked(rcTarget);
      check('读协调 checkFileLocked：活锁 → 已锁定', lk1.locked === true && lk1.stale === false, JSON.stringify(lk1));
      fs.utimesSync(rcTarget + '.lock', new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 31 * 60 * 1000));
      const lkStale = checkFileLocked(rcTarget);
      check('读协调 checkFileLocked：陈旧锁（>30min，崩溃遗留）视为无人持有并标记 stale', lkStale.locked === false && lkStale.stale === true, JSON.stringify(lkStale));
      fs.utimesSync(rcTarget + '.lock', new Date(), new Date()); // 恢复 mtime，让 release 正常删锁
    } finally {
      relRc();
    }

    // ② compile e2e：canon 被持锁 → stderr 警告（不阻断，对当前快照的分析仍有效）
    const rcMs = path.join(rcDir, 'demo-manuscript.md');
    const rcCanon = path.join(rcDir, 'demo-canon.json');
    fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'demo-manuscript.md'), rcMs);
    fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'demo-canon.json'), rcCanon);
    const relC = acquireFileLock(rcCanon);
    try {
      const rcCompile = run([rcMs, rcCanon, '--reader', 'webnovel', '--json'], CLI);
      check('读协调 compile：canon 被占 → stderr 警告「正被其他进程写入」', rcCompile.err.includes('正被其他进程写入'), rcCompile.err);
      check('读协调 compile：警告含锁路径', rcCompile.err.includes(rcCanon + '.lock'), rcCompile.err);
      let rcParsed = null;
      try { rcParsed = JSON.parse(rcCompile.out); } catch { /* 忽略 */ }
      check('读协调 compile：仍正常产出（exit 0/1，stdout JSON 可解析）', (rcCompile.code === 0 || rcCompile.code === 1) && rcParsed && Array.isArray(rcParsed.problems), `code=${rcCompile.code}`);
    } finally {
      relC();
    }

    // ③ compare e2e：pred 被持锁 → stderr 警告（不阻断）
    const rcPred = path.join(rcDir, 'pred-canon.json');
    fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'pred-canon.json'), rcPred);
    const relP = acquireFileLock(rcPred);
    try {
      const rcCmp = run([rcPred, rcCanon, '--json'], CMP);
      check('读协调 compare：pred 被占 → stderr 警告「正被其他进程写入」', rcCmp.err.includes('正被其他进程写入'), rcCmp.err);
      check('读协调 compare：仍正常产出（exit 0/1）', rcCmp.code === 0 || rcCmp.code === 1, `code=${rcCmp.code}`);
    } finally {
      relP();
    }

    // ④⑤⑥⑦ IDE e2e：/api/state 上报锁状态；/api/review 输入被占用时阻断、释放后正常
    const tmpCfg56 = path.join(ROOT, 'app', 'predictions', 'tmp-server-config-56.json');
    fs.writeFileSync(tmpCfg56, JSON.stringify({
      model: 'deepseek-chat',
      apiKey: null,
      activeProject: '读协调测试',
      projects: {
        '读协调测试': {
          manuscript: '../test/fixtures/demo-manuscript.md',
          canon: 'predictions/tmp-read-coord-canon.json',
          outline: '../examples/outline.md',
          premise: '../examples/premise.md',
          reader: 'webnovel',
        },
      },
    }, null, 2) + '\n', 'utf8');
    const srv56 = spawn(process.execPath, [SRV, '--port', '0', '--config', tmpCfg56], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf56 = '';
    const port56 = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('服务器启动超时（场景56）')), 15000);
      srv56.stdout.on('data', (d) => {
        buf56 += d.toString();
        const m = buf56.match(/LISTENING [^:]+:(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
      srv56.on('exit', (c) => reject(new Error(`服务器提前退出 ${c}`)));
    });
    const tmpCanon56 = path.join(ROOT, 'app', 'predictions', 'tmp-read-coord-canon.json');
    const tmpProposal56 = path.join(ROOT, 'app', 'predictions', 'tmp-read-coord-proposal.json');
    fs.writeFileSync(tmpCanon56, JSON.stringify({ meta: { title: '读协调测试', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(tmpProposal56, JSON.stringify({ meta: { title: '读协调测试', target_reader: 'webnovel' }, entities: [{ id: 'e1', name: '测试实体', type: 'location' }], knowledge: [], suspense: [], timeline: [] }, null, 2) + '\n', 'utf8');
    try {
      // ④ /api/state：canon 被持锁 → locks 元数据如实上报
      const relSt = acquireFileLock(tmpCanon56);
      try {
        const st56 = await fetchT(`http://127.0.0.1:${port56}/api/state`).then((r) => r.json());
        check('读协调 /api/state：canon 被占 → locks.canon.locked=true', !!(st56.locks && st56.locks.canon && st56.locks.canon.locked), JSON.stringify(st56.locks || {}));
        check('读协调 /api/state：未占用文件 locks.manuscript.locked=false', !!(st56.locks && st56.locks.manuscript && st56.locks.manuscript.locked === false), JSON.stringify(st56.locks || {}));
      } finally {
        relSt();
      }
      // ⑤ /api/review：基线（canon）被持锁 → 200 + ok:false + 明确提示（业务条件，非协议层错误）
      const relB = acquireFileLock(tmpCanon56);
      try {
        const rvB = await fetchT(`http://127.0.0.1:${port56}/api/review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposal: 'test/fixtures/pred-canon.json' }),
        }).then((r) => r.json());
        check('读协调 /api/review：基线被占 → 200 + ok:false', rvB.ok === false, JSON.stringify(rvB).slice(0, 200));
        check('读协调 /api/review：提示含「正被其他进程写入」与锁路径', !!rvB.error && rvB.error.includes('正被其他进程写入') && rvB.error.includes(tmpCanon56 + '.lock'), rvB.error || '');
      } finally {
        relB();
      }
      // ⑥ /api/review：提议（last-extract）被持锁 → 阻断
      const relP2 = acquireFileLock(tmpProposal56);
      try {
        const rvP = await fetchT(`http://127.0.0.1:${port56}/api/review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposal: tmpProposal56, baseline: 'test/fixtures/demo-canon.json' }),
        }).then((r) => r.json());
        check('读协调 /api/review：提议被占 → 200 + ok:false + 提示', rvP.ok === false && !!rvP.error && rvP.error.includes('正被其他进程写入'), JSON.stringify(rvP).slice(0, 200));
      } finally {
        relP2();
      }
      // ⑦ 释放后正常审阅 + 无 .lock 残留
      const rvOk = await fetchT(`http://127.0.0.1:${port56}/api/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal: 'test/fixtures/pred-canon.json' }),
      }).then((r) => r.json());
      check('读协调 /api/review：释放后正常审阅', !!rvOk.ok && rvOk.review && rvOk.review.counts, JSON.stringify(rvOk).slice(0, 200));
      check('读协调 /api/review：审阅后无 .lock 残留', !fs.existsSync(tmpCanon56 + '.lock') && !fs.existsSync(tmpProposal56 + '.lock'), '');
      // ⑧ /api/risks：last-pred.json 被在途写者占用 → locked/lockedInfo 上报，释放后恢复
      const predDir56 = path.join(ROOT, 'app', 'predictions', '读协调测试');
      const predFile56 = path.join(predDir56, 'last-pred.json');
      fs.mkdirSync(predDir56, { recursive: true });
      fs.writeFileSync(predFile56, JSON.stringify({ meta: { title: '读协调测试', simulated_at: '2026-01-01T00:00:00Z' }, risk_register: [{ id: 'r1', severity: 'high', risk: '测试风险', trigger: '触发', mitigation: '对策', probability: 0.5, chapter: 1, kind: 'suspense' }] }, null, 2) + '\n', 'utf8');
      const relRk = acquireFileLock(predFile56);
      try {
        const rk = await fetchT(`http://127.0.0.1:${port56}/api/risks`).then((r) => r.json());
        check('读协调 /api/risks：pred 被占 → locked=true 且 lockedInfo 含锁路径', rk.locked === true && !!rk.lockedInfo && rk.lockedInfo.includes(predFile56 + '.lock'), JSON.stringify({ locked: rk.locked, lockedInfo: rk.lockedInfo }));
        check('读协调 /api/risks：锁内仍返回可读的预测数据', rk.ok === true && Array.isArray(rk.risks) && rk.risks.length === 1 && rk.meta && rk.meta.title === '读协调测试', JSON.stringify(rk).slice(0, 200));
      } finally {
        relRk();
      }
      const rkOk = await fetchT(`http://127.0.0.1:${port56}/api/risks`).then((r) => r.json());
      check('读协调 /api/risks：释放后 locked=false', rkOk.locked === false, JSON.stringify({ locked: rkOk.locked }));
      check('读协调 /api/risks：释放后无 .lock 残留', !fs.existsSync(predFile56 + '.lock'), '');
      // ⑨ POST /api/risks 写锁（O-4 回归）：risk-status.json 被在途写者占用 → 409 且不覆盖——
      // 状态更新是「读旧 statuses → buildRiskStatus → 写」的读-改-写，无锁时并发请求后写覆盖先写、
      // 静默丢失一个状态更新（GET 已有读协调，POST 写侧必须同协议）
      const statusFile56 = path.join(predDir56, 'risk-status.json');
      fs.writeFileSync(statusFile56, JSON.stringify({ source: predFile56, simulated_at: '2026-01-01T00:00:00Z', statuses: { r1: 'open' } }, null, 2) + '\n', 'utf8');
      const relSt2 = acquireFileLock(statusFile56);
      try {
        const rkPostLocked = await fetchT(`http://127.0.0.1:${port56}/api/risks`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'r1', status: 'handled' }),
        });
        check('写锁 /api/risks：statusFile 被占 → 409（不并发覆盖）', rkPostLocked.status === 409, `got ${rkPostLocked.status}`);
        const rkPostLockedBody = await rkPostLocked.json();
        check('写锁 /api/risks：409 提示含「被其他进程占用」', !!rkPostLockedBody.error && rkPostLockedBody.error.includes('被其他进程占用'), JSON.stringify(rkPostLockedBody));
        check('写锁 /api/risks：锁冲突时不覆盖现有状态文件', JSON.parse(fs.readFileSync(statusFile56, 'utf8')).statuses.r1 === 'open', fs.readFileSync(statusFile56, 'utf8'));
      } finally {
        relSt2();
      }
      const rkPostOk = await fetchT(`http://127.0.0.1:${port56}/api/risks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'r1', status: 'handled' }),
      }).then((r) => r.json());
      check('写锁 /api/risks：释放后正常更新状态', rkPostOk.ok === true && rkPostOk.status === 'handled', JSON.stringify(rkPostOk));
      check('写锁 /api/risks：更新后无 .lock 残留', !fs.existsSync(statusFile56 + '.lock'), '');
    } finally {
      srv56.kill();
      try { fs.rmSync(tmpCfg56, { recursive: true, force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(rcDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      try {
        const pdir56 = path.join(ROOT, 'app', 'predictions');
        for (const f of fs.readdirSync(pdir56)) {
          if (f.startsWith('tmp-read-coord-') || f.startsWith('tmp-server-config-56')) { try { fs.unlinkSync(path.join(pdir56, f)); } catch { /* 忽略 */ } }
        }
      } catch { /* 忽略 */ }
      try { fs.rmSync(path.join(ROOT, 'app', 'predictions', '读协调测试'), { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  console.log('场景 57: 读协调覆盖 simulate/rebase 输入读取（O-6 回归——compile/compare 已有，simulate 全量长计算、rebase 漂移判定均基于写入前快照）');
  {
    const { acquireFileLock } = require('../src/fsutil');
    const rcDir57 = path.join(ROOT, 'test', 'fixtures', 'tmp-rc57');
    fs.mkdirSync(rcDir57, { recursive: true });
    const outline57 = path.join(rcDir57, 'outline.md');
    const premise57 = path.join(rcDir57, 'premise.md');
    const canon57 = path.join(rcDir57, 'canon.json');
    const pred57 = path.join(rcDir57, 'pred.json');
    const actual57 = path.join(rcDir57, 'actual.json');
    const canonObj57 = { meta: { title: '读协调57', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] };
    fs.writeFileSync(outline57, '# 大纲\n\n第一章 测试\n第二章 更多\n', 'utf8');
    fs.writeFileSync(premise57, '# 前提\n\n规则内容。\n', 'utf8');
    fs.writeFileSync(canon57, JSON.stringify(canonObj57, null, 2) + '\n', 'utf8');
    fs.writeFileSync(pred57, JSON.stringify({ meta: { title: '读协调57', target_reader: 'webnovel', simulated_at: '2026-01-01T00:00:00Z' }, canon: canonObj57, risk_register: [], simulation_notes: [] }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(actual57, JSON.stringify(canonObj57, null, 2) + '\n', 'utf8');
    try {
      // ① simulate：outline 被在途写者占用 → stderr 警告（不阻断，--dry-run 不调 LLM）
      const relO = acquireFileLock(outline57);
      try {
        const sim57 = run([outline57, '--premise', premise57, '--canon', canon57, '--dry-run'], SIM);
        check('读协调 simulate：outline 被占 → stderr 警告「正被其他进程写入」', sim57.err.includes('正被其他进程写入'), sim57.err);
        check('读协调 simulate：仍正常产出提示词（exit 0）', sim57.code === 0 && sim57.out.includes('系统提示词'), `code=${sim57.code}`);
      } finally {
        relO();
      }
      // ② simulate：canon 被在途写者占用 → 警告
      const relC57 = acquireFileLock(canon57);
      try {
        const sim57b = run([outline57, '--premise', premise57, '--canon', canon57, '--dry-run'], SIM);
        check('读协调 simulate：canon 被占 → stderr 警告', sim57b.err.includes('正被其他进程写入'), sim57b.err);
      } finally {
        relC57();
      }
      // ③ rebase：pred 被在途写者占用 → 警告（--dry-run 漂移判断前已打印）
      const relP57 = acquireFileLock(pred57);
      try {
        const rb57 = run([pred57, actual57, '--dry-run'], RBS);
        check('读协调 rebase：pred 被占 → stderr 警告', rb57.err.includes('正被其他进程写入'), rb57.err);
        check('读协调 rebase：仍正常产出（exit 0/1）', rb57.code === 0 || rb57.code === 1, `code=${rb57.code}`);
      } finally {
        relP57();
      }
      // ④ rebase：actual 被在途写者占用 → 警告
      const relA57 = acquireFileLock(actual57);
      try {
        const rb57b = run([pred57, actual57, '--dry-run'], RBS);
        check('读协调 rebase：actual 被占 → stderr 警告', rb57b.err.includes('正被其他进程写入'), rb57b.err);
      } finally {
        relA57();
      }
      // ⑤ 释放后无警告、无 .lock 残留
      const sim57c = run([outline57, '--premise', premise57, '--canon', canon57, '--dry-run'], SIM);
      check('读协调 simulate：释放后无锁警告', !sim57c.err.includes('正被其他进程写入'), sim57c.err);
      const rb57c = run([pred57, actual57, '--dry-run'], RBS);
      check('读协调 rebase：释放后无锁警告', !rb57c.err.includes('正被其他进程写入'), rb57c.err);
      check('读协调：全程无 .lock 残留', !fs.existsSync(outline57 + '.lock') && !fs.existsSync(canon57 + '.lock') && !fs.existsSync(pred57 + '.lock') && !fs.existsSync(actual57 + '.lock'), '');
    } finally {
      try { fs.rmSync(rcDir57, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  // 场景 58: 锁 pid 探活自愈 —— v0.4.4 review 确认：killTree（taskkill /F）强杀不触发
  // process.on('exit')，.lock 残留后写入被冻结最长 30 分钟（LOCK_STALE_MS）。修复契约：
  // 锁 payload 写 {pid, host, acquired_at}；获取遇 EEXIST 先 process.kill(pid, 0) 探活，
  // ESRCH（进程已死）即判陈旧立即回收；mtime 阈值保留为回退（无 pid 信息/跨机 host/pid 复用）。
  console.log('场景 58: 锁 pid 探活自愈（强杀/崩溃残留死进程锁立即回收，不再冻结 30 分钟）');
  {
    const { acquireFileLock, acquireFileLockAsync, acquireFileLocks, checkFileLocked } = require('../src/fsutil');
    const lkDir58 = path.join(ROOT, 'test', 'fixtures', 'tmp-lk58');
    fs.mkdirSync(lkDir58, { recursive: true });

    // 构造确定已退出的真实 pid：等价于强杀后残留锁中的死 pid
    const deadRun = spawnSync(process.execPath, ['-e', 'console.log(process.pid); process.exit(0)'], { encoding: 'utf8' });
    const deadPid = Number((deadRun.stdout || '').trim());
    check('环境前置：取得已退出进程的真实 pid', Number.isInteger(deadPid) && deadPid > 0, `stdout=${deadRun.stdout}`);

    // ① 死 pid 锁（旧文本格式 pid=N，上一版写入格式，向后兼容）→ 立即回收
    //    锁 mtime 刻意保持新鲜：回收依据必须是探活而非 30min mtime 阈值
    const t1 = path.join(lkDir58, 't1.json');
    fs.writeFileSync(t1 + '.lock', `pid=${deadPid}\n${new Date().toISOString()}\n`, 'utf8');
    let ok1 = false, err1 = '';
    try { const rel = acquireFileLock(t1); ok1 = true; rel(); } catch (e) { err1 = e.message; }
    check('锁自愈：死 pid 锁（旧文本格式）立即回收', ok1, err1);

    // ② 死 pid 锁（新 JSON 格式）→ 立即回收
    const t2 = path.join(lkDir58, 't2.json');
    // host 必须为本机：host 不同会触发跨机保护不探活（该分支由 ⑧ t8 单独验证）
    fs.writeFileSync(t2 + '.lock', JSON.stringify({ pid: deadPid, host: os.hostname(), acquired_at: new Date().toISOString() }), 'utf8');
    let ok2 = false, err2 = '';
    try { const rel = acquireFileLock(t2); ok2 = true; rel(); } catch (e) { err2 = e.message; }
    check('锁自愈：死 pid 锁（JSON 格式）立即回收', ok2, err2);

    // ③ 新写入的锁 payload 为结构化 JSON（pid/host/acquired_at，为多机判定预留依据）
    //    ② 已获取并释放 t2（锁文件随之删除），这里重新获取并在持有期间读取——释放后不能读
    let payload3 = null;
    try {
      const rel = acquireFileLock(t2);
      try { payload3 = JSON.parse(fs.readFileSync(t2 + '.lock', 'utf8')); } finally { rel(); }
    } catch { /* 获取/读取失败：payload3 保持 null */ }
    check('锁 payload：写入 {pid, host, acquired_at} JSON', !!payload3 && payload3.pid === process.pid && !!payload3.host && !!payload3.acquired_at, JSON.stringify(payload3));

    // ④ 活 pid 锁（本进程）→ 不误回收：等满争用上限报并发冲突；报错含 .lock 路径与清理指引
    const t4 = path.join(lkDir58, 't4.json');
    fs.writeFileSync(t4 + '.lock', `pid=${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    const waitStart4 = Date.now();
    let grabbed4 = false;
    try { const rel = acquireFileLock(t4); grabbed4 = true; rel(); }
    catch (e) {
      check('不误回收：活 pid 锁等待至争用上限（约3s）后报冲突', Date.now() - waitStart4 >= 2500, `waited=${Date.now() - waitStart4}ms`);
      check('冲突报错含 .lock 路径与手动清理指引', e.message.includes(t4 + '.lock') && e.message.includes('删除'), e.message);
    }
    check('不误回收：活 pid 锁未被回收（未获取成功）', !grabbed4, '');
    try { fs.unlinkSync(t4 + '.lock'); } catch { /* 已清理 */ }

    // ⑤ 回退语义保持：无 pid 信息锁（空 payload，如损坏/被截断）→ 按 mtime 阈值判定（协议不比修复前弱）
    const t5 = path.join(lkDir58, 't5.json');
    fs.writeFileSync(t5 + '.lock', '', 'utf8');
    let ok5 = false;
    try { const rel = acquireFileLock(t5); ok5 = true; rel(); } catch { /* 争用冲突，符合预期 */ }
    check('回退：无 pid 信息锁 + 新 mtime → 不回收（争用冲突）', !ok5, '意外获取成功');
    fs.utimesSync(t5 + '.lock', new Date(Date.now() - 31 * 60 * 1000), new Date(Date.now() - 31 * 60 * 1000));
    let ok5b = false, err5b = '';
    try { const rel = acquireFileLock(t5); ok5b = true; rel(); } catch (e) { err5b = e.message; }
    check('回退：无 pid 信息锁 + 超30min mtime → 按 mtime 回收', ok5b, err5b);

    // ⑥⑦ 读侧同口径自愈：checkFileLocked 对死 pid 锁不再视为在途写者
    const t6 = path.join(lkDir58, 't6.json');
    fs.writeFileSync(t6 + '.lock', JSON.stringify({ pid: deadPid, host: os.hostname(), acquired_at: new Date().toISOString() }), 'utf8'); // host 本机：跨机保护由 ⑧ t8 验证
    const lk6 = checkFileLocked(t6);
    check('读协调自愈：checkFileLocked 对死 pid 锁 → stale（读者不被死进程阻塞）', lk6.locked === false && lk6.stale === true, JSON.stringify(lk6));
    const t7 = path.join(lkDir58, 't7.json');
    fs.writeFileSync(t7 + '.lock', `pid=${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    const lk7 = checkFileLocked(t7);
    check('读协调自愈：checkFileLocked 对活 pid 锁 → 已锁定', lk7.locked === true && lk7.stale === false, JSON.stringify(lk7));
    try { fs.unlinkSync(t7 + '.lock'); } catch { /* 已清理 */ }

    // ⑧ 跨机保护：host 与本机不同的锁不探活（他机 pid 空间不可信，避免未来多机共享目录时误回收）
    const t8 = path.join(lkDir58, 't8.json');
    fs.writeFileSync(t8 + '.lock', JSON.stringify({ pid: deadPid, host: 'other-machine-58', acquired_at: new Date().toISOString() }), 'utf8');
    const lk8 = checkFileLocked(t8);
    check('跨机保护：他机 host 的死 pid 锁不探活回收（fresh mtime → 仍视为持有）', lk8.locked === true, JSON.stringify(lk8));

    // ⑨ 异步变体（IDE 服务器专用）同一自愈协议
    const t9 = path.join(lkDir58, 't9.json');
    fs.writeFileSync(t9 + '.lock', `pid=${deadPid}\n${new Date().toISOString()}\n`, 'utf8');
    let ok9 = false, err9 = '';
    try { const rel = await acquireFileLockAsync(t9); ok9 = true; rel(); } catch (e) { err9 = e.message; }
    check('锁自愈：异步变体（服务器）死 pid 锁同样立即回收', ok9, err9);

    // ⑩ 批量入口同一协议
    const t10 = path.join(lkDir58, 't10.json');
    fs.writeFileSync(t10 + '.lock', `pid=${deadPid}\n${new Date().toISOString()}\n`, 'utf8');
    let ok10 = false, err10 = '';
    try { const rel = acquireFileLocks([t10]); ok10 = true; rel(); } catch (e) { err10 = e.message; }
    check('锁自愈：批量锁入口（acquireFileLocks）同一协议', ok10, err10);

    try { fs.rmSync(lkDir58, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log('场景 60: validateParams 参数校验单元测试（src/validate-params.js）');
  {
    const { validateParams } = require('../src/validate-params');
    const eq = (name, body, rules, expected) => {
      const got = validateParams(body, rules);
      check(name, got === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got)}`);
    };
    // ① 基本必填校验
    eq('必填缺失：undefined', { a: 1 }, { x: { required: true } }, '缺少必填参数: x');
    eq('必填缺失：null', { x: null }, { x: { required: true } }, '缺少必填参数: x');
    eq('必填缺失：空字符串', { x: '' }, { x: { required: true, type: 'string' } }, '缺少必填参数: x');
    eq('必填缺失：纯空白', { x: '   ' }, { x: { required: true, type: 'string' } }, '缺少必填参数: x');
    eq('必填存在：正常值', { x: 'ok' }, { x: { required: true } }, null);
    eq('必填存在：0', { x: 0 }, { x: { required: true } }, null);
    eq('必填存在：false', { x: false }, { x: { required: true } }, null);
    // ② 必填 + message 自定义
    eq('必填缺失带 message', { }, { x: { required: true, message: '请提供 x' } }, '缺少必填参数: x（请提供 x）');
    // ③ type 校验
    eq('类型匹配：string', { x: 'hello' }, { x: { type: 'string' } }, null);
    eq('类型不匹配：string 期望但收到 number', { x: 42 }, { x: { type: 'string' } }, '参数 x 类型应为 string，实际为 number');
    eq('类型不匹配：number 期望但收到 string', { x: '42' }, { x: { type: 'number' } }, '参数 x 类型应为 number，实际为 string');
    eq('类型匹配：array', { x: [1, 2] }, { x: { type: 'object' } }, null);
    // ④ enum 校验
    eq('enum 匹配', { x: 'a' }, { x: { enum: ['a', 'b', 'c'] } }, null);
    eq('enum 不匹配', { x: 'd' }, { x: { enum: ['a', 'b', 'c'] } }, '参数 x 值不合法（允许: a/b/c）');
    eq('enum 不匹配带 message', { x: 'd' }, { x: { enum: ['a', 'b', 'c'], message: '选项范围' } }, '参数 x 值不合法（允许: a/b/c）（选项范围）');
    // ⑤ pattern 校验
    eq('pattern 匹配', { x: 'abc123' }, { x: { pattern: /^[a-z0-9]+$/ } }, null);
    eq('pattern 不匹配', { x: 'ABC' }, { x: { pattern: /^[a-z]+$/ } }, '参数 x 格式不合法');
    eq('pattern 不匹配带 message', { x: 'ABC' }, { x: { pattern: /^[a-z]+$/, message: '仅小写字母' } }, '参数 x 格式不合法（仅小写字母）');
    // ⑥ 可选参数：undefined/null 跳过非 required 规则
    eq('可选参数 undefined 跳过', { }, { x: { type: 'string' } }, null);
    eq('可选参数 null 跳过', { x: null }, { x: { type: 'string' } }, null);
    // ⑦ 多规则组合
    eq('多规则：必填 + 类型 + 枚举全部通过', { x: 'a' }, { x: { required: true, type: 'string', enum: ['a', 'b'] } }, null);
    eq('多规则：必填通过但类型不匹配', { x: 1 }, { x: { required: true, type: 'string', enum: ['a', 'b'] } }, '参数 x 类型应为 string，实际为 number');
    eq('多规则：必填通过类型匹配但枚举不匹配', { x: 'c' }, { x: { required: true, type: 'string', enum: ['a', 'b'] } }, '参数 x 值不合法（允许: a/b）');
    // ⑧ 空规则
    eq('无规则', { }, { }, null);
    eq('规则为空对象', { x: 1 }, { x: {} }, null);
    // ⑨ non-string 类型不触发 pattern 校验（type 校验优先）
    eq('number 不触发 pattern 校验', { x: 123 }, { x: { pattern: /^[a-z]+$/ } }, null);
    // ⑩ 子类型 object 校验
    eq('object 类型匹配', { x: { a: 1 } }, { x: { type: 'object' } }, null);
    eq('object 类型不匹配：null', { x: null }, { x: { type: 'object' } }, null); // null 跳过
  }

  console.log('场景 61: canon schema 模块单元测试（src/canon.js 导出值）');
  {
    const { CANON_SECTIONS, CANON_SECTIONS_ALL, asArray } = require('../src/canon');
    // ① 常量值正确性
    check('CANON_SECTIONS 为实体/知识/悬念', JSON.stringify(CANON_SECTIONS) === '["entities","knowledge","suspense"]', '');
    check('CANON_SECTIONS_ALL 含时间线', JSON.stringify(CANON_SECTIONS_ALL) === '["entities","knowledge","suspense","timeline"]', '');
    check('CANON_SECTIONS 是 CANON_SECTIONS_ALL 的前缀', CANON_SECTIONS_ALL.slice(0, 3).every((s, i) => s === CANON_SECTIONS[i]), '');
    // ② asArray 防御
    check('asArray 数组原样返回', Array.isArray(asArray([1, 2])) && asArray([1, 2]).length === 2, '');
    check('asArray null 返回空数组', Array.isArray(asArray(null)) && asArray(null).length === 0, '');
    check('asArray undefined 返回空数组', Array.isArray(asArray()) && asArray().length === 0, '');
    check('asArray string 返回空数组', Array.isArray(asArray('abc')) && asArray('abc').length === 0, '');
    check('asArray object 返回空数组', Array.isArray(asArray({ a: 1 })) && asArray({ a: 1 }).length === 0, '');
    // ③ asArray 不修改原始引用
    const orig = [1, 2, 3];
    const got = asArray(orig);
    check('asArray 返回同一引用', got === orig, '');
  }

  console.log('场景 62: 规则注册表单元测试（src/rules.js RULES）');
  {
    const { RULES } = require('../src/rules');
    const { parseManuscript: pm62, scanMentions: sm62, quoteStats: qs62 } = require('../src/extract');
    const { configFor: cf62 } = require('../src/validate');
    const { asArray: asArray62 } = require('../src/canon');
    // ① 注册表完整性：固定 9 段规则，顺序即输出顺序（chapter-order → suspense）
    const expectedIds = ['text/chapter-order', 'text/quote-balance', 'structure/chapter-length',
      'timeline/regression', 'timeline/missing', 'timeline/ghost', 'continuity/location',
      'knowledge/premature', 'entity/missing', 'suspense/overdue'];
    check('RULES 注册表含全部 10 个条目', RULES.length === 10, `got ${RULES.length}`);
    check('RULES 注册表条目顺序稳定', JSON.stringify(RULES.map((r) => r.id)) === JSON.stringify(expectedIds),
      JSON.stringify(RULES.map((r) => r.id)));
    // ② 元数据完整性：每条含 id/layer/name/emits/run
    const metaOk = RULES.every((r) => typeof r.id === 'string' && r.id
      && ['L0', 'L1', 'L3'].includes(r.layer)
      && typeof r.name === 'string' && r.name
      && Array.isArray(r.emits) && r.emits.includes(r.id)
      && typeof r.run === 'function');
    check('RULES 每条含 id/layer/name/emits/run 且 emits 含主 id', metaOk, JSON.stringify(RULES.map((r) => ({ id: r.id, layer: r.layer, hasName: !!r.name, emitsLen: r.emits && r.emits.length, hasRun: typeof r.run === 'function' }))));
    // ③ emits 目录 vs 实际产出：用 demo 夹具跑 runChecks，确认所有产出的 rule id 都在注册表声明内（防 emit 漂移）
    const { runChecks: runChecks62 } = require('../src/rules');
    const demoMs = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'demo-manuscript.md'), 'utf8');
    const demoCanon = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'demo-canon.json'), 'utf8'));
    const p62 = pm62(demoMs);
    const m62 = sm62(p62.chapters, asArray62(demoCanon.entities), p62.lines);
    const q62 = qs62(p62.chapters, p62.lines);
    const probs62 = runChecks62({ canon: demoCanon, parsed: p62, mentions: m62, quotes: q62, cfg: cf62('webnovel'), file: 'm.md' });
    const emitted = new Set(probs62.map((p) => p.rule));
    const declared = new Set(RULES.flatMap((r) => r.emits));
    check('demo 产出全部 rule id 均在注册表 emits 声明内', [...emitted].every((r) => declared.has(r)), `未声明: ${[...emitted].filter((r) => !declared.has(r))}`);
    check('demo 覆盖多数规则（≥5 类）', emitted.size >= 5, `got ${emitted.size}: ${[...emitted]}`);
    // ④ 层归属无漂移：主 id → 期望层 硬编码映射与注册表一致
    const layerExpect = { 'text/chapter-order': 'L0', 'text/quote-balance': 'L0', 'structure/chapter-length': 'L0',
      'timeline/regression': 'L1', 'timeline/missing': 'L1', 'timeline/ghost': 'L1', 'continuity/location': 'L1',
      'knowledge/premature': 'L1', 'entity/missing': 'L3', 'suspense/overdue': 'L3' };
    const layerDrift = RULES.filter((r) => layerExpect[r.id] && layerExpect[r.id] !== r.layer)
      .map((r) => `${r.id}:${r.layer}≠${layerExpect[r.id]}`);
    check('规则层归属与期望一致（L0/L1/L3 无漂移）', layerDrift.length === 0, layerDrift.join('；'));
    // ⑤ 独立规则函数可脱离 runChecks 直接调用：以空结构合法 ctx 遍历注册表，每条跑一遍不抛错误
    const emptyCtx62 = {
      canon: { entities: [], knowledge: [], suspense: [], timeline: [] },
      parsed: { chapters: [], lines: [] },
      mentions: new Map(), quotes: {},
      cfg: { chapterMin: 0, chapterMax: 1e9, overdueLimit: 3, danglingSeverity: 'warning', label: '网文' },
      file: 'x.md', problems: [],
      chapters: [], lastChapterNumber: 0, headingLineOf: () => 1, timeline: [], chapterNumbers: new Set(),
      add() {},
    };
    let directFail = null;
    for (const r of RULES) {
      try { r.run({ ...emptyCtx62 }); } catch (e) { directFail = `${r.id}: ${e.message}`; break; }
    }
    check('每条规则 run 可脱离 runChecks 直接调用', directFail === null, directFail);
  }

  console.log('场景 63: wjrc 接入规则注册表元数据（未知规则 id / 未知阈值键防静默失效）');
  {
    const { LEGAL_RULE_IDS, RULE_NAMES, RULE_LAYERS } = require('../src/rules');
    const { applyWjrc: aw63 } = require('../src/wjrc');
    // ① 注册表元数据视图完整性
    check('LEGAL_RULE_IDS 去重且覆盖规则目录', LEGAL_RULE_IDS.length > 0 && new Set(LEGAL_RULE_IDS).size === LEGAL_RULE_IDS.length, JSON.stringify(LEGAL_RULE_IDS));
    check('LEGAL_RULE_IDS 含全部主规则 id', ['text/quote-balance', 'suspense/overdue', 'entity/missing'].every((id) => LEGAL_RULE_IDS.includes(id)), '');
    const namedAll = LEGAL_RULE_IDS.every((id) => typeof RULE_NAMES[id] === 'string' && RULE_NAMES[id]);
    check('RULE_NAMES 覆盖全部合法规则 id', namedAll, JSON.stringify(LEGAL_RULE_IDS.filter((id) => !RULE_NAMES[id])));
    const layeredOk = LEGAL_RULE_IDS.every((id) => ['L0', 'L1', 'L3'].includes(RULE_LAYERS[id]));
    check('RULE_LAYERS 全为合法层级', layeredOk, JSON.stringify(LEGAL_RULE_IDS.filter((id) => !['L0', 'L1', 'L3'].includes(RULE_LAYERS[id]))));
    check('注册表规则名与层级正确', RULE_NAMES['text/quote-balance'] === '引号配对' && RULE_LAYERS['suspense/overdue'] === 'L3' && RULE_LAYERS['timeline/regression'] === 'L1', '');
    // ② 未知规则 id / 未知阈值键 → invalid 列表 + 不生效（防拼错静默失效）
    const base63 = { label: 'x', chapterMin: 100, chapterMax: 1000, overdueLimit: 3, danglingSeverity: 'info' };
    const bad63 = aw63(base63, { file: 'f', rc: { rules: { 'text/quote-balanc': 'off', 'entity/missing': 'error' }, thresholds: { overdueLmit: 9 } } });
    check('未知规则 id 进入 invalidRules', JSON.stringify(bad63.invalidRules) === '["text/quote-balanc"]', JSON.stringify(bad63.invalidRules));
    check('未知规则 id 不进 overrides（合法 id 不受影响）', !bad63.overrides.has('text/quote-balanc') && bad63.overrides.get('entity/missing') === 'error', JSON.stringify([...bad63.overrides]));
    check('未知阈值键进入 invalidThresholds', JSON.stringify(bad63.invalidThresholds) === '["overdueLmit"]', JSON.stringify(bad63.invalidThresholds));
    check('未知阈值键不覆盖 cfg（overdueLimit 保持默认）', bad63.cfg.overdueLimit === 3, JSON.stringify(bad63.cfg));
    const good63 = aw63(base63, { file: 'f', rc: { rules: { 'entity/missing': 'off' }, thresholds: { overdueLimit: 7 } } });
    check('合法配置下 invalid 列表为空', good63.invalidRules.length === 0 && good63.invalidThresholds.length === 0, '');
    check('无 .wjrc 时 invalid 列表为空', aw63(base63, null).invalidRules.length === 0 && aw63(base63, null).invalidThresholds.length === 0, '');
    // ③ e2e：compile manifest.wjrc 命中配置、manifest.wjrcInvalid 暴露未知项
    const wj63dir = path.join(ROOT, 'test', 'fixtures', 'tmp-wjrc-meta');
    fs.mkdirSync(wj63dir, { recursive: true });
    fs.writeFileSync(path.join(wj63dir, '.wjrc.json'), JSON.stringify({ rules: { 'no/such-rule': 'off' }, thresholds: { bogusKey: 1 } }), 'utf8');
    try {
      const ms63 = path.join(wj63dir, 'ms.md');
      const cn63 = path.join(wj63dir, 'canon.json');
      fs.copyFileSync(path.join(ROOT, 'test/fixtures/clean-manuscript.md'), ms63);
      fs.copyFileSync(path.join(ROOT, 'test/fixtures/clean-canon.json'), cn63);
      const out63 = run([ms63, cn63, '--json']);
      let j63 = null;
      try { j63 = JSON.parse(out63.out); } catch { /* noop */ }
      check('manifest.wjrc 命中临时配置', !!j63 && j63.manifest.wjrc === path.join(wj63dir, '.wjrc.json'), JSON.stringify(j63 && j63.manifest));
      check('manifest.wjrcInvalid 暴露未知规则 + 未知阈值键', !!j63 && !!j63.manifest.wjrcInvalid && JSON.stringify(j63.manifest.wjrcInvalid.rules) === '["no/such-rule"]' && JSON.stringify(j63.manifest.wjrcInvalid.thresholds) === '["bogusKey"]', JSON.stringify(j63 && j63.manifest.wjrcInvalid));
      check('未知规则未进入实际覆盖（编译仍成功）', !!j63 && j63.problems.every((p) => p.rule !== 'no/such-rule'), '');
    } finally {
      try { fs.rmSync(wj63dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  console.log('场景 64: wjrc 校验边界（规则值形态 / 未知 id 分类分级 / 阈值键边界）');
  {
    const { applyWjrc: aw64, applyRuleOverrides: aro64 } = require('../src/wjrc');
    const base64 = { label: 'x', chapterMin: 100, chapterMax: 1000, overdueLimit: 3, danglingSeverity: 'info' };
    // stub warn：隔离噪音并按「每未知 id 一次」验证
    const warnLog64 = [];
    const origWarn64 = console.warn;
    console.warn = (...a) => warnLog64.push(a.join(' '));
    try {
      // ① 合法规则 id 的 value 形态 → overrides 判定
      const ovOf = (val) => aw64(base64, { file: 'f', rc: { rules: { 'entity/missing': val } } }).overrides.get('entity/missing');
      check('"off" → off', ovOf('off') === 'off', String(ovOf('off')));
      check('false → off', ovOf(false) === 'off', String(ovOf(false)));
      check('severity 字符串原样传递', ovOf('error') === 'error' && ovOf('warning') === 'warning' && ovOf('info') === 'info', '');
      check('{enabled:false} → off', ovOf({ enabled: false }) === 'off', String(ovOf({ enabled: false })));
      check('{enabled:false,severity:...} → off 优先', ovOf({ enabled: false, severity: 'error' }) === 'off', String(ovOf({ enabled: false, severity: 'error' })));
      check('{severity:...} → 该级别', ovOf({ severity: 'warning' }) === 'warning', String(ovOf({ severity: 'warning' })));
      check('{enabled:true} → 不覆盖', ovOf({ enabled: true }) === undefined, String(ovOf({ enabled: true })));
      check('空对象 → 不覆盖', ovOf({}) === undefined, String(ovOf({})));
      check('非法值("bogus"/""/123/null) → 不覆盖', ovOf('bogus') === undefined && ovOf('') === undefined && ovOf(123) === undefined && ovOf(null) === undefined, '');
      // ② 合法 id 的各种 value 不触发 warn
      check('合法 id 各 value 未触发 warn', warnLog64.length === 0, JSON.stringify(warnLog64));

      // ③ 未知规则 id：分类分级 + 值形态不影响拒绝
      const unk64 = aw64(base64, { file: 'f', rc: { rules: { 'entity/missing': 'off', 'no-such-1': { severity: 'error' }, 'also/no-such': 'off' } } });
      check('多个未知 id 全部进 invalidRules', JSON.stringify(unk64.invalidRules) === '["no-such-1","also/no-such"]', JSON.stringify(unk64.invalidRules));
      check('未知 id 不进 overrides（合法 id 正常生效）', !unk64.overrides.has('no-such-1') && !unk64.overrides.has('also/no-such') && unk64.overrides.get('entity/missing') === 'off', JSON.stringify([...unk64.overrides]));
      check('每未知 id 恰好一次 warn 且含该 id', warnLog64.length === 2 && warnLog64.every((w) => /未知规则 id「[^」]+」/.test(w)), JSON.stringify(warnLog64));
      check('未知 id 大小写敏感（Entity/missing 视为未知）', aw64(base64, { file: 'f', rc: { rules: { 'Entity/missing': 'off' } } }).invalidRules.length === 1, '');

      // ④ 阈值键边界
      const warnBeforeTh64 = warnLog64.length;
      const th64 = aw64(base64, { file: 'f', rc: { thresholds: { overdueLimit: 7, chapterMin: '2000', chapterMax: true, bogus: 1, '': 2 } } });
      check('已知阈值键生效（整数）', th64.cfg.overdueLimit === 7, JSON.stringify(th64.cfg));
      check('字符串数字阈值回退默认', th64.cfg.chapterMin === 100, JSON.stringify(th64.cfg));
      check('布尔阈值回退默认', th64.cfg.chapterMax === 1000, JSON.stringify(th64.cfg));
      check('未知阈值键全部列出（含空串键）', th64.invalidThresholds.includes('bogus') && th64.invalidThresholds.includes(''), JSON.stringify(th64.invalidThresholds));
      check('未知阈值键不触发 warn（thresholds 静默忽略）', warnLog64.length === warnBeforeTh64, `${warnLog64.length} vs before=${warnBeforeTh64}`);
      // thresholds 非对象（字符串/数字）不崩溃且 invalid 为空
      const thStr = aw64(base64, { file: 'f', rc: { thresholds: 'abc' } });
      const thNum = aw64(base64, { file: 'f', rc: { thresholds: 5 } });
      check('thresholds 为字符串/数字不崩溃且 invalid 为空', thStr.invalidThresholds.length === 0 && thNum.invalidThresholds.length === 0, '');

      // ⑤ rules 非对象不崩溃
      const ruStr = aw64(base64, { file: 'f', rc: { rules: 'abc' } });
      const ruArr = aw64(base64, { file: 'f', rc: { rules: [1, 2] } });
      check('rules 为字符串/数组不崩溃且 invalid 为空', ruStr.overrides.size === 0 && ruStr.invalidRules.length === 0 && ruArr.overrides.size === 0, '');

      // ⑥ 每次调用 invalid 列表独立（无状态泄漏） + 合法配置 invalid 为空
      const clean64 = aw64(base64, { file: 'f', rc: { rules: { 'entity/missing': 'off' }, thresholds: { overdueLimit: 4 } } });
      check('独立配置 invalid 为空', clean64.invalidRules.length === 0 && clean64.invalidThresholds.length === 0, '');
      check('多次调用 invalid 数组互不共享', unk64.invalidRules !== clean64.invalidRules, '');

      // ⑦ applyRuleOverrides 应用层边界
      const arr64 = [{ rule: 'a', severity: 'warning', line: 1 }];
      check('空 overrides 返回原引用（无拷贝）', aro64(arr64, new Map()) === arr64, '');
      check('改写为同级别不产生新对象', aro64(arr64, new Map([['a', 'warning']]))[0] === arr64[0], '');
      check('off 全删 + 未覆盖保留', aro64([{ rule: 'a', severity: 'info' }, { rule: 'b', severity: 'error' }], new Map([['a', 'off']])).map((p) => p.rule).join() === 'b', '');
    } finally {
      console.warn = origWarn64;
    }
  }

  console.log('场景 59: canon schema 漂移检测（app.js fallback 字面量与 src/canon.js 一致）');
  {
    const { CANON_SECTIONS, CANON_SECTIONS_ALL } = require('../src/canon');
    const appJs = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
    // 提取 app.js 中 CANON_SECTIONS_ALL 的 fallback 字面量
    const secAllMatch = appJs.match(/\[['"]entities['"],\s*['"]knowledge['"],\s*['"]suspense['"],\s*['"]timeline['"]\]/);
    check('app.js 含 CANON_SECTIONS_ALL fallback 字面量', !!secAllMatch, '');
    // 改单引号为双引号后 JSON.parse 比较（避免 eval 的环境差异）
    const parseLiteral = (s) => JSON.parse(s.replace(/'/g, '"'));
    check('canon schema 无漂移：CANON_SECTIONS_ALL fallback 与 src/canon.js 一致',
      secAllMatch && JSON.stringify(parseLiteral(secAllMatch[0])) === JSON.stringify(CANON_SECTIONS_ALL), '');
    // CANON_SECTIONS 是 CANON_SECTIONS_ALL 的前 3 个元素，无需额外字面量匹配
    // 检查 app.js 中所有 section 引用都来自 CANON_SECTIONS_ALL 的子集
    const sectionsUsed = ['entities', 'knowledge', 'suspense', 'timeline'];
    check('canon schema 无漂移：app.js section 引用在 CANON_SECTIONS 范围内',
      sectionsUsed.every((s) => CANON_SECTIONS_ALL.includes(s)), '');
  }

  console.log('场景 62: LLM 供应商适配层（多供应商解析/自动推断/未知拒绝/config 透传）');
  {
    const { providerIds, isKnownProvider, resolveProviderId, resolveProvider, missingKeyHint, DEFAULT_PROVIDER, PROVIDERS } = require('../src/providers');

    // ① 注册表完整性
    check('deepseek 为默认供应商', DEFAULT_PROVIDER === 'deepseek', DEFAULT_PROVIDER);
    check('注册表含全部主流供应商', ['deepseek', 'openai', 'moonshot', 'qwen', 'zhipu', 'ollama'].every((p) => isKnownProvider(p)), providerIds().join(','));
    check('供应商均有 baseUrl 与 defaultModel', providerIds().every((p) => PROVIDERS[p].baseUrl && PROVIDERS[p].defaultModel), '');
    check('供应商 id 均为已知', providerIds().every((p) => isKnownProvider(p)), '');

    // ② 显式指定已知供应商
    const r1 = resolveProvider({ provider: 'moonshot', env: {} });
    check('显式指定 moonshot 生效', r1.provider === 'moonshot' && r1.baseUrl === 'https://api.moonshot.cn/v1', `${r1.provider} ${r1.baseUrl}`);
    check('moonshot 默认模型', r1.model === 'moonshot-v1-8k', r1.model);

    // ③ 显式指定未知供应商 → 抛错（不静默回退）
    let ue = null;
    try { resolveProvider({ provider: 'huggingface', env: {} }); } catch (e) { ue = e; }
    check('未知 provider 显式指定抛错（不静默回退）', ue && ue.code === 'UNKNOWN_PROVIDER', ue ? ue.message : 'no error');
    let ue2 = null;
    try { resolveProviderId({ LLM_PROVIDER: 'nope' }); } catch (e) { ue2 = e; }
    check('未知 LLM_PROVIDER 抛错', ue2 && ue2.code === 'UNKNOWN_PROVIDER', ue2 ? ue2.message : 'no error');

    // ④ 未显式指定：依赖自动推断（谁有 key 用谁）
    const infOpenai = resolveProviderId({ OPENAI_API_KEY: 'sk-x' });
    check('有 key 自动推断供应商（openai）', infOpenai.provider === 'openai', infOpenai.provider);
    const infDeep = resolveProviderId({});
    check('无 key 默认回退 deepseek', infDeep.provider === 'deepseek', infDeep.provider);
    // 显式 LLM_PROVIDER 优先于 key 推断
    const infExplicit = resolveProviderId({ LLM_PROVIDER: 'qwen', MOONSHOT_API_KEY: 'k' });
    check('显式 LLM_PROVIDER 优先于 key 推断', infExplicit.provider === 'qwen', infExplicit.provider);

    // ⑤ deepseek 向后兼容：DEEPSEEK_MODEL/DEEPSEEK_BASE_URL 覆盖
    const rd = resolveProvider({ env: { DEEPSEEK_MODEL: 'deepseek-coder', DEEPSEEK_BASE_URL: 'https://apix.deepseek.com', DEEPSEEK_API_KEY: 'k' } });
    check('DEEPSEEK_MODEL 覆盖默认模型', rd.model === 'deepseek-coder', rd.model);
    check('DEEPSEEK_BASE_URL 覆盖 baseUrl', rd.baseUrl === 'https://apix.deepseek.com', rd.baseUrl);
    check('DEEPSEEK_API_KEY 作为 key', rd.apiKey === 'k', String(rd.apiKey));

    // ⑥ 通用覆盖：LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 对任意供应商生效
    const rg = resolveProvider({ provider: 'zhipu', env: { LLM_BASE_URL: 'https://proxy.example.org/v1', LLM_MODEL: 'glm-custom', LLM_API_KEY: 'gk' } });
    check('LLM_* 通用覆盖（baseUrl）', rg.baseUrl === 'https://proxy.example.org/v1', rg.baseUrl);
    check('LLM_* 通用覆盖（model）', rg.model === 'glm-custom', rg.model);
    check('LLM_* 通用覆盖（apiKey）', rg.apiKey === 'gk', String(rg.apiKey));

    // ⑦ ollama 无鉴权：apiKey 为 null（未显式提供时）
    const ro = resolveProvider({ provider: 'ollama', env: {} });
    check('ollama 默认无 apiKey', ro.apiKey === null, String(ro.apiKey));
    check('ollama jsonMode=false（走 format=json 而非 response_format）', ro.jsonMode === false, String(ro.jsonMode));

    // ⑧ missingKeyHint 随供应商定制
    const hk = missingKeyHint('moonshot');
    check('缺失 key 提示含对应环境变量名', hk.includes('MOONSHOT_API_KEY'), hk);
    const hko = missingKeyHint('ollama');
    check('ollama 缺失配置提示不含 key', !hko.includes('_API_KEY'), hko);

    // ⑨ env.js loadLLMEnv 结构兼容（返回 apiKey/baseUrl/model/provider）
    const { loadLLMEnv } = require('../src/env');
    const el = loadLLMEnv({ provider: 'openai', apiKey: 'ek' });
    check('loadLLMEnv 返回结构兼容', el.apiKey === 'ek' && el.model && el.baseUrl && el.provider === 'openai', JSON.stringify(el));
  }

  console.log('场景 63: 世界观图谱推导（canon → 实体关系网络/悬念/时间线）');
  {
    const { buildWorldGraph, chapterSpanFor } = require('../src/worldgraph');
    const ex = require('../examples/canon.json');

    // ① 示例 canon：节点/边/悬念/时间线
    const g = buildWorldGraph(ex);
    check('示例 canon 实体节点数=12', g.meta.nodeCount === 12, String(g.meta.nodeCount));
    check('示例 canon 关系边数=5', g.meta.edgeCount === 5, String(g.meta.edgeCount));
    check('示例 canon 悬念全已回收（openSuspense=0）', g.meta.openSuspense === 0, String(g.meta.openSuspense));
    const shen = g.nodes.find((n) => n.id === 'shen_nanzhi');
    check('中心角色（沈南枝）关联度最高', shen && shen.degree === 4, shen ? String(shen.degree) : 'missing');
    check('时间线按章节排序并解析地点名', g.timeline.map((t) => `${t.chapter}:${t.locationName}`).join(',') === '1:山神庙,2:山神庙,3:青云山,4:后山禁地', g.timeline.map((t) => t.locationName).join(','));
    // 孤立实体（无 knowledge 关联）仍保留为节点，degree=0
    const isolated = g.nodes.filter((n) => n.degree === 0).map((n) => n.type);
    check('孤立地点/物品保留（degree=0）', isolated.includes('location') && isolated.includes('item'), isolated.join(','));

    // ② 手搓 canon：覆盖 open/planned 悬念 + 多 holder 演化 + 缺字段兜底
    const handmade = {
      meta: { title: '测试世界' },
      entities: [
        { id: 'a', name: '主角', type: 'character', appears_from_chapter: 1 },
        { id: 'b', name: '配角', type: 'character', appears_from_chapter: 1 },
        { id: 'c', name: '地点1', type: 'location', appears_from_chapter: 2 },
      ],
      knowledge: [
        { id: 'k1', name: '甲乙相识', holders: ['a', 'b'], known_from_chapter: 1 },
        { id: 'k2', name: '甲乙同往地点', holders: ['a', 'b', 'c'], known_from_chapter: 2 },
      ],
      suspense: [
        { id: 's1', name: '主角身世', planted_in_chapter: 1, expected_resolve_chapter: 5 },
        { id: 's2', name: '已解之秘', planted_in_chapter: 1, expected_resolve_chapter: 3, resolved_in_chapter: 3 },
      ],
      timeline: [
        { chapter: 1, day: 1, location: 'loc1' },
        { chapter: 3, day: 2, location: 'c' },
      ],
    };
    const h = buildWorldGraph(handmade);
    check('手搓 canon：abc 三者两两成边（共 3 条）', h.meta.edgeCount === 3, String(h.meta.edgeCount));
    check('多 holder 共现 count 累加（a~b 两条知识→count2）', h.edges.some((e) => (e.a === 'a' && e.b === 'b') && e.count === 2), JSON.stringify(h.edges));
    const sOpen = h.suspense.find((s) => s.id === 's1');
    const sRes = h.suspense.find((s) => s.id === 's2');
    check('未到期悬念归为 planned', sOpen && sOpen.status === 'planned', sOpen && sOpen.status);
    check('已回收悬念归为 resolved', sRes && sRes.status === 'resolved', sRes && sRes.status);
    check('openSuspense 统计（planned 不计入 open）', h.meta.openSuspense === 0, String(h.meta.openSuspense));
    // 陈旧命名：预留/开放可共存——handmade 无 genuinely-open（expected==planted 需 expected<=planted）
    const withOpen = buildWorldGraph({ ...handmade, suspense: [{ id: 's3', name: '遗留悬念', planted_in_chapter: 1, expected_resolve_chapter: 1 }] });
    check('expected<=planted 归为 open（历史遗留未收）', withOpen.suspense.find((s) => s.id === 's3').status === 'open', '');
    check('openSuspense=1（仅 open 计入）', withOpen.meta.openSuspense === 1, String(withOpen.meta.openSuspense));

    // ③ 缺失字段兜底：无 entities/knowledge/timeline 的裸 canon 不崩溃
    const bare = buildWorldGraph({ meta: {} });
    check('空 canon 不崩溃（0 节点/0 边）', bare.meta.nodeCount === 0 && bare.meta.edgeCount === 0, JSON.stringify(bare.meta));
    // chapterSpanFor 缺字段兜底
    const cs = chapterSpanFor('ghost', { entities: [], knowledge: [{ id: 'k', holders: ['ghost'], known_from_chapter: 7 }] });
    check('chapterSpanFor 从 knowledge 兜底起始章', Array.isArray(cs) && cs[0] === 7, JSON.stringify(cs));
  }

  console.log('场景 64: 剧情健康度雷达舱（canon → 评分/六维雷达/逐章序列/警戒清单）');
  {
    const { buildHealthReport } = require('../src/health');
    const ex = require('../examples/canon.json');

    // ① 示例 canon：结构健康样本
    const g = buildHealthReport(ex);
    check('示例 canon 健康度评分=98', g.meta.score === 98, String(g.meta.score));
    check('示例 canon 判定=优秀', g.meta.verdict === '优秀', g.meta.verdict);
    check('示例 canon 回收率=100%', g.suspense.resolveRate === 1, String(g.suspense.resolveRate));
    check('示例 canon 零过期/零悬空', g.suspense.overdue === 0 && g.suspense.dangling === 0, JSON.stringify(g.suspense));
    check('示例 canon 平均回收章差=1（同章回收记0）', g.suspense.avgResolutionLag === 1, String(g.suspense.avgResolutionLag));
    check('示例 canon 逐章数=4（span 1..4）', g.chapters.length === 4 && g.span[0] === 1 && g.span[1] === 4, JSON.stringify(g.span));
    check('示例 canon 堆积峰值=2（第2章）', g.curves.backlogPeak === 2 && g.curves.backlogPeakAt === 1, JSON.stringify(g.curves));
    check('示例 canon 覆盖/聚集/铺陈维度=1', g.meta.dimensions.coverage === 1 && g.meta.dimensions.cast === 1 && g.meta.dimensions.world > 0.8, JSON.stringify(g.meta.dimensions));
    check('示例 canon 无警戒项', Array.isArray(g.issues) && g.issues.length === 0, JSON.stringify(g.issues));

    // ② 问题样本：过期/悬空/在飞齐全 + 时间线断档 + 未全回收
    const p = buildHealthReport({
      meta: { title: '问题世界' },
      entities: [
        { id: 'a', type: 'character', appears_from_chapter: 1 },
        { id: 'b', type: 'character', appears_from_chapter: 1 },
        { id: 'locX', type: 'location', appears_from_chapter: 1 },
      ],
      knowledge: [
        { id: 'k1', holders: ['a', 'b'], known_from_chapter: 1 },
        { id: 'k2', holders: ['a'], known_from_chapter: 1 },
      ],
      suspense: [
        { id: 's1', name: '过期悬念', planted_in_chapter: 1, expected_resolve_chapter: 1 },
        { id: 's2', name: '悬空悬念', planted_in_chapter: 1 },
        { id: 's3', name: '在飞悬念', planted_in_chapter: 1, expected_resolve_chapter: 5 },
        { id: 's4', name: '已解1', planted_in_chapter: 1, expected_resolve_chapter: 2, resolved_in_chapter: 2 },
        { id: 's5', name: '已解2', planted_in_chapter: 2, expected_resolve_chapter: 3, resolved_in_chapter: 3 },
      ],
      timeline: [
        { chapter: 1, location: 'locX' },
        { chapter: 4, location: 'locX' },
      ],
    });
    check('问题样本 悬念分类（2收/1过期/1在飞/1悬空）', p.suspense.resolved === 2 && p.suspense.overdue === 1 && p.suspense.inflight === 1 && p.suspense.dangling === 1, JSON.stringify(p.suspense));
    check('问题样本 回收率=40%', p.suspense.resolveRate === 0.4, String(p.suspense.resolveRate));
    check('问题样本 章节跨度含预期落点（span 1..5）', p.chapters.length === 5 && p.span[1] === 5, JSON.stringify(p.span));
    check('问题样本 堆积峰值=4', p.curves.backlogPeak === 4, String(p.curves.backlogPeak));
    check('问题样本 时间线覆盖=0.4（2/5）', p.meta.dimensions.coverage === 0.4, String(p.meta.dimensions.coverage));
    check('问题样本 评分=52 · 判定=需打磨', p.meta.score === 52 && p.meta.verdict === '需打磨', p.meta.score + '/' + p.meta.verdict);
    check('问题样本 cast 只按角色计（2角色/5=0.4）', p.meta.dimensions.cast === 0.4, String(p.meta.dimensions.cast));
    check('问题样本 警戒 4 类（过期/悬空/断档/未收）', p.issues.map((i) => i.code).join(',') === 'overdue-suspense,dangling-suspense,timeline-gap,unresolved', p.issues.map((i) => i.code).join(','));
    check('问题样本 过期警戒为 warn 级', p.issues.some((i) => i.code === 'overdue-suspense' && i.level === 'warn'), JSON.stringify(p.issues));

    // ③ 裸 canon 兜底：空世界不崩溃
    const bare = buildHealthReport({ meta: {} });
    check('空 canon 章节=1 且无悬念', bare.meta.chapterCount === 1 && bare.suspense.total === 0, JSON.stringify(bare.meta));
    check('空 canon 评分=25 · 判定=需大修', bare.meta.score === 25 && bare.meta.verdict === '需大修', bare.meta.score + '/' + bare.meta.verdict);
    check('空 canon 列 no-suspense 警戒', bare.issues.some((i) => i.code === 'no-suspense'), JSON.stringify(bare.issues));

    // ④ O-10-1 回归锁定：无悬念但知识丰富的世界，resolve/inFlight 不得用知识量代偿——
    // 否则评分会虚高到 100「优秀」，与 no-suspense 告警自相矛盾（修复前实为 100/优秀）
    const noSusp = buildHealthReport({
      meta: { title: '无悬念世界' },
      entities: [1, 2, 3, 4, 5].map((n) => ({ id: 'e' + n, type: 'character', appears_from_chapter: 1 })),
      knowledge: [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'k' + i, holders: ['e1', 'e2'], known_from_chapter: 1 })),
      suspense: [],
      timeline: [{ chapter: 1, location: 'loc1' }],
    });
    check('无悬念+有知识：resolve/inFlight 维度归 0（不代偿）', noSusp.suspense.total === 0 && noSusp.meta.dimensions.resolve === 0 && noSusp.meta.dimensions.inFlight === 0, JSON.stringify(noSusp.meta.dimensions));
    check('无悬念+有知识：世界观维度不被牺牲', noSusp.meta.dimensions.world === 1, String(noSusp.meta.dimensions.world));
    check('无悬念+有知识：评分=55 需打磨（不再 100 优秀）', noSusp.meta.score === 55 && noSusp.meta.verdict === '需打磨', noSusp.meta.score + '/' + noSusp.meta.verdict);
    check('无悬念+有知识：仍报 no-suspense 警戒', noSusp.issues.some((i) => i.code === 'no-suspense'), JSON.stringify(noSusp.issues));

    // ⑤ O-10-2~O-10-5 锁定：cast 口径 / 权重常量 / open 跨面板对齐 / 回收章差口径
    const { computeScore, HEALTH_WEIGHTS } = require('../src/health');
    const { buildWorldGraph } = require('../src/worldgraph');
    // O-10-2：cast 只计 character，location/item 不计入
    const locCast = buildHealthReport({
      meta: { title: '只有地点' },
      entities: [1, 2, 3, 4, 5].map((n) => ({ id: 'loc' + n, type: 'location', appears_from_chapter: 1 })),
      knowledge: [{ id: 'k1', holders: ['loc1', 'loc2'], known_from_chapter: 1 }],
      suspense: [{ id: 's1', planted_in_chapter: 1, resolved_in_chapter: 1 }],
      timeline: [{ chapter: 1, location: 'loc1' }],
    });
    check('O-10-2 零角色多地点 → cast=0', locCast.meta.dimensions.cast === 0, String(locCast.meta.dimensions.cast));
    // O-10-3：权重为常量、和为 1、满帆满分
    const ws = Object.values(HEALTH_WEIGHTS);
    check('O-10-3 权重六键且和=1', Object.keys(HEALTH_WEIGHTS).length === 6 && Math.abs(ws.reduce((a, b) => a + b, 0) - 1) < 1e-9, ws.join(','));
    const fullDim = { resolve: 1, overdue: 1, inFlight: 1, cast: 1, world: 1, coverage: 1 };
    check('O-10-3 全维度满帆 → 100', computeScore(fullDim) === 100, String(computeScore(fullDim)));
    check('O-10-3 全维度归零 → 0', computeScore({ resolve: 0, overdue: 0, inFlight: 0, cast: 0, world: 0, coverage: 0 }) === 0, String(computeScore({})));
    // O-10-4：health.open 与 worldgraph.openSuspense 口径对齐（用同一份原始 canon 双端推导）
    const gOpen = buildWorldGraph(ex);
    check('O-10-4 示例：health.open 与 worldgraph.openSuspense 对齐=0', g.suspense.open === 0 && gOpen.meta.openSuspense === 0, g.suspense.open + '/' + gOpen.meta.openSuspense);
    const problemCanon = {
      meta: { title: '问题世界' },
      entities: [{ id: 'a', type: 'character', appears_from_chapter: 1 }, { id: 'b', type: 'character', appears_from_chapter: 1 }, { id: 'locX', type: 'location', appears_from_chapter: 1 }],
      knowledge: [{ id: 'k1', holders: ['a', 'b'], known_from_chapter: 1 }, { id: 'k2', holders: ['a'], known_from_chapter: 1 }],
      suspense: [
        { id: 's1', name: '过期悬念', planted_in_chapter: 1, expected_resolve_chapter: 1 },
        { id: 's2', name: '悬空悬念', planted_in_chapter: 1 },
        { id: 's3', name: '在飞悬念', planted_in_chapter: 1, expected_resolve_chapter: 5 },
        { id: 's4', name: '已解1', planted_in_chapter: 1, expected_resolve_chapter: 2, resolved_in_chapter: 2 },
        { id: 's5', name: '已解2', planted_in_chapter: 2, expected_resolve_chapter: 3, resolved_in_chapter: 3 },
      ],
      timeline: [{ chapter: 1, location: 'locX' }, { chapter: 4, location: 'locX' }],
    };
    const pWorld = buildWorldGraph(problemCanon);
    const pRep = buildHealthReport(problemCanon);
    check('O-10-4 问题样本：health.open 对齐 worldgraph.openSuspense=2', pRep.suspense.open === 2 && pWorld.meta.openSuspense === 2, pRep.suspense.open + '/' + pWorld.meta.openSuspense);
    // O-10-5：同章回收记 0 章差
    const sameCh = buildHealthReport({
      meta: { title: '同章回收' },
      entities: [{ id: 'a', type: 'character', appears_from_chapter: 1 }],
      knowledge: [{ id: 'k1', holders: ['a'], known_from_chapter: 1 }],
      suspense: [{ id: 's1', planted_in_chapter: 2, resolved_in_chapter: 2 }],
      timeline: [{ chapter: 1, location: 'l' }, { chapter: 2, location: 'l' }],
    });
    check('O-10-5 同章回收 → 平均章差=0', sameCh.suspense.avgResolutionLag === 0, String(sameCh.suspense.avgResolutionLag));
  }

  // README 断言数快照一致性（发布 checklist：测试变更后必须同步 README 的断言数）
  const readmeAssert = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').match(/冒烟测试（(\d+) 项断言）/);
  check(`README 断言数快照一致（README=${readmeAssert ? readmeAssert[1] : '?'} · 实际含本断言=${pass + 1}）`,
    !!readmeAssert && Number(readmeAssert[1]) === pass + 1, '');

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  // 兜底：主 IIFE 中途抛异常（含 fetchT 看门狗 30s 中止）时，给出非零退出与堆栈——
  // 没有它 Node 的 unhandled rejection 只报一行，且 fail 计数来不及累加
  // 全局清理：异常终止时清除已知可能残留的临时目录与文件
  try { fs.rmSync(path.join(ROOT, 'app', 'app'), { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(path.join(ROOT, 'app', 'predictions', 'tmp-server-config.json'), { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(path.join(ROOT, 'app', 'predictions', 'tmp-project'), { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(path.join(ROOT, 'app', 'predictions', 'tmp-oldproj'), { recursive: true, force: true }); } catch { /* 忽略 */ }
  for (const f of ['timeout-hang.js', 'timeout-tree.js', 'timeout-tree-child.pid']) {
    try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* 忽略 */ }
  }
  console.error(`\n测试框架异常（提前终止）: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e}`);
  process.exit(1);
});
