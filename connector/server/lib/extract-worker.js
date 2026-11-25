import './quiet.js';
import { parentPort } from 'node:worker_threads';
import v8 from 'node:v8';
import { extractFile } from './extract-core.js';
import { handled } from './tidy.js';

// Each reply reports how much memory this worker holds, so the connector can replace it before it grows large.
const heapMb = () => { try { return Math.round(v8.getHeapStatistics().total_heap_size / 1048576); } catch { return 0; } };

parentPort.postMessage({ ready: true }); // loaded: from here on a failure concerns the document being read

parentPort.on('message', async (job) => {
  try {
    const result = await extractFile(job.abs, job.ext, job.size, job.password ? { password: job.password } : {});
    parentPort.postMessage({ id: job.id, ok: true, result });
    handled(Math.max(job.size || 0, result && result.text ? result.text.length * 2 : 0));
    parentPort.postMessage({ heapMb: heapMb() });
  } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, error: String((e && e.message) || e).slice(0, 300), code: e && typeof e.code === 'string' ? e.code : '' });
    handled(job.size || 0);
    parentPort.postMessage({ heapMb: heapMb() });
  }
});
