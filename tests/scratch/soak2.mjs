// Deep stress run: three copies of the connector work at random on REAL documents (PDF, Word, Excel, text,
// password-protected PDFs, pictures saved as .pdf, files with the wrong ending), using every feature: saving in
// base64, receiving in parts, bringing in from the Mac, copy, move, rename to a wrong ending, delete, restore,
// overwrite, unlock with a password (right, wrong, cancelled), search, find identical, export and clearing the
// transfer folder, while copies are killed and restarted and the background reading and text recognition run.
// The test keeps its own record of where every document must be and compares bytes, replies and searches.
import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const SERVER = process.env.SERVER || '/home/tester/build/final/server/index.js';
const BASE = '/home/tester/build/mock'; const ROOT = process.env.SOAK_ROOT || `${BASE}/Tresors`; const W = 'Birch Labs/soak2'; const DATA = `${BASE}/data-soak2`;
const HOME = `${BASE}/data-soak2-home`; const PWDIR = `${BASE}/data-soak2-pw`; const POOL = `${BASE}/data-pool`;
const MINUTES = Number(process.argv[2]) || 10; const SEED = Number(process.argv[3]) || Date.now() % 100000; const KILLS = process.env.SOAK_KILLS !== '0';
let seed = SEED; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)]; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
for (const d of [DATA, HOME, PWDIR, T(W)]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/Downloads`, { recursive: true }); fs.mkdirSync(PWDIR, { recursive: true }); fs.mkdirSync(T(W), { recursive: true });
const pool = JSON.parse(fs.readFileSync(`${POOL}/pool.json`, 'utf8')); const PW = { A: pool.pwA, B: pool.pwB };
// the pool in a random order, dealt to the three copies
const deck = pool.items.map((x) => ({ ...x, bytes: fs.readFileSync(`${POOL}/${x.file}`) })).sort(() => rnd() - 0.5);
const hands = [0, 1, 2].map((i) => deck.filter((_, k) => k % 3 === i));
const lockedToks = new Set(pool.items.filter((x) => x.type === 'locked').map((x) => x.tok));

const picture = () => { const h = crypto.createHash('sha256'); const visit = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(d, e.name); if (p === T(W)) continue; if (e.isDirectory()) { h.update(`D ${p}\n`); visit(p); } else if (e.isFile()) { const st = fs.statSync(p); h.update(`F ${p} ${st.size} ${st.mtimeMs}\n`); } else h.update(`O ${p}\n`); } }; visit(ROOT); return h.digest('hex'); };
const before = picture();
const anomalies = []; const note = (s) => { if (anomalies.length < 50) anomalies.push(s); };
const counts = {}; const count = (k) => { counts[k] = (counts[k] || 0) + 1; };
const everUnlocked = new Set(); // markers of protected PDFs that a right password has opened at least once
let replies = 0;
function inspect(text, where) { // every reply: no password, and no text of a protected PDF that was never opened
  replies++;
  if (text.includes(PW.A) || text.includes(PW.B)) note(`A PASSWORD APPEARED IN A REPLY (${where})`);
  const m = text.match(/POOLTOK\d{6}X/g); if (m) for (const t of m) if (lockedToks.has(t) && !everUnlocked.has(t)) { note(`TEXT OF A PROTECTED PDF THAT WAS NEVER OPENED APPEARED IN A REPLY (${where}): ${t}`); everUnlocked.add(t); }
}
async function start(i) {
  const script = `${PWDIR}/ask${i}.sh`; fs.writeFileSync(script, `#!/bin/sh\nv=$(cat "${PWDIR}/answer${i}" 2>/dev/null)\n[ "$v" = "CANCEL" ] && exit 1\nprintf '%s\\n' "$v"\n`); fs.writeFileSync(`${PWDIR}/answer${i}`, 'CANCEL');
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME, TRESORIT_INDEX_DELAY_MS: '500', TRESORIT_INDEX_INTERVAL_MS: '20000', TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_PAUSE_ON_BATTERY: 'false', TRESORIT_PASSWORD_CMD: JSON.stringify(['/bin/sh', script]) };
  delete env.TRESORIT_HOLDING_DAYS;
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: `soak2-${i}`, version: '1' }, { capabilities: {} }); await client.connect(transport);
  const c = { i, client, pid: transport.pid, dead: false };
  c.call = async (tool, args = {}) => { try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 120000 }); const text = r.content.map((x) => x.text || '').join('\n'); inspect(text, tool); return { text, err: Boolean(r.isError) }; } catch (e) { return { text: `CALL FAILED: ${e.message}`, err: true, broken: true }; } };
  return c;
}
const copies = await Promise.all([start(0), start(1), start(2)]);
const lanes = [0, 1, 2].map((i) => ({ dir: `${W}/lane${i}`, files: new Map(), n: 0, batches: [], uncertain: null, hand: hands[i], next: 0, stamp: new Map() }));
const diskSha = (rel) => { try { return sha(fs.readFileSync(T(rel))); } catch { return null; } };
const extFor = (it) => path.extname(it.file);
const folderFor = (it) => (it.type === 'locked' ? `locked ${it.pw}/` : pick(['', 'docs/', 'docs/Relatório/', 'deep/a/b/']));
const paths = (text) => [...text.matchAll(/^\d+\. (.+?) {3}\(/gm)].map((m) => m[1]);
const partial = (text) => /had not been read yet|time limit|not searchable yet|still waiting for text recognition/.test(text);
const stage = (it) => { const f = `${HOME}/Downloads/${it.file}`; fs.writeFileSync(f, it.bytes); return f; };

async function laneOp(c) {
  const l = lanes[c.i]; const names = [...l.files.keys()]; const r = rnd(); let kind;
  const some = (pred) => { const a = names.filter((p) => pred(l.files.get(p))); return a.length ? pick(a) : null; };
  if ((r < (names.length < 60 ? 0.26 : 0.07) || names.length < 8) && l.next < l.hand.length) { // a new document arrives, one of three ways
    const it = l.hand[l.next++]; const p = `${l.dir}/${folderFor(it)}${path.basename(it.file, extFor(it))} c${c.i}-${++l.n}${extFor(it)}`; const way = rnd();
    kind = way < 0.4 ? 'save' : way < 0.7 ? 'bring in' : 'in parts'; l.uncertain = { paths: [p], ok: [it.sha] }; let x;
    if (kind === 'save') x = await c.call('write_file', { path: p, content: it.bytes.toString('base64'), encoding: 'base64', sha256: it.sha });
    else if (kind === 'bring in') x = await c.call('import_file', { source: stage(it), destination: p, allow_duplicate: true });
    else { const b64 = it.bytes.toString('base64'); const parts = []; for (let k = 0; k < b64.length; k += 8000) parts.push(b64.slice(k, k + 8000)); for (let k = 0; k < parts.length; k++) { x = await c.call('receive_file', { path: p, part: k + 1, parts: parts.length, data: parts[k], part_sha256: sha(Buffer.from(parts[k], 'base64')), ...(k === parts.length - 1 ? { file_sha256: it.sha } : {}) }); if (x.err) break; } }
    if (!x.err) { l.files.set(p, it); if (diskSha(p) !== it.sha) note(`${kind}: ${p} is not byte for byte what was sent`); } else if (!x.broken) note(`${kind} refused: ${x.text.slice(0, 200)}`);
  } else if (r < 0.40) { // read it back as text
    kind = 'read'; const p = pick(names); const it = l.files.get(p); const x = await c.call('read_file', { path: p });
    if (it.type === 'locked') { if (!x.err && !everUnlocked.has(it.tok)) note(`a protected PDF was read without a password: ${p}`); }
    else if (it.type === 'picture') { if (x.err && !/still being recognised|text recognition/.test(x.text) && !x.broken) note(`picture read refused: ${p}: ${x.text.slice(0, 160)}`); }
    else if (x.err) { if (!x.broken) note(`read refused: ${p} (${it.type}): ${x.text.slice(0, 300)}`); } else if (!x.text.includes(it.tok)) note(`read of ${p} (${it.type}) did not return its text: ${x.text.slice(0, 160)}`);
  } else if (r < 0.47) { kind = 'copy'; const p = pick(names); const it = l.files.get(p); const d = `${l.dir}/copies/${path.basename(p, path.extname(p))} copy ${++l.n}${path.extname(p)}`; l.uncertain = { paths: [d], ok: [it.sha] }; const x = await c.call('copy_item', { source: p, destination: d }); if (!x.err) l.files.set(d, it); else if (!x.broken) note(`copy refused: ${x.text.slice(0, 160)}`);
  } else if (r < 0.58) { // move, sometimes to a name with capitals and accents, sometimes to the wrong ending
    kind = 'move'; const p = pick(names); const it = l.files.get(p); let ext = path.extname(p); const w = rnd();
    if (w < 0.15 && (it.type === 'pdf' || it.type === 'pdf-as-docx')) { ext = ext === '.pdf' ? '.docx' : '.pdf'; kind = 'wrong ending'; }
    const d = `${l.dir}/${it.type === 'locked' ? `locked ${it.pw}/` : pick(['moved/', 'Ação é Útil/', 'docs/'])}${pick(['Doc', 'RELATÓRIO', 'file'])} ${++l.n}${ext}`;
    l.uncertain = { paths: [p, d], ok: [it.sha], move: true }; const x = await c.call('move_item', { source: p, destination: d }); if (!x.err) { l.files.set(d, it); l.files.delete(p); } else if (!x.broken) note(`move refused: ${x.text.slice(0, 160)}`);
  } else if (r < 0.66) { kind = 'delete'; const p = pick(names); const it = l.files.get(p); l.uncertain = { paths: [p], ok: [it.sha], del: true }; const pv = await c.call('delete_items', { paths: [p] }); const code = (pv.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1]; if (diskSha(p) === null && !pv.broken) note(`a delete preview removed ${p}`);
    if (code) { const x = await c.call('delete_items', { paths: [p], confirm_token: code }); if (!x.err) { l.files.delete(p); l.batches.push({ b: (x.text.match(/as batch (\S+)/) || [])[1], p, it }); } else if (!x.broken) note(`delete refused: ${x.text.slice(0, 160)}`); }
  } else if (r < 0.71 && l.batches.length) { kind = 'restore'; const { b, p, it } = l.batches.splice(Math.floor(rnd() * l.batches.length), 1)[0]; l.uncertain = { paths: [p], ok: [it.sha], restore: true }; const x = await c.call('restore_deleted', { batch: b }); if (!x.err) { l.files.set(p, it); if (diskSha(p) !== it.sha) note(`restored ${p} is not byte for byte what was deleted`); } else if (!x.broken) note(`restore refused: ${x.text.slice(0, 200)}`);
  } else if (r < 0.75 && l.next < l.hand.length) { // replace a document by another of the same kind
    kind = 'overwrite'; const p = some((it) => it.type !== 'locked'); const it2 = l.hand.slice(l.next).find((x) => p && extFor(x) === path.extname(p).toLowerCase() && x.type !== 'locked');
    if (p && it2) { l.hand.splice(l.hand.indexOf(it2), 1); const old = l.files.get(p); l.uncertain = { paths: [p], ok: [old.sha, it2.sha] }; const x = await c.call('write_file', { path: p, content: it2.bytes.toString('base64'), encoding: 'base64', sha256: it2.sha, overwrite: true }); if (!x.err) { l.files.set(p, it2); if (!/holding area/.test(x.text)) note(`overwrite of ${p} did not say the old version was kept`); } else if (!x.broken) note(`overwrite refused: ${x.text.slice(0, 160)}`); }
  } else if (r < 0.80) { // the password box: right, wrong or cancelled
    kind = 'unlock'; const which = pick(['A', 'B']); const dir = `${l.dir}/locked ${which}`; const inside = names.filter((p) => p.startsWith(`${dir}/`)); const how = pick(['right', 'right', 'wrong', 'cancel']);
    if (inside.length) { fs.writeFileSync(`${PWDIR}/answer${c.i}`, how === 'right' ? PW[which] : how === 'wrong' ? 'not-the-password-123' : 'CANCEL');
      if (how === 'right') for (const p of inside) everUnlocked.add(l.files.get(p).tok); // (set before the call: a kill may come between the opening and the reply)
      const x = await c.call('unlock_folder', { path: dir }); const m = x.text.match(/^(\d+) of (\d+) password-protected/m);
      if (how === 'right') { if (!x.broken && !x.err && m && Number(m[1]) !== Number(m[2])) note(`right password, but ${m[1]} of ${m[2]} opened in ${dir}: ${x.text.slice(0, 300)}`); if (x.err && !x.broken) note(`unlock with the right password refused: ${x.text.slice(0, 200)}`); }
      else if (!x.broken && m && Number(m[1]) > 0) note(`${how} password, yet ${m[1]} PDF(s) were opened in ${dir}`);
      fs.writeFileSync(`${PWDIR}/answer${c.i}`, 'CANCEL'); count(`unlock ${how}`); }
  } else if (r < 0.90) { // search for one document by its marker: it must be found exactly where the record says
    kind = 'search'; const p = some((it) => it.type !== 'locked' && it.type !== 'picture'); if (p) { const it = l.files.get(p); const want = names.filter((q) => l.files.get(q) === it || l.files.get(q).tok === it.tok).sort(); const x = await c.call('search_contents', { query: it.tok, path: l.dir, limit: 50 }); const got = paths(x.text).sort();
      if (!x.broken) { const ghosts = got.filter((g) => !want.includes(g)); const missing = want.filter((g) => !got.includes(g)); if (ghosts.length) note(`search found ${it.tok} where it is not: ${ghosts[0]}`); if (missing.length && !partial(x.text)) note(`search did not find ${it.tok} (${it.type}) at ${missing[0]} | ${x.text.slice(0, 200).replace(/\n/g, ' ')}`); } }
  } else if (r < 0.93) { // identical files: exactly the copies the record knows of
    kind = 'identical'; const x = await c.call('find_identical', { path: l.dir, limit: 500 }); if (!x.err) { const groups = x.text.split(/\n(?=\d+ identical file\(s\))/).slice(1).map((g) => [...g.matchAll(/^- (.+?) {3}\d{4}-/gm)].map((m) => m[1]));
      for (const g of groups) { const shas = new Set(g.map((p) => (l.files.get(p) || {}).sha)); if (shas.size !== 1 || shas.has(undefined)) { if (g.every((p) => diskSha(p) === diskSha(g[0]) && diskSha(p))) continue; note(`find identical grouped files that differ: ${g.slice(0, 3).join(' | ')}`); } }
      const bySha = new Map(); for (const [p, it] of l.files) { if (!bySha.has(it.sha)) bySha.set(it.sha, []); bySha.get(it.sha).push(p); } const expect = [...bySha.values()].filter((v) => v.length > 1).length; if (groups.length < expect && !/more group/.test(x.text)) note(`find identical reported ${groups.length} group(s), the record has ${expect}`); } else if (!x.broken) note(`find identical refused: ${x.text.slice(0, 160)}`);
  } else if (r < 0.96) { // copies out, and the transfer folder emptied (shared by the three copies)
    kind = 'export+clear'; const x = await c.call('export_to_transfer', { paths: names.slice(0, 3) }); if (x.err && !x.broken) note(`export refused: ${x.text.slice(0, 160)}`);
    const pv = await c.call('clear_transfer', {}); const code = (pv.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1]; if (code && rnd() < 0.7) { const y = await c.call('clear_transfer', { confirm_token: code }); if (y.err && !y.broken && !/changed|again|preview/i.test(y.text)) note(`clearing the transfer folder failed oddly: ${y.text.slice(0, 200)}`); }
  } else { kind = 'look'; const tool = pick(['connector_status', 'list_deleted', 'list_unreadable', 'recent_files', 'access_log']); const x = await c.call(tool, tool === 'list_unreadable' ? { path: l.dir } : {}); if (x.err && !x.broken) note(`a read-only tool failed (${tool}): ${x.text.slice(0, 160)}`);
    if (tool === 'list_unreadable' && !x.err) for (const m of x.text.matchAll(/^- \[(damaged|empty[^\]]*|content[^\]]*|too large|other[^\]]*)\] (.+?) {3}/gm)) { const it = l.files.get(m[2]); if (it && diskSha(m[2]) === it.sha) note(`a good document is listed as unreadable (${m[1]}): ${m[2]} | ${(x.text.split('\n').find((y) => y.includes(m[2])) || '').slice(-160)}`); } }
  count(kind || 'none'); if (!c.dead) l.uncertain = null;
}
// after a kill: the one operation under way may or may not have happened, but never half
function reconcile(l) {
  const u = l.uncertain; l.uncertain = null; if (!u) return;
  const state = u.paths.map((p) => diskSha(p));
  for (let k = 0; k < u.paths.length; k++) if (state[k] !== null && !u.ok.includes(state[k])) note(`after a kill ${u.paths[k]} holds bytes that are neither the old nor the new document (half-written)`);
  if (u.move) { const [p, d] = u.paths; const it = l.files.get(p) || l.files.get(d); if (state[0] && state[1]) note(`after a kill a moved file is in both places: ${p} and ${d}`); if (!state[0] && !state[1]) note(`after a kill a moved file is in neither place: ${p}`); if (it) { l.files.delete(p); l.files.delete(d); l.files.set(state[1] ? d : p, it); } return; }
  const p = u.paths[0]; const known = [...lanes.flatMap((x) => x.hand), ...l.files.values(), ...l.batches.map((b) => b.it)].find((it) => it.sha === state[0]);
  if (state[0] === null) { const was = l.files.get(p); l.files.delete(p); if (u.del && was) { const dirs = fs.readdirSync(`${DATA}/deleted`).filter((n) => !n.startsWith('.')); const b = dirs.find((n) => { try { return JSON.parse(fs.readFileSync(`${DATA}/deleted/${n}/manifest.json`, 'utf8')).items.some((i) => i.original === p); } catch { return false; } }); if (b) l.batches.push({ b, p, it: was }); else note(`after a kill ${p} is neither in Tresorit nor in the holding area`); } }
  else if (known) { l.files.set(p, known); if (u.restore) l.batches = l.batches.filter((b) => b.p !== p); }
}

