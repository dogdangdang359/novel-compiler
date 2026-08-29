'use strict';

// 文检 IDE 前端 —— 零框架，Monaco 编辑器 + 面板

const $ = (s) => document.querySelector(s);

// 数组化防御（与 src/canon.js 同源，通过 /api/canon-schema 获取 schema 常量）
const asArray = (x) => (Array.isArray(x) ? x : []);

// canon schema 常量（初始为 fallback 字面量，初始化时从 /api/canon-schema 覆盖）
let canonSchema = { CANON_SECTIONS_ALL: ['entities', 'knowledge', 'suspense', 'timeline'] };

const FILES = ['manuscript', 'canon', 'outline', 'premise'];
const FILE_LABEL = { manuscript: 'manuscript.md', canon: 'canon.json', outline: 'outline.md', premise: 'premise.md' };
// 创作者模式标签：面向创作者的中文命名（canon 不直接暴露——由生成报告/审阅在幕后维护）
const FILE_LABEL_CREATOR = { manuscript: '文稿', outline: '故事大纲', premise: '前情提要' };

const state = {
  mode: 'creator', // 创作者模式（默认，不持久化——刷新即回）/ 开发者模式
  active: 'manuscript',
  reader: 'webnovel',
  model: 'deepseek-chat',
  paths: null,
  problems: [],
  filter: 'all',
  review: null,      // /api/review 结果
  decisions: new Map(), // `${section}|${id}` -> { action, value? }
  projects: [],      // [{id}]
  activeProject: null,
};

let editor = null;
const models = {};
// dirty 跟踪：Monaco 版本号随每次编辑自增，保存后记录基线值（构建模型时 = 干净）。
// AI 工具读的是磁盘文件——编辑器里未保存的修改对工具不可见，运行前须先落盘
const savedVer = {};
function isDirty(name) {
  const m = models[name];
  return !!m && m.getAlternativeVersionId() !== savedVer[name];
}

// ---------- 工具 ----------
function log(lines) {
  const el = $('#ai-log');
  el.textContent += (el.textContent ? '\n' : '') + lines;
  el.scrollTop = el.scrollHeight;
}
function setStatus(s) { $('#status-right').textContent = s; }
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
async function api(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

// ---------- 初始化 ----------
function initMonaco() {
  require.config({ paths: { vs: '/vendor/monaco/vs' } });
  require(['vs/editor/editor.main'], async () => {
    editor = monaco.editor.create($('#editor'), {
      theme: 'vs-dark',
      fontSize: 14,
      lineHeight: 22,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: true },
      wordWrap: 'on',
      tabSize: 2,
    });
    await loadState();
  });
}

async function loadState(opts) {
  const keepTab = opts && opts.keepTab;
  const d = await api('/api/state');
  if (!d.ok) { log('✗ ' + d.error); return; }
  state.reader = d.config.reader;
  state.model = d.config.model;
  state.paths = d.config.paths;
  state.projects = asArray(d.projects);
  state.activeProject = d.activeProject || null;
  $('#reader').value = state.reader;
  $('#model').value = state.model;
  renderProjectSelect();
  $('#status-left').textContent = `文检 v${d.version || '?'} · ${state.activeProject || '未命名项目'}`;
  if (!d.config.hasApiKey) {
    log('⚠ 未检测到 DEEPSEEK_API_KEY —— AI 工具（模拟/提取/重构/重规划）不可用');
    log('  可在 app/config.json 配置 apiKey，或设置环境变量后重启服务器');
  }
  const prevActive = state.active;
  rebuildModels(d.files);
  if (keepTab && FILES.includes(prevActive)) {
    state.active = prevActive;
    editor.setModel(models[prevActive]);
  }
  renderTabs();
  renderDashboard(d.canonParsed);
  renderLockBanner(d.locks);
  log(`已加载项目「${state.activeProject}」工作文件：`);
  FILES.forEach((n) => log('  · ' + d.files[n].path));
  await compile();
  // 拉取 canon schema 常量（与 src/canon.js 同源，浏览器端无法 require）
  try {
    const s = await api('/api/canon-schema');
    if (s && s.CANON_SECTIONS_ALL) canonSchema = s;
  } catch { /* 初始化阶段网络故障可降级使用 fallback 字面量 */ }
}

function renderProjectSelect() {
  const sel = $('#project');
  sel.innerHTML = '';
  for (const p of state.projects) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.id;
    o.selected = p.id === state.activeProject;
    sel.appendChild(o);
  }
}

function rebuildModels(files) {
  for (const m of Object.values(models)) if (m) m.dispose();
  for (const name of FILES) {
    models[name] = monaco.editor.createModel(files[name].content, name === 'canon' ? 'json' : 'markdown');
    savedVer[name] = models[name].getAlternativeVersionId();
  }
  state.active = 'manuscript';
  editor.setModel(models.manuscript);
}

async function switchProject(id) {
  if (id === state.activeProject) return;
  const r = await api('/api/projects', { project: id });
  if (!r.ok) { log('✗ 切换失败: ' + r.error); return; }
  setStatus('切换项目…');
  await loadState();
  log(`✓ 已切换到项目「${id}」`);
}

