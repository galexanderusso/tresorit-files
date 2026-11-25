import { Client, StdioClientTransport, MOCK, BUNDLE, serverLib } from './lib/env.mjs';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
let pass = 0, fail = 0;
const keepAlive = setInterval(() => {}, 1000);
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, String(d).slice(0, 500)); } };
const F = `${MOCK}/Tresors/Alder Works UK/07 - Research/ORBIT/README.md`;
const { Extractor } = await serverLib('extractor.js');

// A. a user request interrupts a long background job, which then restarts and completes
{
  const ex = new Extractor();
  fs.writeFileSync(`${MOCK}/slow-worker.mjs`, `
    import { parentPort } from 'node:worker_threads';
    import { extractFile } from '${BUNDLE}/server/lib/extract-core.js';
    let n = 0;
    parentPort.on('message', async (job) => { if (n++ === 0) { const end = Date.now() + 8000; while (Date.now() < end) {} }
      parentPort.postMessage({ id: job.id, ok: true, result: await extractFile(job.abs, job.ext, job.size) }); });`);
  const realSpawn = ex._spawn.bind(ex);
  let first = true;
  ex._spawn = function () {
    if (!first) return realSpawn();
    first = false;
    const w = new Worker(`${MOCK}/slow-worker.mjs`);
    w.on('message', (m) => { if (this.worker === w) this._finish(m); }); w.unref(); this.worker = w;
  };
  const t0 = Date.now();
  let bgDone = 0;
  const bgJob = ex.extract(F, 'md', 50, false).then((r) => { bgDone = Date.now() - t0; return r; });
  await new Promise((x) => setTimeout(x, 300));
  const pr = await ex.extract(F, 'md', 50, true);
  const prTime = Date.now() - t0;
  check('user request served at once despite a busy background job', pr.status === 'ok' && prTime < 1500, prTime);
  const pr2 = await ex.extract(F, 'md', 50, true);
  check('second user request also immediate', pr2.status === 'ok' && Date.now() - t0 < 2000);
  const b = await bgJob;
  check('interrupted background job restarts after the pause and completes', b.status === 'ok' && bgDone > 2000 && bgDone < 6000, bgDone);
  await ex.close();
}
// B. fallback when worker threads cannot start
{
  const ex = new Extractor();
  ex._spawn = function () { throw new Error('workers unavailable'); };
  const r = await ex.extract(F, 'md', 50, true);
  const r2 = await ex.extract(F, 'md', 50, false);
  check('falls back to in-process reading', r.status === 'ok' && r2.status === 'ok' && ex.inline === true);
}
// C. search while the background pass is running over the big tree
{
  const DATA = `${MOCK}/data4`;
  fs.rmSync(DATA, { recursive: true, force: true });
  const transport = new StdioClientTransport({ command: 'node', args: [process.env.SERVER || `${BUNDLE}/server/index.js`], env: { ...process.env, TRESORIT_ROOT: `${MOCK}/Tresors`, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '200' }, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).content.map((c) => c.text || '').join('\n');
  await new Promise((x) => setTimeout(x, 1500));
  let st = await call('tresorit_connector_status', {});
  check('background pass is in progress', /in progress/.test(st), st.split('\n').find((l) => /Background/.test(l)));
  const t0 = Date.now();
  const [a, b, c] = await Promise.all([
    call('tresorit_search_contents', { query: 'needle-zebra-42' }),
    call('tresorit_read_file', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf' }),
    call('tresorit_find_files', { query: 'report 123' }),
  ]);
  check('search during indexing finds both needles', a.includes('report 123.pdf') && a.includes('notes 17-3.txt'), a.slice(0, 400));
  check('read during indexing works', b.includes('boson sampling'));
  check('find during indexing works', c.includes('report 123.pdf'));
  console.log('       three concurrent calls took', Date.now() - t0, 'ms');
  let ok = false;
  for (let i = 0; i < 600 && !ok; i++) { await new Promise((x) => setTimeout(x, 500)); st = await call('tresorit_connector_status', {}); ok = /up to date as of/.test(st); }
  check('background pass still completes afterwards', ok, st);
  console.log('      ', st.split('\n').filter((l) => /Search index:|Background/.test(l)).join('\n       '));
  await client.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
