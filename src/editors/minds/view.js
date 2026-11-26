/**
 * Shared pieces of the Minds views: DOM helpers, the party strip ("simulation, not
 * assessment" banner + LOD chip), meters without numerals, the affect decay curve and the
 * speech block. No graph numbers are rendered here as text: values beside these visuals are
 * BoundValues created by the views.
 * @module editors/minds/view
 */

const NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {Object} MindsHost
 * @property {any} ctx                      EditorContext
 * @property {any} d3
 * @property {import('../shared/bound-value.js').BoundValues} bv
 * @property {any} mind                     MindService
 * @property {any} owner                    the editor (scheduler visibility)
 * @property {boolean} table                show tables instead of charts
 * @property {'tree'|'radial'} layout       nested-beliefs layout
 * @property {() => number} width           panel content width
 * @property {() => number} height          panel content height
 * @property {() => boolean} reducedMotion
 * @property {() => string|null} agentId
 * @property {(ids: string[]) => void} select
 * @property {(id: string|null) => void} hover
 * @property {(agentId: string, tab?: string) => void} open
 * @property {(layout: 'tree'|'radial') => void} setLayout
 * @property {() => void} infer
 */

/**
 * @param {string} tag @param {string} [cls] @param {string|null} [text]
 * @returns {HTMLElement}
 */
export function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** @param {string} tag @param {Record<string, string|number>} [attrs] */
export function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** @param {string} name */
export function icon(name) {
  const s = document.createElement('span');
  s.className = `codicon codicon-${name}`;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

/** Text button (no numerals). @param {string} label @param {string} iconName @param {() => void} run @param {string} [cls] */
export function button(label, iconName, run, cls = 'ms-btn is-secondary is-small') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  if (iconName) b.appendChild(icon(iconName));
  b.appendChild(document.createTextNode(label));
  b.addEventListener('click', run);
  return b;
}

/** The "simulation, not assessment" banner shown on every party header. */
export function simBanner() {
  const b = h('span', 'ms-sim-banner');
  b.append(icon('beaker'), document.createTextNode('simulation, not assessment'));
  b.title = 'A model of how a real, identifiable person might act in this situation. It is not an assessment of the person.';
  return b;
}

const LOD_TEXT = {
  L0: 'population statistics only',
  L1: 'simple behavioral rules',
  L2: 'goals, beliefs and relationships',
  L3: 'goals, beliefs, relationships and nested models of other parties',
};

/** Level-of-detail chip. @param {string} lod */
export function lodChip(lod) {
  const c = h('span', 'ms-chip is-lod', lod);
  c.title = `Level of detail ${lod}: ${LOD_TEXT[lod] || 'agent model'}`;
  c.setAttribute('aria-label', `level of detail ${lod}`);
  return c;
}

/**
 * Header strip for the per-party tabs: name, role, LOD chip and the banner.
 * @param {any} m party profile @param {MindsHost} host
 */
export function partyStrip(m, host) {
  const strip = h('div', 'ms-mind-strip');
  const name = /** @type {HTMLButtonElement} */ (h('button', 'ms-mind-name', m.name));
  name.type = 'button';
  name.title = 'Select this Mind Scope';
  name.addEventListener('click', () => host.select([m.id]));
  const role = h('span', 'ms-mind-role', m.role);
  const spacer = h('span', 'ms-mind-spacer');
  strip.append(icon('person'), name, role, spacer, lodChip(m.lod), simBanner());
  return strip;
}

/**
 * Bar meter without numerals (the value beside it is a BoundValue, or the exact number is in
 * the aria label for profile constants).
 * @param {{diverging?: boolean, label?: string}} [opts]
 */
export function meter(opts = {}) {
  const m = h('span', `ms-mind-meter${opts.diverging ? ' is-diverging' : ''}`);
  const fill = h('span', 'ms-mind-meter-fill');
  m.appendChild(fill);
  if (opts.label) {
    m.setAttribute('role', 'img');
    m.setAttribute('aria-label', opts.label);
  } else {
    m.setAttribute('aria-hidden', 'true');
  }
  return m;
}

/**
 * @param {HTMLElement} m @param {number} v
 * @param {{min?: number, max?: number, diverging?: boolean}} [opts]
 */
