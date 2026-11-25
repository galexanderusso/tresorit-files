import { Client, StdioClientTransport, MOCK, BUNDLE, rssMB } from './lib/env.mjs';
// Deep check of 1.3: hostile paths at volume, interruptions, simultaneous changes, abuse of the small-file route,
// protected items nested in folders, and the interplay with older features.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// These tests put old-dated batches into the holding area to test clearing and restoring by hand; the automatic
// clearing added in 1.4.1 is switched off here so that it cannot take them first (test16 covers it).
process.env.TRESORIT_HOLDING_DAYS ??= '0';

const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const LIB = path.join(path.dirname(SERVER), 'lib');
const BASE = `${MOCK}`;
const ROOT = `${BASE}/Tresors`;
const HOME = `${BASE}/data-dc-home`;
const VOLS = `${BASE}/data-dc-volumes`;
const W = 'Birch Labs/dc';
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 700)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const T = (rel) => `${ROOT}/${rel}`;
const inT = (rel) => fs.existsSync(T(rel));
const tok = (t) => (t.match(/confirm_token "([0-9a-f]+)"/) || [])[1];

function makeHome() {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(VOLS, { recursive: true, force: true });
  for (const d of ['Downloads', 'Desktop', 'Documents/Projects/deep/er', 'Applications/Thing.app/Contents', 'Pictures/Lib.photoslibrary/db', 'Library/Keychains', 'Library/Application Support/App',
    'Library/Mobile Documents/com~apple~CloudDocs/Notes', 'Library/Mobile Documents/iCloud~other~app/Documents', 'Library/CloudStorage/OneDrive-Alder/Docs', 'Library/CloudStorage/Tresorit-X/T', '.ssh', '.config/x', 'Documents/.hid']) fs.mkdirSync(`${HOME}/${d}`, { recursive: true });
  fs.mkdirSync(`${VOLS}/USB/Scans`, { recursive: true }); fs.mkdirSync(`${VOLS}/USB/.Trashes`, { recursive: true });
  const w = (rel, c = 'x') => fs.writeFileSync(`${HOME}/${rel}`, c);
  for (const f of ['Downloads/a.pdf', 'Downloads/b c.txt', 'Desktop/d.docx', 'Documents/Projects/p.docx', 'Documents/Projects/deep/er/q.txt', 'Documents/.hid/h.txt', 'Applications/Thing.app/Contents/i', 'Pictures/Lib.photoslibrary/db/p.db',
    'Library/Keychains/login.keychain-db', 'Library/Application Support/App/data', 'Library/Mobile Documents/com~apple~CloudDocs/Notes/n.txt', 'Library/Mobile Documents/iCloud~other~app/Documents/d.db', 'Library/CloudStorage/OneDrive-Alder/Docs/o.txt',
    'Library/CloudStorage/Tresorit-X/T/s.txt', '.ssh/id_rsa', '.config/x/t', 'vault.kdbx', 'Downloads/~$lock.docx', 'Downloads/Thumbs.db']) w(f, `content of ${f}`);
  fs.writeFileSync(`${VOLS}/USB/Scans/u.pdf`, 'usb'); fs.writeFileSync(`${VOLS}/USB/.Trashes/t`, 't');
  fs.symlinkSync(`${HOME}/Library/Keychains/login.keychain-db`, `${HOME}/Documents/alias.txt`);
  fs.symlinkSync(`${HOME}/Library/Keychains`, `${HOME}/Documents/klink`);
  fs.symlinkSync(`${HOME}/.ssh`, `${HOME}/Downloads/slink`);
  fs.symlinkSync(ROOT, `${HOME}/Documents/tlink`);
  fs.symlinkSync('/etc', `${HOME}/Desktop/elink`);
  fs.symlinkSync(`${HOME}/Documents/Projects`, `${HOME}/Desktop/plink`);
}

async function start(name, extraEnv = {}, opts = {}) {
  const DATA = opts.data || `${BASE}/data-dc-${name}`; if (!opts.keep) fs.rmSync(DATA, { recursive: true, force: true });
  // (Up to 1.4.8 these two folders were "do not index" by default. From 1.5.0 the program names no folder, so the
  // suite enters them, as a user does in the settings.)
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: `${HOME}:${VOLS}`, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_NO_INDEX: 'Strongbox', ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  let protoErrors = 0; client.onerror = () => { protoErrors++; };
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const t0 = Date.now();
    try { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError, ms: Date.now() - t0 }; } catch (e) { return { text: `PROTOCOL ${e.message}`, isError: true, protocol: true, ms: Date.now() - t0 }; }
  };
  const rss = () => rssMB(transport.pid);
  return { client, call, DATA, pid: transport.pid, rss, errors: () => protoErrors, transport };
}

makeHome();
fs.rmSync(T(W), { recursive: true, force: true });

