import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Pip's Garden, Playful's cover game (docs/PLAYFUL.md, The cover game): the rules in
// public/v2/modules/mode/playful/games/garden/logic.js with a seeded random source, how hard the levels are
// (scripts/garden-sim.ts, played many times), the setting that opens it first, where its record is kept
// (and that Erase everything takes it), and that the game sees nothing of the app.
const ROOT = resolve(import.meta.dirname, '../../..');
const GAME = 'public/v2/modules/mode/playful/games/garden';
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const G: any = await import('../../../public/v2/modules/mode/playful/games/garden/logic.js' as string);
const STATE: any = await import('../../../public/v2/core/state.js' as string);
const R: any = await import('../../../public/v2/core/registry.js' as string);
const ROUTER: any = await import('../../../public/v2/core/router.js' as string);
const E: any = await import('../../../public/v2/core/erase.js' as string);
const DB: any = await import('../../../public/v2/core/db.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
const SIM = await import('../../../scripts/garden-sim.ts');
type SimStats = import('../../../scripts/garden-sim.ts').LevelStats;

/** A seeded random source (mulberry32): the same seed, the same boards. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A random source that always says the same thing. */
const always = (x: number) => () => x;
/** A random source that says `first` in order, then goes on as `then`. */
const seq = (first: number[], then: () => number) => {
  const q = [...first];
  return () => (q.length ? q.shift()! : then());
};

// Boards in the tests are written as rows of letters: s sun, l leaf, f flower, d drop.
const K: Record<string, number> = { s: 0, l: 1, f: 2, d: 3 };
const board = (...rows: string[]) => rows.join('').split('').map((c) => K[c]!);
const at = (r: number, c: number) => r * G.SIZE + c;

describe('the board', () => {
  it('is 5 by 5 with four kinds and 15 moves a level, and those are constants', () => {
    expect(G.SIZE).toBe(5);
    expect(G.KINDS).toBe(4);
    expect(G.RUN).toBe(3);
    expect(G.MOVES).toBe(15);
    expect(G.VERSION).toBe(2);
  });

  it('starts with no match and at least one move, from any seed, and the same seed gives the same board', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const b = G.newBoard(seeded(seed));
      expect(b).toHaveLength(25);
      expect(b.every((k: number) => k >= 0 && k < 4)).toBe(true);
      expect(G.findRuns(b), `seed ${seed}`).toEqual([]);
      expect(G.hasMove(b), `seed ${seed}`).toBe(true);
    }
    expect(G.newBoard(seeded(7))).toEqual(G.newBoard(seeded(7)));
    expect(G.newBoard(seeded(7))).not.toEqual(G.newBoard(seeded(8)));
  });

  it('follows SIZE: a bigger board works the same', () => {
    const b = G.newBoard(seeded(3), 7);
    expect(b).toHaveLength(49);
    expect(G.findRuns(b, 7)).toEqual([]);
    expect(G.hasMove(b, 7)).toBe(true);
  });
});

describe('matches', () => {
  it('finds runs of three or more across and down, and none of two', () => {
    const b = board('sssld', 'lfdfs', 'lfdsl', 'ldfsd', 'fsdlf');
    expect(G.findRuns(b)).toEqual([
      { kind: K.s, cells: [at(0, 0), at(0, 1), at(0, 2)] },
      { kind: K.l, cells: [at(1, 0), at(2, 0), at(3, 0)] },
    ]);
    // A run of five across the bottom row.
    expect(G.findRuns(board('sldfs', 'ldfsl', 'dfsld', 'fsldf', 'ddddd'))).toEqual([{ kind: K.d, cells: [20, 21, 22, 23, 24] }]);
    expect(G.findRuns(board('sslls', 'ldfsl', 'dfsld', 'fsldf', 'sldfs'))).toEqual([]);
  });

  it('a swap is valid only between neighbours and only when it makes a run', () => {
    // Swapping (0,2) and (1,2) brings a sun into row 1 beside two suns.
    const b = board('lfsdl', 'ssfld', 'dlfsl', 'fsdlf', 'ldsfd');
    expect(G.findRuns(b)).toEqual([]);
    expect(G.isNeighbour(at(0, 2), at(1, 2))).toBe(true);
    expect(G.canSwap(b, at(0, 2), at(1, 2))).toBe(true);
    expect(G.canSwap(b, at(0, 0), at(0, 1))).toBe(false); // neighbours, no run
    expect(G.canSwap(b, at(0, 2), at(2, 2))).toBe(false); // not neighbours
    expect(G.isNeighbour(at(0, 4), at(1, 0))).toBe(false); // the end of one row and the start of the next
    expect(G.step(at(0, 4), 'right')).toBe(-1);
    expect(G.step(at(2, 2), 'up')).toBe(at(1, 2));
  });

  it('an invalid swap changes nothing and costs no move', () => {
    const g = { level: 1, flowers: 0, moves: 15, got: 0, board: board('lfsdl', 'ssfld', 'dlfsl', 'fsdlf', 'ldsfd') };
    expect(G.move(g, at(0, 0), at(0, 1), seeded(1))).toEqual({ ok: false });
    expect(G.move(g, at(0, 0), at(3, 3), seeded(1))).toEqual({ ok: false });
    expect(g.moves).toBe(15);
  });
});

