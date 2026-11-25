// Feeds every document of the test library through one reading worker and prints the worker's heap as it goes.
import { Worker } from 'node:worker_threads';
import fs from 'node:fs'; import path from 'node:path';
const LIB = '/home/tester/build/tresorit-connector/server/lib';
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(p); else files.push(p); } })(process.argv[2]);
const pick = files.filter((f) => /\.(pdf|docx|xlsx|pptx|doc|xls|ppt|msg)$/i.test(f));
const w = new Worker(new URL(`file://${LIB}/extract-worker.js`));
let id = 0; const out = []; let lastHeap = 0;
const run = (abs) => new Promise((res) => { const my = ++id; const h = (m) => { if (m.id == null) { lastHeap = m.heapMb; return; } if (m.id === my) { w.off('message', h); res(m); } }; w.on('message', h); w.postMessage({ id: my, abs, ext: path.extname(abs).slice(1).toLowerCase(), size: fs.statSync(abs).size }); });
const rounds = Number(process.argv[3] || 1);
for (let r = 0; r < rounds; r++) for (let i = 0; i < pick.length; i++) { const m = await run(pick[i]); if ((r * pick.length + i) % Math.ceil(pick.length * rounds / 16) === 0) out.push(`${r * pick.length + i}:${lastHeap}`); }
console.log(`${pick.length * rounds} documents; worker heap (MB) along the way: ${out.join(' ')}; process ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
await w.terminate();
