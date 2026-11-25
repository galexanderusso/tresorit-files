// Text recognition (OCR) for scanned PDFs.
// Two engines: the Mac's built-in Vision framework (preferred: faster and more accurate) and a bundled engine
// that works anywhere. Whichever is used must first pass a self-test on a known sample page.
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OCR_DIR = path.join(HERE, '..', 'ocr');
const SELFTEST_PDF = path.join(OCR_DIR, 'selftest.pdf');
const VISION_SCRIPT = path.join(OCR_DIR, 'vision-ocr.js');
const SELFTEST_EXPECT = /48213/;
export const MAX_OCR_PAGES = 150;
const VISION_CHUNK = 6;                       // pages per helper process, keeps memory bounded
const VISION_LANGS = 'en-US,pt-BR,es-ES';
const BG_HOLD_MS = 3000;

export class Ocr {
  constructor({ enabled = true, force = 'auto' } = {}) {
    this.enabled = enabled;
    this.force = force;            // 'auto' | 'bundled' | 'mac'
    this.engine = null;            // 'vision' | 'bundled' | 'none'
    this.detail = '';
    this.ready = null;
    this.queue = [];
    this.current = null;
    this.worker = null;
    this.idleTimer = null;
    this.holdBgUntil = 0;
    this.holdTimer = null;
    this.seq = 0;
    this.pagesDone = 0;
  }

  describe() {
    if (!this.enabled) return 'switched off in settings';
    if (!this.engine) return 'not started yet (starts with the first scanned PDF)';
    if (this.engine === 'vision') return 'Mac built-in text recognition (passed its self-test)';
    if (this.engine === 'bundled') return `bundled engine (passed its self-test)${this.detail ? `; ${this.detail}` : ''}`;
    return `unavailable: ${this.detail}`;
  }

  ensureReady() {
    if (!this.ready) this.ready = this._choose();
    return this.ready;
  }

  async _choose() {
    if (!this.enabled) { this.engine = 'none'; this.detail = 'switched off in settings'; return; }
    let visionWhy = '';
    const visionPossible = (process.platform === 'darwin' || process.env.TRESORIT_VISION_CMD) && this.force !== 'bundled';
    if (visionPossible) {
      const r = await this._selfTest('vision');
      if (r.ok) { this.engine = 'vision'; return; }
      visionWhy = r.why;
    }
    if (this.force !== 'mac') {
      const r = await this._selfTest('bundled');
      if (r.ok) { this.engine = 'bundled'; this.detail = visionWhy ? `the Mac's own recognition was not used: ${visionWhy}` : ''; return; }
      this.detail = `${visionWhy ? `Mac recognition: ${visionWhy}; ` : ''}bundled engine: ${r.why}`;
    } else this.detail = `Mac recognition: ${visionWhy || 'not available on this computer'}`;
    this.engine = 'none';
  }

  async _selfTest(engine) {
    try {
      const run = engine === 'vision' ? this._runVision(SELFTEST_PDF, [1]) : this._runBundled(SELFTEST_PDF, [1]);
      const timer = setTimeout(() => run.cancel(), 90_000);
      let pages;
      try { pages = await run.promise; } finally { clearTimeout(timer); }
      if (SELFTEST_EXPECT.test(pages[1] || '')) return { ok: true };
      return { ok: false, why: 'the self-test page was not read correctly' };
    } catch (e) {
      return { ok: false, why: String((e && e.message) || e).slice(0, 160) };
    }
  }

