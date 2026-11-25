// A folder is replaced by a copy of another one, again and again, and the connector is killed at random moments.
// At every moment the folder being replaced must be the old one, the complete new one, or (for an instant) away
// in the holding area: never half a folder.
import fs from 'node:fs'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
const SERVER = process.env.SERVER; const BASE = '/home/tester/build/mock'; const ROOT = `${BASE}/Tresors`; const W = 'Birch Labs/chaos-x';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const T = (rel) => `${ROOT}/${rel}`;
const KILLS = Number(process.argv[2]) || 120; const DATA = `${BASE}/data-chaos-x`; fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(T(W), { recursive: true, force: true }); fs.mkdirSync(T(`${W}/src`), { recursive: true }); for (let i = 0; i < 300; i++) fs.writeFileSync(T(`${W}/src/o${i}.bin`), crypto.randomBytes(50000));
const reset = () => { fs.rmSync(T(`${W}/copy`), { recursive: true, force: true }); fs.mkdirSync(T(`${W}/copy`), { recursive: true }); fs.writeFileSync(T(`${W}/copy/old.txt`), 'OLD COPY'); };
reset();
let half = 0, unsafe = 0, done = 0, away = 0, old = 0; const seen = []; let made = false;
for (let round = 1; round <= KILLS; round++) {
  const child = spawn('node', [SERVER], { env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_BACKGROUND_INDEX: 'false', TRESORIT_PREFLIGHT_GATE: 'off', TRESORIT_STAGING_MAX_AGE_MS: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {}); child.stdout.on('data', () => {});
  const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } }); await sleep(600); send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tresorit_copy_item', arguments: { source: `${W}/src`, destination: `${W}/copy`, overwrite: true } } });
  await sleep(3 + Math.floor(Math.random() * 700)); child.kill('SIGKILL'); await new Promise((r) => child.on('exit', r));
  const inner = `${W}/copy/src`; const c = fs.existsSync(T(`${W}/copy`)) ? fs.readdirSync(T(`${W}/copy`)) : [];
  if (!c.includes('old.txt') || c.some((n) => n !== 'old.txt' && n !== 'src')) { unsafe++; seen.push(`round ${round}: the folder copied into holds: ${c.join(', ').slice(0, 80)}`); reset(); made = false; }
  else if (fs.existsSync(T(inner))) { const n = fs.readdirSync(T(inner)).length; if (n === 300) { done++; made = true; } else { half++; seen.push(`round ${round}: copy with ${n} of 300`); reset(); made = false; } }
  else if (made) { const safe = fs.readdirSync(`${DATA}/deleted`).some((b) => { try { return fs.readdirSync(`${DATA}/deleted/${b}/files/${inner}`).length === 300; } catch { return false; } }); if (safe) away++; else { unsafe++; seen.push(`round ${round}: previous copy gone and not in the holding area`); } made = false; }
  else old++;
}
const log = fs.readdirSync(`${DATA}/logs`).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n');
console.log(`${KILLS} kills while a folder was being replaced: no copy yet ${old}, complete copy in place ${done}, being swapped at that instant with the previous copy safe in the holding area ${away}, HALF A COPY ${half}, anything lost or damaged ${unsafe}${seen.length ? ' | ' + seen.slice(0, 6).join('; ') : ''}`);
fs.rmSync(T(W), { recursive: true, force: true });
