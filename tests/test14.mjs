import { Client, StdioClientTransport, BUILD, MOCK, BUNDLE } from './lib/env.mjs';
// Version 1.4: reading by content, unreadable files by reason, password-protected PDFs, the transfer folder,
// identical files, the status report, and the upgrade from 1.3.5.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// These tests put old-dated batches into the holding area to test clearing and restoring by hand; the automatic
// clearing added in 1.4.1 is switched off here so that it cannot take them first (test16 covers it).
process.env.TRESORIT_HOLDING_DAYS ??= '0';

const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const OLD = `${BUILD}/ref135/server/index.js`;
const SAMPLES = path.join(path.dirname(SERVER), 'preflight', 'samples');
const BASE = `${MOCK}`; const ROOT = `${BASE}/Tresors`; const FX = `${BASE}/data-fx14`;
const HOME = `${BASE}/data-v14-home`;
const W = 'Birch Labs/v14';
const PW = fs.readFileSync(`${FX}/pw.txt`, 'utf8'); const ODD = fs.readFileSync(`${FX}/pw-odd.txt`, 'utf8');
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 1100)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (rel) => `${ROOT}/${rel}`;
const put = (rel, from) => { fs.mkdirSync(path.dirname(T(rel)), { recursive: true }); if (Buffer.isBuffer(from) || typeof from === 'string' && !from.startsWith('/')) fs.writeFileSync(T(rel), from); else fs.copyFileSync(from, T(rel)); };
const PWFILE = `${BASE}/data-v14-pw.txt`; const PWSH = `${BASE}/data-v14-pw.sh`;
fs.writeFileSync(PWSH, `if [ -f "${PWFILE}.cancel" ]; then exit 1; fi\ncat "${PWFILE}"\n`);
const typed = (pw) => { fs.rmSync(`${PWFILE}.cancel`, { force: true }); fs.writeFileSync(PWFILE, pw); };
const cancelled = () => fs.writeFileSync(`${PWFILE}.cancel`, '1');

async function start(name, extraEnv = {}, opts = {}) {
  const DATA = opts.data || `${BASE}/data-v14-${name}`;
  if (!opts.keep) fs.rmSync(DATA, { recursive: true, force: true });
  // (Up to 1.4.8 these two folders were "do not index" by default. From 1.5.0 the program names no folder, so the
  // suite enters them, as a user does in the settings.)
  const env = { ...process.env, TRESORIT_NO_INDEX: 'Strongbox; Personal/16 - Secrets', TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off',
    TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_OCR_WAIT_MS: '60000', TRESORIT_PASSWORD_CMD: JSON.stringify(['/bin/sh', PWSH]), ...extraEnv };
  const transport = new StdioClientTransport({ command: 'node', args: [opts.server || SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError }; } catch (e) { return { text: `call failed: ${e.message}`, isError: true }; }
  };
  return { client, call, DATA, pid: transport.pid };
}
const logOf = (DATA) => { try { return fs.readdirSync(`${DATA}/logs`).filter((f) => f.startsWith('access')).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n'); } catch { return ''; } };
const holds = (dir, needle) => { let hit = ''; const visit = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) visit(p); else if (!hit && fs.readFileSync(p).includes(needle)) hit = p; } }; try { visit(dir); } catch { /* none */ } return hit; };
const tok = (t) => (t.match(/confirm_token "([0-9a-f]+)"/) || [])[1];

