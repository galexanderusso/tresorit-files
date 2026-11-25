// Wrapper around the bundled recognition engine's own worker script.
// It removes the engine's ability to download anything: all files it needs are inside the bundle.
'use strict';
const toErr = (...a) => console.error(...a);
console.log = toErr; console.info = toErr; console.warn = toErr; console.debug = toErr;
global.fetch = async (url) => { throw new Error(`network access is disabled in this connector (attempted: ${String(url).slice(0, 120)})`); };
require('tesseract.js/src/worker-script/node/index.js');
