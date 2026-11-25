import { Client, StdioClientTransport, MOCK, TESTS, BUNDLE } from './lib/env.mjs';
// 1.4.1: the holding area clears itself (batches older than the number of days in the settings), and only that.
import fs from 'node:fs'; import path from 'node:path';
import { execFile } from 'node:child_process';
const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const BASE = `${MOCK}`; const ROOT = `${BASE}/Tresors`; const W = 'Birch Labs/t16'; const FX = `${BASE}/data-fx14`;
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 900)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
const FAST = { TRESORIT_HOLDING_FIRST_MS: '300', TRESORIT_HOLDING_SWEEP_MS: '300' };
async function start(name, extra = {}, keep = false) {
  const DATA = `${BASE}/data-t16-${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off', ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => { try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 120000 }); return r.content.map((c) => c.text || '').join('\n'); } catch (e) { return `CALL FAILED: ${e.message}`; } };
  const del = async (rel) => { const pv = await call('delete_items', { paths: [rel] }); return call('delete_items', { paths: [rel], confirm_token: (pv.match(/confirm_token "([0-9a-f]+)"/) || [])[1] }); };
  // makes one batch in the holding area and returns its name
  const batch = async (label, files = 1) => {
    if (files === 1) { fs.mkdirSync(T(W), { recursive: true }); fs.writeFileSync(T(`${W}/${label}.txt`), `T16 ${label}`); const r = await del(`${W}/${label}.txt`); return (r.match(/as batch (\S+)/) || [])[1]; }
    fs.mkdirSync(T(`${W}/${label}`), { recursive: true }); for (let i = 0; i < files; i++) fs.writeFileSync(T(`${W}/${label}/f${i}.txt`), `T16 ${label} ${i}`);
    const r = await del(`${W}/${label}`); return (r.match(/as batch (\S+)/) || [])[1];
  };
  return { client, call, del, batch, DATA, HOLD: `${DATA}/deleted`, pid: transport.pid, close: () => client.close() };
}
const backdate = (hold, name, days) => { const f = path.join(hold, name, 'manifest.json'); const m = JSON.parse(fs.readFileSync(f, 'utf8')); const d = new Date(Date.now() - days * 86_400_000); const p2 = (n) => String(n).padStart(2, '0'); m.when = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; fs.writeFileSync(f, JSON.stringify(m)); };
const there = (hold, name) => fs.existsSync(path.join(hold, name, 'manifest.json'));
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(100); } return fn(); };
const logOf = (DATA) => { try { return fs.readdirSync(`${DATA}/logs`).filter((f) => f.startsWith('access-')).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n'); } catch { return ''; } };
const autoLines = (DATA) => logOf(DATA).split('\n').filter((l) => /\| PURGE\s+\| .*removed from the holding area automatically/.test(l));
fs.rmSync(T(W), { recursive: true, force: true });

console.log('A. With nothing set: 30 days');
{
  const s = await start('a', { ...FAST, TRESORIT_HOLDING_DAYS: undefined });
  const old = await s.batch('old'); const edge = await s.batch('edge'); const fresh = await s.batch('fresh');
  await sleep(1200);
  check('fresh batches are left alone by the automatic clearing', there(s.HOLD, old) && there(s.HOLD, edge) && there(s.HOLD, fresh));
  backdate(s.HOLD, old, 31); backdate(s.HOLD, edge, 29);
  const gone = await until(() => !fs.existsSync(path.join(s.HOLD, old)));
  await sleep(900);
  check('a batch 31 days old is removed by itself; one of 29 days and a fresh one stay', gone && there(s.HOLD, edge) && there(s.HOLD, fresh), fs.readdirSync(s.HOLD).join(', '));
  const lines = autoLines(s.DATA);
  check('the removal is written to the access log with what it was, and only that batch', lines.length === 1 && lines[0].includes(`| ${old} |`) && /older than 30 day\(s\) \(made .*deleted; 1 item\(s\).*old\.txt/.test(lines[0]), lines.join('\n') || logOf(s.DATA).slice(-400));
  const st = await s.call('connector_status');
  check('the status report says so, with the last automatic clearing', /Batches older than 30 day\(s\) are removed automatically[^\n]*last automatic clearing \d{4}-\d\d-\d\d[^\n]*: 1 batch\(es\)/.test(st) && /2 batch\(es\)/.test((st.match(/Holding area[^\n]*/) || [''])[0]), (st.match(/Holding area[^\n]*/) || [st])[0]);
  const ld = await s.call('list_deleted');
  check('the list of the holding area says so too', /Batches older than 30 day\(s\) are removed for good automatically/.test(ld), ld.slice(-300));
  const back = await s.call('restore_deleted', { batch: edge });
  check('the 29-day batch can still be restored', /restored/.test(back) && fs.existsSync(T(`${W}/edge.txt`)) && fs.readFileSync(T(`${W}/edge.txt`), 'utf8') === 'T16 edge', back);
  check('nothing is left half-removed in the holding area', !fs.readdirSync(s.HOLD).some((n) => n.startsWith('.removing-')), fs.readdirSync(s.HOLD).join(', '));
  await s.close();
}

console.log('B. Switched off (0 days)');
{
  const s = await start('b', { ...FAST, TRESORIT_HOLDING_DAYS: '0' });
  const old = await s.batch('ancient'); backdate(s.HOLD, old, 400);
  await sleep(2500);
  const st = await s.call('connector_status');
  check('with 0 nothing is removed by itself, however old', there(s.HOLD, old) && autoLines(s.DATA).length === 0);
  check('the status report says that automatic clearing is off and how to clear by hand', /Automatic clearing is off \(settings\); batches older than 30 days can be cleared with tresorit_clear_deleted/.test(st), (st.match(/Holding area[^\n]*/) || [st])[0]);
  const pv = await s.call('clear_deleted', { older_than_days: 30 }); const tk = (pv.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
  check('clearing by hand still previews first and removes nothing', /NOTHING HAS BEEN REMOVED/.test(pv) && there(s.HOLD, old), pv);
  const r = await s.call('clear_deleted', { older_than_days: 30, confirm_token: tk });
  check('and with the code the batch goes, leaving nothing half-removed', /Removed 1 batch/.test(r) && fs.readdirSync(s.HOLD).length === 0, `${r} | ${fs.readdirSync(s.HOLD).join(', ')}`);
  await s.close();
}

console.log('C. Not before the self-check has passed');
{
  let s = await start('c', { TRESORIT_HOLDING_DAYS: '0' });
  const old = await s.batch('gated'); backdate(s.HOLD, old, 90); await s.close();
  s = await start('c', { ...FAST, TRESORIT_PREFLIGHT_GATE: undefined }, true);
  await sleep(2500);
  const st = await s.call('connector_status');
  check('a connector that has not passed its self-check removes nothing', there(s.HOLD, old) && autoLines(s.DATA).length === 0 && /NOT YET PASSED/.test(st), (st.match(/Self-check[^\n]*/) || [st.slice(0, 200)])[0]);
  check('and the status report says the clearing waits for the self-check', /not before the self-check has passed/.test(st), (st.match(/Holding area[^\n]*/) || [st])[0]);
  await s.close();
  s = await start('c', { ...FAST }, true);
  const gone = await until(() => !fs.existsSync(path.join(s.HOLD, old)));
  check('once it may change files, the old batch goes', gone && autoLines(s.DATA).length === 1);
  await s.close();
}

console.log('D. What the setting accepts');
{
  for (const [val, days] of [['${user_config.holding_days}', 30], ['', 30], ['abc', 30], ['-5', 30], ['99999', 3650], ['7', 7]]) {
    const s = await start('d', { TRESORIT_HOLDING_DAYS: val, TRESORIT_HOLDING_FIRST_MS: '600000' });
    const st = await s.call('connector_status');
    check(`setting ${JSON.stringify(val)} means ${days} day(s)`, new RegExp(`Batches older than ${days} day\\(s\\) are removed automatically`).test(st), (st.match(/Holding area[^\n]*/) || [st])[0]);
    await s.close();
  }
  const s = await start('d7', { ...FAST, TRESORIT_HOLDING_DAYS: '7' });
  const a = await s.batch('eight'); const b = await s.batch('six'); backdate(s.HOLD, a, 8); backdate(s.HOLD, b, 6);
  const gone = await until(() => !fs.existsSync(path.join(s.HOLD, a))); await sleep(700);
  check('with 7 days: a batch of 8 days goes, one of 6 days stays', gone && there(s.HOLD, b));
  await s.close();
}

console.log('E. Three copies of the connector at once');
{
  let s = await start('e', { TRESORIT_HOLDING_DAYS: '0' });
  const olds = []; const news = [];
  for (let i = 0; i < 12; i++) olds.push(await s.batch(`o${i}`, 3));
  for (let i = 0; i < 4; i++) news.push(await s.batch(`n${i}`, 3));
  for (const n of olds) backdate(s.HOLD, n, 45);
  await s.close();
  const copies = await Promise.all([start('e', FAST, true), start('e', FAST, true), start('e', FAST, true)]);
  const gone = await until(() => olds.every((n) => !fs.existsSync(path.join(copies[0].HOLD, n))), 10000);
  await sleep(1200);
  const lines = autoLines(copies[0].DATA); const names = lines.map((l) => (l.match(/\| PURGE\s+\| (\S+) \|/) || [])[1]);
  check('all 12 old batches go and the 4 fresh ones stay', gone && news.every((n) => there(copies[0].HOLD, n)), fs.readdirSync(copies[0].HOLD).join(', '));
  check('each batch is removed and logged exactly once, whichever copy did it', lines.length === 12 && new Set(names).size === 12 && olds.every((n) => names.includes(n)), `${lines.length} line(s), ${new Set(names).size} different`);
  check('no errors in the log and nothing half-removed', !/\| ERROR\s+\|/.test(logOf(copies[0].DATA)) && !fs.readdirSync(copies[0].HOLD).some((n) => n.startsWith('.removing-')), (logOf(copies[0].DATA).match(/.*\| ERROR.*/g) || []).slice(0, 3).join('\n'));
  const sts = await Promise.all(copies.map((c) => c.call('connector_status')));
  check('all three copies report the same holding area', new Set(sts.map((x) => (x.match(/Holding area[^\n]*?(\d+ batch\(es\))/) || [])[1])).size === 1 && /4 batch\(es\)/.test(sts[0]), sts.map((x) => (x.match(/Holding area[^\n]*/) || [''])[0].slice(90, 200)).join(' | '));
  for (const c of copies) await c.close();
}

console.log('F. Only batches, only the real holding area');
{
  let s = await start('f', { TRESORIT_HOLDING_DAYS: '0' });
  const real = await s.batch('real'); backdate(s.HOLD, real, 60);
  const longAgo = new Date(Date.now() - 400 * 86_400_000);
  // a folder that looks like an old batch but has no record
  const noRecord = path.join(s.HOLD, '2026-01-01_000000_deleted_abcdef'); fs.mkdirSync(path.join(noRecord, 'files'), { recursive: true }); fs.writeFileSync(path.join(noRecord, 'files', 'keep.txt'), 'KEEP'); fs.utimesSync(noRecord, longAgo, longAgo);
  fs.writeFileSync(path.join(s.HOLD, 'notes.txt'), 'a loose file');
  // a link named like a batch, leading to a Tresorit folder that holds what looks like an old batch record
  fs.mkdirSync(T(`${W}/precious/files`), { recursive: true }); fs.writeFileSync(T(`${W}/precious/files/keep me.txt`), 'PRECIOUS');
  fs.writeFileSync(T(`${W}/precious/manifest.json`), JSON.stringify({ kind: 'deleted', when: '2026-01-01 00:00:00', items: [{ original: 'x', stored: 'files/keep me.txt' }] }));
  fs.symlinkSync(T(`${W}/precious`), path.join(s.HOLD, '2026-01-02_000000_deleted_aaaaaa'));
  await s.close();
  s = await start('f', FAST, true);
  const gone = await until(() => !fs.existsSync(path.join(s.HOLD, real))); await sleep(900);
  check('the real old batch goes', gone);
  check('a folder without a batch record, and a loose file, are left alone', fs.existsSync(path.join(noRecord, 'files', 'keep.txt')) && fs.existsSync(path.join(s.HOLD, 'notes.txt')));
  check('a link that looks like an old batch is not followed: the Tresorit folder behind it is untouched', fs.readFileSync(T(`${W}/precious/files/keep me.txt`), 'utf8') === 'PRECIOUS' && fs.existsSync(T(`${W}/precious/manifest.json`)));
  await s.close();
  // the holding area itself replaced by a link into Tresorit
  s = await start('f2', { TRESORIT_HOLDING_DAYS: '0' }); await s.call('connector_status'); await s.close();
  fs.rmSync(s.HOLD, { recursive: true, force: true });
  fs.mkdirSync(T(`${W}/fakehold/2026-01-03_000000_deleted_bbbbbb/files`), { recursive: true }); fs.writeFileSync(T(`${W}/fakehold/2026-01-03_000000_deleted_bbbbbb/files/doc.txt`), 'IN TRESORIT');
  fs.writeFileSync(T(`${W}/fakehold/2026-01-03_000000_deleted_bbbbbb/manifest.json`), JSON.stringify({ kind: 'deleted', when: '2026-01-03 00:00:00', items: [{ original: 'y', stored: 'files/doc.txt' }] }));
  fs.symlinkSync(T(`${W}/fakehold`), s.HOLD);
  s = await start('f2', FAST, true);
  await sleep(2500);
  check('a holding area that is a link into Tresorit is never cleared: nothing removed, and the refusal is logged', fs.existsSync(T(`${W}/fakehold/2026-01-03_000000_deleted_bbbbbb/files/doc.txt`)) && /\| REFUSED\s+\| holding area \| automatic clearing: the holding area is a link/.test(logOf(s.DATA)) && autoLines(s.DATA).length === 0, logOf(s.DATA).slice(-300));
  await s.close(); fs.rmSync(s.HOLD, { force: true });
}

console.log('G. Restoring at the very moment a batch is cleared');
{
  const s = await start('g', { TRESORIT_HOLDING_FIRST_MS: '100', TRESORIT_HOLDING_SWEEP_MS: '100' });
  let restored = 0, cleared = 0, bad = 0; const notes = [];
  for (let i = 0; i < 14; i++) {
    const name = await s.batch(`race${i}`, 40);
    await sleep(Math.floor(Math.random() * 100));
    backdate(s.HOLD, name, 35);
    await sleep(Math.floor(Math.random() * 60));
    const r = await s.call('restore_deleted', { batch: name });
    await sleep(350);
    const dir = T(`${W}/race${i}`); const n = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    if (/restored/.test(r) && n === 40 && fs.readFileSync(`${dir}/f7.txt`, 'utf8') === `T16 race${i} 7`) restored++;
    else if (n === 0 && !fs.existsSync(path.join(s.HOLD, name)) && /No batch|not found|no longer|Error/i.test(r)) cleared++;
    else { bad++; notes.push(`round ${i}: ${n} file(s) back; ${r.slice(0, 120)}`); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  check(`in 14 rounds a batch was either restored whole (${restored}) or cleared whole (${cleared}), never half`, bad === 0 && restored + cleared === 14, notes.join('\n'));
  await s.close();
}

console.log('H. The connector killed while it is clearing');
{
  let leftovers = 0, halfVisible = 0, rounds = 0; const notes = [];
  for (; rounds < 6; rounds++) {
    let s = await start('h', { TRESORIT_HOLDING_DAYS: '0' });
    const name = await s.batch(`big${rounds}`, 2500); backdate(s.HOLD, name, 50); await s.close();
    s = await start('h', { TRESORIT_HOLDING_FIRST_MS: '150', TRESORIT_HOLDING_SWEEP_MS: '150' }, true);
    await until(() => !fs.existsSync(path.join(s.HOLD, name)), 4000); await sleep(Math.floor(Math.random() * 25));
    try { process.kill(s.pid, 'SIGKILL'); } catch { /* already gone */ }
    await sleep(300);
    // right after the kill: the batch is whole under its own name, or out of sight, or gone; never a visible remainder
    const dir = path.join(s.HOLD, name);
    if (fs.existsSync(dir) && !(fs.existsSync(path.join(dir, 'manifest.json')) && fs.readdirSync(path.join(dir, 'files', W, `big${rounds}`)).length === 2500)) { halfVisible++; notes.push(`round ${rounds}: a visible remainder of ${name}`); }
    s = await start('h', FAST, true);
    await until(() => fs.readdirSync(s.HOLD).length === 0, 8000);
    const left = fs.readdirSync(s.HOLD); if (left.length) { leftovers++; notes.push(`round ${rounds}: left after the next start: ${left.join(', ')}`); }
    await s.close();
  }
  check(`killed ${rounds} times in the middle of clearing a batch of 2,500 files: never a visible half batch, and the next start finishes the job`, halfVisible === 0 && leftovers === 0, notes.join('\n'));
}

console.log('I. The list of unreadable files');
{
  const s = await start('i', { TRESORIT_HOLDING_DAYS: '0' });
  fs.mkdirSync(T(`${W}/unread`), { recursive: true });
  for (let i = 0; i < 3; i++) fs.writeFileSync(T(`${W}/unread/cut ${i}.pdf`), fs.readFileSync(`${FX}/plain.pdf`).subarray(0, 300 + i));
  for (let i = 0; i < 2; i++) fs.copyFileSync(`${FX}/page.html`, T(`${W}/unread/page ${i}.pdf`));
  for (const n of fs.readdirSync(T(`${W}/unread`))) await s.call('read_file', { path: `${W}/unread/${n}` });
  const r = await s.call('list_unreadable', { path: `${W}/unread`, limit: 2 });
  check('the "and N more" line says how many of the rest are unreadable and how many only have a wrong ending', /\.\.\.and 3 more \(1 that could not be read, 2 with a wrong ending that are read by their content\)/.test(r), r.slice(-400));
  await s.close();
}

console.log('J. Deep check (scratch/probe141.mjs)');
{
  const run = (section, ms = 400000) => new Promise((res) => execFile('node', [`${TESTS}/scratch/probe141.mjs`, section], { timeout: ms, maxBuffer: 1 << 24, env: process.env }, (e, out, err) => res(String(out || '') + (e ? `\n[ended: ${e.message.slice(0, 200)}] ${String(err || '').slice(-300)}` : ''))));
  const shipped = run('defaults'); // (takes two minutes: runs beside the others, on its own folders)
  let o = await run('records');
  check('odd, damaged and wrong-clock batch records: none is removed that should stay, the old ones go, nothing outside is touched', /25 that must stay: all still there; 8 old ones that must go: all gone; the Tresorit folder a record pointed at: untouched; connector still answering: true; removals logged: 8 of 8; errors logged: 0/.test(o), o);
  check('batches dated by a wrong clock are named in the status report and can be cleared by hand', /status: 3 batch\(es\) carry a date from before 2025/.test(o) && /cleared by hand \(older than 300 days\): Removed 3 batch\(es\)[^\n]*wrong-clock batches left: 0/.test(o), o);
  o = await run('failhalf');
  check('something in the way of a removal (a leftover folder, a file, a link into Tresorit) does not stop it and harms nothing', /nothing left over: true \(in the holding area now: 1 item\(s\), the fresh batch intact\); the Tresorit folder behind the link: untouched; errors logged: 0/.test(o), o);
  o = await run('manual');
  check('clearing by hand with a preview that the automatic clearing has overtaken is refused, and a new preview works', /outdated preview: \[Error: The batches no longer match[^\]]*\]; the fresh batch was not removed by it; a new preview and confirmation: \[Removed 1 batch/.test(o), o);
  o = await run('tz');
  check('a change of time zone never makes a fresh or a 28-day batch go (36 combinations of six zones)', /\(36 combinations\): removed too early 0 time\(s\)\./.test(o), o);
  o = await run('scale');
  const slow = Number((o.match(/the slowest took (\d+) ms/) || [0, 99999])[1]);
  check('2,401 old batches (one of 20,000 files) are cleared, 600 fresh ones stay, each removal is logged, and saving files meanwhile never waits long', /fresh batches left: 600 of 600; removals logged: 2401 of 2401; meanwhile \d+ files were saved through two copies: 0 failed/.test(o) && slow < 5000, o);
  o = await run('guards');
  check('nothing in the environment can shorten a "day", and a setting between 0 and 1 counts as one whole day', /a fresh and a 2-day batch stay with TRESORIT_HOLDING_DAY_MS=1\): true/.test(o) && (o.match(/: 1 day, 5-hour batch kept, 29-hour batch removed/g) || []).length === 4, o);
  check('the log line of a batch with a garbage record stays short and says the folder\'s date was used', /log line of a batch with a garbage record: \d{2,3} characters, says the folder's date was used: true/.test(o), o);
  o = await run('freeze');
  const slowF = Number((o.match(/saves meanwhile: 0 failed, slowest (\d+) ms/) || [0, 999999])[1]);
  check('a copy frozen and woken again and again while clearing 1,500 batches: nothing is cleared while it is frozen, everything in the end, each removal logged once, the other copy keeps saving', /while it was frozen nothing was cleared: true, and the other copy saved \d+ files \(0 failed/.test(o) && /all cleared in the end: true, removals logged 1500 of 1500/.test(o) && slowF < 20000, o);
  o = await shipped;
  const at = Number((o.match(/removed: true, (\d+) s after the start/) || [0, 0])[1]);
  check('exactly as shipped, with no test shortcuts: the first look comes between 90 and 150 seconds after the start and removes the old batch', at >= 88 && at <= 160 && /the fresh one is still there: true; logged: true/.test(o), o);
}

fs.rmSync(T(W), { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
