// Checks the layout of connector/server:  node --expose-internals tools/checks/structure.mjs <server folder>
//   - every file in core/ and tools/ is loaded by index.js, and index.js loads nothing that is not there;
//   - a part uses only parts that index.js loads before it;
//   - no part assigns to a name it has from another file (that would stop the connector at that line);
//   - every name a file uses is declared in it, imported into it, or part of Node itself.
// Prints one line per problem and ends with exit code 1 if there is any.
import fs from 'node:fs';
import path from 'node:path';
import { topLevel } from '../split/scope.mjs';

const dir = path.resolve(process.argv[2]);
const problems = [];
const partsOnDisk = ['core', 'tools'].flatMap((d) => fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`)).sort();
const read = (rel) => topLevel(fs.readFileSync(path.join(dir, rel), 'utf8'));
const importsOf = (top) => top.items.filter((it) => it.type === 'ImportDeclaration');

const indexTop = read('index.js');
const order = importsOf(indexTop).map((it) => it.source).filter((s) => /^\.\/(core|tools)\//.test(s)).map((s) => s.slice(2));
for (const p of partsOnDisk) if (!order.includes(p)) problems.push(`${p} is not loaded by index.js`);
for (const p of order) if (!partsOnDisk.includes(p)) problems.push(`index.js loads ${p}, which does not exist`);
if (new Set(order).size !== order.length) problems.push('index.js loads a part twice');

for (const p of [...order.filter((x) => partsOnDisk.includes(x)), 'index.js']) {
  const top = p === 'index.js' ? indexTop : read(p);
  const mine = p === 'index.js' ? order.length : order.indexOf(p);
  const imported = new Set();
  for (const it of importsOf(top)) {
    for (const sp of it.specifiers) imported.add(sp.local);
    if (!it.source.startsWith('.')) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(p), it.source));
    if (/^(core|tools)\//.test(target)) {
      const at = order.indexOf(target);
      if (at < 0) problems.push(`${p} uses ${target}, which index.js does not load`);
      else if (at >= mine) problems.push(`${p} uses ${target}, which is loaded after it`);
    } else if (!fs.existsSync(path.join(dir, target))) problems.push(`${p} uses ${target}, which does not exist`);
  }
  for (const it of top.items) for (const [name, u] of it.uses) if (u.write && imported.has(name)) problems.push(`${p} assigns to "${name}", which it has from another file`);
  if (top.topAwait.length && p !== 'index.js') problems.push(`${p} waits at its top level (only index.js may)`);
}
// Every name a file uses is declared in it, imported into it, or part of Node itself. (A forgotten import would only
// show when that very line runs.)
const all = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) all(p, out); else if (e.name.endsWith('.js')) out.push(p); } return out; };
for (const file of all(dir)) {
  const rel = path.relative(dir, file);
  if (rel.startsWith('ocr' + path.sep)) continue; // scripts for the Mac's own scripting, not programs for Node
  let top; try { top = topLevel(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push(`${rel} cannot be read as a program: ${e.message}`); continue; }
  const unknown = new Set();
  for (const it of top.items) for (const name of it.uses.keys()) if (!top.names.has(name) && !(name in globalThis) && name !== 'undefined') unknown.add(name);
  if (unknown.size) problems.push(`${rel} uses ${[...unknown].map((n) => `"${n}"`).join(', ')}, declared nowhere in it and not imported`);
}
for (const line of problems) console.log(line);
console.log(problems.length ? `${problems.length} problem(s) in the layout` : `layout in order: ${order.length} parts, loaded in the order of index.js`);
process.exit(problems.length ? 1 : 0);
