import { Client, StdioClientTransport, MOCK, TESTS, BUNDLE } from './lib/env.mjs';
// Cross-volume behaviour (connector data folder on a different disk from Tresorit) and a network-silence check.
import fs from 'node:fs';
const SERVER = process.env.SERVER || `${BUNDLE}/server/index.js`;
const ROOT = `${MOCK}/Tresors`;
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log('  ok  ', l); } else { fail++; console.log('  FAIL', l, '\n       ' + String(d).slice(0, 600)); } };
async function start(DATA, wrap = null) {
  fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999', TRESORIT_OCR_ENGINE: 'bundled' };
  const transport = new StdioClientTransport(wrap ? { command: wrap[0], args: [...wrap.slice(1), 'node', SERVER], env, stderr: 'ignore' } : { command: 'node', args: [SERVER], env, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  const call = async (tool, args = {}) => { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 }); return { text: r.content.map((c) => c.text || '').join('\n'), isError: !!r.isError }; };
  return { client, call };
}
// A folder on another disk than the test library: /dev/shm on Linux; elsewhere name one in TEST_OTHER_DISK.
const OTHER_DISK = process.env.TEST_OTHER_DISK || '/dev/shm';
if (!fs.existsSync(OTHER_DISK)) console.log(`  skip  the cross-disk checks need a folder on another disk (${OTHER_DISK} does not exist here; set TEST_OTHER_DISK)`);
else {
  const DATA = `${OTHER_DISK}/tresorit-xdev`;
  check('test set-up: data folder is on a different disk', fs.statSync(OTHER_DISK).dev !== fs.statSync(ROOT).dev);
  const s = await start(DATA);
  const D = 'Birch Labs/Xdev';
  await s.call('create_folder', { path: `${D}/sub` });
  await s.call('write_file', { path: `${D}/a.txt`, content: 'alpha' });
  await s.call('write_file', { path: `${D}/sub/b.txt`, content: 'beta' });
  let r = await s.call('write_file', { path: `${D}/a.txt`, content: 'alpha v2', overwrite: true });
  const rb = (r.text.match(/batch (\S+_replaced_\w+)/) || [])[1];
  check('replace across disks keeps the previous version', !r.isError && fs.readFileSync(`${DATA}/deleted/${rb}/files/${D}/a.txt`, 'utf8') === 'alpha' && fs.readFileSync(`${ROOT}/${D}/a.txt`, 'utf8') === 'alpha v2', r.text);
  r = await s.call('delete_items', { paths: [D] });
  const tok = r.text.match(/confirm_token "([0-9a-f]+)"/)[1];
  r = await s.call('delete_items', { paths: [D], confirm_token: tok });
  const db = (r.text.match(/batch (\S+_deleted_\w+)/) || [])[1];
  check('delete across disks: gone from Tresorit, whole folder in the holding area', !r.isError && !fs.existsSync(`${ROOT}/${D}`) && fs.readFileSync(`${DATA}/deleted/${db}/files/${D}/sub/b.txt`, 'utf8') === 'beta', r.text);
  r = await s.call('restore_deleted', { batch: db });
  check('restore across disks: back in place, batch removed', fs.readFileSync(`${ROOT}/${D}/sub/b.txt`, 'utf8') === 'beta' && fs.readFileSync(`${ROOT}/${D}/a.txt`, 'utf8') === 'alpha v2' && !fs.existsSync(`${DATA}/deleted/${db}`), r.text);
  r = await s.call('export_to_transfer', { path: `${D}/a.txt` });
  fs.writeFileSync(`${DATA}/transfer/incoming.docx`, 'docx bytes');
  r = await s.call('import_from_transfer', { name: 'incoming.docx', destination: D });
  check('import across disks moves the file in', !r.isError && fs.readFileSync(`${ROOT}/${D}/incoming.docx`, 'utf8') === 'docx bytes' && !fs.existsSync(`${DATA}/transfer/incoming.docx`), r.text);
  await s.client.close();
  fs.rmSync(`${ROOT}/${D}`, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
}
if (process.platform !== 'linux') console.log('  skip  the system-call trace for network connections needs strace (Linux only)');
else {
  // Run a full working session under a system-call tracer and look for any attempt to open a network connection.
  const LOG = `${TESTS}/scratch/net-trace.log`;
  fs.rmSync(LOG, { force: true });
  const s = await start(`${MOCK}/data-net`, ['strace', '-f', '-qq', '-e', 'trace=connect,sendto,sendmsg', '-o', LOG]);
  const a = await s.call('read_file', { path: 'Personal/Scans/Contract scan.pdf' });
  const b = await s.call('search_contents', { query: 'unicorn-keyword' });
  const c = await s.call('read_file', { path: 'Alder Works UK/06 - Emails/unicode.msg' });
  const d = await s.call('connector_status', {});
  await s.client.close();
  await new Promise((r) => setTimeout(r, 500));
  const lines = fs.readFileSync(LOG, 'utf8').split('\n');
  const inet = lines.filter((l) => /AF_INET6?|sin_addr|sin6_addr/.test(l));
  check('session did real work (OCR, search, message read)', a.text.includes('ZEBRA-QUARTZ-7781') && b.text.includes('technical report') && c.text.includes('Brian Zhou') && /bundled engine/.test(d.text));
  check(`no network connection was attempted (${lines.length} traced calls, 0 to the internet)`, inet.length === 0, inet.slice(0, 5).join('\n'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
