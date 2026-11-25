// Tools: tresorit_list_unreadable, tresorit_unlock_folder.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UserError } from '../lib/paths.js';
import { TextIndex } from '../lib/textindex.js';
import { isExtractable } from '../lib/extract-core.js';
import { reasonOf, REASONS, REASON_LABEL } from '../lib/sniff.js';
import { displayText } from '../lib/textutil.js';
import {
  ROOT, log, R, index, isNoIndexRel, indexHold, cloudOnly, extOf, fmtSize, fmtDate, show, walk, fromOlderVersion, getText,
  askPassword, readWithPassword,
} from '../core/setup.js';
import { tool, RO } from '../core/server.js';
import { sha256Of } from './write.js';

// ---- tresorit_list_unreadable ---------------------------------------------------------------------------------------
const REASON_ARG = ['all', 'password', 'damaged', 'empty', 'unsupported', 'too_large', 'other', 'wrong_ending'];
// What the catalogue says about the documents under a folder: unreadable ones by reason, and readable ones whose
// ending does not match their content. Names, sizes and dates only; nothing is opened.
async function surveyUnreadable(baseAbs) {
  const out = { byReason: Object.fromEntries(REASONS.map((r) => [r, []])), wrongEnding: [], notRead: 0, opened: 0, total: 0 };
  for await (const f of walk(baseAbs)) {
    if (f.isDir || !isExtractable(extOf(f.name)) || isNoIndexRel(f.rel)) continue;
    let st; try { st = await fsp.stat(f.abs); } catch { continue; }
    if (cloudOnly(st)) continue;
    out.total++;
    const e = index.fresh(f.rel, st);
    if (!e) { out.notRead++; continue; }
    if (e.pw) out.opened++;
    const item = { rel: f.rel, size: st.size, mtimeMs: st.mtimeMs, note: e.n || '' };
    const why = reasonOf(e);
    if (why) (out.byReason[why] || out.byReason.other).push(item);
    if (e.mm) out.wrongEnding.push({ ...item, note: e.mm, readable: e.st === 'ok' || e.st === 'scan' || e.st === 'empty' });
  }
  return out;
}

tool('tresorit_list_unreadable', {
  title: 'List the files that could not be read',
  description: 'List the documents in Tresorit that the connector could not read, with path, size, date and the reason: password-protected, damaged, empty, content of a kind that cannot be read, too large. Also lists files whose ending does not match their content (for example a PNG image saved as .pdf); those are read by their content. Totals are grouped by reason. Names, sizes and dates only: nothing is opened. Folders set as "do not index" are not included.',
  inputSchema: {
    reason: z.enum(REASON_ARG).default('all').describe('Only this reason. wrong_ending = files whose ending does not match their content.'),
    path: z.string().default('').describe('Only inside this folder; "" for all of Tresorit'),
    limit: z.number().int().min(1).max(1000).default(100),
  },
  annotations: RO,
}, async ({ reason, path: p, limit }) => {
  const base = p ? R.resolve(p, { mustExist: true }) : { abs: ROOT, rel: '' };
  index.refresh(true);
  const sv = await surveyUnreadable(base.abs);
  const n = REASONS.reduce((k, r) => k + sv.byReason[r].length, 0);
  log('UNREADABLE', base.rel || '(all)', `${n} unreadable, ${sv.wrongEnding.length} with a wrong ending listed (reason: ${reason})`);
  const where = base.rel ? `in ${base.rel}` : 'in all of Tresorit';
  const head = [
    `${n} of ${sv.total} document(s) ${where} could not be read:`,
    ...REASONS.filter((r) => sv.byReason[r].length).map((r) => `  ${String(sv.byReason[r].length).padStart(5)}  ${REASON_LABEL[r]}`),
    `${sv.wrongEnding.length} file(s) have an ending that does not match their content (${sv.wrongEnding.filter((x) => x.readable).length} of them are read by their content).`,
    ...(sv.opened ? [`${sv.opened} password-protected PDF(s) have been opened with a password and are searchable.`] : []),
    ...(sv.notRead ? [`${sv.notRead} document(s) have not been read yet (${indexHold().all ? 'nothing new is read into the search index until the list of folders that are not to be indexed has been confirmed on this Mac' : 'the background reading has not reached them'}).`] : []),
  ];
  const key = reason === 'too_large' ? 'too-large' : reason;
  let items = [];
  if (reason === 'wrong_ending') items = sv.wrongEnding.map((x) => ({ ...x, tag: x.readable ? 'wrong ending, read by content' : 'wrong ending, not readable' }));
  else for (const r of REASONS) if (reason === 'all' || key === r) items.push(...sv.byReason[r].map((x) => ({ ...x, tag: REASON_LABEL[r] })));
  if (reason === 'all') items.push(...sv.wrongEnding.filter((x) => x.readable).map((x) => ({ ...x, tag: 'wrong ending, read by content' })));
  items.sort((a, b) => a.tag.localeCompare(b.tag) || a.rel.localeCompare(b.rel));
  const shown = items.slice(0, limit);
  return [...head, '', ...(shown.length ? shown.map((x) => `- [${x.tag}] ${show(x.rel)}   ${fmtSize(x.size)}   ${fmtDate(x.mtimeMs)}${x.note ? `   ${String(x.note).slice(0, 140)}` : ''}`) : ['Nothing to list for that choice.']),
    ...(items.length > shown.length ? [`...and ${items.length - shown.length} more${reason === 'all' ? ` (${items.slice(limit).filter((x) => !/^wrong ending/.test(x.tag)).length} that could not be read, ${items.slice(limit).filter((x) => /^wrong ending/.test(x.tag)).length} with a wrong ending that are read by their content)` : ''}. Narrow it with reason or path, or raise limit.`] : []),
    ...(sv.byReason.password.length ? ['', 'Password-protected PDFs can be read with tresorit_read_file (ask_password) or made searchable, a folder at a time, with tresorit_unlock_folder. The user types the password on their Mac; never ask for it in the conversation.'] : [])].join('\n');
});

