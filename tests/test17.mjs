import { Client, StdioClientTransport, MOCK, TESTS, BUNDLE } from './lib/env.mjs';
// 1.4.4: what the hard test of 1.4.3 found.
//  A. A file that was missing or busy at the moment it was read is not recorded as damaged, and such records left
//     by earlier versions are read again.
//  B. Delete and restore, move away and back: the file stays readable and searchable, also under a race.
//  C. The holding-area list shows the first items of a large batch and one batch in full on request.
//  D. The access log says why the Mac's own text recognition passed a file to the bundled engine.
//  E. The random stress run (three copies, kills) ends with nothing wrong.
import fs from 'node:fs'; import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
process.env.TRESORIT_HOLDING_DAYS ??= '0';
const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const BASE = `${MOCK}`; const ROOT = `${BASE}/Tresors`; const W = 'Birch Labs/t17';
const SOAK_MIN = process.env.T17_SOAK_MINUTES || '3';
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 900)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
async function start(name, extra = {}, keep = false) {
  const DATA = `${BASE}/data-t17-${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_INDEX_DELAY_MS: '999999', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_OCR_ENGINE: 'bundled', ...extra };
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => { try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError }; } catch (e) { return { text: `CALL FAILED: ${e.message}`, isError: true }; } };
  const del = async (paths) => { const pv = await call('delete_items', { paths }); return call('delete_items', { paths, confirm_token: (pv.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1] }); };
  await call('connector_status');
  return { client, call, del, DATA, close: () => client.close() };
}
const catalog = (DATA) => JSON.parse(fs.readFileSync(`${DATA}/index/catalog.json`, 'utf8'));
const unreadableIn = async (s, folder) => (await s.call('list_unreadable', { path: folder })).text;
fs.rmSync(T(W), { recursive: true, force: true }); fs.mkdirSync(T(W), { recursive: true });

// ================================================================================================================
console.log('A. A file that was not there at the moment of reading');
{
  const { Extractor } = await import(new URL('./lib/extractor.js', `file://${path.dirname(SERVER)}/`).href);
  const ex = new Extractor();
  const r = await ex.extract(`${T(W)}/never existed.txt`, 'txt', 10);
  await ex.close();
  check('the reader, asked for a file that is not there, says so and does not call the document damaged', r.status === 'error' && r.gone === true && r.transient === true && /not there at the moment/.test(r.note) && !/ENOENT/.test(r.note), JSON.stringify(r));
}
{
  let s = await start('stale');
  await s.call('write_file', { path: `${W}/a/alpha.txt`, content: 'Marker T17-ALPHA-4410 in a plain text file.\n' });
  await s.call('write_file', { path: `${W}/a/beta.csv`, content: 'name,code\nbeta,T17-BETA-4411\n' });
  await s.call('write_file', { path: `${W}/a/gamma.md`, content: '# Gamma\nMarker T17-GAMMA-4412.\n' });
  fs.writeFileSync(T(`${W}/a/broken.pdf`), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(900, 7)]));
  const first = await s.call('search_contents', { query: 'T17-', path: `${W}/a`, match: 'phrase' });
  check('three new files are found by content', /3 file\(s\) contain/.test(first.text), first.text);
  await s.close(); await sleep(300);
  // what an earlier version left behind when the file was missing or busy at the moment it was opened
  const f = `${s.DATA}/index/catalog.json`; const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  const key = (name) => Object.keys(c.entries).find((k) => k.endsWith(name));
  const stale = (name, note, more = {}) => { const k = key(name); const e = c.entries[k]; c.entries[k] = { s: e.s, m: e.m, st: 'error', c: 0, n: note, y: 'damaged', ...more }; };
  stale('alpha.txt', "could not be read: ENOENT: no such file or directory, open '/somewhere/alpha.txt'");
  stale('beta.csv', 'could not be read: EBUSY: resource busy or locked, open', { x: 1 });
  stale('gamma.md', 'could not be read: ENOENT: no such file or directory, open', { x: 2 });
  check('the test catalogue holds three such records and one truly damaged PDF', ['alpha.txt', 'beta.csv', 'gamma.md'].every((n) => c.entries[key(n)].st === 'error') && c.entries[key('broken.pdf')] && c.entries[key('broken.pdf')].st === 'error', JSON.stringify(c.entries[key('broken.pdf')]));
  fs.writeFileSync(f, JSON.stringify(c));
  fs.cpSync(s.DATA, `${BASE}/data-t17-stalebg`, { recursive: true });
  s = await start('stale', {}, true);
  const u0 = await unreadableIn(s, `${W}/a`);
  check('before anything is asked, the old records still show the three files as unreadable (the fault of 1.4.3)', /alpha\.txt/.test(u0) && /beta\.csv/.test(u0) && /gamma\.md/.test(u0), u0);
  const again = await s.call('search_contents', { query: 'T17-', path: `${W}/a`, match: 'phrase' });
  check('a search reads them again and finds all three', /3 file\(s\) contain/.test(again.text) && /alpha\.txt/.test(again.text) && /beta\.csv/.test(again.text) && /gamma\.md/.test(again.text), again.text);
  const rd = await s.call('read_file', { path: `${W}/a/alpha.txt` });
  check('the file opens', !rd.isError && /T17-ALPHA-4410/.test(rd.text), rd.text);
  const u1 = await unreadableIn(s, `${W}/a`);
  check('afterwards only the truly damaged PDF is listed as unreadable', /broken\.pdf/.test(u1) && !/alpha\.txt|beta\.csv|gamma\.md/.test(u1) && /1 of 4 document/.test(u1), u1);
  await s.close();
  // the same, left to the background reading alone
  const b = await start('stalebg', { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '200' }, true);
  let u2 = ''; let cat = null;
  for (let i = 0; i < 240; i++) { await sleep(500); try { cat = catalog(b.DATA); } catch { cat = null; } if (cat && ['alpha.txt', 'beta.csv', 'gamma.md'].every((n) => { const k = Object.keys(cat.entries).find((x) => x.endsWith(`t17/a/${n}`)); return k && cat.entries[k].st === 'ok'; })) break; }
  u2 = await unreadableIn(b, `${W}/a`);
  check('the background reading alone also reads them again; the damaged PDF stays damaged', /broken\.pdf/.test(u2) && !/alpha\.txt|beta\.csv|gamma\.md/.test(u2), u2);
  await b.close();
}