// ---------- 标签页 ----------
function tabNames() {
  // 创作者模式隐藏 canon 标签（设定状态由生成报告/审阅在幕后维护）
  return state.mode === 'creator' ? FILES.filter((n) => n !== 'canon') : FILES;
}
function tabLabel(name) {
  return state.mode === 'creator' ? FILE_LABEL_CREATOR[name] : FILE_LABEL[name];
}
function renderTabs() {
  $('#tabs').innerHTML = '';
  for (const name of tabNames()) {
    const b = document.createElement('button');
    b.className = 'tab' + (name === state.active ? ' active' : '');
    b.textContent = tabLabel(name);
    b.onclick = () => switchTab(name);
    $('#tabs').appendChild(b);
  }
}
function switchTab(name) {
  state.active = name;
  editor.setModel(models[name]);
  renderTabs();
}

// ---------- 模式切换（创作者 / 开发者） ----------
// 创作者模式（默认）：三个中文标签 + 生成报告一键；开发者模式：还原完整界面（四个英文标签 + 六项 AI 流水线）
function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-creator', mode === 'creator');
  document.body.classList.toggle('mode-dev', mode === 'dev');
  $('#settings-mode-item').textContent = mode === 'creator' ? '开发者模式' : '创作者模式';
  $('#ai-title').textContent = mode === 'creator' ? 'AI 助手' : 'AI 流水线';
  // 创作者模式不展示 canon：若正处于 canon 标签，回落到文稿
  if (mode === 'creator' && state.active === 'canon') switchTab('manuscript');
  renderTabs();
}
function bindSettings() {
  const wrap = $('#logo-wrap');
  const menu = $('#settings-menu');
  $('#logo-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) menu.classList.add('hidden'); });
  $('#settings-mode-item').addEventListener('click', () => {
    menu.classList.add('hidden');
    setMode(state.mode === 'creator' ? 'dev' : 'creator');
    log(`✓ 已切换到${state.mode === 'creator' ? '创作者' : '开发者'}模式`);
  });
}

// ---------- 保存（保存 / 另存为 / 存储为） ----------
async function saveActive() {
  const content = models[state.active].getValue();
  const r = await api('/api/save', { file: state.active, content });
  if (r.ok) {
    savedVer[state.active] = models[state.active].getAlternativeVersionId();
    setStatus('已保存 ' + FILE_LABEL[state.active]);
  } else log('✗ 保存失败: ' + r.error);
}
// 运行 AI 工具前保存全部未保存修改（工具读磁盘文件）。
// 保存失败则中止工具运行：带着旧内容跑提取/模拟只会得到错误结果
async function saveDirtyBeforeTool() {
  const dirty = FILES.filter(isDirty);
  if (!dirty.length) return true;
  for (const name of dirty) {
    const r = await api('/api/save', { file: name, content: models[name].getValue() });
    if (!r.ok) {
      log(`✗ 自动保存 ${FILE_LABEL[name]} 失败: ${r.error}——已中止工具运行（工具读取磁盘文件，未保存修改对工具不可见）`);
      return false;
    }
    savedVer[name] = models[name].getAlternativeVersionId();
    log(`✓ 运行前已自动保存 ${FILE_LABEL[name]}`);
  }
  return true;
}
function suggestCopyPath() {
  const cur = state.paths && state.paths[state.active];
  if (!cur) return '../examples/copy.md';
  const ext = cur.includes('.') ? cur.slice(cur.lastIndexOf('.')) : '';
  const base = cur.endsWith(ext) ? cur.slice(0, -ext.length) : cur;
  return `${pathDir(cur)}/${pathBase(base)}-copy${ext}`.replace(/\\/g, '/');
}
function pathDir(p) { return String(p).replace(/[\\/][^\\/]*$/, ''); }
function pathBase(p) { return String(p).split(/[\\/]/).pop(); }
async function saveAs() {
  const target = window.prompt('另存为路径（相对 app/ 或绝对路径）：', suggestCopyPath());
  if (!target) return;
  const name = state.active;
  const content = models[name].getValue();
  const r = await api('/api/save-as', { file: name, content, path: target });
  if (!r.ok) { log('✗ 另存为失败: ' + r.error); return; }
  // 只刷新被另存文件自身：项目指针更新后重建该文件模型（磁盘内容 = 刚保存的内容）。
  // 不能整页 loadState 重建全部模型——其他文件若有未保存编辑会被磁盘内容静默覆盖。
  const d = await api('/api/state');
  if (d.ok) {
    state.paths = d.config.paths;
    const old = models[name];
    models[name] = monaco.editor.createModel(d.files[name].content, name === 'canon' ? 'json' : 'markdown');
    savedVer[name] = models[name].getAlternativeVersionId();
    if (state.active === name) editor.setModel(models[name]);
    if (old) old.dispose();
  }
  log(`✓ 已另存为 ${r.path}，项目「${state.activeProject}」的 ${FILE_LABEL[name]} 指针已更新`);
}
async function saveCopy() {
  const target = window.prompt('存储为路径（相对 app/ 或绝对路径）：', suggestCopyPath());
  if (!target) return;
  const content = models[state.active].getValue();
  const r = await api('/api/save-copy', { file: state.active, content, path: target });
  if (!r.ok) { log('✗ 存储为失败: ' + r.error); return; }
  log(`✓ 已存储副本到 ${r.path}（项目指针不变）`);
}
function bindSaveMenu() {
  const wrap = $('.save-wrap');
  const menu = $('#save-menu');
  wrap.addEventListener('mouseenter', () => menu.classList.remove('hidden'));
  wrap.addEventListener('mouseleave', () => menu.classList.add('hidden'));
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) menu.classList.add('hidden');
  });
  menu.querySelectorAll('.menu-item').forEach((item) => {
    item.addEventListener('click', () => {
      menu.classList.add('hidden');
      const act = item.dataset.act;
      if (act === 'save') saveActive();
      else if (act === 'save-as') saveAs();
      else if (act === 'save-copy') saveCopy();
    });
  });
}

