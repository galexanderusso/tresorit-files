import { Client, StdioClientTransport, BUILD, MOCK, rssMB } from '../lib/env.mjs';
// Hard test of 1.4.3: three copies of the connector work at random for a set time, each in its own lane plus a
// shared lane where they compete, while copies are killed and restarted and old batches are cleared automatically.
// The test keeps its own record of what every file must contain and compares it with what is really there.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const SERVER = process.env.SERVER || `${BUILD}/final/server/index.js`;
const BASE = `${MOCK}`; const ROOT = `${BASE}/Tresors`; const W = 'Birch Labs/soak'; const DATA = `${BASE}/data-soak`;
const MINUTES = Number(process.argv[2]) || 10; const SEED = Number(process.argv[3]) || Date.now() % 100000;
let seed = SEED; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)]; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(T(W), { recursive: true, force: true }); fs.mkdirSync(T(W), { recursive: true });

// a picture of everything outside the work folder, to prove nothing else was touched
const picture = () => { const h = crypto.createHash('sha256'); const visit = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(d, e.name); if (p === T(W)) continue; if (e.isDirectory()) { h.update(`D ${p}\n`); visit(p); } else if (e.isFile()) { const st = fs.statSync(p); h.update(`F ${p} ${st.size} ${st.mtimeMs}\n`); } else h.update(`O ${p}\n`); } }; visit(ROOT); return h.digest('hex'); };
const before = picture();

const anomalies = []; const note = (s) => { if (anomalies.length < 40) anomalies.push(s); };
const counts = {}; const count = (k) => { counts[k] = (counts[k] || 0) + 1; };
async function start(i) {
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '500', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_HOLDING_FIRST_MS: '700', TRESORIT_HOLDING_SWEEP_MS: '700', TRESORIT_PAUSE_ON_BATTERY: 'false' }, stderr: 'ignore' });
  const client = new Client({ name: `soak${i}`, version: '1' }, { capabilities: {} }); await client.connect(transport);
  const c = { i, client, pid: transport.pid, dead: false };
  c.call = async (tool, args = {}) => { try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 60000 }); return { text: r.content.map((x) => x.text || '').join('\n'), err: Boolean(r.isError) }; } catch (e) { return { text: `CALL FAILED: ${e.message}`, err: true, broken: true }; } };
  return c;
}
const copies = await Promise.all([start(0), start(1), start(2)]);
let lastKill = 0; let lastKilled = -1;
let tokenN = 0; const newToken = () => `SOAKTOKEN${String(++tokenN).padStart(6, '0')}X`;
const body = (tok) => `Soak test document.\nMarker ${tok}\nSecond line of ${tok}.\n`;
const read = (rel) => { try { return fs.readFileSync(T(rel), 'utf8'); } catch { return null; } };
const inHoldOnce = (tok) => { const visit = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (visit(p)) return true; } else if (e.name !== 'manifest.json') { try { if (fs.readFileSync(p, 'utf8').includes(tok)) return true; } catch { /* gone meanwhile */ } } } return false; }; return visit(`${DATA}/deleted`); };
// (batches come and go while the test looks, so it looks twice before saying a file is not in the holding area)
const inHold = (tok) => inHoldOnce(tok) || inHoldOnce(tok);

