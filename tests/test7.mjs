import { Client, StdioClientTransport, ElicitRequestSchema, MOCK, TESTS, BUNDLE, rssMB } from './lib/env.mjs';
// Third-round tests: defects found on re-reading the code, real files the readers got wrong, and hostile conditions.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const ROOT = `${MOCK}/Tresors`;
const BASE = `${MOCK}`;
let pass = 0, fail = 0;
const verbose = process.argv.includes('-v');
const check = (l, c, d = '') => { if (c) { pass++; if (verbose) console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 800)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const protoErrors = [];
const stub = (mode) => JSON.stringify(['node', `${TESTS}/scratch/vision-stub.mjs`, mode]);

async function start(name, extraEnv = {}, caps = {}, onElicit = null) {
  const DATA = `${BASE}/data-r3-${name}`;
  if (!extraEnv.KEEP_DATA) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999', TRESORIT_OCR_ENGINE: 'bundled', ...extraEnv };
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 'test', version: '1' }, { capabilities: caps });
  client.onerror = (e) => protoErrors.push(`${name}: ${e}`);
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
  await client.connect(transport);
  const raw = (tool, args) => client.callTool({ name: tool, arguments: args }, undefined, { timeout: 170000 });
  const call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await raw(`tresorit_${tool}`, args);
    return { text: (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.isError, ms: Date.now() - t0 };
  };
  const t = async (label, tool, args, pred) => { const r = await call(tool, args); let ok = false; try { ok = pred(r); } catch { ok = false; } check(label, ok, r.text); return r; };
  return { client, call, t, raw, DATA, transport };
}
const waitStatus = async (s, re, tries = 400) => { let r; for (let i = 0; i < tries; i++) { r = await s.call('connector_status', {}); if (re.test(r.text)) return r; await sleep(300); } return r; };
const count = (text, needle) => text.split(needle).length - 1;

