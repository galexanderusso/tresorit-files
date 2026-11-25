import fs from 'node:fs';
const { Extractor } = await import('/home/tester/build/final/server/lib/extractor.js');
const keep = setInterval(() => {}, 1000);
const ex = new Extractor();
for (const [f, ext] of [['pages1500.pdf', 'pdf'], ['pages6000.pdf', 'pdf'], ['rows300k.xlsx', 'xlsx']]) {
  const abs = `/home/tester/build/scratch/big/${f}`; const t0 = Date.now();
  const r = await ex.extract(abs, ext, fs.statSync(abs).size, true);
  console.log(`${f}: ${r.status} in ${Date.now() - t0} ms, ${r.text.length} chars | ${r.note || 'no note'} | last marker present: ${/ENDMARK-PAGE|ROW300000END/.test(r.text)} | sample: ${JSON.stringify(r.text.slice(0, 110))}`);
}
await ex.close(); clearInterval(keep);
