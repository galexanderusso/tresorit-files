import { Client, StdioClientTransport, MOCK, BUNDLE } from '../lib/env.mjs';
// Deep check of 1.4.1: the holding area that clears itself. Everything here is about the one thing the connector
// now removes for good without being asked.
import fs from 'node:fs'; import path from 'node:path';
const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const BASE = `${MOCK}`; const ROOT = `${BASE}/Tresors`;
const which = process.argv[2] || 'all'; const W = `Birch Labs/p141-${which}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
const FAST = { TRESORIT_HOLDING_FIRST_MS: '300', TRESORIT_HOLDING_SWEEP_MS: '300' };
async function start(name, extra = {}, keep = false) {
  const DATA = `${BASE}/data-p141-${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off', ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => { const t = Date.now(); let text; try { text = (await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n'); } catch (e) { text = `CALL FAILED: ${e.message}`; } call.last = Date.now() - t; return text; };
  const del = async (rel) => { const pv = await call('delete_items', { paths: [rel] }); return call('delete_items', { paths: [rel], confirm_token: (pv.match(/confirm_token "([0-9a-f]+)"/) || [])[1] }); };
  const batch = async (label) => { fs.mkdirSync(T(W), { recursive: true }); fs.writeFileSync(T(`${W}/${label}.txt`), `P141 ${label}`); const r = await del(`${W}/${label}.txt`); return (r.match(/as batch (\S+)/) || [])[1]; };
  await call('connector_status');
  return { client, call, del, batch, DATA, HOLD: `${DATA}/deleted`, pid: transport.pid, close: () => client.close() };
}
const stampOf = (d) => { const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const daysAgo = (n) => stampOf(new Date(Date.now() - n * 86_400_000));
const backdate = (hold, name, days) => { const f = path.join(hold, name, 'manifest.json'); const m = JSON.parse(fs.readFileSync(f, 'utf8')); m.when = daysAgo(days); fs.writeFileSync(f, JSON.stringify(m)); };
// a batch made by hand: record is any JSON-able value or a raw string
let seq = 0;
const handMade = (hold, record, { raw = false, files = 1, dirDaysOld = 0, label = '' } = {}) => {
  const name = `2026-06-${String(1 + (seq % 28)).padStart(2, '0')}_1${String(seq++).padStart(5, '0')}_deleted_${label || 'x'}`; const d = path.join(hold, name);
  fs.mkdirSync(path.join(d, 'files', 'Birch Labs'), { recursive: true });
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(d, 'files', 'Birch Labs', `kept ${i}.txt`), 'HELD');
  fs.writeFileSync(path.join(d, 'manifest.json'), raw ? record : JSON.stringify(record));
  if (dirDaysOld) { const t = new Date(Date.now() - dirDaysOld * 86_400_000); fs.utimesSync(d, t, t); }
  return name;
};
const rec = (when, extra = {}) => ({ kind: 'deleted', when, items: [{ original: 'Birch Labs/kept 0.txt', stored: 'files/Birch Labs/kept 0.txt', type: 'file' }], ...extra });
const logOf = (DATA) => { try { return fs.readdirSync(`${DATA}/logs`).filter((f) => f.startsWith('access-')).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n'); } catch { return ''; } };
const auto = (DATA) => logOf(DATA).split('\n').filter((l) => /\| PURGE\s+\| .*removed from the holding area automatically/.test(l));
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(100); } return fn(); };
fs.rmSync(T(W), { recursive: true, force: true });

if (which === 'defaults') {
  // exactly as shipped: no test shortcuts for the timing
  const s = await start('defaults', { TRESORIT_HOLDING_DAYS: undefined, TRESORIT_HOLDING_FIRST_MS: undefined, TRESORIT_HOLDING_SWEEP_MS: undefined });
  const t0 = Date.now(); const old = await s.batch('old'); const fresh = await s.batch('fresh'); backdate(s.HOLD, old, 31);
  const gone = await until(() => !fs.existsSync(path.join(s.HOLD, old)), 175000); const at = Math.round((Date.now() - t0) / 1000);
  console.log(`AS SHIPPED (no test shortcuts): the 31-day batch was removed: ${gone}, ${at} s after the start (expected between 90 and 150); the fresh one is still there: ${fs.existsSync(path.join(s.HOLD, fresh, 'manifest.json'))}; logged: ${auto(s.DATA).length === 1}`);
  await s.close();
}