  // ---- Mac Vision, through a small helper script run by osascript -------------------------------------------
  _runVision(abs, pages) {
    let child = null;
    let cancelled = false;
    const override = process.env.TRESORIT_VISION_CMD ? JSON.parse(process.env.TRESORIT_VISION_CMD) : null;
    const once = (chunk) => new Promise((resolve, reject) => {
      const cmd = override ? override[0] : '/usr/bin/osascript';
      const args = override ? [...override.slice(1), abs, chunk.join(','), VISION_LANGS] : ['-l', 'JavaScript', VISION_SCRIPT, abs, chunk.join(','), VISION_LANGS];
      child = execFile(cmd, args, { timeout: 60_000 + chunk.length * 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
        child = null;
        if (err) return reject(new Error(cancelled ? 'cancelled' : `helper failed: ${String(err.message).split('\n')[0].slice(0, 120)}`));
        let parsed;
        try { parsed = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { return reject(new Error('helper returned an unreadable answer')); }
        if (!parsed || parsed.error || typeof parsed.pages !== 'object') return reject(new Error(parsed && parsed.error ? String(parsed.error).slice(0, 120) : 'helper returned no pages'));
        resolve(parsed.pages);
      });
    });
    const promise = (async () => {
      const out = {};
      for (let i = 0; i < pages.length; i += VISION_CHUNK) {
        if (cancelled) throw new Error('cancelled');
        const chunk = pages.slice(i, i + VISION_CHUNK);
        const got = await once(chunk);
        for (const p of chunk) { out[p] = typeof got[p] === 'string' ? got[p] : ''; this.pagesDone++; }
      }
      return out;
    })();
    return { promise, cancel: () => { cancelled = true; try { child?.kill('SIGKILL'); } catch { /* ignore */ } } };
  }

  // ---- Bundled engine, in a worker thread ---------------------------------------------------------------------
  _ensureWorker() {
    if (this.worker) return this.worker;
    const langPath = path.join(OCR_DIR, 'lang'); // English and Portuguese language data, inside the bundle
    const w = new Worker(new URL('./ocr-worker.js', import.meta.url), { workerData: { langPath, innerWorkerPath: path.join(OCR_DIR, 'tess-inner.cjs') } });
    w.unref();
    this.worker = w;
    return w;
  }

  _killWorker() {
    const w = this.worker;
    this.worker = null;
    if (w) { try { w.terminate(); } catch { /* ignore */ } }
  }

  _runBundled(abs, pages, password) {
    let settle;
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      let w;
      try { w = this._ensureWorker(); } catch (e) { reject(e); return; }
      const onMessage = (msg) => {
        if (msg.id !== id) return;
        if (msg.progress) { this.pagesDone++; return; }
        cleanup();
        if (msg.ok) resolve(msg.pages); else reject(new Error(msg.error || 'recognition failed'));
      };
      const onError = (err) => { cleanup(); if (this.worker === w) this._killWorker(); reject(new Error(`engine stopped: ${String((err && err.message) || err).slice(0, 120)}`)); };
      const cleanup = () => { w.off('message', onMessage); w.off('error', onError); };
      settle = () => { cleanup(); reject(new Error('cancelled')); };
      w.on('message', onMessage);
      w.on('error', onError);
      w.postMessage({ id, abs, pages, ...(password ? { password } : {}) });
    });
    return { promise, cancel: () => { this._killWorker(); if (settle) settle(); } };
  }

  // ---- Queue ---------------------------------------------------------------------------------------------------
  // Resolves to { pages: {pageNumber: text}, engine } or rejects with a reason.
  // opts.password: for a password-protected PDF. Such a file is read by the bundled engine, inside the connector,
  // so that the password is never handed to another program; it is kept in memory for this request only.
  request(abs, pages, priority = false, opts = {}) {
    return new Promise((resolve, reject) => {
      const job = { abs, pages: pages.slice(0, MAX_OCR_PAGES), priority, resolve, reject, run: null };
      if (opts && opts.password) Object.defineProperty(job, 'password', { value: opts.password, enumerable: false });
      if (priority) {
        this.holdBgUntil = Date.now() + BG_HOLD_MS;
        const i = this.queue.findIndex((j) => !j.priority);
        if (i === -1) this.queue.push(job); else this.queue.splice(i, 0, job);
        if (this.current && !this.current.priority) {
          const bg = this.current;
          bg.preempted = true;
          bg.run?.cancel();
        }
      } else this.queue.push(job);
      this._next();
    });
  }

  pending() { return this.queue.length + (this.current ? 1 : 0); }

  async _next() {
    if (this.current || !this.queue.length) return;
    if (!this.queue[0].priority) {
      const wait = this.holdBgUntil - Date.now();
      if (wait > 0) {
        if (!this.holdTimer) { this.holdTimer = setTimeout(() => { this.holdTimer = null; this._next(); }, wait + 10); this.holdTimer.unref?.(); }
        return;
      }
    }
    const job = this.queue.shift();
    this.current = job;
    clearTimeout(this.idleTimer);
    try {
      await this.ensureReady();
      if (this.engine === 'none') throw new Error(`text recognition is unavailable (${this.detail})`);
      let pages;
      let used = this.engine;
      let passedOn = ''; // why the Mac's own recognition handed this file to the bundled engine, when it did
      const limit = setTimeout(() => job.run?.cancel(), 20 * 60_000);
      try {
        const viaVision = this.engine === 'vision' && !job.password;
        if (!viaVision) used = 'bundled';
        job.run = viaVision ? this._runVision(job.abs, job.pages) : this._runBundled(job.abs, job.pages, job.password);
        try {
          pages = await job.run.promise;
        } catch (e) {
          // If the Mac helper fails on a particular file, give the bundled engine a chance at it.
          if (viaVision && !job.preempted && this.force !== 'mac' && e.message !== 'cancelled') {
            passedOn = String(e && e.message || 'no reason given').replace(/\s+/g, ' ').slice(0, 120);
            job.run = this._runBundled(job.abs, job.pages);
            pages = await job.run.promise;
            used = 'bundled';
          } else throw e;
        }
      } finally { clearTimeout(limit); }
      this.current = null;
      if (job.priority) this.holdBgUntil = Date.now() + BG_HOLD_MS;
      job.resolve({ pages, engine: used, passedOn });
    } catch (e) {
      this.current = null;
      if (job.preempted) { job.preempted = false; job.run = null; this.queue.push(job); } // start again later
      else job.reject(e);
    }
    if (!this.queue.length && !this.current) {
      this.idleTimer = setTimeout(() => { if (!this.current) this._killWorker(); }, 90_000);
      this.idleTimer.unref?.();
    }
    this._next();
  }

  close() { this._killWorker(); }
}
