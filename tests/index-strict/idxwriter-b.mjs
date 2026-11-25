// Variant of scratch/idxwriter.mjs with stricter book-keeping, to tell a real loss from an artefact of the test:
//  - a removal is announced in the log BEFORE the save ("~ key"), and confirmed after it ("- key");
//  - additions are logged as saved only when the save really happened (the index no longer has unsaved changes).
import fs from 'node:fs';
const LIB = process.argv[2]; const dir = process.argv[3]; const id = process.argv[4]; const N = Number(process.argv[5]) || 300;
const { TextIndex } = await import(`${LIB}/textindex.js`);
const ix = new TextIndex(dir); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = (n) => ({ size: n + 1, mtimeMs: 5000 + n });
const mine = []; const adds = []; const rems = [];
const logf = `${dir}/../saved-${id}.log`;
const flush = () => {
  if (rems.length) fs.appendFileSync(logf, rems.map((k) => `~ ${k}`).join('\n') + '\n');
  ix.save();
  if (ix.dirty) { fs.appendFileSync(logf, 'SAVE-FAILED\n'); return; }
  const lines = [...adds.map((k) => `+ ${k}`), ...rems.map((k) => `- ${k}`)];
  if (lines.length) fs.appendFileSync(logf, lines.join('\n') + '\n');
  adds.length = 0; rems.length = 0;
};
for (let i = 0; i < N; i++) {
  const key = `w${id}/doc-${i}.txt`;
  await ix.put(key, st(i), { status: 'ok', text: `text of ${key}` }); mine.push(key); adds.push(key);
  if (i % 9 === 4 && mine.length > 3) { const gone = mine.splice(Math.floor(Math.random() * (mine.length - 1)), 1)[0]; ix.remove(gone); const a = adds.indexOf(gone); if (a >= 0) adds.splice(a, 1); else rems.push(gone); }
  if (Math.random() < 0.35) flush();
  if (Math.random() < 0.2) ix.refresh(true);
  if (Math.random() < 0.3) await sleep(Math.random() * 3);
}
flush();
fs.appendFileSync(logf, 'DONE\n');