const t0 = Date.now(); const until = t0 + MINUTES * 60000; let kills = 0; let nextKill = KILLS ? t0 + 30000 : Infinity; let peak = 0; const memLog = []; let nextMem = t0 + 60000;
const rss = (pid) => { try { return Math.round(Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024); } catch { return 0; } };
const worker = async (c) => { while (Date.now() < until) { if (c.dead) { await sleep(50); continue; } await laneOp(c); if (rnd() < 0.3) await sleep(Math.floor(rnd() * 40)); } };
const side = (async () => {
  while (Date.now() < until) {
    await sleep(500);
    copies.forEach((c) => { peak = Math.max(peak, rss(c.pid)); });
    if (Date.now() > nextMem) { nextMem = Date.now() + 60000; memLog.push(copies.map((c) => rss(c.pid)).join('/')); }
    if (Date.now() > nextKill && Date.now() < until - 20000) {
      nextKill = Date.now() + 25000 + Math.floor(rnd() * 25000); const c = pick(copies);
      await sleep(Math.floor(rnd() * 300)); c.dead = true; try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } kills++;
      await sleep(1500); reconcile(lanes[c.i]);
      const n = await start(c.i); c.client = n.client; c.pid = n.pid; c.call = n.call; c.dead = false;
    }
  }
})();
await Promise.all([...copies.map(worker), side]);