// ================================================================================================================
console.log('B. Delete and restore, move away and back');
{
  const s = await start('back');
  await s.call('write_file', { path: `${W}/b/Relatório final.txt`, content: 'Marker T17-BACK-5520 stays findable.\n' });
  const find = async () => (await s.call('search_contents', { query: 'T17-BACK-5520', path: `${W}/b` })).text;
  check('found before', /1 file\(s\) contain/.test(await find()));
  const d = await s.del([`${W}/b/Relatório final.txt`]);
  const batch = (d.text.match(/as batch (\S+)/) || d.text.match(/batch (\d{4}-\S+)/) || [])[1];
  check('deleted with permission, not found while it is gone', Boolean(batch) && /0 file\(s\) contain|No file|nothing/i.test(await find()), `${d.text}\n${await find()}`);
  const r = await s.call('restore_deleted', { batch: String(batch).replace(/[.,]$/, '') });
  const after = await find();
  check('restored: found again', !r.isError && /1 file\(s\) contain/.test(after), `${r.text}\n${after}`);
  await s.call('move_item', { source: `${W}/b/Relatório final.txt`, destination: `${W}/b/elsewhere.txt` });
  await find();
  await s.call('move_item', { source: `${W}/b/elsewhere.txt`, destination: `${W}/b/Relatório final.txt` });
  const back = await find();
  check('moved away and back: found at its place, once', /1 file\(s\) contain/.test(back) && /Relatório final\.txt/.test(back), back);
  const u = await unreadableIn(s, `${W}/b`);
  check('nothing is recorded as unreadable', /0 of 1 document|No document|none|could be read/i.test(u) && !/Relatório final/.test(u.replace(/^.*?\n/, '')) , u);
  await s.close();
}
{
  // files vanish and come back unchanged (as when Tresorit or the Finder moves them) while they are being read
  const N = 500; const dir = T(`${W}/race`); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < N; i++) fs.writeFileSync(`${dir}/doc ${i}.txt`, `Race file ${i} with marker T17-RACE-${10000 + i} and some more words.\n`);
  const s = await start('race');
  let stop = false; let swaps = 0;
  const mover = (async () => { while (!stop) { for (let i = 0; i < N && !stop; i++) { const a = `${dir}/doc ${i}.txt`; const z = `${dir}/.away ${i}`; try { fs.renameSync(a, z); } catch { continue; } await sleep(1); try { fs.renameSync(z, a); swaps++; } catch { /* ignore */ } } } })();
  let during = '';
  for (let k = 0; k < 8; k++) during = (await s.call('search_contents', { query: 'T17-NOT-IN-ANY-FILE', path: `${W}/race` })).text;
  stop = true; await mover;
  for (let i = 0; i < N; i++) { const z = `${dir}/.away ${i}`; if (fs.existsSync(z)) fs.renameSync(z, `${dir}/doc ${i}.txt`); }
  const uDuring = await unreadableIn(s, `${W}/race`);
  let settle = '';
  for (let k = 0; k < 6; k++) settle = (await s.call('search_contents', { query: 'T17-NOT-IN-ANY-FILE', path: `${W}/race` })).text;
  let missing = 0;
  for (const i of [0, 7, 99, 250, 333, 499]) { const r = await s.call('search_contents', { query: `T17-RACE-${10000 + i}`, path: `${W}/race` }); if (!/1 file\(s\) contain/.test(r.text)) missing++; }
  const u = await unreadableIn(s, `${W}/race`);
  const st = (await s.call('connector_status')).text;
  check(`${N} files moved away and back ${swaps} times while being read: none is left recorded as unreadable`, swaps > 200 && !/doc \d+\.txt/.test(u) && /Searched 500 document/.test(settle) && /0 damaged/.test(st), `swaps ${swaps}\nduring: ${uDuring.slice(0, 200)}\nafter: ${u.slice(0, 300)}\n${settle.slice(0, 200)}\n${(st.match(/Unreadable by reason.*/) || [''])[0]}`);
  check('...and every sampled file is found by its content', missing === 0, `${missing} of 6 not found`);
  const log = fs.readdirSync(`${s.DATA}/logs`).map((n) => fs.readFileSync(`${s.DATA}/logs/${n}`, 'utf8')).join('');
  check('no error line in the access log', !/\| ERROR/.test(log), (log.match(/.*\| ERROR.*/g) || []).slice(0, 3).join('\n'));
  await s.close();
}

