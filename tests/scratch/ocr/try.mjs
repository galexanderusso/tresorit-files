import fs from 'node:fs';
import { getDocumentProxy, extractImages, extractText } from '../../tresorit-connector/node_modules/unpdf/dist/index.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createWorker } = require('../../tresorit-connector/node_modules/tesseract.js');
const t0 = Date.now();
const worker = await createWorker(['eng', 'por'], 1, { langPath: '/home/tester/build/scratch/ocr/lang', cacheMethod: 'none', gzip: true });
console.log('worker ready', Date.now() - t0, 'ms');
for (const f of process.argv.slice(2)) {
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(f)), { isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  console.log(`\n== ${f.split('/').pop()}: ${totalPages} page(s), text layer chars: ${text.trim().length}`);
  for (let p = 1; p <= totalPages; p++) {
    const imgs = await extractImages(pdf, p, { format: 'png' });
    for (const im of imgs) {
      const t1 = Date.now();
      const { data } = await worker.recognize(Buffer.from(im.data));
      console.log(`  page ${p}: image ${im.width}x${im.height} png ${Math.round(im.data.length / 1024)}KB bounds ${JSON.stringify(im.bounds)} ocr ${Date.now() - t1} ms, confidence ${data.confidence}`);
      console.log('   | ' + data.text.trim().split('\n').join('\n   | '));
    }
  }
}
await worker.terminate();
