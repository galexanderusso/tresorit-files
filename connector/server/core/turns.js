// Whose turn it is: the self-check gate (read-only until the self-check has passed on this computer) and the
// queue that lets only one change run at a time, across all running copies of the connector.
import { makeChangeLock } from '../lib/lock.js';
import { VERSION } from '../lib/config.js';
import { UserError } from '../lib/paths.js';
import { preflightPassed } from '../preflight.js';
import { ROOT, DATA, log } from './setup.js';

// Until the self-check has passed on this computer (for this version and this Tresorit folder) the connector
// only reads. Changing anything in Tresorit is refused.
const GATE_ON = process.env.TRESORIT_PREFLIGHT_GATE !== 'off';
const IS_PREFLIGHT_CHILD = process.env.TRESORIT_PREFLIGHT_CHILD === '1';
let gateCache = null;
function checkedHere() {
  if (!GATE_ON) return { when: 'not required' };
  if (!gateCache) gateCache = preflightPassed(DATA, VERSION, ROOT);
  return gateCache;
}
function requireChecked(what) {
  if (checkedHere()) return;
  throw new UserError(`${what} is not available yet: this connector has not passed its self-check on this computer. Run tresorit_preflight first. It tests the connector in a scratch folder, changes nothing in Tresorit and takes under a minute. Until it passes, the connector can read and search but not change anything.`);
}
// After a self-check the result is looked up afresh.
function forgetChecked() { gateCache = null; }

// Changes are made strictly one at a time. Claude often issues several tool calls at once; two changes aimed at
// the same place must never run interleaved, or one could replace the other's result unnoticed. Reading and
// searching are not held up by this.
let changeQueue = Promise.resolve();
const changing = { what: '', since: 0, waiting: 0 };
// The app runs several copies of the connector (one per window or session). A lock file in the data folder makes
// the copies wait for each other too: see lib/lock.js.
const changeLock = makeChangeLock(DATA, { staleMs: Number(process.env.TRESORIT_LOCK_STALE_MS) || 120000, onNote: (m) => log('NOTE', '', m) });
process.on('exit', () => changeLock.releaseNow());
const CHANGE_WAIT_MS = Number(process.env.TRESORIT_CHANGE_WAIT_MS) || 5 * 60 * 1000;
function oneAtATime(fn, what = 'a change', signal = null) {
  // A change that has to wait too long behind another (for example a copy from a network drive that has stopped
  // answering) gives up with an explanation instead of waiting for ever. It is then never carried out.
  let gaveUp = false;
  let started = false;
  let timer = null;
  const turn = changeQueue.then(async () => {
    if (gaveUp) return undefined;
    // The app has withdrawn this request while it was waiting (it stopped waiting for the answer): it must not
    // be carried out behind the user's back later on. A change that has already begun always runs to its end.
    if (signal && signal.aborted) {
      log('REFUSED', what, 'withdrawn by the app while waiting its turn; not carried out');
      throw new UserError('This request was withdrawn by the app while it was waiting its turn. It was NOT carried out.');
    }
    // Wait for any other copy of the connector (another Claude window) that is in the middle of a change.
    const release = await changeLock.take(what, {
      stop: () => gaveUp || Boolean(signal && signal.aborted),
      onWait: (h) => { changing.what = `${h.what || 'a change'} in another Claude window`; changing.since = h.since || changing.since || Date.now(); },
    });
    if (!release || gaveUp) {
      if (release) await release();
      changing.what = ''; changing.since = 0;
      if (gaveUp) return undefined;
      log('REFUSED', what, 'withdrawn by the app while waiting its turn; not carried out');
      throw new UserError('This request was withdrawn by the app while it was waiting its turn. It was NOT carried out.');
    }
    started = true;
    clearTimeout(timer);
    changing.what = what; changing.since = Date.now();
    try { return await fn(); } finally { await release(); changing.what = ''; changing.since = 0; }
  });
  changeQueue = turn.then(() => {}, () => {});
  changing.waiting++;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (started) return;
      gaveUp = true;
      reject(new UserError(`Another change (${changing.what || 'unknown'}) has been running for ${Math.round((Date.now() - (changing.since || Date.now())) / 60000)} minute(s) and this one waited ${Math.round(CHANGE_WAIT_MS / 60000)} minute(s) for it. It was NOT carried out. Try again when the other change has finished (tresorit_connector_status shows it).`));
    }, CHANGE_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([turn, limit]).finally(() => { changing.waiting--; clearTimeout(timer); });
}

export { GATE_ON, IS_PREFLIGHT_CHILD, checkedHere, requireChecked, forgetChecked, changing, oneAtATime };