describe('gravity and refill', () => {
  it('clears, drops the tiles above into the gap, and fills the top from above the board', () => {
    const b = board('sldfs', 'ldfsl', 'fffld', 'dslds', 'sldfl');
    const f = G.fall(b, new Set([at(2, 0), at(2, 1), at(2, 2)]), always(0.99));
    // Column 0: rows 0 and 1 fall one row; a new tile (kind 3, from rand 0.99) drops into row 0 from just above.
    expect(f.falls).toContainEqual({ from: at(1, 0), to: at(2, 0) });
    expect(f.falls).toContainEqual({ from: at(0, 0), to: at(1, 0) });
    expect(f.drops).toContainEqual({ to: at(0, 0), kind: 3, from: -1 });
    expect(f.board[at(2, 0)]).toBe(b[at(1, 0)]);
    expect(f.board[at(1, 0)]).toBe(b[at(0, 0)]);
    // Columns 3 and 4 do not move.
    for (const r of [0, 1, 2, 3, 4]) for (const c of [3, 4]) expect(f.board[at(r, c)]).toBe(b[at(r, c)]);
    expect(f.falls.filter((x: any) => x.from % 5 >= 3)).toEqual([]);
  });

  it('a column cleared three deep drops three new tiles, the top one from three rows up', () => {
    const b = board('sldfs', 'sdfsl', 'sflds', 'dslds', 'lldfl');
    const f = G.fall(b, new Set([at(0, 0), at(1, 0), at(2, 0)]), always(0));
    expect(f.drops.filter((d: any) => d.to % 5 === 0)).toEqual([
      { to: at(2, 0), kind: 0, from: -1 },
      { to: at(1, 0), kind: 0, from: -2 },
      { to: at(0, 0), kind: 0, from: -3 },
    ]);
    expect(f.falls.filter((x: any) => x.to % 5 === 0)).toEqual([]);
  });

  it('a chain resolves until nothing matches, and each round counts', () => {
    // After the first clear the three drops (suns, from rand 0) make a new run on the top row.
    const b = board('lfdld', 'dlfsl', 'sssdf', 'fdlfs', 'dfsld');
    const r = G.settle(b, seq([0, 0, 0], seeded(4)));
    expect(r.steps.length).toBeGreaterThanOrEqual(2);
    expect(r.steps[0].runs).toEqual([{ kind: K.s, cells: [10, 11, 12] }]);
    expect(r.steps[1].runs).toContainEqual({ kind: K.s, cells: [0, 1, 2] });
    expect(G.findRuns(r.board)).toEqual([]);
    for (const s of r.steps) expect(s.cleared.length).toBeGreaterThanOrEqual(3);
  });
});

