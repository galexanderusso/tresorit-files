// Many contenders, and a killer that stops them at random moments (often while they hold the lock).
import fs from 'node:fs'; import { spawn } from 'node:child_process';
const dir = '/home/tester/build/mock/data-locktorture'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const N = Number(process.argv[2]) || 8; const SECS = Number(process.argv[3]) || 40; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = new Set(); let kills = 0, killsWhileHolding = 0;
const add = () => { const c = spawn('node', ['/home/tester/build/scratch/lockworker.mjs', dir], { stdio: 'ignore' }); kids.add(c); c.on('exit', () => kids.delete(c)); };
for (let i = 0; i < N; i++) add();
const end = Date.now() + SECS * 1000;
while (Date.now() < end) {
  await sleep(40 + Math.random() * 160);
  // prefer to kill whoever holds the lock right now
  let victim = null;
  try { const h = JSON.parse(fs.readFileSync(`${dir}/change.lock`, 'utf8')); victim = [...kids].find((k) => k.pid === h.pid) || null; if (victim) killsWhileHolding++; } catch { victim = null; }
  if (!victim || Math.random() < 0.3) victim = [...kids][Math.floor(Math.random() * kids.size)];
  if (victim) { victim.kill('SIGKILL'); kills++; }
  add();
}
for (const k of kids) k.kill('SIGKILL');
await sleep(300);
const turns = fs.existsSync(`${dir}/turns.log`) ? fs.readFileSync(`${dir}/turns.log`, 'utf8').trim().split('\n').length * 50 : 0;
const v = fs.existsSync(`${dir}/violations.log`) ? fs.readFileSync(`${dir}/violations.log`, 'utf8').trim().split('\n') : [];
console.log(`${N} contenders for ${SECS} s: at least ${turns} turns taken; ${kills} kills (${killsWhileHolding} aimed at the holder); two holders at once: ${v.length}`);
if (v.length) console.log(v.slice(0, 8).join('\n'));
console.log('left behind:', fs.readdirSync(dir).filter((x) => /change\.lock/.test(x)).join(', ') || 'nothing but a possible last lock');
