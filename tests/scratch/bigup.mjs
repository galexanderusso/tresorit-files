// The update from 1.3.5 at real size: 30,000 documents and the 172 problem files, three copies, folders unlocked
// through a copy that is not doing the background reading while the old failures are being read again.
import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs'; import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process';
const SERVER = process.env.SERVER; const B = '/home/tester/build/mock/data-big'; const DATA = `${B}/data`;
fs.rmSync(DATA, { recursive: true, force: true }); execFileSync('cp', ['-a', `${B}/data-135`, DATA]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PWSH = `${B}/pw.sh`; const usePw = (n) => fs.writeFileSync(PWSH, `cat "${B}/pw${n}.txt"\n`); usePw(1);
const textsBefore = fs.readdirSync(`${DATA}/index/text`).length; const sample = fs.readdirSync(`${DATA}/index/text`).filter((_, i) => i % 500 === 0).map((n) => [n, fs.statSync(`${DATA}/index/text/${n}`).mtimeMs]);
async function start() {
  const t0 = Date.now();
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env, TRESORIT_ROOT: `${B}/Tresors`, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_PASSWORD_CMD: JSON.stringify(['/bin/sh', PWSH]) }, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => { const t = Date.now(); let text; try { text = (await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n'); } catch (e) { text = `CALL FAILED: ${e.message}`; } call.last = Date.now() - t; return text; };
  const rss = () => { try { return Math.round(Number(fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024); } catch { return 0; } };
  await call('connector_status');
  return { client, call, rss, pid: transport.pid, ready: Date.now() - t0 };
}
const t0 = Date.now(); const copies = await Promise.all([start(), start(), start()]);
console.log(`three copies answering after ${copies.map((c) => c.ready).join(' / ')} ms`);
const peak = [0, 0, 0]; const watch = setInterval(() => copies.forEach((c, k) => { peak[k] = Math.max(peak[k], c.rss()); }), 400);
let wp = 0; for (let i = 0; i < 40 && !wp; i++) { try { wp = JSON.parse(fs.readFileSync(`${DATA}/index/background.lock`, 'utf8')).pid; } catch { await sleep(100); } }
const follower = copies.find((c) => c.pid !== wp) || copies[0]; const worker = copies.find((c) => c.pid === wp) || copies[1];
// straight away, while the background copy is busy with the old failures: unlock the bills through another copy
const u1 = await follower.call('unlock_folder', { path: 'Personal/04 - Travel/Old bills' }); const u1ms = follower.call.last;
usePw(2); const u2 = await follower.call('unlock_folder', { path: 'Personal/02 - Tax' });
const settle = async () => { for (let i = 0; i < 1200; i++) { await sleep(500); const s = await Promise.all(copies.map((c) => c.call('connector_status'))); if (s.every((x) => /up to date as of/.test(x))) return s; } return []; };
let sts = await settle(); await sleep(7000); sts = await Promise.all(copies.map((c) => c.call('connector_status')));
const passDone = Math.round((Date.now() - t0) / 1000);
const pick = (s, re) => (s.match(re) || ['?'])[0];
console.log(`unlock through a copy that is not reading in the background: ${u1.split('\n')[0]} (${Math.round(u1ms / 1000)} s) | ${u2.split('\n')[0]}`);
console.log(`settled after ${passDone} s; the three copies report ${new Set(sts.map((s) => pick(s, /Search index: .*/))).size === 1 ? 'the same' : 'DIFFERENT'}: ${pick(sts[0], /Search index: .*/)}`);
console.log(`  ${pick(sts[0], /Unreadable by reason: .*/)}`);
console.log(`  ${pick(sts[0], /\d+ password-protected PDF\(s\) were opened[^\n]*/)} | ${pick(sts[0], /\d+ (?:readable )?file\(s\)[^\n]*ending[^\n]*/)}`);
const log = fs.readdirSync(`${DATA}/logs`).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n');
console.log(`background passes in the log since the update: ${log.split('\n').filter((l) => /document\(s\) read into the search index/.test(l)).slice(1).map((l) => l.split('|').pop().trim()).join(' / ')}`);
const touched = sample.filter(([n, m]) => { try { return fs.statSync(`${DATA}/index/text/${n}`).mtimeMs !== m; } catch { return true; } }).length;
console.log(`stored text of documents already readable: ${touched} of ${sample.length} sampled were rewritten; text files ${textsBefore} -> ${fs.readdirSync(`${DATA}/index/text`).filter((n) => n.endsWith('.txt')).length} (.txt only now)`);
// every opened file must have its text
const cat = JSON.parse(fs.readFileSync(`${DATA}/index/catalog.json`, 'utf8')).entries; let pw = 0, noText = 0, stillPw = 0;
for (const [k, e] of Object.entries(cat)) { if (e.y === 'password') stillPw++; if (e.pw) { pw++; if (!fs.existsSync(`${DATA}/index/text/${crypto.createHash('sha1').update(k).digest('hex')}.txt`)) noText++; } }
console.log(`catalogue: ${pw} opened with a password, ${noText} of them without stored text, ${stillPw} still password-protected`);
const q = async (c, query, path) => { const r = await c.call('search_contents', path ? { query, path } : { query }); return `${(r.match(/^(\d+) file\(s\)/) || [r.slice(0, 50)])[0]} in ${c.call.last} ms`; };
console.log(`searches (through each copy): bill 077: ${(await Promise.all(copies.map((c) => q(c, 'LOCKED-B-077')))).join(' | ')}; tax return: ${await q(worker, 'LOCKED-T-002')}; an ordinary report: ${await q(follower, 'BIG-12345')}; text in a picture saved as .pdf: ${await q(worker, '48213', 'Alder Works UK/09 - Archive')}`);
const lu = await follower.call('list_unreadable', {}); console.log(`list of unreadable files: ${lu.split('\n')[0]} (${follower.call.last} ms)`);
const we = await follower.call('list_unreadable', { reason: 'wrong_ending' }); console.log(`wrong endings: ${we.split('\n').slice(0, 4).join(' // ').slice(0, 420)}`);
let idn = 0; let idt = ''; const ti = Date.now(); for (; idn < 30; idn++) { idt = await worker.call('find_identical', { min_size_kb: 1 }); if (!/Not finished/.test(idt)) break; }
console.log(`identical files across the whole library: ${idt.split('\n')[0].slice(0, 160)} after ${idn + 1} call(s), ${Math.round((Date.now() - ti) / 1000)} s`);
const secret = [...fs.readdirSync(`${DATA}/index`)].filter((n) => n.endsWith('.json')).some((n) => /BIGSECRET|seed\.txt|Secrets\/list/.test(fs.readFileSync(`${DATA}/index/${n}`, 'utf8')));
const pwLeak = (() => { const p1 = fs.readFileSync(`${B}/pw1.txt`, 'utf8'); const p2 = fs.readFileSync(`${B}/pw2.txt`, 'utf8'); let n = 0; const v = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) v(p); else { const b = fs.readFileSync(p); if (b.includes(p1) || b.includes(p2)) n++; } } }; v(DATA); return n; })();
clearInterval(watch);
console.log(`"do not index" folders named in any index file: ${secret}; files of the connector holding a password: ${pwLeak}; peak memory: background copy ${peak[copies.indexOf(worker)]} MB, the others ${peak.filter((_, k) => copies[k] !== worker).join(' and ')} MB`);
for (const c of copies) await c.client.close();
