/**
 * S&P500: a Highcharts "large treemap" of the index's largest constituents (sector → company,
 * block area = market cap) on the hologram stage, fed by a simulated live tape.
 *  - every TICK_MS each company's day change takes a random-walk step (with occasional bursts) and
 *    its cap moves with it; blocks re-tint (mint up / magenta down, opacity by size of the move);
 *  - the HOT biggest movers of each tick pulse (class re-applied on every render, since Highcharts
 *    rewrites the class attribute when it redraws a point);
 *  - prism shader from shared/prism-filter.js (as on the Candlestick), scanlines and a sweep band in CSS.
 * Caps are rough $B snapshots for layout only; the feed is simulated, not market data.
 * @module editors/sp500
 */
import { BaseEditor } from '../base-editor.js';
import { loadCss } from '../../core/lazy.js';
import { addPrism } from '../shared/prism-filter.js';

const TICK_MS = 1000;
const LOOP = 40; // ticks per loop for the Home cycle
const HOT = 4;
const BASE_INDEX = 6800;
const UP = '#3fffb0';
const DOWN = '#ff4f8b';
const CYAN = '#3fd8ff';

// ponytail: ~190 largest constituents with rough caps ($B); load a full constituents file if all ~503 are needed
const SECTORS = {
  'Information Technology': 'NVDA NVIDIA 4500, AAPL Apple 3800, MSFT Microsoft 3700, AVGO Broadcom 1600, ORCL Oracle 700, PLTR Palantir 420, AMD AMD 380, CSCO Cisco 270, IBM IBM 260, CRM Salesforce 240, MU Micron 200, INTU Intuit 180, NOW ServiceNow 180, TXN Texas Instruments 170, QCOM Qualcomm 170, AMAT Applied Materials 160, ANET Arista Networks 160, LRCX Lam Research 150, ADBE Adobe 150, INTC Intel 140, APH Amphenol 130, PANW Palo Alto Networks 130, KLAC KLA 120, ADI Analog Devices 120, CRWD CrowdStrike 120, CDNS Cadence 90, DELL Dell 90, SNPS Synopsys 80, MSI Motorola Solutions 70, FTNT Fortinet 70',
  'Communication Services': 'GOOGL Alphabet 3000, META Meta Platforms 1800, NFLX Netflix 450, TMUS T-Mobile 260, APP AppLovin 200, DIS Disney 200, T AT&T 190, VZ Verizon 170, CMCSA Comcast 130, WBD Warner Bros. Discovery 50, EA Electronic Arts 50, TTWO Take-Two 45',
  'Consumer Discretionary': "AMZN Amazon 2400, TSLA Tesla 1400, HD Home Depot 380, MCD McDonald's 220, BKNG Booking 170, TJX TJX 160, LOW Lowe's 140, SBUX Starbucks 100, NKE Nike 100, ABNB Airbnb 80, ORLY O'Reilly 80, RCL Royal Caribbean 80, MAR Marriott 75, HLT Hilton 65, AZO AutoZone 65, GM General Motors 60, CMG Chipotle 60, ROST Ross Stores 50, F Ford 45",
  Financials: 'BRK.B Berkshire Hathaway 1050, JPM JPMorgan Chase 830, V Visa 680, MA Mastercard 520, BAC Bank of America 380, WFC Wells Fargo 270, MS Morgan Stanley 240, AXP American Express 240, GS Goldman Sachs 230, BX Blackstone 200, C Citigroup 180, SCHW Charles Schwab 170, BLK BlackRock 170, SPGI S&P Global 160, PGR Progressive 150, COF Capital One 140, KKR KKR 120, CB Chubb 110, MMC Marsh McLennan 100, CME CME Group 100, ICE Intercontinental Exchange 95, AON Aon 80, USB U.S. Bancorp 75, PNC PNC 75, PYPL PayPal 70',
  'Health Care': 'LLY Eli Lilly 850, JNJ Johnson & Johnson 450, ABBV AbbVie 400, UNH UnitedHealth 300, MRK Merck 230, ABT Abbott 220, TMO Thermo Fisher 200, ISRG Intuitive Surgical 180, AMGN Amgen 160, BSX Boston Scientific 150, GILD Gilead 150, SYK Stryker 145, PFE Pfizer 140, DHR Danaher 140, MDT Medtronic 120, VRTX Vertex 110, BMY Bristol-Myers Squibb 95, CVS CVS Health 95, HCA HCA 95, CI Cigna 80, ELV Elevance 75, ZTS Zoetis 65, REGN Regeneron 60',
  Industrials: 'GE GE Aerospace 300, CAT Caterpillar 250, RTX RTX 220, UBER Uber 190, GEV GE Vernova 170, BA Boeing 160, ETN Eaton 140, UNP Union Pacific 135, HON Honeywell 130, DE Deere 130, ADP ADP 120, LMT Lockheed Martin 110, PH Parker-Hannifin 90, TT Trane 90, GD General Dynamics 90, WM Waste Management 85, NOC Northrop Grumman 85, MMM 3M 80, CTAS Cintas 80, UPS UPS 75, ITW Illinois Tool Works 75, EMR Emerson 75, CSX CSX 65, FDX FedEx 55',
  'Consumer Staples': 'WMT Walmart 800, COST Costco 420, PG Procter & Gamble 360, KO Coca-Cola 300, PM Philip Morris 250, PEP PepsiCo 200, MO Altria 100, MDLZ Mondelez 80, CL Colgate-Palmolive 65, TGT Target 45, KDP Keurig Dr Pepper 45, KMB Kimberly-Clark 40',
  Energy: 'XOM Exxon Mobil 480, CVX Chevron 300, COP ConocoPhillips 115, WMB Williams 70, EOG EOG Resources 65, KMI Kinder Morgan 60, PSX Phillips 66 55, MPC Marathon Petroleum 55, SLB SLB 50, OKE ONEOK 45',
  Utilities: 'NEE NextEra Energy 160, CEG Constellation Energy 110, SO Southern Company 100, DUK Duke Energy 95, VST Vistra 65, AEP American Electric Power 60, SRE Sempra 55, D Dominion Energy 50, EXC Exelon 45',
  'Real Estate': 'WELL Welltower 110, PLD Prologis 105, AMT American Tower 85, EQIX Equinix 75, SPG Simon Property 60, DLR Digital Realty 55, O Realty Income 52, PSA Public Storage 50, CCI Crown Castle 45',
  Materials: 'LIN Linde 210, NEM Newmont 90, SHW Sherwin-Williams 85, ECL Ecolab 75, APD Air Products 60, FCX Freeport-McMoRan 60, CTVA Corteva 45, NUE Nucor 35, DD DuPont 30',
};

