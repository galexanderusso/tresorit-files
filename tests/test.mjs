import { Client, StdioClientTransport, BASE, SERVER } from './lib/env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = `${BASE}/mock/Tresors`;
const DATA = `${BASE}/mock/data`;
fs.rmSync(DATA, { recursive: true, force: true });
const env = { ...process.env, TRESORIT_ROOT: ROOT, TRESORIT_DATA_DIR: DATA, TRESORIT_INDEX_DELAY_MS: process.env.BG_DELAY || '999999', TRESORIT_BLOCKED: process.env.BLOCKED || '${user_config.blocked_folders}', TRESORIT_ASSUME_FILE_PROVIDER: '1', TRESORIT_OCR_ENGINE: 'bundled' };
const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env, stderr: 'inherit' });
const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
await client.connect(transport);

let pass = 0, fail = 0;
const verbose = process.argv.includes('-v');
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: !!r.isError, content: r.content };
}
function check(label, cond, detail = '') {
  if (cond) { pass++; if (verbose) console.log('  ok  ', label); }
  else { fail++; console.log('  FAIL', label, detail ? '\n       ' + String(detail).slice(0, 600) : ''); }
}
async function t(label, name, args, pred) {
  const r = await call(name, args);
  let ok = false; try { ok = pred(r); } catch (e) { ok = false; }
  check(label, ok, r.text);
  if (verbose) console.log('       ' + r.text.split('\n').slice(0, 6).join('\n       '));
  return r;
}

const tools = await client.listTools();
console.log('tools:', tools.tools.map((x) => x.name).join(', '));
check('28 tools, all prefixed tresorit_', tools.tools.length === 28 && tools.tools.every((x) => x.name.startsWith('tresorit_')), tools.tools.length);
const protoErrors = []; client.onerror = (e) => protoErrors.push(String(e));
check('delete is marked destructive', tools.tools.find((x) => x.name === 'tresorit_delete_items').annotations.destructiveHint === true);
console.log('instructions present:', !!client.getInstructions());

// ---- browse
await t('list top level shows 4 tresors', 'tresorit_list_folder', {}, (r) => ['Strongbox', 'Alder Works UK', 'Personal', 'Birch Labs'].every((n) => r.text.includes(n)));
await t('junk and lock files hidden', 'tresorit_list_folder', { path: 'Alder Works UK/03 - Finance' }, (r) => !r.text.includes('.DS_Store') && !r.text.includes('~$') && r.text.includes('Commission tracker'));
await t('symlink not listed', 'tresorit_list_folder', { path: 'Alder Works UK' }, (r) => !r.text.includes('escape-link'));
await t('recursive list', 'tresorit_list_folder', { path: 'Alder Works UK', recursive: true }, (r) => r.text.includes('07 - Research/ORBIT/README.md'));
await t('leading slash accepted', 'tresorit_list_folder', { path: '/Personal/Tax' }, (r) => r.text.includes('Scanned letter.pdf'));
await t('absolute path inside root accepted', 'tresorit_list_folder', { path: ROOT + '/Personal' }, (r) => r.text.includes('Tax/'));
await t('online-only flagged', 'tresorit_list_folder', { path: 'Personal/Tax' }, (r) => /Online only report\.txt.*online only/.test(r.text));

// ---- escapes
await t('dot-dot escape refused', 'tresorit_list_folder', { path: '../outside-secret' }, (r) => r.isError && /outside the Tresorit folder/.test(r.text));
await t('deep dot-dot refused', 'tresorit_read_file', { path: 'Alder Works UK/../../outside-secret/secret.txt' }, (r) => r.isError && !r.text.includes('TOP SECRET'));
await t('symlink escape refused', 'tresorit_read_file', { path: 'Alder Works UK/escape-link/secret.txt' }, (r) => r.isError && /link/.test(r.text) && !r.text.includes('TOP SECRET'));
await t('absolute outside refused', 'tresorit_read_file', { path: '/etc/passwd' }, (r) => r.isError && !r.text.includes('root:'));
await t('tilde refused', 'tresorit_read_file', { path: '~/.ssh/id_rsa' }, (r) => r.isError);
await t('write through symlink refused', 'tresorit_write_file', { path: 'Alder Works UK/escape-link/planted.txt', content: 'x' }, (r) => r.isError);
check('nothing planted outside', !fs.existsSync(`${BASE}/mock/outside-secret/planted.txt`));