// ---- the reckoning ----
const out = [];
console.error(`[${new Date().toISOString().slice(11, 19)}] work done, settling`);
let settled = false; let lastStatus = '';
for (let i = 0; i < 300; i++) { const s = await Promise.all(copies.map((c) => c.call('connector_status'))); lastStatus = s.map((x) => (x.text.match(/Scanned PDFs:[^\n]*/) || [''])[0] + ' | ' + (x.text.match(/Background reading[^\n]*/) || [''])[0]).join(' // '); if (s.every((x) => /up to date as of/.test(x.text) && /, 0 waiting/.test(x.text))) { settled = true; break; } await sleep(1000); } await sleep(7000);
if (!settled) note(`the background reading and text recognition had not settled 5 minutes after the work stopped: ${lastStatus.slice(0, 500)}`);
console.error(`[${new Date().toISOString().slice(11, 19)}] settled: ${settled}`);
let missing = 0, wrong = 0, extra = 0, total = 0; const strays = [];
for (const l of lanes) { for (const [p, it] of l.files) { total++; const d = diskSha(p); if (d === null) { missing++; note(`MISSING: ${p}`); } else if (d !== it.sha) { wrong++; note(`WRONG BYTES: ${p}`); } }
  const visit = (rel) => { for (const e of fs.readdirSync(T(rel), { withFileTypes: true })) { const q = `${rel}/${e.name}`; if (e.isDirectory()) visit(q); else if (/\.tmp$|^\.|\.partial$/.test(e.name)) strays.push(q); else if (!l.files.has(q)) { extra++; note(`NOT IN THE RECORD: ${q}`); } } }; if (fs.existsSync(T(l.dir))) visit(l.dir); }
