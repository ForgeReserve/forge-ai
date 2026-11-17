// Pip's Garden, the cover game's rules (docs/PLAYFUL.md, The cover game; the design's KidsCover): a
// match-three on a small board. No imports and no page, so it runs in Node and the tests drive it with a
// seeded random source.
//
// A board is a flat array of SIZE * SIZE tile kinds (0 to KINDS - 1), row by row from the top. Every
// function that needs chance takes rand(), any function that returns a number from 0 up to 1 (Math.random
// in the app). A game is {level, flowers, moves, got, board}: the level, the flowers grown in all (the
// score), the moves left in this level, the tiles of the level's kind the player has matched in it, and
// the board.
//
// Each level asks for so many tiles of one kind ("Match ten suns") within MOVES moves. Only the tiles the
// player's own swap matches count; a chain after it grows flowers but not the goal. One swap can match at
// most 2 * SIZE - 1 tiles of a kind (a row and a column through the cell it moved a tile to: 9), and every
// goal is 10 or more, so no level is won in one move. GOALS sets how hard each level is: scripts/garden-sim.ts measures
// it, and test/unit/v2/garden.test.ts keeps it in its bands (docs/PLAYFUL.md, Tuning the difficulty).

/** Tiles on a side. A builder can make the board bigger or smaller here: the screen follows it. */
export const SIZE = 5;
/** Tile kinds: sun, leaf, flower and drop (yellow, green, coral and sky on the screen). */
export const KINDS = 4;
/** Moves in every level. */
export const MOVES = 15;
/** Tiles of the level's kind to match, level by level from level 1; the levels after keep the last. */
export const GOALS = [10, 11, 12, 13, 15, 16, 17, 19, 20, 22, 22, 23, 23, 23, 24];
/** The shape of the game kept on the phone. 1 was the first rules' (a count of matches, chains too). */
export const VERSION = 2;
/** The shortest run that matches. */
export const RUN = 3;
/** Flowers for each tile cleared, and the extra for each tile past three in one run. */
export const PER_TILE = 10;
export const LONG_RUN = 10;
/** The most cascades one move can make; a board that keeps matching past this just stops. */
const MAX_STEPS = 40;

/** A whole number from 0 up to n, from rand(). */
const pick = (rand, n) => Math.min(n - 1, Math.floor(rand() * n));

/** True when a and b are side by side or one above the other. */
export function isNeighbour(a, b, size = SIZE) {
  if (a === b || a < 0 || b < 0 || a >= size * size || b >= size * size) return false;
  const [ra, ca, rb, cb] = [Math.floor(a / size), a % size, Math.floor(b / size), b % size];
  return Math.abs(ra - rb) + Math.abs(ca - cb) === 1;
}

/** The cell next to i in a direction ('up', 'down', 'left', 'right'), or -1 at the edge. */
export function step(i, dir, size = SIZE) {
  const r = Math.floor(i / size);
  const c = i % size;
  if (dir === 'up') return r > 0 ? i - size : -1;
  if (dir === 'down') return r < size - 1 ? i + size : -1;
  if (dir === 'left') return c > 0 ? i - 1 : -1;
  if (dir === 'right') return c < size - 1 ? i + 1 : -1;
  return -1;
}

/** The runs of RUN or more of one kind in a row or a column: [{kind, cells}], rows first. */
export function findRuns(board, size = SIZE) {
  const runs = [];
  const scan = (cellAt) => {
    for (let line = 0; line < size; line++) {
      let start = 0;
      for (let k = 1; k <= size; k++) {
        if (k < size && board[cellAt(line, k)] === board[cellAt(line, start)]) continue;
        if (k - start >= RUN) runs.push({ kind: board[cellAt(line, start)], cells: Array.from({ length: k - start }, (_, j) => cellAt(line, start + j)) });
        start = k;
      }
    }
  };
  scan((r, c) => r * size + c);
  scan((c, r) => r * size + c);
  return runs;
}

