import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const dir = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
const transport = new StdioClientTransport({ command: 'node', args: [`${dir}/server/index.js`], env: { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: '/home/tester/build/mock/data-toolcheck', TRESORIT_INDEX_DELAY_MS: '999999' }, stderr: 'ignore' });
const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
await client.connect(transport);
const live = (await client.listTools()).tools;
const a = new Set(manifest.tools.map((t) => t.name)); const b = new Set(live.map((t) => t.name));
console.log('manifest', a.size, 'server', b.size, '| only in manifest:', [...a].filter((x) => !b.has(x)).join(',') || 'none', '| only in server:', [...b].filter((x) => !a.has(x)).join(',') || 'none');
console.log('server reports version', client.getServerVersion().version, '| manifest version', manifest.version);
const bytes = JSON.stringify(live).length;
console.log('size of the tool definitions sent to Claude:', bytes, 'characters; longest description', Math.max(...live.map((t) => t.description.length)));
for (const t of live) { const s = t.inputSchema; if (s.type !== 'object' || s.additionalProperties === true) console.log('schema oddity', t.name); }
console.log('every tool has a title and read-only/destructive hints:', live.every((t) => t.title && t.annotations && typeof t.annotations.readOnlyHint === 'boolean'));
console.log('read-only tools:', live.filter((t) => t.annotations.readOnlyHint).map((t) => t.name.replace('tresorit_', '')).join(', '));
await client.close();
