// Set-up and the reading of documents: where the Tresorit folder and the connector's own data folder are, the
// access log, the search index, the rules for blocked and "do not index" folders, small helpers, and getText(),
// which every tool uses to read a document (with passwords and text recognition).
// These belong together: every logged change asks for the changed file to be read into the index.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { VERSION,
  detectRoot, dataDir, blockedFolders, backgroundIndexEnabled, ocrEnabled, ocrEngineChoice, homeDir, importRoots,
  noIndexFolders,
} from '../lib/config.js';
import { makeResolver, UserError, isJunkName, foldPlace } from '../lib/paths.js';
import { makeLogger, stamp } from '../lib/log.js';
import { Extractor } from '../lib/extractor.js';
import { TextIndex } from '../lib/textindex.js';
import { Ocr, MAX_OCR_PAGES } from '../lib/ocr.js';
import { isExtractable } from '../lib/extract-core.js';
import { reasonOf } from '../lib/sniff.js';
import { handled } from '../lib/tidy.js';
import { makeOutside } from '../lib/outside.js';

// ---------------------------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------------------------
const detected = detectRoot();
let ROOT = detected.root;
let DATA = dataDir();
let dataProblem = false;
if (ROOT && (DATA === ROOT || DATA.startsWith(ROOT + path.sep))) {
  // Never keep the log, index or holding area inside Tresorit itself: fall back to the default place and refuse to work.
  dataProblem = true;
  DATA = path.join(os.homedir(), 'TresoritConnector');
  if (DATA === ROOT || DATA.startsWith(ROOT + path.sep)) DATA = path.join(os.tmpdir(), 'TresoritConnector');
}
const HOLD = path.join(DATA, 'deleted');
const TRANSFER = path.join(DATA, 'transfer');
const STAGING = path.join(DATA, 'staging');
const BLOCKED = blockedFolders();
let rootProblem = '';
if (!ROOT) {
  rootProblem = `The Tresorit folder was not found on this Mac (looked in: ${detected.tried.join(', ') || 'no candidates'}). ` +
    'Open the Tresorit app and check it is syncing, or set the folder in the connector settings (Settings > Extensions > Tresorit).';
} else if (dataProblem) {
  rootProblem = 'The connector data folder is set inside the Tresorit folder. Choose a data folder outside Tresorit in the connector settings.';
  ROOT = null;
}
for (const d of [DATA, HOLD, TRANSFER, STAGING]) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* reported by status */ } }
// Copies are prepared in the staging folder and only then put in place. Anything left there by a run that was
// cut short is cleared (older than an hour, so a second running copy of the connector is never disturbed).
// While another running copy is in the middle of a change (it holds the lock), nothing is cleared at all: what
// looks left over may be the very thing it is working on.
const changeInProgressElsewhere = (() => {
  try { const h = JSON.parse(fs.readFileSync(path.join(DATA, 'change.lock'), 'utf8')); process.kill(h.pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
})();
// Scraps of the lock itself, left by a copy that was stopped at the very instant it was taking it.
try {
  for (const dir of [DATA, path.join(DATA, 'index')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const n of names) {
      const m = n.match(/^(?:change|background)\.lock\.(\d+)\.\d+\.tmp$/);
      if (!m) continue;
      let running = true;
      try { process.kill(Number(m[1]), 0); } catch (e) { running = e.code === 'EPERM'; }
      if (!running || Number(m[1]) === process.pid) fs.rmSync(path.join(dir, n), { force: true });
    }
  }
} catch { /* ignore */ }
try {
  if (changeInProgressElsewhere) throw new Error('skip');
  const cutoff = Date.now() - (Number(process.env.TRESORIT_STAGING_MAX_AGE_MS) || 3_600_000);
  for (const n of fs.readdirSync(STAGING)) {
    const p = path.join(STAGING, n);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  // The same for a holding-area batch that was begun but never received anything (no record and no files in it).
  // A batch that holds any file at all is never touched here.
  const holdsAFile = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) return true;
      if (holdsAFile(path.join(dir, e.name))) return true;
    }
    return false;
  };
  for (const n of fs.readdirSync(HOLD)) {
    const p = path.join(HOLD, n);
    try {
      const st = fs.lstatSync(p);
      // A batch that was being removed for good when the connector stopped: the removal is finished.
      if (st.isDirectory() && n.startsWith('.removing-')) { fs.rmSync(p, { recursive: true, force: true }); continue; }
      if (!st.isDirectory() || st.mtimeMs >= cutoff || !/^\d{4}-\d{2}-\d{2}_\d{6}_[a-z]+_[0-9a-f]+$/.test(n)) continue;
      if (fs.existsSync(path.join(p, 'manifest.json'))) continue;
      // (A record that was being written for the first time when the connector stopped does not count as a file.)
      const filesDir = path.join(p, 'files');
      const stray = fs.readdirSync(p).filter((x) => x !== 'files' && !/^manifest\.json\.\d+\.tmp$/.test(x));
      if (!stray.length && (!fs.existsSync(filesDir) || !holdsAFile(filesDir))) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
} catch { /* ignore */ }
// The data folder holds document text and set-aside files: readable by this user only.
try { fs.chmodSync(DATA, 0o700); } catch { /* ignore */ }

const logger = makeLogger(path.join(DATA, 'logs'));
// (A file saved, edited or brought in through the connector is also put into the search index straight away.)
const log = (kind, target, detail) => {
  logger.log(kind, target, detail);
  if ((kind === 'WRITE' || kind === 'EDIT' || kind === 'IMPORT') && typeof target === 'string' && target) { try { indexSoon(target); } catch { /* at the next pass */ } }
};
const R = ROOT ? makeResolver(ROOT, BLOCKED) : null;
const extractor = new Extractor();
const index = new TextIndex(path.join(DATA, 'index'));
const ocr = new Ocr({ enabled: ocrEnabled(), force: ocrEngineChoice() });

// Dealings with the rest of the Mac (bringing files in, copies out to Downloads or Desktop) follow their own rules.
const HOME = homeDir();
const outside = makeOutside({ home: HOME, roots: importRoots(), tresoritRoot: ROOT, dataDir: DATA });

// Folders whose documents are read only when asked for by name: their text is never kept in the search index
// and they are left out of searches inside documents.
const NO_INDEX = noIndexFolders();
const noIndexFolded = NO_INDEX.map((b) => foldPlace(b.split(path.sep).join('/')));
// ---- The safeguard for the folders that are not to be indexed ---------------------------------------------------
// Which folders stay out of the index is a setting, and a setting can be lost or shortened without anyone meaning
// it (the app asks for every setting again when the connector is installed anew). So the connector remembers, in
// its data folder, the list the user last confirmed in a window on this computer, and holds back:
//   - while no list has been confirmed here (a first start): NOTHING new is read into the index;
//   - when a folder of the confirmed list is no longer in the settings: that folder stays out of the index.
// The hold ends with the user's yes, asked at the end of a self-check that has passed (tools/status.js). A folder
// ADDED to the settings needs no yes: it is kept out at once and remembered. Where the self-check gate is off
// (the tests, and the scratch copy the self-check runs) there is no hold.
const SAFEGUARD_ON = process.env.TRESORIT_PREFLIGHT_GATE !== 'off';
const CONFIRMED_FILE = path.join(DATA, 'index', 'not-indexed.confirmed.json');
const foldSetting = (b) => foldPlace(String(b).split(path.sep).join('/'));
const coveredBy = (list, f) => list.some((b) => f === b || f.startsWith(b + '/'));
let holdAll = false;      // nothing new into the index: no list has been confirmed on this computer yet
let heldNames = [];       // folders that dropped off the settings and are still kept out, as they were confirmed
let heldFolded = [];
let holdLooked = 0;
let holdStamp = '';
function saveConfirmed(folders) {
  const tmp = `${CONFIRMED_FILE}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(CONFIRMED_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ folders, when: stamp(), version: VERSION }));
  fs.renameSync(tmp, CONFIRMED_FILE);
}
// Looks at the remembered list (at most every two seconds: another copy of the connector may have had the yes).
function lookAtHold(force = false) {
  if (!SAFEGUARD_ON || !ROOT) return;
  const now = Date.now();
  if (!force && now - holdLooked < 2000) return;
  holdLooked = now;
  let seen = 'none';
  try { const st = fs.statSync(CONFIRMED_FILE); seen = `${st.mtimeMs}:${st.size}`; } catch { /* none yet */ }
  if (!force && seen === holdStamp) return;
  holdStamp = seen;
  let confirmed = null;
  try { const j = JSON.parse(fs.readFileSync(CONFIRMED_FILE, 'utf8')); if (j && Array.isArray(j.folders)) confirmed = j.folders.map(String); } catch { /* none, or unreadable: as on a first start */ }
  if (!confirmed) { holdAll = true; heldNames = []; heldFolded = []; index.frozen = true; return; }
  holdAll = false; index.frozen = false;
  heldNames = confirmed.filter((f) => !coveredBy(noIndexFolded, foldSetting(f)));
  heldFolded = heldNames.map(foldSetting);
  const known = confirmed.map(foldSetting);
  const added = NO_INDEX.filter((f) => !known.includes(foldSetting(f)));
  if (added.length) { try { saveConfirmed([...confirmed, ...added]); holdStamp = ''; } catch { /* remembered at the next look */ } }
}
// The hold now in force: { all, folders }. Nothing is held when both are empty.
function indexHold() { lookAtHold(); return { all: holdAll, folders: heldNames }; }
// The user has said yes: the list as it is in the settings now is the confirmed one, and the hold ends.
function confirmNotIndexed() { saveConfirmed(NO_INDEX); lookAtHold(true); }
// Every folder kept out of the index now: those of the settings and those still held.
const notIndexedNames = () => [...NO_INDEX, ...heldNames];
const isNoIndexRel = (rel) => {
  lookAtHold();
  if (!noIndexFolded.length && !heldFolded.length) return false;
  const f = foldPlace(rel);
  return coveredBy(noIndexFolded, f) || coveredBy(heldFolded, f);
};
lookAtHold(true);
// Anything already in the index from before the setting was made is removed.
for (const k of [...index.map.keys()]) if (isNoIndexRel(k)) index.remove(k);

// ---- Protected folders reached through a folder above them ----------------------------------------------------
// A blocked folder is refused when it is named. It must be just as safe when the folder ABOVE it is named: a copy
// of that folder leaves the blocked folder out, and a move, a deletion or a replacement of it is refused, because
// each of those would take the blocked folder along to a place where it is no longer protected.
const BLOCKED_FOLDED = BLOCKED.map((b) => foldPlace(b.split(path.sep).join('/')));
// The items below baseAbs whose path is `parts`, compared the way the settings are (capitals, accents and the spellings a Mac treats as one name
// ignored). Links are never followed.
async function findFolded(baseAbs, parts) {
  let level = [baseAbs];
  for (const want of parts) {
    const next = [];
    for (const dir of level) {
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) if (!e.isSymbolicLink() && foldPlace(e.name) === want) next.push(path.join(dir, e.name));
    }
    if (!next.length) return [];
    level = next;
  }
  return level;
}
// Which folders of a list from the settings would be found below asRel if the folder at abs stood there.
// With asRel = the folder's own path: the listed folders it contains. With asRel = a destination: the listed
// folders that putting it there would fill.
async function foldersUnder(list, abs, asRel) {
  if (!list.length || !asRel) return [];
  const base = `${foldPlace(asRel)}/`;
  const out = new Set();
  for (const b of list) {
    if (!b.startsWith(base)) continue;
    for (const hit of await findFolded(abs, b.slice(base.length).split('/'))) out.add(`${asRel}/${path.relative(abs, hit).split(path.sep).join('/')}`);
  }
  return [...out];
}
const blockedUnder = (abs, asRel) => foldersUnder(BLOCKED_FOLDED, abs, asRel);
// True for a place inside the Tresorit folder that is in a blocked folder (used to leave such places out of copies
// and counts made from a folder above them).
const blockedAt = (p) => Boolean(R && BLOCKED_FOLDED.length && R.inside(p) && R.isBlockedRel(R.toRel(p)));
const notBlocked = (from) => !blockedAt(from);
const nameList = (rels, n = 5) => `${rels.slice(0, n).map((r) => `"${show(r)}"`).join(', ')}${rels.length > n ? ` and ${rels.length - n} more` : ''}`;
// Refuses when putting the folder at srcAbs at dRel would place items inside a blocked folder.
async function refuseLanding(srcAbs, dRel) {
  const lands = await blockedUnder(srcAbs, dRel);
  if (lands.length) throw new UserError(`Nothing was done: putting it at "${dRel}" would place items inside a blocked folder (${nameList(lands)}), which the connector never changes (set in the connector's settings).`);
}
// What to tell the user when something from a "do not index" folder now stands where it WILL be indexed.
async function noIndexNote(srcAbs, sRel, dRel) {
  if (!noIndexFolded.length || isNoIndexRel(dRel)) return '';
  // (the source is such a folder or lies in one, or it has such folders inside it: where each of them stands now)
  const tails = isNoIndexRel(sRel) ? [''] : (await foldersUnder(noIndexFolded, srcAbs, sRel)).map((r) => r.slice(sRel.length));
  const now = tails.map((t) => `${dRel}${t}`).filter((r) => !isNoIndexRel(r));
  if (!now.length) return '';
  return `Note: this came out of a "do not index" folder. At its new place (${nameList(now)}) it is no longer covered by that setting: its text will be read into the search index and searched like any other document. To keep it out, add the new place to "Folders not to index" in the connector's settings.`;
}

// Files that exist in Tresorit but are not downloaded only occur when Tresorit runs as a macOS "cloud storage"
// location. With the classic Tresors folder every file is fully on disk, so nothing is ever treated as online-only.
const FILE_PROVIDER = Boolean(ROOT && (/[\\/]Library[\\/]CloudStorage[\\/]/.test(ROOT + path.sep) || process.env.TRESORIT_ASSUME_FILE_PROVIDER === '1'));
const cloudOnly = (st) => FILE_PROVIDER && st.isFile() && st.size > 0 && st.blocks === 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extOf = (name) => { const e = path.extname(name).toLowerCase(); return e ? e.slice(1) : ''; };
const depthOf = (rel) => (rel ? rel.split('/').length : 0);

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
const fmtDate = (ms) => stamp(new Date(ms)).slice(0, 16);
// A file name can contain line breaks or other control characters. Shown raw, such a name could imitate extra
// lines in a listing or a delete preview, so it is shown in escaped form instead.
const show = (rel) => (/[\u0000-\u001f\u007f\u2028\u2029]/.test(rel) ? `${JSON.stringify(rel)} (name contains control characters, shown escaped)` : rel);

function parseDate(s, label) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new UserError(`${label} is not a valid date. Use YYYY-MM-DD.`);
  return d.getTime();
}

function extSet(list) {
  if (!list || !list.length) return null;
  return new Set(list.map((e) => String(e).toLowerCase().replace(/^\*?\./, '').trim()).filter(Boolean));
}

// Walks the folder tree. Skips system junk, blocked folders and symbolic links (links are never followed).
async function* walk(dirAbs, opts = {}, depth = 1) {
  const { maxDepth = Infinity, includeHidden = false } = opts;
  let ents;
  try { ents = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  for (const e of ents) {
    if (isJunkName(e.name)) continue;
    if (!includeHidden && e.name.startsWith('.')) continue;
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dirAbs, e.name);
    const rel = R.toRel(abs);
    if (R.isBlockedRel(rel)) continue;
    const isDir = e.isDirectory();
    if (!isDir && !e.isFile()) continue;
    yield { abs, rel, name: e.name, isDir, depth };
    if (isDir && depth < maxDepth) yield* walk(abs, opts, depth + 1);
  }
}

async function statMany(items, fn, concurrency = 24) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try { it.st = await fsp.stat(it.abs); } catch { it.st = null; }
      if (fn) fn(it);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------------------------------------------
// Document text: extraction, cache, and text recognition (OCR) for scanned PDF pages
// ---------------------------------------------------------------------------------------------------------------
// Returns { status, text, note, ocrPending }.
//   status 'ok'   : text is available (ocrPending = some scanned pages are still waiting for text recognition)
//   status 'scan' : a scanned PDF whose text has not been recognised yet
const retriedThisRun = new Set(); // documents whose reading failed for a passing reason, already retried in this run
// True when an earlier attempt to read this document failed for a reason that may have passed (it timed out on a
// busy Mac, or memory was short). Such a document gets another attempt: once per run of the connector, three in all.
const retryable = (e, rel) => Boolean(e && e.st === 'error' && e.x && e.x < 3 && !retriedThisRun.has(TextIndex.key(rel)));
// A file that an OLDER version of the connector could not read has no recorded reason. It is read once more by
// this version, which reads by content and may well manage (a picture saved as .pdf, a PDF saved as .docx).
const fromOlderVersion = (e) => Boolean(e && (e.st === 'error' || e.st === 'unsupported' || e.st === 'toolarge') && !e.y);
// A failure recorded by an earlier version that was about the moment and not about the document (the file was
// missing or busy when it was opened). Earlier versions kept that as if the document were damaged, so a file that
// was deleted and restored, or moved away and back, could stay "unreadable". It is read again (at most 3 times).
// Only the exact form such a record has (the reader's "could not be read:" followed by the disk's own error code)
// counts, so that no message of a document reader can ever be mistaken for it.
const wasMomentary = (e) => Boolean(e && e.st === 'error' && (e.x || 0) < 3 && /could not be read: (ENOENT|ENOTDIR|EBUSY|EDEADLK|EAGAIN|EIO|EMFILE|ENFILE|ETIMEDOUT|EINTR|ESTALE|EPERM|EACCES): /.test(String(e.n || '')));

const UNSTORED_OCR_WAIT_MS = Number(process.env.TRESORIT_UNSTORED_OCR_WAIT_MS) || 100_000;

// Reads a document in a "do not index" folder, or any document while nothing new may be read into the index
// (held): straight from the file, every time, keeping nothing.
async function readUnstored(abs, rel, st, held = false) {
  const res = await extractor.extract(abs, extOf(rel), st.size, true);
  let { status } = res;
  let text = res.text || '';
  let note = res.note || '';
  handled(text.length * 4);
  if (res.scanPages && res.scanPages.length && (status === 'ok' || status === 'scan')) {
    const pages = res.scanPages.slice(0, MAX_OCR_PAGES);
    let got = null;
    if (ocr.enabled) {
      try { got = await Promise.race([ocr.request(abs, pages, true), sleep(UNSTORED_OCR_WAIT_MS).then(() => null)]); } catch { got = null; }
    }
    const read = got ? pages.filter((n) => (got.pages[n] || '').trim()).length : 0;
    if (read) {
      text = mergeOcr(text, got.pages);
      status = 'ok';
      note = `${read} of ${res.pages || pages.length} page(s) read by text recognition (OCR); recognised text can contain errors`;
    } else if (status === 'scan') {
      status = got ? 'empty' : 'error';
      note = got ? 'scanned PDF in which no text could be recognised' : (ocr.enabled ? 'scanned PDF whose text could not be recognised in the time available' : 'scanned PDF with no text layer, and text recognition is switched off');
    } else {
      note = [note, 'some scanned pages could not be recognised and are missing from this text'].filter(Boolean).join('; ');
    }
  }
  if (status === 'ok') note = [note, held ? 'read directly from the file; nothing new is read into the search index until the list of folders that are not to be indexed has been confirmed on this Mac, so its text is not kept or searched' : 'read directly from the file; this folder is set as "do not index", so its text is not kept or searched'].filter(Boolean).join('; ');
  return { status, text: status === 'ok' ? text : '', note, ocrPending: false, why: status === 'ok' ? '' : (res.why || reasonOf({ st: res.status, n: res.note })) };
}

async function getText(abs, rel, st, priority = true, retry = true) {
  if (isNoIndexRel(rel)) return readUnstored(abs, rel, st);
  const e = index.fresh(rel, st);
  // While nothing new may be read into the index, a document that is not in it is read without being kept.
  if (holdAll && !(e && e.st === 'ok')) {
    // A search (the call with no second try) answers from the record the index has, whatever that record says, as
    // it does without a hold: it opens no document again that is known as protected, damaged, empty or as a scan
    // waiting for text recognition. Only a file asked for by name is read from the file.
    if (e && !retry) return { status: e.st, text: '', note: e.n, ocrPending: e.o === 'pending' || e.o === 'failed', why: reasonOf(e) };
    return readUnstored(abs, rel, st, true);
  }
  if (e) {
    const ocrPending = e.o === 'pending' || e.o === 'failed';
    if (e.st === 'ok') {
      const t = await index.readText(rel);
      if (t != null) { handled(t.length * 2); return { status: 'ok', text: t, note: e.n, ocrPending }; }
    } else if (!(retry && retryable(e, rel)) && !fromOlderVersion(e) && !wasMomentary(e)) {
      return { status: e.st, text: '', note: e.n, ocrPending, why: reasonOf(e) };
    }
  }
  const res = await extractor.extract(abs, extOf(rel), st.size, priority);
  if (res.gone) {
    // Not there when it was opened: nothing is recorded about the document (and a stale record of an earlier
    // failure goes). If it is back, the next look reads it; if it is gone for good, the next look forgets it.
    // (Another copy may have read this version of the file successfully in the meantime: its text is never
    // removed on the strength of this copy's bad moment.)
    if (e && e.st !== 'ok') { index.refresh(true); const cur = index.fresh(rel, st); if (cur && cur.st !== 'ok' && cur.st !== 'scan') index.remove(rel); }
    return { status: 'error', text: '', note: res.note, ocrPending: false, why: 'other' };
  }
  const extra = {};
  if (res.status !== 'ok' && res.status !== 'empty' && res.status !== 'scan') extra.y = res.why || reasonOf({ st: res.status, n: res.note }); // why it could not be read
  if (res.mismatch) extra.mm = res.mismatch; // the content is not what the ending of the name says
  if (res.transient) { extra.x = ((e && e.x) || 0) + 1; retriedThisRun.add(TextIndex.key(rel)); }
  if (res.scanPages && res.scanPages.length && (res.status === 'ok' || res.status === 'scan')) {
    extra.o = 'pending';
    extra.op = res.scanPages.slice(0, MAX_OCR_PAGES);
    extra.pg = res.pages;
    if (res.scanPages.length > MAX_OCR_PAGES) extra.more = res.scanPages.length - MAX_OCR_PAGES;
  }
  if (res.partial) extra.tr = 1; // very long document: only its first part is kept and searchable
  await index.put(rel, st, res, extra);
  handled((res.text ? res.text.length : 0) * 6);
  return { status: res.status, text: res.text, note: res.note, ocrPending: Boolean(extra.o), why: extra.y || '' };
}

// ---- Password-protected PDFs --------------------------------------------------------------------------------------
// The password is typed by the user into a box on this Mac. It goes from the keyboard into this program's memory,
// is used to open the files asked for, and is dropped. It is never part of the conversation, never written to the
// access log, the index or any other file, and never handed to another program.
const PASSWORD_CMD = (() => { try { return process.env.TRESORIT_PASSWORD_CMD ? JSON.parse(process.env.TRESORIT_PASSWORD_CMD) : null; } catch { return null; } })();
function askPassword(message) {
  return new Promise((resolve, reject) => {
    let cmd; let args;
    if (PASSWORD_CMD) { cmd = PASSWORD_CMD[0]; args = [...PASSWORD_CMD.slice(1), message]; } // used by the tests and the self-check
    else if (process.platform === 'darwin') {
      cmd = '/usr/bin/osascript';
      args = ['-e', 'on run argv', '-e', 'tell me to activate',
        '-e', 'set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "Tresorit Files" buttons {"Cancel", "Open"} default button "Open" giving up after 180',
        '-e', 'if gave up of r then error number -128', '-e', 'return text returned of r', '-e', 'end run', message];
    } else { reject(new UserError('A password can only be asked for in a dialog on a Mac.')); return; }
    execFile(cmd, args, { timeout: 200_000, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; } // cancelled, not answered, or the dialog could not be shown
      const pw = String(stdout).replace(/\r?\n$/, '');
      resolve(pw.length ? pw : null);
    });
  });
}
// Reads one protected PDF with a password. With store, its text goes into the search index (marked as opened with
// a password); without, nothing is kept. Scanned pages are recognised straight away, because the password is not
// kept for later.
async function readWithPassword(abs, rel, st, password, store) {
  let res = await extractor.extract(abs, extOf(rel), st.size, true, { password });
  if (res.status !== 'ok' && res.status !== 'scan') return res;
  let recognised = 0;
  if (res.scanPages && res.scanPages.length && ocr.enabled && !res.partial) {
    try {
      const r = await ocr.request(abs, res.scanPages.slice(0, MAX_OCR_PAGES), true, { password });
      recognised = res.scanPages.filter((p) => (r.pages[p] || '').trim()).length;
      if (recognised) res = { ...res, status: 'ok', text: mergeOcr(res.text, r.pages) };
    } catch { /* the text layer, if any, is still used */ }
  }
  if (res.status === 'scan') res = { ...res, status: 'empty', text: '', note: 'opened with the password, but it is a scan in which no text could be recognised' };
  else res = { ...res, note: [res.mismatch, `opened with a password entered on this Mac on ${fmtDate(Date.now()).slice(0, 10)}`, recognised ? `${recognised} scanned page(s) read by text recognition` : ''].filter(Boolean).join('; ') };
  if (store) await index.put(rel, st, { status: res.status, text: res.text, note: res.note }, { pw: 1, ...(res.pages ? { pg: res.pages } : {}), ...(res.mismatch ? { mm: res.mismatch } : {}), ...(res.partial ? { tr: 1 } : {}) });
  return res;
}
// Text of a file opened with a password for a single read: kept in memory for a few minutes so that a long
// document can be read on in pages, then forgotten. Never written anywhere.
const openedOnce = new Map();
const onceKey = (rel, st) => `${TextIndex.key(rel)}|${st.size}|${st.mtimeMs}`;
function rememberOnce(rel, st, res) {
  for (const [k, v] of openedOnce) if (v.until < Date.now()) openedOnce.delete(k);
  while (openedOnce.size >= 4) openedOnce.delete(openedOnce.keys().next().value);
  if (res.text.length <= 12_000_000) openedOnce.set(onceKey(rel, st), { res, until: Date.now() + 10 * 60_000 });
}

// Puts recognised page text into the stored document text, which is divided by "--- Page i of n ---" lines.
function mergeOcr(base, pages) {
  const re = /^--- Page (\d+) of (\d+)(?: \(text read by OCR\))? ---$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(base))) marks.push({ page: Number(m[1]), total: Number(m[2]), start: m.index, bodyStart: m.index + m[0].length });
  if (!marks.length) return base;
  let out = base.slice(0, marks[0].start);
  marks.forEach((k, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : base.length;
    const got = pages[k.page];
    if (typeof got === 'string' && got.trim()) out += `--- Page ${k.page} of ${k.total} (text read by OCR) ---\n${got.trim()}\n\n`;
    else out += base.slice(k.start, end);
  });
  return out.trimEnd();
}

