#!/usr/bin/env node
'use strict';

// 文检 IDE · 本地服务器（零框架）
// 静态资源（public + Monaco）+ 流水线 API（compile/extract/simulate/compare/rebase）
// 用法: node app/server.js [--port 3090]   （或环境变量 PORT）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { validateCanon, READERS } = require('../src/validate');
const { reviewProposal, applyReview } = require('../src/review');
const { parseConfig, setActiveInConfig, addProjectInConfig, setProjectPathInConfig, isReservedKey } = require('./config-util');
const { parseRiskStatus, buildRiskStatus, isStale, STATUSES } = require('./risks');
const { TOOL_TIMEOUT_MS, pruneBackups, atomicWrite: atomicWriteFile, acquireFileLockAsync, checkFileLocked } = require('../src/fsutil');
const { VERSION } = require('../src/version');
const { unwrapEnvelope } = require('../src/canonio');
const { CANON_SECTIONS, CANON_SECTIONS_ALL, asArray } = require('../src/canon');
const { validateParams } = require('../src/validate-params');
const { resolveProvider } = require('../src/providers');
const { buildWorldGraph } = require('../src/worldgraph');
const { buildHealthReport } = require('../src/health');

const APP = __dirname;
const ROOT = path.join(APP, '..');
const PUBLIC = path.join(APP, 'public');
const VENDOR = path.join(APP, 'node_modules', 'monaco-editor', 'min');
const PRED_DIR = path.join(APP, 'predictions');
// 新建项目时单个上传文件的内容上限（readBody 全局 20MB；这里按工作文件更严，防单文件撑爆）
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
// 配置文件路径：默认 app/config.json；测试可传 --config <path> 用临时配置（不触碰用户配置）
const CONFIG_PATH = (() => {
  const i = process.argv.indexOf('--config');
  if (i !== -1 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return path.join(APP, 'config.json');
})();

// 预测产物按项目隔离：predictions/<sanitized-projectId>/ 下的
// last-pred.json / last-extract.json / risk-status.json —— 多项目切换时不会互相覆盖。
// 读取时兜底兼容旧的单项目路径（predictions/last-*.json），写入一律进新目录。
const predDirOf = (projectId) => {
  const safe = String(projectId || '').replace(/[\\/:*?"<>|]/g, '_') || 'default';
  return path.join(PRED_DIR, safe);
};
function predFilePath(projectId, name) {
  return path.join(predDirOf(projectId), name);
}
function resolvePredFile(projectId, name) {
  const p = predFilePath(projectId, name);
  if (fs.existsSync(p)) return p;
  const legacy = path.join(PRED_DIR, name);
  return fs.existsSync(legacy) ? legacy : p;
}
const riskPredFileOf = (projectId) => resolvePredFile(projectId, 'last-pred.json');
const riskStatusFileOf = (projectId) => resolvePredFile(projectId, 'risk-status.json');
const lastExtractFileOf = (projectId) => resolvePredFile(projectId, 'last-extract.json');

// 端口解析：--port 0（随机端口）是合法值，不能用 `x || 3090` 吞掉；非法值回退默认并警告
function resolvePort() {
  const raw = (process.env.PORT !== undefined && process.env.PORT !== '')
    ? process.env.PORT
    : (process.argv[2] === '--port' && process.argv[3] !== undefined ? process.argv[3] : null);
  if (raw === null) return 3090;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  console.warn(`⚠ 无效端口 "${raw}"，使用默认 3090`);
  return 3090;
}
const PORT = resolvePort();
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- 配置（多项目） ----------
// 读取失败语义：文件不存在 → '{}'（首次运行正常）；存在但读失败（磁盘/权限错误）→ null
// ——调用方不得基于 null 做"写回"决策（旧实现失败返回 '{}'，persistActive 会把空配置
// 迁移写回，用户原有 config.json 被清空）。
function readConfigRaw() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return '{}';
    return fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return null;
  }
}
let STATE = parseConfig(readConfigRaw(), APP, ROOT);
// 损坏 config：启动时明确警告（不静默默认——parseConfig 已返回空项目集 + parseError）
if (STATE.parseError) {
  console.warn(`⚠ ${STATE.parseError}`);
  console.warn(`  按空配置启动（无项目）；请修复 ${CONFIG_PATH} 后再使用多项目功能`);
}

function currentProject() {
  return STATE.projects.find((p) => p.id === STATE.active) || (STATE.projects[0] || null);
}
function workFiles() {
  const p = currentProject();
  return p ? [p.manuscript, p.canon, p.outline, p.premise] : [];
}
function persistActive(projectId) {
  const raw = readConfigRaw();
  if (raw === null) return false; // 读失败：不做写回决策（防止空配置覆盖用户 config）
  return writeConfigContent(setActiveInConfig(raw, projectId));
}
function writeConfigContent(content) {
  try {
    atomicWriteFile(CONFIG_PATH, content);
    return true;
  } catch { return false; }
}
// 写前备份（与 refactor 一致：<文件>.bak-<时间戳>），由调用方决定是否 pruneBackups 清理
function backupFile(p) {
  if (!fs.existsSync(p)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${p}.bak-${ts}`;
  try { fs.copyFileSync(p, target); return target; } catch { return null; }
}

function apiKey() {
  if (STATE.apiKey) return STATE.apiKey;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  // 本机 DSH 凭据兜底（若 DSH_HOME 存在）
  try {
    const home = process.env.DSH_HOME;
    if (home) {
      const cred = path.join(home, '.credentials.yaml');
      if (fs.existsSync(cred)) {
        const line = fs.readFileSync(cred, 'utf8').split(/\r?\n/).find((l) => /^\s*DEEPSEEK_API_KEY\s*:/.test(l));
        if (line) {
          // 值可能含冒号（不能用 split(':', 2) 截断）；剥离行内注释与 YAML 引号
          let v = line.slice(line.indexOf(':') + 1).split(/\s+#/)[0].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          return v || null;
        }
      }
    }
  } catch { /* 忽略 */ }
  return null;
}

// 解析生效 LLM 连接：供应商（config.provider 或 env 自动推断）+ 对应 API key 环境变量名。
// 返回 { provider, keyEnv, apiKey }；spawn 子进程时据此注入正确 keyEnv，子进程 CLI 才能读到。
function resolvedLLM() {
  const r = resolveProvider({ provider: STATE.provider || undefined, apiKey: apiKey() || undefined });
  const keyEnv = r.provider && r.provider !== 'ollama' ? `${r.provider.toUpperCase()}_API_KEY` : null;
  return { provider: r.provider, keyEnv, apiKey: r.apiKey };
}

function isAllowedWrite(file) {
  const r = path.resolve(file);
  if (workFiles().includes(r)) return true;
  if (r.startsWith(PRED_DIR + path.sep)) return true;
  return false;
}

// 路径必须落在项目根目录内（另存为/存储为的目标限制，防止写出项目任意落盘）
function isInsideRoot(p) {
  const r = path.resolve(ROOT);
  const t = path.resolve(p);
  return t === r || t.startsWith(r + path.sep);
}

// 读取白名单：项目自身工作文件（可能位于磁盘任意位置，用户显式配置）+ 项目根内文件
// （含 predictions/ 产物）。/api/review 等按 body 路径读文件时必须先过此关，
// 否则恶意调用可借服务端读任意本地 JSON（基线/提议路径来自请求体）。
function isAllowedRead(p) {
  const r = path.resolve(p);
  if (workFiles().includes(r)) return true;
  return isInsideRoot(r);
}

// 流水线工具名校验：仅允许合法的脚本名（禁止路径分隔符 / .. / 扩展名注入）
// 脚本必须存在于项目根目录下（ROOT/<tool>.js）
function toolScript(tool) {
  if (typeof tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(tool)) return null;
  const script = path.join(ROOT, `${tool}.js`);
  return fs.existsSync(script) ? script : null;
}

// 浏览器跨站请求防护：POST /api/* 若携带 Origin 头，必须是本机来源（127.0.0.1/localhost/::1）
// 且端口与服务器实际监听端口一致；无 Origin（CLI/curl/Node fetch）放行。
function isTrustedOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '::1') return false;
    const op = u.port || (u.protocol === 'https:' ? '443' : '80');
    return op === String(port);
  } catch { return false; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// ---------- 工具执行（带超时：挂起的 LLM 调用不会无限阻塞） ----------
const { killTree } = require('../src/proctree');

// 流水线工具互斥锁：按活动项目粒度串行。同一项目的模拟/提取/重构会写该项目
// 的 last-pred.json / last-extract.json / canon，并发会互相覆盖——按项目加锁，
// 不同项目互不阻塞（原为全局锁，多项目会互相 409）。
const toolLocks = new Set();
const runLockKey = () => (typeof STATE.active === 'string' && STATE.active) || '_none';
function tryLockTool() { const k = runLockKey(); if (toolLocks.has(k)) return null; toolLocks.add(k); return k; }
function unlockTool(k) { if (k != null) toolLocks.delete(k); }

// 用户透传 args 的本地纵深防线（/api/run、/api/run-stream）：全库透传的 --out
// 等可被利用覆写任意文件。编译器也顽固：IDE 合法调用均为 ROOT 内相对路径、无 `..`、
// 无 NUL，故采用"不依赖具体工具语法"的通用护栏——限条目/长度/体积，且每个 arg
// 解析后必须落在 ROOT 内（拒绝绝对越界路径与 `..` 穿越）。flag 名与 reader/model 等
// 枚举值无分隔符，经 path.resolve 落在 ROOT 下，不会误伤。
const MAX_RUN_ARGS = 64;
const MAX_RUN_ARG_LEN = 4096;
const MAX_RUN_ARGS_BYTES = 64 * 1024;
function checkRunArgs(args, root) {
  if (!Array.isArray(args)) return 'args 必须是数组';
  const n = args.length;
  // 空 args 无任何覆写风险（没有位置参数不可能触发 --out），放行；只拦截过度/越界的
  if (n > MAX_RUN_ARGS) return `args 数量过多（>${MAX_RUN_ARGS}）`;
  let total = 0;
  for (const a of args) {
    if (typeof a !== 'string') return 'args 只能包含字符串';
    if (a.length === 0) return 'args 含空字符串';
    if (a.includes('\u0000')) return 'args 含 NUL 字节';
    if (a.length > MAX_RUN_ARG_LEN) return `单个 arg 超长（>${MAX_RUN_ARG_LEN}）`;
    total += a.length;
  }
  if (total > MAX_RUN_ARGS_BYTES) return 'args 总体积过大';
  const rootAbs = path.resolve(root);
  for (const a of args) {
    const r = path.resolve(rootAbs, a);
    if (r !== rootAbs && !r.startsWith(rootAbs + path.sep)) {
      return `arg「${a.length > 40 ? a.slice(0, 40) + '…' : a}」解析后落在项目目录外，已拒绝（危险路径）`;
    }
  }
  return null;
}

function runTool(tool, args) {
  return new Promise((resolve) => {
    const lockKey = tryLockTool();
    if (lockKey === null) {
      return resolve({ code: -1, stdout: '', stderr: '该项目已有流水线任务运行中（并发会互相覆盖预测文件），请等待当前任务完成', busy: true });
    }
    // 锁窗口说明：lockKey 入账到 spawn 的 'error'/'close' 事件释放之间，锁被占用
    // （毫秒级）。spawn 失败（ENOENT 等）走 'error' 事件 → done → 释放；同步异常走 catch → 释放。
    // 极端情况下锁窗口会短暂拒绝并发任务（安全侧：宁可拒绝不可并发覆盖）。
    try {
      const script = toolScript(tool);
      if (!script) { unlockTool(lockKey); return resolve({ code: -1, stdout: '', stderr: `未知工具: ${tool}` }); }
      const argErr = checkRunArgs(args, ROOT);
      if (argErr) { unlockTool(lockKey); return resolve({ code: -1, stdout: '', stderr: `参数校验拒绝: ${argErr}`, badArgs: true }); }
      const env = { ...process.env };
      const llm = resolvedLLM();
      // 注入生效供应商的 key（子进程 loadLLMEnv 据此解析到同款供应商与 key）；
      // 同时显式注入 LLM_PROVIDER 防推断歧义（config 指定了供应商时强制子进程一致）
      if (llm.keyEnv && llm.apiKey) env[llm.keyEnv] = llm.apiKey;
      if (llm.keyEnv) env.LLM_PROVIDER = llm.provider;
      if (STATE.model) env.LLM_MODEL = STATE.model;
      const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env, detached: process.platform !== 'win32', windowsHide: true });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; unlockTool(lockKey); clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => {
        killTree(child);
        done({ code: -1, stdout, stderr, timedOut: true, error: `工具超时（超过 ${Math.round(TOOL_TIMEOUT_MS / 1000)}s，可用 TOOL_TIMEOUT_MS 调整）` });
      }, TOOL_TIMEOUT_MS);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => done({ code, stdout, stderr }));
      child.on('error', (e) => done({ code: -1, stdout, stderr, error: String(e) }));
    } catch (e) {
      // 同步异常（如 spawn 参数问题）：必须释放锁，否则后续所有流水线任务被永久拒绝
      unlockTool(lockKey);
      resolve({ code: -1, stdout: '', stderr: `工具启动失败: ${e.message}` });
    }
  });
}

// ---------- JSON 响应 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > 20 * 1024 * 1024) {
        chunks.length = 0; // 超限：立即释放已收集的 Buffer（20MB 级大请求不留驻内存）
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(res, 200, {
      ok: true,
      projects: STATE.projects.map((p) => ({ id: p.id })),
      active: STATE.active,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const { project } = body;
    if (!project || !STATE.projects.some((p) => p.id === project)) {
      return sendJson(res, 404, { ok: false, error: `项目不存在: ${project}` });
    }
    // 先持久化、后改内存：持久化失败时 STATE 与磁盘保持一致（旧实现先改 STATE，
    // 写失败后内存与 config.json 不一致——页面显示已切换、重启后回退）
    if (!persistActive(project)) {
      return sendJson(res, 500, { ok: false, error: '活动项目持久化失败（config.json 写入失败）' });
    }
    STATE.active = project;
    return sendJson(res, 200, { ok: true, active: project });
  }

  if (req.method === 'POST' && url.pathname === '/api/projects/new') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const name = body && typeof body.id === 'string' ? body.id.trim() : '';
    if (!name) return sendJson(res, 400, { ok: false, error: '需要项目名称（id）' });
    // 入口处 sanitize：项目 id 禁止路径分隔符/通配等危险字符——保证 id → 预测目录 1:1 映射
    // （否则 'a/b' 与 'a_b' 会映射到同一目录导致数据串扰；predDirOf 的 replace 只是防御手工 config）
    if (/[\\/:*?"<>|]/.test(name)) {
      return sendJson(res, 400, { ok: false, error: '项目名称不能包含 \\ / : * ? " < > | 等字符' });
    }
    // 保留字（__proto__ 等）不能当 projects 字典 key：写入会走原型而非自有属性，项目静默丢失
    if (isReservedKey(name)) {
      return sendJson(res, 400, { ok: false, error: '项目名称不能使用保留字（__proto__ / constructor / prototype）' });
    }
    if (STATE.projects.some((p) => p.id === name)) return sendJson(res, 409, { ok: false, error: `项目已存在: ${name}` });
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');
    const relManuscript = (body.manuscript && String(body.manuscript).trim()) || `../examples/${safe}.md`;
    const relCanon = (body.canon && String(body.canon).trim()) || `../examples/${safe}-canon.json`;
    const relOutline = (body.outline && String(body.outline).trim()) || `../examples/${safe}-outline.md`;
    const relPremise = (body.premise && String(body.premise).trim()) || `../examples/${safe}-premise.md`;
    // reader 必须是合法枚举（防注入任意值导致后续 --reader 校验失败）
    const reader = READERS.includes(body.reader) ? body.reader : 'webnovel';
    // 卡片上传：contents 携带用户上传的各文件内容（键 creature manuscript/canon/outline/premise）。
    // 提供内容即覆盖写入（用户明确要导入自己的文件），未提供的落回模板/保留现状。
    const contents = {};
    if (body.contents && typeof body.contents === 'object') {
      for (const kind of ['manuscript', 'canon', 'outline', 'premise']) {
        const v = body.contents[kind];
        if (v == null) continue;
        if (typeof v !== 'string') { return sendJson(res, 400, { ok: false, error: `${kind} 内容必须为文本` }); }
        if (Buffer.byteLength(v, 'utf8') > MAX_UPLOAD_BYTES) {
          return sendJson(res, 400, { ok: false, error: `${kind} 内容过大（超过 ${MAX_UPLOAD_BYTES} 字节）` });
        }
        contents[kind] = v;
      }
    }
    // canon 内容若被上传必须是合法 JSON 对象，否则后续 compile/validate 全链路会直接炸
    if (contents.canon != null) {
      let parsed;
      try { parsed = JSON.parse(contents.canon); } catch { return sendJson(res, 400, { ok: false, error: 'canon 文件内容不是合法 JSON' }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return sendJson(res, 400, { ok: false, error: 'canon 文件内容必须是 JSON 对象' });
      }
    }
    const project = {
      id: name,
      manuscript: path.resolve(APP, relManuscript),
      canon: path.resolve(APP, relCanon),
      outline: path.resolve(APP, relOutline),
      premise: path.resolve(APP, relPremise),
      reader,
    };
    // 新项目文件路径必须落在项目根目录内（防止任意路径创建文件）
    for (const kind of ['manuscript', 'canon', 'outline', 'premise']) {
      if (!isInsideRoot(project[kind])) {
        return sendJson(res, 403, { ok: false, error: `路径超出项目根目录: ${project[kind]}` });
      }
    }
    const templates = {
      manuscript: `# 第1章 开始\n\n`,
      canon: JSON.stringify({ meta: { title: name, target_reader: reader, genre: '' }, entities: [], knowledge: [], suspense: [], timeline: [] }, null, 2) + '\n',
      outline: `# ${name} · 分章大纲\n\n`,
      premise: `# ${name} · 前提设定\n\n`,
    };
    const created = [];
    for (const kind of ['manuscript', 'canon', 'outline', 'premise']) {
      const p = project[kind];
      const existing = fs.existsSync(p);
      if (contents[kind] != null) {
        // 用户明确上传 → 覆盖写入导入内容（无需等文件不存在才建）；已有文件不算"新建"不入 created
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          atomicWriteFile(p, contents[kind]);
          if (!existing) created.push(p);
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: `写入 ${kind} 失败: ${e.message}` });
        }
      } else if (!existing) {
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          atomicWriteFile(p, templates[kind]);
          created.push(p);
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: `创建 ${kind} 失败: ${e.message}` });
        }
      }
    }
    // 先持久化、后改内存（与项目切换同原则）：持久化失败时 STATE 不包含新项目
    const cfgRaw = readConfigRaw();
    if (cfgRaw === null) {
      return sendJson(res, 500, { ok: false, error: '配置读取失败（不做写回决策），请检查 config.json 可读性' });
    }
    let newCfgContent;
    try {
      newCfgContent = addProjectInConfig(cfgRaw, {
        id: name,
        manuscript: relManuscript, canon: relCanon, outline: relOutline, premise: relPremise, reader,
      }, APP);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: `配置写入被拒绝: ${e.message}` });
    }
    if (!writeConfigContent(newCfgContent)) {
      return sendJson(res, 500, { ok: false, error: '配置持久化失败' });
    }
    STATE.projects.push(project);
    STATE.active = name;
    return sendJson(res, 200, { ok: true, active: name, created });
  }

  if (req.method === 'POST' && url.pathname === '/api/save-as') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const pj = currentProject();
    if (!pj) return sendJson(res, 404, { ok: false, error: '没有任何已配置项目' });
    const { file, content, path: targetStr } = body;
    if (!['manuscript', 'canon', 'outline', 'premise'].includes(file)) return sendJson(res, 400, { ok: false, error: `未知文件类型: ${file}` });
    if (typeof targetStr !== 'string' || !targetStr.trim()) return sendJson(res, 400, { ok: false, error: '需要目标路径' });
    const target = path.resolve(APP, targetStr.trim());
    if (!isInsideRoot(target)) return sendJson(res, 403, { ok: false, error: `路径超出项目根目录: ${target}` });
    // 跨进程写锁（与 CLI 侧 <target>.lock 协议互认）：另存为目标可能是既有共享文件
    // （如 canon.json），并发写时后到者 409。先 mkdir（锁文件与目标同目录），再拿锁写
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: `写入失败: ${e.message}` }); }
    let releaseLock = null;
    try { releaseLock = await acquireFileLockAsync(target); }
    catch (e) { return sendJson(res, 409, { ok: false, error: e.message }); }
    // 先释放锁再回包：sendJson 经 res.end 投递响应，客户端收到响应可能早于 finally 的 unlink，
    // 竞态窗口内 .lock 仍可见（偶发「成功后残留」）。锁覆盖区内统一用 send 回包。
    const send = (status, obj) => {
      if (releaseLock) { releaseLock(); releaseLock = null; }
      return sendJson(res, status, obj);
    };
    try {
      try { atomicWriteFile(target, content); }
      catch (e) { return send(500, { ok: false, error: `写入失败: ${e.message}` }); }
    } finally {
      if (releaseLock) releaseLock();
    }
    const rel = path.relative(APP, target).replace(/\\/g, '/');
    const cfgRaw = readConfigRaw();
    if (cfgRaw === null) {
      return sendJson(res, 500, { ok: false, error: '配置读取失败（不做写回决策），请检查 config.json 可读性' });
    }
    let repointedContent;
    try {
      repointedContent = setProjectPathInConfig(cfgRaw, pj.id, file, rel);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: `配置写入被拒绝: ${e.message}` });
    }
    if (!writeConfigContent(repointedContent)) {
      return sendJson(res, 500, { ok: false, error: '配置持久化失败（文件已写入，指针未更新）' });
    }
    pj[file] = target; // 持久化成功后才更新内存指针（失败时 STATE 与磁盘一致）
    return sendJson(res, 200, { ok: true, file, path: target });
  }

  if (req.method === 'POST' && url.pathname === '/api/save-copy') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const { file, content, path: targetStr } = body;
    if (!['manuscript', 'canon', 'outline', 'premise'].includes(file)) return sendJson(res, 400, { ok: false, error: `未知文件类型: ${file}` });
    if (typeof targetStr !== 'string' || !targetStr.trim()) return sendJson(res, 400, { ok: false, error: '需要目标路径' });
    const target = path.resolve(APP, targetStr.trim());
    if (!isInsideRoot(target)) return sendJson(res, 403, { ok: false, error: `路径超出项目根目录: ${target}` });
    // 跨进程写锁（与 save-as 同机制）：存储为目标可能是既有共享文件，并发写时互认锁协议
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: `写入失败: ${e.message}` }); }
    let releaseLock = null;
    try { releaseLock = await acquireFileLockAsync(target); }
    catch (e) { return sendJson(res, 409, { ok: false, error: e.message }); }
    // 先释放锁再回包（同 save-as：避免响应先于 unlink 的竞态）
    const send = (status, obj) => {
      if (releaseLock) { releaseLock(); releaseLock = null; }
      return sendJson(res, status, obj);
    };
    try {
      try { atomicWriteFile(target, content); }
      catch (e) { return send(500, { ok: false, error: `写入失败: ${e.message}` }); }
    } finally {
      if (releaseLock) releaseLock();
    }
    return sendJson(res, 200, { ok: true, file, path: target }); // 存储为：不改变项目指针
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const pj = currentProject();
    if (!pj) return sendJson(res, 404, { ok: false, error: '没有任何已配置项目（请检查 app/config.json）' });
    const files = {};
    for (const name of ['manuscript', 'canon', 'outline', 'premise']) {
      const p = pj[name];
      const content = readText(p);
      // 文件缺失属业务校验失败（README：业务失败统一 200 + ok:false），非协议层 404
      if (content === null) return sendJson(res, 200, { ok: false, error: `文件不存在: ${p}` });
      files[name] = { path: p, content };
    }
    let canonParsed = null;
    try { canonParsed = JSON.parse(files.canon.content); } catch { /* 未解析 */ }
    // 读协调：/api/state 返回每个工作文件的在途写者锁状态（<target>.lock 协议与 CLI 互认），
    // 前端据此提示「文件正被其他进程写入」——否则用户在写者长窗口内看到的旧内容无从察觉
    const locks = {};
    for (const name of ['manuscript', 'canon', 'outline', 'premise']) locks[name] = checkFileLocked(pj[name]);
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      projects: STATE.projects.map((p) => ({ id: p.id })),
      activeProject: STATE.active,
      config: {
        reader: pj.reader,
        model: STATE.model,
        provider: resolvedLLM().provider,
        paths: { manuscript: pj.manuscript, canon: pj.canon, outline: pj.outline, premise: pj.premise, predDir: predDirOf(STATE.active) },
        hasApiKey: !!apiKey(),
      },
      files,
      locks,
      canonParsed,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/canon-schema') {
    return sendJson(res, 200, { CANON_SECTIONS, CANON_SECTIONS_ALL });
  }

  if (req.method === 'GET' && url.pathname === '/api/worldgraph') {
    // 世界观图谱（纯函数推导）：canon → 实体关系网络 + 悬念开合 + 时间线。
    // 文件读取走同 /api/state 的守门（读白名单），canon 缺失/损坏返回业务失败（200+ok:false）。
    const pj = currentProject();
    if (!pj) return sendJson(res, 404, { ok: false, error: '没有任何已配置项目（请检查 app/config.json）' });
    const canonText = readText(pj.canon);
    if (canonText === null) return sendJson(res, 200, { ok: false, error: `canon 文件不存在: ${pj.canon}` });
    let canon;
    try { canon = JSON.parse(canonText); } catch { return sendJson(res, 200, { ok: false, error: 'canon 文件无法解析为 JSON，无法生成世界图谱' }); }
    try {
      const graph = buildWorldGraph(canon);
      return sendJson(res, 200, { ok: true, graph });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: `世界图谱生成失败: ${e.message}` });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    // 剧情健康度雷达舱（纯函数推导）：canon → 结构记分卡 + 六维雷达 + 警戒清单。
    // 同 worldgraph：canon 缺失/损坏返回业务失败（200+ok:false）。
    const pj = currentProject();
    if (!pj) return sendJson(res, 404, { ok: false, error: '没有任何已配置项目（请检查 app/config.json）' });
    const canonText = readText(pj.canon);
    if (canonText === null) return sendJson(res, 200, { ok: false, error: `canon 文件不存在: ${pj.canon}` });
    let canon;
    try { canon = JSON.parse(canonText); } catch { return sendJson(res, 200, { ok: false, error: 'canon 文件无法解析为 JSON，无法生成健康度报告' }); }
    try {
      const report = buildHealthReport(canon);
      return sendJson(res, 200, { ok: true, report });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: `健康度报告生成失败: ${e.message}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/save') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const { file, content } = body;
    // 与 save-as/save-copy 一致的白名单：防止原型链属性（constructor/__proto__ 等）穿透到路径解析
    if (!['manuscript', 'canon', 'outline', 'premise'].includes(file)) {
      return sendJson(res, 400, { ok: false, error: `未知文件类型: ${file}` });
    }
    const pj = currentProject();
    const target = pj && pj[file];
    if (!target) return sendJson(res, 400, { ok: false, error: `未知文件: ${file}` });
    if (!isAllowedWrite(target)) return sendJson(res, 403, { ok: false, error: `不允许写入: ${target}` });
    // 跨进程写锁（与 CLI 侧 <target>.lock 协议互认）：手动保存 canon/大纲/前提与后台
    // extract-llm --canon-out / refactor 并发写同一文件时，后到者 409 而非静默互相覆盖
    let releaseLock = null;
    try { releaseLock = await acquireFileLockAsync(target); }
    catch (e) { return sendJson(res, 409, { ok: false, error: e.message }); }
    // 先释放锁再回包（同 save-as：成功/失败都在锁覆盖区内回包，必须回包前先 unlink，
    // 否则客户端收到 200 时 .lock 可能仍在磁盘（finally 尚未执行））
    const send = (status, obj) => {
      if (releaseLock) { releaseLock(); releaseLock = null; }
      return sendJson(res, status, obj);
    };
    try {
      // 原子保存（fsync 版，与 save-as/save-copy/审阅写回同源）：临时文件 + fsync 落盘 + rename
      // 失败时临时文件由 atomicWrite 内部清理（catch 里无需再 unlink）
      try {
        atomicWriteFile(target, content);
        return send(200, { ok: true });
      } catch (e) {
        return send(500, { ok: false, error: `写入失败: ${e.message}` });
      }
    } finally {
      if (releaseLock) releaseLock();
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/compile') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* 默认参数 */ }
    const pj = currentProject();
    if (!pj) return sendJson(res, 404, { ok: false, error: '没有任何已配置项目' });
    const reader = body.reader || pj.reader;
    const r = await runTool('compile', [pj.manuscript, pj.canon, '--reader', reader, '--json']);
    // compile 的 exit 1 = 检出 error 级问题（正常语义）；仅 exit 2 与解析失败视为错误
    if (r.code === 2) return sendJson(res, 200, { ok: false, error: r.stderr || r.stdout, code: r.code });
    try {
      const parsed = JSON.parse(r.stdout);
      // 读协调：compile.js 在输入被在途写者占用时向 stderr 发非致命警告，透传给前端日志
      // （不然 runTool 的 stderr 在成功分支被忽略，用户看不到「基于过期快照」的提示）
      const warn = r.stderr && r.stderr.trim();
      if (warn) parsed.warning = warn;
      return sendJson(res, 200, { ok: true, ...parsed });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: `编译输出解析失败: ${e.message}`, raw: r.stdout.slice(0, 2000) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/review') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* 默认参数 */ }
    const pj = currentProject();
    if (!pj) return sendJson(res, 400, { ok: false, error: '当前没有已配置的项目，请先创建或切换到项目' });
    const proposalPath = body.proposal || lastExtractFileOf(pj.id);
    const baselinePath = body.baseline || pj.canon;
    if (!isAllowedRead(proposalPath) || !isAllowedRead(baselinePath)) {
      return sendJson(res, 403, { ok: false, error: '路径超出允许读取范围（仅限项目工作文件或项目根内）' });
    }
    if (!fs.existsSync(proposalPath)) return sendJson(res, 200, { ok: false, error: `提议文件不存在: ${proposalPath}（请先运行 ② 提取）` });
    // 读协调：审阅基于基线 canon 与提议（last-extract.json）做决定，决定会写回 canon。
    // 若任一输入正被在途写者占用（extract-llm --canon-out / refactor / rebase / 外部 CLI），
    // 本次审阅即基于写入前快照——写者完成后决定就会过期/被覆盖。这里阻断并提示等待，
    // 而非让用户在过期数据上做决定。业务条件 → 200 + ok:false（README 契约，非协议层错误）。
    const lkBase = checkFileLocked(baselinePath);
    const lkProp = checkFileLocked(proposalPath);
    if (lkBase.locked || lkProp.locked) {
      const who = [];
      if (lkBase.locked) who.push(`基线 ${baselinePath}（${lkBase.lockPath}）`);
      if (lkProp.locked) who.push(`提议 ${proposalPath}（${lkProp.lockPath}）`);
      return sendJson(res, 200, { ok: false, error: `文件正被其他进程写入，请等待完成后再审阅：${who.join('；')}` });
    }
    let baseline, proposal;
    try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); }
    catch (e) { return sendJson(res, 200, { ok: false, error: `基线解析失败: ${e.message}` }); }
    try { proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8')); }
    catch (e) { return sendJson(res, 200, { ok: false, error: `提议解析失败: ${e.message}` }); }
    const vb = validateCanon(baseline);
    if (!vb.ok) return sendJson(res, 200, { ok: false, error: `基线 canon 校验失败: ${vb.errors.slice(0, 5).join('；')}` });
    const vp = validateCanon(unwrapEnvelope(proposal));
    if (!vp.ok) return sendJson(res, 200, { ok: false, error: `提议 canon 校验失败: ${vp.errors.slice(0, 5).join('；')}` });
    const review = reviewProposal(baseline, proposal);
    return sendJson(res, 200, { ok: true, review, proposalPath, baselinePath });
  }

  if (req.method === 'POST' && url.pathname === '/api/apply-review') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const { decisions } = body;
    if (!Array.isArray(decisions)) return sendJson(res, 400, { ok: false, error: '需要 decisions 数组' });
    // 前置校验：action 必须合法；edit 决定必须携带非空普通对象 value
    // （排除数组/null/空对象 {}——空对象是清空编辑框的无意义编辑）；身份一致性由 applyReview 强制
    for (const d of decisions) {
      if (!['accept', 'reject', 'edit'].includes(d.action)) {
        return sendJson(res, 400, { ok: false, error: `非法审阅决定 action: "${d.action}"（可选 accept/reject/edit）` });
      }
      if (d.action === 'edit' && (!d.value || typeof d.value !== 'object' || Array.isArray(d.value) || Object.keys(d.value).length === 0)) {
        return sendJson(res, 400, { ok: false, error: `编辑决定「${d.section}|${d.id}」需要非空对象 value` });
      }
    }
    const pj = currentProject();
    const proposalPath = body.proposal || (pj ? lastExtractFileOf(pj.id) : path.join(PRED_DIR, 'last-extract.json'));
    const target = body.canonPath || (pj && pj.canon);
    if (!isAllowedWrite(target)) return sendJson(res, 403, { ok: false, error: `不允许写入: ${target}` });
    if (!isAllowedRead(proposalPath)) return sendJson(res, 403, { ok: false, error: '路径超出允许读取范围（仅限项目工作文件或项目根内）' });
    if (!fs.existsSync(proposalPath)) return sendJson(res, 200, { ok: false, error: `提议文件不存在: ${proposalPath}` });
    // 跨进程写锁（与 CLI 侧 <target>.lock 协议互认）：覆盖「读基线 → 合并 → 备份 → 原子写」整个
    // 读改写周期——否则与 extract-llm --canon-out / refactor 并发写同一 canon 时，审阅决定会被静默覆盖。
    // 异步锁（服务器单线程不能阻塞事件循环）；冲突返回 409（与 /api/run-stream 并发 409 口径一致）。
    let releaseLock = null;
    try { releaseLock = await acquireFileLockAsync(target); }
    catch (e) { return sendJson(res, 409, { ok: false, error: e.message }); }
    // 先释放锁再回包（同 save-as）：本端点所有回包都在锁覆盖区内，必须 unlink 后才 res.end，
    // 否则客户端收到 200 时 .lock 仍可能可见（finally 的 unlink 滞后于响应投递的竞态）
    const send = (status, obj) => {
      if (releaseLock) { releaseLock(); releaseLock = null; }
      return sendJson(res, status, obj);
    };
    try {
      let baseline, proposal;
      try { baseline = JSON.parse(fs.readFileSync(target, 'utf8')); }
      catch (e) { return send(200, { ok: false, error: `基线解析失败: ${e.message}` }); }
      try { proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8')); }
      catch (e) { return send(200, { ok: false, error: `提议解析失败: ${e.message}` }); }
      let merged;
      try { merged = applyReview(baseline, proposal, decisions); }
      catch (e) { return send(400, { ok: false, error: e.message }); }
      const vm = validateCanon(merged);
      if (!vm.ok) return send(200, { ok: false, error: `合并结果未通过 schema 校验: ${vm.errors.slice(0, 5).join('；')}` });
      // 审阅写回：先备份（.bak-<时间戳>，保留最近 5 个），再原子写（临时文件 + rename）
      const bak = backupFile(target);
      if (bak) pruneBackups(target, 5);
      try {
        atomicWriteFile(target, JSON.stringify(merged, null, 2) + '\n');
        return send(200, { ok: true, applied: decisions.filter((d) => d.action !== 'reject').length, target, backup: bak });
      } catch (e) {
        return send(500, { ok: false, error: `写入失败: ${e.message}` });
      }
    } finally {
      if (releaseLock) releaseLock();
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/risks') {
    const pj = currentProject();
    const predFile = pj ? riskPredFileOf(pj.id) : path.join(PRED_DIR, 'last-pred.json');
    const statusFile = pj ? riskStatusFileOf(pj.id) : path.join(PRED_DIR, 'risk-status.json');
    // 读协调：风险面板基于 last-pred.json 做状态判断，simulate/rebase（外部 CLI 或 run-stream）
    // 写它时磁盘上是写入前快照——上报 locked/lockedInfo，前端据此提示「风险数据可能即将更新」，
    // 避免用户基于过期预测对风险条目做状态变更
    const lockPaths = [predFile, statusFile].map((f) => checkFileLocked(f)).filter((l) => l.locked).map((l) => l.lockPath);
    const locked = lockPaths.length > 0;
    const lockedInfo = locked ? lockPaths.join('、') : null;
    if (!fs.existsSync(predFile)) {
      return sendJson(res, 200, { ok: true, risks: [], meta: null, stale: false, locked, lockedInfo });
    }
    let pred;
    try { pred = JSON.parse(fs.readFileSync(predFile, 'utf8')); }
    catch (e) { return sendJson(res, 200, { ok: false, error: `预测文件解析失败: ${e.message}` }); }
    const meta = { source: predFile, simulated_at: (pred.meta && pred.meta.simulated_at) || null };
    const st = parseRiskStatus(readText(statusFile) || '');
    const stale = isStale(st, meta);
    const risks = asArray(pred.risk_register).map((r) => ({
      ...r,
      status: stale ? 'open' : (st.statuses[r.id] || 'open'),
    }));
    return sendJson(res, 200, {
      ok: true,
      risks,
      stale,
      locked,
      lockedInfo,
      meta: { title: pred.meta && pred.meta.title, simulated_at: meta.simulated_at, riskCount: risks.length },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/risks') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const pj = currentProject();
    const predFile = pj ? riskPredFileOf(pj.id) : path.join(PRED_DIR, 'last-pred.json');
    const statusFile = pj ? riskStatusFileOf(pj.id) : path.join(PRED_DIR, 'risk-status.json');
    // 尚无预测是业务状态（用户尚未运行模拟），非协议层 404——统一 200 + ok:false
    if (!fs.existsSync(predFile)) return sendJson(res, 200, { ok: false, error: '尚无预测（请先运行 ① 模拟）' });
    let pred;
    try { pred = JSON.parse(fs.readFileSync(predFile, 'utf8')); }
    catch (e) { return sendJson(res, 200, { ok: false, error: `预测文件解析失败: ${e.message}` }); }
    const meta = { source: predFile, simulated_at: (pred.meta && pred.meta.simulated_at) || null };
    // 跨进程写锁（与 CLI <target>.lock 协议互认）：状态更新是「读旧 statuses → buildRiskStatus → 写」的
    // 读-改-写，无锁时并发 POST 后写覆盖先写、静默丢失状态更新；GET 侧已有 checkFileLocked 读协调，写侧同协议。
    // 冲突返回 409（与 /api/apply-review、/api/run-stream 并发口径一致）。
    let releaseLock = null;
    try { releaseLock = await acquireFileLockAsync(statusFile); }
    catch (e) { return sendJson(res, 409, { ok: false, error: e.message }); }
    // 先释放锁再回包：本端点所有回包都在锁覆盖区内，必须 unlink 后才 res.end
    const send = (status, obj) => {
      if (releaseLock) { releaseLock(); releaseLock = null; }
      return sendJson(res, status, obj);
    };
    try {
      if (body.reset) {
        const content = JSON.stringify({ source: meta.source, simulated_at: meta.simulated_at, statuses: {} }, null, 2) + '\n';
        try {
          fs.mkdirSync(path.dirname(statusFile), { recursive: true });
          atomicWriteFile(statusFile, content);
          return send(200, { ok: true, reset: true });
        } catch (e) { return send(500, { ok: false, error: `写入失败: ${e.message}` }); }
      }
      const { id, status } = body;
      if (!id || !STATUSES.includes(status)) {
        return send(400, { ok: false, error: `需要合法的 id 与 status（${STATUSES.join('/')}）` });
      }
      try {
        const content = buildRiskStatus(readText(statusFile) || '', meta, id, status);
        fs.mkdirSync(path.dirname(statusFile), { recursive: true });
        atomicWriteFile(statusFile, content);
        return send(200, { ok: true, id, status });
      } catch (e) { return send(500, { ok: false, error: `写入失败: ${e.message}` }); }
    } finally {
      if (releaseLock) releaseLock();
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/run-stream') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const { tool, args } = body;
    if (!tool || !Array.isArray(args)) return sendJson(res, 400, { ok: false, error: '需要 tool 与 args' });
    const script = toolScript(tool);
    if (!script) return sendJson(res, 200, { ok: false, error: `未知工具: ${tool}` });
    const lockKey = tryLockTool();
    if (lockKey === null) return sendJson(res, 409, { ok: false, error: '该项目已有流水线任务运行中（并发会互相覆盖预测文件），请等待当前任务完成' });
    const argErr = checkRunArgs(args, ROOT);
    if (argErr) { unlockTool(lockKey); return sendJson(res, 400, { ok: false, error: `参数校验拒绝: ${argErr}` }); }
    // 锁窗口说明：与 runTool 相同——spawn 的 'error'/'close' 或同步异常都会经 endTrailer/catch 释放锁
    try {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      const env = { ...process.env };
      const llm = resolvedLLM();
      // 注入生效供应商的 key（子进程 loadLLMEnv 据此解析到同款供应商与 key）；
      // 同时显式注入 LLM_PROVIDER 防推断歧义（config 指定了供应商时强制子进程一致）
      if (llm.keyEnv && llm.apiKey) env[llm.keyEnv] = llm.apiKey;
      if (llm.keyEnv) env.LLM_PROVIDER = llm.provider;
      if (STATE.model) env.LLM_MODEL = STATE.model;
      const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env, detached: process.platform !== 'win32', windowsHide: true });
      let ended = false;
      const endTrailer = (payload) => {
        if (ended) return;
        ended = true;
        unlockTool(lockKey);
        clearTimeout(timer);
        try { res.end(payload); } catch { /* 连接已断 */ }
      };
      const timer = setTimeout(() => {
        killTree(child);
        endTrailer(`__RESULT__:${JSON.stringify({ code: -1, ok: false, timedOut: true, error: `工具超时（超过 ${Math.round(TOOL_TIMEOUT_MS / 1000)}s）` })}\n`);
      }, TOOL_TIMEOUT_MS);
      child.stdout.on('data', (d) => { try { res.write(d); } catch { /* 连接已断 */ } });
      child.stderr.on('data', (d) => { try { res.write(d); } catch { /* 连接已断 */ } });
      child.on('close', (code) => endTrailer(`__RESULT__:${JSON.stringify({ code, ok: true })}\n`));
      child.on('error', (e) => endTrailer(`__RESULT__:${JSON.stringify({ code: -1, ok: false, error: String(e) })}\n`));
      // 客户端断开（关页/断网）：res 未正常 end 即 close → 终止子进程并释放锁。
      // 否则进程继续跑到自然结束/超时，期间锁被占用、该项目流水线任务被 409 拒绝
      res.on('close', () => {
        if (res.writableEnded || ended) return; // 正常收尾（endTrailer 已 end）不误杀
        ended = true;
        unlockTool(lockKey);
        clearTimeout(timer);
        killTree(child);
      });
      return;
    } catch (e) {
      // 同步异常（如 spawn 参数问题）：必须释放锁，否则后续所有流水线任务被永久拒绝
      unlockTool(lockKey);
      return sendJson(res, 500, { ok: false, error: `工具启动失败: ${e.message}` });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { ok: false, error: `请求解析失败: ${e.message}` }); }
    const { tool, args } = body;
    if (!tool || !Array.isArray(args)) return sendJson(res, 400, { ok: false, error: '需要 tool 与 args' });
    // args 校验在 runTool 内兜底（badArgs），这里提前校验以返回明确的 400
    const argErr2 = checkRunArgs(args, ROOT);
    if (argErr2) return sendJson(res, 400, { ok: false, error: `参数校验拒绝: ${argErr2}` });
    const r = await runTool(tool, args);
    return sendJson(res, 200, { ok: true, tool, args, ...r });  }

  return sendJson(res, 404, { ok: false, error: '未知 API' });
}

// ---------- 静态文件 ----------
function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath).replace(/^\/+/, ''); }
  catch { rel = ''; } // 畸形百分号编码（如 /%zz）：按不存在处理 → 404，不能让服务器崩溃
  const candidates = [];
  if (rel.startsWith('vendor/monaco/')) {
    candidates.push(path.join(VENDOR, rel.slice('vendor/monaco/'.length)));
  } else {    candidates.push(path.join(PUBLIC, rel));
  }
  for (const c of candidates) {
    const r = path.resolve(c);
    // 前缀校验必须带路径分隔符边界，防止 `public` 误匹配 `public-evil` 等兄弟目录
    const pub = path.resolve(PUBLIC);
    const vendor = path.resolve(VENDOR);
    const insidePub = r === pub || r.startsWith(pub + path.sep);
    const insideVendor = r === vendor || r.startsWith(vendor + path.sep);
    if (!insidePub && !insideVendor) continue;
    if (fs.existsSync(r) && fs.statSync(r).isFile()) {
      const ext = path.extname(r).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(r).pipe(res);
      return;
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found（若为 Monaco 资源，请确认 app 目录已执行 npm install）');
}

// ---------- 启动 ----------
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    // 跨站防护：有副作用的后端写入/执行接口只接受本机页面来源（防御纵深；浏览器跨站 JSON
    // 请求本身也会被 preflight 挡住，这里在服务器端兜底校验）
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const port = server.address() ? server.address().port : PORT;
      if (!isTrustedOrigin(req, port)) {
        return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝（Origin 校验失败，仅接受本机页面）' });
      }
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => sendJson(res, 500, { ok: false, error: `服务器内部错误: ${e.message}` }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      serveStatic(res, '/index.html');
      return;
    }
    serveStatic(res, url.pathname);
  } catch (e) {
    // 兜底：任何同步异常（畸形 URL 等）都不得击穿服务器进程
    try { sendJson(res, 500, { ok: false, error: `服务器内部错误: ${e.message}` }); } catch { /* 连接已断 */ }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LISTENING ${HOST}:${server.address().port}`);
  console.log(`文检 IDE 已启动 —— 浏览器打开 http://${HOST}:${server.address().port}`);
  const pj = currentProject();
  console.log(`活动项目: ${STATE.active}（共 ${STATE.projects.length} 个）`);
  if (pj) console.log(`工作文件: ${[pj.manuscript, pj.canon, pj.outline, pj.premise].map((f) => path.relative(ROOT, f)).join(' · ')}`);
});
