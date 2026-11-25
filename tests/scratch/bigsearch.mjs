import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const SERVER = process.env.SERVER; const B = '/home/tester/build/mock/data-big'; const DATA = `${B}/data-s`;
fs.rmSync(DATA, { recursive: true, force: true }); execFileSync('cp', ['-a', `${B}/data-135`, DATA]);
const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env, TRESORIT_ROOT: `${B}/Tresors`, TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off' }, stderr: 'ignore' });
const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
const call = async (tool, args = {}) => { const t = Date.now(); const text = (await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n'); return [Date.now() - t, text]; };
const out = [];
for (const q of ['BIG-12345', 'BIG-12345', 'amount 20001', 'big library report', 'zzz-not-there']) { const [ms, t] = await call('search_contents', { query: q }); out.push(`${q}: ${(t.match(/^(\d+) file\(s\)/) || ['?'])[0]} ${ms} ms`); }
const [ms2] = await call('find_files', { query: 'Report 123' }); const [ms3] = await call('connector_status');
console.log(out.join(' | '), `| find by name ${ms2} ms | status ${ms3} ms`);
await client.close(); fs.rmSync(DATA, { recursive: true, force: true });