console.log('A. 30,000 hostile source paths against the rules for places outside Tresorit');
{
  const { makeOutside } = await import(`${LIB}/outside.js`);
  const DATA = `${BASE}/data-dc-fuzzdata`; fs.mkdirSync(`${DATA}/logs`, { recursive: true }); fs.writeFileSync(`${DATA}/logs/l.log`, 'log');
  const o = makeOutside({ home: HOME, roots: [HOME, VOLS], tresoritRoot: ROOT, dataDir: DATA });
  const pool = ['Downloads', 'Documents', 'Desktop', 'Projects', 'deep', 'er', 'Library', 'library', 'LIBRARY', 'Keychains', 'keychains', 'login.keychain-db', 'LOGIN.KEYCHAIN-DB', 'Application Support', 'App', 'data', 'Mobile Documents', 'mobile documents',
    'com~apple~CloudDocs', 'iCloud~other~app', 'Notes', 'n.txt', 'CloudStorage', 'OneDrive-Alder', 'Tresorit-X', 'tresorit-x', 'T', 'Docs', 'o.txt', 's.txt', '.ssh', 'id_rsa', '.config', '.hid', 'h.txt', 'Applications', 'applications', 'Thing.app', 'Contents', 'i',
    'Pictures', 'Lib.photoslibrary', 'db', 'p.db', 'vault.kdbx', 'a.pdf', 'b c.txt', 'd.docx', 'p.docx', 'q.txt', 'alias.txt', 'klink', 'slink', 'tlink', 'elink', 'plink', '..', '..', '.', '', '~', 'passwd', 'hosts', '~$lock.docx', 'Thumbs.db', 'USB', 'Scans', 'u.pdf',
    '.Trashes', 't', 'Birch Labs', 'Alder Works UK', 'logs', 'l.log', 'nonexistent', 'café', '%2e%2e', '..∕', '‮', 'a\nb', ' ', 'x'.repeat(300)];
  const prefixes = [`${HOME}/`, `${HOME}/`, `${HOME}/`, '~/', '~/', '/', `${VOLS}/`, `${ROOT}/`, `${DATA}/`, '', `${HOME}/../`, '/etc/', `${HOME.toUpperCase()}/`, `/proc/self/root${HOME}/`, `//`, `${HOME}//./`];
  let seed = 20261120; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const realH = fs.realpathSync(HOME); const realV = fs.realpathSync(VOLS); const realR = fs.realpathSync(ROOT); const realD = fs.realpathSync(DATA);
  const PKG = /\.(app|photoslibrary|musiclibrary|tvlibrary|imovielibrary|aplibrary|lrcat|lrdata|keychain|keychain-db|agilekeychain|opvault|kdbx)$/i;
  let accepted = 0, refused = 0; const bad = []; const acceptedSet = new Set();
  // every real path in the test home and drive, links included: half the attempts start from one of these
  const existing = [];
  (function walk(d, depth) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); existing.push(p); if (e.isDirectory() && depth < 6) walk(p, depth + 1); else if (e.isSymbolicLink()) { try { if (fs.statSync(p).isDirectory() && depth < 3) for (const n of fs.readdirSync(p).slice(0, 6)) existing.push(path.join(p, n)); } catch { /* broken link */ } } } })(HOME, 0);
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); existing.push(p); if (e.isDirectory()) walk(p); } })(VOLS);
  const mutate = (p) => {
    const r = rnd();
    if (r < 0.25) return p;
    if (r < 0.35) return p.replace(HOME, '~');
    if (r < 0.45) return p.toUpperCase();
    if (r < 0.55) return p.split('/').map((x) => (rnd() < 0.3 ? x.toLowerCase() : x)).join('/');
    if (r < 0.65) return p.replace(/\/([^/]+)$/, '/./$1');
    if (r < 0.75) return `${p}/../${path.basename(p)}`;
    if (r < 0.85) return `${p}/${pick(pool)}`;
    if (r < 0.92) return p.replace(/\//g, '//');
    return `${path.dirname(p)}/${pick(pool)}/../${path.basename(p)}`;
  };
  for (let n = 0; n < 30000; n++) {
    let p;
    if (rnd() < 0.5) p = mutate(pick(existing));
    else {
      p = pick(prefixes); const k = 1 + Math.floor(rnd() * 7);
      for (let i = 0; i < k; i++) p += (i ? '/' : '') + pick(pool);
    }
    if (rnd() < 0.05) p += '/';
    if (rnd() < 0.02) p = p.replace('/', '\\');
    let res = null;
    try { res = o.resolve(p); } catch { res = null; }
    if (!res) { refused++; continue; }
    accepted++; acceptedSet.add(res.abs);
    // an independent check of what was accepted
    const real = fs.realpathSync(res.abs); const why = [];
    if (real !== res.abs) why.push('not fully resolved');
    const typed = p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
    if (fs.lstatSync(path.normalize(typed).replace(/\/+$/, '') || '/').isSymbolicLink()) why.push('a link was accepted');
    const inH = real.startsWith(realH + '/'); const inV = real.startsWith(realV + '/');
    if (!inH && !inV) why.push('outside the allowed area');
    const rel = inH ? real.slice(realH.length + 1) : real.slice(realV.length + 1); const parts = rel.split('/');
    if (parts.some((x) => x.startsWith('.'))) why.push('hidden');
    if (parts.some((x) => PKG.test(x))) why.push('package or key store');
    if (inH && /^applications$/i.test(parts[0])) why.push('Applications');
    if (inH && /^library$/i.test(parts[0])) { const ok = (/^mobile documents$/i.test(parts[1]) && /^com~apple~clouddocs$/i.test(parts[2] || '')) || (/^cloudstorage$/i.test(parts[1]) && parts.length >= 3 && !/^tresorit/i.test(parts[2])); if (!ok) why.push('Library'); }
    if (real === realR || real.startsWith(realR + '/') || real.startsWith(realD + '/') || real === realD) why.push('Tresorit or data folder');
    if (/^(~\$|\._)|^(Thumbs\.db|\.DS_Store|desktop\.ini)$/.test(path.basename(real))) why.push('clutter');
    if (why.length && bad.length < 8) bad.push(`${JSON.stringify(p)} -> ${res.abs}: ${why.join(', ')}`);
    if (why.length) bad.push('');
  }
  check(`none of the accepted paths breaks a rule (${accepted} accepted, ${refused} refused, ${acceptedSet.size} distinct places)`, bad.length === 0 && accepted > 1500 && refused > 15000 && acceptedSet.size >= 12, bad.filter(Boolean).join('\n       '));
  check('only ordinary documents were ever accepted', [...acceptedSet].every((a) => /\/(Downloads|Documents|Desktop|Pictures|USB|Library\/(Mobile Documents\/com~apple~CloudDocs|CloudStorage\/OneDrive-Alder))(\/|$)/.test(a)), [...acceptedSet].filter((a) => !/\/(Downloads|Documents|Desktop|Pictures|USB|Library\/(Mobile Documents\/com~apple~CloudDocs|CloudStorage\/OneDrive-Alder))(\/|$)/.test(a)).slice(0, 5).join(' | '));
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log('B. Protected items nested inside a folder that is brought in');
{
  const s = await start('nested');
  const P = `${HOME}/Documents/bundle`;
  for (const d of ['normal/sub', 'Old Tool.app/Contents/MacOS', 'photos.photoslibrary/database', 'normal/keys.agilekeychain', '.env-folder']) fs.mkdirSync(`${P}/${d}`, { recursive: true });
  const w = (rel, c) => fs.writeFileSync(`${P}/${rel}`, c);
  w('normal/a.txt', 'A'); w('normal/sub/b.txt', 'B'); w('Old Tool.app/Contents/MacOS/bin', 'BIN-SECRET'); w('photos.photoslibrary/database/p.db', 'PHOTO-SECRET'); w('normal/backup.keychain-db', 'KEYCHAIN-SECRET');
  w('normal/keys.agilekeychain/k', 'AGILE-SECRET'); w('normal/passwords.kdbx', 'KDBX-SECRET'); w('normal/~$open.docx', 'LOCK'); w('.env-folder/e', 'ENV-SECRET'); w('normal/.env', 'DOTENV-SECRET');
  fs.symlinkSync(`${HOME}/.ssh/id_rsa`, `${P}/normal/id link`);
  let r = await s.call('import_file', { source: '~/Documents/bundle', destination: W });
  const preview = r.text;
  r = await s.call('import_file', { source: '~/Documents/bundle', destination: W, confirm_token: tok(preview) });
  const all = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); all.push(p); if (e.isDirectory()) walk(p); } })(T(`${W}/bundle`));
  const arrived = all.map((p) => p.slice(T(`${W}/bundle/`).length)).sort();
  check('only the two ordinary files arrive; applications, libraries, key stores, hidden items, clutter and links are left', !r.isError && JSON.stringify(arrived) === JSON.stringify(['normal', 'normal/a.txt', 'normal/sub', 'normal/sub/b.txt']), arrived.join(', '));
  check('the preview and the reply say that items were left out', /2 file\(s\)/.test(preview) && /left out/.test(preview) && /left out/.test(r.text), preview + r.text);
  const content = all.filter((p) => fs.statSync(p).isFile()).map((p) => fs.readFileSync(p, 'utf8')).join('|');
  check('no protected content reached Tresorit', !/SECRET|LOCK/.test(content), content);
  // a folder that contains the connector's own data folder
  const inner = await start('inner', {}, { data: `${HOME}/Documents/Projects/conn-data` });
  r = await inner.call('import_file', { source: '~/Documents/Projects', destination: W });
  const r2 = await inner.call('import_file', { source: '~/Documents/Projects/conn-data/logs', destination: W });
  check('a folder that contains the connector data folder (or is inside it) is refused', r.isError && r2.isError && !inT(`${W}/Projects`), r.text + r2.text);
  await inner.client.close(); fs.rmSync(`${HOME}/Documents/Projects/conn-data`, { recursive: true, force: true });
  r = await s.call('import_file', { source: '~/Downloads/~$lock.docx', destination: W });
  const r3 = await s.call('import_file', { source: 'Thumbs.db', destination: W });
  check('a lock file or system clutter is not brought in on its own either', r.isError && r3.isError && fs.readdirSync(T(W)).length === 1, r.text + r3.text);
  await s.client.close();
}

console.log('C. Interruptions');
{
  fs.mkdirSync(`${HOME}/Downloads/bigpack`, { recursive: true });
  for (let i = 0; i < 1500; i++) fs.writeFileSync(`${HOME}/Downloads/bigpack/f${i}.bin`, crypto.randomBytes(100000));
  const k = await start('kill');
  let pv = await k.call('import_file', { source: '~/Downloads/bigpack', destination: W });
  let pending = k.call('import_file', { source: '~/Downloads/bigpack', destination: W, confirm_token: tok(pv.text) });
  await sleep(300); process.kill(k.pid, 'SIGKILL'); await pending;
  const staged = fs.readdirSync(`${k.DATA}/staging`).length;
  check('killed in mid-import: nothing half-copied is in Tresorit, and the originals are intact', !inT(`${W}/bigpack`) && fs.readdirSync(`${HOME}/Downloads/bigpack`).length === 1500 && staged >= 1, `staged ${staged}`);
  const k2 = await start('kill', { TRESORIT_STAGING_MAX_AGE_MS: '1' }, { keep: true });
  check('the next start clears what the interrupted import left in the staging folder', fs.readdirSync(`${k2.DATA}/staging`).length === 0);
  pv = await k2.call('import_file', { source: '~/Downloads/bigpack', destination: W });
  const done = await k2.call('import_file', { source: '~/Downloads/bigpack', destination: W, confirm_token: tok(pv.text) });
  check('and the import can simply be run again', !done.isError && fs.readdirSync(T(`${W}/bigpack`)).length === 1500 && fs.readdirSync(`${k2.DATA}/staging`).length === 0, done.text);
  // the existing copy tool, killed in mid-copy
  pending = k2.call('copy_item', { source: `${W}/bigpack`, destination: `${W}/bigpack copy` });
  await sleep(150); process.kill(k2.pid, 'SIGKILL'); await pending;
  check('killed in the middle of a copy inside Tresorit: no half-made copy is left there either', !inT(`${W}/bigpack copy`) && fs.readdirSync(T(`${W}/bigpack`)).length === 1500);
  // a move interrupted after the copy: nothing can be lost, because the original leaves only after the copy is checked
  const k3 = await start('kill3');
  fs.mkdirSync(`${HOME}/Desktop/movepack`); for (let i = 0; i < 800; i++) fs.writeFileSync(`${HOME}/Desktop/movepack/m${i}.bin`, crypto.randomBytes(100000));
  pv = await k3.call('import_file', { source: '~/Desktop/movepack', destination: W, mode: 'move' });
  pending = k3.call('import_file', { source: '~/Desktop/movepack', destination: W, mode: 'move', confirm_token: tok(pv.text) });
  await sleep(250); process.kill(k3.pid, 'SIGKILL'); await pending;
  const atSource = fs.existsSync(`${HOME}/Desktop/movepack`) ? fs.readdirSync(`${HOME}/Desktop/movepack`).length : 0;
  const atDest = inT(`${W}/movepack`) ? fs.readdirSync(T(`${W}/movepack`)).length : 0;
  let held = 0; for (const b of fs.readdirSync(`${k3.DATA}/deleted`)) { const p = `${k3.DATA}/deleted/${b}/files/_outside/movepack`; if (fs.existsSync(p)) held = fs.readdirSync(p).length; }
  check(`killed during a move: every file is still complete somewhere (source ${atSource}, Tresorit ${atDest}, holding area ${held})`, atSource === 800 || held === 800 || (atDest === 800 && (atSource === 800 || held === 800)), `${atSource} ${atDest} ${held}`);
  // Claude is closed (not killed) in mid-import: the import finishes first
  const g = await start('graceful');
  fs.rmSync(T(`${W}/bigpack`), { recursive: true, force: true });
  pv = await g.call('import_file', { source: '~/Downloads/bigpack', destination: W });
  const p2 = g.call('import_file', { source: '~/Downloads/bigpack', destination: W, confirm_token: tok(pv.text) });
  await sleep(250); await g.client.close(); await p2;
  let complete = false; for (let i = 0; i < 300 && !complete; i++) { await sleep(200); complete = inT(`${W}/bigpack`) && fs.readdirSync(T(`${W}/bigpack`)).length === 1500; }
  let alive = true; for (let i = 0; i < 100 && alive; i++) { await sleep(100); try { process.kill(g.pid, 0); } catch { alive = false; } }
  check('closing Claude in mid-import lets the import finish, and then the connector stops', complete && !alive && fs.readdirSync(`${g.DATA}/staging`).length === 0, `complete ${complete}, still running ${alive}`);
  fs.rmSync(`${HOME}/Desktop/movepack`, { recursive: true, force: true }); fs.rmSync(T(`${W}/movepack`), { recursive: true, force: true });
}

