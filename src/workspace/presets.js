/**
 * Default layouts. Each preset builds a fresh AreaTree (new ids every time).
 * @module workspace/presets
 */
import { AreaTree, makeArea as A, makeSplit as S } from './area-tree.js';

/**
 * @typedef {Object} Preset
 * @property {string} key
 * @property {string} name
 * @property {string} icon
 * @property {string} description
 * @property {() => AreaTree} build
 */

/** @type {Preset[]} */
export const PRESETS = [
  {
    key: 'home',
    name: 'Home',
    icon: 'home',
    description: 'Human Atlas on the left; Earth Globe above Atom and Solar System on the right.',
    build: () => new AreaTree(
      S('row', 0.45,
        A('scope'),
        S('col', 0.55,
          A('globe'),
          S('row', 0.5, A('atom'), A('solar')))),
    ),
  },
  {
    key: 'model',
    name: 'Model',
    icon: 'type-hierarchy-sub',
    description: 'Outliner, Scope Graph and Properties above the Sheet.',
    build: () => new AreaTree(
      S('col', 0.7,
        S('row', 0.2,
          A('outliner'),
          S('row', 0.725, A('graph'), A('inspector'))),
        A('sheet')),
    ),
  },
  {
    key: 'scenarios',
    name: 'Scenarios',
    icon: 'repo-forked',
    description: 'Scenario compare/sweep/goal seek with Sensitivity and Distributions; Chat below.',
    build: () => new AreaTree(
      S('col', 0.72,
        S('row', 0.6,
          A('scenarios'),
          S('col', 0.5, A('sensitivity'), A('distribution'))),
        A('chat')),
    ),
  },
  {
    key: 'minds',
    name: 'Minds',
    icon: 'organization',
    description: 'Mind Scopes beside Simulation and Evidence; Chat below.',
    build: () => new AreaTree(
      S('col', 0.72,
        S('row', 0.5,
          A('minds'),
          S('col', 0.55, A('simulation'), A('evidence'))),
        A('chat')),
    ),
  },
  {
    key: 'verify',
    name: 'Verify',
    icon: 'verified',
    description: 'Certificate, Formula over Proofs, ScopeLang; Console below.',
    build: () => new AreaTree(
      S('col', 0.74,
        S('row', 0.3,
          A('certificate'),
          S('row', 0.57,
            S('col', 0.5, A('formula'), A('proofs')),
            A('scopelang'))),
        A('console')),
    ),
  },
  {
    key: 'space',
    name: 'Space',
    icon: 'globe',
    description: '3D Scope Space with Properties and a small Chat.',
    build: () => new AreaTree(
      S('row', 0.78,
        A('space3d'),
        S('col', 0.62, A('inspector'), A('chat'))),
    ),
  },
  {
    key: 'scope',
    name: 'Human Atlas',
    icon: 'pulse',
    description: 'Anatomy hologram (body and brain) with annotations; Chat beside it.',
    build: () => new AreaTree(S('row', 0.76, A('scope'), A('chat'))),
  },
  {
    key: 'solar',
    name: 'Solar',
    icon: 'globe',
    description: 'Solar system with a looping camera tour (system → Earth → full system); Chat beside it.',
    build: () => new AreaTree(S('row', 0.76, A('solar'), A('chat'))),
  },
];

/** @param {string} key */
export function getPreset(key) {
  return PRESETS.find((p) => p.key === key) || null;
}
