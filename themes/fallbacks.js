/**
 * Fallback colors for keys the UI needs that are missing from dark_modern.json or
 * light_modern.json. Both files `include` a base theme (dark_plus.json / light_plus.json)
 * that is not shipped with this prototype.
 *
 * APPROXIMATE: these values are VS Code's registered defaults (or Dark+/Light+ values) as best
 * known. Replace them with the true *_plus.json values when those files are added.
 *
 * Merge rule (src/theme/theme-loader.js): theme keys ALWAYS win over fallbacks.
 */

/** @type {Record<string, string>} */
export const darkFallbacks = {
  // lists, trees, tables
  'list.activeSelectionBackground': '#04395E',
  'list.activeSelectionForeground': '#FFFFFF',
  'list.inactiveSelectionBackground': '#37373D',
  'list.hoverBackground': '#2A2D2E',
  'list.focusOutline': '#0078D4',
  'list.highlightForeground': '#2AAAFF',
  // menus
  'menu.foreground': '#CCCCCC',
  'menu.border': '#454545',
  'menu.selectionForeground': '#FFFFFF',
  'menu.separatorBackground': '#454545',
  // scrollbars
  'scrollbar.shadow': '#000000',
  'scrollbarSlider.background': '#79797966',
  'scrollbarSlider.hoverBackground': '#646464B3',
  'scrollbarSlider.activeBackground': '#BFBFBF66',
  // editor bits
  'editorIndentGuide.background1': '#404040',
  'editor.selectionBackground': '#264F78',
  'editor.inactiveSelectionBackground': '#3A3D41',
  'editorError.foreground': '#F14C4C',
  'editorWarning.foreground': '#CCA700',
  'editorInfo.foreground': '#3794FF',
  'editorWidget.foreground': '#CCCCCC',
  'editorWidget.border': '#454545',
  // pickers, toolbars, widgets
  'pickerGroup.foreground': '#3794FF',
  'quickInputList.focusBackground': '#04395E',
  'quickInputList.focusForeground': '#FFFFFF',
  'toolbar.hoverBackground': '#5A5D5E50',
  'toolbar.activeBackground': '#63666750',
  'widget.shadow': '#0000005C',
  'inputOption.activeForeground': '#FFFFFF',
  'checkbox.foreground': '#CCCCCC',
  'statusBarItem.errorBackground': '#C72E0F',
  'statusBarItem.errorForeground': '#FFFFFF',
  'keybindingLabel.background': '#8080802B',
  'keybindingLabel.border': '#33333399',
  'keybindingLabel.bottomBorder': '#44444499',
  'debugToolBar.background': '#181818',
  'peekViewEditor.background': '#1F1F1F',
  'sash.hoverBorder': '#0078D4',
};

/** @type {Record<string, string>} */
export const lightFallbacks = {
  'list.inactiveSelectionBackground': '#E4E6F1',
  'list.focusOutline': '#005FB8',
  'list.highlightForeground': '#0066BF',
  'menu.background': '#FFFFFF',
  'menu.foreground': '#3B3B3B',
  'menu.separatorBackground': '#D4D4D4',
  'scrollbar.shadow': '#DDDDDD',
  'scrollbarSlider.background': '#64646466',
  'scrollbarSlider.hoverBackground': '#646464B3',
  'scrollbarSlider.activeBackground': '#00000099',
  'editor.selectionBackground': '#ADD6FF',
  'editor.findMatchBackground': '#A8AC94',
  'editorError.foreground': '#E51400',
  'editorWarning.foreground': '#BF8803',
  'editorInfo.foreground': '#1A85FF',
  'editorWidget.foreground': '#3B3B3B',
  'editorWidget.border': '#C8C8C8',
  'quickInputList.focusBackground': '#E8E8E8',
  'quickInputList.focusForeground': '#000000',
  'toolbar.hoverBackground': '#B8B8B850',
  'toolbar.activeBackground': '#A6A6A650',
  'widget.shadow': '#00000029',
  'checkbox.foreground': '#3B3B3B',
  'statusBarItem.errorForeground': '#FFFFFF',
  'keybindingLabel.background': '#DDDDDD66',
  'keybindingLabel.border': '#CCCCCC66',
  'keybindingLabel.bottomBorder': '#BBBBBB66',
  'debugToolBar.background': '#F3F3F3',
  'peekViewEditor.background': '#F2F8FC',
  'sash.hoverBorder': '#005FB8',
};

/** @param {'dark'|'light'} kind */
export function fallbacksFor(kind) {
  return kind === 'light' ? lightFallbacks : darkFallbacks;
}
