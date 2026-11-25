import { Client, StdioClientTransport, MOCK, BUNDLE } from '../lib/env.mjs';
// Deep check of the shared search index in 1.3.5: random kills, a frozen worker, a rebuild in the middle of a pass.
import fs from 'node:fs';
const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const BASE = `${MOCK}`; const ROOT = `${BASE}/Tresors`; const LIB = 'Birch Labs/chaos-lib';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
const which = process.argv[2] || 'all';
async function start(DATA, extra = {}) {
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_INDEX_INTERVAL_MS: '1200', TRESORIT_BG_TAKEOVER_MS: '500', TRESORIT_BG_HOUSEKEEP_MS: '300', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off', ...extra };
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => { try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 60000 }); return r.content.map((c) => c.text || '').join('\n'); } catch (e) { return `call failed: ${e.message}`; } };
  return { client, call, pid: transport.pid };
}
const handled = (st) => { const m = st.match(/Search index: (\d+) document\(s\) readable \([^)]*\), (\d+) with no text, (\d+) unreadable/) || []; return Number(m[1]) + Number(m[2]) + Number(m[3]); };
const logOf = (DATA) => { try { return fs.readdirSync(`${DATA}/logs`).filter((f) => f.startsWith('access')).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n'); } catch { return ''; } };
const workerPid = (DATA) => { try { return JSON.parse(fs.readFileSync(`${DATA}/index/background.lock`, 'utf8')).pid; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = async (copies, tries = 400) => { let sts = []; let same = 0; for (let i = 0; i < tries; i++) { await sleep(300); sts = await Promise.all(copies.map((c) => c.call('connector_status'))); if (sts.every((s) => /up to date as of/.test(s)) && new Set(sts.map(handled)).size === 1) { if (++same >= 3) break; } else same = 0; } return sts; };
const makeLib = (n) => { fs.rmSync(T(LIB), { recursive: true, force: true }); fs.mkdirSync(T(LIB), { recursive: true }); for (let i = 0; i < n; i++) fs.writeFileSync(T(`${LIB}/doc-${i}.txt`), `library document ${i} marker-lib-${i}\n` + 'filler text '.repeat(200)); };
const reference = async () => { const D = `${BASE}/data-p135-ref`; fs.rmSync(D, { recursive: true, force: true }); const c = await start(D); const st = (await settle([c]))[0]; await c.client.close(); return handled(st); };
const passes = (log) => log.split('\n').filter((l) => /document\(s\) read into the search index/.test(l)).map((l) => Number((l.match(/(\d+) document\(s\) read/) || [])[1]));

if (which === 'all' || which === 'chaos') {
  makeLib(300);
  const DATA = `${BASE}/data-p135-chaos`; fs.rmSync(DATA, { recursive: true, force: true });
  let copies = await Promise.all([start(DATA), start(DATA), start(DATA)]);
  await settle(copies);
  const before = logOf(DATA).split('\n').length;
  let unreadable = 0, reads = 0, stop = false;
  (async () => { while (!stop) { try { JSON.parse(fs.readFileSync(`${DATA}/index/catalog.json`, 'utf8')); reads++; } catch (e) { if (e.code !== 'ENOENT') unreadable++; } await sleep(2); } })();
  let kills = 0, workerKills = 0; const added = []; let changes = 0;
  for (let round = 0; round < 30; round++) {
    await sleep(150 + Math.random() * 1300);
    fs.writeFileSync(T(`${LIB}/new-${round}.txt`), `added in round ${round} marker-new-${round}`); added.push(round); changes++;
    if (round % 3 === 1 && added.length > 2) { const g = added.splice(Math.floor(Math.random() * added.length), 1)[0]; fs.rmSync(T(`${LIB}/new-${g}.txt`), { force: true }); }
    if (round % 4 === 2) { fs.appendFileSync(T(`${LIB}/doc-${round}.txt`), `\nchanged in round ${round}`); changes++; }
    const wp = workerPid(DATA); let victim = copies.find((c) => c.pid === wp);
    if (!victim || Math.random() < 0.35) victim = copies[Math.floor(Math.random() * copies.length)]; else workerKills++;
    try { process.kill(victim.pid, 'SIGKILL'); kills++; } catch { /* already gone */ }
    copies = copies.filter((c) => c !== victim); copies.push(await start(DATA));
  }
  stop = true;
  const sts = await settle(copies); await sleep(7000); const again = await Promise.all(copies.map((c) => c.call('connector_status')));
  const want = await reference();
  const log = logOf(DATA).split('\n').slice(before).join('\n');
  const p = passes(log); const big = p.filter((n) => n > 80);
  const wp = workerPid(DATA);
  // every file that is on disk now can be found through every copy; removed ones are gone from the index
  const probe = added.slice(-3); const finds = await Promise.all(copies.flatMap((c) => probe.map((r) => c.call('file_info', { path: `${LIB}/new-${r}.txt` }))));
  console.log(`CHAOS: ${kills} kills (${workerKills} of the worker) with ${changes} files added or changed meanwhile`);
  console.log(`  all three agree: ${new Set(again.map(handled)).size === 1}; documents in the index ${again.map(handled).join('/')} against ${want} in a clean reference: ${again.every((s) => handled(s) === want) ? 'EQUAL' : 'DIFFERENT'}`);
  console.log(`  passes logged during the chaos read ${p.join(', ') || 'nothing'} document(s); passes that read most of the library again: ${big.length}`);
  console.log(`  catalog read ${reads} times during the chaos, unreadable ${unreadable}; newest files searchable from every copy: ${finds.every((t) => /Text search: searchable/.test(t))}`);
  console.log(`  one live worker at the end: ${Boolean(wp) && alive(wp) && copies.some((c) => c.pid === wp)}; locks left: ${['index/catalog.json.lock', 'change.lock'].filter((f) => fs.existsSync(`${DATA}/${f}`)).join(', ') || 'none'}; settled: ${sts.every((s) => /up to date/.test(s))}`);
  for (const c of copies) await c.client.close().catch(() => {});
}

if (which === 'all' || which === 'frozen') {
  makeLib(60);
  const DATA = `${BASE}/data-p135-frozen`; fs.rmSync(DATA, { recursive: true, force: true });
  const ex = { TRESORIT_LOCK_STALE_MS: '1500' };
  const copies = await Promise.all([start(DATA, ex), start(DATA, ex), start(DATA, ex)]);
  await settle(copies);
  const wp = workerPid(DATA);
  process.kill(wp, 'SIGSTOP'); let newWp = wp; for (let i = 0; i < 60 && newWp === wp; i++) { await sleep(250); newWp = workerPid(DATA); }
  await sleep(1500); process.kill(wp, 'SIGCONT');
  let noticed = false; for (let i = 0; i < 60 && !noticed; i++) { await sleep(250); noticed = /another copy of the connector has taken over the background reading/.test(logOf(DATA)); }
  fs.writeFileSync(T(`${LIB}/after-freeze.txt`), 'marker-after-freeze'); await sleep(6000);
  const log = logOf(DATA); const sts = await settle(copies);
  const readsOfNew = log.split('\n').filter((l) => /1 document\(s\) read into the search index/.test(l)).length;
  console.log(`FROZEN WORKER: taken over by another copy: ${newWp !== wp}; the old worker noticed and stood down: ${noticed}; worker now ${workerPid(DATA) === newWp ? 'still the new one' : 'CHANGED AGAIN'}`);
  console.log(`  a file added afterwards was read ${readsOfNew} time(s); all three agree: ${new Set(sts.map(handled)).size === 1}`);
  for (const c of copies) await c.client.close().catch(() => {});
}

if (which === 'all' || which === 'rebuild') {
  makeLib(400);
  const want = await reference();
  for (const via of ['a copy that is not the worker', 'the worker itself']) {
    const DATA = `${BASE}/data-p135-rebuild`; fs.rmSync(DATA, { recursive: true, force: true });
    const copies = await Promise.all([start(DATA), start(DATA), start(DATA)]);
    let st = ''; for (let i = 0; i < 200; i++) { await sleep(100); st = await copies[0].call('connector_status'); const m = st.match(/reading documents \((\d+) new/); if (m && Number(m[1]) > 60) break; }
    const mid = /in progress/.test(st);
    const wp = workerPid(DATA); const target = via.startsWith('the worker') ? copies.find((c) => c.pid === wp) : copies.find((c) => c.pid !== wp);
    const other = copies.find((c) => c !== target && c.pid !== wp) || copies.find((c) => c !== target);
    const [, found] = await Promise.all([target.call('connector_status', { rebuild_index: true }), other.call('search_contents', { query: 'marker-lib-17', path: LIB })]);
    const sts = await settle(copies); await sleep(6500); const again = await Promise.all(copies.map((c) => c.call('connector_status')));
    const log = logOf(DATA);
    console.log(`REBUILD in the middle of a pass, asked of ${via}: asked while a pass was running: ${mid}; rebuild recorded: ${/rebuild requested/.test(log)}; a search through another copy at that moment found its file: ${found.includes('doc-17.txt')}`);
    console.log(`  afterwards every copy has the whole library: ${again.map(handled).join('/')} against ${want}: ${again.every((s) => handled(s) === want) ? 'EQUAL' : 'DIFFERENT'}; settled ${sts.every((s) => /up to date/.test(s))}; passes: ${passes(log).join(', ')}`);
    for (const c of copies) await c.client.close().catch(() => {});
  }
}
fs.rmSync(T(LIB), { recursive: true, force: true });