// ---- each copy's own lane: the test knows exactly what must be there ----
const lanes = [0, 1, 2].map((i) => ({ dir: `${W}/lane${i}`, files: new Map(), n: 0, batches: [], uncertain: null }));
for (const l of lanes) fs.mkdirSync(T(l.dir), { recursive: true });
const purged = new Set(); let backdated = 0;
async function laneOp(c) {
  const l = lanes[c.i]; const names = [...l.files.keys()]; const r = rnd();
  const fresh = () => `${l.dir}/${pick(['', 'sub a/', 'sub b/deep/', 'Relatório/'])}doc ${c.i}-${++l.n}${pick(['.txt', '.md', '.txt', '.csv'])}`;
  let op;
  if (r < 0.30 || names.length < 5) { const p = fresh(); const tok = newToken(); op = { kind: 'write', p, tok }; l.uncertain = op; const x = await c.call('write_file', { path: p, content: body(tok) }); if (!x.err) l.files.set(p, tok); else if (!x.broken) note(`write refused: ${x.text.slice(0, 120)}`); }
  else if (r < 0.42) { const p = pick(names); const tok = newToken(); const old = l.files.get(p); op = { kind: 'overwrite', p, tok, old }; l.uncertain = op; const x = await c.call('write_file', { path: p, content: body(tok), overwrite: true }); if (!x.err) { l.files.set(p, tok); if (!inHold(old)) note(`overwritten version of ${p} not in the holding area`); } else if (!x.broken) note(`overwrite refused: ${x.text.slice(0, 120)}`); }
  else if (r < 0.50) { const p = pick(names); const old = l.files.get(p); const tok = newToken(); op = { kind: 'edit', p, tok, old }; l.uncertain = op; const x = await c.call('edit_file', { path: p, old_text: old, new_text: tok, replace_all: true }); if (!x.err) l.files.set(p, tok); else if (!x.broken) note(`edit refused: ${x.text.slice(0, 120)}`); }
  else if (r < 0.60) { const p = pick(names); const d = fresh(); op = { kind: 'copy', p, d, tok: l.files.get(p) }; l.uncertain = op; const x = await c.call('copy_item', { source: p, destination: d }); if (!x.err) l.files.set(d, l.files.get(p)); else if (!x.broken) note(`copy refused: ${x.text.slice(0, 120)}`); }
  else if (r < 0.72) { const p = pick(names); const d = fresh(); op = { kind: 'move', p, d, tok: l.files.get(p) }; l.uncertain = op; const x = await c.call('move_item', { source: p, destination: d }); if (!x.err) { l.files.set(d, l.files.get(p)); l.files.delete(p); } else if (!x.broken) note(`move refused: ${x.text.slice(0, 120)}`); }
  else if (r < 0.82) { const p = pick(names); const tok = l.files.get(p); op = { kind: 'delete', p, tok }; l.uncertain = op; const pv = await c.call('delete_items', { paths: [p] }); const code = (pv.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1]; if (read(p) === null && !pv.broken) note(`a delete preview removed ${p}`); if (code) { const x = await c.call('delete_items', { paths: [p], confirm_token: code }); if (!x.err) { l.files.delete(p); const b = (x.text.match(/as batch (\S+)/) || [])[1]; l.batches.push({ b, p, tok }); if (!inHold(tok)) note(`deleted ${p} is not in the holding area`); } else if (!x.broken) note(`delete refused: ${x.text.slice(0, 120)}`); } }
  else if (r < 0.88 && l.batches.length) { const k = Math.floor(rnd() * l.batches.length); const { b, p, tok } = l.batches.splice(k, 1)[0]; op = { kind: 'restore', p, tok, b }; l.uncertain = op; const x = await c.call('restore_deleted', { batch: b }); if (!x.err) l.files.set(p, tok); else if (!x.broken) note(`restore refused: ${x.text.slice(0, 140)}`); }
  else if (r < 0.94) { const p = pick(names); op = { kind: 'read' }; const x = await c.call('read_file', { path: p }); if (!x.err && !x.text.includes(l.files.get(p))) note(`read of ${p} did not return its content (${x.text.slice(0, 80)})`); if (x.err && !x.broken) note(`read refused ${Math.round((Date.now() - lastKill) / 100) / 10} s after the last kill (of copy ${lastKilled}; this is copy ${c.i}); file there now: ${read(p) !== null}: ${x.text.slice(0, 600)}`); }
  else if (r < 0.97) { op = { kind: 'export' }; const some = names.slice(0, 3); const x = await c.call('export_to_transfer', { paths: some }); if (x.err && !x.broken) note(`export refused: ${x.text.slice(0, 120)}`); }
  else { op = { kind: 'look' }; const x = await c.call(pick(['connector_status', 'list_deleted', 'list_unreadable', 'recent_files']), {}); if (x.err && !x.broken) note(`a read-only tool failed: ${x.text.slice(0, 120)}`); }
  count(op.kind); if (!c.dead) l.uncertain = null;
}
// after a kill: the one operation that was under way may or may not have happened, but never half
function reconcile(l) {
  const u = l.uncertain; l.uncertain = null; if (!u) return;
  const cur = (p) => { const t = read(p); return t === null ? null : (t.match(/SOAKTOKEN\d{6}X/) || ['?'])[0]; };
  const whole = (p, tok) => read(p) === body(tok);
  if (u.kind === 'write') { const t = read(u.p); if (t === null) l.files.delete(u.p); else if (whole(u.p, u.tok)) l.files.set(u.p, u.tok); else note(`after a kill, ${u.p} is a partial file (${t.length} of ${body(u.tok).length} characters)`); }
  else if (u.kind === 'overwrite' || u.kind === 'edit') { const t = cur(u.p); if (t === u.tok && read(u.p).includes(u.tok)) l.files.set(u.p, u.tok); else if (t === u.old) l.files.set(u.p, u.old); else note(`after a kill, ${u.p} holds neither the old nor the new version (${String(read(u.p)).slice(0, 60)})`); if (u.kind === 'overwrite' && t === u.tok && !whole(u.p, u.tok)) note(`after a kill, ${u.p} is a partial new version`); }
  else if (u.kind === 'copy') { const t = read(u.d); if (t === null) l.files.delete(u.d); else if (whole(u.d, u.tok)) l.files.set(u.d, u.tok); else note(`after a kill, the copy ${u.d} is partial`); if (!whole(u.p, u.tok)) note(`after a kill, the source of a copy (${u.p}) was damaged`); }
  else if (u.kind === 'move') { const s = whole(u.p, u.tok), d = whole(u.d, u.tok); if (read(u.d) !== null && !d) note(`after a kill, the moved file ${u.d} is partial`); if (!s && !d) note(`after a kill, a moved file is at neither place (${u.p})`); if (d) l.files.set(u.d, u.tok); else l.files.delete(u.d); if (s) l.files.set(u.p, u.tok); else l.files.delete(u.p); }
  else if (u.kind === 'delete') { if (read(u.p) === null) { l.files.delete(u.p); if (!inHold(u.tok)) note(`after a kill, ${u.p} is gone and not in the holding area`); } else if (!whole(u.p, u.tok)) note(`after a kill, ${u.p} was damaged by an unfinished delete`); }
  else if (u.kind === 'restore') { if (whole(u.p, u.tok)) l.files.set(u.p, u.tok); else if (read(u.p) === null) { if (inHold(u.tok)) l.batches.push({ b: u.b, p: u.p, tok: u.tok }); else note(`after a kill, a restored file is neither back nor in the holding area (${u.p})`); } else note(`after a kill, the restored file ${u.p} is partial`); }
}

