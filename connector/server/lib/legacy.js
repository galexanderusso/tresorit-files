// Readers for the pre-2007 Office formats (.doc, .xls, .ppt) and Outlook messages (.msg).
// Written against Microsoft's published format specifications; no third-party libraries.
import { openCfb } from './cfb.js';
import { htmlToText, rtfToText, decodeCodepage, dateKind, serialToText } from './textutil.js';

const cp1252 = new TextDecoder('windows-1252');

// ---------------------------------------------------------------------------------------------------------------
// Word 97-2003 (.doc)
// ---------------------------------------------------------------------------------------------------------------
function cleanWordText(s) {
  // Fields: 0x13 starts the field code (hidden), 0x14 separates it from the visible result, 0x15 ends the field.
  let out = '';
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x13) { stack.push(true); continue; }
    if (ch === 0x14) { if (stack.length) stack[stack.length - 1] = false; continue; }
    if (ch === 0x15) { stack.pop(); continue; }
    if (stack.includes(true)) continue;
    if (ch === 0x0d || ch === 0x0b || ch === 0x0c) out += '\n';
    else if (ch === 0x07) out += '\t';
    else if (ch === 0x1e) out += '-';
    else if (ch === 0xa0) out += ' ';
    else if (ch === 0x09) out += '\t';
    else if (ch < 0x20) continue;
    else out += s[i];
  }
  return out.replace(/\t+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractDoc(buf) {
  const c = openCfb(buf);
  const wd = c.readPath('WordDocument');
  if (wd.length < 0x1aa) throw new Error('not a Word document');
  const ident = wd.readUInt16LE(0);
  if (ident !== 0xa5ec) throw new Error(ident === 0xa5dc ? 'Word 6/95 format is not supported' : 'not a Word 97-2003 document');
  const flags = wd.readUInt16LE(0x0a);
  if (flags & 0x0100) throw new Error('the document is password-protected');
  const tbl = c.readPath(flags & 0x0200 ? '1Table' : '0Table');
  const ccp = [0x4c, 0x50, 0x54, 0x58, 0x5c, 0x60, 0x64, 0x68].map((o) => wd.readInt32LE(o));
  const [ccpText, ccpFtn, ccpHdd, ccpMcr, ccpAtn, ccpEdn, ccpTxbx] = ccp.map((n) => (n > 0 ? n : 0));
  const fcClx = wd.readUInt32LE(0x01a2);
  const lcbClx = wd.readUInt32LE(0x01a6);

  const pieces = [];
  let pos = fcClx;
  const end = Math.min(fcClx + lcbClx, tbl.length);
  while (lcbClx && pos < end) {
    const t = tbl[pos];
    if (t === 1) { if (pos + 3 > end) break; pos += 3 + tbl.readUInt16LE(pos + 1); continue; }
    if (t !== 2 || pos + 5 > end) break;
    const lcb = tbl.readUInt32LE(pos + 1);
    const base = pos + 5;
    const n = Math.floor((lcb - 4) / 12);
    for (let i = 0; i < n; i++) {
      const pcd = base + 4 * (n + 1) + 8 * i;
      if (pcd + 8 > tbl.length) break;
      const cpStart = tbl.readUInt32LE(base + 4 * i);
      const cpEnd = tbl.readUInt32LE(base + 4 * (i + 1));
      const fcRaw = tbl.readUInt32LE(pcd + 2);
      if (cpEnd > cpStart) pieces.push({ cpStart, cpEnd, compressed: (fcRaw & 0x40000000) !== 0, fc: fcRaw & 0x3fffffff });
    }
    break;
  }

  let all = '';
  if (pieces.length) {
    pieces.sort((a, b) => a.cpStart - b.cpStart);
    for (const p of pieces) {
      const count = Math.min(p.cpEnd - p.cpStart, 20_000_000);
      if (all.length < p.cpStart) all += ' '.repeat(Math.min(p.cpStart - all.length, 1000));
      if (p.compressed) {
        const off = p.fc >> 1;
        all += cp1252.decode(wd.subarray(off, Math.min(off + count, wd.length)));
      } else {
        all += wd.subarray(p.fc, Math.min(p.fc + count * 2, wd.length)).toString('utf16le');
      }
      if (all.length > 12_000_000) break;
    }
  } else {
    const fcMin = wd.readUInt32LE(0x18);
    const fcMac = wd.readUInt32LE(0x1c);
    all = cp1252.decode(wd.subarray(fcMin, Math.min(fcMac, wd.length)));
  }

  const seg = (start, len) => (len > 0 ? cleanWordText(all.slice(start, start + len)) : '');
  let at = 0;
  const main = seg(at, ccpText || all.length); at += ccpText;
  const ftn = seg(at, ccpFtn); at += ccpFtn;
  at += ccpHdd + ccpMcr; // headers/footers and macros are skipped
  const atn = seg(at, ccpAtn); at += ccpAtn;
  const edn = seg(at, ccpEdn); at += ccpEdn;
  const txbx = seg(at, ccpTxbx);
  const parts = [main];
  if (ftn) parts.push(`--- Footnotes ---\n${ftn}`);
  if (edn) parts.push(`--- Endnotes ---\n${edn}`);
  if (atn) parts.push(`--- Comments ---\n${atn}`);
  if (txbx) parts.push(`--- Text boxes ---\n${txbx}`);
  return parts.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Excel 97-2003 (.xls)
// ---------------------------------------------------------------------------------------------------------------
function fmtNum(v) {
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toPrecision(12)));
}