describe('scoring and levels', () => {
  it('ten flowers a tile, more for a long run, times the place in the chain', () => {
    expect(G.flowersFor([{ kind: 0, cells: [0, 1, 2] }])).toBe(30);
    expect(G.flowersFor([{ kind: 0, cells: [0, 1, 2, 3] }])).toBe(50);
    expect(G.flowersFor([{ kind: 0, cells: [0, 1, 2, 3, 4] }])).toBe(70);
    expect(G.flowersFor([{ kind: 0, cells: [0, 1, 2] }], 2)).toBe(60);
    expect(G.flowersFor([{ kind: 0, cells: [0, 1, 2] }, { kind: 1, cells: [5, 10, 15] }], 3)).toBe(180);
  });

  it('a level asks for so many tiles of one kind, in turn sun, leaf, flower, drop, within 15 moves', () => {
    expect(G.goalFor(1)).toEqual({ kind: K.s, count: 10, moves: 15 });
    expect(G.goalFor(2)).toEqual({ kind: K.l, count: 11, moves: 15 });
    expect(G.goalFor(3)).toEqual({ kind: K.f, count: 12, moves: 15 });
    expect(G.goalFor(4)).toEqual({ kind: K.d, count: 13, moves: 15 });
    expect(G.goalFor(5).kind).toBe(K.s);
    expect(G.goalFor(10).count).toBe(22);
    // Past the table every level asks for the last count.
    expect(G.goalFor(G.GOALS.length).count).toBe(G.GOALS.at(-1));
    expect(G.goalFor(400).count).toBe(G.GOALS.at(-1));
    expect(G.goalFor(0)).toEqual(G.goalFor(1));
    // The goal never shrinks from one level to the next.
    for (let n = 1; n < 30; n++) expect(G.goalFor(n + 1).count).toBeGreaterThanOrEqual(G.goalFor(n).count);
  });

  it('one swap matches at most 9 tiles of a kind, and every goal is more, so no level is won in one move', () => {
    // A swap's runs of one kind all pass through the one cell that got a tile of that kind: its row and
    // its column, 5 + 5 - 1 tiles at most.
    for (let seed = 1; seed <= 200; seed++) {
      const g = G.newGame(1, 0, seeded(seed));
      for (let i = 0; i < 25; i++) for (const j of [G.step(i, 'right'), G.step(i, 'down')]) {
        if (j < 0 || !G.canSwap(g.board, i, j)) continue;
        for (let k = 0; k < G.KINDS; k++) expect(G.goalTiles(G.findRuns(G.swapped(g.board, i, j)), k)).toBeLessThanOrEqual(9);
      }
    }
    expect(Math.min(...G.GOALS)).toBeGreaterThan(9);
  });

  it("a move counts the level's tiles its own runs matched, not the chain's, and ends the level at the goal", () => {
    // Swapping (0,2) and (1,2) brings a sun into row 1 beside two suns: three suns, level 1's kind.
    const b = board('lfsdl', 'ssfld', 'dlfsl', 'fsdlf', 'ldsfd');
    const g = { level: 1, flowers: 100, moves: 15, got: 7, board: b };
    const r = G.move(g, at(0, 2), at(1, 2), seeded(5));
    expect(r.ok).toBe(true);
    expect(r.got).toBe(3);
    expect(r.game.moves).toBe(14);
    expect(r.game.got).toBe(10);
    expect(r.flowers).toBeGreaterThanOrEqual(30);
    expect(r.game.flowers).toBe(100 + r.flowers);
    expect(r.outcome).toBe('won');
    expect(G.toGo(r.game)).toBe(0);
    // Done: no more moves are taken.
    expect(G.move(r.game, 0, 1, seeded(5))).toEqual({ ok: false });
    // The same swap at level 2 (leaves) matches no leaf: a move spent, flowers grown, nothing counted.
    const r2 = G.move({ ...g, level: 2, got: 0 }, at(0, 2), at(1, 2), seeded(5));
    expect(r2.got).toBe(0);
    expect(r2.game.got).toBe(0);
    expect(r2.flowers).toBeGreaterThanOrEqual(30);
    expect(r2.outcome).toBeNull();
  });

  it("a chain grows flowers but not the goal", () => {
    // A sun swap, then the three new suns from rand 0 make a second round of suns on the top row.
    const b = board('lfdld', 'dlfsl', 'ssdsf', 'fdlfs', 'dfsld');
    const g = { level: 1, flowers: 0, moves: 15, got: 0, board: b };
    const r = G.move(g, at(2, 2), at(1, 3), seq([0, 0, 0], seeded(4)));
    expect(r.ok).toBe(false);
    const r2 = G.move(g, at(2, 2), at(2, 3), seq([0, 0, 0], seeded(4)));
    expect(r2.ok).toBe(true);
    expect(r2.steps.length).toBeGreaterThanOrEqual(2);
    expect(r2.steps[1].runs.some((x: any) => x.kind === K.s)).toBe(true);
    expect(r2.steps[0].runs).toEqual([{ kind: K.s, cells: [10, 11, 12] }]);
    expect(r2.got).toBe(3);
    expect(r2.flowers).toBe(r2.steps.reduce((n: number, s: any, k: number) => n + G.flowersFor(s.runs, k + 1), 0));
  });

  it('the last move without the goal is out of moves', () => {
    const g = { level: 3, flowers: 0, moves: 1, got: 0, board: board('lfsdl', 'ssfld', 'dlfsl', 'fsdlf', 'ldsfd') };
    const r = G.move(g, at(0, 2), at(1, 2), seeded(3));
    expect(r.game.moves).toBe(0);
    expect(r.outcome).toBe('lost');
  });
});

