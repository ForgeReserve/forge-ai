// Pip's Garden (docs/PLAYFUL.md, The cover game; the design's KidsCover): the match-three Playful opens
// on, with the helper behind it. A cover game is self-contained: it imports only its own rules, and the
// cover screen (../../cover.js) hands it what it may use. It never sees the app.
//
//   mount(node, {t, el, reduced, pip, progress}) puts the game in `node` and returns {tap(), held(),
//   destroy()}. t: the string table. el: the app's element helper. reduced(): true with reduced motion.
//   pip: {node, set(mood)}, Pip as a button the cover screen made (it owns the hold that opens the helper);
//   the game places it and sets its mood. progress: {load(), save(data)}, the game's own record on the
//   phone. tap(): Pip was tapped (say a line). held(): Pip was held and the helper is opening.
//
// The board is two layers: the tiles, drawn and moved with transform and opacity only, and over them a
// fixed grid of buttons, one per cell, for touch, the keyboard and screen readers. Drag a tile onto its
// neighbour, or tap one then the other. With the keyboard: the arrow keys move between the tiles, Enter or
// Space picks one up, an arrow key then swaps it that way, and Escape puts it down. What happened is said
// in a live region. With reduced motion nothing slides: each step shows at once.
import { isNeighbour, move, newGame, restore, SIZE, step, toGo } from './logic.js';

export const id = 'garden';
/** The string key of the game's name, which is also the page's title while it shows. */
export const title = 'garden.title';
/** The page's icon while the game shows, and the game's stylesheet (loaded with Playful's screens). */
export const icon = new URL('./icon.svg', import.meta.url).href;
export const styles = new URL('./garden.css', import.meta.url).href;

/** How long each kind of step slides, in ms. */
const SWAP_MS = 170;
const CLEAR_MS = 200;
const FALL_MS = 260;
/** A drag this far, as a share of a tile, is a swap. */
const DRAG = 0.35;

const INK = '#1B1440';
/** Each kind's picture, on its own colour, so colour is never the only cue: a sun, a leaf, a flower, a drop. */
const SHAPES = [
  `<circle cx="12" cy="12" r="4.2" fill="${INK}"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`,
  `<path d="M5 19C5 10.5 10.5 5 19 5c0 8.5-5.5 14-14 14z" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/><path d="M5 19l8.5-8.5" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`,
  `<g fill="none" stroke="${INK}" stroke-width="2"><circle cx="12" cy="6.6" r="3"/><circle cx="17.1" cy="10.3" r="3"/><circle cx="15.2" cy="16.3" r="3"/><circle cx="8.8" cy="16.3" r="3"/><circle cx="6.9" cy="10.3" r="3"/></g><circle cx="12" cy="12" r="2.4" fill="${INK}"/>`,
  `<path d="M12 3.2c3.6 4.6 5.8 7.9 5.8 10.9a5.8 5.8 0 0 1-11.6 0c0-3 2.2-6.3 5.8-10.9z" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linejoin="round"/><path d="M9.4 14.6a2.7 2.7 0 0 0 2.2 2.4" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`,
];
const NS = 'http://www.w3.org/2000/svg';

function shape(kind) {
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'gd-shape' })) s.setAttribute(k, v);
  s.innerHTML = SHAPES[kind] ?? '';
  return s;
}

