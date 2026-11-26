/**
 * Toast renderer for notify:toast events (notifications.* tokens). Max 4 visible.
 * @module shell/toast
 */
import { DisposableStore, listen } from '../core/disposable.js';

const ICONS = { info: 'info', success: 'pass', warn: 'warning', error: 'error' };

export class ToastHost {
  /** @param {{events: import('../core/events.js').EventBus}} deps */
  constructor({ events }) {
    this.d = new DisposableStore();
    this.el = document.createElement('div');
    this.el.className = 'ms-toasts';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Notifications');
    (document.getElementById('overlay-root') || document.body).appendChild(this.el);
    this.d.add(events.on('notify:toast', (t) => this.show(t)));
  }

  /** @param {import('../services/notify.js').Toast} t */
  show(t) {
    const box = document.createElement('div');
    box.className = 'ms-toast';
    box.dataset.level = t.level;
    box.setAttribute('role', t.level === 'error' ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.className = `codicon codicon-${ICONS[t.level] || 'info'}`;
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    body.className = 'ms-toast-body';
    const msg = document.createElement('div');
    msg.textContent = t.message;
    body.appendChild(msg);
    if (t.detail) {
      const det = document.createElement('div');
      det.className = 'ms-toast-detail';
      det.textContent = t.detail;
      body.appendChild(det);
    }
    const d = new DisposableStore();
    const close = () => {
      d.dispose();
      box.remove();
    };
    if (t.actions?.length) {
      const row = document.createElement('div');
      row.className = 'ms-toast-actions';
      for (const a of t.actions) {
        const b = document.createElement('button');
        b.className = a.primary === false ? 'ms-btn is-secondary is-small' : 'ms-btn is-small';
        b.textContent = a.label;
        d.add(listen(b, 'click', () => { close(); a.run(); }));
        row.appendChild(b);
      }
      body.appendChild(row);
    }
    const x = document.createElement('button');
    x.className = 'ms-icon-btn is-small';
    x.setAttribute('aria-label', 'Dismiss notification');
    x.innerHTML = '<span class="codicon codicon-close" aria-hidden="true"></span>';
    d.add(listen(x, 'click', close));
    box.append(icon, body, x);
    this.el.appendChild(box);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    if (t.timeout) {
      let id = setTimeout(close, t.timeout);
      d.add({ dispose: () => clearTimeout(id) });
      d.add(listen(box, 'pointerenter', () => clearTimeout(id)));
      d.add(listen(box, 'pointerleave', () => { clearTimeout(id); id = setTimeout(close, 2500); }));
    }
  }

  dispose() {
    this.d.dispose();
    this.el.remove();
  }
}
