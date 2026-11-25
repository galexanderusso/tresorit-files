import fs from 'node:fs';
const { Ocr } = await import('/home/tester/build/tresorit-connector/server/lib/ocr.js');
const keep = setInterval(() => {}, 1000);
const D = '/home/tester/samples/pdfjs/test/pdfs';
const scans = JSON.parse(fs.readFileSync('/home/tester/build/scratch/pdf_scans.json', 'utf8')).filter((s) => s.status === 'scan');
// every 5th whole-document scan, at most 3 pages each
const pick = scans.filter((_, i) => i % 5 === 0);
const ocr = new Ocr({ enabled: true, force: 'bundled' });
let withText = 0, empty = 0, failed = 0, maxMs = 0; const fails = {}; const samples = [];
const t00 = Date.now();
for (const s of pick) {
  const t0 = Date.now();
  try {
    const pages = Array.from({ length: Math.min(3, s.pages) }, (_, i) => i + 1);
    const r = await ocr.request(`${D}/${s.f}`, pages, false);
    const text = Object.values(r.pages).join(' ').trim();
    if (text) { withText++; if (samples.length < 6 && text.length > 60) samples.push(`${s.f}: ${text.replace(/\s+/g, ' ').slice(0, 90)}`); } else empty++;
  } catch (e) { failed++; const k = e.message.slice(0, 60); fails[k] = (fails[k] || 0) + 1; }
  maxMs = Math.max(maxMs, Date.now() - t0);
}
console.log(`OCR on ${pick.length} real image-only PDFs in ${Math.round((Date.now() - t00) / 1000)} s: ${withText} gave text, ${empty} no text (pictures, blank pages), ${failed} failed | slowest ${maxMs} ms`);
console.log('failures:', JSON.stringify(fails));
for (const s of samples) console.log('   ', s);
console.log('engine:', ocr.describe());
ocr.close(); clearInterval(keep);
