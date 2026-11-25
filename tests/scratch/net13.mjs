import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs'; import crypto from 'node:crypto';
const BASE = '/home/tester/build/mock'; const DATA = `${BASE}/data-net13`; const HOME = `${BASE}/data-net13-home`;
fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(`${HOME}/Downloads`, { recursive: true }); fs.mkdirSync(`${HOME}/Desktop`);
fs.writeFileSync(`${HOME}/Downloads/net file.pdf`, 'net test'); fs.writeFileSync(`${BASE}/data-net13-power.sh`, `echo "Now drawing from 'AC Power'"\n`);
const transport = new StdioClientTransport({ command: 'strace', args: ['-f', '-qq', '-e', 'trace=connect,socket,bind,sendto', '-o', '/tmp/net13.trace', 'node', '/home/tester/build/final/server/index.js'], env: { ...process.env, TRESORIT_ROOT: `${BASE}/Tresors`, TRESORIT_DATA_DIR: DATA, TRESORIT_HOME_DIR: HOME, TRESORIT_IMPORT_ROOTS: HOME, TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_OCR_ENGINE: 'bundled', TRESORIT_POWER_CMD: `${BASE}/data-net13-power.sh`, TRESORIT_POWER_POLL_MS: '500', TRESORIT_HOLDING_FIRST_MS: '400', TRESORIT_HOLDING_SWEEP_MS: '400', TRESORIT_PASSWORD_CMD: JSON.stringify(['/bin/sh', '-c', `cat "${BASE}/data-fx14/pw.txt"`]) }, stderr: 'ignore' });
const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
const call = async (tool, args = {}) => (await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n');
console.log((await call('preflight')).split('\n')[1]);
const h = (b) => crypto.createHash('sha256').update(b).digest('hex'); const buf = crypto.randomBytes(3000);
const out = [];
out.push((await call('import_file', { source: 'net file.pdf', destination: 'Birch Labs/net13' })).split('\n')[0]);
out.push((await call('import_file', { source: '~/Downloads/net file.pdf', destination: 'Birch Labs/net13/moved.pdf', mode: 'move', allow_duplicate: true })).split('\n')[0]);
out.push((await call('export_file', { path: 'Birch Labs/net13/moved.pdf', to: 'Desktop' })).split('\n')[0]);
out.push(await call('receive_file', { path: 'Birch Labs/net13/r.bin', part: 1, parts: 1, data: buf.toString('base64'), part_sha256: h(buf), file_sha256: h(buf) }));
out.push((await call('list_outside_folder', {})).split('\n')[0]);
out.push((await call('clear_deleted', { older_than_days: 0 })).split('\n')[1]);
await call('search_contents', { query: 'unicorn-keyword' }); await call('read_file', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf' });
// 1.4.0: the new tools
fs.mkdirSync(`${BASE}/Tresors/Birch Labs/net13/pw`, { recursive: true }); fs.copyFileSync(`${BASE}/data-fx14/locked-aes256.pdf`, `${BASE}/Tresors/Birch Labs/net13/pw/locked.pdf`); fs.copyFileSync(`${BASE}/data-fx14/locked-aes256.pdf`, `${BASE}/Tresors/Birch Labs/net13/pw/locked copy.pdf`); fs.copyFileSync(`${BASE}/data-fx14/page.png`, `${BASE}/Tresors/Birch Labs/net13/pw/picture.pdf`);
out.push('read with password: ' + (await call('read_file', { path: 'Birch Labs/net13/pw/locked.pdf', ask_password: true })).split('\n')[0].slice(0, 90));
out.push('unlock: ' + (await call('unlock_folder', { path: 'Birch Labs/net13/pw' })).split('\n')[0].slice(0, 90));
out.push('picture as pdf: ' + (await call('read_file', { path: 'Birch Labs/net13/pw/picture.pdf' })).split('\n')[0].slice(0, 90));
out.push('unreadable: ' + (await call('list_unreadable', { path: 'Birch Labs/net13' })).split('\n')[0].slice(0, 90));
out.push('identical: ' + (await call('find_identical', { path: 'Birch Labs/net13', min_size_kb: 0 })).split('\n')[0].slice(0, 90));
out.push('export several: ' + (await call('export_to_transfer', { paths: ['Birch Labs/net13/pw/locked.pdf', 'Birch Labs/net13/moved.pdf'] })).split('\n')[0].slice(0, 90));
{ const pv = await call('clear_transfer', {}); const tk = (pv.match(/confirm_token "([0-9a-f]+)"/) || [])[1]; out.push('clear transfer: ' + (tk ? (await call('clear_transfer', { confirm_token: tk })).split('\n')[0].slice(0, 90) : 'NO TOKEN: ' + pv.slice(0, 80))); }
for (let i = 0; i < 300; i++) { await new Promise((r) => setTimeout(r, 400)); if (/up to date as of/.test(await call('connector_status'))) break; }
console.log(out.join('\n'));
await client.close(); fs.rmSync(`${BASE}/Tresors/Birch Labs/net13`, { recursive: true, force: true });
