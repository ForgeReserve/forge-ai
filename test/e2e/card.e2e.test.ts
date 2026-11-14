import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintSigner, provision } from '../support/cards.ts';
import { CardSim } from '../support/cardsim.ts';
import { type Gateway, MINT_A, MINT_C, mintsUp, redeem, startGateway } from './helpers.ts';

// The Cashu card against the real thing (slice A13): a simulated card loaded with SIG_ALL pieces minted
// at the local Nutshell mints, the phone's flow (public/v2/core/card/flow.js) through the engine's card
// relay (src/cardrelay.ts) to the card's mint, and the eCash added to a balance: at the engine's own mint
// with a top-up, at another mint (input fees 100 ppk) through other-mint funding. Also what the relay
// refuses.
const F: any = await import('../../public/v2/core/card/flow.js' as string);
const E: any = await import('../../public/v2/core/engine.js' as string);
const N: any = await import('../../public/v2/core/note.js' as string);

let g: Gateway;
let engine: any;

function memStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true' } });
  engine = E.createEngine({ base: g.url, fetch: globalThis.fetch.bind(globalThis) });
});

afterAll(async () => {
  await g?.close();
});

const relayOf = (eng: any) => ({ mint: eng.cardMint, swap: eng.cardSwap, restore: eng.cardRestore });

async function cardAt(mint: string, amounts: number[], pin: string | null = '1234') {
  const card = new CardSim({ pin, mint });
  await provision(card, await mintSigner(mint), amounts);
  const flow = F.createCardFunding({ storage: memStorage(), relay: relayOf(engine) });
  return { card, flow };
}

