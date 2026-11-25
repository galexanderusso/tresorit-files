// Tools: tresorit_read_file, tresorit_file_info, tresorit_recent_files.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/paths.js';
import { isExtractable, IMAGE_EXTS } from '../lib/extract-core.js';
import {
  log, R, index, ocr, isNoIndexRel, cloudOnly, sleep, extOf, fmtSize, fmtDate, show, extSet, walk, statMany,
  getText, askPassword, readWithPassword, openedOnce, onceKey, rememberOnce, runOcr,
} from '../core/setup.js';
import { measure } from '../core/changes.js';
import { tool, RO } from '../core/server.js';

// ---- tresorit_read_file -----------------------------------------------------------------------------------------
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const OCR_WAIT_MS = Number(process.env.TRESORIT_OCR_WAIT_MS) || 40_000;

tool('tresorit_read_file', {
  title: 'Read a file',
  description: 'Read a file from Tresorit. Documents come back as text: PDF (scanned PDFs through text recognition), Word (.docx, .doc), Excel (.xlsx, .xls), PowerPoint (.pptx, .ppt), Outlook messages (.msg) and text formats. Long documents are paged, so use offset to continue. Images (png, jpg, gif, webp) are shown directly. For other binary files use tresorit_export_to_transfer.',
  inputSchema: {
    path: z.string().describe('File path relative to the Tresorit folder'),
    offset: z.number().int().min(0).default(0).describe('Character position to start from (for long documents)'),
    max_chars: z.number().int().min(500).max(200000).default(60000),
    ask_password: z.boolean().default(false).describe('For a password-protected PDF: ask the user for its password in a box on their Mac (never in the conversation), and read it once. The text is not kept. To make a whole folder of protected PDFs searchable use tresorit_unlock_folder.'),
  },
  annotations: RO,
}, async ({ path: p, offset, max_chars, ask_password }, extra) => {
  const t = R.resolve(p, { mustExist: true });
  const st = await fsp.stat(t.abs);
  if (st.isDirectory()) throw new UserError(`"${t.rel}" is a folder. Use tresorit_list_folder.`);
  const ext = extOf(t.rel);
  if (IMAGE_EXTS.has(ext)) {
    if (st.size > 4 * 1024 * 1024) throw new UserError(`Image is ${fmtSize(st.size)}, too large to show here (limit 4 MB). Use tresorit_export_to_transfer.`);
    const data = await fsp.readFile(t.abs);
    log('READ', t.rel, `image, ${fmtSize(st.size)}`);
    return { content: [{ type: 'text', text: `${t.rel}   (${fmtSize(st.size)}, modified ${fmtDate(st.mtimeMs)})` }, { type: 'image', data: data.toString('base64'), mimeType: MIME[ext] }] };
  }
  if (!isExtractable(ext)) throw new UserError(`.${ext || '(no extension)'} files cannot be read as text. Use tresorit_export_to_transfer to copy it out for processing, or tresorit_file_info for its details.`);
  let res = await getText(t.abs, t.rel, st, true);
  let stillPending = false;
  if (res.status !== 'ok' && res.why === 'password' && extOf(t.rel) !== 'pdf' && ask_password) throw new UserError(`"${t.rel}" is a password-protected Office file. Only password-protected PDFs can be opened with a password.`);
  if (res.status !== 'ok' && res.why === 'password') {
    const kept = openedOnce.get(onceKey(t.rel, st));
    if (kept && kept.until > Date.now()) res = kept.res; // opened a moment ago: reading on in the same document
    else if (ask_password) {
      const pw = await askPassword(`Password for "${path.basename(t.rel)}" (in ${path.dirname(t.rel)}).\nIt is used to read this file once and is not kept.`);
      if (pw === null) { log('REFUSED', 'tresorit_read_file', `${t.rel}: no password was entered`); throw new UserError(`No password was entered for "${t.rel}" (the box on the Mac was cancelled or not answered). Nothing was read.`); }
      if (extra && extra.signal && extra.signal.aborted) { log('REFUSED', 'tresorit_read_file', `${t.rel}: withdrawn by the app while the password box was open; nothing was read`); throw new UserError('This request was withdrawn by the app while the password box was open. Nothing was read.'); }
      const opened = await readWithPassword(t.abs, t.rel, st, pw, false);
      if (opened.wrongPassword) { log('REFUSED', 'tresorit_read_file', `${t.rel}: the password entered does not open it`); throw new UserError(`The password entered does not open "${t.rel}". Nothing was read. Ask the user before trying again.`); }
      if (opened.status === 'ok') { rememberOnce(t.rel, st, opened); res = { status: 'ok', text: opened.text, note: `${opened.note}; read once, its text is not kept`, ocrPending: false }; }
      else res = { status: opened.status, text: '', note: opened.note, ocrPending: false };
    } else {
      log('READ', t.rel, 'password-protected, not opened');
      throw new UserError(`"${t.rel}" is password-protected. To read it, call tresorit_read_file again with ask_password set to true: the user is then asked for the password in a box on their Mac (never ask for it in the conversation). To make a whole folder of protected PDFs searchable, use tresorit_unlock_folder.`);
    }
  }
  if (res.ocrPending && ocr.enabled) {
    // Scanned pages: recognise them now, but do not keep the user waiting beyond a reasonable time.
    const finished = await Promise.race([runOcr(t.abs, t.rel, st, true).then(() => true, () => true), sleep(OCR_WAIT_MS).then(() => false)]);
    if (finished) res = await getText(t.abs, t.rel, st, true);
    stillPending = res.ocrPending && ocr.engine !== 'none' && !finished;
  }
  if (res.status === 'scan') {
    log('READ', t.rel, 'scanned PDF, text not available yet');
    if (!ocr.enabled) throw new UserError(`"${t.rel}" is a scanned PDF with no text layer, and text recognition is switched off in the connector settings.`);
    if (ocr.engine === 'none') throw new UserError(`"${t.rel}" is a scanned PDF with no text layer, and text recognition is unavailable on this computer (${ocr.detail}).`);
    const e2 = index.fresh(t.rel, st);
    if (e2 && e2.o === 'failed') throw new UserError(`"${t.rel}" is a scanned PDF and text recognition did not succeed on it (${e2.on || 'unknown reason'}).`);
    throw new UserError(`"${t.rel}" is a scanned PDF. Its text is still being recognised (this continues in the background). Try again in a minute.`);
  }
  if (res.status !== 'ok') {
    log('READ', t.rel, `no text: ${res.note}`);
    throw new UserError(`"${t.rel}" could not be read as text: ${res.note || res.status}.`);
  }
  const total = res.text.length;
  if (offset >= total && total > 0) throw new UserError(`offset ${offset} is past the end of the text (${total} characters).`);
  const chunk = res.text.slice(offset, offset + max_chars);
  const end = offset + chunk.length;
  log('READ', t.rel, `characters ${offset}-${end} of ${total}`);
  const notes = [res.note, res.ocrPending ? (stillPending ? 'some scanned pages are still being recognised and are missing from this text; read again shortly' : 'some scanned pages could not be recognised and are missing from this text') : ''].filter(Boolean);
  const head = `File: ${t.rel}   (${fmtSize(st.size)}, modified ${fmtDate(st.mtimeMs)})\n` +
    `Text: characters ${offset}-${end} of ${total}${end < total ? `. More remains: call tresorit_read_file again with offset ${end}.` : ' (complete).'}` +
    `${notes.length ? `\nNote: ${notes.join('; ')}` : ''}\n${'-'.repeat(60)}\n`;
  return head + chunk;
});

