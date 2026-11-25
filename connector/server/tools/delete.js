// Tools: tresorit_delete_items, tresorit_list_deleted, tresorit_restore_deleted, and the connector's own
// confirmation window.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { UserError } from '../lib/paths.js';
import { HOLD, log, R, outside, blockedUnder, nameList, fmtSize, show } from '../core/setup.js';
import { requireChecked, oneAtATime } from '../core/turns.js';
import {
  newBatch, absent, moveRobust, heldPath, saveManifest, holdItem, readBatches, HOLDING_DAYS, setAside,
  undoOrExplain, measure, forgetIndexed, requireDepth,
} from '../core/changes.js';
import { server, tool, RO, RW } from '../core/server.js';

// ---- tresorit_delete_items --------------------------------------------------------------------------------------
// ---- The connector's own confirmation window -----------------------------------------------------------------------
// Not every part of the Claude app shows a confirmation box when a connector asks for one. Where it does not, the
// connector opens a window of its own on this Mac before anything is deleted or removed for good, so that the
// user's yes never rests on the conversation alone. Only a click on the action button counts: a window that is
// closed, left unanswered or that cannot be shown means nothing is done.
const CONFIRM_CMD = (() => { try { return process.env.TRESORIT_CONFIRM_CMD ? JSON.parse(process.env.TRESORIT_CONFIRM_CMD) : null; } catch { return null; } })();
const OWN_WINDOW = Boolean(CONFIRM_CMD) || process.platform === 'darwin';
function askOnMac(message, keepButton, okButton) {
  return new Promise((resolve) => {
    let cmd; let args;
    if (CONFIRM_CMD) { cmd = CONFIRM_CMD[0]; args = [...CONFIRM_CMD.slice(1), message, keepButton, okButton]; } // used by the tests and the self-check
    else if (process.platform === 'darwin') {
      cmd = '/usr/bin/osascript';
      args = ['-e', 'on run argv', '-e', 'tell me to activate',
        '-e', 'set r to display dialog (item 1 of argv) with title "Tresorit Files" buttons {item 2 of argv, item 3 of argv} default button 1 with icon caution giving up after 120',
        '-e', 'if gave up of r then return "GAVE-UP"', '-e', 'return button returned of r', '-e', 'end run', message, keepButton, okButton];
    } else { resolve('unsupported'); return; }
    execFile(cmd, args, { timeout: 140_000, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) { resolve('unanswered'); return; } // closed, or the window could not be shown
      const out = String(stdout).replace(/\r?\n$/, '');
      resolve(out === okButton ? 'yes' : out === keepButton ? 'no' : 'unanswered');
    });
  });
}
// How the user is asked on this computer, for the status report.
const confirmHow = () => {
  const caps = server.server.getClientCapabilities?.();
  if (caps && caps.elicitation) return 'in a confirmation box of the Claude app';
  return OWN_WINDOW ? 'in a window of the connector on this Mac (this part of the Claude app shows no box of its own)' : 'in the conversation only (no confirmation window is available on this computer)';
};

