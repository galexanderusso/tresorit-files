// Tools: tresorit_preflight, tresorit_connector_status, tresorit_access_log.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { VERSION } from '../lib/config.js';
import { UserError, existsAsNamed } from '../lib/paths.js';
import { reasonOf, REASONS } from '../lib/sniff.js';
import { powerState } from '../lib/power.js';
import { runPreflight } from '../preflight.js';
import {
  ROOT, DATA, HOLD, TRANSFER, BLOCKED, logger, log, index, ocr, HOME, NO_INDEX, FILE_PROVIDER, fmtSize, fmtDate,
  bg, indexHold, confirmNotIndexed,
} from '../core/setup.js';
import { BG_REQUEST_FILE, isWorker, becomeWorker, bgView, otherVersionReading, rebuildIndex, indexPass } from '../core/background.js';
import { GATE_ON, IS_PREFLIGHT_CHILD, checkedHere, forgetChecked, changing } from '../core/turns.js';
import { readBatches, batchMade, CLOCK_FLOOR, HOLDING_DAYS, lastSweep, measure } from '../core/changes.js';
import { server, TOOL_COUNT, tool, RO, RW } from '../core/server.js';
import { confirmHow, askOnMac, ELICIT_TIMEOUT_MS } from './delete.js';
import { transferItems, ageText } from './clear-transfer.js';

// ---- tresorit_preflight ------------------------------------------------------------------------------------------
// At the end of a self-check that has passed, the user is asked about the folders that are not to be indexed when
// a hold is in force (see "The safeguard" in core/setup.js): in a box of the Claude app where the app shows one,
// otherwise in the connector's own window. The first button is the safe one. Returns what to add to the reply.
const holdLine = (hold) => (hold.all
  ? 'HOLD: nothing new is read into the search index until the list of folders that are not to be indexed has been confirmed on this Mac. Run tresorit_preflight: it asks for that at its end.'
  : `HOLD: ${hold.folders.join('; ')} ${hold.folders.length > 1 ? 'are' : 'is'} no longer set as "do not index" and ${hold.folders.length > 1 ? 'stay' : 'stays'} out of the search index until that has been confirmed on this Mac. Run tresorit_preflight: it asks for that at its end.`);
