# MillionScope Workbench: front-end prototype

A static, front-end-only prototype of the MillionScope Workbench. It is a Blender-style tiled
workbench that you can split, join, swap, maximize and save per workspace, styled with the
VS Code Dark Modern and Light Modern themes. It has exactly one chat composer and 21 editor
types. The model, the engine and the AI are mocked in the browser, behind adapters named after
the planned API.

It uses plain ES2022 modules with JSDoc types and no framework, built with Vite.

## Run it

```bash
npm install
npm run dev       # http://localhost:5173/
npm run build     # production build in dist/
npm run preview   # serve dist/
```

- **Tests**: open `/tests/` on the dev server. It is a zero-dependency in-browser runner covering the
  area tree, units, bindings, deltas, the engine and the import-rule check.
- **Libraries**: npm dependencies at exact versions (`package.json`), loaded only through
  `src/core/lazy.js` when an editor needs them; Vite splits each into its own chunk.
- **Static files**: everything in `public/` is served from the site root (`/fonts`, `/favicon`,
  `/models`, `/sitemap.xml`, `/robots.txt`).
- **Human Atlas**: the anatomy viewer (Human Atlas tab) streams the BodyParts3D atlas from `public/models`
  (about 33 MB gzipped, loaded once per page). BodyParts3D © The Database Center for Life Science,
  CC BY 4.0.

## Deploy to Cloudflare Pages

`wrangler.toml` points Pages at the Vite output, `dist/`.

- **Git integration**: in the Cloudflare dashboard, go to *Workers & Pages → Create → Pages →
  Connect to Git*, pick this repo, set the build command to `npm run build` and the output
  directory to `dist`.
- **CLI**: `npm run build`, then `npx wrangler pages dev` serves `dist/` on Pages' runtime and
  `npx wrangler pages deploy` uploads it.
- **Sitemap**: `public/sitemap.xml` and `public/robots.txt` are served at `/sitemap.xml` and
  `/robots.txt`. A pre-commit hook rewrites the sitemap's `lastmod` on every commit. Turn it on
  once per clone with `git config core.hooksPath .githooks`, or run
  `node scripts/generate-sitemap.mjs` by hand.

## A two-minute tour

1. **Answer** workspace (the default): the chat answer is prose whose numbers are *bound values*.
   Each number has a provenance glyph (● input, ◆ observed, ~ estimated, ƒ computed,
   ✓ proven); click one to select its scope. Drag **rent** in Controls and every number updates
   (chat, Distributions, Certificate). The status bar shows `0 tokens`.
2. In the composer, type `set rent to 7000`. The routing chip says `local · 0 tokens`, the edit
   lands as a new version and `Ctrl+Z` undoes it.
3. Type `add a competitor named Crumb & Co`. The mock swarm plans the change, a Skeptic's bad
   delta is rejected by the real validator, and the new scope appears in Outliner, Scope Graph,
   History and Swarm.
4. Scenario commands:
   - `/sweep rent 5000..9000 step 500 vs price 3.5..5 step 0.25` draws a heatmap; click a
     cell to fork that scenario.
   - `/goalseek P(monthly_cash<0) < 10% by price` writes a new scenario and never changes your
     inputs.
   - `/fork Higher rent` and `/compare` work as named.
5. **Areas**:
   - `Ctrl+Space` maximizes the area under the pointer.
   - Dragging from an area's top corner splits it or joins it with a neighbour.
   - The icon at the left of each header switches the editor type.
   - `T` and `N` toggle the tool region and the sidebar.
6. **Debug commands** (open the palette with `F3`):
   - *Debug: Load Stress Graph (100k metrics)*;
   - *Debug: Toggle Leak Overlay* (`Ctrl+Alt+D`);
   - *Debug: Cycle Area Through All Editor Types ×2*.

## Architecture

Seven layers. A layer imports only from layers below it. `tests/deps.test.js` enforces this by
crawling every module, including the lazy editor modules.

```
L6  shell/       top bar, workspace tabs, composer, status bar, palette, menus, toasts
L5  editors/     21 editor types, each self-contained and lazily imported
L4  workspace/   screen, area tree, area, header, splitters, corner gestures, workspaces, persistence
L3  services/    selection, chat, change router, swarm feed, history/undo, scenarios, sims, minds, verify
L2  model/       Scope IR, graph index, ScopeDelta, mock engine (incremental + Monte Carlo + sensitivity)
L1  theme/       JSONC loader, token → CSS variables, semantic tokens, library adapters
L0  core/        events, store, commands, keymap, scheduler, disposables, lazy loader, ids, log
    mock/        deterministic demo data (imported only by model/loader.js and services/)
```