function rkValue(rk) {
  let v;
  if (rk & 2) v = rk >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 1 ? v / 100 : v;
}

function parseSst(chunks) {
  const out = [];
  let ci = 0;
  let off = 0;
  const more = () => { while (ci < chunks.length && off >= chunks[ci].length) { ci++; off = 0; } return ci < chunks.length; };
  const byte = () => (more() ? chunks[ci][off++] : 0);
  const u16 = () => { const a = byte(); return a | (byte() << 8); };
  const u32 = () => { const a = u16(); return (a | (u16() << 16)) >>> 0; };
  const skip = (n) => { while (n > 0 && more()) { const k = Math.min(n, chunks[ci].length - off); off += k; n -= k; } };
  u32();
  const unique = u32();
  for (let i = 0; i < unique && more() && i < 5_000_000; i++) {
    let remaining = u16();
    const flags = byte();
    let high = flags & 1;
    const runs = flags & 8 ? u16() : 0;
    const ext = flags & 4 ? u32() : 0;
    let s = '';
    while (remaining > 0) {
      if (ci >= chunks.length) break;
      if (off >= chunks[ci].length) {
        ci++; off = 0;
        if (ci >= chunks.length) break;
        high = chunks[ci][off++] & 1; // each continuation restates the character width
      }
      const per = high ? 2 : 1;
      const can = Math.min(remaining, Math.floor((chunks[ci].length - off) / per));
      if (can <= 0) { off = chunks[ci].length; continue; }
      s += high ? chunks[ci].toString('utf16le', off, off + can * 2) : chunks[ci].toString('latin1', off, off + can);
      off += can * per;
      remaining -= can;
    }
    skip(4 * runs + ext);
    out.push(s);
  }
  return out;
}

