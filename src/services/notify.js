/**
 * Notifications: toasts and status messages. No DOM; emits notify:toast for the shell.
 * @module services/notify
 */
import { uid } from '../core/ids.js';
import { log } from '../core/log.js';

/**
 * @typedef {Object} Toast
 * @property {string} id
 * @property {'info'|'success'|'warn'|'error'} level
 * @property {string} message
 * @property {string=} detail
 * @property {Array<{label: string, run: () => void, primary?: boolean}>=} actions
 * @property {number=} timeout   ms; 0 = sticky
 * @property {number} time
 */

export class NotifyService {
  /** @param {import('../core/events.js').EventBus} events */
  constructor(events) {
    this.events = events;
    /** @type {Toast[]} */
    this.history = [];
    this.unread = 0;
  }

  /**
   * @param {Toast['level']} level @param {string} message
   * @param {{detail?: string, actions?: Toast['actions'], timeout?: number, source?: string, silent?: boolean}} [opts]
   */
  show(level, message, opts = {}) {
    /** @type {Toast} */
    const t = {
      id: uid('nt'),
      level,
      message,
      detail: opts.detail,
      actions: opts.actions,
      timeout: opts.timeout ?? (level === 'error' ? 9000 : level === 'warn' ? 7000 : 4500),
      time: Date.now(),
    };
    this.history.unshift(t);
    if (this.history.length > 100) this.history.length = 100;
    this.unread++;
    const lvl = level === 'success' ? 'info' : level;
    log[lvl](opts.source || 'notify', message + (opts.detail ? ` (${opts.detail})` : ''));
    if (!opts.silent) this.events.emit('notify:toast', t);
    return t.id;
  }

  info(message, opts) { return this.show('info', message, opts); }
  success(message, opts) { return this.show('success', message, opts); }
  warn(message, opts) { return this.show('warn', message, opts); }
  error(message, opts) { return this.show('error', message, opts); }

  markRead() { this.unread = 0; }
}
