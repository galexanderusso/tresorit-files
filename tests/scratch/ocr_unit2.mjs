import { Ocr } from '/home/tester/build/unpacked/server/lib/ocr.js';
const keep = setInterval(() => {}, 1000);
const ocr = new Ocr({ enabled: true, force: 'bundled' });
try { const r = await ocr.request('/home/tester/build/scratch/ocr/scan_jpeg.pdf', [1], true); console.log('ok', r.pages[1].slice(0, 40)); } catch (e) { console.log('ERR', e.message); }
console.log(ocr.describe()); ocr.close(); clearInterval(keep);
