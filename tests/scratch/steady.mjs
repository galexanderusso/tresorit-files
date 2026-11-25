import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const transport = new StdioClientTransport({ command: 'node', args: [process.env.SERVER], env: { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: process.env.DATA, TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off' }, stderr: 'ignore' });
const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
const call = async (tool, args = {}) => { const t0 = Date.now(); const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 600000 }); return { text: r.content.map((c) => c.text || '').join('\n'), ms: Date.now() - t0 }; };
const rss = () => Math.round(Number(fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
for (let i = 0; i < 2000; i++) { await new Promise((r) => setTimeout(r, 300)); if (/up to date as of/.test((await call('connector_status')).text)) break; }
const out = [`start ${rss()}`]; let t = 0;
for (let i = 0; i < 40; i++) { const r = await call('search_contents', { query: ['needle-zebra-42', 'copper sulphate', 'fundação', 'report'][i % 4], match: i % 2 ? 'all_words' : 'phrase' }); t += r.ms; } out.push(`after 40 word searches ${rss()} (${Math.round(t / 40)} ms each)`); t = 0;
for (let i = 0; i < 12; i++) { const r = await call('search_contents', { query: 'need[a-z]+-zebra-\\d+', match: 'regex' }); t += r.ms; } out.push(`after 12 pattern searches ${rss()} (${Math.round(t / 12)} ms each)`);
for (let i = 0; i < 30; i++) await call('read_file', { path: 'Birch Labs/Large/twelve million chars.txt', offset: i * 50000 }); out.push(`after 30 reads of a 12-million-character file ${rss()}`);
console.log(out.join(' | ')); await client.close();