// ================================================================================================================
console.log('A. Real files the readers got wrong before, and reader improvements');
{
  const s = await start('readers');
  const F = 'Alder Works UK/08 - Real files';
  await s.t('Excel file written with prefixed tags and an unusual sheet file name', 'read_file', { path: `${F}/59021.xlsx` }, (r) => r.text.includes('Destination') && r.text.includes('Dial Code') && r.text.includes('Rate (USD)'));
  await s.t('Excel file with prefixed shared strings', 'read_file', { path: `${F}/prefixed shared strings.xlsx` }, (r) => r.text.includes('Unit Priority') && r.text.includes('Goal Name'));
  await s.t('Excel file whose first sheet is "sheet.xml"', 'read_file', { path: `${F}/65016.xlsx` }, (r) => r.text.includes('Sheet: 26 Mar 2014') && r.text.includes('Activity') && r.text.includes('Calories') && r.text.includes('2014-03-26 11:11:02'));
  await s.t('Excel rows without row numbers', 'read_file', { path: `${F}/59746_NoRowNums.xlsx` }, (r) => r.text.includes('Molecular Weight'));
  await s.t('.xlsx dates and times are shown as dates, other numbers untouched', 'read_file', { path: `${F}/Payment dates.xlsx` }, (r) => r.text.includes('2026-10-03') && r.text.includes('2026-11-09 14:30') && r.text.includes('48213.5') && r.text.includes('0.25') && r.text.includes('01:15:00') && r.text.includes('46298') && !r.text.includes('46298.6'));
  await s.t('.xls dates and times are shown as dates too', 'read_file', { path: `${F}/Payment dates.xls` }, (r) => r.text.includes('2026-10-03') && r.text.includes('2026-11-09 14:30') && r.text.includes('48213.5') && r.text.includes('46298'));
  await s.t('a date in a spreadsheet can be found by searching for it', 'search_contents', { query: '2026-10-03', path: F }, (r) => r.text.includes('Payment dates.xlsx') && r.text.includes('Payment dates.xls'));
  const deck = await s.t('slides come out in the order they are shown, each with its own notes', 'read_file', { path: `${F}/Reordered deck.pptx` }, (r) => {
    const c = r.text.indexOf('Slide about CHARLIE'), a = r.text.indexOf('Slide about ALPHA'), b = r.text.indexOf('Slide about BRAVO');
    const n = r.text.indexOf('[Speaker notes] Notes for CHARLIE');
    return c > 0 && c < a && a < b && n > c && n < a && /--- Slide 1 ---\nSlide about CHARLIE/.test(r.text);
  });
  await s.t('text box stored twice in a Word file is read once; tab-stop settings add nothing', 'read_file', { path: `${F}/Text box.docx` }, (r) => count(r.text, 'TEXTBOX-ONCE-4417') === 1 && r.text.includes('Before the box\n') && r.text.includes('After the box\ttabbed'));
  await s.t('password-protected Word file says so', 'read_file', { path: `${F}/locked.docx` }, (r) => r.isError && /password-protected/.test(r.text));
  await s.t('password-protected PDF says so', 'read_file', { path: `${F}/password.pdf` }, (r) => r.isError && /password-protected/.test(r.text));
  await s.t('what was typed into a PDF form is read', 'read_file', { path: `${F}/filled form.pdf` }, (r) => r.text.includes('[Form fields]') && r.text.includes('Single line, length 10: Lorem ipsu') && r.text.includes('combs: abcdefghijklmnopqrstuvwxyz'));
  await s.t('selected choices in a PDF form are read', 'read_file', { path: `${F}/form with choices.pdf` }, (r) => r.text.includes('Group1: Choice2') && r.text.includes('List Box8: item4'));
  await s.t('form entries are searchable', 'search_contents', { query: 'abcdefghijklmnopqrstuvwxyz', path: F }, (r) => r.text.includes('filled form.pdf'));
  const b1 = await s.t('zip bomb (unpacks to 300 MB) is refused quickly', 'read_file', { path: `${F}/Bomb 300MB.docx` }, (r) => r.isError && r.ms < 8000);
  const b2 = await s.t('60 MB document is read and cut at the size limit', 'read_file', { path: `${F}/Big 60MB.docx`, max_chars: 1000 }, (r) => !r.isError && /text truncated at 10 million characters/.test(r.text) && r.text.includes('BOMB BOMB') && r.ms < 40000);
  await s.t('...and the connector is still responsive afterwards', 'find_files', { query: 'payment dates' }, (r) => r.text.includes('Payment dates.xlsx') && r.ms < 2000);
  if (verbose) console.log(`       bomb ${b1.ms} ms, 60MB ${b2.ms} ms`);
  const L = 'Birch Labs/Large';
  await s.t('text file over 16 MB: start is read, and the reply says it was cut', 'read_file', { path: `${L}/seventeen megabytes.log`, max_chars: 600 }, (r) => r.text.includes('HEAD-MARKER-11') && /only the first 16 MB was read/.test(r.text) && /truncated at 10 million/.test(r.text));
  await s.t('...a search says plainly that such documents are only partly covered', 'search_contents', { query: 'TAIL-MARKER-99', path: L }, (r) => /^0 file/.test(r.text) && /2 very long document\(s\) are only searchable up to their first 10 million characters/.test(r.text));
  await s.t('12-million-character file: cut at 10 million with a note', 'read_file', { path: `${L}/twelve million chars.txt`, max_chars: 500 }, (r) => r.text.includes('START-MARKER-21') && /of 10000000/.test(r.text) && /text truncated at 10 million characters/.test(r.text));
  await s.t('search limited to one file', 'search_contents', { query: 'START-MARKER-21', path: `${L}/twelve million chars.txt` }, (r) => /^1 file/.test(r.text) && /Searched 1 document/.test(r.text));
  await s.t('create_folder on a folder that exists is harmless', 'create_folder', { path: 'Birch Labs/Large' }, (r) => !r.isError && /already exists/.test(r.text));
  await s.t('create_folder where a file has that name is refused', 'create_folder', { path: 'Birch Labs/Briefs/existing-file' }, (r) => r.isError && fs.statSync(`${ROOT}/Birch Labs/Briefs/existing-file`).isFile());
  await s.t('moving something onto itself is refused', 'move_item', { source: 'Birch Labs/Briefs/existing-file', destination: 'Birch Labs/Briefs/existing-file' }, (r) => r.isError && /same/.test(r.text));
  await s.client.close();
}

