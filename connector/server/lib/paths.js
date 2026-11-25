// Path safety: every path the model supplies is resolved here and must stay inside the Tresorit folder.
import path from 'node:path';
import fs from 'node:fs';

export class UserError extends Error {}

// System clutter and the lock files of other programs: never shown, never searched and never brought in. The five
// exact names (.DS_Store, desktop.ini, Thumbs.db, Icon\r, .localized) count whatever their capitals: a Mac's disk
// opens "Thumbs.db" when "THUMBS.DB" is typed, and a disk may hold the file under either spelling.
const SKIP_EXACT = new Set(['.ds_store', 'desktop.ini', 'thumbs.db', 'icon\r', '.localized']);

export function isJunkName(name) {
  return SKIP_EXACT.has(name.toLowerCase()) || name.startsWith('._') || /^\.tresorit/i.test(name) || name.startsWith('~$');
}

// Names that nothing new inside Tresorit may be given.
//  - Tresorit does not sync them: the lists "Junk files" and "Ignored files" of its page "Files excluded from sync"
//    (https://support.tresorit.com/hc/en-us/articles/216114257, as read on 23 November 2026): desktop.ini,
//    Thumbs.db, .DS_Store, Icon\r, ~$*, .~*, ._*, *.tmp, *.onetmp, *.kate-swp, and .tresorit, .VolumeIcon.icns,
//    System Volume Information, $RECYCLE.BIN, *.lnk, *.crdownload, *.part_*. A file saved under such a name would
//    stay on this computer only, while the connector had answered that it was saved.
//  - Or the connector itself leaves them out of its lists and searches: system clutter (isJunkName) and names
//    that begin with a dot.
// Judged whatever the capitals. Returns the reason in words, or '' when the name can be used.
const UNSYNCED_EXACT = new Set(['desktop.ini', 'thumbs.db', '.ds_store', 'icon\r', '.tresorit', '.volumeicon.icns', 'system volume information', '$recycle.bin']);
const UNSYNCED_FORM = /^~\$|^\.~|^\._|\.tmp$|\.onetmp$|\.kate-swp$|\.lnk$|\.crdownload$|\.part_/;
export function unusableNameReason(name) {
  const n = String(name).toLowerCase();
  if (UNSYNCED_EXACT.has(n) || UNSYNCED_FORM.test(n)) return 'Tresorit does not sync anything with such a name (it treats it as a temporary or system file), so it would stay on this Mac only and never reach the cloud or your other devices';
  if (isJunkName(name) || n.startsWith('.')) return 'the connector leaves names like this out of its lists and searches (hidden and system files), so it could not be found again';
  return '';
}

// Refuses a place inside Tresorit when one of its new names (those that do not exist yet) cannot be used.
// t is what the resolver returned. What already exists under such a name can still be read, replaced and deleted.
export function requireUsableNames(t) {
  for (const name of t.fresh || []) {
    const why = unusableNameReason(name);
    if (why) throw new UserError(`"${name}" cannot be used as a name in Tresorit: ${why}. Choose another name.`);
  }
}

