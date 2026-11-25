// Tool: tresorit_clear_deleted.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../lib/paths.js';
import { HOLD, log, fmtSize, show } from '../core/setup.js';
import { requireChecked, oneAtATime } from '../core/turns.js';
import { readBatches, hideBatch, batchMade, measure } from '../core/changes.js';
import { server, tool } from '../core/server.js';
import { askOnMac, TOKEN_TTL_MS, ELICIT_TIMEOUT_MS } from './delete.js';

// ---- tresorit_clear_deleted -------------------------------------------------------------------------------------
// Asks the user directly, in a dialog of their own, where the app supports it. Only an explicit yes counts.
async function askInDialog(message, label, okButton) {
  const caps = server.server.getClientCapabilities?.();
  if (!caps || !caps.elicitation) return askOnMac(message.replace(/^Tresorit connector: r/, 'R'), 'Keep', okButton); // the connector's own window
  let answer;
  try {
    answer = await server.server.elicitInput({
      message,
      requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: label, default: false } }, required: ['confirm'] },
    }, { timeout: ELICIT_TIMEOUT_MS });
  } catch { return 'unanswered'; }
  return answer && answer.action === 'accept' && answer.content && answer.content.confirm === true ? 'yes' : 'no';
}

const pendingClears = new Map();

tool('tresorit_clear_deleted', {
  title: 'Empty old batches from the holding area (needs the user\'s permission)',
  description: 'Remove batches from the holding area FOR GOOD, sooner than they would go by themselves: after this they cannot be restored. (Batches older than the number of days in the settings, 30 by default, are removed automatically without this tool.) THE USER MUST APPROVE. Step 1: call with older_than_days (or with batch names); nothing is removed and you get a preview with sizes and a confirm_token. Step 2: show the user the preview, and only after an explicit yes call again with the same arguments and the confirm_token. Nothing in Tresorit itself is touched.',
  inputSchema: {
    older_than_days: z.number().min(0).max(3650).default(30).describe('Remove batches older than this many days'),
    batches: z.array(z.string()).max(500).optional().describe('Instead of an age: the exact batch names to remove'),
    confirm_token: z.string().optional().describe('The token from the preview step. Only pass it after the user has said yes.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ older_than_days, batches, confirm_token }) => {
  requireChecked('Emptying the holding area');
  const all = await readBatches();
  let chosen;
  if (batches && batches.length) {
    chosen = [];
    for (const n of batches) {
      const b = all.find((x) => x.name === n);
      if (!b) throw new UserError(`No batch named "${n}" in the holding area. Use tresorit_list_deleted.`);
      if (!chosen.includes(b)) chosen.push(b);
    }
  } else {
    const cutoff = Date.now() - older_than_days * 86_400_000;
    chosen = [];
    for (const b of all) {
      const made = await batchMade(b);
      if (made !== null && made <= cutoff) chosen.push(b);
    }
  }
  if (!chosen.length) return batches && batches.length ? 'Nothing to remove.' : `No batch in the holding area is older than ${older_than_days} day(s). Nothing to remove.`;
  const keyOf = () => chosen.map((b) => b.name).sort().join('\n');
  for (const [tok, v] of pendingClears) if (v.expires < Date.now()) pendingClears.delete(tok);

  if (!confirm_token) {
    let bytes = 0; let files = 0;
    const lines = [];
    for (const b of chosen) {
      const m = await measure(path.join(b.dir, 'files')).catch(() => ({ files: 0, bytes: 0 }));
      bytes += m.bytes; files += m.files;
      if (lines.length < 40) lines.push(`- ${b.name}   ${b.kind}   ${b.when}   ${m.files} file(s), ${fmtSize(m.bytes)}${b.items[0] ? `   e.g. ${show(String(b.items[0].original))}` : ''}`);
    }
    const token = crypto.randomBytes(4).toString('hex');
    pendingClears.set(token, { key: keyOf(), expires: Date.now() + TOKEN_TTL_MS });
    log('PURGE-ASK', `${chosen.length} batch(es)`, `preview only: ${files} file(s), ${fmtSize(bytes)}`);
    return [
      'NOTHING HAS BEEN REMOVED. This is a preview.',
      `Would remove for good ${chosen.length} of ${all.length} batch(es) from the holding area: ${files} file(s), ${fmtSize(bytes)}. They could no longer be restored.`,
      ...lines,
      ...(chosen.length > lines.length ? [`...and ${chosen.length - lines.length} more.`] : []),
      '',
      `Show this to the user and ask for permission. Only after an explicit yes, call tresorit_clear_deleted again with the same arguments and confirm_token "${token}" (valid for 15 minutes).`,
    ].join('\n');
  }

  const pend = pendingClears.get(confirm_token);
  if (!pend || pend.expires < Date.now()) throw new UserError('That confirm_token is unknown or has expired. Call tresorit_clear_deleted without a token to get a fresh preview, and ask the user again.');
  if (pend.key !== keyOf()) throw new UserError('The batches no longer match the list that was previewed for this token. Get a new preview and ask the user again.');
  pendingClears.delete(confirm_token);
  const asked = await askInDialog(`Tresorit connector: remove ${chosen.length} batch(es) from the holding area for good?\nThey are deleted or replaced items, and originals of files moved into Tresorit, kept as a safety net. After this they cannot be restored.`, 'Yes, remove them for good', 'Remove for good');
  if (asked === 'unanswered') throw new UserError('The confirmation dialog was not answered, so nothing was removed.');
  if (asked === 'no') throw new UserError('The user declined in the confirmation dialog. Nothing was removed.');
  let done = 0; let bytes = 0; const failed = [];
  await oneAtATime(async () => {
    for (const b of chosen) {
      // A batch is a folder directly inside the holding area, and nothing else is ever removed here.
      if (path.dirname(b.dir) !== HOLD || !/^[\w.-]+$/.test(b.name) || b.name.startsWith('.')) { failed.push(`${b.name}: not a batch`); continue; }
      try {
        const m = await measure(b.dir).catch(() => ({ bytes: 0 }));
        const gone = await hideBatch(b.dir);
        log('PURGE', b.name, `removed from the holding area for good (${b.items.length} item(s))`);
        done++; bytes += m.bytes;
        await fsp.rm(gone, { recursive: true, force: true }).catch(() => { /* finished at the next start */ });
      } catch (e) { failed.push(`${b.name}: ${e.message}`); }
    }
  }, 'tresorit_clear_deleted');
  return [`Removed ${done} batch(es) from the holding area for good, freeing ${fmtSize(bytes)}.`, ...(failed.length ? ['Could not remove:', ...failed.map((f) => `- ${f}`)] : [])].join('\n');
});

export { askInDialog };
