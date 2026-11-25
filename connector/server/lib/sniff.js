// What a file really is, judged from its content and not from the ending of its name.
// Documents are often saved under the wrong ending (a photo of a receipt called .pdf, a PDF called .docx). The
// connector reads each file with the reader that matches its content, and says so when the two disagree.
import { unzipSync } from 'fflate';
import { isCfb, openCfb } from './cfb.js';

const starts = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf, from, to) => buf.subarray(from, to).toString('latin1');

// The kind of image, or '' when it is not one.
export function imageKind(buf) {
  if (buf.length < 12) return '';
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return 'gif';
  if (starts(buf, [0x49, 0x49, 0x2a, 0x00]) || starts(buf, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
  if (ascii(buf, 0, 2) === 'BM' && buf.readUInt32LE(2) === buf.length) return 'bmp';
  if (ascii(buf, 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|avif)/.test(ascii(buf, 8, 12))) return 'heic';
  return '';
}

function zipKind(buf) {
  const names = [];
  try { unzipSync(buf, { filter: (f) => { if (names.length < 5000) names.push(f.name); return false; } }); } catch { return 'zip'; }
  if (names.includes('word/document.xml')) return 'docx';
  if (names.includes('xl/workbook.xml') || names.includes('xl/workbook.bin')) return 'xlsx';
  if (names.includes('ppt/presentation.xml')) return 'pptx';
  return 'zip';
}

function cfbKind(buf) {
  let c;
  try { c = openCfb(buf); } catch { return 'cfb'; }
  if (c.find('EncryptedPackage') || c.find('EncryptionInfo')) return 'office-protected';
  if (c.find('WordDocument')) return 'doc';
  if (c.find('Workbook') || c.find('Book')) return 'xls';
  if (c.find('PowerPoint Document')) return 'ppt';
  if (c.find('__properties_version1.0') || c.find('__nameid_version1.0')) return 'msg';
  return 'cfb';
}

// One of: empty, pdf, png/jpeg/gif/tiff/webp/bmp/heic, docx, xlsx, pptx, zip, doc, xls, ppt, msg, cfb,
// office-protected, rtf, html, xml, webarchive, bplist, text, unknown.
export function sniff(buf) {
  if (!buf || buf.length === 0) return 'empty';
  const img = imageKind(buf);
  if (img) return img;
  const head = ascii(buf, 0, Math.min(buf.length, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (starts(buf, [0x50, 0x4b, 0x03, 0x04]) || starts(buf, [0x50, 0x4b, 0x05, 0x06])) return zipKind(buf);
  if (isCfb(buf)) return cfbKind(buf);
  if (head.startsWith('bplist00')) return buf.includes('WebMainResource') ? 'webarchive' : 'bplist';
  const lead = head.replace(/^﻿|^\xef\xbb\xbf/, '').trimStart().toLowerCase();
  if (lead.startsWith('{\\rtf')) return 'rtf';
  if (lead.startsWith('<!doctype html') || lead.startsWith('<html') || (/^<!--|^<head|^<body/.test(lead) && lead.includes('<'))) return 'html';
  if (lead.startsWith('<?xml') || lead.startsWith('<')) return /<html[\s>]/.test(lead) ? 'html' : 'xml';
  // Plain text: no control characters other than tabs and line ends in the first part of the file.
  const sample = buf.subarray(0, 4096);
  for (const b of sample) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return 'unknown';
  if (sample.includes(0x7f)) return 'unknown';
  return 'text';
}

export const KIND_LABEL = {
  pdf: 'PDF', png: 'PNG image', jpeg: 'JPEG image', gif: 'GIF image', tiff: 'TIFF image', webp: 'WebP image', bmp: 'BMP image', heic: 'HEIC image',
  docx: 'Word document', xlsx: 'Excel workbook', pptx: 'PowerPoint presentation', zip: 'zip archive',
  doc: 'old-format Word document', xls: 'old-format Excel workbook', ppt: 'old-format PowerPoint presentation', msg: 'Outlook message',
  cfb: 'old Office-style file of an unknown kind', 'office-protected': 'password-protected Office file',
  rtf: 'rich-text document', html: 'web page', xml: 'XML file', webarchive: 'Safari web archive', bplist: 'Apple property list', text: 'plain text file', unknown: 'file of an unrecognised kind',
};

// The kinds that the ending of a name promises.
const PROMISED = {
  pdf: ['pdf'], docx: ['docx'], docm: ['docx'], dotx: ['docx'], xlsx: ['xlsx'], xlsm: ['xlsx'], pptx: ['pptx'], ppsx: ['pptx'],
  doc: ['doc'], dot: ['doc'], xls: ['xls'], xlt: ['xls'], ppt: ['ppt'], pps: ['ppt'], msg: ['msg'],
};
// A mismatch is only claimed when the content is positively something else. A zip or an old Office-style file
// that could not be identified further, or content of no recognisable kind, is "damaged" or "unreadable", not
// "wrongly named".
const ZIP_ENDINGS = ['docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'pptx', 'ppsx'];
const OLD_ENDINGS = ['doc', 'dot', 'xls', 'xlt', 'ppt', 'pps', 'msg'];
export const matchesEnding = (kind, ext) => {
  if (!PROMISED[ext] || PROMISED[ext].includes(kind) || kind === 'unknown' || kind === 'empty') return true;
  if (kind === 'zip') return ZIP_ENDINGS.includes(ext);
  if (kind === 'cfb' || kind === 'office-protected') return OLD_ENDINGS.includes(ext) || ZIP_ENDINGS.includes(ext);
  return false;
};

// ---- Safari web archives --------------------------------------------------------------------------------------
// A web archive is an Apple "binary property list" holding the saved page. Only what is needed to reach the page
// itself (WebMainResource > WebResourceData) is read.
function parseBplist(buf) {
  const t = buf.subarray(buf.length - 32);
  const offSize = t[6]; const refSize = t[7];
  const count = Number(t.readBigUInt64BE(8)); const top = Number(t.readBigUInt64BE(16)); const table = Number(t.readBigUInt64BE(24));
  if (!(offSize >= 1 && offSize <= 8 && refSize >= 1 && refSize <= 8) || count > 5_000_000 || table + count * offSize > buf.length) throw new Error('not a readable property list');
  const uint = (at, size) => { let n = 0; for (let i = 0; i < size; i++) n = n * 256 + buf[at + i]; return n; };
  const offsetOf = (i) => uint(table + i * offSize, offSize);
  let budget = 200000;
  const read = (i, depth) => {
    if (--budget < 0 || depth > 40 || i >= count) throw new Error('property list too complex');
    let at = offsetOf(i);
    const marker = buf[at]; const kind = marker >> 4; let n = marker & 15; at += 1;
    const length = () => { if (n !== 15) return n; const sz = 1 << (buf[at] & 15); const v = uint(at + 1, sz); at += 1 + sz; return v; };
    if (kind === 0) return n === 8 ? false : n === 9 ? true : null;
    if (kind === 1) return uint(at, 1 << n);
    if (kind === 2 || kind === 3) return null;
    if (kind === 4) { const len = length(); return buf.subarray(at, at + len); }
    if (kind === 5) { const len = length(); return buf.subarray(at, at + len).toString('latin1'); }
    if (kind === 6) { const len = length(); const b = Buffer.from(buf.subarray(at, at + len * 2)); b.swap16(); return b.toString('utf16le'); }
    if (kind === 10) { const len = length(); const out = []; for (let k = 0; k < len; k++) out.push(read(uint(at + k * refSize, refSize), depth + 1)); return out; }
    if (kind === 13) {
      const len = length(); const out = {};
      for (let k = 0; k < len; k++) {
        const key = read(uint(at + k * refSize, refSize), depth + 1);
        if (typeof key !== 'string') continue;
        // only the branches that lead to the page are followed; the rest (images, scripts) is skipped unread
        if (depth === 0 && key !== 'WebMainResource') continue;
        if (depth === 1 && !/^WebResource(Data|TextEncodingName|MIMEType)$/.test(key)) continue;
        out[key] = read(uint(at + (len + k) * refSize, refSize), depth + 1);
      }
      return out;
    }
    return null;
  };
  return read(top, 0);
}

// The saved page of a web archive, as HTML text (or '' when there is none).
export function webarchiveHtml(buf) {
  const root = parseBplist(buf);
  const main = root && root.WebMainResource;
  const data = main && main.WebResourceData;
  if (!Buffer.isBuffer(data)) return '';
  const enc = String((main && main.WebResourceTextEncodingName) || 'utf-8').toLowerCase();
  return /16/.test(enc) ? data.toString('utf16le') : /8859|1252|latin/.test(enc) ? data.toString('latin1') : data.toString('utf8');
}

// ---- Why a file could not be read ------------------------------------------------------------------------------
export const REASONS = ['password', 'damaged', 'empty', 'unsupported', 'too-large', 'other'];
export const REASON_LABEL = { password: 'password-protected', damaged: 'damaged', empty: 'empty (0 bytes)', unsupported: 'content of a kind that cannot be read', 'too-large': 'too large', other: 'could not be read for another reason' };
// For a catalogue entry: the recorded reason, or one worked out from the note (entries made by older versions).
export function reasonOf(e) {
  if (!e || e.st === 'ok' || e.st === 'empty' || e.st === 'scan') return '';
  if (e.y) return e.y;
  if (e.st === 'toolarge') return 'too-large';
  if (e.st === 'unsupported') return 'unsupported';
  const n = String(e.n || '').toLowerCase();
  if (/password/.test(n)) return 'password';
  if (/0 bytes|is empty/.test(n)) return 'empty';
  if (/timed out|memory|took too long|stopped/.test(n)) return 'other';
  return 'damaged';
}
