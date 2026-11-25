// The project's own checks, in one command (run from the project folder):
//   node tools/check.mjs quick     about 15 seconds; runs by itself before every commit (tools/hooks/pre-commit)
//   node tools/check.mjs full      the quick checks, the self-check and all suites; about 25 minutes
//   node tools/check.mjs record    writes the reference files again after a change that was decided on purpose
//                                  (tool list and instructions, fingerprint of node_modules)
// Option: --connector <folder>  checks another copy of the connector (used to see that each check can fail).
// Everything runs in scratch folders under work/. The real Tresorit folder and data folder are never used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const mode = args[0];
const optAt = args.indexOf('--connector');
const CONNECTOR = optAt > 0 ? path.resolve(args[optAt + 1]) : path.join(PROJECT, 'connector');
const OWN = CONNECTOR === path.join(PROJECT, 'connector');
if (!['quick', 'full', 'record'].includes(mode)) { console.error('usage: node tools/check.mjs quick|full|record [--connector <folder>]'); process.exit(2); }
const SERVER_DIR = path.join(CONNECTOR, 'server');
const EXPECT = path.join(PROJECT, 'tools', 'expected');
const BASE = path.join(PROJECT, 'work', mode === 'full' ? 'base' : 'quick-base'); // the quick checks have a library of their own
const childEnv = { ...process.env, TEST_BASE: BASE, SERVER: path.join(SERVER_DIR, 'index.js'), TRESORIT_PREFLIGHT_GATE: 'off', NODE_OPTIONS: '' };
const node = (a, opts = {}) => spawnSync(process.execPath, a, { cwd: PROJECT, env: childEnv, encoding: 'utf8', maxBuffer: 1 << 27, ...opts });

const results = [];
const say = (ok, name, detail = '') => { results.push({ ok, name, detail }); console.log(`${ok === true ? '  ok   ' : ok === 'note' ? '  note ' : '  FAIL '}${name}${detail ? `\n         ${String(detail).split('\n').join('\n         ')}` : ''}`); };
const ownFiles = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) ownFiles(p, out); else out.push(p); } return out; };
const jsFiles = () => ownFiles(SERVER_DIR).filter((f) => f.endsWith('.js') || f.endsWith('.cjs'));

