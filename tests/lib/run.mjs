// Runs suites one after the other on a fresh library:  node lib/run.mjs A|B|C suite[:seconds] [suite[:seconds] ...]
// Example (one line of the old run_all.sh):  node lib/run.mjs B test5 test6 test8
// Needs TEST_BASE and SERVER as lib/env.mjs describes. Each suite's full output goes to <TEST_BASE>/results/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUILD, TESTS } from './env.mjs';

const [lib, ...suites] = process.argv.slice(2);
if (!lib || !suites.length) { console.error('usage: node lib/run.mjs A|B|C suite[:seconds] ...'); process.exit(2); }
const out = path.join(BUILD, 'results'); fs.mkdirSync(out, { recursive: true });
const r0 = spawnSync(process.execPath, [path.join(TESTS, 'lib', 'restore-library.mjs'), lib], { encoding: 'utf8' });
if (r0.status !== 0) { console.log(`LIBRARY ${lib} COULD NOT BE RESTORED: ${r0.stderr || r0.stdout}`); process.exit(2); }
let bad = 0;
for (const item of suites) {
  const [name, secs] = item.split(':');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(TESTS, `${name}.mjs`)], { env: process.env, encoding: 'utf8', timeout: (Number(secs) || 900) * 1000, maxBuffer: 1 << 27 });
  const text = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`;
  fs.writeFileSync(path.join(out, `${name}.out`), text);
  const m = [...text.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  const fails = text.split('\n').filter((l) => /^\s*FAIL/.test(l)).length;
  const skips = text.split('\n').filter((l) => /^\s*skip\s/.test(l)).length; // a suite that skips everything must not look like a full pass
  const ended = r.error ? `did not finish (${r.error.code || r.error.message})` : `exit ${r.status}`;
  if (!m || Number(m[2]) || r.status !== 0) bad++;
  console.log(`SUITE ${name} on library ${lib}: ${m ? `${m[1]} passed, ${m[2]} failed` : 'NO RESULT LINE'}; FAIL lines ${fails}; skipped parts ${skips}; ${ended}; ${Math.round((Date.now() - t0) / 1000)} s`);
}
process.exit(bad ? 1 : 0);
