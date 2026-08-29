'use strict';

// 原子写：写临时文件 → fsync 落盘 → rename 替换。
// 必要性：本机文件保护下，子进程直接覆写外部创建的文件会被拦（EPERM），
// 而「同目录新建临时文件 + rename 替换」可行；同时也避免写一半的中间状态。
// fsync：rename 成功后若数据仍在页缓存（崩溃/断电），文件会以空/旧内容存在——
// 对 canon/配置这类关键数据，落盘后再 rename 才真正原子。

const fs = require('fs');
const os = require('os');
const path = require('path');

function atomicWrite(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    // 写入/fsync/rename 失败：清理临时文件（不留 .tmp- 垃圾），再原样抛出
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw e;
  }
  // POSIX：rename 的目录项变更也需落盘（fsync 目录），否则崩溃后可能出现
  // "文件数据已落盘但目录项未持久化"（重命名丢失/指向旧 inode）。
  // Windows 不能 fsync 目录（会 EBADF），跳过；部分平台/文件系统不支持目录 fsync，失败不致命。
  if (process.platform !== 'win32') {
    try {
      const dfd = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* 目录 fsync 失败可忽略 */ }
  }
}

// 工具进程超时（毫秒）：默认 20 分钟（覆盖 LLM 重试的最坏情况），可用环境变量覆盖。
// 非数字/非正值容错回退默认：NaN 传入 setTimeout 等效 0（工具瞬杀），负值同步触发——
// 两者都让超时形同虚设或误杀，静默采用比报错更糟
const TOOL_TIMEOUT_RAW = Number(process.env.TOOL_TIMEOUT_MS || 1200000);
const TOOL_TIMEOUT_MS = Number.isFinite(TOOL_TIMEOUT_RAW) && TOOL_TIMEOUT_RAW > 0 ? TOOL_TIMEOUT_RAW : 1200000;

/**
 * 备份清理：只保留最近 keep 个 `<文件>.bak-*`（按 mtime 排序，最旧的先删）。
 * @returns {number} 删除数量
 */
function pruneBackups(targetPath, keep = 5) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(base + '.bak-'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return 0; }
  let removed = 0;
  for (const f of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, f.name)); removed++; } catch { /* 忽略 */ }
  }
  return removed;
}

/**
 * 分块提取检查点：把当前合并进度写入 `<outFile>.partial`（原子写）。
 * 失败时中间结果不丢，可用 `--canon <checkpoint> --from X --to Y` 从失败批继续。
 * @returns {string} checkpoint 文件路径
 */
function writeChunkCheckpoint(outFile, envelope) {
  const p = `${outFile}.partial`;
  atomicWrite(p, JSON.stringify(envelope, null, 2) + '\n');
  return p;
}

/** 分块提取成功收尾：删除检查点文件。 */
function clearChunkCheckpoint(outFile) {
  try { fs.unlinkSync(`${outFile}.partial`); } catch { /* 忽略 */ }
}

// 跨进程写锁：CLI 直接运行与 IDE（spawn 同一 CLI）并发写同一共享输出（如 last-extract.json）时，
// 原子写只能防损坏、不能防"计算几分钟后互相覆盖"。锁 <target>.lock（O_EXCL）覆盖整个运行：
// 后到者快速失败并给出明确提示，而非白算后静默覆盖。强杀/崩溃遗留的锁由后续获取者
// 按 pid 探活（持有者已死立即回收）或 mtime 陈旧阈值回收。
// 陈旧阈值随 TOOL_TIMEOUT_MS 派生：锁由进程持有整个工具运行（最坏接近 TOOL_TIMEOUT_MS），
// 若阈值低于运行上限，用户调高超时后合法长运行的锁会被后到者误判陈旧回收 → 并发覆盖回归。
// 默认 20min 超时 × 1.5 = 30min 恰为下限（max 保证不变）；超时调高（如 60min）时阈值同步放大。
const LOCK_STALE_MS = Math.max(30 * 60 * 1000, Math.ceil(TOOL_TIMEOUT_MS * 1.5));
const LOCK_WAIT_MS = 3000;            // 争用等待上限：超时报并发冲突（同一输出并发运行是罕见错误，快速失败更可取）
const LOCK_RETRY_MS = 100;

// 锁 payload：写 {pid, host, acquired_at} JSON。动机：killTree（taskkill /F / SIGTERM）强杀与
// 崩溃都不触发 process.on('exit')，.lock 残留后旧协议只能等 30min mtime 阈值回收，期间写入被冻结；
// 有了持有者 pid 即可探活自愈（process.kill(pid, 0)，ESRCH=进程已死 → 立即回收）。
// host 为多机共享目录预留：他机 pid 空间不可信，host 不同不探活（保守走 mtime 回退）。
// 兼容旧文本格式 pid=N（上一版写入，只可能产生于本机）同样探活；无 pid 信息回退 mtime 判定。
function readLockPayload(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        return { pid: Number.isInteger(j.pid) ? j.pid : null, host: typeof j.host === 'string' ? j.host : null };
      }
    } catch { /* 旧文本格式 */ }
    const m = raw.match(/^pid=(\d+)/m);
    if (m) return { pid: Number(m[1]), host: null };
    return { pid: null, host: null };
  } catch { return { pid: null, host: null }; } // 读失败（刚被释放/竞态）：交由调用方按 mtime/重试处理
}

