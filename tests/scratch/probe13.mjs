// Probes aimed at breaking 1.3.0: simultaneous changes, interruption, odd names, abuse of the small-file route.
import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs'; import crypto from 'node:crypto'; import path from 'node:path';
const SERVER = process.env.SERVER; const BASE = '/home/tester/build/mock'; const ROOT = `${BASE}/Tresors`; const HOME = `${BASE}/data-probe-home`; const W = 'Birch Labs/probe';
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(`${HOME}/Downloads`, { recursive: true }); fs.rmSync(`${ROOT}/${W}`, { recursive: true, force: true });
async function start(name, extra = {}) {
  const DATA = `${BASE}/data-probe-${name}`; fs.rmSync(DATA, { recursive: true, force: true });
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off', ...extra }, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (n, a = {}) => { try { const r = await client.callTool({ name: 'tresorit_' + n, arguments: a }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError }; } catch (e) { return { text: 'PROTOCOL ' + e.message, isError: true }; } };
  const rss = () => Math.round(Number(fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
  return { client, call, DATA, pid: transport.pid, rss };
}
const s = await start('a');
// 1. many different files brought in to the same destination name at the same moment
let lost = 0; const ROUNDS = 40;
for (let k = 0; k < ROUNDS; k++) {
  const N = 6; const names = [];
  for (let i = 0; i < N; i++) { const n = `race-${k}-${i}.txt`; fs.writeFileSync(`${HOME}/Downloads/${n}`, `content ${k} ${i} ` + crypto.randomBytes(8).toString('hex')); names.push(n); }
  const rs = await Promise.all(names.map((n) => s.call('import_file', { source: `~/Downloads/${n}`, destination: `${W}/same-${k}.txt` })));
  const winners = rs.filter((r) => !r.isError).length;
  if (winners !== 1) lost++;
}
console.log(`1. six files imported to one name at once, ${ROUNDS} rounds: rounds where more than one "succeeded" (one silently replacing another): ${lost}`);
// 2. the same with the existing move tool
let lost2 = 0;
for (let k = 0; k < ROUNDS; k++) {
  for (let i = 0; i < 6; i++) fs.writeFileSync(`${ROOT}/${W}/mv-${k}-${i}.txt`, `m ${k} ${i}`);
  const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => s.call('move_item', { source: `${W}/mv-${k}-${i}.txt`, destination: `${W}/moved-${k}.txt` })));
  if (rs.filter((r) => !r.isError).length !== 1) lost2++;
}
console.log(`2. six files moved to one name at once (existing tool), ${ROUNDS} rounds: rounds with a silent replacement: ${lost2}`);
// 3. an Office lock file / system clutter as the thing to import
fs.writeFileSync(`${HOME}/Downloads/~$budget.xlsx`, 'lock'); fs.writeFileSync(`${HOME}/Downloads/Thumbs.db`, 'thumbs');
const j1 = await s.call('import_file', { source: '~/Downloads/~$budget.xlsx', destination: W }); const j2 = await s.call('import_file', { source: '~/Downloads/Thumbs.db', destination: W });
const listed = (await s.call('list_folder', { path: W })).text;
console.log(`3. clutter files imported: ${!j1.isError}/${!j2.isError}; visible afterwards in the folder listing: ${listed.includes('budget')}/${listed.includes('Thumbs')}`);
// 4. flooding the small-file route with unfinished uploads
const m0 = s.rss(); const part = crypto.randomBytes(48000); const b64 = part.toString('base64'); const ph = crypto.createHash('sha256').update(part).digest('hex');
let started = 0;
for (let i = 0; i < 300; i++) { for (let p = 1; p <= 20; p++) { const r = await s.call('receive_file', { path: `${W}/flood-${i}.bin`, part: p, parts: 600, data: b64, part_sha256: ph }); if (r.isError) break; } started++; if (s.rss() > 1500) break; }
console.log(`4. ${started} unfinished uploads of ~1 MB each: memory ${m0} MB -> ${s.rss()} MB`);
await s.client.close();
// 5. the connector is killed outright in the middle of bringing in a folder
fs.mkdirSync(`${HOME}/Downloads/bigpack`, { recursive: true });
for (let i = 0; i < 1500; i++) fs.writeFileSync(`${HOME}/Downloads/bigpack/f${i}.bin`, crypto.randomBytes(120000));
const k = await start('kill');
const prev = await k.call('import_file', { source: '~/Downloads/bigpack', destination: W });
const token = (prev.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
const pending = k.call('import_file', { source: '~/Downloads/bigpack', destination: W, confirm_token: token });
await new Promise((r) => setTimeout(r, 350));
process.kill(k.pid, 'SIGKILL'); await pending;
const partial = fs.existsSync(`${ROOT}/${W}/bigpack`) ? fs.readdirSync(`${ROOT}/${W}/bigpack`).length : -1;
console.log(`5. killed mid-import of 1,500 files: files left in Tresorit from the unfinished import: ${partial < 0 ? 'none (folder absent)' : partial + ' of 1500 (an incomplete folder sits in Tresorit)'}; originals intact: ${fs.readdirSync(`${HOME}/Downloads/bigpack`).length === 1500}`);
fs.rmSync(`${ROOT}/${W}`, { recursive: true, force: true }); fs.rmSync(`${HOME}/Downloads/bigpack`, { recursive: true, force: true });
// 6. rules that depend on capital letters (matters on a Mac disk, which ignores capitals)
const { makeOutside } = await import(path.join(path.dirname(SERVER), 'lib/outside.js'));
const o = makeOutside({ home: HOME, roots: [HOME], tresoritRoot: ROOT, dataDir: `${BASE}/data-probe-a` });
const variants = ['library/Keychains/x', 'LIBRARY/keychains/x', 'applications/Thing.app/x', 'Library/mobile documents/iCloud~other~app/x', 'Library/cloudstorage/tresorit-X/y'];
console.log('6. protected places written with other capitals that the rules would let through:', variants.filter((v) => o.protectedReason(`${HOME}/${v}`) === '').join(' | ') || 'none');
console.log('   Tresorit or data folder written with other capitals let through:', [ROOT.toUpperCase() + '/Birch Labs/x', `${BASE}/DATA-PROBE-A/logs/x`].filter((v) => o.protectedReason(v) === '').length);
