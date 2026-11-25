// Worker thread: text recognition for scanned PDF pages with the bundled engine (works on any computer, offline).
import './quiet.js';
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let engine = null;

async function getEngine() {
  if (!engine) {
    const { createWorker } = require('tesseract.js');
    engine = await createWorker(['eng', 'por'], 1, {
      langPath: workerData.langPath,
      workerPath: workerData.innerWorkerPath,
      cacheMethod: 'none',
      gzip: true,
      errorHandler: () => {},
    });
  }
  return engine;
}

const usable = (im) => im.width >= 300 && im.height >= 60 && im.width * im.height <= 40_000_000;
// Top of the page first (PDF coordinates start at the bottom), then left to right.
const byPosition = (a, b) => ((b.bounds?.y ?? 0) + (b.bounds?.height ?? 0)) - ((a.bounds?.y ?? 0) + (a.bounds?.height ?? 0)) || (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0);

parentPort.on('message', async (job) => {
  try {
    const { getDocumentProxy, extractImages } = await import('unpdf');
    const eng = await getEngine();
    const buf = await fs.readFile(job.abs);
    // A picture saved under a document's name is recognised as it is: one page.
    const { imageKind } = await import('./sniff.js');
    if (imageKind(buf)) {
      let text = '';
      if (buf.length <= 30 * 1024 * 1024) try { const { data } = await eng.recognize(buf); if (data.confidence >= 40) text = (data.text || '').trim(); } catch { text = ''; }
      parentPort.postMessage({ id: job.id, progress: 1 });
      parentPort.postMessage({ id: job.id, ok: true, pages: { 1: text } });
      return;
    }
    const pdfOpts = { verbosity: 0, isOffscreenCanvasSupported: false, isImageDecoderSupported: false };
    if (job.password) pdfOpts.password = job.password; // in memory, for this file only
    const pdf = await getDocumentProxy(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), pdfOpts);
    const pages = {};
    try {
      for (const p of job.pages) {
        if (p < 1 || p > pdf.numPages) continue;
        let texts = [];
        try {
          const imgs = (await extractImages(pdf, p, { format: 'png' })).filter(usable).sort(byPosition).slice(0, 20);
          for (const im of imgs) {
            const { data } = await eng.recognize(Buffer.from(im.data));
            const t = (data.text || '').trim();
            if (t && data.confidence >= 40) texts.push(t); // below this the "text" is usually noise read off a picture
          }
        } catch { texts = []; }
        pages[p] = texts.join('\n');
        parentPort.postMessage({ id: job.id, progress: p });
      }
    } finally {
      try { if (pdf.loadingTask && typeof pdf.loadingTask.destroy === 'function') await pdf.loadingTask.destroy(); else await pdf.destroy(); } catch { /* ignore */ }
    }
    parentPort.postMessage({ id: job.id, ok: true, pages });
  } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, error: (e && e.name === 'PasswordException') ? 'the PDF is password-protected' : String((e && e.message) || e).slice(0, 300) });
  }
});
