// One place that says where the tests work and which connector they test, so that the same test files run on
// Linux and on a Mac.
//   TEST_BASE  the folder that holds mock/ (default: /home/tester/build; on a Mac it must be set)
//   SERVER     server/index.js of the connector under test
//              (default: <TEST_BASE>/tresorit-connector/server/index.js)
// The MCP client is taken from the connector under test, not from a second copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const IS_MAC = process.platform === 'darwin';
export const BASE = (process.env.TEST_BASE || '/home/tester/build').replace(/\/+$/, '');
export const MOCK = `${BASE}/mock`;
export const BUILD = BASE; // the same, under a name that does not clash with a suite's own BASE
export const SERVER = process.env.SERVER || `${BASE}/tresorit-connector/server/index.js`;
export const BUNDLE = path.dirname(path.dirname(SERVER));
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TESTS = path.dirname(HERE); // the tests folder itself (scratch/ and fixtures/ are in it)

// Never the real thing. On a Mac in use the real Tresorit folder and the real data folder are in the home
// folder; a test library there, or a missing TEST_BASE, stops the run before anything is started.
{
  const real = [path.join(os.homedir(), 'Tresors'), path.join(os.homedir(), 'TresoritConnector'), path.join(os.homedir(), 'Library')];
  const inside = (p, dir) => (p + path.sep).startsWith(dir + path.sep);
  if (IS_MAC && !process.env.TEST_BASE) throw new Error('Set TEST_BASE to a scratch folder (for example <project>/work/base).');
  if (BASE === os.homedir() || real.some((r) => inside(BASE, r) || inside(r, BASE))) throw new Error(`TEST_BASE must be a scratch folder, not ${BASE}`);
  if (!fs.existsSync(SERVER)) throw new Error(`SERVER not found: ${SERVER}`);
}

// Every server a test starts inherits these (the tests pass process.env on).
// - The connector's own confirmation window (1.4.7 and later) is answered by a stand-in that presses the
//   action button. A test that wants another answer sets TRESORIT_CONFIRM_CMD itself.
// - On a Mac, the home folder and the password box default to stand-ins too, so that a test which sets
//   neither can never look into the real home folder or open a real box on the screen.
const standIn = (name) => JSON.stringify([process.execPath, path.join(HERE, name)]);
if (!('TRESORIT_CONFIRM_CMD' in process.env)) process.env.TRESORIT_CONFIRM_CMD = standIn('confirm-yes.mjs');
if (IS_MAC) {
  if (!('TRESORIT_HOME_DIR' in process.env)) process.env.TRESORIT_HOME_DIR = `${MOCK}/home-not-there`;
  if (!('TRESORIT_IMPORT_ROOTS' in process.env)) process.env.TRESORIT_IMPORT_ROOTS = `${MOCK}/home-not-there`;
  if (!('TRESORIT_PASSWORD_CMD' in process.env)) process.env.TRESORIT_PASSWORD_CMD = standIn('password-none.mjs');
}

const sdk = (file) => import(pathToFileURL(path.join(BUNDLE, 'node_modules/@modelcontextprotocol/sdk/dist/esm', file)).href);
export const { Client } = await sdk('client/index.js');
export const { StdioClientTransport } = await sdk('client/stdio.js');
export const sdkTypes = await sdk('types.js');
export const { ElicitRequestSchema } = sdkTypes;

// A module of the connector under test, e.g. serverLib('extractor.js'). `tag` gives a fresh copy of the module.
export const serverLib = (name, tag = '') => import(pathToFileURL(path.join(BUNDLE, 'server/lib', name)).href + (tag ? `?${tag}` : ''));

// Memory in use by a process, in MB (0 when it cannot be told).
export function rssMB(pid) {
  try {
    if (fs.existsSync(`/proc/${pid}/status`)) return Math.round(Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
    return Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024);
  } catch { return 0; }
}
