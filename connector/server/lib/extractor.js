// Runs text-extraction jobs one at a time in a worker thread, so a slow or broken file can never freeze the
// connector. Jobs a user is waiting for ("priority") go ahead of background indexing and interrupt it.
import { Worker } from 'node:worker_threads';

const PRIORITY_TIMEOUT_MS = Number(process.env.TRESORIT_JOB_TIMEOUT_MS) || 45_000;
const BACKGROUND_TIMEOUT_MS = Number(process.env.TRESORIT_JOB_TIMEOUT_MS) || 60_000;
const SLEEP_SLACK_MS = 20_000;
const BACKGROUND_HOLD_MS = 2_000; // background work pauses this long after a user request
const IDLE_KILL_MS = Number(process.env.TRESORIT_IDLE_KILL_MS) || 120_000;
// A document that needs more memory than this to read is given up on (reported as unreadable) instead of
// being allowed to take the Mac's memory.
const WORKER_HEAP_MB = Number(process.env.TRESORIT_WORKER_HEAP_MB) || 1536;
// The worker is replaced by a fresh one, between documents, once it holds this much or has read this many.
const RECYCLE_HEAP_MB = Number(process.env.TRESORIT_WORKER_RECYCLE_MB) || 512;
const RECYCLE_JOBS = Number(process.env.TRESORIT_WORKER_RECYCLE_JOBS) || 2000;

const MOMENT_CODES = new Set(['EBUSY', 'EAGAIN', 'EIO', 'EPERM', 'EACCES', 'ETIMEDOUT', 'EDEADLK', 'EINTR', 'ESTALE', 'EMFILE', 'ENFILE', 'ENXIO', 'ECANCELED']);

export class Extractor {
  constructor() {
    this.queue = [];
    this.current = null;
    this.worker = null;
    this.seq = 0;
    this.holdBgUntil = 0;
    this.holdTimer = null;
    this.idleTimer = null;
    this.spawnFailures = 0;
    this.everWorked = false;
    this.inline = false; // fallback when worker threads are unavailable
    this.jobsDone = 0;   // documents read by the current worker
    this.recycled = 0;
  }

  _spawn() {
    const w = new Worker(new URL('./extract-worker.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    w.on('message', (msg) => {
      if (this.worker !== w) return;
      if (msg && msg.ready) { this.workerReady = true; return; }
      if (msg && msg.id == null) { this._heapReport(msg.heapMb || 0); return; }
      this._finish(msg);
    });
    w.on('error', (err) => { if (this.worker === w) this._crash(err, true); });
    w.unref();
    this.worker = w;
    this.jobsDone = 0;
    this.recycleAfterCurrent = false;
    this.workerReady = false; // set when the worker reports that it has loaded
  }

  _kill() {
    const w = this.worker;
    this.worker = null;
    if (w) { try { w.terminate(); } catch { /* ignore */ } }
  }

  _crash(err, workerFault = false) {
    const job = this.current;
    const diedWhileStarting = workerFault && !this.workerReady;
    this.current = null;
    this._kill();
    const outOfMemory = Boolean(err && err.code === 'ERR_WORKER_OUT_OF_MEMORY');
    if (diedWhileStarting) {
      // The worker stopped before it had even loaded, so the fault is not in the document. After three such
      // failures in a row worker threads evidently do not work here, and documents are read in-process instead.
      // The document that was waiting is not blamed: it is tried again.
      if (++this.spawnFailures >= 3) this.inline = true;
      if (job && (job.startRetries = (job.startRetries || 0) + 1) <= 3) {
        clearTimeout(job.timer);
        job.id = ++this.seq;
        this.queue.unshift(job);
        this._next();
        return;
      }
    }
    if (job && outOfMemory && !job.retried && this.jobsDone > 0) {
      // The worker ran out of memory after reading other documents: this document may be innocent.
      // It gets one more attempt, alone, in a fresh worker.
      clearTimeout(job.timer);
      job.retried = true;
      job.id = ++this.seq;
      this.queue.unshift(job);
      this._next();
      return;
    }
    if (job && outOfMemory) err = new Error('it needs more memory to open than the connector allows for one document');
    if (job) {
      clearTimeout(job.timer);
      // "transient": the failure may be down to the moment (a busy Mac, memory pressure) and not to the
      // document, so the connector tries the document again on a later occasion instead of writing it off.
      const transient = outOfMemory || Boolean(err && err.timedOut);
      job.resolve({ status: 'error', text: '', note: `could not be read: ${String((err && err.message) || err).slice(0, 200)}`, ...(transient ? { transient: true } : {}) });
    }
    this._next();
  }

