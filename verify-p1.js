'use strict';
const fs = require('fs');
const { buildExtractPrompt, planExtractionChunks } = require('./src/extraction');
const { estimateTokens } = require('./src/llm');
const { configFor } = require('./src/validate');

// 构造与测试同款手稿：2 章 × 各 250 行短行（行号前缀开销占比放大）
const lines = [];
for (let i = 0; i < 2; i++) {
  lines.push(`# 第${i + 1}章 章名${i + 1}`, '');
  for (let j = 0; j < 250; j++) lines.push('正文内容一二三四五六七八九十');
}
const ms = lines.join('\n');
const baseline = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] };
const cfg = configFor('webnovel');

// 实际批次提示词（分块批 1-2 章会走 range 模式 → assembleNumbered，与全量 numberLines 不同）
const { system, user } = buildExtractPrompt({ manuscript: ms, baseline, cfg, range: { from: 1, to: 2 } });
const actual = estimateTokens(system) + estimateTokens(user);
console.log('实际批次提示词估算:', actual);

// 规划器口径：预算贴实际之上 → 不分块；预算贴实际之下 → 分块
const big = planExtractionChunks({ manuscript: ms, baseline, maxTokens: actual + 5000 });
console.log('预算 actual+5000 →', big === null ? 'null（不分块）' : `${big.length} 批`);
const tight = planExtractionChunks({ manuscript: ms, baseline, maxTokens: Math.round(actual * 0.98) });
console.log('预算 actual*0.98 →', tight === null ? 'null（不分块，测试无效！）' : `${tight.length} 批 ${JSON.stringify(tight.map((c) => c.tokens))}`);

// 模拟旧实现（裸章节文本 + 无系统提示词）判断同一预算
const { parseManuscript } = require('./src/extract');
const parsed = parseManuscript(ms);
let oldSum = estimateTokens(
  `【目标读者】webnovel【提取范围】仅第 1 至 9999 章【已有 canon（基线，必须保留其全部条目的 id 与 name）】`
  + JSON.stringify(baseline, null, 2)
  + `【正文（行号|内容，行号即证据锚点）】【要求】只输出 JSON：{ "canon": {...}, "evidence": {...}, "extraction_notes": [...] }`,
);
for (const ch of parsed.chapters) oldSum += estimateTokens(`${ch.title}\n${ch.text}`);
console.log('旧口径估算:', oldSum, 'vs 实际', actual, '· 低估', actual - oldSum, `(${(((actual - oldSum) / actual) * 100).toFixed(1)}%)`);
console.log('旧实现对预算 actual*0.98 会判定:', oldSum <= Math.round(actual * 0.98) ? '不分块（BUG 复现）' : '分块');

// 真实手稿验证：风雪夜归人 应分成 2 批
const realMs = fs.readFileSync('examples/风雪夜归人.md', 'utf8');
const realBase = JSON.parse(fs.readFileSync('examples/风雪夜归人-canon.json', 'utf8'));
const realChunks = planExtractionChunks({ manuscript: realMs, baseline: realBase, maxTokens: 48000 });
console.log('\n风雪夜归人（4.76 万 token 手稿）规划:', realChunks === null ? 'null（不分块——修复无效！）' : `${realChunks.length} 批`);
if (realChunks) realChunks.forEach((c) => console.log(`  批: 第${c.from}-${c.to}章 ≈ ${c.tokens} tokens`));
