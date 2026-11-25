// Access log: one plain-text line per action, in monthly files, kept outside Tresorit.
import fs from 'node:fs';
import path from 'node:path';

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fileStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function makeLogger(dir) {
  let ok = true;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { ok = false; }
  function currentFile(d = new Date()) {
    return path.join(dir, `access-${d.getFullYear()}-${pad(d.getMonth() + 1)}.log`);
  }
  function log(action, target = '', detail = '') {
    if (!ok) return;
    const d = new Date();
    const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 600);
    const line = `${stamp(d)} | ${action.padEnd(8)} | ${clean(target)}${detail ? ' | ' + clean(detail) : ''}\n`;
    try { fs.appendFileSync(currentFile(d), line); } catch { /* never let logging break a tool */ }
  }
  return { log, currentFile, dir };
}
