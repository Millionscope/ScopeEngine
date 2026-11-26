/**
 * Scripted assistant turns. Every number in prose is a {{binding}} into the graph (no free
 * numerals); names and words are free text. Intents are matched by simple patterns; the mock
 * model adapter (services/chat.js) plays the returned script: swarm steps, deltas, then prose.
 * Imported only by services.
 * @module mock/conversation
 */
import { competitorBuild, initialBuild, questionBuild, removeLoanBuild } from './swarm-script.js';

/**
 * @typedef {Object} BuildScript
 * @property {string} title
 * @property {number} tokens
 * @property {boolean=} historical
 * @property {Array<any>} steps
 */

export const INITIAL_QUESTION = 'Should our bakery open a second location?';

export const INITIAL_ANSWER = `**Yes, if you keep a cash buffer.** Opening Location B leaves median monthly cash at {{bakery.monthly_cash.p50 | usd}} (p10–p90: {{bakery.monthly_cash.p10 | usd}} to {{bakery.monthly_cash.p90 | usd}}), with a {{bakery.p_cash_negative | pct}} chance of a negative month.

Once ramped, Location B nets {{locationB.net_cash.p50 | usd}} a month at the median, after rent of {{locationB.rent | usd}} and payroll of {{locationB.staff.payroll | usd}}. The expansion loan costs {{expansion.payment | usd}} a month.

Over the first two years the chance that cash runs out at some point is {{projection.p_buffer_breach | pct}}, because most of the fit-out (median {{locationB.fit_out_cost.p50 | usd}}) is financed by the loan.

Of the uncertainties, the answer moves most with the capture rate at Location B, demand at the current bakery and Harbor Street foot traffic. Of the things you decide, bread price and rent are the biggest levers: drag them in Controls and every number here recomputes in the browser with zero model tokens.`;

/** @returns {Array<any>} preloaded conversation */
export function initialConversation() {
  return [
    { role: 'user', text: INITIAL_QUESTION, tokens: 0 },
    { role: 'assistant', template: INITIAL_ANSWER, tokens: 41280, build: initialBuild(), certificate: true },
  ];
}

const ADD_RE = /\b(add|new|another|introduce|include)\b.*\b(competitor|rival|bakery|caf[eé]|shop)\b|\b(competitor|rival)\s+(named|called)\b/i;
const NAME_RE = /\b(?:named|called)\s+["“']?([^"”'?.!,]+?)["”']?\s*(?:[?.!,]|$)/i;

/**
 * Classify a free-text request into a scripted intent and build its script.
 * @param {string} text
 * @param {{ graph: any, engine: any, sensitivity: () => any, scenarioIdFor: (name: string) => string }} ctx
 */
