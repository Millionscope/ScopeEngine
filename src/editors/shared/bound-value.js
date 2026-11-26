/**
 * Bound values: every displayed number is a span linked to a scope metric.
 *
 *   <span class="ms-bv" data-node="sc_bakery.monthly_cash" data-stat="p50" data-fmt="usd">$3,671●</span>
 *
 * Renders the formatted value and a provenance glyph; click selects the metric everywhere;
 * hover emits hover:changed (the shell shows the scope preview card); flashes when its value
 * changes after a recompute. BoundValues keeps an index node -> spans per editor so
 * onRecompute only touches spans whose node changed.
 * @module editors/shared/bound-value
 */
import { formatAs } from '../../model/format.js';
import { defaultFmt, parseTemplate, resolveSegments, statValue } from '../../model/binding.js';
import { PROVENANCE } from '../../theme/tokens.js';

let liveCount = 0;
/** Live bound-value spans across all editors (debug overlay). */
export function boundValueCount() { return liveCount; }

/**
 * @typedef {Object} BindSpec
 * @property {string} node
 * @property {string=} stat         value | p10 | p50 | p90 | mean | sd | min | max
 * @property {string|null=} fmt
 * @property {string|null=} scenario
 * @property {boolean=} glyph        show the provenance glyph (default true)
 * @property {boolean=} plain        inherit text color (tables)
 * @property {boolean=} interval     append p10–p90 in a tooltip (default true)
 */