if (which === 'records') {
  let s = await start('records', { TRESORIT_HOLDING_DAYS: '0' }); await s.close(); const H = s.HOLD; fs.mkdirSync(H, { recursive: true });
  const keep = {}; const go = {};
  // dates that are not in the connector's own form: never taken at their word (the folder is fresh, so they stay)
  for (const [label, when] of [['missing', undefined], ['empty', ''], ['x', 'x'], ['year-only', '2026'], ['digit', '2'], ['date-only', '2026-01-05'], ['T-form', '2026-01-05T10:00:00'], ['number', 20260105], ['null', null], ['object', {}], ['long', '2026-01-05 10:00:00'.repeat(5000)], ['slashes', '01/05/2026 10:00:00']]) keep[`odd date: ${label}`] = handMade(H, rec(when));
  keep['a date in the future'] = handMade(H, rec('2031-01-01 00:00:00'));
  for (const w of ['1970-01-01 00:00:00', '2001-01-01 00:00:00', '2024-12-31 23:59:59']) keep[`wrong-clock date ${w}`] = handMade(H, rec(w));
  keep['29 days'] = handMade(H, rec(daysAgo(29)));
  for (const [label, raw] of [['null', 'null'], ['a list', '[]'], ['a string', '"hello"'], ['a number', '42'], ['cut off', '{"kind":"deleted","when":"2026-01-01 00:00:00","items":[{"orig'], ['items not a list', JSON.stringify({ kind: 'deleted', when: '2026-01-01 00:00:00', items: 'x' })], ['empty file', '']]) keep[`record that is ${label}`] = handMade(H, raw, { raw: true, dirDaysOld: 90 });
  const victim = handMade(H, rec(daysAgo(1)), { label: 'victim' }); keep['a fresh batch that another record points at'] = victim;
  fs.mkdirSync(T(`${W}/precious`), { recursive: true }); fs.writeFileSync(T(`${W}/precious/keep me.txt`), 'PRECIOUS');
  // old and plausible: these go
  go['31 days'] = handMade(H, rec(daysAgo(31)));
  go['just after the clock floor (2025-01-01 00:00:01)'] = handMade(H, rec('2025-01-01 00:00:01'));
  go['no date, folder 60 days old'] = handMade(H, rec(undefined), { dirDaysOld: 60 });
  go['no items, old'] = handMade(H, { kind: 'deleted', when: daysAgo(40), items: [] });
  go['a record of 4 MB, old'] = handMade(H, rec(daysAgo(40), { junk: 'j'.repeat(4_000_000) }));
  go['a record that names another batch as its place'] = handMade(H, rec(daysAgo(40), { name: victim, dir: path.join(H, victim) }));
  go['a record that names a Tresorit folder as its place'] = handMade(H, rec(daysAgo(40), { name: 'precious', dir: T(`${W}/precious`) }));
  go['odd kind and item fields'] = handMade(H, { kind: { a: 1 }, when: daysAgo(40), items: [null, 5, { original: { x: 1 } }] });
  s = await start('records', FAST, true);
  await until(() => Object.values(go).every((n) => !fs.existsSync(path.join(H, n))), 8000); await sleep(1200);
  const wrongKept = Object.entries(keep).filter(([, n]) => !fs.existsSync(path.join(H, n, 'files', 'Birch Labs', 'kept 0.txt'))).map(([k]) => k);
  const wrongGone = Object.entries(go).filter(([, n]) => fs.existsSync(path.join(H, n))).map(([k]) => k);
  const st = await s.call('connector_status'); const ld = await s.call('list_deleted');
  console.log(`ODD AND DAMAGED BATCH RECORDS: ${Object.keys(keep).length} that must stay: ${wrongKept.length ? 'REMOVED: ' + wrongKept.join('; ') : 'all still there'}; ${Object.keys(go).length} old ones that must go: ${wrongGone.length ? 'STILL THERE: ' + wrongGone.join('; ') : 'all gone'}; the Tresorit folder a record pointed at: ${fs.existsSync(T(`${W}/precious/keep me.txt`)) ? 'untouched' : 'DAMAGED'}; connector still answering: ${/Tresorit connector/.test(st)}; removals logged: ${auto(s.DATA).length} of ${Object.keys(go).length}; errors logged: ${(logOf(s.DATA).match(/\| ERROR\s+\|/g) || []).length}`);
  console.log(`  status: ${(st.match(/\d+ batch\(es\) carry a date from before 2025[^\n.]*/) || ['(no wrong-clock note)'])[0]}; list of the holding area still works: ${/batch/.test(ld)}`);
  // by hand the wrong-clock ones can still be cleared
  const pv = await s.call('clear_deleted', { older_than_days: 300 }); const tk = (pv.match(/confirm_token "([0-9a-f]+)"/) || [])[1]; const r = tk ? await s.call('clear_deleted', { older_than_days: 300, confirm_token: tk }) : pv;
  console.log(`  cleared by hand (older than 300 days): ${r.split('\n')[0].slice(0, 110)}; wrong-clock batches left: ${Object.entries(keep).filter(([k, n]) => k.startsWith('wrong-clock') && fs.existsSync(path.join(H, n))).length}`);
  await s.close();
}

