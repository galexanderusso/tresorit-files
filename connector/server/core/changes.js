// How anything in Tresorit is changed: copies are prepared in the staging folder and put in place whole, what is
// deleted or replaced goes to the holding area, and the holding area clears itself after the set number of days.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { holdingDays } from '../lib/config.js';
import { UserError } from '../lib/paths.js';
import { stamp, fileStamp } from '../lib/log.js';
import { TextIndex } from '../lib/textindex.js';
import {
  ROOT, DATA, HOLD, STAGING, log, index, blockedUnder, blockedAt, nameList, depthOf, fmtSize, closing,
} from './setup.js';
import { checkedHere, oneAtATime } from './turns.js';

// ---------------------------------------------------------------------------------------------------------------
// Holding area: nothing is ever permanently deleted or silently overwritten. Items go here and can be restored.
// ---------------------------------------------------------------------------------------------------------------
async function newBatch(kind) {
  await fsp.mkdir(HOLD, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${fileStamp()}_${kind}_${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(HOLD, name);
    try { await fsp.mkdir(dir); } catch (e) { if (e.code === 'EEXIST') continue; throw e; } // never reuse a batch
    await fsp.mkdir(path.join(dir, 'files'));
    return { name, dir, kind, when: stamp(), items: [] };
  }
  throw new Error('could not create a new batch in the holding area');
}

// Errors that mean "something is already there". After one of these, whatever is at the destination was NOT made by
// the failed operation and must not be cleaned up.
const EXISTS_ERRORS = new Set(['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR', 'ERR_FS_CP_EEXIST', 'ERR_FS_CP_DIR_TO_NON_DIR', 'ERR_FS_CP_NON_DIR_TO_DIR']);
const alreadyThere = (what) => Object.assign(new Error(`something already exists at ${what}`), { code: 'EEXIST' });

async function absent(p) {
  try { await fsp.lstat(p); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}

// Copies src to dst, which must not exist. If the copy fails part-way the half-made copy is removed, because
// everything at dst was created by this call. If dst turns out to exist after all, nothing there is touched.
async function copyFresh(src, dst, opts = {}) {
  if (!(await absent(dst))) throw alreadyThere('the destination');
  try {
    await fsp.cp(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false, ...opts });
  } catch (e) {
    if (!EXISTS_ERRORS.has(e.code)) { try { await fsp.rm(dst, { recursive: true, force: true }); } catch { /* ignore */ } }
    throw e;
  }
}

// Copies src to dst (which must not exist) so that dst appears complete or not at all: the copy is first made in
// the connector's staging folder, optionally checked there, and then put in place in one step. If the connector
// is stopped half-way, nothing half-copied is left in Tresorit for the Tresorit app to sync to other people.
// (When the staging folder is on a different disk from the destination, that single step is not possible and
// the copy is made in place as before.)
function copyWhole(src, dst, opts = {}, verify = null) {
  return putWhole(dst, async (at) => {
    await copyFresh(src, at, opts);
    if (verify) await verify(at);
  });
}

// Whether a place is on the same disk as the staging folder. Only then can something be put there in one step.
async function onStagingDisk(dst) {
  try {
    let parent = path.dirname(dst);
    while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    return (await fsp.stat(STAGING)).dev === (await fsp.stat(parent)).dev;
  } catch { return false; }
}

const newStage = async (name) => {
  const dir = path.join(STAGING, `${fileStamp()}_${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(dir, { recursive: true });
  return { dir, at: path.join(dir, name), clear: () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) };
};

// ---- Writing through to the disk ---------------------------------------------------------------------------------
// A file that has just been written sits partly in the Mac's memory for a while. If the power fails then, a swap
// that has already been recorded could point at contents that never reached the disk. So before a new version
// takes a file's place, its contents are written through to the disk itself (on a Mac this is the full flush,
// which also empties the drive's own buffer), and afterwards the folder entry is written through as well.
// TRESORIT_SYNC_LOG names a file in which each flush is noted; it is used by the self-check only.
const SYNC_LOG = process.env.TRESORIT_SYNC_LOG || '';
const noteFlush = (kind, p) => { if (SYNC_LOG) { try { fs.appendFileSync(SYNC_LOG, `${kind}\t${p}\n`); } catch { /* ignore */ } } };
async function flushFile(p) {
  const h = await fsp.open(p, 'r');
  try { await h.sync(); } finally { await h.close(); }
  noteFlush('file', p);
}
// (The folder entry: without it the new version is safe but the Mac might still show the old one after a power cut,
// which is also a complete file. So this one is best effort.)
async function flushDir(dir) {
  try { const h = await fsp.open(dir, 'r'); try { await h.sync(); } finally { await h.close(); } noteFlush('dir', dir); } catch { /* best effort */ }
}

// Puts a newly made item at plan.d, replacing what is there when plan.d.exists (the caller has made sure that is
// wanted). `make(place)` builds the new item at the place it is given. All the slow work (copying, checking) is
// done first, in the staging folder, while Tresorit is left untouched. Only then:
//   - a file replacing a file: the old file is COPIED to the holding area and the new one takes its place in one
//     single step, so that at no moment is the file missing or incomplete, even if the connector is stopped;
//   - anything else: what is there is moved to the holding area and the new item moved in, two quick steps.
// On failure, what was there before is back in place (or, at worst, safe in the holding area, and the error says so).
async function placeNew(plan, make) {
  const { d } = plan;
  await fsp.mkdir(path.dirname(d.abs), { recursive: true });
  if (!(await onStagingDisk(d.abs))) {
    // The staging folder is on another disk: set aside what is there, then build the new item in place.
    if (d.exists) plan.aside = await setAside(d.abs, d.rel, 'move');
    try {
      if (!(await absent(d.abs))) throw alreadyThere('the destination');
      try { await make(d.abs); } catch (e) {
        if (!EXISTS_ERRORS.has(e.code)) await fsp.rm(d.abs, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
    } catch (e) {
      if (plan.aside && !e.keepDestination) { const a = plan.aside; plan.aside = null; throw await undoOrExplain(a, d.rel, e); }
      throw e;
    }
    return;
  }
  const stage = await newStage(path.basename(d.abs));
  try {
    await make(stage.at);
    const made = await fsp.lstat(stage.at);
    if (made.isFile()) await flushFile(stage.at);
    if (!d.exists) { await moveRobust(stage.at, d.abs); if (made.isFile()) await flushDir(path.dirname(d.abs)); return; }
    const old = await fsp.lstat(d.abs);
    if (made.isFile() && old.isFile()) {
      plan.aside = await setAside(d.abs, d.rel, 'copy');
      try { await fsp.rename(stage.at, d.abs); } catch (e) {
        const a = plan.aside; plan.aside = null;
        await a.undo(e).catch(() => {}); // nothing was changed: the copy in the holding area is simply dropped
        throw e;
      }
      await flushDir(path.dirname(d.abs));
    } else {
      plan.aside = await setAside(d.abs, d.rel, 'move');
      try { await moveRobust(stage.at, d.abs); } catch (e) {
        const a = plan.aside; plan.aside = null;
        throw await undoOrExplain(a, d.rel, e);
      }
    }
  } finally {
    await stage.clear();
  }
}

// Replaces the contents of an existing file in one step: the new contents are written to a copy of the file in
// the staging folder (a copy, so that its permissions and other attributes are kept), which then takes the
// file's place. If the connector is stopped at any moment, the file is either as it was or as it should be.
async function rewriteWhole(abs, data) {
  if (!(await onStagingDisk(abs))) { await fsp.writeFile(abs, data); return; }
  const stage = await newStage(path.basename(abs));
  try {
    await fsp.copyFile(abs, stage.at, fs.constants.COPYFILE_FICLONE);
    await fsp.writeFile(stage.at, data);
    await flushFile(stage.at);
    await fsp.rename(stage.at, abs);
    await flushDir(path.dirname(abs));
  } finally {
    await stage.clear();
  }
}

// Makes something at dst (which must not exist) by calling make(place): `make` builds it at the place it is
// given, in the staging folder, and it is then moved to dst in one step.
async function putWhole(dst, make) {
  if (!(await absent(dst))) throw alreadyThere('the destination');
  const sameDisk = await onStagingDisk(dst);
  if (!sameDisk) {
    try { await make(dst); } catch (e) {
      // Whatever is at dst now was made by this call, unless the failure was that something was already there.
      if (!EXISTS_ERRORS.has(e.code)) await fsp.rm(dst, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    return;
  }
  const stage = await newStage(path.basename(dst));
  try {
    await make(stage.at);
    await moveRobust(stage.at, dst);
  } finally {
    await stage.clear();
  }
}

// Moves src to dst, which must not exist (a plain rename would silently replace a file that is in the way).
async function moveRobust(src, dst) {
  if (!(await absent(dst))) {
    // On a Mac "Report.pdf" and "report.pdf" are one file: a rename that only changes capitals is the same item.
    const [a, b] = await Promise.all([fsp.lstat(src), fsp.lstat(dst)]);
    if (a.ino !== b.ino || a.dev !== b.dev) throw alreadyThere('the destination');
  }
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await copyFresh(src, dst);
    try {
      await fsp.rm(src, { recursive: true, force: true });
    } catch (e2) {
      // The complete copy is in place; it must never be cleaned up as if the move had failed.
      throw Object.assign(new Error(`moved, but the original could not be fully removed from its old place: ${e2.message}`), { keepDestination: true });
    }
  }
}

const heldPath = (batchDir, rel) => path.join(batchDir, 'files', ...rel.split('/'));

// The record of a batch is replaced in one step (written beside it, written through to the disk, then swapped
// in), so that stopping the connector or losing power while it is being updated can never leave a damaged record,
// which would hide the whole batch. Every change to a record goes through here, also after a restore.
async function saveManifest(batch) {
  const file = path.join(batch.dir, 'manifest.json');
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify({ kind: batch.kind, when: batch.when, items: batch.items }, null, 2));
    await flushFile(tmp);
    await fsp.rename(tmp, file);
    await flushDir(batch.dir);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function holdItem(batch, abs, rel, mode) {
  const st = await fsp.stat(abs);
  const dst = heldPath(batch.dir, rel);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  // The record is written BEFORE the item is moved. If the connector is stopped at that very moment, an item can
  // then never sit in the holding area without a record of where it came from (which would make it invisible to
  // tresorit_list_deleted and impossible to restore from here).
  batch.items.push({ original: rel, type: st.isDirectory() ? 'folder' : 'file' });
  await saveManifest(batch);
  try {
    if (mode === 'copy') await copyFresh(abs, dst, { mode: fs.constants.COPYFILE_FICLONE });
    else await moveRobust(abs, dst);
  } catch (e) {
    if (!e.keepDestination) { batch.items.pop(); await saveManifest(batch).catch(() => {}); }
    throw e;
  }
}

async function readBatches() {
  let names = [];
  try { names = (await fsp.readdir(HOLD)).sort().reverse(); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // (a batch on its way out, see hideBatch)
    try {
      const m = JSON.parse(await fsp.readFile(path.join(HOLD, name, 'manifest.json'), 'utf8'));
      if (m && typeof m === 'object' && Array.isArray(m.items)) out.push({ ...m, name, dir: path.join(HOLD, name) }); // (where a batch is comes from the folder, never from its record)
    } catch { /* not a batch */ }
  }
  return out;
}

// Removes a batch from the holding area for good. It is first renamed out of sight in one step, so a batch is
// either still there whole or gone from the list: a connector stopped half-way never leaves half a batch behind
// (what remains of a renamed batch is removed at the next start or the next look). The renaming is hideBatch.
const REMOVING = '.removing-';
async function hideBatch(dir) {
  const gone = path.join(path.dirname(dir), REMOVING + path.basename(dir));
  await fsp.rename(dir, gone);
  return gone;
}
async function finishRemovals() {
  let names = []; try { names = await fsp.readdir(HOLD); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(REMOVING)) continue;
    const p = path.join(HOLD, n);
    try { if ((await fsp.lstat(p)).isDirectory()) await fsp.rm(p, { recursive: true, force: true }); else await fsp.unlink(p); /* (a link is removed itself, never followed) */ } catch { /* next time */ }
  }
}

// A batch's age is the moment it was made, as recorded in it (falling back to the folder's own date).
async function batchMade(b) {
  // Only a date in exactly the form the connector writes is taken at its word (a damaged record must not turn
  // into "very old" by accident); anything else falls back to the folder's own date.
  let made = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(String(b.when || '')) ? Date.parse(String(b.when).replace(' ', 'T')) : NaN;
  if (Number.isNaN(made)) { try { made = (await fsp.lstat(b.dir)).mtimeMs; } catch { return null; } }
  return made;
}
// A date from before this connector existed can only come from a Mac whose clock was wrong when the batch was
// made. Its real age is unknown, so the automatic clearing leaves it alone (it can still be cleared by hand).
const CLOCK_FLOOR = Date.parse('2025-01-01T00:00:00');

// ---- The holding area clears itself ----
// Batches older than the number of days in the settings (30 unless changed; 0 = never) are removed for good, without
// anyone asking. That is the one standing permission the user has given: everything else that leaves the holding area
// still needs a preview and a yes. It happens only while the connector runs, only after the self-check has passed on
// this computer, only for whole batches, and every removal is written to the access log.
const HOLDING_DAYS = holdingDays();
const HOLD_DAY_MS = 86_400_000; // (a fixed value on purpose: nothing in the environment can shorten a day)
const SWEEP_NOTE = path.join(DATA, 'holding-cleared.json');
function lastSweep() { try { return JSON.parse(fs.readFileSync(SWEEP_NOTE, 'utf8')); } catch { return null; } }
let sweeping = false;
async function sweepHolding() {
  if (!HOLDING_DAYS || sweeping || closing || !ROOT || !checkedHere()) return 0;
  sweeping = true;
  try {
    const cutoff = () => Date.now() - HOLDING_DAYS * HOLD_DAY_MS;
    const oldOnes = async () => { const out = []; for (const b of await readBatches()) { const made = await batchMade(b); if (made !== null && made >= CLOCK_FLOOR && made <= cutoff()) { b.made = made; out.push(b); } } return out; };
    await finishRemovals(); // (what a stopped connector left of a batch it was removing)
    // A look first, without holding anything up: nearly always there is nothing to do.
    const first = await oldOnes();
    if (!first.length) return 0;
    const sizes = new Map(); for (const b of first) sizes.set(b.name, (await measure(b.dir).catch(() => ({ bytes: 0 }))).bytes);
    let done = 0; let bytes = 0; const hidden = [];
    await oneAtATime(async () => {
      // The holding area must be the connector's own real folder: never a link, and never inside (or around) Tresorit.
      const realHold = fs.realpathSync.native(HOLD); const realRoot = (() => { try { return fs.realpathSync.native(ROOT); } catch { return ROOT; } })();
      if (fs.lstatSync(HOLD).isSymbolicLink() || realHold === realRoot || realHold.startsWith(realRoot + path.sep) || realRoot.startsWith(realHold + path.sep)) {
        log('REFUSED', 'holding area', 'automatic clearing: the holding area is a link or overlaps the Tresorit folder; nothing was removed');
        return;
      }
      // Looked at again now that no other change is under way (another copy may have restored or cleared a batch).
      // Inside this turn a batch is only moved out of sight, which takes an instant, and logged; the files themselves
      // are removed afterwards, so that other requests never wait for a large batch to be deleted.
      for (const b of await oldOnes()) {
        if (closing) break;
        if (path.dirname(b.dir) !== HOLD || !/^[\w.-]+$/.test(b.name) || b.name.startsWith('.')) continue;
        try {
          const st = await fsp.lstat(b.dir);
          if (!st.isDirectory()) continue; // (a link is never followed)
          const size = sizes.has(b.name) ? sizes.get(b.name) : (await measure(b.dir).catch(() => ({ bytes: 0 }))).bytes;
          hidden.push(await hideBatch(b.dir));
          const dated = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(String(b.when || '')) ? `made ${b.when}` : `no usable date in its record, folder dated ${stamp(new Date(b.made))}`;
          const eg = b.items[0] && typeof b.items[0].original === 'string' ? `; e.g. ${b.items[0].original.slice(0, 300)}` : '';
          log('PURGE', b.name, `removed from the holding area automatically: older than ${HOLDING_DAYS} day(s) (${dated}; ${String(b.kind).slice(0, 20)}; ${b.items.length} item(s), ${fmtSize(size)}${eg})`);
          done++; bytes += size;
        } catch (e) { log('ERROR', b.name, `automatic clearing of the holding area: ${e.message}`); }
      }
    }, 'automatic clearing of the holding area');
    for (const g of hidden) { try { await fsp.rm(g, { recursive: true, force: true }); } catch { /* finished at the next look or the next start */ } }
    if (done) { try { const tmp = `${SWEEP_NOTE}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ when: stamp(), batches: done, bytes })); fs.renameSync(tmp, SWEEP_NOTE); } catch { /* only a note for the status report */ } }
    return done;
  } catch (e) { console.error('holding area sweep:', e && e.message); return 0; } finally { sweeping = false; }
}