// ---- the shared lane: three copies compete for the same names ----
const shared = `${W}/shared`; fs.mkdirSync(T(shared), { recursive: true }); let contest = 0; const sharedTokens = new Map(); // token -> where it must be found (a path, or 'hold')
async function contestRound() {
  const k = ++contest; const kind = pick(['write', 'move']);
  if (kind === 'write') {
    const p = `${shared}/prize ${k}.txt`; const toks = copies.map(() => newToken());
    const res = await Promise.all(copies.map((c, i) => (c.dead ? { err: true, broken: true } : c.call('write_file', { path: p, content: body(toks[i]) }))));
    const won = res.map((x, i) => (!x.err ? i : -1)).filter((i) => i >= 0); const t = read(p);
    if (res.some((x) => x.broken)) { if (t !== null && !toks.some((tk) => t === body(tk))) note(`contest ${k}: the file is not any one copy's whole content`); if (t !== null) sharedTokens.set((t.match(/SOAKTOKEN\d{6}X/) || ['?'])[0], p); }
    else if (won.length !== 1) note(`contest ${k}: ${won.length} copies were told they saved the same new file`);
    else if (t !== body(toks[won[0]])) note(`contest ${k}: the file does not hold the winner's content`);
    else sharedTokens.set(toks[won[0]], p);
  } else {
    const srcs = copies.map((c, i) => `${shared}/runner ${k}-${i}.txt`); const toks = srcs.map(() => newToken()); srcs.forEach((s, i) => fs.writeFileSync(T(s), body(toks[i])));
    const d = `${shared}/finish ${k}.txt`;
    const res = await Promise.all(copies.map((c, i) => (c.dead ? { err: true, broken: true } : c.call('move_item', { source: srcs[i], destination: d }))));
    const won = res.map((x, i) => (!x.err ? i : -1)).filter((i) => i >= 0); const t = read(d);
    if (!res.some((x) => x.broken) && won.length !== 1) note(`contest ${k}: ${won.length} copies were told they moved a file to the same name`);
    if (t !== null && !toks.some((tk) => t === body(tk))) note(`contest ${k}: the destination is not any one runner's whole content`);
    toks.forEach((tk, i) => { const atSrc = read(srcs[i]) === body(tk); const atDst = t === body(tk); if (!atSrc && !atDst && !inHold(tk)) note(`contest ${k}: runner ${i} is nowhere (not at its start, not at the finish, not in the holding area)`); sharedTokens.set(tk, atDst ? d : atSrc ? srcs[i] : 'hold'); });
  }
  count('contest');
}