// ================================================================================================================
console.log('C. The holding-area list');
{
  const s = await start('held');
  const paths = [];
  for (let i = 0; i < 25; i++) { const p = `${W}/c/item ${String(i).padStart(2, '0')}.txt`; fs.mkdirSync(path.dirname(T(p)), { recursive: true }); fs.writeFileSync(T(p), `held ${i}`); paths.push(p); }
  const d = await s.del(paths);
  const list = await s.call('list_deleted');
  const name = (list.text.match(/^(\d{4}-\d\d-\d\d_\d{6}_deleted_\w+)/m) || [])[1];
  const shownItems = (list.text.match(/^ {3}- \[file\]/gm) || []).length;
  check('a batch of 25 items shows its first 10 and says 15 more', !d.isError && shownItems === 10 && /\.\.\.and 15 more item\(s\) in this batch/.test(list.text) && /25 item\(s\)/.test(list.text), list.text);
  const one = await s.call('list_deleted', { batch: name });
  check('asked for by name, the batch is listed in full', (one.text.match(/^ {3}- \[file\]/gm) || []).length === 25 && /item 24\.txt/.test(one.text), one.text);
  const three = await s.call('list_deleted', { items_per_batch: 3 });
  check('the number shown per batch can be chosen', (three.text.match(/^ {3}- \[file\]/gm) || []).length === 3 && /and 22 more item/.test(three.text), three.text);
  const bad = await s.call('list_deleted', { batch: '../../etc' }); const none = await s.call('list_deleted', { batch: '2020-01-01_000000_deleted_zzzzzz' });
  check('a made-up or malformed batch name is refused', bad.isError && none.isError && /Invalid batch name/.test(bad.text) && /No batch named/.test(none.text), `${bad.text}\n${none.text}`);
  const r = await s.call('restore_deleted', { batch: name, item: `${W}/c/item 24.txt` });
  check('an item beyond the first ten can be restored by its path', !r.isError && fs.existsSync(T(`${W}/c/item 24.txt`)) && !fs.existsSync(T(`${W}/c/item 23.txt`)), r.text);
  const log = (await s.call('access_log', { contains: 'HELD', lines: 20 })).text;
  check('listing the holding area is in the access log', (log.match(/\| HELD/g) || []).length >= 3, log);
  await s.close();
}