// ================================================================================================================
console.log('B. Deleting: only an explicit yes counts');
{
  const D = 'Birch Labs/Briefs';
  for (const n of ['e1', 'e2', 'e3', 'e4']) fs.writeFileSync(`${ROOT}/${D}/${n}.txt`, n);
  let mode = 'silent'; let asked = 0;
  const s = await start('elicit', { TRESORIT_ELICIT_TIMEOUT_MS: '900', TRESORIT_TOKEN_TTL_MS: '1500' }, { elicitation: {} }, async () => {
    asked++;
    if (mode === 'silent') { await sleep(4000); return { action: 'accept', content: { confirm: true } }; } // answers far too late
    if (mode === 'throw') throw new Error('dialog could not be shown');
    if (mode === 'cancel') return { action: 'cancel' };
    return { action: 'accept', content: { confirm: true } };
  });
  const preview = async (p) => (await s.call('delete_items', { paths: [p] })).text.match(/confirm_token "([0-9a-f]+)"/)[1];
  let tok = await preview(`${D}/e1.txt`);
  let r = await s.call('delete_items', { paths: [`${D}/e1.txt`], confirm_token: tok });
  check('dialog left unanswered: nothing is deleted', r.isError && /not answered, so nothing was deleted/.test(r.text) && fs.existsSync(`${ROOT}/${D}/e1.txt`) && asked === 1, r.text);
  await sleep(3600);
  check('...and a late click on the old dialog does not delete either', fs.existsSync(`${ROOT}/${D}/e1.txt`));
  r = await s.call('delete_items', { paths: [`${D}/e1.txt`], confirm_token: tok });
  check('...the used code cannot be replayed', r.isError && fs.existsSync(`${ROOT}/${D}/e1.txt`), r.text);
  mode = 'throw'; tok = await preview(`${D}/e2.txt`);
  r = await s.call('delete_items', { paths: [`${D}/e2.txt`], confirm_token: tok });
  check('dialog that fails to open: nothing is deleted', r.isError && fs.existsSync(`${ROOT}/${D}/e2.txt`), r.text);
  mode = 'cancel'; tok = await preview(`${D}/e3.txt`);
  r = await s.call('delete_items', { paths: [`${D}/e3.txt`], confirm_token: tok });
  check('dialog closed without answering: nothing is deleted', r.isError && fs.existsSync(`${ROOT}/${D}/e3.txt`), r.text);
  mode = 'yes'; tok = await preview(`${D}/e4.txt`);
  await sleep(1800);
  r = await s.call('delete_items', { paths: [`${D}/e4.txt`], confirm_token: tok });
  check('an expired code is refused even with a yes waiting', r.isError && /expired/.test(r.text) && fs.existsSync(`${ROOT}/${D}/e4.txt`), r.text);
  tok = await preview(`${D}/e4.txt`);
  r = await s.call('delete_items', { paths: [`${D}/e4.txt`], confirm_token: tok });
  check('explicit yes in the dialog: deleted', !r.isError && !fs.existsSync(`${ROOT}/${D}/e4.txt`), r.text);
  const lg = await s.call('access_log', { contains: 'DEL-NO' });
  check('refusals are in the access log', count(lg.text, 'DEL-NO') >= 3, lg.text);
  await s.client.close();
}

