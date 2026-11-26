/**
 * Mermaid theme adapter: initialize({ theme: 'base', themeVariables }) from the current tokens.
 * Call again on theme:changed and re-render diagrams. Receives mermaid from the editor.
 * @module theme/adapters/mermaid
 */
import { token, FONT_UI, provColor } from '../tokens.js';

/** @param {any} mermaid */
export function applyMermaidTheme(mermaid) {
  const dark = document.documentElement.dataset.theme !== 'light';
  const vars = {
    darkMode: dark,
    background: token('editor.background', '#1f1f1f'),
    fontFamily: FONT_UI,
    fontSize: '13px',
    primaryColor: token('editorWidget.background', '#202020'),
    primaryTextColor: token('editor.foreground', '#cccccc'),
    primaryBorderColor: token('focusBorder', '#0078d4'),
    secondaryColor: token('sideBar.background', '#181818'),
    secondaryTextColor: token('editor.foreground', '#cccccc'),
    secondaryBorderColor: token('widget.border', '#313131'),
    tertiaryColor: token('textBlockQuote.background', '#2b2b2b'),
    tertiaryTextColor: token('editor.foreground', '#cccccc'),
    tertiaryBorderColor: token('widget.border', '#313131'),
    lineColor: token('descriptionForeground', '#9d9d9d'),
    textColor: token('editor.foreground', '#cccccc'),
    mainBkg: token('editorWidget.background', '#202020'),
    nodeBorder: token('widget.border', '#313131'),
    clusterBkg: token('sideBar.background', '#181818'),
    clusterBorder: token('editorGroup.border', '#2b2b2b'),
    edgeLabelBackground: token('editor.background', '#1f1f1f'),
    actorBkg: token('editorWidget.background', '#202020'),
    actorBorder: token('focusBorder', '#0078d4'),
    actorTextColor: token('editor.foreground', '#cccccc'),
    actorLineColor: token('descriptionForeground', '#9d9d9d'),
    signalColor: token('editor.foreground', '#cccccc'),
    signalTextColor: token('editor.foreground', '#cccccc'),
    labelBoxBkgColor: token('editorWidget.background', '#202020'),
    labelBoxBorderColor: token('widget.border', '#313131'),
    labelTextColor: token('editor.foreground', '#cccccc'),
    noteBkgColor: token('textBlockQuote.background', '#2b2b2b'),
    noteTextColor: token('editor.foreground', '#cccccc'),
    noteBorderColor: token('textBlockQuote.border', '#616161'),
    classText: token('editor.foreground', '#cccccc'),
    errorBkgColor: token('--ms-fail', '#f85149'),
  };
  mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'antiscript', themeVariables: vars, flowchart: { htmlLabels: true, curve: 'basis' }, sequence: { mirrorActors: false } });
  return vars;
}

/** classDef lines coloring nodes by provenance (append to flowcharts). */
export function mermaidProvClasses() {
  const k = ['input', 'observed', 'estimated', 'computed', 'proven'];
  return [
    ...k.map((p) => `classDef ${p} stroke:${provColor(p)},stroke-width:2px;`),
    `classDef contested stroke:${token('--ms-contested-color')},stroke-width:2px,stroke-dasharray:4 3;`,
    `classDef failed stroke:${token('--ms-fail')},stroke-width:2px;`,
  ].join('\n');
}
