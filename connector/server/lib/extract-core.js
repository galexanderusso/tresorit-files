// Text extraction for PDF, Word, Excel, PowerPoint, Outlook messages and plain-text formats.
// Runs inside a worker thread.
import fs from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { decodeEntities, htmlToText, rtfToText, decodeTextFile, dateKind, serialToText } from './textutil.js';
import { isCfb, openCfb } from './cfb.js';
import { extractDoc, extractXls, extractPpt, extractMsg } from './legacy.js';
import { sniff, imageKind, KIND_LABEL, matchesEnding, webarchiveHtml } from './sniff.js';

export const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml', 'ini', 'cfg',
  'tex', 'bib', 'py', 'js', 'ts', 'sql', 'sh', 'r', 'ipynb', 'rtf', 'eml', 'xyz', 'inp', 'out', 'svg',
]);
export const DOC_EXTS = new Set([
  'pdf', 'docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'pptx', 'ppsx',
  'doc', 'dot', 'xls', 'xlt', 'ppt', 'pps', 'msg',
]);
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
export const isExtractable = (ext) => TEXT_EXTS.has(ext) || DOC_EXTS.has(ext);

export const MAX_DOC_BYTES = 80 * 1024 * 1024;   // larger documents are skipped
export const MAX_TEXT_BYTES = 16 * 1024 * 1024;  // larger plain-text files are read up to this point
export const MAX_CHARS = 10_000_000;             // extracted text kept per file
export const PAGE_TEXT_MIN = 40;                 // a PDF page with fewer characters than this is treated as a scan
const MAX_ZIP_ENTRY = 120 * 1024 * 1024;

function unzipSome(buf, wanted) {
  return unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
    filter: (f) => wanted(f.name) && f.originalSize <= MAX_ZIP_ENTRY,
  });
}

const numIn = (name) => parseInt((name.match(/(\d+)\.xml$/) || [0, 0])[1], 10);
const isZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5);

// Office XML normally uses fixed prefixes (w:, a:, none in spreadsheets) but some programs write others
// (x: is common in exports from web systems), so every tag is matched with any prefix or none.
const NS = '(?:[A-Za-z_][\\w.-]*:)?';
const END = '(?=[\\s/>])';
const rx = (src) => new RegExp(src, 'g');
const attrOf = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`)) || tag.match(new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`));
  return m ? decodeEntities(m[1]) : null;
};
const relIdOf = (tag) => (tag.match(/\s[A-Za-z_][\w.-]*:id\s*=\s*["']([^"']*)["']/) || [])[1] || null;
const keyCI = (files, name) => { const want = name.toLowerCase(); return Object.keys(files).find((k) => k.toLowerCase() === want) || null; };
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function readRels(xml) {
  const map = {};
  if (!xml) return map;
  for (const m of xml.matchAll(rx(`<${NS}Relationship${END}[^>]*>`))) {
    const id = attrOf(m[0], 'Id');
    const target = attrOf(m[0], 'Target');
    if (id && target) map[id] = { target, type: attrOf(m[0], 'Type') || '' };
  }
  return map;
}