describe('no moves', () => {
  // Four kinds in a pattern where no swap makes three.
  const stuck = board('sldfs', 'dfsld', 'sldfs', 'dfsld', 'sldfs');

  it('detects a board with no move', () => {
    expect(G.findRuns(stuck)).toEqual([]);
    expect(G.hasMove(stuck)).toBe(false);
    expect(G.findMove(stuck)).toBeNull();
  });

  it('reshuffles the same tiles into a board with no match and a move', () => {
    const b = G.reshuffle(stuck, seeded(11));
    expect([...b].sort()).toEqual([...stuck].sort());
    expect(G.findRuns(b)).toEqual([]);
    expect(G.hasMove(b)).toBe(true);
  });

  it('a move that leaves the board stuck reshuffles it, so play never stops', () => {
    // Play many seeded games to the end: every board after a move has a move and no run.
    for (let seed = 1; seed <= 40; seed++) {
      const rand = seeded(seed);
      let g = G.newGame(1, 0, rand);
      for (let n = 0; n < 15 && !G.outcome(g); n++) {
        const m = G.findMove(g.board);
        expect(m, `seed ${seed}`).not.toBeNull();
        const r = G.move(g, m[0], m[1], rand);
        expect(r.ok).toBe(true);
        if (r.shuffled) expect(G.hasMove(r.shuffled)).toBe(false);
        g = r.game;
        expect(G.findRuns(g.board)).toEqual([]);
        expect(G.hasMove(g.board)).toBe(true);
      }
    }
  });
});

// How hard the levels are, from scripts/garden-sim.ts: each level played from fresh boards by a greedy
// player (the swap that matches most of the goal now) and a random one (any swap that matches), seeded so
// the numbers are the same every run. A change to GOALS, MOVES, KINDS or what counts must stay in these
// bands (docs/PLAYFUL.md, Tuning the difficulty).
describe('the difficulty', () => {
  const LEVELS = Array.from({ length: 20 }, (_, k) => k + 1);
  const GAMES = 300;
  let greedy: SimStats[] = [];
  let random: SimStats[] = [];
  beforeAll(() => {
    greedy = SIM.simulate('greedy', LEVELS, GAMES, 1);
    random = SIM.simulate('random', LEVELS, GAMES, 1);
  });
  const won = (s: SimStats[], level: number) => s[level - 1]!.won;
  /** The average share won over levels from..to. */
  const span = (s: SimStats[], from: number, to: number) => s.slice(from - 1, to).reduce((n, x) => n + x.won, 0) / (to - from + 1);

  it('level 1 is won nearly always by the greedy player, and never in fewer than three moves', () => {
    expect(won(greedy, 1)).toBeGreaterThanOrEqual(0.95);
    expect(greedy[0]!.fewest).toBeGreaterThanOrEqual(3);
  });

  it("the greedy player's wins fall steadily, to about half by level 10, and stay at a quarter or more to level 20", () => {
    for (const level of [1, 2, 3]) expect(won(greedy, level), `level ${level}`).toBeGreaterThanOrEqual(0.95);
    expect(won(greedy, 10)).toBeGreaterThanOrEqual(0.4);
    expect(won(greedy, 10)).toBeLessThanOrEqual(0.6);
    for (const level of LEVELS) {
      expect(won(greedy, level), `level ${level}`).toBeGreaterThanOrEqual(0.25);
      // Never much above the level before (the seeded games wobble a few points where goals are equal).
      if (level > 1) expect(won(greedy, level), `level ${level}`).toBeLessThanOrEqual(won(greedy, level - 1) + 0.12);
    }
    // Steadily, five levels at a time.
    expect(span(greedy, 1, 5)).toBeGreaterThan(span(greedy, 6, 10) + 0.15);
    expect(span(greedy, 6, 10)).toBeGreaterThan(span(greedy, 11, 15) + 0.1);
    expect(span(greedy, 11, 15)).toBeGreaterThan(span(greedy, 16, 20) - 0.03);
  });

  it('the random player wins the first levels often and loses later ones most of the time', () => {
    expect(won(random, 1)).toBeGreaterThanOrEqual(0.5);
    for (const level of LEVELS.filter((n) => n >= 5)) expect(won(random, level), `level ${level}`).toBeLessThan(0.5);
    for (const level of LEVELS.filter((n) => n >= 10)) expect(won(random, level), `level ${level}`).toBeLessThan(0.1);
  });

  it('no level is won in one move by any player, and a chain still happens on about every second move', () => {
    const careless = SIM.simulate('careless', [1, 2, 3], GAMES, 1);
    for (const s of [...greedy, ...random, ...careless]) {
      expect(s.inOne, `level ${s.level}`).toBe(0);
      expect(s.fewest, `level ${s.level}`).toBeGreaterThanOrEqual(2);
    }
    for (const s of greedy) expect(s.chain).toBeGreaterThan(1.5);
  });
});

