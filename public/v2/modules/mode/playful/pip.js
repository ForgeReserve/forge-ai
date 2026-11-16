// Pip, Playful mode's helper (docs/PLAYFUL.md): a round yellow face with a small sprout, drawn as inline
// SVG at any size. One drawing with a few moods, so other screens (the cover game, an event's own screens)
// can use the same Pip:
//   idle       the design's smile
//   listening  eyes wide, a small round mouth, the sprout up: while a question is recorded
//   thinking   eyes up to one side, a flat mouth and a thought: while the answer is awaited
//   reading    happy closed eyes and an open mouth: while the answer is read aloud
//   oops       worried brows, a wavy mouth and a drop: when something went wrong
// Each mood moves a little (a bob, the sprout, the mouth, the thought) with SVG's own animation, so Pip
// needs no stylesheet; with reduced motion nothing moves. The markup is static and from this file only.
import { reduced } from '../../../core/ui.js';

export const MOODS = ['idle', 'listening', 'thinking', 'reading', 'oops'];

const INK = '#1B1440';
const SUN = '#FFD23F';
const LEAF = '#3DDC97';
const CHEEK = '#FF8A7A';
const DROP = '#7FD4FF';

const NS = 'http://www.w3.org/2000/svg';

/** One part's SVG animation, or '' with reduced motion. */
const move = (attrs) => (reduced() ? '' : `<animateTransform attributeName="transform" ${attrs} repeatCount="indefinite"/>`);

/** Two eyes with their highlights, at a pupil offset. */
const eyes = (dx = 0, dy = 0, r = 9) =>
  `<circle cx="${64 + dx}" cy="${86 + dy}" r="${r}" fill="${INK}"/><circle cx="${106 + dx}" cy="${86 + dy}" r="${r}" fill="${INK}"/>` +
  `<circle cx="${67 + dx}" cy="${83 + dy}" r="3" fill="#FFFFFF"/><circle cx="${109 + dx}" cy="${83 + dy}" r="3" fill="#FFFFFF"/>`;

/** The face of each mood: eyes, mouth and anything else, drawn over the body. */
const FACES = {
  idle: () => eyes() + `<path d="M66 112c10 12 28 12 38 0" stroke="${INK}" stroke-width="6" stroke-linecap="round" fill="none"/>`,
  listening: () =>
    eyes(0, -2, 10) +
    `<path d="M56 68l14-3M114 68l-14-3" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>` +
    `<ellipse cx="85" cy="116" rx="8" ry="9" fill="${INK}">${reduced() ? '' : '<animate attributeName="ry" values="9;6;9" dur="0.9s" repeatCount="indefinite"/>'}</ellipse>`,
  thinking: () =>
    eyes(-5, -5) +
    `<path d="M72 116h26" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>` +
    `<g fill="${INK}" opacity="0.55"><circle cx="140" cy="44" r="6"/><circle cx="152" cy="26" r="4">${reduced() ? '' : '<animate attributeName="opacity" values="1;0.2;1" dur="1.4s" repeatCount="indefinite"/>'}</circle></g>`,
  reading: () =>
    `<path d="M55 88q9-10 18 0M97 88q9-10 18 0" stroke="${INK}" stroke-width="6" stroke-linecap="round" fill="none"/>` +
    `<g transform="translate(85 108)"><path d="M-17 0q17 20 34 0z" fill="${INK}">${move('type="scale" values="1 1;1 0.45;1 1" dur="0.5s"')}</path></g>`,
  oops: () =>
    eyes(0, 2, 8) +
    `<path d="M52 72l16 6M118 72l-16 6" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="M66 120q6-7 12 0t12 0t12 0" stroke="${INK}" stroke-width="5" stroke-linecap="round" fill="none"/>` +
    `<path d="M132 52c5 8 8 12 8 16a8 8 0 0 1-16 0c0-4 3-8 8-16z" fill="${DROP}"/>`,
};

/** The sprout's sway by mood: up and quick while listening, still when something went wrong. */
const SWAY = { idle: '0 85 32;-6 85 32;0 85 32', listening: '-10 85 32;4 85 32;-10 85 32', thinking: '0 85 32;8 85 32;0 85 32', reading: '0 85 32;-6 85 32;0 85 32', oops: null };

function markup(mood) {
  const m = MOODS.includes(mood) ? mood : 'idle';
  const sway = SWAY[m] ? move(`type="rotate" values="${SWAY[m]}" dur="${m === 'listening' ? '0.8s' : '2.6s'}"`) : '';
  const bob = m === 'oops' ? '' : move('type="translate" values="0 0;0 -3;0 0" dur="3s"');
  return (
    `<g>${bob}` +
    `<path d="M85 30c-2-12 6-20 16-22-2 10-6 18-16 22z" fill="${LEAF}">${sway}</path>` +
    `<circle cx="85" cy="95" r="62" fill="${SUN}"/>` +
    `<circle cx="46" cy="104" r="8" fill="${CHEEK}"/><circle cx="124" cy="104" r="8" fill="${CHEEK}"/>` +
    FACES[m]() +
    '</g>'
  );
}

/**
 * Pip at `size` px in `mood`. With a `label` Pip is an image with that name; without one Pip is
 * decoration beside words that say what Pip does. Returns {node, set(mood)}.
 */
export function pip({ size = 84, mood = 'idle', label = null } = {}) {
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 170 170', class: 'pip' })) s.setAttribute(k, String(v));
  if (label) {
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label);
  } else s.setAttribute('aria-hidden', 'true');
  let now = null;
  const set = (m) => {
    const next = MOODS.includes(m) ? m : 'idle';
    if (next === now) return;
    now = next;
    s.dataset.mood = next;
    s.innerHTML = markup(next);
  };
  set(mood);
  return { node: s, set };
}