out.push(`the three lanes hold ${total} documents: ${missing} missing, ${wrong} not byte for byte right, ${extra} that should not be there; temporary files left in Tresorit: ${strays.length}`); if (strays.length) note(`temporary files: ${strays.slice(0, 3).join(' | ')}`);
const same = picture() === before; out.push(`everything outside the work folder is exactly as before: ${same}`); if (!same) note('SOMETHING OUTSIDE THE WORK FOLDER CHANGED');
// reading each kind back through each copy
const all = lanes.flatMap((l) => [...l.files.entries()]); const kinds = [...new Set(all.map(([, it]) => it.type))]; let readBad = 0, readN = 0; const ocrMiss = [];
for (const k of kinds) { const of = all.filter(([, it]) => it.type === k).sort(() => rnd() - 0.5).slice(0, k === 'picture' ? 30 : 12); for (const [p, it] of of) for (const c of (k === 'picture' ? [copies[0]] : copies)) { const x = await c.call('read_file', { path: p }); readN++;
  if (k === 'locked') { if (!x.err && !everUnlocked.has(it.tok)) { readBad++; note(`at the end a never-opened protected PDF was readable: ${p}`); } }
  else if (k === 'picture') { if (x.err || !x.text.includes(it.tok)) ocrMiss.push(`${p}: ${x.text.slice(-90).replace(/\n/g, ' ')}`); }
  else if (x.err || !x.text.includes(it.tok)) { readBad++; note(`at the end ${p} (${k}) could not be read back through copy ${c.i}: ${x.text.slice(0, 200)}`); } } }
