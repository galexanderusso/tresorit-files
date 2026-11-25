// Corrupts real files in thousands of ways and feeds them to the readers. Pass criteria: the process never dies,
// every job comes back, and nothing runs past the time limit without being cut off.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
process.env.TRESORIT_JOB_TIMEOUT_MS = '15000';
const LIB = process.env.LIB || '/home/tester/build/tresorit-connector/server/lib';
const { Extractor } = await import(LIB + '/extractor.js');
const { unzipSync, zipSync } = await import('/home/tester/build/tresorit-connector/node_modules/fflate/esm/index.mjs');
const keep = setInterval(() => {}, 1000);
const R = '/home/tester/build/mock/Tresors';
const seeds = [
  `${R}/Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx`, `${R}/Alder Works UK/03 - Finance/Commission tracker 2026.xlsx`, `${R}/Alder Works UK/07 - Research/ORBIT/ORBIT pilot deck.pptx`,
  `${R}/Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf`, `${R}/Alder Works UK/08 - Real files/filled form.pdf`, `${R}/Personal/Scans/Settlement one-bit.pdf`,
  `${R}/Alder Works UK/05 - Legacy/SampleDoc.doc`, `${R}/Alder Works UK/05 - Legacy/footnote.doc`, `${R}/Alder Works UK/05 - Legacy/SimpleWithFormula.xls`, `${R}/Alder Works UK/05 - Legacy/Commission tracker 2026.xls`,
  `${R}/Alder Works UK/05 - Legacy/basic_test_ppt_file.ppt`, `${R}/Alder Works UK/06 - Emails/multi-to.msg`, `${R}/Alder Works UK/06 - Emails/htmlLink.msg`, `${R}/Alder Works UK/06 - Emails/msgInMsgInMsg.msg`,
  `${R}/Alder Works UK/08 - Real files/prefixed shared strings.xlsx`, `${R}/Alder Works UK/08 - Real files/Reordered deck.pptx`, `${R}/Alder Works UK/08 - Real files/Payment dates.xls`, `${R}/Alder Works UK/05 - Legacy/letter.doc`,
].filter((f) => fs.existsSync(f));
let seed = 987654321; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const ri = (n) => Math.floor(rnd() * n);
function mutateBytes(buf) {
  let b = Buffer.from(buf);
  const kind = ri(7);
  if (kind === 0) for (let i = 0, n = 1 + ri(20); i < n; i++) b[ri(b.length)] ^= 1 << ri(8);
  else if (kind === 1) b = b.subarray(0, 1 + ri(b.length));
  else if (kind === 2) { const a = ri(b.length), l = Math.min(1 + ri(4096), b.length - a); b.fill(0, a, a + l); }
  else if (kind === 3) { const a = ri(b.length), l = Math.min(1 + ri(8192), b.length - a); b = Buffer.concat([b.subarray(0, a + l), b.subarray(a, a + l), b.subarray(a + l)]); }
  else if (kind === 4) { const a = ri(b.length); const junk = Buffer.alloc(1 + ri(2000)); for (let i = 0; i < junk.length; i++) junk[i] = ri(256); b = Buffer.concat([b.subarray(0, a), junk, b.subarray(a)]); }
  else if (kind === 5) for (let i = 0, n = 1 + ri(6); i < n; i++) b.writeUInt32LE([0xffffffff, 0xfffffffe, 0, 0x7fffffff, 0x80000000, 1][ri(6)], Math.max(0, ri(b.length - 4)));
  else { const a = ri(b.length), l = Math.min(1 + ri(64), b.length - a); for (let i = a; i < a + l; i++) b[i] = 0xff; }
  return b;
}
function mutateXml(str) {
  const kind = ri(7);
  const a = ri(str.length);
  if (kind === 0) return str.slice(0, a) + str.slice(a + 1 + ri(200));
  if (kind === 1) return str.slice(0, a) + '<w:t>' + 'A'.repeat(ri(200000)) + str.slice(a);
  if (kind === 2) return str.replace(/>/g, () => (rnd() < 0.02 ? '' : '>'));
  if (kind === 3) return str.slice(0, a) + '<row><c t="s"><v>' + (ri(2) ? '99999999999' : '-5') + '</v></c>'.repeat(1 + ri(3)) + str.slice(a);
  if (kind === 4) return str.slice(0, a) + '<x:si>'.repeat(ri(5000)) + str.slice(a);
  if (kind === 5) return str.slice(0, a) + '&#x' + 'F'.repeat(ri(40)) + ';&#99999999999;&bogus;' + str.slice(a);
  return str.slice(0, a) + '<Relationship Id="rId1" Target="../../../../etc/passwd" Type="x/notesSlide"/><sheet name="x" r:id="rId1"/><p:sldId r:id="rId1"/>' + str.slice(a);
}
function mutateZip(buf) {
  let files;
  try { files = unzipSync(new Uint8Array(buf)); } catch { return mutateBytes(buf); }
  const names = Object.keys(files).filter((n) => /\.(xml|rels)$/.test(n));
  if (!names.length) return mutateBytes(buf);
  for (let i = 0, n = 1 + ri(3); i < n; i++) { const name = names[ri(names.length)]; files[name] = Buffer.from(mutateXml(Buffer.from(files[name]).toString('utf8')), 'utf8'); }
  if (rnd() < 0.15) delete files[names[ri(names.length)]];
  return Buffer.from(zipSync(files));
}
const tmp = '/home/tester/build/scratch/fuzz-tmp'; fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
const ex = new Extractor();
const N = Number(process.env.FUZZ_N || 130);
const tally = {}; let jobs = 0, timeouts = 0, maxMs = 0; const slowest = []; const t00 = Date.now(); const notes = {};
for (const s of seeds) {
  const ext = path.extname(s).slice(1).toLowerCase(); const orig = fs.readFileSync(s); const isZip = orig[0] === 0x50 && orig[1] === 0x4b;
  const per = ext === 'pdf' ? Math.round(N / 2) : N;
  for (let i = 0; i < per; i++) {
    const m = isZip && rnd() < 0.6 ? mutateZip(orig) : mutateBytes(orig);
    const f = path.join(tmp, `m.${ext}`); fs.writeFileSync(f, m);
    const t0 = Date.now();
    const r = await ex.extract(f, ext, m.length, true);
    const ms = Date.now() - t0; jobs++; maxMs = Math.max(maxMs, ms);
    if (!r || typeof r.status !== 'string') { console.log('BAD RESULT', s, i, JSON.stringify(r)); process.exit(2); }
    tally[r.status] = (tally[r.status] || 0) + 1;
    if (/timed out/.test(r.note || '')) { timeouts++; fs.copyFileSync(f, path.join(tmp, `timeout-${timeouts}.${ext}`)); }
    if (ms > 4000) slowest.push(`${path.basename(s)}#${i} ${ms}ms ${r.status}`);
    if (r.status === 'error') { const k = (r.note || '').replace(/\d+/g, 'N').slice(0, 48); notes[k] = (notes[k] || 0) + 1; }
  }
}
console.log(`${jobs} corrupted files from ${seeds.length} originals in ${Math.round((Date.now() - t00) / 1000)} s: ${JSON.stringify(tally)}`);
console.log(`worker restarts forced by the time limit: ${timeouts} | slowest job ${maxMs} ms | over 4 s: ${slowest.length ? slowest.slice(0, 6).join('; ') : 'none'}`);
console.log('most common refusals:', Object.entries(notes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v}x ${k}`).join(' | '));
const final = await ex.extract(seeds[0], 'docx', fs.statSync(seeds[0]).size, true);
console.log('reader still healthy afterwards:', final.status === 'ok' && final.text.includes('Megaphos'));
await ex.close(); clearInterval(keep);
