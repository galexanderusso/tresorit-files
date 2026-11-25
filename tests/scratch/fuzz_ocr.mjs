import fs from 'node:fs';
const { Ocr } = await import('/home/tester/build/tresorit-connector/server/lib/ocr.js');
const keep = setInterval(() => {}, 1000);
const seeds = ['/home/tester/build/scratch/ocr/scan_1bit.pdf', '/home/tester/build/scratch/ocr/scan_jpeg.pdf', '/home/tester/build/scratch/ocr/scan_jpx.pdf'];
let seed = 4242; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const ri = (n) => Math.floor(rnd() * n);
const ocr = new Ocr({ enabled: true, force: 'bundled' });
let ok = 0, rejected = 0, maxMs = 0; const why = {}; const t00 = Date.now();
for (const s of seeds) {
  const orig = fs.readFileSync(s);
  for (let i = 0; i < 25; i++) {
    let b = Buffer.from(orig); const k = ri(4);
    if (k === 0) for (let j = 0, n = 1 + ri(30); j < n; j++) b[ri(b.length)] ^= 1 << ri(8);
    else if (k === 1) b = b.subarray(0, Math.floor(b.length * (0.3 + rnd() * 0.69)));
    else if (k === 2) { const a = ri(b.length), l = Math.min(1 + ri(20000), b.length - a); b.fill(ri(256), a, a + l); }
    else { const str = b.toString('latin1').replace(/\/Width (\d+)/, () => `/Width ${[0, 1, 99999, 65536][ri(4)]}`).replace(/\/Height (\d+)/, () => `/Height ${[0, 3, 120000][ri(3)]}`); b = Buffer.from(str, 'latin1'); }
    const f = '/home/tester/build/scratch/fuzz-tmp/ocr.pdf'; fs.mkdirSync('/home/tester/build/scratch/fuzz-tmp', { recursive: true }); fs.writeFileSync(f, b);
    const t0 = Date.now();
    try { await ocr.request(f, [1, 2], false); ok++; } catch (e) { rejected++; const key = e.message.slice(0, 50); why[key] = (why[key] || 0) + 1; }
    maxMs = Math.max(maxMs, Date.now() - t0);
  }
}
console.log(`OCR on 75 corrupted scans in ${Math.round((Date.now() - t00) / 1000)} s: ${ok} handled, ${rejected} refused, slowest ${maxMs} ms`, JSON.stringify(why));
const good = await ocr.request(seeds[0], [1], true);
console.log('engine still healthy afterwards:', /ZEBRA-QUARTZ-7781/.test(good.pages[1]));
ocr.close(); clearInterval(keep);
