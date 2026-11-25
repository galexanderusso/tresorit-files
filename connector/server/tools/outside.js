// Tools: tresorit_list_outside_folder, tresorit_import_file, tresorit_export_file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { UserError, requireUsableNames } from '../lib/paths.js';
import { fingerprint, sameFingerprint, sha256File, takes } from '../lib/outside.js';
import {
  log, R, HOME, outside, blockedUnder, blockedAt, nameList, refuseLanding, fmtSize, fmtDate, show,
} from '../core/setup.js';
import { requireChecked } from '../core/turns.js';
import {
  newBatch, copyFresh, copyWhole, placeNew, moveRobust, saveManifest, measure, requireDepth,
} from '../core/changes.js';
import { tool, RO, RW } from '../core/server.js';
import { TOKEN_TTL_MS, confirmCopyOut } from './delete.js';
import { freeName } from './transfer.js';

// ---- tresorit_list_outside_folder / tresorit_import_file / tresorit_export_file ----------------------------------
const IMPORT_LIMIT = 20 * 1024 * 1024 * 1024;
const IMPORT_PREVIEW_BYTES = Number(process.env.TRESORIT_IMPORT_PREVIEW_BYTES) || 1024 * 1024 * 1024;
const pendingImports = new Map();

tool('tresorit_list_outside_folder', {
  title: 'List a folder on this Mac (names only)',
  description: 'Show the names, sizes and dates of what is in a folder OUTSIDE Tresorit on this Mac (by default Downloads), so that the right file can be found and brought in with tresorit_import_file. Nothing is opened or read. Hidden folders, the Library, applications and password or key stores cannot be listed.',
  inputSchema: {
    path: z.string().default('~/Downloads').describe('Full path of a folder on this Mac, e.g. ~/Downloads, ~/Desktop, /Volumes/USB'),
    sort: z.enum(['recent', 'name']).default('recent'),
    limit: z.number().int().min(1).max(500).default(60),
  },
  annotations: RO,
}, async ({ path: p, sort, limit }) => {
  const l = await outside.list(p, { limit, sort });
  log('OUTSIDE', l.dir, `${l.total} name(s) listed`);
  return [`Folder on this Mac (outside Tresorit): ${l.dir}   ${l.total} item(s)${l.total > l.items.length ? `, showing ${l.items.length} (${sort === 'recent' ? 'newest first' : 'by name'})` : ''}`,
    ...l.items.map((i) => `${i.isDir ? '[DIR] ' : '[FILE]'} ${show(i.name)}${i.isDir ? '/' : `   ${fmtSize(i.size)}`}   ${fmtDate(i.mtimeMs)}${i.note ? `   (${i.note})` : ''}`),
    ...(l.hidden ? [`(${l.hidden} hidden item(s) not shown)`] : [])].join('\n');
});

