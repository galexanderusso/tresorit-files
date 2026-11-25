// The connector talks to Claude over standard output, so nothing else may ever be printed there.
// Any library that calls console.log is redirected to standard error instead.
const toErr = (...args) => console.error(...args);
console.log = toErr;
console.info = toErr;
console.warn = toErr;
console.debug = toErr;