const ocrJobs = new Map();     // rel -> promise, so the same file is never recognised twice at once
const ocrFailedThisRun = new Set();

function runOcr(abs, rel, st, priority) {
  const key = TextIndex.key(rel);
  const running = ocrJobs.get(key);
  if (running) return running;
  const job = (async () => {
    const e = index.fresh(rel, st);
    if (!e || (e.o !== 'pending' && e.o !== 'failed') || !Array.isArray(e.op) || !e.op.length) return false;
    let result;
    try {
      result = await ocr.request(abs, e.op, priority);
    } catch (err) {
      ocrFailedThisRun.add(key);
      const cur = index.fresh(rel, st);
      if (cur) { cur.o = 'failed'; cur.on = String(err.message || err).slice(0, 200); index._touch(); }
      return false;
    }
    // The file may have changed while it was being read.
    let now;
    try { now = await fsp.stat(abs); } catch { return false; }
    const cur = index.fresh(rel, now);
    if (!cur) return false;
    const base = (await index.readText(rel)) || '';
    const merged = mergeOcr(base, result.pages);
    const readCount = e.op.filter((p) => (result.pages[p] || '').trim()).length;
    const wasScan = cur.st === 'scan';
    let note;
    if (readCount) {
      note = `${readCount} of ${cur.pg || e.op.length} page(s) read by text recognition (OCR, ${result.engine === 'vision' ? 'Mac built-in' : 'bundled engine'}); recognised text can contain errors`;
      if (cur.more) note += `; ${cur.more} further scanned page(s) beyond the ${MAX_OCR_PAGES}-page limit were not read`;
    } else note = wasScan ? (cur.mm ? 'no text could be recognised in it' : 'scanned PDF in which no text could be recognised') : cur.n;
    if (cur.mm && !String(note).startsWith(cur.mm)) note = `${cur.mm}; ${note}`;
    const status = wasScan ? (readCount ? 'ok' : 'empty') : 'ok';
    await index.put(rel, now, { status, text: status === 'ok' ? merged : '', note }, { o: 'done', pg: cur.pg, ...(cur.mm ? { mm: cur.mm } : {}) });
    if (readCount) log('OCR', rel, `${readCount} page(s) read by ${result.engine === 'vision' ? 'Mac built-in recognition' : 'the bundled engine'}${result.passedOn ? ` (the Mac's own recognition passed it on: ${result.passedOn})` : ''}`);
    return true;
  })().finally(() => ocrJobs.delete(key));
  ocrJobs.set(key, job);
  return job;
}

// The state of the background reading. The reading itself is in background.js.
const bg = { enabled: backgroundIndexEnabled(), running: false, phase: '', lastPass: 0, lastDurationMs: 0, seen: 0, extracted: 0, cloudOnly: 0, ocrTodo: 0, ocrDone: 0, battery: false, low: false, deferred: 0, deferredSmall: 0, ocrDeferred: 0, onBatteryRead: 0, again: false };

// True from the moment the app disconnects: nothing new is begun, and work in the background stops.
let closing = false;
function markClosing() { closing = true; }

// ---- Files written through the connector are put into the search index straight away -------------------------
function indexSoon(rel) {
  if (!bg.enabled || isNoIndexRel(rel) || !isExtractable(extOf(rel))) return;
  const t = setTimeout(async () => {
    try { const abs = path.join(ROOT, ...rel.split('/')); const st = await fsp.stat(abs); if (st.isFile() && !cloudOnly(st)) await getText(abs, rel, st, false); } catch { /* read at the next pass instead */ }
  }, 300);
  t.unref?.();
}

export {
  ROOT, DATA, HOLD, TRANSFER, STAGING, BLOCKED, rootProblem, logger, log, R, index, ocr, HOME, outside, NO_INDEX,
  isNoIndexRel, blockedUnder, blockedAt, notBlocked, nameList, refuseLanding, noIndexNote, FILE_PROVIDER,
  cloudOnly, sleep, extOf, depthOf, fmtSize, fmtDate, show, parseDate, extSet, walk, statMany, retryable,
  fromOlderVersion, wasMomentary, getText, askPassword, readWithPassword, openedOnce, onceKey, rememberOnce,
  ocrFailedThisRun, runOcr, bg, closing, markClosing, indexSoon, indexHold, confirmNotIndexed, notIndexedNames,
};
