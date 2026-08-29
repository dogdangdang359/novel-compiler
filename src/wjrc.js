'use strict';

// 个人规则库 .wjrc.json：规则启停 / 级别覆盖 + 阈值覆盖（compile 与 simulate 共用）
// 查找顺序：手稿所在目录 -> 当前工作目录（就近优先）
// 示例：
// {
//   "rules": { "text/quote-balance": "off", "entity/missing": "error", "knowledge/premature": { "severity": "warning" } },
//   "thresholds": { "overdueLimit": 4, "chapterMin": 200, "chapterMax": 8000, "danglingSeverity": "info" }
// }
// 合法规则 id 目录取自规则注册表 RULES（src/rules.js），未知 id / 未知阈值键会警告并忽略（防静默失效）。

const fs = require('fs');
const path = require('path');
const { LEGAL_RULE_IDS } = require('./rules');

const SEVERITIES = ['error', 'warning', 'info'];
// 可配置阈值白名单（规则注册表的 cfg 层键）
const KNOWN_THRESHOLDS = ['overdueLimit', 'chapterMin', 'chapterMax', 'danglingSeverity'];

/**
 * 查找 .wjrc.json：按「锚点文件所在目录」就近优先（可传多个锚点，任一目录存在即命中），
 * 最后兜底当前工作目录。compile 传 [手稿, canon]，simulate 传 [大纲, canon]——
 * 保证同一项目的 .wjrc.json 无论放在哪个工作文件目录都能被两个工具一致读到。
 * @param {string|string[]|null} anchorPaths 锚点文件路径（可为 null/空，跳过）
 * @returns {string|null} 命中的配置文件路径
 */
function findWjrc(anchorPaths) {
  const list = Array.isArray(anchorPaths) ? anchorPaths : (anchorPaths ? [anchorPaths] : []);
  const dirs = [];
  for (const p of list) {
    if (p) dirs.push(path.dirname(path.resolve(p)));
  }
  dirs.push(process.cwd());
  for (const d of [...new Set(dirs)]) {
    const c = path.join(d, '.wjrc.json');
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 加载 .wjrc.json；不存在返回 null；解析失败返回 null 并警告。
 * @param {string|string[]|null} anchorPaths 锚点文件路径（见 findWjrc）
 * @returns {{file: string, rc: object}|null}
 */
function loadWjrc(anchorPaths) {
  const p = findWjrc(anchorPaths);
  if (!p) return null;
  try {
    return { file: p, rc: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    console.warn(`⚠ .wjrc.json 解析失败（忽略该配置）: ${p}（${e.message}）`);
    return null;
  }
}

/** 解析单条规则覆盖：'off' | severity | { enabled?, severity? }；无效返回 null */
function parseRuleOverride(value) {
  if (value === 'off' || value === false) return 'off';
  if (typeof value === 'string' && SEVERITIES.includes(value)) return value;
  if (value && typeof value === 'object') {
    if (value.enabled === false) return 'off';
    if (typeof value.severity === 'string' && SEVERITIES.includes(value.severity)) return value.severity;
    if (value.enabled === true) return null;
  }
  return null;
}

/**
 * 合并 .wjrc 到基础配置。未知 rule id 与未知阈值键会警告并忽略（防配置拼错后静默失效）。
 * @returns {{cfg: object, overrides: Map<rule, 'off'|severity>, invalidRules: string[], invalidThresholds: string[]}}
 */
function applyWjrc(baseCfg, loaded) {
  if (!loaded) return { cfg: baseCfg, overrides: new Map(), invalidRules: [], invalidThresholds: [] };
  const rc = loaded.rc;
  const cfg = { ...baseCfg };
  const overrides = new Map();
  const invalidRules = [];
  const invalidThresholds = [];
  if (rc.thresholds && typeof rc.thresholds === 'object') {
    // 先收集未知阈值键（警告并忽略，避免误写 keys 静默失效）
    for (const k of Object.keys(rc.thresholds)) {
      if (!KNOWN_THRESHOLDS.includes(k)) invalidThresholds.push(k);
    }
    for (const k of KNOWN_THRESHOLDS) {
      if (rc.thresholds[k] !== undefined) cfg[k] = rc.thresholds[k];
    }
    // 类型/取值范围校验（非法值回退读者向默认，而不是删除——删除会让规则静默失效）
    for (const k of ['overdueLimit', 'chapterMin', 'chapterMax']) {
      if (cfg[k] !== undefined && (!Number.isInteger(cfg[k]) || cfg[k] < 0)) cfg[k] = baseCfg[k];
    }
    // 一致性：下限不得大于上限（否则章节长度检查恒不触发，规则静默失效）
    if (cfg.chapterMin !== undefined && cfg.chapterMax !== undefined && cfg.chapterMin > cfg.chapterMax) {
      cfg.chapterMin = baseCfg.chapterMin;
      cfg.chapterMax = baseCfg.chapterMax;
    }
    if (!SEVERITIES.includes(cfg.danglingSeverity)) cfg.danglingSeverity = baseCfg.danglingSeverity;
  }
  if (rc.rules && typeof rc.rules === 'object') {
    for (const [rule, value] of Object.entries(rc.rules)) {
      if (!LEGAL_RULE_IDS.includes(rule)) {
        invalidRules.push(rule);
        console.warn(`⚠ .wjrc.json 存在未知规则 id「${rule}」，已忽略（合法规则见规则注册表；若为拼写错误请修正）`);
        continue;
      }
      const ov = parseRuleOverride(value);
      if (ov) overrides.set(rule, ov);
    }
  }
  return { cfg, overrides, invalidRules, invalidThresholds };
}

/** 应用规则覆盖：'off' 删除问题；级别覆盖改写 severity */
function applyRuleOverrides(problems, overrides) {
  if (!overrides.size) return problems;
  return problems
    .filter((p) => overrides.get(p.rule) !== 'off')
    .map((p) => {
      const ov = overrides.get(p.rule);
      return ov && ov !== 'off' && ov !== p.severity ? { ...p, severity: ov } : p;
    });
}

module.exports = { loadWjrc, applyWjrc, applyRuleOverrides, findWjrc, parseRuleOverride };
