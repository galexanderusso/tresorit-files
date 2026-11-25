// Reader for the Microsoft Compound File Binary container used by old Office files (.doc, .xls, .ppt) and
// Outlook messages (.msg). Read-only, defensive against damaged or hostile files (loops, out-of-range sectors).
const ENDOFCHAIN = 0xfffffffe;
const MAX_REGULAR = 0xfffffffa;
const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isCfb(buf) {
  if (!buf || buf.length < 512) return false;
  for (let i = 0; i < 8; i++) if (buf[i] !== SIGNATURE[i]) return false;
  return true;
}

export function openCfb(buf) {
  if (!isCfb(buf)) throw new Error('not an Office binary file');
  const sectorShift = buf.readUInt16LE(30);
  const miniShift = buf.readUInt16LE(32);
  if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6) throw new Error('unsupported file structure');
  const ssz = 1 << sectorShift;
  const mssz = 1 << miniShift;
  const firstDir = buf.readUInt32LE(48);
  const cutoff = buf.readUInt32LE(56) || 4096;
  const firstMiniFat = buf.readUInt32LE(60);
  const firstDifat = buf.readUInt32LE(68);
  const nDifat = buf.readUInt32LE(72);
  const maxSectors = Math.floor(buf.length / ssz) + 1;
  const sectorOffset = (sid) => (sid + 1) * ssz;
  const sectorOk = (sid) => sid <= MAX_REGULAR && sectorOffset(sid) + 1 <= buf.length;

  // DIFAT: list of sectors that hold the FAT
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s <= MAX_REGULAR) fatSectors.push(s);
  }
  let d = firstDifat;
  for (let n = 0; n < nDifat && n < maxSectors && sectorOk(d); n++) {
    const off = sectorOffset(d);
    const per = ssz / 4 - 1;
    for (let i = 0; i < per; i++) {
      if (off + i * 4 + 4 > buf.length) break;
      const s = buf.readUInt32LE(off + i * 4);
      if (s <= MAX_REGULAR) fatSectors.push(s);
    }
    if (off + per * 4 + 4 > buf.length) break;
    d = buf.readUInt32LE(off + per * 4);
  }
  const fatAt = (sid) => {
    const per = ssz / 4;
    const fs = fatSectors[Math.floor(sid / per)];
    if (fs === undefined || !sectorOk(fs)) return ENDOFCHAIN;
    const off = sectorOffset(fs) + (sid % per) * 4;
    if (off + 4 > buf.length) return ENDOFCHAIN;
    return buf.readUInt32LE(off);
  };

  function readChain(start, size) {
    const parts = [];
    let sid = start;
    let got = 0;
    let guard = 0;
    while (sid <= MAX_REGULAR && guard++ < maxSectors && (size == null || got < size)) {
      const off = sectorOffset(sid);
      if (off >= buf.length) break;
      const end = Math.min(off + ssz, buf.length);
      parts.push(buf.subarray(off, end));
      got += end - off;
      sid = fatAt(sid);
    }
    const all = Buffer.concat(parts);
    return size == null ? all : all.subarray(0, Math.min(size, all.length));
  }

  // Directory
  const dirBuf = readChain(firstDir, null);
  const raw = [];
  for (let off = 0; off + 128 <= dirBuf.length && raw.length < 200000; off += 128) {
    const nameLen = Math.min(dirBuf.readUInt16LE(off + 64), 64);
    const name = nameLen >= 2 ? dirBuf.subarray(off, off + nameLen - 2).toString('utf16le') : '';
    raw.push({
      name,
      type: dirBuf[off + 66],
      left: dirBuf.readUInt32LE(off + 68),
      right: dirBuf.readUInt32LE(off + 72),
      child: dirBuf.readUInt32LE(off + 76),
      start: dirBuf.readUInt32LE(off + 116),
      size: sectorShift === 9 ? dirBuf.readUInt32LE(off + 120) : Number(dirBuf.readBigUInt64LE(off + 120)),
    });
  }
  if (!raw.length || raw[0].type !== 5) throw new Error('damaged file (no root entry)');
  const root = raw[0];
  const miniStream = readChain(root.start, root.size);
  const miniFat = readChain(firstMiniFat, null);

  function readMini(start, size) {
    const parts = [];
    let sid = start;
    let got = 0;
    let guard = 0;
    const limit = Math.floor(miniFat.length / 4);
    while (sid <= MAX_REGULAR && sid < limit && guard++ <= limit && got < size) {
      const off = sid * mssz;
      if (off >= miniStream.length) break;
      parts.push(miniStream.subarray(off, Math.min(off + mssz, miniStream.length)));
      got += mssz;
      sid = miniFat.readUInt32LE(sid * 4);
    }
    const all = Buffer.concat(parts);
    return all.subarray(0, Math.min(size, all.length));
  }

  // Walk the tree (siblings form a binary tree; children hang off storages). Guard against cycles.
  const entries = [];
  const seen = new Set();
  function visit(id, parentPath, depth) {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === 0xffffffff || cur >= raw.length || seen.has(cur) || seen.size > 200000) continue;
      seen.add(cur);
      const e = raw[cur];
      const path = parentPath ? `${parentPath}/${e.name}` : e.name;
      if (e.type === 1 || e.type === 2) entries.push({ name: e.name, path, type: e.type === 1 ? 'storage' : 'stream', start: e.start, size: e.size });
      if (e.type === 1 && depth < 32) visit(e.child, path, depth + 1);
      stack.push(e.left, e.right);
    }
  }
  visit(root.child, '', 0);

  const byPath = new Map(entries.map((e) => [e.path.toLowerCase(), e]));
  return {
    entries,
    find(path) { return byPath.get(path.toLowerCase()) || null; },
    read(entry, maxBytes = 512 * 1024 * 1024) {
      if (!entry || entry.type !== 'stream') return Buffer.alloc(0);
      const size = Math.min(entry.size, maxBytes);
      return entry.size < cutoff ? readMini(entry.start, size) : readChain(entry.start, size);
    },
    readPath(path, maxBytes) { return this.read(this.find(path), maxBytes); },
  };
}
