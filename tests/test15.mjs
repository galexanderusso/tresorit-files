import { TESTS } from './lib/env.mjs';
// 1.4.0 deep check kept as a permanent suite: runs each section of scratch/probe140.mjs and judges its report.
import { execFile } from 'node:child_process';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} \n       ${String(detail).slice(0, 900)}`); } };
const run = (section, extra = [], ms = 560000, script = 'probe140.mjs') => new Promise((res) => execFile('node', [`${TESTS}/scratch/${script}`, section, ...extra], { timeout: ms, maxBuffer: 1 << 24, env: process.env }, (e, out, err) => res(String(out || '') + (e ? `\n[ended: ${e.message.slice(0, 200)}] ${String(err || '').slice(-400)}` : ''))));

console.log('A. The transfer folder');
let o = await run('transfer');
check('a transfer folder replaced by a link is never emptied (neither a Tresorit folder nor another folder loses a file)', /: refused \(1 file\(s\) still there\); refused \(1 file\(s\) still there\)/.test(o), o);

console.log('B. Passwords');
o = await run('withdrawn');
check('a request withdrawn while the password box is open opens nothing, stores nothing, sends nothing back', /unlock recorded as withdrawn: true; single read recorded as withdrawn: true; anything unlocked into the index: false; text sent back after the withdrawal: false; password in data: 0/.test(o), o);
o = await run('real');
check('142 protected PDFs under two passwords: 138 open with the first, the other 4 are reported and open with the second', /first password 138 of 142[^\n]*\n?[^\n]*/.test(o) && /4 were NOT opened/.test(o) && /second password: 4 of 4/.test(o), o);
check('they are searchable afterwards and no longer counted as unreadable', /searchable: true and true; status: 142 password-protected PDF\(s\) were opened[^\n]*Unreadable by reason: 0 password-protected/.test(o), o);
check('neither password is in any file of the connector or in anything it sent back', /either password in the data folder: 0 file\(s\); in anything the connector sent back: false/.test(o), o);
o = await run('kill');
check('killed repeatedly in the middle of unlocking: no password on disk, the catalogue stays readable, a later run finishes the job', /password found in a file or an output 0 time\(s\); catalogue unreadable 0 time\(s\); a final run finished the job[^\n]*first and last file searchable: true \/ true/.test(o), o);

console.log('C. Malformed files');
o = await run('fuzz', ['2500']);
check('2,500 random, cut-off and corrupted files: the reader never throws, never hangs, always gives a known kind of answer', /the reader threw 0 time\(s\), gave an answer of an unknown kind 0 time\(s\), took over 5 s 0 time\(s\)/.test(o), o);
o = await run('badpics', [], 400000);
check('corrupt pictures saved as .pdf are all answered, and a good one is still read afterwards', /12 of 12 answered[^\n]*still read afterwards: true; connector still running: true/.test(o), o);

console.log('D. The new features with three copies of the connector at once');
o = await run('race', ['3'], 560000, 'probe140b.mjs');
check('right after the update from 1.3.5, folders unlocked through each of three copies while the old failures are re-read: every opened file stays searchable', /unlock reported 405 opened; sampled files not searchable afterwards: 0; copies disagreeing: 0; rounds with a wrong status count: 0/.test(o), o);
o = await run('newfiles', ['3'], 560000, 'probe140b.mjs');
check('new protected files unlocked through one copy while another reads them in the background stay searchable', /unlock reported 180 opened; sampled files not searchable afterwards: 0/.test(o), o);
o = await run('transfer', [], 300000, 'probe140b.mjs');
check('transfer folder: a changed list is refused, a token from another copy is not accepted', /changed after the preview is refused: true; a token from another copy is not accepted: true/.test(o), o);
check('two confirmations of the same list at the same moment: exactly one removes it, the other is refused', /two confirmations of the same list at once: refused \+ removed 2, left 0 item\(s\)/.test(o), o);
// while a third copy exports: either one confirmation wins and the other is refused (the fresh export is all that is
// left), or the export lands first and both are refused (nothing removed). Never both, never the fresh export harmed.
check('two confirmations while a third copy exports: never both carried out, the fresh export survives whole, the log matches, originals untouched', (/while a third copy exports 20 files: refused \+ removed 2, export: done, left in the transfer folder: 20 file\(s\); removals in the log: 2;/.test(o) || /while a third copy exports 20 files: refused \+ refused, export: done, left in the transfer folder: 10\+10\+20 file\(s\); removals in the log: 1;/.test(o)) && /originals in Tresorit: 40 of 40; connectors alive: true/.test(o), o);
o = await run('identical', [], 300000, 'probe140b.mjs');
check('identical files asked through three copies at once: the same right answer, also after files change; the fingerprint file stays whole', /first answers 100\/100\/100 group\(s\)[^\n]*different answer: 0; after 30 files were changed: 100 group\(s\)[^\n]*unreadable 0 time/.test(o), o);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
