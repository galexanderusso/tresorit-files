import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const DATA = '/home/tester/build/mock/data-net'; fs.rmSync(DATA, { recursive: true, force: true });
const transport = new StdioClientTransport({ command: 'strace', args: ['-f', '-qq', '-e', 'trace=connect,socket,bind,sendto', '-o', '/tmp/net.trace', 'node', '/home/tester/build/final/server/index.js'], env: { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_OCR_ENGINE: 'bundled' }, stderr: 'ignore' });
const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
const call = async (tool, args = {}) => (await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n');
console.log((await call('preflight')).split('\n')[1]);
await call('search_contents', { query: 'unicorn-keyword' }); await call('read_file', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf' });
await call('write_file', { path: 'Birch Labs/net.txt', content: 'x' });
for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 400)); if (/up to date as of/.test(await call('connector_status'))) break; }
console.log((await call('connector_status')).split('\n').filter((l) => /Memory|Search index:|Self-check/.test(l)).join('\n'));
await client.close();
