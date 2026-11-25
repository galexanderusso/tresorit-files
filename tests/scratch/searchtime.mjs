import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const DATA = process.env.DATA || '/home/tester/build/mock/data-memsearch';
const transport = new StdioClientTransport({ command: 'node', args: [process.env.SERVER], env: { ...process.env, TRESORIT_ROOT: process.env.ROOT || '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off' }, stderr: 'ignore' });
const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
await client.connect(transport);
const call = async (tool, args = {}) => { const t0 = Date.now(); const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 600000 }); return { text: r.content.map((c) => c.text || '').join('\n'), ms: Date.now() - t0 }; };
const rss = () => Math.round(Number(fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
for (let i = 0; i < 2000; i++) { await new Promise((r) => setTimeout(r, 300)); if (/up to date as of/.test((await call('connector_status')).text)) break; }
console.log((await call('connector_status')).text.split('\n').filter((l) => /Search index:/.test(l)).join(''));
for (const a of [{ query: 'needle-zebra-42' }, { query: 'copper sulphate fundação', match: 'all_words' }, { query: 'need[a-z]+-zebra-\\d+', match: 'regex' }, { query: 'zzz-not-there' }]) { const r = await call('search_contents', a); console.log(`${a.match || 'phrase'}: ${r.ms} ms, memory ${rss()} MB | ${r.text.split('\n')[0]}`); }
await client.close();
