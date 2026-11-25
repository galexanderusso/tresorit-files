// Used by test18, part C. Plays one copy of the connector whose attempt to read a file meets the instant at which
// the file is not there, after an earlier failure of its own, while (in one mode) another copy has read that very
// version of the file successfully. Prints one line of JSON as its last line.
//   node gone150.mjs <server folder> <path in Tresorit> other-has-text|nobody-has-text
// Needs TRESORIT_ROOT and TRESORIT_DATA_DIR (scratch folders). The file named is removed.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [serverDir, rel, mode] = process.argv.slice(2);
const ROOT = process.env.TRESORIT_ROOT; const DATA = process.env.TRESORIT_DATA_DIR;
if (!ROOT || !DATA || !rel || !['other-has-text', 'nobody-has-text'].includes(mode)) { console.error('usage: see the top of this file'); process.exit(2); }
const lib = (name) => import(pathToFileURL(path.join(serverDir, name)).href);
const abs = path.join(ROOT, ...rel.split('/'));
const st = fs.statSync(abs);
const { TextIndex } = await lib('lib/textindex.js');
const indexDir = path.join(DATA, 'index');
// On disk before this copy starts: the record of its own earlier failure, of the kind that is tried again.
{
  const first = new TextIndex(indexDir);
  first.map.set(TextIndex.key(rel), { s: st.size, m: st.mtimeMs, st: 'error', c: 0, n: 'could not be read: EBUSY: resource busy or locked, open', y: 'other', x: 1 });
  first.dirty = true; first.save();
}
const copy = await lib('core/setup.js'); // this copy of the connector: it loads the catalog as it is now
const had = copy.index.fresh(rel, st);
// Meanwhile another copy reads the same version of the file successfully and saves that.
if (mode === 'other-has-text') { const other = new TextIndex(indexDir); await other.put(rel, st, { status: 'ok', text: 'TEXT READ BY THE OTHER COPY', note: '' }); other.save(); }
fs.rmSync(abs); // the instant at which the file is not there
const res = await copy.getText(abs, rel, st);
copy.index.save();
await new Promise((r) => setTimeout(r, 300));
let onDisk = null; try { const e = JSON.parse(fs.readFileSync(path.join(indexDir, 'catalog.json'), 'utf8')).entries[TextIndex.key(rel)]; onDisk = e ? e.st : null; } catch { onDisk = 'unreadable catalog'; }
console.log(JSON.stringify({ had: had ? had.st : null, answer: res.status, note: res.note, onDisk, text: await new TextIndex(indexDir).readText(rel) }));
process.exit(0);