// ---- find
await t('find by words, accent-insensitive', 'tresorit_find_files', { query: 'nda fundacao' }, (r) => r.text.includes('NDA Fundação Exemplo.docx'));
await t('find with extension filter', 'tresorit_find_files', { query: 'orbit', extensions: ['pdf'] }, (r) => r.text.includes('ORBIT technical report.pdf') && !r.text.includes('.pptx'));
await t('find folders', 'tresorit_find_files', { query: 'quarantine', kind: 'folder' }, (r) => r.text.includes('06_IP_quarantine/'));
await t('find nothing', 'tresorit_find_files', { query: 'zzzznothing' }, (r) => /No names matching/.test(r.text));
await t('find by date filter only', 'tresorit_find_files', { modified_after: '2020-01-01', extensions: ['xlsx'] }, (r) => r.text.includes('Commission tracker 2026.xlsx'));
await t('find bad date', 'tresorit_find_files', { query: 'x', modified_after: 'yesterdayish' }, (r) => r.isError);

// ---- read
await t('read docx incl. table + entities', 'tresorit_read_file', { path: 'Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx' }, (r) => r.text.includes('cláusula de não-divulgação') && r.text.includes('USD 1,250 & more <tagged>') && r.text.includes('Megaphos'));
await t('read xlsx both sheets', 'tresorit_read_file', { path: 'Alder Works UK/03 - Finance/Commission tracker 2026.xlsx' }, (r) => r.text.includes('Sheet: Commissions') && r.text.includes('INV-0042') && r.text.includes('15250.5') && r.text.includes('Sheet: Notes') && r.text.includes('unicorn-keyword'));
await t('read pptx slides + notes', 'tresorit_read_file', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT pilot deck.pptx' }, (r) => r.text.includes('Slide 1') && r.text.includes('Photonic sampling') && r.text.includes('Slide 2') && r.text.includes('provenance stamp'));
await t('read pdf pages', 'tresorit_read_file', { path: 'Alder Works UK/07 - Research/ORBIT/ORBIT technical report.pdf' }, (r) => r.text.includes('Page 1 of 2') && r.text.includes('boson sampling') && r.text.includes('error mitigation'));
const long1 = await t('long pdf is paged', 'tresorit_read_file', { path: 'Alder Works UK/07 - Research/ORBIT/Long appendix.pdf', max_chars: 5000 }, (r) => /More remains: call tresorit_read_file again with offset 5000/.test(r.text));
await t('paging continues', 'tresorit_read_file', { path: 'Alder Works UK/07 - Research/ORBIT/Long appendix.pdf', max_chars: 5000, offset: 5000 }, (r) => /characters 5000-10000/.test(r.text));
await t('scanned pdf reported clearly', 'tresorit_read_file', { path: 'Personal/Tax/Scanned letter.pdf' }, (r) => r.isError && /scanned PDF in which no text could be recognised/.test(r.text));
await t('damaged .doc reported clearly', 'tresorit_read_file', { path: 'Personal/Tax/legacy.doc' }, (r) => r.isError && /unrecognised file format/.test(r.text));
await t('a .docx that is really a line of plain text is read as text, and says so', 'tresorit_read_file', { path: 'Alder Works UK/03 - Finance/Broken file.docx' }, (r) => !r.isError && /not a zip at all/.test(r.text) && /plain text file saved as \.docx/.test(r.text));
const img = await call('tresorit_read_file', { path: 'Personal/Tax/passport photo.png' });
check('image returned as image', img.content.some((c) => c.type === 'image' && c.mimeType === 'image/png'));
await t('read folder refused', 'tresorit_read_file', { path: 'Personal' }, (r) => r.isError && /folder/.test(r.text));
await t('read missing', 'tresorit_read_file', { path: 'Personal/nope.txt' }, (r) => r.isError && /Not found/.test(r.text));

// ---- content search
await t('phrase search across pdf/xlsx/txt', 'tresorit_search_contents', { query: 'unicorn-keyword' }, (r) => r.text.includes('ORBIT technical report.pdf') && r.text.includes('Commission tracker 2026.xlsx') && r.text.includes('novelty candidate.txt') && !r.text.includes('secret.txt'));
await t('search accent-insensitive', 'tresorit_search_contents', { query: 'clausula de nao-divulgacao' }, (r) => r.text.includes('NDA Fundação Exemplo.docx') && r.text.includes('cláusula'));
await t('search all_words', 'tresorit_search_contents', { query: 'mitigation boson', match: 'all_words' }, (r) => r.text.includes('ORBIT technical report.pdf') && /^1 file/.test(r.text));
await t('search phrase negative', 'tresorit_search_contents', { query: 'mitigation boson' }, (r) => /^0 file/.test(r.text));
await t('search any_word', 'tresorit_search_contents', { query: 'qumodes megaphos', match: 'any_word' }, (r) => r.text.includes('pilot deck.pptx') && r.text.includes('NDA Fundação'));
await t('search regex', 'tresorit_search_contents', { query: 'INV-\\d{4}', match: 'regex' }, (r) => r.text.includes('Commission tracker'));
await t('search bad regex', 'tresorit_search_contents', { query: '([', match: 'regex' }, (r) => r.isError);
await t('search scoped to folder', 'tresorit_search_contents', { query: 'unicorn-keyword', path: 'Alder Works UK/03 - Finance' }, (r) => r.text.includes('Commission tracker') && !r.text.includes('technical report'));
await t('search notes online-only + unreadable', 'tresorit_search_contents', { query: 'unicorn-keyword' }, (r) => /online-only file\(s\) were skipped/.test(r.text) && /have no readable text/.test(r.text));
await t('search in pptx notes', 'tresorit_search_contents', { query: 'provenance stamp' }, (r) => r.text.includes('pilot deck.pptx'));

// ---- info / recent
await t('file_info file', 'tresorit_file_info', { path: 'Alder Works UK/07 - Research/ORBIT/README.md' }, (r) => r.text.includes('Type: file (.md)') && r.text.includes('searchable (65 characters)'));
await t('file_info folder', 'tresorit_file_info', { path: 'Alder Works UK' }, (r) => /Contains: \d+ file/.test(r.text));
await t('recent files', 'tresorit_recent_files', { days: 1 }, (r) => r.text.includes('README.md'));

// ---- write / edit
const W = 'Birch Labs/Briefs/pilot brief.md';
await t('write new file (creates folders)', 'tresorit_write_file', { path: 'Birch Labs/Briefs/2026/new/pilot notes.md', content: 'hello' }, (r) => !r.isError && fs.readFileSync(ROOT + '/Birch Labs/Briefs/2026/new/pilot notes.md', 'utf8') === 'hello');
await t('write brief', 'tresorit_write_file', { path: W, content: 'Status: amber\nOwner: Morgan\nStatus history: none\n' }, (r) => !r.isError);
await t('write refuses overwrite by default', 'tresorit_write_file', { path: W, content: 'clobber' }, (r) => r.isError && /already exists/.test(r.text) && fs.readFileSync(ROOT + '/' + W, 'utf8').startsWith('Status: amber'));
const ow = await t('overwrite keeps previous version', 'tresorit_write_file', { path: W, content: 'Status: green\nOwner: Morgan\nStatus history: none\n', overwrite: true }, (r) => !r.isError && /batch \S+_replaced_/.test(r.text));
await t('write at top level refused', 'tresorit_write_file', { path: 'loose.txt', content: 'x' }, (r) => r.isError && /top level/.test(r.text));
await t('create top-level folder refused', 'tresorit_create_folder', { path: 'New Tresor' }, (r) => r.isError);
await t('write base64', 'tresorit_write_file', { path: 'Birch Labs/Briefs/bin.dat', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' }, (r) => !r.isError && fs.readFileSync(ROOT + '/Birch Labs/Briefs/bin.dat').length === 4);
await t('edit unique', 'tresorit_edit_file', { path: W, old_text: 'Owner: Morgan', new_text: 'Owner: M. Example-Smith' }, (r) => !r.isError && fs.readFileSync(ROOT + '/' + W, 'utf8').includes('M. Example-Smith'));
await t('edit ambiguous refused', 'tresorit_edit_file', { path: W, old_text: 'Status', new_text: 'State' }, (r) => r.isError && /appears 2 times/.test(r.text));
await t('edit replace_all', 'tresorit_edit_file', { path: W, old_text: 'Status', new_text: 'State', replace_all: true }, (r) => !r.isError && !fs.readFileSync(ROOT + '/' + W, 'utf8').includes('Status'));
await t('edit not found', 'tresorit_edit_file', { path: W, old_text: 'nonexistent passage', new_text: 'x' }, (r) => r.isError);
await t('edit docx refused', 'tresorit_edit_file', { path: 'Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx', old_text: 'a', new_text: 'b' }, (r) => r.isError && /plain-text/.test(r.text));
await t('edit with $ in replacement is literal', 'tresorit_edit_file', { path: W, old_text: 'State: green', new_text: 'Price: $& $1 USD' }, (r) => !r.isError && fs.readFileSync(ROOT + '/' + W, 'utf8').includes('Price: $& $1 USD'));
await t('search sees edited content (index refreshes)', 'tresorit_search_contents', { query: 'Example-Smith', path: 'Birch Labs' }, (r) => r.text.includes('pilot brief.md'));

// ---- folders / move / copy
await t('create folder', 'tresorit_create_folder', { path: 'Alder Works UK/Packs/Vitas pack' }, (r) => !r.isError && fs.statSync(ROOT + '/Alder Works UK/Packs/Vitas pack').isDirectory());
await t('copy file into folder', 'tresorit_copy_item', { source: 'Alder Works UK/03 - Finance/Commission tracker 2026.xlsx', destination: 'Alder Works UK/Packs/Vitas pack' }, (r) => !r.isError && fs.existsSync(ROOT + '/Alder Works UK/Packs/Vitas pack/Commission tracker 2026.xlsx') && fs.existsSync(ROOT + '/Alder Works UK/03 - Finance/Commission tracker 2026.xlsx'));
await t('copy again refused (exists)', 'tresorit_copy_item', { source: 'Alder Works UK/03 - Finance/Commission tracker 2026.xlsx', destination: 'Alder Works UK/Packs/Vitas pack' }, (r) => r.isError && /already exists/.test(r.text));
await t('copy folder', 'tresorit_copy_item', { source: 'Alder Works UK/07 - Research/ORBIT', destination: 'Alder Works UK/Packs/ORBIT copy' }, (r) => !r.isError && fs.existsSync(ROOT + '/Alder Works UK/Packs/ORBIT copy/README.md'));
await t('rename', 'tresorit_move_item', { source: 'Alder Works UK/Packs/ORBIT copy/README.md', destination: 'Alder Works UK/Packs/ORBIT copy/READ FIRST.md' }, (r) => !r.isError && fs.existsSync(ROOT + '/Alder Works UK/Packs/ORBIT copy/READ FIRST.md') && !fs.existsSync(ROOT + '/Alder Works UK/Packs/ORBIT copy/README.md'));
await t('move across tresors', 'tresorit_move_item', { source: 'Alder Works UK/Packs/ORBIT copy', destination: 'Birch Labs/Briefs' }, (r) => !r.isError && fs.existsSync(ROOT + '/Birch Labs/Briefs/ORBIT copy/READ FIRST.md'));
await t('move tresor refused', 'tresorit_move_item', { source: 'Strongbox', destination: 'Personal/Crypto' }, (r) => r.isError && fs.existsSync(ROOT + '/Strongbox'));
await t('move into itself refused', 'tresorit_move_item', { source: 'Birch Labs/Briefs', destination: 'Birch Labs/Briefs/2026/inner' }, (r) => r.isError);
await t('move out of root refused', 'tresorit_move_item', { source: 'Birch Labs/Briefs/bin.dat', destination: '../../outside-secret/bin.dat' }, (r) => r.isError && fs.existsSync(ROOT + '/Birch Labs/Briefs/bin.dat'));

// ---- delete gating
const D1 = 'Birch Labs/Briefs/bin.dat';
const D2 = 'Birch Labs/Briefs/ORBIT copy';
const prev = await t('delete preview deletes nothing', 'tresorit_delete_items', { paths: [D1, D2] }, (r) => /NOTHING HAS BEEN DELETED/.test(r.text) && fs.existsSync(ROOT + '/' + D1) && fs.existsSync(ROOT + '/' + D2));
const token = (prev.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
check('preview returned a token', !!token, prev.text);
await t('made-up token refused', 'tresorit_delete_items', { paths: [D1, D2], confirm_token: 'deadbeef' }, (r) => r.isError && fs.existsSync(ROOT + '/' + D1));
await t('token refused for a different list', 'tresorit_delete_items', { paths: [D1, 'Birch Labs/Briefs/pilot brief.md'], confirm_token: token }, (r) => r.isError && fs.existsSync(ROOT + '/Birch Labs/Briefs/pilot brief.md') && fs.existsSync(ROOT + '/' + D1));
const prev2 = await call('tresorit_delete_items', { paths: [D1, D2] });
const token2 = (prev2.text.match(/confirm_token "([0-9a-f]+)"/) || [])[1];
const del = await t('delete with valid token moves to holding area', 'tresorit_delete_items', { paths: [D2, D1], confirm_token: token2 }, (r) => !r.isError && !fs.existsSync(ROOT + '/' + D1) && !fs.existsSync(ROOT + '/' + D2));
await t('token is single-use', 'tresorit_delete_items', { paths: [D1, D2], confirm_token: token2 }, (r) => r.isError);
await t('delete tresor refused', 'tresorit_delete_items', { paths: ['Strongbox'] }, (r) => r.isError && fs.existsSync(ROOT + '/Strongbox'));
await t('delete outside refused', 'tresorit_delete_items', { paths: ['../outside-secret/secret.txt'] }, (r) => r.isError && fs.existsSync(`${BASE}/mock/outside-secret/secret.txt`));
const held = await t('list_deleted shows batches', 'tresorit_list_deleted', {}, (r) => r.text.includes(D1) && r.text.includes('replaced') && r.text.includes('deleted'));
const batch = (del.text.match(/batch (\S+_deleted_\w+)/) || [])[1];
check('held copy exists on disk', fs.existsSync(path.join(DATA, 'deleted', batch, 'files', D2, 'READ FIRST.md')));
await t('restore single item', 'tresorit_restore_deleted', { batch, item: D1 }, (r) => /restored/.test(r.text) && fs.existsSync(ROOT + '/' + D1));
await t('restore rest of batch', 'tresorit_restore_deleted', { batch }, (r) => fs.existsSync(ROOT + '/' + D2 + '/READ FIRST.md') && !fs.existsSync(path.join(DATA, 'deleted', batch)));
const rb = (ow.text.match(/batch (\S+_replaced_\w+)/) || [])[1];
await t('restore replaced version needs overwrite', 'tresorit_restore_deleted', { batch: rb }, (r) => /not restored/.test(r.text));
await t('restore replaced version with overwrite', 'tresorit_restore_deleted', { batch: rb, overwrite: true }, (r) => /restored/.test(r.text) && fs.readFileSync(ROOT + '/' + W, 'utf8').startsWith('Status: amber'));
await t('restore bad batch name', 'tresorit_restore_deleted', { batch: '../../etc' }, (r) => r.isError);

// ---- transfer
const ex = await t('export copies out', 'tresorit_export_to_transfer', { path: 'Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx' }, (r) => !r.isError && fs.existsSync(path.join(DATA, 'transfer', 'NDA Fundação Exemplo.docx')) && fs.existsSync(ROOT + '/Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx'));
await t('export twice gets a new name', 'tresorit_export_to_transfer', { path: 'Alder Works UK/03 - Finance/NDA Fundação Exemplo.docx' }, (r) => fs.existsSync(path.join(DATA, 'transfer', 'NDA Fundação Exemplo (2).docx')));
fs.writeFileSync(path.join(DATA, 'transfer', 'Signed NDA.pdf'), 'pdf bytes');
await t('transfer listing', 'tresorit_import_from_transfer', {}, (r) => r.text.includes('Signed NDA.pdf') && r.text.includes('item(s) waiting'));
await t('import into folder', 'tresorit_import_from_transfer', { name: 'Signed NDA.pdf', destination: 'Alder Works UK/03 - Finance' }, (r) => !r.isError && fs.existsSync(ROOT + '/Alder Works UK/03 - Finance/Signed NDA.pdf') && !fs.existsSync(path.join(DATA, 'transfer', 'Signed NDA.pdf')));
await t('import name escape refused', 'tresorit_import_from_transfer', { name: '../../outside-secret/secret.txt', destination: 'Personal/Tax/s.txt' }, (r) => r.isError && !fs.existsSync(ROOT + '/Personal/Tax/s.txt'));
fs.symlinkSync(`${BASE}/mock/outside-secret/secret.txt`, path.join(DATA, 'transfer', 'sneaky.txt'));
await t('import symlink escape refused', 'tresorit_import_from_transfer', { name: 'sneaky.txt', destination: 'Personal/Tax/s.txt' }, (r) => r.isError && !fs.existsSync(ROOT + '/Personal/Tax/s.txt'));
fs.unlinkSync(path.join(DATA, 'transfer', 'sneaky.txt'));

// ---- status / log
await t('status', 'tresorit_connector_status', {}, (r) => r.text.includes('Tresors: Alder Works UK, Birch Labs, Personal, Strongbox') && r.text.includes('Blocked folders: none') && /Search index: \d+ document/.test(r.text));
const lg = await t('access log has reads, searches, deletes, refusals', 'tresorit_access_log', { lines: 400 }, (r) => /\| READ /.test(r.text) && /\| SEARCH /.test(r.text) && /\| DELETE /.test(r.text) && /\| REFUSED /.test(r.text) && /\| DEL-ASK /.test(r.text) && /\| EXPORT /.test(r.text));
await t('access log filter', 'tresorit_access_log', { contains: 'DELETE' }, (r) => r.text.split('\n').slice(1).every((l) => /DELETE/i.test(l)));
check('log file is outside Tresorit', fs.readdirSync(path.join(DATA, 'logs')).length === 1 && !DATA.startsWith(ROOT));
if (verbose) console.log(lg.text.split('\n').slice(-12).join('\n'));

check('no protocol errors during the session', protoErrors.length === 0, protoErrors.join(' | '));
await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
