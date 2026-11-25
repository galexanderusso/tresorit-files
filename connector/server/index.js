#!/usr/bin/env node
// Tresorit Files connector for Claude.
// Works on the Tresorit folder that the Tresorit app keeps synced on this Mac. Nothing is sent anywhere by this
// program: it only reads and writes local files, so Tresorit's end-to-end encryption is untouched.
// This file starts the connector. The work is in core/ (shared parts) and tools/ (the tools), loaded below in a
// fixed order: the libraries first, then the parts. A part may use the parts loaded before it, never one loaded
// after it. Do not sort or reorder these lines.
import './lib/quiet.js';
import '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import 'zod';
import './lib/lock.js';
import { VERSION } from './lib/config.js';
import './lib/paths.js';
import './lib/log.js';
import './lib/extractor.js';
import './lib/textindex.js';
import './lib/ocr.js';
import './lib/extract-core.js';
import './lib/sniff.js';
import './lib/textutil.js';
import './lib/tidy.js';
import './lib/outside.js';
import './lib/power.js';
import './preflight.js';
import { ROOT, log, bg } from './core/setup.js';
import { indexPass } from './core/background.js';
import './core/turns.js';
import { HOLDING_DAYS, sweepHolding } from './core/changes.js';
import { server, shutdown } from './core/server.js';
import './tools/browse.js';
import './tools/search.js';
import './tools/read.js';
import './tools/write.js';
import './tools/move-copy.js';
import './tools/delete.js';
import './tools/transfer.js';
import './tools/clear-deleted.js';
import './tools/outside.js';
import './tools/receive.js';
import './tools/unreadable.js';
import './tools/clear-transfer.js';
import './tools/identical.js';
import './tools/status.js';

// ---------------------------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------------------------
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => { console.error('uncaught:', e); });
process.on('unhandledRejection', (e) => { console.error('unhandled:', e); });

const transport = new StdioServerTransport();
await server.connect(transport);
log('START', ROOT || '(Tresorit folder not found)', `connector ${VERSION}`);
console.error(`Tresorit connector ${VERSION} started. Folder: ${ROOT || 'NOT FOUND'}`);

if (ROOT && HOLDING_DAYS) {
  // The holding area is looked at shortly after the start and then a few times a day. (Every copy of the connector
  // looks; the removal itself takes its turn among the changes of all copies, so a batch is only ever removed once.)
  const firstLook = setTimeout(() => { sweepHolding(); }, Number(process.env.TRESORIT_HOLDING_FIRST_MS) || (90_000 + Math.floor(Math.random() * 60_000))); firstLook.unref?.();
  const looks = setInterval(() => { sweepHolding(); }, Number(process.env.TRESORIT_HOLDING_SWEEP_MS) || 6 * 3_600_000); looks.unref?.();
}

if (ROOT && bg.enabled) {
  const delay = Number(process.env.TRESORIT_INDEX_DELAY_MS || 20000);
  const first = setTimeout(indexPass, delay); first.unref?.();
  const every = setInterval(indexPass, Number(process.env.TRESORIT_INDEX_INTERVAL_MS) || 30 * 60 * 1000); every.unref?.();
}
