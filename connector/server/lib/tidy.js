// Memory housekeeping. Reading and searching documents creates large short-lived strings, and the JavaScript
// engine is slow to release them on its own: left alone, the connector can sit on over a gigabyte during heavy
// use. After every so many megabytes of text handled, this asks the engine to release what is no longer needed.
// If the engine does not offer that here, everything works the same, only with more memory in use.
import v8 from 'node:v8';
import vm from 'node:vm';

let collect = null;
if (process.env.TRESORIT_GC !== 'off') {
  try {
    if (typeof globalThis.gc === 'function') collect = globalThis.gc;
    else {
      v8.setFlagsFromString('--expose-gc');
      const g = vm.runInNewContext('typeof gc === "function" ? gc : null');
      if (typeof g === 'function') collect = g;
    }
  } catch { collect = null; }
}

const EVERY_CHARS = Number(process.env.TRESORIT_GC_EVERY_CHARS) || 24_000_000;
let pending = 0;
let runs = 0;

// Call with the number of characters (or bytes) of text just handled.
export function handled(chars) {
  if (!collect) return;
  pending += chars > 0 ? chars : 0;
  if (pending < EVERY_CHARS) return;
  pending = 0;
  try { collect(); runs++; } catch { collect = null; }
}

export function tidyNow() {
  if (!collect) return;
  pending = 0;
  try { collect(); runs++; } catch { collect = null; }
}

export const tidyInfo = () => ({ available: Boolean(collect), runs });
