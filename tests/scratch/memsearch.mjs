import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const DATA = '/home/tester/build/mock/data-memsearch'; fs.rmSync(DATA, { recursive: true, force: true });
const transport = new StdioClientTransport({ command: 'node', args: [process.env.SERVER], env: { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off' }, stderr: 'ignore' });
const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
await client.connect(transport);
const call = async (tool, args = {}) => { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return r.content.map((c) => c.text || '').join('\n'); };
const rss = () => Math.round(Number(fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
for (let i = 0; i < 400; i++) { await new Promise((r) => setTimeout(r, 300)); if (/up to date as of/.test(await call('connector_status'))) break; }
const s = [rss()];
for (let i = 0; i < 60; i++) { const t = await call('search_contents', { query: ['needle-zebra-42', 'copper sulphate', 'fundação', 'zzz-not-there'][i % 4], ...(i % 5 === 4 ? { match: 'regex', query: 'need[a-z]+-zebra-\\d+' } : {}) }); if (i % 6 === 5) s.push(rss()); if (i === 0) console.log(t.split('\n').slice(-3).join(' / ').slice(0, 400)); }
console.log('memory (MB) after indexing, then after every 6 whole-library searches:', s.join(', '));

await client.close();