console.log('D. Many changes at the same moment');
{
  const s = await start('together');
  let wrong = 0;
  for (let k = 0; k < 30; k++) {
    const names = []; for (let i = 0; i < 6; i++) { const n = `race-${k}-${i}.txt`; fs.writeFileSync(`${HOME}/Downloads/${n}`, `content ${k} ${i} ${crypto.randomBytes(6).toString('hex')}`); names.push(n); }
    const rs = await Promise.all(names.map((n) => s.call('import_file', { source: `~/Downloads/${n}`, destination: `${W}/same-${k}.txt` })));
    if (rs.filter((r) => !r.isError).length !== 1 || !names.some((n) => fs.readFileSync(`${HOME}/Downloads/${n}`, 'utf8') === fs.readFileSync(T(`${W}/same-${k}.txt`), 'utf8'))) wrong++;
  }
  check('180 files brought in, six at a time to the same name: exactly one of each six arrives, intact', wrong === 0, `${wrong} rounds wrong`);
  wrong = 0;
  for (let k = 0; k < 30; k++) {
    for (let i = 0; i < 6; i++) fs.writeFileSync(T(`${W}/mv-${k}-${i}.txt`), `m ${k} ${i}`);
    const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => s.call('move_item', { source: `${W}/mv-${k}-${i}.txt`, destination: `${W}/moved-${k}.txt` })));
    const stay = [0, 1, 2, 3, 4, 5].filter((i) => inT(`${W}/mv-${k}-${i}.txt`)).length;
    if (rs.filter((r) => !r.isError).length !== 1 || stay !== 5) wrong++;
  }
  check('180 files moved, six at a time to the same name: one moves, five stay, none is lost', wrong === 0, `${wrong} rounds wrong`);
  wrong = 0;
  for (let k = 0; k < 10; k++) {
    for (let i = 0; i < 4; i++) fs.writeFileSync(T(`${W}/cp-${k}-${i}.txt`), `c ${k} ${i}`);
    const rs = await Promise.all([0, 1, 2, 3].map((i) => s.call('copy_item', { source: `${W}/cp-${k}-${i}.txt`, destination: `${W}/copied-${k}.txt` })));
    if (rs.filter((r) => !r.isError).length !== 1) wrong++;
  }
  check('copies to the same name at once: one is made, the others are refused', wrong === 0, `${wrong} rounds wrong`);
  // ten edits of one file at once: every one must be kept
  const tokens = Array.from({ length: 10 }, (_, i) => `[[slot-${i}]]`);
  await s.call('write_file', { path: `${W}/shared.md`, content: tokens.join('\n') + '\n' });
  let rs = await Promise.all(tokens.map((t, i) => s.call('edit_file', { path: `${W}/shared.md`, old_text: t, new_text: `done-${i}` })));
  const after = fs.readFileSync(T(`${W}/shared.md`), 'utf8');
  check('ten edits of the same file sent at once are all kept (none overwrites another)', rs.every((r) => !r.isError) && tokens.every((_, i) => after.includes(`done-${i}`)) && !after.includes('[[slot-'), after.replace(/\n/g, ' '));
  // ten overwrites at once: every previous version must be in the holding area
  const before = new Set(fs.readdirSync(`${s.DATA}/deleted`));
  rs = await Promise.all(Array.from({ length: 10 }, (_, i) => s.call('write_file', { path: `${W}/shared.md`, content: `version ${i}`, overwrite: true })));
  const batches = fs.readdirSync(`${s.DATA}/deleted`).filter((b) => !before.has(b));
  const kept = batches.map((b) => { try { return fs.readFileSync(`${s.DATA}/deleted/${b}/files/${W}/shared.md`, 'utf8'); } catch { return ''; } });
  const final = fs.readFileSync(T(`${W}/shared.md`), 'utf8');
  const versions = new Set([final, ...kept.filter((v) => v.startsWith('version'))]);
  check('ten overwrites at once: the file holds one version and the other nine are all in the holding area', rs.every((r) => !r.isError) && versions.size === 10 && kept.some((v) => v.includes('done-0')), `${versions.size} distinct versions, ${batches.length} batches`);
  // the same batch restored three times at once
  await s.call('write_file', { path: `${W}/once.txt`, content: 'restore me' });
  const dp = await s.call('delete_items', { paths: [`${W}/once.txt`] });
  const dd = await s.call('delete_items', { paths: [`${W}/once.txt`], confirm_token: tok(dp.text) });
  const bn = (dd.text.match(/batch (\S+_deleted_\w+)/) || [])[1];
  rs = await Promise.all([1, 2, 3].map(() => s.call('restore_deleted', { batch: bn })));
  check('one batch restored three times at once: restored once, the others say it is gone', rs.filter((r) => /: restored/.test(r.text)).length === 1 && fs.readFileSync(T(`${W}/once.txt`), 'utf8') === 'restore me', rs.map((r) => r.text).join(' | '));
  // a storm of mixed changes on a small set of names
  const jobs = [];
  for (let i = 0; i < 240; i++) {
    const a = `${W}/storm/s${i % 7}.txt`; const b = `${W}/storm/s${(i + 3) % 7}.txt`;
    const k = i % 6;
    if (k === 0) jobs.push(s.call('write_file', { path: a, content: `storm ${i}`, overwrite: true }));
    else if (k === 1) jobs.push(s.call('move_item', { source: a, destination: b }));
    else if (k === 2) jobs.push(s.call('copy_item', { source: a, destination: b }));
    else if (k === 3) jobs.push(s.call('edit_file', { path: a, old_text: 'storm', new_text: 'storm' }));
    else if (k === 4) jobs.push(s.call('read_file', { path: a }));
    else jobs.push(s.call('import_file', { source: 'a.pdf', destination: `${W}/storm/s${i % 7}.txt`, allow_duplicate: true }));
  }
  rs = await Promise.all(jobs);
  const names = fs.readdirSync(T(`${W}/storm`));
  const intact = names.every((n) => { const c = fs.readFileSync(T(`${W}/storm/${n}`), 'utf8'); return /^storm \d+$/.test(c) || c === 'content of Downloads/a.pdf'; });
  check(`a storm of 240 mixed changes on seven names: every file left is whole, no protocol errors (${rs.filter((r) => !r.isError).length} succeeded)`, intact && names.every((n) => /^s[0-6]\.txt$/.test(n)) && s.errors() === 0 && !rs.some((r) => r.protocol), names.join(','));
  check('nothing was left behind in the staging folder', fs.readdirSync(`${s.DATA}/staging`).length === 0);

  // reading is not held up by a long change
  fs.rmSync(T(`${W}/bigpack`), { recursive: true, force: true });
  const pv = await s.call('import_file', { source: '~/Downloads/bigpack', destination: W });
  const long = s.call('import_file', { source: '~/Downloads/bigpack', destination: W, confirm_token: tok(pv.text) });
  await sleep(50);
  const reads = await Promise.all([s.call('list_folder', { path: 'Alder Works UK' }), s.call('find_files', { query: 'orbit' }), s.call('read_file', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf' }), s.call('connector_status')]);
  const l = await long;
  check(`listing, finding, reading and status answer while a long import runs (slowest ${Math.max(...reads.map((r) => r.ms))} ms; the import took ${l.ms} ms)`, reads.every((r) => !r.isError) && Math.max(...reads.map((r) => r.ms)) < l.ms && !l.isError, reads.map((r) => r.ms).join(','));
  check('the status names the change in progress', /A change is in progress: tresorit_import_file/.test(reads[3].text), reads[3].text.split('\n').slice(0, 8).join(' | '));
  await s.client.close();

  // a change that waits too long behind another gives up, and is then never carried out
  const q = await start('queue', { TRESORIT_CHANGE_WAIT_MS: '150' });
  fs.rmSync(T(`${W}/bigpack`), { recursive: true, force: true });
  const pv2 = await q.call('import_file', { source: '~/Downloads/bigpack', destination: W });
  const long2 = q.call('import_file', { source: '~/Downloads/bigpack', destination: W, confirm_token: tok(pv2.text) });
  await sleep(30);
  const waited = await q.call('write_file', { path: `${W}/queued.txt`, content: 'should not appear' });
  await long2; await sleep(500);
  check('a change that waited too long behind another is refused with an explanation, and does not happen later', waited.isError && /NOT carried out/.test(waited.text) && !inT(`${W}/queued.txt`), waited.text);
  const ok = await q.call('write_file', { path: `${W}/queued.txt`, content: 'now it does' });
  check('once the long change is done, changes work again', !ok.isError && inT(`${W}/queued.txt`), ok.text);
  await q.client.close();
}

console.log('E. Abuse of the small-file route');
{
  const s = await start('flood');
  const part = crypto.randomBytes(48000); const b64 = part.toString('base64'); const ph = hex(part);
  const m0 = s.rss();
  for (let i = 0; i < 250; i++) for (let p = 1; p <= 12; p++) { const r = await s.call('receive_file', { path: `${W}/flood-${i}.bin`, part: p, parts: 600, data: b64, part_sha256: ph }); if (r.isError) break; }
  const m1 = s.rss();
  check(`250 files started and never finished: memory stays bounded (${m0} MB -> ${m1} MB) and nothing was saved`, m1 - m0 < 250 && !fs.readdirSync(T(W)).some((n) => n.startsWith('flood')), `${m0} -> ${m1}`);
  let r = await s.call('receive_file', { path: `${W}/flood-0.bin`, part: 13, parts: 600, data: b64, part_sha256: ph });
  check('an upload pushed out by newer ones says clearly that it must start again', r.isError && /Start again from part 1/.test(r.text), r.text);
  const big = await s.call('receive_file', { path: `${W}/huge-part.bin`, part: 1, parts: 1, data: 'A'.repeat(120000), part_sha256: ph, file_sha256: ph });
  const many = await s.call('receive_file', { path: `${W}/many.bin`, part: 1, parts: 5000, data: 'QQ==', part_sha256: hex(Buffer.from('A')) });
  const neg = await s.call('receive_file', { path: `${W}/neg.bin`, part: 0, parts: 1, data: 'QQ==', part_sha256: hex(Buffer.from('A')) });
  const beyond = await s.call('receive_file', { path: `${W}/beyond.bin`, part: 3, parts: 2, data: 'QQ==', part_sha256: hex(Buffer.from('A')) });
  check('oversized parts, absurd part counts and impossible part numbers are refused', big.isError && many.isError && neg.isError && beyond.isError, [big, many, neg, beyond].map((x) => x.text.slice(0, 60)).join(' | '));
  // after all that, an honest file still goes through
  const file = crypto.randomBytes(20000); const parts = [file.subarray(0, 7000), file.subarray(7000, 14000), file.subarray(14000)];
  for (let i = 0; i < 3; i++) r = await s.call('receive_file', { path: `${W}/honest.bin`, part: i + 1, parts: 3, data: parts[i].toString('base64'), part_sha256: hex(parts[i]), ...(i === 2 ? { file_sha256: hex(file) } : {}) });
  check('and a normal file still arrives intact afterwards', !r.isError && Buffer.compare(fs.readFileSync(T(`${W}/honest.bin`)), file) === 0 && s.errors() === 0, r.text);
  await s.client.close();
}

console.log('F. Interplay with the older features');
{
  const s = await start('interplay', { TRESORIT_BLOCKED: 'Personal/Scans' });
  const textOf = () => { try { return fs.readdirSync(`${s.DATA}/index/text`).map((f) => fs.readFileSync(`${s.DATA}/index/text/${f}`, 'utf8')).join('\n'); } catch { return ''; } };
  await s.call('write_file', { path: `${W}/secret plan.txt`, content: 'the phrase walnut-harbour-7731 is in here' });
  await s.call('write_file', { path: `${W}/to delete.txt`, content: 'the phrase maple-lantern-5582 is in here' });
  let r = await s.call('search_contents', { query: 'walnut-harbour-7731' }); const r0 = await s.call('search_contents', { query: 'maple-lantern-5582' });
  const indexed = r.text.includes('secret plan.txt') && r0.text.includes('to delete.txt') && /walnut-harbour-7731/.test(textOf()) && /maple-lantern-5582/.test(textOf());
  fs.mkdirSync(T('Strongbox'), { recursive: true });
  r = await s.call('move_item', { source: `${W}/secret plan.txt`, destination: 'Strongbox/secret plan.txt' });
  await sleep(300);
  check('a document moved into a "do not index" folder has its text dropped from the index at once', indexed && !r.isError && !/walnut-harbour-7731/.test(textOf()), `indexed ${indexed}`);
  r = await s.call('search_contents', { query: 'walnut-harbour-7731' });
  check('and searches no longer find it, while reading it by name still works', /^0 file/.test(r.text) && (await s.call('read_file', { path: 'Strongbox/secret plan.txt' })).text.includes('walnut-harbour-7731'), r.text);
  const dp = await s.call('delete_items', { paths: [`${W}/to delete.txt`] });
  await s.call('delete_items', { paths: [`${W}/to delete.txt`], confirm_token: tok(dp.text) });
  await sleep(300);
  check('a deleted document has its text dropped from the index at once too', !/maple-lantern-5582/.test(textOf()));
  r = await s.call('import_file', { source: 'a.pdf', destination: 'Personal/Scans' });
  const r2 = await s.call('export_file', { path: 'Personal/Scans' });
  check('a blocked folder can be neither a destination for bringing in nor a source for copying out', r.isError && r2.isError && !fs.existsSync(T('Personal/Scans/a.pdf')) && fs.readdirSync(`${s.DATA}/staging`).length === 0, r.text + r2.text);
  // bringing a folder in over an existing folder, with overwrite
  fs.mkdirSync(T(`${W}/Projects`), { recursive: true }); fs.writeFileSync(T(`${W}/Projects/original.txt`), 'ORIGINAL-FOLDER');
  const pv = await s.call('import_file', { source: '~/Documents/Projects', destination: W, overwrite: true });
  r = await s.call('import_file', { source: '~/Documents/Projects', destination: W, overwrite: true, confirm_token: tok(pv.text) });
  const hb = (r.text.match(/batch (\S+_replaced_\w+)/) || [])[1];
  check('a folder brought in over an existing one keeps the old folder whole in the holding area', !r.isError && inT(`${W}/Projects/p.docx`) && !inT(`${W}/Projects/original.txt`) && hb && fs.readFileSync(`${s.DATA}/deleted/${hb}/files/${W}/Projects/original.txt`, 'utf8') === 'ORIGINAL-FOLDER', r.text);
  r = await s.call('restore_deleted', { batch: hb, overwrite: true });
  check('and the old folder can be restored over it (the imported one is then kept instead)', /restored/.test(r.text) && fs.readFileSync(T(`${W}/Projects/original.txt`), 'utf8') === 'ORIGINAL-FOLDER', r.text);
  // the original of a moved file cannot be put back through a link
  fs.mkdirSync(`${HOME}/Desktop/spot`); fs.writeFileSync(`${HOME}/Desktop/spot/item.txt`, 'ITEM');
  r = await s.call('import_file', { source: '~/Desktop/spot/item.txt', destination: `${W}/item.txt`, mode: 'move' });
  const mb = (r.text.match(/batch (\S+_imported_\w+)/) || [])[1];
  fs.rmSync(`${HOME}/Desktop/spot`, { recursive: true }); fs.symlinkSync(`${HOME}/Library/Keychains`, `${HOME}/Desktop/spot`);
  r = await s.call('restore_deleted', { batch: mb });
  check('if the folder a moved original came from has since become a link into a protected place, it is not put back there', /not restored/.test(r.text) && !fs.existsSync(`${HOME}/Library/Keychains/item.txt`), r.text);
  fs.rmSync(`${HOME}/Desktop/spot`);
  // a holding-area record whose item never arrived (the connector was stopped between writing the record and
  // moving the item): it must be listed, fail to restore politely, and be clearable
  const ghost = `${s.DATA}/deleted/2026-01-01_000000_deleted_abcdef`;
  fs.mkdirSync(`${ghost}/files`, { recursive: true });
  fs.writeFileSync(`${ghost}/manifest.json`, JSON.stringify({ kind: 'deleted', when: '2026-01-01 00:00:00', items: [{ original: `${W}/never arrived.txt`, type: 'file' }, { original: `${HOME}/Desktop/never left.txt`, type: 'file', outside: true }] }));
  const gl = await s.call('list_deleted', {}); const gr = await s.call('restore_deleted', { batch: '2026-01-01_000000_deleted_abcdef' });
  const gc = await s.call('clear_deleted', { batches: ['2026-01-01_000000_deleted_abcdef'], confirm_token: tok((await s.call('clear_deleted', { batches: ['2026-01-01_000000_deleted_abcdef'] })).text) });
  check('a holding-area record without its item is listed, fails to restore without harm, and can be cleared', gl.text.includes('never arrived.txt') && /failed|not restored/.test(gr.text) && !inT(`${W}/never arrived.txt`) && !fs.existsSync(`${HOME}/Desktop/never left.txt`) && !gc.isError && !fs.existsSync(ghost), gr.text + gc.text);
  // every batch made in this session has its record
  const noRecord = fs.readdirSync(`${s.DATA}/deleted`).filter((b) => !fs.existsSync(`${s.DATA}/deleted/${b}/manifest.json`));
  check('no batch in the holding area is without a record', noRecord.length === 0, noRecord.join(', '));
  await s.client.close();

  const g = await start('gate', { TRESORIT_PREFLIGHT_GATE: undefined });
  const e = await g.call('export_file', { path: 'Alder Works UK/03 - Finance/Commission tracker 2026.xlsx' });
  check('copying out to Downloads also waits for the self-check', e.isError && /self-check/.test(e.text) && !fs.readdirSync(`${HOME}/Downloads`).some((n) => /Commission/.test(n)), e.text);
  await g.client.close();
}

console.log('G. The Mac\'s own disk reached through /Volumes');
{
  const { makeOutside } = await import(`${LIB}/outside.js`);
  let made = false;
  try { fs.mkdirSync('/Volumes/DeepCheckDisk/Users/someone/Library/Keychains', { recursive: true }); fs.writeFileSync('/Volumes/DeepCheckDisk/Users/someone/Library/Keychains/login.keychain', 'k'); fs.writeFileSync('/Volumes/DeepCheckDisk/doc.txt', 'd'); made = true; } catch { made = false; }
  if (made) {
    const o = makeOutside({ home: HOME, roots: [HOME, '/Volumes'], tresoritRoot: ROOT, dataDir: `${BASE}/data-dc-x` });
    const why = o.protectedReason('/Volumes/DeepCheckDisk/doc.txt');
    check('a path under /Volumes that is really on the Mac\'s own disk is refused', /own disk/.test(why), why);
    fs.rmSync('/Volumes/DeepCheckDisk', { recursive: true, force: true }); try { fs.rmdirSync('/Volumes'); } catch { /* not empty or not ours */ }
  } else check('(skipped: /Volumes cannot be created here)', true);
}

console.log('H. The queue of changes: closing, withdrawn requests, dialogs');
{
  const { spawn } = await import('node:child_process');
  const raw = (name, extra = {}, keep = false) => {
    const DATA = `${BASE}/data-dc-${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
    const child = spawn('node', [SERVER], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off', ...extra }, stdio: ['pipe', 'pipe', 'ignore'] });
    const replies = new Map(); const waiters = new Map(); let buf = ''; const incoming = [];
    child.stdin.on('error', () => { /* the connector was killed while a request was being sent: expected in these tests */ });
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id !== undefined && m.method) incoming.push(m); else if (m.id !== undefined) { replies.set(m.id, m); const w = waiters.get(m.id); if (w) w(m); } } });
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };
    let id = 100;
    const call = (tool, args) => { const my = ++id; send({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name: 'tresorit_' + tool, arguments: args } }); return { id: my, done: new Promise((res) => { if (replies.has(my)) res(replies.get(my)); else waiters.set(my, res); }) }; };
    const text = (m) => (m && m.result ? m.result.content.map((c) => c.text || '').join('\n') : JSON.stringify(m && m.error));
    const init = async (caps = {}) => { send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: caps, clientInfo: { name: 'raw', version: '1' } } }); await sleep(600); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); };
    const exited = new Promise((res) => child.on('exit', (c) => res(c)));
    return { child, send, call, text, init, exited, DATA, incoming };
  };
  fs.mkdirSync(T(W), { recursive: true });
  fs.mkdirSync(`${HOME}/Downloads/qpack`, { recursive: true }); for (let i = 0; i < 1000; i++) fs.writeFileSync(`${HOME}/Downloads/qpack/f${i}.bin`, crypto.randomBytes(100000));
  {
    const s = raw('q1'); await s.init();
    const pv = await s.call('import_file', { source: '~/Downloads/qpack', destination: W }).done;
    s.call('import_file', { source: '~/Downloads/qpack', destination: W, confirm_token: tok(s.text(pv)) });
    await sleep(100);
    for (let i = 0; i < 6; i++) s.call('write_file', { path: `${W}/queued-${i}.txt`, content: `queued ${i}` });
    await sleep(50); s.child.stdin.end();
    const code = await Promise.race([s.exited, sleep(100000).then(() => 'still running')]);
    const n = inT(`${W}/qpack`) ? fs.readdirSync(T(`${W}/qpack`)).length : 0;
    const q = [0, 1, 2, 3, 4, 5].filter((i) => inT(`${W}/queued-${i}.txt`)).length;
    check('Claude closed with one change running and six waiting: all seven are completed, then the connector stops', code === 0 && n === 1000 && q === 6 && fs.readdirSync(`${s.DATA}/staging`).length === 0, `exit ${code}, ${n} files, ${q} writes`);
    fs.rmSync(T(`${W}/qpack`), { recursive: true, force: true });
  }
  {
    const s = raw('q2'); await s.init();
    const pv = await s.call('import_file', { source: '~/Downloads/qpack', destination: W }).done;
    const long = s.call('import_file', { source: '~/Downloads/qpack', destination: W, confirm_token: tok(s.text(pv)) });
    await sleep(100);
    const w = s.call('write_file', { path: `${W}/withdrawn.txt`, content: 'the app gave up on this one' });
    const w2 = s.call('write_file', { path: `${W}/kept.txt`, content: 'this one was not withdrawn' });
    await sleep(50); s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: w.id, reason: 'timed out' } });
    await long.done; await w2.done; await sleep(500);
    const logText = fs.readFileSync(`${s.DATA}/logs/${fs.readdirSync(`${s.DATA}/logs`)[0]}`, 'utf8');
    check('a change the app withdrew while it was waiting is not carried out later; the others are', !inT(`${W}/withdrawn.txt`) && inT(`${W}/kept.txt`) && /withdrawn by the app/.test(logText), logText.split('\n').slice(-6).join(' | '));
    s.child.kill(); await s.exited; fs.rmSync(T(`${W}/qpack`), { recursive: true, force: true });
  }
  {
    const s = raw('q3'); await s.init({ elicitation: {} });
    await s.call('write_file', { path: `${W}/victim.txt`, content: 'v' }).done;
    const pv = await s.call('delete_items', { paths: [`${W}/victim.txt`] }).done;
    const del = s.call('delete_items', { paths: [`${W}/victim.txt`], confirm_token: tok(s.text(pv)) });
    await sleep(300);
    const w = await Promise.race([s.call('write_file', { path: `${W}/meanwhile.txt`, content: 'm' }).done, sleep(4000).then(() => null)]);
    const still = inT(`${W}/victim.txt`);
    if (s.incoming[0]) s.send({ jsonrpc: '2.0', id: s.incoming[0].id, result: { action: 'accept', content: { confirm: true } } });
    await del.done;
    check('while a delete waits for the user in a dialog, other changes go ahead, and the delete happens only after the yes', Boolean(w) && still && s.incoming.length === 1 && !inT(`${W}/victim.txt`));
    s.child.kill(); await s.exited;
  }

  console.log('I. Killed at random moments while replacing files and folders');
  {
    const names = Array.from({ length: 9 }, (_, i) => `chaos-${i}.txt`);
    const body = (v) => `version ${v}\n` + 'x'.repeat(200000) + `\nend of version ${v}\n`;
    for (const n of names) fs.writeFileSync(T(`${W}/${n}`), body(0));
    fs.mkdirSync(T(`${W}/chaos-folder`), { recursive: true }); for (let i = 0; i < 300; i++) fs.writeFileSync(T(`${W}/chaos-folder/o${i}.bin`), crypto.randomBytes(50000));
    fs.mkdirSync(T(`${W}/chaos-copy`), { recursive: true }); fs.writeFileSync(T(`${W}/chaos-copy/old.txt`), 'OLD COPY');
    let missing = 0, torn = 0, sourceDamaged = 0, noRecord = 0, copyGone = 0; const KILLS = 45; let DATA = ''; let innerMade = false;
    const hasFile = (d) => fs.readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasFile(`${d}/${e.name}`) : !/^manifest\.json/.test(e.name)));
    for (let round = 1; round <= KILLS; round++) {
      const s = raw('chaos', { TRESORIT_STAGING_MAX_AGE_MS: '1' }, round > 1); DATA = s.DATA; await s.init();
      for (const [i, n] of names.entries()) {
        if (i % 3 === 0) s.call('write_file', { path: `${W}/${n}`, content: body(round), overwrite: true });
        else if (i % 3 === 1) s.call('edit_file', { path: `${W}/${n}`, old_text: 'version', new_text: 'version', replace_all: true });
        else { fs.writeFileSync(`${HOME}/Downloads/${n}`, body(round)); s.call('import_file', { source: `~/Downloads/${n}`, destination: `${W}/${n}`, overwrite: true }); }
      }
      if (round % 2 === 0) s.call('copy_item', { source: `${W}/chaos-folder`, destination: `${W}/chaos-copy`, overwrite: true });
      await sleep(3 + Math.floor(Math.random() * 160)); s.child.kill('SIGKILL'); await s.exited;
      for (const n of names) {
        const p = T(`${W}/${n}`);
        if (!fs.existsSync(p)) { missing++; fs.writeFileSync(p, body(0)); continue; }
        const c = fs.readFileSync(p, 'utf8'); const m = c.match(/^version (\d+)\n/);
        if (!m || !c.endsWith(`\nend of version ${m[1]}\n`) || c.length !== body(Number(m[1])).length) { torn++; fs.writeFileSync(p, body(0)); }
      }
      if (!inT(`${W}/chaos-folder`) || fs.readdirSync(T(`${W}/chaos-folder`)).length !== 300) sourceDamaged++;
      // The copy goes INTO the existing folder chaos-copy (that is what copying onto a folder means), as
      // chaos-copy/chaos-folder; from the second time on it replaces the copy made before. So chaos-copy itself and
      // what was in it are never touched, and the copy inside is, at every moment, complete, not there yet, or (for
      // an instant, while it is being swapped) away with the previous one safe in the holding area: never half a folder.
      {
        const inner = `${W}/chaos-copy/chaos-folder`;
        if (!inT(`${W}/chaos-copy/old.txt`) || fs.readFileSync(T(`${W}/chaos-copy/old.txt`), 'utf8') !== 'OLD COPY') { copyGone++; fs.mkdirSync(T(`${W}/chaos-copy`), { recursive: true }); fs.writeFileSync(T(`${W}/chaos-copy/old.txt`), 'OLD COPY'); }
        if (fs.readdirSync(T(`${W}/chaos-copy`)).some((n) => n !== 'old.txt' && n !== 'chaos-folder')) copyGone++;
        if (inT(inner)) { if (fs.readdirSync(T(inner)).length !== 300) { copyGone++; fs.rmSync(T(inner), { recursive: true, force: true }); innerMade = false; } else innerMade = true; }
        else if (innerMade) {
          const safe = fs.readdirSync(`${DATA}/deleted`).some((b) => { try { return fs.readdirSync(`${DATA}/deleted/${b}/files/${inner}`).length === 300; } catch { return false; } });
          if (!safe) copyGone++;
          innerMade = false;
        }
      }
      for (const b of fs.readdirSync(`${DATA}/deleted`)) { let ok = false; try { JSON.parse(fs.readFileSync(`${DATA}/deleted/${b}/manifest.json`, 'utf8')); ok = true; } catch { ok = false; } if (!ok && hasFile(`${DATA}/deleted/${b}`)) noRecord++; }
    }
    check(`${KILLS} kills while files were being overwritten, edited and replaced: no file was ever missing or cut short`, missing === 0 && torn === 0, `missing ${missing}, cut short ${torn}`);
    check('the folder being copied from was never touched, the folder copied into kept what it held, and the copy inside it was never left half-made', sourceDamaged === 0 && copyGone === 0, `source ${sourceDamaged}, replaced folder ${copyGone}`);
    check('every batch in the holding area that holds a file has a readable record', noRecord === 0, noRecord);
    const after = await start('chaos', { TRESORIT_STAGING_MAX_AGE_MS: '1' }, { keep: true });
    const junk = fs.readdirSync(`${DATA}/deleted`).filter((b) => !fs.existsSync(`${DATA}/deleted/${b}/manifest.json`));
    const lst = await after.call('list_deleted', {}); const wr = await after.call('write_file', { path: `${W}/after chaos.txt`, content: 'fine' });
    check('after all that the next start clears the leftovers and everything works', fs.readdirSync(`${DATA}/staging`).length === 0 && junk.length === 0 && !lst.isError && !wr.isError, `junk ${junk.length}; ${lst.text.slice(0, 100)}`);
    await after.client.close();
  }
  {
    // The connector is stopped while the files are on their way to the holding area. Since 1.4.7 a confirmed delete
    // first waits for the confirmation window (here the stand-in, a process that has to start), so a stop a fixed
    // number of milliseconds after the request mostly came before the first file had moved, and the check could
    // not tell anything. Each round now waits until a set number of the 200 files has reached the holding area and
    // stops the connector at that moment (or a few milliseconds after it), whatever the speed of the machine.
    const STOP_AT = [1, 20, 50, 90, 130, 170];
    let lost = 0, unrecorded = 0, both = 0, heldTotal = 0, midway = 0; const heldAtStop = [];
    for (let round = 0; round < STOP_AT.length; round++) {
      const s = raw('delkill'); await s.init();
      fs.rmSync(T(`${W}/many`), { recursive: true, force: true }); fs.mkdirSync(T(`${W}/many`), { recursive: true }); const paths = [];
      for (let i = 0; i < 200; i++) { fs.writeFileSync(T(`${W}/many/d${i}.txt`), `d ${i}`); paths.push(`${W}/many/d${i}.txt`); }
      const pv = await s.call('delete_items', { paths }).done;
      s.call('delete_items', { paths, confirm_token: tok(s.text(pv)) });
      const heldNow = () => { let n = 0; try { for (const b of fs.readdirSync(`${s.DATA}/deleted`)) { try { n += fs.readdirSync(`${s.DATA}/deleted/${b}/files/${W}/many`).length; } catch { /* not there yet */ } } } catch { /* not there yet */ } return n; };
      const giveUp = Date.now() + 60000; while (heldNow() < STOP_AT[round] && Date.now() < giveUp) await sleep(1);
      if (round % 2) await sleep(1 + round); // every other round a few milliseconds later, to land at another point of the work
      s.child.kill('SIGKILL'); await s.exited;
      const batches = fs.readdirSync(`${s.DATA}/deleted`);
      const recorded = new Set(); for (const b of batches) { try { for (const it of JSON.parse(fs.readFileSync(`${s.DATA}/deleted/${b}/manifest.json`, 'utf8')).items) recorded.add(it.original); } catch { /* no record */ } }
      let heldRound = 0;
      for (const p of paths) { const there = inT(p); const held = batches.some((b) => fs.existsSync(`${s.DATA}/deleted/${b}/files/${p}`)); if (there && held) both++; if (!there && !held) lost++; if (held) { heldRound++; if (!recorded.has(p)) unrecorded++; } }
      heldTotal += heldRound; heldAtStop.push(heldRound); if (heldRound > 0 && heldRound < paths.length) midway++;
    }
    check(`stopped six times while 200 files were on their way to the holding area (there at the stop: ${heldAtStop.join(', ')}): none lost, none without a record, none duplicated`, lost === 0 && unrecorded === 0 && both === 0 && midway >= 3, `lost ${lost}, unrecorded ${unrecorded}, both ${both}; stopped in mid-delete in ${midway} of ${STOP_AT.length} rounds`);
  }

  console.log('K. Several copies of the connector at once (several Claude windows)');
  const good = (m) => Boolean(m && m.result && !m.result.isError);
  {
    const a = raw('twin'); await a.init(); const b = raw('twin', {}, true); await b.init(); const c = raw('twin', {}, true); await c.init();
    const copies = [a, b, c];
    fs.mkdirSync(T(`${W}/twin`), { recursive: true });
    const ROUNDS = 60; let cleanMoves = 0, cleanImports = 0, overwritten = 0;
    for (let r = 0; r < ROUNDS; r++) {
      for (let i = 0; i < 6; i++) { fs.writeFileSync(T(`${W}/twin/m${r}-${i}.txt`), `mover ${r}-${i}`); fs.writeFileSync(`${HOME}/Downloads/tw${r}-${i}.txt`, `incomer ${r}-${i}`); }
      const moves = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => copies[i % 3].call('move_item', { source: `${W}/twin/m${r}-${i}.txt`, destination: `${W}/twin/target-${r}.txt` }).done));
      const left = [0, 1, 2, 3, 4, 5].filter((i) => inT(`${W}/twin/m${r}-${i}.txt`)).length;
      const got = inT(`${W}/twin/target-${r}.txt`) ? fs.readFileSync(T(`${W}/twin/target-${r}.txt`), 'utf8') : '';
      if (moves.filter(good).length === 1 && left === 5 && new RegExp(`^mover ${r}-\\d$`).test(got)) cleanMoves++; else if (left < 5) overwritten++;
      const imps = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => copies[i % 3].call('import_file', { source: `~/Downloads/tw${r}-${i}.txt`, destination: `${W}/twin/in-${r}.txt` }).done));
      const arrived = inT(`${W}/twin/in-${r}.txt`) ? fs.readFileSync(T(`${W}/twin/in-${r}.txt`), 'utf8') : '';
      if (imps.filter(good).length === 1 && new RegExp(`^incomer ${r}-\\d$`).test(arrived)) cleanImports++;
      for (let i = 0; i < 6; i++) fs.rmSync(`${HOME}/Downloads/tw${r}-${i}.txt`, { force: true });
    }
    check(`${ROUNDS * 6} files moved to the same name by three copies of the connector at once: one moves, five stay, none is overwritten`, cleanMoves === ROUNDS && overwritten === 0, `clean rounds ${cleanMoves}/${ROUNDS}; rounds where a file was overwritten ${overwritten}`);
    check(`${ROUNDS * 6} files brought in to the same name by three copies at once: exactly one arrives each time`, cleanImports === ROUNDS, `clean rounds ${cleanImports}/${ROUNDS}`);
    // ten edits of one file, spread over the three copies: every one must be kept
    fs.writeFileSync(T(`${W}/twin/shared.md`), Array.from({ length: 10 }, (_, i) => `line ${i}: old`).join('\n') + '\n');
    const eds = await Promise.all(Array.from({ length: 10 }, (_, i) => copies[i % 3].call('edit_file', { path: `${W}/twin/shared.md`, old_text: `line ${i}: old`, new_text: `line ${i}: NEW` }).done));
    const sh = fs.readFileSync(T(`${W}/twin/shared.md`), 'utf8');
    check('ten edits of one file made through three copies at once are all kept', eds.every(good) && (sh.match(/NEW/g) || []).length === 10 && !/old/.test(sh), sh.replace(/\n/g, ' | '));
    check('the lock is given back when nothing is changing', !fs.existsSync(`${a.DATA}/change.lock`) && !fs.existsSync(`${a.DATA}/change.lock.break`) && fs.readdirSync(a.DATA).filter((x) => /change\.lock/.test(x)).length === 0, fs.readdirSync(a.DATA).join(', '));

    // a change in one window waits for a long change in another, and is then carried out
    let pv = await a.call('import_file', { source: '~/Downloads/qpack', destination: `${W}/twin` }).done;
    const long = a.call('import_file', { source: '~/Downloads/qpack', destination: `${W}/twin`, confirm_token: tok(a.text(pv)) });
    await sleep(150);
    let longDone = false; long.done.then(() => { longDone = true; });
    const waited = await b.call('write_file', { path: `${W}/twin/after the import.txt`, content: 'waited for the other window' }).done;
    const arrivedBefore = inT(`${W}/twin/qpack`) && fs.readdirSync(T(`${W}/twin/qpack`)).length === 1000;
    await long.done;
    check('a change in one window waits for a long change in another window, then is carried out', good(waited) && arrivedBefore && inT(`${W}/twin/after the import.txt`), `${a.text(waited)}; import complete before the write: ${arrivedBefore}; ${longDone}`);
    fs.rmSync(T(`${W}/twin/qpack`), { recursive: true, force: true });

    // withdrawn while waiting for the other window; and too long a wait is refused and never happens later
    const d = raw('twin', { TRESORIT_CHANGE_WAIT_MS: '300' }, true); await d.init();
    pv = await a.call('import_file', { source: '~/Downloads/qpack', destination: `${W}/twin` }).done;
    const long2 = a.call('import_file', { source: '~/Downloads/qpack', destination: `${W}/twin`, confirm_token: tok(a.text(pv)) });
    await sleep(150);
    const wd = b.call('write_file', { path: `${W}/twin/withdrawn.txt`, content: 'given up' });
    const late = d.call('write_file', { path: `${W}/twin/too late.txt`, content: 'waited too long' });
    await sleep(60); b.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: wd.id, reason: 'timed out' } });
    const lateReply = await late.done; await long2.done; await sleep(600);
    check('a change withdrawn while waiting for another window is not carried out', !inT(`${W}/twin/withdrawn.txt`));
    check('a change that waited too long for another window is refused with an explanation, and does not happen later', !good(lateReply) && /another Claude window/.test(d.text(lateReply)) && !inT(`${W}/twin/too late.txt`), d.text(lateReply));
    fs.rmSync(T(`${W}/twin/qpack`), { recursive: true, force: true });

    // Claude closes one window while its change is waiting for another window: the change is still completed
    pv = await a.call('import_file', { source: '~/Downloads/qpack', destination: `${W}/twin` }).done;
    const long3 = a.call('import_file', { source: '~/Downloads/qpack', destination: `${W}/twin`, confirm_token: tok(a.text(pv)) });
    await sleep(150);
    c.call('write_file', { path: `${W}/twin/closing window.txt`, content: 'window closed while waiting' });
    await sleep(60); c.child.stdin.end();
    const ccode = await Promise.race([c.exited, sleep(100000).then(() => 'still running')]); await long3.done;
    check('a window closed while its change waits for another window: the change is completed, then that copy stops', ccode === 0 && inT(`${W}/twin/closing window.txt`), `exit ${ccode}`);
    fs.rmSync(T(`${W}/twin/qpack`), { recursive: true, force: true });

    // the copy that holds the lock is killed in mid-change: the others carry on at once
    pv = await a.call('import_file', { source: '~/Downloads/qpack', destination: `${W}/twin` }).done;
    a.call('import_file', { source: '~/Downloads/qpack', destination: `${W}/twin`, confirm_token: tok(a.text(pv)) });
    await sleep(200); const heldBy = fs.existsSync(`${a.DATA}/change.lock`); a.child.kill('SIGKILL'); await a.exited;
    const t0 = Date.now();
    const afterKill = await Promise.race([b.call('write_file', { path: `${W}/twin/after the kill.txt`, content: 'carried on' }).done, sleep(15000).then(() => null)]);
    check('when the copy that is changing something is killed, the other copies carry on at once', heldBy && good(afterKill) && Date.now() - t0 < 3000 && !inT(`${W}/twin/qpack`), `lock was held: ${heldBy}; ${afterKill ? b.text(afterKill) : 'no answer in 15 s'}; ${Date.now() - t0} ms`);
    b.child.kill(); d.child.kill(); await b.exited; await d.exited;

    // locks left behind in other ways
    const plant = (body, ageMs) => { fs.writeFileSync(`${a.DATA}/change.lock`, body); const t = new Date(Date.now() - ageMs); fs.utimesSync(`${a.DATA}/change.lock`, t, t); };
    const e = raw('twin', { TRESORIT_LOCK_STALE_MS: '1500' }, true); await e.init();
    plant(JSON.stringify({ id: 'gone.1', pid: 2147483600, what: 'x', since: 1 }), 0);
    let t1 = Date.now(); let w = await Promise.race([e.call('write_file', { path: `${W}/twin/stale 1.txt`, content: '1' }).done, sleep(20000).then(() => null)]);
    const fast = Date.now() - t1;
    plant('', 600000);
    const w2 = await Promise.race([e.call('write_file', { path: `${W}/twin/stale 2.txt`, content: '2' }).done, sleep(20000).then(() => null)]);
    plant(JSON.stringify({ id: 'alive.1', pid: process.pid, what: 'x', since: 1 }), 0);
    t1 = Date.now(); const w3 = await Promise.race([e.call('write_file', { path: `${W}/twin/stale 3.txt`, content: '3' }).done, sleep(20000).then(() => null)]);
    const slow = Date.now() - t1;
    check('a lock left by a copy that no longer exists is cleared at once; an unreadable or unrenewed one after a while', good(w) && fast < 2000 && good(w2) && good(w3) && slow >= 1500 && slow < 12000, `${fast} ms; ${Boolean(w2)}; ${slow} ms`);
    // a lock that IS being renewed by a live copy is respected for as long as it takes
    plant(JSON.stringify({ id: 'alive.2', pid: process.pid, what: 'a long copy', since: Date.now() }), 0);
    const renew = setInterval(() => { const t = new Date(); try { fs.utimesSync(`${a.DATA}/change.lock`, t, t); } catch { /* gone */ } }, 300);
    let respected = true; const w4 = e.call('write_file', { path: `${W}/twin/respected.txt`, content: '4' }); w4.done.then(() => { if (fs.existsSync(`${a.DATA}/change.lock`) && renewing) respected = false; });
    let renewing = true; await sleep(6000); const stillWaiting = !inT(`${W}/twin/respected.txt`);
    renewing = false; clearInterval(renew); fs.rmSync(`${a.DATA}/change.lock`, { force: true });
    const w4r = await Promise.race([w4.done, sleep(8000).then(() => null)]);
    check('a lock that a live copy keeps renewing is respected however long it takes, and the change follows when it is given back', stillWaiting && respected && good(w4r) && inT(`${W}/twin/respected.txt`), `${stillWaiting} ${respected} ${Boolean(w4r)}`);
    e.child.kill(); await e.exited;
    // a copy that starts while another is in the middle of a change leaves that copy's work in the staging folder alone
    fs.mkdirSync(`${a.DATA}/staging/in-use-by-another-copy`, { recursive: true }); fs.writeFileSync(`${a.DATA}/staging/in-use-by-another-copy/part.bin`, 'half way');
    const old = new Date(Date.now() - 5 * 3600 * 1000); fs.utimesSync(`${a.DATA}/staging/in-use-by-another-copy`, old, old);
    plant(JSON.stringify({ id: 'alive.3', pid: process.pid, what: 'a very long import', since: Date.now() }), 0);
    const f = raw('twin', {}, true); await f.init(); await sleep(300);
    const keptWhileBusy = fs.existsSync(`${a.DATA}/staging/in-use-by-another-copy/part.bin`);
    f.child.kill(); await f.exited; fs.rmSync(`${a.DATA}/change.lock`, { force: true });
    const g = raw('twin', {}, true); await g.init(); await sleep(300);
    const clearedWhenIdle = !fs.existsSync(`${a.DATA}/staging/in-use-by-another-copy`);
    g.child.kill(); await g.exited;
    check('a copy that starts while another is in mid-change leaves the staging folder alone; once nothing is changing, old leftovers are cleared', keptWhileBusy && clearedWhenIdle, `${keptWhileBusy} ${clearedWhenIdle}`);
  }

  console.log('L. A refusal does not reveal whether something exists in a protected place');
  {
    const s = raw('oracle'); await s.init();
    const ask = async (tool, args) => s.text(await s.call(tool, args).done);
    const strip = (t, p) => t.split(p).join('<path>');
    const pairs = [['~/.ssh/id_rsa', '~/.ssh/no-such-key'], ['~/Library/Keychains/login.keychain-db', '~/Library/Keychains/absent.keychain-db'], ['~/Library/Application Support/App/data', '~/Library/Application Support/Nothing/here'],
      ['~/Downloads/slink/id_rsa', '~/Downloads/slink/no-such-key'], ['~/Documents/klink/login.keychain-db', '~/Documents/klink/absent.keychain-db'], ['~/Documents/.hid/h.txt', '~/Documents/.hid/none.txt'],
      ['~/Applications/Thing.app/Contents/i', '~/Applications/Thing.app/Contents/none'], [`${ROOT}/Birch Labs`, `${ROOT}/Birch Labs/no such file.txt`], ['/etc/hosts', '/etc/no-such-file'], [`${s.DATA}/logs`, `${s.DATA}/nothing`]];
    const differ = [];
    for (const [there, absent] of pairs) {
      for (const [tool, key] of [['import_file', 'source'], ['list_outside_folder', 'path']]) {
        const args = (p) => (tool === 'import_file' ? { source: p, destination: `${W}/oracle/` } : { path: p });
        const x = strip(await ask(tool, args(there)), there); const y = strip(await ask(tool, args(absent)), absent);
        if (x !== y || !/cannot be used/.test(x)) differ.push(`${tool} ${there}: "${x.slice(0, 90)}" vs "${y.slice(0, 90)}"`);
      }
    }
    check(`${pairs.length} protected places, asked for something that exists and something that does not: the answers are identical`, differ.length === 0, differ.join(' || '));
    const nf = await ask('import_file', { source: '~/Downloads/not here.pdf', destination: `${W}/oracle/` });
    const okImp = await ask('import_file', { source: '~/Downloads/a.pdf', destination: `${W}/oracle/` });
    check('in a place that may be used, a missing file is still reported as not found and a present one is brought in', /Not found on this Mac/.test(nf) && /Brought into Tresorit/.test(okImp) && !inT(`${W}/oracle/id_rsa`), `${nf} | ${okImp}`);
    s.child.kill(); await s.exited;
  }
  fs.rmSync(`${HOME}/Downloads/qpack`, { recursive: true, force: true });
}

console.log('J. Replacing things: what is kept, and what stays the same');
{
  const s = await start('replace');
  await s.call('write_file', { path: `${W}/perm.md`, content: 'line one\nline two\n' });
  fs.chmodSync(T(`${W}/perm.md`), 0o640);
  let r = await s.call('edit_file', { path: `${W}/perm.md`, old_text: 'line two', new_text: 'line 2' });
  check('an edit keeps the file\'s permissions, and the earlier version goes to the holding area', !r.isError && (fs.statSync(T(`${W}/perm.md`)).mode & 0o777) === 0o640 && fs.readFileSync(T(`${W}/perm.md`), 'utf8') === 'line one\nline 2\n' && /holding area/.test(r.text), r.text);
  fs.mkdirSync(T(`${W}/is a folder`), { recursive: true }); fs.writeFileSync(T(`${W}/is a folder/inside.txt`), 'INSIDE');
  r = await s.call('write_file', { path: `${W}/is a folder`, content: 'x', overwrite: true });
  check('a file is never written over a folder', r.isError && fs.readFileSync(T(`${W}/is a folder/inside.txt`), 'utf8') === 'INSIDE', r.text);
  fs.writeFileSync(`${HOME}/Downloads/over folder.txt`, 'NEW FILE');
  r = await s.call('import_file', { source: '~/Downloads/over folder.txt', destination: `${W}/is a folder/inside.txt`, overwrite: true });
  const b1 = (r.text.match(/batch (\S+_replaced_\w+)/) || [])[1];
  check('a file brought in over a file: the new one is in place and the old one is kept', !r.isError && fs.readFileSync(T(`${W}/is a folder/inside.txt`), 'utf8') === 'NEW FILE' && b1 && fs.readFileSync(`${s.DATA}/deleted/${b1}/files/${W}/is a folder/inside.txt`, 'utf8') === 'INSIDE', r.text);
  r = await s.call('restore_deleted', { batch: b1, overwrite: true });
  check('and restoring brings the old one back, keeping the newer one in the holding area instead', /restored/.test(r.text) && fs.readFileSync(T(`${W}/is a folder/inside.txt`), 'utf8') === 'INSIDE', r.text);
  // a failing copy over an existing folder leaves the existing folder exactly as it was, with nothing in the holding area
  const { execSync } = await import('node:child_process');
  fs.mkdirSync(T(`${W}/src-bad`), { recursive: true }); fs.writeFileSync(T(`${W}/src-bad/a.txt`), 'A'); execSync(`mkfifo "${T(`${W}/src-bad/pipe`)}"`);
  fs.mkdirSync(T(`${W}/dst-good`), { recursive: true }); fs.writeFileSync(T(`${W}/dst-good/keep.txt`), 'KEEP');
  const before = fs.readdirSync(`${s.DATA}/deleted`).length;
  r = await s.call('copy_item', { source: `${W}/src-bad`, destination: `${W}/dst-good`, overwrite: true });
  check('a copy that fails leaves the folder it would have replaced untouched, and nothing in the holding area', r.isError && fs.readFileSync(T(`${W}/dst-good/keep.txt`), 'utf8') === 'KEEP' && fs.readdirSync(T(`${W}/dst-good`)).length === 1 && fs.readdirSync(`${s.DATA}/deleted`).length === before && fs.readdirSync(`${s.DATA}/staging`).length === 0, r.text);
  await s.client.close();
}

fs.rmSync(T(W), { recursive: true, force: true }); fs.rmSync(T('Strongbox/secret plan.txt'), { force: true }); fs.rmSync(`${HOME}/Downloads/bigpack`, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
