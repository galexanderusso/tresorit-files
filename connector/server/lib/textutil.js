// Small text helpers shared by the format readers.
export function safeCp(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function htmlToText(s) {
  return decodeEntities(
    s.replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t\r]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Removes balanced {\*\destination ...} groups (fonts, styles, pictures, embedded HTML tags and the like).
function stripRtfDestinations(s) {
  let out = '';
  let i = 0;
  const skipWords = /^\{\\(?:\*\\[a-z]+|fonttbl|colortbl|stylesheet|info|pict|object|themedata|colorschememapping|datastore|latentstyles|generator)\b/;
  while (i < s.length) {
    if (s[i] === '{' && skipWords.test(s.slice(i, i + 40))) {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (ch === '\\') { j++; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
      }
      i = j + 1;
      continue;
    }
    out += s[i++];
  }
  return out;
}

export function rtfToText(s, codepage = 1252) {
  let dec;
  try { dec = new TextDecoder(`windows-${codepage}`); } catch { dec = new TextDecoder('windows-1252'); }
  return stripRtfDestinations(s)
    .replace(/\\par[d]?\b ?|\\line\b ?|\\row\b ?/g, '\n')
    .replace(/\\tab\b ?|\\cell\b ?/g, '\t')
    .replace(/\\u(-?\d+)\??(?:\\'[0-9a-fA-F]{2})?/g, (_, d) => safeCp((parseInt(d, 10) + 65536) % 65536))
    .replace(/(?:\\'[0-9a-fA-F]{2})+/g, (m) => dec.decode(Buffer.from(m.replace(/\\'/g, ''), 'hex')))
    .replace(/\\([{}\\])/g, '\u0000$1')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/\\[^a-zA-Z]/g, '')
    .replace(/[{}]/g, '')
    .replace(/\u0000([{}\\])/g, '$1')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CP_LABELS = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 65001: 'utf-8', 20127: 'utf-8', 28591: 'iso-8859-1', 28592: 'iso-8859-2', 28605: 'iso-8859-15', 20866: 'koi8-r', 50220: 'iso-2022-jp' };
export function decodeCodepage(buf, cp = 1252) {
  const label = CP_LABELS[cp] || (cp >= 1250 && cp <= 1258 ? `windows-${cp}` : cp === 874 ? 'windows-874' : 'windows-1252');
  try { return new TextDecoder(label).decode(buf); } catch { return Buffer.from(buf).toString('latin1'); }
}

// Plain-text files: UTF-8 normally; UTF-16 with a byte-order mark; Windows-1252 when the bytes are not valid UTF-8.
export function decodeTextFile(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function isValidUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

// ---- Spreadsheet dates ------------------------------------------------------------------------------------------
// Excel stores a date as a day count and marks it as a date only through the cell's number format.
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47]);

// Returns 'date', 'datetime', 'time' or null for a number format (built-in id and/or custom code).
export function dateKind(id, code) {
  if (!code) {
    if (id === 22) return 'datetime';
    if (BUILTIN_DATE.has(id)) return 'date';
    if (BUILTIN_TIME.has(id)) return 'time';
    return null;
  }
  const clean = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, '').replace(/_.|\*./g, '');
  if (/general/i.test(clean) || !/[dmyhs]/i.test(clean)) return null;
  if (/[#0?]/.test(clean) && !/[dyhs]/i.test(clean)) return null; // e.g. "0.00 m" is a number with a unit
  const hasTime = /[hs]/i.test(clean) || /am\/pm|a\/p/i.test(clean);
  const hasDate = /[dy]/i.test(clean) || (/m/i.test(clean) && !hasTime);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  return hasTime ? 'time' : null;
}

const p2 = (n) => String(n).padStart(2, '0');
export function serialToText(serial, kind, date1904 = false) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465.99999) return null;
  if (kind === 'time') {
    const secs = Math.round(serial * 86400);
    return `${p2(Math.floor(secs / 3600))}:${p2(Math.floor((secs % 3600) / 60))}:${p2(secs % 60)}`;
  }
  if (serial < 1 && !date1904) return null; // day 0 is not a real date
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, serial < 60 ? 31 : 30); // Excel counts a 29 Feb 1900 that never was
  const d = new Date(base + Math.round(serial * 86400) * 1000);
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  if (kind === 'date') return date;
  const hms = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return d.getUTCSeconds() ? `${date} ${hms}:${p2(d.getUTCSeconds())}` : `${date} ${hms}`;
}

// ---- search form of a document ----------------------------------------------------------------------------------
// "display" is the text as shown in search excerpts; "fold" is the same text, same length, with case and accents
// removed, so a position found in one is valid in the other.
// A word that was split at the end of a line ("agree-" at the end of one line, "ment" at the start of the next) is
// joined again, so that it is found whole: a letter, a hyphen (or a soft hyphen), the line break, a small letter.
// A capital after the hyphen ("Müller-" / "Schmidt"), a list ("- first") and a hyphen with a space before it are
// left alone. This is done here only, in the form that is searched and shown in excerpts: the stored text of the
// document keeps the split exactly as the document has it.
// SEARCH_FORM is the number of this form. A search form made under another number is not used: it is made again
// from the stored text (TextIndex.refold), without the document being read again.
export const SEARCH_FORM = 2;
const LINE_END_SPLIT = /(\p{L})[-\u2010\u00AD][ \t]*\r?\n[ \t]*(\p{Ll})/gu;
export function displayText(text) { return text.normalize('NFC').replace(LINE_END_SPLIT, '$1$2').replace(/\s+/g, ' '); }
export function foldText(display) {
  const f = display.replace(/[^\x00-\x7f]/g, (ch) => {
    const b = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return b.length === ch.length ? b : ch;
  }).toLowerCase();
  return f.length === display.length ? f : display.toLowerCase();
}
