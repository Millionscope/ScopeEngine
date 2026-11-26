/**
 * Tooltips and hover cards via event delegation:
 *  - any element with [data-tooltip] gets a delayed tooltip (pointer hover or keyboard focus);
 *  - bound values (.ms-bv) get a scope preview card from a provider registered by main.js
 *    (name, prototype chain, value with p10-p90, provenance, source, "open in…" actions).
 * @module shell/tooltip
 */
import { DisposableStore, listen } from '../core/disposable.js';

const TIP_DELAY = 550;
const CARD_DELAY = 380;

export class TooltipService {
  constructor() {
    this.d = new DisposableStore();
    this.tip = document.createElement('div');
    this.tip.className = 'ms-tooltip';
    this.tip.setAttribute('role', 'tooltip');
    this.tip.id = 'ms-tooltip';
    this.tip.hidden = true;
    (document.getElementById('overlay-root') || document.body).appendChild(this.tip);
    /** @type {((el: HTMLElement) => HTMLElement|null) | null} */
    this.cardProvider = null;
    /** @type {HTMLElement|null} */
    this.card = null;
    this._tipTimer = 0;
    this._cardTimer = 0;
    this._cardHideTimer = 0;
    /** @type {HTMLElement|null} */
    this._tipTarget = null;
    /** @type {HTMLElement|null} */
    this._cardTarget = null;

    this.d.add(listen(document, 'pointerover', (e) => this._over(/** @type {PointerEvent} */ (e))));
    this.d.add(listen(document, 'pointerout', (e) => this._out(/** @type {PointerEvent} */ (e))));
    this.d.add(listen(document, 'focusin', (e) => this._focus(/** @type {FocusEvent} */ (e))));
    this.d.add(listen(document, 'focusout', () => this.hideTip()));
    this.d.add(listen(document, 'pointerdown', (e) => {
      this.hideTip();
      const t = /** @type {HTMLElement} */ (e.target);
      if (this.card && !this.card.contains(t)) this.hideCard();
    }, true));
    this.d.add(listen(document, 'keydown', (e) => {
      if (/** @type {KeyboardEvent} */ (e).key === 'Escape') { this.hideTip(); this.hideCard(); }
    }));
    this.d.add(listen(window, 'scroll', () => { this.hideTip(); }, true));
  }

  /** @param {(el: HTMLElement) => HTMLElement|null} fn */
  setCardProvider(fn) {
    this.cardProvider = fn;
  }

  /** @param {PointerEvent} e */
  _over(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!(t instanceof Element)) return;
    const bv = /** @type {HTMLElement|null} */ (t.closest('.ms-bv'));
    if (bv && this.cardProvider) {
      clearTimeout(this._cardHideTimer);
      if (this._cardTarget !== bv) {
        clearTimeout(this._cardTimer);
        this._cardTimer = setTimeout(() => this.showCard(bv), CARD_DELAY);
      }
      return;
    }
    if (this.card && t.closest('.ms-card')) {
      clearTimeout(this._cardHideTimer);
      return;
    }
    const host = /** @type {HTMLElement|null} */ (t.closest('[data-tooltip]'));
    if (host && host !== this._tipTarget) {
      clearTimeout(this._tipTimer);
      this._tipTimer = setTimeout(() => this.showTip(host), TIP_DELAY);
    }
  }

  /** @param {PointerEvent} e */
  _out(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const rel = /** @type {HTMLElement|null} */ (e.relatedTarget);
    if (!(t instanceof Element)) return;
    const host = t.closest('[data-tooltip]');
    if (host && (!rel || !host.contains(rel))) {
      clearTimeout(this._tipTimer);
      if (this._tipTarget === host) this.hideTip();
    }
    const bv = t.closest('.ms-bv');
    const fromCard = t.closest('.ms-card');
    if ((bv || fromCard) && !(rel && (rel.closest?.('.ms-card') || (bv && bv.contains(rel))))) {
      clearTimeout(this._cardTimer);
      if (this._cardTarget === bv) this._cardTarget = null;
      clearTimeout(this._cardHideTimer);
      this._cardHideTimer = setTimeout(() => this.hideCard(), 260);
    }
  }

  /** @param {FocusEvent} e */
  _focus(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!(t instanceof Element) || !t.matches(':focus-visible')) return;
    const host = /** @type {HTMLElement|null} */ (t.closest('[data-tooltip]'));
    if (host) {
      clearTimeout(this._tipTimer);
      this._tipTimer = setTimeout(() => this.showTip(host), TIP_DELAY);
    }
  }

  /** @param {HTMLElement} host */
  showTip(host) {
    if (!host.isConnected) return;
    const text = host.dataset.tooltip;
    if (!text) return;
    this._tipTarget = host;
    this.tip.textContent = text;
    if (host.dataset.tooltipKey) {
      const k = document.createElement('span');
      k.className = 'ms-kbd';
      k.textContent = host.dataset.tooltipKey;
      this.tip.appendChild(k);
    }
    this.tip.hidden = false;
    host.setAttribute('aria-describedby', 'ms-tooltip');
    const r = host.getBoundingClientRect();
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.bottom + 6;
    if (y + th > window.innerHeight - 4) y = r.top - th - 6;
    x = Math.max(4, Math.min(x, window.innerWidth - tw - 4));
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }

  hideTip() {
    clearTimeout(this._tipTimer);
    if (this._tipTarget) this._tipTarget.removeAttribute('aria-describedby');
    this._tipTarget = null;
    this.tip.hidden = true;
  }

  /** @param {HTMLElement} bv */
  showCard(bv) {
    if (!bv.isConnected || !this.cardProvider) return;
    this.hideTip();
    const card = this.cardProvider(bv);
    if (!card) return;
    this.hideCard();
    this._cardTarget = bv;
    this.card = card;
    card.classList.add('ms-card');
    card.setAttribute('role', 'dialog');
    (document.getElementById('overlay-root') || document.body).appendChild(card);
    const r = bv.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let x = r.left;
    let y = r.bottom + 6;
    if (y + ch > window.innerHeight - 8) y = Math.max(8, r.top - ch - 6);
    x = Math.max(8, Math.min(x, window.innerWidth - cw - 8));
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.addEventListener('pointerleave', () => {
      clearTimeout(this._cardHideTimer);
      this._cardHideTimer = setTimeout(() => this.hideCard(), 260);
    });
    card.addEventListener('pointerenter', () => clearTimeout(this._cardHideTimer));
  }

  hideCard() {
    clearTimeout(this._cardTimer);
    clearTimeout(this._cardHideTimer);
    this.card?.remove();
    this.card = null;
    this._cardTarget = null;
  }

  dispose() {
    this.d.dispose();
    this.tip.remove();
    this.hideCard();
  }
}