describe('a Cashu card through the engine to its mint', () => {
  it("at the engine's mint: takes part of the card, gives the card its change, and the eCash tops up a sat balance", async () => {
    const { card, flow } = await cardAt(MINT_A, [64, 32, 4]);
    card.tap();
    const summary = await flow.read(card.transceive);
    expect(summary).toMatchObject({ mint: MINT_A, unit: 'sat', balance: 100, pinState: 'set' });
    const info = await flow.mintInfo(summary);
    expect(info).toMatchObject({ mint: MINT_A, trusted: true, unit: 'sat' });
    const plan = flow.plan(summary, info, 70);
    const job = await flow.pay(card.transceive, { summary, info, plan, pin: '1234' });
    expect(job).toMatchObject({ state: 'swapped', received: 70, changeOwed: false });
    expect(card.balance()).toBe(30);
    // The card's change is real: it is on the card as a piece the mint signed.
    expect(card.unspent().map((p) => p.amount).sort((a, b) => a - b)).toEqual([2, 4, 8, 16]);
    const note = N.readNote(job.token);
    expect(note).toMatchObject({ ok: true, mint: MINT_A, unit: 'sat', amount: 70 });
    // The token tops up a new sat balance at the engine.
    const r = await engine.topup(undefined, job.token);
    expect(r.ok).toBe(true);
    expect(r.body).toMatchObject({ unit: 'sat', credited: 70 });
    flow.handed(job.id);
    expect(flow.pending()).toEqual([]);

    // The change on the card pays the next time, all of it, no change.
    card.lift();
    card.tap();
    const s2 = await flow.read(card.transceive);
    expect(s2.balance).toBe(30);
    const i2 = await flow.mintInfo(s2);
    const j2 = await flow.pay(card.transceive, { summary: s2, info: i2, plan: flow.plan(s2, i2, 30), pin: '1234' });
    expect(N.readNote(j2.token).amount).toBe(30);
    expect(card.balance()).toBe(0);
    const r2 = await engine.topup(r.body.key, j2.token);
    expect(r2.body).toMatchObject({ credited: 30 });
    expect((await engine.wallet(r.body.key)).balance).toBe(100);
  }, 60_000);

  it("the swap's answer lost on the way back: the relay's restore brings the signatures again", async () => {
    const { card } = await cardAt(MINT_A, [16, 8]);
    let lose = true;
    const relay = relayOf(engine);
    const lossy = { ...relay, swap: async (b: unknown) => {
      const r = await relay.swap(b);
      if (lose) {
        lose = false;
        throw new TypeError('Failed to fetch');
      }
      return r;
    } };
    const f2 = F.createCardFunding({ storage: memStorage(), relay: lossy });
    card.tap();
    const summary = await f2.read(card.transceive);
    const info = await f2.mintInfo(summary);
    const e = await f2.pay(card.transceive, { summary, info, plan: f2.plan(summary, info, 24), pin: '1234' }).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'mint_unavailable', kept: true });
    const tokens: string[] = [];
    await f2.resume(async (j: any) => void tokens.push(j.token));
    expect(tokens).toHaveLength(1);
    // The eCash is real and unspent: the local mint takes it.
    expect(await redeem(tokens[0]!, MINT_A, 'sat')).toBe(24);
    expect(f2.pending()).toEqual([]);
  }, 60_000);

  it('at another mint: the input fee is paid, and the token goes through other-mint funding', async () => {
    const { card, flow } = await cardAt(MINT_C, [32, 16]);
    card.tap();
    const summary = await flow.read(card.transceive);
    const info = await flow.mintInfo(summary);
    expect(info.trusted).toBe(false);
    const plan = flow.plan(summary, info, 48);
    // Two pieces at 100 ppk: 0.2, so 1 sat.
    expect(plan).toMatchObject({ fee: 1, receive: 47 });
    const job = await flow.pay(card.transceive, { summary, info, plan, pin: '1234' });
    expect(N.readNote(job.token)).toMatchObject({ mint: MINT_C, amount: 47 });
    const q = await engine.foreignQuote(undefined, { token: job.token, unit: 'sat' });
    expect(q.ok).toBe(true);
    expect(q.body.foreign.credit).toBeGreaterThan(0);
    const c = await engine.foreignConfirm(q.body.key, { id: q.body.id, token: job.token });
    expect(c.ok).toBe(true);
    for (let i = 0; i < 50 && (await engine.funding(q.body.key, q.body.id)).body.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 200));
    expect((await engine.funding(q.body.key, q.body.id)).body.state).toBe('done');
  }, 60_000);

  it("at another mint, with a cap lower than the card: the card gives no more than Other mint then takes, and Other mint takes it", async () => {
    const capped = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true', FORGE_FOREIGN_MAX_SAT: '40' } });
    try {
      const eng = E.createEngine({ base: capped.url, fetch: globalThis.fetch.bind(globalThis) });
      const card = new CardSim({ pin: '1234', mint: MINT_C });
      await provision(card, await mintSigner(MINT_C), [32, 16, 8]);
      const flow = F.createCardFunding({ storage: memStorage(), relay: relayOf(eng) });
      card.tap();
      const summary = await flow.read(card.transceive);
      const info = await flow.mintInfo(summary);
      expect(info).toMatchObject({ trusted: false, max: 40 });
      expect(() => flow.plan(summary, info, 56)).toThrow(expect.objectContaining({ code: 'over_max' }));
      const plan = flow.plan(summary, info);
      expect(plan.amount).toBe(40);
      const job = await flow.pay(card.transceive, { summary, info, plan, pin: '1234' });
      expect(card.balance()).toBe(16);
      const q = await eng.foreignQuote(undefined, { token: job.token, unit: 'sat' });
      expect(q.ok).toBe(true);
      // Without the cap (through the uncapped engine), all 56 leave the card and this engine refuses the token.
      const other = await cardAt(MINT_C, [32, 16, 8]);
      other.card.tap();
      const s2 = await other.flow.read(other.card.transceive);
      const i2 = await other.flow.mintInfo(s2);
      const all = await other.flow.pay(other.card.transceive, { summary: s2, info: i2, plan: other.flow.plan(s2, i2, 56), pin: '1234' });
      const over = await eng.foreignQuote(undefined, { token: all.token, unit: 'sat' });
      expect(over.body.error.code).toBe('amount_too_large');
    } finally {
      await capped.close();
    }
  }, 60_000);

  it('the relay refuses what it should: an unknown address, a private one, the wrong shapes', async () => {
    const strict = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_POLICY: 'allowlist' } });
    try {
      const eng = E.createEngine({ base: strict.url, fetch: globalThis.fetch.bind(globalThis) });
      const other = await eng.cardMint({ mint: MINT_C, unit: 'sat' });
      expect(other.ok).toBe(false);
      expect(other.body.error.code).toBe('mint_not_allowed');
      // An address that is not a mint the engine may reach is never fetched.
      const internal = await eng.cardMint({ mint: 'http://169.254.169.254/latest', unit: 'sat' });
      expect(internal.ok).toBe(false);
      const bad = await eng.cardSwap({ mint: MINT_A, inputs: [{ amount: 1, id: 'zz', secret: 'x', C: '02' }], outputs: [] });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('invalid_request');
      // A swap the mint refuses comes back with the mint's own code.
      const refused = await eng.cardSwap({ mint: MINT_A, inputs: [{ amount: 1, id: '00'.repeat(8), secret: '["P2PK",{}]', C: '02' + '11'.repeat(32) }], outputs: [{ amount: 1, id: '00'.repeat(8), B_: '02' + '22'.repeat(32) }] });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('mint_refused');
      expect(typeof refused.body.mint_code).toBe('number');
    } finally {
      await strict.close();
    }
    const off = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ENABLED: 'false' } });
    try {
      const eng = E.createEngine({ base: off.url, fetch: globalThis.fetch.bind(globalThis) });
      expect((await eng.cardMint({ mint: MINT_A, unit: 'sat' })).ok).toBe(true);
      expect((await eng.cardMint({ mint: MINT_C, unit: 'sat' })).body.error.code).toBe('method_unavailable');
    } finally {
      await off.close();
    }
  }, 60_000);
});
