// The self-check while the connector is busy reading a large library in the background, as on the real Mac;
// two requests at once; and a repeat run.
import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const SERVER = process.env.SERVER; const DATA = '/home/tester/build/mock/data-pfbusy'; fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '50', TRESORIT_OCR_ENGINE: 'bundled' }; delete env.TRESORIT_PREFLIGHT_GATE;
const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
const client = new Client({ name: 'pf', version: '1' }, { capabilities: {} }); let protoErrors = 0; client.onerror = () => protoErrors++;
await client.connect(transport);
const call = async (n, a = {}) => { const t0 = Date.now(); const r = await client.callTool({ name: 'tresorit_' + n, arguments: a }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError, ms: Date.now() - t0 }; };
const rss = () => Math.round(Number(fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
const threads = () => Number(fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8').match(/Threads:\s+(\d+)/)[1]);
await new Promise((r) => setTimeout(r, 1500));
const st0 = (await call('connector_status')).text.match(/Background reading: [^\n]+/)[0];
const [a, b] = await Promise.all([call('preflight'), call('preflight')]);
const line = (t) => t.split('\n')[1];
console.log('while busy:', st0.slice(0, 90));
console.log('first :', line(a.text), `(${a.ms} ms)`); console.log('second:', line(b.text), `(${b.ms} ms, same report: ${a.text === b.text})`);
if (!/PASSED\. /.test(a.text)) console.log(a.text.split('\n').filter((l) => /FAIL/.test(l)).join('\n'));
const w = await call('write_file', { path: 'Birch Labs/pf-busy.txt', content: 'x' }); console.log('write after the check:', w.isError ? 'REFUSED' : 'allowed');
const t1 = threads(); const m1 = rss();
for (let i = 0; i < 5; i++) { const r = await call('preflight'); if (!/PASSED\. 50 of 50/.test(r.text)) console.log('repeat', i, line(r.text), r.text.split('\n').filter((l) => /FAIL/.test(l)).join(' | ')); }
for (let i = 0; i < 600; i++) { await new Promise((r) => setTimeout(r, 500)); if (/up to date as of/.test((await call('connector_status')).text)) break; }
await new Promise((r) => setTimeout(r, 1000));
console.log(`after 5 more runs: threads ${t1} -> ${threads()}, memory ${m1} -> ${rss()} MB, stray output errors ${protoErrors}, scratch folders left: ${fs.readdirSync(DATA + '/preflight').length}`);
const s = await call('search_contents', { query: 'needle-zebra-42' }); console.log('real connector still searching correctly:', s.text.includes('report 123.pdf'), '| PF markers leaked into the real index:', /PF-DOCX-101/.test((await call('search_contents', { query: 'PF-DOCX-101' })).text.split('\n').slice(1).join('\n')));
fs.rmSync('/home/tester/build/mock/Tresors/Birch Labs/pf-busy.txt', { force: true });
await client.close();
