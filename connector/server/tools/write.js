// Tools: tresorit_write_file, tresorit_edit_file, tresorit_create_folder.
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import { UserError, requireUsableNames } from '../lib/paths.js';
import { TEXT_EXTS } from '../lib/extract-core.js';
import { isValidUtf8 } from '../lib/textutil.js';
import { log, R, extOf, fmtSize } from '../core/setup.js';
import { requireChecked } from '../core/turns.js';
import { placeNew, rewriteWhole, setAside, requireDepth } from '../core/changes.js';
import { tool, RW } from '../core/server.js';

// ---- tresorit_write_file ----------------------------------------------------------------------------------------
tool('tresorit_write_file', {
  title: 'Create or replace a file',
  description: 'Write a file into Tresorit. Missing folders are created. An existing file is only replaced when overwrite is true, and its previous version is then kept in the holding area (see tresorit_list_deleted). Use encoding "base64" for very small binary files. For a document made in the chat use tresorit_receive_file (in parts, checked); for a file already on this Mac use tresorit_import_file.',
  inputSchema: {
    path: z.string().describe('Where to save, relative to the Tresorit folder, including the file name'),
    content: z.string().describe('The file content'),
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
    overwrite: z.boolean().default(false),
    sha256: z.string().regex(/^\s*[0-9a-fA-F]{64}\s*$/).optional().describe('Optional SHA-256 fingerprint (hex) of the file. If given, the file is saved only when it matches.'),
  },
  annotations: RW,
}, async ({ path: p, content, encoding, overwrite, sha256 }) => {
  requireChecked('Saving files');
  const t = R.resolve(p);
  requireDepth(t.rel, 'Writing a file');
  requireUsableNames(t);
  const data = encoding === 'base64' ? decodeBase64(content) : Buffer.from(content, 'utf8');
  if (data.length > 25 * 1024 * 1024) throw new UserError('Content is larger than 25 MB. Use tresorit_import_file for large files.');
  if (sha256 && sha256Of(data) !== sha256.trim().toLowerCase()) throw new UserError('The content did not arrive intact: its SHA-256 fingerprint does not match the one given. Nothing was saved; send it again.');
  return saveBytes(t, data, overwrite);
});

// Strict base64: anything that is not valid is refused instead of being silently skipped.
function decodeBase64(text) {
  const clean = String(text).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw new UserError('The content is not valid base64 (it may have been cut off or altered on the way). Nothing was saved; send it again.');
  return Buffer.from(clean, 'base64');
}
const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Saves bytes as a file in Tresorit. An existing file is replaced only on request, and is then kept in the
// holding area and put back if the save fails.
async function saveBytes(t, data, overwrite) {
  if (t.exists) {
    const st = await fsp.stat(t.abs);
    if (st.isDirectory()) throw new UserError(`"${t.rel}" is a folder.`);
    if (!overwrite) throw new UserError(`"${t.rel}" already exists. Choose another name, or set overwrite to true to replace it (the old version is kept).`);
  }
  const plan = { d: t, aside: null };
  await placeNew(plan, (at) => fsp.writeFile(at, data, { flag: 'wx' }));
  const { aside } = plan;
  log('WRITE', t.rel, `${fmtSize(data.length)}${aside ? `, replaced an existing file (previous version kept in ${aside.name})` : ', new file'}`);
  return `Saved ${t.rel} (${fmtSize(data.length)}).${aside ? ` The previous version is kept in the holding area, batch ${aside.name}.` : ''}`;
}

// ---- tresorit_edit_file -----------------------------------------------------------------------------------------
tool('tresorit_edit_file', {
  title: 'Edit a text file',
  description: 'Replace a passage in a plain-text file in Tresorit (md, txt, csv, json and similar). old_text must match exactly and only once unless replace_all is true. The version before the edit is kept in the holding area. Word, Excel and PDF files cannot be edited this way.',
  inputSchema: {
    path: z.string(),
    old_text: z.string().min(1),
    new_text: z.string(),
    replace_all: z.boolean().default(false),
  },
  annotations: RW,
}, async ({ path: p, old_text, new_text, replace_all }) => {
  requireChecked('Editing files');
  const t = R.resolve(p, { mustExist: true });
  const st = await fsp.stat(t.abs);
  if (st.isDirectory()) throw new UserError(`"${t.rel}" is a folder.`);
  const ext = extOf(t.rel);
  if (!TEXT_EXTS.has(ext) || ext === 'rtf') throw new UserError(`tresorit_edit_file works on plain-text files only, not .${ext}.`);
  if (st.size > 8 * 1024 * 1024) throw new UserError('File is too large to edit this way (limit 8 MB).');
  const raw = await fsp.readFile(t.abs);
  // Saving re-encodes the file as UTF-8, so a file in another encoding would have its accented characters damaged.
  if (!isValidUtf8(raw)) throw new UserError(`"${t.rel}" is not stored as UTF-8 text, so editing it here could damage accented characters. Read it and save a corrected copy with tresorit_write_file instead.`);
  const text = raw.toString('utf8');
  const n = text.split(old_text).length - 1;
  if (n === 0) throw new UserError('old_text was not found in the file. Read the file again and copy the passage exactly.');
  if (n > 1 && !replace_all) throw new UserError(`old_text appears ${n} times. Include more surrounding text to make it unique, or set replace_all to true.`);
  const next = replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text);
  const aside = await setAside(t.abs, t.rel, 'copy');
  try {
    await rewriteWhole(t.abs, Buffer.from(next, 'utf8'));
  } catch (e) {
    let back = false;
    try { await fsp.copyFile(aside.held, t.abs); back = true; } catch { /* reported below */ }
    throw new Error(`${e.message}. ${back ? 'The file was put back as it was.' : 'The file may be incomplete.'} The version before the edit is in the holding area, batch ${aside.name}.`);
  }
  log('EDIT', t.rel, `${n} replacement(s); previous version kept in ${aside.name}`);
  return `Edited ${t.rel}: ${n} replacement(s). The version before this edit is kept in the holding area, batch ${aside.name}.`;
});

// ---- tresorit_create_folder -------------------------------------------------------------------------------------
tool('tresorit_create_folder', {
  title: 'Create a folder',
  description: 'Create a folder inside a tresor (parent folders are created as needed). New tresors themselves are created in the Tresorit app.',
  inputSchema: { path: z.string() },
  annotations: { ...RW, idempotentHint: true },
}, async ({ path: p }) => {
  requireChecked('Creating folders');
  const t = R.resolve(p);
  requireDepth(t.rel, 'Creating a folder');
  requireUsableNames(t);
  if (t.exists) {
    const st = await fsp.stat(t.abs);
    if (!st.isDirectory()) throw new UserError(`A file named "${t.rel}" already exists.`);
    return `Folder already exists: ${t.rel}/`;
  }
  await fsp.mkdir(t.abs, { recursive: true });
  log('MKDIR', t.rel);
  return `Created folder ${t.rel}/`;
});

export { decodeBase64, sha256Of, saveBytes };