Import rules:

| Layer | May import |
| --- | --- |
| `core/` | nothing from the app |
| `theme/` | `core/`. Adapters never import their library; the editor passes the library object in. |
| `model/` | `core/` and itself; only `model/loader.js` reads `mock/`. No DOM access (Web Worker ready). |
| `services/` | `core/`, `model/`, `mock/`. No DOM, except that `notify.js` emits events. |
| `workspace/` | `core/`, `theme/`, `services/` and `editors/registry.js` only |
| `editors/<id>/` | `core/`, `theme/`, `services/`, `model/` helpers, `editors/base-editor.js`, `editors/shared/`. **Never another editor.** |
| `shell/` | everything below except concrete editors |

Heavy libraries (three, chart.js, d3, mermaid, katex) are never imported statically. The only
module that loads them is `core/lazy.js`, and only when an editor that declares them in `needs`
mounts.

### Data flow

- **Numeric edit (zero tokens)**: a slider drag or `set rent to 7000` goes through
  `services/router.js` and becomes a `{op:'set', target, expect, value}` ScopeDelta.
  - `model/delta.js` validates it: version, unit, type, cycles. Rejections fail closed with an
    actionable message.
  - `model/engine.js` recomputes only the downstream cone in topological order, with early
    cutoff, and re-runs Monte Carlo only for affected nodes. It uses common random numbers, so
    an edit never re-draws the noise.
  - The engine emits `graph:recomputed`. Each visible editor redraws the ids it shows inside
    the single frame scheduler, and History records the delta.
- **Question or structural request**: the router hands it to the mock model, which streams swarm
  events. The deltas the model accepts go through the same validator and history path as a
  numeric edit.

### Events

Editors talk to each other only through services, commands and these events, all listed in
`core/events.js`:

```
theme:changed  graph:loaded  graph:recomputed  delta:applied  delta:rejected  selection:changed
hover:changed  scenario:changed  chat:message  chat:stream  swarm:event  sim:progress
certificate:updated  area:focused  area:typeChanged  layout:changed  composer:context
workspace:changed  history:changed  evidence:changed  mind:inferred  notify:toast  log:entry
lazy:loaded  lazy:failed  command:run  app:ready
```

### Engine adapter and mock API

`model/engine.js` (`JsEngine`) implements the `EngineAdapter` interface: `load(ir)`,
`apply(deltas)`, `run(targets, mode)`, `sample(id)`, `stats(id)`, `sensitivity(output)` and
`goalSeek(spec)`. A Rust→WASM engine can replace it without touching the editors.

The AI is mocked in `services/chat.js` (`MockModelAdapter`) and `services/sim.js`. Their method
names match the planned endpoints:

| Mock method | Planned endpoint |
| --- | --- |
| `createGraph` | `POST /graphs` |
| `patchGraph` | `PATCH /graphs/{id}` |
| `run` | `POST /graphs/{id}/run` |
| `getCertificate` | `GET /graphs/{id}/certificate` |
| `SimService.run` | `POST /sims` |

### No free numbers

Assistant prose is a template such as `{{bakery.monthly_cash.p50 | usd}}`, optionally prefixed
`scenarioId::`. Each binding renders as a live, clickable span with a provenance mark and
updates in place on recompute. A post-check (`findFreeNumerals`) flags any numeral that is not
bound.

## Theme

- `themes/dark_modern.json` and `themes/light_modern.json` are the VS Code theme files, copied
  unmodified and parsed as JSONC.
- Every `colors` key becomes a CSS variable named `--vscode-` plus the key with `.` replaced by
  `-`, for example `editor.background` → `--vscode-editor-background`.
- `themes/fallbacks.js` supplies a value only for keys a theme file lacks. Theme keys always win.
  To check, edit a value in `dark_modern.json` and reload.
- `themes/millionscope.tokens.js` derives the semantic `--ms-*` tokens: provenance colors,
  validated categorical series, the sequential ramp and status colors.
- Editor code never hard-codes a color.
- Chart.js, d3, three, Mermaid and KaTeX adapters in `src/theme/adapters/` re-theme on
  `theme:changed`.
- Theme mode is Dark, Light or Auto (follows the system) and is saved.

## Keyboard map

Shortcuts go to the area under the mouse pointer (Blender convention), falling back to the
active area. `?` opens the same list in the app.

