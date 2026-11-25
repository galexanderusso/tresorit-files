// Review aid for the old Office reader (server/lib/legacy.js, cfb.js). Runs it over every .doc, .xls, .ppt and .msg
// below a folder and reports: how many were read or refused and why, the slowest file, and the Word files whose
// text ends inside a field that is never closed (cleanWordText hides everything after such a field).
//   node tools/review/old-office-probe.mjs <server/lib folder> <folder with files> <empty work folder>
// It works on a copy of the three files in the work folder; the connector is not changed.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [libDir, root, work] = process.argv.slice(2).map((p) => path.resolve(p));
fs.mkdirSync(work, { recursive: true });
for (const f of ['cfb.js', 'textutil.js']) fs.copyFileSync(path.join(libDir, f), path.join(work, f));
let src = fs.readFileSync(path.join(libDir, 'legacy.js'), 'utf8');
const a = "  return out.replace(/\\t+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();\n}\n\nexport function extractDoc(buf) {";
if (!src.includes(a)) throw new Error('cleanWordText is no longer as this probe expects');
fs.writeFileSync(path.join(work, 'legacy-probe.js'), src.replace(a, "  if (stack.includes(true)) globalThis.__open = (globalThis.__open || 0) + 1;\n" + a));
const L = await import(pathToFileURL(path.join(work, 'legacy-probe.js')).href);
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(doc|xls|ppt|msg)$/i.test(e.name)) files.push(p); } };
walk(root);
const by = {}; const open = []; let slowest = { ms: 0 };
for (const f of files) {
  const ext = path.extname(f).slice(1).toLowerCase();
  by[ext] ??= { files: 0, read: 0, refused: 0, chars: 0, reasons: {} };
  const buf = fs.readFileSync(f); globalThis.__open = 0; const t0 = Date.now();
  try {
    const t = ({ doc: L.extractDoc, xls: L.extractXls, ppt: L.extractPpt, msg: L.extractMsg })[ext](buf);
    by[ext].read++; by[ext].chars += t.length;
    if (globalThis.__open) open.push(`${path.relative(root, f)} (${globalThis.__open} segment(s); ${t.length} characters read)`);
  } catch (e) { by[ext].refused++; const r = String(e.message).slice(0, 60); by[ext].reasons[r] = (by[ext].reasons[r] || 0) + 1; }
  by[ext].files++;
  const ms = Date.now() - t0; if (ms > slowest.ms) slowest = { ms, f: path.relative(root, f), size: buf.length };
}
for (const [ext, v] of Object.entries(by)) console.log(`.${ext}: ${v.files} file(s), ${v.read} read (${v.chars} characters), ${v.refused} refused ${JSON.stringify(v.reasons)}`);
console.log(`Word files whose text ends inside an unclosed field: ${open.length}`);
for (const o of open.slice(0, 50)) console.log(`  ${o}`);
if (slowest.f) console.log(`slowest: ${slowest.f} (${slowest.size} bytes) in ${slowest.ms} ms`);