/** The board with a and b swapped. */
export function swapped(board, a, b) {
  const next = board.slice();
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** A swap is allowed when a and b are neighbours and the swap makes a run. */
export const canSwap = (board, a, b, size = SIZE) => isNeighbour(a, b, size) && findRuns(swapped(board, a, b), size).length > 0;

/** A swap that makes a run, as [a, b], or null when the board has none. */
export function findMove(board, size = SIZE) {
  for (let i = 0; i < size * size; i++) {
    for (const j of [step(i, 'right', size), step(i, 'down', size)]) if (j >= 0 && board[i] !== board[j] && canSwap(board, i, j, size)) return [i, j];
  }
  return null;
}

export const hasMove = (board, size = SIZE) => findMove(board, size) !== null;

/** A board with no run and at least one move. Each tile avoids making three with the two before it. */
export function newBoard(rand = Math.random, size = SIZE, kinds = KINDS) {
  for (let tries = 0; tries < 100; tries++) {
    const b = [];
    for (let i = 0; i < size * size; i++) {
      const r = Math.floor(i / size);
      const c = i % size;
      const banned = new Set();
      if (c >= 2 && b[i - 1] === b[i - 2]) banned.add(b[i - 1]);
      if (r >= 2 && b[i - size] === b[i - 2 * size]) banned.add(b[i - size]);
      const open = Array.from({ length: kinds }, (_, k) => k).filter((k) => !banned.has(k));
      b.push(open[pick(rand, open.length)]);
    }
    if (hasMove(b, size)) return b;
  }
  // Not reached with four kinds on a five by five board; a fixed pattern with a move, just in case.
  return Array.from({ length: size * size }, (_, i) => (i === 1 ? 0 : (Math.floor(i / size) + (i % size)) % kinds));
}

/**
 * The same tiles in a new order, with no run and at least one move (the board was stuck). Falls back to
 * a new board when the tiles cannot be placed so.
 */
export function reshuffle(board, rand = Math.random, size = SIZE, kinds = KINDS) {
  for (let tries = 0; tries < 200; tries++) {
    const b = board.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = pick(rand, i + 1);
      [b[i], b[j]] = [b[j], b[i]];
    }
    if (!findRuns(b, size).length && hasMove(b, size)) return b;
  }
  return newBoard(rand, size, kinds);
}

/**
 * Clears `cleared` (a set of cells), lets the tiles above fall into the gaps and drops new ones in from
 * the top. Returns {board, falls: [{from, to}], drops: [{to, kind, from}]}, where a drop's `from` is the
 * row above the board it starts on (-1 is just above the top row), for the screen to animate.
 */
export function fall(board, cleared, rand = Math.random, size = SIZE, kinds = KINDS) {
  const next = board.slice();
  const falls = [];
  const drops = [];
  for (let c = 0; c < size; c++) {
    let write = size - 1;
    for (let r = size - 1; r >= 0; r--) {
      const i = r * size + c;
      if (cleared.has(i)) continue;
      const to = write * size + c;
      if (to !== i) falls.push({ from: i, to });
      next[to] = board[i];
      write--;
    }
    const empty = write + 1;
    for (let r = write; r >= 0; r--) {
      const kind = pick(rand, kinds);
      next[r * size + c] = kind;
      drops.push({ to: r * size + c, kind, from: r - empty });
    }
  }
  return { board: next, falls, drops };
}

/**
 * Clears every run, lets the tiles fall, and goes on while the new tiles make runs (a chain). Returns
 * {board, steps}: one step per round, {runs, cleared (sorted cells), falls, drops, board after it}.
 */
export function settle(board, rand = Math.random, size = SIZE, kinds = KINDS) {
  const steps = [];
  let b = board;
  for (let n = 0; n < MAX_STEPS; n++) {
    const runs = findRuns(b, size);
    if (!runs.length) break;
    const cleared = new Set(runs.flatMap((x) => x.cells));
    const f = fall(b, cleared, rand, size, kinds);
    steps.push({ runs, cleared: [...cleared].sort((x, y) => x - y), falls: f.falls, drops: f.drops, board: f.board });
    b = f.board;
  }
  return { board: b, steps };
}

/**
 * The flowers a round grows: PER_TILE for each tile of each run, LONG_RUN more for each tile past three,
 * all times the round's place in the chain (1 for the swap's own match, 2 for the next, and on).
 */