export function setMeter(m, v, opts = {}) {
  const min = opts.min ?? (opts.diverging ? -1 : 0);
  const max = opts.max ?? 1;
  const fill = /** @type {HTMLElement} */ (m.firstElementChild);
  const t = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
  if (opts.diverging) {
    const mid = (0 - min) / (max - min);
    const a = Math.min(t, mid);
    const b = Math.max(t, mid);
    fill.style.left = `${a * 100}%`;
    fill.style.width = `${Math.max(0.5, (b - a) * 100)}%`;
    m.dataset.sign = v < 0 ? 'neg' : 'pos';
  } else {
    fill.style.left = '0';
    fill.style.width = `${t * 100}%`;
  }
}

/**
 * Affect decay: the current value relaxing toward neutral at the profile's decay rate.
 * @param {number} value @param {number} decay per step @param {boolean} diverging
 */
export function decayCurve(value, decay, diverging) {
  const w = 52;
  const hgt = 16;
  const svg = /** @type {SVGSVGElement} */ (svgEl('svg', { class: 'ms-mind-decay', width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}` }));
  const steps = 12;
  const y = (v) => (diverging ? hgt / 2 - (v * (hgt / 2 - 1.5)) : hgt - 1.5 - v * (hgt - 3));
  const base = diverging ? hgt / 2 : hgt - 1.5;
  svg.appendChild(svgEl('line', { class: 'base', x1: 0, x2: w, y1: base, y2: base }));
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const v = (Number.isFinite(value) ? value : 0) * Math.exp(-decay * i);
    d += `${i ? 'L' : 'M'}${((i / steps) * (w - 2) + 1).toFixed(1)},${y(v).toFixed(1)}`;
  }
  svg.appendChild(svgEl('path', { class: 'curve', d }));
  const halfLife = Math.log(2) / Math.max(1e-6, decay);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `decays toward neutral, half-life about ${halfLife.toFixed(1)} steps (profile constant)`);
  const t = svgEl('title');
  t.textContent = `Decays toward neutral at ${decay} per step (half-life about ${halfLife.toFixed(1)} steps). Profile constant, not a graph metric.`;
  svg.appendChild(t);
  return svg;
}

/** Qualitative reciprocity (profile constant in [-1, 1]). @param {number} r */
export function reciprocityWord(r) {
  if (r >= 0.3) return 'reciprocal';
  if (r >= 0.1) return 'slightly reciprocal';
  if (r > -0.1) return 'neutral';
  if (r > -0.3) return 'slightly adversarial';
  return 'adversarial';
}

/** Qualitative level in [0, 1] (profile constants). @param {number} v */
export function levelWord(v) {
  if (v >= 0.8) return 'high';
  if (v >= 0.55) return 'moderate';
  if (v >= 0.3) return 'low';
  return 'very low';
}

/** @param {string} type */
export function sourceIcon(type) {
  switch (String(type || '').toUpperCase()) {
    case 'PDF': return 'file-pdf';
    case 'CSV': return 'database';
    case 'WEB': return 'globe';
    case 'API': return 'json';
    default: return 'file';
  }
}

/** 'Agent: “several …”' -> 'several …' ; '“X.”' -> 'X.' @param {string} text */
export function stripQuote(text) {
  const s = String(text || '').trim();
  const m = /^[^:“”"]{1,40}:\s*[“"](.+)[”"]$/.exec(s) || /^[“"](.+)[”"]$/.exec(s);
  return m ? m[1] : s;
}

/** @param {string} who */
function initials(who) {
  const words = String(who || '?').replace(/[’'`]s\b/g, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

/**
 * Speech on record, styled as a simulation voice (never like the assistant).
 * @param {string} who @param {string} text @param {string} [label]
 */
export function speechBlock(who, text, label = 'observed speech') {
  const box = h('div', 'ms-sim-voice ms-mind-speech');
  const av = h('span', 'ms-sim-voice-avatar', initials(who));
  av.setAttribute('aria-hidden', 'true');
  const head = h('div', 'ms-mind-speech-head');
  const lab = h('span', 'ms-sim-voice-label');
  lab.append(icon('quote'), document.createTextNode(label));
  head.append(lab, h('span', 'ms-sim-voice-who', who));
  const q = h('q', null, stripQuote(text));
  box.append(av, head, q);
  return box;
}

/** Signed number with a true minus sign (computed values, not graph metrics). @param {number} v @param {number} [d] */
export function signed(v, d = 2) {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(d);
  if (Number(s) === 0) return s;
  return `${v < 0 ? '−' : '+'}${s}`;
}

/** Evidence strength words for a log Bayes factor. @param {number} lbf */
export function strengthWord(lbf) {
  const a = Math.abs(lbf);
  if (a < 0.2) return 'barely moves it';
  if (a < 0.7) return 'weak';
  if (a < 1.5) return 'moderate';
  return 'strong';
}