/** A small picture beside Moves (two arrows that swap) and Flowers (a flower). */
function mark(name) {
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', class: 'gd-mark' })) s.setAttribute(k, v);
  s.innerHTML =
    name === 'moves'
      ? '<path d="M4 8h14l-3-3M20 16H6l3 3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<g fill="#FF8A7A"><circle cx="12" cy="6.5" r="3.4"/><circle cx="17.3" cy="10.4" r="3.4"/><circle cx="15.3" cy="16.6" r="3.4"/><circle cx="8.7" cy="16.6" r="3.4"/><circle cx="6.7" cy="10.4" r="3.4"/></g><circle cx="12" cy="12" r="2.8" fill="#FFD23F"/>';
  return s;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function mount(node, { t, el, reduced, pip, progress }) {
  const size = SIZE;
  const n = size * size;
  let game = restore(progress.load());
  let dead = false;
  let busy = false;
  let picked = -1;
  let focused = 0;
  let tapN = 0;
  let after = null; // the game kept for Next level or Play again, once a level ended
  /** What shows in Pip's card: its line, the line under it and the button, if any ('next' or 'again'). */
  let card = { say: 'garden.hello', sub: null, mood: 'idle', button: null };
  const ms = (x) => (reduced() ? 0 : x);

  const level = el('p', { class: 'gd-level', id: 'gameLevel' });
  const moves = el('span', { class: 'gd-stat', id: 'gameMoves' });
  const flowers = el('span', { class: 'gd-stat', id: 'gameFlowers' });
  const layer = el('div', { class: 'gd-tiles', 'aria-hidden': 'true' });
  const cellsBox = el('div', { class: 'gd-cells', id: 'gameCells', role: 'group', 'aria-label': t('garden.board', { size }) });
  const cells = Array.from({ length: n }, (_, i) => el('button', { type: 'button', class: 'gd-cell', 'data-i': String(i), tabindex: i === 0 ? '0' : '-1' }));
  cellsBox.append(...cells);
  const board = el('div', { class: 'gd-board', id: 'gameBoard', style: `--size: ${size}` }, layer, cellsBox);
  const say = el('p', { class: 'gd-say', id: 'gameSay' });
  const sub = el('p', { class: 'gd-sub', id: 'gameSub' });
  const go = el('div', { class: 'gd-go' });
  const live = el('p', { class: 'sr-only', id: 'gameLive', role: 'status', 'aria-live': 'polite' });
  pip.node.classList.add('gd-pip');
  const root = el(
    'div',
    { class: 'gd' },
    el('header', { class: 'gd-head' }, el('h1', { class: 'gd-title', text: t('garden.title') }), level),
    el('p', { class: 'gd-how', text: t('garden.how') }),
    board,
    el('div', { class: 'gd-stats' }, el('span', { class: 'gd-stat-wrap' }, mark('moves'), moves), el('span', { class: 'gd-stat-wrap' }, mark('flowers'), flowers)),
    el('div', { class: 'gd-card' }, pip.node, el('div', { class: 'gd-words' }, say, sub), go),
    live,
  );
  node.append(root);

  // ---------------------------------------------------------------- the tiles

  /** tiles[i]: the tile on cell i, {node, kind}. */
  let tiles = [];
  const place = (tile, i, row = Math.floor(i / size)) => {
    tile.node.style.setProperty('--c', String(i % size));
    tile.node.style.setProperty('--r', String(row));
  };
  const makeTile = (kind, i, row) => {
    const tile = { kind, node: el('div', { class: `gd-tile k${kind}` }) };
    tile.node.append(shape(kind));
    place(tile, i, row);
    layer.append(tile.node);
    return tile;
  };
  const drawAll = () => {
    layer.replaceChildren();
    tiles = game.board.map((k, i) => makeTile(k, i));
  };

  const kindName = (k) => t(`garden.kind.${k}`);
  const tileName = (i) => t('garden.tile', { kind: kindName(game.board[i]), row: Math.floor(i / size) + 1, col: (i % size) + 1 });

  /** The cells' names and the one tab stop, after any change. */
  const label = () => {
    cells.forEach((c, i) => {
      c.setAttribute('aria-label', tileName(i));
      c.setAttribute('aria-pressed', String(i === picked));
      c.tabIndex = i === focused ? 0 : -1;
      c.dataset.kind = String(game.board[i]);
    });
    tiles.forEach((tile, i) => tile?.node.classList.toggle('picked', i === picked));
  };

  // ---------------------------------------------------------------- Pip's card and the counts

  /** How many matches are left, in words: "Three more matches to bloom." */
  const left = () => {
    const k = toGo(game);
    if (k === 1) return t('garden.toGoOne');
    return t('garden.toGo', { count: k <= 10 ? t(`garden.num.${k}`) : String(k) });
  };

  const show = () => {
    level.textContent = t('garden.level', { n: game.level });
    moves.textContent = t('garden.moves', { n: Math.max(0, game.moves) });
    flowers.textContent = t('garden.flowers', { n: game.flowers });
    say.textContent = t(card.say);
    sub.textContent = card.sub === 'left' ? left() : card.sub ? t(card.sub, { n: game.level }) : '';
    sub.hidden = !sub.textContent;
    pip.set(card.mood);
    const b = card.button;
    go.replaceChildren(
      ...(b
        ? [
            el(
              'button',
              { type: 'button', class: 'gd-btn', id: b === 'next' ? 'gameNext' : 'gameAgain', onclick: () => (b === 'next' ? nextLevel() : playAgain()) },
              arrow(b),
              el('span', { text: t(b === 'next' ? 'garden.next' : 'garden.again') }),
            ),
          ]
        : []),
    );
  };

  /** The Next level and Play again buttons' pictures. */
  function arrow(b) {
    const s = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '22', height: '22', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    s.innerHTML = b === 'next' ? '<path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' : '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.7M4 4v4.7h4.7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
    return s;
  }

  const tell = (text) => {
    live.textContent = '';
    setTimeout(() => !dead && (live.textContent = text), 30);
  };
  const keep = (g = game) => progress.save({ v: 1, level: g.level, flowers: g.flowers, moves: g.moves, made: g.made, board: g.board.slice() });

  // ---------------------------------------------------------------- moves

  /** How long the next slide takes (the tiles' transition reads it). */
  const slide = (x) => layer.style.setProperty('--slide', `${ms(x)}ms`);
  const swapTiles = (a, b) => {
    slide(SWAP_MS);
    [tiles[a], tiles[b]] = [tiles[b], tiles[a]];
    place(tiles[a], a);
    place(tiles[b], b);
  };

  async function attempt(a, b) {
    if (busy || dead || card.button || !isNeighbour(a, b, size)) return;
    busy = true;
    picked = -1;
    label();
    swapTiles(a, b);
    await wait(ms(SWAP_MS));
    if (dead) return;
    const res = move(game, a, b);
    if (!res.ok) {
      // No match: the tiles slide back, and nothing is spent.
      swapTiles(a, b);
      await wait(ms(SWAP_MS));
      if (dead) return;
      card = { say: 'garden.noMatch', sub: 'garden.tryAgain', mood: 'oops', button: null };
      show();
      tell(`${t('garden.noMatch')} ${t('garden.swapBack')}`);
      busy = false;
      label();
      return;
    }
    for (const s of res.steps) {
      for (const i of s.cleared) {
        const tile = tiles[i];
        tile.node.classList.add('gone');
        setTimeout(() => tile.node.remove(), ms(CLEAR_MS) + 40);
      }
      await wait(ms(CLEAR_MS));
      if (dead) return;
      const next = tiles.slice();
      for (const f of s.falls) next[f.to] = tiles[f.from];
      const fresh = s.drops.map((d) => (next[d.to] = makeTile(d.kind, d.to, d.from)));
      tiles = next;
      slide(FALL_MS);
      // The new tiles are drawn above the board first, then all slide to their cells together.
      if (fresh.length && !reduced()) void layer.offsetWidth;
      tiles.forEach((tile, i) => place(tile, i));
      await wait(ms(FALL_MS));
      if (dead) return;
    }
    game = res.game;
    if (res.shuffled) {
      // Stuck: the same tiles in a new order, faded in.
      drawAll();
      for (const tile of tiles) tile.node.classList.add('fresh');
      void layer.offsetWidth;
      for (const tile of tiles) tile.node.classList.remove('fresh');
    }
    const chain = res.steps.length > 1;
    if (res.outcome === 'won') {
      // The next level is kept at once, so a phone closed now opens on it.
      after = newGame(game.level + 1, game.flowers);
      keep(after);
      card = { say: 'garden.won', sub: 'garden.wonSub', mood: 'reading', button: 'next' };
    } else if (res.outcome === 'lost') {
      after = newGame(game.level, game.flowers);
      keep(after);
      card = { say: 'garden.lost', sub: 'garden.lostSub', mood: 'oops', button: 'again' };
    } else {
      keep();
      card = { say: res.shuffled ? 'garden.shuffle' : chain ? 'garden.chain' : 'garden.nice', sub: 'left', mood: res.shuffled ? 'thinking' : 'reading', button: null };
    }
    show();
    tell(`${t(card.say)} ${sub.textContent} ${t('garden.flowers', { n: game.flowers })}.`);
    busy = false;
    label();
    if (card.button) go.querySelector('button')?.focus({ preventScroll: true });
  }

  function start(g) {
    game = g;
    after = null;
    picked = -1;
    drawAll();
    card = { say: 'garden.hello', sub: 'left', mood: 'idle', button: null };
    show();
    label();
    keep();
    tell(`${t('garden.level', { n: game.level })}. ${left()}`);
  }
  /** Next level and Play again: the game kept when the level ended. */
  const nextLevel = () => start(after ?? newGame(game.level + 1, game.flowers));
  const playAgain = () => start(after ?? newGame(game.level, game.flowers));

  // ---------------------------------------------------------------- input: tap, drag and keys

  const cellOf = (e) => {
    const b = e.target?.closest?.('.gd-cell');
    return b ? Number(b.dataset.i) : -1;
  };
  const focusCell = (i) => {
    focused = i;
    label();
    cells[i].focus({ preventScroll: true });
  };

  /** A tap (or Enter or Space) on a cell: pick it, put it down, or swap it with the picked neighbour. */
  function tapCell(i) {
    if (busy || card.button) return;
    focused = i;
    if (picked === i) {
      picked = -1;
      label();
      return;
    }
    if (picked >= 0 && isNeighbour(picked, i, size)) return attempt(picked, i);
    picked = i;
    label();
    tell(t('garden.picked', { tile: tileName(i) }));
  }

  let drag = null; // {i, x, y, done}
  let skipClick = false;
  const off = new AbortController();
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: off.signal });
  on(cellsBox, 'pointerdown', (e) => {
    const i = cellOf(e);
    if (i < 0 || e.button > 0) return;
    // No pointer capture: the click that follows a tap must reach the cell. A touch keeps its moves on
    // the cell it started on anyway, and they reach this box.
    drag = { i, x: e.clientX, y: e.clientY, done: false };
    skipClick = false;
  });
  on(cellsBox, 'pointermove', (e) => {
    if (!drag || drag.done) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const reach = cells[0].getBoundingClientRect().width * DRAG;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < reach) return;
    drag.done = true;
    skipClick = true;
    const j = step(drag.i, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up', size);
    if (j >= 0) attempt(drag.i, j);
  });
  const endDrag = () => {
    drag = null;
  };
  on(cellsBox, 'pointerup', endDrag);
  on(cellsBox, 'pointercancel', endDrag);
  on(cellsBox, 'click', (e) => {
    const i = cellOf(e);
    if (skipClick) {
      skipClick = false;
      return;
    }
    if (i >= 0) tapCell(i);
  });
  on(cellsBox, 'keydown', (e) => {
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    const i = cellOf(e);
    if (i < 0) return;
    if (e.key === 'Escape' && picked >= 0) {
      e.preventDefault();
      picked = -1;
      label();
      return;
    }
    if (!dir) return;
    e.preventDefault();
    const j = step(i, dir, size);
    if (j < 0) return;
    // A picked tile goes that way; otherwise the arrow moves along the board.
    if (picked === i) return attempt(i, j);
    focusCell(j);
  });
  on(cellsBox, 'focusin', (e) => {
    const i = cellOf(e);
    if (i >= 0 && i !== focused) {
      focused = i;
      label();
    }
  });

  drawAll();
  card = { say: 'garden.hello', sub: 'left', mood: 'idle', button: null };
  show();
  label();

  return {
    /** Pip was tapped: a game line. */
    tap() {
      if (dead) return;
      const k = tapN++ % 3;
      card = { ...card, say: `garden.tap.${k}`, mood: 'reading' };
      show();
      tell(t(card.say));
    },
    /** Pip was held: the helper opens now. The game is kept as it is. */
    held() {
      if (!dead && !busy && !card.button) keep();
    },
    destroy() {
      dead = true;
      off.abort();
    },
  };
}
