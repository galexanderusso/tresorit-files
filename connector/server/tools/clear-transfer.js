// Tool: tresorit_clear_transfer.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../lib/paths.js';
import { ROOT, TRANSFER, log, fmtSize, show } from '../core/setup.js';
import { requireChecked, oneAtATime } from '../core/turns.js';
import { measure } from '../core/changes.js';
import { tool } from '../core/server.js';
import { TOKEN_TTL_MS } from './delete.js';
import { askInDialog } from './clear-deleted.js';

// ---- tresorit_clear_transfer ----------------------------------------------------------------------------------------
async function transferItems() {
  let ents = [];
  try { ents = await fsp.readdir(TRANSFER, { withFileTypes: true }); } catch { return []; }
  const items = [];
  for (const e of ents) {
    if (e.name === '.DS_Store') continue;
    const abs = path.join(TRANSFER, e.name);
    let st; try { st = await fsp.lstat(abs); } catch { continue; }
    const m = st.isDirectory() ? await measure(abs).catch(() => ({ files: 0, bytes: 0 })) : { files: 1, bytes: st.size };
    items.push({ name: e.name, abs, dir: st.isDirectory(), mtimeMs: st.mtimeMs, files: m.files, bytes: m.bytes });
  }
  return items.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
const ageText = (ms) => { const h = (Date.now() - ms) / 3_600_000; return h < 1 ? 'under an hour old' : h < 48 ? `${Math.round(h)} hour(s) old` : `${Math.round(h / 24)} day(s) old`; };
const pendingTransferClears = new Map();

tool('tresorit_clear_transfer', {
  title: 'List and empty the transfer folder (needs the user\'s permission)',
  description: 'Show what is in the connector\'s transfer folder (copies made by tresorit_export_to_transfer, outside Tresorit and not encrypted by it) and remove it. THE USER MUST APPROVE. Step 1: call without a token; nothing is removed and you get the list with sizes and ages, and a confirm_token. Step 2: show the user the list, and only after an explicit yes call again with the same arguments and the confirm_token. Removal is for good: these are copies, the originals stay in Tresorit, and nothing in Tresorit is touched.',
  inputSchema: {
    older_than_hours: z.number().min(0).max(87600).default(0).describe('Only items older than this many hours; 0 for everything'),
    confirm_token: z.string().optional().describe('The token from the preview step. Only pass it after the user has said yes.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ older_than_hours, confirm_token }, extra) => {
  const all = await transferItems();
  const chosen = all.filter((x) => Date.now() - x.mtimeMs >= older_than_hours * 3_600_000);
  const keyOf = () => chosen.map((x) => `${x.name}|${x.bytes}|${x.files}`).sort().join('\n');
  for (const [tok, v] of pendingTransferClears) if (v.expires < Date.now()) pendingTransferClears.delete(tok);
  const bytes = chosen.reduce((n, x) => n + x.bytes, 0); const filesN = chosen.reduce((n, x) => n + x.files, 0);
  if (!confirm_token) {
    log('TRANSFER', `${all.length} item(s)`, `listed: ${fmtSize(all.reduce((n, x) => n + x.bytes, 0))}`);
    if (!all.length) return `The transfer folder is empty.\n${TRANSFER}`;
    if (!chosen.length) return `The transfer folder holds ${all.length} item(s), none older than ${older_than_hours} hour(s). Nothing to remove.`;
    const token = crypto.randomBytes(4).toString('hex');
    pendingTransferClears.set(token, { key: keyOf(), expires: Date.now() + TOKEN_TTL_MS });
    return [
      'NOTHING HAS BEEN REMOVED. This is a preview.',
      `Transfer folder: ${TRANSFER}`,
      `Would remove for good ${chosen.length} of ${all.length} item(s): ${filesN} file(s), ${fmtSize(bytes)}. They are copies outside Tresorit; the originals in Tresorit are not touched.`,
      ...chosen.slice(0, 60).map((x) => `- ${x.dir ? '[FOLDER]' : '[FILE]  '} ${show(x.name)}   ${x.files} file(s), ${fmtSize(x.bytes)}   ${ageText(x.mtimeMs)}`),
      ...(chosen.length > 60 ? [`...and ${chosen.length - 60} more.`] : []),
      '',
      `Show this to the user and ask for permission. Only after an explicit yes, call tresorit_clear_transfer again with the same arguments and confirm_token "${token}" (valid for 15 minutes).`,
    ].join('\n');
  }
  requireChecked('Emptying the transfer folder');
  const pend = pendingTransferClears.get(confirm_token);
  if (!pend || pend.expires < Date.now()) throw new UserError('That confirm_token is unknown or has expired. Call tresorit_clear_transfer without a token to get a fresh preview, and ask the user again.');
  if (pend.key !== keyOf()) throw new UserError('The transfer folder no longer matches the list that was previewed for this token. Get a new preview and ask the user again.');
  pendingTransferClears.delete(confirm_token);
  const asked = await askInDialog(`Tresorit connector: remove ${chosen.length} item(s) (${fmtSize(bytes)}) from the transfer folder for good?\nThey are copies outside Tresorit. The originals in Tresorit are not touched.`, 'Yes, remove these copies', 'Remove copies');
  if (asked === 'unanswered') throw new UserError('The confirmation dialog was not answered, so nothing was removed.');
  if (asked === 'no') { log('REFUSED', 'tresorit_clear_transfer', 'the user declined in the confirmation dialog'); throw new UserError('The user declined in the confirmation dialog. Nothing was removed.'); }
  // The removal itself takes its turn among the changes, also those of other copies of the connector: nothing is
  // being copied out while it runs, and two confirmations at the same moment cannot both act on the same list.
  let removed = 0; const kept = [];
  await oneAtATime(async () => {
    // (the dialog can stay open for minutes, and another copy may have copied files out or cleared the folder meanwhile)
    const nowThere = (await transferItems()).filter((x) => Date.now() - x.mtimeMs >= older_than_hours * 3_600_000).map((x) => `${x.name}|${x.bytes}|${x.files}`).sort().join('\n');
    if (nowThere !== pend.key) { log('REFUSED', 'tresorit_clear_transfer', 'the transfer folder changed after the preview was confirmed; nothing was removed'); throw new UserError('The transfer folder no longer matches the list that was previewed for this token. Nothing was removed. Get a new preview and ask the user again.'); }
    const realBase = fs.realpathSync.native(TRANSFER);
    // The transfer folder must be the connector's own real folder: never a link, and never inside (or around) Tresorit.
    const realRoot = (() => { try { return fs.realpathSync.native(ROOT); } catch { return ROOT; } })();
    if (fs.lstatSync(TRANSFER).isSymbolicLink() || realBase === realRoot || realBase.startsWith(realRoot + path.sep) || realRoot.startsWith(realBase + path.sep)) {
      log('REFUSED', 'tresorit_clear_transfer', 'the transfer folder is a link or overlaps the Tresorit folder; nothing was removed');
      throw new UserError('The transfer folder is not an ordinary folder of the connector (it is a link, or it overlaps the Tresorit folder). Nothing was removed.');
    }
    for (const x of chosen) {
      try {
        // only ever inside the transfer folder itself, and never through a link
        if (path.dirname(x.abs) !== TRANSFER || !fs.realpathSync.native(path.dirname(x.abs)).startsWith(realBase)) throw new Error('outside');
        await fsp.lstat(x.abs); // (already gone counts as not removed by this call)
        await fsp.rm(x.abs, { recursive: true, force: true });
        removed++;
      } catch { kept.push(x.name); }
    }
  }, 'tresorit_clear_transfer', extra && extra.signal);
  log('TRANSFER', `${removed} item(s) removed for good`, `${filesN} file(s), ${fmtSize(bytes)}${kept.length ? `; ${kept.length} could not be removed` : ''}`);
  return `Removed ${removed} item(s) from the transfer folder for good (${filesN} file(s), ${fmtSize(bytes)}). Nothing in Tresorit was touched.${kept.length ? `\nCould not remove: ${kept.join(', ')}` : ''}`;
});

export { transferItems, ageText };
