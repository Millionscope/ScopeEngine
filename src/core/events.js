/**
 * Typed event bus. The ONLY channel between editors, services, workspace and shell
 * (editors never import each other).
 *
 * Canonical event names and payloads:
 *
 * | Event               | Payload                                                                  |
 * | ------------------- | ------------------------------------------------------------------------ |
 * | theme:changed       | { kind:'dark'|'light', mode:'dark'|'light'|'auto', colors }              |
 * | graph:loaded        | { version, hash, nodes, scopes }                                         |
 * | graph:recomputed    | { version, hash, changed:string[], ms, nodes, tokens, mcMs, full, structural } |
 * | delta:applied       | { deltas, version, author, tokens, changed, summary }                    |
 * | delta:rejected      | { delta, errors:[{code,message,hint}], author }                          |
 * | selection:changed   | { selected:string[], focusScope, primary, source }                       |
 * | hover:changed       | { id|null, source }                                                      |
 * | scenario:changed    | { activeId, scenarios, reason, id }                                      |
 * | chat:message        | { message, kind:'add'|'update' }                                         |
 * | chat:stream         | { messageId, state:'start'|'chunk'|'end', text? }                        |
 * | swarm:event         | { buildId, event }                                                       |
 * | sim:progress        | { runId, phase:'start'|'progress'|'done', done, total, result? }         |
 * | certificate:updated | { certificate }                                                          |
 * | area:focused        | { areaId, workspaceId, editorType }                                      |
 * | area:typeChanged    | { areaId, workspaceId, from, to }                                        |
 * | layout:changed      | { workspaceId, reason }                                                  |
 * | composer:context    | { scopes:string[], scenarioId, areaType, areaId }                        |
 * | workspace:changed   | { activeId, previousId }                                                 |
 * | history:changed     | { canUndo, canRedo, version, size }                                      |
 * | evidence:changed    | { sources }                                                              |
 * | mind:inferred       | { agentId, result }                                                      |
 * | notify:toast        | { id, level, message, detail?, actions?, timeout? }                      |
 * | log:entry           | { entry }                                                                |
 * | lazy:loaded         | { name, ms }                                                             |
 * | lazy:failed         | { name, error }                                                          |
 * | command:run         | { id, args }                                                             |
 * | app:ready           | {}                                                                       |
 *
 * @module core/events
 */
import { leakCounters, toDisposable } from './disposable.js';

export const EVENTS = Object.freeze([
  'theme:changed', 'graph:loaded', 'graph:recomputed', 'delta:applied', 'delta:rejected',
  'selection:changed', 'hover:changed', 'scenario:changed', 'chat:message', 'chat:stream',
  'swarm:event', 'sim:progress', 'certificate:updated', 'area:focused', 'area:typeChanged',
  'layout:changed', 'composer:context', 'workspace:changed', 'history:changed',
  'evidence:changed', 'mind:inferred', 'notify:toast', 'log:entry', 'lazy:loaded',
  'lazy:failed', 'command:run', 'app:ready',
]);
const KNOWN = new Set(EVENTS);

/**
 * @callback Handler
 * @param {any} payload
 * @param {string} type
 */

export class EventBus {
  constructor({ strict = false } = {}) {
    /** @type {Map<string, Set<Handler>>} */
    this._handlers = new Map();
    /** @type {Set<Handler>} */
    this._any = new Set();
    this._strict = strict;
    /** counts emits per type (debug overlay) */
    this.stats = new Map();
  }

  /**
   * Subscribe. Returns a Disposable that unsubscribes.
   * @param {string} type
   * @param {Handler} handler
   */
  on(type, handler) {
    if (this._strict && !KNOWN.has(type)) console.warn(`[events] unknown event "${type}"`);
    let set = this._handlers.get(type);
    if (!set) this._handlers.set(type, (set = new Set()));
    set.add(handler);
    leakCounters.listeners++;
    return toDisposable(() => {
      if (set.delete(handler)) leakCounters.listeners--;
    });
  }

  /**
   * Subscribe for one emission.
   * @param {string} type @param {Handler} handler
   */
  once(type, handler) {
    const d = this.on(type, (p, t) => {
      d.dispose();
      handler(p, t);
    });
    return d;
  }

  /** @param {string} type @param {Handler} handler */
  off(type, handler) {
    const set = this._handlers.get(type);
    if (set && set.delete(handler)) leakCounters.listeners--;
  }

  /** Observe every event (console editor, debug tools). @param {Handler} handler */
  onAny(handler) {
    this._any.add(handler);
    leakCounters.listeners++;
    return toDisposable(() => {
      if (this._any.delete(handler)) leakCounters.listeners--;
    });
  }

  /**
   * Emit synchronously. Handler errors are isolated and logged.
   * @param {string} type @param {any} [payload]
   */
  emit(type, payload) {
    this.stats.set(type, (this.stats.get(type) || 0) + 1);
    const set = this._handlers.get(type);
    if (set) {
      for (const h of [...set]) {
        try { h(payload, type); } catch (err) { console.error(`[events] handler for ${type} failed`, err); }
      }
    }
    for (const h of [...this._any]) {
      try { h(payload, type); } catch (err) { console.error('[events] any-handler failed', err); }
    }
  }

  /** @param {string} type */
  listenerCount(type) {
    return this._handlers.get(type)?.size ?? 0;
  }
}