// ---- The single checks ------------------------------------------------------------------------------------------
function syntax() {
  const bad = [];
  for (const f of jsFiles()) { const r = node(['--check', f]); if (r.status !== 0) bad.push(`${path.relative(CONNECTOR, f)}: ${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'does not parse'}`); }
  say(!bad.length, `every program file of the connector can be read by Node (${jsFiles().length} files)`, bad.join('\n'));
}
function structure() {
  const r = node(['--expose-internals', path.join(PROJECT, 'tools', 'checks', 'structure.mjs'), SERVER_DIR]);
  say(r.status === 0, 'the parts are loaded in a fixed order and each uses only parts loaded before it', r.status === 0 ? '' : (r.stdout || r.stderr).trim());
}
function versions() {
  const a = (fs.readFileSync(path.join(SERVER_DIR, 'lib', 'config.js'), 'utf8').match(/export const VERSION = '([^']+)'/) || [])[1];
  const b = JSON.parse(fs.readFileSync(path.join(CONNECTOR, 'package.json'), 'utf8')).version;
  const c = JSON.parse(fs.readFileSync(path.join(CONNECTOR, 'manifest.json'), 'utf8')).version;
  say(Boolean(a) && a === b && b === c, `the version is the same in its three places (${a})`, a === b && b === c ? '' : `config.js ${a}, package.json ${b}, manifest.json ${c}`);
  return a;
}
function dashes() {
  const files = [...jsFiles(), path.join(CONNECTOR, 'README.md'), path.join(CONNECTOR, 'manifest.json')];
  if (OWN) files.push(...[path.join(PROJECT, 'README.md'), path.join(PROJECT, 'tests', 'README-TESTS.md')].filter((f) => fs.existsSync(f)));
  const hits = [];
  for (const f of files) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (l.includes('—')) hits.push(`${path.relative(PROJECT, f)} line ${i + 1}`); });
  say(!hits.length, 'no long dash in the replies and the README files', hits.slice(0, 10).join('\n'));
}
function network() {
  const rx = /from\s+['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]|require\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]\s*\)|\bfetch\s*\(|XMLHttpRequest|WebSocket/;
  const hits = [];
  for (const f of jsFiles()) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (rx.test(l)) hits.push(`${path.relative(CONNECTOR, f)} line ${i + 1}: ${l.trim().slice(0, 90)}`); });
  say(!hits.length, 'the connector\'s own code names nothing that could open a network connection', hits.slice(0, 10).join('\n'));
}
function modulesPrint() {
  const root = path.join(CONNECTOR, 'node_modules');
  const h = crypto.createHash('sha256'); let n = 0;
  for (const f of ownFiles(root).sort()) { const st = fs.lstatSync(f); h.update(`${path.relative(root, f)}\0${st.isSymbolicLink() ? `link:${fs.readlinkSync(f)}` : crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}\n`); n++; }
  return `${h.digest('hex')}  ${n} files`;
}
function modules() {
  const now = modulesPrint();
  let was = ''; try { was = fs.readFileSync(path.join(EXPECT, 'node_modules.sha256'), 'utf8').trim(); } catch { /* none yet */ }
  say(now === was, 'the bundled libraries (node_modules, pruned by hand) are exactly as recorded', now === was ? '' : `recorded: ${was || '(nothing)'}\nnow:      ${now}`);
}
async function toolList(version) {
  // What Claude is told: the 28 tools with their descriptions, and the instructions. Compared word for word.
  process.env.TEST_BASE = BASE; process.env.SERVER = childEnv.SERVER;
  const { Client, StdioClientTransport, MOCK } = await import('../tests/lib/env.mjs');
  const DATA = `${MOCK}/data-check-tools`; fs.rmSync(DATA, { recursive: true, force: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [childEnv.SERVER], env: { ...process.env, ...childEnv, TRESORIT_ROOT: `${MOCK}/Tresors`, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '999999' }, stderr: 'ignore' });
  const client = new Client({ name: 'check', version: '1' }, { capabilities: {} });
  let now;
  try {
    await client.connect(transport);
    now = { server: client.getServerVersion().name, instructions: client.getInstructions(), tools: (await client.listTools()).tools };
    const told = client.getServerVersion().version;
    say(told === version, 'the running connector reports the version of config.js', told === version ? '' : `${told} against ${version}`);
    await client.close();
  } catch (e) { say(false, 'the connector starts and answers', String(e && e.message || e)); return null; }
  const manifest = JSON.parse(fs.readFileSync(path.join(CONNECTOR, 'manifest.json'), 'utf8')).tools.map((t) => t.name);
  const names = now.tools.map((t) => t.name);
  say(names.length === manifest.length && names.every((n) => manifest.includes(n)), `the connector offers the tools the manifest lists (${names.length})`, names.filter((n) => !manifest.includes(n)).concat(manifest.filter((n) => !names.includes(n))).join(', '));
  const file = path.join(EXPECT, 'tool-list.json');
  if (mode === 'record') { fs.writeFileSync(file, JSON.stringify(now, null, 1) + '\n'); return now; }
  let was = null; try { was = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const diffs = [];
  if (!was) diffs.push('no reference recorded yet (node tools/check.mjs record)');
  else {
    if (was.server !== now.server) diffs.push(`server name: ${now.server}`);
    if (was.instructions !== now.instructions) diffs.push('the instructions sent to Claude differ');
    if (was.tools.map((t) => t.name).join() !== names.join()) diffs.push('the tool names or their order differ');
    for (const t of now.tools) { const o = was.tools.find((x) => x.name === t.name); if (o && JSON.stringify(o) !== JSON.stringify(t)) diffs.push(`${t.name}: title, description, inputs or hints differ`); }
  }
  say(!diffs.length, 'tool names, order, descriptions, inputs and the instructions are word for word as recorded', diffs.join('\n'));
  return now;
}
// One group of suites on a fresh library, as tests/lib/run.mjs does it. Returns the SUITE lines it printed.
function suites(lib, list) {
  const r = node([path.join(PROJECT, 'tests', 'lib', 'run.mjs'), lib, ...list]);
  return (r.stdout || '').split('\n').filter((l) => l.startsWith('SUITE') || l.startsWith('LIBRARY'));
}
function judge(expected, lines) {
  for (const l of lines) {
    const m = l.match(/^SUITE (\S+) on library \w: (?:(\d+) passed, (\d+) failed|NO RESULT LINE); FAIL lines \d+; skipped parts (\d+); (.*?); (\d+) s/);
    if (!m) { say(false, l); continue; }
    const [, name, p, f, skipped, ended, secs] = m; let exp = expected.suites[name];
    // A part that needs something a computer may not have: the second figure counts only where that thing is really absent.
    const lacking = Boolean(exp.without) && !fs.existsSync(path.join(BASE, exp.without.needs));
    if (lacking) exp = { ...exp, ...exp.without };
    const out = (() => { try { return fs.readFileSync(path.join(BASE, 'results', `${name}.out`), 'utf8'); } catch { return ''; } })();
    const failed = out.split('\n').filter((x) => /^\s*FAIL /.test(x)).map((x) => x.replace(/^\s*FAIL /, '').trim());
    const known = failed.filter((x) => (exp.known || []).some((k) => x.startsWith(k)));
    const unsteady = failed.filter((x) => (exp.unsteady || []).some((k) => x.startsWith(k)));
    const fresh = failed.filter((x) => !known.includes(x) && !unsteady.includes(x));
    const total = Number(p || 0) + Number(f || 0);
    const missingKnown = (exp.known || []).filter((k) => !failed.some((x) => x.startsWith(k)));
    const ok = p !== undefined && total === exp.checks && !fresh.length && /^exit [01]$/.test(ended);
    say(ok, `${name}: ${p ?? '?'} of ${total} passed in ${secs} s`, [
      total !== exp.checks ? `expected ${exp.checks} checks, counted ${total}` : '',
      !/^exit [01]$/.test(ended) ? ended : '',
      ...fresh.map((x) => `NEW FAILURE: ${x.slice(0, 150)}`)].filter(Boolean).join('\n'));
    if (Number(skipped) !== (exp.skips || 0)) say(false, `${name}: ${skipped} part(s) skipped, ${exp.skips || 0} expected on this computer`);
    else if (lacking) say('note', `${name}: ${exp.say}`);
    for (const x of known) say('note', `${name}: fails as recorded (a finding not yet repaired): ${x.slice(0, 110)}`);
    for (const x of unsteady) say('note', `${name}: a check known to come and go failed this time: ${x.slice(0, 110)}`);
    for (const k of missingKnown) say('note', `${name}: a check recorded as failing passed this time: ${k.slice(0, 110)} (update tools/expected/suites.json if it was repaired)`);
  }
}

// ---- The run ----------------------------------------------------------------------------------------------------
fs.mkdirSync(BASE, { recursive: true });
const lockFile = path.join(BASE, '.check-running');
try { const pid = Number(fs.readFileSync(lockFile, 'utf8')); process.kill(pid, 0); console.error(`Another run of the checks (process ${pid}) is using ${path.relative(PROJECT, BASE)}. Wait for it to end.`); process.exit(2); } catch { /* free */ }
fs.writeFileSync(lockFile, String(process.pid));
process.on('exit', () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ } });

const started = Date.now();
console.log(`${mode === 'full' ? 'Full' : mode === 'quick' ? 'Quick' : 'Recording the reference for the'} checks of ${path.relative(PROJECT, CONNECTOR) || CONNECTOR}`);
const expected = JSON.parse(fs.readFileSync(path.join(EXPECT, 'suites.json'), 'utf8'));
const restore = node([path.join(PROJECT, 'tests', 'lib', 'restore-library.mjs'), 'A']);
if (restore.status !== 0) { console.error(`The test library could not be restored: ${restore.stderr || restore.stdout}`); process.exit(2); }

if (mode === 'record') {
  if (!OWN) { console.error('record works on the project\'s own connector only'); process.exit(2); }
  const v = versions();
  fs.mkdirSync(EXPECT, { recursive: true });
  fs.writeFileSync(path.join(EXPECT, 'node_modules.sha256'), modulesPrint() + '\n');
  await toolList(v);
  console.log('Reference files written in tools/expected. Commit them together with the change they belong to.');
  process.exit(results.some((r) => r.ok === false) ? 1 : 0);
}

syntax();
structure();
const version = versions();
dashes();
network();
modules();
await toolList(version);
if (mode === 'quick') judge(expected, suites('A', expected.quick));
else {
  // The self-check, as a user runs it after an installation, with the gate in force.
  const snap = node([path.join(PROJECT, 'tools', 'split', 'snapshot.mjs'), 'check', 'selfcheck'], { env: { ...childEnv, TRESORIT_PREFLIGHT_GATE: undefined } });
  let line = ''; try { const s = JSON.parse(fs.readFileSync(path.join(BASE, 'snapshots', 'check.json'), 'utf8')); line = Object.entries(s.calls).find(([k]) => k.includes('preflight'))[1].text.split('\n')[1]; } catch { /* no snapshot */ }
  say(snap.status === 0 && /^RESULT: PASSED\. (\d+) of \1 checks passed/.test(line), `the self-check passes (${line.replace('RESULT: ', '').slice(0, 60) || 'no report'})`, snap.status === 0 ? '' : (snap.stderr || '').slice(0, 400));
  for (const [lib, list] of expected.groups) judge(expected, suites(lib, list));
}

const failed = results.filter((r) => r.ok === false);
const notes = results.filter((r) => r.ok === 'note');
const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: PROJECT, encoding: 'utf8' }).stdout.trim() !== '';
const verdict = `${failed.length ? 'NOT PASSED' : 'PASSED'}: ${results.filter((r) => r.ok === true).length} in order, ${failed.length} failed, ${notes.length} note(s); ${Math.round((Date.now() - started) / 1000)} s; version ${version}, after commit ${head}${dirty ? ' with changes not yet committed' : ''}`;
console.log(verdict);
if (mode === 'full' && OWN) {
  const dir = path.join(PROJECT, 'work', 'check'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  fs.writeFileSync(path.join(dir, `full-${stamp}.txt`), [verdict, '', ...results.map((r) => `${r.ok === true ? 'ok  ' : r.ok === 'note' ? 'note' : 'FAIL'} ${r.name}${r.detail ? `\n     ${r.detail}` : ''}`)].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'last-full.json'), JSON.stringify({ when: new Date().toISOString(), passed: !failed.length, version, commit: head, uncommitted: dirty }, null, 1) + '\n');
}
process.exit(failed.length ? 1 : 0);