export function flowersFor(runs, chain = 1) {
  return runs.reduce((sum, r) => sum + r.cells.length * PER_TILE + Math.max(0, r.cells.length - RUN) * LONG_RUN, 0) * chain;
}

/** A level's goal: the kind to match (sun, leaf, flower, drop, then round again), how many, and the moves. */
export function goalFor(level) {
  const n = Math.max(1, Math.floor(level) || 1);
  return { kind: (n - 1) % KINDS, count: GOALS[Math.min(n, GOALS.length) - 1], moves: MOVES };
}

/** How many cells of `kind` these runs hold (a tile in two runs counts once). */
export function goalTiles(runs, kind) {
  const cells = new Set();
  for (const r of runs) if (r.kind === kind) for (const c of r.cells) cells.add(c);
  return cells.size;
}

/** A new game at `level`, with the flowers grown so far. */
export function newGame(level = 1, flowers = 0, rand = Math.random, size = SIZE, kinds = KINDS) {
  const lv = Math.max(1, Math.floor(level) || 1);
  return { level: lv, flowers: Math.max(0, Math.floor(flowers) || 0), moves: goalFor(lv).moves, got: 0, board: newBoard(rand, size, kinds) };
}

/** Tiles still to match in this level (0 once it is done). */
export const toGo = (game) => Math.max(0, goalFor(game.level).count - game.got);

/** 'won' once the level's tiles are matched, 'lost' when the moves ran out first, else null. */
export const outcome = (game) => (toGo(game) === 0 ? 'won' : game.moves <= 0 ? 'lost' : null);

/**
 * One move: swap a and b. An invalid swap (not neighbours, no run, or the level is over) is {ok: false}
 * and costs nothing. A valid one clears its runs and the chain after them, takes a move, counts the goal
 * tiles its own runs matched and the flowers of every round, and reshuffles a board left with no move.
 * Returns {ok, game (the new one), steps (from settle), got (goal tiles matched), flowers (grown by this
 * move), shuffled (the board before the reshuffle, or null), outcome}.
 */
export function move(game, a, b, rand = Math.random, size = SIZE, kinds = KINDS) {
  if (outcome(game) || !canSwap(game.board, a, b, size)) return { ok: false };
  const { board, steps } = settle(swapped(game.board, a, b), rand, size, kinds);
  const got = goalTiles(steps[0].runs, goalFor(game.level).kind);
  const grown = steps.reduce((n, s, k) => n + flowersFor(s.runs, k + 1), 0);
  const stuck = !hasMove(board, size);
  const next = { ...game, moves: game.moves - 1, got: game.got + got, flowers: game.flowers + grown, board: stuck ? reshuffle(board, rand, size, kinds) : board };
  return { ok: true, game: next, steps, got, flowers: grown, shuffled: stuck ? board : null, outcome: outcome(next) };
}

/**
 * A game kept on the phone, checked: the version, the shape, the numbers and the board (the right size,
 * kinds in range, no run, a move). One kept under the first rules (no `v: 2`) keeps its level and flowers
 * and gets a new board under these rules; anything else that does not pass starts its level again, or
 * level 1.
 */
export function restore(saved, rand = Math.random, size = SIZE, kinds = KINDS) {
  if (!saved || typeof saved !== 'object') return newGame(1, 0, rand, size, kinds);
  const level = Number.isInteger(saved.level) && saved.level >= 1 ? saved.level : 1;
  const flowers = Number.isInteger(saved.flowers) && saved.flowers >= 0 ? saved.flowers : 0;
  const goal = goalFor(level);
  const b = saved.board;
  const boardOk = Array.isArray(b) && b.length === size * size && b.every((k) => Number.isInteger(k) && k >= 0 && k < kinds) && !findRuns(b, size).length && hasMove(b, size);
  const movesOk = Number.isInteger(saved.moves) && saved.moves >= 1 && saved.moves <= goal.moves;
  const gotOk = Number.isInteger(saved.got) && saved.got >= 0 && saved.got < goal.count;
  if (saved.v !== VERSION || !boardOk || !movesOk || !gotOk) return newGame(level, flowers, rand, size, kinds);
  return { level, flowers, moves: saved.moves, got: saved.got, board: b.slice() };
}
