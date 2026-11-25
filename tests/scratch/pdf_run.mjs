import fs from 'node:fs';
import path from 'node:path';
const { Extractor } = await import((process.env.LIB || '/home/tester/build/tresorit-connector/server/lib') + '/extractor.js');
const keep = setInterval(() => {}, 1000);
const dir = '/home/tester/samples/pdfjs/test/pdfs'; const outDir = '/home/tester/build/scratch/ours-pdf';
fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
const ex = new Extractor();
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();
const tally = {}; const slow = []; const notes = {}; const scans = []; let maxMs = 0; const t00 = Date.now();
for (const f of files) {
  const abs = path.join(dir, f); const t0 = Date.now();
  const r = await ex.extract(abs, 'pdf', fs.statSync(abs).size, true);
  const ms = Date.now() - t0; maxMs = Math.max(maxMs, ms);
  tally[r.status] = (tally[r.status] || 0) + 1;
  if (ms > 10000) slow.push(`${f} ${ms}ms`);
  if (r.status === 'ok') fs.writeFileSync(path.join(outDir, f + '.txt'), r.text);
  if (r.status === 'scan' || (r.scanPages && r.scanPages.length)) scans.push({ f, status: r.status, scanPages: r.scanPages.length, pages: r.pages });
  if (r.status === 'error') { const k = (r.note || '').replace(/\d+/g, 'N').slice(0, 60); (notes[k] = notes[k] || []).push(f); }
}
console.log(`pdf: ${files.length} files in ${Math.round((Date.now() - t00) / 1000)} s ->`, JSON.stringify(tally), `| slowest ${maxMs} ms | over 10 s: ${slow.length ? slow.join(', ') : 'none'}`);
for (const [k, v] of Object.entries(notes).sort((a, b) => b[1].length - a[1].length).slice(0, 8)) console.log(`   ${String(v.length).padStart(3)} x ${k}   e.g. ${v.slice(0, 2).join(', ')}`);
fs.writeFileSync('/home/tester/build/scratch/pdf_scans.json', JSON.stringify(scans));
console.log('files with scanned pages:', scans.length, '| whole-document scans:', scans.filter((s) => s.status === 'scan').length);
await ex.close(); clearInterval(keep);