// The names under "Folders not to index" that match no folder in Tresorit (compared the way the settings are).
const notIndexedUnmatched = () => (ROOT ? NO_INDEX.filter((b) => !existsAsNamed(ROOT, b.split(path.sep).join('/'))) : []);
let askingNotIndexed = null;
async function askAboutNotIndexed() {
  const hold = indexHold();
  if (!hold.all && !hold.folders.length) return '';
  const list = (names) => names.map((n) => `- ${n}`).join('\n');
  let body; let safe; let go; let tick;
  if (!hold.all) {
    body = `These folders are no longer set as "do not index":\n${list(hold.folders)}\n\nUntil now they were kept out of the search index. Read them into it now?`;
    safe = 'Keep them out'; go = 'Read them in'; tick = 'Yes, read them into the index';
  } else if (NO_INDEX.length) {
    // A name that matches no folder protects nothing (a slip of the keyboard, most likely): it is marked, here
    // where the user decides.
    const lost = notIndexedUnmatched();
    const marked = NO_INDEX.map((n) => `- ${n}${lost.includes(n) ? '   (NOT FOUND in Tresorit)' : ''}`).join('\n');
    body = `Start reading documents into the search index on this Mac?\n\nThese folders will NOT be read into it:\n${marked}\n\n${lost.length ? 'A name marked NOT FOUND matches no folder in Tresorit and protects nothing. If it is a typing slip, press Stop, correct the name in the connector\'s settings and run the self-check again.\n\n' : ''}Everything else in Tresorit will be read. The index keeps a copy of the text on this Mac, outside Tresorit.`;
    safe = 'Stop'; go = 'Start'; tick = 'Yes, start reading documents into the index';
  } else {
    body = `No folder is set as "do not index".${index.map.size ? ' A search index already exists on this Mac.' : ''}\n\nEvery document in Tresorit will be read into the search index, which keeps a copy of the text on this Mac, outside Tresorit. If some folders must stay out of it, press Stop, enter them in the connector's settings and run the self-check again.`;
    safe = 'Stop'; go = 'Start'; tick = 'Yes, read every document into the index';
  }
  const about = hold.all ? (NO_INDEX.join('; ') || 'no folder set') : hold.folders.join('; ');
  let answer;
  const caps = server.server.getClientCapabilities?.();
  if (caps && caps.elicitation) {
    try {
      const a = await server.server.elicitInput({ message: `Tresorit connector: ${body}`, requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: tick, default: false } }, required: ['confirm'] } }, { timeout: ELICIT_TIMEOUT_MS });
      answer = a && a.action === 'accept' && a.content && a.content.confirm === true ? 'yes' : 'no';
    } catch { answer = 'unanswered'; }
  } else answer = await askOnMac(body, safe, go);
  if (answer === 'yes' || answer === 'unsupported') {
    // (Where no window can be shown at all, on a computer that is not a Mac, the list is taken as the settings give it.)
    confirmNotIndexed();
    log('INDEX', '(folders not to index)', `${answer === 'yes' ? 'confirmed on this Mac' : 'taken from the settings (no confirmation window is available on this computer)'}: ${NO_INDEX.join('; ') || 'none'}`);
    if (bg.enabled) indexPass().catch(() => {});
    return `\n\nFolders not to index: ${answer === 'yes' ? 'confirmed on this Mac' : 'taken from the settings, because no confirmation window is available on this computer'} (${NO_INDEX.join('; ') || 'none'}). ${hold.all ? 'Documents are now read into the search index.' : 'The folders taken off the list are now read into the search index.'}`;
  }
  log('INDEX', '(folders not to index)', `not confirmed (${answer === 'no' ? `the user chose "${safe}"` : 'the question was not answered'}); the hold stays: ${about}`);
  return `\n\n${holdLine(hold)}\n(${answer === 'no' ? `The user chose "${safe}" when asked just now.` : 'The question asked just now was not answered.'})`;
}
let preflightRunning = null;
tool('tresorit_preflight', {
  title: 'Self-check on this computer',
  description: 'Run the connector\'s self-check on this computer. It runs a second copy of the connector, inside the connector itself, on a scratch folder in the connector\'s own data folder and tests reading every document type, staying inside the folder, capital letters and accents in names, saving, overwriting, copying, moving, deleting and restoring, bringing files in from the Mac and copying them out, receiving a file in parts, searching and text recognition. It changes nothing in Tresorit (the real folder is only listed). It takes under a minute. The connector is read-only until this check has passed once on each computer, and again after each update. Show the user the full report.',
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  if (IS_PREFLIGHT_CHILD) throw new UserError('The self-check cannot be started from inside itself.');
  if (!preflightRunning) {
    log('CHECK', '(self-check started)');
    preflightRunning = runPreflight({ dataDir: DATA, realRoot: ROOT, version: VERSION, expectedTools: TOOL_COUNT, realHome: HOME, noIndex: NO_INDEX, blocked: BLOCKED }).finally(() => { preflightRunning = null; });
  }
  const res = await preflightRunning;
  forgetChecked();
  log('CHECK', res.ok ? 'PASSED' : 'NOT PASSED', `${res.summary.passed} of ${res.summary.checks} checks passed; ${res.summary.critical_failed} essential failure(s)`);
  if (!res.ok) return res.text;
  if (!askingNotIndexed) askingNotIndexed = askAboutNotIndexed().finally(() => { askingNotIndexed = null; });
  return res.text + await askingNotIndexed; // (requests made together share the one question, as they share the one run)
});