// Moves the original of an imported item into the holding area, where it stays until the user clears it.
async function holdOutside(batch, abs, isDir) {
  const dst = path.join(batch.dir, 'files', '_outside', path.basename(abs));
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  // As with everything that enters the holding area, the record comes first and the move second.
  batch.items.push({ original: abs, type: isDir ? 'folder' : 'file', outside: true });
  await saveManifest(batch);
  try {
    await moveRobust(abs, dst);
  } catch (e) {
    if (e.keepDestination) throw e;
    await fsp.rm(batch.dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

tool('tresorit_import_file', {
  title: 'Bring a file or folder into Tresorit from this Mac',
  description: 'Copy (or move) a file or folder from elsewhere on this Mac into Tresorit: from the home folder (Downloads, Desktop, Documents, iCloud Drive and so on) or an external drive. Give the full path as source, for example ~/Downloads/report.pdf, or only a file name to take it from Downloads (the exact name if there is one, otherwise the newest file whose name contains those words; the reply says which file was taken). Hidden folders, the Library, applications and password or key stores are refused. By default the file is COPIED and the original stays where it is. With mode "move", the original is taken away only after the copy has been checked, and is kept in the holding area so the move can be undone with tresorit_restore_deleted. A folder holding items that are never brought in (hidden items, links, applications, key stores, files with a name Tresorit does not sync) cannot be moved, only copied, so that those items are never lost; the reply lists them. Every copy is verified against the original. Nothing in Tresorit is overwritten unless overwrite is true. A folder, or anything very large, first returns a preview and a confirm_token: show the preview to the user and call again with the token only after they agree. The contents are not shown here; once the file is in Tresorit it can be read with tresorit_read_file.',
  inputSchema: {
    source: z.string().describe('Full path on this Mac (e.g. ~/Downloads/report.pdf, /Volumes/USB/folder), or just a file name to look for in Downloads'),
    destination: z.string().describe('Where to put it in Tresorit. For a file: a folder (a new one is created; end it with "/" to be explicit), or the full new path including the file name. A folder always goes inside the destination folder, keeping its own name'),
    mode: z.enum(['copy', 'move']).default('copy').describe('copy leaves the original in place; move takes it away after the copy is checked'),
    overwrite: z.boolean().default(false),
    allow_duplicate: z.boolean().default(false).describe('Bring the file in even if an identical file is already in the destination folder under another name'),
    confirm_token: z.string().optional().describe('The token from the preview of a folder or very large import. Only pass it after the user has agreed.'),
  },
  annotations: RW,
}, async ({ source, destination, mode, overwrite, allow_duplicate, confirm_token }) => {
  requireChecked('Bringing files into Tresorit');
  let pickedNote = '';
  let src;
  const typed = String(source).trim();
  if (typed && !typed.includes('/') && typed !== '~') {
    const f = await outside.findInDownloads(typed);
    src = outside.resolve(f.abs);
    pickedNote = `Taken from Downloads (${f.how}): ${path.basename(f.abs)}${f.others ? `. ${f.others} other item(s) there also matched "${typed}"; this is the newest.` : ''}`;
  } else {
    src = outside.resolve(typed);
  }
  const isDir = src.st.isDirectory();
  let d = R.resolve(destination);
  // Where exactly it lands. A folder always goes INTO the destination under its own name (the destination is
  // created if need be), so "put this folder in Finance/2026" can never rename the folder to "2026". A file goes
  // into the destination when that is a folder, when it ends with "/", or when it does not exist yet and its last
  // name has no extension; otherwise the destination is the file's new full name.
  const dIsDir = d.exists && (await fsp.stat(d.abs)).isDirectory();
  if (isDir && d.exists && !dIsDir) throw new UserError(`"${d.rel}" is a file, so a folder cannot be put inside it. Give a folder as the destination.`);
  const intoFolder = isDir || dIsDir || /\/\s*$/.test(String(destination)) || (!d.exists && path.extname(d.rel) === '' && path.extname(src.abs) !== '');
  if (intoFolder) d = R.resolve(path.posix.join(d.rel, path.basename(src.abs)));
  requireDepth(d.rel, 'Bringing something to the top level');
  requireUsableNames(d);

  let size;
  try { size = await fingerprint(src.abs, { filtered: true, hash: false }); } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') throw new UserError(`macOS did not allow reading "${src.abs}". Allow Claude to use that folder in System Settings > Privacy & Security > Files and Folders, then try again.`);
    throw e;
  }
  if (isDir && size.files === 0) throw new UserError('That folder contains no files that can be brought in.');
  if (isDir) await refuseLanding(src.abs, d.rel);
  // Some things in a folder are never brought in (hidden items, links, applications, key stores, and files with a
  // name Tresorit does not sync). With "move" the
  // whole original folder goes to the holding area, which clears itself: those items would then exist nowhere
  // else and be lost when it does. So such a folder is not moved. (System clutter like .DS_Store does not count.)
  const leftLines = (fp, n = 10) => [...fp.left.slice(0, n).map((x) => `- ${show(x.rel)}${x.dir ? '/' : ''}   (${x.why})`), ...(fp.leftCount > n ? [`...and ${fp.leftCount - Math.min(n, fp.left.length)} more.`] : [])];
  if (isDir && mode === 'move' && size.leftCount) {
    throw new UserError([
      `Nothing was moved. The folder ${src.abs} contains ${size.leftCount} item(s) that are never brought into Tresorit (hidden items, links, applications, password or key stores, names Tresorit does not sync):`,
      ...leftLines(size),
      'With "move" the whole original folder goes to the holding area, which clears itself after a while, so these items would be lost. Either call again with mode "copy" (the original folder then stays where it is, complete), or ask the user to take these items out of the folder first.',
    ].join('\n'));
  }
  const leftOutNote = (fp, future) => [
    ...(fp.leftCount ? [`${fp.leftCount} item(s) inside the folder ${future ? 'would be' : 'were'} left out and ${future ? 'would stay' : 'are'} only in the original folder (hidden items, links, applications, password or key stores, names Tresorit does not sync):`, ...leftLines(fp)] : []),
    ...(fp.junk ? [`${fp.junk} piece(s) of system clutter (such as .DS_Store) ${future ? 'would be' : 'were'} left out.`] : []),
  ];
  if (size.bytes > IMPORT_LIMIT) throw new UserError(`That is ${fmtSize(size.bytes)}; one import is limited to ${fmtSize(IMPORT_LIMIT)}. Bring it in parts.`);
  // Dataless files of a cloud drive (iCloud and others) exist by name only until they are downloaded.
  if (!isDir && src.st.size > 0 && src.st.blocks === 0 && /[\\/]Library[\\/](Mobile Documents|CloudStorage)[\\/]/.test(src.abs)) {
    throw new UserError(`"${src.abs}" is in a cloud drive and has not been downloaded to this Mac yet. Open it in Finder first, then try again.`);
  }

  if (d.exists) {
    const dst = await fsp.stat(d.abs);
    if (!isDir && dst.isFile() && dst.size === src.st.size && (await sha256File(d.abs)) === (await sha256File(src.abs))) {
      log('IMPORT', d.rel, `identical file already there; nothing copied (source ${src.abs})`);
      return `"${d.rel}" is already in Tresorit and is identical to ${src.abs}. Nothing was copied${mode === 'move' ? ', and the original was left where it is' : ''}.`;
    }
    if (!overwrite) throw new UserError(`"${d.rel}" already exists in Tresorit and is different. Choose another name, or set overwrite to true to replace it (the old one is kept in the holding area).`);
  } else if (!isDir && !allow_duplicate) {
    // The same file under another name in that folder (for example "report (1).pdf" next to "report.pdf").
    let ents = [];
    try { ents = await fsp.readdir(path.dirname(d.abs), { withFileTypes: true }); } catch { /* the folder does not exist yet */ }
    let srcHash = null; let compared = 0;
    for (const e of ents) {
      if (!e.isFile() || compared >= 25) continue;
      const pth = path.join(path.dirname(d.abs), e.name);
      let st;
      try { st = await fsp.stat(pth); } catch { continue; }
      if (st.size !== src.st.size) continue;
      compared++;
      srcHash = srcHash || await sha256File(src.abs);
      if ((await sha256File(pth)) === srcHash) {
        log('IMPORT', R.toRel(pth), `identical file already in the folder; nothing copied (source ${src.abs})`);
        return `An identical file is already in that folder as "${R.toRel(pth)}". Nothing was copied. To add this copy as well, call again with allow_duplicate set to true.`;
      }
    }
  }

  const needsPreview = isDir || size.bytes > IMPORT_PREVIEW_BYTES;
  const key = `${src.abs}\n${d.rel}\n${mode}`;
  for (const [tok, v] of pendingImports) if (v.expires < Date.now()) pendingImports.delete(tok);
  if (needsPreview && !confirm_token) {
    const token = crypto.randomBytes(4).toString('hex');
    pendingImports.set(token, { key, expires: Date.now() + TOKEN_TTL_MS });
    log('IMP-ASK', src.abs, `preview only: ${size.files} file(s), ${fmtSize(size.bytes)} to ${d.rel}`);
    return [
      'NOTHING HAS BEEN COPIED. This is a preview.',
      `Would ${mode} ${isDir ? 'the folder' : 'the file'} ${src.abs}`,
      `into Tresorit as ${d.rel}${isDir ? '/' : ''}: ${size.files} file(s)${isDir ? ` in ${size.folders} subfolder(s)` : ''}, ${fmtSize(size.bytes)}.`,
      ...leftOutNote(size, true),
      ...(pickedNote ? [pickedNote] : []),
      'It will be uploaded by Tresorit and synced to everyone that tresor is shared with.',
      '',
      `Show this to the user. Only after they agree, call tresorit_import_file again with the same arguments and confirm_token "${token}" (valid for 15 minutes).`,
    ].join('\n');
  }
  if (needsPreview) {
    const pend = pendingImports.get(confirm_token);
    if (!pend || pend.expires < Date.now()) throw new UserError('That confirm_token is unknown or has expired. Call tresorit_import_file without a token to get a fresh preview.');
    if (pend.key !== key) throw new UserError('The source, destination or mode does not match what was previewed for this token. Get a new preview.');
    pendingImports.delete(confirm_token);
  }

  const takesItem = async (from) => {
    if (from === src.abs) return true;
    if (!takes(path.basename(from))) return false;
    try { const st = await fsp.lstat(from); return st.isFile() || st.isDirectory(); } catch { return false; }
  };
  const plan = { d, aside: null };
  let got;
  await placeNew(plan, async (at) => {
    await copyFresh(src.abs, at, { filter: takesItem, mode: fs.constants.COPYFILE_FICLONE });
    // The copy must be exactly the original before it is put in place in Tresorit.
    const a = await fingerprint(src.abs, { filtered: true });
    const b = await fingerprint(at);
    if (!sameFingerprint(a, b)) throw new Error('the copy did not match the original (the original may have changed while it was being copied). Nothing was put into Tresorit; try again');
    got = a;
  });

  let originalNote = mode === 'move' ? '' : `The original is still at ${src.abs}.`;
  if (mode === 'move' && got.leftCount) {
    // (Something that is never brought in appeared in the folder while this was under way: the original stays.)
    originalNote = `The copy in Tresorit is complete and checked, but the original was NOT taken away: it now contains ${got.leftCount} item(s) that were not brought in and would otherwise be lost. It is still at ${src.abs}.`;
  } else if (mode === 'move') {
    try {
      const batch = await newBatch('imported');
      await holdOutside(batch, src.abs, isDir);
      originalNote = `The original was taken away from ${src.abs} and is kept in the holding area, batch ${batch.name} (tresorit_restore_deleted puts it back).`;
    } catch (e) {
      originalNote = `The copy in Tresorit is complete and checked, but the original could not be taken away (${e.message}). It is still at ${src.abs}.`;
    }
  }
  log('IMPORT', d.rel, `${mode === 'move' ? 'moved' : 'copied'} in from ${src.abs} (${got.files} file(s), ${fmtSize(got.bytes)}, verified)${plan.aside ? `; replaced item kept in ${plan.aside.name}` : ''}`);
  return [
    `Brought into Tresorit: ${d.rel}${isDir ? '/' : ''}   (${got.files} file(s), ${fmtSize(got.bytes)}; the copy was checked against the original)`,
    ...(pickedNote ? [pickedNote] : []),
    ...leftOutNote(got, false),
    ...(plan.aside ? [`The item that was at that place in Tresorit is kept in the holding area, batch ${plan.aside.name}.`] : []),
    originalNote,
  ].join('\n');
});

tool('tresorit_export_file', {
  title: 'Copy out to Downloads or Desktop',
  description: 'Copy a file or folder from Tresorit to the Downloads or Desktop folder on this Mac, for example to attach it to an email. It is always a copy: the original stays in Tresorit, and nothing in Downloads or Desktop is overwritten (a number is added to the name if needed). The copy is then outside Tresorit and no longer protected by it. A whole folder is copied out only after the user has agreed in a confirmation window on their Mac; if they decline or do not answer, nothing is copied.',
  inputSchema: {
    path: z.string().describe('File or folder in Tresorit'),
    to: z.enum(['Downloads', 'Desktop']).default('Downloads'),
  },
  annotations: RW,
}, async ({ path: p, to }) => {
  requireChecked('Copying files out to Downloads or Desktop');
  const t = R.resolve(p, { mustExist: true });
  requireDepth(t.rel, 'Copying out a whole tresor');
  const dir = outside.resolve(path.join(HOME, to), { forListing: true });
  if (!dir.st.isDirectory()) throw new UserError(`${to} is not a folder on this Mac.`);
  const m = await measure(t.abs);
  if (m.bytes > 2 * 1024 * 1024 * 1024) throw new UserError(`That is ${fmtSize(m.bytes)}; the limit for one copy out is 2 GB.`);
  // A whole folder leaves Tresorit only after the user's yes.
  const approved = (await fsp.stat(t.abs)).isDirectory() ? await confirmCopyOut([{ rel: t.rel, files: m.files, bytes: m.bytes }], to) : '';
  const name = await freeName(dir.abs, path.basename(t.abs));
  const dst = path.join(dir.abs, name);
  const noLinks = async (from) => { if (blockedAt(from)) return false; try { const st = await fsp.lstat(from); return st.isFile() || st.isDirectory(); } catch { return false; } };
  const leftOut = await blockedUnder(t.abs, t.rel);
  try {
    await copyWhole(t.abs, dst, { filter: noLinks });
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') throw new UserError(`macOS did not allow writing to ${to}. Allow Claude to use that folder in System Settings > Privacy & Security > Files and Folders, then try again.`);
    throw e;
  }
  log('EXPORT', t.rel, `copied out of Tresorit to ${dst} (${m.files} file(s), ${fmtSize(m.bytes)})${leftOut.length ? `; ${leftOut.length} blocked folder(s) inside it left out` : ''}${approved ? `; ${approved}` : ''}`);
  return `Copied ${t.rel} out of Tresorit to:\n${dst}\n(${m.files} file(s), ${fmtSize(m.bytes)}). The original is still in Tresorit. This copy is outside Tresorit and not encrypted by it.${leftOut.length ? `\nLeft out of the copy: ${leftOut.length} blocked folder(s) inside it (${nameList(leftOut)}). Blocked folders are never read or copied (set in the connector's settings).` : ''}`;
});
