// Probes aimed at the 1.3.1 fix code: the change queue, cancelled requests, dialogs, and kills at random moments.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import crypto from 'node:crypto';
const SERVER = process.env.SERVER; const BASE = '/home/tester/build/mock'; const ROOT = `${BASE}/Tresors`; const HOME = `${BASE}/data-p131-home`; const W = 'Birch Labs/p131';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(`${HOME}/Downloads/pack`, { recursive: true }); fs.rmSync(`${ROOT}/${W}`, { recursive: true, force: true }); fs.mkdirSync(`${ROOT}/${W}`, { recursive: true });
for (let i = 0; i < 1200; i++) fs.writeFileSync(`${HOME}/Downloads/pack/f${i}.bin`, crypto.randomBytes(100000));
function raw(name, extra = {}, keep = false) {
  const DATA = `${BASE}/data-p131-${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
  const child = spawn('node', [SERVER], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off', ...extra }, stdio: ['pipe', 'pipe', 'ignore'] });
  const replies = new Map(); const waiters = new Map(); let buf = ''; const incoming = [];
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id !== undefined && m.method) incoming.push(m); else if (m.id !== undefined) { replies.set(m.id, m); const w = waiters.get(m.id); if (w) w(m); } } });
  const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };
  let id = 100;
  const call = (tool, args) => { const my = ++id; send({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name: 'tresorit_' + tool, arguments: args } }); return { id: my, done: new Promise((res) => { if (replies.has(my)) res(replies.get(my)); else waiters.set(my, res); }) }; };
  const text = (m) => (m && m.result ? m.result.content.map((c) => c.text || '').join('\n') : JSON.stringify(m && m.error));
  const init = async (caps = {}) => { send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: caps, clientInfo: { name: 'raw', version: '1' } } }); await sleep(600); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); };
  const exited = new Promise((res) => child.on('exit', (c) => res(c)));
  return { child, send, call, text, init, exited, DATA, incoming };
}
const tok = (t) => (t.match(/confirm_token "([0-9a-f]+)"/) || [])[1];

// P1. Claude closes while one long change is running and six more are waiting their turn
{
  const s = raw('p1'); await s.init();
  const pv = await s.call('import_file', { source: '~/Downloads/pack', destination: W }).done;
  s.call('import_file', { source: '~/Downloads/pack', destination: W, confirm_token: tok(s.text(pv)) });
  await sleep(100);
  for (let i = 0; i < 6; i++) s.call('write_file', { path: `${W}/queued-${i}.txt`, content: `queued ${i}` });
  await sleep(50); s.child.stdin.end();
  const code = await Promise.race([s.exited, sleep(100000).then(() => 'still running')]);
  const n = fs.existsSync(`${ROOT}/${W}/pack`) ? fs.readdirSync(`${ROOT}/${W}/pack`).length : 0;
  const q = [0, 1, 2, 3, 4, 5].filter((i) => fs.existsSync(`${ROOT}/${W}/queued-${i}.txt`)).length;
  console.log(`P1. closed with a long import running and 6 writes waiting: exit ${code}; import ${n}/1200 files; ${q}/6 waiting writes carried out; staging left: ${fs.readdirSync(`${s.DATA}/staging`).length}`);
  fs.rmSync(`${ROOT}/${W}/pack`, { recursive: true, force: true });
}
// P2. a waiting change is cancelled by the app before its turn
{
  const s = raw('p2'); await s.init();
  const pv = await s.call('import_file', { source: '~/Downloads/pack', destination: W }).done;
  const long = s.call('import_file', { source: '~/Downloads/pack', destination: W, confirm_token: tok(s.text(pv)) });
  await sleep(100);
  const w = s.call('write_file', { path: `${W}/cancelled.txt`, content: 'the app gave up on this one' });
  await sleep(50); s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: w.id, reason: 'timed out' } });
  await long.done; await sleep(800);
  console.log(`P2. a waiting write cancelled by the app: carried out anyway afterwards: ${fs.existsSync(`${ROOT}/${W}/cancelled.txt`)}`);
  s.child.kill(); fs.rmSync(`${ROOT}/${W}/pack`, { recursive: true, force: true }); fs.rmSync(`${ROOT}/${W}/cancelled.txt`, { force: true });
}
// P3. a delete is waiting for the user's answer in a dialog: other changes must not be held up
{
  const s = raw('p3'); await s.init({ elicitation: {} });
  await s.call('write_file', { path: `${W}/victim.txt`, content: 'v' }).done;
  const pv = await s.call('delete_items', { paths: [`${W}/victim.txt`] }).done;
  const del = s.call('delete_items', { paths: [`${W}/victim.txt`], confirm_token: tok(s.text(pv)) });
  await sleep(300);
  const t0 = Date.now(); const w = await Promise.race([s.call('write_file', { path: `${W}/meanwhile.txt`, content: 'm' }).done, sleep(4000).then(() => null)]);
  console.log(`P3. write while a delete dialog is open: ${w ? `done in ${Date.now() - t0} ms` : 'BLOCKED'}; dialog requests seen: ${s.incoming.length}`);
  if (s.incoming[0]) s.send({ jsonrpc: '2.0', id: s.incoming[0].id, result: { action: 'accept', content: { confirm: true } } });
  await del.done; console.log(`    after answering yes: victim deleted: ${!fs.existsSync(`${ROOT}/${W}/victim.txt`)}`);
  s.child.kill();
}
// P4. killed at random moments during overwrites, edits and imports over existing files: is anything ever missing or cut short?
{
  const names = Array.from({ length: 8 }, (_, i) => `chaos-${i}.txt`);
  const body = (v) => `version ${v}\n` + 'x'.repeat(200000) + `\nend of version ${v}\n`;
  for (const n of names) fs.writeFileSync(`${ROOT}/${W}/${n}`, body(0));
  fs.mkdirSync(`${ROOT}/${W}/chaos-folder`, { recursive: true }); for (let i = 0; i < 300; i++) fs.writeFileSync(`${ROOT}/${W}/chaos-folder/o${i}.bin`, crypto.randomBytes(50000));
  let missing = 0, torn = 0, folderGone = 0, kills = 0, noRecord = 0;
  for (let round = 1; round <= 30; round++) {
    const s = raw('p4', { TRESORIT_STAGING_MAX_AGE_MS: '1' }, round > 1); await s.init();
    for (const [i, n] of names.entries()) {
      if (i % 3 === 0) s.call('write_file', { path: `${W}/${n}`, content: body(round), overwrite: true });
      else if (i % 3 === 1) s.call('edit_file', { path: `${W}/${n}`, old_text: 'version', new_text: 'version', replace_all: true });
      else { fs.writeFileSync(`${HOME}/Downloads/${n}`, body(round)); s.call('import_file', { source: `~/Downloads/${n}`, destination: `${W}/${n}`, overwrite: true }); }
    }
    if (round % 3 === 0) { const pv = await s.call('import_file', { source: '~/Downloads/pack', destination: `${W}/chaos-into`, overwrite: true }).done; s.call('copy_item', { source: `${W}/chaos-folder`, destination: `${W}/chaos-copy`, overwrite: true }); void pv; }
    await sleep(5 + Math.floor(Math.random() * 140)); s.child.kill('SIGKILL'); await s.exited; kills++;
    for (const n of names) {
      const p = `${ROOT}/${W}/${n}`;
      if (!fs.existsSync(p)) { missing++; fs.writeFileSync(p, body(0)); continue; }
      const c = fs.readFileSync(p, 'utf8'); const m = c.match(/^version (\d+)\n/); if (!m || !c.endsWith(`\nend of version ${m[1]}\n`) || c.length !== body(Number(m[1])).length) { torn++; fs.writeFileSync(p, body(0)); }
    }
    if (!fs.existsSync(`${ROOT}/${W}/chaos-folder`) || fs.readdirSync(`${ROOT}/${W}/chaos-folder`).length !== 300) folderGone++;
    const hasFile = (d) => fs.readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasFile(`${d}/${e.name}`) : !/^manifest\.json/.test(e.name)));
    for (const b of fs.readdirSync(`${s.DATA}/deleted`)) { let ok = false; try { JSON.parse(fs.readFileSync(`${s.DATA}/deleted/${b}/manifest.json`, 'utf8')); ok = true; } catch { ok = false; } if (!ok && hasFile(`${s.DATA}/deleted/${b}`)) noRecord++; }
  }
  console.log(`P4. ${kills} kills at random moments during overwrites, edits and imports over existing files: file missing afterwards ${missing} time(s), file cut short ${torn} time(s), source folder damaged ${folderGone}, holding batches that hold files but have no readable record ${noRecord}`);
}
// P5. killed in the middle of deleting 400 files in one request
{
  const s = raw('p5'); await s.init();
  fs.mkdirSync(`${ROOT}/${W}/many`, { recursive: true }); const paths = [];
  for (let i = 0; i < 400; i++) { fs.writeFileSync(`${ROOT}/${W}/many/d${i}.txt`, `d ${i}`); paths.push(`${W}/many/d${i}.txt`); }
  const pv = await s.call('delete_items', { paths: paths.slice(0, 200) }).done;
  s.call('delete_items', { paths: paths.slice(0, 200), confirm_token: tok(s.text(pv)) });
  await sleep(25); s.child.kill('SIGKILL'); await s.exited;
  let both = 0, neither = 0, held = 0, unrecorded = 0;
  const batches = fs.readdirSync(`${s.DATA}/deleted`);
  const recorded = new Set(); for (const b of batches) { try { for (const it of JSON.parse(fs.readFileSync(`${s.DATA}/deleted/${b}/manifest.json`, 'utf8')).items) recorded.add(it.original); } catch { /* no record */ } }
  for (let i = 0; i < 200; i++) { const inT = fs.existsSync(`${ROOT}/${paths[i]}`); const inH = batches.some((b) => fs.existsSync(`${s.DATA}/deleted/${b}/files/${paths[i]}`)); if (inT && inH) both++; if (!inT && !inH) neither++; if (inH) { held++; if (!recorded.has(paths[i])) unrecorded++; } }
  console.log(`P5. killed while deleting 200 files: ${held} reached the holding area; lost altogether ${neither}; in the holding area without a record ${unrecorded}; duplicated ${both}`);
}
fs.rmSync(`${ROOT}/${W}`, { recursive: true, force: true });
