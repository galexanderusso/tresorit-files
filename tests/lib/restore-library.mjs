// Puts a clean copy of the ready-made test library in <TEST_BASE>/mock:  node lib/restore-library.mjs A|B|C
//   A = after make_mock.py; B = A plus make_mock2.py; C = B plus make_mock3.py and make_scale.py
// Replaces mock/Tresors and mock/outside-secret only. The files get today's date (the tests expect that).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MOCK } from './env.mjs';

const which = String(process.argv[2] || '').toUpperCase();
if (!['A', 'B', 'C'].includes(which)) { console.error('usage: node lib/restore-library.mjs A|B|C'); process.exit(2); }
const archive = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'library', `test-library-${which}.tar.gz`);
if (!MOCK.endsWith('/mock')) throw new Error(`unexpected test folder: ${MOCK}`);
fs.mkdirSync(MOCK, { recursive: true });
for (const d of ['Tresors', 'outside-secret']) fs.rmSync(path.join(MOCK, d), { recursive: true, force: true });
execFileSync('tar', ['-xmzf', archive, '-C', MOCK], { stdio: 'inherit' });
// The library holds two links on purpose: one that points outside the library (re-pointed here to wherever
// outside-secret has landed) and one that points to nothing (left as it is).
const link = path.join(MOCK, 'Tresors', 'Alder Works UK', 'escape-link');
fs.rmSync(link, { force: true });
fs.symlinkSync(path.join(MOCK, 'outside-secret'), link);
// One file stands for a document that is "online only": it has a size but takes no room on the disk. An archive
// stores it as ordinary zeros, so it is made again here the way make_mock.py makes it.
const hollow = path.join(MOCK, 'Tresors', 'Personal', 'Tax', 'Online only report.txt');
fs.rmSync(hollow, { force: true });
{ const fd = fs.openSync(hollow, 'w'); fs.ftruncateSync(fd, 50000); fs.closeSync(fd); }
if (fs.statSync(hollow).blocks !== 0) console.log('NOTE: this disk gave the "online only" file real room; two checks of test.mjs will fail');
// The small fixed files (protected PDFs, pictures) that test14, test16 and some helpers expect beside the library.
fs.rmSync(path.join(MOCK, 'data-fx14'), { recursive: true, force: true });
fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'data-fx14'), path.join(MOCK, 'data-fx14'), { recursive: true });
// Three very large documents that test10 needs beside the tests (scratch/big). They are kept as one archive.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const big = path.join(here, '..', 'scratch', 'big'); const packed = path.join(here, '..', 'library', 'test10-large-documents.tar.gz');
  if (which === 'C' && !fs.existsSync(path.join(big, 'rows300k.xlsx')) && fs.existsSync(packed)) execFileSync('tar', ['-xzf', packed, '-C', path.join(here, '..', 'scratch')], { stdio: 'inherit' });
}
let files = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else files++; } };
walk(path.join(MOCK, 'Tresors'));
console.log(`library ${which} restored in ${MOCK}: ${files} items that are not folders`);