/** @returns {Array<{id: string, full: string, parent: string, cap: number, chg: number}>} */
function companies() {
  return Object.entries(SECTORS).flatMap(([parent, list]) => list.split(', ').map((s) => {
    const [, id, full, cap] = /** @type {RegExpMatchArray} */ (s.match(/^(\S+) (.+) (\d+)$/));
    return { id, full, parent, cap: +cap, chg: (Math.random() - 0.5) * 2 };
  }));
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const pct = (v) => `${v >= 0 ? '+' : ''}${(Math.round(v * 100) / 100 || 0).toFixed(2)}%`;

export default class Sp500Editor extends BaseEditor {
  static id = 'sp500';
  static label = 'S&P500';
  static icon = 'graph';
  static group = 'Scope';
  static needs = ['highchartsTreemap'];

  async mount(ctx, state) {
    await Promise.all([loadCss(new URL('../scope/scope.css', import.meta.url)), loadCss(new URL('./sp500.css', import.meta.url))]);
    this.Highcharts = ctx.libs.highchartsTreemap;
    this.running = state.running !== false;
    this.cos = companies();
    this.cap0 = this.cos.reduce((s, c) => s + c.cap, 0);
    this.hot = new Set();

    const root = (this.root = el('div', 'ms-ed ms-scope ms-sp'));
    this.host = el('div', 'ms-sc-host');
    this.host.tabIndex = 0;
    this.host.setAttribute('role', 'img');
    this.host.setAttribute('aria-label', 'Treemap of the largest S&P 500 companies by market cap, grouped by sector, with a simulated live feed. S pauses or resumes the feed.');
    const plot = el('div', 'ms-sp-plot');
    this.host.append(plot);
    root.append(this.host);
    ctx.el.append(root);

    const hot = this.hot;
    this.chart = this.Highcharts.chart(plot, {
      chart: {
        backgroundColor: 'transparent', animation: { duration: 500 }, style: { fontFamily: 'var(--ms-font-mono)' }, spacing: [44, 8, 8, 8],
        events: { render() { for (const p of this.series[0]?.points || []) p.graphic?.element.classList.toggle('ms-sp-hot', hot.has(p.id)); } },
      },
      title: { text: undefined },
      credits: { enabled: false },
      accessibility: { enabled: false },
      tooltip: {
        backgroundColor: 'rgba(4,16,30,.85)', borderColor: CYAN, style: { color: '#d8f3ff' }, useHTML: false,
        formatter() {
          const p = /** @type {any} */ (this);
          return p.chg == null ? `<b>${p.name}</b><br>$${(p.value / 1000).toFixed(2)}T`
            : `<b>${p.id}</b> · ${p.full}<br>${p.parent}<br>$${p.value.toFixed(0)}B · <span style="color:${p.chg >= 0 ? UP : DOWN}">${pct(p.chg)}</span>`;
        },
      },
      series: [{
        type: 'treemap',
        name: 'S&P500',
        layoutAlgorithm: 'squarified',
        allowTraversingTree: true,
        interactByLeaf: true, // clicking a company drills into its sector
        animationLimit: 1000,
        borderColor: 'rgba(63,216,255,.35)',
        borderWidth: 1,
        dataLabels: { enabled: false },
        breadcrumbs: {
          floating: true, position: { align: 'left', verticalAlign: 'top', y: -38 },
          buttonTheme: { fill: 'rgba(4,16,30,.7)', stroke: 'rgba(63,216,255,.4)', 'stroke-width': 1, padding: 4, r: 4, style: { color: CYAN }, states: { hover: { fill: 'rgba(63,216,255,.2)' } } },
          style: { color: '#7aa6bb' }, separator: { style: { color: '#7aa6bb' } },
        },
        levels: [
          {
            level: 1, borderWidth: 2, borderColor: CYAN, color: 'transparent',
            dataLabels: { enabled: true, headers: true, align: 'left', padding: 3, style: { color: CYAN, fontSize: '11px', fontWeight: '600', textOutline: 'none', textTransform: 'uppercase' } },
          },
          {
            level: 2,
            dataLabels: { enabled: true, format: '{point.id}<br><span style="opacity:.75">{point.label}</span>', style: { color: '#eafaff', fontSize: '11px', fontWeight: '600', textOutline: 'none' } },
          },
        ],
        data: [...Object.keys(SECTORS).map((id) => ({ id, name: id })), ...this.cos.map((c) => this.point(c))],
      }],
    });
    this.prism = addPrism(this.chart);
    this.buildOverlay();

    this.time = 0;
    this.tickT = 0;
    this.count = 0;
    this.disposables.add(ctx.scheduler.animate(this, (info) => this.tick(info)));
    this.listen(this.host, 'keydown', (e) => this.onKey(/** @type {KeyboardEvent} */ (e)));
  }

  /** Treemap point for a company: translucent tint whose strength follows the size of the move. */
  point(c) {
    const a = 0.16 + 0.64 * Math.min(1, Math.abs(c.chg) / 3);
    return { id: c.id, parent: c.parent, value: c.cap, full: c.full, chg: c.chg, label: pct(c.chg),
      color: this.Highcharts.color(c.chg >= 0 ? UP : DOWN).setOpacity(a).get('rgba') };
  }

  buildOverlay() {
    const left = el('div', 'ms-sc-col is-left');
    const panel = el('section', 'ms-sc-panel ms-sc-detail ms-sp-ticker');
    const head = el('header', 'ms-sc-head');
    head.append(el('span', '', `S&P500 · top ${this.cos.length} · simulated`));
    this.priceEl = el('h3', '');
    this.metaEl = el('div', 'ms-sc-meta');
    this.moversEl = el('div', 'ms-sp-movers');
    panel.append(head, this.priceEl, this.metaEl, this.moversEl);
    left.append(panel);
    this.host.append(left);
    this.updateTicker();
  }

  /** HUD: cap-weighted index level and change, plus this tick's hottest movers. */
  updateTicker() {
    const cap = this.cos.reduce((s, c) => s + c.cap, 0);
    const chg = this.cos.reduce((s, c) => s + c.chg * c.cap, 0) / cap;
    this.priceEl.textContent = (BASE_INDEX * cap / this.cap0).toFixed(2);
    this.priceEl.style.setProperty('--c', chg >= 0 ? UP : DOWN);
    this.metaEl.replaceChildren(
      el('span', '', `${chg >= 0 ? '▲' : '▼'} ${pct(chg)}`),
      el('span', '', `$${(cap / 1000).toFixed(1)}T`),
      el('span', '', this.running ? 'LIVE' : 'PAUSED'),
    );
    this.moversEl.replaceChildren(...this.cos.filter((c) => this.hot.has(c.id)).map((c) => {
      const row = el('span', '', `${c.id} ${pct(c.chg)}`);
      row.style.color = c.chg >= 0 ? UP : DOWN;
      return row;
    }));
  }

  /** One tape tick: random-walk every change (mean-reverting, rare bursts), move caps with it. */
  step() {
    const moves = this.cos.map((c) => {
      const d = (Math.random() - 0.5) * 0.4 * (Math.random() < 0.03 ? 6 : 1);
      c.chg = c.chg * 0.995 + d;
      c.cap *= 1 + d / 100;
      return [Math.abs(d), c.id];
    }).sort((a, b) => b[0] - a[0]);
    this.hot.clear();
    for (const [, id] of moves.slice(0, HOT)) this.hot.add(id);
    // updatePoints matches by id, so the drilled-into node and the layout order are kept
    this.chart.series[0].setData([...Object.keys(SECTORS).map((id) => ({ id, name: id })), ...this.cos.map((c) => this.point(c))], true);
    this.updateTicker();
  }

  /** @param {import('../../core/scheduler.js').FrameInfo} info */
  tick(info) {
    const dt = Math.min(info.dt, 100);
    this.time += dt;
    this.prism(this.time, info.reducedMotion);
    if (!this.running) return;
    this.tickT += dt * (info.reducedMotion ? 0.5 : 1);
    if (this.tickT < TICK_MS) return;
    this.tickT = 0;
    this.step();
    this.loopCheck(this.count, ++this.count, LOOP);
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (e.target !== this.host || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    this.running = !this.running;
    this.updateTicker();
    this.save();
  }

  resize() {
    this.chart?.reflow();
  }

  getState() {
    return { running: this.running };
  }

  dispose() {
    this.chart?.destroy();
    this.chart = null;
    this.root?.remove();
    super.dispose();
  }
}
