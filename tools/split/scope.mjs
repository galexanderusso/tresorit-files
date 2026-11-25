// Reads a JavaScript module and tells, for each top-level statement, which names it declares and which names
// from outside itself it uses. Used to split server/index.js into parts without losing a reference.
// Run with:  node --expose-internals <script>   (the parser that ships inside Node is used; nothing is installed)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const acorn = require('internal/deps/acorn/acorn/dist/acorn');

export function parse(src) {
  return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
}

// Names bound by a pattern (the left side of a declaration, a parameter, a catch variable).
export function patternNames(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p.name); break;
    case 'ObjectPattern': for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, out); break;
    case 'ArrayPattern': for (const q of p.elements) patternNames(q, out); break;
    case 'RestElement': patternNames(p.argument, out); break;
    case 'AssignmentPattern': patternNames(p.left, out); break;
    default: throw new Error(`pattern ${p.type}`);
  }
  return out;
}

// Names a statement list declares at its own level (let, const, class, function). "var" is refused: the file has none.
function declaredIn(stmts) {
  const names = [];
  for (const s of stmts) {
    const d = (s.type === 'ExportNamedDeclaration' && s.declaration) ? s.declaration : s;
    if (d.type === 'VariableDeclaration') { if (d.kind === 'var') throw new Error(`var at line ${d.loc.start.line}`); for (const v of d.declarations) patternNames(v.id, names); }
    else if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') names.push(d.id.name);
    else if (d.type === 'ImportDeclaration') for (const sp of d.specifiers) names.push(sp.local.name);
  }
  return names;
}

// Walks one node. scopes: array of Sets of local names (innermost last). use(name, node, isWrite) is called for every
// identifier that is not found in a local scope, that is: a name of the module's top level or a global.
export function walk(node, scopes, use, state = { topAwait: [] , fn: 0 }) {
  if (!node || typeof node.type !== 'string') return;
  const sub = (n, sc = scopes) => walk(n, sc, use, state);
  const each = (list, sc = scopes) => { for (const n of list) if (n) sub(n, sc); };
  const ref = (id, write = false) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(id.name)) return; use(id.name, id, write); };
  // the expressions hidden inside a binding pattern: default values and computed keys
  const patExprs = (p, sc) => {
    if (!p) return;
    if (p.type === 'ObjectPattern') for (const q of p.properties) { if (q.type === 'RestElement') patExprs(q.argument, sc); else { if (q.computed) sub(q.key, sc); patExprs(q.value, sc); } }
    else if (p.type === 'ArrayPattern') for (const q of p.elements) patExprs(q, sc);
    else if (p.type === 'RestElement') patExprs(p.argument, sc);
    else if (p.type === 'AssignmentPattern') { patExprs(p.left, sc); sub(p.right, sc); }
  };
  // the left side of an assignment: every identifier in it is written
  const target = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') ref(p, true);
    else if (p.type === 'ObjectPattern') for (const q of p.properties) { if (q.type === 'RestElement') target(q.argument); else { if (q.computed) sub(q.key); target(q.value); } }
    else if (p.type === 'ArrayPattern') for (const q of p.elements) target(q);
    else if (p.type === 'RestElement') target(p.argument);
    else if (p.type === 'AssignmentPattern') { target(p.left); sub(p.right); }
    else sub(p);
  };
  const fnLike = (n) => {
    const mine = new Set();
    if (n.type === 'FunctionExpression' && n.id) mine.add(n.id.name);
    for (const p of n.params) for (const nm of patternNames(p)) mine.add(nm);
    if (n.body.type === 'BlockStatement') for (const nm of declaredIn(n.body.body)) mine.add(nm);
    const sc = [...scopes, mine];
    state.fn++;
    for (const p of n.params) patExprs(p, sc);
    if (n.body.type === 'BlockStatement') each(n.body.body, sc); else sub(n.body, sc);
    state.fn--;
  };
  switch (node.type) {
    case 'Identifier': ref(node); return;
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': fnLike(node); return;
    case 'ClassDeclaration': case 'ClassExpression': {
      const sc = (node.type === 'ClassExpression' && node.id) ? [...scopes, new Set([node.id.name])] : scopes;
      if (node.superClass) sub(node.superClass, sc);
      for (const m of node.body.body) {
        if (m.type === 'StaticBlock') { each(m.body, [...sc, new Set(declaredIn(m.body))]); continue; }
        if (m.computed) sub(m.key, sc);
        if (m.value) sub(m.value, sc);
      }
      return;
    }
    case 'BlockStatement': each(node.body, [...scopes, new Set(declaredIn(node.body))]); return;
    case 'SwitchStatement': {
      sub(node.discriminant);
      const sc = [...scopes, new Set(declaredIn(node.cases.flatMap((c) => c.consequent)))];
      for (const c of node.cases) { if (c.test) sub(c.test, sc); each(c.consequent, sc); }
      return;
    }
    case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
      const head = node.type === 'ForStatement' ? node.init : node.left;
      const sc = (head && head.type === 'VariableDeclaration') ? [...scopes, new Set(declaredIn([head]))] : scopes;
      if (node.type === 'ForOfStatement' && node.await && state.fn === 0) state.topAwait.push(node.loc.start.line);
      if (head) { if (head.type === 'VariableDeclaration') sub(head, sc); else if (node.type === 'ForStatement') sub(head, sc); else walkTarget(head, sc); }
      if (node.type === 'ForStatement') { if (node.test) sub(node.test, sc); if (node.update) sub(node.update, sc); } else sub(node.right, sc);
      sub(node.body, sc);
      return;
    }
    case 'CatchClause': {
      const sc = [...scopes, new Set([...patternNames(node.param), ...declaredIn(node.body.body)])];
      patExprs(node.param, sc); each(node.body.body, sc);
      return;
    }
    case 'VariableDeclaration': for (const v of node.declarations) { patExprs(v.id, scopes); if (v.init) sub(v.init); } return;
    case 'AssignmentExpression': target(node.left); if (node.operator !== '=' && node.left.type === 'Identifier') ref(node.left); sub(node.right); return;
    case 'UpdateExpression': if (node.argument.type === 'Identifier') { ref(node.argument, true); ref(node.argument); } else sub(node.argument); return;
    case 'MemberExpression': sub(node.object); if (node.computed) sub(node.property); return;
    case 'Property': if (node.computed) sub(node.key); sub(node.value); return;
    case 'LabeledStatement': sub(node.body); return;
    case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': return;
    case 'AwaitExpression': if (state.fn === 0) state.topAwait.push(node.loc.start.line); sub(node.argument); return;
    case 'ImportDeclaration': return;
    case 'ExportNamedDeclaration': if (node.declaration) sub(node.declaration); return;
    case 'ImportExpression': sub(node.source); return;
    default:
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (Array.isArray(v)) each(v); else if (v && typeof v.type === 'string') sub(v);
      }
  }
  function walkTarget(p, sc) { const keep = scopes; scopes = sc; target(p); scopes = keep; }
}

