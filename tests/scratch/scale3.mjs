// Three copies on the large test library: one reads it, all three end with the same index.
import { Client } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../tresorit-connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import fs from 'node:fs';
const SERVER = process.env.SERVER; const DATA = '/home/tester/build/mock/data-scale3'; fs.rmSync(DATA, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start() {
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env, TRESORIT_ROOT: '/home/tester/build/mock/Tresors', TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: '200', TRESORIT_OCR: 'false', TRESORIT_PREFLIGHT_GATE: 'off' }, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} }); await client.connect(transport);
  const call = async (tool, args = {}) => (await client.callTool({ name: `tresorit_${tool}`, arguments: args }, undefined, { timeout: 170000 })).content.map((c) => c.text || '').join('\n');
  const rss = () => Math.round(Number(fs.readFileSync(`/proc/${transport.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024);
  return { client, call, rss, pid: transport.pid };
}
const t0 = Date.now(); const copies = await Promise.all([start(), start(), start()]);
let sts = []; let peak = [0, 0, 0]; let sawProgress = 0;
for (let i = 0; i < 2400; i++) {
  await sleep(500); sts = await Promise.all(copies.map((c) => c.call('connector_status')));
  copies.forEach((c, k) => { peak[k] = Math.max(peak[k], c.rss()); });
  if (sts.every((s) => /in progress: reading documents/.test(s))) sawProgress++;
  if (sts.every((s) => /up to date as of/.test(s))) break;
}
const line = (s) => (s.match(/Search index: .*/) || [''])[0];
const wp = JSON.parse(fs.readFileSync(`${DATA}/index/background.lock`, 'utf8')).pid;
const log = fs.readdirSync(`${DATA}/logs`).map((f) => fs.readFileSync(`${DATA}/logs/${f}`, 'utf8')).join('\n');
console.log(`finished in ${Math.round((Date.now() - t0) / 1000)} s; all three report: ${new Set(sts.map(line)).size === 1 ? 'the same index' : 'DIFFERENT indexes'}: ${line(sts[0])}`);
console.log(`full passes in the log: ${log.split('\n').filter((l) => /document\(s\) read into the search index/.test(l)).map((l) => l.split('|').pop().trim()).join(' / ')}`);
console.log(`peak memory: worker ${peak[copies.findIndex((c) => c.pid === wp)]} MB; the other two ${peak.filter((_, k) => copies[k].pid !== wp).join(' and ')} MB; times all three showed the same "in progress": ${sawProgress}`);
const q = await Promise.all(copies.map((c) => c.call('search_contents', { query: 'needle-zebra-42' })));
console.log(`the same search through each copy: ${q.map((t) => (t.match(/^(\d+) file\(s\)/) || [t.slice(0, 60)])[0]).join(' | ')}`);
for (const c of copies) await c.client.close();
