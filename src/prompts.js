'use strict';

// 提示词构建：模拟器（大纲 -> 预测 canon + 风险登记册）

const SYSTEM_PROMPT = `你是「小说模拟器」：在动笔之前，把作者的大纲跑成一个可验证的"模拟小说环境"，预测动笔后可能出现的逻辑问题。
你只输出一个 JSON 对象，包含三个字段：canon（预测的设定库，必须严格符合下方 schema）、risk_register（风险登记册）、simulation_notes（模拟假设，字符串数组）。

## canon schema（字段名与枚举值不可变）
{
  "meta": { "title": "书名", "target_reader": "webnovel|genre|published", "genre": "题材" },
  "entities": [
    { "id": "小写字母或下划线id", "name": "名称", "aliases": ["别名"], "type": "character|location|item", "appears_from_chapter": 1 }
  ],
  "knowledge": [
    { "id": "k1", "name": "信息名称", "terms": ["知识专属特征词1", "特征词2"], "holders": ["实体id"], "known_from_chapter": 3 }
  ],
  "suspense": [
    { "id": "s1", "name": "悬念名称", "planted_in_chapter": 1, "expected_resolve_chapter": 5, "resolved_in_chapter": 5 }
  ],
  "timeline": [
    { "chapter": 1, "day": 1, "location": "实体id" }
  ]
}

## canon 规则（必须遵守）
1. 实体只收录跨章节引用的关键角色/地点/物件；状态粗粒度（位置、目标、立场、生死），不写情绪、体力等细粒度状态。
2. knowledge.terms 必须是「知情者获得该知识后才会说/用的话」，例如"暗格、黄铜钥匙"；禁止用泛指物品名（如"铜钟"）——角色看见某物不等于知道其秘密。
3. knowledge.known_from_chapter 必须与大纲吻合（谁在哪一章获知什么）；知情者不得在获知章之前使用该知识。
4. suspense 每条必须有 planted_in_chapter；resolved_in_chapter 可为 null（模拟结束时仍未回收）；回收章不得早于埋设章。
5. timeline 每章一条；day 是剧情内第几天，必须单调不减（不得回退）；location 引用 entities 中 type=location 的 id。
6. 所有 id 引用必须存在；同一数组内 id 不得重复。

## risk_register（风险登记册，最多 12 条，只报有价值的）
每条格式：{ "id": "R1", "chapter": 章号, "severity": "high|medium|low", "kind": "motivation|continuity|pacing|suspense|world|information", "risk": "风险描述", "probability": 0.0到1.0, "trigger": "触发条件（可验证的具体剧情条件）", "mitigation": "对策" }
覆盖维度：动机断裂、连续性/信息差、节奏、悬念超期、设定漏洞。
每条风险必须是"可验证的"：给出触发条件，让作者写完后能对照检查。
`;

function buildSimulatePrompt({ outline, premise, reader, cfg, existingCanon }) {
  const user = [
    `【目标读者】${cfg.label}（悬念悬置阈值 ${cfg.overdueLimit} 章；超期悬置至少报 medium）`,
    `【前提设定】\n${premise || '（未提供）'}`,
    `【大纲】\n${outline}`,
  ];
  if (existingCanon) {
    user.push(
      '【已有 canon（作者手写，权威基线）】',
      '```json',
      JSON.stringify(existingCanon, null, 2),
      '```',
      '要求：输出的 canon 必须**原样保留**已有 canon 中所有条目的 id 与 name（实体/知识/悬念都不得删除或改名），在此基础之上：',
      '1. 补全 timeline（每章一条，day 单调不减，location 使用已有地点 id）；',
      '2. 修正/补充字段值（appears_from_chapter、known_from_chapter、planted/expected/resolved_in_chapter）；',
      '3. 可以新增你认为必要的新条目（这属于预测性扩展，用新 id）。',
    );
  }
  user.push('【要求】只输出 JSON：{ "canon": {...}, "risk_register": [...], "simulation_notes": [...] }');
  return { system: SYSTEM_PROMPT, user: user.join('\n\n') };
}

// 修复轮：把校验错误反馈给模型，要求修正后重新输出完整 JSON
function buildFixPrompt(previous, errors) {
  return [
    '你上一次输出的 JSON 未通过校验，问题如下：',
    ...errors.map((e) => `- ${e}`),
    '请修正后重新输出完整的、符合 schema 的 JSON（字段结构不变，只修正内容）。',
  ].join('\n');
}

module.exports = { buildSimulatePrompt, buildFixPrompt, SYSTEM_PROMPT };
