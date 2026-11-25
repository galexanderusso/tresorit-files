// Tools: tresorit_move_item, tresorit_copy_item.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UserError, requireUsableNames } from '../lib/paths.js';
import { log, R, blockedUnder, notBlocked, nameList, refuseLanding, noIndexNote, fmtSize } from '../core/setup.js';
import { requireChecked } from '../core/turns.js';
import {
  copyFresh, placeNew, moveRobust, setAside, undoOrExplain, measure, forgetIndexed, requireDepth,
} from '../core/changes.js';
import { tool, RW } from '../core/server.js';

// ---- tresorit_move_item / tresorit_copy_item --------------------------------------------------------------------
const COPY_LIMIT = 5 * 1024 * 1024 * 1024;

async function planTransfer(source, destination, overwrite, verb) {
  const s = R.resolve(source, { mustExist: true });
  requireDepth(s.rel, `${verb} a tresor itself`);
  let d = R.resolve(destination);
  if (d.exists && d.abs !== s.abs) {
    const dst = await fsp.stat(d.abs);
    if (dst.isDirectory()) d = R.resolve(path.posix.join(d.rel, path.basename(s.abs)));
  }
  requireDepth(d.rel, `${verb} to the top level`);
  requireUsableNames(d);
  if (d.abs === s.abs) {
    // On a Mac "report.pdf" and "Report.pdf" are the same file, so a rename that only changes capitals lands here.
    const wanted = path.basename(String(destination).trim().replace(/\/+$/, ''));
    const current = path.basename(s.abs);
    if (verb === 'Moving' && wanted && wanted !== current && wanted.toLowerCase() === current.toLowerCase()) {
      const abs = path.join(path.dirname(s.abs), wanted);
      return { s, d: { abs, rel: R.toRel(abs), exists: false }, aside: null };
    }
    throw new UserError('Source and destination are the same.');
  }
  if (d.abs.startsWith(s.abs + path.sep)) throw new UserError('A folder cannot be placed inside itself.');
  if (d.exists && !overwrite) throw new UserError(`"${d.rel}" already exists. Choose another name, or set overwrite to true to replace it (the old one is kept in the holding area).`);
  if (d.exists && s.abs.startsWith(d.abs + path.sep)) throw new UserError('The destination contains the source, so it cannot be replaced by it.');
  // Blocked folders inside the source. A move would take them along to a place where they are no longer blocked,
  // so it is refused; a copy is made without them (see tresorit_copy_item).
  const leftOut = await blockedUnder(s.abs, s.rel);
  if (leftOut.length && verb === 'Moving') throw new UserError(`"${s.rel}" cannot be moved or renamed through the connector: it contains a blocked folder (${nameList(leftOut)}), and moving it would take that folder out of the protection set in the connector's settings. Move the other items in it one by one, or move the folder in Finder and correct the setting.`);
  if (d.exists) {
    const guarded = await blockedUnder(d.abs, d.rel);
    if (guarded.length) throw new UserError(`"${d.rel}" cannot be replaced: it contains a blocked folder (${nameList(guarded)}), which the connector never changes (set in the connector's settings).`);
  }
  await refuseLanding(s.abs, d.rel);
  return { s, d, aside: null, leftOut, noIndex: await noIndexNote(s.abs, s.rel, d.rel) };
}

// Runs a copy or move into plan.d. What was at the destination (when replacing) is first kept in the holding area
// and is put back if the operation fails. Half-made copies are removed by copyFresh itself.
async function carryOut(plan, action) {
  const { d } = plan;
  if (d.exists) plan.aside = await setAside(d.abs, d.rel, 'move');
  try {
    await fsp.mkdir(path.dirname(d.abs), { recursive: true });
    await action();
  } catch (e) {
    if (plan.aside && !e.keepDestination) {
      const aside = plan.aside;
      plan.aside = null;
      throw await undoOrExplain(aside, d.rel, e);
    }
    throw e;
  }
}

tool('tresorit_move_item', {
  title: 'Move or rename',
  description: 'Move or rename a file or folder within Tresorit. If destination is an existing folder the item is moved into it; otherwise destination is the new full path. Nothing is overwritten unless overwrite is true. A folder that has a blocked folder inside it cannot be moved or renamed.',
  inputSchema: { source: z.string(), destination: z.string(), overwrite: z.boolean().default(false) },
  annotations: RW,
}, async ({ source, destination, overwrite }) => {
  requireChecked('Moving or renaming');
  const plan = await planTransfer(source, destination, overwrite, 'Moving');
  const { s, d } = plan;
  await carryOut(plan, () => moveRobust(s.abs, d.abs));
  forgetIndexed(s.rel);
  log('MOVE', s.rel, `to ${d.rel}${plan.aside ? ` (replaced item kept in ${plan.aside.name})` : ''}${plan.noIndex ? '; taken out of a "do not index" folder' : ''}`);
  return `Moved ${s.rel}  ->  ${d.rel}${plan.aside ? `\nThe item that was at the destination is kept in the holding area, batch ${plan.aside.name}.` : ''}${plan.noIndex ? `\n${plan.noIndex}` : ''}`;
});

tool('tresorit_copy_item', {
  title: 'Copy',
  description: 'Copy a file or folder within Tresorit, for example to assemble a pack for a third party. If destination is an existing folder the copy goes into it; otherwise destination is the full path of the copy. A blocked folder inside the copied folder is left out, and the reply says so.',
  inputSchema: { source: z.string(), destination: z.string(), overwrite: z.boolean().default(false) },
  annotations: RW,
}, async ({ source, destination, overwrite }) => {
  requireChecked('Copying');
  const plan = await planTransfer(source, destination, overwrite, 'Copying');
  const { s, d } = plan;
  const size = await measure(s.abs);
  if (size.bytes > COPY_LIMIT) throw new UserError(`That is ${fmtSize(size.bytes)}; one copy is limited to ${fmtSize(COPY_LIMIT)}. Copy it in parts, or copy it in Finder.`);
  await placeNew(plan, (at) => copyFresh(s.abs, at, { mode: fs.constants.COPYFILE_FICLONE, filter: notBlocked }));
  const without = plan.leftOut.length ? `Left out of the copy: ${plan.leftOut.length} blocked folder(s) inside it (${nameList(plan.leftOut)}). Blocked folders are never read or copied (set in the connector's settings).` : '';
  log('COPY', s.rel, `to ${d.rel} (${size.files} file(s), ${fmtSize(size.bytes)})${plan.aside ? ` (replaced item kept in ${plan.aside.name})` : ''}${without ? `; ${plan.leftOut.length} blocked folder(s) inside it left out` : ''}${plan.noIndex ? '; includes material from a "do not index" folder' : ''}`);
  return `Copied ${s.rel}  ->  ${d.rel}   (${size.files} file(s), ${fmtSize(size.bytes)})${plan.aside ? `\nThe item that was at the destination is kept in the holding area, batch ${plan.aside.name}.` : ''}${without ? `\n${without}` : ''}${plan.noIndex ? `\n${plan.noIndex}` : ''}`;
});

export { carryOut };
