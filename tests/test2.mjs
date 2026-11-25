import { Client, StdioClientTransport, BASE, SERVER, sdkTypes, serverLib } from './lib/env.mjs';
const { ElicitRequestSchema } = sdkTypes;
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = `${BASE}/mock/Tresors`;
const DATA = `${BASE}/mock/data2`;
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, String(d).slice(0, 500)); } };

async function start(extraEnv, caps = {}, onElicit) {
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999', ...extraEnv };
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 'test', version: '1' }, { capabilities: caps });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { client, call, transport };
}

// 1. Tresorit folder missing: server starts, every tool explains
fs.rmSync(DATA, { recursive: true, force: true });
{
  const s = await start({ TRESORIT_ROOT: `${BASE}/mock/does-not-exist` });
  const r = await s.call('tresorit_list_folder', {});
  check('missing folder gives a clear message, no crash', r.isError && /was not found on this Mac/.test(r.text), r.text);
  await s.client.close();
}
// 1b. Data folder inside Tresorit refused
{
  const s = await start({ TRESORIT_DATA_DIR: ROOT + '/Personal/conn' });
  const r = await s.call('tresorit_list_folder', {});
  check('data folder inside Tresorit refused', r.isError && /outside Tresorit/.test(r.text), r.text);
  check('nothing created inside Tresorit', !fs.existsSync(ROOT + '/Personal/conn/logs'));
  await s.client.close();
  fs.rmSync(ROOT + '/Personal/conn', { recursive: true, force: true });
}
// 2. Blocked folders setting
{
  const s = await start({ TRESORIT_BLOCKED: 'Alder Works UK/07 - Research/AB1150/06_IP_quarantine; Strongbox' });
  let r = await s.call('tresorit_read_file', { path: 'Alder Works UK/07 - Research/AB1150/06_IP_quarantine/novelty candidate.txt' });
  check('blocked folder: read refused', r.isError && /blocked folder/.test(r.text), r.text);
  r = await s.call('tresorit_read_file', { path: 'alder works uk/07 - Research/AB1150/06_ip_QUARANTINE/novelty candidate.txt' });
  check('blocked folder: different capitals still refused', r.isError && !/Pre-filing/.test(r.text), r.text);
  r = await s.call('tresorit_search_contents', { query: 'unicorn-keyword' });
  check('blocked folder: hidden from search', !r.text.includes('novelty candidate') && r.text.includes('technical report'), r.text);
  r = await s.call('tresorit_list_folder', {});
  check('blocked tresor: hidden from listing', !r.text.includes('Strongbox') && r.text.includes('Personal'), r.text);
  r = await s.call('tresorit_find_files', { query: 'novelty' });
  check('blocked folder: hidden from find', /No names matching/.test(r.text), r.text);
  r = await s.call('tresorit_write_file', { path: 'Strongbox/x.txt', content: 'x' });
  check('blocked tresor: write refused', r.isError, r.text);
  await s.client.close();
}
// 3. Background indexing
fs.rmSync(DATA, { recursive: true, force: true });
{
  const s = await start({ TRESORIT_INDEX_DELAY_MS: '300' });
  let r; let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await new Promise((x) => setTimeout(x, 500)); r = await s.call('tresorit_connector_status', {}); ok = /up to date as of/.test(r.text); }
  check('background pass completes', ok, r.text);
  check('index counts readable/no-text docs', /Search index: [1-9]\d* document\(s\) readable/.test(r.text) && /[1-9]\d* with no text/.test(r.text), r.text);
  console.log('      ', r.text.split('\n').filter((l) => /Search index|Background/.test(l)).join('\n       '));
  // delete a file behind the connector's back; the next pass should drop it from the index
  const cat = () => JSON.parse(fs.readFileSync(path.join(DATA, 'index', 'catalog.json'), 'utf8')).entries;
  r = await s.call('tresorit_connector_status', { rebuild_index: true });
  for (let i = 0; i < 40; i++) { await new Promise((x) => setTimeout(x, 500)); r = await s.call('tresorit_connector_status', {}); if (/up to date as of/.test(r.text)) break; }
  check('rebuild works', /up to date as of/.test(r.text), r.text);
  await s.client.close();
  await new Promise((x) => setTimeout(x, 300));
  check('catalog saved on exit', Object.keys(cat()).length >= 6, Object.keys(cat()).length);
  const txt = fs.readdirSync(path.join(DATA, 'index', 'text'));
  check('index text stored outside Tresorit', txt.length >= 5 && !DATA.startsWith(ROOT));
}
// 4. Elicitation: user declines, then accepts
{
  fs.writeFileSync(ROOT + '/Birch Labs/Briefs/elicit-a.txt', 'a');
  fs.writeFileSync(ROOT + '/Birch Labs/Briefs/elicit-b.txt', 'b');
  let answer = { action: 'decline' }; let asked = 0; let msg = '';
  const s = await start({}, { elicitation: {} }, async (req) => { asked++; msg = req.params.message; return answer; });
  let p = await s.call('tresorit_delete_items', { paths: ['Birch Labs/Briefs/elicit-a.txt'] });
  let tok = p.text.match(/confirm_token "([0-9a-f]+)"/)[1];
  let r = await s.call('tresorit_delete_items', { paths: ['Birch Labs/Briefs/elicit-a.txt'], confirm_token: tok });
  check('dialog shown to the user', asked === 1 && /elicit-a\.txt/.test(msg), msg);
  check('decline in dialog blocks the delete', r.isError && /declined/.test(r.text) && fs.existsSync(ROOT + '/Birch Labs/Briefs/elicit-a.txt'), r.text);
  answer = { action: 'accept', content: { confirm: false } };
  p = await s.call('tresorit_delete_items', { paths: ['Birch Labs/Briefs/elicit-a.txt'] }); tok = p.text.match(/confirm_token "([0-9a-f]+)"/)[1];
  r = await s.call('tresorit_delete_items', { paths: ['Birch Labs/Briefs/elicit-a.txt'], confirm_token: tok });
  check('unticked box blocks the delete', r.isError && fs.existsSync(ROOT + '/Birch Labs/Briefs/elicit-a.txt'), r.text);
  answer = { action: 'accept', content: { confirm: true } };
  p = await s.call('tresorit_delete_items', { paths: ['Birch Labs/Briefs/elicit-a.txt', 'Birch Labs/Briefs/elicit-b.txt'] }); tok = p.text.match(/confirm_token "([0-9a-f]+)"/)[1];
  r = await s.call('tresorit_delete_items', { paths: ['Birch Labs/Briefs/elicit-a.txt', 'Birch Labs/Briefs/elicit-b.txt'], confirm_token: tok });
  check('accept in dialog deletes', !r.isError && !fs.existsSync(ROOT + '/Birch Labs/Briefs/elicit-a.txt') && !fs.existsSync(ROOT + '/Birch Labs/Briefs/elicit-b.txt'), r.text);
  await s.client.close();
}
// 5. Process exits when the app closes the pipe
{
  const child = spawn('node', [SERVER], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((x) => setTimeout(x, 800));
  const exited = new Promise((res) => child.on('exit', (code) => res(code)));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((x) => setTimeout(() => x('still running'), 4000))]);
  check('server exits when the app disconnects', code === 0, code);
  if (code === 'still running') child.kill('SIGKILL');
}
// 5b. stdout carries protocol only (no stray prints)
{
  const child = spawn('node', [SERVER], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) + '\n');
  await new Promise((x) => setTimeout(x, 1200));
  child.stdin.end();
  const lines = out.split('\n').filter(Boolean);
  check('stdout is clean JSON-RPC', lines.length === 1 && JSON.parse(lines[0]).result.serverInfo.name === 'tresorit-local', out.slice(0, 300));
}
// 6. A stuck document cannot freeze the connector
{
  process.env.TRESORIT_JOB_TIMEOUT_MS = '700';
  const { Extractor } = await serverLib('extractor.js', 'x=1');
  const ex = new Extractor();
  fs.writeFileSync(`${BASE}/mock/hang-worker.mjs`, "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => { for(;;){} });");
  const realSpawn = ex._spawn.bind(ex);
  let first = true;
  ex._spawn = function () {
    if (!first) return realSpawn();
    first = false;
    const w = new Worker(`${BASE}/mock/hang-worker.mjs`);
    w.on('message', (m) => this._finish(m)); w.on('error', (e) => this._crash(e)); w.unref(); this.worker = w;
  };
  const t0 = Date.now();
  const p1 = ex.extract(ROOT + '/Alder Works UK/07 - Research/ORBIT/README.md', 'md', 50, true);
  const p2 = ex.extract(ROOT + '/Alder Works UK/07 - Research/ORBIT/README.md', 'md', 50, true);
  const r1 = await p1; const r2 = await p2;
  check('hung job is cut off', r1.status === 'error' && /timed out/.test(r1.note) && Date.now() - t0 < 5000, JSON.stringify(r1));
  check('next job runs on a fresh worker', r2.status === 'ok' && r2.text.includes('Shared brief'), JSON.stringify(r2).slice(0, 200));
  await ex.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
