import { Client, StdioClientTransport, ElicitRequestSchema, MOCK, BUNDLE } from './lib/env.mjs';
// Version 1.3.0: bringing files in from the Mac, copies out, files received in parts, holding-area clean-up,
// "do not index" folders and the battery pause.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
// These tests put old-dated batches into the holding area to test clearing and restoring by hand; the automatic
// clearing added in 1.4.1 is switched off here so that it cannot take them first (test16 covers it).
process.env.TRESORIT_HOLDING_DAYS ??= '0';

const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const LIB = path.join(path.dirname(SERVER), 'lib');
const BASE = `${MOCK}`;
const ROOT = `${BASE}/Tresors`;
const HOME = `${BASE}/data-v13-home`;
const VOLS = `${BASE}/data-v13-volumes`;
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 700)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const W = 'Birch Labs/v13';

function makeHome() {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(VOLS, { recursive: true, force: true });
  for (const d of ['Downloads', 'Desktop', 'Documents/Projects', 'Applications/Thing.app/Contents', 'Pictures/Photos Library.photoslibrary/database',
    'Library/Keychains', 'Library/Application Support/Browser', 'Library/Mobile Documents/com~apple~CloudDocs/Notes', 'Library/CloudStorage/OneDrive-Alder/Docs',
    'Library/CloudStorage/Tresorit-MorganSmith/Alder Works UK', '.ssh', '.config/tool', 'Documents/.hidden-folder']) fs.mkdirSync(`${HOME}/${d}`, { recursive: true });
  fs.mkdirSync(`${VOLS}/USB DRIVE/Scans`, { recursive: true }); fs.mkdirSync(`${VOLS}/USB DRIVE/.Spotlight-V100`, { recursive: true });
  const w = (rel, content) => fs.writeFileSync(`${HOME}/${rel}`, content);
  w('Downloads/Quarterly report Q3.pdf', 'Q3-REPORT-CONTENT-AAA');
  w('Downloads/quarterly notes.txt', 'NOTES-CONTENT-BBB');
  w('Downloads/Relatório final.pdf', 'RELATORIO-CONTENT-CCC'); // accent stored in decomposed form, as a Mac does
  w('Downloads/invoice.pdf', 'INVOICE-OLD');
  w('Documents/Projects/plan.docx', 'PLAN-CONTENT-DDD');
  w('Documents/.hidden-folder/x.txt', 'HIDDEN-EEE');
  w('Applications/Thing.app/Contents/Info.plist', 'APP');
  w('Pictures/Photos Library.photoslibrary/database/photos.db', 'PHOTOS');
  w('Library/Keychains/login.keychain-db', 'KEYCHAIN-FFF');
  w('Library/Application Support/Browser/Cookies', 'COOKIES-GGG');
  w('Library/Mobile Documents/com~apple~CloudDocs/Notes/icloud note.txt', 'ICLOUD-HHH');
  w('Library/CloudStorage/OneDrive-Alder/Docs/onedrive file.txt', 'ONEDRIVE-III');
  w('Library/CloudStorage/Tresorit-MorganSmith/Alder Works UK/stale.txt', 'STALE-JJJ');
  w('.ssh/id_rsa', 'PRIVATE-KEY-KKK');
  w('.config/tool/token', 'TOKEN-LLL');
  w('passwords.kdbx', 'KDBX-MMM');
  fs.writeFileSync(`${VOLS}/USB DRIVE/Scans/usb scan.pdf`, 'USB-NNN');
  fs.writeFileSync(`${VOLS}/USB DRIVE/.Spotlight-V100/store.db`, 'SPOT-OOO');
  fs.symlinkSync(`${HOME}/Library/Keychains/login.keychain-db`, `${HOME}/Documents/innocent name.txt`);
  fs.symlinkSync(`${HOME}/Library/Keychains`, `${HOME}/Documents/keys link`);
  fs.symlinkSync(`${HOME}/Documents/Projects`, `${HOME}/Desktop/projects link`);
  execSync(`truncate -s 1M "${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Notes/not downloaded.pdf"`);
  // a folder to bring in whole
  for (const d of ['pack/sub/deeper', 'pack/.git', 'pack/empty']) fs.mkdirSync(`${HOME}/Downloads/${d}`, { recursive: true });
  w('Downloads/pack/one.txt', 'ONE'); w('Downloads/pack/sub/two.txt', 'TWO'); w('Downloads/pack/sub/deeper/três \u{1F600}.txt', 'THREE');
  w('Downloads/pack/.git/config', 'GIT'); w('Downloads/pack/.DS_Store', 'junk');
  fs.symlinkSync(`${HOME}/.ssh/id_rsa`, `${HOME}/Downloads/pack/sub/key link`);
  fs.mkdirSync(`${HOME}/Downloads/hollow/.only-hidden`, { recursive: true });
  const old = new Date(Date.now() - 86400000 * 3); fs.utimesSync(`${HOME}/Downloads/invoice.pdf`, old, old);
}

