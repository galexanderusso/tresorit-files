import { Client, StdioClientTransport, BUILD, MOCK, TESTS, BUNDLE } from './lib/env.mjs';
// Version 1.1 tests: old Office formats, Outlook messages, OCR, and the defects found in the code audit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const ROOT = `${MOCK}/Tresors`;
const BASE = `${MOCK}`;
let pass = 0, fail = 0;
const verbose = process.argv.includes('-v');
const check = (l, c, d = '') => { if (c) { pass++; if (verbose) console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 700)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allProtoErrors = [];

async function start(name, extraEnv = {}) {
  const DATA = `${BASE}/data-${name}`;
  if (!extraEnv.KEEP_DATA) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999', TRESORIT_OCR_ENGINE: 'bundled', ...extraEnv };
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  client.onerror = (e) => allProtoErrors.push(`${name}: ${e}`);
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 });
    return { text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.isError, ms: Date.now() - t0 };
  };
  const t = async (label, tool, args, pred) => { const r = await call(tool, args); let ok = false; try { ok = pred(r); } catch { ok = false; } check(label, ok, r.text); return r; };
  return { client, call, t, DATA };
}

// Snapshot of everything outside the Tresorit folder and the data folders: must be untouched at the end.
function snapshot(dir) {
  const h = crypto.createHash('sha1');
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); h.update(p); if (e.isDirectory()) walk(p); else if (e.isFile()) h.update(fs.readFileSync(p)); } }(dir));
  return h.digest('hex');
}
const outsideBefore = snapshot(`${BASE}/outside-secret`);

// ================================================================================================================
console.log('A. Old Office formats and Outlook messages');
{
  const s = await start('legacy');
  const L = 'Alder Works UK/05 - Legacy'; const M = 'Alder Works UK/06 - Emails';
  await s.t('.doc: text, accents and table', 'read_file', { path: `${L}/NDA Fundação Exemplo.doc` }, (r) => r.text.includes('cláusula de não-divulgação') && r.text.includes('Megaphos') && r.text.includes('USD 1,250 & more <tagged>'));
  await s.t('.doc: real Word file', 'read_file', { path: `${L}/SampleDoc.doc` }, (r) => r.text.includes('I am a test document') && r.text.includes('Arial Black in 16 point'));
  await s.t('.doc: footnotes, endnotes, comments', 'read_file', { path: `${L}/footnote.doc` }, (r) => r.text.includes('TestFootnote') && r.text.includes('TestEndnote') && r.text.includes('TestComment'));
  await s.t('.xls: both sheets, numbers, strings', 'read_file', { path: `${L}/Commission tracker 2026.xls` }, (r) => r.text.includes('Sheet: Commissions') && r.text.includes('INV-0042') && r.text.includes('15250.5') && r.text.includes('Sheet: Notes') && r.text.includes('unicorn-keyword'));
  await s.t('.xls: real Excel file with formula results', 'read_file', { path: `${L}/SimpleWithFormula.xls` }, (r) => r.text.includes('replaceme'));
  await s.t('.xls: password-protected reported clearly', 'read_file', { path: `${L}/password.xls` }, (r) => r.isError && /password-protected/.test(r.text));
  await s.t('.ppt: slides and notes', 'read_file', { path: `${L}/ORBIT pilot deck.ppt` }, (r) => r.text.includes('Photonic sampling') && r.text.includes('Scale to twelve qumodes') && /Slide 2/.test(r.text) && r.text.includes('provenance stamp'));
  await s.t('.ppt: real PowerPoint file, current version only', 'read_file', { path: `${L}/basic_test_ppt_file.ppt` }, (r) => r.text.includes('This is the title on page 2') && r.text.includes('These are the notes for page 1') && !/Slide 3/.test(r.text) && !r.text.includes('formattingT'));
  await s.t('file with .xls name but HTML inside', 'read_file', { path: `${L}/export.xls` }, (r) => r.text.includes('HTML-EXPORT-551'));
  await s.t('file with .doc name but RTF inside', 'read_file', { path: `${L}/letter.doc` }, (r) => r.text.includes('RTF-LETTER-907') && r.text.includes('Café'));
  await s.t('.msg: headers and body', 'read_file', { path: `${M}/multi-to.msg` }, (r) => r.text.includes('Subject: Test: multiple To recipients') && r.text.includes('From: Bob <bob@example.com>') && r.text.includes('Alice Smith <alice@example.com>') && r.text.includes('Cc: Dave Jones') && /Date: 2021-05-28/.test(r.text) && r.text.includes('Test email body.'));
  await s.t('.msg: signed message lists inner attachment', 'read_file', { path: `${M}/signed.msg` }, (r) => r.text.includes('Some empty PDF.PDF') && r.text.includes('Is the pdf found'));
  await s.t('.msg: Japanese non-Unicode message decoded', 'read_file', { path: `${M}/nonUnicodeCP932.msg` }, (r) => r.text.includes('日本語 Non Unicode タイトル'));
  await s.t('.msg: message attached inside a message', 'read_file', { path: `${M}/msgInMsgInMsg.msg` }, (r) => (r.text.match(/=== Attached message ===/g) || []).length >= 1);
  await s.t('.msg: hostile structure does not hang or crash', 'read_file', { path: `${M}/cyclicFatRing.msg` }, (r) => r.isError && r.ms < 5000);
  await s.t('search inside .doc', 'search_contents', { query: 'nao-divulgacao', path: L }, (r) => r.text.includes('NDA Fundação Exemplo.doc'));
  await s.t('search inside .xls', 'search_contents', { query: 'INV-0043', path: L }, (r) => r.text.includes('Commission tracker 2026.xls'));
  await s.t('search inside .ppt', 'search_contents', { query: 'twelve qumodes', path: L }, (r) => r.text.includes('ORBIT pilot deck.ppt'));
  await s.t('search inside .msg', 'search_contents', { query: 'Test email body', path: M }, (r) => r.text.includes('multi-to.msg'));
  await s.t('search by sender address', 'search_contents', { query: 'bob@example.com', path: M }, (r) => r.text.includes('multi-to.msg'));
  await s.client.close();
}

