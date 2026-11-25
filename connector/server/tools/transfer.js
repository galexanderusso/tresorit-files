// Tools: tresorit_export_to_transfer, tresorit_import_from_transfer.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UserError, isJunkName, requireUsableNames } from '../lib/paths.js';
import { fileStamp } from '../lib/log.js';
import {
  TRANSFER, log, R, blockedUnder, notBlocked, nameList, refuseLanding, fmtSize, indexSoon,
} from '../core/setup.js';
import { requireChecked } from '../core/turns.js';
import { confirmCopyOut } from './delete.js';
import { copyFresh, copyWhole, placeNew, moveRobust, measure, requireDepth } from '../core/changes.js';
import { tool, RW } from '../core/server.js';
import { carryOut } from './move-copy.js';

// ---- transfer folder --------------------------------------------------------------------------------------------
async function freeName(dir, name) {
  const ext = path.extname(name); const stem = name.slice(0, name.length - ext.length);
  let cand = name; let i = 2;
  for (;;) {
    try { await fsp.lstat(path.join(dir, cand)); cand = `${stem} (${i++})${ext}`; } catch { return cand; }
  }
}

function resolveTransfer(name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw new UserError('Give the name of an item in the transfer folder.');
  const abs = path.normalize(path.join(TRANSFER, name));
  if (!abs.startsWith(TRANSFER + path.sep)) throw new UserError('That name is outside the transfer folder.');
  let real;
  try { real = fs.realpathSync.native(abs); } catch { throw new UserError(`"${name}" is not in the transfer folder. Call tresorit_import_from_transfer without a name to see what is there.`); }
  const realBase = fs.realpathSync.native(TRANSFER);
  if (!real.startsWith(realBase + path.sep)) throw new UserError('That item links outside the transfer folder. Refused.');
  return real;
}

