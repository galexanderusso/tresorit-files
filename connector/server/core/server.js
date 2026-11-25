// The server that Claude talks to: the instructions it sends, how a tool is registered (tool()), and how the
// connector stops when the app disconnects.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../lib/config.js';
import { UserError } from '../lib/paths.js';
import { ROOT, rootProblem, log, index, ocr, closing, markClosing } from './setup.js';
import { oneAtATime } from './turns.js';

// ---------------------------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------------------------
const INSTRUCTIONS = [
  'This connector works on the user\'s Tresorit folder as synced on this Mac. Use it for anything "in Tresorit".',
  'Paths are relative to the Tresorit folder and start with the tresor name, e.g. "Company/Projects/2026/notes.md". Use "" for the top level.',
  'To locate things: tresorit_find_files searches names, tresorit_search_contents searches inside documents (PDF including scans, Word, Excel, PowerPoint, Outlook messages, text), tresorit_list_folder browses, tresorit_recent_files shows what changed lately.',
  'Reading: tresorit_read_file returns the text of a document (paged with offset) or shows an image. Text of scanned PDFs comes from text recognition and can contain errors: check figures, names and dates against the original before relying on them.',
  'Files are read by their content, not by the ending of their name: a picture saved as .pdf goes through text recognition, a PDF saved as .docx is read as a PDF, and the note says so. tresorit_list_unreadable lists what could not be read, with the reason (password-protected, damaged, empty, unsupported content, too large) and the files whose ending does not match their content.',
  'PASSWORD-PROTECTED PDFs: NEVER ask the user to type a document password in the conversation, and never accept one there. Use tresorit_read_file with ask_password (one read, nothing kept) or tresorit_unlock_folder (makes a folder searchable): the user is then asked for the password in a box on their Mac. The password is used for that call and kept nowhere.',
  'tresorit_find_identical finds files with the same content, or tells whether a given file is already in Tresorit. tresorit_clear_transfer lists and empties the transfer folder (needs the user\'s permission, with a preview first). tresorit_export_to_transfer and tresorit_import_from_transfer take several items in one call.',
  'Changing: tresorit_write_file, tresorit_edit_file, tresorit_create_folder, tresorit_move_item, tresorit_copy_item. Existing files are never overwritten unless overwrite is true, and then the previous version is kept in the holding area.',
  'Blocked folders (connector settings) are never read or changed, also not through a folder above them: a copy of such a folder leaves the blocked folder out and says so; moving, renaming, deleting or replacing it is refused. Tell the user when that happens; do not work around it.',
  'DELETING REQUIRES THE USER\'S PERMISSION EVERY TIME. Call tresorit_delete_items once to get a preview and a token, show the user exactly what would be deleted, wait for their explicit yes in the conversation, and only then call tresorit_delete_items again with the token. The user is then asked once more in a confirmation window on their Mac (or a box of the app): tell them to expect it, and if they do not answer it or choose Keep, nothing is deleted. Never treat an earlier, general instruction as permission. Deleted items go to a holding area and can be brought back with tresorit_restore_deleted.',
  'Bringing things in: a file or folder that is elsewhere on this Mac (Downloads, Desktop, Documents, an external drive) goes into Tresorit with tresorit_import_file (copy by default; a bare file name means the one in Downloads); tresorit_list_outside_folder shows names in an outside folder. A small document you created in the conversation can be saved directly with tresorit_receive_file; for a larger one, give it to the user to download and then import it from Downloads.',
  'Taking things out: tresorit_export_file copies a file to Downloads or Desktop (for example to attach to an email); tresorit_export_to_transfer copies it to the connector\'s transfer folder for processing.',
  'Folders set as "do not index" are read only when the user asks for a file in them by name; their contents are never searched.',
  'The holding area clears itself: batches older than the number of days in the connector\'s settings (30 unless the user changed it; 0 = never) are removed for good automatically, and each such removal is in the access log. tresorit_list_deleted shows its size. Removing anything sooner is done with tresorit_clear_deleted, only with the user\'s permission.',
  'Every action is written to an access log on the user\'s Mac.',
  'The connector is read-only until tresorit_preflight (a self-check that changes nothing in Tresorit) has passed on this computer for this version. If a tool says the self-check has not passed, offer to run it and show the user its report.',
].join('\n');

const server = new McpServer({ name: 'tresorit-local', version: VERSION }, { instructions: INSTRUCTIONS });

let activeCalls = 0;

const CHANGING = new Set(['tresorit_write_file', 'tresorit_edit_file', 'tresorit_create_folder', 'tresorit_move_item', 'tresorit_copy_item', 'tresorit_restore_deleted',
  'tresorit_export_to_transfer', 'tresorit_import_from_transfer', 'tresorit_import_file', 'tresorit_export_file', 'tresorit_receive_file']);
// (Deleting and emptying the holding area wait for the user's answer first, and queue only the change itself.)

let TOOL_COUNT = 0;
function tool(name, cfg, fn) {
  TOOL_COUNT++;
  server.registerTool(name, cfg, async (args, extra) => {
    activeCalls++;
    try {
      if (!ROOT) throw new UserError(rootProblem);
      index.refresh(); // what other copies of the connector have added to the search index (the copy that reads in the background looks too: the others open protected files and read files on request)
      const out = CHANGING.has(name) ? await oneAtATime(() => fn(args || {}, extra), name, extra && extra.signal) : await fn(args || {}, extra);
      return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
    } catch (e) {
      const msg = e instanceof UserError ? e.message : `${e.code ? e.code + ': ' : ''}${e.message || e}`;
      log(e instanceof UserError ? 'REFUSED' : 'ERROR', name, msg);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    } finally {
      activeCalls--;
      if (closing && activeCalls === 0) finish();
    }
  });
}

const RO = { readOnlyHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function finish() {
  try { index.save(); } catch { /* ignore */ }
  try { ocr.close(); } catch { /* ignore */ }
  process.exit(0);
}
// When the app disconnects, an operation that is half-way (a copy, a move, a save) is allowed to complete first,
// so that closing Claude never leaves a half-finished change in Tresorit.
function shutdown() {
  if (closing) return;
  markClosing();
  if (activeCalls === 0) { finish(); return; }
  log('STOP', '', `waiting for ${activeCalls} operation(s) in progress before stopping`);
  setTimeout(finish, Number(process.env.TRESORIT_SHUTDOWN_WAIT_MS) || 120_000);
}

export { server, TOOL_COUNT, tool, RO, RW, shutdown };