if (which === 'tz') {
  const zones = ['Europe/London', 'America/Sao_Paulo', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Niue']; let wrongly = 0, n = 0; const notes = [];
  for (const made of zones) {
    let s = await start('tz', { TRESORIT_HOLDING_DAYS: '0', TZ: made }); const fresh = await s.batch(`fresh-${n}`); const near = await s.batch(`near-${n}`); await s.close();
    // "near": 28 days old as written in the zone it was made in
    const f = path.join(s.HOLD, near, 'manifest.json'); const m = JSON.parse(fs.readFileSync(f, 'utf8')); const d = new Date(Date.now() - 28 * 86_400_000);
    m.when = new Intl.DateTimeFormat('sv-SE', { timeZone: made, dateStyle: 'short', timeStyle: 'medium' }).format(d); fs.writeFileSync(f, JSON.stringify(m));
    for (const read of zones) {
      s = await start('tz', { ...FAST, TZ: read }, true); await sleep(1500);
      if (!fs.existsSync(path.join(s.HOLD, fresh)) || !fs.existsSync(path.join(s.HOLD, near))) { wrongly++; notes.push(`made in ${made}, read in ${read}`); }
      await s.close(); n++;
    }
  }
  console.log(`TIME ZONES: a fresh batch and one 28 days old, made in each of ${zones.length} zones and then looked at from each of them (${n} combinations): removed too early ${wrongly} time(s)${notes.length ? ': ' + notes.join('; ') : ''}. (Dates are local time, so a batch can go early or late by at most the difference between two zones: 3 hours between London and São Paulo.)`);
}

if (which === 'scale') {
  let s = await start('scale', { TRESORIT_HOLDING_DAYS: '0' }); await s.close(); const H = s.HOLD; fs.mkdirSync(H, { recursive: true });
  const N = 3000; const olds = []; const news = [];
  for (let i = 0; i < N; i++) (i % 5 ? olds : news).push(handMade(H, rec(daysAgo(i % 5 ? 45 : 3)), { files: 2 }));
  const big = handMade(H, rec(daysAgo(45)), { files: 20000, label: 'big' });
  const b = await start('scale', { TRESORIT_HOLDING_FIRST_MS: '600000' }, true); const t0 = Date.now(); const aP = start('scale', { TRESORIT_HOLDING_FIRST_MS: '2500', TRESORIT_HOLDING_SWEEP_MS: '2500' }, true); let a = b; aP.then((x) => { a = x; });
  let worst = 0, calls = 0, failed = 0; let goneAt = 0; let visibleGoneAt = 0; fs.mkdirSync(T(W), { recursive: true });
  while (Date.now() - t0 < 120000) {
    const c = calls % 2 ? a : b; const r = await c.call('write_file', { path: `${W}/while clearing ${calls}.txt`, content: 'x' }); calls++;
    if (!/Saved|Created|Wrote/.test(r)) failed++; worst = Math.max(worst, c.call.last);
    const left = fs.readdirSync(H);
    if (!visibleGoneAt && !left.some((n) => !n.startsWith('.') && (olds.includes(n) || n === big))) visibleGoneAt = Date.now() - t0;
    if (visibleGoneAt && !left.some((n) => n.startsWith('.removing-'))) { goneAt = Date.now() - t0; break; }
    await sleep(100);
  }
  a = await aP; const st = await a.call('connector_status'); const stMs = a.call.last;
  const freshLeft = news.filter((n) => fs.existsSync(path.join(H, n, 'manifest.json'))).length;
  console.log(`A LARGE HOLDING AREA (${N} batches of which ${olds.length} old, plus one old batch of 20,000 files): old batches out of the list after ${(visibleGoneAt / 1000).toFixed(1)} s, their files fully deleted after ${(goneAt / 1000).toFixed(1)} s; fresh batches left: ${freshLeft} of ${news.length}; removals logged: ${auto(a.DATA).length} of ${olds.length + 1}; meanwhile ${calls} files were saved through two copies: ${failed} failed, the slowest took ${worst} ms; status afterwards in ${stMs} ms: ${(st.match(/Holding area[^\n]*?(\d+ batch\(es\)[^.]*)/) || ['', '?'])[1]}`);
  await a.close(); await b.close();
}

if (which === 'failhalf') {
  let s = await start('failhalf', { TRESORIT_HOLDING_DAYS: '0' }); await s.close(); const H = s.HOLD; fs.mkdirSync(H, { recursive: true });
  const b1 = handMade(H, rec(daysAgo(40))); const b2 = handMade(H, rec(daysAgo(40))); const b3 = handMade(H, rec(daysAgo(40))); const fresh = handMade(H, rec(daysAgo(2)));
  // something is in the way of each removal: a folder with content, a plain file, a link into Tresorit
  fs.mkdirSync(path.join(H, `.removing-${b1}`, 'left'), { recursive: true }); fs.writeFileSync(path.join(H, `.removing-${b1}`, 'left', 'old.txt'), 'x');
  fs.writeFileSync(path.join(H, `.removing-${b2}`), 'a file in the way');
  fs.mkdirSync(T(`${W}/precious`), { recursive: true }); fs.writeFileSync(T(`${W}/precious/keep me.txt`), 'PRECIOUS'); fs.symlinkSync(T(`${W}/precious`), path.join(H, `.removing-${b3}`));
  s = await start('failhalf', FAST, true);
  const clean = await until(() => fs.readdirSync(H).length === 1, 8000);
  console.log(`SOMETHING IN THE WAY OF A REMOVAL (a leftover folder, a file, a link into Tresorit): all three old batches removed and nothing left over: ${clean} (in the holding area now: ${fs.readdirSync(H).length} item(s), the fresh batch ${fs.existsSync(path.join(H, fresh, 'manifest.json')) ? 'intact' : 'GONE'}); the Tresorit folder behind the link: ${fs.existsSync(T(`${W}/precious/keep me.txt`)) ? 'untouched' : 'DAMAGED'}; errors logged: ${(logOf(s.DATA).match(/\| ERROR\s+\|/g) || []).length}`);
  await s.close();
}

if (which === 'manual') {
  const s = await start('manual', { TRESORIT_HOLDING_FIRST_MS: '2500', TRESORIT_HOLDING_SWEEP_MS: '2500' });
  const old = await s.batch('old'); const fresh = await s.batch('fresh'); backdate(s.HOLD, old, 40);
  const pv = await s.call('clear_deleted', { older_than_days: 0 }); const tk = (pv.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
  await until(() => !fs.existsSync(path.join(s.HOLD, old)), 6000);
  const r = await s.call('clear_deleted', { older_than_days: 0, confirm_token: tk });
  const freshStill = fs.existsSync(path.join(s.HOLD, fresh, 'manifest.json'));
  const pv2 = await s.call('clear_deleted', { older_than_days: 0 }); const tk2 = (pv2.match(/confirm_token "([0-9a-f]+)"/) || [])[1]; const r2 = await s.call('clear_deleted', { older_than_days: 0, confirm_token: tk2 });
  console.log(`CLEARING BY HAND WHILE THE AUTOMATIC CLEARING TAKES ONE OF THE PREVIEWED BATCHES: the confirmation of the outdated preview: [${r.split('\n')[0].slice(0, 120)}]; the fresh batch was ${freshStill ? 'not removed by it' : 'removed by it'}; a new preview and confirmation: [${r2.split('\n')[0].slice(0, 80)}]; holding area now: ${fs.readdirSync(s.HOLD).length} item(s)`);
  await s.close();
}
if (which === 'guards') {
  // 1. nothing in the environment can shorten a day
  let s = await start('guards', { ...FAST, TRESORIT_HOLDING_DAY_MS: '1' });
  const fresh = await s.batch('fresh'); const twoDays = await s.batch('twodays'); backdate(s.HOLD, twoDays, 2); await sleep(2500);
  const dayHook = fs.existsSync(path.join(s.HOLD, fresh)) && fs.existsSync(path.join(s.HOLD, twoDays)); await s.close();
  // 2. a fraction of a day counts as one whole day
  const out = [];
  for (const v of ['0.001', '0.3', '0,5', '1e-9']) {
    s = await start('guards', { ...FAST, TRESORIT_HOLDING_DAYS: v });
    const b = await s.batch(`h${out.length}`); const m = JSON.parse(fs.readFileSync(path.join(s.HOLD, b, 'manifest.json'), 'utf8')); m.when = stampOf(new Date(Date.now() - 5 * 3_600_000)); fs.writeFileSync(path.join(s.HOLD, b, 'manifest.json'), JSON.stringify(m));
    const old = await s.batch(`o${out.length}`); backdate(s.HOLD, old, 1.2);
    await until(() => !fs.existsSync(path.join(s.HOLD, old)), 5000); await sleep(600);
    const st = await s.call('connector_status');
    out.push(`${v}: ${/Batches older than 1 day\(s\) are removed automatically/.test(st) ? '1 day' : 'OTHER'}, 5-hour batch ${fs.existsSync(path.join(s.HOLD, b)) ? 'kept' : 'REMOVED'}, 29-hour batch ${fs.existsSync(path.join(s.HOLD, old)) ? 'STILL THERE' : 'removed'}`);
    await s.close();
  }
  // 3. the log line of a batch judged by its folder's date
  s = await start('guards2', { TRESORIT_HOLDING_DAYS: '0' }); await s.close(); fs.mkdirSync(s.HOLD, { recursive: true });
  handMade(s.HOLD, { kind: 'k'.repeat(5000), when: 'garbage '.repeat(2000), items: [{ original: 'x'.repeat(100000) }] }, { dirDaysOld: 50 });
  s = await start('guards2', FAST, true); await until(() => auto(s.DATA).length === 1, 5000);
  const line = auto(s.DATA)[0] || ''; await s.close();
  console.log(`GUARDS: a "day" cannot be shortened from outside (a fresh and a 2-day batch stay with TRESORIT_HOLDING_DAY_MS=1): ${dayHook}; fractions of a day: ${out.join(' | ')}; log line of a batch with a garbage record: ${line.length} characters, says the folder's date was used: ${/no usable date in its record, folder dated \d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(line)}`);
}

if (which === 'freeze') {
  // a copy of the connector frozen for a while (as when the Mac sleeps) and then woken
  let s = await start('freeze', { TRESORIT_HOLDING_DAYS: '0' }); await s.close(); const H = s.HOLD; fs.mkdirSync(H, { recursive: true });
  const a = await start('freeze', FAST, true); const b = await start('freeze', { TRESORIT_HOLDING_FIRST_MS: '600000' }, true);
  await sleep(800); process.kill(a.pid, 'SIGSTOP');
  const olds = []; for (let i = 0; i < 1500; i++) olds.push(handMade(H, rec(daysAgo(40)), { files: 2 })); const fresh = handMade(H, rec(daysAgo(1)));
  let worst = 0, failed = 0, n = 0; fs.mkdirSync(T(W), { recursive: true });
  const t0 = Date.now(); while (Date.now() - t0 < 12000) { const r = await b.call('write_file', { path: `${W}/during freeze ${n++}.txt`, content: 'x' }); if (!/Saved|Created|Wrote/.test(r)) failed++; worst = Math.max(worst, b.call.last); await sleep(200); }
  const untouched = olds.every((x) => fs.existsSync(path.join(H, x)));
  process.kill(a.pid, 'SIGCONT');
  // freeze it again at random moments while it clears, and wake it; the other copy keeps saving files
  let worst2 = 0, failed2 = 0; let stops = 0; const t1 = Date.now(); let saving = true;
  const saver = (async () => { while (saving) { const t = Date.now(); const r = await b.call('write_file', { path: `${W}/during clearing ${n++}.txt`, content: 'x' }); if (!/Saved|Created|Wrote/.test(r)) failed2++; worst2 = Math.max(worst2, Date.now() - t); await sleep(50); } })();
  while (Date.now() - t1 < 60000 && fs.readdirSync(H).length > 1) {
    await sleep(40 + Math.floor(Math.random() * 300)); process.kill(a.pid, 'SIGSTOP'); stops++;
    await sleep(400); process.kill(a.pid, 'SIGCONT'); // (frozen for 0.4 s each time, wherever it happened to be)
  }
  saving = false; await saver;
  await until(() => fs.readdirSync(H).length === 1, 20000);
  const left = fs.readdirSync(H);
  console.log(`A COPY FROZEN AND WOKEN (as when the Mac sleeps): while it was frozen nothing was cleared: ${untouched}, and the other copy saved ${n} files (${failed} failed, slowest ${worst} ms); frozen ${stops} more time(s) at random moments while it was clearing 1,500 batches: all cleared in the end: ${left.length === 1 && left[0] === fresh}, removals logged ${auto(a.DATA).length} of 1500, the other copy's saves meanwhile: ${failed2} failed, slowest ${worst2} ms`);
  await a.close(); await b.close();
}
fs.rmSync(T(W), { recursive: true, force: true });
