import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const DATA = '/home/tester/build/mock/data-pfrep'; fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_OCR_ENGINE: 'bundled' }; delete env.TRESORIT_PREFLIGHT_GATE;
const transport = new StdioClientTransport({ command: 'node', args: [process.env.SERVER], env, stderr: 'ignore' });
const client = new Client({ name: 'pf', version: '1' }, { capabilities: {} }); await client.connect(transport);
const call = async (n, a = {}) => (await client.callTool({ name: 'tresorit_' + n, arguments: a }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n');
const stat = () => { const s = fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8'); return `${Math.round(Number(s.match(/VmRSS:\s+(\d+)/)[1]) / 1024)} MB/${s.match(/Threads:\s+(\d+)/)[1]} thr`; };
const out = [stat()]; let bad = 0;
for (let i = 0; i < 12; i++) { const r = await call('preflight'); if (!/PASSED\. 50 of 50/.test(r)) bad++; if (i % 3 === 2) out.push(stat()); }
await new Promise((r) => setTimeout(r, 3000)); out.push(stat());
console.log(`12 runs, ${bad} not fully passed; memory/threads: ${out.join(' , ')}`);
await client.close();
