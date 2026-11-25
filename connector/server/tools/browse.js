// Tools: tresorit_list_folder, tresorit_find_files.
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { UserError, foldName } from '../lib/paths.js';
import {
  log, R, cloudOnly, extOf, fmtSize, fmtDate, show, parseDate, extSet, walk, statMany,
} from '../core/setup.js';
import { tool, RO } from '../core/server.js';

// ---- tresorit_list_folder ---------------------------------------------------------------------------------------
tool('tresorit_list_folder', {
  title: 'List a Tresorit folder',
  description: 'List what is inside a folder in Tresorit. Use path "" for the top level (the tresors). Set recursive to also list subfolders.',
  inputSchema: {
    path: z.string().default('').describe('Folder path relative to the Tresorit folder; "" for the top level'),
    recursive: z.boolean().default(false).describe('Also list the contents of subfolders'),
    max_depth: z.number().int().min(1).max(8).default(3).describe('How many levels deep to go when recursive'),
    include_hidden: z.boolean().default(false),
    limit: z.number().int().min(1).max(2000).default(400),
  },
  annotations: RO,
}, async ({ path: p, recursive, max_depth, include_hidden, limit }) => {
  const t = R.resolve(p, { mustExist: true });
  const st = await fsp.stat(t.abs);
  if (!st.isDirectory()) throw new UserError(`"${t.rel}" is a file. Use tresorit_read_file or tresorit_file_info.`);
  const items = [];
  let truncated = false;
  for await (const f of walk(t.abs, { maxDepth: recursive ? max_depth : 1, includeHidden: include_hidden })) {
    if (items.length >= limit) { truncated = true; break; }
    items.push(f);
  }
  await statMany(items);
  const base = t.rel ? t.rel + '/' : '';
  const lines = items.map((f) => {
    const shown = show(f.rel.slice(base.length));
    if (f.isDir) return `[DIR]  ${shown}/`;
    if (!f.st) return `[FILE] ${shown}`;
    return `[FILE] ${shown}   ${fmtSize(f.st.size)}   ${fmtDate(f.st.mtimeMs)}${cloudOnly(f.st) ? '   (online only)' : ''}`;
  });
  const nDir = items.filter((f) => f.isDir).length;
  log('LIST', t.rel || '(top level)', `${items.length} item(s)${recursive ? ', recursive' : ''}`);
  return [
    `Folder: ${t.rel || '(Tresorit top level)'}   ${nDir} folder(s), ${items.length - nDir} file(s)${truncated ? `   [showing the first ${limit}; narrow the path or raise limit]` : ''}`,
    ...lines,
  ].join('\n');
});

// ---- tresorit_find_files ----------------------------------------------------------------------------------------
tool('tresorit_find_files', {
  title: 'Find files and folders by name',
  description: 'Search Tresorit by file or folder name. All words in the query must appear somewhere in the path (case and accents ignored); files whose own name contains the words rank first. Filter by extension or modified date. For words inside documents use tresorit_search_contents instead.',
  inputSchema: {
    query: z.string().default('').describe('Words from the name, e.g. "settlement letter 2026"'),
    path: z.string().default('').describe('Folder to search in; "" searches all of Tresorit'),
    extensions: z.array(z.string()).optional().describe('Only these file types, e.g. ["pdf","docx"]'),
    kind: z.enum(['any', 'file', 'folder']).default('any'),
    modified_after: z.string().optional().describe('YYYY-MM-DD'),
    modified_before: z.string().optional().describe('YYYY-MM-DD'),
    limit: z.number().int().min(1).max(500).default(50),
  },
  annotations: RO,
}, async ({ query, path: p, extensions, kind, modified_after, modified_before, limit }) => {
  const t = R.resolve(p, { mustExist: true });
  const exts = extSet(extensions);
  const after = parseDate(modified_after, 'modified_after');
  const before = parseDate(modified_before, 'modified_before');
  const terms = foldName(query).replace(/\*/g, ' ').split(/\s+/).filter(Boolean);
  if (!terms.length && !exts && after == null && before == null) throw new UserError('Give a query, an extension filter or a date filter.');
  const matches = [];
  let scanned = 0;
  for await (const f of walk(t.abs)) {
    scanned++;
    if (kind === 'file' && f.isDir) continue;
    if (kind === 'folder' && !f.isDir) continue;
    if (exts && (f.isDir || !exts.has(extOf(f.name)))) continue;
    const frel = foldName(f.rel);
    if (!terms.every((w) => frel.includes(w))) continue;
    const fname = foldName(f.name);
    f.score = terms.filter((w) => fname.includes(w)).length;
    matches.push(f);
    if (matches.length >= 20000) break;
  }
  matches.sort((a, b) => b.score - a.score);
  const needAll = after != null || before != null;
  const pool = needAll ? matches : matches.slice(0, Math.max(limit * 6, 600));
  await statMany(pool);
  let res = pool.filter((f) => f.st);
  if (after != null) res = res.filter((f) => f.st.mtimeMs >= after);
  if (before != null) res = res.filter((f) => f.st.mtimeMs < before + 86400000);
  res.sort((a, b) => (b.score - a.score) || (b.st.mtimeMs - a.st.mtimeMs));
  const total = needAll ? res.length : matches.length;
  res = res.slice(0, limit);
  log('FIND', query || '(filters only)', `${total} match(es) in ${t.rel || 'all of Tresorit'}`);
  if (!res.length) return `No names matching "${query}" in ${t.rel || 'Tresorit'} (${scanned} items checked). Try fewer words, or tresorit_search_contents to look inside documents.`;
  const lines = res.map((f, i) => (f.isDir
    ? `${i + 1}. [DIR]  ${show(f.rel)}/`
    : `${i + 1}. [FILE] ${show(f.rel)}   ${fmtSize(f.st.size)}   ${fmtDate(f.st.mtimeMs)}`));
  return [`${total} match(es)${total > res.length ? `, showing ${res.length}` : ''}:`, ...lines].join('\n');
});