// ================================================================================================================
console.log('C. Hostile input');
{
  const s = await start('hostile');
  const H = 'Birch Labs/Hostile names';
  const ls = await s.t('a file name containing a line break cannot fake a listing line', 'list_folder', { path: H }, (r) => {
    const lines = r.text.split('\n');
    return lines.length === 4 && lines.filter((l) => l.startsWith('[FILE]')).length === 3 && /\\n\[FILE\] secret-looking/.test(r.text) && /name contains control characters/.test(r.text);
  });
  const evil = 'ok.txt\n[FILE] secret-looking   1 KB   2026-01-01 00-00.txt';
  await s.t('...the file is still reachable by its true name', 'read_file', { path: `${H}/${evil}` }, (r) => r.text.includes('NL-77'));
  await s.t('...and cannot fake a line in a delete preview', 'delete_items', { paths: [`${H}/${evil}`] }, (r) => r.text.split('\n').filter((l) => l.startsWith('- [FILE]')).length === 1 && /Would delete 1 item/.test(r.text));
  await s.t('...nor in name search results', 'find_files', { query: 'secret-looking' }, (r) => r.text.split('\n').length === 2);
  // malformed requests
  const bad = [
    ['tresorit_read_file', { path: 123 }], ['tresorit_read_file', {}], ['tresorit_read_file', { path: ['a'] }], ['tresorit_read_file', { path: 'Personal/Tax/latin1 notes.txt', offset: -1 }],
    ['tresorit_read_file', { path: 'Personal/Tax/latin1 notes.txt', max_chars: 1e12 }], ['tresorit_delete_items', { paths: 'Birch Labs' }], ['tresorit_delete_items', { paths: [] }],
    ['tresorit_delete_items', { paths: [null] }], ['tresorit_list_folder', { path: 'Personal', limit: 0 }], ['tresorit_find_files', { query: { $ne: 1 } }],
    ['tresorit_search_contents', { query: 'x' }], ['tresorit_search_contents', { query: 'abc', match: 'fuzzy' }], ['tresorit_write_file', { path: 'Birch Labs/x.txt' }],
    ['tresorit_write_file', { path: 'Birch Labs/x.txt', content: 5 }], ['tresorit_move_item', { source: 'a' }], ['tresorit_restore_deleted', { batch: 7 }], ['tresorit_no_such_tool', {}],
    ['tresorit_recent_files', { days: 'many' }], ['tresorit_access_log', { lines: 99999 }], ['tresorit_read_file', { path: 'a'.repeat(200000) }],
  ];
  let handled = 0; const odd = [];
  for (const [tool, args] of bad) {
    try { const r = await s.raw(tool, args); if (r.isError) handled++; else odd.push(`${tool} ${JSON.stringify(args).slice(0, 60)} -> accepted`); } catch (e) { handled++; }
  }
  check(`${bad.length} malformed requests are all refused cleanly`, handled === bad.length && odd.length === 0, odd.join(' | '));
  // Oversized or decorated but valid requests are simply answered.
  const huge = await s.call('find_files', { query: 'é'.repeat(300000) });
  const extra = await s.raw('tresorit_read_file', { path: 'Personal/Tax/latin1 notes.txt', constructor: 'x', toString: 'y', extra_field: { a: 1 } });
  check('a 300,000-character query and unknown extra fields do no harm', /No names matching/.test(huge.text) && !extra.isError && ({}).polluted === undefined, huge.text.slice(0, 80));
  check('...nothing was written by them', !fs.existsSync(`${ROOT}/Birch Labs/x.txt`));
  await s.t('...and the connector still works', 'read_file', { path: 'Personal/Tax/latin1 notes.txt' }, (r) => r.text.includes('Relatório'));
  await s.client.close();
}

