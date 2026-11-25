// Used by test18, part D. Asks one copy of the connector for a
// background pass twice at the same instant, as two of its timers falling together would, and prints one line of
// JSON as its last line: what the log says was read, and how many documents the status would call "checked".
//   node twopass150.mjs <server folder>
// Needs TRESORIT_ROOT, TRESORIT_DATA_DIR (an empty scratch folder), TRESORIT_BACKGROUND_INDEX=true, TRESORIT_OCR=false.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const serverDir = process.argv[2];
const lib = (name) => import(pathToFileURL(path.join(serverDir, name)).href);
const { bg, index } = await lib('core/setup.js');
const { indexPass } = await lib('core/background.js');
await Promise.all([indexPass(), indexPass()]);
const once = bg.seen;                       // after the two requests made together
await indexPass();                          // a pass by itself, for comparison: what one pass looks at
const logDir = path.join(process.env.TRESORIT_DATA_DIR, 'logs');
const log = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
const read = log.split('\n').map((l) => Number((l.match(/(\d+) document\(s\) read into the search index/) || [])[1])).filter((n) => n > 0);
console.log(JSON.stringify({ read, checkedAfterTwoRequests: once, checkedByOnePass: bg.seen, inIndex: index.map.size }));
process.exit(0);