describe('the record kept on the phone', () => {
  it('restores a good record, and starts its level again from a bad one', () => {
    const g = G.newGame(4, 220, seeded(2));
    expect(G.restore(JSON.parse(JSON.stringify({ v: 2, ...g })), seeded(9))).toEqual(g);
    const fresh = G.restore({ v: 2, ...g, board: [1, 2, 3] }, seeded(9));
    expect(fresh.level).toBe(4);
    expect(fresh.flowers).toBe(220);
    expect(fresh.moves).toBe(G.goalFor(4).moves);
    expect(fresh.got).toBe(0);
    expect(G.restore(null, seeded(9)).level).toBe(1);
    expect(G.restore({ level: -3, flowers: 'x' }, seeded(9))).toMatchObject({ level: 1, flowers: 0 });
    // A board with a run in it is not taken, nor a count at or past the goal.
    expect(G.restore({ v: 2, ...g, board: board('sssld', 'lfdfs', 'lfdsl', 'ldfsd', 'fsdlf') }, seeded(9)).board).not.toEqual(board('sssld', 'lfdfs', 'lfdsl', 'ldfsd', 'fsdlf'));
    expect(G.restore({ v: 2, ...g, got: G.goalFor(4).count }, seeded(9)).got).toBe(0);
    expect(G.restore({ v: 2, ...g, moves: 16 }, seeded(9)).moves).toBe(15);
  });

  it('a game kept under the first rules keeps its level and flowers, with a new board under these rules', () => {
    // As the first rules kept it (v 1: matches made, chains too), on a phone at level 4 with 1,080 flowers.
    const old = { v: 1, level: 4, flowers: 1080, moves: 9, made: 3, board: G.newBoard(seeded(21)) };
    const g = G.restore(JSON.parse(JSON.stringify(old)), seeded(9));
    expect(g).toEqual({ level: 4, flowers: 1080, moves: 15, got: 0, board: expect.any(Array) });
    expect(G.findRuns(g.board)).toEqual([]);
    expect(G.hasMove(g.board)).toBe(true);
    expect(G.outcome(g)).toBeNull();
    expect(G.toGo(g)).toBe(13);
    // A game past every level of the table keeps its level too, at the last goal.
    expect(G.restore({ v: 1, level: 31, flowers: 9000, moves: 3, made: 20, board: old.board }, seeded(9))).toMatchObject({ level: 31, flowers: 9000, moves: 15, got: 0 });
    // The screen keeps the new shape.
    expect(read(`${GAME}/index.js`)).toMatch(/progress\.save\(\{ v: VERSION, level: g\.level, flowers: g\.flowers, moves: g\.moves, got: g\.got, board: g\.board\.slice\(\) \}\)/);
  });

  it('is kept in the database beside the settings, through the two actions a mode gets', () => {
    const app = read('public/v2/app.js');
    expect(app).toMatch(/kv\.put\('game', S\.game\)/);
    expect(app).toMatch(/S\.game = \(await kv\.get\('game'\)/);
    // Erase everything wipes it from memory too, and no write follows an erase.
    expect(app).toMatch(/Object\.assign\(S, \{ key: null,.*game: null \}\)/);
    expect(app).toMatch(/saveCoverProgress: \(data\) => \{\s*if \(erased\) return;/);
    expect(R.PROJECTIONS.mode.actions).toEqual(expect.arrayContaining(['coverProgress', 'saveCoverProgress']));
  });

  it('is removed by Erase everything, with the settings, in the forge2 database', async () => {
    expect(DB.DB_NAME).toBe('forge2');
    expect(E.KNOWN_DATABASES).toContain(DB.DB_NAME);
    // A browser with the app's database holding the game's record (and the settings) and the boot caches.
    const dbs = new Map<string, Map<string, unknown>>([['forge2', new Map<string, unknown>([['settings', { mode: 'playful' }], ['game', { level: 7, flowers: 340 }]])]]);
    const local = new Map<string, string>([['forge2.mode', 'playful'], ['forge2.cover', '{"title":"Pip\'s Garden"}']]);
    const storage = {
      get length() {
        return local.size;
      },
      clear: () => local.clear(),
    };
    const env = {
      localStorage: storage,
      sessionStorage: { length: 0, clear: () => {} },
      indexedDB: {
        databases: async () => [...dbs.keys()].map((name) => ({ name })),
        deleteDatabase(name: string) {
          const req: any = {};
          setTimeout(() => (dbs.delete(name), req.onsuccess?.()), 0);
          return req;
        },
      },
    };
    const r = await E.eraseEverything(env);
    expect(r.ok).toBe(true);
    expect(dbs.has('forge2')).toBe(false);
    expect(local.size).toBe(0);
  });
});

describe('the setting', () => {
  it('Open as a game first is on by default, and kept like the mode', () => {
    expect(STATE.DEFAULT_SETTINGS.gameFirst).toBe(true);
    expect(STATE.loadedSettings(null).gameFirst).toBe(true);
    expect(STATE.loadedSettings({ mode: 'playful', gameFirst: false }).gameFirst).toBe(false);
    expect(ROUTER.parse('#/game')).toEqual({ name: 'game', params: {} });
    expect(ROUTER.href('game')).toBe('#/game');
  });
});

describe('the cover shows nothing of the app', () => {
  it("the game's words never name the app, a price, a balance or a model", () => {
    const words = Object.entries(en).filter(([k]) => k.startsWith('garden.'));
    expect(words.length).toBeGreaterThan(20);
    for (const [k, v] of words) {
      expect(v, k).not.toMatch(/forge|\$|\bsats?\b|balance|wallet|model|ecash|price|money/i);
      expect(v, k).not.toMatch(/[–—]/);
    }
    expect(en['garden.title']).toBe("Pip's Garden");
    expect(en['garden.how']).toBe('Match three to grow the garden.');
    expect(en['look.coverWarn']).toBe('This hides Forge from a quick look at your screen. It does not hide it from someone who searches the phone.');
  });

  it('the game imports only its own rules, and its rules nothing', () => {
    const imports = (f: string) => [...read(f).matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports(`${GAME}/index.js`)).toEqual(['./logic.js']);
    expect(imports(`${GAME}/logic.js`)).toEqual([]);
    // The mode's entry still has no imports, so a phone in Default fetches none of the game.
    expect(read('public/v2/modules/mode/playful/index.js')).not.toMatch(/^\s*import\s/m);
  });

  it('the hold that opens the helper is three seconds, and draws nothing', () => {
    const cover = read('public/v2/modules/mode/playful/cover.js');
    expect(cover).toMatch(/export const HOLD_MS = 3000;/);
    const hold = cover.slice(cover.indexOf('export function holdPip'), cover.indexOf('function holdToasts'));
    expect(hold).not.toMatch(/style|classList|--hold|progress|haptics/);
  });
});