// ---- Before a whole folder is copied out of Tresorit --------------------------------------------------------------
// A copy outside Tresorit is not encrypted by it. A single file is copied out when asked. A whole folder is copied
// out only after the user has said yes directly: in a box of the Claude app where the app shows one, otherwise in
// the connector's own window on this Mac. There "Do not copy" is the first button and the default, and a window
// that is closed, left unanswered or that cannot be shown copies nothing. On a computer where no window exists at
// all, the copy is made as before.
// folders: [{ rel, files, bytes }]. where: "Downloads", "Desktop" or "the transfer folder".
// Returns how it was approved (for the access log), or '' when there was no folder to ask about.
async function confirmCopyOut(folders, where) {
  if (!folders.length) return '';
  const one = folders.length === 1;
  const size = (f) => `${f.files} file(s), ${fmtSize(f.bytes)}`;
  const body = one
    ? `Copy the folder "${show(folders[0].rel)}" out of Tresorit?\n\n${size(folders[0])}, to ${where}.\n\nClaude has asked the connector to copy it. The copy is outside Tresorit and is not encrypted by it.`
    : `Copy ${folders.length} folders out of Tresorit?\n\n${folders.slice(0, 12).map((f) => `- "${show(f.rel)}" (${size(f)})`).join('\n')}${folders.length > 12 ? `\n...and ${folders.length - 12} more` : ''}\n\nTo ${where}.\n\nClaude has asked the connector to copy them. The copies are outside Tresorit and are not encrypted by it.`;
  const names = folders.map((f) => f.rel).join('; ');
  const caps = server.server.getClientCapabilities?.();
  if (caps && caps.elicitation) {
    let answer;
    try {
      answer = await server.server.elicitInput({
        message: `Tresorit connector: ${body.charAt(0).toLowerCase()}${body.slice(1)}`,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: one ? 'Yes, copy this folder out' : 'Yes, copy these folders out', default: false } }, required: ['confirm'] },
      }, { timeout: ELICIT_TIMEOUT_MS });
    } catch (e) {
      log('EXP-NO', names, `the confirmation dialog gave no answer (${String((e && e.message) || e).slice(0, 80)})`);
      throw new UserError('The confirmation dialog was not answered, so nothing was copied out. To try again, ask the user and call again.');
    }
    if (!answer || answer.action !== 'accept' || !answer.content || answer.content.confirm !== true) {
      log('EXP-NO', names, 'the user declined in the confirmation dialog');
      throw new UserError('The user declined the copy in the confirmation dialog. Nothing was copied out.');
    }
    return 'approved in a confirmation box of the Claude app';
  }
  const answer = await askOnMac(body, 'Do not copy', 'Copy out');
  if (answer === 'unanswered') {
    log('EXP-NO', names, 'the connector\'s confirmation window was closed, not answered or could not be shown');
    throw new UserError('The confirmation window on the Mac was not answered (or could not be shown), so nothing was copied out. To try again, ask the user and call again.');
  }
  if (answer === 'no') {
    log('EXP-NO', names, 'the user chose "Do not copy" in the connector\'s confirmation window');
    throw new UserError('The user chose "Do not copy" in the confirmation window on the Mac. Nothing was copied out.');
  }
  return answer === 'yes' ? 'approved in the connector\'s window on this Mac' : 'no confirmation window was available';
}

const pendingDeletes = new Map();
const TOKEN_TTL_MS = Number(process.env.TRESORIT_TOKEN_TTL_MS) || 15 * 60 * 1000;
// Two minutes, like the connector's own window: less than the five minutes after which a change that waits its turn
// gives up, so a change asked for behind an unanswered box is delayed and never refused for that reason.
const ELICIT_TIMEOUT_MS = Number(process.env.TRESORIT_ELICIT_TIMEOUT_MS) || 2 * 60 * 1000;

