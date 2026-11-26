/**
 * Distribution editor (shared by Controls and Properties): family dropdown, parameter fields
 * (median/p90, mean/sd, alpha/beta, min/max, min/mode/max) and a live mini PDF preview.
 * Emits onChange(spec, {final}) while typing/dragging (final=false) and on commit (final=true).
 * @module editors/shared/dist-editor
 */
import { FAMILY_PARAMS, convertFamily, describe, makeDist, validateDist } from '../../model/distributions.js';

const NS = 'http://www.w3.org/2000/svg';

export class DistEditor {
  /**
   * @param {{
   *   spec: any,
   *   unit?: string,
   *   onChange: (spec: any, info: {final: boolean}) => void,
   *   compact?: boolean,
   *   color?: string,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.spec = { ...opts.spec };
    this.el = document.createElement('div');
    this.el.className = 'ms-dist-editor';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Distribution editor');
    this.family = document.createElement('select');
    this.family.className = 'ms-select is-small';
    this.family.setAttribute('aria-label', 'Distribution family');
    for (const f of Object.keys(FAMILY_PARAMS)) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      this.family.appendChild(o);
    }
    if (this.spec.family === 'Mixture') {
      const o = document.createElement('option');
      o.value = 'Mixture';
      o.textContent = 'Mixture (contested)';
      this.family.appendChild(o);
    }
    this.params = document.createElement('div');
    this.params.className = 'ms-dist-params';
    this.preview = /** @type {SVGSVGElement} */ (document.createElementNS(NS, 'svg'));
    this.preview.setAttribute('class', 'ms-dist-preview');
    this.preview.setAttribute('role', 'img');
    this.desc = document.createElement('div');
    this.desc.className = 'ms-dist-desc ms-mono ms-muted';
    const row = document.createElement('div');
    row.className = 'ms-row ms-dist-row';
    row.append(this.family, this.params);
    this.el.append(row, this.preview, this.desc);
    this.family.addEventListener('change', () => {
      const next = convertFamily(this.spec, this.family.value);
      this.spec = next;
      this.renderParams();
      this.renderPreview();
      this.opts.onChange(this.spec, { final: true });
    });
    this.renderParams();
    this.renderPreview();
  }

  /** External update (e.g. after undo) without firing onChange. @param {any} spec */
  setSpec(spec) {
    this.spec = { ...spec };
    this.renderParams();
    this.renderPreview();
  }

  renderParams() {
    this.family.value = this.spec.family;
    this.params.replaceChildren();
    const names = FAMILY_PARAMS[this.spec.family] || [];
    if (this.spec.family === 'Mixture') {
      const span = document.createElement('span');
      span.className = 'ms-small ms-muted';
      span.textContent = `${this.spec.components.length} components, flagged contested`;
      this.params.appendChild(span);
      return;
    }
    for (const p of names) {
      const lab = document.createElement('label');
      lab.className = 'ms-dist-param';
      const t = document.createElement('span');
      t.className = 'ms-unit';
      t.textContent = p;
      const inp = document.createElement('input');
      inp.className = 'ms-num-input';
      inp.type = 'number';
      inp.step = 'any';
      inp.value = String(round(this.spec[p]));
      inp.setAttribute('aria-label', `${this.spec.family} ${p}`);
      const apply = (final) => {
        const v = Number(inp.value);
        if (!Number.isFinite(v)) { inp.classList.add('is-invalid'); return; }
        const next = { ...this.spec, [p]: v };
        const err = validateDist(next);
        inp.classList.toggle('is-invalid', !!err);
        inp.title = err || '';
        if (err) return;
        this.spec = next;
        this.renderPreview();
        this.opts.onChange(this.spec, { final });
      };
      inp.addEventListener('input', () => apply(false));
      inp.addEventListener('change', () => apply(true));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(true); });
      lab.append(t, inp);
      this.params.appendChild(lab);
    }
  }

  renderPreview() {
    const svg = this.preview;
    while (svg.firstChild) svg.firstChild.remove();
    const w = 200;
    const h = this.opts.compact ? 28 : 40;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    let d;
    try { d = makeDist(this.spec); } catch { return; }
    const lo = d.quantile(0.005);
    const hi = d.quantile(0.995);
    if (!(hi > lo)) return;
    const N = 64;
    const ys = [];
    for (let i = 0; i < N; i++) ys.push(d.pdf(lo + ((hi - lo) * i) / (N - 1)));
    const max = Math.max(...ys.filter(Number.isFinite)) || 1;
    const pts = ys.map((y, i) => `${((i / (N - 1)) * w).toFixed(1)},${(h - 1 - (Math.min(max, y) / max) * (h - 3)).toFixed(1)}`);
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('d', `M0,${h} L${pts.join(' L')} L${w},${h} Z`);
    area.setAttribute('class', 'area');
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', `M${pts.join(' L')}`);
    line.setAttribute('class', 'line');
    svg.append(area, line);
    // p10 / p50 / p90 ticks
    for (const q of [0.1, 0.5, 0.9]) {
      const x = ((d.quantile(q) - lo) / (hi - lo)) * w;
      const t = document.createElementNS(NS, 'line');
      t.setAttribute('x1', x.toFixed(1));
      t.setAttribute('x2', x.toFixed(1));
      t.setAttribute('y1', String(h));
      t.setAttribute('y2', String(q === 0.5 ? 2 : h * 0.45));
      t.setAttribute('class', q === 0.5 ? 'tick is-mid' : 'tick');
      svg.appendChild(t);
    }
    svg.setAttribute('aria-label', `${describe(this.spec)}: p10 ${round(d.quantile(0.1))}, p50 ${round(d.quantile(0.5))}, p90 ${round(d.quantile(0.9))}`);
    this.desc.textContent = `${describe(this.spec)} · p10 ${round(d.quantile(0.1))} · p50 ${round(d.quantile(0.5))} · p90 ${round(d.quantile(0.9))}${this.opts.unit ? ` ${this.opts.unit}` : ''}`;
  }

  dispose() {
    this.el.remove();
  }
}

/** @param {number} x */
function round(x) {
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  if (a >= 1000) return Math.round(x);
  if (a >= 10) return Math.round(x * 10) / 10;
  if (a >= 1) return Math.round(x * 100) / 100;
  return Number(x.toPrecision(3));
}