tool('tresorit_export_to_transfer', {
  title: 'Copy out to the transfer folder',
  description: 'Copy a file or folder from Tresorit to the connector\'s transfer folder on this Mac (outside Tresorit), so it can be processed with other tools, for example a Word or Excel file that needs editing. The original stays in Tresorit. Returns the full path of the copy. A whole folder is copied out only after the user has agreed in a confirmation window on their Mac; if they decline or do not answer, nothing is copied.',
  inputSchema: {
    path: z.string().optional().describe('One file or folder in Tresorit'),
    paths: z.array(z.string()).min(1).max(100).optional().describe('Several files or folders in one call. They are put together in one new dated folder inside the transfer folder, each under its own Tresorit path, so files with the same name never collide.'),
  },
  annotations: RW,
}, async ({ path: p, paths }) => {
  const many = [...(paths || []), ...(p && paths ? [p] : [])];
  if (many.length) {
    const items = [];
    let total = 0;
    for (const one of [...new Set(many)]) {
      const t = R.resolve(one, { mustExist: true });
      requireDepth(t.rel, 'Exporting a whole tresor');
      const m = await measure(t.abs);
      total += m.bytes;
      if (total > 2 * 1024 * 1024 * 1024) throw new UserError(`Together that is more than 2 GB (${fmtSize(total)} so far); the limit for one export is 2 GB. Nothing was copied.`);
      items.push({ t, m, leftOut: await blockedUnder(t.abs, t.rel), isDir: (await fsp.stat(t.abs)).isDirectory() });
    }
    // A whole folder leaves Tresorit only after the user's yes (one question for all the folders of this call).
    const approved = await confirmCopyOut(items.filter((i) => i.isDir).map((i) => ({ rel: i.t.rel, files: i.m.files, bytes: i.m.bytes })), 'the transfer folder');
    await fsp.mkdir(TRANSFER, { recursive: true });
    const batchName = await freeName(TRANSFER, `${fileStamp()}_export`);
    const batchDir = path.join(TRANSFER, batchName);
    const lines = [];
    for (const { t, m, leftOut, isDir } of items) {
      const dst = path.join(batchDir, ...t.rel.split('/'));
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await copyWhole(t.abs, dst, { filter: notBlocked });
      log('EXPORT', t.rel, `copied out of Tresorit to ${dst} (${m.files} file(s), ${fmtSize(m.bytes)})${leftOut.length ? `; ${leftOut.length} blocked folder(s) inside it left out` : ''}${isDir && approved ? `; ${approved}` : ''}`);
      lines.push(`- ${batchName}/${t.rel}   (${m.files} file(s), ${fmtSize(m.bytes)})${leftOut.length ? `   without ${leftOut.length} blocked folder(s) inside it: ${nameList(leftOut)}` : ''}`);
    }
    return [`Copied ${items.length} item(s) out of Tresorit into one folder:`, batchDir, ...lines, 'Each keeps its Tresorit path inside that folder, so same-named files stay apart. These copies are outside Tresorit and not encrypted by it; remove them with tresorit_clear_transfer when finished.'].join('\n');
  }
  if (!p) throw new UserError('Give path (one item) or paths (several).');
  const t = R.resolve(p, { mustExist: true });
  requireDepth(t.rel, 'Exporting a whole tresor');
  const m = await measure(t.abs);
  if (m.bytes > 2 * 1024 * 1024 * 1024) throw new UserError(`That is ${fmtSize(m.bytes)}; the limit for one export is 2 GB.`);
  const approved = (await fsp.stat(t.abs)).isDirectory() ? await confirmCopyOut([{ rel: t.rel, files: m.files, bytes: m.bytes }], 'the transfer folder') : '';
  await fsp.mkdir(TRANSFER, { recursive: true });
  const name = await freeName(TRANSFER, path.basename(t.abs));
  const dst = path.join(TRANSFER, name);
  const leftOut = await blockedUnder(t.abs, t.rel);
  await copyWhole(t.abs, dst, { filter: notBlocked });
  log('EXPORT', t.rel, `copied out of Tresorit to ${dst} (${m.files} file(s), ${fmtSize(m.bytes)})${leftOut.length ? `; ${leftOut.length} blocked folder(s) inside it left out` : ''}${approved ? `; ${approved}` : ''}`);
  return `Copied ${t.rel} out of Tresorit to:\n${dst}\n(${m.files} file(s), ${fmtSize(m.bytes)}). This copy is outside Tresorit and not encrypted by it; remove it with tresorit_clear_transfer when finished.${leftOut.length ? `\nLeft out of the copy: ${leftOut.length} blocked folder(s) inside it (${nameList(leftOut)}). Blocked folders are never read or copied (set in the connector's settings).` : ''}`;
});

tool('tresorit_import_from_transfer', {
  title: 'Bring in from the transfer folder',
  description: 'Move a file or folder from the connector\'s transfer folder into Tresorit. Call without name to see what is waiting in the transfer folder and where that folder is. If destination is an existing folder the item goes into it; otherwise destination is the full new path.',
  inputSchema: {
    name: z.string().optional().describe('Name of the item inside the transfer folder'),
    names: z.array(z.string()).min(1).max(100).optional().describe('Several items in one call (names or paths inside the transfer folder). destination must then be a folder; each item goes into it under its own name. Nothing is overwritten unless overwrite is true; an item that cannot be brought in is reported and the others still are.'),
    destination: z.string().optional().describe('Where to put it in Tresorit'),
    overwrite: z.boolean().default(false),
    keep_copy: z.boolean().default(false).describe('Leave the item in the transfer folder as well'),
  },
  annotations: RW,
}, async ({ name, names, destination, overwrite, keep_copy }) => {
  await fsp.mkdir(TRANSFER, { recursive: true });
  if (name || names) requireChecked('Bringing files into Tresorit');
  if (names && names.length) {
    if (!destination) throw new UserError('Give a destination folder in Tresorit.');
    const folder = R.resolve(destination);
    requireDepth(path.posix.join(folder.rel, 'x'), 'Importing to the top level');
    requireUsableNames(folder);
    if (folder.exists && !(await fsp.stat(folder.abs)).isDirectory()) throw new UserError(`"${folder.rel}" is a file. With several items the destination must be a folder.`);
    const done = []; const failed = [];
    for (const one of [...new Set([...(name ? [name] : []), ...names])]) {
      try {
        const src = resolveTransfer(one);
        const sst = await fsp.stat(src);
        const d = R.resolve(path.posix.join(folder.rel, path.basename(src)));
        requireUsableNames(d);
        if (d.exists && !overwrite) throw new UserError(`"${d.rel}" already exists`);
        await refuseLanding(src, d.rel);
        const plan = { d, aside: null };
        if (keep_copy) await placeNew(plan, (at) => copyFresh(src, at));
        else await carryOut(plan, () => moveRobust(src, d.abs));
        const m = await measure(d.abs);
        log('IMPORT', d.rel, `${sst.isDirectory() ? 'folder' : 'file'} brought in from the transfer folder (${m.files} file(s), ${fmtSize(m.bytes)})${plan.aside ? `; replaced item kept in ${plan.aside.name}` : ''}`);
        done.push(`- ${d.rel}   (${m.files} file(s), ${fmtSize(m.bytes)})${plan.aside ? `   replaced item kept in ${plan.aside.name}` : ''}`);
        indexSoon(d.rel);
      } catch (e) {
        const why = e instanceof UserError ? e.message : `could not be brought in (${e.code || 'error'})`;
        log('REFUSED', 'tresorit_import_from_transfer', `${one}: ${why}`);
        failed.push(`- ${one}: ${why}`);
      }
    }
    return [`Saved into Tresorit: ${done.length} of ${done.length + failed.length} item(s), in ${folder.rel}/`, ...done, ...(failed.length ? ['', `NOT brought in (${failed.length}); these are still in the transfer folder:`, ...failed] : [])].join('\n');
  }
  if (!name) {
    const ents = (await fsp.readdir(TRANSFER, { withFileTypes: true })).filter((e) => !isJunkName(e.name) && !e.name.startsWith('.'));
    log('TRANSFER', `${ents.length} item(s) waiting`);
    const lines = [];
    for (const e of ents) {
      const m = await measure(path.join(TRANSFER, e.name)).catch(() => null);
      lines.push(`- ${e.isDirectory() ? '[FOLDER]' : '[FILE]  '} ${e.name}${m ? `   (${m.files} file(s), ${fmtSize(m.bytes)})` : ''}`);
    }
    return [`Transfer folder on this Mac: ${TRANSFER}`, ents.length ? `${ents.length} item(s) waiting:` : 'It is empty.', ...lines].join('\n');
  }
  if (!destination) throw new UserError('Give a destination in Tresorit.');
  const src = resolveTransfer(name);
  const sst = await fsp.stat(src);
  let d = R.resolve(destination);
  if (d.exists && (await fsp.stat(d.abs)).isDirectory()) d = R.resolve(path.posix.join(d.rel, path.basename(src)));
  requireDepth(d.rel, 'Importing to the top level');
  requireUsableNames(d);
  if (d.exists && !overwrite) throw new UserError(`"${d.rel}" already exists. Choose another name, or set overwrite to true to replace it (the old one is kept).`);
  await refuseLanding(src, d.rel);
  const plan = { d, aside: null };
  if (keep_copy) await placeNew(plan, (at) => copyFresh(src, at));
  else await carryOut(plan, () => moveRobust(src, d.abs));
  const m = await measure(d.abs);
  log('IMPORT', d.rel, `${sst.isDirectory() ? 'folder' : 'file'} brought in from the transfer folder (${m.files} file(s), ${fmtSize(m.bytes)})${plan.aside ? `; replaced item kept in ${plan.aside.name}` : ''}`);
  return `Saved into Tresorit: ${d.rel}   (${m.files} file(s), ${fmtSize(m.bytes)})${plan.aside ? `\nThe item that was there is kept in the holding area, batch ${plan.aside.name}.` : ''}`;
});

export { freeName };
