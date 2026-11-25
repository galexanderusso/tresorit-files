// Run the legacy readers over every sample: must never hang or crash the process; record timing and output size.
import fs from 'node:fs';
import path from 'node:path';
import { extractDoc, extractXls, extractPpt } from '../tresorit-connector/server/lib/legacy.js';
const dir = process.argv[2]; const kind = process.argv[3];
const fn = { doc: extractDoc, xls: extractXls, ppt: extractPpt }[kind];
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.' + kind)).sort();
const out = {}; let ok = 0, empty = 0, err = 0, slow = 0; const errs = {};
fs.mkdirSync(`/home/tester/build/scratch/ours-${kind}`, { recursive: true });
for (const f of files) {
  const t0 = Date.now();
  try {
    const text = fn(fs.readFileSync(path.join(dir, f)));
    const ms = Date.now() - t0;
    if (ms > 3000) { slow++; console.log('SLOW', f, ms); }
    if (text.trim()) ok++; else empty++;
    fs.writeFileSync(`/home/tester/build/scratch/ours-${kind}/${f}.txt`, text);
  } catch (e) { err++; const k = e.message.slice(0, 60); (errs[k] = errs[k] || []).push(f); }
}
console.log(`${kind}: ${files.length} files -> ${ok} with text, ${empty} empty, ${err} refused, ${slow} slow`);
for (const [k, v] of Object.entries(errs)) console.log(`   ${String(v.length).padStart(3)} x ${k}   e.g. ${v.slice(0, 3).join(', ')}`);