export class BoundValues {
  /**
   * @param {{ engine: any, services: any, scenarioId?: () => string|null, onClick?: (node: string, e: MouseEvent) => void }} opts
   */
  constructor(opts) {
    this.engine = opts.engine;
    this.services = opts.services;
    this.scenarioId = opts.scenarioId || (() => null);
    this.onClick = opts.onClick;
    /** @type {Map<string, Set<HTMLElement>>} */
    this.byNode = new Map();
    /** @type {Set<HTMLElement>} */
    this.all = new Set();
    this._onClick = (e) => {
      const el = /** @type {HTMLElement} */ (e.currentTarget);
      const node = /** @type {string} */ (el.dataset.node);
      e.stopPropagation();
      if (this.onClick) this.onClick(node, e);
      else this.services.selection?.select([node], { mode: e.ctrlKey || e.metaKey ? 'toggle' : 'replace', source: 'bound-value' });
    };
    this._onKey = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        /** @type {HTMLElement} */ (e.currentTarget).click();
      }
    };
    this._onEnter = (e) => this.services.selection?.hover(/** @type {HTMLElement} */ (e.currentTarget).dataset.node || null, 'bound-value');
    this._onLeave = () => this.services.selection?.hover(null, 'bound-value');
  }

  /**
   * Create a bound span.
   * @param {BindSpec} spec
   * @returns {HTMLElement}
   */
  create(spec) {
    const el = document.createElement('span');
    el.className = 'ms-bv' + (spec.plain ? ' is-plain' : '');
    el.dataset.node = spec.node;
    el.dataset.stat = spec.stat || 'value';
    if (spec.fmt) el.dataset.fmt = spec.fmt;
    if (spec.scenario) el.dataset.scenario = spec.scenario;
    if (spec.glyph === false) el.dataset.noglyph = '1';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', this._onClick);
    el.addEventListener('keydown', this._onKey);
    el.addEventListener('pointerenter', this._onEnter);
    el.addEventListener('pointerleave', this._onLeave);
    let set = this.byNode.get(spec.node);
    if (!set) this.byNode.set(spec.node, (set = new Set()));
    set.add(el);
    this.all.add(el);
    liveCount++;
    this.render(el, false);
    return el;
  }

  /**
   * (Re)render one span. @param {HTMLElement} el @param {boolean} flash
   */
  render(el, flash) {
    const node = /** @type {string} */ (el.dataset.node);
    const g = this.engine.graph;
    const n = g.node(node);
    if (!n) {
      el.textContent = '—';
      el.classList.add('is-unbound');
      el.setAttribute('aria-label', `unbound value ${node}`);
      return;
    }
    const scen = el.dataset.scenario || this.scenarioId() || null;
    const view = this.engine.view(scen);
    const stat = el.dataset.stat || 'value';
    const v = statValue(view, node, stat);
    const unit = n.type.unit;
    const text = formatAs(v, el.dataset.fmt || defaultFmt(unit), unit);
    const prov = g.displayProv(node);
    const prev = el.dataset.text;
    if (prev === text && el.dataset.prov === prov) return;
    el.dataset.text = text;
    el.dataset.prov = prov;
    el.textContent = text;
    if (!el.dataset.noglyph) {
      const p = PROVENANCE[prov] || PROVENANCE.computed;
      const gl = document.createElement('span');
      gl.className = 'ms-prov';
      gl.dataset.prov = prov;
      gl.textContent = p.glyph;
      gl.setAttribute('aria-hidden', 'true');
      el.appendChild(gl);
    }
    const p = PROVENANCE[prov] || PROVENANCE.computed;
    const statLabel = stat === 'value' ? '' : ` ${stat}`;
    el.setAttribute('aria-label', `${g.path(node)}${statLabel} ${text}, ${p.label}${scen && scen !== 'base' ? `, scenario ${this.engine.scenarios.get(scen)?.name || scen}` : ''}. Press Enter to select.`);
    if (flash && prev !== undefined && !this.reducedMotion()) {
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
    }
  }

  reducedMotion() {
    return document.documentElement.classList.contains('ms-reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Update spans whose node changed. @param {Iterable<string>} changedIds */
  update(changedIds) {
    for (const id of changedIds) {
      const set = this.byNode.get(id);
      if (!set) continue;
      for (const el of set) {
        if (!el.isConnected) { this._forget(el); continue; }
        this.render(el, true);
      }
    }
  }

  /** Re-render every span (scenario switch, theme, structure). @param {boolean} [flash] */
  updateAll(flash = false) {
    for (const el of [...this.all]) {
      if (!el.isConnected) { this._forget(el); continue; }
      this.render(el, flash);
    }
  }

  /** Highlight spans for a hovered node. @param {string|null} id */
  hover(id) {
    for (const el of this.all) el.classList.toggle('is-hovered', !!id && el.dataset.node === id);
  }

  /** @param {string[]} ids */
  select(ids) {
    const set = new Set(ids);
    for (const el of this.all) el.classList.toggle('is-selected', set.has(/** @type {string} */ (el.dataset.node)));
  }

  /** Forget spans inside a container being removed. @param {HTMLElement} root */
  releaseWithin(root) {
    for (const el of [...this.all]) if (root.contains(el)) this._forget(el);
  }

  /** @param {HTMLElement} el */
  _forget(el) {
    if (!this.all.delete(el)) return;
    liveCount--;
    el.removeEventListener('click', this._onClick);
    el.removeEventListener('keydown', this._onKey);
    el.removeEventListener('pointerenter', this._onEnter);
    el.removeEventListener('pointerleave', this._onLeave);
    const set = this.byNode.get(/** @type {string} */ (el.dataset.node));
    set?.delete(el);
  }

  get size() { return this.all.size; }

  dispose() {
    for (const el of [...this.all]) this._forget(el);
    this.byNode.clear();
  }
}

/**
 * Render a template with **bold**, `code`, paragraphs and {{bindings}} into an element.
 * Bindings become bound spans registered in `bv` (or plain text without a registry).
 * @param {HTMLElement} el
 * @param {string} template
 * @param {{ engine: any, graph?: any, scenarioId?: string|null, bv?: BoundValues }} ctx
 */
export function renderTemplateInto(el, template, ctx) {
  if (ctx.bv) ctx.bv.releaseWithin(el);
  el.replaceChildren();
  const graph = ctx.graph || ctx.engine.graph;
  const paragraphs = String(template).split(/\n{2,}/);
  for (const para of paragraphs) {
    const p = document.createElement('p');
    const segs = resolveSegments(parseTemplate(para), graph);
    for (const s of segs) {
      if (s.type === 'text') appendMarkdown(p, s.text);
      else if (!s.nodeId) {
        const bad = document.createElement('span');
        bad.className = 'ms-bv is-unbound';
        bad.textContent = `[${s.path}]`;
        bad.title = s.error || 'unbound reference';
        p.appendChild(bad);
      } else if (ctx.bv) {
        p.appendChild(ctx.bv.create({ node: s.nodeId, stat: s.stat, fmt: s.fmt, scenario: s.scenario || ctx.scenarioId || null }));
      } else {
        const view = ctx.engine.view(s.scenario || ctx.scenarioId || null);
        const unit = graph.node(s.nodeId)?.type.unit || '';
        const span = document.createElement('span');
        span.className = 'ms-bv';
        span.dataset.node = s.nodeId;
        span.dataset.stat = s.stat;
        span.textContent = formatAs(statValue(view, s.nodeId, s.stat), s.fmt || defaultFmt(unit), unit);
        p.appendChild(span);
      }
    }
    el.appendChild(p);
  }
  return el;
}

/**
 * Minimal inline markdown: **bold**, `code`, and line breaks. Text only (no HTML injection).
 * @param {HTMLElement} parent @param {string} text
 */
export function appendMarkdown(parent, text) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\n)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok === '\n') parent.appendChild(document.createElement('br'));
    else if (tok.startsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = tok.slice(2, -2);
      parent.appendChild(b);
    } else {
      const c = document.createElement('code');
      c.className = 'ms-inline';
      c.textContent = tok.slice(1, -1);
      parent.appendChild(c);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
