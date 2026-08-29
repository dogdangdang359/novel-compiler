'use strict';

// 多项目配置：解析 / 旧格式迁移 / 活动项目持久化（纯函数，供服务器与测试使用）

const fs = require('fs');
const path = require('path');

const DEFAULT_READER = 'webnovel';

// 项目 id 作为 projects 字典 key：这三个保留字走 [[Set]] 会设置原型而非自有属性
// （JSON.stringify 时项目静默消失，或 `cfg.projects['__proto__']` 误判为存在）——统一拒绝
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isReservedKey(k) {
  return typeof k === 'string' && RESERVED_KEYS.has(k);
}
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 解析 config.json 文本 → 规范化状态。
 * 支持两种格式：
 *   新格式 { model, apiKey, activeProject, projects: { id: {manuscript, canon, outline, premise, reader} } }
 *   旧格式 { manuscript, canon, outline, premise, reader, model, apiKey }（单项目，自动迁移，
 *           项目名取 canon meta.title，读不到则"默认项目"）
 * @param {string} raw - config.json 原文
 * @param {string} appDir - 相对路径基准（app/）
 * @param {string} rootDir - 兜底路径基准（项目根）
 * @returns {{model, apiKey, active, projects: [{id, manuscript, canon, outline, premise, reader}]}}
 */
function parseConfig(raw, appDir, rootDir) {
  let cfg = null;
  let parseError = null;
  if (raw) {
    try { cfg = JSON.parse(raw); } catch (e) { parseError = `config.json 解析失败（文件损坏）: ${e.message}`; }
  }
  // 损坏 config：不静默给默认项目（掩盖损坏——用户以为 IDE 出问题）——
  // 返回空项目集 + parseError 标记，由启动方打印明确警告
  if (parseError) {
    return { model: 'deepseek-chat', apiKey: null, provider: null, active: null, projects: [], parseError };
  }
  cfg = cfg || {}; // raw 为 null（读失败）时按空配置处理，不崩溃
  const model = cfg.model || 'deepseek-chat';
  const apiKey = cfg.apiKey || null;
  // provider：显式指定的 LLM 供应商（缺省 null → 由 providers 适配层自动推断/回退 deepseek）
  const provider = (typeof cfg.provider === 'string' && cfg.provider) || null;
  const resolve = (v, def) => (v ? path.resolve(appDir, v) : path.resolve(rootDir, def));

  let projects;
  let active;
  if (cfg.projects && typeof cfg.projects === 'object' && !Array.isArray(cfg.projects)) {
    projects = Object.entries(cfg.projects).map(([id, p]) => ({
      id,
      manuscript: resolve(p && p.manuscript, 'examples/manuscript.md'),
      canon: resolve(p && p.canon, 'examples/canon.json'),
      outline: resolve(p && p.outline, 'examples/outline.md'),
      premise: resolve(p && p.premise, 'examples/premise.md'),
      reader: (p && p.reader) || DEFAULT_READER,
    }));
    active = cfg.activeProject && projects.some((p) => p.id === cfg.activeProject)
      ? cfg.activeProject
      : (projects[0] ? projects[0].id : null);
  } else {
    // 旧格式迁移：单项目，项目名取 canon meta.title
    const canonPath = resolve(cfg.canon, 'examples/canon.json');
    let title = '默认项目';
    try {
      const canon = JSON.parse(fs.readFileSync(canonPath, 'utf8'));
      if (canon.meta && canon.meta.title) title = canon.meta.title;
    } catch { /* 保持默认 */ }
    if (isReservedKey(title)) title = '默认项目'; // canon 标题撞保留字：不能当 projects key
    projects = [{
      id: title,
      manuscript: resolve(cfg.manuscript, 'examples/manuscript.md'),
      canon: canonPath,
      outline: resolve(cfg.outline, 'examples/outline.md'),
      premise: resolve(cfg.premise, 'examples/premise.md'),
      reader: cfg.reader || DEFAULT_READER,
    }];
    active = title;
  }
  return { model, apiKey, provider, active, projects, parseError: null };
}

/**
 * 把活动项目写回 config.json 文本（尽量保留用户原有内容：仅改 activeProject；
 * 旧格式则整体迁移为新格式，路径保持用户写的相对值）。
 * @returns {string} 新 config 文本
 */
function setActiveInConfig(raw, projectId) {
  let cfg = {};
  try { cfg = JSON.parse(raw); } catch { throw new Error('config.json 解析失败（文件损坏），拒绝写回'); }
  if (isReservedKey(projectId)) throw new Error(`项目名称不能使用保留字: ${projectId}`);
  if (!cfg.projects || typeof cfg.projects !== 'object' || Array.isArray(cfg.projects)) {
    cfg = {
      model: cfg.model || 'deepseek-chat',
      apiKey: cfg.apiKey || null,
      provider: cfg.provider || null,
      activeProject: projectId,
      projects: {
        [projectId]: {
          manuscript: cfg.manuscript,
          canon: cfg.canon,
          outline: cfg.outline,
          premise: cfg.premise,
          reader: cfg.reader || DEFAULT_READER,
        },
      },
    };
  } else {
    // 新格式：projectId 必须是 projects 的自有键（防写回指向不存在项目的幽灵 activeProject；
    // 用 hasOwn 而非真值判断——cfg.projects['__proto__'] 取到 Object.prototype，恒为真值）
    if (isReservedKey(projectId) || !hasOwn(cfg.projects, projectId)) throw new Error(`项目不存在: ${projectId}`);
    cfg.activeProject = projectId;
  }
  return JSON.stringify(cfg, null, 2) + '\n';
}

