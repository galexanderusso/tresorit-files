// Reads the big library into the index with a given version of the connector (one copy), and reports.
import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const SERVER = process.env.SERVER; const B = '/home/tester/build/mock/data-big'; const DATA = `${B}/data`;
if (process.argv[2] === 'fresh') fs.rmSync(DATA, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env, TRESORIT_ROOT: `${B}/Tresors`, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off' }, stderr: 'ignore' });
const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
const call = async (tool, args = {}) => (await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n');
const t0 = Date.now(); let st = '';
for (let i = 0; i < 7000; i++) { await sleep(1000); st = await call('connector_status'); if (/up to date as of/.test(st)) break; if (i % 60 === 0) console.log(`${Math.round((Date.now() - t0) / 1000)} s: ${(st.match(/in progress[^\n]*/) || [''])[0].slice(0, 140)}`); }
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s: ${(st.match(/Search index: .*/) || [''])[0]}`);
await client.close();
