import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const DATA = '/home/tester/build/mock/data-quick'; fs.rmSync(DATA, { recursive: true, force: true });
const transport = new StdioClientTransport({ command: 'node', args: ['/home/tester/build/tresorit-connector/server/index.js'], env: { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off' }, stderr: 'pipe' });
transport.stderr?.on('data', (d) => process.stdout.write('[stderr] ' + d));
const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
const call = async (tool, args = {}) => { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 30000 }); return r.content.map((c) => c.text || '').join('\n'); };
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); const s = await call('connector_status'); const l = s.split('\n').filter((x) => /Search index:|Background/.test(x)).join(' | '); if (i % 4 === 0) console.log(l); if (/up to date/.test(s)) { console.log('done', l); break; } }
await client.close();
