// Self-check that runs ON THE USER'S COMPUTER.
// It starts a second copy of this connector pointed at a scratch folder inside the connector's own data folder,
// drives it through the same tools Claude uses, and checks the results. The second copy runs inside this same
// program, as a separate thread with its own settings: Claude's built-in runtime does not allow an extension to
// start itself again as a second program. Nothing in Tresorit is changed: the real
// Tresorit folder is only looked at (its top-level folders are listed) to confirm it can be read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Worker } from 'node:worker_threads';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { existsAsNamed } from './lib/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, 'preflight', 'samples');
const SCAN = path.join(HERE, 'ocr', 'selftest.pdf');
const FIXTURES = path.join(HERE, 'fixtures');
const FIXTURE_PASSWORD = 'Pf7-quartz-Lima-2291'; // opens fixtures/protected.pdf, a test file made for this check
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Connects to a copy of the connector running in a thread, over that thread's own input and output streams: the
// same line-by-line conversation the connector has with Claude.
class ThreadTransport {
  constructor(file, env) {
    this.file = file;
    this.env = env;
    this.buffer = new ReadBuffer();
    this.errTail = '';
    this.exited = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      try {
        this.worker = new Worker(this.file, { env: this.env, stdin: true, stdout: true, stderr: true, argv: [] });
      } catch (e) { reject(e); return; }
      const w = this.worker;
      w.stdout.on('data', (chunk) => {
        this.buffer.append(chunk);
        for (;;) {
          let msg;
          try { msg = this.buffer.readMessage(); } catch (e) { if (this.onerror) this.onerror(e); continue; }
          if (msg === null) break;
          if (this.onmessage) this.onmessage(msg);
        }
      });
      w.stderr.on('data', (chunk) => { this.errTail = (this.errTail + chunk.toString('utf8')).slice(-600); });
      w.once('online', () => done(resolve));
      w.on('error', (e) => { done(reject, e); if (this.onerror) this.onerror(e); });
      w.on('exit', () => {
        this.exited = true;
        done(reject, new Error(`the second copy stopped while starting. ${this.errTail}`));
        if (this.onclose) this.onclose();
      });
    });
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (!this.worker || this.exited) { reject(new Error(`the second copy is not running. ${this.errTail}`)); return; }
      this.worker.stdin.write(serializeMessage(message), (e) => (e ? reject(e) : resolve()));
    });
  }

  // Disconnects (which is the connector's signal to stop) and reports whether it stopped by itself.
  async close() {
    if (!this.worker || this.exited) return true;
    const w = this.worker;
    const gone = new Promise((resolve) => w.once('exit', () => resolve(true)));
    try { w.stdin.end(); } catch { /* ignore */ }
    const byItself = await Promise.race([gone, sleep(8000).then(() => false)]);
    if (!byItself) { try { await w.terminate(); } catch { /* ignore */ } }
    this.stoppedByItself = byItself;
    return byItself;
  }
}

export const markerFile = (dataDir) => path.join(dataDir, 'preflight-passed.json');

// The connector may change files only after this check has passed for this version, this computer and this folder.
export function preflightPassed(dataDir, version, root) {
  try {
    const m = JSON.parse(fs.readFileSync(markerFile(dataDir), 'utf8'));
    return m && m.version === version && m.root === root && m.host === os.hostname() && m.critical_failed === 0 ? m : null;
  } catch { return null; }
}