// ---- tresorit_unlock_folder -----------------------------------------------------------------------------------------
const textFingerprint = (t) => sha256Of(Buffer.from(displayText(String(t || '')).replace(/--- Page \d+ of \d+(?: \(text read by OCR\))? ---/g, '').replace(/\s+/g, ' ').trim().toLowerCase(), 'utf8'));
tool('tresorit_unlock_folder', {
  title: 'Make password-protected PDFs in a folder searchable',
  description: 'Open the password-protected PDFs in a folder (or one file) with a password that THE USER TYPES IN A BOX ON THEIR MAC, and put their text into the search index so they can be searched and read like any other document. The password is never part of the conversation: do not ask the user for it and do not accept it in a message. It is used for this call and kept nowhere (not in the log, the index or any file). The files in Tresorit are not changed and no unlocked copies are made; only the extracted text is kept, in the search index on this Mac, like the text of every other document. Files that the password does not open are reported, so the tool can be called again for another password. Also reports any unprotected PDF in the same folder that looks like a copy of a protected one. Each Mac has its own index, so this is done once on each.',
  inputSchema: {
    path: z.string().describe('Folder (or a single PDF) in Tresorit'),
    recursive: z.boolean().default(true).describe('Also the folders inside it'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ path: p, recursive }, extra) => {
  if (indexHold().all) throw new UserError('Making a folder searchable is not available yet: nothing new is read into the search index until the list of folders that are not to be indexed has been confirmed on this Mac. Run tresorit_preflight: it asks for that at its end.');
  const t = R.resolve(p, { mustExist: true });
  if (isNoIndexRel(t.rel) || isNoIndexRel(`${t.rel}/x`)) throw new UserError(`"${t.rel}" is set as "do not index": its text is never kept. A single file there can be read once with tresorit_read_file and ask_password.`);
  const tst = await fsp.stat(t.abs);
  const files = [];
  if (tst.isFile()) files.push({ abs: t.abs, rel: t.rel });
  else for await (const f of walk(t.abs, recursive ? {} : { maxDepth: 1 })) { if (!f.isDir && extOf(f.name) === 'pdf' && !isNoIndexRel(f.rel)) files.push({ abs: f.abs, rel: f.rel }); if (files.length >= 5000) break; }
  // which of them are protected (reading the ones not looked at yet)
  const locked = [];
  for (const f of files) {
    let st; try { st = await fsp.stat(f.abs); } catch { continue; }
    if (cloudOnly(st) || extOf(f.rel) !== 'pdf') continue;
    let e = index.fresh(f.rel, st);
    if (!e || fromOlderVersion(e)) { await getText(f.abs, f.rel, st, true); e = index.fresh(f.rel, st); }
    if (e && reasonOf(e) === 'password') locked.push({ ...f, st });
  }
  if (!locked.length) { log('UNLOCK', t.rel, 'no password-protected PDF found'); return `No password-protected PDF was found in ${t.rel}${tst.isFile() ? '' : recursive ? ' or the folders inside it' : ''}.`; }
  const pw = await askPassword(`Password for ${locked.length} protected PDF(s) in "${t.rel}".\nIt is used now to make them searchable and is not kept.`);
  if (pw === null) { log('REFUSED', 'tresorit_unlock_folder', `${t.rel}: no password was entered`); throw new UserError(`No password was entered (the box on the Mac was cancelled or not answered). Nothing was opened. ${locked.length} protected PDF(s) are waiting in ${t.rel}.`); }
  if (extra && extra.signal && extra.signal.aborted) { log('REFUSED', 'tresorit_unlock_folder', `${t.rel}: withdrawn by the app while the password box was open; nothing was opened`); throw new UserError('This request was withdrawn by the app while the password box was open. Nothing was opened.'); }
  const opened = []; const wrong = []; const failed = [];
  for (const f of locked) {
    const res = await readWithPassword(f.abs, f.rel, f.st, pw, true);
    if ((opened.length + 1) % 20 === 0) index.save(); // what has been opened is kept even if the connector is stopped part-way
    if (res.wrongPassword) wrong.push(f.rel);
    else if (res.status === 'ok' || res.status === 'empty') opened.push({ ...f, text: res.text });
    else failed.push(`${f.rel}: ${res.note}`);
  }
  index.save();
  // an unprotected PDF beside a protected one, with the same text: probably an unlocked copy
  const alike = [];
  const byDir = new Map();
  for (const o of opened) { const d = path.posix.dirname(o.rel); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(o); }
  for (const [dir, list] of byDir) {
    const prints = new Map(list.filter((o) => o.text && o.text.trim().length > 40).map((o) => [textFingerprint(o.text), o.rel]));
    if (!prints.size) continue;
    let ents = []; try { ents = await fsp.readdir(path.join(ROOT, ...dir.split('/')), { withFileTypes: true }); } catch { ents = []; }
    for (const en of ents.slice(0, 2000)) {
      if (!en.isFile() || extOf(en.name) !== 'pdf') continue;
      const rel = path.posix.join(dir, en.name);
      if (list.some((o) => TextIndex.key(o.rel) === TextIndex.key(rel))) continue;
      let st; try { st = await fsp.stat(path.join(ROOT, ...rel.split('/'))); } catch { continue; }
      const e = index.fresh(rel, st);
      if (!e || e.st !== 'ok' || e.pw) continue;
      const txt = await index.readText(rel);
      const twin = txt ? prints.get(textFingerprint(txt)) : null;
      if (twin) alike.push(`- ${show(rel)}   looks like an unprotected copy of   ${show(twin)}`);
    }
  }
  log('UNLOCK', t.rel, `${opened.length} of ${locked.length} protected PDF(s) opened with a password entered on this Mac; their text is in the search index. ${wrong.length} not opened by it, ${failed.length} failed`);
  return [
    `${opened.length} of ${locked.length} password-protected PDF(s) in ${t.rel} were opened and are now searchable.`,
    'The files themselves are unchanged, no unlocked copies were made, and the password was not kept.',
    ...(wrong.length ? ['', `${wrong.length} were NOT opened by that password (call tresorit_unlock_folder again to try another one):`, ...wrong.slice(0, 40).map((r) => `- ${show(r)}`), ...(wrong.length > 40 ? [`...and ${wrong.length - 40} more.`] : [])] : []),
    ...(failed.length ? ['', `${failed.length} opened but could not be read:`, ...failed.slice(0, 20).map((r) => `- ${show(r)}`)] : []),
    ...(alike.length ? ['', 'Possible unlocked copies (same text, same folder). Nothing was changed; ask the user what to do with them:', ...alike.slice(0, 40)] : []),
    '', 'If one of these files changes, or the index is rebuilt, it has to be unlocked again. Each Mac has its own index.',
  ].join('\n');
});
