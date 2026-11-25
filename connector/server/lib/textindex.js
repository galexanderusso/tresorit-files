// Cache of extracted text, so searching inside documents is fast after the first pass.
// Stored on this Mac only, in the connector's own folder (outside Tresorit).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { displayText, foldText, SEARCH_FORM } from './textutil.js';

const CATALOG_VERSION = 3;

export class TextIndex {
  constructor(dir) {
    this.dir = dir;
    this.textDir = path.join(dir, 'text');
    this.catalogFile = path.join(dir, 'catalog.json');
    this.map = new Map();
    this.dirty = false;
    this.saveTimer = null;
    // Several copies of the connector share this index. Each keeps note of what it has changed itself since it
    // last looked at the catalog on disk (an entry, or null for a removal), and of what the catalog looked like
    // then. Saving merges its own changes into whatever the other copies have written meanwhile; see save().
    this.changed = new Map();
    this.synced = null;
    this.cleared = false;
    this.lastRefresh = 0;
    try {
      fs.mkdirSync(this.textDir, { recursive: true });
      this.synced = this._stamp();
      const raw = JSON.parse(fs.readFileSync(this.catalogFile, 'utf8'));
      if (raw && raw.v === CATALOG_VERSION && raw.entries) for (const [k, v] of Object.entries(raw.entries)) this.map.set(k, v);
      else this.stale = true; // written by an older version: rebuilt from scratch
    } catch { /* first run or unreadable catalog: start empty */ }
    if (this.stale) {
      try { fs.rmSync(this.textDir, { recursive: true, force: true }); fs.mkdirSync(this.textDir, { recursive: true }); } catch { /* ignore */ }
    }
    // Half-written files left behind if the connector was stopped abruptly (older than an hour, so that a second
    // running copy of the connector is never disturbed).
    try {
      const cutoff = Date.now() - 3_600_000;
      for (const name of fs.readdirSync(this.textDir)) {
        if (!name.endsWith('.tmp')) continue;
        const p = path.join(this.textDir, name);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  static key(rel) { return rel.normalize('NFC'); }
  _file(rel) { return path.join(this.textDir, crypto.createHash('sha1').update(TextIndex.key(rel)).digest('hex') + '.txt'); }
  // The same text prepared for searching (case and accents removed), so a search does not redo that work every time.
  _foldFile(rel) { return path.join(this.textDir, crypto.createHash('sha1').update(TextIndex.key(rel)).digest('hex') + '.fold'); }

  // Entry is "fresh" when the file has not changed since it was extracted.
  fresh(rel, stat) {
    const e = this.map.get(TextIndex.key(rel));
    if (!e) return null;
    if (e.s !== stat.size || Math.abs(e.m - stat.mtimeMs) > 1) return null;
    return e;
  }

  async readText(rel) {
    try { return await fsp.readFile(this._file(rel), 'utf8'); } catch { return null; }
  }

  // As bytes: a search first checks the bytes for the query and only turns a document into text when it matches,
  // which keeps a search over a large library fast and light on memory.
  async readFold(rel, entry) {
    if (!entry || !entry.f || (entry.fv || 1) !== SEARCH_FORM) return null; // made under an earlier form: see refold()
    try {
      const bytes = await fsp.readFile(this._foldFile(rel));
      return bytes.length === entry.f ? bytes : null;
    } catch { return null; }
  }

  async _writeWhole(file, bytes) {
    const tmp = `${file}.${process.pid}.${this.seq = (this.seq || 0) + 1}.tmp`;
    try {
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, file);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  // Makes the search form of a document again from its stored text, when it was made under an earlier form (or is
  // missing). The document itself is not read: what was unlocked with a password or recognised from a scan is
  // kept. Returns true when a search form was written.
  async refold(rel) {
    const key = TextIndex.key(rel);
    const e = this.map.get(key);
    if (!e || e.st !== 'ok' || (e.f && (e.fv || 1) === SEARCH_FORM)) return false;
    let text;
    try { text = await fsp.readFile(this._file(rel), 'utf8'); } catch { return false; }
    const fold = Buffer.from(foldText(displayText(text)), 'utf8');
    try { await fsp.unlink(this._foldFile(rel)).catch(() => {}); await this._writeWhole(this._foldFile(rel), fold); } catch { return false; }
    const cur = this.map.get(key);
    if (cur !== e) return false; // the entry changed meanwhile (the document was read again): that reading stands
    const next = { ...e, f: fold.length, fv: SEARCH_FORM };
    this.map.set(key, next);
    this.changed.set(key, next);
    this._touch();
    return true;
  }
  // The same for every document whose search form was made under an earlier form. stop() ends it early.
  async refoldAll(stop = () => false) {
    let done = 0;
    for (const [key, e] of [...this.map]) {
      if (stop()) break;
      if (e.st !== 'ok' || (e.f && (e.fv || 1) === SEARCH_FORM)) continue;
      if (await this.refold(key)) done++;
      if (done % 50 === 49) await new Promise((r) => setTimeout(r, 5));
    }
    return done;
  }

  // extra: { o: 'pending' | 'done' | 'failed', op: [pages awaiting text recognition], pg: page count }
  async put(rel, stat, result, extra = {}) {
    if (this.frozen) return; // a hold is in force (see "The safeguard" in core/setup.js): nothing new is taken in
    const entry = { s: stat.size, m: stat.mtimeMs, st: result.status, c: result.text ? result.text.length : 0, n: result.note || '', ...extra };
    if ((result.status === 'ok' || result.status === 'scan') && result.text) {
      try {
        // The search form is removed first and written last, each file is put in place whole or not at all, and
        // the catalog records the size the search form must have. If anything goes wrong in between (the Mac is
        // switched off, the disk is full), a search falls back to the full text instead of trusting a search
        // form that is incomplete or belongs to an older version of the text.
        await fsp.unlink(this._foldFile(rel)).catch(() => {});
        await this._writeWhole(this._file(rel), Buffer.from(result.text, 'utf8'));
        if (result.status === 'ok') {
          const fold = Buffer.from(foldText(displayText(result.text)), 'utf8');
          try { await this._writeWhole(this._foldFile(rel), fold); entry.f = fold.length; entry.fv = SEARCH_FORM; } catch { /* searched from the full text instead */ }
        }
      } catch { return; }
    } else {
      // A reading that failed. Several copies of the connector share this index, and another copy may have read
      // this same version of the file successfully in the meantime (above all: opened it with a password the
      // user typed, which the background reading does not have). A failure never replaces such a text.
      this.refresh(true);
      const cur = this.map.get(TextIndex.key(rel));
      if (this._goodFor(cur, entry, rel)) return;
      // Stored text is removed only when this index knows of one: text that another copy is just now writing
      // for a file not yet in the catalog is left alone.
      if (cur && (cur.st === 'ok' || cur.st === 'scan')) {
        fsp.unlink(this._file(rel)).catch(() => {});
        fsp.unlink(this._foldFile(rel)).catch(() => {});
      }
    }
    this.map.set(TextIndex.key(rel), entry);
    this.changed.set(TextIndex.key(rel), entry);
    this._touch();
  }

  remove(rel) {
    if (this.map.delete(TextIndex.key(rel))) {
      this.changed.set(TextIndex.key(rel), null);
      fsp.unlink(this._file(rel)).catch(() => {});
      fsp.unlink(this._foldFile(rel)).catch(() => {});
      this._touch();
    }
  }

  _touch() {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 5000);
      this.saveTimer.unref?.();
    }
  }

  // What the catalog on disk looks like right now (to notice that another copy has written it).
  _stamp() {
    try { const st = fs.statSync(this.catalogFile); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return 'none'; }
  }

  // The catalog as it is on disk, or null when there is none that can be used.
  _readDisk() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.catalogFile, 'utf8'));
      if (!raw || raw.v !== CATALOG_VERSION || !raw.entries) return null;
      return new Map(Object.entries(raw.entries));
    } catch { return null; }
  }

  // True when cur holds a readable text for exactly the version of the file that entry (a failed reading) is about.
  _goodFor(cur, entry, rel) {
    if (!cur || cur === entry || cur.st !== 'ok') return false;
    if (entry.st === 'ok' || entry.st === 'scan') return false;
    if (cur.s !== entry.s || Math.abs(cur.m - entry.m) > 1) return false;
    try { return fs.existsSync(this._file(rel)); } catch { return false; }
  }

  _applyOwnChanges(base) {
    for (const [k, v] of this.changed) {
      if (v === null) { base.delete(k); continue; }
      // another copy read this very version of the file while this copy's attempt failed: its text stands
      if (this._goodFor(base.get(k), v, k)) { this.changed.delete(k); continue; }
      base.set(k, v);
    }
    return base;
  }

  // Picks up what other copies of the connector have added to the index since this copy last looked. Cheap when
  // nothing has changed (one look at the file's date). Returns true when the index in memory was renewed.
  refresh(force = false) {
    const now = Date.now();
    if (this.cleared) return false; // a rebuild of the index is under way: what is on disk is being replaced
    if (!force && now - this.lastRefresh < 2000) return false;
    this.lastRefresh = now;
    const stamp = this._stamp();
    if (stamp === this.synced) return false;
    const disk = this._readDisk();
    this.synced = stamp;
    if (!disk) return false;
    this.map = this._applyOwnChanges(disk);
    return true;
  }

  // Whether the lock file f was left behind by a copy that has stopped.
  _lockAbandoned(f) {
    try {
      const pid = Number(fs.readFileSync(f, 'utf8'));
      if (pid > 0) { try { process.kill(pid, 0); return false; } catch (err) { return err.code !== 'EPERM'; } }
      return Date.now() - fs.statSync(f).mtimeMs > 2000; // created but never signed
    } catch { return false; } // gone meanwhile: just try again
  }

  // Clears an abandoned lock. Only one copy at a time may do this (it holds the ".break" marker meanwhile), and it
  // looks again before removing. Without that, two copies that both saw the same abandoned lock could each remove
  // it: the second would remove the lock the first had just taken, both would save at once, and one save would be
  // lost. Returns false when another copy is doing the clearing. (lib/lock.js guards the change lock the same way.)
  _clearAbandonedLock(f) {
    const breaker = `${f}.break`;
    let fd = null;
    try { fd = fs.openSync(breaker, 'wx'); } catch (e) {
      // A marker left by a copy that was stopped at that very instant is removed after a few seconds.
      if (e.code === 'EEXIST') { try { if (Date.now() - fs.statSync(breaker).mtimeMs > 5000) fs.rmSync(breaker, { force: true }); } catch { /* gone */ } }
      return false;
    }
    try {
      if (this._lockAbandoned(f)) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.rmSync(breaker, { force: true }); } catch { /* ignore */ }
    }
    return true;
  }

  // A very short lock while the catalog is rewritten, so that two copies saving at the same instant do not lose
  // each other's additions. If it cannot be had quickly the save goes ahead anyway: at worst a few documents are
  // read a second time later.
  _lockCatalog() {
    const f = `${this.catalogFile}.lock`;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const started = Date.now();
    while (Date.now() - started < 3000) {
      try {
        const fd = fs.openSync(f, 'wx');
        try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
        return f;
      } catch (e) {
        if (e.code !== 'EEXIST') return null;
        // Held by a copy that no longer exists (it was stopped in mid-save)? Then it is cleared at once.
        if (this._lockAbandoned(f)) { if (!this._clearAbandonedLock(f)) Atomics.wait(nap, 0, 0, 2); continue; }
        Atomics.wait(nap, 0, 0, 4);
      }
    }
    return null;
  }

  save() {
    if (!this.dirty) return;
    const lock = this._lockCatalog();
    try {
      // Merge: start from what is on disk now (other copies may have added to it), then apply this copy's own
      // changes. After a deliberate clearing of the index, what is on disk is not kept.
      if (!this.cleared && this._stamp() !== this.synced) {
        const disk = this._readDisk();
        if (disk) this.map = this._applyOwnChanges(disk);
      }
      const tmp = `${this.catalogFile}.${process.pid}.tmp`; // per process: two running copies never write the same file
      fs.writeFileSync(tmp, JSON.stringify({ v: CATALOG_VERSION, entries: Object.fromEntries(this.map) }));
      fs.renameSync(tmp, this.catalogFile);
      this.synced = this._stamp();
      this.changed.clear();
      this.cleared = false;
      this.dirty = false;
    } catch { /* best effort: tried again at the next change */ } finally {
      if (lock) { try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.rmSync(lock, { force: true }); } catch { /* ignore */ } }
    }
  }

  async clear() {
    this.map.clear();
    this.changed.clear();
    this.cleared = true;
    try { await fsp.rm(this.textDir, { recursive: true, force: true }); await fsp.mkdir(this.textDir, { recursive: true }); } catch { /* ignore */ }
    this.dirty = true;
    this.save();
  }

  counts() {
    const c = { ok: 0, empty: 0, error: 0, unsupported: 0, toolarge: 0, scan: 0, ocrPending: 0, ocrDone: 0, chars: 0 };
    for (const e of this.map.values()) {
      c[e.st] = (c[e.st] || 0) + 1;
      c.chars += e.c || 0;
      if (e.o === 'pending' || e.o === 'failed') c.ocrPending++;
      else if (e.o === 'done' && e.st === 'ok') c.ocrDone++;
    }
    return c;
  }
}
