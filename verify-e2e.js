'use strict';
// P0 修复后的端到端验证：通过运行中的 IDE server（/api/run-stream）重跑
// 「风雪夜归人」的提取——与浏览器点击 ④重构 ① 阶段完全同路径
const OUT = 'verify-e2e.log';
const body = JSON.stringify({
  tool: 'extract-llm',
  args: [
    'examples/风雪夜归人.md',
    '--canon', 'examples/风雪夜归人-canon.json',
    '--reader', 'webnovel',
    '--model', 'deepseek-chat',
    '--retire-stale',
    '--canon-out', 'examples/风雪夜归人-canon.json',
    '--out', 'app/predictions/风雪夜归人/last-extract.json',
  ],
});
(async () => {
  const t0 = Date.now();
  const fs = require('fs');
  const res = await fetch('http://127.0.0.1:3090/api/run-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  console.log('HTTP', res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let all = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    all += dec.decode(value, { stream: true });
    process.stdout.write('.');
  }
  fs.writeFileSync(OUT, all, 'utf8');
  console.log(`\n完成，用时 ${Math.round((Date.now() - t0) / 1000)}s，输出已存 ${OUT}（${all.length} 字节）`);
})().catch((e) => { console.error('请求失败:', e.message); process.exit(1); });
