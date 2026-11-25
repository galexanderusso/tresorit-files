import { Client, StdioClientTransport, MOCK, BUNDLE } from './lib/env.mjs';
// The self-check and the read-only rule that depends on it.
import fs from 'node:fs';
import os from 'node:os';
const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const ROOT = `${MOCK}/Tresors`; const BASE = `${MOCK}`;
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 700)); } };
async function start(name, extraEnv = {}, keep = false) {
  const DATA = `${BASE}/data-r4-${name}`; if (!keep) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999', TRESORIT_OCR_ENGINE: 'bundled', ...extraEnv }; delete env.TRESORIT_PREFLIGHT_GATE;
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  const call = async (tool, args = {}) => { const t0 = Date.now(); const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError, ms: Date.now() - t0 }; };
  return { client, call, DATA };
}
const snap = () => JSON.stringify(fs.readdirSync(ROOT, { recursive: true }).sort());
const Q = 'Birch Labs/Gate';
fs.rmSync(`${ROOT}/${Q}`, { recursive: true, force: true }); fs.mkdirSync(`${ROOT}/${Q}`, { recursive: true }); fs.writeFileSync(`${ROOT}/${Q}/keep.txt`, 'keep me'); fs.writeFileSync(`${ROOT}/${Q}/notes.md`, 'alpha');
{
  const s = await start('gate');
  const before = snap();
  const attempts = [
    ['write_file', { path: `${Q}/new.txt`, content: 'x' }], ['write_file', { path: `${Q}/keep.txt`, content: 'x', overwrite: true }], ['edit_file', { path: `${Q}/notes.md`, old_text: 'alpha', new_text: 'beta' }],
    ['create_folder', { path: `${Q}/sub` }], ['move_item', { source: `${Q}/keep.txt`, destination: `${Q}/moved.txt` }], ['copy_item', { source: `${Q}/keep.txt`, destination: `${Q}/copy.txt` }],
    ['delete_items', { paths: [`${Q}/keep.txt`] }], ['restore_deleted', { batch: 'x' }], ['import_from_transfer', { name: 'x', destination: Q }],
  ];
  let refused = 0; const leaks = [];
  for (const [tool, args] of attempts) { const r = await s.call(tool, args); if (r.isError && /has not passed its self-check/.test(r.text)) refused++; else leaks.push(`${tool}: ${r.text.slice(0, 60)}`); }
  check('before the self-check, all 9 kinds of change are refused', refused === attempts.length, leaks.join(' | '));
  check('...and Tresorit is exactly as it was', snap() === before && fs.readFileSync(`${ROOT}/${Q}/keep.txt`, 'utf8') === 'keep me' && fs.readFileSync(`${ROOT}/${Q}/notes.md`, 'utf8') === 'alpha');
  let r = await s.call('read_file', { path: `${Q}/keep.txt` });
  const f = await s.call('find_files', { query: 'keep' }); const se = await s.call('search_contents', { query: 'keep me', path: Q }); const ls = await s.call('list_folder', { path: Q }); const tr = await s.call('import_from_transfer', {});
  // (From 1.5.0 a search inside documents reads nothing new into the index before the list of folders that are not
  // to be indexed has been confirmed on this computer, which the self-check asks for at its end.)
  check('reading, finding and listing work before the self-check, and a search inside documents says that it waits for the folders not to index to be confirmed', !r.isError && r.text.includes('keep me') && f.text.includes('keep.txt') && ls.text.includes('notes.md') && /Transfer folder/.test(tr.text) && !se.isError && /were not searched: nothing new is read into the index until/.test(se.text), se.text);
  r = await s.call('connector_status', {});
  check('status says the connector is read-only until checked', /Self-check on this computer: NOT YET PASSED/.test(r.text), r.text);
  const before2 = snap();
  const [p1, p2] = await Promise.all([s.call('preflight'), s.call('preflight')]);
  check('self-check passes here', /RESULT: PASSED/.test(p1.text) && !/FAIL /.test(p1.text), p1.text.split('\n').slice(0, 12).join(' / '));
  check('two requests at once share one run', p1.text === p2.text);
  check('the self-check itself changed nothing in Tresorit', snap() === before2);
  check('its scratch folder is gone and the report is saved', fs.readdirSync(`${s.DATA}/preflight`).length === 0 && fs.readdirSync(`${s.DATA}/logs`).some((n) => n.startsWith('preflight-')));
  r = await s.call('write_file', { path: `${Q}/new.txt`, content: 'after check' });
  check('after it passes, changes are allowed', !r.isError && fs.readFileSync(`${ROOT}/${Q}/new.txt`, 'utf8') === 'after check', r.text);
  const se2 = await s.call('search_contents', { query: 'keep me', path: Q });
  check('...and, the list of folders not to index confirmed at its end, a search inside documents reads and finds them', /Folders not to index: confirmed on this Mac/.test(p1.text) && se2.text.includes('keep.txt'), `${p1.text.split('\n').pop()} | ${se2.text.slice(0, 200)}`);
  r = await s.call('connector_status', {});
  check('status shows when the check passed', /Self-check on this computer: passed on 20\d\d-\d\d-\d\d \d\d:\d\d UTC \(\d+ of \d+ checks\)/.test(r.text), r.text);
  const mode = (fs.statSync(s.DATA).mode & 0o777).toString(8);
  check('the data folder is private to the user', mode === '700', mode);
  await s.client.close();
  // restart: the pass is remembered
  const s2 = await start('gate', {}, true);
  r = await s2.call('create_folder', { path: `${Q}/after restart` });
  check('the pass is remembered after a restart', !r.isError, r.text);
  await s2.client.close();
  // a pass recorded for another version, another folder or another computer does not count
  const mf = `${s.DATA}/preflight-passed.json`; const good = JSON.parse(fs.readFileSync(mf, 'utf8'));
  for (const [label, change] of [['an older version', { version: '1.1.1' }], ['a different Tresorit folder', { root: '/somewhere/else' }], ['a different computer', { host: 'other-mac' }], ['a failed run', { critical_failed: 1 }]]) {
    fs.rmSync(`${ROOT}/${Q}/sneak.txt`, { force: true });
    fs.writeFileSync(mf, JSON.stringify({ ...good, ...change }));
    const s3 = await start('gate', {}, true);
    r = await s3.call('write_file', { path: `${Q}/sneak.txt`, content: 'x' });
    check(`a pass recorded for ${label} does not unlock changes`, r.isError && !fs.existsSync(`${ROOT}/${Q}/sneak.txt`), r.text.slice(0, 80));
    await s3.client.close();
  }
  fs.writeFileSync(mf, '{ not json');
  const s4 = await start('gate', {}, true);
  r = await s4.call('write_file', { path: `${Q}/sneak.txt`, content: 'x' });
  check('a damaged record does not unlock changes', r.isError, r.text.slice(0, 80));
  await s4.client.close();
}
{
  // A Tresorit folder that fails the check keeps the connector read-only.
  const emptyRoot = `${BASE}/empty-root`; fs.rmSync(emptyRoot, { recursive: true, force: true }); fs.mkdirSync(emptyRoot, { recursive: true }); fs.writeFileSync(`${emptyRoot}/just-a-file.txt`, 'x');
  const s = await start('fail', { TRESORIT_ROOT: emptyRoot });
  const r = await s.call('preflight');
  check('when an essential check fails the result says NOT PASSED and names the failure', /RESULT: NOT PASSED/.test(r.text) && /FAIL  The real Tresorit folder can be read/.test(r.text), r.text.split('\n').slice(0, 6).join(' / '));
  check('...and no pass is recorded', !fs.existsSync(`${s.DATA}/preflight-passed.json`));
  await s.client.close();
  fs.rmSync(emptyRoot, { recursive: true, force: true });
}
fs.rmSync(`${ROOT}/${Q}`, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