// ---- tresorit_file_info -----------------------------------------------------------------------------------------
tool('tresorit_file_info', {
  title: 'File or folder details',
  description: 'Size, dates and type of a file or folder in Tresorit. For a folder, also counts what is inside.',
  inputSchema: { path: z.string().default('') },
  annotations: RO,
}, async ({ path: p }) => {
  const t = R.resolve(p, { mustExist: true });
  const st = await fsp.stat(t.abs);
  log('INFO', t.rel || '(top level)');
  const lines = [`Path: ${t.rel || '(Tresorit top level)'}`, `On this Mac: ${t.abs}`];
  if (st.isDirectory()) {
    const m = await measure(t.abs);
    lines.push('Type: folder', `Contains: ${m.files} file(s) in ${m.folders} subfolder(s), ${fmtSize(m.bytes)} in total`);
  } else {
    const ext = extOf(t.rel);
    lines.push(`Type: file${ext ? ` (.${ext})` : ''}`, `Size: ${fmtSize(st.size)} (${st.size} bytes)`);
    if (cloudOnly(st)) lines.push('Storage: online only (not downloaded to this Mac; reading it downloads it)');
    const e = index.fresh(t.rel, st);
    let state;
    if (!isExtractable(ext)) state = 'not a searchable type';
    else if (isNoIndexRel(t.rel)) state = 'not indexed (this folder is set as "do not index"); it can still be read by name';
    else if (!e) state = 'not read yet';
    else if (e.st === 'ok') state = `searchable (${e.c} characters)${e.n ? `; ${e.n}` : ''}${e.o === 'pending' ? '; some scanned pages are waiting for text recognition' : ''}`;
    else if (e.st === 'scan') state = `scanned PDF, ${e.o === 'failed' ? `text recognition failed (${e.on || 'unknown reason'})` : 'waiting for text recognition'}`;
    else state = `no text (${e.n || e.st})`;
    lines.push(`Text search: ${state}`);
  }
  lines.push(`Created: ${fmtDate(st.birthtimeMs)}`, `Modified: ${fmtDate(st.mtimeMs)}`);
  return lines.join('\n');
});

// ---- tresorit_recent_files --------------------------------------------------------------------------------------
tool('tresorit_recent_files', {
  title: 'Recently changed files',
  description: 'List the files in Tresorit (or one folder) that were added or changed most recently.',
  inputSchema: {
    path: z.string().default(''),
    days: z.number().min(0.01).max(3650).default(7).describe('Look back this many days'),
    extensions: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(300).default(40),
  },
  annotations: RO,
}, async ({ path: p, days, extensions, limit }) => {
  const t = R.resolve(p, { mustExist: true });
  const exts = extSet(extensions);
  const cutoff = Date.now() - days * 86400000;
  const files = [];
  for await (const f of walk(t.abs)) {
    if (f.isDir) continue;
    if (exts && !exts.has(extOf(f.name))) continue;
    files.push(f);
  }
  await statMany(files);
  const res = files.filter((f) => f.st && f.st.mtimeMs >= cutoff).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  log('RECENT', t.rel || '(all of Tresorit)', `${res.length} file(s) in the last ${days} day(s)`);
  if (!res.length) return `Nothing changed in ${t.rel || 'Tresorit'} in the last ${days} day(s).`;
  return [`${res.length} file(s) changed in the last ${days} day(s)${res.length > limit ? `, showing the latest ${limit}` : ''}:`,
    ...res.slice(0, limit).map((f) => `${fmtDate(f.st.mtimeMs)}   ${show(f.rel)}   ${fmtSize(f.st.size)}`)].join('\n');
});