// ================================================================================================================
console.log('D. Text recognition: why a file was passed to the bundled engine');
{
  const stub = (mode) => JSON.stringify(['node', `${TESTS}/scratch/vision-stub.mjs`, mode]);
  const S = 'Personal/Scans';
  let s = await start('visfail', { TRESORIT_OCR_ENGINE: 'auto', TRESORIT_VISION_CMD: stub('failfile') });
  const r = await s.call('read_file', { path: `${S}/Contract scan.pdf` });
  const log = (await s.call('access_log', { contains: '| OCR', lines: 10 })).text;
  check('the Mac engine fails on one file: the bundled engine reads it and the log gives the reason', /ZEBRA-QUARTZ-7781/.test(r.text) && /read by the bundled engine \(the Mac's own recognition passed it on: the PDF could not be opened\)/.test(log), `${r.text.slice(0, 200)}\n${log}`);
  await s.close();
  s = await start('visok', { TRESORIT_OCR_ENGINE: 'auto', TRESORIT_VISION_CMD: stub('ok') });
  await s.call('read_file', { path: `${S}/Contract scan.pdf` });
  const log2 = (await s.call('access_log', { contains: '| OCR', lines: 10 })).text;
  check('when the Mac engine reads the file itself the log says so and gives no such reason', /read by Mac built-in recognition/.test(log2) && !/passed it on/.test(log2), log2);
  await s.close();
  s = await start('visnone');
  await s.call('read_file', { path: `${S}/Contract scan.pdf` });
  const log3 = (await s.call('access_log', { contains: '| OCR', lines: 10 })).text;
  check('with the bundled engine alone there is nothing to pass on', /read by the bundled engine/.test(log3) && !/passed it on/.test(log3), log3);
  await s.close();
  const helper = path.join(path.dirname(SERVER), 'ocr', 'vision-ocr.js');
  let syntax = ''; try { execFileSync('node', ['--check', helper], { stdio: 'pipe' }); } catch (e) { syntax = String(e.stderr || e.message); }
  const src = fs.readFileSync(helper, 'utf8');
  check('the Mac helper is valid script and opens a picture from its bytes, not by the ending of its name', syntax === '' && /NSData\.dataWithContentsOfFile\(path\)/.test(src) && /NSImage\.alloc\.initWithData\(bytes\)/.test(src) && !/initWithContentsOfFile/.test(src), syntax);
}

// ================================================================================================================
console.log(`E. Random stress run (${SOAK_MIN} minutes, three copies, sudden kills)`);
{
  const out = await new Promise((res) => execFile('node', [`${TESTS}/scratch/soak143.mjs`, SOAK_MIN, '7741'], { timeout: (Number(SOAK_MIN) + 12) * 60000, maxBuffer: 1 << 24, env: (() => { const e = { ...process.env, SERVER }; delete e.TRESORIT_HOLDING_DAYS; return e; })() }, (e, o, err) => res(String(o) + (e ? `\n${e.message}\n${String(err).slice(0, 600)}` : ''))));
  check('nothing lost, nothing wrong, nothing touched outside the work folder', /ANOMALIES: 0/.test(out) && /0 missing, 0 with wrong content, 0 that should not be there/.test(out) && /everything outside the work folder is exactly as before: true/.test(out), out.slice(0, 1500));
  check('no document is left recorded as unreadable, and search agrees with what is there', /recorded as unreadable: 0 /.test(out) && /0 live file\(s\) not found, 0 deleted file\(s\) still found/.test(out), out.slice(0, 1500));
  check('automatic clearing took exactly the old batches; no error lines', /0 still there, 0 removed that were not old/.test(out) && /ERROR lines: 0; NOTE lines: 0/.test(out), out.slice(0, 1500));
}

fs.rmSync(T(W), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
