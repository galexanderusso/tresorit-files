// Splits the single file server/index.js of 1.4.8 into parts, without changing what any line does.
//   node --expose-internals tools/split/split.mjs <original index.js> <server folder to write into>
// Every line of the original goes, unchanged, into exactly one part. What a part needs from another part is
// worked out here (scope.mjs) and written as an import at its top and an export list at its end. The script stops
// with an error if a line is used twice or not at all, if a part would need something from a part loaded after
// it, or if a part would assign to a name that belongs to another part.
import fs from 'node:fs';
import path from 'node:path';
import { topLevel, wordsOf } from './scope.mjs';

const [origFile, outDir] = process.argv.slice(2);
const src = fs.readFileSync(origFile, 'utf8');
const L = src.split('\n'); // L[i] is line i+1
if (L[L.length - 1] !== '') throw new Error('the original must end with a line end');
const LAST = L.length - 1;
const line = (n) => L[n - 1];

// ---- Three lines are changed in form (not in effect), because a name can only be assigned in the part it belongs to
const EDITS = new Map([
  [2916, ['  gateCache = null;', '  forgetChecked();']],
  [3035, ['  closing = true;', '  markClosing();']],
]);
const DROPPED = new Map([[1120, 'let closing = false;']]); // declared in core/setup.js instead (see the text there)

const seg = (from, to) => ({ from, to });
const text = (t) => ({ text: t });
const PARTS = [
  { file: 'core/setup.js',
    head: ['// Set-up and the reading of documents: where the Tresorit folder and the connector\'s own data folder are, the',
      '// access log, the search index, the rules for blocked and "do not index" folders, small helpers, and getText(),',
      '// which every tool uses to read a document (with passwords and text recognition).',
      '// These belong together: every logged change asks for the changed file to be read into the index.'],
    body: [seg(32, 454),
      text('// The state of the background reading. The reading itself is in background.js.\n'),
      seg(459, 460),
      text('// True from the moment the app disconnects: nothing new is begun, and work in the background stops.\nlet closing = false;\nfunction markClosing() { closing = true; }\n\n'),
      seg(2593, 2601)] },
  { file: 'core/background.js',
    head: ['// Background reading: one copy of the connector reads every document once, so that searching inside documents',
      '// is fast afterwards. Goes easy on the battery.'],
    body: [seg(455, 458), seg(461, 692)] },
  { file: 'core/turns.js',
    head: ['// Whose turn it is: the self-check gate (read-only until the self-check has passed on this computer) and the',
      '// queue that lets only one change run at a time, across all running copies of the connector.'],
    body: [seg(1122, 1135),
      text('// After a self-check the result is looked up afresh.\nfunction forgetChecked() { gateCache = null; }\n'),
      seg(1136, 1189)] },
  { file: 'core/changes.js',
    head: ['// How anything in Tresorit is changed: copies are prepared in the staging folder and put in place whole, what is',
      '// deleted or replaced goes to the holding area, and the holding area clears itself after the set number of days.'],
    body: [seg(693, 1094)] },
  { file: 'core/server.js',
    head: ['// The server that Claude talks to: the instructions it sends, how a tool is registered (tool()), and how the',
      '// connector stops when the app disconnects.'],
    body: [seg(1095, 1119), seg(1121, 1121), seg(1190, 1217), seg(3026, 3039)] },
  { file: 'tools/browse.js', head: ['// Tools: tresorit_list_folder, tresorit_find_files.'], body: [seg(1218, 1308)] },
  { file: 'tools/search.js', head: ['// Tool: tresorit_search_contents.'], body: [seg(1309, 1484)] },
  { file: 'tools/read.js', head: ['// Tools: tresorit_read_file, tresorit_file_info, tresorit_recent_files.'], body: [seg(1485, 1620)] },
  { file: 'tools/write.js', head: ['// Tools: tresorit_write_file, tresorit_edit_file, tresorit_create_folder.'], body: [seg(1621, 1724)] },
  { file: 'tools/move-copy.js', head: ['// Tools: tresorit_move_item, tresorit_copy_item.'], body: [seg(1725, 1811)] },
  { file: 'tools/delete.js',
    head: ['// Tools: tresorit_delete_items, tresorit_list_deleted, tresorit_restore_deleted, and the connector\'s own',
      '// confirmation window.'],
    body: [seg(1812, 2068)] },
  { file: 'tools/transfer.js', head: ['// Tools: tresorit_export_to_transfer, tresorit_import_from_transfer.'], body: [seg(2069, 2204)] },
  { file: 'tools/clear-deleted.js', head: ['// Tool: tresorit_clear_deleted.'], body: [seg(2205, 2298)] },
  { file: 'tools/outside.js', head: ['// Tools: tresorit_list_outside_folder, tresorit_import_file, tresorit_export_file.'], body: [seg(2299, 2521)] },
  { file: 'tools/receive.js', head: ['// Tool: tresorit_receive_file.'], body: [seg(2522, 2590)] },
  { file: 'tools/unreadable.js', head: ['// Tools: tresorit_list_unreadable, tresorit_unlock_folder.'], body: [seg(2602, 2728)] },
  { file: 'tools/clear-transfer.js', head: ['// Tool: tresorit_clear_transfer.'], body: [seg(2729, 2811)] },
  { file: 'tools/identical.js', head: ['// Tool: tresorit_find_identical.'], body: [seg(2812, 2903)] },
  { file: 'tools/status.js', head: ['// Tools: tresorit_preflight, tresorit_connector_status, tresorit_access_log.'], body: [seg(2591, 2592), seg(2904, 3022)] },
  { file: 'index.js', head: [], body: [seg(3023, 3025), seg(3040, LAST)] },
];
const HEADER = [1, 4];   // "#!" line and the opening comment: stay at the top of index.js
const IMPORTS = [5, 31]; // the import lines: written anew for each part
const INDEX_NOTE = ['// This file starts the connector. The work is in core/ (shared parts) and tools/ (the tools), loaded below in a',
  '// fixed order: the libraries first, then the parts. A part may use the parts loaded before it, never one loaded',
  '// after it. Do not sort or reorder these lines.'];

