/**
 * Leveled, structured logging into a ring buffer read by the Console editor.
 * Errors are mirrored to the browser console; warnings stay in the Console editor.
 * @module core/log
 */

/** @typedef {'debug'|'info'|'warn'|'error'} Level */
/**
 * @typedef {Object} LogEntry
 * @property {number} seq
 * @property {number} time       ms since epoch
 * @property {Level} level
 * @property {string} source     'compiler' | 'engine' | 'delta' | 'theme' | 'lazy' | 'swarm' | ...
 * @property {string} message
 * @property {string=} hint      actionable fix
 * @property {string=} nodeId    related scope/metric id (click selects it)
 * @property {any=} data
 */

const MAX = 5000;
/** @type {LogEntry[]} */
const buffer = [];
let seq = 0;
/** @type {((entry: LogEntry) => void) | null} */
let sink = null;

/** Route new entries to the event bus. @param {(entry: LogEntry) => void} fn */
export function setLogSink(fn) {
  sink = fn;
}

/**
 * @param {Level} level @param {string} source @param {string} message
 * @param {{hint?:string, nodeId?:string, data?:any}} [extra]
 */
export function write(level, source, message, extra = {}) {
  /** @type {LogEntry} */
  const entry = { seq: ++seq, time: Date.now(), level, source, message, ...extra };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  // warnings (rejected deltas, compiler diagnostics) belong in the Console editor;
  // only genuine errors are mirrored to the browser console
  if (level === 'error') console.error(`[${source}] ${message}`, extra.data ?? '');
  if (sink) {
    try { sink(entry); } catch { /* ignore */ }
  }
  return entry;
}

export const log = {
  debug: (source, message, extra) => write('debug', source, message, extra),
  info: (source, message, extra) => write('info', source, message, extra),
  warn: (source, message, extra) => write('warn', source, message, extra),
  error: (source, message, extra) => write('error', source, message, extra),
  /** @returns {LogEntry[]} */
  entries: () => buffer,
  clear: () => { buffer.length = 0; },
};