// ---- tresorit_connector_status / tresorit_access_log ------------------------------------------------------------
tool('tresorit_connector_status', {
  title: 'Connector status',
  description: 'Show how the Tresorit connector is set up on this Mac: which folder it works on, the tresors found, the state of the search index and of text recognition for scanned PDFs, and where the access log, holding area and transfer folder are. Set rebuild_index to true to throw the search index away and read every document again.',
  inputSchema: { rebuild_index: z.boolean().default(false) },
  annotations: RW,
}, async ({ rebuild_index }) => {
  if (rebuild_index) {
    // While nothing new may be read into the index, a rebuild would throw the index away and read nothing to fill
    // it again: every search would come back empty until the user's yes. Refused, as tresorit_unlock_folder is.
    if (indexHold().all) throw new UserError('Rebuilding the search index is not available yet: nothing new is read into the search index until the list of folders that are not to be indexed has been confirmed on this Mac, so a rebuild would leave the index empty. Run tresorit_preflight: it asks for that at its end. The index is as it was.');
    if (await becomeWorker()) await rebuildIndex();
    else { try { fs.writeFileSync(BG_REQUEST_FILE, String(Date.now())); log('INDEX', '(rebuild requested)', 'passed on to the copy of the connector that does the background reading'); } catch { /* ignore */ } }
  }
  let tresors = [];
  try { tresors = (await fsp.readdir(ROOT, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { /* ignore */ }
  index.refresh(true);
  const c = index.counts();
  const batches = await readBatches();
  log('STATUS', '');
  // why documents could not be read, and how many have an ending that does not match their content
  const whys = Object.fromEntries(REASONS.map((r) => [r, 0])); let wrongEnding = 0; let openedWithPassword = 0;
  for (const e of index.map.values()) { const w = reasonOf(e); if (w) whys[w] = (whys[w] || 0) + 1; if (e.mm && !w) wrongEnding++; if (e.pw) openedWithPassword++; }
  const unreadableLine = `Unreadable by reason: ${whys.password} password-protected, ${whys.damaged} damaged, ${whys.empty} empty, ${whys.unsupported} with content of a kind that cannot be read, ${whys['too-large']} too large${whys.other ? `, ${whys.other} for another reason` : ''}. List them with tresorit_list_unreadable.`;
  // the holding area and the transfer folder: how much, and how old
  let holdBytes = 0; let holdOldest = 0; let wrongClock = 0;
  for (const b of batches) {
    const m = await measure(path.join(b.dir, 'files')).catch(() => ({ bytes: 0 })); holdBytes += m.bytes;
    const made = (await batchMade(b)) ?? Date.now();
    if (made < CLOCK_FLOOR) { wrongClock++; continue; } // (dated by a wrong clock: its age is unknown)
    if (!holdOldest || made < holdOldest) holdOldest = made;
  }
  const holdDays = holdOldest ? Math.floor((Date.now() - holdOldest) / 86_400_000) : 0;
  const swept = lastSweep();
  const tItems = await transferItems();
  const tBytes = tItems.reduce((n, x) => n + x.bytes, 0);
  const tOld = tItems.filter((x) => Date.now() - x.mtimeMs > 24 * 3_600_000).length;
  let power = '';
  try { const pwr = await powerState(); power = pwr.battery ? `on battery${pwr.percent !== null ? ` (${pwr.percent}%)` : ''}` : (process.platform === 'darwin' || process.env.TRESORIT_POWER_CMD) ? 'mains power' : ''; } catch { power = ''; }
  const v = bgView();
  const hold = indexHold();
  let reading;
  if (!v.enabled) reading = 'switched off';
  else if (hold.all) reading = 'on hold (see the line HOLD above)';
  else if (v.running) reading = v.phase === 'reading documents'
    ? `in progress${v.battery ? ' on battery (new documents only, in small amounts)' : ''}: reading documents (${v.extracted} new document(s) read so far in this pass, ${v.seen} checked)`
    : `in progress: recognising text in scanned PDFs (${v.ocrDone} of ${v.ocrTodo} done)`;
  else if (v.lastPass && (v.deferred || v.ocrDeferred)) {
    const waits = [];
    if (v.deferred) waits.push(`${v.deferred} document(s) still to read${v.low ? ' (the battery is low)' : v.deferredSmall ? ' (more than the hourly battery allowance; some are read each hour)' : ' (very large files)'}`);
    if (v.ocrDeferred) waits.push(`text recognition for ${v.ocrDeferred} scanned PDF(s)`);
    reading = `on battery as of ${fmtDate(v.lastPass)}: ${v.onBatteryRead} new document(s) read on battery in the last pass; waiting for mains power: ${waits.join(' and ')}. It carries on by itself when the Mac is plugged in`;
  } else if (v.lastPass) reading = `up to date as of ${fmtDate(v.lastPass)} (${v.seen} document(s) checked${FILE_PROVIDER ? `, ${v.cloudOnly} online-only skipped` : ''})`;
  else reading = 'has not run yet (starts shortly after the app opens)';
  // A name under "Blocked folders" that matches nothing protects nothing: say so.
  const blockedUnmatched = ROOT ? BLOCKED.filter((b) => !existsAsNamed(ROOT, b)) : [];
  const noIndexUnmatched = notIndexedUnmatched();
  const otherVersion = bg.enabled ? otherVersionReading() : null;
  return [
    `Tresorit connector ${VERSION}`,
    `Tresorit folder: ${ROOT}`,
    `Tresors: ${tresors.length ? tresors.join(', ') : '(none found)'}`,
    `Blocked folders: ${BLOCKED.length ? BLOCKED.join('; ') : 'none'}`,
    ...(blockedUnmatched.length ? [`WARNING: ${blockedUnmatched.map((b) => `"${b}"`).join(', ')} under "Blocked folders" ${blockedUnmatched.length > 1 ? 'match' : 'matches'} no folder in Tresorit, so nothing is blocked by ${blockedUnmatched.length > 1 ? 'those names' : 'that name'}. Check the spelling in the connector's settings (Settings > Extensions > Tresorit).`] : []),
    `Not indexed (read only when asked for by name, never searched): ${NO_INDEX.length ? NO_INDEX.join('; ') : 'none'}`,
    ...(noIndexUnmatched.length ? [`WARNING: ${noIndexUnmatched.map((b) => `"${b}"`).join(', ')} under "Folders not to index" ${noIndexUnmatched.length > 1 ? 'match' : 'matches'} no folder in Tresorit, so nothing is kept out of the search index by ${noIndexUnmatched.length > 1 ? 'those names' : 'that name'}. Check the spelling in the connector's settings (Settings > Extensions > Tresorit).`] : []),
    ...(hold.all || hold.folders.length ? [holdLine(hold)] : []),
    ...(otherVersion !== null ? [`WARNING: the background reading is done by a copy of the connector of another version (${otherVersion || 'earlier than 1.5.0'}), which follows its own rules: a folder set as "do not index" here can be read into the search index by it. Remove the older "Tresorit Files" extension in the Claude app (Settings > Extensions) and start Claude again.`] : []),
    `Files can be brought in from: ${HOME} and external drives (not hidden folders, Library, applications or key stores)`,
    `Memory in use by the connector: ${Math.round(process.memoryUsage().rss / 1048576)} MB`,
    ...(changing.what ? [`A change is in progress: ${changing.what}, running for ${Math.round((Date.now() - changing.since) / 1000)} second(s)${changing.waiting > 1 ? `; ${changing.waiting - 1} more waiting their turn` : ''}`] : []),
    `Self-check on this computer: ${!GATE_ON ? 'not required in this mode' : checkedHere() ? `passed on ${String(checkedHere().when).slice(0, 16).replace('T', ' ')} UTC (${checkedHere().passed} of ${checkedHere().checks} checks)` : 'NOT YET PASSED for this version. The connector is read-only until tresorit_preflight has been run and passes.'}`,
    `Before deleting, removing for good or copying a whole folder out of Tresorit, the user is asked: ${confirmHow()}`,
    '',
    `Search index: ${c.ok} document(s) readable (${(c.chars / 1e6).toFixed(1)} million characters), ${c.empty} with no text, ${c.error + c.toolarge} unreadable or too large.`,
    unreadableLine,
    ...(wrongEnding ? [`${wrongEnding} file(s) have an ending that does not match their content (for example a picture saved as .pdf); they are read by their content.`] : []),
    ...(openedWithPassword ? [`${openedWithPassword} password-protected PDF(s) were opened with a password and are searchable.`] : []),
    `Scanned PDFs: ${c.ocrDone} read by text recognition, ${c.ocrPending} waiting.`,
    `Text recognition (OCR): ${ocr.describe()}`,
    `Background reading: ${reading}`,
    ...(bg.enabled ? [`Background reading is done by: ${hold.all ? 'no copy of this version of the connector for now (see the line HOLD above)' : isWorker ? 'this copy of the connector' : otherVersion !== null ? 'another copy of the connector, of another version (see the line WARNING above)' : 'another copy of the connector (another Claude window)'}`] : []),
    ...(power ? [`Power: ${power}`] : []),
    '',
    `Access log: ${logger.currentFile()}`,
    `Holding area (deleted and replaced items, originals of files moved in): ${HOLD}   ${batches.length} batch(es)${batches.length ? `, ${fmtSize(holdBytes)}, the oldest ${holdDays} day(s) old` : ''}${HOLDING_DAYS ? `. Batches older than ${HOLDING_DAYS} day(s) are removed automatically (changed in the connector's settings; 0 = never)${swept ? `; last automatic clearing ${swept.when}: ${swept.batches} batch(es), ${fmtSize(swept.bytes || 0)}` : ''}${checkedHere() ? '' : '; not before the self-check has passed'}${wrongClock ? `. ${wrongClock} batch(es) carry a date from before 2025 (the clock of the Mac was wrong when they were made): those are not cleared automatically, only by hand with tresorit_clear_deleted` : ''}` : `. Automatic clearing is off (settings)${holdDays > 30 ? '; batches older than 30 days can be cleared with tresorit_clear_deleted (the user must approve)' : ''}`}`,
    `Transfer folder: ${TRANSFER}   ${tItems.length ? `${tItems.length} item(s), ${fmtSize(tBytes)}, the oldest ${ageText(tItems[0].mtimeMs)}` : 'empty'}${tOld ? `. ${tOld} item(s) are more than 24 hours old: they are copies outside Tresorit and can be removed with tresorit_clear_transfer (the user must approve).` : ''}`,
    `Search index files: ${index.dir}`,
  ].join('\n');
});

tool('tresorit_access_log', {
  title: 'Show the access log',
  description: 'Show the most recent lines of the connector\'s access log: every file opened, searched, written, moved or deleted through it.',
  inputSchema: {
    lines: z.number().int().min(1).max(500).default(50),
    contains: z.string().optional().describe('Only lines containing this text'),
  },
  annotations: RO,
}, async ({ lines, contains }) => {
  let all = [];
  let files = [];
  try { files = (await fsp.readdir(logger.dir)).filter((n) => /^access-\d{4}-\d{2}\.log$/.test(n)).sort().reverse(); } catch { /* ignore */ }
  for (const n of files.slice(0, 3)) {
    try {
      const part = (await fsp.readFile(path.join(logger.dir, n), 'utf8')).split('\n').filter(Boolean);
      all = part.concat(all);
    } catch { /* ignore */ }
    if (!contains && all.length >= lines) break;
  }
  if (contains) { const c = contains.toLowerCase(); all = all.filter((l) => l.toLowerCase().includes(c)); }
  const out = all.slice(-lines);
  return out.length ? [`Last ${out.length} line(s) of the access log (${logger.dir}):`, ...out].join('\n') : 'No matching log lines.';
});