const GLOBALS = new Set(['Array', 'Boolean', 'Buffer', 'Date', 'Error', 'Infinity', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'RegExp', 'Set', 'String',
  'clearTimeout', 'console', 'process', 'setImmediate', 'setInterval', 'setTimeout', 'undefined']);

// ---- Every line exactly once
const used = new Array(LAST + 2).fill(0);
for (let n = HEADER[0]; n <= HEADER[1]; n++) used[n]++;
for (let n = IMPORTS[0]; n <= IMPORTS[1]; n++) used[n]++;
for (const [n, t] of DROPPED) { if (line(n) !== t) throw new Error(`line ${n} is not as expected`); used[n]++; }
for (const p of PARTS) for (const s of p.body) if (!s.text) for (let n = s.from; n <= s.to; n++) used[n]++;
for (let n = 1; n <= LAST; n++) if (used[n] !== 1) throw new Error(`line ${n} is used ${used[n]} time(s): ${line(n).slice(0, 60)}`);
for (const [n, [was]] of EDITS) if (line(n) !== was) throw new Error(`line ${n} is not as expected`);

// ---- The original as a whole: its names, its imports, and no statement cut in two
const orig = topLevel(src);
const cuts = new Set();
for (const p of PARTS) for (const s of p.body) if (!s.text) { cuts.add(s.from); cuts.add(s.to + 1); }
for (const it of orig.items) for (const c of cuts) if (c > it.from && c <= it.to) throw new Error(`a cut at line ${c} falls inside the statement of lines ${it.from}-${it.to}`);
const libOf = new Map(); // local name -> { source, kind, imported }
const libOrder = [];
for (const it of orig.items) {
  if (it.type !== 'ImportDeclaration') continue;
  libOrder.push(it.source);
  for (const sp of it.specifiers) libOf.set(sp.local, { source: it.source, kind: sp.kind, imported: sp.imported });
}

// ---- Each part: its text, what it declares, what it uses
const bodyOf = (p) => p.body.map((s) => (s.text ? s.text : Array.from({ length: s.to - s.from + 1 }, (_, i) => { const n = s.from + i; return (EDITS.has(n) ? EDITS.get(n)[1] : line(n)) + '\n'; }).join(''))).join('');
const owner = new Map(); // name -> index of the part that declares it
PARTS.forEach((p, i) => {
  p.text = bodyOf(p);
  p.top = topLevel(p.text);
  if (p.top.topAwait.length && p.file !== 'index.js') throw new Error(`${p.file} waits at its top level`);
  for (const n of p.top.names) { if (owner.has(n)) throw new Error(`${n} is declared twice`); owner.set(n, i); }
});
for (const n of orig.names) if (!owner.has(n) && !libOf.has(n)) throw new Error(`${n} is declared nowhere after the split`);

PARTS.forEach((p, i) => {
  p.needs = new Map();   // part index -> names
  p.libs = new Map();    // source -> names
  p.exports = new Set();
  for (const it of p.top.items) {
    for (const [name, u] of it.uses) {
      if (p.top.names.has(name)) continue;
      if (u.write) throw new Error(`${p.file} assigns to "${name}", which belongs to another part (line ${u.lines.join(', ')} of the part)`);
      if (owner.has(name)) {
        const j = owner.get(name);
        if (j > i) throw new Error(`${p.file} uses "${name}" from ${PARTS[j].file}, which is loaded after it`);
        if (!p.needs.has(j)) p.needs.set(j, new Set());
        p.needs.get(j).add(name);
      } else if (libOf.has(name)) {
        const { source } = libOf.get(name);
        if (!p.libs.has(source)) p.libs.set(source, new Set());
        p.libs.get(source).add(name);
      } else if (!GLOBALS.has(name)) throw new Error(`${p.file} uses "${name}", which is declared nowhere`);
    }
  }
});
PARTS.forEach((p) => { for (const [j, names] of p.needs) for (const n of names) PARTS[j].exports.add(n); });

