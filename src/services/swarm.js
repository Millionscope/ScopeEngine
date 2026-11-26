/**
 * Swarm feed: builds (one per question or structural request), role states and events, plus
 * Delphi rounds for estimated metrics. Emits swarm:event. No DOM.
 * @module services/swarm
 */
import { uid } from '../core/ids.js';
import { ROLES } from '../mock/swarm-script.js';

/**
 * @typedef {Object} SwarmEvent
 * @property {string} id
 * @property {number} time
 * @property {string} role
 * @property {'plan'|'propose'|'research'|'estimate'|'review'|'explain'|'verify'} kind
 * @property {string} text
 * @property {'thinking'|'proposed'|'accepted'|'rejected'} outcome
 * @property {string=} reason          verifier message when rejected
 * @property {string=} hint
 * @property {number=} level           verification ladder level that decided
 * @property {string=} nodeId
 * @property {any=} delta
 * @property {any=} delphi
 */

/**
 * @typedef {Object} Build
 * @property {string} id
 * @property {string} title
 * @property {number} tokens
 * @property {number} started
 * @property {number|null} ended
 * @property {boolean} historical
 * @property {SwarmEvent[]} events
 * @property {Record<string, string>} roles     role -> idle|thinking|proposed|accepted|rejected|done
 * @property {any[]} delphi
 */

export class SwarmService {
  /**
   * @param {{events: import('../core/events.js').EventBus, store: import('../core/store.js').Store}} deps
   */
  constructor({ events, store }) {
    this.events = events;
    this.store = store;
    /** @type {Build[]} */
    this.builds = [];
    /** @type {Build|null} */
    this.current = null;
    this.roles = ROLES;
  }

  /** @param {{title: string, tokens: number, historical?: boolean}} script */
  startBuild(script) {
    /** @type {Build} */
    const b = {
      id: uid('bld'),
      title: script.title,
      tokens: script.tokens,
      started: Date.now(),
      ended: null,
      historical: !!script.historical,
      events: [],
      roles: Object.fromEntries(ROLES.map((r) => [r, 'idle'])),
      delphi: [],
    };
    this.builds.push(b);
    if (!b.historical) {
      this.current = b;
      this.store.set('status.swarm', { running: true, roles: 0, label: '' });
    }
    this.events.emit('swarm:event', { buildId: b.id, event: null, type: 'start' });
    return b;
  }

  /**
   * @param {Build} b
   * @param {Omit<SwarmEvent, 'id'|'time'>} ev
   */
  push(b, ev) {
    /** @type {SwarmEvent} */
    const e = { id: uid('se'), time: Date.now(), ...ev };
    b.events.push(e);
    const roleKey = ev.role.startsWith('Estimator') && ev.delphi ? null : ev.role;
    if (roleKey) b.roles[roleKey] = ev.outcome;
    if (ev.delphi) {
      b.delphi.push({ ...ev.delphi, eventId: e.id });
      for (const r of ev.delphi.round1 || []) b.roles[r.role] = 'proposed';
    }
    if (!b.historical) {
      const active = Object.values(b.roles).filter((s) => s !== 'idle').length;
      this.store.set('status.swarm', { running: true, roles: active, label: '' });
      this.store.set('status.message', `${ev.role}: ${ev.text.length > 60 ? ev.text.slice(0, 59) + '…' : ev.text}`);
    }
    this.events.emit('swarm:event', { buildId: b.id, event: e, type: 'event' });
    return e;
  }

  /** Update an event in place (e.g. proposed -> accepted). @param {Build} b @param {SwarmEvent} e @param {Partial<SwarmEvent>} patch */
  update(b, e, patch) {
    Object.assign(e, patch);
    if (patch.outcome && !e.delphi) b.roles[e.role] = patch.outcome;
    this.events.emit('swarm:event', { buildId: b.id, event: e, type: 'update' });
  }

  /** @param {Build} b */
  end(b) {
    b.ended = Date.now();
    for (const r of Object.keys(b.roles)) if (b.roles[r] !== 'idle' && b.roles[r] !== 'rejected') b.roles[r] = 'done';
    if (this.current === b) {
      this.current = null;
      const n = b.events.length;
      this.store.set('status.swarm', { running: false, roles: 0, label: `Swarm · ${n} events` });
      this.store.set('status.message', '');
    }
    this.events.emit('swarm:event', { buildId: b.id, event: null, type: 'end' });
  }

  /** @param {string} id */
  get(id) {
    return this.builds.find((b) => b.id === id) || null;
  }

  last() {
    return this.builds[this.builds.length - 1] || null;
  }
}
