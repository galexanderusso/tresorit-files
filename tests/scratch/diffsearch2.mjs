// Runs the same content searches against two versions of the connector and reports any difference in the answers.
import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const ROOT = '/home/tester/build/mock/Tresors';
async function start(server, name, env = {}) {
  const DATA = `/home/tester/build/mock/data-diff-${name}`; fs.rmSync(DATA, { recursive: true, force: true });
  const transport = new StdioClientTransport({ command: 'node', args: [server], env: { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '100', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off', ...env }, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => { const r = await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 300000 }); return r.content.map((c) => c.text || '').join('\n'); };
  for (let i = 0; i < 3000; i++) { await new Promise((r) => setTimeout(r, 300)); if (/up to date as of/.test(await call('connector_status'))) break; }
  return { call, client, DATA };
}
const oldS = await start(process.argv[2], 'old'); const newS = await start(process.argv[3], 'new');
const words = ['needle-zebra-42', 'copper sulphate', 'fundação', 'FUNDACAO', 'clausula', 'cláusula décima', 'unicorn-keyword', 'boson', 'INV-0042', 'orbit', 'the', 'alder works', 'acid mist', 'São Paulo', 'e', 'zz', 'confidential information', 'page 3', '2026', 'naïve café', 'straße', 'ĳ', '日本', 'İstanbul', 'ﬁnance', 'a b', '  spaced   out  ', 'line\nbreak', 'report', 'pilot deck', 'commission', 'total', '%', '(c)', '...', 'A/B', 'R&D', 'email@', '10.5', 'zzz-not-there'];
const dirs = ['', 'Alder Works UK/03 - Finance', 'Alder Works UK/07 - Research', 'Alder Works UK/05 - Legacy', 'Alder Works UK/06 - Emails', 'Alder Works UK/08 - Real files', 'Personal'];
const strip0 = (t) => t.split('\n').filter((l) => !/very long document|Notes:|^$/.test(l) && !/time limit/.test(l)).join('\n');
const strip = (t) => strip0(t).split('\n').filter((l) => !/have no readable text/.test(l)).join('\n').replace(/Searched \d+ document\(s\)/g, 'Searched N document(s)');
let n = 0, diff = 0; const shown = [];
for (const q of words) for (const match of ['phrase', 'all_words', 'any_word']) for (const p of dirs) {
  if (p === '' && !['needle-zebra-42', 'fundação', 'the', 'e', '2026', 'zzz-not-there'].includes(q)) continue;
  const args = { query: q, match, path: p, limit: 100, snippets_per_file: 8 };
  let a, b; try { a = await oldS.call('search_contents', args); } catch (e) { a = 'ERR ' + e.message; } try { b = await newS.call('search_contents', args); } catch (e) { b = 'ERR ' + e.message; }
  n++; if (strip(a) !== strip(b)) { diff++; if (shown.length < 4) { const al = strip(a).split('\n'), bl = strip(b).split('\n'); const i = al.findIndex((l, k) => l !== bl[k]); shown.push(`[${q}|${match}|${p}] line ${i}:\n   old: ${(al[i] || '').slice(0, 220)}\n   new: ${(bl[i] || '').slice(0, 220)}`); } }
}
// now the slow path of the new version: remove every stored search form and compare the new version with itself
const fast = {}; const probe = words.slice(0, 20);
for (const q of probe) fast[q] = await newS.call('search_contents', { query: q, match: 'all_words', limit: 100, snippets_per_file: 8 });
let removed = 0; for (const f of fs.readdirSync(`${newS.DATA}/index/text`)) if (f.endsWith('.fold')) { fs.unlinkSync(`${newS.DATA}/index/text/${f}`); removed++; }
let slowDiff = 0; for (const q of probe) if (await newS.call('search_contents', { query: q, match: 'all_words', limit: 100, snippets_per_file: 8 }) !== fast[q]) slowDiff++;
console.log(`${n} searches compared between versions: ${diff} differ. Fast path vs slow path (${removed} search forms removed): ${slowDiff} of ${probe.length} differ.`);
for (const s of shown) console.log(s);
await oldS.client.close(); await newS.client.close();
