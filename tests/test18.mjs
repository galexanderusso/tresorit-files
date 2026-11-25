// 1.5.0: the repairs. Every part here was seen to fail on the code before its repair.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { Client, StdioClientTransport, ElicitRequestSchema, MOCK, SERVER, TESTS, serverLib } from './lib/env.mjs';
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 600)); } };
const BASE = `${MOCK}/data-r150`;
fs.rmSync(BASE, { recursive: true, force: true });
const ROOT = `${MOCK}/Tresors`; const W = 'Birch Labs/t18'; const T = (rel) => `${ROOT}/${rel}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.rmSync(T(W), { recursive: true, force: true });
// One running copy of the connector on the test library. keep: start again on the data folder as it was left.
async function start(name, extra = {}, keep = false) {
  const DATA = `${BASE}/${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_INDEX_DELAY_MS: '999999', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_HOLDING_DAYS: '0', ...extra };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => { try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError }; } catch (e) { return { text: `CALL FAILED: ${e.message}`, isError: true }; } };
  await call('connector_status');
  return { client, call, DATA, pid: transport.pid, close: () => client.close() };
}
const catalogOf = (DATA) => JSON.parse(fs.readFileSync(`${DATA}/index/catalog.json`, 'utf8'));

console.log('A. The lock that guards the saving of the search index');
{
  // Several copies of the connector save the same catalog. A short lock keeps two saves apart. Up to 1.4.8 two
  // copies that both found a lock left behind by a stopped copy could each clear it: the second one removed the
  // lock the first had just taken, both saved at once, and one save was lost.
  const { TextIndex } = await serverLib('textindex.js');
  const dir = `${BASE}/lock/index`; fs.mkdirSync(dir, { recursive: true });
  const ix = new TextIndex(dir);
  const lock = `${dir}/catalog.json.lock`; const breaker = `${lock}.break`;
  const stopped = spawnSync(process.execPath, ['-e', '']).pid;               // a copy that no longer runs
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }); // one that does
  const holder = () => { try { return Number(fs.readFileSync(lock, 'utf8')); } catch { return 0; } };

  fs.writeFileSync(lock, String(stopped));
  let t0 = Date.now(); let got = ix._lockCatalog();
  check('a lock left behind by a copy that has stopped is cleared and taken at once', got === lock && holder() === process.pid && Date.now() - t0 < 1000 && !fs.existsSync(breaker), `returned ${got}; held by ${holder()}; ${Date.now() - t0} ms`);
  fs.rmSync(lock, { force: true });

  // The moment that went wrong: this copy has just seen the abandoned lock; before it acts, another copy clears
  // that lock and takes it. (Arranged here by doing exactly that at the instant this copy reads the lock.)
  fs.writeFileSync(lock, String(stopped));
  const realRead = fs.readFileSync; let arranged = false;
  fs.readFileSync = function (p, ...rest) {
    const out = realRead.call(fs, p, ...rest);
    if (!arranged && p === lock) { arranged = true; fs.rmSync(lock, { force: true }); fs.writeFileSync(lock, String(other.pid)); }
    return out;
  };
  t0 = Date.now();
  try { got = ix._lockCatalog(); } finally { fs.readFileSync = realRead; }
  check('a lock that another copy has just taken is not removed by a copy that had seen the abandoned one (it waits, then goes on without the lock)',
    arranged && got === null && holder() === other.pid && Date.now() - t0 >= 2500 && !fs.existsSync(breaker), `returned ${got}; lock held by ${holder()} (the other copy is ${other.pid}, this one ${process.pid}); ${Date.now() - t0} ms`);
  fs.rmSync(lock, { force: true });

  // A copy stopped at the very instant it was clearing an abandoned lock leaves its marker behind.
  fs.writeFileSync(lock, String(stopped)); fs.writeFileSync(breaker, ''); const longAgo = new Date(Date.now() - 60000); fs.utimesSync(breaker, longAgo, longAgo);
  t0 = Date.now(); got = ix._lockCatalog();
  check('a clearing left unfinished by a stopped copy does not hold up the others', got === lock && holder() === process.pid && Date.now() - t0 < 1000 && !fs.existsSync(breaker), `returned ${got}; held by ${holder()}; marker still there: ${fs.existsSync(breaker)}; ${Date.now() - t0} ms`);
  fs.rmSync(lock, { force: true });

  // While another copy is in the middle of clearing (its marker is fresh), the abandoned lock is left to it.
  fs.writeFileSync(lock, String(stopped)); fs.writeFileSync(breaker, '');
  t0 = Date.now(); got = ix._lockCatalog();
  check('while another copy is clearing an abandoned lock, this one does not clear it as well', got === null && holder() === stopped && Date.now() - t0 >= 2500, `returned ${got}; held by ${holder()} (stopped copy: ${stopped}); ${Date.now() - t0} ms`);
  fs.rmSync(lock, { force: true }); fs.rmSync(breaker, { force: true });

  ix.dirty = true; ix.save();
  check('an ordinary save leaves neither lock nor marker behind', fs.existsSync(`${dir}/catalog.json`) && !fs.existsSync(lock) && !fs.existsSync(breaker), fs.readdirSync(dir).join(', '));
  other.kill('SIGKILL');
}

console.log('B. Which old records of a failed reading are tried again');
{
  // A reading that failed because of the moment (the file was missing or busy when it was opened) is tried again.
  // Up to 1.4.8 such a record was recognised by loose words anywhere in its note, so the message of a document
  // reader about a truly damaged file could be taken for it. Now only the exact form the connector writes counts:
  // "could not be read: " followed by the disk's own error code.
  let s = await start('momentary');
  await s.call('write_file', { path: `${W}/b/sound.txt`, content: 'Marker T18-SOUND-5510 in a sound file.' });
  fs.writeFileSync(T(`${W}/b/broken.pdf`), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(900, 7)]));
  const first = await s.call('search_contents', { query: 'T18-SOUND-5510', path: `${W}/b`, match: 'phrase' });
  await s.close(); await sleep(300);
  const f = `${s.DATA}/index/catalog.json`; const cat = JSON.parse(fs.readFileSync(f, 'utf8'));
  const key = (name) => Object.keys(cat.entries).find((k) => k.endsWith(name));
  const plant = (name, note) => { const e = cat.entries[key(name)]; cat.entries[key(name)] = { s: e.s, m: e.m, st: 'error', c: 0, n: note, y: 'damaged' }; };
  const readerNote = 'could not be read: the archive has no such file or directory inside it: word/document.xml';
  plant('broken.pdf', readerNote);
  plant('sound.txt', "could not be read: EMFILE: too many open files, open '/somewhere/sound.txt'");
  check('the test catalogue holds the two records', /1 file\(s\) contain/.test(first.text) && cat.entries[key('broken.pdf')].st === 'error' && cat.entries[key('sound.txt')].st === 'error', first.text);
  fs.writeFileSync(f, JSON.stringify(cat));
  s = await start('momentary', {}, true);
  const again = await s.call('search_contents', { query: 'T18-SOUND-5510', path: `${W}/b`, match: 'phrase' });
  await s.close(); await sleep(300);
  const after = catalogOf(s.DATA).entries;
  const k = Object.keys(after).find((x) => x.endsWith('broken.pdf'));
  check('a failure recorded with the disk\'s own error code ("could not be read: EMFILE: ...") is tried again, and the file is found', /1 file\(s\) contain/.test(again.text) && /sound\.txt/.test(again.text), again.text);
  check('a reader\'s message about a damaged file that merely contains the words "no such file or directory" is not taken for a passing failure: the file is not read again', Boolean(k) && after[k].n === readerNote, JSON.stringify(k ? after[k] : null));
}

// One of the helper scripts in scratch/ that play a single copy of the connector from the inside. Its last line is JSON.
const inside = (script, args, DATA, extra = {}) => {
  fs.rmSync(DATA, { recursive: true, force: true });
  try {
    const out = execFileSync(process.execPath, [`${TESTS}/scratch/${script}`, path.dirname(SERVER), ...args], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_HOLDING_DAYS: '0', ...extra }, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) { return { failedToRun: String(e.message).slice(0, 300) }; }
};

console.log('C. A file that is not there at the instant it is opened');
{
  // A copy that failed to read a file earlier tries again and finds the file gone at that instant (it was just
  // moved, deleted or replaced). It then drops its stale record of the failure. Up to 1.4.8 it dropped whatever the
  // index held for the file, also the text that another copy had read of that very version in the meantime.
  const twin = `${W}/c/twin.txt`;
  const play = (mode) => { fs.mkdirSync(T(`${W}/c`), { recursive: true }); fs.writeFileSync(T(twin), 'Marker T18-TWIN-5520.'); return inside('gone150.mjs', [twin, mode], `${BASE}/gone-${mode}`, { TRESORIT_BACKGROUND_INDEX: 'false' }); };
  let r = play('other-has-text');
  check('the text another copy has read of that very version is kept, not thrown away with this copy\'s stale record', r.had === 'error' && r.answer === 'error' && r.onDisk === 'ok' && r.text === 'TEXT READ BY THE OTHER COPY', JSON.stringify(r));
  r = play('nobody-has-text');
  check('when no copy has a text of it, the stale record of the failure still goes', r.had === 'error' && r.answer === 'error' && r.onDisk === null && r.text === null, JSON.stringify(r));
}

