// Scale, endurance and two copies running at once.
import { Client, StdioClientTransport, MOCK, SERVER, rssMB } from './lib/env.mjs';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const ROOT = `${MOCK}/Tresors`; const BASE = MOCK;
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 600)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start(name, extraEnv = {}, keep = false) {
  const DATA = extraEnv.DATA || `${BASE}/data-r5-${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999', TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_PREFLIGHT_GATE: 'off', ...extraEnv };
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  let protoErrors = 0; client.onerror = () => { protoErrors++; };
  await client.connect(transport);
  const call = async (tool, args = {}) => { const t0 = Date.now(); const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError, ms: Date.now() - t0 }; };
  const rss = () => rssMB(transport.pid);
  return { client, call, DATA, rss, errors: () => protoErrors, pid: transport.pid };
}

console.log('A. A very large Tresorit (150,000 files)');
{
  const BIG = `${ROOT}/Alder Works UK/98 - Huge`;
  if (!fs.existsSync(`${BIG}/d299`)) execSync(`python3 - <<'PY'
import os
root=${JSON.stringify(BIG)}
for d in range(300):
    p=os.path.join(root,f'd{d:03d}'); os.makedirs(p,exist_ok=True)
    for f in range(500):
        open(os.path.join(p,f'invoice {d:03d}-{f:03d} copper.dat'),'wb').close()
open(os.path.join(root,'d150','needle in haystack 77.txt'),'w').write('haystack content NEEDLE-77')
PY`, { shell: '/bin/bash' });
  const s = await start('huge');
  const m0 = s.rss();
  const t = [];
  let r = await s.call('find_files', { query: 'needle haystack' }); t.push(['find by name', r.ms]);
  check('finds one file among 150,000 by name', r.text.includes('needle in haystack 77.txt'), r.text.slice(0, 200));
  r = await s.call('find_files', { query: 'invoice copper', limit: 20 }); t.push(['find with 150,000 matches', r.ms]);
  check('a query matching everything returns a bounded, sensible answer', /match\(es\), showing 20/.test(r.text) && r.text.split('\n').length === 21, r.text.slice(0, 120));
  r = await s.call('recent_files', { days: 1, limit: 10 }); t.push(['recent files', r.ms]);
  check('recent-files over 150,000 files', !r.isError && r.text.split('\n').length === 11);
  r = await s.call('list_folder', { path: 'Alder Works UK/98 - Huge', recursive: true, max_depth: 2, limit: 2000 }); t.push(['recursive listing (capped)', r.ms]);
  check('a recursive listing is capped and says so', /showing the first 2000/.test(r.text));
  r = await s.call('file_info', { path: 'Alder Works UK/98 - Huge' }); t.push(['folder size count', r.ms]);
  check('counts a 150,000-file folder', /150001 file\(s\) in 300 subfolder/.test(r.text), r.text);
  r = await s.call('delete_items', { paths: ['Alder Works UK/98 - Huge'] }); t.push(['delete preview', r.ms]);
  check('delete preview of a 150,000-file folder (nothing deleted)', /Would delete 1 item\(s\), 150001 file/.test(r.text) && fs.existsSync(`${BIG}/d000`));
  r = await s.call('search_contents', { query: 'NEEDLE-77' }); t.push(['content search', r.ms]);
  check('content search still finds the one text file', r.text.includes('needle in haystack 77.txt'));
  const slowest = Math.max(...t.map((x) => x[1]));
  check(`every operation answers in reasonable time (slowest ${slowest} ms)`, slowest < 25000, t.map((x) => `${x[0]} ${x[1]} ms`).join('; '));
  console.log('       ' + t.map((x) => `${x[0]} ${x[1]} ms`).join(' | '));
  check(`memory stays moderate (${m0} MB at start, ${s.rss()} MB after)`, s.rss() < 900);
  await s.client.close();
  fs.rmSync(BIG, { recursive: true, force: true });
}

console.log('B. Endurance: 5,000 operations in one session');
{
  const s = await start('soak');
  const W = 'Birch Labs/Soak'; await s.call('create_folder', { path: W });
  const docs = ['Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx', 'Alder Works UK/03 - Finance/Commission tracker 2026.xlsx', 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf', 'Alder Works UK/07 - Research/ORBIT/ORBIT pilot deck.pptx', 'Alder Works UK/07 - Research/ORBIT/Long appendix.pdf'];
  for (let i = 0; i < 300; i++) await s.call(['read_file', 'find_files', 'list_folder'][i % 3], i % 3 === 0 ? { path: docs[i % docs.length] } : i % 3 === 1 ? { query: 'orbit' } : { path: 'Alder Works UK' });
  const warm = s.rss();
  let errors = 0; const t0 = Date.now(); const N = 5000;
  for (let i = 0; i < N; i++) {
    const k = i % 10; let r;
    if (k === 0) r = await s.call('read_file', { path: docs[i % docs.length], max_chars: 4000 });
    else if (k === 1) r = await s.call('find_files', { query: ['nda', 'orbit', 'commission', 'report'][i % 4] });
    else if (k === 2) r = await s.call('search_contents', { query: ['unicorn-keyword', 'boson', 'clausula', 'INV-0042'][i % 4], path: 'Alder Works UK/03 - Finance' });
    else if (k === 3) r = await s.call('write_file', { path: `${W}/f${i % 40}.txt`, content: `content ${i} ` + 'x'.repeat(500), overwrite: true });
    else if (k === 4) r = await s.call('list_folder', { path: 'Alder Works UK', recursive: true });
    else if (k === 5) r = await s.call('edit_file', { path: `${W}/f${(i - 2) % 40}.txt`, old_text: 'content', new_text: 'edited' });
    else if (k === 6) r = await s.call('file_info', { path: docs[i % docs.length] });
    else if (k === 7) r = await s.call('recent_files', { days: 1, limit: 5 });
    else if (k === 8) r = await s.call('connector_status', {});
    else r = await s.call('read_file', { path: `${W}/f${(i - 6) % 40}.txt` });
    if (r.isError) { errors++; if (errors < 4) console.log('       error:', k, r.text.slice(0, 120)); }
  }
  const end = s.rss(); const per = ((Date.now() - t0) / N).toFixed(1);
  check(`5,000 mixed operations: no errors (${per} ms each on average)`, errors === 0 && s.errors() === 0, `${errors} errors`);
  check(`memory does not creep up over the session (${warm} MB after warm-up, ${end} MB at the end)`, end - warm < 120, `${warm} -> ${end}`);
  const held = fs.readdirSync(`${s.DATA}/deleted`).length;
  let r = await s.call('list_deleted', { limit: 5 });
  check(`holding area with ${held} batches still lists quickly (${r.ms} ms)`, held >= 900 && r.ms < 5000 && /batch\(es\) in the holding area/.test(r.text));
  const logKb = Math.round(fs.statSync(`${s.DATA}/logs/${fs.readdirSync(`${s.DATA}/logs`)[0]}`).size / 1024);
  r = await s.call('access_log', { lines: 20 });
  check(`access log (${logKb} KB after the session) is still read quickly (${r.ms} ms)`, r.ms < 3000 && r.text.split('\n').length === 21);
  await s.client.close();
  fs.rmSync(`${ROOT}/${W}`, { recursive: true, force: true });
}

console.log('C. Two copies of the connector running on the same data folder');
{
  const DATA = `${BASE}/data-r5-twin`; fs.rmSync(DATA, { recursive: true, force: true });
  const a = await start('twinA', { DATA, TRESORIT_INDEX_DELAY_MS: '200' }, true);
  const b = await start('twinB', { DATA, TRESORIT_INDEX_DELAY_MS: '250' }, true);
  const W = 'Birch Labs/Twins'; await a.call('create_folder', { path: W });
  const jobs = [];
  for (let i = 0; i < 60; i++) {
    const s = i % 2 ? a : b;
    jobs.push(s.call('write_file', { path: `${W}/t${i % 12}.txt`, content: `from ${i % 2 ? 'A' : 'B'} ${i}`, overwrite: true }));
    jobs.push(s.call('search_contents', { query: 'unicorn-keyword' }));
    jobs.push(s.call('read_file', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf' }));
  }
  const rs = await Promise.all(jobs);
  const bad = rs.filter((r) => r.isError && !/already exists/.test(r.text));
  check('both copies work side by side without errors', bad.length === 0, bad.slice(0, 3).map((r) => r.text.slice(0, 100)).join(' | '));
  let ok = false; for (let i = 0; i < 400 && !ok; i++) { await sleep(300); const [x, y] = await Promise.all([a.call('connector_status', {}), b.call('connector_status', {})]); ok = /up to date as of/.test(x.text) && /up to date as of/.test(y.text); }
  check('both finish their background reading', ok);
  const batches = fs.readdirSync(`${DATA}/deleted`);
  check('their holding batches never collide', new Set(batches).size === batches.length && batches.every((n) => fs.existsSync(`${DATA}/deleted/${n}/manifest.json`)), batches.length);
  await a.client.close(); await b.client.close(); await sleep(400);
  let valid = false; try { valid = Object.keys(JSON.parse(fs.readFileSync(`${DATA}/index/catalog.json`, 'utf8')).entries).length > 5; } catch { valid = false; }
  check('the shared search index is intact afterwards', valid);
  const c = await start('twinC', { DATA }, true);
  const r = await c.call('search_contents', { query: 'unicorn-keyword' });
  check('a fresh start on that data folder searches correctly', r.text.includes('ORBIT technical report.pdf'));
  await c.client.close();
  fs.rmSync(`${ROOT}/${W}`, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
