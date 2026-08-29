'use strict';
// 复现：IDE apply-review 成功后 <canon>.lock 残留（场景 55 第 ④ 步）
// 循环执行：CLI 持锁 → 409 → 释放 → 正常 apply → 检查 .lock 是否残留；失败时转储 .lock 内容
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRV = path.join(ROOT, 'app', 'server.js');
const { acquireFileLock } = require(path.join(ROOT, 'src', 'fsutil'));

const rounds = Number(process.argv[2] || 30);
let failures = 0;

(async () => {
  for (let i = 0; i < rounds; i++) {
    const tag = `repro55-${i}`;
    const cfg = path.join(ROOT, 'app', 'predictions', `${tag}-config.json`);
    const canon = path.join(ROOT, 'app', 'predictions', `${tag}-canon.json`);
    fs.writeFileSync(cfg, JSON.stringify({
      model: 'deepseek-chat', apiKey: null, activeProject: 'P',
      projects: { P: { manuscript: '../test/fixtures/demo-manuscript.md', canon: `predictions/${tag}-canon.json`, outline: '../examples/outline.md', premise: '../examples/premise.md', reader: 'webnovel' } },
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(canon, JSON.stringify({ meta: { title: 'P', target_reader: 'webnovel' }, entities: [], knowledge: [], suspense: [], timeline: [] }, null, 2) + '\n', 'utf8');

    const srv = spawn(process.execPath, [SRV, '--port', '0', '--config', cfg], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const port = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('server start timeout')), 15000);
      srv.stdout.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/LISTENING [^:]+:(\d+)/);
        if (m) { clearTimeout(t); res(Number(m[1])); }
      });
      srv.on('exit', (c) => rej(new Error('server exit ' + c)));
    });

    try {
      const rel = acquireFileLock(canon);
      const r1 = await fetch(`http://127.0.0.1:${port}/api/apply-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: [{ section: 'entities', id: 'old_zhou', action: 'accept' }], proposal: 'test/fixtures/pred-canon.json', canonPath: canon }),
      });
      const j1 = await r1.json();
      if (r1.status !== 409) { failures++; console.log(`[${i}] 预期 409 得到 ${r1.status}`); }
      rel();

      const r2 = await fetch(`http://127.0.0.1:${port}/api/apply-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: [{ section: 'entities', id: 'old_zhou', action: 'accept' }], proposal: 'test/fixtures/pred-canon.json', canonPath: canon }),
      });
      const j2 = await r2.json();
      const residue = fs.existsSync(canon + '.lock');
      if (!(j2.ok && residue === false)) {
        failures++;
        console.log(`[${i}] 失败: j2.ok=${!!j2.ok} applied=${j2.applied} residue=${residue}`);
        if (residue) {
          console.log(`  本脚本 pid=${process.pid} 服务器 pid=${srv.pid}`);
          let content = null;
          for (let k = 0; k < 20 && !content; k++) {
            try { content = fs.readFileSync(canon + '.lock', 'utf8'); } catch { await new Promise((r) => setTimeout(r, 2)); }
          }
          console.log('  .lock 内容:', JSON.stringify(content));
        }
      }
    } finally {
      srv.kill();
      for (const f of fs.readdirSync(path.join(ROOT, 'app', 'predictions'))) {
        if (f.startsWith(tag)) { try { fs.unlinkSync(path.join(ROOT, 'app', 'predictions', f)); } catch { /* 忽略 */ } }
      }
    }
  }
  console.log(`\n结果: ${rounds - failures}/${rounds} 通过, ${failures} 失败`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