// Keeps what is at abs safe in the holding area before it is replaced. Returns a handle that can undo the move.
async function setAside(abs, rel, mode) {
  // A folder with a blocked folder inside it is never replaced: that would carry the blocked folder off with it.
  const guarded = await blockedUnder(abs, rel);
  if (guarded.length) throw new UserError(`"${rel}" cannot be replaced: it contains a blocked folder (${nameList(guarded)}), which the connector never changes (set in the connector's settings).`);
  const batch = await newBatch('replaced');
  try {
    await holdItem(batch, abs, rel, mode);
  } catch (e) {
    if (!batch.items.length) await fsp.rm(batch.dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return {
    name: batch.name,
    held: heldPath(batch.dir, rel),
    // Puts the original back after a failed replacement. Returns true when it is back in place; false means it
    // could not be put back and remains safe in the holding area under this batch name.
    async undo(err) {
      if (mode !== 'move') { await fsp.rm(batch.dir, { recursive: true, force: true }); return true; }
      try {
        if (!(await absent(abs))) {
          // Something is at the old place. It is only removed when it is the half-made result of our own operation.
          if (err && EXISTS_ERRORS.has(err.code)) return false;
          await fsp.rm(abs, { recursive: true, force: true });
        }
        await moveRobust(heldPath(batch.dir, rel), abs);
        await fsp.rm(batch.dir, { recursive: true, force: true });
        return true;
      } catch { return false; }
    },
  };
}

// After a failed replacement: put the original back, and say so plainly if that was not possible.
async function undoOrExplain(aside, rel, err) {
  if (await aside.undo(err)) return err;
  return Object.assign(new Error(`${err.message}. What was at "${rel}" before could not be put back automatically; it is safe in the holding area, batch ${aside.name} (bring it back with tresorit_restore_deleted).`), { code: err.code });
}

async function measure(abs) {
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) return { type: 'file', files: 1, folders: 0, bytes: st.size };
  let files = 0; let bytes = 0; let folders = 0;
  const stack = [abs];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (blockedAt(p)) continue; // a blocked folder inside is not looked into, not even to count it
      if (e.isDirectory()) { folders++; stack.push(p); } else {
        files++;
        try { bytes += (await fsp.lstat(p)).size; } catch { /* ignore */ }
      }
    }
  }
  return { type: 'folder', files, folders, bytes };
}

// When something is moved or deleted, the text kept for it under its old name is dropped at once (not at the next
// background pass), so that nothing lingers in the index, for example after a move into a "do not index" folder.
function forgetIndexed(rel) {
  const base = TextIndex.key(rel);
  for (const k of [...index.map.keys()]) if (k === base || k.startsWith(base + '/')) index.remove(k);
}

function requireDepth(rel, what) {
  if (depthOf(rel) < 2) {
    throw new UserError(`${what} is not allowed at the top level. The top level holds the tresors themselves ` +
      '(create, rename or remove tresors in the Tresorit app). Work inside a tresor, for example "Company/...".');
  }
}

export {
  newBatch, absent, copyFresh, copyWhole, placeNew, rewriteWhole, moveRobust, heldPath, saveManifest, holdItem,
  readBatches, hideBatch, batchMade, CLOCK_FLOOR, HOLDING_DAYS, lastSweep, sweepHolding, setAside, undoOrExplain,
  measure, forgetIndexed, requireDepth,
};