export async function runPreflight({ dataDir, realRoot, version, expectedTools, realHome, noIndex = [], blocked = [] }) {
  const started = Date.now();
  const results = [];
  const info = [];
  const add = (critical, label, pass, detail = '') => results.push({ critical, label, pass: Boolean(pass), detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 260) });
  // (Named after the time and after this copy: two copies of the connector, in two Claude windows, can be asked
  // within the same second, and each needs a scratch folder of its own.)
  const sandbox = path.join(dataDir, 'preflight', `${stampNow()}-${process.pid}`);
  const root = path.join(sandbox, 'Tresors');
  const data = path.join(sandbox, 'data');
  const outside = path.join(sandbox, 'outside');
  const T = 'Test Tresor A';
  let client = null;
  let protoErrors = 0;

  try {
    // ---- scratch folders and files ------------------------------------------------------------------------------
    for (const d of [path.join(root, T, 'Docs'), path.join(root, T, 'Case'), path.join(root, T, 'Work'), path.join(root, 'Blocked Zone'), outside]) fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(SAMPLES)) fs.copyFileSync(path.join(SAMPLES, f), path.join(root, T, 'Docs', f));
    fs.copyFileSync(SCAN, path.join(root, T, 'Docs', 'scan.pdf'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET-909');
    fs.writeFileSync(path.join(root, 'Blocked Zone', 'private.txt'), 'BLOCKED-SECRET-808');
    fs.writeFileSync(path.join(root, T, 'Work', 'notes.md'), 'Status: amber\nOwner: test\n');
    const nfdName = 'Relatório ação.txt'; // name stored in decomposed Unicode, as some programs write it
    fs.writeFileSync(path.join(root, T, 'Work', nfdName), 'unicode name content PF-NFD-505');
    let linkMade = true;
    try { fs.symlinkSync(outside, path.join(root, T, 'link-out')); } catch { linkMade = false; }
    // A stand-in for the rest of the Mac: a home folder with Downloads, Desktop, and places that must stay off limits.
    const home = path.join(sandbox, 'home');
    for (const d of ['Downloads/pack/sub', 'Downloads/pack/.hidden-inside', 'Desktop', 'Library/Keychains', '.secrets']) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, 'Downloads', 'incoming report.pdf'), `PF-INCOMING-808 ${crypto.randomBytes(24).toString('hex')}`);
    fs.writeFileSync(path.join(home, 'Downloads', 'to move.txt'), 'PF-MOVE-707');
    fs.writeFileSync(path.join(home, 'Downloads', 'pack', 'a.txt'), 'pack a');
    fs.writeFileSync(path.join(home, 'Downloads', 'pack', 'sub', 'b.txt'), 'pack b');
    fs.writeFileSync(path.join(home, 'Downloads', 'pack', '.hidden-inside', 'h.txt'), 'hidden');
    try { fs.symlinkSync(outside, path.join(home, 'Downloads', 'pack', 'link-out')); } catch { /* links not available */ }
    fs.mkdirSync(path.join(home, 'Downloads', 'pack', 'Tool.app', 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Downloads', 'pack', 'Tool.app', 'Contents', 'x'), 'app');
    fs.writeFileSync(path.join(home, 'Downloads', 'pack', 'old.keychain-db'), 'NESTED-KEYCHAIN');
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(home, 'Downloads', `rival ${i}.txt`), `rival content ${i}`);
    fs.writeFileSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'), 'KEYCHAIN-SECRET');
    fs.writeFileSync(path.join(home, '.secrets', 'key.txt'), 'HIDDEN-SECRET');
    // A blocked folder that sits INSIDE an ordinary folder, and a clean folder to move in from Downloads.
    for (const d of ['Guarded/Sealed', 'Guarded/Open', 'Work/Guarded', 'Work/Lander/Sealed']) fs.mkdirSync(path.join(root, T, d), { recursive: true });
    fs.writeFileSync(path.join(root, T, 'Guarded', 'Sealed', 's.txt'), 'SEALED-SECRET-313');
    fs.writeFileSync(path.join(root, T, 'Guarded', 'Open', 'o.txt'), 'guarded open PF-OPEN-414');
    fs.writeFileSync(path.join(root, T, 'Work', 'Guarded', 'x.txt'), 'PF-RIVAL-515');
    fs.writeFileSync(path.join(root, T, 'Work', 'Lander', 'Sealed', 'new.txt'), 'PF-LANDER-616');
    fs.mkdirSync(path.join(home, 'Downloads', 'clean pack', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Downloads', 'clean pack', 'inner', 'c.txt'), 'PF-CLEAN-717');
    fs.writeFileSync(path.join(home, 'Downloads', 'clean pack', '.DS_Store'), 'clutter');
    fs.mkdirSync(path.join(root, T, 'Vault'), { recursive: true });
    fs.writeFileSync(path.join(root, T, 'Vault', 'keys.txt'), 'vault words PF-VAULT-606');

    // What kind of disk is this? (Macs normally ignore capitals and accent encoding in names.)
    const ignoresCase = fs.existsSync(path.join(root, T.toUpperCase()));
    const ignoresAccentForm = fs.existsSync(path.join(root, T, 'Work', nfdName.normalize('NFC')));
    info.push(`Disk where the connector keeps its data: ${ignoresCase ? 'ignores' : 'distinguishes'} capital letters in names; ${ignoresAccentForm ? 'treats both accent encodings as the same name' : 'treats accent encodings as different names'}.`);

    // A stand-in for the connector's own confirmation window: it answers what confirm.txt says.
    const answerWindow = (a) => fs.writeFileSync(path.join(sandbox, 'confirm.txt'), a);
    answerWindow('yes'); // also asked before a whole folder is copied out
    fs.writeFileSync(path.join(sandbox, 'confirm.sh'), `a=$(cat "${path.join(sandbox, 'confirm.txt')}")\nif [ "$a" = yes ]; then printf '%s' "$3"; elif [ "$a" = no ]; then printf '%s' "$2"; else exit 1; fi\n`);
    answerWindow('yes');

    // ---- start a second copy of the connector on the scratch folder --------------------------------------------
    const env = { ...process.env, TRESORIT_ROOT: root, TRESORIT_DATA_DIR: data, TRESORIT_BLOCKED: `Blocked Zone; ${T}/Guarded/Sealed; ${T}/Future/Sealed; ${T}/Strasse/Geheim`, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PASSWORD_CMD: JSON.stringify(['/bin/sh', path.join(sandbox, 'pw.sh')]), TRESORIT_CONFIRM_CMD: JSON.stringify(['/bin/sh', path.join(sandbox, 'confirm.sh')]), TRESORIT_SYNC_LOG: path.join(sandbox, 'sync.log'), TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_PREFLIGHT_CHILD: '1', TRESORIT_OCR_WAIT_MS: '30000', TRESORIT_HOME_DIR: home, TRESORIT_IMPORT_ROOTS: home, TRESORIT_NO_INDEX: `${T}/Vault; ${T}/Shelf/Vault`, TRESORIT_PAUSE_ON_BATTERY: 'false', TRESORIT_HOLDING_DAYS: '30', TRESORIT_HOLDING_FIRST_MS: '500', TRESORIT_HOLDING_SWEEP_MS: '500' };
    const transport = new ThreadTransport(path.join(HERE, 'index.js'), env);
    client = new Client({ name: 'tresorit-preflight', version }, { capabilities: {} });
    client.onerror = () => { protoErrors++; };
    try {
      await client.connect(transport, { timeout: 30000 });
    } catch (e) {
      add(true, 'A second copy of the connector starts on this computer', false, `${e.message} ${transport.errTail}`);
      try { await transport.close(); } catch { /* ignore */ }
      client = null;
      throw new Error('stop');
    }
    const call = async (tool, args = {}, timeout = 45000) => {
      try {
        const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout });
        return { text: (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: Boolean(r.isError) };
      } catch (e) { return { text: `call failed: ${e.message}`, isError: true, crashed: true }; }
    };
    const exists = (rel) => fs.existsSync(path.join(root, rel));
    const readDisk = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };

    const tools = (await client.listTools()).tools.map((t) => t.name);
    add(true, 'The connector starts and offers all its tools', tools.length === expectedTools, `${tools.length} tools`);

    // ---- reading ------------------------------------------------------------------------------------------------
    let r = await call('list_folder', {});
    add(true, 'Lists the top level and hides the blocked folder', r.text.includes(T) && !r.text.includes('Blocked Zone'), r.text);
    const docs = `${T}/Docs`;
    for (const [file, marker, critical] of [['sample.docx', 'PF-DOCX-101', true], ['sample.xlsx', 'PF-XLSX-202', true], ['sample.pptx', 'PF-PPTX-303', true], ['sample.pdf', 'PF-PDF-404', true], ['sample.doc', 'PF-DOCX-101', true], ['sample.xls', 'PF-XLSX-202', true], ['sample.ppt', 'PF-PPTX-303', true]]) {
      r = await call('read_file', { path: `${docs}/${file}` });
      add(critical, `Reads ${path.extname(file)} files`, !r.isError && r.text.includes(marker), r.text.slice(-200));
    }
    r = await call('read_file', { path: `${docs}/sample.xlsx` });
    add(false, 'Shows spreadsheet dates as dates', r.text.includes('2026-10-03'), r.text.slice(-120));
    r = await call('read_file', { path: `${docs}/sample.docx` });
    add(true, 'Keeps accented characters intact', r.text.includes('Relatório de verificação, ação concluída'), r.text.slice(-160));

    // ---- staying inside the folder ------------------------------------------------------------------------------
    for (const [label, p] of [['a path that climbs out with ".."', `${T}/../../outside/secret.txt`], ['an absolute path elsewhere on the disk', path.join(outside, 'secret.txt')], ['a system path', '/etc/hosts']]) {
      r = await call('read_file', { path: p });
      add(true, `Refuses ${label}`, r.isError && !r.text.includes('OUTSIDE-SECRET-909') && !/localhost/.test(r.text), r.text);
    }
    if (linkMade) {
      r = await call('read_file', { path: `${T}/link-out/secret.txt` });
      add(true, 'Refuses to follow a link that leads outside the folder', r.isError && !r.text.includes('OUTSIDE-SECRET-909'), r.text);
      r = await call('write_file', { path: `${T}/link-out/planted.txt`, content: 'x' });
      add(true, 'Refuses to write through such a link', r.isError && !fs.existsSync(path.join(outside, 'planted.txt')), r.text);
      r = await call('list_folder', { path: T });
      add(true, 'Does not list such a link', !r.text.includes('link-out'), r.text);
    } else info.push('Links could not be created in the scratch folder, so the link tests were skipped.');
    r = await call('read_file', { path: 'Blocked Zone/private.txt' });
    add(true, 'Refuses a blocked folder', r.isError && !r.text.includes('BLOCKED-SECRET-808'), r.text);
    r = await call('read_file', { path: 'BLOCKED zone/PRIVATE.txt' });
    add(true, 'Refuses a blocked folder typed with different capitals', r.isError && !r.text.includes('BLOCKED-SECRET-808'), r.text);
    r = await call('search_contents', { query: 'BLOCKED-SECRET-808' });
    add(true, 'Search does not look inside a blocked folder', /^0 file/.test(r.text), r.text);
    // A blocked folder must be just as safe when the folder ABOVE it is named.
    {
      const sealed = () => readDisk(`${T}/Guarded/Sealed/s.txt`) === 'SEALED-SECRET-313';
      r = await call('copy_item', { source: `${T}/Guarded`, destination: `${T}/Guarded copy` });
      add(true, 'A copy of a folder leaves out a blocked folder inside it, and says so', !r.isError && readDisk(`${T}/Guarded copy/Open/o.txt`) === 'guarded open PF-OPEN-414' && !exists(`${T}/Guarded copy/Sealed`) && /Left out of the copy/.test(r.text) && sealed(), r.text);
      try { fs.rmSync(path.join(root, T, 'Guarded copy'), { recursive: true, force: true }); } catch { /* ignore */ }
      r = await call('export_to_transfer', { path: `${T}/Guarded` });
      const outCopy = path.join(data, 'transfer', 'Guarded');
      add(true, 'A copy out of Tresorit leaves out a blocked folder inside it', !r.isError && fs.existsSync(path.join(outCopy, 'Open', 'o.txt')) && !fs.existsSync(path.join(outCopy, 'Sealed')) && /Left out of the copy/.test(r.text), r.text);
      try { fs.rmSync(outCopy, { recursive: true, force: true }); } catch { /* ignore */ }
      r = await call('file_info', { path: `${T}/Guarded` });
      add(true, 'A blocked folder inside a folder is not counted into its size', !r.isError && /Contains: 1 file\(s\)/.test(r.text), r.text);
      r = await call('move_item', { source: `${T}/Guarded`, destination: `${T}/Guarded moved` });
      add(true, 'A folder with a blocked folder inside it cannot be moved or renamed', r.isError && sealed() && !exists(`${T}/Guarded moved`), r.text);
      r = await call('delete_items', { paths: [`${T}/Guarded`] });
      add(true, 'A folder with a blocked folder inside it cannot be deleted, not even previewed for deletion', r.isError && !/confirm_token "/.test(r.text) && sealed(), r.text);
      r = await call('move_item', { source: `${T}/Work/Guarded`, destination: T, overwrite: true });
      add(true, 'A folder with a blocked folder inside it cannot be replaced by another', r.isError && sealed() && readDisk(`${T}/Work/Guarded/x.txt`) === 'PF-RIVAL-515', r.text);
      r = await call('move_item', { source: `${T}/Work/Lander`, destination: `${T}/Future` });
      add(true, 'Nothing can be put where it would fill a blocked folder', r.isError && !exists(`${T}/Future`) && readDisk(`${T}/Work/Lander/Sealed/new.txt`) === 'PF-LANDER-616', r.text);
      // The same reach-through for a "do not index" folder: copying the folder above it is allowed, and the reply
      // says that the copy is no longer covered by the setting.
      fs.mkdirSync(path.join(root, T, 'Shelf', 'Vault'), { recursive: true });
      fs.writeFileSync(path.join(root, T, 'Shelf', 'Vault', 'k.txt'), 'shelf vault PF-SHELF-818');
      r = await call('copy_item', { source: `${T}/Shelf`, destination: `${T}/Shelf copy` });
      add(true, 'Copying a folder that has a "do not index" folder inside it says that the copy will be indexed', !r.isError && /do not index/.test(r.text) && r.text.includes(`${T}/Shelf copy/Vault`), r.text);
      try { fs.rmSync(path.join(root, T, 'Shelf copy'), { recursive: true, force: true }); fs.rmSync(path.join(root, T, 'Shelf'), { recursive: true, force: true }); } catch { /* ignore */ }
      r = await call('read_file', { path: `${T}/Guarded/Sealed/s.txt` });
      add(true, 'After all that the blocked folder is untouched and still refused', r.isError && !r.text.includes('SEALED-SECRET-313') && sealed(), r.text);
      // A Mac treats a few spellings as one name ("ß" and "ss", the long "ſ" and "s"). A blocked folder must be
      // protected under every spelling the Mac would accept for it. (The settings say "Strasse"; the disk has "Straße".)
      const geheimAt = `${T}/Straße/Geheim/g.txt`;
      fs.mkdirSync(path.join(root, T, 'Straße', 'Geheim'), { recursive: true });
      fs.mkdirSync(path.join(root, T, 'Straße', 'Offen'), { recursive: true });
      fs.writeFileSync(path.join(root, geheimAt), 'GEHEIM-SECRET-919');
      fs.writeFileSync(path.join(root, T, 'Straße', 'Offen', 'h.txt'), 'offen PF-OFFEN-929');
      const geheim = () => readDisk(geheimAt) === 'GEHEIM-SECRET-919';
      r = await call('read_file', { path: geheimAt });
      const r2 = await call('search_contents', { query: 'GEHEIM-SECRET-919' });
      add(true, 'A blocked folder is refused when its name on the disk is spelled in another way the Mac treats as the same ("ß" for "ss")', r.isError && !r.text.includes('GEHEIM-SECRET-919') && /^0 file/.test(r2.text) && geheim(), `${r.text} / ${r2.text}`);
      r = await call('copy_item', { source: `${T}/Straße`, destination: `${T}/Spelling copy` });
      add(true, 'A copy of the folder above it leaves such a blocked folder out', !r.isError && readDisk(`${T}/Spelling copy/Offen/h.txt`) === 'offen PF-OFFEN-929' && !exists(`${T}/Spelling copy/Geheim`) && /Left out of the copy/.test(r.text) && geheim(), r.text);
      r = await call('create_folder', { path: `${T}/Future/ſealed` });
      const madeIt = exists(`${T}/Future`);
      fs.mkdirSync(path.join(root, T, 'Work', 'Lander2', 'ſealed'), { recursive: true });
      fs.writeFileSync(path.join(root, T, 'Work', 'Lander2', 'ſealed', 'new.txt'), 'PF-LANDER-626');
      const r3 = await call('move_item', { source: `${T}/Work/Lander2`, destination: `${T}/Future` });
      add(true, 'Nothing can be created or put in the place of a blocked folder under such a spelling (the long "ſ" for "s")', r.isError && !madeIt && r3.isError && !exists(`${T}/Future`) && readDisk(`${T}/Work/Lander2/ſealed/new.txt`) === 'PF-LANDER-626', `${r.text} / ${r3.text}`);
      // (tidy up, so that these scratch files do not crowd the later checks)
      for (const d of ['Straße', 'Spelling copy', 'Future', 'Work/Lander2']) { try { fs.rmSync(path.join(root, T, d), { recursive: true, force: true }); } catch { /* ignore */ } }
    }

    // ---- writing ------------------------------------------------------------------------------------------------
    const W = `${T}/Work`;
    r = await call('write_file', { path: `${W}/new/first.txt`, content: 'version one' });
    add(true, 'Saves a new file (creating its folder)', !r.isError && readDisk(`${W}/new/first.txt`) === 'version one', r.text);
    r = await call('write_file', { path: `${W}/new/first.txt`, content: 'clobber' });
    add(true, 'Does not overwrite unless told to', r.isError && readDisk(`${W}/new/first.txt`) === 'version one', r.text);
    r = await call('write_file', { path: `${W}/new/first.txt`, content: 'version two', overwrite: true });
    const rb = (r.text.match(/batch (\S+_replaced_\w+)/) || [])[1];
    const heldOld = rb ? (() => { try { return fs.readFileSync(path.join(data, 'deleted', rb, 'files', ...`${W}/new/first.txt`.split('/')), 'utf8'); } catch { return null; } })() : null;
    add(true, 'When overwriting, keeps the previous version in the holding area', !r.isError && readDisk(`${W}/new/first.txt`) === 'version two' && heldOld === 'version one', r.text);
    r = await call('edit_file', { path: `${W}/notes.md`, old_text: 'Status: amber', new_text: 'Status: green' });
    add(true, 'Edits a text file', !r.isError && readDisk(`${W}/notes.md`) === 'Status: green\nOwner: test\n', r.text);
    r = await call('write_file', { path: 'loose.txt', content: 'x' });
    add(true, 'Refuses to write at the top level, beside the tresors', r.isError && !exists('loose.txt'), r.text);

    // ---- capital letters in names -------------------------------------------------------------------------------
    const C = `${T}/Case`;
    await call('write_file', { path: `${C}/Report.txt`, content: 'case content 1' });
    r = await call('read_file', { path: `${T.toLowerCase()}/case/REPORT.TXT` });
    if (ignoresCase) {
      add(true, 'Finds a file when its name is typed with different capitals', !r.isError && r.text.includes('case content 1'), r.text);
      add(false, 'Reports that file under its true name', r.text.includes(`${C}/Report.txt`), r.text.slice(0, 120));
    }
    else add(false, 'This disk distinguishes capitals: a differently typed name is simply not found', r.isError, r.text);
    r = await call('write_file', { path: `${C}/REPORT.TXT`, content: 'second' });
    if (ignoresCase) add(true, 'Does not let "REPORT.TXT" silently replace "Report.txt"', r.isError && readDisk(`${C}/Report.txt`) === 'case content 1', r.text);
    else { add(false, 'This disk distinguishes capitals: "REPORT.TXT" is a separate file', !r.isError, r.text); await call('move_item', { source: `${C}/REPORT.TXT`, destination: `${C}/other.txt` }); }
    r = await call('move_item', { source: `${C}/Report.txt`, destination: `${C}/report.txt` });
    const names = fs.readdirSync(path.join(root, C));
    add(true, 'Renames a file when only the capitals change, without losing it', !r.isError && names.includes('report.txt') && !names.includes('Report.txt') && readDisk(`${C}/report.txt`) === 'case content 1', `${r.text} | folder now: ${names.join(', ')}`);

    // ---- accented names -----------------------------------------------------------------------------------------
    r = await call('find_files', { query: 'relatorio acao' });
    const found = (r.text.match(/\[FILE\] (.*?\.txt)/) || [])[1];
    add(true, 'Finds a file with accents in its name from an unaccented query', Boolean(found) && found.normalize('NFC').includes('Relatório ação.txt'), r.text);
    r = await call('read_file', { path: found || 'missing' });
    add(true, 'Reads it through the path the search returned', !r.isError && r.text.includes('PF-NFD-505'), r.text);
    r = await call('read_file', { path: `${W}/${nfdName.normalize('NFC')}` });
    if (ignoresAccentForm) add(true, 'Reads it when the name is typed in the other accent encoding', !r.isError && r.text.includes('PF-NFD-505'), r.text);
    else add(false, 'This disk treats the two accent encodings as different names', true, r.text.slice(0, 80));

    // ---- written through to the disk before a file is replaced -----------------------------------------------------
    // (So that a power cut at that instant leaves the old version or the new one, complete. The second copy of the
    // connector notes each such write in a file, which is read here.)
    {
      const flushed = () => { try { return fs.readFileSync(path.join(sandbox, 'sync.log'), 'utf8'); } catch { return ''; } };
      const from = flushed().length;
      const f = `${W}/flush test.txt`;
      const a = await call('write_file', { path: f, content: 'one' });
      const b = await call('write_file', { path: f, content: 'two', overwrite: true });
      const c = await call('edit_file', { path: f, old_text: 'two', new_text: 'three' });
      const lines = flushed().slice(from).split('\n');
      const files = lines.filter((l) => l.startsWith('file\t') && l.endsWith('/flush test.txt')).length;
      const folders = lines.filter((l) => l.startsWith('dir\t') && l.endsWith(`/${W}`)).length;
      const records = lines.filter((l) => l.startsWith('file\t') && /manifest\.json\.\d+\.tmp$/.test(l)).length;
      add(true, 'A new, replaced or edited file is written through to the disk before it is put in place (power-cut safety)', !a.isError && !b.isError && !c.isError && readDisk(f) === 'three' && files >= 3 && folders >= 3, `${files} file write(s), ${folders} folder write(s) noted`);
      add(true, 'The record of a batch in the holding area is written through to the disk too', records >= 1, `${records} record write(s) noted`);
      try { fs.rmSync(path.join(root, f), { force: true }); } catch { /* ignore */ }
    }

    // ---- copy, move, delete, restore ----------------------------------------------------------------------------
    r = await call('copy_item', { source: docs, destination: `${T}/Docs copy` });
    add(true, 'Copies a folder completely', !r.isError && fs.readdirSync(path.join(root, T, 'Docs copy')).length === fs.readdirSync(path.join(root, docs)).length, r.text);
    r = await call('move_item', { source: `${T}/Docs copy/sample.pdf`, destination: `${W}/moved.pdf` });
    add(true, 'Moves a file between folders', !r.isError && exists(`${W}/moved.pdf`) && !exists(`${T}/Docs copy/sample.pdf`), r.text);
    r = await call('delete_items', { paths: [`${T}/Docs copy`] });
    const token = (r.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
    add(true, 'A delete request only previews: nothing is removed', /NOTHING HAS BEEN DELETED/.test(r.text) && exists(`${T}/Docs copy`) && Boolean(token), r.text);
    r = await call('delete_items', { paths: [`${T}/Docs copy`], confirm_token: 'deadbeef' });
    add(true, 'A wrong confirmation code deletes nothing', r.isError && exists(`${T}/Docs copy`), r.text);
    r = await call('delete_items', { paths: [`${T}/Docs copy`], confirm_token: token });
    const batch = (r.text.match(/batch (\S+_deleted_\w+)/) || [])[1];
    const heldDir = batch ? path.join(data, 'deleted', batch, 'files', T, 'Docs copy') : '';
    add(true, 'With the right code the item goes to the holding area, outside the folder', !r.isError && !exists(`${T}/Docs copy`) && Boolean(batch) && fs.existsSync(path.join(heldDir, 'sample.docx')), r.text);
    r = await call('restore_deleted', { batch: batch || 'none' });
    add(true, 'Restores it from the holding area', exists(`${T}/Docs copy/sample.docx`) && !fs.existsSync(heldDir), r.text);
    // The connector's own confirmation window (used where the app shows no box of its own): only a yes there deletes.
    {
      const ask = async () => ((await call('delete_items', { paths: [`${T}/Docs copy`] })).text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
      answerWindow('no');
      r = await call('delete_items', { paths: [`${T}/Docs copy`], confirm_token: await ask() });
      add(true, 'With the right code but "Keep" chosen in the connector\'s own confirmation window, nothing is deleted', r.isError && /Keep/.test(r.text) && exists(`${T}/Docs copy/sample.docx`), r.text);
      answerWindow('');
      r = await call('delete_items', { paths: [`${T}/Docs copy`], confirm_token: await ask() });
      add(true, 'A confirmation window that is closed, left unanswered or cannot be shown deletes nothing', r.isError && /not answered/.test(r.text) && exists(`${T}/Docs copy/sample.docx`), r.text);
      answerWindow('yes');
      const lg = await call('access_log', { lines: 40, contains: 'DEL-NO' });
      add(false, 'Both refusals are written to the access log', (lg.text.match(/DEL-NO/g) || []).length >= 2, lg.text.slice(-300));
    }
    // The same window before a whole folder leaves Tresorit: only a yes there copies it out.
    {
      const waiting = () => (fs.existsSync(path.join(data, 'transfer')) ? fs.readdirSync(path.join(data, 'transfer')).length : 0);
      const had = waiting();
      answerWindow('no');
      const declined = await call('export_to_transfer', { path: `${T}/Docs copy` });
      answerWindow('');
      const unanswered = await call('export_to_transfer', { path: `${T}/Docs copy` });
      answerWindow('yes');
      add(true, 'A whole folder is copied out of Tresorit only after a yes in the confirmation window: "Do not copy", or no answer, copies nothing', declined.isError && /Do not copy/.test(declined.text) && unanswered.isError && /not answered/.test(unanswered.text) && waiting() === had, `${declined.text} / ${unanswered.text}`);
    }
    // Restoring part of a batch: the record of what is left is replaced whole, never written over in place (an
    // interruption while writing over it could damage the record and hide the rest of the batch).
    {
      const two = [`${W}/record a.txt`, `${W}/record b.txt`];
      for (const p of two) fs.writeFileSync(path.join(root, p), `content of ${p}`);
      const pv = await call('delete_items', { paths: two });
      r = await call('delete_items', { paths: two, confirm_token: (pv.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1] });
      const bn = (r.text.match(/batch (\S+_deleted_\w+)/) || [])[1] || 'none';
      const rec = path.join(data, 'deleted', bn, 'manifest.json');
      let inoBefore = 0; try { inoBefore = fs.statSync(rec).ino; } catch { /* reported below */ }
      r = await call('restore_deleted', { batch: bn, item: two[0] });
      let left = null; let inoAfter = 0; let strays = [];
      try { left = JSON.parse(fs.readFileSync(rec, 'utf8')).items.map((i) => i.original); inoAfter = fs.statSync(rec).ino; strays = fs.readdirSync(path.dirname(rec)).filter((x) => x.endsWith('.tmp')); } catch { /* reported below */ }
      add(true, 'After part of a batch is restored, its record is replaced whole (not written over in place) and lists what is left', !r.isError && exists(two[0]) && !exists(two[1]) && Array.isArray(left) && left.length === 1 && left[0] === two[1] && inoBefore > 0 && inoAfter > 0 && inoAfter !== inoBefore && strays.length === 0, `${r.text} | left: ${JSON.stringify(left)} | record ${inoAfter !== inoBefore ? 'replaced' : 'written over in place'}`);
      r = await call('restore_deleted', { batch: bn });
      add(true, 'The rest of that batch can still be restored', !r.isError && exists(two[1]), r.text);
      for (const p of two) { try { fs.rmSync(path.join(root, p), { force: true }); } catch { /* ignore */ } }
    }
    r = await call('delete_items', { paths: [T] });
    add(true, 'Refuses to delete a whole tresor', r.isError && exists(T), r.text);

    // A copy that fails half-way must leave nothing behind (uses a special file that cannot be copied).
    let fifo = false;
    try { fs.mkdirSync(path.join(root, T, 'Pipes')); fs.writeFileSync(path.join(root, T, 'Pipes', 'a.txt'), 'a'); execFileSync('mkfifo', [path.join(root, T, 'Pipes', 'zz-pipe')], { stdio: 'ignore', timeout: 5000 }); fifo = true; } catch { fifo = false; }
    if (fifo) {
      r = await call('copy_item', { source: `${T}/Pipes`, destination: `${T}/Pipes copy` });
      add(true, 'A copy that fails half-way leaves no partial folder behind', r.isError && !exists(`${T}/Pipes copy`) && exists(`${T}/Pipes/a.txt`), r.text);
    }

    // ---- transfer folder ----------------------------------------------------------------------------------------
    r = await call('export_to_transfer', { path: `${docs}/sample.docx` });
    add(true, 'Copies a file out to the transfer folder', !r.isError && fs.existsSync(path.join(data, 'transfer', 'sample.docx')) && exists(`${docs}/sample.docx`), r.text);
    fs.writeFileSync(path.join(data, 'transfer', 'incoming.txt'), 'brought in');
    r = await call('import_from_transfer', { name: 'incoming.txt', destination: W });
    add(true, 'Brings a file in from the transfer folder', !r.isError && readDisk(`${W}/incoming.txt`) === 'brought in', r.text);

    // ---- bringing files in from the rest of the Mac, and copies out ----------------------------------------------
    const dl = path.join(home, 'Downloads');
    r = await call('list_outside_folder', {});
    add(true, 'Lists the names in Downloads without opening anything', !r.isError && r.text.includes('incoming report.pdf') && !/PF-INCOMING-808|PF-MOVE-707/.test(r.text), r.text);
    r = await call('import_file', { source: 'incoming report', destination: W });
    add(true, 'Brings a file in from Downloads by its name, checked against the original', !r.isError && exists(`${W}/incoming report.pdf`) && fs.existsSync(path.join(dl, 'incoming report.pdf')) && /checked against the original/.test(r.text), r.text);
    r = await call('import_file', { source: path.join(dl, 'incoming report.pdf'), destination: W });
    add(true, 'Does not bring the same file in twice', !r.isError && /identical/.test(r.text) && !exists(`${W}/incoming report (2).pdf`), r.text);
    const refusals = [];
    // (The same protected places are also asked for in other capitals: on a Mac disk, which ignores capitals,
    // those are the very same files and must be refused just the same.)
    for (const src of [path.join(home, 'Library', 'Keychains', 'login.keychain-db'), path.join(home, '.secrets', 'key.txt'), path.join(outside, 'secret.txt'), path.join(root, T, 'Work', 'notes.md'), path.join(data, 'logs'), '/etc/hosts',
      path.join(home, 'LIBRARY', 'keychains', 'LOGIN.KEYCHAIN-DB'), path.join(home, 'library', 'Keychains', 'login.keychain-db'), path.join(home, '.SECRETS', 'KEY.TXT'), path.join(root.toUpperCase(), T, 'Work', 'notes.md'), path.join(data.toUpperCase(), 'logs'), home]) {
      const x = await call('import_file', { source: src, destination: `${W}/must-not-arrive` });
      if (!x.isError || exists(`${W}/must-not-arrive`)) refusals.push(src);
    }
    add(true, 'Refuses key stores, hidden folders, system files and anything outside the home folder', refusals.length === 0, `not refused: ${refusals.join(', ')}`);
    {
      const there = await call('import_file', { source: path.join(home, '.secrets', 'key.txt'), destination: `${W}/must-not-arrive` });
      const absent = await call('import_file', { source: path.join(home, '.secrets', 'none.txt'), destination: `${W}/must-not-arrive` });
      const there2 = await call('list_outside_folder', { path: path.join(home, 'Library', 'Keychains') });
      const absent2 = await call('list_outside_folder', { path: path.join(home, 'Library', 'Nothing Here') });
      const same = there.isError && absent.isError && there.text.split('key.txt').join('X') === absent.text.split('none.txt').join('X') && there2.isError && absent2.isError && there2.text.split('Keychains').join('X') === absent2.text.split('Nothing Here').join('X');
      add(true, 'A refusal reads the same whether or not the item exists in the protected place', same, `${there.text} | ${absent.text} | ${there2.text} | ${absent2.text}`);
    }
    r = await call('import_file', { source: path.join(dl, 'pack'), destination: W });
    const itoken = (r.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
    add(true, 'A whole folder is only previewed first: nothing is copied', /NOTHING HAS BEEN COPIED/.test(r.text) && !exists(`${W}/pack`) && Boolean(itoken), r.text);
    r = await call('import_file', { source: path.join(dl, 'pack'), destination: W, confirm_token: itoken });
    add(true, 'After agreement the folder comes in, without hidden items, links, applications or key stores', !r.isError && readDisk(`${W}/pack/sub/b.txt`) === 'pack b' && !exists(`${W}/pack/.hidden-inside`) && !exists(`${W}/pack/link-out`) && !exists(`${W}/pack/Tool.app`) && !exists(`${W}/pack/old.keychain-db`), r.text);
    // Claude often sends several requests at once. Two changes aimed at the same place must not overwrite each other.
    let rivals = await Promise.all([0, 1, 2, 3, 4].map((i) => call('import_file', { source: path.join(dl, `rival ${i}.txt`), destination: `${W}/one name.txt` })));
    const won = rivals.filter((x) => !x.isError).length;
    const winner = readDisk(`${W}/one name.txt`) || '';
    add(true, 'Five files brought in to the same name at the same moment: one arrives, the rest are refused', won === 1 && /^rival content \d$/.test(winner), rivals.map((x) => x.text.slice(0, 60)).join(' | '));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, W, `mover ${i}.txt`), `mover ${i}`);
    rivals = await Promise.all([0, 1, 2, 3, 4].map((i) => call('move_item', { source: `${W}/mover ${i}.txt`, destination: `${W}/moved to one name.txt` })));
    const left = [0, 1, 2, 3, 4].filter((i) => exists(`${W}/mover ${i}.txt`)).length;
    add(true, 'Five files moved to the same name at the same moment: one moves, four stay where they were', rivals.filter((x) => !x.isError).length === 1 && left === 4, `${rivals.filter((x) => !x.isError).length} moved, ${left} left`);
    // Claude runs several copies of the connector at once (one per window). They must wait for each other.
    fs.writeFileSync(path.join(data, 'change.lock'), JSON.stringify({ id: 'stopped.copy', pid: 2147483600, what: 'left behind', since: 1 }));
    r = await call('write_file', { path: `${W}/after a stopped copy.txt`, content: 'not held up' });
    add(true, 'A lock left behind by a copy of the connector that has stopped does not hold up changes', !r.isError && !fs.existsSync(path.join(data, 'change.lock')), r.text);
    {
      const transport2 = new ThreadTransport(path.join(HERE, 'index.js'), env);
      const client2 = new Client({ name: 'tresorit-preflight-2', version }, { capabilities: {} });
      client2.onerror = () => { protoErrors++; };
      let twoOk = false; let twoDetail = '';
      try {
        await client2.connect(transport2, { timeout: 30000 });
        const call2 = async (tool, args = {}) => {
          try { const x = await client2.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 45000 }); return { text: (x.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: Boolean(x.isError) }; } catch (e) { return { text: `call failed: ${e.message}`, isError: true }; }
        };
        let clean = 0; const ROUNDS = 8;
        for (let k = 0; k < ROUNDS; k++) {
          for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(root, W, `window ${k}-${i}.txt`), `window ${k}-${i}`);
          const both = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => (i % 2 ? call : call2)('move_item', { source: `${W}/window ${k}-${i}.txt`, destination: `${W}/from two windows ${k}.txt` })));
          const stay = [0, 1, 2, 3, 4, 5].filter((i) => exists(`${W}/window ${k}-${i}.txt`)).length;
          if (both.filter((x) => !x.isError).length === 1 && stay === 5) clean++;
        }
        twoOk = clean === ROUNDS && !fs.existsSync(path.join(data, 'change.lock')); twoDetail = `${clean} of ${ROUNDS} rounds clean`;
        // (tidy up, so that these scratch files do not crowd the later checks)
        for (const f of fs.readdirSync(path.join(root, W))) if (/^(window \d+-\d+|from two windows \d+)\.txt$/.test(f)) fs.rmSync(path.join(root, W, f), { force: true });
      } catch (e) { twoDetail = `${e.message} ${transport2.errTail || ''}`; }
      try { await client2.close(); } catch { /* ignore */ }
      add(true, 'Two copies of the connector moving files to the same name at the same moment: one moves, the rest stay', twoOk, twoDetail);
    }
    r = await call('import_file', { source: path.join(dl, 'to move.txt'), destination: W, mode: 'move' });
    const mbatch = (r.text.match(/batch (\S+_imported_\w+)/) || [])[1];
    add(true, 'A move takes the original away only after the copy is checked, and keeps it in the holding area', !r.isError && readDisk(`${W}/to move.txt`) === 'PF-MOVE-707' && !fs.existsSync(path.join(dl, 'to move.txt')) && Boolean(mbatch), r.text);
    r = await call('restore_deleted', { batch: mbatch || 'none' });
    add(true, 'The original of a moved file can be put back where it was', !r.isError && fs.existsSync(path.join(dl, 'to move.txt')) && fs.readFileSync(path.join(dl, 'to move.txt'), 'utf8') === 'PF-MOVE-707', r.text);
    // A folder holding things that are never brought in must not be MOVED: they would be left only in the holding area.
    {
      const packFiles = () => ['a.txt', 'sub/b.txt', '.hidden-inside/h.txt', 'old.keychain-db', 'Tool.app/Contents/x'].every((f) => fs.existsSync(path.join(dl, 'pack', f)));
      const batchesBefore = fs.existsSync(path.join(data, 'deleted')) ? fs.readdirSync(path.join(data, 'deleted')).length : 0;
      r = await call('import_file', { source: path.join(dl, 'pack'), destination: `${T}/Case`, mode: 'move' });
      const batchesAfter = fs.existsSync(path.join(data, 'deleted')) ? fs.readdirSync(path.join(data, 'deleted')).length : 0;
      add(true, 'A folder holding hidden items or key stores is not moved in: nothing is taken away, and the reply names them', r.isError && /Nothing was moved/.test(r.text) && r.text.includes('.hidden-inside') && r.text.includes('old.keychain-db') && !/confirm_token "/.test(r.text) && packFiles() && !exists(`${T}/Case/pack`) && batchesAfter === batchesBefore, r.text);
      r = await call('import_file', { source: path.join(dl, 'clean pack'), destination: `${T}/Case`, mode: 'move' });
      const ctoken = (r.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
      r = await call('import_file', { source: path.join(dl, 'clean pack'), destination: `${T}/Case`, mode: 'move', confirm_token: ctoken || 'none' });
      const cbatch = (r.text.match(/batch (\S+_imported_\w+)/) || [])[1];
      add(true, 'A folder with nothing but documents (and system clutter) is moved in, and its original is kept in the holding area', !r.isError && readDisk(`${T}/Case/clean pack/inner/c.txt`) === 'PF-CLEAN-717' && !exists(`${T}/Case/clean pack/.DS_Store`) && !fs.existsSync(path.join(dl, 'clean pack')) && Boolean(cbatch), r.text);
      r = await call('restore_deleted', { batch: cbatch || 'none' });
      add(true, 'The original of a moved folder can be put back where it was', !r.isError && fs.existsSync(path.join(dl, 'clean pack', 'inner', 'c.txt')), r.text);
    }
    fs.writeFileSync(path.join(home, 'Desktop', 'notes.md'), 'ALREADY-HERE');
    r = await call('export_file', { path: `${W}/notes.md`, to: 'Desktop' });
    add(true, 'Copies a file out to Desktop without overwriting what is there', !r.isError && fs.readFileSync(path.join(home, 'Desktop', 'notes.md'), 'utf8') === 'ALREADY-HERE' && fs.existsSync(path.join(home, 'Desktop', 'notes (2).md')) && exists(`${W}/notes.md`), r.text);

    // ---- a document made in the conversation, received in parts ------------------------------------------------
    const made = crypto.randomBytes(7000);
    const hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const pieces = [made.subarray(0, 3000), made.subarray(3000, 6000), made.subarray(6000)];
    let recv = await call('receive_file', { path: `${W}/made.bin`, part: 1, parts: 3, data: pieces[0].toString('base64'), part_sha256: hex(pieces[0]) });
    const damaged = Buffer.from(pieces[1]); damaged[10] ^= 0xff;
    const bad = await call('receive_file', { path: `${W}/made.bin`, part: 2, parts: 3, data: damaged.toString('base64'), part_sha256: hex(pieces[1]) });
    add(true, 'A part of a file that arrives damaged is noticed and refused', !recv.isError && bad.isError && !exists(`${W}/made.bin`), bad.text);
    recv = await call('receive_file', { path: `${W}/made.bin`, part: 2, parts: 3, data: pieces[1].toString('base64'), part_sha256: hex(pieces[1]) });
    recv = await call('receive_file', { path: `${W}/made.bin`, part: 3, parts: 3, data: pieces[2].toString('base64'), part_sha256: hex(pieces[2]), file_sha256: hex(made) });
    let same = false;
    try { same = Buffer.compare(fs.readFileSync(path.join(root, W, 'made.bin')), made) === 0; } catch { same = false; }
    add(true, 'A file received in parts is saved exactly as it was sent', !recv.isError && same, recv.text);

    // ---- a folder set as "do not index" ---------------------------------------------------------------------------
    r = await call('search_contents', { query: 'PF-VAULT-606' });
    const indexDir = path.join(data, 'index', 'text');
    let leaked = false;
    try { for (const f of fs.readdirSync(indexDir)) if (fs.readFileSync(path.join(indexDir, f), 'utf8').toLowerCase().includes('pf-vault-606')) leaked = true; } catch { /* no index yet */ }
    add(true, 'A "do not index" folder is left out of searches and of the search index', /^0 file/.test(r.text) && /do not index/.test(r.text) && !leaked, r.text);
    r = await call('read_file', { path: `${T}/Vault/keys.txt` });
    add(true, '...and its files can still be read when asked for by name', !r.isError && r.text.includes('PF-VAULT-606'), r.text);

    // ---- emptying the holding area --------------------------------------------------------------------------------
    const heldBefore = fs.readdirSync(path.join(data, 'deleted')).length;
    r = await call('clear_deleted', { older_than_days: 0 });
    const ctoken = (r.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
    const wrong = await call('clear_deleted', { older_than_days: 0, confirm_token: 'deadbeef' });
    add(true, 'Emptying the holding area only previews, and a wrong code removes nothing', /NOTHING HAS BEEN REMOVED/.test(r.text) && wrong.isError && heldBefore > 0 && fs.readdirSync(path.join(data, 'deleted')).length === heldBefore, r.text);
    answerWindow('no');
    r = await call('clear_deleted', { older_than_days: 0, confirm_token: ctoken });
    add(true, 'With the right code but "Keep" chosen in the confirmation window, the holding area is not emptied', r.isError && fs.readdirSync(path.join(data, 'deleted')).length === heldBefore, r.text);
    answerWindow('yes');
    r = await call('clear_deleted', { older_than_days: 0 });
    r = await call('clear_deleted', { older_than_days: 0, confirm_token: (r.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1] });
    add(true, 'With the right code the old batches are removed', !r.isError && fs.readdirSync(path.join(data, 'deleted')).length === 0, r.text);

    // ---- the holding area clears itself: batches older than the number of days in the settings, and only those ---------
    {
      const hold = path.join(data, 'deleted'); const made = {};
      for (const which of ['old', 'recent']) {
        await call('write_file', { path: `${T}/Work/expire-${which}.txt`, content: `PF-EXPIRE-${which}` });
        const pv = await call('delete_items', { paths: [`${T}/Work/expire-${which}.txt`] });
        await call('delete_items', { paths: [`${T}/Work/expire-${which}.txt`], confirm_token: (pv.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1] });
        made[which] = fs.readdirSync(hold).find((n) => { try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(hold, n, 'manifest.json'), 'utf8')).items).includes(`expire-${which}.txt`); } catch { return false; } });
      }
      const both = Boolean(made.old && made.recent && made.old !== made.recent);
      await sleep(1300); // several looks by the automatic clearing: nothing here is old yet
      const untouched = both && fs.existsSync(path.join(hold, made.old)) && fs.existsSync(path.join(hold, made.recent));
      const backdate = (name, days) => { const f = path.join(hold, name, 'manifest.json'); const m = JSON.parse(fs.readFileSync(f, 'utf8')); const d = new Date(Date.now() - days * 86_400_000); const p2 = (n) => String(n).padStart(2, '0'); m.when = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; fs.writeFileSync(f, JSON.stringify(m)); };
      if (both) { backdate(made.old, 31); backdate(made.recent, 29); }
      let gone = false; for (let i = 0; i < 40 && both && !gone; i++) { await sleep(150); gone = !fs.existsSync(path.join(hold, made.old)); }
      await sleep(700);
      const kept = both && fs.existsSync(path.join(hold, made.recent, 'files'));
      const lg = await call('access_log', { lines: 100, contains: 'PURGE' });
      const logged = both && new RegExp(`\\| PURGE\\s+\\| ${made.old} \\| removed from the holding area automatically: older than 30 day`).test(lg.text) && !new RegExp(`\\| PURGE\\s+\\| ${made.recent} `).test(lg.text);
      const back = await call('restore_deleted', { batch: made.recent });
      add(true, 'The holding area clears itself: a batch older than 30 days is removed automatically and logged, a batch of 29 days is kept and can be restored', untouched && gone && kept && logged && !back.isError && fs.existsSync(path.join(root, T, 'Work', 'expire-recent.txt')), `made ${JSON.stringify(made)} untouched ${untouched} gone ${gone} kept ${kept} logged ${logged} restore: ${back.text.slice(0, 120)}`);
      await call('delete_items', { paths: [`${T}/Work/expire-recent.txt`] }).then((pv) => call('delete_items', { paths: [`${T}/Work/expire-recent.txt`], confirm_token: (pv.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1] })).catch(() => {});
    }

    // ---- searching ----------------------------------------------------------------------------------------------
    // ---- reading by content, unreadable files, passwords ------------------------------------------------------------
    {
      const C = `${T}/Case`;
      fs.copyFileSync(path.join(FIXTURES, 'page.png'), path.join(root, C, 'photo of a page.pdf'));
      fs.copyFileSync(path.join(SAMPLES, 'sample.pdf'), path.join(root, C, 'really a pdf.docx'));
      fs.copyFileSync(path.join(FIXTURES, 'protected.pdf'), path.join(root, C, 'statement.pdf'));
      fs.writeFileSync(path.join(root, C, 'empty.pdf'), '');
      fs.writeFileSync(path.join(root, C, 'cut off.pdf'), fs.readFileSync(path.join(SAMPLES, 'sample.pdf')).subarray(0, 300));
      fs.writeFileSync(path.join(sandbox, 'pw.sh'), `cat "${path.join(sandbox, 'pw.txt')}"\n`);
      r = await call('read_file', { path: `${C}/really a pdf.docx` });
      add(true, 'A PDF saved with the ending .docx is read as the PDF it is', !r.isError && r.text.includes('PF-PDF-404') && /PDF saved as \.docx/.test(r.text), r.text);
      r = await call('read_file', { path: `${C}/photo of a page.pdf` }, 150000);
      add(false, 'A picture saved with the ending .pdf is read by text recognition', !r.isError && /48213/.test(r.text), r.text);
      for (const f of ['empty.pdf', 'cut off.pdf']) await call('read_file', { path: `${C}/${f}` });
      r = await call('read_file', { path: `${C}/statement.pdf` });
      add(true, 'A password-protected PDF is not opened without a password, and the reply says how to open it', r.isError && /password-protected/.test(r.text) && /ask_password/.test(r.text) && !r.text.includes('PF-LOCKED-4471'), r.text);
      r = await call('list_unreadable', { path: C });
      const st1 = await call('connector_status');
      add(true, 'The list of unreadable files gives each one with its reason, and agrees with the status report',
        !r.isError && /3 of \d+ document\(s\)/.test(r.text) && /1\s+password-protected/.test(r.text) && /1\s+damaged/.test(r.text) && /1\s+empty/.test(r.text)
        && /\[password-protected\] .*statement\.pdf/.test(r.text) && /\[damaged\] .*cut off\.pdf/.test(r.text) && /\[empty \(0 bytes\)\] .*empty\.pdf/.test(r.text)
        && /Unreadable by reason: 1 password-protected, 1 damaged, 1 empty,/.test(st1.text), `${r.text} | ${(st1.text.match(/Unreadable by reason[^\n]*/) || [''])[0]}`);
      r = await call('list_unreadable', { path: C, reason: 'wrong_ending' });
      add(true, 'Files whose ending does not match their content are listed, with what they really are', !r.isError && /really a pdf\.docx.*PDF saved as \.docx/.test(r.text) && /photo of a page\.pdf.*PNG image saved as \.pdf/.test(r.text), r.text);
      fs.writeFileSync(path.join(sandbox, 'pw.txt'), 'not-the-password');
      r = await call('read_file', { path: `${C}/statement.pdf`, ask_password: true });
      add(true, 'A wrong password is refused and nothing is read', r.isError && /does not open/.test(r.text) && !r.text.includes('PF-LOCKED-4471'), r.text);
      fs.writeFileSync(path.join(sandbox, 'pw.txt'), FIXTURE_PASSWORD);
      r = await call('read_file', { path: `${C}/statement.pdf`, ask_password: true });
      const once = await call('search_contents', { query: 'PF-LOCKED-4471', path: C });
      add(true, 'With the right password, typed on the Mac, the PDF is read once and its text is not kept', !r.isError && r.text.includes('PF-LOCKED-4471') && !once.text.includes('statement.pdf'), `${r.text} | ${once.text}`);
      r = await call('unlock_folder', { path: C });
      const found = await call('search_contents', { query: 'PF-LOCKED-4471', path: C });
      add(true, 'A folder of protected PDFs is made searchable with one password, without changing the files', !r.isError && /1 of 1 password-protected PDF\(s\)/.test(r.text) && found.text.includes('statement.pdf')
        && fs.readFileSync(path.join(root, C, 'statement.pdf')).equals(fs.readFileSync(path.join(FIXTURES, 'protected.pdf'))), `${r.text} | ${found.text}`);
      try { fs.rmSync(path.join(sandbox, 'pw.txt'), { force: true }); fs.rmSync(path.join(sandbox, 'pw.sh'), { force: true }); } catch { /* ignore */ }
      await sleep(5500); // the index is written to disk a few seconds after a change
      const holds = (dir) => { let hit = ''; const visit = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const pth = path.join(d, e.name); if (e.isDirectory()) visit(pth); else if (!hit && fs.readFileSync(pth).includes(FIXTURE_PASSWORD)) hit = pth; } }; try { visit(dir); } catch { /* ignore */ } return hit; };
      const leak = holds(data);
      add(true, 'The password is in no file the connector keeps: not the access log, not the index, not anywhere in its data folder', leak === '', `found in ${leak}`);

      // ---- transfer folder: several at once, and emptying it --------------------------------------------------------
      fs.mkdirSync(path.join(root, T, 'Twin A'), { recursive: true }); fs.mkdirSync(path.join(root, T, 'Twin B'), { recursive: true });
      fs.writeFileSync(path.join(root, T, 'Twin A', 'same name.txt'), 'from A'); fs.writeFileSync(path.join(root, T, 'Twin B', 'same name.txt'), 'from B');
      r = await call('export_to_transfer', { paths: [`${T}/Twin A/same name.txt`, `${T}/Twin B/same name.txt`] });
      const batch = fs.readdirSync(path.join(data, 'transfer')).find((n) => /_export/.test(n)) || '';
      const inBatch = (rel) => { try { return fs.readFileSync(path.join(data, 'transfer', batch, rel), 'utf8'); } catch { return null; } };
      add(true, 'Several files copied out in one call: two with the same name are both kept, each under its own path', !r.isError && inBatch(`${T}/Twin A/same name.txt`) === 'from A' && inBatch(`${T}/Twin B/same name.txt`) === 'from B', r.text);
      r = await call('import_from_transfer', { names: [`${batch}/${T}/Twin A/same name.txt`, 'no such item.txt'], destination: `${W}/Brought back`, keep_copy: true });
      add(true, 'Several items brought in in one call: each is reported, and one that fails does not stop the others', !r.isError && readDisk(`${W}/Brought back/same name.txt`) === 'from A' && /1 of 2 item/.test(r.text) && /no such item\.txt/.test(r.text), r.text);
      r = await call('clear_transfer', {});
      const tok = (r.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
      const stillThere = fs.readdirSync(path.join(data, 'transfer')).length;
      const wrongTok = await call('clear_transfer', { confirm_token: 'deadbeef' });
      const afterWrong = fs.readdirSync(path.join(data, 'transfer')).length;
      add(true, 'Emptying the transfer folder only previews, and a wrong code removes nothing', /NOTHING HAS BEEN REMOVED/.test(r.text) && Boolean(tok) && stillThere > 0 && wrongTok.isError && afterWrong === stillThere, `${r.text} | ${wrongTok.text}`);
      r = await call('clear_transfer', { confirm_token: tok });
      add(true, 'With the right code the transfer folder is emptied, and nothing in the Tresorit folder is touched', !r.isError && fs.readdirSync(path.join(data, 'transfer')).length === 0 && exists(`${T}/Twin A/same name.txt`) && exists(`${docs}/sample.docx`), r.text);

      // ---- identical files ------------------------------------------------------------------------------------------
      const blob = crypto.randomBytes(3000);
      fs.writeFileSync(path.join(root, T, 'Twin A', 'report.bin'), blob); fs.writeFileSync(path.join(root, T, 'Twin B', 'copy of report (2).bin'), blob);
      fs.writeFileSync(path.join(root, T, 'Twin B', 'same size other content.bin'), crypto.randomBytes(3000));
      fs.writeFileSync(path.join(home, 'Downloads', 'is it there.bin'), blob);
      r = await call('find_identical', { path: T });
      const grp = r.text.split('\n\n').find((g) => g.includes('report.bin')) || '';
      add(true, 'Files with identical content are found whatever their names, and same-sized files that differ are not', !r.isError && grp.includes('copy of report (2).bin') && !r.text.includes('same size other content.bin'), r.text);
      r = await call('find_identical', { path: T, file: path.join(home, 'Downloads', 'is it there.bin') });
      add(true, 'Answers whether a given file is already in Tresorit under another name', !r.isError && r.text.includes('Twin A/report.bin') && r.text.includes('copy of report (2).bin'), r.text);
    }

    r = await call('search_contents', { query: 'PF-PDF-404' });
    add(true, 'Searches inside PDFs', r.text.includes('sample.pdf'), r.text);
    r = await call('search_contents', { query: 'relatorio de verificacao' });
    add(true, 'Searches inside Word files, ignoring accents', r.text.includes('sample.docx'), r.text);
    r = await call('recent_files', { days: 1 });
    add(false, 'Lists recently changed files', r.text.includes('first.txt'), r.text.slice(0, 160));

    // ---- text recognition ---------------------------------------------------------------------------------------
    r = await call('read_file', { path: `${docs}/scan.pdf` }, 50000);
    add(false, 'Reads a scanned page by text recognition', !r.isError && /48213/.test(r.text), r.text.slice(-200));
    r = await call('connector_status', {});
    const engine = (r.text.match(/Text recognition \(OCR\): (.*)/) || [])[1] || 'unknown';
    info.push(`Text recognition engine in use: ${engine}`);

    // ---- records and tidiness -----------------------------------------------------------------------------------
    r = await call('access_log', { lines: 400 });
    add(true, 'The access log records reads, writes, deletes and refusals', /\| READ /.test(r.text) && /\| WRITE /.test(r.text) && /\| DELETE /.test(r.text) && /\| REFUSED /.test(r.text), r.text.slice(-200));
    add(true, 'Nothing outside the scratch folder was read into a reply or changed', fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8') === 'OUTSIDE-SECRET-909' && fs.readdirSync(outside).length === 1 && fs.readFileSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'), 'utf8') === 'KEYCHAIN-SECRET' && fs.readFileSync(path.join(home, '.secrets', 'key.txt'), 'utf8') === 'HIDDEN-SECRET' && fs.readFileSync(path.join(root, 'Blocked Zone', 'private.txt'), 'utf8') === 'BLOCKED-SECRET-808' && fs.readFileSync(path.join(root, T, 'Guarded', 'Sealed', 's.txt'), 'utf8') === 'SEALED-SECRET-313');
    add(true, 'The channel to Claude stayed clean (no stray output)', protoErrors === 0, `${protoErrors} error(s)`);
    await client.close();
    client = null;
    add(false, 'The second copy stops when disconnected', transport.stoppedByItself === true);
  } catch (e) {
    if (e.message !== 'stop') add(true, 'The check ran to the end', false, e.stack || e.message);
  } finally {
    if (client) { try { await client.close(); } catch { /* ignore */ } }
  }

  // ---- the real Tresorit folder: looked at, never changed ------------------------------------------------------
  let tresors = [];
  let realOk = false;
  try {
    const ents = fs.readdirSync(realRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const unreadable = [];
    for (const e of ents) { try { fs.readdirSync(path.join(realRoot, e.name)); tresors.push(e.name); } catch (err) { unreadable.push(`${e.name} (${err.code})`); } }
    realOk = ents.length > 0 && unreadable.length === 0;
    add(true, 'The real Tresorit folder can be read', realOk, unreadable.length ? `cannot open: ${unreadable.join(', ')}` : `${tresors.length} tresor(s)`);
    info.push(`Tresorit folder: ${realRoot}  (tresors: ${tresors.join(', ') || 'none found'})`);
    const sameDisk = fs.statSync(realRoot).dev === fs.statSync(dataDir).dev;
    info.push(`Tresorit and the connector's data folder are on ${sameDisk ? 'the same disk (moves to the holding area are instant)' : 'different disks (moves to the holding area copy the data, and an interrupted copy can leave a partial item)'}.`);
    info.push(`Capital letters in names inside Tresorit are ${fs.existsSync(realRoot.toUpperCase()) && fs.existsSync(realRoot.toLowerCase()) ? 'ignored' : 'significant'} on that disk.`);
    try { const s = fs.statfsSync(dataDir); info.push(`Free space for the search index and holding area: ${Math.round((s.bavail * s.bsize) / 1e9)} GB.`); } catch { /* not available */ }
    // Folders outside Tresorit that files are most often brought in from: can the connector see them? (Looking at
    // them here is also what makes macOS ask for permission, once, if it has not been given yet.)
    if (realHome) {
      const seen = [];
      const refused = [];
      const absent = [];
      for (const n of ['Downloads', 'Desktop', 'Documents']) {
        try { fs.readdirSync(path.join(realHome, n)); seen.push(n); } catch (err) { (err.code === 'ENOENT' ? absent : refused).push(n); }
      }
      info.push(`Folders the Mac lets the connector see for bringing files in: ${seen.join(', ') || 'none'}${refused.length ? `. NOT ALLOWED by macOS: ${refused.join(', ')} (allow them for Claude in System Settings > Privacy & Security > Files and Folders)` : ''}${absent.length ? `. Not present on this computer: ${absent.join(', ')}` : ''}.`);
    }
    if (noIndex.length) {
      const state = noIndex.map((f) => `${f} (${fs.existsSync(path.join(realRoot, f)) ? 'found' : 'NOT FOUND in Tresorit: check the name in the settings'})`);
      info.push(`Folders set as "do not index": ${state.join('; ')}.`);
    } else info.push('No folder is set as "do not index".');
    if (blocked.length) {
      const state = blocked.map((f) => `${f} (${existsAsNamed(realRoot, f) ? 'found' : 'NOT FOUND in Tresorit: nothing is blocked by this name, check it in the settings'})`);
      info.push(`Blocked folders: ${state.join('; ')}.`);
    } else info.push('No folder is blocked.');
  } catch (e) {
    add(true, 'The real Tresorit folder can be read', false, e.message);
  }

  // ---- result ---------------------------------------------------------------------------------------------------
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* left for inspection */ }
  const critFailed = results.filter((x) => x.critical && !x.pass);
  const otherFailed = results.filter((x) => !x.critical && !x.pass);
  const passed = results.filter((x) => x.pass).length;
  const ok = critFailed.length === 0 && results.some((x) => x.critical);
  const lines = [
    `Tresorit connector ${version}: check on this computer (${os.hostname()}, ${process.platform} ${process.arch}, Node ${process.versions.node})`,
    ok ? `RESULT: PASSED. ${passed} of ${results.length} checks passed${otherFailed.length ? `; ${otherFailed.length} optional check(s) did not` : ''}. The connector may now change files in Tresorit.`
      : `RESULT: NOT PASSED. ${critFailed.length} essential check(s) failed. The connector stays read-only. Send this report to whoever maintains the connector.`,
    '',
    ...(critFailed.length ? ['Essential checks that FAILED:', ...critFailed.map((x) => `  FAIL  ${x.label}${x.detail ? `  [${x.detail}]` : ''}`), ''] : []),
    ...(otherFailed.length ? ['Optional checks that did not pass:', ...otherFailed.map((x) => `  note  ${x.label}${x.detail ? `  [${x.detail}]` : ''}`), ''] : []),
    'Passed:',
    ...results.filter((x) => x.pass).map((x) => `  ok    ${x.label}`),
    '',
    'About this computer:',
    ...info.map((i) => `  ${i}`),
    '',
    `Took ${Math.round((Date.now() - started) / 1000)} seconds. Nothing in Tresorit was changed: the test used a scratch folder that has been removed.`,
  ];
  const summary = { version, host: os.hostname(), root: realRoot, when: new Date().toISOString(), checks: results.length, passed, critical_failed: critFailed.length, optional_failed: otherFailed.length };
  let reportPath = '';
  try {
    const logDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    reportPath = path.join(logDir, `preflight-${stampNow()}.txt`);
    fs.writeFileSync(reportPath, lines.join('\n') + '\n');
    if (ok) fs.writeFileSync(markerFile(dataDir), JSON.stringify(summary, null, 2));
    else { try { fs.rmSync(markerFile(dataDir), { force: true }); } catch { /* ignore */ } }
  } catch { /* the report is still returned */ }
  if (reportPath) lines.push(`Report saved to ${reportPath}`);
  return { ok, text: lines.join('\n'), summary };
}
