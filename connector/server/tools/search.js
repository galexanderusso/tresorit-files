// Tool: tresorit_search_contents.
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { z } from 'zod';
import { UserError } from '../lib/paths.js';
import { isExtractable } from '../lib/extract-core.js';
import { displayText, foldText } from '../lib/textutil.js';
import { handled } from '../lib/tidy.js';
import {
  log, R, index, ocr, isNoIndexRel, indexHold, notIndexedNames, cloudOnly, extOf, fmtSize, fmtDate, show, extSet, walk, statMany,
  getText,
} from '../core/setup.js';
import { tool, RO } from '../core/server.js';

// ---- tresorit_search_contents -----------------------------------------------------------------------------------
function countAll(hay, needle, cap = 5000) {
  const pos = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && pos.length < cap) { pos.push(i); i = hay.indexOf(needle, i + Math.max(needle.length, 1)); }
  return pos;
}

function snippet(display, at, len) {
  const a = Math.max(0, at - 110);
  const b = Math.min(display.length, at + len + 150);
  return `${a > 0 ? '...' : ''}${display.slice(a, b).trim()}${b < display.length ? '...' : ''}`;
}

// A badly formed pattern can take practically forever on some texts; run it where it can be interrupted.
const REGEX_SCRIPT = new vm.Script('rx.lastIndex = 0; var m, g = 0; while ((m = rx.exec(text)) && g++ < 2000) { out.push([m.index, Math.max(m[0].length, 1)]); if (m[0].length === 0) rx.lastIndex++; }');
let regexBox = null; // one sandbox, reused: creating one per document is slow and holds on to memory
function regexPositions(rx, text) {
  if (!regexBox) regexBox = vm.createContext({ rx: null, text: '', out: [] });
  const out = [];
  regexBox.rx = rx; regexBox.text = text; regexBox.out = out;
  try {
    REGEX_SCRIPT.runInContext(regexBox, { timeout: 1500 });
  } catch (e) {
    regexBox = null; // an interrupted run is never reused
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new UserError('That pattern takes too long to evaluate on these documents. Use a simpler pattern, or a phrase or word search.');
    throw e;
  } finally {
    if (regexBox) { regexBox.rx = null; regexBox.text = ''; regexBox.out = null; }
  }
  return out;
}

const SEARCH_LIMIT_MS = Number(process.env.TRESORIT_SEARCH_LIMIT_MS) || 40_000; // a search always answers within this