export function foldName(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// The comparison used for the folders named in the settings (blocked, "do not index"). Like foldName it ignores
// capitals and accents, and it also treats as one name every pair of spellings that a Mac's disk treats as one:
// "ß" and "ss", the long "ſ" and "s", the joined "ﬁ" and "fi", the two small Greek sigmas, "µ" and "μ", and so on.
// Without this, a folder the disk regards as the blocked one could be reached, or created, under such a spelling.
// (Capitals and back, repeated until nothing changes, is how those spellings are brought to one form: "ẞ" becomes
// "ß" in the first round and "ss" in the second.)
export function foldPlace(s) {
  let f = s.normalize('NFD');
  for (let i = 0; i < 4; i++) {
    const n = f.toUpperCase().toLowerCase().normalize('NFD');
    if (n === f) break;
    f = n;
  }
  return f.replace(/[̀-ͯ]/g, '').replace(/ς/g, 'σ');
}

// Whether something named rel (as typed in the settings) exists below root, matched the way the settings are
// matched (foldPlace): capitals, accents and the spellings a Mac's disk treats as one do not matter. Links are not
// followed. Used to warn when a name under "Blocked folders" matches nothing, so that a slip of the keyboard does
// not leave a folder unprotected without anyone noticing.
export function existsAsNamed(root, rel) {
  let level = [root];
  for (const want of String(rel).split('/').filter(Boolean).map((p) => foldPlace(p))) {
    const next = [];
    for (const dir of level) {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) if (!e.isSymbolicLink() && foldPlace(e.name) === want) next.push(path.join(dir, e.name));
    }
    if (!next.length) return false;
    level = next;
  }
  return true;
}

export function makeResolver(ROOT, blocked = []) {
  const blockedFolded = blocked.map((b) => foldPlace(b.split(path.sep).join('/')));

  function toRel(abs) {
    const r = path.relative(ROOT, abs);
    return r.split(path.sep).join('/');
  }

  function isBlockedRel(rel) {
    if (!blockedFolded.length) return false;
    const f = foldPlace(rel);
    return blockedFolded.some((b) => f === b || f.startsWith(b + '/'));
  }

  function inside(abs) {
    return abs === ROOT || abs.startsWith(ROOT + path.sep);
  }

  // Returns an absolute path guaranteed to be inside ROOT (after resolving symlinks on the existing part).
  function resolve(input, { mustExist = false } = {}) {
    if (input == null) input = '';
    if (typeof input !== 'string') throw new UserError('Path must be text.');
    if (input.includes('\0')) throw new UserError('Invalid path.');
    let p = input.trim();
    if (p === '' || p === '.' || p === '/') p = '';
    if (p === '~' || p.startsWith('~/')) throw new UserError('Paths are relative to the Tresorit folder; "~" is not allowed.');

    let abs;
    if (path.isAbsolute(p)) {
      const norm = path.normalize(p);
      if (inside(norm)) abs = norm;
      else abs = path.normalize(path.join(ROOT, p)); // treat "/Tresor/x" as root-relative
    } else {
      abs = path.normalize(path.join(ROOT, p));
    }
    if (abs.length > 1 && abs.endsWith(path.sep)) abs = abs.slice(0, -1);
    if (!inside(abs)) throw new UserError(`"${input}" is outside the Tresorit folder. The connector only works inside it.`);

    // Resolve symlinks on the deepest existing ancestor and re-check containment.
    let existing = abs;
    const tail = [];
    for (;;) {
      try {
        fs.lstatSync(existing);
        break;
      } catch {
        if (existing === ROOT) break;
        tail.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    let real;
    try {
      real = fs.realpathSync.native(existing);
    } catch {
      // The path exists but where it really leads cannot be established (broken or looping link, no permission).
      throw new UserError(`"${input}" could not be verified as being inside the Tresorit folder (a link whose target cannot be checked, or no permission). Refused.`);
    }
    if (!inside(real)) throw new UserError(`"${input}" resolves outside the Tresorit folder (it goes through a link). Refused.`);
    const finalAbs = tail.length ? path.join(real, ...tail) : real;
    if (!inside(finalAbs)) throw new UserError(`"${input}" is outside the Tresorit folder.`);

    const rel = toRel(finalAbs);
    if (isBlockedRel(rel)) throw new UserError(`"${rel}" is in a blocked folder (set in the connector's settings).`);
    if (mustExist && tail.length) throw new UserError(`Not found: "${rel}". Use find_files or list_folder to locate it.`);
    return { abs: finalAbs, rel, exists: tail.length === 0, fresh: tail }; // fresh: the names on the way that do not exist yet
  }

  return { resolve, toRel, isBlockedRel, inside };
}
