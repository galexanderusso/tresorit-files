// Background reading: one copy of the connector reads every document once, so that searching inside documents
// is fast afterwards. Goes easy on the battery.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeLock } from '../lib/lock.js';
import { pauseOnBattery, VERSION } from '../lib/config.js';
import { TextIndex } from '../lib/textindex.js';
import { isExtractable } from '../lib/extract-core.js';
import { powerState } from '../lib/power.js';
import {
  ROOT, DATA, log, index, ocr, isNoIndexRel, indexHold, cloudOnly, sleep, extOf, walk, retryable, fromOlderVersion,
  wasMomentary, getText, ocrFailedThisRun, runOcr, bg, closing,
} from './setup.js';

// ---------------------------------------------------------------------------------------------------------------
// Background reading: extracts each document once so that searching inside documents is fast afterwards,
// then runs text recognition on scanned PDFs.
// ---------------------------------------------------------------------------------------------------------------
// Going easy on the battery (a setting, on by default). While the Mac runs on its battery:
//   - new documents are still read, newest first, but only in small amounts: a limited number and volume per hour,
//     and no very large files. So what arrived today is searchable today, even when travelling;
//   - everything else waits for mains power: a large backlog (such as the very first pass over the library), very
//     large files, and all text recognition for scanned PDFs, which is the heaviest work by far;
//   - below a low charge level nothing at all is read in the background.
// What waits is picked up as soon as the Mac is plugged in. Anything the user asks for is never held up.
const EASY_ON_BATTERY = pauseOnBattery();
const POWER_POLL_MS = Number(process.env.TRESORIT_POWER_POLL_MS) || 30_000;
const BATTERY_DOCS_PER_HOUR = Number(process.env.TRESORIT_BATTERY_DOCS_PER_HOUR) || 100;
const BATTERY_BYTES_PER_HOUR = (Number(process.env.TRESORIT_BATTERY_MB_PER_HOUR) || 250) * 1024 * 1024;
const BATTERY_MAX_FILE = (Number(process.env.TRESORIT_BATTERY_MAX_FILE_MB) || 25) * 1024 * 1024;
const BATTERY_LOW_PERCENT = Number(process.env.TRESORIT_BATTERY_LOW_PERCENT) || 20;
const BATTERY_WINDOW_MS = Number(process.env.TRESORIT_BATTERY_WINDOW_MS) || 3_600_000;
const batteryWork = []; // what was read on battery lately: { at, bytes }
function batteryAllowance(size) {
  const cutoff = Date.now() - BATTERY_WINDOW_MS;
  while (batteryWork.length && batteryWork[0].at < cutoff) batteryWork.shift();
  const bytes = batteryWork.reduce((n, w) => n + w.bytes, 0);
  return batteryWork.length < BATTERY_DOCS_PER_HOUR && bytes + size <= BATTERY_BYTES_PER_HOUR;
}
async function easyNow() {
  if (!EASY_ON_BATTERY) return { battery: false, low: false };
  const p = await powerState();
  return { battery: p.battery, low: p.battery && p.percent !== null && p.percent < BATTERY_LOW_PERCENT };
}
function notePower(now) {
  if (now.battery && !bg.battery) log('INDEX', '(background)', 'on battery: reading only small amounts of new documents; large files, bulk reading and text recognition wait for mains power');
  if (!now.battery && bg.battery) log('INDEX', '(background)', 'resumed in full: the Mac is on mains power');
  bg.battery = now.battery; bg.low = now.low;
}

