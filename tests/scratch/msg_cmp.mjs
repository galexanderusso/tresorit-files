import fs from 'node:fs';
import { extractMsg } from '../tresorit-connector/server/lib/legacy.js';
const ref = JSON.parse(fs.readFileSync('/home/tester/build/scratch/msg_ref.json', 'utf8'));
const norm = (s) => (s || '').replace(/\0/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
let ok = 0, bad = 0, err = 0;
for (const [f, r] of Object.entries(ref)) {
  const name = f.split('/').pop();
  let text;
  try { text = extractMsg(fs.readFileSync(f)); } catch (e) { console.log(`ERR   ${name}: ${e.message}   (reference: ${r.error ? 'also error' : r.cls})`); err++; continue; }
  if (r.error) { console.log(`ref-error ${name}: ours gave ${text.length} chars`); continue; }
  const problems = [];
  const head = text.split('\n' + '-'.repeat(40) + '\n')[0];
  const body = text.slice(head.length + 42);
  if (r.subject && !norm(head).includes(norm(r.subject))) problems.push(`subject "${r.subject}"`);
  const refBody = norm(r.body); const ourBody = norm(body);
  if (refBody.length > 20) {
    const probe = [refBody.slice(0, 40), refBody.slice(Math.floor(refBody.length / 2), Math.floor(refBody.length / 2) + 40), refBody.slice(-40)];
    const hit = probe.filter((p) => ourBody.includes(p)).length;
    if (hit < 2) problems.push(`body mismatch (${hit}/3 probes; ref ${refBody.length} chars, ours ${ourBody.length})`);
  }
  for (const a of r.att || []) if (a && !head.includes(a)) problems.push(`attachment "${a}"`);
  if (r.sender) { const em = (r.sender.match(/[\w.+-]+@[\w.-]+/) || [])[0]; if (em && !norm(head).includes(norm(em))) problems.push(`sender ${em}`); }
  if (problems.length) { bad++; console.log(`DIFF  ${name} [${r.cls}]: ${problems.join(' | ')}`); } else ok++;
}
console.log(`\n${ok} match the reference, ${bad} differ, ${err} errors`);
