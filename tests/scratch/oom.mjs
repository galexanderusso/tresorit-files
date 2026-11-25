const { Extractor } = await import('/home/tester/build/tresorit-connector/server/lib/extractor.js');
import fs from 'node:fs';
const x = new Extractor();
const small = '/home/tester/build/mock/Tresors/Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf';
const run = async (f) => { const t0 = Date.now(); const r = await x.extract(f, f.split('.').pop(), fs.statSync(f).size, true); return `${r.status}${r.note ? ' (' + r.note.slice(0, 90) + ')' : ''} ${r.text ? r.text.length : 0} chars ${Date.now() - t0} ms`; };
console.log('limit', process.env.TRESORIT_WORKER_HEAP_MB, '| small:', await run(small));
for (const f of process.argv.slice(2)) console.log('  ', f.split('/').pop(), '->', await run(f));
console.log('   small again:', await run(small), '| inline mode:', x.inline, '| worker replaced', x.recycled, 'time(s)');
await x.close(); process.exit(0);
