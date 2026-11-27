/**
 * Game: the Manhattan open-world game (public/game, based on Slop New York), embedded in an iframe.
 * It runs on its own three.js r188 WebGPU build from a CDN importmap, which the app's three@0.160 cannot host,
 * so it stays a separate page; the iframe is dropped on dispose, which stops its renderer and audio.
 * @module editors/game
 */
import { BaseEditor } from '../base-editor.js';

export default class GameEditor extends BaseEditor {
  static id = 'game';
  static label = 'Game';
  static icon = 'game';
  static group = 'Scope';
  static needs = [];

  async mount(ctx) {
    const frame = document.createElement('iframe');
    frame.className = 'ms-ed';
    frame.style.cssText = 'border:0;width:100%;height:100%;display:block;background:#000';
    frame.title = 'Game: explore Manhattan on foot, by car, bicycle or helicopter';
    frame.allow = 'fullscreen; gamepad; autoplay';
    // explicit index.html: a bare /game/ hits the dev server's SPA fallback
    // ponytail: keeps rendering while the area is hidden; pause it via postMessage if that costs too much
    frame.src = '/game/index.html';
    this.frame = frame;
    ctx.el.appendChild(frame);
  }

  dispose() {
    this.frame?.remove();
    super.dispose();
  }
}
