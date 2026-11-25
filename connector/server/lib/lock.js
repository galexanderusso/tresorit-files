// One change at a time across EVERY running copy of the connector.
//
// The Claude app starts several copies of the connector at once (one per window or session). Inside one copy,
// changes already wait their turn. This lock makes copies wait for each other as well, so that two windows
// changing the same place in Tresorit at the same instant can never overwrite each other unnoticed.
//
// The lock is a small file in the connector's data folder. It names the copy that holds it. A lock left behind
// by a copy that has stopped (Claude was closed, the Mac lost power) is recognised and cleared: either its
// process no longer exists, or it has stopped renewing the lock for a long time.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeChangeLock(dataDir, opts = {}) {
  return makeLock(path.join(dataDir, 'change.lock'), opts);
}

// The same kind of lock on any file. Also used so that only ONE copy of the connector does the background
// reading of documents, instead of every copy doing all of it again.
export function makeLock(file, { staleMs = 120000, beatMs = 2000, onNote = () => {} } = {}) {
  const breaker = `${file}.break`;
  const me = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const recheckMs = Math.min(3000, staleMs);
  let holding = false;
  let beat = null;
  let noted = false;
  let seq = 0;

  const processExists = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  const look = async () => {
    try {
      const st = await fsp.stat(file);
      let h = null;
      try { h = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { h = null; }
      return { st, h };
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };

  // Takes the lock if nobody holds it. The lock file appears with its content already in it (a link to a
  // finished file), so another copy never reads a half-written lock.
  async function tryTake(what) {
    const body = JSON.stringify({ id: me, pid: process.pid, what, since: Date.now() });
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    try {
      await fsp.writeFile(tmp, body, { mode: 0o600 });
      try { await fsp.link(tmp, file); return true; } catch (e) {
        if (e.code === 'EEXIST') return false;
        if (e.code !== 'ENOTSUP' && e.code !== 'EPERM' && e.code !== 'ENOSYS' && e.code !== 'EOPNOTSUPP') throw e;
      }
    } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
    // A disk that has no links: create the file directly (still fails if it exists).
    try { await fsp.writeFile(file, body, { flag: 'wx', mode: 0o600 }); return true; } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  }

  // Whether the lock seen in `seen` was left behind by a copy that has stopped.
  async function abandoned(seen) {
    const { st, h } = seen;
    if (h && h.id === me) return !holding; // ours from an earlier failure
    if (h && !processExists(h.pid)) return true;
    if (Date.now() - st.mtimeMs <= staleMs) return false;
    // Not renewed for a long time. A Mac that has just woken up looks like this for a moment, so look twice.
    await sleep(recheckMs);
    const again = await look();
    return Boolean(again) && again.st.mtimeMs === st.mtimeMs && (again.h ? again.h.id : null) === (h ? h.id : null);
  }

  // Clears an abandoned lock. Only one copy at a time may do this, and it looks again before removing, so a
  // lock that another copy has just taken is never removed by mistake.
  async function clearAbandoned(seen) {
    let fh = null;
    try { fh = await fsp.open(breaker, 'wx', 0o600); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { const b = await fsp.stat(breaker); if (Date.now() - b.mtimeMs > 10000) await fsp.rm(breaker, { force: true }); } catch { /* gone */ }
      return;
    }
    try {
      const now = await look();
      if (!now) return;
      const same = (now.h ? now.h.id : null) === (seen.h ? seen.h.id : null) && now.st.ino === seen.st.ino;
      if (same) await fsp.rm(file, { force: true });
    } finally {
      await fh.close().catch(() => {});
      await fsp.rm(breaker, { force: true }).catch(() => {});
    }
  }

  async function release() {
    if (!holding) return;
    holding = false;
    clearInterval(beat); beat = null;
    try {
      const now = await look();
      if (now && now.h && now.h.id === me) await fsp.rm(file, { force: true });
    } catch { /* nothing more to do */ }
  }

  // From the moment the lock is ours: keep renewing it, and hand back the function that gives it up.
  function held() {
    holding = true;
    beat = setInterval(() => {
      const t = new Date();
      fsp.readFile(file, 'utf8').then((c) => { if (holding && JSON.parse(c).id === me) return fsp.utimes(file, t, t); return null; }).catch(() => {});
    }, beatMs);
    beat.unref?.();
    return release;
  }

  // Takes the lock only if it is free (or was left behind by a copy that has stopped). Never waits for a copy
  // that is alive. Returns the function that gives the lock back, or null when another copy holds it.
  async function tryOnce(what) {
    if (holding) return release;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await tryTake(what)) return held();
        const seen = await look();
        if (!seen) continue;
        if (!(await abandoned(seen))) return null;
        await clearAbandoned(seen);
      }
    } catch (e) {
      if (!noted) { noted = true; onNote(`a lock shared between copies of the connector could not be used (${e.code || e.message})`); }
    }
    return null;
  }

  // Waits for the lock. `stop()` is asked regularly: when it says true the wait ends and null is returned.
  // `onWait(holder)` is told who is being waited for. Returns the function that gives the lock back.
  async function take(what, { stop = () => false, onWait = () => {} } = {}) {
    let pause = 15;
    for (;;) {
      if (stop()) return null;
      try {
        if (await tryTake(what)) return held();
        const seen = await look();
        if (seen) {
          if (await abandoned(seen)) { await clearAbandoned(seen); continue; }
          onWait(seen.h || {});
        }
      } catch (e) {
        // The lock is an extra protection between windows. If the data folder does not allow it at all, changes
        // still go ahead one at a time within this copy, and the log says so once.
        if (!noted) { noted = true; onNote(`the lock shared between Claude windows could not be used (${e.code || e.message}); changes are still made one at a time within this window`); }
        return async () => {};
      }
      await sleep(pause);
      pause = Math.min(200, Math.round(pause * 1.5));
    }
  }

  // Last resort when the process is stopping: do not leave our own lock behind.
  function releaseNow() {
    if (!holding) return;
    holding = false;
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).id === me) fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }

  // Is the lock still ours? A copy that was frozen for a long time (longer than the lock is trusted for) can
  // have had it taken over by another copy without knowing. If so, this copy stops acting as the holder.
  async function check() {
    if (!holding) return false;
    try {
      const now = await look();
      if (now && now.h && now.h.id === me) return true;
    } catch { return true; } // cannot tell right now: keep going, look again next time
    holding = false;
    clearInterval(beat); beat = null;
    return false;
  }

  return { take, tryOnce, check, releaseNow, file, holding: () => holding };
}
