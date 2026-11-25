// Tool: tresorit_receive_file.
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { UserError, requireUsableNames } from '../lib/paths.js';
import { log, R, fmtSize } from '../core/setup.js';
import { requireChecked } from '../core/turns.js';
import { requireDepth } from '../core/changes.js';
import { tool, RW } from '../core/server.js';
import { decodeBase64, sha256Of, saveBytes } from './write.js';

// ---- tresorit_receive_file ---------------------------------------------------------------------------------------
// A document made in the conversation arrives here as text, in parts. Each part and the whole file carry a
// fingerprint, so a part altered on the way is noticed at once and only that part is sent again.
const RECEIVE_LIMIT = 3 * 1024 * 1024;
const RECEIVE_TTL_MS = 30 * 60 * 1000;
const RECEIVE_MAX_FILES = 4;                  // files being received at the same time
const RECEIVE_MAX_BYTES = 8 * 1024 * 1024;    // held in memory for all of them together
const receiving = new Map();
// Unfinished files are given up, oldest first, when there are too many or they hold too much memory.
function trimReceiving(keep) {
  const total = () => [...receiving.values()].reduce((n, v) => n + v.bytes, 0);
  while (receiving.size > RECEIVE_MAX_FILES || total() > RECEIVE_MAX_BYTES) {
    let oldest = null;
    for (const [k, v] of receiving) if (k !== keep && (!oldest || v.touched < receiving.get(oldest).touched)) oldest = k;
    if (!oldest) break;
    receiving.delete(oldest);
  }
}

tool('tresorit_receive_file', {
  title: 'Save a small document made in the chat (in parts, checked)',
  description: 'Save a small binary document that was created in the conversation (for example a .docx, .pdf or .xlsx) into Tresorit, without the user having to download it. The file is sent as base64 text in numbered parts, in order, with the SHA-256 fingerprint of each part (of the decoded bytes) and, on the last part, of the whole file. A part that does not match its fingerprint is refused and must be sent again; nothing is saved until every part has arrived and the whole file matches. Keep each part to about 8,000 base64 characters. Meant for files up to roughly 50 KB (limit 3 MB): for anything larger, give the file to the user to download and bring it in with tresorit_import_file. Plain text files do not need this: use tresorit_write_file.',
  inputSchema: {
    path: z.string().describe('Where to save, relative to the Tresorit folder, including the file name'),
    part: z.number().int().min(1).max(600).describe('Number of this part, starting at 1'),
    parts: z.number().int().min(1).max(600).describe('Total number of parts'),
    data: z.string().max(90000).describe('This part of the file, as base64'),
    part_sha256: z.string().regex(/^\s*[0-9a-fA-F]{64}\s*$/).describe('SHA-256 (hex) of the decoded bytes of this part'),
    file_sha256: z.string().regex(/^\s*[0-9a-fA-F]{64}\s*$/).optional().describe('SHA-256 (hex) of the whole file; required with the last part'),
    overwrite: z.boolean().default(false),
  },
  annotations: RW,
}, async ({ path: p, part, parts, data, part_sha256, file_sha256, overwrite }) => {
  requireChecked('Saving files');
  const t = R.resolve(p);
  requireDepth(t.rel, 'Writing a file');
  requireUsableNames(t);
  if (part > parts) throw new UserError(`Part ${part} is beyond the total of ${parts}.`);
  for (const [k, v] of receiving) if (Date.now() - v.touched > RECEIVE_TTL_MS) receiving.delete(k);
  if (t.exists) {
    const st = await fsp.stat(t.abs);
    if (st.isDirectory()) throw new UserError(`"${t.rel}" is a folder.`);
    if (!overwrite) throw new UserError(`"${t.rel}" already exists. Choose another name, or set overwrite to true to replace it (the old version is kept).`);
  }
  let job = receiving.get(t.abs);
  if (part === 1) { job = { parts, chunks: [], bytes: 0, touched: Date.now() }; receiving.set(t.abs, job); }
  if (!job) throw new UserError(`No file is being received for "${t.rel}" (the connector may have restarted, more than 30 minutes passed, or too many other files were started in the meantime). Start again from part 1.`);
  if (job.parts !== parts) throw new UserError(`This file was started as ${job.parts} part(s), not ${parts}. Start again from part 1.`);
  if (part !== job.chunks.length + 1) throw new UserError(`Expected part ${job.chunks.length + 1} of ${parts}, got part ${part}. Send part ${job.chunks.length + 1}.`);
  const bytes = decodeBase64(data);
  if (sha256Of(bytes) !== part_sha256.trim().toLowerCase()) {
    job.touched = Date.now();
    log('RECV-BAD', t.rel, `part ${part} of ${parts} did not match its fingerprint`);
    throw new UserError(`Part ${part} did not arrive intact (its fingerprint does not match). Nothing was lost: send part ${part} again.`);
  }
  if (job.bytes + bytes.length > RECEIVE_LIMIT) { receiving.delete(t.abs); throw new UserError(`The file is larger than ${fmtSize(RECEIVE_LIMIT)}. Give it to the user to download and bring it in with tresorit_import_file instead.`); }
  job.chunks.push(bytes); job.bytes += bytes.length; job.touched = Date.now();
  trimReceiving(t.abs);
  if (part < parts) return `Part ${part} of ${parts} received and checked (${fmtSize(job.bytes)} so far). Send part ${part + 1}.`;
  if (!file_sha256) { job.chunks.pop(); job.bytes -= bytes.length; throw new UserError('The last part must come with file_sha256, the fingerprint of the whole file. Send the last part again with it.'); }
  const whole = Buffer.concat(job.chunks);
  receiving.delete(t.abs);
  if (sha256Of(whole) !== file_sha256.trim().toLowerCase()) {
    log('RECV-BAD', t.rel, 'the assembled file did not match its fingerprint; nothing saved');
    throw new UserError('All parts arrived, but the assembled file does not match the fingerprint of the whole file. Nothing was saved. Start again from part 1.');
  }
  const saved = await saveBytes(t, whole, overwrite);
  return `${saved} Received in ${parts} part(s) and verified against its fingerprint.`;
});
