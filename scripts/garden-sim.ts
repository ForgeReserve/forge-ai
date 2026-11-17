/**
 * Plays Pip's Garden (public/v2/modules/mode/playful/games/garden/logic.js) many times with simple
 * players, to measure how hard each level is (docs/PLAYFUL.md, The cover game, Tuning the difficulty).
 *
 *   node scripts/garden-sim.ts [--games 400] [--levels 1-20] [--seed 1]
 *
 * Every level is played from a fresh board, `games` times per player, with a seeded random source, so the
 * same arguments print the same table. The players see the board as a person does, and nothing of the
 * tiles still to come:
 *
 *   random    any swap that makes a match;
 *   greedy    the swap that does most for the goal now (its runs' goal tiles, then its tiles), ties at random;
 *   careless  greedy, but one move in three is any swap that makes a match.
 *
 * test/unit/v2/garden.test.ts runs the same players for the bands the difficulty must stay in.
 */
import { pathToFileURL } from 'node:url';

const G: any = await import('../public/v2/modules/mode/playful/games/garden/logic.js' as string);

/** A seeded random source (mulberry32): the same seed, the same games. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Player = 'random' | 'greedy' | 'careless';
export const PLAYERS: Player[] = ['greedy', 'careless', 'random'];

/**
 * Every swap that makes a match on the game's board, with what it does for the goal that a person can
 * see: the goal tiles in its runs, then all its tiles.
 */
function swaps(game: any): { swap: [number, number]; worth: number }[] {
  const size = G.SIZE;
  const kind = G.goalFor(game.level).kind;
  const out: { swap: [number, number]; worth: number }[] = [];
  for (let i = 0; i < size * size; i++) {
    for (const j of [G.step(i, 'right', size), G.step(i, 'down', size)]) {
      if (j < 0 || game.board[i] === game.board[j]) continue;
      const runs = G.findRuns(G.swapped(game.board, i, j), size);
      if (runs.length) out.push({ swap: [i, j], worth: G.goalTiles(runs, kind) * 100 + new Set(runs.flatMap((r: any) => r.cells)).size });
    }
  }
  return out;
}

function choose(player: Player, game: any, rand: () => number): [number, number] {
  const all = swaps(game);
  if (player === 'random' || (player === 'careless' && rand() < 1 / 3)) return all[Math.floor(rand() * all.length)]!.swap;
  const best = Math.max(...all.map((s) => s.worth));
  const picks = all.filter((s) => s.worth === best);
  return picks[Math.floor(rand() * picks.length)]!.swap;
}

export interface LevelPlay {
  won: boolean;
  /** Moves taken. */
  moves: number;
  /** Rounds of clearing per move (1 is no chain). */
  chains: number[];
}

/** One level from a fresh board, played to its end. */
export function playLevel(level: number, player: Player, rand: () => number): LevelPlay {
  let game = G.newGame(level, 0, rand);
  let moves = 0;
  const chains: number[] = [];
  while (!G.outcome(game)) {
    const [a, b] = choose(player, game, rand);
    const r = G.move(game, a, b, rand);
    if (!r.ok) throw new Error(`level ${level}: a swap the player could make was refused`);
    moves++;
    chains.push(r.steps.length);
    game = r.game;
  }
  return { won: G.outcome(game) === 'won', moves, chains };
}

export interface LevelStats {
  level: number;
  games: number;
  /** Share of games won, 0 to 1. */
  won: number;
  /** Average moves taken, in all games. */
  moves: number;
  /** The fewest moves a won game took (Infinity with no win). */
  fewest: number;
  /** Share of games won in one move, and in one or two. */
  inOne: number;
  inTwo: number;
  /** Average rounds of clearing per move. */
  chain: number;
}

/** `games` plays of each level by one player, from `seed`. */
export function simulate(player: Player, levels: number[], games: number, seed = 1): LevelStats[] {
  return levels.map((level) => {
    const rand = seeded(seed * 7919 + level * 104729 + PLAYERS.indexOf(player));
    const plays = Array.from({ length: games }, () => playLevel(level, player, rand));
    const wins = plays.filter((p) => p.won);
    const chains = plays.flatMap((p) => p.chains);
    return {
      level,
      games,
      won: wins.length / games,
      moves: plays.reduce((n, p) => n + p.moves, 0) / games,
      fewest: Math.min(...wins.map((p) => p.moves)),
      inOne: wins.filter((p) => p.moves === 1).length / games,
      inTwo: wins.filter((p) => p.moves <= 2).length / games,
      chain: chains.reduce((n, c) => n + c, 0) / chains.length,
    };
  });
}

function main(argv: string[]) {
  const arg = (name: string, dflt: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
  };
  const games = Number(arg('games', '400'));
  const [from, to] = arg('levels', '1-20').split('-').map(Number);
  const levels = Array.from({ length: (to ?? from!) - from! + 1 }, (_, k) => from! + k);
  const seed = Number(arg('seed', '1'));
  const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);
  for (const player of PLAYERS) {
    console.log(`\n${player} (${games} games a level)`);
    console.log('level  goal        won  moves  fewest  in 1  in 2  chain');
    for (const s of simulate(player, levels, games, seed)) {
      const goal = G.goalFor(s.level);
      console.log(`${String(s.level).padStart(5)}  ${`${goal.count} in ${goal.moves}`.padEnd(9)} ${pct(s.won)} ${s.moves.toFixed(1).padStart(6)} ${String(s.fewest === Infinity ? '-' : s.fewest).padStart(7)} ${pct(s.inOne)} ${pct(s.inTwo)} ${s.chain.toFixed(2).padStart(6)}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
