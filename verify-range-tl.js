'use strict';
const fs = require('fs');
const { validateExtraction } = require('./src/extraction');
const { parseManuscript } = require('./src/extract');

// 手稿：3 章（模拟 32 章手稿的缩小版）
const ms = ['# 第1章 A', '甲在村里。', '# 第2章 B', '乙进城了。', '# 第3章 C', '丙回来了。'].join('\n');
const parsed = parseManuscript(ms);
console.log('手稿章节:', parsed.chapters.map((c) => c.number).join(','));

// 模拟「空基线 + range 1-2 章」的模型输出（分块批 1 会遇到的真实形态）：
// timeline 只有 1-2 章（模型看不到第 3 章），基线 timeline 为空
const raw = {
  canon: {
    meta: { title: 'T', target_reader: 'webnovel' },
    entities: [{ id: 'a', name: '甲', aliases: [], type: 'character', appears_from_chapter: 1 }],
    knowledge: [], suspense: [],
    timeline: [{ chapter: 1, day: 1 }, { chapter: 2, day: 2 }],
  },
  evidence: {
    entities: { a: [{ chapter: 1, line: 2, quote: '甲在村里' }] },
    knowledge: {}, suspense: {},
    timeline: { '1': [{ chapter: 1, line: 2, quote: '甲在村里' }], '2': [{ chapter: 2, line: 4, quote: '乙进城了' }] },
  },
  extraction_notes: [],
};
const emptyBaseline = { meta: { title: 'T', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] };

console.log('\n== 空基线 + range{1,2}（分块批 1 / 手动 --from 1 --to 2）==');
const errs1 = validateExtraction(raw, { baseline: emptyBaseline, manuscript: ms, range: { from: 1, to: 2 } });
console.log(errs1.length === 0 ? '通过' : errs1.join('\n'));

console.log('\n== 完整基线（timeline 覆盖 3 章）+ range{1,2} ==');
const fullBaseline = JSON.parse(JSON.stringify(emptyBaseline));
fullBaseline.timeline = [{ chapter: 1, day: 1 }, { chapter: 2, day: 2 }, { chapter: 3, day: 3 }];
const raw2 = JSON.parse(JSON.stringify(raw));
raw2.canon.timeline.push({ chapter: 3, day: 3 }); // 模型按基线原样带回范围外章
const errs2 = validateExtraction(raw2, { baseline: fullBaseline, manuscript: ms, range: { from: 1, to: 2 } });
console.log(errs2.length === 0 ? '通过' : errs2.join('\n'));