// ---- the run ----
const t0 = Date.now(); const until = t0 + MINUTES * 60000; let kills = 0; let nextKill = process.env.SOAK_KILLS === '0' ? Infinity : t0 + 25000; const memLog = []; let nextMem = t0 + 60000; let nextAge = t0 + 20000; let peak = 0;
const rss = (pid) => { try { return rssMB(pid); } catch { return 0; } };
const worker = async (c) => { while (Date.now() < until) { if (c.dead) { await sleep(50); continue; } await laneOp(c); if (rnd() < 0.3) await sleep(Math.floor(rnd() * 30)); } };
const side = (async () => {
  while (Date.now() < until) {
    await sleep(400 + Math.floor(rnd() * 600));
    if (rnd() < 0.5) await contestRound();
    copies.forEach((c) => { peak = Math.max(peak, rss(c.pid)); });
    if (Date.now() > nextMem) { nextMem = Date.now() + 60000; memLog.push(copies.map((c) => rss(c.pid)).join('/')); }
    if (Date.now() > nextAge) { // time passes for a few batches of replaced versions: they become older than 30 days
      nextAge = Date.now() + 15000;
      try { const keep = new Set(lanes.flatMap((l) => l.batches.map((x) => x.b))); const cands = fs.readdirSync(`${DATA}/deleted`).filter((n) => /_replaced_/.test(n) && !keep.has(n) && !purged.has(n)); for (const n of cands.slice(0, 3)) { const f = `${DATA}/deleted/${n}/manifest.json`; const m = JSON.parse(fs.readFileSync(f, 'utf8')); m.when = '2026-09-01 10:00:00'; fs.writeFileSync(f, JSON.stringify(m)); purged.add(n); backdated++; } } catch { /* a batch went meanwhile */ }
    }
    if (Date.now() > nextKill && Date.now() < until - 15000) { // one copy is killed in the middle of whatever it is doing, and started again
      nextKill = Date.now() + 20000 + Math.floor(rnd() * 20000); const c = pick(copies);
      await sleep(Math.floor(rnd() * 200)); c.dead = true; try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } kills++; lastKill = Date.now(); lastKilled = c.i;
      await sleep(1500); reconcile(lanes[c.i]);
      const n = await start(c.i); c.client = n.client; c.pid = n.pid; c.call = n.call; c.dead = false;
    }
  }
})();
await Promise.all([...copies.map(worker), side]);
await sleep(2000);

