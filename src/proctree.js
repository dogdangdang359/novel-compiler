'use strict';

// 进程树终止（独立模块以便单测 mock）：
// 工具可能再 spawn 子进程（如 refactor -> extract-llm），只杀主进程会残留孙进程继续消耗 LLM 配额。
//   POSIX: detached 形成新进程组，kill(-pid) 杀整组
//   Windows: taskkill /T 递归杀子进程树（spawnSync 必须带 timeout——taskkill 卡住会同步阻塞事件循环）
// 注意：spawnSync 用运行时 require（不用顶层解构），单测可 monkey-patch child_process.spawnSync 捕获调用。

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      require('child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    }
  } catch { try { child.kill(); } catch { /* 忽略 */ } }
}

module.exports = { killTree };