tool('tresorit_delete_items', {
  title: 'Delete (needs the user\'s permission)',
  description: 'Delete files or folders from Tresorit. THE USER MUST APPROVE EVERY DELETION. Step 1: call with paths only; nothing is deleted and you get a preview and a confirm_token. Step 2: show the user the preview, ask for their permission, and only after an explicit yes call again with the same paths and the confirm_token. Deleted items are moved to a holding area on this Mac and can be brought back with tresorit_restore_deleted.',
  inputSchema: {
    paths: z.array(z.string()).min(1).max(200),
    confirm_token: z.string().optional().describe('The token from the preview step. Only pass it after the user has said yes to this exact list.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ paths, confirm_token }) => {
  requireChecked('Deleting');
  let targets = [];
  for (const p of paths) {
    const t = R.resolve(p, { mustExist: true });
    requireDepth(t.rel, 'Deleting a tresor itself');
    const guarded = await blockedUnder(t.abs, t.rel);
    if (guarded.length) throw new UserError(`"${t.rel}" cannot be deleted through the connector: it contains a blocked folder (${nameList(guarded)}), which the connector never changes (set in the connector's settings). Nothing was deleted. Delete the other items in it one by one, or delete the folder in Finder.`);
    if (!targets.some((x) => x.abs === t.abs)) targets.push(t);
  }
  // An item inside a folder that is also on the list goes with that folder.
  targets = targets.filter((t) => !targets.some((o) => o !== t && t.abs.startsWith(o.abs + path.sep)));
  const keyOf = () => targets.map((t) => t.rel).sort().join('\n');
  for (const [tok, v] of pendingDeletes) if (v.expires < Date.now()) pendingDeletes.delete(tok);

  if (!confirm_token) {
    const lines = [];
    let files = 0; let bytes = 0;
    for (const t of targets) {
      const m = await measure(t.abs);
      files += m.files; bytes += m.bytes;
      lines.push(m.type === 'folder'
        ? `- [FOLDER] ${show(t.rel)}/   (${m.files} file(s) in ${m.folders} subfolder(s), ${fmtSize(m.bytes)})`
        : `- [FILE]   ${show(t.rel)}   (${fmtSize(m.bytes)})`);
    }
    const token = crypto.randomBytes(4).toString('hex');
    pendingDeletes.set(token, { key: keyOf(), expires: Date.now() + TOKEN_TTL_MS });
    log('DEL-ASK', targets.map((t) => t.rel).join('; '), `preview only: ${files} file(s), ${fmtSize(bytes)}`);
    return [
      'NOTHING HAS BEEN DELETED. This is a preview.',
      `Would delete ${targets.length} item(s), ${files} file(s), ${fmtSize(bytes)} in total:`,
      ...lines,
      '',
      `Show this list to the user and ask for permission. Only after an explicit yes, call tresorit_delete_items again with the same paths and confirm_token "${token}" (valid for 15 minutes). The user is then asked once more in a window on their Mac, which lists the items: tell them to expect it. Nothing is deleted unless they click Delete there.`,
    ].join('\n');
  }

  const pend = pendingDeletes.get(confirm_token);
  if (!pend || pend.expires < Date.now()) throw new UserError('That confirm_token is unknown or has expired. Call tresorit_delete_items without a token to get a fresh preview, and ask the user again.');
  if (pend.key !== keyOf()) throw new UserError('The paths do not match the list that was previewed for this token. Get a new preview and ask the user again.');
  pendingDeletes.delete(confirm_token);
  let approved = 'no confirmation window was available';

  // Where the app supports it, also ask the user directly in a dialog of their own. Only an explicit yes counts:
  // a dialog that is closed, declined, left unanswered or that fails for any reason means nothing is deleted.
  const caps = server.server.getClientCapabilities?.();
  if (caps && caps.elicitation) {
    let answer;
    try {
      answer = await server.server.elicitInput({
        message: `Tresorit connector: delete ${targets.length} item(s)?\n${targets.slice(0, 12).map((t) => '- ' + show(t.rel)).join('\n')}${targets.length > 12 ? `\n...and ${targets.length - 12} more` : ''}\n\nThey are moved to the holding folder on this Mac and can be restored.`,
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Yes, delete these items', default: false } }, required: ['confirm'] },
      }, { timeout: ELICIT_TIMEOUT_MS });
    } catch (e) {
      log('DEL-NO', targets.map((t) => t.rel).join('; '), `the confirmation dialog gave no answer (${String((e && e.message) || e).slice(0, 80)})`);
      throw new UserError('The confirmation dialog was not answered, so nothing was deleted. To try again, get a new preview and ask the user.');
    }
    if (!answer || answer.action !== 'accept' || !answer.content || answer.content.confirm !== true) {
      log('DEL-NO', targets.map((t) => t.rel).join('; '), 'the user declined in the confirmation dialog');
      throw new UserError('The user declined the deletion in the confirmation dialog. Nothing was deleted.');
    }
    approved = 'approved in a confirmation box of the Claude app';
  } else {
    const what = `Delete ${targets.length} item(s) from Tresorit?\n\n${targets.slice(0, 12).map((t) => '- ' + show(t.rel)).join('\n')}${targets.length > 12 ? `\n...and ${targets.length - 12} more` : ''}\n\nClaude has asked the connector to delete them. They are moved to the holding folder on this Mac and can be restored.`;
    const answer = await askOnMac(what, 'Keep', 'Delete');
    if (answer === 'unanswered') {
      log('DEL-NO', targets.map((t) => t.rel).join('; '), 'the connector\'s confirmation window was closed, not answered or could not be shown');
      throw new UserError('The confirmation window on the Mac was not answered (or could not be shown), so nothing was deleted. To try again, get a new preview and ask the user.');
    }
    if (answer === 'no') {
      log('DEL-NO', targets.map((t) => t.rel).join('; '), 'the user chose Keep in the connector\'s confirmation window');
      throw new UserError('The user chose "Keep" in the confirmation window on the Mac. Nothing was deleted.');
    }
    if (answer === 'yes') approved = 'approved in the connector\'s window on this Mac';
  }

  const done = [];
  const failed = [];
  const batch = await oneAtATime(async () => {
    const b = await newBatch('deleted');
    for (const t of targets) {
      try {
        await holdItem(b, t.abs, t.rel, 'move');
        done.push(t.rel);
        log('DELETE', t.rel, `moved to holding area, batch ${b.name}; ${approved}`);
      } catch (e) {
        failed.push(`${t.rel}: ${e.message}`);
        log('ERROR', 'tresorit_delete_items', `${t.rel}: ${e.message}`);
      }
    }
    if (!done.length) await fsp.rm(b.dir, { recursive: true, force: true });
    for (const r of done) forgetIndexed(r);
    return b;
  }, 'tresorit_delete_items');
  return [
    done.length
      ? `Deleted ${done.length} item(s) from Tresorit. They are in the holding area as batch ${batch.name} and can be brought back with tresorit_restore_deleted.`
      : 'Nothing was deleted.',
    ...done.map((r) => `- ${show(r)}`),
    ...(failed.length ? ['', 'Could not delete:', ...failed.map((f) => `- ${f}`)] : []),
    ...(done.length ? ['', `Holding folder on this Mac: ${batch.dir}  (empty it in Finder to remove the items for good)`] : []),
  ].join('\n');
});

// ---- tresorit_list_deleted / tresorit_restore_deleted -----------------------------------------------------------
tool('tresorit_list_deleted', {
  title: 'List the holding area',
  description: 'Show what is in the holding area: items deleted through this connector and previous versions of files that were replaced or edited. Anything here can be restored with tresorit_restore_deleted. A batch with many items shows its first few and says how many more there are; give its name in batch to see all of them.',
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(30),
    batch: z.string().optional().describe('Show only this batch, with every item in it'),
    items_per_batch: z.number().int().min(1).max(2000).default(10).describe('How many items to show for each batch when listing several'),
  },
  annotations: RO,
}, async ({ limit, batch, items_per_batch: perBatch }) => {
  const batches = await readBatches();
  if (batch !== undefined) {
    if (!/^[\w.-]+$/.test(batch) || batch.startsWith('.')) throw new UserError('Invalid batch name.');
    const one = batches.find((x) => x.name === batch);
    if (!one) throw new UserError(`No batch named "${batch}" in the holding area. Use tresorit_list_deleted without a batch name to see them.`);
    log('HELD', one.name, `${one.items.length} item(s) listed`);
    one.size = await measure(path.join(one.dir, 'files')).catch(() => null);
    const cap = 2000;
    return [`${one.name}   ${one.kind}   ${one.when}${one.size ? `   ${fmtSize(one.size.bytes)}` : ''}   ${one.items.length} item(s):`,
      ...one.items.slice(0, cap).map((i) => `   - [${i.type}] ${show(String(i.original))}${i.outside ? '   (the original of an item moved into Tresorit; restoring puts it back on the Mac)' : ''}`),
      ...(one.items.length > cap ? [`   ...and ${one.items.length - cap} more item(s).`] : []),
      '', 'Restore the whole batch, or one item by its path, with tresorit_restore_deleted.'].join('\n');
  }
  log('HELD', `${batches.length} batch(es)`);
  if (!batches.length) return 'The holding area is empty.';
  const total = await measure(HOLD).catch(() => null);
  const shown = batches.slice(0, limit);
  for (const b of shown) b.size = await measure(path.join(b.dir, 'files')).catch(() => null);
  return [`${batches.length} batch(es) in the holding area (${HOLD})${total ? `, ${fmtSize(total.bytes)} in total` : ''}; the oldest is from ${batches[batches.length - 1].when}. Newest first:`,
    ...shown.map((b) => [`${b.name}   ${b.kind}   ${b.when}${b.size ? `   ${fmtSize(b.size.bytes)}` : ''}${b.items.length > 1 ? `   ${b.items.length} item(s)` : ''}`,
      ...b.items.slice(0, perBatch).map((i) => `   - [${i.type}] ${show(String(i.original))}${i.outside ? '   (the original of an item moved into Tresorit; restoring puts it back on the Mac)' : ''}`),
      ...(b.items.length > perBatch ? [`   ...and ${b.items.length - perBatch} more item(s) in this batch (call again with batch "${b.name}" to see them all).`] : [])].join('\n')),
    ...(batches.length > shown.length ? [`...and ${batches.length - shown.length} older batch(es).`] : []),
    '', HOLDING_DAYS ? `Batches older than ${HOLDING_DAYS} day(s) are removed for good automatically (connector settings). Anything can be removed sooner with tresorit_clear_deleted (the user must approve).` : 'Automatic clearing is switched off in the settings. Old batches can be removed for good with tresorit_clear_deleted (the user must approve).'].join('\n');
});

tool('tresorit_restore_deleted', {
  title: 'Restore from the holding area',
  description: 'Put back items from a holding-area batch (see tresorit_list_deleted) to where they were in Tresorit. Restores the whole batch, or one item if item is given. If something now exists at the original place it is only replaced when overwrite is true (and is then itself kept in the holding area).',
  inputSchema: {
    batch: z.string().describe('Batch name from tresorit_list_deleted'),
    item: z.string().optional().describe('Original path of a single item to restore'),
    overwrite: z.boolean().default(false),
  },
  annotations: RW,
}, async ({ batch, item, overwrite }) => {
  requireChecked('Restoring');
  if (!/^[\w.-]+$/.test(batch) || batch.startsWith('.')) throw new UserError('Invalid batch name.');
  const b = (await readBatches()).find((x) => x.name === batch);
  if (!b) throw new UserError(`No batch named "${batch}" in the holding area. Use tresorit_list_deleted.`);
  const chosen = item ? b.items.filter((i) => i.original === item) : b.items;
  if (!chosen.length) throw new UserError(`"${item}" is not in batch ${batch}.`);
  const out = [];
  const remaining = [...b.items];
  const filesRoot = path.join(b.dir, 'files');
  for (const it of chosen) {
    if (it.outside) {
      // The original of an item that was moved into Tresorit: it goes back to its old place on the Mac.
      try {
        if (typeof it.original !== 'string' || !path.isAbsolute(it.original)) throw new UserError('damaged record');
        const held = path.join(filesRoot, '_outside', path.basename(it.original));
        if (!held.startsWith(path.join(filesRoot, '_outside') + path.sep)) throw new UserError('damaged record (path outside the batch)');
        await fsp.lstat(held);
        let parent;
        try { parent = fs.realpathSync.native(path.dirname(it.original)); } catch { throw new UserError(`the folder it came from no longer exists (${path.dirname(it.original)})`); }
        const target = path.join(parent, path.basename(it.original));
        const why = outside.protectedReason(target);
        if (why) throw new UserError(`its old place cannot be written to: ${why}`);
        if (!(await absent(target))) throw new UserError('something exists at its old place now; nothing outside Tresorit is ever overwritten');
        await moveRobust(held, target);
        remaining.splice(remaining.indexOf(it), 1);
        out.push(`- ${it.original}: put back on the Mac`);
        log('RESTORE', it.original, `original put back from batch ${batch}`);
      } catch (e) { out.push(`- ${it.original}: not restored, ${e.message}`); }
      continue;
    }
    let d;
    let src;
    try {
      if (typeof it.original !== 'string') throw new UserError('damaged record');
      src = path.normalize(heldPath(b.dir, it.original));
      if (!src.startsWith(filesRoot + path.sep)) throw new UserError('damaged record (path outside the batch)');
      d = R.resolve(it.original);
      requireDepth(d.rel, 'Restoring to the top level');
    } catch (e) { out.push(`- ${it.original}: ${e.message}`); continue; }
    try {
      await fsp.lstat(src);
      let aside = null;
      if (d.exists) {
        if (!overwrite) { out.push(`- ${it.original}: not restored, something exists there now (set overwrite to true to replace it)`); continue; }
        aside = await setAside(d.abs, d.rel, 'move');
      }
      try {
        await fsp.mkdir(path.dirname(d.abs), { recursive: true });
        await moveRobust(src, d.abs);
      } catch (e) { throw aside ? await undoOrExplain(aside, d.rel, e) : e; }
      remaining.splice(remaining.indexOf(it), 1);
      out.push(`- ${it.original}: restored${aside ? ` (what was there is kept in batch ${aside.name})` : ''}`);
      log('RESTORE', it.original, `from batch ${batch}`);
    } catch (e) {
      out.push(`- ${it.original}: failed, ${e.message}`);
    }
  }
  if (!remaining.length) await fsp.rm(b.dir, { recursive: true, force: true });
  else await saveManifest({ dir: b.dir, kind: b.kind, when: b.when, items: remaining });
  return [`Restore from batch ${batch}:`, ...out].join('\n');
});

export { askOnMac, confirmHow, confirmCopyOut, TOKEN_TTL_MS, ELICIT_TIMEOUT_MS };