// ---- the reckoning ----
const out = [];
// 1. every lane holds exactly what the test's own record says
let wrong = 0, missing = 0, extra = 0; let files = 0;
for (const l of lanes) {
  const actual = new Map(); const visit = (d) => { for (const e of fs.readdirSync(T(d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) visit(p); else actual.set(p.normalize('NFC'), fs.readFileSync(T(p), 'utf8')); } }; visit(l.dir);
  for (const [p, tok] of l.files) { files++; const a = actual.get(p.normalize('NFC')); if (a === undefined) { missing++; note(`missing: ${p}`); } else if (a !== body(tok)) { wrong++; note(`wrong content: ${p}`); } }
  for (const p of actual.keys()) if (![...l.files.keys()].some((k) => k.normalize('NFC') === p)) { extra++; note(`unexpected file: ${p}`); }
  // deleted and not restored: still restorable from the holding area
  for (const { p, tok } of l.batches) if (!inHold(tok)) note(`deleted file no longer in the holding area: ${p}`);
}
out.push(`the three lanes hold ${files} files: ${missing} missing, ${wrong} with wrong content, ${extra} that should not be there`);
// 2. the shared lane
let lost = 0; for (const [tok, where] of sharedTokens) { if (where === 'hold') { if (!inHold(tok)) lost++; } else if (read(where) !== body(tok)) lost++; }
out.push(`the shared lane: ${contest} contests, ${lost} file(s) not where they must be`);
// 3. nothing left lying around
const strays = []; const scan = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) scan(p); else if (/\.tmp$|\.part$|^\.tresorit|~$/.test(e.name)) strays.push(p); } }; scan(T(W));
const staging = (() => { try { return fs.readdirSync(`${DATA}/staging`).length; } catch { return 0; } })();
out.push(`temporary files left in Tresorit: ${strays.length}; unfinished work left in the connector's staging folder: ${staging}; half-removed batches: ${fs.readdirSync(`${DATA}/deleted`).filter((n) => n.startsWith('.')).length}`);
// 4. nothing outside the work folder was touched
out.push(`everything outside the work folder is exactly as before: ${picture() === before}`);
// 5. the automatic clearing took exactly the batches that had become old
await sleep(2500);
const log = fs.readdirSync(`${DATA}/logs`).filter((f) => f.startsWith('access-')).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n');
const autoNames = log.split('\n').filter((l) => /\| PURGE\s+\| .*removed from the holding area automatically/.test(l)).map((l) => (l.match(/\| PURGE\s+\| (\S+) \|/) || [])[1]);
const stillThere = [...purged].filter((n) => fs.existsSync(`${DATA}/deleted/${n}`)).length; const wrongly = autoNames.filter((n) => !purged.has(n)).length;
out.push(`automatic clearing: ${backdated} batches became older than 30 days, ${new Set(autoNames).size} removed and logged (${autoNames.length} log lines), ${stillThere} still there, ${wrongly} removed that were not old`);
const errors = (log.match(/\| ERROR\s+\|.*/g) || []); const notes = (log.match(/\| NOTE\s+\|.*/g) || []);
out.push(`log lines: ${log.split('\n').length}; ERROR lines: ${errors.length}${errors.length ? ` (${errors[0].slice(0, 160)})` : ''}; NOTE lines: ${notes.length}${notes.length ? ` (${notes[0].slice(0, 160)})` : ''}`);
// 6. the search index: settled, the same through each copy, finds live files and not deleted ones
for (let i = 0; i < 240; i++) { const s = await Promise.all(copies.map((c) => c.call('connector_status'))); if (s.every((x) => /up to date as of/.test(x.text))) break; await sleep(500); } await sleep(6500);
let notFound = 0, ghost = 0, disagree = 0, probes = 0;
const live = lanes.flatMap((l) => [...l.files.entries()]); for (let i = 0; i < 40 && live.length; i++) { const [p, tok] = live[Math.floor(rnd() * live.length)]; const rs = await Promise.all(copies.map((c) => c.call('search_contents', { query: tok, path: W }))); probes++; const hit = rs.map((x) => x.text.includes(path.basename(p))); if (!hit.every(Boolean)) { notFound++; note(`search did not find ${p} (${hit.join('/')})`); } if (new Set(rs.map((x) => (x.text.match(/^(\d+) file/) || [])[1])).size > 1) disagree++; }
const liveTokens = new Set(lanes.flatMap((l) => [...l.files.values()])); const gone = lanes.flatMap((l) => l.batches).filter((x) => !liveTokens.has(x.tok)); for (let i = 0; i < 15 && gone.length; i++) { const { tok } = gone[Math.floor(rnd() * gone.length)]; const x = await copies[i % 3].call('search_contents', { query: tok, path: W }); probes++; if (!/^0 file|No file|nothing/i.test(x.text) && /\d+ file\(s\) contain/.test(x.text) && !/^0 /.test(x.text)) { ghost++; note(`search still finds a deleted file's content: ${x.text.slice(0, 100)}`); } }
out.push(`search: ${probes} searches through the three copies: ${notFound} live file(s) not found, ${ghost} deleted file(s) still found, ${disagree} disagreement(s) between copies`);
const lu = await copies[0].call('list_unreadable', { path: W, limit: 20 }); const unread = Number((lu.text.match(/^(\d+) of \d+ document/) || [0, -1])[1]);
out.push(`documents in the work folder recorded as unreadable: ${unread} (every one of them is a plain readable text file)`); if (unread !== 0) note(`recorded as unreadable: ${lu.text.split('\n').filter((x) => x.startsWith('- [')).slice(0, 4).join(' || ').slice(0, 500)}`);
const st = await Promise.all(copies.map((c) => c.call('connector_status')));
out.push(`all three copies answering at the end: ${st.every((x) => /Tresorit connector \d+\.\d+\.\d+/.test(x.text))}; peak memory of one copy: ${peak} MB; the lock file left behind: ${fs.existsSync(`${DATA}/change.lock`)}`);
const ops = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
if (process.env.SOAK_KILLS === '0') out.push(`memory of the three copies, each minute (MB): ${memLog.join('  ')}`);
console.log(`HARD TEST (seed ${SEED}): ${MINUTES} minutes, ${Object.values(counts).reduce((a, b) => a + b, 0)} operations (${ops}), ${kills} kills\n- ${out.join('\n- ')}\nANOMALIES: ${anomalies.length}${anomalies.length ? '\n  ' + anomalies.join('\n  ') : ''}`);
for (const c of copies) await c.client.close().catch(() => {});
fs.rmSync(T(W), { recursive: true, force: true });
process.exit(anomalies.length ? 1 : 0);