function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = [];
  for (const part of `${baseDir}/${target}`.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

const TEXT_RUN = `<${NS}t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${NS}t>`;

function wordXmlToText(xml) {
  const body = xml
    .replace(rx(`<${NS}Fallback>[\\s\\S]*?<\\/${NS}Fallback>`), '')   // the same content repeated for older programs
    .replace(rx(`<${NS}pPr>[\\s\\S]*?<\\/${NS}pPr>`), '');            // paragraph settings (tab stops are not text)
  let out = '';
  const re = rx(`${TEXT_RUN}|<${NS}tab${END}[^>]*\\/>|<${NS}(?:br|cr)${END}[^>]*\\/>|<\\/${NS}p>|<\\/${NS}tc>`);
  let m;
  while ((m = re.exec(body))) {
    const tok = m[0];
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (tok.startsWith('</')) out += tok.endsWith('tc>') ? '\t' : '\n';
    else if (/tab/.test(tok.slice(0, 16))) out += '\t';
    else out += '\n';
  }
  return out;
}

function extractDocx(buf) {
  const files = unzipSome(buf, (n) => /^word\/(document|footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/i.test(n));
  const get = (name) => { const k = keyCI(files, name); return k ? strFromU8(files[k]) : null; };
  const parts = [];
  const doc = get('word/document.xml');
  if (doc) parts.push(wordXmlToText(doc));
  for (const [extra, label] of [['word/footnotes.xml', 'Footnotes'], ['word/endnotes.xml', 'Endnotes'], ['word/comments.xml', 'Comments']]) {
    const xml = get(extra);
    if (xml) {
      const t = wordXmlToText(xml).trim();
      if (t) parts.push(`\n--- ${label} ---\n${t}`);
    }
  }
  const hf = Object.keys(files).filter((n) => /header|footer/i.test(n)).sort(natural);
  const hfText = [...new Set(hf.map((n) => wordXmlToText(strFromU8(files[n])).trim()).filter(Boolean))];
  if (hfText.length) parts.push(`\n--- Headers and footers ---\n${hfText.join('\n')}`);
  return parts.join('\n');
}

function extractPptx(buf) {
  const files = unzipSome(buf, (n) => /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml|slides\/_rels\/[^/]+\.rels|notesSlides\/[^/]+\.xml)$/i.test(n));
  const get = (name) => { const k = keyCI(files, name); return k ? strFromU8(files[k]) : null; };
  const paraText = (xml) => {
    let out = '';
    const re = rx(`${TEXT_RUN}|<${NS}br${END}[^>]*\\/>|<\\/${NS}p>`);
    let m;
    while ((m = re.exec(xml))) out += m[1] !== undefined ? decodeEntities(m[1]) : '\n';
    return out.replace(/\n{3,}/g, '\n\n').trim();
  };
  // Slides in the order they are shown (files are numbered in the order they were created, which can differ).
  const order = [];
  const rels = readRels(get('ppt/_rels/presentation.xml.rels'));
  for (const m of (get('ppt/presentation.xml') || '').matchAll(rx(`<${NS}sldId${END}[^>]*>`))) {
    const rel = rels[relIdOf(m[0])];
    const key = rel ? keyCI(files, resolveTarget('ppt', rel.target)) : null;
    if (key && !order.includes(key)) order.push(key);
  }
  for (const k of Object.keys(files).filter((n) => /^ppt\/slides\/[^/]+\.xml$/i.test(n)).sort(natural)) if (!order.includes(k)) order.push(k);

  const parts = order.map((key, i) => {
    let text = `--- Slide ${i + 1} ---\n${paraText(strFromU8(files[key]))}`;
    const relKey = keyCI(files, key.replace(/slides\/([^/]+)$/i, 'slides/_rels/$1.rels'));
    if (relKey) {
      for (const r of Object.values(readRels(strFromU8(files[relKey])))) {
        if (!/\/notesSlide$/i.test(r.type)) continue;
        const nk = keyCI(files, resolveTarget('ppt/slides', r.target));
        const notes = nk ? paraText(strFromU8(files[nk])).split('\n').filter((l) => l.trim() && !/^\d+$/.test(l.trim())).join('\n') : '';
        if (notes) text += `\n[Speaker notes] ${notes}`;
      }
    }
    return text;
  });
  // Notes that no slide points to (seen in damaged files) are still worth having.
  const linked = new Set();
  for (const key of order) {
    const relKey = keyCI(files, key.replace(/slides\/([^/]+)$/i, 'slides/_rels/$1.rels'));
    if (relKey) for (const r of Object.values(readRels(strFromU8(files[relKey])))) { const nk = keyCI(files, resolveTarget('ppt/slides', r.target)); if (nk) linked.add(nk); }
  }
  const orphan = Object.keys(files).filter((k) => /^ppt\/notesSlides\/[^/]+\.xml$/i.test(k) && !linked.has(k)).sort(natural)
    .map((k) => paraText(strFromU8(files[k])).split('\n').filter((l) => l.trim() && !/^\d+$/.test(l.trim())).join('\n')).filter(Boolean);
  if (orphan.length) parts.push(`--- Speaker notes ---\n${orphan.join('\n\n')}`);
  return parts.join('\n\n');
}

function extractXlsx(buf) {
  const files = unzipSome(buf, (n) => /^xl\/(?:workbook\.xml|styles\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/i.test(n) || /^xl\/.*sharedstrings\.xml$/i.test(n));
  const get = (name) => { const k = keyCI(files, name); return k ? strFromU8(files[k]) : null; };
  const rels = readRels(get('xl/_rels/workbook.xml.rels'));
  const wbXml = get('xl/workbook.xml') || '';
  const date1904 = /\sdate1904\s*=\s*["'](?:1|true)["']/i.test(wbXml);

  // Shared strings
  const shared = [];
  let sstKey = keyCI(files, 'xl/sharedStrings.xml');
  for (const r of Object.values(rels)) if (/\/sharedStrings$/i.test(r.type)) sstKey = keyCI(files, resolveTarget('xl', r.target)) || sstKey;
  if (sstKey) {
    const xml = strFromU8(files[sstKey]);
    const re = rx(`<${NS}si(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${NS}si>|<${NS}si\\s*\\/>`);
    const phonetic = rx(`<${NS}rPh${END}[\\s\\S]*?<\\/${NS}rPh>`);
    let m;
    while ((m = re.exec(xml))) {
      if (m[1] === undefined) { shared.push(''); continue; }
      let s = '';
      for (const t of m[1].replace(phonetic, '').matchAll(rx(TEXT_RUN))) s += decodeEntities(t[1]);
      shared.push(s);
    }
  }

  // Which cell styles are dates (a date is stored as a plain number plus a date format)
  const styleKind = [];
  const stylesXml = get('xl/styles.xml');
  if (stylesXml) {
    const custom = {};
    for (const m of stylesXml.matchAll(rx(`<${NS}numFmt${END}[^>]*>`))) {
      const id = Number(attrOf(m[0], 'numFmtId'));
      const code = attrOf(m[0], 'formatCode');
      if (Number.isFinite(id) && code != null) custom[id] = code;
    }
    const block = (stylesXml.match(new RegExp(`<${NS}cellXfs${END}[^>]*>([\\s\\S]*?)<\\/${NS}cellXfs>`)) || [])[1] || '';
    for (const m of block.matchAll(rx(`<${NS}xf${END}[^>]*>`))) {
      const id = Number(attrOf(m[0], 'numFmtId') || 0);
      styleKind.push(dateKind(id, custom[id]));
    }
  }

  // Sheets in workbook order
  const ordered = [];
  const defs = [...wbXml.matchAll(rx(`<${NS}sheet${END}[^>]*>`))].map((m) => ({ name: attrOf(m[0], 'name'), rid: relIdOf(m[0]) }));
  for (const def of defs) {
    const rel = rels[def.rid];
    const key = rel ? keyCI(files, resolveTarget('xl', rel.target)) : null;
    if (key && /^xl\/worksheets\//i.test(key) && !ordered.some((o) => o.key === key)) ordered.push({ key, label: def.name });
  }
  const loose = Object.keys(files).filter((k) => /^xl\/worksheets\/[^/]+\.xml$/i.test(k) && !ordered.some((o) => o.key === k)).sort(natural);
  const positional = !ordered.length && defs.length === loose.length;
  loose.forEach((key, i) => ordered.push({ key, label: positional ? defs[i].name : null }));

  const rowRe = `<${NS}row${END}[^>]*?\\/>|<${NS}row${END}[^>]*>([\\s\\S]*?)<\\/${NS}row>`; // an empty row may be self-closing
  const cellRe = `<${NS}c${END}([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}c>)`;
  const valRe = new RegExp(`<${NS}v(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${NS}v>`);
  const parts = [];
  let total = 0;
  ordered.forEach((sheet, i) => {
    if (total > MAX_CHARS) return;
    const xml = strFromU8(files[sheet.key]);
    const lines = [];
    for (const r of xml.matchAll(rx(rowRe))) {
      if (r[1] === undefined) continue;
      const cells = [];
      for (const c of r[1].matchAll(rx(cellRe))) {
        const attrs = ` ${c[1] || ''}`;
        const inner = c[2] || '';
        const type = attrOf(attrs, 't');
        let val = '';
        if (type === 'inlineStr') {
          for (const t of inner.matchAll(rx(TEXT_RUN))) val += decodeEntities(t[1]);
        } else {
          const v = (inner.match(valRe) || [])[1];
          if (v !== undefined) {
            if (type === 's') val = shared[parseInt(v, 10)] ?? '';
            else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
            else if (type === 'd' || type === 'str' || type === 'e') val = decodeEntities(v);
            else {
              const kind = styleKind[Number(attrOf(attrs, 's') || 0)];
              val = (kind && serialToText(Number(v), kind, date1904)) || decodeEntities(v);
            }
          }
        }
        if (val !== '') cells.push(val.replace(/[\t\r\n]+/g, ' '));
      }
      if (cells.length) {
        const line = cells.join('\t');
        lines.push(line);
        total += line.length + 1;
        if (total > MAX_CHARS) break;
      }
    }
    parts.push(`--- Sheet: ${sheet.label || `Sheet ${i + 1}`} ---\n${lines.join('\n')}`);
  });
  return parts.join('\n\n');
}

export const pageMarker = (i, n) => `--- Page ${i} of ${n} ---`;

// What a person typed into a fillable PDF form, and comments added on top of a page, are not part of the page's
// own text: they are stored separately and are collected here.
async function pageExtras(pdf, pageNumber) {
  const lines = [];
  try {
    const page = await pdf.getPage(pageNumber);
    const annotations = await page.getAnnotations();
    const fields = [];
    const comments = [];
    for (const a of annotations) {
      if (a.subtype === 'Widget') {
        let value = a.fieldValue;
        if (Array.isArray(value)) value = value.join(', ');
        if (a.checkBox || a.radioButton) {
          if (value == null || value === 'Off' || value === '') continue;
          if (a.exportValue != null && value !== a.exportValue) continue; // this box is not the one selected
          value = a.radioButton ? String(value) : 'checked';
        }
        if (value == null || String(value).trim() === '' || a.fieldType === 'Sig') continue;
        const name = String(a.alternativeText || a.fieldName || '').split('.').pop().replace(/\[\d+\]$/, '').trim() || 'field';
        fields.push(`${name}: ${String(value).replace(/\s+/g, ' ').trim()}`.slice(0, 2000));
      } else {
        const c = a.contentsObj && typeof a.contentsObj.str === 'string' ? a.contentsObj.str.trim() : '';
        if (c && a.subtype !== 'Link' && a.subtype !== 'Popup') comments.push(c.replace(/\s+/g, ' ').slice(0, 2000));
      }
      if (fields.length + comments.length > 2000) break;
    }
    if (fields.length) lines.push(`[Form fields]\n${[...new Set(fields)].join('\n')}`);
    if (comments.length) lines.push(`[Comments]\n${[...new Set(comments)].join('\n')}`);
  } catch { /* a page whose annotations cannot be read still keeps its text */ }
  return lines.join('\n');
}

// Releases everything the PDF library holds for a document. (This library's document object has no destroy()
// of its own; the release goes through its loading task. Without it every PDF read stays in memory.)
export async function closePdf(pdf) {
  try {
    if (pdf && pdf.loadingTask && typeof pdf.loadingTask.destroy === 'function') await pdf.loadingTask.destroy();
    else if (pdf && typeof pdf.destroy === 'function') await pdf.destroy();
  } catch { /* nothing more can be done */ }
}

// An error that carries the reason a file could not be read (see REASONS in sniff.js).
function unreadable(why, message, extra = {}) {
  return Object.assign(new Error(message), { why, ...extra });
}

async function extractPdf(buf, password) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf;
  try {
    const opts = { verbosity: 0 };
    if (typeof password === 'string' && password.length) opts.password = password; // held in memory for this one read only
    pdf = await getDocumentProxy(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), opts);
  } catch (e) {
    // (The message of the reader is never passed on here: it must not be able to carry a password.)
    if ((e && e.name === 'PasswordException') || /password/i.test(String(e && e.message))) {
      if (password) throw unreadable('password', 'the password supplied does not open this PDF', { wrongPassword: true });
      throw unreadable('password', 'the PDF is password-protected');
    }
    throw e;
  }
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text || '')];
    const blocks = [];
    const scanPages = [];
    let chars = 0;
    for (let i = 0; i < pages.length; i++) {
      let body = (pages[i] || '').trim();
      if (i < 1000) {
        const extras = await pageExtras(pdf, i + 1);
        if (extras) body = body ? `${body}\n${extras}` : extras;
      }
      blocks.push(`${pageMarker(i + 1, totalPages)}\n${body}`);
      const n = body.replace(/\s+/g, '').length;
      chars += n;
      if (n < PAGE_TEXT_MIN) scanPages.push(i + 1);
    }
    return { text: blocks.join('\n\n'), chars, pages: totalPages, scanPages };
  } finally {
    await closePdf(pdf);
  }
}

