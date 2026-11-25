// Several separate processes writing the same index catalog at once, some of them killed at random moments,
// while a reader keeps checking that the catalog on disk can always be read.
import fs from 'node:fs'; import { spawn } from 'node:child_process';
const LIB = process.argv[2]; const WRITERS = Number(process.argv[3]) || 6; const KILL = process.argv[4] === 'kill'; const N = Number(process.argv[5]) || 300;
const base = '/home/tester/build/mock/data-idxhammer'; const dir = `${base}/index`; fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let unreadable = 0, reads = 0; let stop = false;
(async () => { while (!stop) { try { if (fs.existsSync(`${dir}/catalog.json`)) { JSON.parse(fs.readFileSync(`${dir}/catalog.json`, 'utf8')); reads++; } } catch { unreadable++; } await sleep(1); } })();
const kids = []; let kills = 0; let nextId = 0;
const launch = () => { const id = nextId++; const c = spawn('node', ['/home/tester/build/scratch/idxwriter2.mjs', LIB, dir, String(id), String(N)], { stdio: 'ignore' }); const k = { c, id, done: new Promise((r) => c.on('exit', r)) }; kids.push(k); return k; };
for (let i = 0; i < WRITERS; i++) launch();
if (KILL) for (let i = 0; i < 14; i++) { await sleep(60 + Math.random() * 120); const alive = kids.filter((k) => k.c.exitCode === null && k.c.signalCode === null); if (!alive.length) break; alive[Math.floor(Math.random() * alive.length)].c.kill('SIGKILL'); kills++; launch(); }
await Promise.all(kids.map((k) => k.done)); stop = true; await sleep(20);
// a last copy loads and saves once more (as any copy would)
const { TextIndex } = await import(`${LIB}/textindex.js`); const last = new TextIndex(dir);
const disk = new Set(Object.keys(JSON.parse(fs.readFileSync(`${dir}/catalog.json`, 'utf8')).entries));
let expected = 0, missing = 0, wronglyThere = 0, finished = 0;
for (const k of kids) {
  let lines = []; try { lines = fs.readFileSync(`${base}/saved-${k.id}.log`, 'utf8').trim().split('\n'); } catch { lines = []; }
  if (lines.includes('DONE')) finished++;
  const live = new Set(); const removed = new Set();
  for (const l of lines) { if (l.startsWith('+ ')) live.add(l.slice(2)); else if (l.startsWith('- ')) { live.delete(l.slice(2)); removed.add(l.slice(2)); } }
  for (const key of live) { expected++; if (!disk.has(key)) missing++; }
  for (const key of removed) if (disk.has(key)) wronglyThere++;
}
console.log(`${kids.length} writer processes (${finished} ran to the end, ${kills} killed): ${expected} entries were saved and should be in the catalog; missing ${missing}; removed ones still present ${wronglyThere}; catalog read ${reads} times while being written, unreadable ${unreadable} time(s); lock left behind: ${fs.existsSync(`${dir}/catalog.json.lock`)}; in memory after loading: ${last.map.size}`);