  _finish(msg) {
    const job = this.current;
    if (!job || msg.id !== job.id) return; // reply from an interrupted job
    clearTimeout(job.timer);
    this.current = null;
    this.spawnFailures = 0;
    this.everWorked = true;
    this.jobsDone++;
    if (this.worker && (this.jobsDone >= RECYCLE_JOBS || this.recycleAfterCurrent)) { this._kill(); this.recycled++; }
    if (job.priority) this.holdBgUntil = Date.now() + BACKGROUND_HOLD_MS;
    if (msg.ok) job.resolve(msg.result);
    else {
      // A failure of the disk and not of the document (the file was missing, busy or not permitted at that
      // moment) says nothing lasting about the document. "gone": it was not there at all when it was opened, for
      // instance because it was just moved, deleted or replaced: that is never kept as a fact about the file.
      const gone = msg.code === 'ENOENT' || msg.code === 'ENOTDIR';
      const moment = gone || MOMENT_CODES.has(msg.code);
      job.resolve({ status: 'error', text: '', note: gone ? 'the file was not there at the moment it was read (it may just have been moved, deleted or replaced)' : `could not be read: ${msg.error}`, ...(moment ? { transient: true, why: 'other' } : {}), ...(gone ? { gone: true } : {}) });
    }
    this._next();
  }

  // Sent by the worker after each document, once it has tidied up: how much memory it still holds.
  _heapReport(heapMb) {
    this.lastHeapMb = heapMb;
    if (heapMb > RECYCLE_HEAP_MB && this.worker && !this.current) { this._kill(); this.recycled++; }
    else if (heapMb > RECYCLE_HEAP_MB && this.worker) this.recycleAfterCurrent = true;
  }

  _preempt() {
    const job = this.current;
    clearTimeout(job.timer);
    this.current = null;
    this._kill();
    job.id = ++this.seq;
    this.queue.push(job); // the background job starts again later
  }

  async _runInline(job) {
    try {
      const { extractFile } = await import('./extract-core.js');
      const result = await extractFile(job.abs, job.ext, job.size, job.password ? { password: job.password } : {});
      this._finish({ id: job.id, ok: true, result });
    } catch (e) {
      this._finish({ id: job.id, ok: false, error: String((e && e.message) || e).slice(0, 300) });
    }
  }

  // Lets the worker go after a quiet spell so the memory it used for large documents is returned.
  _armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.current && !this.queue.length) this._kill(); }, IDLE_KILL_MS);
    this.idleTimer.unref?.();
  }

  _next() {
    if (!this.current && !this.queue.length) { this._armIdle(); return; }
    if (this.current || !this.queue.length) return;
    if (!this.queue[0].priority) {
      const wait = this.holdBgUntil - Date.now();
      if (wait > 0) {
        if (!this.holdTimer) {
          this.holdTimer = setTimeout(() => { this.holdTimer = null; this._next(); }, wait + 10);
          this.holdTimer.unref?.();
        }
        return;
      }
    }
    const job = this.queue.shift();
    this.current = job;
    clearTimeout(this.idleTimer);
    if (this.inline) { this._runInline(job); return; }
    try {
      if (!this.worker) this._spawn();
    } catch {
      this.inline = true;
      this._runInline(job);
      return;
    }
    const limit = job.priority ? PRIORITY_TIMEOUT_MS : BACKGROUND_TIMEOUT_MS;
    const startedAt = Date.now();
    job.timer = setTimeout(() => {
      // If far more time has passed than the limit, the Mac was asleep in between: the document did not really
      // take that long, so it is simply started again.
      if (Date.now() - startedAt > limit + SLEEP_SLACK_MS && (job.sleepRetries = (job.sleepRetries || 0) + 1) <= 2) {
        this.current = null;
        this._kill();
        job.id = ++this.seq;
        this.queue.unshift(job);
        this._next();
        return;
      }
      const e = new Error(`timed out after ${Math.round(limit / 1000)} seconds`);
      e.timedOut = true;
      this._crash(e);
    }, limit);
    this.worker.postMessage({ id: job.id, abs: job.abs, ext: job.ext, size: job.size, ...(job.password ? { password: job.password } : {}) });
  }

  // opts.password: for a password-protected PDF; it travels to the reader in memory only and is kept nowhere.
  extract(abs, ext, size, priority = true, opts = {}) {
    return new Promise((resolve) => {
      const job = { id: ++this.seq, abs, ext, size, resolve, timer: null, priority };
      if (opts && opts.password) Object.defineProperty(job, 'password', { value: opts.password, enumerable: false }); // never shown if a job is printed
      if (priority) {
        this.holdBgUntil = Date.now() + BACKGROUND_HOLD_MS;
        const i = this.queue.findIndex((j) => !j.priority);
        if (i === -1) this.queue.push(job); else this.queue.splice(i, 0, job);
        if (this.current && !this.current.priority && !this.inline) this._preempt();
      } else {
        this.queue.push(job);
      }
      this._next();
    });
  }

  async close() {
    this._kill();
  }
}
