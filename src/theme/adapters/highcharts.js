/**
 * Optional Highcharts adapter (off by default; Chart.js and d3 are the defaults).
 * NOTE: Highcharts requires a commercial license for commercial products.
 * Receives Highcharts from the caller; never imports it.
 * @module theme/adapters/highcharts
 */
import { token, seriesColors, FONT_UI } from '../tokens.js';

/** @param {any} Highcharts */
export function applyHighchartsTheme(Highcharts) {
  const fg = token('editor.foreground', '#cccccc');
  const muted = token('descriptionForeground', '#9d9d9d');
  const grid = token('editorGroup.border', '#2b2b2b');
  Highcharts.setOptions({
    colors: seriesColors(),
    chart: { backgroundColor: token('editor.background', '#1f1f1f'), style: { fontFamily: FONT_UI, color: fg } },
    title: { style: { color: fg } },
    legend: { itemStyle: { color: muted } },
    xAxis: { gridLineColor: grid, lineColor: grid, labels: { style: { color: muted } } },
    yAxis: { gridLineColor: grid, lineColor: grid, labels: { style: { color: muted } } },
    tooltip: { backgroundColor: token('editorWidget.background', '#202020'), borderColor: token('widget.border', '#313131'), style: { color: fg } },
    credits: { enabled: false },
  });
}
