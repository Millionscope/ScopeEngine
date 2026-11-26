/**
 * Claims: for statements a modeled party made, the probability that the statement is
 * accurate, with its reasons (belief, incentive, consistency). A probability with reasons,
 * not a verdict. Computed by mind.truthfulness (reason probabilities combined in log-odds);
 * not a graph metric.
 * @module editors/minds/claims
 */
import { provMark } from '../shared/prov-mark.js';
import { emptyState } from '../shared/empty-state.js';
import { pct } from '../../model/format.js';
import { h, icon, partyStrip, speechBlock, meter, setMeter } from './view.js';

const REASON = {
  belief: { icon: 'lightbulb', label: 'Belief', hint: 'would they know it?' },
  incentive: { icon: 'law', label: 'Incentive', hint: 'what does saying it gain them?' },
  consistency: { icon: 'git-compare', label: 'Consistency', hint: 'does it fit what they did?' },
};

export class ClaimsView {
  /**
   * @param {HTMLElement} el @param {any[]} parties @param {any} m selected party
   * @param {import('./view.js').MindsHost} host
   */
  constructor(el, parties, m, host) {
    this.host = host;
    const wrap = h('div', 'ms-mind-claims');
    wrap.appendChild(partyStrip(m, host));
    if (!m.claims.length) {
      const other = parties.find((p) => p.claims.length);
      wrap.appendChild(emptyState({
        icon: 'comment-discussion',
        title: `No claims recorded for ${m.name}`,
        text: 'Claims are statements a party made that matter to the decision.',
        action: other ? { label: `Show ${other.name}’s claims`, run: () => host.open(other.id, 'claims') } : undefined,
      }));
      el.appendChild(wrap);
      return;
    }
    for (const c of m.claims) wrap.appendChild(this.claimCard(m, c));
    const foot = h('p', 'ms-mind-foot-note', 'Each reason is a probability the statement is accurate given one consideration; the three are combined in log-odds with equal weights. The person is real: this is a model of the situation, not an assessment of them.');
    wrap.appendChild(foot);
    el.appendChild(wrap);
  }

  /** @param {any} m @param {any} c */
  claimCard(m, c) {
    const t = this.host.mind.truthfulness(m.id, c.id);
    const card = h('article', 'ms-pcard ms-mind-claim');
    card.setAttribute('aria-label', `Claim by ${c.who}`);
    const body = h('div', 'ms-pcard-body');
    body.appendChild(speechBlock(c.who, c.text, 'claim on record'));
    if (!t) {
      body.appendChild(h('p', 'ms-muted', 'No estimate for this claim.'));
      card.appendChild(body);
      return card;
    }
    const est = h('div', 'ms-mind-claim-est');
    const big = h('div', 'ms-mind-claim-p');
    const num = h('span', 'ms-mind-claim-num', pct(t.p));
    big.append(num, provMark('estimated', { title: 'Computed by mind.truthfulness from the three reasons below; not a graph metric' }));
    const lab = h('div', 'ms-mind-claim-lab');
    lab.append(h('div', 'ms-mind-claim-what', 'probability the statement is accurate'), h('div', 'ms-mind-claim-note', t.note));
    const mt = meter({ label: `probability the statement is accurate: ${pct(t.p)}` });
    mt.classList.add('is-claim');
    setMeter(mt, t.p);
    est.append(big, lab);
    body.append(est, mt);
    const ul = h('ul', 'ms-mind-reasons');
    ul.setAttribute('aria-label', 'Reasons');
    for (const r of t.reasons) {
      const info = REASON[r.kind] || { icon: 'circle-small', label: r.kind, hint: '' };
      const li = h('li', 'ms-mind-reason');
      const head = h('div', 'ms-mind-reason-head');
      const kind = h('span', 'ms-mind-reason-kind');
      kind.append(icon(info.icon), document.createTextNode(info.label));
      const hint = h('span', 'ms-mind-reason-hint', info.hint);
      const rm = meter({ label: `${info.label}: ${pct(r.p)}` });
      setMeter(rm, r.p);
      const rp = h('span', 'ms-mind-reason-p', pct(r.p));
      head.append(kind, hint, rm, rp);
      li.append(head, h('p', 'ms-mind-reason-text', r.text));
      ul.appendChild(li);
    }
    body.appendChild(ul);
    card.appendChild(body);
    return card;
  }

  dispose() {}
}