export function extractXls(buf, maxChars = 10_000_000) {
  const c = openCfb(buf);
  let wb = c.readPath('Workbook');
  if (!wb.length) wb = c.readPath('Book');
  if (!wb.length) throw new Error('not an Excel workbook');
  let biff8 = true;
  let sst = [];
  const names = new Map();
  const sheets = [];
  let cur = null;
  let depth = 0;
  let pendingStr = null;
  let total = 0;
  // Dates are stored as plain numbers; the cell's format (XF record -> FORMAT record) says when a number is a date.
  let date1904 = false;
  const formats = {};
  const xfFormat = [];
  const kindCache = new Map();
  const numText = (xf, v) => {
    const ifmt = xfFormat[xf];
    if (ifmt === undefined) return fmtNum(v);
    if (!kindCache.has(ifmt)) kindCache.set(ifmt, dateKind(ifmt, formats[ifmt]));
    const kind = kindCache.get(ifmt);
    return (kind && serialToText(v, kind, date1904)) || fmtNum(v);
  };
  const put = (row, col, val) => {
    if (!cur || depth !== 1 || val === '' || val == null || total > maxChars) return;
    let r = cur.rows.get(row);
    if (!r) { r = new Map(); cur.rows.set(row, r); }
    const v = String(val).replace(/[\t\r\n]+/g, ' ');
    r.set(col, v);
    total += v.length + 1;
  };
  const xlString = (d, limit) => {
    if (d + 3 > limit) return '';
    const cch = wb.readUInt16LE(d);
    const fl = wb[d + 2];
    const start = d + 3 + (fl & 8 ? 2 : 0) + (fl & 4 ? 4 : 0);
    return fl & 1 ? wb.toString('utf16le', start, Math.min(start + cch * 2, limit)) : wb.toString('latin1', start, Math.min(start + cch, limit));
  };

  let pos = 0;
  while (pos + 4 <= wb.length) {
    const id = wb.readUInt16LE(pos);
    const len = wb.readUInt16LE(pos + 2);
    const d = pos + 4;
    const next = d + len;
    if (next > wb.length) break;
    switch (id) {
      case 0x0809: { // BOF
        depth++;
        if (depth === 1) {
          const type = len >= 4 ? wb.readUInt16LE(d + 2) : 0;
          if (type === 0x0005) { biff8 = wb.readUInt16LE(d) >= 0x0600; cur = null; } else if (type === 0x0010) { cur = { offset: pos, rows: new Map() }; sheets.push(cur); } else cur = null;
        }
        break;
      }
      case 0x000a: depth = Math.max(0, depth - 1); break; // EOF
      case 0x002f: throw new Error('the workbook is password-protected');
      case 0x0022: if (len >= 2) date1904 = wb.readUInt16LE(d) === 1; break; // DATEMODE
      case 0x041e: { // FORMAT
        if (len >= 4) {
          const ifmt = wb.readUInt16LE(d);
          formats[ifmt] = biff8 ? xlString(d + 2, next) : cp1252.decode(wb.subarray(d + 3, Math.min(d + 3 + wb[d + 2], next)));
        }
        break;
      }
      case 0x00e0: if (len >= 4 && depth === 1 && !cur) xfFormat.push(wb.readUInt16LE(d + 2)); break; // XF
      case 0x0085: { // BOUNDSHEET
        if (len >= 8) {
          const offset = wb.readUInt32LE(d);
          const cch = wb[d + 6];
          let name;
          if (biff8) name = wb[d + 7] & 1 ? wb.toString('utf16le', d + 8, Math.min(d + 8 + cch * 2, next)) : wb.toString('latin1', d + 8, Math.min(d + 8 + cch, next));
          else name = cp1252.decode(wb.subarray(d + 7, Math.min(d + 7 + cch, next)));
          names.set(offset, name);
        }
        break;
      }
      case 0x00fc: { // SST (+ CONTINUE records)
        const chunks = [wb.subarray(d, next)];
        let p = next;
        while (p + 4 <= wb.length && wb.readUInt16LE(p) === 0x003c) {
          const l = wb.readUInt16LE(p + 2);
          if (p + 4 + l > wb.length) break;
          chunks.push(wb.subarray(p + 4, p + 4 + l));
          p += 4 + l;
        }
        sst = parseSst(chunks);
        pos = p;
        continue;
      }
      case 0x00fd: if (len >= 10) put(wb.readUInt16LE(d), wb.readUInt16LE(d + 2), sst[wb.readUInt32LE(d + 6)]); break; // LABELSST
      case 0x0203: if (len >= 14) put(wb.readUInt16LE(d), wb.readUInt16LE(d + 2), numText(wb.readUInt16LE(d + 4), wb.readDoubleLE(d + 6))); break; // NUMBER
      case 0x027e: if (len >= 10) put(wb.readUInt16LE(d), wb.readUInt16LE(d + 2), numText(wb.readUInt16LE(d + 4), rkValue(wb.readInt32LE(d + 6)))); break; // RK
      case 0x00bd: { // MULRK
        const row = wb.readUInt16LE(d);
        const first = wb.readUInt16LE(d + 2);
        const n = Math.floor((len - 6) / 6);
        for (let i = 0; i < n; i++) put(row, first + i, numText(wb.readUInt16LE(d + 4 + i * 6), rkValue(wb.readInt32LE(d + 4 + i * 6 + 2))));
        break;
      }
      case 0x0204: { // LABEL
        if (len >= 8) {
          const row = wb.readUInt16LE(d);
          const col = wb.readUInt16LE(d + 2);
          if (biff8) put(row, col, xlString(d + 6, next));
          else put(row, col, cp1252.decode(wb.subarray(d + 8, Math.min(d + 8 + wb.readUInt16LE(d + 6), next))));
        }
        break;
      }
      case 0x0006: { // FORMULA (cached result)
        if (len >= 14) {
          const row = wb.readUInt16LE(d);
          const col = wb.readUInt16LE(d + 2);
          if (wb.readUInt16LE(d + 12) === 0xffff) {
            const t = wb[d + 6];
            if (t === 0) pendingStr = { row, col };
            else if (t === 1) put(row, col, wb[d + 8] ? 'TRUE' : 'FALSE');
          } else put(row, col, numText(wb.readUInt16LE(d + 4), wb.readDoubleLE(d + 6)));
        }
        break;
      }
      case 0x0207: { // STRING (result of the preceding formula)
        if (pendingStr) {
          put(pendingStr.row, pendingStr.col, biff8 ? xlString(d, next) : cp1252.decode(wb.subarray(d + 2, Math.min(d + 2 + wb.readUInt16LE(d), next))));
          pendingStr = null;
        }
        break;
      }
      case 0x0205: if (len >= 8 && !wb[d + 7]) put(wb.readUInt16LE(d), wb.readUInt16LE(d + 2), wb[d + 6] ? 'TRUE' : 'FALSE'); break; // BOOLERR
      default: break;
    }
    pos = next;
  }

  const parts = [];
  sheets.forEach((s, i) => {
    const rows = [...s.rows.keys()].sort((a, b) => a - b);
    const lines = rows.map((r) => {
      const cols = s.rows.get(r);
      return [...cols.keys()].sort((a, b) => a - b).map((k) => cols.get(k)).join('\t');
    });
    parts.push(`--- Sheet: ${names.get(s.offset) || `Sheet ${i + 1}`} ---\n${lines.join('\n')}`);
  });
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------------------------------------------
// PowerPoint 97-2003 (.ppt)
// ---------------------------------------------------------------------------------------------------------------
// A .ppt file keeps old versions of slides after each save. The "persist directory" says which copy is current,
// so the reader follows it; if that fails it falls back to reading every text record in the file in order.
export function extractPpt(buf) {
  const c = openCfb(buf);
  if (c.find('EncryptedSummary')) throw new Error('the presentation is password-protected');
  const s = c.readPath('PowerPoint Document');
  if (!s.length) throw new Error('not a PowerPoint presentation');
  let budget = 10_500_000;
  const tidy = (t) => t.replace(/[\r\x0b]/g, '\n').replace(/[\x00-\x08\x0e-\x1f]/g, '').trim();
  const rec = (pos) => (pos >= 0 && pos + 8 <= s.length
    ? { ver: s.readUInt16LE(pos) & 0xf, inst: s.readUInt16LE(pos) >> 4, type: s.readUInt16LE(pos + 2), len: s.readUInt32LE(pos + 4), data: pos + 8 }
    : null);

  // Collect text atoms under [start, end). onPersist is called for each SlidePersistAtom met at this level.
  function collect(start, end, into, depth, onPersist) {
    let pos = start;
    while (pos + 8 <= end && budget > 0) {
      const r = rec(pos);
      const dEnd = Math.min(r.data + r.len, end);
      if (r.type === 0x03f3 && onPersist) onPersist(r.data, dEnd);
      else if (r.type === 0x0fa0 || r.type === 0x0fa8) {
        const text = tidy(r.type === 0x0fa0 ? s.toString('utf16le', r.data, dEnd) : s.toString('latin1', r.data, dEnd));
        if (text) { into().push(text); budget -= text.length; }
      } else if (r.ver === 0xf && depth < 40 && r.type !== 0x03f8 && r.type !== 0x0fc9 && r.type !== 0x0ff0) collect(r.data, dEnd, into, depth + 1, null);
      pos = r.data + r.len;
    }
  }
  const boilerplate = (t) => /^\*$/.test(t) || /^\d+$/.test(t);

  function viaPersistDirectory() {
    const cu = c.readPath('Current User');
    if (cu.length < 20) return null;
    let editOff = cu.readUInt32LE(16);
    const persist = new Map();
    let docRef = null;
    for (let guard = 0; guard < 2000 && editOff; guard++) {
      const ue = rec(editOff);
      if (!ue || ue.type !== 0x0ff5 || ue.data + 20 > s.length) break;
      const lastEdit = s.readUInt32LE(ue.data + 8);
      const dirOff = s.readUInt32LE(ue.data + 12);
      if (docRef == null) docRef = s.readUInt32LE(ue.data + 16);
      const pd = rec(dirOff);
      if (pd && pd.type === 0x1772) {
        let p = pd.data;
        const pEnd = Math.min(pd.data + pd.len, s.length);
        while (p + 4 <= pEnd) {
          const head = s.readUInt32LE(p); p += 4;
          const id = head & 0xfffff;
          const count = head >>> 20;
          for (let i = 0; i < count && p + 4 <= pEnd; i++, p += 4) if (!persist.has(id + i)) persist.set(id + i, s.readUInt32LE(p));
        }
      }
      if (!lastEdit || lastEdit >= editOff) break;
      editOff = lastEdit;
    }
    const doc = rec(persist.get(docRef));
    if (!doc || doc.type !== 0x03e8) return null;

    const slides = [];
    const notes = [];
    let pos = doc.data;
    const docEnd = Math.min(doc.data + doc.len, s.length);
    while (pos + 8 <= docEnd) {
      const r = rec(pos);
      const dEnd = Math.min(r.data + r.len, docEnd);
      if (r.type === 0x0ff0 && (r.inst === 0 || r.inst === 2)) {
        let cur = null;
        collect(r.data, dEnd, () => (cur ? cur.text : []), 0, (d) => {
          cur = { ref: s.readUInt32LE(d), text: [] };
          (r.inst === 0 ? slides : notes).push(cur);
        });
      }
      pos = r.data + r.len;
    }
    const fromContainer = (ref, type) => {
      const k = rec(persist.get(ref));
      const out = [];
      if (k && k.type === type) collect(k.data, Math.min(k.data + k.len, s.length), () => out, 0, null);
      return out;
    };
    const parts = slides.map((sl, i) => {
      const lines = [...sl.text, ...fromContainer(sl.ref, 0x03ee)].filter((t) => !boilerplate(t));
      return `--- Slide ${i + 1} ---\n${lines.join('\n')}`;
    });
    const noteLines = notes.flatMap((n) => [...n.text, ...fromContainer(n.ref, 0x03f0)]).filter((t) => !boilerplate(t));
    if (noteLines.length) parts.push(`--- Speaker notes ---\n${noteLines.join('\n')}`);
    return slides.length ? parts.join('\n\n') : null;
  }

  let text = null;
  try { text = viaPersistDirectory(); } catch { text = null; }
  if (text != null && text.replace(/--- [^\n]* ---/g, '').trim()) return text;

  // Fallback: every text record in file order (may include superseded versions of slides).
  const all = [];
  const seen = new Set();
  (function sweep(start, end, depth) {
    let pos = start;
    while (pos + 8 <= end && budget > 0) {
      const r = rec(pos);
      const dEnd = Math.min(r.data + r.len, end);
      if (r.type === 0x0fa0 || r.type === 0x0fa8) {
        const t = tidy(r.type === 0x0fa0 ? s.toString('utf16le', r.data, dEnd) : s.toString('latin1', r.data, dEnd));
        if (t && !boilerplate(t) && !seen.has(t)) { seen.add(t); all.push(t); budget -= t.length; }
      } else if (r.ver === 0xf && depth < 40 && r.type !== 0x03f8 && r.type !== 0x0fc9) sweep(r.data, dEnd, depth + 1);
      pos = r.data + r.len;
    }
  }(0, s.length, 0));
  return all.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Outlook message (.msg)
// ---------------------------------------------------------------------------------------------------------------
const RTF_PREBUF = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

export function decompressRtf(src) {
  if (!src || src.length < 16) return '';
  const compSize = src.readUInt32LE(0);
  const rawSize = src.readUInt32LE(4);
  const magic = src.readUInt32LE(8);
  if (magic === 0x414c454d) return src.toString('latin1', 16, Math.min(16 + rawSize, src.length));
  if (magic !== 0x75465a4c) return '';
  const dict = Buffer.alloc(4096);
  dict.write(RTF_PREBUF, 'latin1');
  let wp = RTF_PREBUF.length;
  const cap = Math.min(rawSize || 0, 30_000_000) || 30_000_000;
  const out = Buffer.alloc(cap);
  let op = 0;
  let ip = 16;
  const end = Math.min(src.length, compSize + 4);
  outer: while (ip < end) {
    const control = src[ip++];
    for (let bit = 0; bit < 8; bit++) {
      if (ip >= end) break outer;
      if (control & (1 << bit)) {
        if (ip + 1 >= end) break outer;
        const ref = (src[ip] << 8) | src[ip + 1];
        ip += 2;
        const offset = ref >> 4;
        const length = (ref & 0xf) + 2;
        if (offset === wp) break outer; // end marker
        for (let k = 0; k < length; k++) {
          const b = dict[(offset + k) & 4095];
          if (op >= cap) break outer;
          out[op++] = b;
          dict[wp] = b;
          wp = (wp + 1) & 4095;
        }
      } else {
        const b = src[ip++];
        if (op >= cap) break outer;
        out[op++] = b;
        dict[wp] = b;
        wp = (wp + 1) & 4095;
      }
    }
  }
  return out.toString('latin1', 0, op);
}

function readProps(buf, headerSize) {
  const props = new Map();
  for (let off = headerSize; off + 16 <= buf.length; off += 16) {
    const type = buf.readUInt16LE(off);
    const id = buf.readUInt16LE(off + 2);
    props.set(id, { type, value: buf.subarray(off + 8, off + 16) });
  }
  return props;
}

function fileTimeToIso(v) {
  const ft = v.readBigUInt64LE(0);
  if (ft === 0n) return '';
  const ms = Number(ft / 10000n) - 11644473600000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) || ms < 0 ? '' : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readMessage(c, prefix, level) {
  const P = (name) => (prefix ? `${prefix}/${name}` : name);
  const propBuf = c.readPath(P('__properties_version1.0'));
  const props = readProps(propBuf, level === 0 ? 32 : 24);
  const long = (id) => { const p = props.get(id); return p && p.type === 0x0003 ? p.value.readInt32LE(0) : null; };
  // 8-bit strings use the message code page; when absent, fall back to the code page of the message's locale.
  const LCID_CP = { 1041: 932, 2052: 936, 4100: 936, 1042: 949, 1028: 950, 3076: 950, 5124: 950, 1049: 1251, 1058: 1251, 1026: 1251, 2074: 1251, 1045: 1250, 1029: 1250, 1038: 1250, 1051: 1250, 1048: 1250, 1050: 1250, 1060: 1250, 1032: 1253, 1055: 1254, 1037: 1255, 1025: 1256, 1065: 1256, 1061: 1257, 1062: 1257, 1063: 1257, 1066: 1258, 1054: 874 };
  const codepage = long(0x3ffd) || LCID_CP[long(0x3ff1)] || (long(0x3fde) === 65001 ? 65001 : 1252);
  const sub = (base, id) => {
    const u = c.find(`${base}__substg1.0_${id}001F`);
    if (u) return c.read(u).toString('utf16le').replace(/\0+$/, '');
    const a = c.find(`${base}__substg1.0_${id}001E`);
    if (a) return decodeCodepage(c.read(a), codepage).replace(/\0+$/, '');
    return '';
  };
  const base = prefix ? `${prefix}/` : '';
  const str = (id) => sub(base, id);
  const bin = (id) => c.readPath(P(`__substg1.0_${id}0102`));
  const date = (id) => { const p = props.get(id); return p && p.type === 0x0040 ? fileTimeToIso(p.value) : ''; };

  const headers = str('007D');
  const subject = str('0037');
  let fromName = str('0C1A') || str('0042');
  let fromEmail = [str('5D01'), str('5D02'), str('0C1F'), str('0065')].find((v) => v.includes('@')) || '';
  if (!fromEmail && headers) fromEmail = (headers.match(/^From:[^\n]*?<?([\w.+-]+@[\w.-]+)>?/im) || [])[1] || '';
  if (!fromName && headers) fromName = ((headers.match(/^From:\s*"?([^"<\n]*?)"?\s*</im) || [])[1] || '').trim();

  const to = []; const cc = []; const bcc = [];
  const kids = c.entries.filter((e) => e.type === 'storage' && e.path.toLowerCase().startsWith(base.toLowerCase()) && !e.path.slice(base.length).includes('/'));
  for (const r of kids.filter((e) => e.name.startsWith('__recip_version1.0_#'))) {
    const rb = `${r.path}/`;
    const name = sub(rb, '3001');
    const email = [sub(rb, '39FE'), sub(rb, '3003'), sub(rb, '403D')].find((v) => v.includes('@')) || '';
    const rp = readProps(c.readPath(`${r.path}/__properties_version1.0`), 8);
    const kind = rp.get(0x0c15) ? rp.get(0x0c15).value.readInt32LE(0) : 1;
    const shown = name && email && name.toLowerCase() !== email.toLowerCase() ? `${name} <${email}>` : (email || name);
    if (shown) (kind === 2 ? cc : kind === 3 ? bcc : to).push(shown);
  }
  const attachments = [];
  const embedded = [];
  for (const a of kids.filter((e) => e.name.startsWith('__attach_version1.0_#'))) {
    const ab = `${a.path}/`;
    const name = sub(ab, '3707') || sub(ab, '3704') || sub(ab, '3001') || '(unnamed)';
    const data = c.find(`${a.path}/__substg1.0_37010102`);
    const inner = c.find(`${a.path}/__substg1.0_3701000D`);
    if (inner && inner.type === 'storage') {
      attachments.push(`${name} (attached message)`);
      if (level < 2) { try { embedded.push(readMessage(c, inner.path, level + 1)); } catch { /* skip unreadable inner message */ } }
    } else {
      let extra = '';
      if (data && /^smime\.p7[ms]$/i.test(name)) {
        // A signed message keeps its real attachments inside this envelope; list their names when it is readable MIME.
        const mime = c.read(data, 3 * 1024 * 1024).toString('latin1');
        if (/content-type:/i.test(mime.slice(0, 4000))) {
          const inner = [...new Set([...mime.matchAll(/filename\*?="?([^";\r\n]+)"?/gi)].map((m) => m[1].trim()))].filter((n) => !/^smime\.p7/i.test(n));
          if (inner.length) extra = `, signed envelope containing: ${inner.join(', ')}`;
        }
      }
      attachments.push(data ? `${name} (${fmtBytes(data.size)}${extra})` : name);
    }
  }

  let body = str('1000');
  if (!body.trim()) {
    const htmlBin = bin('1013');
    const html = htmlBin.length ? decodeCodepage(htmlBin, long(0x3fde) || 65001) : str('1013');
    if (html.trim()) body = htmlToText(html);
  }
  if (!body.trim()) {
    const rtf = decompressRtf(bin('1009'));
    if (rtf) body = rtfToText(rtf, codepage);
  }

  const head = [
    `Subject: ${subject}`,
    `From: ${fromName && fromEmail && fromName !== fromEmail ? `${fromName} <${fromEmail}>` : (fromEmail || fromName)}`,
    `To: ${to.length ? to.join('; ') : str('0E04')}`,
  ];
  const ccText = cc.length ? cc.join('; ') : str('0E03');
  if (ccText) head.push(`Cc: ${ccText}`);
  const bccText = bcc.length ? bcc.join('; ') : str('0E02');
  if (bccText) head.push(`Bcc: ${bccText}`);
  const when = date(0x0039) || date(0x0e06) || ((headers.match(/^Date:\s*(.+)$/im) || [])[1] || '').trim();
  if (when) head.push(`Date: ${when}`);
  if (attachments.length) head.push(`Attachments: ${attachments.join('; ')}`);
  let text = `${head.join('\n')}\n${'-'.repeat(40)}\n${body.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}`;
  for (const e of embedded) text += `\n\n=== Attached message ===\n${e}`;
  return text;
}

export function extractMsg(buf) {
  const c = openCfb(buf);
  if (!c.find('__properties_version1.0')) throw new Error('not an Outlook message');
  return readMessage(c, '', 0);
}