out.push(`read back through the copies: ${readN} reads of ${kinds.length} kinds of document (${kinds.join(', ')}), ${readBad} wrong; pictures saved as .pdf whose number was not recognised: ${ocrMiss.length}${ocrMiss.length ? ` (${ocrMiss[0]})` : ''}`);
// searching: exactly where the record says, the same through each copy
let notFound = 0, ghost = 0, disagree = 0, probes = 0; const searchable = all.filter(([, it]) => it.type !== 'locked' && it.type !== 'picture');
for (let i = 0; i < 60 && searchable.length; i++) { const [, it] = searchable[Math.floor(rnd() * searchable.length)]; const want = all.filter(([, x]) => x.tok === it.tok).map(([p]) => p).sort(); const rs = await Promise.all(copies.map((c) => c.call('search_contents', { query: it.tok, path: W, limit: 50 }))); probes++; const got = rs.map((x) => paths(x.text).sort().join('|'));
  if (new Set(got).size > 1) { disagree++; note(`copies disagree on ${it.tok}: ${got.join(' // ').slice(0, 300)}`); } const g = got[0].split('|').filter(Boolean); if (want.some((p) => !g.includes(p))) { notFound++; note(`at the end search does not find ${it.tok} (${it.type}) at ${want.find((p) => !g.includes(p))}`); } if (g.some((p) => !want.includes(p))) { ghost++; note(`at the end search finds ${it.tok} at ${g.find((p) => !want.includes(p))}, where it is not`); } }
