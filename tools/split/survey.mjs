// Surveys server/index.js before the split:  node --expose-internals tools/split/survey.mjs <path of index.js>
import fs from 'node:fs';
import { topLevel } from './scope.mjs';

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const { names, items, topAwait } = topLevel(src);
const where = new Map(); // name -> item that declares it
for (const it of items) for (const n of it.declares) where.set(n, it);

console.log(`top-level statements: ${items.length}; top-level names: ${names.size}`);
console.log(`top-level await at lines: ${topAwait.join(', ') || 'none'}`);

console.log('\n== names that are assigned again after their declaration (let), and where');
for (const it of items) {
  if (it.kind !== 'let') continue;
  for (const n of it.declares) {
    const sites = [];
    for (const other of items) { const u = other.uses.get(n); if (u && u.write) sites.push(`${other.from}${other.declares[0] ? `(${other.declares[0]})` : ''}@${u.lines.join('/')}`); }
    console.log(`  ${n} [declared ${it.from}]: ${sites.join('  ') || 'never'}`);
  }
}

console.log('\n== statements that are not plain declarations of functions (they do something when the file loads)');
for (const it of items) {
  if (it.type === 'FunctionDeclaration' || it.type === 'ImportDeclaration') continue;
  const text = src.slice(it.start, it.end).split('\n')[0].slice(0, 110);
  console.log(`  ${String(it.from).padStart(4)}-${String(it.to).padEnd(4)} ${it.type === 'VariableDeclaration' ? it.kind : it.type.replace('Statement', '')}: ${text}`);
}

console.log('\n== uses of a name declared further down (statement line -> name@line)');
for (const it of items) {
  const fwd = [];
  for (const n of it.uses.keys()) { const d = where.get(n); if (d && d.from > it.to) fwd.push(`${n}@${d.from}`); }
  if (fwd.length) console.log(`  ${String(it.from).padStart(4)} ${it.declares[0] || it.type}: ${fwd.join(', ')}`);
}

console.log('\n== names used that are neither declared at the top level nor imported (globals expected)');
const globals = new Set();
for (const it of items) for (const n of it.uses.keys()) if (!where.has(n)) globals.add(n);
console.log(`  ${[...globals].sort().join(', ')}`);
