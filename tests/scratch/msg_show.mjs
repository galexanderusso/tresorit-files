import fs from 'node:fs';
import { extractMsg } from '../tresorit-connector/server/lib/legacy.js';
import { openCfb } from '../tresorit-connector/server/lib/cfb.js';
for (const f of process.argv.slice(2)) {
  console.log('=====', f.split('/').pop());
  console.log(extractMsg(fs.readFileSync(f)).slice(0, 700));
  const c = openCfb(fs.readFileSync(f));
  console.log('  [top-level streams]', c.entries.filter((e) => !e.path.includes('/') && e.type === 'stream').map((e) => e.name.replace('__substg1.0_', '') + ':' + e.size).join(' ').slice(0, 600));
}