fs.rmSync(T(W), { recursive: true, force: true }); fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/Downloads`, { recursive: true }); fs.mkdirSync(`${HOME}/.ssh`, { recursive: true }); fs.writeFileSync(`${HOME}/.ssh/id_rsa`, 'KEY');

// The kinds of wrongly named and unreadable files found in the real library.
const WRONG = [
  ['scan one.pdf', `${FX}/page.png`, /48213/, 'PNG image saved as .pdf'],
  ['photo.pdf', `${FX}/page.jpg`, /48213/, 'JPEG image saved as .pdf'],
  ['saved page.pdf', `${FX}/page.webarchive`, /FX-WEBARCHIVE-8801/, 'Safari web archive saved as .pdf'],
  ['page.pdf', `${FX}/page.html`, /FX-HTML-8802/, 'web page saved as .pdf'],
  ['sheet.pdf', `${SAMPLES}/sample.xlsx`, /PF-XLSX-202/, 'Excel workbook saved as .pdf'],
  ['old office.pdf', `${SAMPLES}/sample.doc`, /PF-DOC/, 'old-format Word document saved as .pdf'],
  ['slides.pdf', `${SAMPLES}/sample.ppt`, /PF-PPT/, 'old-format PowerPoint presentation saved as .pdf'],
  ['pointer.pdf', `${FX}/pointer.xml`, /FX-XML-8803/, 'XML file saved as .pdf'],
  ['really a pdf.docx', `${SAMPLES}/sample.pdf`, /PF-PDF-404/, 'PDF saved as .docx'],
  ['word as sheet.xlsx', `${SAMPLES}/sample.docx`, /PF-DOCX-101/, 'Word document saved as .xlsx'],
];
const makeLibrary = () => {
  for (const [name, from] of WRONG) put(`${W}/mixed/${name}`, from);
  put(`${W}/mixed/empty one.pdf`, Buffer.alloc(0)); put(`${W}/mixed/empty two.docx`, Buffer.alloc(0));
  put(`${W}/mixed/cut off.pdf`, fs.readFileSync(`${SAMPLES}/sample.pdf`).subarray(0, 400));
  put(`${W}/mixed/bad zip.docx`, Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(600)]));
  put(`${W}/mixed/noise.pdf`, Buffer.concat([Buffer.from([0, 1, 2, 3, 0, 9]), crypto.randomBytes(900)]));
  put(`${W}/mixed/normal.pdf`, `${SAMPLES}/sample.pdf`);
  put(`${W}/bills/2019-03 energia.pdf`, `${FX}/locked-aes256.pdf`); put(`${W}/bills/2019-04 energia.pdf`, `${FX}/locked-aes128.pdf`); put(`${W}/bills/old/2012 conta.pdf`, `${FX}/locked-rc4.pdf`);
  put(`${W}/bills/other bank.pdf`, `${FX}/locked-odd.pdf`); put(`${W}/bills/scan protected.pdf`, `${FX}/locked-scan.pdf`);
  put(`${W}/bills/2019-03 energia (unlocked).pdf`, `${FX}/plain.pdf`); put(`${W}/bills/owner only.pdf`, `${FX}/owner-only.pdf`);
};
makeLibrary();

console.log('A. Reading by content, not by name');
{
  const s = await start('content');
  const bad = [];
  for (const [name, , marker, note] of WRONG) {
    const r = await s.call('read_file', { path: `${W}/mixed/${name}` });
    if (r.isError || !marker.test(r.text)) bad.push(`${name}: ${r.text.slice(0, 160)}`);
    const fi = await s.call('file_info', { path: `${W}/mixed/${name}` });
    if (!fi.text.includes(note) && !r.text.includes(note)) bad.push(`${name}: note missing (${note})`);
  }
  check(`${WRONG.length} wrongly named files (pictures, a web archive, a web page, Office files, a PDF) are each read as what they are`, bad.length === 0, bad.join(' || '));
  let r = await s.call('read_file', { path: `${W}/mixed/saved page.pdf` });
  check('a web archive gives the text of the saved page only (no script, none of the embedded pictures)', !/SCRIPT-NOT-TEXT/.test(r.text) && /Boleto de cobrança/.test(r.text), r.text);
  r = await s.call('search_contents', { query: 'FX-WEBARCHIVE-8801', path: `${W}/mixed` });
  const r2 = await s.call('search_contents', { query: '48213', path: `${W}/mixed` });
  check('they are found by a search of their contents, including the pictures once recognised', r.text.includes('saved page.pdf') && r2.text.includes('scan one.pdf') && r2.text.includes('photo.pdf'), `${r.text} | ${r2.text}`);
  for (const f of ['empty one.pdf', 'empty two.docx', 'cut off.pdf', 'bad zip.docx', 'noise.pdf', 'normal.pdf']) await s.call('read_file', { path: `${W}/mixed/${f}` });
  r = await s.call('list_unreadable', { path: `${W}/mixed` });
  check('what truly cannot be read is listed with the right reason: empty, damaged, unrecognised content', /5 of \d+ document/.test(r.text) && /2\s+empty \(0 bytes\)/.test(r.text) && /2\s+damaged/.test(r.text) && /1\s+content of a kind that cannot be read/.test(r.text)
    && /\[damaged\] .*cut off\.pdf/.test(r.text) && /\[damaged\] .*bad zip\.docx/.test(r.text) && /\[content of a kind that cannot be read\] .*noise\.pdf/.test(r.text) && !/normal\.pdf/.test(r.text), r.text);
  r = await s.call('list_unreadable', { path: `${W}/mixed`, reason: 'wrong_ending' });
  check('the wrongly named files are listed separately, with what each really is', WRONG.every(([name, , , note]) => r.text.includes(name) && r.text.includes(note)) && /10 file\(s\) have an ending that does not match/.test(r.text), r.text);
  r = await s.call('list_unreadable', { path: `${W}/mixed`, reason: 'empty', limit: 1 });
  check('the list can be narrowed by reason and limited', /empty one\.pdf|empty two\.docx/.test(r.text) && !/cut off/.test(r.text) && /and 1 more/.test(r.text), r.text);
  const st = (await s.call('connector_status')).text;
  check('the status report splits the unreadable count by reason and counts the wrong endings', /Unreadable by reason: 0 password-protected, 2 damaged, 2 empty, 1 with content of a kind that cannot be read, 0 too large/.test(st) && /10 file\(s\) have an ending that does not match their content/.test(st), (st.match(/Unreadable[^\n]*\n[^\n]*/) || [''])[0]);
  check('the new tools write to the access log', /\| UNREADABLE/.test(logOf(s.DATA)));
  await s.client.close();
}

console.log('B. Upgrading from 1.3.5: only what could not be read is read again');
if (!fs.existsSync(OLD)) console.log('  skip  the update from 1.3.5: needs an unpacked copy of that version in <TEST_BASE>/ref135 (3 checks)');
else {
  const DATA = `${BASE}/data-v14-upgrade`; fs.rmSync(DATA, { recursive: true, force: true });
  const bgEnv = { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_INDEX_INTERVAL_MS: '600000' };
  const settle = async (srv) => { let st = ''; for (let i = 0; i < 600; i++) { await sleep(300); st = (await srv.call('connector_status')).text; if (/up to date as of/.test(st) && /Scanned PDFs: \d+ read by text recognition, 0 waiting/.test(st)) break; } return st; };
  const old = await start('upgrade', bgEnv, { server: OLD, data: DATA });
  const stOld = await settle(old); await sleep(5500); await old.client.close();
  const unreadOld = Number((stOld.match(/(\d+) unreadable or too large/) || [])[1]);
  const before = logOf(DATA).split('\n').length;
  const s = await start('upgrade', bgEnv, { data: DATA, keep: true });
  const st = await settle(s);
  const log = logOf(DATA).split('\n').slice(before).join('\n');
  const reread = Number((log.match(/(\d+) document\(s\) read into the search index/) || [])[1]);
  const total = Number((st.match(/\((\d+) document\(s\) checked/) || [])[1]);
  check('after the update the worker reads again only the files 1.3.5 could not read, not the library', reread > 0 && reread <= unreadOld && reread < total / 2, `1.3.5 had ${unreadOld} unreadable; 1.4.0 read ${reread} again of ${total} checked`);
  const r = await s.call('list_unreadable', { path: W });
  const readableNow = WRONG.filter(([name]) => !new RegExp(`\\] .*${name.replace(/[.()]/g, '\\$&')}`).test(r.text.split('\n').filter((l) => !/wrong ending/.test(l)).join('\n'))).length;
  const stNew = Number((st.match(/(\d+) unreadable or too large/) || [])[1]);
  check('the wrongly named files that 1.3.5 called unreadable are readable now, and the rest have a reason', readableNow === WRONG.length && stNew < unreadOld && /5\s+password-protected/.test(r.text), `unreadable before ${unreadOld}, now ${stNew} | ${r.text.slice(0, 500)}`);
  const sr = await s.call('search_contents', { query: 'FX-WEBARCHIVE-8801' });
  check('and they are in the search index', sr.text.includes('saved page.pdf'), sr.text.slice(0, 300));
  await s.client.close();
}

console.log('C. Password-protected PDFs');
{
  const s = await start('pw');
  let r = await s.call('read_file', { path: `${W}/bills/2019-03 energia.pdf` });
  check('without a password a protected PDF is refused, and the reply tells Claude to have the user type it on the Mac', r.isError && /password-protected/.test(r.text) && /ask_password/.test(r.text) && /never ask for it in the conversation/.test(r.text), r.text);
  typed('wrong-one');
  r = await s.call('read_file', { path: `${W}/bills/2019-03 energia.pdf`, ask_password: true });
  check('a wrong password is refused', r.isError && /does not open/.test(r.text) && !/FX-LOCKED/.test(r.text), r.text);
  cancelled();
  r = await s.call('read_file', { path: `${W}/bills/2019-03 energia.pdf`, ask_password: true });
  check('a cancelled or unanswered password box reads nothing', r.isError && /No password was entered/.test(r.text), r.text);
  typed(PW);
  r = await s.call('read_file', { path: `${W}/bills/2019-03 energia.pdf`, ask_password: true, max_chars: 500 });
  check('the right password opens it for one read', !r.isError && /FX-LOCKED-7701/.test(r.text) && /not kept/.test(r.text), r.text);
  cancelled();
  r = await s.call('read_file', { path: `${W}/bills/2019-03 energia.pdf`, offset: 10 });
  const sr0 = await s.call('search_contents', { query: 'FX-LOCKED-7701', path: `${W}/bills` });
  check('reading on in the same document shortly after needs no second password, yet nothing was put in the index', !r.isError && /FX-LOCKED-7701|energia/.test(r.text) && !sr0.text.includes('2019-03 energia.pdf'), `${r.text.slice(0, 200)} | ${sr0.text.slice(0, 200)}`);
  r = await s.call('read_file', { path: `${W}/bills/owner only.pdf` });
  check('a PDF that only restricts printing or copying (no password to open) is read as usual', !r.isError && /FX-LOCKED-7702/.test(r.text), r.text.slice(0, 200));

  typed(PW);
  r = await s.call('unlock_folder', { path: `${W}/bills` });
  check('one password makes a whole folder searchable: every strength of protection, sub-folders, and a protected scan', !r.isError && /4 of 5 password-protected PDF\(s\)/.test(r.text) && /1 were NOT opened by that password/.test(r.text) && /other bank\.pdf/.test(r.text), r.text);
  check('it points out the unprotected copy lying beside a protected original', /2019-03 energia \(unlocked\)\.pdf\s+looks like an unprotected copy of\s+.*2019-0[34] energia\.pdf/.test(r.text), r.text);
  const sr = await s.call('search_contents', { query: 'FX-LOCKED-7701', path: `${W}/bills` });
  const srScan = await s.call('search_contents', { query: '48213', path: `${W}/bills` });
  check('their text is searchable afterwards, including the scanned one', ['2019-03 energia.pdf', '2019-04 energia.pdf', '2012 conta.pdf'].every((n) => sr.text.includes(n)) && srScan.text.includes('scan protected.pdf'), `${sr.text} | ${srScan.text}`);
  cancelled();
  r = await s.call('read_file', { path: `${W}/bills/old/2012 conta.pdf` });
  check('and they are read like any other document, with no password asked again', !r.isError && /FX-LOCKED-7701/.test(r.text) && /opened with a password/.test(r.text), r.text.slice(0, 300));
  typed(ODD);
  r = await s.call('unlock_folder', { path: `${W}/bills` });
  check('a second call with another password (with quotes, spaces and an accent in it) opens the rest', !r.isError && /1 of 1 password-protected PDF\(s\)/.test(r.text), r.text);
  const before = fs.readFileSync(`${FX}/locked-aes256.pdf`);
  check('the files in Tresorit are byte for byte unchanged, and no unlocked copy was made', fs.readFileSync(T(`${W}/bills/2019-03 energia.pdf`)).equals(before) && fs.readdirSync(T(`${W}/bills`)).length === 7, fs.readdirSync(T(`${W}/bills`)).join(', '));
  const st = (await s.call('connector_status')).text;
  check('the status report counts them as opened, no longer as unreadable', /5 password-protected PDF\(s\) were opened with a password and are searchable/.test(st) && /Unreadable by reason: 0 password-protected/.test(st), (st.match(/Unreadable[^\n]*\n[^\n]*\n[^\n]*/) || [''])[0]);
  await sleep(5600);
  const leak = [PW, ODD].map((p) => holds(s.DATA, p)).filter(Boolean);
  const log = logOf(s.DATA);
  check('neither password is in any file the connector keeps, nor in any reply or log line', leak.length === 0 && !log.includes(PW) && !log.includes(ODD) && /\| UNLOCK/.test(log), `found in ${leak.join(', ')}`);
  // a changed file has to be unlocked again; the others stay
  fs.appendFileSync(T(`${W}/bills/2019-04 energia.pdf`), '\n');
  cancelled();
  r = await s.call('read_file', { path: `${W}/bills/2019-04 energia.pdf` });
  const r3 = await s.call('read_file', { path: `${W}/bills/2019-03 energia.pdf` });
  check('if a protected file changes it must be unlocked again; the others stay searchable', r.isError && /password-protected/.test(r.text) && !r3.isError && /FX-LOCKED-7701/.test(r3.text), `${r.text.slice(0, 160)} | ${r3.text.slice(0, 100)}`);
  // refusals
  put('Strongbox/keys/locked.pdf', `${FX}/locked-aes256.pdf`);
  typed(PW);
  r = await s.call('unlock_folder', { path: 'Strongbox/keys' });
  const r4 = await s.call('read_file', { path: 'Strongbox/keys/locked.pdf', ask_password: true });
  await sleep(5600);
  check('a "do not index" folder cannot be unlocked into the index, but a single file there can still be read once', r.isError && /do not index/.test(r.text) && !r4.isError && /FX-LOCKED-7701/.test(r4.text) && !fs.readFileSync(`${s.DATA}/index/catalog.json`, 'utf8').includes('Strongbox'), `${r.text} | ${r4.text.slice(0, 100)}`);
  fs.rmSync(T('Strongbox/keys'), { recursive: true, force: true });
  r = await s.call('unlock_folder', { path: `${W}/mixed` });
  check('a folder with nothing protected says so and asks for no password', !r.isError && /No password-protected PDF was found/.test(r.text), r.text);
  await s.client.close();

  // through a copy that is not the worker, with the background reading on: the worker does not undo it
  const D3 = `${BASE}/data-v14-pw3`; fs.rmSync(D3, { recursive: true, force: true });
  const bg = { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_INDEX_INTERVAL_MS: '1500', TRESORIT_BG_TAKEOVER_MS: '800', TRESORIT_OCR: 'false' };
  const three = await Promise.all([0, 1, 2].map(() => start('pw3', bg, { data: D3, keep: true })));
  let sts = []; for (let i = 0; i < 200; i++) { await sleep(300); sts = await Promise.all(three.map(async (c) => (await c.call('connector_status')).text)); if (sts.every((x) => /up to date as of/.test(x))) break; }
  const wp = (() => { try { return JSON.parse(fs.readFileSync(`${D3}/index/background.lock`, 'utf8')).pid; } catch { return 0; } })();
  const follower = three.find((c) => c.pid !== wp);
  typed(PW);
  r = await follower.call('unlock_folder', { path: `${W}/bills`, recursive: false });
  await sleep(9000); // several passes of the worker, and the copies exchanging what they know
  const finds = await Promise.all(three.map((c) => c.call('search_contents', { query: 'FX-LOCKED-7701', path: `${W}/bills` })));
  const sts2 = await Promise.all(three.map(async (c) => (await c.call('connector_status')).text));
  check('unlocked through a copy that is not the worker: every copy can search them, and the worker\'s next passes do not lock them again', !r.isError && finds.every((f) => f.text.includes('2019-03 energia.pdf')) && sts2.every((x) => /password-protected PDF\(s\) were opened with a password/.test(x)), `${r.text.slice(0, 200)} | ${finds.map((f) => f.text.slice(0, 80)).join(' | ')}`);
  for (const c of three) await c.client.close();
  await sleep(300);
  check('...and the password is in none of the shared files either', !holds(D3, PW), holds(D3, PW));
}

console.log('D. The transfer folder');
{
  const s = await start('transfer');
  put(`${W}/t/a/report.txt`, 'report from a'); put(`${W}/t/b/report.txt`, 'report from b'); put(`${W}/t/folder/x.txt`, 'x'); put(`${W}/t/folder/sub/y.txt`, 'y');
  let r = await s.call('export_to_transfer', { paths: [`${W}/t/a/report.txt`, `${W}/t/b/report.txt`, `${W}/t/folder`] });
  const batch = fs.readdirSync(`${s.DATA}/transfer`).find((n) => /_export/.test(n));
  const rd = (rel) => { try { return fs.readFileSync(`${s.DATA}/transfer/${batch}/${rel}`, 'utf8'); } catch { return null; } };
  check('three items copied out in one call, into one dated folder, same-named files kept apart, a folder kept whole', !r.isError && rd(`${W}/t/a/report.txt`) === 'report from a' && rd(`${W}/t/b/report.txt`) === 'report from b' && rd(`${W}/t/folder/sub/y.txt`) === 'y' && /Copied 3 item/.test(r.text), r.text);
  r = await s.call('export_to_transfer', { paths: [`${W}/t/a/report.txt`, 'Birch Labs'] });
  check('if one of several cannot be exported, nothing of that call is copied', r.isError && fs.readdirSync(`${s.DATA}/transfer`).length === 1, `${r.text} | ${fs.readdirSync(`${s.DATA}/transfer`).join(', ')}`);
  r = await s.call('export_to_transfer', { path: `${W}/t/a/report.txt` });
  r = await s.call('export_to_transfer', { path: `${W}/t/b/report.txt` });
  check('single exports of same-named files still do not overwrite each other', fs.readdirSync(`${s.DATA}/transfer`).filter((n) => /^report/.test(n)).length === 2, fs.readdirSync(`${s.DATA}/transfer`).join(', '));
  fs.writeFileSync(`${s.DATA}/transfer/edited.txt`, 'edited outside'); fs.writeFileSync(`${s.DATA}/transfer/second.txt`, 'second');
  r = await s.call('import_from_transfer', { names: ['edited.txt', 'second.txt', `${batch}/${W}/t/a/report.txt`, '../../etc/passwd', 'missing.txt'], destination: `${W}/t/in` });
  check('five items brought in in one call: three arrive, the two bad ones are refused and reported, nothing else is touched', !r.isError && /3 of 5 item/.test(r.text) && fs.readFileSync(T(`${W}/t/in/edited.txt`), 'utf8') === 'edited outside' && fs.existsSync(T(`${W}/t/in/report.txt`)) && /outside the transfer folder/.test(r.text) && /missing\.txt/.test(r.text), r.text);
  r = await s.call('import_from_transfer', { names: [`${batch}/${W}/t/b/report.txt`], destination: `${W}/t/in` });
  check('bringing in a same-named file does not overwrite the one already there', /0 of 1 item/.test(r.text) && fs.readFileSync(T(`${W}/t/in/report.txt`), 'utf8') === 'report from a' && /already exists/.test(r.text), r.text);
  // emptying
  fs.symlinkSync(T(`${W}/t/folder`), `${s.DATA}/transfer/link to tresorit`);
  const old = new Date(Date.now() - 30 * 3600 * 1000); fs.utimesSync(`${s.DATA}/transfer/${batch}`, old, old);
  let st = (await s.call('connector_status')).text;
  check('the status report shows what is in the transfer folder and flags copies older than 24 hours', /Transfer folder: .* item\(s\), .*the oldest/.test(st) && /1 item\(s\) are more than 24 hours old/.test(st) && /tresorit_clear_transfer/.test(st), (st.match(/Transfer folder[^\n]*/) || [''])[0]);
  r = await s.call('clear_transfer', { older_than_hours: 24 });
  const n0 = fs.readdirSync(`${s.DATA}/transfer`).length;
  check('emptying first only lists: names, sizes and ages, and nothing is removed', /NOTHING HAS BEEN REMOVED/.test(r.text) && /1 of \d+ item/.test(r.text) && /day\(s\) old|hour\(s\) old/.test(r.text) && fs.readdirSync(`${s.DATA}/transfer`).length === n0, r.text);
  const t1 = tok(r.text);
  fs.writeFileSync(`${s.DATA}/transfer/${batch}/added later.txt`, 'new');
  r = await s.call('clear_transfer', { older_than_hours: 24, confirm_token: t1 });
  check('if the folder changed since the preview, the code is refused and nothing is removed', r.isError && fs.existsSync(`${s.DATA}/transfer/${batch}`), r.text);
  r = await s.call('clear_transfer', { older_than_hours: 24 }); fs.utimesSync(`${s.DATA}/transfer/${batch}`, old, old);
  r = await s.call('clear_transfer', { older_than_hours: 24 });
  r = await s.call('clear_transfer', { older_than_hours: 24, confirm_token: tok(r.text) });
  check('with the right code only the old item goes; newer ones stay', !r.isError && !fs.existsSync(`${s.DATA}/transfer/${batch}`) && fs.readdirSync(`${s.DATA}/transfer`).length === n0 - 1, `${r.text} | ${fs.readdirSync(`${s.DATA}/transfer`).join(', ')}`);
  r = await s.call('clear_transfer', {});
  r = await s.call('clear_transfer', { confirm_token: tok(r.text) });
  check('emptying everything removes a link without following it: the Tresorit folder it points to is untouched', !r.isError && fs.readdirSync(`${s.DATA}/transfer`).length === 0 && fs.readFileSync(T(`${W}/t/folder/sub/y.txt`), 'utf8') === 'y', r.text);
  r = await s.call('clear_transfer', {});
  check('an empty transfer folder says so', /is empty/.test(r.text));
  check('listing and emptying are in the access log', /TRANSFER .*removed for good/.test(logOf(s.DATA)) && /TRANSFER .*listed/.test(logOf(s.DATA)));
  await s.client.close();
}

console.log('E. Identical files');
{
  const s = await start('identical', { TRESORIT_NO_INDEX: 'Strongbox' });
  const blobA = crypto.randomBytes(40000); const blobB = crypto.randomBytes(40000); const blobC = crypto.randomBytes(900);
  put(`${W}/dup/one/contract.pdf`, blobA); put(`${W}/dup/two/contract (1).pdf`, blobA); put(`${W}/dup/two/Copy of contract.pdf`, blobA);
  put(`${W}/dup/one/other same size.bin`, blobB); put(`${W}/dup/small a.txt`, blobC); put(`${W}/dup/small b.txt`, blobC); put(`${W}/dup/zero a.txt`, Buffer.alloc(0)); put(`${W}/dup/zero b.txt`, Buffer.alloc(0));
  put('Strongbox/dup/secret copy.bin', blobA);
  let r = await s.call('find_identical', { path: `${W}/dup` });
  const groups = r.text.split('\n\n');
  check('identical files are grouped whatever their names; same-sized different files and empty files are not', !r.isError && /2 group\(s\) of identical files/.test(r.text) && groups.some((g) => g.includes('contract.pdf') && g.includes('contract (1).pdf') && g.includes('Copy of contract.pdf')) && groups.some((g) => g.includes('small a.txt') && g.includes('small b.txt')) && !r.text.includes('other same size') && !r.text.includes('zero a'), r.text);
  check('it reports how much space the extra copies take, and changes nothing', /The extra copies take/.test(r.text) && /Nothing was changed/.test(r.text) && fs.readdirSync(T(`${W}/dup/two`)).length === 2);
  r = await s.call('find_identical', { path: '' , min_size_kb: 30 });
  check('across all of Tresorit, the "do not index" folder is left out, and small files can be ignored', !r.isError && r.text.includes('contract (1).pdf') && !r.text.includes('secret copy.bin') && !r.text.includes('small a.txt'), r.text.slice(0, 600));
  r = await s.call('find_identical', { path: 'Strongbox/dup' });
  check('a "do not index" folder is only looked at when it is named', !r.isError && /0 group/.test(r.text), r.text.slice(0, 200));
  fs.writeFileSync(`${HOME}/Downloads/new contract.pdf`, blobA); fs.writeFileSync(`${HOME}/Downloads/never seen.pdf`, crypto.randomBytes(40000));
  r = await s.call('find_identical', { path: W, file: '~/Downloads/new contract.pdf' });
  const r2 = await s.call('find_identical', { path: W, file: '~/Downloads/never seen.pdf' });
  check('"is this file already in Tresorit?": yes with the places, or no', !r.isError && /3 file\(s\)/.test(r.text) && r.text.includes('Copy of contract.pdf') && /No file in/.test(r2.text), `${r.text} | ${r2.text}`);
  r = await s.call('find_identical', { path: W, file: '~/.ssh/id_rsa' });
  check('the file to compare cannot be taken from a protected place', r.isError && /cannot be used/.test(r.text), r.text);
  r = await s.call('find_identical', { path: W, file: `${W}/dup/one/contract.pdf` });
  check('a file inside Tresorit can be compared too, and is not listed as its own copy', !r.isError && /2 file\(s\)/.test(r.text) && !/- .*dup\/one\/contract\.pdf/.test(r.text), r.text);
  const prints = fs.readFileSync(`${s.DATA}/index/fingerprints.json`, 'utf8');
  check('only fingerprints are remembered between runs, not content', /"h":"[0-9a-f]{64}"/.test(prints) && !prints.includes(blobC.toString('latin1').slice(0, 20)) && Object.values(JSON.parse(prints)).every((v) => Object.keys(v).sort().join() === 'h,m,s'));
  check('the search is in the access log', /\| IDENTICAL/.test(logOf(s.DATA)));
  await s.client.close();
  // a large folder is compared in stages
  for (let i = 0; i < 40; i++) { const b = crypto.randomBytes(200000 + i); put(`${W}/dup/many/a-${i}.bin`, b); put(`${W}/dup/many/b-${i}.bin`, b); }
  const slow = await start('identical-slow', { TRESORIT_IDENTICAL_LIMIT_MS: '15' });
  let rounds = 0; let last = '';
  for (; rounds < 60; rounds++) { last = (await slow.call('find_identical', { path: `${W}/dup/many`, limit: 100 })).text; if (!/Not finished/.test(last)) break; }
  check('a comparison too long for one call says so, and calling again finishes it', rounds > 0 && /40 group\(s\) of identical files/.test(last), `${rounds} extra call(s) | ${last.slice(0, 200)}`);
  await slow.client.close();
  fs.rmSync(T('Strongbox/dup'), { recursive: true, force: true });
}

console.log('F. Status report and immediate indexing');
{
  const script = `${BASE}/data-v14-power.sh`;
  fs.writeFileSync(script, `echo "Now drawing from 'Battery Power'"\necho " -InternalBattery-0 (id=1)\t64%; discharging; 3:10 remaining present: true"\n`);
  const s = await start('status', { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_INDEX_INTERVAL_MS: '600000', TRESORIT_POWER_CMD: script, TRESORIT_OCR: 'false', TRESORIT_PAUSE_ON_BATTERY: 'false' });
  let st = ''; for (let i = 0; i < 200; i++) { await sleep(300); st = (await s.call('connector_status')).text; if (/up to date as of/.test(st)) break; }
  check('the status report shows the power source with the charge level, and which copy does the background reading', /Power: on battery \(64%\)/.test(st) && /Background reading is done by: this copy of the connector/.test(st), (st.match(/Background reading is done[^\n]*\n[^\n]*/) || [''])[0]);
  await s.call('write_file', { path: `${W}/now/fresh note.txt`, content: 'indexed at once marker-fresh-9911' });
  fs.writeFileSync(`${HOME}/Downloads/arrives.txt`, 'arrives marker-fresh-9912');
  await s.call('import_file', { source: '~/Downloads/arrives.txt', destination: `${W}/now/` });
  let ok = false; let a = ''; let b = '';
  for (let i = 0; i < 20 && !ok; i++) { await sleep(250); a = (await s.call('file_info', { path: `${W}/now/fresh note.txt` })).text; b = (await s.call('file_info', { path: `${W}/now/arrives.txt` })).text; ok = /Text search: searchable/.test(a) && /Text search: searchable/.test(b); }
  check('a file saved or brought in through the connector is in the search index within seconds, without waiting for the next pass', ok, `${a.split('\n').pop()} | ${b.split('\n').pop()}`);
  await s.call('write_file', { path: `${W}/now/fresh note.txt`, content: 'v2', overwrite: true });
  const hold = `${s.DATA}/deleted`; const bdir = fs.readdirSync(hold)[0];
  const man = JSON.parse(fs.readFileSync(`${hold}/${bdir}/manifest.json`, 'utf8')); man.when = '2026-09-01 10:00:00'; fs.writeFileSync(`${hold}/${bdir}/manifest.json`, JSON.stringify(man));
  st = (await s.call('connector_status')).text;
  check('the holding area is shown with its size and the age of its oldest batch, with a suggestion once that is over 30 days', /Holding area .* 1 batch\(es\), .*the oldest \d+ day\(s\) old/.test(st) && /older than 30 days can be cleared with tresorit_clear_deleted \(the user must approve\)/.test(st), (st.match(/Holding area[^\n]*/) || [''])[0]);
  await s.client.close();
  const other = await start('status2', { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false' }, { data: `${BASE}/data-v14-status`, keep: true });
  const w2 = await start('status3', { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false' }, { data: `${BASE}/data-v14-status`, keep: true });
  await sleep(1500);
  const both = [(await other.call('connector_status')).text, (await w2.call('connector_status')).text];
  check('of two copies, one says it does the background reading and the other says another copy does', both.filter((x) => /done by: this copy/.test(x)).length === 1 && both.filter((x) => /done by: another copy/.test(x)).length === 1, both.map((x) => (x.match(/Background reading is done[^\n]*/) || [''])[0]).join(' | '));
  await other.client.close(); await w2.client.close();
}

fs.rmSync(T(W), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