// 探活：true=活着或无法确定（保守不回收，mtime 阈值兜底 pid 复用/探活异常）；false=确定已死（可回收）。
// EPERM=进程存在但无权发信号（POSIX 跨用户）→ 视为活着；ESRCH=不存在 → 已死。
function lockHolderAlive(payload) {
  if (!Number.isInteger(payload.pid) || payload.pid <= 0) return true;
  if (payload.host && payload.host !== os.hostname()) return true;
  try { process.kill(payload.pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function writeLockPayload(fd) {
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), acquired_at: new Date().toISOString() }), null, 'utf8');
}

/**
 * 获取覆盖整个运行的排他写锁。成功返回释放函数（进程退出时经 process.on('exit') 调用；
 * 强杀/崩溃遗留的锁由后续获取者按 pid 探活（持有者已死立即回收）或陈旧阈值回收）。争用超过 LOCK_WAIT_MS 抛错。
 * @param {string} target 被保护的输出文件路径（锁文件为 <target>.lock）
 * @returns {() => void} 释放函数
 */
function acquireFileLock(target) {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
      try { writeLockPayload(fd); }
      finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(lockPath); } catch { /* 已被清理 */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        // 持有者已死（强杀/崩溃遗留）→ 立即回收，不等 mtime 阈值（与异步版同一自愈协议）
        if (!lockHolderAlive(readLockPayload(lockPath))) { fs.unlinkSync(lockPath); continue; }
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch { continue; } // 锁文件刚被释放/竞态：重试获取
      if (Date.now() >= deadline) {
        throw new Error(`输出文件被其他进程占用（${lockPath}）——可能另有 CLI 或 IDE 正在提取同一项目，已放弃本次写入。请等待其完成；若确认无进程在运行，可删除该 .lock 文件后重试`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}

/**
 * 异步获取排他写锁（IDE 服务器专用变体，与 acquireFileLock 同一 <target>.lock 协议互认）。
 * 服务器单线程：同步版内部用 Atomics.wait 阻塞事件循环（CLI 无并发请求，可接受），
 * 服务器阻塞期间将无法响应任何其他请求——改用 setTimeout 轮询，语义完全一致
 * （O_EXCL 创建、pid 探活自愈 + 陈旧回收随 TOOL_TIMEOUT_MS 派生（下限 30min）、3s 争用上限）。冲突抛错信息与同步版相同。
 * @param {string} target 被保护的输出文件路径（锁文件为 <target>.lock）
 * @returns {Promise<() => void>} 释放函数（unlink 锁文件）
 */
async function acquireFileLockAsync(target) {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const dbg = process.env.LOCK_TRACE ? (msg) => console.error(`[lock-trace pid=${process.pid}] ${msg}`) : () => {};
  dbg(`acquire start: ${lockPath}`);
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
      try { writeLockPayload(fd); }
      finally { fs.closeSync(fd); }
      dbg(`acquired: ${lockPath}`);
      return () => { dbg(`release: ${lockPath}`); try { fs.unlinkSync(lockPath); dbg(`released: ${lockPath}`); } catch (e) { dbg(`release FAILED ${e.code}: ${lockPath}`); } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        // 持有者已死（强杀/崩溃遗留）→ 立即回收，不等 mtime 阈值（与同步版同一自愈协议）
        if (!lockHolderAlive(readLockPayload(lockPath))) { fs.unlinkSync(lockPath); continue; }
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) {
        dbg(`deadline reached, giving up: ${lockPath}`);
        throw new Error(`输出文件被其他进程占用（${lockPath}）——可能另有 CLI 或 IDE 正在写入，已放弃本次写入。请等待其完成；若确认无进程在运行，可删除该 .lock 文件后重试`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

/**
 * 批量获取排他写锁（一个工具可能写多个共享输出：extract-llm 同时写 --out 与 --canon-out）。
 * 任一目标获取失败时回滚已获取的锁再抛错——不留部分锁残留在内存/磁盘。
 * @param {string[]} targets 被保护的输出文件路径数组
 * @returns {() => void} 释放函数（逆序释放全部已获取的锁）
 */
function acquireFileLocks(targets) {
  const releases = [];
  try {
    for (const t of targets) releases.push(acquireFileLock(t));
  } catch (e) {
    for (let i = releases.length - 1; i >= 0; i--) { try { releases[i](); } catch { /* 忽略 */ } }
    throw e;
  }
  return () => {
    for (let i = releases.length - 1; i >= 0; i--) { try { releases[i](); } catch { /* 忽略 */ } }
  };
}

/**
 * 读协调检查：锁协议不只约束写侧，读者也应在读取共享文件前感知在途写者——否则读者会在
 * 写者「读-改-写」的长窗口内读到陈旧/进行中数据而无从察觉（如 IDE 审阅基于过期基线做决定）。
 * 与写侧同口径：陈旧锁（mtime 超阈值，崩溃遗留）视为无人持有——读者不应被死进程永久阻塞，
 * 写侧获取时本就会回收陈旧锁。纯检查，不创建/删除任何文件。
 * @param {string} target 被读取的共享文件路径
 * @returns {{locked: boolean, lockPath: string, stale: boolean}}
 */
function checkFileLocked(target) {
  const lockPath = `${target}.lock`;
  let st;
  try { st = fs.statSync(lockPath); }
  catch { return { locked: false, lockPath, stale: false }; }
  // 持有者已死 → 视为陈旧（读侧与写侧同口径自愈：读者不被死进程永久阻塞）
  if (!lockHolderAlive(readLockPayload(lockPath))) return { locked: false, lockPath, stale: true };
  const stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
  return { locked: !stale, lockPath, stale };
}

module.exports = { atomicWrite, pruneBackups, writeChunkCheckpoint, clearChunkCheckpoint, acquireFileLock, acquireFileLockAsync, acquireFileLocks, checkFileLocked, TOOL_TIMEOUT_MS, LOCK_STALE_MS };
