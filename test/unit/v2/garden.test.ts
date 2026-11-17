import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pip's Garden, Playful's cover game (docs/PLAYFUL.md, The cover game): the rules in
// public/v2/modules/mode/playful/games/garden/logic.js with a seeded random source, the setting that opens
// it first, where its record is kept (and that Erase everything takes it), and that the game sees nothing
// of the app.
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
  it('is 5 by 5 with four kinds, and those are constants', () => {
    expect(G.SIZE).toBe(5);
    expect(G.KINDS).toBe(4);
    expect(G.RUN).toBe(3);
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
    const g = { level: 1, flowers: 0, moves: 15, made: 0, board: board('lfsdl', 'ssfld', 'dlfsl', 'fsdlf', 'ldsfd') };
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

  it('a level asks for one more match than the one before, within 15 moves (one more every fifth level)', () => {
    expect(G.goalFor(1)).toEqual({ matches: 5, moves: 15 });
    expect(G.goalFor(2)).toEqual({ matches: 6, moves: 15 });
    expect(G.goalFor(5)).toEqual({ matches: 9, moves: 16 });
    expect(G.goalFor(7)).toEqual({ matches: 11, moves: 16 });
    expect(G.goalFor(40).matches).toBe(24);
    expect(G.goalFor(0)).toEqual(G.goalFor(1));
  });

  it('a valid move takes a move, counts matches and flowers, and ends the level when the goal is met', () => {
    const b = board('lfsdl', 'ssfld', 'dlfsl', 'fsdlf', 'ldsfd');
    const g = { level: 1, flowers: 100, moves: 15, made: 4, board: b };
    const r = G.move(g, at(0, 2), at(1, 2), seeded(5));
    expect(r.ok).toBe(true);
    expect(r.matches).toBeGreaterThanOrEqual(1);
    expect(r.game.moves).toBe(14);
    expect(r.game.made).toBe(4 + r.matches);
    expect(r.flowers).toBeGreaterThanOrEqual(30);
    expect(r.game.flowers).toBe(100 + r.flowers);
    expect(r.outcome).toBe('won');
    expect(G.toGo(r.game)).toBe(0);
    // Done: no more moves are taken.
    expect(G.move(r.game, 0, 1, seeded(5))).toEqual({ ok: false });
  });

  it('the last move without the goal is out of moves', () => {
    const g = { level: 3, flowers: 0, moves: 1, made: 0, board: board('lfsdl', 'ssfld', 'dlfsl', 'fsdlf', 'ldsfd') };
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

describe('the record kept on the phone', () => {
  it('restores a good record, and starts its level again from a bad one', () => {
    const g = G.newGame(4, 220, seeded(2));
    expect(G.restore(JSON.parse(JSON.stringify({ v: 1, ...g })), seeded(9))).toEqual(g);
    const fresh = G.restore({ ...g, board: [1, 2, 3] }, seeded(9));
    expect(fresh.level).toBe(4);
    expect(fresh.flowers).toBe(220);
    expect(fresh.moves).toBe(G.goalFor(4).moves);
    expect(G.restore(null, seeded(9)).level).toBe(1);
    expect(G.restore({ level: -3, flowers: 'x' }, seeded(9))).toMatchObject({ level: 1, flowers: 0 });
    // A board with a run in it is not taken.
    expect(G.restore({ ...g, board: board('sssld', 'lfdfs', 'lfdsl', 'ldfsd', 'fsdlf') }, seeded(9)).board).not.toEqual(board('sssld', 'lfdfs', 'lfdsl', 'ldfsd', 'fsdlf'));
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