export function scriptFor(text, ctx) {
  const t = text.trim();
  if (ADD_RE.test(t)) {
    const m = NAME_RE.exec(t);
    const name = (m ? m[1] : 'New rival').trim().replace(/\s+/g, ' ').slice(0, 40) || 'New rival';
    return {
      intent: 'competitor',
      kind: 'structural',
      build: competitorBuild({ name, parentId: 'sc_market', distance: 0.4, expect: () => ctx.graph.versionLabel }),
      competitor: { name, distance: 0.4 },
      template: `Added **“${escapeMd(name)}”** under Market. Competitive pressure near Location B rises to {{market.pressure_total | pct}}, which moves Location B's median net cash to {{locationB.net_cash.p50 | usd}}.

Overall, median monthly cash is now {{bakery.monthly_cash.p50 | usd}} with a {{bakery.p_cash_negative | pct}} chance of a negative month. The new scope is in the Outliner and Scope Graph, and the change is in History, so you can undo it.`,
    };
  }
  if (/\b(remove|drop|skip|without|no)\b.*\bloan\b/i.test(t)) {
    return {
      intent: 'remove_loan',
      kind: 'structural',
      build: removeLoanBuild(),
      scenario: { name: 'No loan', overrides: [{ target: 'sc_loan.principal', value: 0 }] },
      template: `Deleting the loan scope would leave dangling references (monthly cash and the projection use its payment), so the verifier rejected that delta. Instead I forked a scenario, **No loan**, with the principal set to zero.

In **No loan**, median monthly cash is {{SCN::bakery.monthly_cash.p50 | usd}} (base: {{bakery.monthly_cash.p50 | usd}}), but the chance of breaching the cash buffer within two years becomes {{SCN::projection.p_buffer_breach | pct}} (base: {{projection.p_buffer_breach | pct}}), because the fit-out is then paid from cash. Compare both in the Scenarios workspace.`,
    };
  }
  if (/\bprice\b/i.test(t) && /\b(raise|increase|higher|charge more|up|what if)\b/i.test(t)) {
    const v = /\$?\s*(\d+(?:\.\d+)?)/.exec(t);
    const price = v ? Math.min(6, Math.max(3, Number(v[1]))) : 4.5;
    const name = `Price $${price.toFixed(2)}`;
    return {
      intent: 'price',
      kind: 'question',
      build: questionBuild(`Question: ${t}`, 38200, [
        { role: 'Modeler', kind: 'propose', text: `fork scenario "${name}" with Bakery.price = ${price.toFixed(2)}`, deltaKey: 'fork', level: 1 },
        { role: 'Skeptic', kind: 'review', text: 'Price also lowers Location B traffic through the elasticity in Customers (L0); kept in the cone.', outcome: 'accepted', level: 8 },
      ]),
      scenario: { name, overrides: [{ target: 'sc_bakery.price', value: price }] },
      template: `I forked a scenario, **${escapeMd(name)}**, so your inputs stay unchanged. There, median monthly cash is {{SCN::bakery.monthly_cash.p50 | usd}} (base {{bakery.monthly_cash.p50 | usd}}) and the chance of a negative month is {{SCN::bakery.p_cash_negative | pct}} (base {{bakery.p_cash_negative | pct}}).

The higher price lifts margin at the current bakery but costs Location B customers through price elasticity: {{SCN::locationB.customers.p50 | int}} a day at the median versus {{locationB.customers.p50 | int}} in base. To find the price that meets a risk target, try \`/goalseek P(monthly_cash<0) < 10% by price\`.`,
    };
  }
  if (/\b(driv|sensitiv|matter|risk|uncertain|why|depend)/i.test(t)) {
    const s = ctx.sensitivity();
    const top = s.items.slice(0, 3).map((it) => it.path.split('.').slice(-2).join('.'));
    return {
      intent: 'drivers',
      kind: 'question',
      build: questionBuild(`Question: ${t}`, 22400, [{ role: 'Lead', kind: 'plan', text: 'Rank inputs by first-order Sobol indices of monthly cash; read value of information for estimates.' }]),
      template: `The spread of monthly cash (p10 {{bakery.monthly_cash.p10 | usd}}, p90 {{bakery.monthly_cash.p90 | usd}}) is driven mostly by **${escapeMd(top[0] || 'demand')}**, then **${escapeMd(top[1] || 'capture_rate')}** and **${escapeMd(top[2] || 'foot_traffic')}**. Those are estimates, so researching them is worth more than tuning inputs you control.

Of the inputs you set, rent matters most. The Sensitivity area shows the full tornado and the value of information for each estimate.`,
    };
  }
  if (/\b(landlord|lease|negotiat|abatement|discount)\b/i.test(t)) {
    return {
      intent: 'landlord',
      kind: 'question',
      build: questionBuild(`Question: ${t}`, 31800, [
        { role: 'Mind sim', kind: 'estimate', text: 'Landlord (L3): goals income 0.6, tenant quality 0.25, property value 0.15; hidden: flexibility.', outcome: 'accepted', level: 7, nodeId: 'sc_landlord.flexibility' },
      ]),
      template: `The lease rent is {{lease.base_rent | usd}} a month with an expected negotiated discount of {{lease.negotiated_discount | pct}}, which depends on the landlord's hidden flexibility (median {{minds.landlord.flexibility.p50 | pct}}). The unit has been vacant for {{minds.landlord.vacancy_months | int}} months, which usually raises flexibility.

This is a simulation, not an assessment of the landlord. Run \`/infer @Landlord\` to update the posterior from the observations on record; the rent and every number downstream recompute from the new estimate.`,
    };
  }
  if (/\b(loan|interest|bank|financ|debt)\b/i.test(t)) {
    return {
      intent: 'loan',
      kind: 'question',
      build: questionBuild(`Question: ${t}`, 19600),
      template: `The expansion loan of {{expansion.principal | usd}} at {{expansion.rate | pct1}} over {{expansion.term | int}} years costs {{expansion.payment | usd}} a month, {{expansion.total_interest | usd}} of interest in total. Debt service coverage is {{bakery.dscr.p50 | num}} at the median against the bank's threshold of {{minds.loan_officer.dscr_threshold | num}}, and the debt ratio is {{bakery.debt_ratio | pct}}, proven below the limit for the declared ranges.`,
    };
  }
  if (/\b(staff|hire|payroll|wage|employee|team)\b/i.test(t)) {
    return {
      intent: 'staff',
      kind: 'question',
      build: questionBuild(`Question: ${t}`, 17800),
      template: `Location B's six staff cost {{locationB.staff.payroll | usd}} a month including benefits of {{locationB.staff.benefits_rate | pct}}; the average wage is {{locationB.staff.avg_wage | usd2}} an hour. Edit any wage or hours in the Sheet (shape Person/v3): payroll and monthly cash recompute locally.`,
    };
  }
  if (/\b(simulat|react|respond|what will)\b/i.test(t)) {
    return {
      intent: 'simulate',
      kind: 'question',
      build: questionBuild(`Question: ${t}`, 26400, [{ role: 'Mind sim', kind: 'estimate', text: 'Rival1 owner (L2): price-cut probability prior Beta(2, 6).', outcome: 'accepted', level: 7 }]),
      template: `Rival1's owner cuts prices after an opening with probability {{minds.rival1_owner.price_cut_prob.p50 | pct}} at the median of our current estimate. That is one input to a simulation, not a prediction about the person. Run \`/sim 100 runs\` to play the lease negotiation and the rival's response over two years with seeded agents; results come back as distributions across runs.`,
    };
  }
  return {
    intent: 'fallback',
    kind: 'question',
    build: questionBuild(`Question: ${t}`, 24600),
    template: `Here is where the answer stands: median monthly cash {{bakery.monthly_cash.p50 | usd}}, a {{bakery.p_cash_negative | pct}} chance of a negative month, and a {{projection.p_buffer_breach | pct}} chance of breaching the cash buffer within two years.

This prototype's model is scripted, so it answers best about price, competitors, the loan, the landlord, staff and what drives the risk. Numeric edits such as "set rent to 7000" run locally with zero tokens.`,
  };
}

/** @param {string} s */
function escapeMd(s) {
  return String(s).replace(/[*_`[\]{}]/g, '');
}
