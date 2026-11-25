// One contender: takes the lock, proves it is alone, gives it back, again and again.
import fs from 'node:fs';
import { makeChangeLock } from '../tresorit-connector/server/lib/lock.js';
const dir = process.argv[2]; const lock = makeChangeLock(dir, { staleMs: Number(process.argv[3]) || 120000 });
const marker = `${dir}/owner.marker`; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let turns = 0;
for (;;) {
  const release = await lock.take('torture');
  // inside the lock: nobody else may be here
  let other = null;
  try { other = Number(fs.readFileSync(marker, 'utf8')); } catch { other = null; }
  if (other !== null) {
    if (other > 0 && alive(other) && other !== process.pid) { fs.appendFileSync(`${dir}/violations.log`, `${process.pid} found live owner ${other}\n`); }
    fs.rmSync(marker, { force: true }); // left by a contender that was killed while inside
  }
  fs.writeFileSync(marker, String(process.pid));
  await sleep(Math.random() * 4);
  // still ours?
  try { const now = Number(fs.readFileSync(marker, 'utf8')); if (now !== process.pid) fs.appendFileSync(`${dir}/violations.log`, `${process.pid} lost the marker to ${now}\n`); } catch { fs.appendFileSync(`${dir}/violations.log`, `${process.pid} marker vanished\n`); }
  fs.rmSync(marker, { force: true });
  await release();
  if (++turns % 50 === 0) fs.appendFileSync(`${dir}/turns.log`, `${process.pid} ${turns}\n`);
  await sleep(Math.random() * 2);
}