async function start(name, extraEnv = {}, opts = {}) {
  const DATA = `${BASE}/data-v13-${name}`; if (!opts.keep) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: `${HOME}:${VOLS}`, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_PREFLIGHT_GATE: 'off', ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: opts.elicit ? { elicitation: {} } : {} });
  if (opts.elicit) client.setRequestHandler(ElicitRequestSchema, async () => opts.elicit());
  let protoErrors = 0; client.onerror = () => { protoErrors++; };
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError }; } catch (e) { return { text: `PROTOCOL ERROR ${e.message}`, isError: true, protocol: true }; }
  };
  return { client, call, DATA, errors: () => protoErrors, tools: async () => (await client.listTools()).tools };
}
const tok = (t) => (t.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
const T = (rel) => `${ROOT}/${rel}`;
const inT = (rel) => fs.existsSync(T(rel));

makeHome();
fs.rmSync(T(W), { recursive: true, force: true });

console.log('A. The rules for places outside Tresorit (checked directly)');
{
  const { makeOutside, fingerprint, sameFingerprint } = await import(`${LIB}/outside.js`);
  const o = makeOutside({ home: HOME, roots: [HOME, VOLS], tresoritRoot: ROOT, dataDir: `${BASE}/data-v13-x` });
  const allowed = ['Downloads/Quarterly report Q3.pdf', 'Documents/Projects/plan.docx', 'Library/Mobile Documents/com~apple~CloudDocs/Notes/icloud note.txt', 'Library/CloudStorage/OneDrive-Alder/Docs/onedrive file.txt', 'Downloads/pack'];
  const refused = ['Library/Keychains/login.keychain-db', 'Library/Application Support/Browser/Cookies', 'Library/Mobile Documents', 'Library/Mobile Documents/iCloud~com~some~app/Documents/data.db', 'Library/CloudStorage/Tresorit-MorganSmith/Alder Works UK/stale.txt', '.ssh/id_rsa', '.config/tool/token',
    'Documents/.hidden-folder/x.txt', 'Applications/Thing.app/Contents/Info.plist', 'Pictures/Photos Library.photoslibrary/database/photos.db', 'passwords.kdbx', 'Library'];
  const a = allowed.filter((p) => o.protectedReason(`${HOME}/${p}`) !== '');
  const r = refused.filter((p) => o.protectedReason(`${HOME}/${p}`) === '');
  check('ordinary documents, iCloud Drive and other cloud drives are allowed', a.length === 0, a.join(', '));
  check('Library, hidden folders, applications, photo libraries and key stores are protected', r.length === 0, r.join(', '));
  check('an external drive is allowed, its hidden system folders are not', o.protectedReason(`${VOLS}/USB DRIVE/Scans/usb scan.pdf`) === '' && o.protectedReason(`${VOLS}/USB DRIVE/.Spotlight-V100/store.db`) !== '');
  check('system places and other users are outside the allowed area', ['/etc/passwd', '/Users/someone-else/file.txt', '/private/var/db/x', '/'].every((p) => o.protectedReason(p) !== ''));
  check('Tresorit itself and the connector data folder are not sources', o.protectedReason(`${ROOT}/Birch Labs`) !== '' && o.protectedReason(`${BASE}/data-v13-x/logs`) !== '');
  const thrown = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
  check('a link is refused as a source, whatever it points to', /link/.test(thrown(() => o.resolve(`${HOME}/Documents/innocent name.txt`))) && /link/.test(thrown(() => o.resolve(`${HOME}/Desktop/projects link`))));
  check('a path that passes through a link into a protected place is refused', /Library|key store/.test(thrown(() => o.resolve(`${HOME}/Documents/keys link/login.keychain-db`))));
  check('"~/../.." tricks, relative paths and odd input are refused', [`~/../../etc/passwd`, 'Downloads/x.pdf', '', '   ', `${HOME}/Downloads/a\0b`].every((p) => thrown(() => o.resolve(p)) !== ''));
  check('the whole home folder and the list of drives cannot be imported, only listed', thrown(() => o.resolve('~')) !== '' && thrown(() => o.resolve(VOLS)) !== '' && o.resolve('~', { forListing: true }).isRoot);
  // fingerprints
  const d1 = `${BASE}/data-v13-fp-a`; const d2 = `${BASE}/data-v13-fp-b`;
  for (const d of [d1, d2]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(`${d}/s`, { recursive: true }); fs.writeFileSync(`${d}/x.txt`, 'same'); fs.writeFileSync(`${d}/s/y.txt`, 'same too'); }
  const same = sameFingerprint(await fingerprint(d1), await fingerprint(d2));
  fs.writeFileSync(`${d2}/s/y.txt`, 'same tOo');
  const changed = sameFingerprint(await fingerprint(d1), await fingerprint(d2));
  fs.writeFileSync(`${d2}/s/y.txt`, 'same too'); fs.writeFileSync(`${d2}/extra.txt`, '');
  const extra = sameFingerprint(await fingerprint(d1), await fingerprint(d2));
  fs.rmSync(`${d2}/extra.txt`); fs.rmSync(`${d2}/x.txt`);
  const missing = sameFingerprint(await fingerprint(d1), await fingerprint(d2));
  check('the copy check notices one changed character, an extra file and a missing file', same && !changed && !extra && !missing, `${same} ${changed} ${extra} ${missing}`);
  fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
}

console.log('B. Bringing files in');
{
  const s = await start('import');
  const tools = await s.tools();
  check('the connector offers 28 tools, including the five from 1.3', tools.length === 28 && ['tresorit_import_file', 'tresorit_list_outside_folder', 'tresorit_export_file', 'tresorit_receive_file', 'tresorit_clear_deleted'].every((n) => tools.some((t) => t.name === n)), tools.length);
  let r = await s.call('list_outside_folder', {});
  check('Downloads is listed by name, newest first, without contents, links marked', !r.isError && r.text.includes('Quarterly report Q3.pdf') && r.text.indexOf('invoice.pdf') > r.text.indexOf('quarterly notes.txt') && !/CONTENT|INVOICE-OLD/.test(r.text), r.text);
  r = await s.call('list_outside_folder', { path: '~/Documents' });
  check('links and hidden items are shown as not importable or not shown at all', /innocent name\.txt.*link/.test(r.text) && !r.text.includes('.hidden-folder') && /hidden item/.test(r.text), r.text);
  r = await s.call('list_outside_folder', { path: '~' });
  check('the home folder can be listed, with Library marked as protected', !r.isError && /Library\/.*protected/.test(r.text) && !r.text.includes('.ssh'), r.text);
  const bad = [];
  for (const p of ['~/Library', '~/.ssh', '~/Library/Keychains', '/etc', '/', `${ROOT}`, `${s.DATA}/logs`]) { const x = await s.call('list_outside_folder', { path: p }); if (!x.isError) bad.push(p); }
  check('protected places cannot even be listed', bad.length === 0, bad.join(', '));

  r = await s.call('import_file', { source: 'Quarterly report Q3.pdf', destination: W });
  check('a bare name takes the exact file from Downloads; the reply shows no contents', !r.isError && fs.readFileSync(T(`${W}/Quarterly report Q3.pdf`), 'utf8') === 'Q3-REPORT-CONTENT-AAA' && /exact name/.test(r.text) && !r.text.includes('Q3-REPORT-CONTENT') && fs.existsSync(`${HOME}/Downloads/Quarterly report Q3.pdf`), r.text);
  r = await s.call('import_file', { source: 'quarterly', destination: `${W}/words` });
  check('words pick the newest match and say how many others matched', !r.isError && /newest match/.test(r.text) && /1 other item/.test(r.text) && inT(`${W}/words`), r.text);
  r = await s.call('import_file', { source: 'relatorio final', destination: W });
  check('a name typed without accents finds the accented file', !r.isError && fs.readdirSync(T(W)).some((n) => n.normalize('NFC') === 'Relatório final.pdf'), r.text);
  r = await s.call('import_file', { source: 'no such thing zzz', destination: W });
  check('no match in Downloads: a clear answer, nothing done', r.isError && /Nothing in Downloads/.test(r.text), r.text);

  const refusedSources = ['~/Library/Keychains/login.keychain-db', '~/Library/Application Support/Browser/Cookies', '~/.ssh/id_rsa', '~/.config/tool/token', '~/Documents/.hidden-folder/x.txt', '~/Applications/Thing.app',
    '~/Pictures/Photos Library.photoslibrary', '~/passwords.kdbx', '~/Documents/innocent name.txt', '~/Documents/keys link/login.keychain-db', '~/Desktop/projects link', '/etc/passwd', '~/../../etc/passwd', '~',
    VOLS, `${VOLS}/USB DRIVE/.Spotlight-V100/store.db`, `${ROOT}/Alder Works UK/03 - Finance`, `${s.DATA}/logs`, '~/Library/CloudStorage/Tresorit-MorganSmith/Alder Works UK/stale.txt', 'Documents/Projects/plan.docx'];
  const got = [];
  for (const src of refusedSources) { const x = await s.call('import_file', { source: src, destination: `${W}/must-not-arrive` }); if (!x.isError || x.protocol || inT(`${W}/must-not-arrive`)) got.push(src); }
  check(`${refusedSources.length} protected or invalid sources are all refused`, got.length === 0, got.join(' | '));
  const leaks = fs.readFileSync(`${s.DATA}/logs/${fs.readdirSync(`${s.DATA}/logs`)[0]}`, 'utf8');
  check('no secret content appears in any reply or in the log', !/KEYCHAIN-FFF|COOKIES-GGG|PRIVATE-KEY-KKK|TOKEN-LLL|HIDDEN-EEE|KDBX-MMM/.test(leaks));

  r = await s.call('import_file', { source: '~/Library/Mobile Documents/com~apple~CloudDocs/Notes/icloud note.txt', destination: W });
  const r2 = await s.call('import_file', { source: `${VOLS}/USB DRIVE/Scans/usb scan.pdf`, destination: `${W}/from usb.pdf` });
  const r3 = await s.call('import_file', { source: '~/Library/CloudStorage/OneDrive-Alder/Docs/onedrive file.txt', destination: W });
  check('files come in from iCloud Drive, another cloud drive and an external drive', !r.isError && !r2.isError && !r3.isError && fs.readFileSync(T(`${W}/from usb.pdf`), 'utf8') === 'USB-NNN' && inT(`${W}/icloud note.txt`) && inT(`${W}/onedrive file.txt`), r.text + r2.text + r3.text);
  r = await s.call('import_file', { source: '~/Library/Mobile Documents/com~apple~CloudDocs/Notes/not downloaded.pdf', destination: W });
  check('a cloud file that is not downloaded yet is not imported as an empty shell', r.isError && /not been downloaded/.test(r.text) && !inT(`${W}/not downloaded.pdf`), r.text);

  // destination rules
  const d1 = await s.call('import_file', { source: '~/Documents/Projects/plan.docx', destination: 'plan.docx' });
  const d2 = await s.call('import_file', { source: '~/Documents/Projects/plan.docx', destination: '../outside.docx' });
  const d3 = await s.call('import_file', { source: '~/Documents/Projects/plan.docx', destination: '/tmp/x.docx' });
  check('the destination must be inside a tresor', d1.isError && d2.isError && (d3.isError || !fs.existsSync('/tmp/x.docx')) && !fs.existsSync(`${ROOT}/plan.docx`) && !fs.existsSync(`${BASE}/outside.docx`), d1.text + d2.text + d3.text);

  // duplicates and overwriting
  r = await s.call('import_file', { source: '~/Downloads/Quarterly report Q3.pdf', destination: W });
  check('the same file again: recognised as identical, nothing copied', !r.isError && /identical/.test(r.text) && fs.readdirSync(T(W)).filter((n) => /Quarterly/.test(n)).length === 1, r.text);
  fs.copyFileSync(`${HOME}/Downloads/Quarterly report Q3.pdf`, `${HOME}/Downloads/Quarterly report Q3 (1).pdf`);
  r = await s.call('import_file', { source: '~/Downloads/Quarterly report Q3 (1).pdf', destination: W });
  check('the same content under another name is noticed', !r.isError && /identical file is already in that folder/.test(r.text) && !inT(`${W}/Quarterly report Q3 (1).pdf`), r.text);
  r = await s.call('import_file', { source: '~/Downloads/Quarterly report Q3 (1).pdf', destination: W, allow_duplicate: true });
  check('...and comes in anyway when asked', !r.isError && inT(`${W}/Quarterly report Q3 (1).pdf`), r.text);
  fs.writeFileSync(`${HOME}/Downloads/Quarterly report Q3.pdf`, 'Q3-REPORT-REVISED-ZZZ');
  r = await s.call('import_file', { source: '~/Downloads/Quarterly report Q3.pdf', destination: W });
  check('a different file with the same name is never overwritten silently', r.isError && /already exists/.test(r.text) && fs.readFileSync(T(`${W}/Quarterly report Q3.pdf`), 'utf8') === 'Q3-REPORT-CONTENT-AAA', r.text);
  r = await s.call('import_file', { source: '~/Downloads/Quarterly report Q3.pdf', destination: W, overwrite: true });
  const ob = (r.text.match(/batch (\S+_replaced_\w+)/) || [])[1];
  check('with overwrite the old version is kept in the holding area', !r.isError && fs.readFileSync(T(`${W}/Quarterly report Q3.pdf`), 'utf8') === 'Q3-REPORT-REVISED-ZZZ' && ob && fs.readFileSync(`${s.DATA}/deleted/${ob}/files/${W}/Quarterly report Q3.pdf`, 'utf8') === 'Q3-REPORT-CONTENT-AAA', r.text);

  // a whole folder
  r = await s.call('import_file', { source: '~/Downloads/pack', destination: W });
  const t1 = tok(r.text);
  check('a folder gives a preview with counts first, and nothing is copied', /NOTHING HAS BEEN COPIED/.test(r.text) && /3 file\(s\)/.test(r.text) && /left out/.test(r.text) && t1 && !inT(`${W}/pack`), r.text);
  const w1 = await s.call('import_file', { source: '~/Downloads/pack', destination: W, confirm_token: 'deadbeef' });
  const w2 = await s.call('import_file', { source: '~/Downloads/pack', destination: `${W}/elsewhere`, confirm_token: t1 });
  const w3 = await s.call('import_file', { source: '~/Downloads/pack', destination: W, mode: 'move', confirm_token: t1 });
  check('a wrong code, or the right code for a different destination or mode, does nothing', w1.isError && w2.isError && w3.isError && !inT(`${W}/pack`) && !inT(`${W}/elsewhere`) && fs.existsSync(`${HOME}/Downloads/pack/one.txt`), w1.text + w2.text + w3.text);
  r = await s.call('import_file', { source: '~/Downloads/pack', destination: W, confirm_token: tok((await s.call('import_file', { source: '~/Downloads/pack', destination: W })).text) });
  const deep = fs.existsSync(T(`${W}/pack/sub/deeper`)) ? fs.readdirSync(T(`${W}/pack/sub/deeper`)) : [];
  check('with the code the folder arrives complete, minus hidden items, clutter and links', !r.isError && fs.readFileSync(T(`${W}/pack/sub/two.txt`), 'utf8') === 'TWO' && deep.length === 1 && !inT(`${W}/pack/.git`) && !inT(`${W}/pack/.DS_Store`) && !inT(`${W}/pack/sub/key link`) && /left out/.test(r.text), r.text + deep);
  r = await s.call('import_file', { source: '~/Downloads/hollow', destination: W });
  check('a folder with nothing importable in it is refused', r.isError && !inT(`${W}/hollow`), r.text);
  const big = await start('bigfile', { TRESORIT_IMPORT_PREVIEW_BYTES: '1000' });
  fs.writeFileSync(`${HOME}/Downloads/large.bin`, crypto.randomBytes(5000));
  r = await big.call('import_file', { source: 'large.bin', destination: W });
  const tb = tok(r.text);
  const rb = await big.call('import_file', { source: 'large.bin', destination: W, confirm_token: tb });
  check('a very large single file is previewed too', /NOTHING HAS BEEN COPIED/.test(r.text) && tb && !rb.isError && Buffer.compare(fs.readFileSync(T(`${W}/large.bin`)), fs.readFileSync(`${HOME}/Downloads/large.bin`)) === 0, r.text + rb.text);
  await big.client.close();

  // moving
  fs.writeFileSync(`${HOME}/Desktop/to move.txt`, 'MOVE-ME-QQQ');
  r = await s.call('import_file', { source: '~/Desktop/to move.txt', destination: W, mode: 'move' });
  const mb = (r.text.match(/batch (\S+_imported_\w+)/) || [])[1];
  check('a move puts the checked copy in Tresorit and the original in the holding area', !r.isError && fs.readFileSync(T(`${W}/to move.txt`), 'utf8') === 'MOVE-ME-QQQ' && !fs.existsSync(`${HOME}/Desktop/to move.txt`) && mb && fs.readFileSync(`${s.DATA}/deleted/${mb}/files/_outside/to move.txt`, 'utf8') === 'MOVE-ME-QQQ', r.text);
  r = await s.call('list_deleted', {});
  check('the holding area lists it with its old place on the Mac and sizes', r.text.includes(`${HOME}/Desktop/to move.txt`) && /in total/.test(r.text) && /original of an item moved into Tresorit/.test(r.text), r.text);
  fs.writeFileSync(`${HOME}/Desktop/to move.txt`, 'SOMETHING-NEW');
  r = await s.call('restore_deleted', { batch: mb });
  check('putting it back never overwrites what is on the Mac now', /not restored/.test(r.text) && fs.readFileSync(`${HOME}/Desktop/to move.txt`, 'utf8') === 'SOMETHING-NEW' && fs.existsSync(`${s.DATA}/deleted/${mb}`), r.text);
  fs.rmSync(`${HOME}/Desktop/to move.txt`);
  r = await s.call('restore_deleted', { batch: mb });
  check('once its old place is free, the original goes back exactly', /put back on the Mac/.test(r.text) && fs.readFileSync(`${HOME}/Desktop/to move.txt`, 'utf8') === 'MOVE-ME-QQQ' && !fs.existsSync(`${s.DATA}/deleted/${mb}`), r.text);
  // a tampered record must not let "restore" write anywhere it likes
  fs.writeFileSync(`${HOME}/Desktop/trick.txt`, 'TRICK');
  r = await s.call('import_file', { source: '~/Desktop/trick.txt', destination: `${W}/trick.txt`, mode: 'move' });
  const tbn = (r.text.match(/batch (\S+_imported_\w+)/) || [])[1];
  const mf = `${s.DATA}/deleted/${tbn}/manifest.json`; const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const out = [];
  for (const target of [`${HOME}/Library/Keychains/trick.txt`, `${HOME}/.ssh/trick.txt`, '/tmp/v13-trick/trick.txt', `${ROOT}/trick.txt`, '../../trick.txt']) {
    man.items[0].original = target; fs.writeFileSync(mf, JSON.stringify(man));
    const x = await s.call('restore_deleted', { batch: tbn });
    if (!/not restored/.test(x.text) || (path.isAbsolute(target) && fs.existsSync(target))) out.push(target);
  }
  check('a tampered holding-area record cannot make "restore" write into protected places', out.length === 0 && !fs.existsSync(`${ROOT}/trick.txt`), out.join(', '));
  fs.mkdirSync(`${HOME}/Desktop/whole`, { recursive: true }); fs.mkdirSync(`${HOME}/Desktop/whole/.private`); fs.writeFileSync(`${HOME}/Desktop/whole/a.txt`, 'A'); fs.writeFileSync(`${HOME}/Desktop/whole/.private/p.txt`, 'P');
  // From 1.4.5 such a folder is not moved in at all: with "move" the original would go to the holding area, which
  // clears itself, and the left-out items would then exist nowhere else. It can be copied in; the original stays whole.
  r = await s.call('import_file', { source: '~/Desktop/whole', destination: W, mode: 'move' });
  check('a folder with hidden items is not moved in: nothing lands in Tresorit and the original stays whole', r.isError && /Nothing was moved/.test(r.text) && !inT(`${W}/whole`) && fs.existsSync(`${HOME}/Desktop/whole/a.txt`) && fs.readFileSync(`${HOME}/Desktop/whole/.private/p.txt`, 'utf8') === 'P', r.text);
  r = await s.call('import_file', { source: '~/Desktop/whole', destination: W, mode: 'copy', confirm_token: tok((await s.call('import_file', { source: '~/Desktop/whole', destination: W, mode: 'copy' })).text) });
  check('...and it can be copied in: the hidden items stay out of Tresorit and with the original', !r.isError && inT(`${W}/whole/a.txt`) && !inT(`${W}/whole/.private`) && fs.readFileSync(`${HOME}/Desktop/whole/.private/p.txt`, 'utf8') === 'P', r.text);
  check('no protocol errors in the whole session', s.errors() === 0);
  await s.client.close();

  // the gate
  const g = await start('gate', { TRESORIT_PREFLIGHT_GATE: undefined });
  const g1 = await g.call('import_file', { source: 'invoice.pdf', destination: W });
  const g2 = await g.call('receive_file', { path: `${W}/g.bin`, part: 1, parts: 1, data: 'QQ==', part_sha256: hex(Buffer.from('A')), file_sha256: hex(Buffer.from('A')) });
  const g3 = await g.call('clear_deleted', { older_than_days: 0 });
  const g4 = await g.call('list_outside_folder', {});
  const g5 = await g.call('export_file', { path: 'Alder Works UK/03 - Finance/Commission tracker 2026.xlsx' });
  check('before the self-check has passed, nothing can be brought in, copied out or cleared (listing still works)', g1.isError && /self-check/.test(g1.text) && g2.isError && g3.isError && g5.isError && !g4.isError && !inT(`${W}/invoice.pdf`) && !inT(`${W}/g.bin`), g1.text);
  await g.client.close();
}

console.log('C. Copies out to Downloads or Desktop');
{
  const s = await start('export');
  let r = await s.call('export_file', { path: 'Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx' });
  const src = fs.readdirSync(T('Alder Works UK/03 - Finance')).find((n) => /^NDA/.test(n));
  check('a file is copied to Downloads and stays in Tresorit', !r.isError && fs.existsSync(`${HOME}/Downloads/${src}`) && Buffer.compare(fs.readFileSync(`${HOME}/Downloads/${src}`), fs.readFileSync(T(`Alder Works UK/03 - Finance/${src}`))) === 0, r.text);
  r = await s.call('export_file', { path: 'Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx' });
  check('a second copy gets a number instead of overwriting', !r.isError && fs.readdirSync(`${HOME}/Downloads`).filter((n) => /^NDA/.test(n)).length === 2, r.text);
  fs.mkdirSync(T(`${W}/outpack`), { recursive: true }); fs.writeFileSync(T(`${W}/outpack/a.txt`), 'A'); fs.symlinkSync(`${HOME}/.ssh/id_rsa`, T(`${W}/outpack/sneaky link`));
  r = await s.call('export_file', { path: `${W}/outpack`, to: 'Desktop' });
  check('a folder is copied out without any links it contains', !r.isError && fs.readFileSync(`${HOME}/Desktop/outpack/a.txt`, 'utf8') === 'A' && !fs.existsSync(`${HOME}/Desktop/outpack/sneaky link`), r.text);
  fs.rmSync(T(`${W}/outpack/sneaky link`));
  const e1 = await s.call('export_file', { path: 'Birch Labs' });
  const e2 = await s.call('export_file', { path: `${W}/outpack`, to: 'Library' });
  const e3 = await s.call('export_file', { path: `${W}/outpack`, to: '../../tmp' });
  const e4 = await s.call('export_file', { path: '../../etc/passwd' });
  check('a whole tresor, other target folders and outside paths are refused', e1.isError && e2.isError && e3.isError && e4.isError, e1.text + e2.text);
  fs.renameSync(`${HOME}/Desktop`, `${HOME}/Desktop-real`); fs.symlinkSync(`${HOME}/Library/Keychains`, `${HOME}/Desktop`);
  r = await s.call('export_file', { path: `${W}/outpack/a.txt`, to: 'Desktop' });
  check('if Desktop is itself a link to somewhere else, nothing is written through it', r.isError && !fs.existsSync(`${HOME}/Library/Keychains/a.txt`), r.text);
  fs.rmSync(`${HOME}/Desktop`); fs.renameSync(`${HOME}/Desktop-real`, `${HOME}/Desktop`);
  await s.client.close();
}

console.log('D. A document made in the chat, received in parts');
{
  const s = await start('receive');
  const file = crypto.randomBytes(40000);
  const cut = (buf, n) => { const out = []; for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, i + n)); return out; };
  const send = (p, parts, i, o = {}) => s.call('receive_file', { path: p, part: i + 1, parts: parts.length, data: parts[i].toString('base64'), part_sha256: hex(parts[i]), ...(i === parts.length - 1 ? { file_sha256: hex(Buffer.concat(parts)) } : {}), ...o });
  const parts = cut(file, 6000);
  let r; let okAll = true;
  for (let i = 0; i < parts.length; i++) { r = await send(`${W}/made.docx`, parts, i); if (r.isError) okAll = false; if (i < parts.length - 1 && inT(`${W}/made.docx`)) okAll = false; }
  check(`a 40 KB file in ${parts.length} parts arrives byte for byte, and only appears when complete`, okAll && Buffer.compare(fs.readFileSync(T(`${W}/made.docx`)), file) === 0 && /verified/.test(r.text), r.text);
  // a single flipped character in the text of a part
  const p2 = cut(crypto.randomBytes(20000), 5000);
  await send(`${W}/flip.bin`, p2, 0);
  const b64 = p2[1].toString('base64'); const flipped = b64.slice(0, 100) + (b64[100] === 'A' ? 'B' : 'A') + b64.slice(101);
  r = await s.call('receive_file', { path: `${W}/flip.bin`, part: 2, parts: 4, data: flipped, part_sha256: hex(p2[1]) });
  const again = await send(`${W}/flip.bin`, p2, 1);
  check('one altered character in a part is caught, and only that part is sent again', r.isError && /did not arrive intact/.test(r.text) && !again.isError, r.text + again.text);
  r = await send(`${W}/flip.bin`, p2, 3);
  check('parts must come in order', r.isError && /Expected part 3/.test(r.text), r.text);
  await send(`${W}/flip.bin`, p2, 2);
  r = await s.call('receive_file', { path: `${W}/flip.bin`, part: 4, parts: 4, data: p2[3].toString('base64'), part_sha256: hex(p2[3]) });
  check('the last part needs the fingerprint of the whole file', r.isError && /file_sha256/.test(r.text) && !inT(`${W}/flip.bin`), r.text);
  r = await s.call('receive_file', { path: `${W}/flip.bin`, part: 4, parts: 4, data: p2[3].toString('base64'), part_sha256: hex(p2[3]), file_sha256: hex(Buffer.from('something else')) });
  check('a wrong fingerprint for the whole file means nothing is saved', r.isError && /does not match/.test(r.text) && !inT(`${W}/flip.bin`), r.text);
  r = await send(`${W}/flip.bin`, p2, 1);
  check('after that failure the upload must start again from part 1', r.isError && /Start again from part 1/.test(r.text), r.text);
  for (let i = 0; i < p2.length; i++) r = await send(`${W}/flip.bin`, p2, i);
  check('...and then succeeds', !r.isError && Buffer.compare(fs.readFileSync(T(`${W}/flip.bin`)), Buffer.concat(p2)) === 0, r.text);
  const junk = [];
  for (const data of ['not base64 !!!', 'QUJD=QUJD', 'QUJ', 'éééé']) { const x = await s.call('receive_file', { path: `${W}/junk.bin`, part: 1, parts: 1, data, part_sha256: hex(Buffer.from('x')), file_sha256: hex(Buffer.from('x')) }); if (!x.isError || inT(`${W}/junk.bin`)) junk.push(data); }
  check('text that is not valid base64 is refused, not guessed at', junk.length === 0, junk.join(' | '));
  // two files at once do not mix
  const fa = cut(crypto.randomBytes(9000), 3000); const fb = cut(crypto.randomBytes(9000), 3000);
  for (let i = 0; i < 3; i++) { await send(`${W}/par-a.bin`, fa, i); await send(`${W}/par-b.bin`, fb, i); }
  check('two files received at the same time do not get mixed up', Buffer.compare(fs.readFileSync(T(`${W}/par-a.bin`)), Buffer.concat(fa)) === 0 && Buffer.compare(fs.readFileSync(T(`${W}/par-b.bin`)), Buffer.concat(fb)) === 0);
  r = await send(`${W}/par-a.bin`, fa, 0);
  const o1 = r.isError;
  for (let i = 0; i < 3; i++) r = await send(`${W}/par-a.bin`, fb, i, { overwrite: true });
  const hb = (r.text.match(/batch (\S+_replaced_\w+)/) || [])[1];
  check('an existing file is replaced only on request, and the old one is kept', o1 && !r.isError && Buffer.compare(fs.readFileSync(T(`${W}/par-a.bin`)), Buffer.concat(fb)) === 0 && hb && Buffer.compare(fs.readFileSync(`${s.DATA}/deleted/${hb}/files/${W}/par-a.bin`), Buffer.concat(fa)) === 0, r.text);
  const bigParts = cut(crypto.randomBytes(3 * 1024 * 1024 + 50000), 60000);
  let stopped = null;
  for (let i = 0; i < bigParts.length && !stopped; i++) { const x = await send(`${W}/too-big.bin`, bigParts, i); if (x.isError) stopped = x; }
  check('a file over the size limit is stopped and pointed to the download route', stopped && /tresorit_import_file/.test(stopped.text) && !inT(`${W}/too-big.bin`), stopped && stopped.text);
  const t1 = await s.call('receive_file', { path: 'top.bin', part: 1, parts: 1, data: 'QQ==', part_sha256: hex(Buffer.from('A')), file_sha256: hex(Buffer.from('A')) });
  const t2 = await s.call('receive_file', { path: '../escape.bin', part: 1, parts: 1, data: 'QQ==', part_sha256: hex(Buffer.from('A')), file_sha256: hex(Buffer.from('A')) });
  check('the usual path rules apply (not at the top level, not outside Tresorit)', t1.isError && t2.isError && !fs.existsSync(`${ROOT}/top.bin`) && !fs.existsSync(`${BASE}/escape.bin`));
  const small = Buffer.from('a small file sent in one go');
  const wOk = await s.call('write_file', { path: `${W}/one-go.bin`, content: small.toString('base64'), encoding: 'base64', sha256: hex(small) });
  const wBad = await s.call('write_file', { path: `${W}/one-go-bad.bin`, content: small.toString('base64'), encoding: 'base64', sha256: hex(Buffer.from('other')) });
  const wJunk = await s.call('write_file', { path: `${W}/one-go-junk.bin`, content: 'this is not base64', encoding: 'base64' });
  const wText = await s.call('write_file', { path: `${W}/plain.txt`, content: 'plain text is unaffected: ação' });
  check('saving in one go can carry a fingerprint too, and bad base64 is refused', !wOk.isError && wBad.isError && wJunk.isError && !wText.isError && !inT(`${W}/one-go-bad.bin`) && !inT(`${W}/one-go-junk.bin`) && fs.readFileSync(T(`${W}/plain.txt`), 'utf8').endsWith('ação'), wBad.text + wJunk.text);
  await s.client.close();
}

