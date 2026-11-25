// The only dealings the connector has with the rest of the Mac: bringing in a file or folder that the user asks
// for, listing names in a folder so the right file can be found, and placing copies in Downloads or Desktop.
// Contents of outside files are never returned to the conversation.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserError, foldName, isJunkName, unusableNameReason } from './paths.js';

// A Mac disk normally ignores capital letters and the two ways of encoding accents in names, so every comparison
// of places here ignores them too. (On a disk that does distinguish them this is merely stricter than needed.)
const fold = (p) => p.normalize('NFC').toLowerCase();
const under = (p, base) => { const a = fold(p); const b = fold(base); return a === b || a.startsWith(b + path.sep); };
const realOf = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };

// Folders that are really one application's private store, and files that hold passwords or keys.
const PACKAGE = /\.(app|photoslibrary|musiclibrary|tvlibrary|imovielibrary|aplibrary|lrcat|lrdata|keychain|keychain-db|agilekeychain|opvault|kdbx)$/i;

export function makeOutside({ home, roots, tresoritRoot, dataDir }) {
  const realHome = realOf(home) || path.normalize(home);
  const realRoots = roots.map((r) => realOf(r) || path.normalize(r));
  const realTresorit = tresoritRoot ? (realOf(tresoritRoot) || tresoritRoot) : null;
  const realData = realOf(dataDir) || dataDir;
  let homeDev = null;
  try { homeDev = fs.statSync(realHome).dev; } catch { homeDev = null; }

  // The disk of a path, taken from the nearest part of it that exists.
  function devOfNearest(p) {
    let cur = p;
    for (;;) {
      try { return fs.statSync(cur).dev; } catch { /* go up */ }
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }
  // Where a path really leads, whether or not the item exists: links are resolved in the part that exists and the
  // rest is appended as typed. The rules are applied to this BEFORE looking whether the item is there, so that a
  // refusal never reveals whether something exists in a protected place.
  function whereItLeads(norm) {
    let cur = norm;
    const rest = [];
    for (;;) {
      const r = realOf(cur);
      if (r) return rest.length ? path.join(r, ...rest.reverse()) : r;
      const up = path.dirname(cur);
      if (up === cur) return norm;
      rest.push(path.basename(cur));
      cur = up;
    }
  }

  // Why a place is off limits, or '' when it may be used. `real` is a path with all links already resolved.
  function protectedReason(real) {
    const root = realRoots.find((r) => under(real, r));
    if (!root) return 'it is outside your home folder and external drives';
    const tail = real.normalize('NFC').slice(root.normalize('NFC').length);
    if (tail && tail[0] !== path.sep) return 'it is outside your home folder and external drives';
    const parts = tail.split(path.sep).filter(Boolean);
    const low = parts.map((x) => x.toLowerCase());
    if (realTresorit && under(real, realTresorit)) return 'it is already inside Tresorit (use tresorit_move_item or tresorit_copy_item there)';
    if (under(real, realData)) return "it is in the connector's own data folder";
    const hidden = parts.find((x) => x.startsWith('.'));
    if (hidden) return /\.icloud$/i.test(hidden) ? 'it is in iCloud but not downloaded to this Mac yet (open it in Finder first)' : 'it is hidden, or inside a hidden folder';
    if (parts.some((x) => PACKAGE.test(x))) return 'it is an application, an application library, or a password or key store';
    if (fold(root) === fold(realHome)) {
      if (low[0] === 'applications') return 'it is in an Applications folder';
      if (low[0] === 'library') {
        // iCloud Drive and other cloud drives are where documents are kept; the rest of Library is application data.
        if (low[1] === 'cloudstorage' && low[2] && low[2].startsWith('tresorit')) return "it is in Tresorit's own drive view (work on the Tresorit folder itself instead)";
        // (Within "Mobile Documents" only iCloud Drive itself; its other folders are applications' own stores.)
        const icloudDrive = low[1] === 'mobile documents' && low[2] === 'com~apple~clouddocs';
        const cloudDrive = low[1] === 'cloudstorage' && parts.length >= 3;
        if (!icloudDrive && !cloudDrive) return 'it is in the Library folder, which holds application data, passwords and keys';
      }
    } else if (root === '/Volumes' && homeDev !== null) {
      // The Mac's own disk also shows up under /Volumes. Reached that way its Library and system folders would
      // escape the rules above, so it is only accepted through its normal path.
      // (Judged on the nearest folder that exists, so the answer is the same whether or not the item itself does.)
      const dev = devOfNearest(real);
      if (dev === null) return 'it could not be checked';
      if (dev === homeDev) return "it is on this Mac's own disk; use its normal path (for example ~/Documents/...) instead of going through /Volumes";
    }
    return '';
  }

  // Turns what was typed into a verified place on this Mac. `forListing` also accepts the home folder itself
  // and the list of external drives.
  function resolve(input, { forListing = false } = {}) {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new UserError('Give the full path of a file or folder on this Mac, for example ~/Downloads/report.pdf.');
    let p = input.trim();
    if (p === '~') p = home;
    else if (p.startsWith('~/')) p = path.join(home, p.slice(2));
    if (!path.isAbsolute(p)) throw new UserError(`"${input}" is not a full path. Give the full path on this Mac (for example ~/Downloads/report.pdf).`);
    let norm = path.normalize(p);
    if (norm.length > 1 && norm.endsWith(path.sep)) norm = norm.slice(0, -1);
    // The rules come first, and give the same answer whether or not the item exists. They are applied to the
    // place where the item is (links in the folders above it resolved), not to where a link at the very end
    // points: such a link, in a place that may be used, is simply refused as a link further down.
    const up = path.dirname(norm);
    const leads = up === norm ? norm : path.join(whereItLeads(up), path.basename(norm));
    const itself = realOf(norm);
    if (!realRoots.some((r) => fold(r) === fold(leads) || (itself && fold(r) === fold(itself)))) {
      const early = protectedReason(leads);
      if (early) throw new UserError(`"${input}" cannot be used: ${early}.`);
    }
    let lst;
    try { lst = fs.lstatSync(norm); } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') throw new UserError(`macOS did not allow access to "${input}". Allow Claude to use that folder in System Settings > Privacy & Security > Files and Folders, then try again.`);
      throw new UserError(`Not found on this Mac: "${input}".`);
    }
    if (lst.isSymbolicLink()) throw new UserError(`"${input}" is a link (alias) to something else, not the item itself. Give the path of the real file or folder.`);
    if (!lst.isFile() && !lst.isDirectory()) throw new UserError(`"${input}" is not a regular file or folder.`);
    // Lock files and system clutter ("~$budget.xlsx", "Thumbs.db") are hidden from every listing in Tresorit, so
    // bringing one in would leave a file there that can never be seen.
    // (Judged by the name as typed and by the name the disk reports: a disk may open the file under another spelling.)
    const real = realOf(norm);
    if (isJunkName(path.basename(norm)) || (real && isJunkName(path.basename(real)))) throw new UserError(`"${input}" is a temporary or system file of another program, not a document. It is not brought in.`);
    if (!real) throw new UserError(`"${input}" could not be verified (a link whose target cannot be checked, or no permission). Refused.`);
    const isRoot = realRoots.some((r) => fold(r) === fold(real));
    if (isRoot) {
      if (!forListing) throw new UserError(`"${input}" is a whole home folder or the list of drives. Choose a file or folder inside it.`);
      return { abs: real, st: lst, isRoot: true };
    }
    const why = protectedReason(real);
    if (why) throw new UserError(`"${input}" cannot be used: ${why}.`);
    // A folder that has Tresorit itself, or the connector's own data, somewhere inside it.
    if (!forListing && lst.isDirectory() && ((realTresorit && under(realTresorit, real)) || under(realData, real))) {
      throw new UserError(`"${input}" contains the Tresorit folder or the connector's data folder. Choose a folder that does not.`);
    }
    return { abs: real, st: lst, isRoot: false };
  }

  // Names, sizes and dates in a folder outside Tresorit. Nothing is opened.
  async function list(input, { limit = 200, sort = 'recent' } = {}) {
    const t = resolve(input, { forListing: true });
    if (!t.st.isDirectory()) throw new UserError(`"${input}" is a file, not a folder.`);
    let ents;
    try { ents = await fsp.readdir(t.abs, { withFileTypes: true }); } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') throw new UserError(`macOS did not allow access to "${input}". Allow Claude to use that folder in System Settings > Privacy & Security > Files and Folders, then try again.`);
      throw e;
    }
    const out = [];
    let hidden = 0;
    for (const e of ents) {
      if (e.name.startsWith('.') || isJunkName(e.name)) { hidden++; continue; }
      const abs = path.join(t.abs, e.name);
      let st;
      try { st = await fsp.lstat(abs); } catch { continue; }
      const item = { name: e.name, abs, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs, note: '' };
      if (st.isSymbolicLink()) item.note = 'link, cannot be brought in';
      else if (!st.isFile() && !st.isDirectory()) item.note = 'not a regular file';
      else { const why = protectedReason(realOf(abs) || abs); if (why) item.note = 'protected, cannot be brought in'; }
      out.push(item);
    }
    if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    else out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { dir: t.abs, total: out.length, hidden, items: out.slice(0, limit) };
  }

  // A bare file name means "the one in Downloads": the exact name if there is one, otherwise the newest whose
  // name contains every word given.
  async function findInDownloads(name) {
    const dir = path.join(home, 'Downloads');
    let listing;
    try { listing = await list(dir, { limit: 100000 }); } catch (e) {
      if (e instanceof UserError && /Not found/.test(e.message)) throw new UserError('There is no Downloads folder in the home folder on this Mac. Give the full path of the file instead.');
      throw e;
    }
    const usable = listing.items.filter((i) => !i.note);
    const want = foldName(name.trim());
    const exact = usable.filter((i) => foldName(i.name) === want);
    if (exact.length) return { abs: exact[0].abs, how: 'exact name', others: 0 };
    const words = want.split(/[\s._-]+/).filter(Boolean);
    const hits = usable.filter((i) => { const f = foldName(i.name); return words.length > 0 && words.every((w) => f.includes(w)); });
    if (!hits.length) throw new UserError(`Nothing in Downloads has a name matching "${name}". Use tresorit_list_outside_folder to see what is there, or give the full path.`);
    return { abs: hits[0].abs, how: 'newest match', others: hits.length - 1 };
  }

  return { resolve, list, findInDownloads, protectedReason, home: realHome };
}

