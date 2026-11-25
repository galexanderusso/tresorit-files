// Tool: tresorit_find_identical.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UserError, isJunkName } from '../lib/paths.js';
import { TextIndex } from '../lib/textindex.js';
import { sha256File } from '../lib/outside.js';
import {
  ROOT, DATA, log, R, outside, isNoIndexRel, cloudOnly, sleep, fmtSize, fmtDate, show, walk,
} from '../core/setup.js';
import { tool, RO } from '../core/server.js';

// ---- tresorit_find_identical ----------------------------------------------------------------------------------------
// Fingerprints (SHA-256 of the content) are remembered per file, with its size and date, so a second run only
// reads what is new or changed. Only fingerprints are kept, never content.
const PRINTS_FILE = path.join(DATA, 'index', 'fingerprints.json');
let prints = null;
function loadPrints() {
  if (prints) return prints;
  prints = new Map();
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(PRINTS_FILE, 'utf8')))) prints.set(k, v); } catch { /* none yet */ }
  return prints;
}
function savePrints() {
  if (!prints) return;
  try {
    // other copies of the connector keep fingerprints in the same file: theirs are kept, never overwritten
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(PRINTS_FILE, 'utf8')))) if (!prints.has(k)) prints.set(k, v); } catch { /* none yet */ }
    const tmp = `${PRINTS_FILE}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(prints))); fs.renameSync(tmp, PRINTS_FILE);
  } catch { /* worked out again next time */ }
}
async function printOf(abs, rel, st) {
  if (rel == null || isNoIndexRel(rel)) return sha256File(abs); // nothing is kept about "do not index" folders, not even a fingerprint
  const map = loadPrints(); const k = TextIndex.key(rel); const c = map.get(k);
  if (c && c.s === st.size && c.m === st.mtimeMs) return c.h;
  const h = await sha256File(abs);
  map.set(k, { s: st.size, m: st.mtimeMs, h });
  return h;
}
const IDENTICAL_LIMIT_MS = Number(process.env.TRESORIT_IDENTICAL_LIMIT_MS) || 40_000;

tool('tresorit_find_identical', {
  title: 'Find files with identical content',
  description: 'Find files that have exactly the same content (same fingerprint), whatever their names: inside a folder or across all of Tresorit. With file, it answers instead "is there already a file with this content here?" for one given file, which may be in Tresorit or elsewhere on this Mac (for example ~/Downloads/report.pdf; only its fingerprint is taken, its content is not shown). Reports only: nothing is changed or deleted. Folders set as "do not index" are left out unless path is inside one. A large folder is compared in stages: the reply says if more remains, and calling again continues where it stopped.',
  inputSchema: {
    path: z.string().default('').describe('Folder to look in; "" for all of Tresorit'),
    file: z.string().optional().describe('Look for copies of this one file (a Tresorit path, or a full path on this Mac such as ~/Downloads/x.pdf)'),
    min_size_kb: z.number().min(0).max(10_000_000).default(0).describe('Ignore files smaller than this'),
    limit: z.number().int().min(1).max(500).default(50).describe('Maximum number of groups listed'),
  },
  annotations: RO,
}, async ({ path: p, file, min_size_kb, limit }) => {
  const base = p ? R.resolve(p, { mustExist: true }) : { abs: ROOT, rel: '' };
  const insideNoIndex = base.rel && (isNoIndexRel(base.rel) || isNoIndexRel(`${base.rel}/x`));
  const started = Date.now();
  const bySize = new Map(); let seen = 0; let skippedOnline = 0;
  for await (const f of walk(base.abs)) {
    if (f.isDir || isJunkName(f.name)) continue;
    if (!insideNoIndex && isNoIndexRel(f.rel)) continue;
    let st; try { st = await fsp.stat(f.abs); } catch { continue; }
    if (!st.isFile() || st.size === 0 || st.size < min_size_kb * 1024) continue;
    if (cloudOnly(st)) { skippedOnline++; continue; }
    seen++;
    if (!bySize.has(st.size)) bySize.set(st.size, []);
    bySize.get(st.size).push({ abs: f.abs, rel: f.rel, st });
    if (seen % 2000 === 0) await sleep(1);
  }
  const where = base.rel ? base.rel : 'all of Tresorit';
  try {
    if (file) {
      // one given file: where is its content already?
      let srcAbs; let srcShown;
      if (/^(~|\/)/.test(file)) { const o = outside.resolve(file); srcAbs = o.abs; srcShown = o.abs; } else { const r = R.resolve(file, { mustExist: true }); srcAbs = r.abs; srcShown = r.rel; }
      const sst = await fsp.stat(srcAbs);
      if (!sst.isFile()) throw new UserError('Give a file, not a folder.');
      const mine = await sha256File(srcAbs);
      const same = [];
      for (const c of bySize.get(sst.size) || []) { if (c.abs === srcAbs) continue; if ((await printOf(c.abs, c.rel, c.st)) === mine) same.push(c); }
      log('IDENTICAL', where, `looked for copies of ${srcShown}: ${same.length} found`);
      return same.length
        ? [`${same.length} file(s) in ${where} have exactly the same content as ${show(srcShown)} (${fmtSize(sst.size)}):`, ...same.slice(0, limit).map((c) => `- ${show(c.rel)}   ${fmtDate(c.st.mtimeMs)}`)].join('\n')
        : `No file in ${where} has the same content as ${show(srcShown)} (${seen} file(s) looked at).`;
    }
    const groups = []; let left = 0; let compared = 0;
    const candidates = [...bySize.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[0] * b[1].length - a[0] * a[1].length);
    for (const [size, list] of candidates) {
      if (Date.now() - started > IDENTICAL_LIMIT_MS) { left++; continue; }
      const byPrint = new Map();
      for (const c of list) { let h; try { h = await printOf(c.abs, c.rel, c.st); } catch { continue; } compared++; if (!byPrint.has(h)) byPrint.set(h, []); byPrint.get(h).push(c); }
      for (const g of byPrint.values()) if (g.length > 1) groups.push({ size, files: g });
    }
    groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
    const extra = groups.reduce((n, g) => n + g.size * (g.files.length - 1), 0);
    log('IDENTICAL', where, `${groups.length} group(s) of identical files among ${seen} file(s)${left ? `; ${left} size group(s) not compared yet` : ''}`);
    const lines = [`${groups.length} group(s) of identical files in ${where} (${seen} file(s) looked at, ${compared} compared by fingerprint). The extra copies take ${fmtSize(extra)}.`];
    for (const g of groups.slice(0, limit)) { lines.push('', `${g.files.length} identical file(s) of ${fmtSize(g.size)} each:`); for (const c of g.files.slice(0, 20)) lines.push(`- ${show(c.rel)}   ${fmtDate(c.st.mtimeMs)}`); if (g.files.length > 20) lines.push(`  ...and ${g.files.length - 20} more.`); }
    if (groups.length > limit) lines.push('', `...and ${groups.length - limit} more group(s). Raise limit or narrow path.`);
    if (left) lines.push('', `Not finished: ${left} more set(s) of same-sized files have not been compared yet. Call tresorit_find_identical again with the same arguments to continue (what was compared is remembered).`);
    if (skippedOnline) lines.push(`${skippedOnline} online-only file(s) were not compared (they are not downloaded to this Mac).`);
    lines.push('', 'Nothing was changed. Deleting any of these needs the user\'s permission through tresorit_delete_items.');
    return lines.join('\n');
  } finally { savePrints(); }
});