console.log('E. Emptying the holding area');
{
  const mk = (DATA, name, when, content = 'held') => { const d = `${DATA}/deleted/${name}`; fs.mkdirSync(`${d}/files/Birch Labs`, { recursive: true }); fs.writeFileSync(`${d}/files/Birch Labs/x.txt`, content); fs.writeFileSync(`${d}/manifest.json`, JSON.stringify({ kind: 'deleted', when, items: [{ original: 'Birch Labs/x.txt', type: 'file' }] })); };
  const stampOf = (daysAgo) => { const d = new Date(Date.now() - daysAgo * 86400000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const s = await start('clear');
  mk(s.DATA, '2026-01-01_000000_deleted_aaaaaa', stampOf(90)); mk(s.DATA, '2026-06-01_000000_deleted_bbbbbb', stampOf(45), 'x'.repeat(5000)); mk(s.DATA, '2026-11-01_000000_deleted_cccccc', stampOf(5));
  fs.mkdirSync(`${s.DATA}/deleted/not a batch`, { recursive: true }); fs.writeFileSync(`${s.DATA}/deleted/not a batch/keep.txt`, 'stray');
  let r = await s.call('clear_deleted', {});
  const t1 = tok(r.text);
  check('the default preview covers only batches older than 30 days, with sizes', /NOTHING HAS BEEN REMOVED/.test(r.text) && /2 of 3 batch/.test(r.text) && r.text.includes('aaaaaa') && r.text.includes('bbbbbb') && !r.text.includes('cccccc') && fs.readdirSync(`${s.DATA}/deleted`).length === 4, r.text);
  const bad1 = await s.call('clear_deleted', { confirm_token: 'deadbeef' });
  const bad2 = await s.call('clear_deleted', { older_than_days: 1, confirm_token: t1 });
  check('a wrong code, or the code used for a different selection, removes nothing', bad1.isError && bad2.isError && fs.readdirSync(`${s.DATA}/deleted`).length === 4, bad1.text + bad2.text);
  r = await s.call('clear_deleted', { confirm_token: t1 });
  check('with the code exactly those batches go, and nothing else in the folder', !r.isError && /Removed 2 batch/.test(r.text) && !fs.existsSync(`${s.DATA}/deleted/2026-01-01_000000_deleted_aaaaaa`) && fs.existsSync(`${s.DATA}/deleted/2026-11-01_000000_deleted_cccccc`) && fs.readFileSync(`${s.DATA}/deleted/not a batch/keep.txt`, 'utf8') === 'stray', r.text);
  mk(s.DATA, '2026-01-01_000000_deleted_aaaaaa', stampOf(90)); mk(s.DATA, '2026-06-01_000000_deleted_bbbbbb', stampOf(45));
  r = await s.call('clear_deleted', { confirm_token: t1 });
  check('a code works once only, even if batches of the same names appear again', r.isError && fs.existsSync(`${s.DATA}/deleted/2026-01-01_000000_deleted_aaaaaa`), r.text);
  fs.rmSync(`${s.DATA}/deleted/2026-01-01_000000_deleted_aaaaaa`, { recursive: true }); fs.rmSync(`${s.DATA}/deleted/2026-06-01_000000_deleted_bbbbbb`, { recursive: true });
  r = await s.call('clear_deleted', { batches: ['../../etc', 'not a batch'] });
  const r2 = await s.call('clear_deleted', { batches: ['2026-11-01_000000_deleted_cccccc'] });
  check('batches can be named; names that are not batches are refused', r.isError && /NOTHING HAS BEEN REMOVED/.test(r2.text) && /1 of 1/.test(r2.text), r.text + r2.text);
  // the selection changes between preview and confirmation
  mk(s.DATA, '2026-02-01_000000_deleted_dddddd', stampOf(80));
  const p1 = tok((await s.call('clear_deleted', { older_than_days: 3 })).text);
  mk(s.DATA, '2026-03-01_000000_deleted_eeeeee', stampOf(70));
  r = await s.call('clear_deleted', { older_than_days: 3, confirm_token: p1 });
  check('if the list changed since the preview, the user is asked again', r.isError && /no longer match/.test(r.text) && fs.existsSync(`${s.DATA}/deleted/2026-02-01_000000_deleted_dddddd`), r.text);
  r = await s.call('clear_deleted', { older_than_days: 3650 });
  check('nothing old enough: says so', !r.isError && /Nothing to remove/.test(r.text), r.text);
  const before = fs.readdirSync(`${ROOT}/Birch Labs`).length;
  check('Tresorit itself is never touched by this', fs.readdirSync(`${ROOT}/Birch Labs`).length === before);
  await s.client.close();

  // with the app's own confirmation dialog
  let answer = { action: 'decline' };
  const e = await start('clear-dialog', {}, { elicit: () => answer });
  mk(e.DATA, '2026-01-01_000000_deleted_ffffff', stampOf(90));
  r = await e.call('clear_deleted', { confirm_token: tok((await e.call('clear_deleted', {})).text) });
  const declined = r.isError && fs.existsSync(`${e.DATA}/deleted/2026-01-01_000000_deleted_ffffff`);
  answer = { action: 'accept', content: { confirm: false } };
  r = await e.call('clear_deleted', { confirm_token: tok((await e.call('clear_deleted', {})).text) });
  const unticked = r.isError && fs.existsSync(`${e.DATA}/deleted/2026-01-01_000000_deleted_ffffff`);
  answer = { action: 'accept', content: { confirm: true } };
  r = await e.call('clear_deleted', { confirm_token: tok((await e.call('clear_deleted', {})).text) });
  check('where the app shows its own dialog, only an explicit yes there removes anything', declined && unticked && !r.isError && !fs.existsSync(`${e.DATA}/deleted/2026-01-01_000000_deleted_ffffff`), r.text);
  await e.client.close();
}

console.log('F. Folders set as "do not index"');
{
  const VAULT = 'Strongbox';
  fs.mkdirSync(T(`${VAULT}/Seeds`), { recursive: true });
  fs.writeFileSync(T(`${VAULT}/Seeds/ledger words.txt`), 'twelve words zebra-vault-marker-9911 and more');
  fs.copyFileSync(T('Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf'), T(`${VAULT}/statement.pdf`));
  const scan = fs.readdirSync(T('Personal/Scans')).find((n) => /Contract scan/.test(n));
  fs.copyFileSync(T(`Personal/Scans/${scan}`), T(`${VAULT}/scanned backup sheet.pdf`));
  const ready = async (s) => { for (let i = 0; i < 1200; i++) { await sleep(250); const st = await s.call('connector_status'); if (/up to date as of/.test(st.text)) return st.text; } return ''; };
  const textFiles = (DATA) => { try { return fs.readdirSync(`${DATA}/index/text`).map((f) => fs.readFileSync(`${DATA}/index/text/${f}`, 'utf8')).join('\n'); } catch { return ''; } };

  // first, indexed like everything else (as in version 1.2)
  const a = await start('noindex', { TRESORIT_NO_INDEX: 'none', TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false' });
  await ready(a);
  let r = await a.call('search_contents', { query: 'zebra-vault-marker-9911' });
  check('with the setting off ("none") the folder is indexed and searched like any other', r.text.includes('ledger words.txt') && textFiles(a.DATA).includes('zebra-vault-marker-9911'), r.text);
  await a.client.close();

  // now with the two folders entered in the setting, on the same data folder (up to 1.4.8 they were the default;
  // from 1.5.0 the program names no folder, see test18 part M)
  const b = await start('noindex', { TRESORIT_NO_INDEX: 'Strongbox; Personal/16 - Secrets', TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false' }, { keep: true });
  const st = await ready(b);
  check('entered in the setting, Strongbox and the passwords folder are named as "do not index"', /Not indexed[^\n]*Strongbox; Personal\/16 - Secrets/.test(st), st.split('\n').slice(0, 6).join(' | '));
  check('text already in the index from before is removed from the disk', !textFiles(b.DATA).includes('zebra-vault-marker-9911') && !/strongbox/i.test(fs.readFileSync(`${b.DATA}/index/catalog.json`, 'utf8')));
  r = await b.call('search_contents', { query: 'zebra-vault-marker-9911' });
  check('a general search no longer finds it, and says what was left out', /^0 file/.test(r.text) && /do not index/.test(r.text) && !r.text.includes('twelve words'), r.text);
  r = await b.call('search_contents', { query: 'zebra-vault-marker-9911', path: VAULT });
  const rr = await b.call('search_contents', { query: 'zebra.vault', match: 'regex', path: `${VAULT}/Seeds/ledger words.txt` });
  check('nor does a search aimed at the folder or the file itself', /^0 file/.test(r.text) && /^0 file/.test(rr.text) && !r.text.includes('twelve words'), r.text + rr.text);
  r = await b.call('read_file', { path: `${VAULT}/Seeds/ledger words.txt` });
  const r2 = await b.call('read_file', { path: `${VAULT}/statement.pdf` });
  check('its files are still read when asked for by name (text and PDF)', !r.isError && r.text.includes('zebra-vault-marker-9911') && !r2.isError && /ORBIT/.test(r2.text) && /do not index/.test(r2.text), r.text.slice(0, 200) + r2.text.slice(0, 200));
  r = await b.call('find_files', { query: 'ledger words' });
  const fi = await b.call('file_info', { path: `${VAULT}/statement.pdf` });
  check('they are still found by name, and file details say they are not indexed', r.text.includes('ledger words.txt') && /not indexed/.test(fi.text), r.text + fi.text);
  check('reading them leaves nothing in the index', !textFiles(b.DATA).includes('zebra-vault-marker-9911') && !/strongbox/i.test(JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(`${b.DATA}/index/catalog.json`, 'utf8')).entries || {}))));
  await b.client.close();

  const c = await start('noindex-ocr', { TRESORIT_NO_INDEX: 'Strongbox; Personal/16 - Secrets' });
  r = await c.call('read_file', { path: `${VAULT}/scanned backup sheet.pdf` });
  check('a scanned PDF there is read by text recognition on request, without being stored', !r.isError && /text recognition/.test(r.text) && r.text.length > 300 && textFiles(c.DATA).length === 0, r.text.slice(0, 300));
  // bringing a file into such a folder
  fs.writeFileSync(`${HOME}/Downloads/new seed.txt`, 'imported-vault-marker-4242');
  r = await c.call('import_file', { source: 'new seed.txt', destination: `${VAULT}/Seeds` });
  const sr = await c.call('search_contents', { query: 'imported-vault-marker-4242' });
  check('a file brought into such a folder is not searched either', !r.isError && inT(`${VAULT}/Seeds/new seed.txt`) && /^0 file/.test(sr.text), r.text + sr.text);
  await c.client.close();

  const d = await start('noindex-custom', { TRESORIT_NO_INDEX: 'alder works uk/03 - FINANCE ; Birch Labs/v13' });
  r = await d.call('search_contents', { query: 'unicorn-keyword' });
  const r3 = await d.call('search_contents', { query: 'plain text is unaffected' });
  const r4 = await d.call('search_contents', { query: 'zebra-vault-marker-9911' });
  check('other folders can be named in the setting (capitals do not matter), replacing the default', r.text.includes('ORBIT technical report.pdf') && /^0 file/.test(r3.text) && r4.text.includes('ledger words.txt'), r3.text + r4.text.slice(0, 200));
  await d.client.close();
  fs.rmSync(T(`${VAULT}/Seeds`), { recursive: true, force: true }); fs.rmSync(T(`${VAULT}/statement.pdf`)); fs.rmSync(T(`${VAULT}/scanned backup sheet.pdf`));
}

console.log('G. Going easy on the battery');
{
  const script = `${BASE}/data-v13-power.sh`;
  const setPower = (battery, pct = 80) => fs.writeFileSync(script, `echo "Now drawing from '${battery ? 'Battery Power' : 'AC Power'}'"\necho " -InternalBattery-0 (id=1234567)\t${pct}%; discharging; 4:10 remaining present: true"\n`);
  const lines = (st) => st.split('\n').filter((l) => /Search index|Background|Scanned/.test(l)).join(' | ');
  const count = (st) => Number((st.match(/Search index: (\d+) document/) || [])[1]);
  const handled = (st) => { const m = st.match(/Search index: (\d+) document\(s\) readable \([^)]*\), (\d+) with no text, (\d+) unreadable/) || []; return Number(m[1]) + Number(m[2]) + Number(m[3]); };
  const settle = async (srv, re, tries = 400) => { let st = ''; for (let i = 0; i < tries; i++) { await sleep(250); st = (await srv.call('connector_status')).text; if (re.test(st)) return st; } return st; };
  const common = { TRESORIT_BACKGROUND_INDEX: 'true', TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_POWER_CMD: script, TRESORIT_POWER_POLL_MS: '400', TRESORIT_OCR: 'false' };
  // one document that arrived today and one very old one
  fs.mkdirSync(T(`${W}/battery`), { recursive: true });
  fs.writeFileSync(T(`${W}/battery/arrived today.txt`), 'this arrived today: battery-newest-771');
  fs.writeFileSync(T(`${W}/battery/very old.txt`), 'this is very old: battery-oldest-772');
  const old = new Date('2012-03-04T10:00:00Z'); fs.utimesSync(T(`${W}/battery/very old.txt`), old, old);
  const future = new Date(Date.now() + 60000); fs.utimesSync(T(`${W}/battery/arrived today.txt`), future, future);

  setPower(true);
  const s = await start('battery', { ...common, TRESORIT_BATTERY_DOCS_PER_HOUR: '5' });
  let st = await settle(s, /on battery as of/);
  const n0 = handled(st);
  check('on battery a small amount is still read (5 here), and the status says what waits for mains power', n0 === 5 && /waiting for mains power: \d+ document\(s\) still to read/.test(st), lines(st));
  const newest = (await s.call('file_info', { path: `${W}/battery/arrived today.txt` })).text; const oldest = (await s.call('file_info', { path: `${W}/battery/very old.txt` })).text;
  check('the newest documents are the ones read on battery; old ones wait', /Text search: searchable/.test(newest) && /Text search: not read yet/.test(oldest), `${newest.split('\n').pop()} | ${oldest.split('\n').pop()}`);
  let r = await s.call('read_file', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf' });
  const sr = await s.call('search_contents', { query: 'battery-oldest-772', path: `${W}/battery` });
  check('what the user asks for is never held up: reading, and searching what is not indexed yet', !r.isError && /ORBIT/.test(r.text) && sr.text.includes('very old.txt'), `${r.text.slice(0, 100)} | ${sr.text.slice(0, 200)}`);
  setPower(false);
  st = await settle(s, /up to date as of/);
  check('plugged in, it carries on by itself and finishes everything', /up to date as of/.test(st) && count(st) > 20, lines(st));
  const logText = fs.readFileSync(`${s.DATA}/logs/${fs.readdirSync(`${s.DATA}/logs`)[0]}`, 'utf8');
  check('the log records the battery mode, what was left waiting, and the resumption', /on battery: reading only small amounts/.test(logText) && /document\(s\) wait for mains power/.test(logText) && /resumed in full/.test(logText), logText.split('\n').filter((l) => /INDEX/.test(l)).join(' | '));
  await s.client.close();

  // the hourly allowance refills (the hour is shortened to three seconds here)
  setPower(true);
  const w = await start('battery-refill', { ...common, TRESORIT_BATTERY_DOCS_PER_HOUR: '5', TRESORIT_BATTERY_WINDOW_MS: '3000' });
  st = await settle(w, /on battery as of/); const first = handled(st);
  let later = first; for (let i = 0; i < 60 && later < 15; i++) { await sleep(500); later = handled((await w.call('connector_status')).text); }
  check('still on battery, a further small amount is read once the allowance has room again', first === 5 && later >= 15, `${first} then ${later}`);
  await w.client.close();

  // very large files wait for mains power even when the allowance has room
  const big = await start('battery-big', { ...common, TRESORIT_BATTERY_MAX_FILE_MB: '0.0002' });
  st = await settle(big, /on battery as of/);
  const tiny = (await big.call('file_info', { path: `${W}/battery/arrived today.txt` })).text; const large = (await big.call('file_info', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf' })).text;
  check('on battery, files over the size limit wait for mains power while small ones are read', /Text search: searchable/.test(tiny) && /Text search: not read yet/.test(large) && /very large files/.test(st), lines(st));
  await big.client.close();

  // a low battery: nothing at all in the background
  setPower(true, 12);
  const low = await start('battery-low', common);
  st = await settle(low, /on battery as of/);
  check('below 20% nothing is read in the background, and the status says the battery is low', count(st) === 0 && /the battery is low/.test(st), lines(st));
  r = await low.call('read_file', { path: `${W}/battery/arrived today.txt` });
  check('...but a document the user asks for is still read', !r.isError && /battery-newest-771/.test(r.text));
  setPower(false);
  st = await settle(low, /up to date as of/);
  check('...and plugged in, everything is read', /up to date as of/.test(st) && count(st) > 20, lines(st));
  await low.client.close();

  // text recognition for scanned PDFs never runs on battery
  setPower(true);
  const oc = await start('battery-ocr', { ...common, TRESORIT_OCR: 'true', TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_BATTERY_DOCS_PER_HOUR: '5000', TRESORIT_BATTERY_MB_PER_HOUR: '5000', TRESORIT_BATTERY_MAX_FILE_MB: '500' });
  st = await settle(oc, /on battery as of|up to date as of/);
  const ocLog = () => fs.readFileSync(`${oc.DATA}/logs/${fs.readdirSync(`${oc.DATA}/logs`)[0]}`, 'utf8');
  const waitingScans = Number((st.match(/Scanned PDFs: \d+ read by text recognition, (\d+) waiting/) || [])[1]);
  check('on battery the documents are read but scanned PDFs are not put through text recognition', /waiting for mains power: text recognition for \d+ scanned PDF/.test(st) && waitingScans > 0 && !/\| OCR /.test(ocLog()), lines(st));
  setPower(false);
  let recognised = false; for (let i = 0; i < 480 && !recognised; i++) { await sleep(500); recognised = /\| OCR /.test(ocLog()); }
  check('plugged in, text recognition starts by itself', recognised);
  await oc.client.close();

  setPower(true);
  const o = await start('battery-off', { ...common, TRESORIT_PAUSE_ON_BATTERY: 'false' });
  st = await settle(o, /up to date as of/);
  check('with the setting switched off, everything is read on battery too', /up to date as of/.test(st) && count(st) > 20, lines(st));
  await o.client.close();
  const noTool = await start('battery-none', { ...common, TRESORIT_POWER_CMD: `${BASE}/data-v13-does-not-exist.sh` });
  st = await settle(noTool, /up to date as of/);
  check('if the power state cannot be read, nothing is held back', /up to date as of/.test(st) && count(st) > 20, lines(st));
  await noTool.client.close();
  // a small backlog on battery (the everyday case): everything new is read, nothing waits
  setPower(true);
  const day = await start('battery-everyday', common);
  st = await settle(day, /up to date as of|on battery as of/);
  check('an ordinary day on battery (a backlog within the allowance): all of it is read and nothing waits', /up to date as of/.test(st) && count(st) > 20, lines(st));
  await day.client.close();
  setPower(false);
}

fs.rmSync(T(W), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
