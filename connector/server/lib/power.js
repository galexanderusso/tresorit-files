// Is this Mac running on its battery, and how full is it? Background work goes easy on the battery (see index.js).
// Asked of the system's own power tool; it involves no network. On a computer without a battery, or where the
// question cannot be answered, the answer is "no" and nothing is ever paused.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const TEST_CMD = process.env.TRESORIT_POWER_CMD || '';
// The answer is remembered for half the time between two looks, so that every look gets a fresh answer.
const TTL_MS = Math.min(15_000, Math.floor((Number(process.env.TRESORIT_POWER_POLL_MS) || 30_000) / 2));
let cache = { at: 0, value: { battery: false, percent: null } };
let pending = null;

function ask() {
  return new Promise((resolve) => {
    const unknown = { battery: false, percent: null };
    let cmd; let args;
    if (TEST_CMD) { cmd = '/bin/sh'; args = [TEST_CMD]; }
    else if (process.platform === 'darwin' && fs.existsSync('/usr/bin/pmset')) { cmd = '/usr/bin/pmset'; args = ['-g', 'batt']; }
    else { resolve(unknown); return; }
    try {
      execFile(cmd, args, { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
        if (err) { resolve(unknown); return; }
        const out = String(stdout);
        const m = out.match(/(\d{1,3})%/);
        resolve({ battery: /drawing from 'Battery Power'/i.test(out), percent: m ? Math.min(100, Number(m[1])) : null });
      });
    } catch { resolve(unknown); }
  });
}

// { battery: true when running on the battery, percent: charge level or null when not known }
export async function powerState() {
  if (Date.now() - cache.at < TTL_MS) return cache.value;
  if (!pending) pending = ask().then((v) => { cache = { at: Date.now(), value: v }; pending = null; return v; });
  return pending;
}

export async function onBattery() {
  return (await powerState()).battery;
}