// ---------- 新建项目 ----------
function openProjectModal() {
  $('#np-name').value = '';
  $('#np-name').focus();
  $('#project-modal').classList.remove('hidden');
}
function fillProjectDefaults() {
  const name = $('#np-name').value.trim();
  if (!name) return;
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  $('#np-manuscript').value = `../examples/${safe}.md`;
  $('#np-canon').value = `../examples/${safe}-canon.json`;
  $('#np-outline').value = `../examples/${safe}-outline.md`;
  $('#np-premise').value = `../examples/${safe}-premise.md`;
}
async function createProject() {
  const id = $('#np-name').value.trim();
  if (!id) { alert('请填写项目名称'); return; }
  const body = { id };
  for (const f of ['manuscript', 'canon', 'outline', 'premise']) {
    const v = $('#' + 'np-' + f).value.trim();
    if (v) body[f] = v;
  }
  const r = await api('/api/projects/new', body);
  if (!r.ok) { log('✗ 新建项目失败: ' + r.error); return; }
  $('#project-modal').classList.add('hidden');
  log(`✓ 已创建并切换到项目「${id}」${r.created && r.created.length ? `（新建文件 ${r.created.length} 个）` : ''}`);
  await loadState();
}

async function compile() {
	  if (!(await saveDirtyBeforeTool())) return;
	  setStatus('编译中…');
  const d = await api('/api/compile', { reader: state.reader });
  if (!d.ok) { log('✗ 编译失败: ' + d.error); setStatus('编译失败'); return false; }
  if (d.warning) log('⚠ ' + d.warning); // 读协调：输入被在途写者占用时的非致命提示
  state.problems = d.problems;
  state.suppressed = asArray(d.suppressed);
  state.unusedSuppressions = asArray(d.unused_suppressions);
  renderProblems();
  renderDashboardFromCompile(d.snapshot);
  const c = d.counts;
  const supp = state.suppressed.length;
  const unusedSupp = state.unusedSuppressions.length;
  setStatus(`编译结果：${c.error} 错误 / ${c.warning} 警告 / ${c.info} 提示${supp ? ` / ${supp} 已豁免` : ''}${unusedSupp ? ` / ${unusedSupp} 失效豁免` : ''} · exit ${c.error > 0 ? 1 : 0}`);
  return true;
}

// ---------- problems 面板 ----------
const SEV_GLYPH = { error: '✗', warning: '⚠', info: 'ℹ' };
function renderProblems() {
  const c = { error: 0, warning: 0, info: 0 };
  state.problems.forEach((p) => { c[p.severity] += 1; });
  const suppressed = asArray(state.suppressed);
  $('#cnt-all').textContent = state.problems.length;
  $('#cnt-error').textContent = c.error;
  $('#cnt-warning').textContent = c.warning;
  $('#cnt-info').textContent = c.info;
  $('#cnt-suppressed').textContent = suppressed.length;
  const list = $('#problems-list');
  list.innerHTML = '';
  if (state.filter === 'suppressed') {
    if (!suppressed.length) { list.innerHTML = '<div class="empty">无豁免</div>'; return; }
    for (const p of suppressed) {
      const row = document.createElement('div');
      row.className = 'prob suppressed';
      const file = String(p.file).split(/[\\/]/).pop();
      const reason = p.suppress_reason ? `<span class="msg">— 理由: ${escapeHtml(p.suppress_reason)}</span>` : '';
      row.innerHTML =
        `<span class="glyph">⊘</span>` +
        `<span class="rule">[${escapeHtml(p.rule)}]</span>` +
        `<span class="loc">${escapeHtml(file)}:${p.line}</span>` +
        `<span class="msg">${escapeHtml(p.message)}</span>` + reason;
      row.title = p.detail || p.message;
      row.onclick = () => jumpTo(p.file, p.line);
      list.appendChild(row);
    }
    return;
  }
  const shown = state.problems.filter((p) => state.filter === 'all' || p.severity === state.filter);
  if (!shown.length) {
    list.innerHTML = '<div class="empty">无问题</div>';
    return;
  }
  for (const p of shown) {
    const row = document.createElement('div');
    row.className = 'prob ' + p.severity;
    const file = String(p.file).split(/[\\/]/).pop();
    row.innerHTML =
      `<span class="glyph">${SEV_GLYPH[p.severity] || '·'}</span>` +
      `<span class="rule">[${escapeHtml(p.rule)}]</span>` +
      `<span class="loc">${escapeHtml(file)}:${p.line}</span>` +
      `<span class="msg">${escapeHtml(p.message)}</span>`;
    row.title = p.detail || p.message;
    row.onclick = () => jumpTo(p.file, p.line);
    list.appendChild(row);
  }
}
function jumpTo(file, line) {
  const base = String(file).split(/[\\/]/).pop();
  const name = FILES.find((n) => {
    const p = state.paths && state.paths[n];
    return p && String(p).split(/[\\/]/).pop() === base;
  });
  if (name) {
    if (state.mode === 'creator' && name === 'canon') return; // 创作者模式无 canon 标签（行定位无处跳转）
    switchTab(name);
  }
  requestAnimationFrame(() => {
    editor.revealPositionInCenter({ lineNumber: line, column: 1 });
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  });
}