// ================================================================================================================
console.log('D. Several things at once');
{
  const s = await start('parallel');
  const P = 'Birch Labs/Parallel';
  await s.call('create_folder', { path: P });
  let rs = await Promise.all(Array.from({ length: 20 }, (_, i) => s.call('write_file', { path: `${P}/same.txt`, content: `writer ${i}` })));
  let ok = rs.filter((r) => !r.isError);
  const content = fs.readFileSync(`${ROOT}/${P}/same.txt`, 'utf8');
  check('20 simultaneous saves to one new name: exactly one wins and its file survives the others failing', ok.length === 1 && /^writer \d+$/.test(content) && rs.filter((r) => /already exists/.test(r.text)).length === 19, `${ok.length} succeeded; content "${content}"`);
  rs = await Promise.all(Array.from({ length: 10 }, (_, i) => s.call('move_item', { source: `${P}/same.txt`, destination: `${P}/moved-${i}.txt` })));
  ok = rs.filter((r) => !r.isError);
  const present = fs.readdirSync(`${ROOT}/${P}`);
  check('10 simultaneous moves of one file: exactly one happens, the file exists once', ok.length === 1 && present.length === 1 && fs.readFileSync(`${ROOT}/${P}/${present[0]}`, 'utf8') === content, `${ok.length} succeeded; folder: ${present.join(', ')}`);
  for (let i = 0; i < 6; i++) fs.writeFileSync(`${ROOT}/${P}/v${i}.txt`, `v${i}`);
  rs = await Promise.all(Array.from({ length: 6 }, (_, i) => s.call('write_file', { path: `${P}/v${i}.txt`, content: `new ${i}`, overwrite: true })));
  const batches = rs.map((r) => (r.text.match(/batch (\S+_replaced_\w+)/) || [])[1]);
  check('6 simultaneous replacements each get their own holding batch', rs.every((r) => !r.isError) && new Set(batches).size === 6 && batches.every((b, i) => fs.readFileSync(`${s.DATA}/deleted/${b}/files/${P}/v${i}.txt`, 'utf8') === `v${i}`), batches.join(', '));
  const pv = await s.call('delete_items', { paths: [`${P}/v0.txt`] });
  const tok = pv.text.match(/confirm_token "([0-9a-f]+)"/)[1];
  rs = await Promise.all(Array.from({ length: 5 }, () => s.call('delete_items', { paths: [`${P}/v0.txt`], confirm_token: tok })));
  check('one confirmation code used 5 times at once: exactly one delete happens', rs.filter((r) => !r.isError).length === 1, rs.map((r) => r.text.slice(0, 40)).join(' | '));
  rs = await Promise.all([s.call('search_contents', { query: 'unicorn-keyword' }), s.call('read_file', { path: 'Personal/Scans/Contract scan.pdf' }), s.call('find_files', { query: 'nda' }), s.call('recent_files', { days: 1 }), s.call('copy_item', { source: 'Alder Works UK/03 - Finance', destination: `${P}/finance copy` }), s.call('connector_status', {})]);
  check('six different operations at once all complete correctly', rs.every((r) => !r.isError) && rs[1].text.includes('ZEBRA-QUARTZ-7781') && fs.existsSync(`${ROOT}/${P}/finance copy/Commission tracker 2026.xlsx`), rs.map((r) => r.isError ? r.text.slice(0, 80) : 'ok').join(' | '));
  await s.client.close();
}

