import { MOCK, BUNDLE } from '../lib/env.mjs';
// Deep check of 1.4.0: passwords (leaks, withdrawn requests, kills), malformed files, the transfer folder's
// identity, and a folder shaped like the real one (142 protected PDFs under two passwords).
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const LIB = path.join(path.dirname(SERVER), 'lib');
const BASE = `${MOCK}`; const ROOT = `${BASE}/Tresors`; const FX = `${BASE}/data-fx14`; const W = 'Birch Labs/p140';
const SAMPLES = path.join(path.dirname(SERVER), 'preflight', 'samples');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
const PW = fs.readFileSync(`${FX}/pw.txt`, 'utf8'); const PW2 = 'Second-Senha-551-xQ';
const which = process.argv[2] || 'all';
const PWFILE = `${BASE}/data-p140-pw.txt`; const PWSH = `${BASE}/data-p140-pw.sh`;
const script = (delay = 0) => fs.writeFileSync(PWSH, `${delay ? `sleep ${delay}\n` : ''}cat "${PWFILE}"\n`);
const holds = (dir, needle) => { const hits = []; const visit = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) visit(p); else if (fs.readFileSync(p).includes(needle)) hits.push(p); } }; try { visit(dir); } catch { /* none */ } return hits; };

// A client that keeps every byte the connector sends, on both of its outputs.
function raw(name, extra = {}, keep = false) {
  const DATA = `${BASE}/data-p140-${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
  const child = spawn('node', [SERVER], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_PASSWORD_CMD: JSON.stringify(['/bin/sh', PWSH]), ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = ''; let buf = ''; const replies = new Map(); const waiters = new Map();
  child.stdin.on('error', () => {});
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => { out += d; buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id !== undefined && !m.method) { replies.set(m.id, m); const w = waiters.get(m.id); if (w) w(m); } } });
  const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };
  let id = 100;
  const call = (tool, args) => { const my = ++id; send({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name: 'tresorit_' + tool, arguments: args } }); return { id: my, done: new Promise((res) => { if (replies.has(my)) res(replies.get(my)); else waiters.set(my, res); }) }; };
  const text = (m) => (m && m.result ? m.result.content.map((c) => c.text || '').join('\n') : JSON.stringify(m && m.error));
  const init = async () => { send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }); await sleep(700); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); };
  const exited = new Promise((res) => child.on('exit', res));
  return { child, send, call, text, init, exited, DATA, everything: () => out + err };
}
const makeLocked = (dir, n, pw, prefix) => {
  fs.mkdirSync(T(dir), { recursive: true });
  execFileSync('python3', ['-c', `
import subprocess, sys
from reportlab.pdfgen import canvas
d, n, pw, prefix = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
for i in range(n):
    c = canvas.Canvas('/tmp/p140-plain.pdf', pagesize=(400, 200)); c.setFont('Helvetica', 12)
    c.drawString(30, 150, 'Boleto %s numero %d' % (prefix, i)); c.drawString(30, 130, 'Marker P140-%s-%04d valor R$ %d,00' % (prefix, i, 100 + i)); c.save()
    subprocess.run(['qpdf', '--encrypt', pw, 'o', '256', '--', '/tmp/p140-plain.pdf', '%s/%s %03d.pdf' % (d, prefix, i)], check=True)
`, T(dir), String(n), pw, prefix]);
};
fs.rmSync(T(W), { recursive: true, force: true });

if (which === 'all' || which === 'real') {
  makeLocked(`${W}/boletos`, 138, PW, 'conta'); makeLocked(`${W}/boletos/tax`, 4, PW2, 'return');
  script(); fs.writeFileSync(PWFILE, PW);
  const s = raw('real'); await s.init();
  let t0 = Date.now(); let r = s.text(await s.call('unlock_folder', { path: `${W}/boletos` }).done); const first = Date.now() - t0;
  fs.writeFileSync(PWFILE, PW2);
  const r2 = s.text(await s.call('unlock_folder', { path: `${W}/boletos` }).done);
  const st = s.text(await s.call('connector_status', {}).done);
  const sr = s.text(await s.call('search_contents', { query: 'P140-conta-0077', path: W }).done); const sr2 = s.text(await s.call('search_contents', { query: 'P140-return-0002', path: W }).done);
  const lu = s.text(await s.call('list_unreadable', { path: W }).done);
  await sleep(5600);
  console.log(`REAL SHAPE (142 protected PDFs, two passwords): first password ${(r.match(/^\d+ of \d+[^\n]*/) || [r.slice(0, 120)])[0]} in ${Math.round(first / 1000)} s; ${(r.match(/\d+ were NOT opened[^\n(]*/) || [''])[0]}`);
  console.log(`  second password: ${(r2.match(/^\d+ of \d+[^\n]*/) || [r2.slice(0, 120)])[0]}; searchable: ${sr.includes('conta 077.pdf')} and ${sr2.includes('return 002.pdf')}; status: ${(st.match(/\d+ password-protected PDF\(s\) were opened[^\n]*/) || ['?'])[0]} / ${(st.match(/Unreadable by reason: \d+ password-protected/) || ['?'])[0]}; unreadable left in the folder: ${(lu.match(/^\d+ of \d+/) || ['?'])[0]}`);
  console.log(`  either password in the data folder: ${[...holds(s.DATA, PW), ...holds(s.DATA, PW2)].length} file(s); in anything the connector sent back: ${s.everything().includes(PW) || s.everything().includes(PW2)}`);
  s.child.kill(); await s.exited;
}

if (which === 'all' || which === 'withdrawn') {
  makeLocked(`${W}/wd`, 6, PW, 'wd');
  script(3); fs.writeFileSync(PWFILE, PW);
  const s = raw('withdrawn'); await s.init();
  const c = s.call('unlock_folder', { path: `${W}/wd` });
  await sleep(1200); s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: c.id, reason: 'timed out' } });
  await sleep(4500);
  const c2 = s.call('read_file', { path: `${W}/wd/wd 000.pdf`, ask_password: true });
  await sleep(1200); s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: c2.id, reason: 'timed out' } });
  await sleep(4500);
  script(); const sr = s.text(await s.call('search_contents', { query: 'P140-wd-0003', path: `${W}/wd` }).done);
  const log = fs.readFileSync(`${s.DATA}/logs/${fs.readdirSync(`${s.DATA}/logs`)[0]}`, 'utf8');
  await sleep(5600);
  const cat = fs.existsSync(`${s.DATA}/index/catalog.json`) ? fs.readFileSync(`${s.DATA}/index/catalog.json`, 'utf8') : '';
  console.log(`WITHDRAWN while the password box was open: unlock recorded as withdrawn: ${/unlock_folder \| .*withdrawn by the app while the password box/.test(log)}; single read recorded as withdrawn: ${/read_file \| .*withdrawn by the app while the password box/.test(log)}; anything unlocked into the index: ${/"pw":1/.test(cat) || sr.includes('wd 003.pdf')}; text sent back after the withdrawal: ${s.everything().includes('P140-wd-0000')}; password in data: ${holds(s.DATA, PW).length}`);
  s.child.kill(); await s.exited;
}

if (which === 'all' || which === 'kill') {
  makeLocked(`${W}/kill`, 120, PW, 'k');
  script(); fs.writeFileSync(PWFILE, PW);
  let leaks = 0, badCatalog = 0, opened = 0; let rounds = 0;
  const DATA = `${BASE}/data-p140-kill`; fs.rmSync(DATA, { recursive: true, force: true });
  for (; rounds < 12; rounds++) {
    const s = raw('kill', {}, true); await s.init();
    const c = s.call('unlock_folder', { path: `${W}/kill` });
    const done = await Promise.race([c.done.then((m) => s.text(m)), sleep(150 + Math.random() * 900).then(() => null)]);
    s.child.kill('SIGKILL'); await s.exited;
    leaks += holds(DATA, PW).length; if (s.everything().includes(PW)) leaks++;
    try { if (fs.existsSync(`${DATA}/index/catalog.json`)) JSON.parse(fs.readFileSync(`${DATA}/index/catalog.json`, 'utf8')); } catch { badCatalog++; }
    if (done && /No password-protected PDF was found/.test(done)) break;
  }
  const s = raw('kill', {}, true); await s.init();
  const r = s.text(await s.call('unlock_folder', { path: `${W}/kill` }).done);
  const sr = s.text(await s.call('search_contents', { query: 'P140-k-0119', path: `${W}/kill` }).done); const sr0 = s.text(await s.call('search_contents', { query: 'P140-k-0000', path: `${W}/kill` }).done);
  opened = Number((r.match(/^(\d+) of/) || [0, 0])[1]);
  await sleep(5600); leaks += holds(DATA, PW).length;
  console.log(`KILLED ${rounds} time(s) in the middle of unlocking 120 files: password found in a file or an output ${leaks} time(s); catalogue unreadable ${badCatalog} time(s); a final run finished the job (${/No password-protected/.test(r) ? 'nothing left to open' : `${opened} more opened`}); first and last file searchable: ${sr0.includes('k 000.pdf')} / ${sr.includes('k 119.pdf')}`);
  s.child.kill(); await s.exited;
}

if (which === 'all' || which === 'transfer') {
  const s = raw('transfer'); await s.init();
  fs.mkdirSync(T(`${W}/precious`), { recursive: true }); fs.writeFileSync(T(`${W}/precious/keep me.txt`), 'KEEP'); fs.mkdirSync(`${BASE}/data-p140-elsewhere`, { recursive: true }); fs.writeFileSync(`${BASE}/data-p140-elsewhere/also keep.txt`, 'KEEP');
  await s.call('connector_status', {}).done;
  const results = [];
  for (const target of [T(`${W}/precious`), `${BASE}/data-p140-elsewhere`]) {
    fs.rmSync(`${s.DATA}/transfer`, { recursive: true, force: true }); fs.symlinkSync(target, `${s.DATA}/transfer`);
    const pv = s.text(await s.call('clear_transfer', {}).done); const tk = (pv.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
    const r = tk ? s.text(await s.call('clear_transfer', { confirm_token: tk }).done) : pv;
    results.push(`${/not an ordinary folder|Nothing was removed/.test(r) ? 'refused' : 'NOT REFUSED'} (${fs.readdirSync(target).length} file(s) still there)`);
  }
  fs.rmSync(`${s.DATA}/transfer`, { force: true });
  console.log(`TRANSFER FOLDER replaced by a link (to a Tresorit folder, then to another folder): ${results.join('; ')}`);
  s.child.kill(); await s.exited; fs.rmSync(`${BASE}/data-p140-elsewhere`, { recursive: true, force: true });
}

if (which === 'all' || which === 'fuzz') {
  const { extractFile } = await import(`${LIB}/extract-core.js`);
  const dir = `${BASE}/data-p140-fuzz`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const real = ['sample.pdf', 'sample.docx', 'sample.xlsx', 'sample.pptx', 'sample.doc', 'sample.xls', 'sample.ppt'].map((f) => fs.readFileSync(`${SAMPLES}/${f}`)).concat([fs.readFileSync(`${FX}/page.webarchive`), fs.readFileSync(`${FX}/page.png`), fs.readFileSync(`${FX}/page.jpg`), fs.readFileSync(`${FX}/locked-aes256.pdf`)]);
  const magics = [Buffer.from('%PDF-1.7\n'), Buffer.from('PK\x03\x04'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('bplist00'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<html>'), Buffer.from('{\\rtf1'), Buffer.from('<?xml version="1.0"?>'), Buffer.alloc(0)];
  const exts = ['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'msg'];
  let n = 0, threw = 0, slow = 0, odd = 0; const statuses = {}; const slowest = { ms: 0, what: '' }; const N = Number(process.argv[3]) || 2500;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    let buf; const mode = i % 5;
    const src = real[Math.floor(Math.random() * real.length)];
    if (mode === 0) buf = Buffer.concat([magics[Math.floor(Math.random() * magics.length)], crypto.randomBytes(Math.floor(Math.random() * 3000))]);
    else if (mode === 1) buf = src.subarray(0, Math.floor(Math.random() * src.length));
    else if (mode === 2) { buf = Buffer.from(src); for (let k = 0; k < 1 + Math.floor(Math.random() * 12); k++) buf[Math.floor(Math.random() * buf.length)] = Math.floor(Math.random() * 256); }
    else if (mode === 3) { buf = Buffer.from(src); const at = Math.floor(Math.random() * buf.length); crypto.randomBytes(Math.min(64, buf.length - at)).copy(buf, at); }
    else buf = Buffer.concat([src.subarray(0, Math.floor(src.length / 2)), real[Math.floor(Math.random() * real.length)].subarray(0, 2000)]);
    const ext = exts[Math.floor(Math.random() * exts.length)]; const f = `${dir}/f${i}.${ext}`; fs.writeFileSync(f, buf);
    const t1 = Date.now();
    try {
      const res = await Promise.race([extractFile(f, ext, buf.length, {}), sleep(20000).then(() => ({ status: 'HUNG' }))]);
      statuses[res.status] = (statuses[res.status] || 0) + 1;
      if (!['ok', 'empty', 'scan', 'error', 'unsupported', 'toolarge'].includes(res.status)) odd++;
      if (res.status === 'error' && !res.why) odd++;
    } catch { threw++; }
    const ms = Date.now() - t1; if (ms > 5000) slow++; if (ms > slowest.ms) { slowest.ms = ms; slowest.what = `mode ${mode} .${ext} ${buf.length} bytes`; }
    n++; fs.rmSync(f, { force: true });
  }
  console.log(`MALFORMED FILES: ${n} random, cut-off and corrupted files read in ${Math.round((Date.now() - t0) / 1000)} s: the reader threw ${threw} time(s), gave an answer of an unknown kind ${odd} time(s), took over 5 s ${slow} time(s) (slowest ${slowest.ms} ms: ${slowest.what}); answers: ${Object.entries(statuses).map(([k, v]) => `${k} ${v}`).join(', ')}; memory now ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  fs.rmSync(dir, { recursive: true, force: true });
}

if (which === 'all' || which === 'badpics') {
  const s = raw('badpics'); await s.init();
  fs.mkdirSync(T(`${W}/pics`), { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(T(`${W}/pics/bad ${i}.pdf`), Buffer.concat([i % 2 ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5000)]));
  fs.copyFileSync(`${FX}/page.png`, T(`${W}/pics/good.pdf`));
  let answered = 0; for (let i = 0; i < 12; i++) { const m = await Promise.race([s.call('read_file', { path: `${W}/pics/bad ${i}.pdf` }).done, sleep(120000).then(() => null)]); if (m) answered++; }
  const good = s.text(await s.call('read_file', { path: `${W}/pics/good.pdf` }).done);
  console.log(`CORRUPT PICTURES saved as .pdf: ${answered} of 12 answered (none may hang); a good picture is still read afterwards: ${/48213/.test(good)}; connector still running: ${s.child.exitCode === null}`);
  s.child.kill(); await s.exited;
}
fs.rmSync(T(W), { recursive: true, force: true });