// ---------- 左侧 dashboard ----------
function dashRow(k, v, warn) {
  return `<div class="dash-row${warn ? ' warn' : ''}"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`;
}
function renderDashboard(canon) {
  if (!canon) {
    $('#dash-knowledge').innerHTML = '<div class="empty">设定未解析</div>';
    return;
  }
  const nameOf = (id) => {
    const e = asArray(canon.entities).find((x) => x.id === id);
    return e ? e.name : id;
  };
  const tl = asArray(canon.timeline).slice().sort((a, b) => a.chapter - b.chapter)
    .map((t) => `第${escapeHtml(String(t.chapter))}章 第${escapeHtml(String(t.day))}天 · ${escapeHtml(nameOf(t.location))}`).join('<br>');
  $('#dash-timeline').innerHTML = tl ? `<div class="dash-row"><span class="v">${tl}</span></div>` : '<div class="empty">无时间线</div>';
  $('#dash-knowledge').innerHTML = asArray(canon.knowledge).map((k) =>
    dashRow(k.name, `获知@${k.known_from_chapter} · ${asArray(k.holders).map(nameOf).join('/')}`, false)).join('')
    || '<div class="empty">无知识</div>';
}
function renderDashboardFromCompile(snapshot) {
  if (!snapshot) return;
  $('#dash-entities').innerHTML = asArray(snapshot.entities).map((e) =>
    dashRow(e.name, `${e.type} · ${e.activeChapters}/${e.totalChapters}章`, !e.present)).join('')
    || '<div class="empty">无实体</div>';
  $('#dash-suspense').innerHTML = asArray(snapshot.suspense).map((s) => {
    const st = s.status === 'resolved' ? '✓ 已回收' : (s.status === 'planned' ? '… 未到期' : '⚠ 悬置中');
    return dashRow(s.name, `埋@${s.planted ?? '?'} ${st}`, s.status !== 'resolved');
  }).join('') || '<div class="empty">无悬念</div>';
  $('#dash-timeline').innerHTML = asArray(snapshot.timeline).map((t) => `${escapeHtml(String(t.chapter))}:${escapeHtml(String(t.day))}`).join(' → ')
    || '<div class="empty">无时间线</div>';
}

// ---------- 读协调提示条 ----------
// /api/state 返回每个工作文件的锁状态（<target>.lock，与 CLI 写侧互认）：任一文件被
// 在途写者占用时顶部亮提示条——用户看到的可能是写入前的旧快照，保存/审阅会基于它做决定
function renderLockBanner(locks) {
  const el = $('#lock-banner');
  if (!el) return;
  const locked = FILES.filter((n) => locks && locks[n] && locks[n].locked);
  if (!locked.length) { el.classList.add('hidden'); return; }
  const names = locked.map((n) => FILE_LABEL[n]).join('、');
  el.textContent = `⚠ ${names} 正在被其他进程写入 —— 当前显示/编译可能基于写入前的快照；请等待写入完成后再审阅或保存，避免基于过期数据做决定。`;
  el.classList.remove('hidden');
}

// ---------- 风险登记册面板 ----------
async function refreshRisks() {
  const d = await api('/api/risks');
  if (!d.ok) { log('✗ 风险面板加载失败: ' + d.error); return; }
  state.risks = d.risks;
  state.riskMeta = d.meta;
  state.riskLocked = d.locked || false;
  state.riskLockedInfo = d.lockedInfo || null;
  renderRisks();
}
const RISK_LABEL = { open: '未处理', handled: '已处理', triggered: '已触发', ignored: '忽略' };
function riskLockHint() {
  return state.riskLocked ? `⚠ ${state.riskLockedInfo || '预测文件'} 正被其他进程写入，风险数据可能即将更新 · ` : '';
}
function renderRisks() {
  const risks = asArray(state.risks);
  const sum = $('#risk-summary');
  const list = $('#risk-list');
  if (!state.riskMeta) {
    sum.textContent = state.riskLocked ? '⚠ 预测文件正被其他进程写入，请稍候刷新 · 尚无预测 —— 先运行 ① 模拟' : '尚无预测 —— 先运行 ① 模拟';
    list.innerHTML = '';
    return;
  }
  const sev = { high: 0, medium: 0, low: 0 };
  const stCnt = { open: 0, handled: 0, triggered: 0, ignored: 0 };
  risks.forEach((r) => { sev[r.severity] = (sev[r.severity] || 0) + 1; stCnt[r.status] = (stCnt[r.status] || 0) + 1; });
  sum.textContent = riskLockHint() + `${state.riskMeta.title || '未命名'} · ${risks.length} 条（高${sev.high} 中${sev.medium} 低${sev.low}）· 已处理${stCnt.handled} 已触发${stCnt.triggered} 忽略${stCnt.ignored}`;
  list.innerHTML = '';
  if (!risks.length) {
    list.innerHTML = '<div class="empty">预测中没有风险条目</div>';
    return;
  }
  for (const r of risks) {
    // 字段兜底：last-pred.json 可能被手工编辑（缺字段），不能让单条脏数据击穿整个面板
    const sevSafe = r.severity || 'low';
    const prob = typeof r.probability === 'number' ? r.probability.toFixed(2) : '?';
    const ch = r.chapter !== undefined && r.chapter !== null ? r.chapter : '?';
    const kind = r.kind || '';
    const row = document.createElement('div');
    row.className = 'risk-row sev-' + sevSafe + (r.status !== 'open' ? ' done' : '');
    row.innerHTML =
      `<div class="risk-head">[${escapeHtml(r.id)} · ${escapeHtml(sevSafe)} · 第${escapeHtml(String(ch))}章 · ${escapeHtml(kind)}] 概率 ${prob}</div>` +
      `<div class="risk-text">${escapeHtml(r.risk)}</div>` +
      `<div class="risk-meta">触发: ${escapeHtml(r.trigger || '')}</div>` +
      `<div class="risk-meta mit">对策: ${escapeHtml(r.mitigation || '')}</div>`;
    const btns = document.createElement('div');
    btns.className = 'risk-btns';
    for (const s of ['open', 'handled', 'triggered', 'ignored']) {
      const b = document.createElement('button');
      b.className = 'btn small' + (r.status === s ? ' on' + ({ handled: ' done-s', triggered: ' fire-s', ignored: ' ignore-s' }[s] || '') : '');
      b.textContent = RISK_LABEL[s];
      b.onclick = () => setRiskStatus(r.id, s);
      btns.appendChild(b);
    }
    row.appendChild(btns);
    list.appendChild(row);
  }
}
async function setRiskStatus(id, status) {
  const d = await api('/api/risks', { id, status });
  if (!d.ok) { log('✗ 状态更新失败: ' + d.error); return; }
  await refreshRisks();
}
async function resetRisks() {
  const d = await api('/api/risks', { reset: true });
  if (!d.ok) { log('✗ 重置失败: ' + d.error); return; }
  await refreshRisks();
  log('✓ 风险状态已重置');
}
function switchDash(view) {
  document.querySelectorAll('.dtab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#dash-state').classList.toggle('hidden', view !== 'state');
  $('#dash-risks').classList.toggle('hidden', view !== 'risks');
  if (view === 'risks') refreshRisks();
}

