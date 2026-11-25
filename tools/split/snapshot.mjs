// Records how the connector answers, to compare before and after a change that must not alter behaviour.
//   TEST_BASE=... SERVER=... node tools/split/snapshot.mjs <label> [selfcheck]
// Needs a restored test library A in <TEST_BASE>/mock (node tests/lib/restore-library.mjs A). Writes
// <TEST_BASE>/snapshots/<label>.json. Works in scratch folders only (tests/lib/env.mjs refuses anything else).
import fs from 'node:fs';
import path from 'node:path';
import { Client, StdioClientTransport, MOCK, SERVER, BUILD } from '../../tests/lib/env.mjs';

const label = process.argv[2];
const withSelfCheck = process.argv[3] === 'selfcheck';
if (!label) { console.error('usage: node tools/split/snapshot.mjs <label> [selfcheck]'); process.exit(2); }
const DATA = `${MOCK}/data-snapshot`;
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env, TRESORIT_ROOT: `${MOCK}/Tresors`, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999', TRESORIT_OCR_ENGINE: 'bundled' };
delete env.TRESORIT_PREFLIGHT_GATE; // the gate as a user has it: read-only until the self-check has passed
const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' });
const client = new Client({ name: 'snapshot', version: '1' }, { capabilities: {} });
await client.connect(transport);
const call = async (tool, args = {}) => {
  const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 600000 });
  return { isError: Boolean(r.isError), text: r.content.map((c) => c.text || `[${c.type}]`).join('\n') };
};
// Times of day, durations and the scratch paths differ from run to run: they are replaced before comparing.
const calm = (t) => t.split(BUILD).join('<BASE>').replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/g, '<time>').replace(/\b\d+(\.\d+)? (ms|s|seconds?|minutes?)\b/g, '<n> $2').replace(/pf-[A-Za-z0-9_-]+/g, 'pf-<id>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/g, '<stamp>').replace(/Memory in use by the connector: \d+ MB/g, 'Memory in use by the connector: <n> MB');

const snap = { server: client.getServerVersion(), instructions: client.getInstructions(), tools: (await client.listTools()).tools, calls: {} };
const steps = [
  ['list_folder', { path: '' }],
  ['list_folder', { path: 'Alder Works UK', recursive: true }],
  ['find_files', { query: 'report' }],
  ['search_contents', { query: 'copper' }],
  ['recent_files', { days: 1 }],
  ['list_deleted', {}],
  ['list_unreadable', {}],
  ['write_file', { path: 'Alder Works UK/snapshot-note.txt', content: 'before the self-check' }],
  ['delete_items', { paths: ['Alder Works UK/snapshot-note.txt'] }],
  ['connector_status', {}],
];
if (withSelfCheck) steps.push(['preflight', {}], ['write_file', { path: 'Alder Works UK/snapshot-note.txt', content: 'after the self-check' }], ['read_file', { path: 'Alder Works UK/snapshot-note.txt' }], ['connector_status', {}], ['access_log', {}]);
let n = 0;
for (const [tool, args] of steps) {
  const r = await call(tool, args);
  snap.calls[`${String(++n).padStart(2, '0')} ${tool} ${JSON.stringify(args)}`] = { isError: r.isError, text: calm(r.text) };
}
await client.close();
const out = path.join(BUILD, 'snapshots');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(snap, null, 1));
console.log(`snapshot ${label}: ${snap.tools.length} tools, ${Object.keys(snap.calls).length} calls recorded`);