const goneToks = lanes.flatMap((l) => l.batches).filter((b) => !all.some(([, it]) => it.tok === b.it.tok) && b.it.type !== 'locked' && b.it.type !== 'picture'); for (let i = 0; i < 15 && goneToks.length; i++) { const b = goneToks[Math.floor(rnd() * goneToks.length)]; const x = await copies[i % 3].call('search_contents', { query: b.it.tok, path: W }); probes++; if (paths(x.text).length) { ghost++; note(`a deleted document is still found by search: ${b.p}`); } }
out.push(`search: ${probes} searches: ${notFound} document(s) not found where they are, ${ghost} found where they are not, ${disagree} disagreement(s) between copies`);
// what is listed as unreadable: only protected PDFs
const lu = await copies[1].call('list_unreadable', { path: W, limit: 500 }); const listed = [...lu.text.matchAll(/^- \[([^\]]+)\] (.+?) {3}/gm)].map((m) => ({ tag: m[1], p: m[2] })); const badList = listed.filter((x) => !/^wrong ending/.test(x.tag) && (all.find(([p]) => p === x.p) || [0, {}])[1].type !== 'locked');
out.push(`listed as unreadable: ${listed.filter((x) => !/^wrong ending/.test(x.tag)).length}, of which not a protected PDF: ${badList.length}; listed with a wrong ending and read by content: ${listed.filter((x) => /^wrong ending, read/.test(x.tag)).length}`); if (badList.length) note(`listed as unreadable although it is a good document: ${badList.slice(0, 3).map((x) => `[${x.tag}] ${x.p}`).join(' || ')}`);
// identical files across the whole work folder
const fi = await copies[2].call('find_identical', { path: W, limit: 500 }); const groups = fi.text.split(/\n(?=\d+ identical file\(s\))/).slice(1).map((g) => [...g.matchAll(/^- (.+?) {3}\d{4}-/gm)].map((m) => m[1])); const byS = new Map(); for (const [p, it] of all) { if (!byS.has(it.sha)) byS.set(it.sha, []); byS.get(it.sha).push(p); } const expect = [...byS.values()].filter((v) => v.length > 1);
const badGroups = groups.filter((g) => new Set(g.map((p) => (all.find(([q]) => q === p) || [0, {}])[1].sha)).size !== 1).length; out.push(`identical files: ${groups.length} group(s) reported, the record has ${expect.length}; groups mixing different documents: ${badGroups}`); if (badGroups || (groups.length !== expect.length && !/more group/.test(fi.text))) note(`find identical at the end: ${groups.length} vs ${expect.length} expected, ${badGroups} mixed | ${fi.text.slice(0, 200)}`);
// passwords: nowhere in the connector's files; the log
let pwFiles = 0; const scan = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) scan(p); else { try { const b = fs.readFileSync(p); if (b.includes(PW.A) || b.includes(PW.B)) { pwFiles++; note(`A PASSWORD IS IN A FILE OF THE CONNECTOR: ${p}`); } } catch { /* went meanwhile */ } } } }; scan(DATA);
const log = fs.readdirSync(`${DATA}/logs`).map((n) => fs.readFileSync(`${DATA}/logs/${n}`, 'utf8')).join(''); const errors = (log.match(/\| ERROR\s+\|.*/g) || []); const notes = (log.match(/\| NOTE\s+\|.*/g) || []);
out.push(`passwords: found in ${pwFiles} file(s) of the connector, ${replies} replies inspected for a password or for text of a never-opened protected PDF; protected PDFs opened with the right password: ${everUnlocked.size} of ${all.filter(([, it]) => it.type === 'locked').length} still there`);
out.push(`log lines: ${log.split('\n').length}; ERROR lines: ${errors.length}${errors.length ? ` (${errors[0].slice(0, 200)})` : ''}; NOTE lines: ${notes.length}${notes.length ? ` (${notes[0].slice(0, 200)})` : ''}`); if (errors.length) note(`ERROR in the log: ${errors[0].slice(0, 300)}`); if (notes.length) note(`NOTE in the log: ${notes[0].slice(0, 300)}`);
const st = await Promise.all(copies.map((c) => c.call('connector_status')));
out.push(`all three copies answering at the end: ${st.every((x) => /Tresorit connector \d+\.\d+\.\d+/.test(x.text))}; peak memory of one copy: ${peak} MB; lock file left behind: ${fs.existsSync(`${DATA}/change.lock`)}; staging leftovers: ${(() => { try { return fs.readdirSync(`${DATA}/staging`).length; } catch { return 0; } })()}`);
out.push(`${(st[0].text.match(/Unreadable by reason:[^\n]*/) || [''])[0]}`);
if (!KILLS) out.push(`memory of the three copies, each minute (MB): ${memLog.join('  ')}`);
const ops = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`DEEP STRESS RUN (seed ${SEED}): ${MINUTES} minutes, ${Object.values(counts).reduce((a, b) => a + b, 0)} operations (${ops}), ${kills} kills\n- ${out.join('\n- ')}\nANOMALIES: ${anomalies.length}${anomalies.length ? '\n  ' + anomalies.join('\n  ') : ''}`);
await Promise.all(copies.map((c) => c.client.close().catch(() => {})));
fs.rmSync(T(W), { recursive: true, force: true });
process.exit(0);
