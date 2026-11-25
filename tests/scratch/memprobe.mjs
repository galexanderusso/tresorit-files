import { spawn } from 'node:child_process';
import fs from 'node:fs';
const SERVER = process.env.SERVER; const DATA = '/home/tester/build/mock/data-memprobe'; fs.rmSync(DATA, { recursive: true, force: true });
const child = spawn('node', [...(process.env.NODEARGS ? process.env.NODEARGS.split(' ') : []), SERVER], { env: { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false' }, stdio: ['pipe', 'pipe', 'ignore'] });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) + '\n');
const rss = () => Math.round(Number(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
const s = []; let last = -1, stable = 0;
for (let i = 0; i < 240; i++) { await new Promise((r) => setTimeout(r, 500)); let n = 0; try { n = fs.readdirSync(`${DATA}/index/text`).length; } catch {} s.push(`${n}:${rss()}`); if (n === last) stable++; else stable = 0; last = n; if (stable > Number(process.env.TAIL || 30)) break; }
console.log(s.filter((_, i) => i % 4 === 0).join(' '));
child.kill();