// ---------- AI 面板（流式） ----------
// 执行单个工具并把输出实时流入日志区，返回 { code, ... } 结果标记；传输失败/无结果标记返回 null
async function runToolStream(tool, args) {
  log(`\n$ node ${tool}.js ${args.join(' ')}`);
  const res = await fetch('/api/run-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok || !res.body) {
    // 优先读出服务端错误（如 409 已有任务运行中），比裸 HTTP 状态码更有用
    let msg = 'HTTP ' + res.status;
    try { const e = await res.json(); if (e && e.error) msg = e.error; } catch { /* 保留 HTTP 状态码 */ }
    log('✗ 流式调用失败: ' + msg);
    return null;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('__RESULT__:')) {
          try { result = JSON.parse(line.slice('__RESULT__:'.length)); } catch { result = null; }
        } else if (line.trim()) {
          log(line);
        }
      }
    }
    if (buf.trim()) log(buf.trim());
  } catch (e) {
    // 服务端中断/网络错误：给出原因后返回 null，调用方统一走「未收到结果标记」分支（避免 unhandled rejection）
    log('✗ 流读取中断: ' + (e && e.message ? e.message : String(e)));
    return null;
  }
  return result;
}

async function runTool(tool, args) {
  if (!(await saveDirtyBeforeTool())) return; // 工具读磁盘：先落盘未保存修改
  setRunning(true, tool);
  try {
    const result = await runToolStream(tool, args);
    if (!result) { log('✗ 未收到结果标记'); return; }
    if (tool === 'simulate' && result.code === 0) {
      log('✓ 模拟完成 —— 风险登记册已刷新');
      await refreshRisks();
      switchDash('risks');
    } else if (tool === 'extract-llm' && result.code === 0) {
      log('✓ 提取完成 —— 可点击 ⑤ 审阅');
    } else if (tool === 'compare' && result.code === 1) {
      log('exit 1（存在警告级偏差 —— 需决定 rebase 或修正）');
    } else if (tool === 'compare' && result.code === 0) {
      log('exit 0（无警告级偏差）');
    } else if (tool === 'rebase' && result.code === 1) {
      log('✓ 漂移已处理 —— 新预测已写入 last-pred.json（旧预测已备份 .bak-*），风险登记册已刷新');
      await refreshRisks();
      switchDash('risks');
    } else if (tool === 'rebase' && result.code === 0) {
      log('exit 0（无漂移，预测仍有效）');
    } else if (result.code === 0) {
      log('✓ 完成');
    } else {
      log(`✗ exit ${result.code}`);
    }
  } finally {
    setRunning(false);
  }
}

function setRunning(on, tool) {
  state.running = on ? tool : null;
  const busy = !!state.running;
  for (const sel of ['#btn-report', '#btn-simulate', '#btn-extract', '#btn-extract-ch', '#btn-compare', '#btn-rebase', '#btn-review', '#btn-refactor', '#btn-compile', '#btn-save']) {
    $(sel).disabled = busy;
  }
  setStatus(busy ? `⏳ 运行中: ${tool} …（输出实时流入下方日志）` : (state.mode === 'creator' ? '就绪' : '就绪（F5 编译）'));
}

