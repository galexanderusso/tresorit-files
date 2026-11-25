import { Client, StdioClientTransport, BUILD, MOCK, BUNDLE } from '../lib/env.mjs';
// Second deep check of 1.4.0: the new features with three copies of the connector running at once.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const OLD = `${BUILD}/ref135/server/index.js`;
const BASE = `${MOCK}`; const ROOT = `${BASE}/Tresors`; const FX = `${BASE}/data-fx14`; const W = 'Birch Labs/p140b';
const PW = fs.readFileSync(`${FX}/pw.txt`, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
const which = process.argv[2] || 'all'; const ROUNDS = Number(process.argv[3]) || 3;
const PWSH = `${BASE}/data-p140b-pw.sh`; fs.writeFileSync(PWSH, `cat "${FX}/pw.txt"\n`);
async function start(server, DATA, extra = {}) {
  const transport = new StdioClientTransport({ command: 'node', args: [server], env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_PASSWORD_CMD: JSON.stringify(['/bin/sh', PWSH]), ...extra }, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => { try { return (await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n'); } catch (e) { return `CALL FAILED: ${e.message}`; } };
  return { client, call, pid: transport.pid };
}
const settle = async (copies, extraMs = 6500) => { for (let i = 0; i < 600; i++) { await sleep(500); const s = await Promise.all(copies.map((c) => c.call('connector_status'))); if (s.every((x) => /up to date as of/.test(x))) break; } await sleep(extraMs); };
const makeLocked = (dir, n, prefix) => {
  fs.mkdirSync(T(dir), { recursive: true });
  execFileSync('python3', ['-c', `
import subprocess, sys
from reportlab.pdfgen import canvas
d, n, pw, prefix = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
for i in range(n):
    c = canvas.Canvas('/tmp/p140b-plain.pdf', pagesize=(400, 200)); c.setFont('Helvetica', 12)
    c.drawString(30, 150, 'Conta de energia eletrica referente ao mes numero %d' % i); c.drawString(30, 130, 'Marker P140B-%s-%04d valor total R$ %d,00' % (prefix, i, 100 + i)); c.save()
    subprocess.run(['qpdf', '--encrypt', pw, 'o', '256', '--', '/tmp/p140b-plain.pdf', '%s/%s %03d.pdf' % (d, prefix, i)], check=True)
`, T(dir), String(n), PW, prefix]);
};
const countFound = async (copy, prefix, n, dir) => { let found = 0; for (let i = 0; i < n; i += 7) { const r = await copy.call('search_contents', { query: `P140B-${prefix}-${String(i).padStart(4, '0')}`, path: dir }); if (new RegExp(`${prefix} ${String(i).padStart(3, '0')}\\.pdf`).test(r)) found++; } return { found, of: Math.ceil(n / 7) }; };
fs.rmSync(T(W), { recursive: true, force: true });

if (which === 'all' || which === 'race') {
  // The situation right after the update: the catalogue comes from 1.3.5, the background copy re-reads the old
  // failures, and at that very moment folders are unlocked through each of the three copies.
  let lost = 0, total = 0, mismatch = 0, statusWrong = 0; const detail = [];
  for (let round = 0; round < ROUNDS; round++) {
    fs.rmSync(T(W), { recursive: true, force: true });
    for (const p of ['a', 'b', 'c']) makeLocked(`${W}/${p}`, 45, p);
    fs.mkdirSync(T(`${W}/filler`), { recursive: true }); const pdf = fs.readFileSync(`${FX}/plain.pdf`);
    for (let i = 0; i < 260; i++) fs.writeFileSync(T(`${W}/filler/cut ${i}.pdf`), pdf.subarray(0, 200 + i));
    const DATA = `${BASE}/data-p140b-race`; fs.rmSync(DATA, { recursive: true, force: true });
    const old = await start(OLD, DATA); await settle([old], 6000); await old.client.close(); await sleep(500);
    const copies = await Promise.all([start(SERVER, DATA), start(SERVER, DATA), start(SERVER, DATA)]);
    await sleep(round * 400); // a different moment each round
    const res = await Promise.all(['a', 'b', 'c'].map((p, k) => copies[k].call('unlock_folder', { path: `${W}/${p}` })));
    const said = res.map((r) => Number((r.match(/^(\d+) of \d+/) || [0, 0])[1]));
    await settle(copies);
    for (const [k, p] of ['a', 'b', 'c'].entries()) {
      total += said[k];
      const seen = await Promise.all(copies.map((c) => countFound(c, p, 45, `${W}/${p}`)));
      const worst = Math.min(...seen.map((s) => s.found)); if (new Set(seen.map((s) => s.found)).size > 1) mismatch++;
      if (said[k] === 45 && worst < seen[0].of) { lost += seen[0].of - worst; detail.push(`round ${round} folder ${p}: ${worst} of ${seen[0].of} sampled files searchable`); }
      if (said[k] !== 45) detail.push(`round ${round} folder ${p}: unlock said ${res[k].slice(0, 100)}`);
    }
    const st = await Promise.all(copies.map((c) => c.call('connector_status')));
    const opened = st.map((s) => Number((s.match(/(\d+) password-protected PDF\(s\) were opened/) || [0, 0])[1]));
    const still = st.map((s) => Number((s.match(/Unreadable by reason: (\d+) password-protected/) || [0, 0])[1]));
    if (!opened.every((n) => n === 135) || !still.every((n) => n === 0)) { statusWrong++; detail.push(`round ${round}: status says opened ${opened.join('/')} and still protected ${still.join('/')}`); }
    for (const c of copies) await c.client.close();
    await sleep(300);
  }
  console.log(`UNLOCKING THROUGH THREE COPIES right after the update (${ROUNDS} round(s), 135 files each): unlock reported ${total} opened; sampled files not searchable afterwards: ${lost}; copies disagreeing: ${mismatch}; rounds with a wrong status count: ${statusWrong}${detail.length ? '\n  ' + detail.slice(0, 8).join('\n  ') : ''}`);
}

if (which === 'all' || which === 'newfiles') {
  // New protected files arrive while the connector runs; they are unlocked through one copy while another reads them in the background.
  const DATA = `${BASE}/data-p140b-new`; fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(T(W), { recursive: true, force: true }); fs.mkdirSync(T(W), { recursive: true });
  const copies = await Promise.all([start(SERVER, DATA), start(SERVER, DATA), start(SERVER, DATA)]); await settle(copies, 1000);
  let lost = 0, said = 0; const detail = [];
  for (let round = 0; round < ROUNDS; round++) {
    const p = `n${round}`; makeLocked(`${W}/${p}`, 60, p);
    await sleep(150 + round * 250);
    const r = await copies[round % 3].call('unlock_folder', { path: `${W}/${p}` }); const n = Number((r.match(/^(\d+) of \d+/) || [0, 0])[1]); said += n;
    await settle(copies);
    const seen = await Promise.all(copies.map((c) => countFound(c, p, 60, `${W}/${p}`))); const worst = Math.min(...seen.map((s) => s.found));
    if (n !== 60 || worst < seen[0].of) { lost += seen[0].of - worst; detail.push(`round ${round}: unlock said ${n}; ${worst} of ${seen[0].of} sampled searchable`); }
  }
  console.log(`NEW PROTECTED FILES unlocked while another copy reads them (${ROUNDS} round(s) of 60): unlock reported ${said} opened; sampled files not searchable afterwards: ${lost}${detail.length ? '\n  ' + detail.join('\n  ') : ''}`);
  for (const c of copies) await c.client.close();
}

if (which === 'all' || which === 'transfer') {
  const DATA = `${BASE}/data-p140b-tr`; fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(T(W), { recursive: true, force: true }); fs.mkdirSync(T(`${W}/t`), { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(T(`${W}/t/file ${i}.txt`), `transfer test ${i}`);
  const [a, b, c] = await Promise.all([start(SERVER, DATA), start(SERVER, DATA), start(SERVER, DATA)]);
  const paths = (from, to) => Array.from({ length: to - from }, (_, i) => `${W}/t/file ${from + i}.txt`);
  await a.call('export_to_transfer', { paths: paths(0, 10) });
  const pv = await b.call('clear_transfer', {}); const tk = (pv.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
  await sleep(1100); const ex2 = await a.call('export_to_transfer', { paths: paths(10, 20) });
  const r1 = await b.call('clear_transfer', { confirm_token: tk });
  const refusedAfterChange = /no longer matches/.test(r1);
  const other = await c.call('clear_transfer', { confirm_token: tk }); const tokenElsewhere = /unknown or has expired/.test(other);
  const preview = async () => { const [pa, pb] = await Promise.all([a.call('clear_transfer', {}), b.call('clear_transfer', {})]); return [(pa.match(/confirm_token "([0-9a-f]+)"/) || [])[1], (pb.match(/confirm_token "([0-9a-f]+)"/) || [])[1]]; };
  const kind = (r) => (/^Removed \d+ item/.test(r) ? `removed ${(r.match(/^Removed (\d+)/) || [])[1]}` : /no longer matches/.test(r) ? 'refused' : `OTHER: ${r.slice(0, 60)}`);
  const filesIn = (d) => { let n = 0; const v = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { if (e.isDirectory()) v(path.join(x, e.name)); else n++; } }; v(d); return n; };
  const left = () => fs.readdirSync(`${DATA}/transfer`).map((n) => filesIn(`${DATA}/transfer/${n}`));
  // two copies, each with its own fresh preview of the same two folders, confirm at the same moment
  let [ta, tb] = await preview(); await sleep(300);
  const two = (await Promise.all([a.call('clear_transfer', { confirm_token: ta }), b.call('clear_transfer', { confirm_token: tb })])).map(kind).sort();
  const leftAfterTwo = left();
  // the same again while the third copy copies more files out at that very moment
  await a.call('export_to_transfer', { paths: paths(0, 10) }); await sleep(1100); await a.call('export_to_transfer', { paths: paths(10, 20) });
  [ta, tb] = await preview(); await sleep(1100);
  const [ra, rb, rc] = await Promise.all([a.call('clear_transfer', { confirm_token: ta }), b.call('clear_transfer', { confirm_token: tb }), c.call('export_to_transfer', { paths: paths(20, 40) })]);
  const three = [ra, rb].map(kind).sort(); const kept = left().sort((x, y) => x - y);
  const originals = fs.readdirSync(T(`${W}/t`)).length;
  const log = fs.readdirSync(`${DATA}/logs`).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n'); const logged = log.split('\n').filter((l) => /TRANSFER\s*\|[^|]*removed for good/.test(l)).length;
  console.log(`TRANSFER FOLDER with three copies: a list that changed after the preview is refused: ${refusedAfterChange}; a token from another copy is not accepted: ${tokenElsewhere}; two confirmations of the same list at once: ${two.join(' + ')}, left ${leftAfterTwo.length} item(s); two confirmations while a third copy exports 20 files: ${three.join(' + ')}, export: ${/^Copied 20 item/.test(rc) ? 'done' : rc.slice(0, 50)}, left in the transfer folder: ${kept.join('+')} file(s); removals in the log: ${logged}; originals in Tresorit: ${originals} of 40; connectors alive: ${[a, b, c].every((x) => { try { process.kill(x.pid, 0); return true; } catch { return false; } })}`);
  for (const x of [a, b, c]) await x.client.close();
}

if (which === 'all' || which === 'identical') {
  const DATA = `${BASE}/data-p140b-id`; fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(T(W), { recursive: true, force: true }); fs.mkdirSync(T(`${W}/i/x`), { recursive: true }); fs.mkdirSync(T(`${W}/i/y`), { recursive: true });
  for (let i = 0; i < 300; i++) { const body = Buffer.alloc(4000, `content ${i % 100} `); fs.writeFileSync(T(`${W}/i/${i % 2 ? 'x' : 'y'}/doc ${i}.bin`), body); }
  const copies = await Promise.all([start(SERVER, DATA), start(SERVER, DATA), start(SERVER, DATA)]);
  let bad = 0, differ = 0; const first = [];
  for (let round = 0; round < 4; round++) {
    const rs = await Promise.all(copies.map((c) => c.call('find_identical', { path: `${W}/i`, min_size_kb: 0, limit: 200 })));
    const groups = rs.map((r) => Number((r.match(/^(\d+) group\(s\)/) || [0, -1])[1])); if (round === 0) first.push(...groups);
    if (!groups.every((g) => g === 100)) differ++;
    try { JSON.parse(fs.readFileSync(`${DATA}/index/fingerprints.json`, 'utf8')); } catch { bad++; }
    if (round === 1) for (let i = 0; i < 300; i += 10) fs.appendFileSync(T(`${W}/i/${i % 2 ? 'x' : 'y'}/doc ${i}.bin`), 'changed');
  }
  const after = await copies[2].call('find_identical', { path: `${W}/i`, min_size_kb: 0, limit: 200 });
  console.log(`IDENTICAL FILES through three copies at once: first answers ${first.join('/')} group(s) (100 expected); rounds with a different answer: ${differ}; after 30 files were changed: ${(after.match(/^(\d+) group\(s\)/) || [after.slice(0, 80)])[0]} (100 expected: the 30 changed files leave groups of two); fingerprint file unreadable ${bad} time(s)`);
  for (const c of copies) await c.client.close();
}
fs.rmSync(T(W), { recursive: true, force: true });
