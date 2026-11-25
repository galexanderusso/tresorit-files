import { Client, StdioClientTransport, MOCK, TESTS, BUNDLE } from './lib/env.mjs';
// Several copies of the connector sharing one search index: only one does the background reading, the others
// use what it builds; takeover when it stops; a rebuild asked of another copy; the battery allowance counted once.
import fs from 'node:fs';
import path from 'node:path';

const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const LIB = path.join(path.dirname(SERVER), 'lib');
const BASE = `${MOCK}`;
const ROOT = `${BASE}/Tresors`;
const W = 'Birch Labs/shared-index';
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 900)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (rel) => `${ROOT}/${rel}`;

async function start(DATA, extraEnv = {}) {
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: `${BASE}/data-si-home`, TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '150', TRESORIT_INDEX_INTERVAL_MS: '1500',
    TRESORIT_BG_TAKEOVER_MS: '800', TRESORIT_BG_HOUSEKEEP_MS: '400', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off', ...extraEnv };
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError }; } catch (e) { return { text: `call failed: ${e.message}`, isError: true }; }
  };
  return { client, call, pid: transport.pid, DATA };
}
const logOf = (DATA) => { try { return fs.readdirSync(`${DATA}/logs`).filter((f) => f.startsWith('access')).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n'); } catch { return ''; } };
const countLines = (text, re) => text.split('\n').filter((l) => re.test(l)).length;
const indexLine = (st) => (st.match(/Search index: .*/) || [''])[0];
const handled = (st) => { const m = st.match(/Search index: (\d+) document\(s\) readable \([^)]*\), (\d+) with no text, (\d+) unreadable/) || []; return Number(m[1]) + Number(m[2]) + Number(m[3]); };
const settleAll = async (copies, re, tries = 240) => { let sts = []; for (let i = 0; i < tries; i++) { await sleep(250); sts = await Promise.all(copies.map(async (c) => (await c.call('connector_status')).text)); if (sts.every((s) => re.test(s))) break; } return sts; };
// What the worker's log says about reading: one line per pass that read something. A rebuild that arrives while a
// pass is under way is finished in two passes (the documents that pass had not yet looked at, then the others),
// so the checks count documents, not lines.
const readLines = (text) => text.split('\n').map((l) => Number((l.match(/(\d+) document\(s\) read into the search index/) || [])[1])).filter((n) => n > 0);
const readTotal = (text) => readLines(text).reduce((a, b) => a + b, 0);
const inCatalog = (DATA) => { try { return Object.keys(JSON.parse(fs.readFileSync(`${DATA}/index/catalog.json`, 'utf8')).entries).length; } catch { return -1; } };
const workerPid = (DATA) => { try { return JSON.parse(fs.readFileSync(`${DATA}/index/background.lock`, 'utf8')).pid; } catch { return null; } };

fs.rmSync(T(W), { recursive: true, force: true }); fs.mkdirSync(T(W), { recursive: true });
fs.mkdirSync(`${BASE}/data-si-home/Downloads`, { recursive: true });

console.log('A. The index catalog when two copies write to it');
{
  const { TextIndex } = await import(path.join(LIB, 'textindex.js'));
  const dir = `${BASE}/data-si-unit/index`; fs.rmSync(`${BASE}/data-si-unit`, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const st = (n) => ({ size: n, mtimeMs: 1000 + n });
  const a = new TextIndex(dir); const b = new TextIndex(dir);
  await a.put('x/one.txt', st(1), { status: 'ok', text: 'one' }); await b.put('x/two.txt', st(2), { status: 'ok', text: 'two' });
  a.save(); b.save();
  const disk = () => Object.keys(JSON.parse(fs.readFileSync(`${dir}/catalog.json`, 'utf8')).entries).sort().join(',');
  check('two copies each add a document and save: the catalog holds both', disk() === 'x/one.txt,x/two.txt', disk());
  a.refresh(true);
  check('a copy picks up what the other added', Boolean(a.fresh('x/two.txt', st(2))) && Boolean(b.fresh('x/one.txt', st(1))));
  b.remove('x/one.txt'); await a.put('x/three.txt', st(3), { status: 'ok', text: 'three' }); b.save(); a.save();
  check('a removal by one copy and an addition by the other both survive', disk() === 'x/three.txt,x/two.txt' && !a.fresh('x/one.txt', st(1)), disk());
  // many saves from both sides, interleaved
  for (let i = 0; i < 200; i++) { await (i % 2 ? a : b).put(`many/${i}.txt`, st(10 + i), { status: 'ok', text: `t${i}` }); if (i % 7 === 0) a.save(); if (i % 5 === 0) b.save(); }
  a.save(); b.save(); a.refresh(true); b.refresh(true);
  const all = Array.from({ length: 200 }, (_, i) => `many/${i}.txt`);
  check('200 additions from two copies with interleaved saves: none is lost, in the catalog or in either copy', all.every((k) => disk().includes(k)) && all.every((k) => a.map.has(k) && b.map.has(k)), `${disk().split(',').length} on disk, ${a.map.size} / ${b.map.size} in memory`);
  await b.clear(); a.refresh(true);
  check('clearing the index from one copy empties it for the other too', disk() === '' && a.map.size === 0, `${disk()} | ${a.map.size}`);
  await a.put('after/clear.txt', st(5), { status: 'ok', text: 'again' }); a.save(); b.refresh(true);
  check('...and it fills again normally afterwards', disk() === 'after/clear.txt' && b.map.has('after/clear.txt'));
  check('no lock file is left behind by saving', !fs.existsSync(`${dir}/catalog.json.lock`));
}

console.log('B. Three copies started at the same moment');
const DATA = `${BASE}/data-si-three`; fs.rmSync(DATA, { recursive: true, force: true });
let copies = await Promise.all([0, 1, 2].map(() => start(DATA, { TRESORIT_OCR: 'true', TRESORIT_OCR_ENGINE: 'bundled' })));
{
  let sts = await settleAll(copies, /up to date as of/, 600);
  // text recognition is done too when no scanned PDF is waiting any more
  for (let i = 0; i < 400 && !sts.every((s) => /Scanned PDFs: \d+ read by text recognition, 0 waiting/.test(s)); i++) { await sleep(500); sts = await Promise.all(copies.map(async (c) => (await c.call('connector_status')).text)); }
  const log = logOf(DATA);
  const passes = log.split('\n').filter((l) => /document\(s\) read into the search index/.test(l));
  const firstBig = passes.filter((l) => Number((l.match(/(\d+) document\(s\) read/) || [])[1]) > 10);
  check('the library is read into the index once, not once per copy', firstBig.length === 1 && countLines(log, /this copy of the connector does the background reading/) === 1, passes.join(' | '));
  const ocrLines = log.split('\n').filter((l) => /\| OCR /.test(l)).map((l) => l.split('|')[2].trim());
  check('each scanned PDF goes through text recognition once', ocrLines.length > 0 && new Set(ocrLines).size === ocrLines.length, `${ocrLines.length} line(s), ${new Set(ocrLines).size} file(s)`);
  check('all three copies report the same index and that it is up to date', new Set(sts.map(indexLine)).size === 1 && handled(sts[0]) > 20 && sts.every((s) => /Background reading: up to date as of/.test(s)), sts.map((s) => `${indexLine(s)} / ${(s.match(/Background reading: .*/) || [''])[0]}`).join(' || '));
  const wp = workerPid(DATA);
  check('exactly one copy is the worker, and it is one of the three', copies.filter((c) => c.pid === wp).length === 1, `worker ${wp}; copies ${copies.map((c) => c.pid).join(', ')}`);
}

console.log('C. Additions reach every copy');
{
  const wp = workerPid(DATA); const followers = copies.filter((c) => c.pid !== wp); const worker = copies.find((c) => c.pid === wp);
  // a file saved through a copy that is not the worker
  await followers[0].call('write_file', { path: `${W}/saved by a follower.txt`, content: 'follower-marker-551 in a new file' });
  // a file that simply appears on disk (synced in by Tresorit)
  fs.writeFileSync(T(`${W}/synced in.txt`), 'synced-marker-552 arrived by sync');
  let ok = false; let infos = [];
  for (let i = 0; i < 80 && !ok; i++) {
    await sleep(250);
    infos = await Promise.all(copies.flatMap((c) => [c.call('file_info', { path: `${W}/saved by a follower.txt` }), c.call('file_info', { path: `${W}/synced in.txt` })]));
    ok = infos.every((r) => /Text search: searchable/.test(r.text));
  }
  check('new files are read by the worker and show as searchable from every copy', ok, infos.map((r) => r.text.split('\n').pop()).join(' | '));
  // a search through a follower finds a brand-new file at once (read directly), and that work is not thrown away
  fs.writeFileSync(T(`${W}/found at once.txt`), 'instant-marker-553');
  const sr = await followers[1].call('search_contents', { query: 'instant-marker-553', path: W });
  check('a search through a copy that is not the worker finds a brand-new file straight away', sr.text.includes('found at once.txt'), sr.text.slice(0, 200));
  const sts = await settleAll(copies, /up to date as of/);
  await sleep(6500); // long enough for every copy to have saved and picked up the others' additions
  const again = await Promise.all(copies.map(async (c) => (await c.call('connector_status')).text));
  check('afterwards all copies agree again', new Set(again.map(indexLine)).size === 1, again.map(indexLine).join(' || '));
  check('still only one copy does the background reading', countLines(logOf(DATA), /this copy of the connector does the background reading/) === 1 && workerPid(DATA) === worker.pid && sts.length === 3);
}

console.log('D. A rebuild asked of a copy that is not the worker');
{
  const wp = workerPid(DATA); const follower = copies.find((c) => c.pid !== wp);
  const full = handled((await follower.call('connector_status')).text); const entriesBefore = inCatalog(DATA);
  const linesBefore = readLines(logOf(DATA)).length; const readBefore = readTotal(logOf(DATA));
  const r = await follower.call('connector_status', { rebuild_index: true });
  let sawEmpty = handled(r.text) < 10; let sts = [];
  // Finished when every copy is back at the full count it had before. (Waiting only for "more than 20" could stop
  // between the two passes of a rebuild that arrived while a pass was under way.)
  for (let i = 0; i < 600; i++) { await sleep(200); sts = await Promise.all(copies.map(async (c) => (await c.call('connector_status')).text)); if (sts.some((s) => handled(s) < 10)) sawEmpty = true; if (sawEmpty && sts.every((s) => /up to date as of/.test(s) && handled(s) === full)) break; }
  const log = logOf(DATA);
  check('the request is passed on, the worker rebuilds, and every copy ends with the full index', /passed on to the copy of the connector that does the background reading/.test(log) && sawEmpty && full > 20 && sts.every((s) => handled(s) === full) && new Set(sts.map(indexLine)).size === 1, `${full} before; ` + sts.map(indexLine).join(' || '));
  const passes = readLines(log).slice(linesBefore); const readSince = readTotal(log) - readBefore;
  check('the rebuild read every document once more and none twice, in one pass or two', readSince === inCatalog(DATA) && inCatalog(DATA) === entriesBefore && passes.length >= 1 && passes.length <= 2 && readBefore >= 1, `read since the request: ${passes.join(' + ') || 0}; in the index: ${inCatalog(DATA)} (before: ${entriesBefore})`);
}

console.log('E. The worker stops: another copy takes over');
{
  const wp = workerPid(DATA); const worker = copies.find((c) => c.pid === wp); const rest = copies.filter((c) => c.pid !== wp);
  const passesBeforeKill = readLines(logOf(DATA)).length;
  process.kill(wp, 'SIGKILL'); await sleep(200);
  let newWp = null; for (let i = 0; i < 60 && (!newWp || newWp === wp); i++) { await sleep(250); newWp = workerPid(DATA); }
  check('when the worker is killed, one of the other copies becomes the worker', newWp && newWp !== wp && rest.some((c) => c.pid === newWp), `old ${wp}, new ${newWp}`);
  fs.writeFileSync(T(`${W}/after takeover.txt`), 'takeover-marker-554');
  let ok = false; let infos = [];
  for (let i = 0; i < 80 && !ok; i++) { await sleep(250); infos = await Promise.all(rest.map((c) => c.call('file_info', { path: `${W}/after takeover.txt` }))); ok = infos.every((r) => /Text search: searchable/.test(r.text)); }
  check('the new worker reads new files, and the remaining copies see them', ok, infos.map((r) => r.text.split('\n').pop()).join(' | '));
  const sts = await Promise.all(rest.map(async (c) => (await c.call('connector_status')).text));
  // (A few documents may be read again: what the stopped worker had read but not yet saved, and failures that a
  // new copy tries once more. A pass of more than 10 would be the library being read again.)
  const passesAfterKill = readLines(logOf(DATA)).slice(passesBeforeKill);
  check('after the takeover the library was not read all over again', passesAfterKill.every((n) => n <= 10) && sts.every((s) => handled(s) > 20), `passes since the worker was stopped: ${passesAfterKill.join(' + ') || 'none'}; ` + sts.map(indexLine).join(' || '));
  // a worker that closes normally gives the work up at once
  const w2 = rest.find((c) => c.pid === newWp); const last = rest.find((c) => c.pid !== newWp);
  await w2.client.close();
  let lastWp = null; for (let i = 0; i < 60 && lastWp !== last.pid; i++) { await sleep(250); lastWp = workerPid(DATA); }
  check('when the worker is closed normally, the remaining copy takes over as well', lastWp === last.pid, `worker now ${lastWp}, remaining copy ${last.pid}`);
  await last.client.close(); await sleep(300);
  check('when the last copy stops, no lock is left behind', !fs.existsSync(`${DATA}/index/background.lock`) && !fs.existsSync(`${DATA}/change.lock`), fs.readdirSync(`${DATA}/index`).filter((f) => !/^text$|catalog\.json$|background\.json$/.test(f)).join(', '));
  void worker;
}

console.log('F. On battery, the hourly allowance is counted once for all copies');
{
  const script = `${BASE}/data-si-power.sh`;
  fs.writeFileSync(script, `echo "Now drawing from 'Battery Power'"\necho " -InternalBattery-0 (id=1)\t80%; discharging; 4:10 remaining present: true"\n`);
  const D2 = `${BASE}/data-si-battery`; fs.rmSync(D2, { recursive: true, force: true });
  const three = await Promise.all([0, 1, 2].map(() => start(D2, { TRESORIT_POWER_CMD: script, TRESORIT_POWER_POLL_MS: '400', TRESORIT_BATTERY_DOCS_PER_HOUR: '5', TRESORIT_INDEX_INTERVAL_MS: '600000' })));
  const sts = await settleAll(three, /on battery as of/);
  await sleep(2500);
  const later = await Promise.all(three.map(async (c) => (await c.call('connector_status')).text));
  check('three copies on battery read 5 documents between them, not 5 each', later.every((s) => handled(s) === 5), later.map(indexLine).join(' || '));
  check('every copy says what is waiting for mains power', later.every((s) => /waiting for mains power: \d+ document\(s\) still to read/.test(s)) && sts.length === 3, later.map((s) => (s.match(/Background reading: .*/) || [''])[0].slice(0, 120)).join(' || '));
  fs.writeFileSync(script, `echo "Now drawing from 'AC Power'"\n`);
  const done = await settleAll(three, /up to date as of/);
  check('plugged in, the worker finishes and every copy reports the full index', done.every((s) => /up to date as of/.test(s) && handled(s) > 20) && new Set(done.map(indexLine)).size === 1, done.map(indexLine).join(' || '));
  for (const c of three) await c.client.close();
}

console.log('G. Harder: separate processes saving at once, kills at random moments, a frozen worker, a rebuild in mid-pass');
{
  const { execFileSync } = await import('node:child_process');
  const run = (script, args, timeout = 280000) => { try { return execFileSync('node', [`${TESTS}/scratch/${script}`, ...args], { env: { ...process.env, SERVER }, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return `FAILED TO RUN: ${e.message} ${e.stdout || ''}`; } };
  let out = run('idxhammer.mjs', [LIB, '6', 'nokill', '250']);
  check('six separate processes saving the catalog at once: nothing saved is lost and the catalog is always readable', /missing 0; removed ones still present 0;/.test(out) && /unreadable 0 time/.test(out) && /lock left behind: false/.test(out), out);
  // With kills, losses are counted by the strict test (index-strict): a writer stopped between its save and its own
  // note of it made the older count report losses that were none. The older test still shows that the catalog
  // stays readable all the while.
  out = run('idxhammer.mjs', [LIB, '6', 'kill', '250']);
  let strict; try { strict = execFileSync('node', [`${TESTS}/index-strict/idxhammer-b.mjs`, LIB, '6', 'kill', '250'], { env: { ...process.env, IDX_BASE: `${BASE}/data-idxstrict` }, encoding: 'utf8', timeout: 280000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { strict = `FAILED TO RUN: ${e.message} ${e.stdout || ''}`; }
  check('the same with fourteen of them killed in mid-work: still nothing saved is lost', /14 killed/.test(strict) && /missing 0;/.test(strict) && /removed still present 0;/.test(strict) && /saves that failed 0;/.test(strict) && /lock left behind: false/.test(strict) && /unreadable 0 time/.test(out) && /lock left behind: false/.test(out), `${strict}
       ${out}`);
  out = run('probe135.mjs', ['chaos'], 420000);
  check('thirty kills of running copies (mostly the worker) while files change: the index ends complete and identical in every copy', /documents in the index (\d+)\/\1\/\1 against \1 in a clean reference: EQUAL/.test(out) && /unreadable 0;/.test(out) && /newest files searchable from every copy: true/.test(out), out);
  check('...and no restart made a copy read the library all over again; one worker and no locks are left', /passes that read most of the library again: 0/.test(out) && /one live worker at the end: true; locks left: none/.test(out), out);
  out = run('probe135.mjs', ['frozen']);
  check('a worker frozen for longer than its lock is trusted: another takes over, and the first stands down when it wakes', /taken over by another copy: true; the old worker noticed and stood down: true; worker now still the new one/.test(out) && /was read 1 time\(s\); all three agree: true/.test(out), out);
  out = run('probe135.mjs', ['rebuild']);
  const eq = out.match(/against \d+: EQUAL/g) || [];
  check('a rebuild asked in the middle of a pass (of the worker, or of another copy) ends with the whole library in every copy', eq.length === 2 && !/DIFFERENT/.test(out) && (out.match(/found its file: true/g) || []).length === 2, out);
}

fs.rmSync(T(W), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
