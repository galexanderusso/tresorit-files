// Plays a copy of the connector of a version before 1.5.0 that does the background reading: it holds the lock of
// the background reading, as every version does, and publishes its state without naming its version, as every
// version before 1.5.0 did. Reads nothing.   node oldworker150.mjs <server/lib folder> <data folder> <seconds>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [lib, data, seconds] = process.argv.slice(2);
const { makeLock } = await import(pathToFileURL(path.join(lib, 'lock.js')).href);
fs.mkdirSync(path.join(data, 'index'), { recursive: true });
const lock = makeLock(path.join(data, 'index', 'background.lock'), { staleMs: 120000, beatMs: 1000 });
if (!(await lock.tryOnce('background reading'))) { console.log('LOCK NOT TAKEN'); process.exit(1); }
fs.writeFileSync(path.join(data, 'index', 'background.json'), JSON.stringify({ enabled: true, running: false, phase: '', seen: 0, extracted: 0, lastPass: Date.now(), at: Date.now(), pid: process.pid }));
console.log('HOLDING');
setTimeout(() => { lock.releaseNow(); process.exit(0); }, Number(seconds) * 1000);