// ---------- 生成报告（一键流水线 · 创作者模式主入口） ----------
// 无人值守链：模拟 → 提取 → 比对 → 重规划 → 编译，跑完自动弹出审阅窗口。
// 保存策略：起点保存一次（工具读磁盘文件），中途不再打断一键体验。
// 失败策略：跑到哪步挂了就在哪步停（原因见日志），已成功步骤的产物已落盘不回滚。
// 语义约定：compare exit 1 = 警告级漂移（正常，交给重规划处理）；
//           rebase exit 1 = 漂移已处理（正常完成）；simulate/extract 非 0 = 失败。
const REPORT_STEPS = [
  { tool: 'simulate', label: '模拟', okCodes: [0] },
  { tool: 'extract-llm', label: '提取', okCodes: [0] },
  { tool: 'compare', label: '比对', okCodes: [0, 1] },
  { tool: 'rebase', label: '重规划', okCodes: [0, 1] },
];
async function generateReport() {
  if (state.running) return;
  if (!state.paths) { log('✗ 尚未加载项目（无可用工作文件），无法生成报告'); return; }
  log('\n═══ 生成报告：模拟 → 提取 → 比对 → 重规划 → 编译 → 审阅 ═══');
  if (!(await saveDirtyBeforeTool())) { log('✗ 生成报告已中止（自动保存失败）'); return; }
  setRunning(true, '生成报告');
  try {
    for (const step of REPORT_STEPS) {
      log(`\n── ${step.label} ──`);
      const result = await runToolStream(step.tool, toolArgs(step.tool));
      if (!result) { log(`✗ 生成报告中止于「${step.label}」（未收到结果标记）`); return; }
      if (result.code === -1) { log(`✗ 生成报告中止于「${step.label}」（${result.error || '工具执行失败'}）`); return; }
      if (!step.okCodes.includes(result.code)) { log(`✗ 生成报告中止于「${step.label}」（exit ${result.code}，原因见上方日志）`); return; }
      if (step.tool === 'simulate' || step.tool === 'rebase') {
        log(`✓ ${step.label}完成 —— 风险登记册已刷新`);
        await refreshRisks();
      }
    }
    log('\n── 编译 ──');
    if (!(await compile())) { log('✗ 生成报告中止于「编译」（原因见上方日志）'); return; }
    log('\n── 审阅 ──');
    const d = await api('/api/review', {});
    if (!d.ok) { log(`✗ 生成报告中止于「审阅」（${d.error}）`); return; }
    state.review = d.review;
    state.decisions = new Map();
    // 与 src/canon.js 的 CANON_SECTIONS_ALL 同源（通过 /api/canon-schema 获取）
    const r = d.review;
    const hasProposals = canonSchema.CANON_SECTIONS_ALL
      .some((s) => r.sections[s].added.length || r.sections[s].modified.length)
      || (r.retired && r.retired.length > 0);
    if (!hasProposals) {
      log('✓ 报告完成 —— 提取提议与设定基线一致，无需审阅');
      return;
    }
    renderReview();
    $('#review-modal').classList.remove('hidden');
    log('✓ 报告就绪 —— 请在审阅窗口逐条决定（接受/拒绝/编辑）后点「应用决定并写回设定」');
  } catch (e) {
    // 流水线内任何未预期异常（网络中断/流读取失败/接口返回非 JSON）都必须有提示，
    // 不能变成无信息的 unhandled rejection（runToolStream 已兜流中断，这里是最后防线）
    log('✗ 生成报告意外中断: ' + (e && e.message ? e.message : String(e)));
  } finally {
    setRunning(false);
  }
}

function toolArgs(tool) {
  const p = state.paths;
  const pred = p.predDir + '/last-pred.json';
  const extract = p.predDir + '/last-extract.json';
  if (tool === 'simulate') return [p.outline, '--premise', p.premise, '--canon', p.canon, '--reader', state.reader, '--model', state.model, '--out', pred];
  if (tool === 'extract-llm') return [p.manuscript, '--canon', p.canon, '--incremental', '--merge-with', extract, '--reader', state.reader, '--model', state.model, '--out', extract];
  if (tool === 'refactor') return [p.manuscript, p.canon, p.outline, p.premise, '--reader', state.reader, '--model', state.model, '--extract-out', extract];
  if (tool === 'compare') return [pred, p.canon];
  // rebase 覆盖式输出（--out 指向 last-pred.json 本身）：新预测直接就位——风险面板/compare/审阅
  // 全部指向同一文件，rebase 成果在 IDE 中可见（旧预测由 rebase 端备份为 .bak-*）
  if (tool === 'rebase') return [pred, p.canon, '--out', pred];
  return [];
}

// 当前光标所在章（客户端解析手稿标题）
// ⚠ 与 src/extract.js 的章节标题解析保持同步（浏览器端无法 require，需手动同步修改）：
//   HEADING_RE / SPECIAL_RE / cnToInt 语义必须与后端一致，否则"提取本章"定位会与 compile 分章漂移。
const ZH_NUM = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CH_HEAD_RE = /^#{0,6}\s*第\s*([0-9]+|[零一二三四五六七八九十百千万]+)\s*章/;
const CH_SPECIAL_RE = /^#{0,6}\s*(楔子|序章|尾声|番外|后记)/;
function cnToInt(str) {
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  let section = 0, num = 0;
  for (const ch of str) {
    if (ZH_NUM[ch] !== undefined) num = ZH_NUM[ch];
    else if (ch === '十') { section += (num || 1) * 10; num = 0; }
    else if (ch === '百') { section += (num || 1) * 100; num = 0; }
    else if (ch === '千') { section += (num || 1) * 1000; num = 0; }
    else if (ch === '万') {
      const before = section + num;
      section = (before > 0 ? before : 1) * 10000;
      num = 0;
    }
    else return null;
  }
  const v = section + num;
  return v > 0 ? v : null;
}
function currentChapter() {
  if (state.active !== 'manuscript' || !editor) return null;
  const lineNo = editor.getPosition().lineNumber;
  const lines = models.manuscript.getValue().split('\n');
  let ch = null;
  for (let i = 0; i < lineNo - 1; i++) {
    const m = lines[i].match(CH_HEAD_RE);
    if (m) { ch = cnToInt(m[1].replace(/\s/g, '')); continue; }
    const sp = lines[i].match(CH_SPECIAL_RE);
    if (sp) {
      if (sp[1] === '楔子' || sp[1] === '序章') ch = 0; // 第0章，可提取
      else ch = -1; // 尾声/番外/后记：后端 number=null，不能按章号 --from/--to 提取
    }
  }
  return ch;
}
async function extractCurrentChapter() {
  const ch = currentChapter();
  if (ch === null) { log('✗ 无法确定光标所在章节（请把光标放到某章正文内，或确认手稿使用 "第N章" 标题）'); return; }
  if (ch === 0) { log('✗ 楔子/序章（第0章）暂不支持单章提取（--from/--to 要求章号 ≥ 1）；请用「② 提取」全量提取'); return; }
  if (ch === -1) { log('✗ 尾声/番外/后记不支持单章提取（后端无法编号）；请用「② 提取」全量提取'); return; }
  const p = state.paths;
  // --merge-with 指向同一信封（与 ② 提取共用 last-extract.json）：本章新哈希 + 其余章旧哈希继承，
  // 之后「② 提取」增量只提真正脏的章——不传则其余章无哈希键被判脏全量重提（安全但浪费）
  await runTool('extract-llm', [p.manuscript, '--canon', p.canon, '--reader', state.reader, '--model', state.model,
    '--from', String(ch), '--to', String(ch), '--merge-with', p.predDir + '/last-extract.json', '--out', p.predDir + '/last-extract.json']);
}

