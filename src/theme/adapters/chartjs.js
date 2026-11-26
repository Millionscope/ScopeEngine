/**
 * Chart.js theme adapter. Receives the Chart class from the editor that loaded it (never
 * imports the library). Sets global defaults from the current CSS variables: text color,
 * grid/border (editorGroup.border), tooltip (editorWidget.background, widget.border), fonts,
 * and exposes the validated series palette. Tracks live chart instances for the debug overlay.
 * @module theme/adapters/chartjs
 */
import { token, seriesColors, provColor, FONT_UI, alpha } from '../tokens.js';

/** @type {Set<any>} */
const live = new Set();

/** Live Chart.js instances (debug overlay / leak checks). */
export function liveChartCount() {
  return live.size;
}

/** Register a chart so destroy() is accounted for. @param {any} chart */
export function trackChart(chart) {
  live.add(chart);
  const destroy = chart.destroy.bind(chart);
  chart.destroy = () => {
    live.delete(chart);
    destroy();
  };
  return chart;
}

/** Palette object for chart code. */
export function chartPalette() {
  return {
    fg: token('editor.foreground', '#cccccc'),
    muted: token('descriptionForeground', '#9d9d9d'),
    grid: token('editorGroup.border', '#2b2b2b'),
    surface: token('editor.background', '#1f1f1f'),
    tooltipBg: token('editorWidget.background', '#202020'),
    tooltipBorder: token('widget.border', '#313131'),
    accent: token('focusBorder', '#0078d4'),
    fail: token('--ms-fail', '#f85149'),
    cone: token('--ms-cone', 'rgba(0,120,212,.35)'),
    series: seriesColors(),
    prov: {
      input: provColor('input'),
      observed: provColor('observed'),
      estimated: provColor('estimated'),
      computed: provColor('computed'),
      proven: provColor('proven'),
    },
  };
}

/**
 * Apply theme defaults to Chart.js (call on mount and on theme:changed).
 * @param {any} Chart
 */
export function applyChartTheme(Chart) {
  const p = chartPalette();
  const d = Chart.defaults;
  d.color = p.muted;
  d.borderColor = p.grid;
  d.font.family = FONT_UI;
  d.font.size = 11;
  d.plugins.tooltip.backgroundColor = p.tooltipBg;
  d.plugins.tooltip.borderColor = p.tooltipBorder;
  d.plugins.tooltip.borderWidth = 1;
  d.plugins.tooltip.titleColor = p.fg;
  d.plugins.tooltip.bodyColor = p.fg;
  d.plugins.tooltip.padding = 8;
  d.plugins.tooltip.cornerRadius = 4;
  d.plugins.tooltip.displayColors = true;
  d.plugins.tooltip.boxPadding = 4;
  d.plugins.legend.labels.color = p.muted;
  d.plugins.legend.labels.boxWidth = 12;
  d.plugins.legend.labels.boxHeight = 3;
  d.scale.grid.color = p.grid;
  d.scale.border.color = p.grid;
  d.scale.ticks.color = p.muted;
  d.elements.bar.borderRadius = 2;
  d.elements.line.borderWidth = 2;
  d.elements.point.radius = 0;
  d.animation = false;
  return p;
}

/**
 * Re-theme an existing chart's scales in place (after theme:changed).
 * @param {any} chart
 */
export function rethemeChart(chart) {
  const p = chartPalette();
  for (const s of Object.values(chart.options.scales || {})) {
    const sc = /** @type {any} */ (s);
    if (sc.grid) sc.grid.color = p.grid;
    if (sc.border) sc.border.color = p.grid;
    if (sc.ticks) sc.ticks.color = p.muted;
    if (sc.title) sc.title.color = p.muted;
  }
  chart.update('none');
}

export { alpha };