// ================================================================================================================
console.log('E. Text recognition: failure and interruption paths');
const S = 'Personal/Scans';
{
  let s = await start('ocr-none', { TRESORIT_OCR_ENGINE: 'mac', TRESORIT_VISION_CMD: stub('crash') });
  await s.t('no working engine: the scan is reported honestly, not as empty', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => r.isError && /text recognition is unavailable on this computer/.test(r.text));
  await s.t('...status explains', 'connector_status', {}, (r) => /Text recognition \(OCR\): unavailable: Mac recognition: helper failed/.test(r.text));
  await s.t('...file_info explains', 'file_info', { path: `${S}/Contract scan.pdf` }, (r) => /scanned PDF, text recognition failed/.test(r.text));
  await s.t('...search says the scans are not covered', 'search_contents', { query: 'ZEBRA-QUARTZ-7781', path: S }, (r) => /text recognition is unavailable/.test(r.text));
  await s.t('...a mixed PDF still gives its typed pages', 'read_file', { path: `${S}/Mixed agreement.pdf` }, (r) => !r.isError && r.text.includes('TEXTLAYER-OK-17') && /could not be recognised and are missing/.test(r.text));
  await s.client.close();
  fs.writeFileSync(`${TESTS}/scratch/vision-wrong.mjs`, "const p = process.argv[3].split(','); const o = {}; for (const x of p) o[x] = 'completely different words'; console.log(JSON.stringify({ total: 1, pages: o }));");
  s = await start('ocr-wrong', { TRESORIT_OCR_ENGINE: 'auto', TRESORIT_VISION_CMD: JSON.stringify(['node', `${TESTS}/scratch/vision-wrong.mjs`]) });
  await s.t('Mac engine that answers but reads the self-test page wrongly is rejected', 'read_file', { path: `${S}/Contract scan.pdf` }, (r) => r.text.includes('ZEBRA-QUARTZ-7781') && /bundled engine/.test(r.text));
  await s.t('...and status says why', 'connector_status', {}, (r) => /the self-test page was not read correctly/.test(r.text));
  await s.client.close();
}
{
  const s = await start('ocr-preempt', { TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_INDEX_INTERVAL_MS: '4000' });
  let st = await waitStatus(s, /recognising text in scanned PDFs \(2 of/);   // Contract and JPEG2000 done, the 30-page scan is next
  check('background recognition reaches the long scan', /recognising text/.test(st.text), st.text);
  await sleep(1500);
  const r = await s.call('read_file', { path: `${S}/Settlement one-bit.pdf` });
  st = await s.call('connector_status', {});
  check('a scan the user asks for jumps the queue while a 30-page scan is being read in the background', !r.isError && r.text.includes('ZEBRA-QUARTZ-7781') && r.ms < 9000 && /recognising text in scanned PDFs \(2 of/.test(st.text), `${r.ms} ms | ${st.text.split('\n').find((l) => /Background/.test(l))}`);
  st = await waitStatus(s, /up to date as of/, 600);
  const long = await s.call('read_file', { path: `${S}/Long scan.pdf`, max_chars: 200000 });
  const got = Array.from({ length: 30 }, (_, i) => long.text.includes(`LONGSCAN-P${String(i + 1).padStart(2, '0')}`)).filter(Boolean).length;
  check(`the interrupted long scan is restarted and finished: all 30 pages recognised (page marker read exactly on ${got} of them)`, got >= 27 && /30 of 30 page\(s\) read by text recognition/.test(long.text) && (long.text.match(/\(text read by OCR\) ---/g) || []).length === 30, `${got} pages; ${long.text.split('\n').slice(0, 3).join(' / ')}`);
  // index hygiene: a file removed outside the connector disappears from the index on the next pass
  const before = (st.text.match(/Search index: (\d+) document/) || [])[1];
  fs.rmSync(`${ROOT}/Alder Works UK/05 - Legacy/SampleDoc.doc`); fs.rmSync(`${ROOT}/Alder Works UK/05 - Legacy/letter.doc`);
  let after; for (let i = 0; i < 60; i++) { await sleep(500); after = ((await s.call('connector_status', {})).text.match(/Search index: (\d+) document/) || [])[1]; if (Number(after) === Number(before) - 2) break; }
  check('files removed outside the connector drop out of the search index on the next pass', Number(after) === Number(before) - 2, `${before} -> ${after}`);
  await s.client.close();
}

// ================================================================================================================
console.log('F. Stopping and crashing');
{
  // The app disconnecting during a copy must not leave half a folder behind.
  const DATA = `${BASE}/data-r3-stop`; fs.rmSync(DATA, { recursive: true, force: true });
  const SRC = `${ROOT}/Alder Works UK/99 - Scale test`; const DST = `${ROOT}/Birch Labs/Scale copy`;
  fs.rmSync(DST, { recursive: true, force: true });
  const nSrc = Number(execSync(`find "${SRC}" -type f | wc -l`).toString().trim());
  const child = spawn('node', [SERVER], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
  await sleep(700);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tresorit_copy_item', arguments: { source: 'Alder Works UK/99 - Scale test', destination: 'Birch Labs/Scale copy' } } });
  // (Since 1.3.1 a copy is prepared in the connector's staging folder and put in place in one step, so progress
  // is watched there, and nothing may be visible in Tresorit while the copy is still under way.)
  let partial = 0; let visibleEarly = false;
  for (let i = 0; i < 400; i++) { await sleep(20); if (fs.existsSync(DST)) { visibleEarly = true; break; } if (fs.existsSync(`${DATA}/staging`)) { partial = Number(execSync(`find "${DATA}/staging" -type f | wc -l`).toString().trim()); if (partial > 200) break; } }
  const exited = new Promise((res) => child.on('exit', (code) => res(code)));
  child.stdin.end();   // the app goes away in the middle of the copy
  const code = await Promise.race([exited, sleep(110000).then(() => 'still running')]);
  const nDst = fs.existsSync(DST) ? Number(execSync(`find "${DST}" -type f | wc -l`).toString().trim()) : 0;
  check(`app closed mid-copy (${partial} of ${nSrc} files done, none of them visible in Tresorit yet): the copy still completes before the connector stops`, code === 0 && partial > 0 && partial < nSrc && !visibleEarly && nDst === nSrc && fs.readdirSync(`${DATA}/staging`).length === 0, `exit ${code}; ${nDst} of ${nSrc} files; visible early ${visibleEarly}`);
  if (code === 'still running') child.kill('SIGKILL');
  fs.rmSync(DST, { recursive: true, force: true });
}
{
  // Hard kill during indexing, then a normal start on the same data folder.
  const DATA = `${BASE}/data-r3-kill`; fs.rmSync(DATA, { recursive: true, force: true });
  const child = spawn('node', [SERVER], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false' }, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) + '\n');
  for (let i = 0; i < 100; i++) { await sleep(100); try { if (fs.readdirSync(`${DATA}/index/text`).length > 150) break; } catch { /* not yet */ } }
  const midway = fs.readdirSync(`${DATA}/index/text`).length;
  child.kill('SIGKILL');
  await sleep(300);
  const s = await start('kill', { KEEP_DATA: '1', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false' });
  const st = await waitStatus(s, /up to date as of/, 600);
  const r = await s.call('search_contents', { query: 'needle-zebra-42' });
  check(`killed outright while indexing (${midway} documents in): restarts cleanly and finishes the index`, /up to date as of/.test(st.text) && r.text.includes('report 123.pdf') && r.text.includes('notes 17-3.txt'), st.text.split('\n').filter((l) => /Search index|Background/.test(l)).join(' / '));
  // memory after indexing ~1,500 documents, and after the idle period
  const pid = s.transport.pid;
  const rss = () => rssMB(pid);
  const hot = rss();
  // (On a Mac the figure straight after a burst of reading moves by about 140 MB from run to run, whatever the
  // build: see README-TESTS.md. The guard against a real leak is the memory read each minute in the long stress runs.)
  const hotLimit = process.platform === 'darwin' ? 900 : 700;
  check(`memory after indexing is moderate (${hot} MB, limit ${hotLimit})`, hot < hotLimit, hot);
  await s.client.close();
}
check('no protocol errors in any session', protoErrors.length === 0, protoErrors.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
