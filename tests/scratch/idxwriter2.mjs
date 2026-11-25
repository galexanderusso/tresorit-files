// One copy of the connector's index, in its own process: adds and removes entries and saves, as fast as it can.
import fs from 'node:fs';
const LIB = process.argv[2]; const dir = process.argv[3]; const id = process.argv[4]; const N = Number(process.argv[5]) || 300;
const { TextIndex } = await import(`${LIB}/textindex.js`);
const ix = new TextIndex(dir); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = (n) => ({ size: n + 1, mtimeMs: 5000 + n });
const mine = []; const pendingLog = [];
const flush = () => { if (ix.save() === false) return; if (pendingLog.length) { fs.appendFileSync(`${dir}/../saved-${id}.log`, pendingLog.join('\n') + '\n'); pendingLog.length = 0; } };
for (let i = 0; i < N; i++) {
  const key = `w${id}/doc-${i}.txt`;
  await ix.put(key, st(i), { status: 'ok', text: `text of ${key}` }); mine.push(key); pendingLog.push(`+ ${key}`);
  if (i % 9 === 4 && mine.length > 3) { const gone = mine.splice(Math.floor(Math.random() * (mine.length - 1)), 1)[0]; ix.remove(gone); pendingLog.push(`- ${gone}`); }
  if (Math.random() < 0.35) flush();
  if (Math.random() < 0.2) ix.refresh(true);
  if (Math.random() < 0.3) await sleep(Math.random() * 3);
}
flush();
fs.appendFileSync(`${dir}/../saved-${id}.log`, 'DONE\n');