// ---------- 审阅模态框 ----------
function reviewKey(section, id) { return `${section}|${id}`; }
function reviewDecision(section, id, action, value) {
  const k = reviewKey(section, id);
  if (action === 'reject') state.decisions.delete(k);
  else state.decisions.set(k, { action, value });
}
async function openReview() {
  const d = await api('/api/review', {});
  if (!d.ok) { log('✗ 审阅失败: ' + d.error); return; }
  state.review = d.review;
  state.decisions = new Map();
  renderReview();
  $('#review-modal').classList.remove('hidden');
}
function renderReview() {
  const r = state.review;
  $('#review-title').textContent = `（新增 ${r.counts.added} · 修改 ${r.counts.modified} · 未变 ${r.counts.unchanged}${r.counts.retired ? ` · 建议退役 ${r.counts.retired}` : ''}）`;
  $('#review-summary').textContent = '逐条决定后点「应用决定并写回设定」；未点接受/编辑的条目保持原设定不变。';
  const body = $('#review-body');
  body.innerHTML = '';
  const SECTION_LABEL = { entities: '实体', knowledge: '知识', suspense: '悬念', timeline: '时间线' };
  // 与 src/canon.js 的 CANON_SECTIONS_ALL 同源（通过 /api/canon-schema 获取）
  for (const section of canonSchema.CANON_SECTIONS_ALL) {
    const g = r.sections[section];
    if (!g.added.length && !g.modified.length) continue;
    // 时间线条目没有 id 字段（只有 chapter）——决定 key 必须用 chapter，否则后端永远匹配不上（视为拒绝）
    const idOf = (item) => (section === 'timeline' ? item.chapter : item.id);
    const sec = document.createElement('div');
    sec.className = 'review-section';
    const h = document.createElement('h4');
    h.textContent = SECTION_LABEL[section] + `（+${g.added.length} ~${g.modified.length}）`;
    sec.appendChild(h);
    for (const item of g.added) {
      sec.appendChild(entryRow(section, idOf(item), item.name || `第${item.chapter}章`, 'added', item, null));
    }
    for (const item of g.modified) {
      sec.appendChild(entryRow(section, idOf(item), item.name || `第${item.chapter}章`, 'modified', item, item.changed));
    }
    body.appendChild(sec);
  }
  // 退役建议分组：模型认为正文已无对应内容的悬念（删不删由作者裁决）。
  // 退役是删除操作，所以「全部接受」不自动勾选退役条目——全接受不该包含删除
  if (r.retired && r.retired.length) {
    const sec = document.createElement('div');
    sec.className = 'review-section';
    const h = document.createElement('h4');
    h.textContent = '退役建议（' + r.retired.length + ' 条：模型认为正文已无对应内容，是否从设定中删除？）';
    sec.appendChild(h);
    const p = document.createElement('p');
    p.className = 'review-summary';
    p.textContent = '选「退役」从设定中删除该伏笔；选「保留」维持现状（默认保留）。';
    sec.appendChild(p);
    for (const item of r.retired) {
      sec.appendChild(entryRow('suspense', item.id, item.name, 'retired', item, null));
    }
    body.appendChild(sec);
  }
  if (!body.children.length) body.innerHTML = '<div class="empty">提议与基线一致，无需审阅。</div>';
}
function entryRow(section, id, label, kind, item, changed) {
  const row = document.createElement('div');
  row.className = 'review-entry ' + kind;
  const detail = document.createElement('div');
  detail.className = 'review-detail';
  if (kind === 'added' || kind === 'retired') {
    detail.innerHTML = `<code>${escapeHtml(JSON.stringify(item.item || item))}</code>`;
  } else {
    const parts = Object.entries(changed).map(([k, [a, b]]) =>
      `<div class="field"><span class="k">${escapeHtml(k)}</span><span class="old">${escapeHtml(JSON.stringify(a))}</span>→<span class="new">${escapeHtml(JSON.stringify(b))}</span></div>`).join('');
    detail.innerHTML = parts;
  }
  const ev = asArray(item.evidence).slice(0, 2).map((e) =>
    `<div class="ev">第${escapeHtml(String(e.chapter ?? '?'))}章 L${escapeHtml(String(e.line ?? '?'))}：「${escapeHtml(e.quote)}」</div>`).join('');
  if (ev) detail.insertAdjacentHTML('beforeend', ev);
  const btns = document.createElement('div');
  btns.className = 'review-btns';
  const btn = (t, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn small ' + cls;
    b.textContent = t;
    b.onclick = fn;
    return b;
  };
  const acceptLabel = kind === 'retired' ? '退役' : '接受';
  const rejectLabel = kind === 'retired' ? '保留' : '拒绝';
  btns.appendChild(btn(acceptLabel, 'ok', () => { reviewDecision(section, id, 'accept'); row.classList.add('accepted'); }));
  btns.appendChild(btn(rejectLabel, '', () => { reviewDecision(section, id, 'reject'); row.classList.add('rejected'); }));
  if (kind !== 'retired') {
    btns.appendChild(btn('编辑', '', () => {
      const v = window.prompt('编辑该条目 JSON（保存后按"编辑"值接受）', JSON.stringify(item.item || item, null, 2));
      if (v) {
        try { reviewDecision(section, id, 'edit', JSON.parse(v)); row.classList.add('accepted'); }
        catch (e) { alert('JSON 解析失败: ' + e.message); }
      }
    }));
  }
  row.appendChild(document.createElement('span')).className = 'review-label';
  row.querySelector('.review-label').textContent = label;
  row.appendChild(detail);
  row.appendChild(btns);
  return row;
}
async function applyReview() {
  const ds = [...state.decisions.entries()].map(([k, v]) => {
    const [section, id] = k.split('|');
    return { section, id, action: v.action, value: v.value };
  });
  const r = await api('/api/apply-review', { decisions: ds });
  if (!r.ok) { log('✗ 应用失败: ' + r.error); return; }
  $('#review-modal').classList.add('hidden');
  log(`✓ 已应用 ${r.applied} 条审阅决定，设定已更新（${r.target}）`);
  await reloadCanonModel();
  await compile();
}
// 审阅写回发生在服务器端：重新拉取 canon 刷新编辑器模型，
// 否则旧模型若被 Ctrl+S 保存会把审阅成果覆盖回旧内容
async function reloadCanonModel() {
  const d = await api('/api/state');
  if (!d.ok) { log('⚠ canon 视图刷新失败: ' + d.error + '（磁盘已是最新，仅编辑器显示滞后）'); return; }
  const old = models.canon;
  models.canon = monaco.editor.createModel(d.files.canon.content, 'json');
  savedVer.canon = models.canon.getAlternativeVersionId();
  if (state.active === 'canon') editor.setModel(models.canon);
  if (old) old.dispose();
}
function bindReview() {
  $('#btn-review').onclick = openReview;
  $('#review-close').onclick = () => $('#review-modal').classList.add('hidden');
  $('#review-all-accept').onclick = () => {
    const r = state.review;
    if (!r) return;
    // 与 src/canon.js 的 CANON_SECTIONS_ALL 同源（通过 /api/canon-schema 获取）
    for (const section of canonSchema.CANON_SECTIONS_ALL) {
      // 时间线条目以 chapter 为 id（与 renderReview 的 idOf 一致）
      const idOf = (item) => (section === 'timeline' ? item.chapter : item.id);
      for (const item of r.sections[section].added) reviewDecision(section, idOf(item), 'accept');
      for (const item of r.sections[section].modified) reviewDecision(section, idOf(item), 'accept');
    }
    renderReview();
  };
  $('#review-apply').onclick = applyReview;
}

