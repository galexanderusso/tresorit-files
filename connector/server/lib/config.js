// Configuration: where Tresorit lives on this Mac and where the connector keeps its own files.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const VERSION = '1.5.0';

// Settings left blank in the extension panel arrive as an unreplaced "${user_config.x}" placeholder.
function clean(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s || s.startsWith('${')) return '';
  return s;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function detectRoot() {
  const home = os.homedir();
  const configured = clean(process.env.TRESORIT_ROOT);
  const candidates = [];
  if (configured) {
    candidates.push(expandHome(configured));
  } else {
    candidates.push(path.join(home, 'Tresors'));
    try {
      const cs = path.join(home, 'Library', 'CloudStorage');
      for (const n of fs.readdirSync(cs)) {
        if (/^tresorit/i.test(n)) candidates.push(path.join(cs, n));
      }
    } catch { /* not present or not permitted */ }
  }
  for (const c of candidates) {
    if (isDir(c)) {
      try { return { root: fs.realpathSync.native(c), tried: candidates }; } catch { /* fall through */ }
    }
  }
  return { root: null, tried: candidates };
}

export function dataDir() {
  const configured = clean(process.env.TRESORIT_DATA_DIR);
  return configured ? expandHome(configured) : path.join(os.homedir(), 'TresoritConnector');
}

// Optional list of folders the connector must never touch, separated by ";" (relative to the Tresorit folder).
export function blockedFolders() {
  const raw = clean(process.env.TRESORIT_BLOCKED);
  if (!raw) return [];
  return raw.split(';').map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
}

export function backgroundIndexEnabled() {
  const v = clean(process.env.TRESORIT_BACKGROUND_INDEX).toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

export function ocrEnabled() {
  const v = clean(process.env.TRESORIT_OCR).toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

// 'auto' (Mac built-in recognition when it passes its self-test, otherwise the bundled engine), 'bundled' or 'mac'.
export function ocrEngineChoice() {
  const v = clean(process.env.TRESORIT_OCR_ENGINE).toLowerCase();
  return v === 'bundled' || v === 'mac' ? v : 'auto';
}

// The user's home folder (where Downloads and Desktop are).
export function homeDir() {
  const c = clean(process.env.TRESORIT_HOME_DIR);
  return c ? expandHome(c) : os.homedir();
}

// Places outside Tresorit from which files may be brought in: the home folder and external drives.
export function importRoots() {
  const raw = clean(process.env.TRESORIT_IMPORT_ROOTS);
  if (raw) return raw.split(path.delimiter).map((s) => expandHome(s.trim())).filter(Boolean);
  return [homeDir(), '/Volumes'];
}

// Folders whose documents are never copied into the search index (they stay readable when asked for by name).
// Separated by ";", relative to the Tresorit folder. Left blank, no folder is kept out: the program itself names
// none. (The word "none" means the same and is kept for settings written for earlier versions.) What the user
// enters here is guarded by the safeguard in core/setup.js.
export function noIndexFolders() {
  const raw = clean(process.env.TRESORIT_NO_INDEX);
  if (!raw || /^none$/i.test(raw)) return [];
  return raw.split(';').map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
}

// Batches in the holding area older than this many days are removed automatically. 0 switches that off.
// (Not set, or not a sensible number: 30.)
export function holdingDays() {
  const raw = clean(process.env.TRESORIT_HOLDING_DAYS);
  if (raw === '') return 30;
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return 30;
  if (n === 0) return 0;
  // Never less than a whole day: a slip of the keyboard (0.3 for 30) must not clear the holding area within hours.
  return Math.min(3650, Math.max(1, n));
}

export function pauseOnBattery() {
  const v = clean(process.env.TRESORIT_PAUSE_ON_BATTERY).toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}