// The Claude app runs several copies of the connector at once. Only ONE of them does the background reading and
// text recognition (the "worker"); the others use the index it builds, which they pick up from disk. The worker
// is whichever copy holds a lock file in the index folder. If that copy stops, another takes over within a
// couple of minutes. What the worker is doing is written to a small file so that every copy reports the same.
const BG_STALE_MS = Number(process.env.TRESORIT_LOCK_STALE_MS) || 120000;
const bgLock = makeLock(path.join(DATA, 'index', 'background.lock'), { staleMs: BG_STALE_MS, beatMs: Math.min(15000, Math.max(250, Math.floor(BG_STALE_MS / 4))), onNote: (m) => log('NOTE', '', m) });
const BG_STATE_FILE = path.join(DATA, 'index', 'background.json');
const BG_REQUEST_FILE = path.join(DATA, 'index', 'rebuild.request');
let isWorker = false;
process.on('exit', () => bgLock.releaseNow());
// (One attempt at a time within this copy: a status request and a scheduled pass can both ask at the same moment.)
let becoming = null;
function becomeWorker() {
  if (!becoming) becoming = becomeWorkerNow().finally(() => { becoming = null; });
  return becoming;
}
async function becomeWorkerNow() {
  if (isWorker) {
    if (await bgLock.check()) return true;
    // This copy was held up for so long that another one took the work over. One worker is enough.
    isWorker = false;
    bg.deferred = 0; bg.deferredSmall = 0; bg.ocrDeferred = 0;
    log('INDEX', '(background)', 'another copy of the connector has taken over the background reading');
  }
  if (!bg.enabled || closing) return false;
  if (await bgLock.tryOnce('background reading')) {
    isWorker = true;
    log('INDEX', '(background)', 'this copy of the connector does the background reading');
  }
  return isWorker;
}
let bgPublished = 0;
function publishBg(force = false) {
  if (!isWorker) return;
  const now = Date.now();
  if (!force && now - bgPublished < 3000) return;
  bgPublished = now;
  try {
    const tmp = `${BG_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...bg, at: now, pid: process.pid, version: VERSION }));
    fs.renameSync(tmp, BG_STATE_FILE);
  } catch { /* only a report */ }
}
// The version of the copy that does the background reading when that is another copy and not of this version:
// as that copy published it, or '' when it published none (every version before 1.5.0). null when this copy does
// the reading, when no running copy holds it, when that copy has published nothing yet, or when it is of this
// version. (An extension of an earlier version left installed beside this one reads by its own rules.)
function otherVersionReading() {
  if (isWorker) return null;
  try {
    const holder = JSON.parse(fs.readFileSync(bgLock.file, 'utf8'));
    if (!holder || !Number.isInteger(holder.pid) || holder.pid === process.pid) return null;
    try { process.kill(holder.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
    const v = JSON.parse(fs.readFileSync(BG_STATE_FILE, 'utf8'));
    if (v.pid !== holder.pid) return null;
    const version = typeof v.version === 'string' ? v.version : '';
    return version === VERSION ? null : version;
  } catch { return null; }
}
// What the background reading is doing, whichever copy is doing it.
function bgView() {
  if (isWorker) return bg;
  try {
    const v = JSON.parse(fs.readFileSync(BG_STATE_FILE, 'utf8'));
    // a worker that stopped in mid-pass left "running" behind: that pass is over
    if (v.running && Date.now() - (v.at || 0) > 120000) v.running = false;
    return { ...bg, ...v, enabled: bg.enabled };
  } catch { return bg; }
}

async function indexPass() {
  if (bg.running || !ROOT) return;
  if (indexHold().all) return; // no list of folders not to index has been confirmed here yet: nothing is read
  if (!(await becomeWorker())) { index.refresh(true); return; } // another copy does this work
  if (bg.running) return;
  // Marked as running at once, before the next wait: a second request for a pass that arrives during that wait
  // (two timers falling together, or a timer and a rebuild) must not get through and start a second pass.
  bg.running = true; bg.phase = 'reading documents';
  try {
    bg.again = false;
    index.refresh(true); // start from everything the other copies have added
    await fsp.readdir(ROOT);
  } catch { bg.running = false; bg.phase = ''; return; } // the folder cannot be read now: no pass, and the mark is taken back
  bg.seen = 0; bg.extracted = 0; bg.cloudOnly = 0; bg.ocrTodo = 0; bg.ocrDone = 0; bg.onBatteryRead = 0;
  let deferred = 0; let deferredSmall = 0; let ocrDeferred = 0;
  const started = Date.now();
  try { notePower(await easyNow()); } catch { /* not known: treated as mains power */ }
  publishBg(true);
  const seen = new Set();
  const needOcr = [];
  const wantsOcr = (e, key) => Boolean(e && (e.o === 'pending' || (e.o === 'failed' && !ocrFailedThisRun.has(key))));
  try {
    // 1. Look at every document (names, sizes and dates only) and note which ones still have to be read.
    const todo = [];
    const knownBefore = new Set(index.map.keys()); // entries other copies add during the walk are not judged by it
    for await (const f of walk(ROOT)) {
      if (f.isDir) continue;
      const ext = extOf(f.name);
      if (!isExtractable(ext)) continue;
      if (isNoIndexRel(f.rel)) continue; // never read into the index
      let st;
      try { st = await fsp.stat(f.abs); } catch { continue; }
      const key = TextIndex.key(f.rel);
      seen.add(key);
      bg.seen++;
      if (cloudOnly(st)) { bg.cloudOnly++; continue; }
      const e = index.fresh(f.rel, st);
      if (!e || retryable(e, f.rel) || fromOlderVersion(e) || wasMomentary(e)) todo.push({ abs: f.abs, rel: f.rel, size: st.size, mtimeMs: st.mtimeMs });
      else if (wantsOcr(e, key)) needOcr.push({ abs: f.abs, rel: f.rel });
      if (bg.seen % 500 === 0) await sleep(1);
    }
    if (bg.seen > 0) for (const k of knownBefore) if (!seen.has(k)) index.remove(k);

    // 2. Read them. On mains power: all of them, in order. On battery: the newest first, within the allowance.
    let sortedForBattery = false;
    while (todo.length && !closing) {
      const now = await easyNow();
      notePower(now);
      let i = 0;
      if (now.battery) {
        if (now.low) break; // nothing more on a low battery
        if (!sortedForBattery) { todo.sort((a, b) => b.mtimeMs - a.mtimeMs); sortedForBattery = true; }
        i = todo.findIndex((t) => t.size <= BATTERY_MAX_FILE);
        if (i < 0 || !batteryAllowance(todo[i].size)) break; // the rest waits for mains power (or for the allowance)
      }
      const f = todo.splice(i, 1)[0];
      let st;
      try { st = await fsp.stat(f.abs); } catch { continue; }
      // Another copy may have read this file since the list was made (for instance, opened it with a password).
      index.refresh();
      const known = index.fresh(f.rel, st);
      if (known && !retryable(known, f.rel) && !fromOlderVersion(known) && !wasMomentary(known)) { if (wantsOcr(known, TextIndex.key(f.rel))) needOcr.push({ abs: f.abs, rel: f.rel }); continue; }
      if (now.battery) { batteryWork.push({ at: Date.now(), bytes: st.size }); bg.onBatteryRead++; }
      await getText(f.abs, f.rel, st, false);
      bg.extracted++;
      const e = index.fresh(f.rel, st);
      if (wantsOcr(e, TextIndex.key(f.rel))) needOcr.push({ abs: f.abs, rel: f.rel });
      publishBg();
      await sleep(15);
    }
    deferred = todo.length;
    // Search forms made under an earlier form are made again from the stored text (no document is read for it).
    const renewed = await index.refoldAll(() => closing);
    if (renewed) log('INDEX', '(background)', `the search form of ${renewed} document(s) was renewed from their stored text`);
    deferredSmall = todo.filter((t) => t.size <= BATTERY_MAX_FILE).length;
    index.save();
    if (bg.extracted) log('INDEX', '(background)', `${bg.extracted} document(s) read into the search index${bg.onBatteryRead ? ` (${bg.onBatteryRead} of them on battery)` : ''}`);
    if (deferred) log('INDEX', '(background)', `${deferred} document(s) wait for mains power${bg.low ? ' (the battery is low)' : ''}`);

    // 3. Text recognition for scanned PDFs: only on mains power.
    if (needOcr.length && ocr.enabled && !closing) {
      bg.phase = 'recognising text in scanned PDFs';
      bg.ocrTodo = needOcr.length;
      publishBg(true);
      for (const f of needOcr) {
        const now = await easyNow();
        notePower(now);
        if (now.battery) break;
        let st;
        try { st = await fsp.stat(f.abs); } catch { bg.ocrDone++; continue; }
        await runOcr(f.abs, f.rel, st, false);
        bg.ocrDone++;
        publishBg();
        if (ocr.engine === 'none') break; // nothing more can be done in this run
      }
      if (bg.battery) {
        ocrDeferred = bg.ocrTodo - bg.ocrDone;
        if (ocrDeferred) log('INDEX', '(background)', `text recognition for ${ocrDeferred} scanned PDF(s) waits for mains power`);
      }
      index.save();
    }
    bg.lastPass = Date.now();
    bg.lastDurationMs = bg.lastPass - started;
  } catch (e) {
    console.error('index pass failed:', e);
  } finally {
    bg.deferred = deferred; bg.deferredSmall = deferredSmall; bg.ocrDeferred = ocrDeferred;
    bg.running = false;
    bg.phase = '';
    publishBg(true);
    // The index was cleared while this pass was under way: what it had read before that is gone, so go round again.
    if (bg.again && !closing) { bg.again = false; setImmediate(() => indexPass().catch(() => {})); }
  }
}

// When something was left waiting for mains power, look now and then whether the Mac has been plugged in, and
// carry on straight away when it has (without waiting for the next regular pass). On battery, a new pass is
// also started as soon as the hourly allowance has room again.
if (EASY_ON_BATTERY) {
  const watch = setInterval(async () => {
    if (!isWorker || bg.running || closing || !(bg.deferred || bg.ocrDeferred)) return;
    try {
      const now = await easyNow();
      if (!now.battery) { indexPass(); return; }
      if (bg.deferredSmall && !now.low && batteryAllowance(0) && Date.now() - bg.lastPass > Math.min(BATTERY_WINDOW_MS / 6, 10 * 60 * 1000)) indexPass();
    } catch { /* try again later */ }
  }, POWER_POLL_MS);
  watch.unref?.();
}

// Housekeeping between the copies. A copy that is not the worker looks now and then whether the worker is still
// there, and takes over if it has stopped. The worker looks for a request, left by another copy, to rebuild the
// index from scratch.
async function rebuildIndex() {
  if (indexHold().all) return; // nothing could be read to fill the index again: it is left as it is
  await index.clear();
  ocrFailedThisRun.clear();
  log('INDEX', '(rebuild requested)');
  if (bg.running) bg.again = true; // the pass under way is followed by a complete one
  else indexPass();
}
if (bg.enabled) {
  const TAKEOVER_MS = Number(process.env.TRESORIT_BG_TAKEOVER_MS) || 120_000;
  const takeover = setInterval(() => { if (!isWorker && !closing && ROOT) indexPass().catch(() => {}); }, TAKEOVER_MS);
  takeover.unref?.();
  const requests = setInterval(async () => {
    if (!isWorker || closing) return;
    try {
      if (!fs.existsSync(BG_REQUEST_FILE)) return;
      fs.rmSync(BG_REQUEST_FILE, { force: true });
      await rebuildIndex();
    } catch { /* tried again next time */ }
  }, Number(process.env.TRESORIT_BG_HOUSEKEEP_MS) || 15_000);
  requests.unref?.();
}

export { BG_REQUEST_FILE, isWorker, becomeWorker, bgView, otherVersionReading, indexPass, rebuildIndex };