console.log('D. One copy asked for a background pass twice at the same instant');
{
  // Two of a copy's timers can fall together, or a timer and a request for a rebuild. Up to 1.4.8 both requests
  // got through the test "is a pass running?" (it was only marked as running after two waits), so the copy made
  // two passes at once: documents were read twice and the status counted them twice.
  const r = inside('twopass150.mjs', [], `${BASE}/twopass`, { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_OCR: 'false', TRESORIT_INDEX_DELAY_MS: '999999' });
  check('the library is read once, by one pass, and the count of documents checked is that of one pass', Array.isArray(r.read) && r.read.length === 1 && r.read[0] > 5 && r.checkedAfterTwoRequests === r.checkedByOnePass && r.checkedByOnePass > 5, JSON.stringify(r));
}

console.log('E. System clutter is clutter whatever the capitals of its name');
{
  // ".DS_Store", "desktop.ini", "Thumbs.db", "Icon\r" and ".localized" are never shown and never brought in. Up to
  // 1.4.8 the five names were compared letter for letter: "THUMBS.DB" typed on a Mac (whose disk ignores capitals)
  // reached the file "Thumbs.db" and was brought in, and a file the disk holds as "thumbs.db" was listed, searched
  // and brought in like a document.
  const HOME = `${BASE}/home-e`; fs.mkdirSync(`${HOME}/Downloads`, { recursive: true });
  fs.writeFileSync(`${HOME}/Downloads/THUMBS.DB`, 'clutter-marker-5530');
  fs.writeFileSync(`${HOME}/Downloads/Desktop.INI`, 'clutter-marker-5531');
  fs.writeFileSync(`${HOME}/Downloads/Thumbs.db.txt`, 'A document whose name only resembles one. Marker T18-RESEMBLES-5532.');
  fs.mkdirSync(T(`${W}/e/in`), { recursive: true });
  fs.writeFileSync(T(`${W}/e/in/thumbs.db`), 'clutter-marker-5533');
  fs.writeFileSync(T(`${W}/e/in/DESKTOP.INI`), 'clutter-marker-5534');
  fs.writeFileSync(T(`${W}/e/in/.ds_store`), 'clutter-marker-5535');
  fs.writeFileSync(T(`${W}/e/in/real note.txt`), 'A real note. Marker T18-REAL-5536.');
  const s = await start('clutter', { TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME });
  const a = await s.call('import_file', { source: `${HOME}/Downloads/THUMBS.DB`, destination: `${W}/e/brought/` });
  const b = await s.call('import_file', { source: `${HOME}/Downloads/Desktop.INI`, destination: `${W}/e/brought/` });
  const arrived = fs.existsSync(T(`${W}/e/brought`)) ? fs.readdirSync(T(`${W}/e/brought`)) : [];
  check('a system file is not brought in when its name is spelled in other capitals', a.isError && b.isError && /temporary or system file/.test(a.text) && /temporary or system file/.test(b.text) && arrived.length === 0, `${a.text.slice(0, 160)} | ${b.text.slice(0, 160)} | arrived: ${arrived.join(', ')}`);
  const c = await s.call('import_file', { source: `${HOME}/Downloads/Thumbs.db.txt`, destination: `${W}/e/brought/` });
  check('a document whose name only resembles such a file is brought in like any other', !c.isError && fs.existsSync(T(`${W}/e/brought/Thumbs.db.txt`)), c.text.slice(0, 200));
  const l = await s.call('list_folder', { path: `${W}/e/in`, include_hidden: true });
  const f = await s.call('find_files', { query: 'thumbs', path: `${W}/e/in` });
  const q = await s.call('search_contents', { query: 'clutter-marker', path: `${W}/e/in` });
  check('inside Tresorit such files are left out of lists, of the search by name and of the search inside documents, under any capitals', /real note\.txt/.test(l.text) && !/thumbs\.db|DESKTOP\.INI|\.ds_store/i.test(l.text) && !/thumbs\.db/i.test(f.text) && /0 file\(s\) contain/.test(q.text), `${l.text.slice(0, 200)} | ${f.text.slice(0, 120)} | ${q.text.slice(0, 120)}`);
  await s.close();
}

console.log('F. Nothing new inside Tresorit gets a name that Tresorit would not sync or that the lists hide');
{
  // Tresorit leaves some names out of sync ("Files excluded from sync" in its knowledge base), and the connector
  // leaves system clutter and names beginning with a dot out of its lists and searches. Up to 1.4.8 a file could be
  // saved, received, copied, moved, renamed or brought in under such a name without a word: it then sat on this
  // computer only, or could not be found again.
  const HOME = `${BASE}/home-f`; fs.mkdirSync(`${HOME}/Downloads`, { recursive: true });
  fs.writeFileSync(`${HOME}/Downloads/plain report.txt`, 'A plain report. Marker T18-PLAIN-5540.');
  fs.mkdirSync(T(`${W}/f`), { recursive: true });
  fs.writeFileSync(T(`${W}/f/already here.tmp`), 'was here before');          // exists under such a name already
  const s = await start('names', { TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME });
  await s.call('write_file', { path: `${W}/f/good.txt`, content: 'A good file. Marker T18-GOOD-5541.' });
  await s.call('write_file', { path: `${W}/f/second.txt`, content: 'A second good file. Marker T18-SECOND-5542.' });
  const refused = (r) => r.isError && /cannot be used as a name in Tresorit/.test(r.text) && /Choose another name/.test(r.text);
  const there = (rel) => fs.existsSync(T(rel));

  const notSynced = ['notes.tmp', 'Shortcut.LNK', '~$budget.xlsx', '.~lock.report.odt#', '._resource', 'Thumbs.db', 'DESKTOP.INI', 'draft.onetmp', 'x.kate-swp', 'film.crdownload', 'big.part_1', '.tresorit', 'System Volume Information', '$RECYCLE.BIN', '.VolumeIcon.icns'];
  const bad = [];
  for (const n of notSynced) { const r = await s.call('write_file', { path: `${W}/f/${n}`, content: 'x' }); if (!refused(r) || !/Tresorit does not sync/.test(r.text) || there(`${W}/f/${n}`)) bad.push(`${JSON.stringify(n)}: ${r.text.slice(0, 80)}`); }
  check(`a file is not saved under any of the ${notSynced.length} kinds of name Tresorit does not sync, and the reply says why`, bad.length === 0, bad.join(' | '));

  const hidden = ['.hidden note.txt', '.localized', '.tresorit-settings'];
  const bad2 = [];
  for (const n of hidden) { const r = await s.call('write_file', { path: `${W}/f/${n}`, content: 'x' }); if (!refused(r) || !/out of its lists and searches/.test(r.text) || there(`${W}/f/${n}`)) bad2.push(`${JSON.stringify(n)}: ${r.text.slice(0, 80)}`); }
  check('nor under a name the connector itself would hide (a leading dot, system clutter)', bad2.length === 0, bad2.join(' | '));

  const tries = {
    'a new folder': await s.call('create_folder', { path: `${W}/f/build.tmp` }),
    'a file in a new folder with such a name': await s.call('write_file', { path: `${W}/f/cache.tmp/inner.txt`, content: 'x' }),
    'a rename': await s.call('move_item', { source: `${W}/f/good.txt`, destination: `${W}/f/good.tmp` }),
    'a copy': await s.call('copy_item', { source: `${W}/f/good.txt`, destination: `${W}/f/~$good.txt` }),
    'a file received in parts': await s.call('receive_file', { path: `${W}/f/received.lnk`, part: 1, parts: 1, data: Buffer.from('x').toString('base64'), part_sha256: crypto.createHash('sha256').update('x').digest('hex'), file_sha256: crypto.createHash('sha256').update('x').digest('hex') }),
    'a file brought in from the Mac': await s.call('import_file', { source: `${HOME}/Downloads/plain report.txt`, destination: `${W}/f/brought.crdownload` }),
  };
  const bad3 = Object.entries(tries).filter(([, r]) => !refused(r)).map(([k, r]) => `${k}: ${r.text.slice(0, 90)}`);
  const made = ['build.tmp', 'cache.tmp', 'good.tmp', '~$good.txt', 'received.lnk', 'brought.crdownload'].filter((n) => there(`${W}/f/${n}`));
  check('the same holds for a new folder, a rename, a copy, a file received in parts and a file brought in, and nothing is made', bad3.length === 0 && made.length === 0 && there(`${W}/f/good.txt`), `${bad3.join(' | ')} made: ${made.join(', ')}`);

  // from the transfer folder
  const out = await s.call('export_to_transfer', { path: `${W}/f/second.txt` });
  const tname = path.relative(`${s.DATA}/transfer`, (out.text.split('\n')[1] || '').trim()); // the second line of the reply is where the copy went
  const back = await s.call('import_from_transfer', { name: tname, destination: `${W}/f/back.tmp` });
  check('and for a file brought back from the transfer folder', !out.isError && refused(back) && !there(`${W}/f/back.tmp`), `${out.text.slice(0, 160)} | ${back.text.slice(0, 160)}`);

  const fine = ['template.tmpl', 'my.partition.txt', 'link.lnk.txt', 'tmp', 'a~$b.txt', 'notes.tmp.txt', 'desktop.ini.bak'];
  const bad4 = [];
  for (const n of fine) { const r = await s.call('write_file', { path: `${W}/f/ok/${n}`, content: 'fine' }); if (r.isError || !there(`${W}/f/ok/${n}`)) bad4.push(`${n}: ${r.text.slice(0, 80)}`); }
  check('names that only resemble them are saved as before', bad4.length === 0, bad4.join(' | '));

  const ow = await s.call('write_file', { path: `${W}/f/already here.tmp`, content: 'replaced', overwrite: true });
  const rd = await s.call('file_info', { path: `${W}/f/already here.tmp` });
  const pv = await s.call('delete_items', { paths: [`${W}/f/already here.tmp`] });
  const del = await s.call('delete_items', { paths: [`${W}/f/already here.tmp`], confirm_token: (pv.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1] });
  check('a file that already has such a name can still be replaced, looked at and deleted', !ow.isError && !rd.isError && /already here\.tmp/.test(rd.text) && !del.isError && !there(`${W}/f/already here.tmp`), `${ow.text.slice(0, 100)} | ${rd.text.slice(0, 80)} | ${del.text.slice(0, 100)}`);
  await s.close();
}

