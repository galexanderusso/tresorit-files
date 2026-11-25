import fs from 'node:fs';
import { openCfb } from '../tresorit-connector/server/lib/cfb.js';
const c = openCfb(fs.readFileSync(process.argv[2]));
const s = c.readPath('PowerPoint Document');
console.log('streams:', c.entries.map((e) => `${e.path}:${e.size}`).join(' ').slice(0, 300), '| ppt stream', s.length);
const counts = {};
function walk(start, end, depth, trail) {
  let pos = start;
  while (pos + 8 <= end) {
    const vi = s.readUInt16LE(pos), type = s.readUInt16LE(pos + 2), len = s.readUInt32LE(pos + 4);
    const key = trail + '>' + type.toString(16);
    if (type === 0xfa0 || type === 0xfa8 || type === 0xfba) counts[key] = (counts[key] || 0) + 1;
    if ((vi & 0xf) === 0xf && depth < 40) walk(pos + 8, Math.min(pos + 8 + len, end), depth + 1, key);
    pos += 8 + len;
  }
}
walk(0, s.length, 0, '');
console.log(counts);
