// Run the bundle's own extraction path (worker thread + timeout) over a folder of real files.
import fs from 'node:fs';
import path from 'node:path';
const { Extractor } = await import((process.env.LIB || '/home/tester/build/final/server/lib') + '/extractor.js');
const keep = setInterval(() => {}, 1000);
const [dir, ext, outDir] = process.argv.slice(2);
const ex = new Extractor();
fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.' + ext)).sort();
const tally = {}; const slow = []; const notes = {};
for (const f of files) {
  const abs = path.join(dir, f); const t0 = Date.now();
  const r = await ex.extract(abs, ext, fs.statSync(abs).size, true);
  const ms = Date.now() - t0;
  tally[r.status] = (tally[r.status] || 0) + 1;
  if (ms > 5000) slow.push(`${f} ${ms}ms`);
  if (r.status === 'ok') fs.writeFileSync(path.join(outDir, f + '.txt'), r.text);
  else { const k = (r.note || '').replace(/\d+/g, 'N').slice(0, 70); (notes[k] = notes[k] || []).push(f); }
}
console.log(`${ext}: ${files.length} files ->`, JSON.stringify(tally), slow.length ? `| slow: ${slow.join(', ')}` : '| none slow');
for (const [k, v] of Object.entries(notes)) console.log(`   ${String(v.length).padStart(3)} x ${k}   e.g. ${v.slice(0, 3).join(', ')}`);
await ex.close(); clearInterval(keep);