// Returns { status, text, note, scanPages?, pages?, why?, kind?, mismatch? }
//   status: 'ok' | 'empty' | 'scan' | 'unsupported' | 'toolarge' | 'error'
//   'scan' = a PDF (or a picture saved as a document) with no usable text layer; scanPages lists the pages that
//            need text recognition (OCR).
//   why    = for a file that cannot be read: password | damaged | empty | unsupported | too-large
//   mismatch = set when the content is not what the ending of the name says, e.g. "PNG image saved as .pdf"
// opts.password: for a password-protected PDF. It is used for this read and kept nowhere.
export async function extractFile(abs, ext, size, opts = {}) {
  if (!isExtractable(ext)) return { status: 'unsupported', text: '', note: `.${ext || '(none)'} files cannot be read as text`, why: 'unsupported' };
  if (DOC_EXTS.has(ext) && size > MAX_DOC_BYTES) return { status: 'toolarge', text: '', note: 'file is larger than 80 MB', why: 'too-large' };

  let text = '';
  let note = '';
  let extra = {};
  if (TEXT_EXTS.has(ext)) {
    let buf;
    if (size > MAX_TEXT_BYTES) {
      const fh = await fs.open(abs, 'r');
      try {
        buf = Buffer.alloc(MAX_TEXT_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MAX_TEXT_BYTES, 0);
        buf = buf.subarray(0, bytesRead);
      } finally { await fh.close(); }
      note = 'only the first 16 MB was read';
      extra = { partial: true };
    } else {
      buf = await fs.readFile(abs);
    }
    text = decodeTextFile(buf);
    if (ext === 'html' || ext === 'htm') text = htmlToText(text);
    else if (ext === 'rtf') text = rtfToText(text);
  } else {
    const buf = await fs.readFile(abs);
    if (buf.length === 0) return { status: 'error', text: '', note: 'the file is empty (0 bytes)', why: 'empty' };
    // Read by content: the reader is chosen from what the file is, whatever the ending of its name says.
    let kind = sniff(buf);
    // A file called .pdf whose first bytes do not announce a PDF may still be one (some carry junk in front).
    // The PDF reader gets the first try; only if it cannot open the file is it treated as what it looks like.
    let early = null;
    if (ext === 'pdf' && ['unknown', 'text', 'xml', 'html', 'bplist'].includes(kind)) {
      try {
        const r = await extractPdf(Buffer.from(buf), opts.password); // a copy: the PDF reader takes over the memory it is given
        // (The PDF reader is forgiving and can "open" almost anything as an empty document: that does not count.)
        if (r.pages >= 1 && (r.chars >= 20 || (kind === 'unknown' && r.scanPages.length))) { early = r; kind = 'pdf'; }
      } catch (e) { if (e && e.why === 'password') kind = 'pdf'; }
    }
    const mismatch = matchesEnding(kind, ext) ? '' : `${KIND_LABEL[kind] || kind} saved as .${ext}`;
    if (mismatch) { note = mismatch; extra.mismatch = mismatch; }
    extra.kind = kind;
    try {
      if (kind === 'pdf') {
        const r = early || await extractPdf(buf, opts.password);
        text = r.text;
        if (r.scanPages.length) Object.assign(extra, { scanPages: r.scanPages, pages: r.pages });
        if (r.chars < 20) {
          return { status: 'scan', text: r.text.length > MAX_CHARS ? '' : r.text, note: [mismatch, `scanned PDF with ${r.pages} page(s) and no text layer`].filter(Boolean).join('; '), scanPages: r.scanPages, pages: r.pages, kind, ...(mismatch ? { mismatch } : {}) };
        }
      } else if (imageKind(buf)) {
        // A picture saved under a document's name (a photographed or scanned page): its text comes from text
        // recognition, exactly as for a one-page scanned PDF.
        return { status: 'scan', text: pageMarker(1, 1), note: `${mismatch}; its text is read by text recognition`, scanPages: [1], pages: 1, kind, mismatch, image: true };
      } else if (kind === 'docx') text = extractDocx(buf);
      else if (kind === 'xlsx') text = extractXlsx(buf);
      else if (kind === 'pptx') text = extractPptx(buf);
      else if (kind === 'doc') text = extractDoc(buf);
      else if (kind === 'xls') text = extractXls(buf);
      else if (kind === 'ppt') text = extractPpt(buf);
      else if (kind === 'msg') text = extractMsg(buf);
      else if (kind === 'office-protected') throw unreadable('password', 'the file is password-protected');
      else if (kind === 'rtf') text = rtfToText(buf.toString('latin1'));
      else if (kind === 'html') text = htmlToText(decodeTextFile(buf));
      else if (kind === 'webarchive') text = htmlToText(webarchiveHtml(buf));
      else if (kind === 'xml' || kind === 'text') text = decodeTextFile(buf.length > MAX_TEXT_BYTES ? buf.subarray(0, MAX_TEXT_BYTES) : buf);
      else if (kind === 'cfb') {
        // An old Office-style file whose kind is not marked: try the reader its ending asks for.
        const legacy = { doc: extractDoc, dot: extractDoc, docx: extractDoc, xls: extractXls, xlt: extractXls, xlsx: extractXls, ppt: extractPpt, pps: extractPpt, pptx: extractPpt, msg: extractMsg }[ext];
        if (!legacy) throw unreadable('unsupported', 'this is a very old or unrecognised file format');
        text = legacy(buf);
      } else if (kind === 'zip') {
        // A zip with none of the usual parts: let the reader its ending asks for say what is wrong with it.
        text = (ext === 'doc' || ext === 'dot' || ext === 'docx' || ext === 'docm' || ext === 'dotx') ? extractDocx(buf) : (ext === 'pptx' || ext === 'ppsx' || ext === 'ppt' || ext === 'pps') ? extractPptx(buf) : (ext === 'pdf' || ext === 'msg') ? (() => { throw unreadable('unsupported', `this is a zip archive, not a ${ext === 'pdf' ? 'PDF' : 'message'}`); })() : extractXlsx(buf);
      } else {
        throw unreadable('unsupported', kind === 'unknown' ? 'this is a very old or unrecognised file format' : `this is a ${KIND_LABEL[kind] || 'file of an unrecognised kind'}, which cannot be read as a document`);
      }
    } catch (e) {
      const why = (e && e.why) || 'damaged';
      const msg = e && e.why ? e.message : String((e && e.message) || e).slice(0, 200);
      return { status: 'error', text: '', note: [mismatch, `could not be read: ${msg}`].filter(Boolean).join('; '), why, kind, ...(mismatch ? { mismatch } : {}), ...(e && e.wrongPassword ? { wrongPassword: true } : {}) };
    }
  }
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    note = note ? note + '; text truncated at 10 million characters' : 'text truncated at 10 million characters';
    extra = { ...extra, partial: true }; // also too long to merge recognised pages into
  }
  if (!text.trim()) return { status: 'empty', text: '', note: note ? `${note}; no text found in the file` : 'no text found in the file', ...(extra.mismatch ? { mismatch: extra.mismatch } : {}) };
  return { status: 'ok', text, note, ...extra };
}