// ---------- 事件 ----------
function bind() {
  bindSettings();
  $('#btn-save').onclick = saveActive;
  $('#btn-new-project').onclick = openProjectModal;
  $('#project-close').onclick = () => $('#project-modal').classList.add('hidden');
  $('#project-create').onclick = createProject;
  $('#np-name').addEventListener('input', fillProjectDefaults);
  bindSaveMenu();
  $('#btn-compile').onclick = compile;
  $('#btn-report').onclick = generateReport;
  $('#btn-refactor').onclick = () => runTool('refactor', toolArgs('refactor'));
  $('#btn-simulate').onclick = () => runTool('simulate', toolArgs('simulate'));
  $('#btn-extract').onclick = () => runTool('extract-llm', toolArgs('extract-llm'));
  $('#btn-extract-ch').onclick = extractCurrentChapter;
  $('#btn-compare').onclick = () => runTool('compare', toolArgs('compare'));
  $('#btn-rebase').onclick = () => runTool('rebase', toolArgs('rebase'));
  bindReview();
  $('#reader').onchange = (e) => { state.reader = e.target.value; };
  $('#model').onchange = (e) => { state.model = e.target.value; };
  $('#project').onchange = (e) => switchProject(e.target.value);
  $('#btn-clear-log').onclick = () => { $('#ai-log').textContent = ''; };
  $('#risk-refresh').onclick = refreshRisks;
  $('#risk-reset').onclick = resetRisks;
  document.querySelectorAll('.dtab').forEach((t) => {
    t.onclick = () => switchDash(t.dataset.view);
  });
  document.querySelectorAll('.ptab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.ptab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      state.filter = t.dataset.sev;
      renderProblems();
    };
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveActive(); }
    if (e.key === 'F5') { e.preventDefault(); compile(); }
  });
}

window.addEventListener('load', () => { bind(); initMonaco(); });
