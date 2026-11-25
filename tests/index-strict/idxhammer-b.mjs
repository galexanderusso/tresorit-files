// Variant of scratch/idxhammer.mjs that uses idxwriter-b.mjs and counts separately:
//  missing      = saved for certain, never announced for removal, and not in the catalog (a real loss);
//  ambiguous    = announced for removal but the writer was stopped before confirming (either state is right);
//  oldCount     = what the original book-keeping would have reported as missing.
import fs from 'node:fs'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const LIB = process.argv[2]; const WRITERS = Number(process.argv[3]) || 6; const KILL = process.argv[4] === 'kill'; const N = Number(process.argv[5]) || 300;
const base = process.env.IDX_BASE; if (!base) throw new Error('Set IDX_BASE to an empty work folder: it is removed and created again');
const dir = `${base}/index`; fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const writer = fileURLToPath(new URL('./idxwriter-b.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = []; let kills = 0; let nextId = 0;
const launch = () => { const id = nextId++; const c = spawn('node', [writer, LIB, dir, String(id), String(N)], { stdio: 'ignore' }); const k = { c, id, done: new Promise((r) => c.on('exit', r)) }; kids.push(k); return k; };
for (let i = 0; i < WRITERS; i++) launch();
if (KILL) for (let i = 0; i < 14; i++) { await sleep(60 + Math.random() * 120); const alive = kids.filter((k) => k.c.exitCode === null && k.c.signalCode === null); if (!alive.length) break; alive[Math.floor(Math.random() * alive.length)].c.kill('SIGKILL'); kills++; launch(); }
await Promise.all(kids.map((k) => k.done)); await sleep(20);
const { TextIndex } = await import(`${LIB}/textindex.js`); const last = new TextIndex(dir);
const disk = new Set(Object.keys(JSON.parse(fs.readFileSync(`${dir}/catalog.json`, 'utf8')).entries));
let expected = 0, missing = 0, ambiguous = 0, oldCount = 0, wronglyThere = 0, saveFailed = 0;
for (const k of kids) {
  let lines = []; try { lines = fs.readFileSync(`${base}/saved-${k.id}.log`, 'utf8').trim().split('\n'); } catch { lines = []; }
  const live = new Set(); const removed = new Set(); const announced = new Set();
  for (const l of lines) { if (l.startsWith('+ ')) live.add(l.slice(2)); else if (l.startsWith('- ')) { live.delete(l.slice(2)); removed.add(l.slice(2)); } else if (l.startsWith('~ ')) announced.add(l.slice(2)); else if (l === 'SAVE-FAILED') saveFailed++; }
  for (const key of live) {
    if (!disk.has(key)) oldCount++;
    if (announced.has(key)) { ambiguous++; continue; }
    expected++; if (!disk.has(key)) missing++;
  }
  for (const key of removed) if (disk.has(key)) wronglyThere++;
}
console.log(`${kids.length} writers, ${kills} killed: certain ${expected}; missing ${missing}; ambiguous ${ambiguous}; oldCount ${oldCount}; removed still present ${wronglyThere}; saves that failed ${saveFailed}; lock left behind: ${fs.existsSync(`${dir}/catalog.json.lock`)}; in memory ${last.map.size}`);
