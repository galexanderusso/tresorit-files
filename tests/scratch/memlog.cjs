const fs = require('fs'); const { isMainThread } = require('worker_threads');
if (isMainThread) { const t = setInterval(() => { const m = process.memoryUsage(); fs.appendFileSync('/tmp/memlog.txt', `rss ${m.rss >> 20} heapTotal ${m.heapTotal >> 20} heapUsed ${m.heapUsed >> 20} external ${m.external >> 20} buffers ${m.arrayBuffers >> 20}\n`); }, 3000); t.unref(); }