// The top level of a module: one entry per statement.
export function topLevel(src) {
  const ast = parse(src);
  const names = new Set(declaredIn(ast.body));
  const items = [];
  const topAwait = [];
  for (const s of ast.body) {
    const uses = new Map(); // name -> { write: bool }
    const state = { topAwait: [], fn: 0 };
    walk(s, [], (name, id, write) => { const u = uses.get(name) || { write: false, lines: [] }; if (write) { u.write = true; u.lines.push(id.loc.start.line); } uses.set(name, u); }, state);
    topAwait.push(...state.topAwait);
    const d = (s.type === 'ExportNamedDeclaration' && s.declaration) ? s.declaration : s;
    items.push({
      type: s.type, kind: d.kind || '', from: s.loc.start.line, to: s.loc.end.line, start: s.start, end: s.end,
      declares: declaredIn([s]), uses, source: s.type === 'ImportDeclaration' ? s.source.value : '',
      specifiers: s.type === 'ImportDeclaration' ? s.specifiers.map((sp) => ({ local: sp.local.name, kind: sp.type, imported: sp.imported ? sp.imported.name : '' })) : [],
    });
  }
  return { ast, names, items, topAwait };
}

// Every word in the text that could be a use of a name: a safety net that cannot miss one (it can only over-report).
export function wordsOf(src) {
  const out = new Set();
  const tok = acorn.tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  let prev = null;
  for (const t of tok) {
    if (t.type.label === 'name' && !(prev && (prev.type.label === '.' || prev.type.label === '?.'))) out.add(t.value);
    prev = t;
  }
  return out;
}