| Key | Action |
| --- | --- |
| `Ctrl+Space` | Maximize or restore the area under the pointer (`Esc` restores) |
| `Ctrl+Alt+Space` | Fullscreen area |
| `F3` or `Ctrl+Shift+P` | Command palette (commands, scopes, editor types, workspaces) |
| `Ctrl+P` | Quick open a scope by name |
| `/` | Focus the composer |
| `T` / `N` | Toggle the tool region or the sidebar of the area under the pointer |
| `Ctrl+PageUp` / `Ctrl+PageDown` (also `Alt+…`) | Previous or next workspace |
| `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) | Undo or redo a graph change (always a new version) |
| `Ctrl+Alt+←/→/↑/↓` | Move focus to the neighbouring area |
| `F2` | Rename the selected scope (mock delta) |
| `Home` / `.` | Frame all or frame selected (Scope Graph, 3D) |
| `Ctrl+F` | Search inside the editor under the pointer |
| `Esc` | Clear the selection, close menus, cancel gestures |
| `?` or `Ctrl+/` | Keyboard shortcuts overlay |
| `Ctrl+Alt+D` | Leak and debug overlay |

Editor type of the area under the pointer:

| Key | Editor | Key | Editor |
| --- | --- | --- | --- |
| `Shift+F1` | Chat | `Shift+F7` | Properties |
| `Shift+F2` | Outliner | `Shift+F8` | Controls |
| `Shift+F3` | Scope Graph | `Shift+F9` | Distributions |
| `Shift+F4` | Console | `Shift+F10` | Sensitivity |
| `Shift+F5` | 3D Scope Space | `Shift+F11` | ScopeLang |
| `Shift+F6` | Sheet | `Shift+F12` | Certificate |

Every editor is also in the editor-type menu (header icon, type-ahead search) and in the
palette.

## Add a new editor type in under 20 lines

1. Create `src/editors/<id>/index.js` exporting a class that extends `BaseEditor`:

   ```js
   import { BaseEditor } from '../base-editor.js';
   import { BoundValues } from '../shared/bound-value.js';

   export default class HelloEditor extends BaseEditor {
     static id = 'hello'; static label = 'Hello'; static icon = 'smiley'; static group = 'General'; static needs = [];
     async mount(ctx) {
       this.bv = new BoundValues({ engine: ctx.engine, services: ctx.services });
       this.el = document.createElement('div');
       this.el.className = 'ms-ed ms-ed-pad';
       this.el.append('Monthly cash: ', this.bv.create({ node: 'sc_bakery.monthly_cash', stat: 'p50' }));
       ctx.el.appendChild(this.el);
     }
     onRecompute(changed) { this.bv.update(changed); }
     dispose() { this.bv.dispose(); this.el.remove(); super.dispose(); }
   }
   ```

2. Register it in `src/editors/registry.js`:

   ```js
   { id: 'hello', label: 'Hello', icon: 'smiley', group: 'General', needs: [], kind: 'panel', shortcut: null, usesScenario: false, loader: lazy('hello', () => import('./hello/index.js')) },
   ```

3. Optionally add it to a workspace preset in `src/workspace/presets.js`.

Nothing else changes. The area gives the editor its context, forwards resize, selection, hover,
recompute, scenario and theme events, schedules `render()` inside the shared frame loop, and
calls `dispose()` when the area closes or switches type.

## Performance (measured)

Measured in headless Chromium in a cloud container at 1280×720. A recent laptop should be
similar or faster.

| Case | Size | Load (engine) | Edit `rent` end to end | Outliner scroll |
| --- | --- | --- | --- | --- |
| Demo graph | 316 metrics, 51 scopes | about 45 ms with 1,000 Monte Carlo samples | under 1 ms point recompute + about 5 ms Monte Carlo for the 81-node cone | 60 fps |
| *Debug: Load Stress Graph (10k)* | 10,029 metrics, 1,289 scopes | 217 ms (2.2 s including every visible editor) | 32 ms | median frame 16.7 ms, p95 18.4 ms |
| *Debug: Load Stress Graph (100k)* | 100,254 metrics, 12,775 scopes | 981 ms (5.2 s including every visible editor) | 25 ms | median frame 16.7 ms, p95 17.7 ms |

Other timings:

- A 63-cell sweep (each cell a full Monte Carlo of the overridden cone) takes about 0.3 s.
- Goal seek takes 11 to 15 evaluations, in tens of milliseconds.
- Sensitivity is cached per graph version.
- Long lists (Outliner, Sheet, History, Console) are virtualized.
- The stress graphs bring a synthetic source ledger, so their certificate stays meaningful
  (0 failed).

## Libraries and licences

Exact versions are pinned in package.json; none is loaded before an editor needs it.

| Library | Version | Used by |
| --- | --- | --- |
| Chart.js | 4.4.1 | Controls, Distributions, Scenarios, Simulation (fan chart) |
| d3 | 7.9.0 | Sensitivity, Scenarios (sweep heatmap, goal-seek trace), Scope Graph, Minds |
| three | 0.160.0 (+ `OrbitControls` addon) | 3D Scope Space; Simulation's agent-field tab (loaded when opened) |
| Mermaid | 10.9.1 | Diagram |
| KaTeX | 0.16.9 | Formula, Proofs |
| @vscode/codicons | 0.0.36 | icons (CSS font) |
| Highcharts | 11.4.8 (optional, not loaded by default) | optional adapter only |

**Highcharts licensing:** Highcharts is not open source. It needs a **commercial licence for
commercial products** and is free only for personal or non-commercial use under its own licence
terms. The prototype draws every chart with Chart.js and d3; `src/theme/adapters/highcharts.js`
is only a theming seam for teams that already hold a licence.

## Persistence

`localStorage` stores:

- `millionscope.layout`: workspaces, area trees and editor states;
- `millionscope.theme`: the theme mode;
- `millionscope.deltas`: the delta log, replayed onto the demo graph on reload.

Two commands undo this:

- **Reset Layout** (palette or File menu) restores the workspace presets.
- **Reset Demo Graph** discards local changes.

## Accessibility

- Every icon button has an `aria-label` and a tooltip.
- Areas are `role="region"` landmarks. Splitters are `role="separator"`, resizable with the
  arrow keys.
- Menus follow the WAI-ARIA menu pattern, and long lists are keyboard-navigable virtual lists.
- Provenance never relies on color alone: each mark has a glyph and a label.
- Every chart offers a *View as table* toggle.
- `prefers-reduced-motion` and the *Reduce Motion* command disable pulses, reveal animations and
  3D auto-rotation.

## Known limitations

This is a prototype: the engine, the AI, the swarm, the simulations and the evidence extraction
are deterministic mocks.

- **Numbers outside the graph:**
  - Delphi estimates, log Bayes factors, claim probabilities, sweep cells and simulation
    outcomes are not metrics in the graph.
  - They carry a provenance glyph and a tooltip, and where they estimate a metric they select
    it, but they are not live bound values.
  - Mind profile constants (reciprocity, affect decay) appear as meters, with exact values in
    tooltips and screen-reader text.
- **Formula:** equation variables are mouse-only, because KaTeX hides its visual layer from
  screen readers. Keyboard users reach the same variables through the derivation list (Enter
  selects, Shift+Enter opens).
- **ScopeLang:** read-only. The code view sits behind a seam where CodeMirror 6 could replace
  it.
- **Scope Graph:**
  - Edges that cross scope frames are not routed around them.
  - Layout runs on the main thread (about 100 ms at 10k nodes).
  - Above 2,000 nodes it draws on a canvas; keyboard users then use *View as table*, which
    shows the first 2,000 rows.
- **Diagram:** the swarm sequence diagram shows the first 40 events. Mermaid cannot color
  individual class members, so provenance there is shown by glyph.
- **3D Scope Space:**
  - Layout runs on the main thread (about 70 ms at 100k).
  - Cluster labels are HTML overlays, at most 200 at a time.
  - Above 30k metrics in view, far clusters show as aggregate spheres by design.
  - On software WebGL (headless browsers, VMs), frames are presented through an off-screen
    canvas to avoid synchronous read-back stalls. Real GPUs draw directly.
- **History:** "Restore this version" reproduces the exact state of that version, scenarios
  included, as a new version. Undo brings back anything it removed.
- **Persistence:** a saved delta log is replayed only onto the demo graph it was recorded
  against. If the demo model changes, the old log is skipped, with a note in Console.

## Folder layout

```
index.html            boot theme guard, root layout
themes/               VS Code theme JSON (unmodified), fallbacks, semantic tokens
styles/               base, shell, workspace, composer, menus, shared editor styles
src/core/             L0
src/theme/            L1 (+ adapters/)
src/model/            L2
src/mock/             demo data: bakery graph, swarm scripts, evidence, minds, sims, stress generator
src/services/         L3
src/workspace/        L4
src/editors/          L5: registry.js, base-editor.js, shared/, and one folder per editor
src/shell/            L6
src/main.js           bootstrap (composition root)
tests/                zero-dependency runner and tests
```