// ================================================================================================================
console.log('B. Text recognition for scanned PDFs');
const S = 'Personal/Scans';
{
  const s = await start('ocr');
  await s.t('status before any scan: engine not started', 'connector_status', {}, (r) => /Text recognition \(OCR\): not started yet/.test(r.text));
  await s.t('search before recognition says scans are pending', 'search_contents', { query: 'ZEBRA-QUARTZ-7781', path: S }, (r) => /^0 file/.test(r.text) && /scanned PDF\(s\) are not searchable yet/.test(r.text) && /searched without some scanned pages/.test(r.text));
  const r1 = await s.t('read a scanned PDF: text comes from OCR', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => !r.isError && r.text.includes('CONTRATO DE PRESTA') && r.text.includes('ZEBRA-QUARTZ-7781') && r.text.includes('GBP 48,213.00') && /Page 2 of 2 \(text read by OCR\)/.test(r.text) && /2 of 2 page\(s\) read by text recognition \(OCR, bundled engine\); recognised text can contain errors/.test(r.text));
  const r2 = await s.call('read_file', { path: `${S}/Contract scan.pdf` });
  check('second read is served from the cache', r2.ms < 400 && r2.text.includes('ZEBRA-QUARTZ-7781'), `${r2.ms} ms (first read ${r1.ms} ms)`);
  await s.t('mixed PDF: typed page kept, scanned page recognised', 'read_file', { path: `${S}/Mixed agreement.pdf` }, (r) => r.text.includes('TEXTLAYER-OK-17') && r.text.includes('MAGENTA-HERON-3310') && /--- Page 1 of 2 ---/.test(r.text) && /Page 2 of 2 \(text read by OCR\)/.test(r.text));
  await s.t('search finds text inside a scan, flagged as OCR', 'search_contents', { query: 'MAGENTA-HERON-3310', path: S }, (r) => r.text.includes('Mixed agreement.pdf') && /includes text read by OCR/.test(r.text));
  await s.t('scan stored as JPEG 2000 is read', 'read_file', { path: `${S}/JPEG2000 scan.pdf` }, (r) => r.text.includes('COBALT-OTTER-6620'));
  await s.t('file_info describes the scan', 'file_info', { path: `${S}/Contract scan.pdf` }, (r) => /searchable \(\d+ characters\); 2 of 2 page\(s\) read by text recognition/.test(r.text));
  await s.t('status names the engine and counts', 'connector_status', {}, (r) => /bundled engine \(passed its self-test\)/.test(r.text) && /Scanned PDFs: 3 read by text recognition, 1 waiting/.test(r.text));
  await s.t('log records the recognition', 'access_log', { contains: '| OCR' }, (r) => /Contract scan\.pdf \| 2 page\(s\) read by the bundled engine/.test(r.text));
  check('language files are not copied or cached anywhere', !fs.existsSync(`${s.DATA}/ocr-lang`) && !fs.readdirSync(`${BUILD}`).some((f) => f.endsWith('.traineddata')) && !fs.readdirSync(path.dirname(SERVER)).some((f) => f.endsWith('.traineddata')));
  await s.client.close();
}
{
  const s = await start('ocrbg', { TRESORIT_INDEX_DELAY_MS: '300' });
  let r; let ok = false;
  for (let i = 0; i < 240 && !ok; i++) { await sleep(500); r = await s.call('connector_status', {}); ok = /up to date as of/.test(r.text); }
  check('background pass reads documents then recognises scans', ok && /Scanned PDFs: 4 read by text recognition, 0 waiting/.test(r.text), r.text);
  await s.t('a scan nobody opened is searchable after the background pass', 'search_contents', { query: 'ZEBRA-QUARTZ-7781' }, (x) => x.text.includes('Settlement one-bit.pdf') && x.text.includes('Contract scan.pdf'));
  await s.t('blank scan ends as "no text", not as an error loop', 'read_file', { path: 'Personal/Tax/Scanned letter.pdf' }, (x) => x.isError && /no text could be recognised/.test(x.text));
  await s.client.close();
  // restart on the same data folder: nothing is recognised twice
  const s2 = await start('ocrbg', { KEEP_DATA: '1' });
  const r3 = await s2.call('read_file', { path: `${S}/Settlement one-bit.pdf` });
  check('recognised text survives a restart', r3.ms < 500 && r3.text.includes('ZEBRA-QUARTZ-7781'), `${r3.ms} ms`);
  await s2.client.close();
}
{
  const s = await start('ocroff', { TRESORIT_OCR: 'false' });
  await s.t('OCR switched off: scan reported, nothing recognised', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => r.isError && /switched off in the connector settings/.test(r.text));
  await s.t('OCR switched off: status says so', 'connector_status', {}, (r) => /Text recognition \(OCR\): switched off in settings/.test(r.text));
  await s.client.close();
}
{
  const s = await start('ocrwait', { TRESORIT_OCR_WAIT_MS: '1' });
  const a = await s.t('slow recognition does not block the reply', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => r.isError && /still being recognised/.test(r.text) && r.ms < 3000);
  let b; for (let i = 0; i < 60; i++) { await sleep(500); b = await s.call('read_file', { path: `${S}/Contract scan.pdf` }); if (!b.isError) break; }
  check('...and the text is there shortly after', !b.isError && b.text.includes('ZEBRA-QUARTZ-7781'), b.text);
  await s.client.close();
}
{
  const stub = (mode) => JSON.stringify(['node', `${TESTS}/scratch/vision-stub.mjs`, mode]);
  let s = await start('vis-ok', { TRESORIT_OCR_ENGINE: 'auto', TRESORIT_VISION_CMD: stub('ok') });
  await s.t('Mac engine used when its self-test passes', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => r.text.includes('VISION-STUB text for page 2') && /OCR, Mac built-in/.test(r.text));
  await s.t('status shows the Mac engine', 'connector_status', {}, (r) => /Mac built-in text recognition \(passed its self-test\)/.test(r.text));
  await s.client.close();
  s = await start('vis-garbage', { TRESORIT_OCR_ENGINE: 'auto', TRESORIT_VISION_CMD: stub('garbage') });
  await s.t('Mac engine that fails its self-test is not used', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => r.text.includes('ZEBRA-QUARTZ-7781') && /OCR, bundled engine/.test(r.text));
  await s.t('status explains why', 'connector_status', {}, (r) => /bundled engine \(passed its self-test\); the Mac's own recognition was not used: helper returned an unreadable answer/.test(r.text));
  await s.client.close();
  s = await start('vis-crash', { TRESORIT_OCR_ENGINE: 'auto', TRESORIT_VISION_CMD: stub('crash') });
  await s.t('Mac helper that crashes falls back', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => r.text.includes('ZEBRA-QUARTZ-7781'));
  await s.client.close();
  s = await start('vis-failfile', { TRESORIT_OCR_ENGINE: 'auto', TRESORIT_VISION_CMD: stub('failfile') });
  await s.t('Mac engine failing on one file: bundled engine reads that file', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => r.text.includes('ZEBRA-QUARTZ-7781') && /OCR, bundled engine/.test(r.text));
  await s.client.close();
}

// ================================================================================================================
console.log('C. Defects found in the audit');
{
  const s = await start('audit', { TRESORIT_ASSUME_FILE_PROVIDER: '' });
  const T = 'Personal/Tax';
  await s.t('classic Tresors folder: nothing is ever treated as online-only', 'list_folder', { path: T }, (r) => r.text.includes('Online only report.txt') && !/online only/.test(r.text));
  await s.t('...so search does not skip it', 'search_contents', { query: 'unicorn-keyword' }, (r) => !/online-only/.test(r.text));
  await s.t('Windows-encoded text file reads with accents intact', 'read_file', { path: `${T}/latin1 notes.txt` }, (r) => r.text.includes('Relatório de março – cláusula nº 4'));
  const before = fs.readFileSync(`${ROOT}/${T}/latin1 notes.txt`);
  await s.t('editing a non-UTF-8 file is refused', 'edit_file', { path: `${T}/latin1 notes.txt`, old_text: 'mar', new_text: 'abr' }, (r) => r.isError && /not stored as UTF-8/.test(r.text));
  check('...and the file is byte-for-byte unchanged', fs.readFileSync(`${ROOT}/${T}/latin1 notes.txt`).equals(before));
  const nf = await s.t('file whose name is stored in decomposed Unicode is found with a plain query', 'find_files', { query: 'relatorio comissao acao' }, (r) => r.text.normalize('NFC').includes('Relatório de comissão ação.txt'));
  const nfPath = (nf.text.match(/\[FILE\] (.*?\.txt)/) || [])[1];
  await s.t('...and read through the path the search returned', 'read_file', { path: nfPath }, (r) => r.text.includes('NFD-MARKER-88'));
  await s.t('...and found by content search', 'search_contents', { query: 'conteudo decomposto' }, (r) => r.text.includes('NFD-MARKER-88'));
  await s.t('link with an unknown target: read refused', 'read_file', { path: 'Birch Labs/Briefs/dangling' }, (r) => r.isError && /target cannot be checked/.test(r.text));
  await s.t('link with an unknown target: write refused', 'write_file', { path: 'Birch Labs/Briefs/dangling', content: 'x', overwrite: true }, (r) => r.isError);
  check('...nothing written through the link', !fs.existsSync('/nonexistent/target/file.txt'));
  const prev = await s.t('deleting a folder and something inside it lists the folder once', 'delete_items', { paths: ['Birch Labs/Nest/inner/x.txt', 'Birch Labs/Nest', 'Birch Labs/Nest/y.txt'] }, (r) => /Would delete 1 item\(s\), 2 file\(s\)/.test(r.text));
  const tok = (prev.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
  const del = await s.t('...and deletes cleanly with no errors', 'delete_items', { paths: ['Birch Labs/Nest', 'Birch Labs/Nest/y.txt', 'Birch Labs/Nest/inner/x.txt'], confirm_token: tok }, (r) => !r.isError && /Deleted 1 item/.test(r.text) && !/Could not delete/.test(r.text) && !fs.existsSync(`${ROOT}/Birch Labs/Nest`));
  const batch = (del.text.match(/batch (\S+_deleted_\w+)/) || [])[1];
  await s.t('...and restores', 'restore_deleted', { batch }, (r) => fs.existsSync(`${ROOT}/Birch Labs/Nest/inner/x.txt`) && fs.existsSync(`${ROOT}/Birch Labs/Nest/y.txt`));

  // A replace that fails half-way must put the original back.
  const held0 = fs.existsSync(`${s.DATA}/deleted`) ? fs.readdirSync(`${s.DATA}/deleted`).length : 0;
  await s.t('copy that fails after replacing the destination is rolled back', 'copy_item', { source: 'Birch Labs/Pipes/has-fifo', destination: 'Birch Labs/Pipes/target', overwrite: true }, (r) => r.isError && /FIFO/.test(r.text));
  const P = `${ROOT}/Birch Labs/Pipes/target/has-fifo`;
  check('...destination is back exactly as it was', fs.existsSync(`${P}/precious.txt`) && fs.readFileSync(`${P}/precious.txt`, 'utf8') === 'precious original content' && fs.readdirSync(P).join(',') === 'precious.txt', fs.existsSync(P) ? fs.readdirSync(P).join(',') : 'destination folder is gone');
  await s.t('copy that fails part-way leaves no half-made copy', 'copy_item', { source: 'Birch Labs/Pipes/has-fifo', destination: 'Birch Labs/Pipes/fresh copy' }, (r) => r.isError);
  check('...no partial folder remains', !fs.existsSync(`${ROOT}/Birch Labs/Pipes/fresh copy`));
  check('...and the source is intact', fs.existsSync(`${ROOT}/Birch Labs/Pipes/has-fifo/a.txt`));
  check('...and no stray holding batch is left', (fs.existsSync(`${s.DATA}/deleted`) ? fs.readdirSync(`${s.DATA}/deleted`).length : 0) === held0);

  // A search pattern that would run for hours must be cut off, and the connector must stay usable.
  const rx = await s.t('runaway search pattern is interrupted', 'search_contents', { query: '(a+)+$', match: 'regex', path: 'Birch Labs/Briefs' }, (r) => r.isError && /takes too long/.test(r.text) && r.ms < 8000);
  const after = await s.call('find_files', { query: 'aaaa' });
  check('...and the connector answers the next request at once', after.text.includes('aaaa.txt') && after.ms < 2000, `${after.ms} ms`);
  await s.t('ordinary pattern still works', 'search_contents', { query: 'INV-\\d{4}', match: 'regex', path: 'Alder Works UK/03 - Finance' }, (r) => r.text.includes('Commission tracker'));

  // Tampered holding-area record must not let a restore reach outside its batch or outside Tresorit.
  const bdir = `${s.DATA}/deleted/2020-01-01_000000_deleted_beef`;
  fs.mkdirSync(`${bdir}/files`, { recursive: true });
  fs.writeFileSync(`${bdir}/manifest.json`, JSON.stringify({ kind: 'deleted', when: 'x', items: [{ original: '../../../outside-secret/secret.txt', type: 'file' }, { original: 'Birch Labs/../../outside-secret/pwn.txt', type: 'file' }, { original: 'Top level file.txt', type: 'file' }] }));
  await s.t('tampered restore record is refused', 'restore_deleted', { batch: '2020-01-01_000000_deleted_beef', overwrite: true }, (r) => !/: restored/.test(r.text));
  check('...nothing appeared outside', !fs.existsSync(`${BASE}/outside-secret/pwn.txt`) && !fs.existsSync(`${ROOT}/Top level file.txt`));
  fs.rmSync(bdir, { recursive: true, force: true });
  await s.client.close();
}
{
  // A search index written by version 1.0 is discarded and rebuilt, so old "no text" verdicts on scans do not stick.
  const DATA = `${BASE}/data-upgrade`;
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(`${DATA}/index/text`, { recursive: true });
  const st = fs.statSync(`${ROOT}/${S}/Contract scan.pdf`);
  fs.writeFileSync(`${DATA}/index/catalog.json`, JSON.stringify({ v: 1, entries: { [`${S}/Contract scan.pdf`]: { s: st.size, m: st.mtimeMs, st: 'empty', c: 0, n: 'PDF with 2 page(s) and no text layer (probably a scan; no OCR available)' } } }));
  fs.writeFileSync(`${DATA}/index/text/stale.txt`, 'old');
  const s = await start('upgrade', { KEEP_DATA: '1' });
  await s.t('index from version 1.0 is rebuilt: the scan is now read', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => !r.isError && r.text.includes('ZEBRA-QUARTZ-7781'));
  check('...stale index files removed', !fs.existsSync(`${DATA}/index/text/stale.txt`));
  await s.client.close();
}

// ================================================================================================================
console.log('D. Path safety under random attack, and integrity of everything outside Tresorit');
{
  const { makeResolver } = await import(path.join(path.dirname(SERVER), 'lib', 'paths.js'));
  const realRoot = fs.realpathSync(ROOT);
  const R = makeResolver(realRoot, []);
  const pieces = ['..', '.', '', 'Alder Works UK', 'Personal', 'Birch Labs', 'escape-link', 'Briefs', 'dangling', 'Tax', '03 - Finance', '../outside-secret', 'secret.txt', '/etc', 'passwd', '~', '\\..\\..', '%2e%2e', 'x'.repeat(300), 'ＡＢ', '..​', '. .', '...', 'á', 'CON', '//', '/'.repeat(5), realRoot, realRoot + '/..', `${MOCK}/outside-secret`, 'Alder Works UK/escape-link/secret.txt', '\0'];
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let escaped = 0; let accepted = 0; let refused = 0; const bad = [];
  for (let i = 0; i < 20000; i++) {
    const n = 1 + Math.floor(rnd() * 6);
    let p = Array.from({ length: n }, () => pieces[Math.floor(rnd() * pieces.length)]).join(rnd() < 0.85 ? '/' : '');
    if (rnd() < 0.2) p = '/' + p;
    try {
      const r = R.resolve(p);
      accepted++;
      const inside = r.abs === realRoot || r.abs.startsWith(realRoot + '/');
      // the deepest existing ancestor, with links resolved, must also be inside
      let ex = r.abs; while (!fs.existsSync(ex) && ex !== realRoot) ex = path.dirname(ex);
      let insideReal = false; try { const real = fs.realpathSync(ex); insideReal = real === realRoot || real.startsWith(realRoot + '/'); } catch { insideReal = false; }
      if (!inside || !insideReal || r.rel.split('/').includes('..')) { escaped++; if (bad.length < 5) bad.push(JSON.stringify(p) + ' -> ' + r.abs); }
    } catch { refused++; }
  }
  check(`20,000 random hostile paths: none resolves outside Tresorit (${accepted} accepted inside, ${refused} refused)`, escaped === 0 && accepted > 1000 && refused > 1000, bad.join('\n'));
}
check('files outside Tresorit are untouched after every test', snapshot(`${BASE}/outside-secret`) === outsideBefore);
check('nothing was created beside the Tresorit folder except the test data folders', fs.readdirSync(BASE).every((n) => n === 'Tresors' || n === 'outside-secret' || /^data/.test(n) || /^(hang|slow)-worker\.mjs$/.test(n) || n === 'ocrdata' || n === 'fakehome'), fs.readdirSync(BASE).join(', '));
check('no protocol errors in any session (standard output stayed clean)', allProtoErrors.length === 0, allProtoErrors.slice(0, 3).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