console.log('G. A folder brought in leaves out what Tresorit would not sync');
{
  // A folder brought in from the Mac leaves out hidden items, links, applications and key stores, and the reply
  // names them. Up to 1.4.8 a file inside it whose name Tresorit does not sync ("report.tmp", a shortcut ending in
  // ".lnk") was taken along and then sat in Tresorit on this computer only.
  const HOME = `${BASE}/home-g`; const P = `${HOME}/Downloads/Project X`;
  fs.mkdirSync(`${P}/sub`, { recursive: true });
  fs.writeFileSync(`${P}/report.txt`, 'The report. Marker T18-FOLDER-5550.');
  fs.writeFileSync(`${P}/notes.md`, '# Notes');
  fs.writeFileSync(`${P}/draft.tmp`, 'left over');
  fs.writeFileSync(`${P}/Old link.LNK`, 'a shortcut');
  fs.writeFileSync(`${P}/film.crdownload`, 'half a download');
  fs.writeFileSync(`${P}/sub/keep.txt`, 'kept');
  fs.writeFileSync(`${P}/sub/big.part_2`, 'a part');
  fs.writeFileSync(`${P}/.DS_Store`, 'clutter');
  const leftOut = ['draft.tmp', 'Old link.LNK', 'film.crdownload', 'sub/big.part_2'];
  const s = await start('folder', { TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME });
  const token = (t) => (t.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
  const mv = await s.call('import_file', { source: P, destination: `${W}/g/moved`, mode: 'move' });
  check('a folder that holds such files is not moved in: nothing is taken away, and the reply names them', mv.isError && /Nothing was moved/.test(mv.text) && leftOut.every((n) => mv.text.includes(n)) && /Tresorit does not sync/.test(mv.text) && fs.existsSync(`${P}/draft.tmp`) && !fs.existsSync(T(`${W}/g/moved`)), mv.text.slice(0, 500));
  const pv = await s.call('import_file', { source: P, destination: `${W}/g/copied` });
  check('the preview of a copy says which files would be left out, and why', /NOTHING HAS BEEN COPIED/.test(pv.text) && leftOut.every((n) => pv.text.includes(n)) && /Tresorit does not sync/.test(pv.text) && /3 file\(s\)/.test(pv.text), pv.text.slice(0, 600));
  const cp = await s.call('import_file', { source: P, destination: `${W}/g/copied`, confirm_token: token(pv.text) });
  const got = []; const walkIn = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walkIn(`${d}/${e.name}`, r); else got.push(r); } };
  if (fs.existsSync(T(`${W}/g/copied/Project X`))) walkIn(T(`${W}/g/copied/Project X`));
  check('after agreement the folder comes in without them, the reply names them, and the original folder is complete', !cp.isError && got.sort().join(', ') === 'notes.md, report.txt, sub/keep.txt' && leftOut.every((n) => cp.text.includes(n)) && leftOut.every((n) => fs.existsSync(`${P}/${n}`)), `${got.sort().join(', ')} | ${cp.text.slice(0, 400)}`);
  await s.close();
}

