import fs from 'node:fs';
import { openCfb } from '../tresorit-connector/server/lib/cfb.js';
import { extractMsg } from '../tresorit-connector/server/lib/legacy.js';
for (const f of process.argv.slice(2)) {
  const c = openCfb(fs.readFileSync(f));
  const pb = c.readPath('__properties_version1.0');
  const found = [];
  for (let off = 32; off + 16 <= pb.length; off += 16) {
    const type = pb.readUInt16LE(off), id = pb.readUInt16LE(off + 2);
    if ([0x3ffd, 0x3fde, 0x3ff1, 0x0e07, 0x340d].includes(id)) found.push(`${id.toString(16)}/${type.toString(16)}=${pb.readInt32LE(off + 8)}`);
  }
  console.log(f.split('/').pop(), found.join(' '));
  try { console.log(extractMsg(fs.readFileSync(f)).slice(0, 500)); } catch (e) { console.log('THROW', e.stack.split('\n').slice(0, 4).join('\n')); }
}