// ---- Writing
const wrap = (open, names, close) => {
  const one = `${open}${names.join(', ')}${close}`;
  if (one.length <= 116) return one;
  const lines = []; let cur = ' ';
  for (const n of names) { if ((cur + ' ' + n + ',').length > 114) { lines.push(cur); cur = ' '; } cur += ` ${n},`; }
  lines.push(cur);
  return `${open.trimEnd()}\n${lines.join('\n')}\n${close.trimStart()}`;
};
const relTo = (fromFile, target) => { let r = path.posix.relative(path.posix.dirname(fromFile), target); if (!r.startsWith('.')) r = `./${r}`; return r; };
const libPath = (fromFile, source) => (source.startsWith('./') ? relTo(fromFile, source.slice(2)) : source);
const libLine = (p, source) => {
  const names = [...p.libs.get(source)];
  const def = names.filter((n) => libOf.get(n).kind === 'ImportDefaultSpecifier');
  const named = names.filter((n) => libOf.get(n).kind === 'ImportSpecifier').sort((a, b) => src.indexOf(a) - src.indexOf(b));
  if (def.length + named.length !== names.length) throw new Error(`import form of ${source}`);
  const target = libPath(p.file, source);
  if (def.length && !named.length) return `import ${def[0]} from '${target}';`;
  if (def.length) throw new Error(`mixed import of ${source}`);
  return wrap('import { ', named, ` } from '${target}';`);
};
const order = (p, names) => [...names].sort((a, b) => p.text.indexOf(a) - p.text.indexOf(b));
const declOrder = (p, names) => { const all = [...p.top.names]; return [...names].sort((a, b) => all.indexOf(a) - all.indexOf(b)); };

const written = [];
PARTS.forEach((p, i) => {
  const out = [];
  const isIndex = p.file === 'index.js';
  if (isIndex) {
    for (let n = HEADER[0]; n <= HEADER[1]; n++) out.push(line(n));
    out.push(...INDEX_NOTE);
    // The libraries first, in the order the single file loaded them, so that nothing about loading changes.
    for (const source of libOrder) {
      if (source.startsWith('node:')) { if (p.libs.has(source)) out.push(libLine(p, source)); continue; }
      out.push(p.libs.has(source) ? libLine(p, source) : `import '${libPath(p.file, source)}';`);
    }
    PARTS.slice(0, i).forEach((q, j) => {
      out.push(p.needs.has(j) ? wrap('import { ', declOrder(q, p.needs.get(j)), ` } from '${relTo(p.file, q.file)}';`) : `import '${relTo(p.file, q.file)}';`);
    });
  } else {
    out.push(...p.head);
    for (const source of libOrder) if (p.libs.has(source)) out.push(libLine(p, source));
    for (const [j, names] of [...p.needs].sort((a, b) => a[0] - b[0])) out.push(wrap('import { ', declOrder(PARTS[j], names), ` } from '${relTo(p.file, PARTS[j].file)}';`));
  }
  out.push('');
  let body = p.text;
  if (!body.endsWith('\n')) body += '\n';
  let whole = out.join('\n') + '\n' + body;
  if (p.exports.size) whole += (whole.endsWith('\n\n') ? '' : '\n') + wrap('export { ', declOrder(p, p.exports), ' };') + '\n';
  whole = whole.replace(/\n{3,}$/, '\n\n').replace(/\n\n$/, '\n');
  const dest = path.join(outDir, p.file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, whole);
  written.push({ file: p.file, lines: whole.split('\n').length - 1, exports: p.exports.size, needs: [...p.needs.keys()].map((j) => PARTS[j].file.replace(/^.*\//, '').replace('.js', '')) });
});

// ---- Report
for (const w of written) console.log(`${w.file.padEnd(24)} ${String(w.lines).padStart(4)} lines; gives ${String(w.exports).padStart(2)} name(s); uses: ${w.needs.join(', ') || '(libraries only)'}`);

// Safety net: any word in a part that is a top-level name of the original but is neither declared nor imported there.
// (Expected: only names that a function uses for something of its own, or that are keys of an object.)
console.log('\nwords to review (a local name or a key that happens to equal a top-level name):');
PARTS.forEach((p, i) => {
  const have = new Set([...p.top.names]);
  for (const names of p.needs.values()) for (const n of names) have.add(n);
  for (const names of p.libs.values()) for (const n of names) have.add(n);
  const odd = [...wordsOf(p.text)].filter((w) => (orig.names.has(w)) && !have.has(w));
  if (odd.length) console.log(`  ${p.file}: ${odd.join(', ')}`);
});

// The order in which things happen at loading: statements that are not function declarations, by original line.
console.log('\nstatements that now run earlier or later than a neighbour, compared with the single file:');
const seq = [];
PARTS.forEach((p) => {
  for (const s of p.body) {
    if (s.text) continue;
    for (const it of orig.items) if (it.from >= s.from && it.to <= s.to && it.type !== 'FunctionDeclaration' && it.type !== 'ImportDeclaration') seq.push({ file: p.file, from: it.from, what: src.slice(it.start, it.end).split('\n')[0].slice(0, 70) });
  }
});
let high = 0;
for (const s of seq) { if (s.from < high) console.log(`  ${s.file}: original line ${s.from} now runs after line ${high}: ${s.what}`); else high = s.from; }
