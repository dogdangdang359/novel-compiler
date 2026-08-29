'use strict';

// 大纲回写 + 前提回写：把已写正文回写成 as-built 文档（重构流水线的 ②③ 段）
// 输出为 Markdown 文本（非 JSON），带轻量确定性校验（覆盖全部实际章节 / 必需小节）

const { parseManuscript, cnToInt } = require('./extract');
const { asArray } = require('./canon');

function buildOutlinePrompt({ manuscript, existingOutline, premise, cfg, title }) {
  const chapters = parseManuscript(manuscript).chapters.filter((c) => c.number !== null).map((c) => c.number);
  // 楔子/序章（第0章）在大纲里通常写作「楔子」标题，给模型明确的标签
  const chLabel = chapters.map((n) => (n === 0 ? '楔子/序章（第0章）' : `第${n}章`)).join('、');
  const system = `你是「大纲回写器」：把已写正文回写成与正文一致的章节大纲（as-built 大纲），把实际剧情固化回规划文档。你只输出 Markdown 大纲文本，不输出 JSON。
规则：
1. 覆盖正文中实际出现的所有章（${chLabel}），每章用 "## 第N章 标题" 开头（楔子/序章用 "## 楔子" 或 "## 序章"）。
2. 每章 2-4 条要点：该章发生的事 / 涉及的关键设定与悬念动作 / 结尾钩子。
3. 只描述正文实际内容，不推测未写内容；不新增剧情。
4. 若提供了已有大纲，以正文为准修订：保留仍然成立的结构与语气，删除已不成立的，补充新出现的。
5. 一级标题（书名）**不得沿用旧大纲的书名**：若正文第一行是非章节标题行则使用它；否则根据故事主角/主题重拟一个简洁书名。`;
  const user = [
    `【目标读者】${cfg.label}`,
    title ? `【书名】${title}（一级标题必须使用此书名）` : null,
    premise ? `【现有前提设定】\n${premise}` : '【现有前提设定】无',
    existingOutline ? `【现有大纲（以正文为准修订）】\n${existingOutline}` : '【现有大纲】无',
    `【正文】\n${manuscript}`,
    '【要求】输出完整 Markdown 大纲（从书名一级标题开始，逐章 ## 标题 + 要点列表）。',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

function validateOutline(text, manuscript) {
  const errors = [];
  if (typeof text !== 'string' || !text.trim()) return ['输出为空'];
  if (text.length < 100) errors.push('大纲过短（<100 字）');
  const chapters = parseManuscript(manuscript).chapters.filter((c) => c.number !== null).map((c) => c.number);
  for (const n of chapters) {
    // 楔子/序章（第0章）：大纲写作「楔子/序章」或「第0章」均可
    if (n === 0) {
      if (!/楔子|序章|第\s*0\s*章/.test(text)) errors.push('大纲缺少「楔子/序章」标题');
    } else if (!new RegExp(`第\\s*${n}\\s*章`).test(text)) {
      errors.push(`大纲缺少「第${n}章」标题`);
    }
  }
  return errors;
}

function buildPremisePrompt({ manuscript, existingPremise, outline, cfg, title }) {
  const system = `你是「设定回写器」：从正文提炼世界规则、角色初始状态、风格基调与核心冲突（as-built 设定），用于更新前提文档。你只输出 Markdown 文本，不输出 JSON。
规则：
1. 分节输出，包含：世界规则 / 角色初始状态 / 基调与风格 / 核心冲突与悬念策略。
2. 只依据正文事实提炼，不脑补正文没有的设定。
3. 若提供了已有前提，保留仍然成立的内容，按正文修正已变化的，补充新出现的。
4. 一级标题（书名）沿用当前大纲的书名（若未提供大纲则按正文重拟），**不得沿用旧前提的旧书名**。
5. 「角色初始状态」写角色的立场/目标/关系与当前处境，**不要把结局写进初始状态**（结局属于 as-built 大纲）。`;
  const user = [
    `【目标读者】${cfg.label}`,
    title ? `【书名】${title}（一级标题必须使用此书名）` : null,
    outline ? `【当前大纲】\n${outline}` : '【当前大纲】无',
    existingPremise ? `【现有前提（以正文为准修订）】\n${existingPremise}` : '【现有前提】无',
    `【正文】\n${manuscript}`,
    '【要求】输出完整 Markdown 前提文档（从书名一级标题开始，包含四个分节）。',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

function validatePremise(text) {
  const errors = [];
  if (typeof text !== 'string' || !text.trim()) return ['输出为空'];
  if (text.length < 150) errors.push('前提过短（<150 字）');
  if (!/规则|设定/.test(text)) errors.push('缺少世界规则/设定内容');
  if (!/角色/.test(text)) errors.push('缺少角色内容');
  return errors;
}

// 跨文件同步检查（确定性）：章节集合一致性 + 标题一致性
// 输入：手稿文本、canon 对象（或 null）、大纲文本（或 null）、前提文本（或 null）
function syncReport({ manuscript, canon, outline, premise }) {
  const issues = [];
  const msCh = parseManuscript(manuscript).chapters.filter((c) => c.number !== null).map((c) => c.number);
  const outlineCh = outline
    ? [...new Set([
        ...[...outline.matchAll(/第\s*([0-9]+|[零一二三四五六七八九十百千万]+)\s*章/g)].map((m) => cnToInt(m[1].replace(/\s/g, ''))).filter((n) => n !== null),
        ...(/楔子|序章/.test(outline) ? [0] : []),
      ])]
    : [];
  if (canon) {
    const tlCh = asArray(canon.timeline).map((t) => t.chapter);
    for (const n of msCh) if (!tlCh.includes(n)) issues.push(`⚠ canon 时间线缺正文已有的第${n}章`);
    for (const n of tlCh) if (!msCh.includes(n)) issues.push(`⚠ canon 时间线有正文没有的第${n}章`);
  }
  if (outline) {
    for (const n of msCh) if (!outlineCh.includes(n)) issues.push(`⚠ 大纲缺正文已有的第${n}章`);
    for (const n of outlineCh) if (!msCh.includes(n)) issues.push(`⚠ 大纲有正文没有的第${n}章`);
  }
  const h1 = (t) => { const m = t && t.match(/^#\s*(.+)$/m); return m ? m[1].trim() : null; };
  const core = (s) => s.replace(/·.*$/, '').replace(/《|》/g, '').trim();
  const oTitle = h1(outline);
  const pTitle = h1(premise);
  if (oTitle && pTitle && core(oTitle) !== core(pTitle)) issues.push(`⚠ 大纲与前提的书名不一致：「${oTitle}」 vs 「${pTitle}」`);
  if (canon && canon.meta && canon.meta.title && oTitle) {
    const t = canon.meta.title;
    if (!oTitle.includes(core(t)) && !core(oTitle).includes(core(t))) {
      issues.push(`⚠ canon 书名「${t}」与大纲标题「${oTitle}」不一致`);
    }
  }
  return issues;
}

module.exports = { buildOutlinePrompt, validateOutline, buildPremisePrompt, validatePremise, syncReport };