export function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(abs);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// What an import takes from inside a folder: regular files and folders. Links, hidden items, system clutter,
// applications, application libraries and password or key stores are left where they are, and so is anything
// whose name Tresorit would not sync (it would sit in Tresorit on this computer only).
export const takes = (name) => !name.startsWith('.') && !isJunkName(name) && !PACKAGE.test(name) && !unusableNameReason(name);

// Every file below abs with its size and fingerprint. With `filtered`, the same rules as an import apply.
export async function fingerprint(abs, { filtered = false, hash = true } = {}) {
  const top = await fsp.lstat(abs);
  // skipped = everything left out; junk = the part of it that is system clutter (.DS_Store and the like);
  // leftCount / left = the rest, by name: items that matter to the user but are never brought in.
  const out = { files: 0, folders: 0, bytes: 0, skipped: 0, junk: 0, leftCount: 0, left: [], map: new Map() };
  if (top.isFile()) {
    out.files = 1; out.bytes = top.size;
    out.map.set('', { size: top.size, hash: hash ? await sha256File(abs) : '' });
    return out;
  }
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const ents = await fsp.readdir(path.join(abs, rel), { withFileTypes: true });
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(abs, r);
      const st = await fsp.lstat(p);
      if (filtered && (!takes(e.name) || st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()))) {
        out.skipped++;
        if (isJunkName(e.name)) out.junk++;
        else {
          out.leftCount++;
          const why = st.isSymbolicLink() ? 'a link' : PACKAGE.test(e.name) ? 'an application, application library or key store' : e.name.startsWith('.') ? 'hidden' : unusableNameReason(e.name) ? 'a name Tresorit does not sync' : 'not a regular file';
          if (out.left.length < 200) out.left.push({ rel: r, why, dir: st.isDirectory() });
        }
        continue;
      }
      if (st.isDirectory()) { out.folders++; stack.push(r); continue; }
      if (!st.isFile()) { out.map.set(r, { size: -1, hash: 'not-a-file' }); continue; }
      out.files++; out.bytes += st.size;
      out.map.set(r, { size: st.size, hash: hash ? await sha256File(p) : '' });
    }
  }
  return out;
}

export function sameFingerprint(a, b) {
  if (a.map.size !== b.map.size) return false;
  for (const [k, v] of a.map) {
    const w = b.map.get(k.normalize('NFC')) || b.map.get(k.normalize('NFD')) || b.map.get(k);
    if (!w || w.size !== v.size || w.hash !== v.hash) return false;
  }
  return true;
}
