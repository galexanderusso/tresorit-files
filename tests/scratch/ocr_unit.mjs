import { Ocr } from '../tresorit-connector/server/lib/ocr.js';
const keep = setInterval(() => {}, 1000);
const t0 = Date.now();
const ocr = new Ocr({ enabled: true, force: 'auto', dataDir: '/home/tester/build/mock/ocrdata' });
const r = await ocr.request('/home/tester/build/scratch/ocr/scan_jpeg.pdf', [1, 2], true);
console.log('engine:', ocr.describe(), '|', Date.now() - t0, 'ms');
console.log('page 1:', r.pages[1].split('\n')[0], '| page 2 has ref:', /ZEBRA-QUARTZ-7781/.test(r.pages[2]));
ocr.close(); clearInterval(keep);