tool('tresorit_search_contents', {
  title: 'Search inside documents',
  description: 'Full-text search inside files in Tresorit: PDF (including scanned PDFs once their text has been recognised), Word (.docx, .doc), Excel (.xlsx, .xls), PowerPoint (.pptx, .ppt), Outlook messages (.msg) and text formats. Case and accents are ignored. Returns matching files with short excerpts. The first search over a large folder can be partial while documents are still being read; the reply says so and a repeat search continues where it left off. Matches in scanned documents come from text recognition, so exact figures and spellings should be checked in the original.',
  inputSchema: {
    query: z.string().min(2).describe('What to look for'),
    match: z.enum(['phrase', 'all_words', 'any_word', 'regex']).default('phrase').describe('phrase = exact wording; all_words = every word somewhere in the file; any_word; regex'),
    path: z.string().default('').describe('Folder to search in; "" searches all of Tresorit'),
    extensions: z.array(z.string()).optional().describe('Only these file types, e.g. ["pdf"]'),
    limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of files returned'),
    snippets_per_file: z.number().int().min(1).max(8).default(3),
    include_online_only: z.boolean().default(false).describe('Also download and read files that are online-only (can be slow and uses disk space)'),
  },
  annotations: RO,
}, async ({ query, match, path: p, extensions, limit, snippets_per_file, include_online_only }) => {
  const t = R.resolve(p, { mustExist: true });
  const exts = extSet(extensions);
  const started = Date.now();
  const BUDGET = 30_000;                 // time allowed for documents that still have to be read for the first time
  const q = foldText(displayText(query).trim());
  const words = q.split(' ').filter(Boolean);
  const qBytes = Buffer.from(q, 'utf8');
  const wordBytes = words.map((w) => Buffer.from(w, 'utf8'));
  let rx = null;
  if (match === 'regex') {
    try { rx = new RegExp(query, 'giu'); } catch (e) { throw new UserError(`Invalid regular expression: ${e.message}`); }
  }
  const st0 = await fsp.stat(t.abs);
  const candidates = [];
  if (st0.isDirectory()) {
    for await (const f of walk(t.abs)) {
      if (f.isDir) continue;
      const ext = extOf(f.name);
      if (!isExtractable(ext)) continue;
      if (exts && !exts.has(ext)) continue;
      candidates.push(f);
    }
  } else {
    candidates.push({ abs: t.abs, rel: t.rel, name: path.basename(t.abs), isDir: false });
  }
  await statMany(candidates);
  // Newest first: if the time limit below is reached on a very large library, it is the oldest documents that
  // are left for a narrower search.
  candidates.sort((a, b) => ((b.st && b.st.mtimeMs) || 0) - ((a.st && a.st.mtimeMs) || 0));
  const hits = [];
  const skipped = { online: 0, unreadable: 0, pending: 0, scans: 0, partial: 0, long: 0, time: 0, noindex: 0, held: 0 };
  const holdAll = indexHold().all;
  let searched = 0;
  for (const f of candidates) {
    if (!f.st) continue;
    if (isNoIndexRel(f.rel)) { skipped.noindex++; continue; }
    if (cloudOnly(f.st) && !include_online_only) { skipped.online++; continue; }
    if (Date.now() - started > SEARCH_LIMIT_MS) { skipped.time++; continue; }
    const cached = index.fresh(f.rel, f.st);
    if (!cached && holdAll) { skipped.held++; continue; } // nothing new is read into the index for now
    if (!cached && Date.now() - started > BUDGET) { skipped.pending++; continue; }
    // Documents already read: search the stored search form, and load the full text only when there is a match.
    let hay = null;
    let res = null;
    if (cached && cached.st === 'ok' && !rx) {
      const bytes = await index.readFold(f.rel, cached);
      if (!bytes) index.refold(f.rel).catch(() => {}); // made under an earlier form, or missing: made again from the stored text
      if (bytes) {
        handled(bytes.length);
        const has = (b) => bytes.includes(b);
        const possible = match === 'phrase' ? has(qBytes) : match === 'all_words' ? wordBytes.every(has) : wordBytes.some(has);
        if (!possible) {
          if (cached.o === 'pending' || cached.o === 'failed') skipped.partial++;
          if (cached.tr) skipped.long++;
          searched++;
          continue;
        }
        hay = bytes.toString('utf8');
        handled(hay.length * 2);
      }
    }
    if (hay == null) {
      res = await getText(f.abs, f.rel, f.st, true, false);
      if (res.status === 'scan') { skipped.scans++; continue; }
      if (res.status !== 'ok') { skipped.unreadable++; continue; }
    }
    const entry = index.fresh(f.rel, f.st) || {};
    if (res ? res.ocrPending : (entry.o === 'pending' || entry.o === 'failed')) skipped.partial++;
    if (entry.tr) skipped.long++;
    searched++;
    let display = res ? displayText(res.text) : null;
    if (res) handled(res.text.length * 4);
    // Where the query occurs: [position, length] pairs, plus how many of the query's words were found.
    const locate = () => {
      if (rx) return { positions: regexPositions(rx, display), distinct: 1 };
      if (hay == null) hay = foldText(display);
      if (match === 'phrase') return { positions: countAll(hay, q).map((i) => [i, q.length]), distinct: 1 };
      const per = words.map((w) => countAll(hay, w).map((i) => [i, w.length]));
      const found = per.filter((a) => a.length);
      if (match === 'all_words' && found.length < words.length) return { positions: [], distinct: found.length };
      // lead with one excerpt per word, then the rest
      return { positions: [...found.map((a) => a[0]), ...per.flatMap((a) => a.slice(1))], distinct: found.length };
    };
    let { positions, distinct } = locate();
    if (!positions.length) continue;
    if (display == null) {
      const full = await index.readText(f.rel);
      display = full == null ? null : displayText(full);
      if (full != null) handled(full.length * 4);
      if (display == null || display.length !== hay.length) {
        // The stored text and its search form do not agree (the document changed in between): redo this one
        // from the full text.
        res = await getText(f.abs, f.rel, f.st, true);
        if (res.status !== 'ok') continue;
        display = displayText(res.text);
        hay = null;
        ({ positions, distinct } = locate());
        if (!positions.length) continue;
      }
    }
    const used = [];
    const snips = [];
    for (const [at, len] of positions) {
      if (snips.length >= snippets_per_file) break;
      if (used.some((u) => Math.abs(u - at) < 200)) continue;
      used.push(at);
      snips.push(snippet(display, at, len));
    }
    hits.push({ f, count: positions.length, distinct, snips, ocr: /read by text recognition/.test((res ? res.note : entry.n) || '') });
  }
  hits.sort((a, b) => (b.distinct - a.distinct) || (b.count - a.count) || (b.f.st.mtimeMs - a.f.st.mtimeMs));
  const shown = hits.slice(0, limit);
  log('SEARCH', `"${query}" (${match})`, `${hits.length} file(s) matched of ${searched} searched in ${t.rel || 'all of Tresorit'}`);
  const notes = [];
  if (skipped.time) notes.push(`The search stopped at its time limit with ${skipped.time} older document(s) not searched (newest documents are searched first). To cover them, narrow the search to a folder (path) or a file type (extensions).`);
  if (skipped.noindex) notes.push(`${skipped.noindex} document(s) in folders set as "do not index" (${notIndexedNames().join('; ')}) were not searched. Their contents are never searched; open such a document by name with tresorit_read_file.`);
  if (skipped.held) notes.push(`${skipped.held} document(s) are not in the search index and were not searched: nothing new is read into the index until the list of folders that are not to be indexed has been confirmed on this Mac. tresorit_preflight asks for that at its end.`);
  if (skipped.pending) notes.push(`${skipped.pending} document(s) had not been read yet and were not searched this time. Run the same search again to continue (the connector keeps reading them in the background).`);
  if (skipped.scans) notes.push(`${skipped.scans} scanned PDF(s) are not searchable yet: ${ocr.enabled ? (ocr.engine === 'none' ? `text recognition is unavailable (${ocr.detail})` : 'their text is being recognised in the background, so repeat the search later') : 'text recognition is switched off in the connector settings'}.`);
  if (skipped.partial) notes.push(`${skipped.partial} PDF(s) were searched without some scanned pages that are still waiting for text recognition.`);
  if (skipped.long) notes.push(`${skipped.long} very long document(s) are only searchable up to their first 10 million characters (16 MB for plain text files); a match beyond that point would be missed.`);
  if (skipped.online) notes.push(`${skipped.online} online-only file(s) were skipped (not downloaded to this Mac). Set include_online_only to read them.`);
  if (skipped.unreadable) notes.push(`${skipped.unreadable} file(s) have no readable text (empty, password-protected, damaged or an unsupported variant).`);
  const head = `${hits.length} file(s) contain "${query}"${hits.length > shown.length ? `, showing the top ${shown.length}` : ''}. Searched ${searched} document(s) in ${t.rel || 'all of Tresorit'}.`;
  const body = shown.map((h, i) => [
    `${i + 1}. ${show(h.f.rel)}   (${fmtSize(h.f.st.size)}, modified ${fmtDate(h.f.st.mtimeMs)}, ${h.count} match${h.count === 1 ? '' : 'es'}${h.ocr ? ', includes text read by OCR' : ''})`,
    ...h.snips.map((s) => `   > ${s}`),
  ].join('\n'));
  return [head, ...body, ...(notes.length ? ['', 'Notes:', ...notes.map((n) => `- ${n}`)] : [])].join('\n');
});