/**
 * 新建项目：写回 config 文本（旧格式自动迁移）。路径以相对 app/ 的字符串存储。
 * 旧格式（单项目平铺字段）迁移：旧项目的 manuscript/canon/outline/premise/reader
 * 保留为独立项目（id 取 canon 标题，与 parseConfig 口径一致）——不能丢旧字段，
 * 否则用户原有的工作文件指针在新建项目后永久丢失。
 * @param {string} appDir - 旧格式迁移时读 canon 标题的路径基准（与 parseConfig 的 appDir 同口径；
 *   缺省取本模块所在目录即 app/）
 * @returns {string} 新 config 文本
 * @throws 项目 id 为保留字（__proto__ 等）或 config 损坏时抛错
 */
function addProjectInConfig(raw, project, appDir) {
  let cfg = {};
  if (raw) { try { cfg = JSON.parse(raw); } catch { throw new Error('config.json 解析失败（文件损坏），拒绝写回'); } }
  if (isReservedKey(project.id)) throw new Error(`项目名称不能使用保留字: ${project.id}`);
  if (!cfg.projects || typeof cfg.projects !== 'object' || Array.isArray(cfg.projects)) {
    // 旧格式迁移：先取旧字段，再重建为新格式
    const oldFields = {
      manuscript: cfg.manuscript,
      canon: cfg.canon,
      outline: cfg.outline,
      premise: cfg.premise,
      reader: cfg.reader || DEFAULT_READER,
    };
    let oldTitle = '默认项目';
    if (cfg.canon) {
      try {
        // 相对路径以 app/ 为基准（与 parseConfig 的 resolve(appDir, ...) 口径一致——
        // 旧实现用 process.cwd()，从非 app/ 目录启动时解析错路径导致标题恒为默认）
        const canon = JSON.parse(fs.readFileSync(path.resolve(appDir || __dirname, cfg.canon), 'utf8'));
        if (canon.meta && canon.meta.title) oldTitle = canon.meta.title;
      } catch { /* canon 不可读时保持默认 */ }
    }
    if (isReservedKey(oldTitle)) oldTitle = '默认项目'; // canon 标题撞保留字：不能当 projects key
    cfg = { model: cfg.model || 'deepseek-chat', apiKey: cfg.apiKey || null, provider: cfg.provider || null, activeProject: project.id, projects: {} };
    cfg.projects[oldTitle] = oldFields;
  }
  // 重名拒绝：覆盖会静默丢掉既有项目的全部文件指针（数据丢失）。服务器层的 409 检查基于
  // 内存态 STATE.projects——config.json 被外部手改后内存与磁盘漂移即可绕过，这里按磁盘
  // 配置本体做第二道防线（与 setProjectPathInConfig 的 hasOwn 校验同原则）
  if (hasOwn(cfg.projects, project.id)) {
    throw new Error(`项目已存在: ${project.id}（覆盖会丢失既有项目的工作文件指针，请换一个项目名）`);
  }
  cfg.projects[project.id] = {
    manuscript: project.manuscript,
    canon: project.canon,
    outline: project.outline,
    premise: project.premise,
    reader: project.reader || DEFAULT_READER,
  };
  cfg.activeProject = project.id;
  return JSON.stringify(cfg, null, 2) + '\n';
}

/**
 * 另存为：更新某项目某文件类型的路径并写回 config 文本。
 * 旧格式（单项目平铺字段）迁移：旧项目字段保留为 projects[projectId]
 * （id 用 projectId，与 setActiveInConfig 迁移口径一致）——不丢旧字段，且迁移后能正常更新路径。
 * @returns {string} 新 config 文本
 * @throws 项目不存在时抛错
 */
function setProjectPathInConfig(raw, projectId, file, relPath) {
  let cfg = {};
  if (raw) { try { cfg = JSON.parse(raw); } catch { throw new Error('config.json 解析失败（文件损坏），拒绝写回'); } }
  if (!cfg.projects || typeof cfg.projects !== 'object' || Array.isArray(cfg.projects)) {
    // 旧格式迁移：先取旧字段，再重建为新格式并挂到 projectId 下
    const oldFields = {
      manuscript: cfg.manuscript,
      canon: cfg.canon,
      outline: cfg.outline,
      premise: cfg.premise,
      reader: cfg.reader || DEFAULT_READER,
    };
    cfg = { model: cfg.model || 'deepseek-chat', apiKey: cfg.apiKey || null, provider: cfg.provider || null, activeProject: projectId, projects: {} };
    cfg.projects[projectId] = oldFields;
  }
  if (isReservedKey(projectId)) throw new Error(`项目名称不能使用保留字: ${projectId}`);
  if (!hasOwn(cfg.projects, projectId)) throw new Error(`项目不存在: ${projectId}`);
  cfg.projects[projectId][file] = relPath;
  return JSON.stringify(cfg, null, 2) + '\n';
}

module.exports = { parseConfig, setActiveInConfig, addProjectInConfig, setProjectPathInConfig, isReservedKey };