console.log('H. A name under "Blocked folders" that matches nothing');
{
  // A blocked folder is named in the settings. A slip of the keyboard there leaves the folder open while the
  // settings look right. Up to 1.4.8 nothing said so. Now the status report warns, and the self-check report says
  // for each blocked name whether it was found. A name is matched as the blocking itself matches it.
  fs.mkdirSync(T(`${W}/h/Sealed`), { recursive: true }); fs.writeFileSync(T(`${W}/h/Sealed/secret.txt`), 'SEALED-5560');
  let s = await start('blocked-found', { TRESORIT_BLOCKED: 'birch labs/T18/h/SEALED' });
  let st = (await s.call('connector_status')).text;
  const rd = await s.call('read_file', { path: `${W}/h/Sealed/secret.txt` });
  check('a blocked name that matches a folder, in whatever capitals, blocks it and brings no warning', /Blocked folders: birch labs\/T18\/h\/SEALED\n/.test(st) && !/WARNING/.test(st) && rd.isError && !/SEALED-5560/.test(rd.text), `${st.split('\n').slice(3, 6).join(' / ')} | ${rd.text.slice(0, 100)}`);
  await s.close();
  s = await start('blocked-slip', { TRESORIT_BLOCKED: `${W}/h/Sealed;${W}/h/Seeled` });
  st = (await s.call('connector_status')).text;
  const warn = st.split('\n').find((l) => l.startsWith('WARNING')) || '';
  check('a blocked name that matches nothing brings a warning in the status report, naming it and only it', /Seeled" under "Blocked folders" matches no folder in Tresorit, so nothing is blocked by that name/.test(warn) && !/h\/Sealed"/.test(warn), st.split('\n').slice(3, 7).join(' / '));
  const pf = await s.call('preflight');
  const line = pf.text.split('\n').find((l) => /Blocked folders:/.test(l)) || '';
  check('and the self-check report says for each blocked name whether it was found', /h\/Sealed \(found\); .*h\/Seeled \(NOT FOUND in Tresorit/.test(line) && /RESULT: PASSED/.test(pf.text), `${line} | ${pf.text.split('\n')[1]}`);
  await s.close();
}

console.log('I. A whole folder is copied out of Tresorit only after a yes in the confirmation window');
{
  // A copy outside Tresorit is not encrypted by it. Up to 1.4.8 a whole folder was copied out to Downloads, to the
  // Desktop or to the transfer folder as soon as it was asked for. Now the connector asks the user first, in its own
  // window on the Mac (or in a box of the Claude app where the app shows one). A single file is copied as before.
  const HOME = `${BASE}/home-i`; fs.mkdirSync(`${HOME}/Downloads`, { recursive: true });
  const answerFile = `${BASE}/window-i-answer.txt`; const shown = `${BASE}/window-i-shown.txt`; fs.rmSync(shown, { force: true });
  const tell = (a) => fs.writeFileSync(answerFile, a);
  const windows = () => { try { return fs.readFileSync(shown, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  fs.mkdirSync(T(`${W}/i/Box`), { recursive: true }); fs.mkdirSync(T(`${W}/i/Crate`), { recursive: true });
  fs.writeFileSync(T(`${W}/i/Box/one.txt`), 'one'); fs.writeFileSync(T(`${W}/i/Box/two.txt`), 'two two');
  fs.writeFileSync(T(`${W}/i/Crate/three.txt`), 'three'); fs.writeFileSync(T(`${W}/i/single.txt`), 'a single file');
  const s = await start('window', { TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME, TRESORIT_CONFIRM_CMD: JSON.stringify([process.execPath, `${TESTS}/lib/confirm-as-told.mjs`]), CONFIRM_ANSWER_FILE: answerFile, CONFIRM_RECORD_FILE: shown });
  const inTransfer = () => { const out = []; const walkIn = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walkIn(`${d}/${e.name}`); else out.push(e.name); } }; try { walkIn(`${s.DATA}/transfer`); } catch { /* empty */ } return out.sort().join(', '); };
  const inDownloads = () => fs.readdirSync(`${HOME}/Downloads`).sort().join(', ');

  tell('no');
  const n1 = await s.call('export_to_transfer', { path: `${W}/i/Box` });
  const n2 = await s.call('export_file', { path: `${W}/i/Box`, to: 'Downloads' });
  check('with "Do not copy" chosen, a folder is copied neither to the transfer folder nor to Downloads, and the reply says so', n1.isError && n2.isError && /Do not copy/.test(n1.text) && /Nothing was copied out/.test(n2.text) && inTransfer() === '' && inDownloads() === '', `${n1.text.slice(0, 150)} | ${n2.text.slice(0, 150)} | transfer: ${inTransfer()} | Downloads: ${inDownloads()}`);
  const w = windows();
  check('the window says which folder, how much and where to, with "Do not copy" as the first button and "Copy out" as the second',
    w.length === 2 && w[0].keep === 'Do not copy' && w[0].action === 'Copy out'
    && w[0].message === `Copy the folder "${W}/i/Box" out of Tresorit?\n\n2 file(s), 10 B, to the transfer folder.\n\nClaude has asked the connector to copy it. The copy is outside Tresorit and is not encrypted by it.`
    && /2 file\(s\), 10 B, to Downloads\./.test(w[1].message), JSON.stringify(w).slice(0, 600));

  tell('');
  const u1 = await s.call('export_to_transfer', { path: `${W}/i/Box` });
  check('a window that is closed, left unanswered or cannot be shown copies nothing', u1.isError && /not answered/.test(u1.text) && inTransfer() === '', `${u1.text.slice(0, 200)} | transfer: ${inTransfer()}`);

  tell('no');
  const several = await s.call('export_to_transfer', { paths: [`${W}/i/Box`, `${W}/i/Crate`, `${W}/i/single.txt`] });
  const last = windows().pop() || {};
  check('several items in one call: one window names every folder among them, and "Do not copy" copies none of the items', several.isError && inTransfer() === '' && /Copy 2 folders out of Tresorit\?/.test(last.message || '') && (last.message || '').includes(`"${W}/i/Box"`) && (last.message || '').includes(`"${W}/i/Crate"`), `${several.text.slice(0, 160)} | ${JSON.stringify(last).slice(0, 300)} | transfer: ${inTransfer()}`);

  const before = windows().length;
  const f1 = await s.call('export_to_transfer', { path: `${W}/i/single.txt` });
  const f2 = await s.call('export_file', { path: `${W}/i/single.txt`, to: 'Downloads' });
  check('a single file is copied out as before, without a window', !f1.isError && !f2.isError && windows().length === before && inTransfer() === 'single.txt' && inDownloads() === 'single.txt', `${f1.text.slice(0, 120)} | ${f2.text.slice(0, 120)} | windows ${windows().length - before}`);

  tell('yes');
  const y1 = await s.call('export_to_transfer', { path: `${W}/i/Box` });
  const y2 = await s.call('export_file', { path: `${W}/i/Box`, to: 'Downloads' });
  const lg = await s.call('access_log', { lines: 30, contains: 'EXPORT' });
  check('with "Copy out" chosen the folder is copied, and the access log notes how it was approved', !y1.isError && !y2.isError && /one\.txt.*two\.txt/.test(inTransfer().replace('single.txt, ', '').replace(', single.txt', '')) && fs.existsSync(`${HOME}/Downloads/Box/two.txt`) && /approved in the connector's window on this Mac/.test(lg.text), `${y1.text.slice(0, 120)} | ${y2.text.slice(0, 120)} | ${lg.text.slice(-260)}`);
  const refusals = await s.call('access_log', { lines: 60, contains: 'EXP-NO' });
  check('each time a folder was not copied out is written to the access log', (refusals.text.match(/EXP-NO/g) || []).length >= 4, refusals.text.slice(-400));
  await s.close();
}

console.log('J. The safeguard for the folders that are not to be indexed');
{
  // Which folders stay out of the search index is a setting, and a setting can be lost or shortened without anyone
  // meaning it. Up to 1.4.8 the background reading began a few seconds after the start with whatever the setting
  // said at that moment. Now the connector remembers the list the user last confirmed on this computer. Until a
  // list has been confirmed, nothing new is read into the index; a folder that drops off the list stays out of
  // it; and the question is asked in a window at the end of a self-check that has passed.
  const answerFile = `${BASE}/window-j-answer.txt`; const shown = `${BASE}/window-j-shown.txt`; fs.rmSync(shown, { force: true });
  const tell = (a) => fs.writeFileSync(answerFile, a);
  const windows = () => { try { return fs.readFileSync(shown, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  fs.mkdirSync(T(`${W}/j/Vault`), { recursive: true });
  fs.writeFileSync(T(`${W}/j/Vault/secret.txt`), 'A secret. VAULT-MARKER-5570.'); fs.writeFileSync(T(`${W}/j/open.txt`), 'An open note. OPEN-MARKER-5571.');
  // The gate of the self-check is in force here, as on a user's Mac (the other parts run with the gate off).
  const gated = (name, noIndex, keep = false) => start(name, { TRESORIT_PREFLIGHT_GATE: 'on', TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_INDEX_INTERVAL_MS: '1000', TRESORIT_OCR: 'false', TRESORIT_NO_INDEX: noIndex,
    TRESORIT_CONFIRM_CMD: JSON.stringify([process.execPath, `${TESTS}/lib/confirm-as-told.mjs`]), CONFIRM_ANSWER_FILE: answerFile, CONFIRM_RECORD_FILE: shown }, keep);
  const entries = (DATA) => { try { return Object.keys(catalogOf(DATA).entries); } catch { return []; } };
  const inVault = (k) => /\/j\/Vault\//.test(k);
  const until = async (DATA, test, tries = 80) => { let keys = []; for (let i = 0; i < tries; i++) { await sleep(500); keys = entries(DATA); if (test(keys)) break; } return keys; };
  const hold = (text) => (text.split('\n').find((l) => l.startsWith('HOLD')) || '');

  let s = await gated('safeguard', `Strongbox;${W}/j/Vault`);
  await sleep(4000); // the background reading would have begun after 200 ms
  let st = (await s.call('connector_status')).text;
  const q0 = await s.call('search_contents', { query: 'OPEN-MARKER-5571', path: `${W}/j` });
  check('on a first start nothing is read into the index: the background reading waits, a search reads nothing new, and the status report says so', entries(s.DATA).length === 0 && /nothing new is read into the search index/.test(hold(st)) && /0 file\(s\) contain/.test(q0.text) && /not searched/.test(q0.text), `${entries(s.DATA).length} in the index | ${hold(st)} | ${q0.text.slice(0, 300)}`);
  const r0 = await s.call('read_file', { path: `${W}/j/open.txt` });
  check('a file asked for by name is still read meanwhile, and nothing of it is kept in the index', !r0.isError && /OPEN-MARKER-5571/.test(r0.text) && entries(s.DATA).length === 0, `${r0.text.slice(0, 120)} | ${entries(s.DATA).length} in the index`);

  tell('no');
  let pf = await s.call('preflight'); await sleep(2500);
  let w = windows().pop() || {};
  check('the self-check, once it has passed, asks in a window; "Stop", its first button, leaves the hold in force', /RESULT: PASSED/.test(pf.text) && /HOLD/.test(pf.text) && w.keep === 'Stop' && w.action === 'Start' && entries(s.DATA).length === 0, `${pf.text.split('\n')[1]} | ${hold(pf.text)} | ${w.keep}/${w.action} | ${entries(s.DATA).length} in the index`);
  check('that window names the folders that will not be read into the index', w.message === `Start reading documents into the search index on this Mac?\n\nThese folders will NOT be read into it:\n- Strongbox\n- ${W}/j/Vault\n\nEverything else in Tresorit will be read. The index keeps a copy of the text on this Mac, outside Tresorit.`, JSON.stringify(w.message));
  const shownSoFar = windows().length;
  const [pa, pb] = await Promise.all([s.call('preflight'), s.call('preflight')]); await sleep(1000);
  check('two self-check requests made at the same instant share the one run and the one question', windows().length === shownSoFar + 1 && pa.text === pb.text && /HOLD/.test(pa.text), `${windows().length - shownSoFar} window(s); same reply: ${pa.text === pb.text}`);

  tell('yes');
  pf = await s.call('preflight');
  let keys = await until(s.DATA, (k) => k.some((x) => x.endsWith('/j/open.txt')));
  st = (await s.call('connector_status')).text;
  check('after "Start" the documents are read into the index, the folders named are not, and the hold is gone', keys.some((x) => x.endsWith('/j/open.txt')) && !keys.some((x) => inVault(x) || x.startsWith('Strongbox/')) && hold(st) === '' && /confirmed on this Mac/.test(pf.text), `${keys.length} in the index; vault in it: ${keys.some(inVault)} | ${hold(st)} | ${pf.text.split('\n').slice(-3).join(' / ').slice(0, 300)}`);
  await s.close(); await sleep(300);

  // The list gets shorter: the vault is no longer in the settings.
  s = await gated('safeguard', 'Strongbox', true);
  await sleep(4000);
  st = (await s.call('connector_status')).text;
  const q1 = await s.call('search_contents', { query: 'VAULT-MARKER-5570', path: `${W}/j` });
  check('a folder that drops off the list stays out of the index, and the status report names it', hold(st).includes(`${W}/j/Vault`) && !entries(s.DATA).some(inVault) && /0 file\(s\) contain/.test(q1.text), `${hold(st)} | vault in the index: ${entries(s.DATA).some(inVault)} | ${q1.text.slice(0, 200)}`);
  tell('no');
  pf = await s.call('preflight'); await sleep(2500);
  w = windows().pop() || {};
  check('the self-check asks about it; "Keep them out", its first button, keeps the folder out', w.keep === 'Keep them out' && w.action === 'Read them in' && w.message === `These folders are no longer set as "do not index":\n- ${W}/j/Vault\n\nUntil now they were kept out of the search index. Read them into it now?` && !entries(s.DATA).some(inVault) && /HOLD/.test(pf.text), `${JSON.stringify(w).slice(0, 400)} | vault in the index: ${entries(s.DATA).some(inVault)}`);
  tell('yes');
  pf = await s.call('preflight');
  keys = await until(s.DATA, (k) => k.some(inVault));
  check('after "Read them in" the folder is read into the index', keys.some(inVault) && hold((await s.call('connector_status')).text) === '', `vault in the index: ${keys.some(inVault)}`);
  await s.close(); await sleep(300);

  // A folder added to the list needs no yes. It is taken out of the index at once, and it is remembered.
  s = await gated('safeguard', `Strongbox;${W}/j/Vault`, true);
  await sleep(3000);
  st = (await s.call('connector_status')).text; const afterAdding = entries(s.DATA);
  await s.close(); await sleep(300);
  s = await gated('safeguard', 'Strongbox', true);
  await sleep(2000);
  const st2 = (await s.call('connector_status')).text;
  check('a folder added to the list needs no yes: it leaves the index at once, and it is remembered (taking it off again brings the hold)', hold(st) === '' && !afterAdding.some(inVault) && hold(st2).includes(`${W}/j/Vault`) && !entries(s.DATA).some(inVault), `after adding: "${hold(st)}", vault in the index: ${afterAdding.some(inVault)} | after taking it off: ${hold(st2)}`);
  await s.close(); await sleep(300);

  // A first start with no folder set at all, on a computer that already has an index.
  const NONE = `${BASE}/safeguard-none`; fs.rmSync(NONE, { recursive: true, force: true }); fs.mkdirSync(`${NONE}/index`, { recursive: true });
  fs.writeFileSync(`${NONE}/index/catalog.json`, JSON.stringify({ v: 3, entries: { 'Birch Labs/gone long ago.txt': { s: 1, m: 1, st: 'ok', c: 1, n: '' } } }));
  s = await gated('safeguard-none', 'none', true);
  tell('no');
  pf = await s.call('preflight'); await sleep(2000);
  w = windows().pop() || {};
  check('with no folder set, the window says so in so many words, and that an index already exists on this computer', w.keep === 'Stop' && w.action === 'Start' && w.message === 'No folder is set as "do not index". A search index already exists on this Mac.\n\nEvery document in Tresorit will be read into the search index, which keeps a copy of the text on this Mac, outside Tresorit. If some folders must stay out of it, press Stop, enter them in the connector\'s settings and run the self-check again.' && /HOLD/.test(pf.text), JSON.stringify(w).slice(0, 500));
  await s.close();
}

console.log('K. The first start after an update: an index left by an earlier version, and the settings empty');
{
  // What happens on a Mac at the update to 1.5.0: the data folder holds the index an earlier version
  // made (with two folders kept out of it), the app has asked for all settings again, so no folder is set as "do
  // not index", and nothing has been confirmed on this computer yet. Nothing of those folders may reach the index.
  const answerFile = `${BASE}/window-k-answer.txt`; const shown = `${BASE}/window-k-shown.txt`; fs.rmSync(shown, { force: true });
  const tell = (a) => fs.writeFileSync(answerFile, a);
  const windows = () => { try { return fs.readFileSync(shown, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  fs.mkdirSync(T(`${W}/k/Vault`), { recursive: true });
  fs.writeFileSync(T(`${W}/k/Vault/secret.txt`), 'A secret. VAULT-MARKER-5580.'); fs.writeFileSync(T(`${W}/k/open.txt`), 'An open note. OPEN-MARKER-5581.');
  const common = { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_INDEX_INTERVAL_MS: '1000', TRESORIT_OCR: 'false', TRESORIT_CONFIRM_CMD: JSON.stringify([process.execPath, `${TESTS}/lib/confirm-as-told.mjs`]), CONFIRM_ANSWER_FILE: answerFile, CONFIRM_RECORD_FILE: shown };
  const entries = (DATA) => { try { return Object.keys(catalogOf(DATA).entries); } catch { return []; } };
  const inVault = (k) => /\/k\/Vault\//.test(k);
  // The earlier version: no safeguard, the vault kept out by its setting. (Played by this connector with the gate
  // off, which reads as every version before 1.5.0 did and remembers no list.)
  let s = await start('update', { ...common, TRESORIT_NO_INDEX: `Strongbox;${W}/k/Vault` });
  let keys = []; for (let i = 0; i < 80; i++) { await sleep(500); keys = entries(s.DATA); if (keys.some((x) => x.endsWith('/k/open.txt'))) break; }
  const before = keys.length;
  await s.close(); await sleep(300);
  check('the data folder is as an earlier version left it: an index without the vault, and no confirmed list', before > 5 && !keys.some(inVault) && !fs.existsSync(`${s.DATA}/index/not-indexed.confirmed.json`), `${before} in the index; vault in it: ${keys.some(inVault)}`);

  // 1.5.0 starts on it, with the settings empty and the self-check not yet run.
  s = await start('update', { ...common, TRESORIT_PREFLIGHT_GATE: 'on', TRESORIT_NO_INDEX: 'none' }, true);
  await sleep(5000);
  const st = (await s.call('connector_status')).text;
  const qv = await s.call('search_contents', { query: 'VAULT-MARKER-5580' });
  const qo = await s.call('search_contents', { query: 'OPEN-MARKER-5581' });
  keys = entries(s.DATA);
  check('nothing of the vault reaches the index, though no folder is set any more; what was indexed is still found',
    !keys.some(inVault) && keys.length === before && /^HOLD: nothing new is read into the search index/m.test(st) && /0 file\(s\) contain/.test(qv.text) && /1 file\(s\) contain/.test(qo.text) && qo.text.includes('open.txt'),
    `${keys.length} in the index (before: ${before}); vault in it: ${keys.some(inVault)} | ${qv.text.slice(0, 160)} | ${qo.text.slice(0, 80)}`);
  tell('no');
  const pf = await s.call('preflight'); await sleep(2500);
  const w = windows().pop() || {};
  check('the self-check then says in its window that no folder is set and that an index already exists, and "Stop" keeps everything as it is', /RESULT: PASSED/.test(pf.text) && /^No folder is set as "do not index"\. A search index already exists on this Mac\./.test(w.message || '') && w.keep === 'Stop' && !entries(s.DATA).some(inVault) && entries(s.DATA).length === before, `${(w.message || '').slice(0, 120)} | ${entries(s.DATA).length} in the index`);
  await s.close(); await sleep(300);

  // The user enters the folders in the settings and runs the self-check again.
  s = await start('update', { ...common, TRESORIT_PREFLIGHT_GATE: 'on', TRESORIT_NO_INDEX: `Strongbox;${W}/k/Vault` }, true);
  fs.writeFileSync(T(`${W}/k/new.txt`), 'A new note. NEW-MARKER-5582.');
  tell('yes');
  const pf2 = await s.call('preflight');
  const w2 = windows().pop() || {};
  for (let i = 0; i < 80; i++) { await sleep(500); keys = entries(s.DATA); if (keys.some((x) => x.endsWith('/k/new.txt'))) break; }
  check('with the folders entered and confirmed, reading goes on where it stopped, and the vault stays out', (w2.message || '').includes(`- ${W}/k/Vault`) && /confirmed on this Mac/.test(pf2.text) && keys.some((x) => x.endsWith('/k/new.txt')) && !keys.some(inVault), `${(w2.message || '').slice(0, 160)} | new note in the index: ${keys.some((x) => x.endsWith('/k/new.txt'))}; vault in it: ${keys.some(inVault)}`);
  await s.close();
}

console.log('L. A word split at the end of a line is found whole');
{
  // Many documents, PDFs above all, split a word at the end of a line: "agree-" and, on the next line, "ment". Up
  // to 1.4.8 a search for "agreement" did not find it. The split is now closed in the form that is searched and
  // shown in excerpts, and only there: the stored text keeps the document as it is. Search forms made by an
  // earlier version are made again from the stored text, without any document being read again.
  const { TextIndex } = await serverLib('textindex.js'); const { foldText } = await serverLib('textutil.js');
  fs.mkdirSync(T(`${W}/l`), { recursive: true });
  const text = ['Minutes of the meeting. The new agree-', 'ment was signed on Friday by the inter-', '   national office, which takes respon­', 'sibility for it. A well-', 'known supplier was named.',
    'Present: Mrs Müller-', 'Schmidt and two others.', 'Items:', '- first the budget', '- second the dates', 'The cost -', 'benefit note is attached.'].join('\n');
  fs.writeFileSync(T(`${W}/l/minutes.txt`), text);
  let s = await start('lineend');
  const find = async (query, match = 'phrase') => (await s.call('search_contents', { query, path: `${W}/l`, match })).text;
  const whole = [await find('agreement'), await find('international'), await find('responsibility'), await find('agreement was signed on friday'), await find('the international office')];
  check('a word split at the end of a line is found whole, by itself and inside a phrase (hyphen, spaces before the next line, soft hyphen)', whole.every((t) => /1 file\(s\) contain/.test(t) && t.includes('minutes.txt')), whole.map((t) => t.split('\n')[0]).join(' | '));
  const rd = await s.call('read_file', { path: `${W}/l/minutes.txt` });
  check('the excerpt shows the word joined, and the file is still read exactly as it was written', /new agreement was signed/.test(whole[0]) && rd.text.includes('The new agree-\nment was signed'), `${whole[0].slice(0, 300)} | ${JSON.stringify(rd.text.slice(0, 160))}`);
  const parts = [await find('agree'), await find('known supplier'), await find('Müller- Schmidt'), await find('- first the budget - second the dates'), await find('cost - benefit')];
  check('parts of such a word are found as before, and what is not such a split is left as it was: a capital after the hyphen, a list, a hyphen with a space before it', parts.every((t) => /1 file\(s\) contain/.test(t)), parts.map((t) => t.split('\n')[0]).join(' | '));
  await s.close(); await sleep(300);

  // An index as an earlier version left it: the search form in the earlier form, and no note of its form.
  const ix = new TextIndex(`${s.DATA}/index`);
  const key = Object.keys(catalogOf(s.DATA).entries).find((k) => k.endsWith('/l/minutes.txt'));
  const earlier = Buffer.from(foldText(text.normalize('NFC').replace(/\s+/g, ' ')), 'utf8');
  fs.writeFileSync(ix._foldFile(key), earlier);
  const cat = catalogOf(s.DATA); delete cat.entries[key].fv; cat.entries[key].f = earlier.length;
  fs.writeFileSync(`${s.DATA}/index/catalog.json`, JSON.stringify(cat));
  fs.chmodSync(T(`${W}/l/minutes.txt`), 0o000); // the document itself cannot be opened now: only the stored text can serve
  let again = ''; let after = null; let formNow = '';
  try {
    s = await start('lineend', {}, true);
    again = await find('agreement was signed');
    for (let i = 0; i < 40; i++) { await sleep(250); after = catalogOf(s.DATA).entries[key]; if (after && after.fv) break; }
    await s.close(); await sleep(300);
    formNow = fs.readFileSync(ix._foldFile(key), 'utf8');
  } finally { fs.chmodSync(T(`${W}/l/minutes.txt`), 0o644); }
  check('an index left by an earlier version: the word is found at once from the stored text, the search form is made again from it, and the document is not read again', /1 file\(s\) contain/.test(again) && after && after.st === 'ok' && after.fv === 2 && formNow.includes('new agreement was signed') && !formNow.includes('agree- ment'), `${again.split('\n')[0]} | ${JSON.stringify(after)} | ${formNow.slice(0, 80)}`);
}

console.log('M. No folder is kept out of the index unless the settings name it');
{
  // Up to 1.4.8 two folder names were built into the program as the default of "folders not to index". The program
  // now names no folder: the list is what the settings say, and empty until they say something. (What is entered
  // there is guarded by the safeguard of parts J and K.)
  fs.mkdirSync(T('Strongbox/m'), { recursive: true }); fs.writeFileSync(T('Strongbox/m/note.txt'), 'A note. DEFAULT-MARKER-5590.');
  let s = await start('no-names');
  let st = (await s.call('connector_status')).text;
  let q = await s.call('search_contents', { query: 'DEFAULT-MARKER-5590' });
  check('with nothing entered, no folder is set as "do not index", and a folder that used to be kept out by default is searched like any other', /^Not indexed \(read only when asked for by name, never searched\): none$/m.test(st) && /1 file\(s\) contain/.test(q.text) && q.text.includes('Strongbox/m/note.txt'), `${(st.match(/^Not indexed.*$/m) || [''])[0]} | ${q.text.slice(0, 160)}`);
  await s.close(); await sleep(300);
  s = await start('no-names', { TRESORIT_NO_INDEX: 'Strongbox' }, true);
  st = (await s.call('connector_status')).text;
  q = await s.call('search_contents', { query: 'DEFAULT-MARKER-5590' });
  const rd = await s.call('read_file', { path: 'Strongbox/m/note.txt' });
  await s.close(); await sleep(300); // (the index is saved when the connector closes)
  check('entered in the settings, the folder is kept out as before: named in the status report, not searched, taken out of the index, still read by name', /^Not indexed \(read only when asked for by name, never searched\): Strongbox$/m.test(st) && /0 file\(s\) contain/.test(q.text) && /were not searched/.test(q.text) && !Object.keys(catalogOf(s.DATA).entries).some((k) => k.startsWith('Strongbox/')) && /DEFAULT-MARKER-5590/.test(rd.text), `${(st.match(/^Not indexed.*$/m) || [''])[0]} | ${q.text.slice(0, 200)}`);
  fs.rmSync(T('Strongbox/m'), { recursive: true, force: true });
}

console.log('N. The manifest states the licence once');
{
  // The manifest of 1.5.0-rc.1 carried "license" twice, as MIT near its top and as UNLICENSED further down. Whoever
  // reads the file takes the later one, so the app saw UNLICENSED while package.json and the LICENSE file said MIT.
  const top = path.join(path.dirname(SERVER), '..');
  const text = fs.readFileSync(path.join(top, 'manifest.json'), 'utf8');
  const names = [...text.matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]);
  const twice = [...new Set(names.filter((k, i) => names.indexOf(k) !== i))];
  const pkg = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8'));
  const lic = fs.readFileSync(path.join(top, 'LICENSE'), 'utf8');
  check('every entry of the manifest is there once, and the licence it gives is MIT, as in package.json and in the LICENSE file', names.length > 10 && twice.length === 0 && JSON.parse(text).license === 'MIT' && pkg.license === 'MIT' && /^MIT License/.test(lic), `entries: ${names.length}; there twice: ${twice.join(', ') || 'none'}; the manifest gives "${JSON.parse(text).license}", package.json "${pkg.license}"`);
}

console.log('O. A rebuild of the index is refused while nothing new may be read into it');
{
  // Until the list of folders not to index has been confirmed on a computer, nothing new is read into the index.
  // In 1.5.0-rc.1 a rebuild asked for during that time still threw the index away, and nothing was read to fill
  // it again: every search came back empty until the yes, and then every document had to be read once more.
  fs.mkdirSync(T(`${W}/o`), { recursive: true }); fs.writeFileSync(T(`${W}/o/open.txt`), 'An open note. OPEN-MARKER-5600.');
  const entries = (DATA) => { try { return Object.keys(catalogOf(DATA).entries); } catch { return []; } };
  const answerFile = `${BASE}/window-o-answer.txt`; fs.writeFileSync(answerFile, 'no');
  const common = { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_INDEX_INTERVAL_MS: '1000', TRESORIT_OCR: 'false', TRESORIT_NO_INDEX: 'Strongbox',
    TRESORIT_CONFIRM_CMD: JSON.stringify([process.execPath, `${TESTS}/lib/confirm-as-told.mjs`]), CONFIRM_ANSWER_FILE: answerFile, CONFIRM_RECORD_FILE: `${BASE}/window-o-shown.txt` };
  const filled = async (DATA) => { let keys = []; for (let i = 0; i < 80; i++) { await sleep(500); keys = entries(DATA); if (keys.some((x) => x.endsWith('/o/open.txt'))) break; } return keys; };
  // An earlier version leaves its index (played by this connector with the gate off, as in part K).
  let s = await start('rebuild-hold', common);
  const before = (await filled(s.DATA)).length;
  await s.close(); await sleep(300);
  // 1.5.0 starts on it: nothing has been confirmed on this computer, so everything is on hold.
  s = await start('rebuild-hold', { ...common, TRESORIT_PREFLIGHT_GATE: 'on' }, true);
  await sleep(3000);
  const q0 = await s.call('search_contents', { query: 'OPEN-MARKER-5600' });
  const rb = await s.call('connector_status', { rebuild_index: true }); await sleep(3000);
  const q1 = await s.call('search_contents', { query: 'OPEN-MARKER-5600' });
  const st = (await s.call('connector_status')).text;
  check('a rebuild asked for during the hold is refused with the reason, and the index stays as it was',
    before > 5 && /^HOLD: nothing new/m.test(st) && rb.isError && /not available yet/.test(rb.text) && /tresorit_preflight/.test(rb.text) && entries(s.DATA).length === before && /1 file\(s\) contain/.test(q0.text) && /1 file\(s\) contain/.test(q1.text),
    `index before: ${before}, after the request: ${entries(s.DATA).length} | reply: ${rb.text.slice(0, 260)} | search afterwards: ${q1.text.slice(0, 120)}`);
  // The hold ends (here as when another copy of the connector has had the yes): a rebuild is done as before.
  fs.writeFileSync(`${s.DATA}/index/not-indexed.confirmed.json`, JSON.stringify({ folders: ['Strongbox'], when: new Date().toISOString(), version: 'test' }));
  await sleep(2600);
  const rb2 = await s.call('connector_status', { rebuild_index: true });
  const keys = await filled(s.DATA); await sleep(1500);
  const q2 = await s.call('search_contents', { query: 'OPEN-MARKER-5600' });
  check('once the hold has ended, a rebuild is done as before', !rb2.isError && !/^HOLD/m.test(rb2.text) && keys.some((x) => x.endsWith('/o/open.txt')) && /1 file\(s\) contain/.test(q2.text), `${rb2.text.slice(0, 160)} | ${keys.length} in the index | ${q2.text.slice(0, 100)}`);
  await s.close();
}

console.log('P. During the hold a search opens no document again that the index has a record of');
{
  // While nothing new may be read into the index, a document that is not in it is read without being kept. In
  // 1.5.0-rc.1 a search did the same for every document the index knows as not readable (protected, damaged,
  // empty, a scan waiting for text recognition): each was opened again in every search, a scan even put through
  // text recognition on the spot. Now a search answers from the record, as it does without a hold. Only reading a
  // file by name goes to the file.
  // Arranged so that it shows: the index records a damaged document. Then the file gets readable content of the
  // same size and date, so the record still stands. A search that finds the new words has opened the file.
  const dir = T('Alder Works UK/03 - Finance'); const nda = fs.readdirSync(dir).find((n) => n.startsWith('NDA') && n.endsWith('.docx'));
  const good = fs.readFileSync(`${dir}/${nda}`); const when = new Date('2026-03-04T10:00:00Z');
  fs.mkdirSync(T(`${W}/p`), { recursive: true }); const doc = T(`${W}/p/agreement.docx`);
  fs.writeFileSync(doc, Buffer.alloc(good.length, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x01]))); fs.utimesSync(doc, when, when); // the first bytes of a Word file, and nothing readable after them
  const record = (DATA) => { const hit = Object.entries(catalogOf(DATA).entries).find(([k]) => /\/p\/agreement\.docx$/i.test(k)); return hit ? hit[1] : null; };
  const common = { TRESORIT_NO_INDEX: 'Strongbox', TRESORIT_OCR: 'false' };
  // An earlier version reads the damaged document and records it (played with the gate off, as in part K).
  let s = await start('hold-search', common);
  const qa = await s.call('search_contents', { query: 'clausula', path: `${W}/p` });
  await s.close(); await sleep(300);
  const rec = record(s.DATA);
  check('the index left behind records the document as not readable', Boolean(rec) && rec.st !== 'ok' && /0 file\(s\) contain/.test(qa.text), `${JSON.stringify(rec).slice(0, 200)} | ${qa.text.slice(0, 120)}`);
  fs.writeFileSync(doc, good); fs.utimesSync(doc, when, when);
  // 1.5.0 starts on that data folder with nothing confirmed: everything is on hold.
  s = await start('hold-search', { ...common, TRESORIT_PREFLIGHT_GATE: 'on', TRESORIT_CONFIRM_CMD: JSON.stringify([process.execPath, `${TESTS}/lib/confirm-yes.mjs`]) }, true);
  const st = (await s.call('connector_status')).text;
  const q = await s.call('search_contents', { query: 'clausula', path: `${W}/p` });
  check('a search during the hold answers from that record and does not open the document again', /^HOLD: nothing new/m.test(st) && /0 file\(s\) contain/.test(q.text), `${(st.match(/^HOLD.*$/m) || ['no HOLD line'])[0].slice(0, 60)} | ${q.text.slice(0, 200)}`);
  const rd = await s.call('read_file', { path: `${W}/p/agreement.docx` });
  await s.close(); await sleep(300);
  const rec2 = record(s.DATA);
  check('the same file asked for by name during the hold is read from the file, and the record in the index stays as it was', !rd.isError && /cl[aá]usula/i.test(rd.text.normalize('NFC')) && JSON.stringify(rec2) === JSON.stringify(rec), `${rd.text.slice(0, 160)} | record: ${JSON.stringify(rec2).slice(0, 120)}`);
}

console.log('Q. Three replies give the hold as the reason while it lasts');
{
  // While nothing new may be read into the index, three replies of 1.5.0-rc.1 gave a reason that was not true: a
  // file read by name was said to be in a folder set as "do not index"; documents not yet read were said not to
  // have been reached by the background reading; and the status report said another copy did that reading.
  fs.mkdirSync(T(`${W}/q`), { recursive: true }); fs.writeFileSync(T(`${W}/q/open.txt`), 'An open note. OPEN-MARKER-5610.');
  fs.mkdirSync(T('Strongbox/q'), { recursive: true }); fs.writeFileSync(T('Strongbox/q/note.txt'), 'A note. KEPT-OUT-MARKER-5611.');
  const HELD = 'nothing new is read into the search index until the list of folders that are not to be indexed has been confirmed on this Mac';
  // A first start: nothing confirmed on this computer, everything on hold. (No pass is due during this part.)
  const s = await start('hold-words', { TRESORIT_PREFLIGHT_GATE: 'on', TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_OCR: 'false', TRESORIT_NO_INDEX: 'Strongbox', TRESORIT_CONFIRM_CMD: JSON.stringify([process.execPath, `${TESTS}/lib/confirm-yes.mjs`]) });
  const rd = await s.call('read_file', { path: `${W}/q/open.txt` });
  const rk = await s.call('read_file', { path: 'Strongbox/q/note.txt' });
  check('a file read by name during the hold: the note gives the hold as the reason, and names "do not index" only for a folder that is set so',
    /OPEN-MARKER-5610/.test(rd.text) && rd.text.includes(`read directly from the file; ${HELD}, so its text is not kept or searched`) && !/this folder is set as "do not index"/.test(rd.text)
    && /KEPT-OUT-MARKER-5611/.test(rk.text) && rk.text.includes('read directly from the file; this folder is set as "do not index", so its text is not kept or searched'), `${rd.text.slice(0, 330)} | ${rk.text.slice(0, 260)}`);
  const lu = await s.call('list_unreadable', { path: `${W}/q` });
  const st = (await s.call('connector_status')).text;
  const by = (text) => (text.split('\n').find((l) => l.startsWith('Background reading is done by:')) || '');
  check('the list of unreadable files gives the hold as the reason why documents have not been read yet', lu.text.includes(`1 document(s) have not been read yet (${HELD}).`) && !/has not reached them/.test(lu.text), lu.text.slice(0, 400));
  check('the status report names no copy as doing the background reading', /^HOLD: nothing new/m.test(st) && by(st) === 'Background reading is done by: no copy of this version of the connector for now (see the line HOLD above)', by(st));
  // The hold ends (here as when another copy of the connector has had the yes): the usual words are back.
  fs.writeFileSync(`${s.DATA}/index/not-indexed.confirmed.json`, JSON.stringify({ folders: ['Strongbox'], when: new Date().toISOString(), version: 'test' }));
  await sleep(2600);
  const lu2 = await s.call('list_unreadable', { path: `${W}/q` });
  const st2 = (await s.call('connector_status')).text;
  check('once the hold has ended, both say what they said before', /have not been read yet \(the background reading has not reached them\)\./.test(lu2.text) && !/^HOLD/m.test(st2) && /^Background reading is done by: (this copy of the connector|another copy of the connector \(another Claude window\))$/.test(by(st2)), `${lu2.text.slice(0, 300)} | ${by(st2)}`);
  await s.close();
  fs.rmSync(T('Strongbox/q'), { recursive: true, force: true });
}

console.log('R. A name under "Folders not to index" that matches no folder');
{
  // The safeguard protects the list as it is typed. In 1.5.0-rc.1 a name with a slip of the keyboard stood in the
  // confirmation window like any other, and after "Start" the folder it was meant for was read into the index.
  // Now the window marks each name that matches no folder and says that such a name protects nothing, and the
  // status report warns, as it does for "Blocked folders".
  const answerFile = `${BASE}/window-r-answer.txt`; const shown = `${BASE}/window-r-shown.txt`; fs.rmSync(shown, { force: true });
  const windows = () => { try { return fs.readFileSync(shown, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  fs.mkdirSync(T(`${W}/r/Vault`), { recursive: true }); fs.writeFileSync(T(`${W}/r/Vault/secret.txt`), 'A secret. VAULT-MARKER-5620.');
  const gated = (noIndex) => start('slip', { TRESORIT_PREFLIGHT_GATE: 'on', TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_INDEX_INTERVAL_MS: '1000', TRESORIT_OCR: 'false', TRESORIT_NO_INDEX: noIndex,
    TRESORIT_CONFIRM_CMD: JSON.stringify([process.execPath, `${TESTS}/lib/confirm-as-told.mjs`]), CONFIRM_ANSWER_FILE: answerFile, CONFIRM_RECORD_FILE: shown });
  const warning = (text) => (text.split('\n').find((l) => l.startsWith('WARNING') && l.includes('Folders not to index')) || '');
  // "Crypto Wallet" for "Strongbox"; the second name is right, in other capitals.
  const typed = `${W}/r/vault`.toUpperCase();
  let s = await gated(`Crypto Wallet; ${typed}`);
  const st = (await s.call('connector_status')).text;
  check('the status report warns about the name that matches no folder, and only about that one', warning(st) === 'WARNING: "Crypto Wallet" under "Folders not to index" matches no folder in Tresorit, so nothing is kept out of the search index by that name. Check the spelling in the connector\'s settings (Settings > Extensions > Tresorit).', warning(st) || '(no such line)');
  fs.writeFileSync(answerFile, 'no');
  const pf = await s.call('preflight'); await sleep(2000);
  const w = windows().pop() || {};
  check('the confirmation window marks that name and says that it protects nothing; "Stop" is still its first button',
    /RESULT: PASSED/.test(pf.text) && w.keep === 'Stop' && w.action === 'Start' && w.message === `Start reading documents into the search index on this Mac?\n\nThese folders will NOT be read into it:\n- Crypto Wallet   (NOT FOUND in Tresorit)\n- ${typed}\n\nA name marked NOT FOUND matches no folder in Tresorit and protects nothing. If it is a typing slip, press Stop, correct the name in the connector's settings and run the self-check again.\n\nEverything else in Tresorit will be read. The index keeps a copy of the text on this Mac, outside Tresorit.`, JSON.stringify(w.message));
  await s.close(); await sleep(300);
  // With every name right, no warning (the window without a mark is checked word for word in part J).
  s = await gated(`Strongbox; ${W}/r/Vault`);
  const st2 = (await s.call('connector_status')).text;
  check('with every name matching a folder there is no such warning', warning(st2) === '' && /^Not indexed/m.test(st2), warning(st2));
  await s.close();
}

console.log('S. The status report names every change the user is asked about');
{
  // Since step 9 a whole folder is copied out of Tresorit only after a yes, asked the same way as before a
  // deletion. The line of the status report that says how the user is asked spoke of deleting only.
  const s = await start('asked-line');
  const st = (await s.call('connector_status')).text;
  const line = st.split('\n').find((l) => / the user is asked: /.test(l)) || '';
  check('the line that says how the user is asked names deleting, removing for good and copying a whole folder out', /^Before deleting, removing for good or copying a whole folder out of Tresorit, the user is asked: \S/.test(line), line || '(no such line)');
  await s.close();
}

console.log('T. The box of the Claude app waits two minutes for an answer, like the window on the Mac');
{
  // Where the Claude app shows a confirmation box of its own, the connector waited five minutes for the answer.
  // The question before a whole folder is copied out is asked while that copy has its turn, and a change that
  // waits its turn behind another gives up after five minutes too: a change asked for behind an unanswered box
  // could be refused only because nobody answered the box. Now the box waits two minutes, as the connector's own
  // window does: the change behind it is delayed and then carried out.
  // (This part waits those two minutes in real time, without any shortened setting.)
  const HOME = `${BASE}/home-t`; fs.mkdirSync(`${HOME}/Downloads`, { recursive: true });
  fs.mkdirSync(T(`${W}/t/Box`), { recursive: true }); fs.writeFileSync(T(`${W}/t/Box/one.txt`), 'one');
  const DATA = `${BASE}/box-wait`; fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_HOLDING_DAYS: '0' };
  delete env.TRESORIT_ELICIT_TIMEOUT_MS; delete env.TRESORIT_CHANGE_WAIT_MS;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: { elicitation: {} } });
  let asked = 0; client.setRequestHandler(ElicitRequestSchema, () => { asked++; return new Promise(() => {}); }); // a box that nobody answers
  await client.connect(transport);
  const call = async (tool, args = {}) => { const t0 = Date.now(); try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 200000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError, ms: Date.now() - t0 }; } catch (e) { return { text: `CALL FAILED: ${e.message}`, isError: true, ms: Date.now() - t0 }; } };
  const out = call('export_file', { path: `${W}/t/Box`, to: 'Downloads' });
  await sleep(1500);
  const wr = call('write_file', { path: `${W}/t/behind.txt`, content: 'written behind an unanswered box' });
  const [x, w] = await Promise.all([out, wr]);
  check('a box left unanswered is given up after two minutes, and nothing is copied out', asked === 1 && x.isError && /not answered, so nothing was copied out/.test(x.text) && x.ms > 100000 && x.ms < 140000 && fs.readdirSync(`${HOME}/Downloads`).length === 0, `${Math.round(x.ms / 1000)} s; box shown ${asked} time(s) | ${x.text.slice(0, 160)}`);
  check('a change asked for behind that box is carried out once the box has been given up, not refused', !w.isError && fs.existsSync(T(`${W}/t/behind.txt`)) && w.ms > 100000 && w.ms < 150000, `${Math.round(w.ms / 1000)} s | ${w.text.slice(0, 200)}`);
  try { await client.close(); } catch { /* closing with the unanswered box still open */ }
}

console.log('U. Two copies of the connector asked for the self-check at the same moment');
{
  // Each Claude window runs its own copy of the connector on the same data folder. The self-check works in a
  // scratch folder named after the time, to the second: two copies asked within the same second shared one
  // scratch folder, and both failed (on the safe side; a second try passed). Now each copy has its own.
  const answerFile = `${BASE}/window-u-answer.txt`; fs.writeFileSync(answerFile, 'no');
  const env = { TRESORIT_PREFLIGHT_GATE: 'on', TRESORIT_OCR: 'false', TRESORIT_NO_INDEX: 'Strongbox', TRESORIT_CONFIRM_CMD: JSON.stringify([process.execPath, `${TESTS}/lib/confirm-as-told.mjs`]), CONFIRM_ANSWER_FILE: answerFile, CONFIRM_RECORD_FILE: `${BASE}/window-u-shown.txt` };
  const a = await start('two-checks', env); const b = await start('two-checks', env, true);
  // (started together; if the clock happens to turn a second between the two, the old fault does not show)
  const [ra, rb] = await Promise.all([a.call('preflight'), b.call('preflight')]);
  const result = (r) => (r.text.match(/RESULT[^\n]*/) || [r.text.slice(0, 160)])[0];
  check('both pass', /RESULT: PASSED/.test(ra.text) && /RESULT: PASSED/.test(rb.text), `copy 1: ${result(ra)} | copy 2: ${result(rb)}`);
  const left = (() => { try { return fs.readdirSync(`${a.DATA}/preflight`); } catch { return []; } })();
  check('and both scratch folders are removed afterwards', left.length === 0, left.join(', '));
  await a.close(); await b.close();
}

console.log('V. A copy of another version that does the background reading is named in the status report');
{
  // If the extension of an earlier version is left installed beside this one, its copy can be the one that does
  // the background reading, by its own rules: a folder set as "do not index" here is read into the index by it.
  // Up to 1.5.0-rc.1 the status report said only "another copy of the connector". Now the copy that reads says
  // which version it is, and the status report warns when that is not this one.
  const DATA = `${BASE}/other-version`; fs.rmSync(DATA, { recursive: true, force: true });
  const old = spawn(process.execPath, [`${TESTS}/scratch/oldworker150.mjs`, path.join(path.dirname(SERVER), 'lib'), DATA, '60'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => { old.stdout.once('data', resolve); setTimeout(resolve, 5000); });
  const bgOn = { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_INDEX_INTERVAL_MS: '1000', TRESORIT_OCR: 'false' };
  const by = (text) => (text.split('\n').find((l) => l.startsWith('Background reading is done by:')) || '');
  const warning = (text) => (text.split('\n').find((l) => l.startsWith('WARNING') && /another version/.test(l)) || '');
  let s = await start('other-version', bgOn, true);
  await sleep(2500);
  let st = (await s.call('connector_status')).text;
  check('beside a copy of an earlier version that does the background reading, the status report warns and says what to do',
    warning(st) === 'WARNING: the background reading is done by a copy of the connector of another version (earlier than 1.5.0), which follows its own rules: a folder set as "do not index" here can be read into the search index by it. Remove the older "Tresorit Files" extension in the Claude app (Settings > Extensions) and start Claude again.'
    && by(st) === 'Background reading is done by: another copy of the connector, of another version (see the line WARNING above)', `${warning(st) || '(no warning)'} | ${by(st)}`);
  old.kill(); await sleep(500);
  await s.close(); await sleep(300);
  // Two copies of this version: no warning.
  fs.rmSync(DATA, { recursive: true, force: true });
  const a = await start('other-version', bgOn, true);
  for (let i = 0; i < 40; i++) { await sleep(500); if (/up to date as of/.test((await a.call('connector_status')).text)) break; }
  const b = await start('other-version', bgOn, true);
  await sleep(2500);
  st = (await b.call('connector_status')).text;
  check('beside a copy of the same version there is no such warning', warning(st) === '' && by(st) === 'Background reading is done by: another copy of the connector (another Claude window)' && /this copy of the connector/.test(by((await a.call('connector_status')).text)), `${warning(st)} | ${by(st)}`);
  await a.close(); await b.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
