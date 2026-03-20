// Prepend timestamps to all console output — import this FIRST
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
console.log = (...args: any[]) => _origLog(`[${_ts()}]`, ...args);
console.error = (...args: any[]) => _origErr(`[${_ts()}]`, ...args);
