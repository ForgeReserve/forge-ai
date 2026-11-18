import { describe, expect, it, vi } from 'vitest';

// Two balances on the phone (docs/PAYMENTS.md, Two balances): which balance pays a question, the home's
// one total, where money goes, and how the keys are kept (the first where it always was).
const B: any = await import('../../../public/v2/core/balances.js' as string);
const ST: any = await import('../../../public/v2/core/state.js' as string);
const V: any = await import('../../../public/v2/core/vault.js' as string);
const E: any = await import('../../../public/v2/core/engine.js' as string);
const KIT: any = await import('../../../public/v2/modules/fund/kit.js' as string);
const NOTE: any = await import('../../../public/v2/core/note.js' as string);

// $100,000 a bitcoin: 1 sat is 0.1 cent, so 1,000 msat is 100 usd msub.
const RATE = 100_000;

describe('which balance pays a question (payUnit)', () => {
  const pay = (available: object, hold: object) => B.payUnit({ available: { usd: null, sat: null, ...available }, hold: { usd: null, sat: null, ...hold } });

  it('pays from dollars first, whenever the dollars cover the whole hold', () => {
    expect(pay({ usd: 5000, sat: 900_000 }, { usd: 4000, sat: 40_000 })).toBe('usd');
    expect(pay({ usd: 4000, sat: 900_000 }, { usd: 4000, sat: 40_000 })).toBe('usd');
  });

  it('pays from sats when the dollars cannot cover it, or the phone has no dollar balance', () => {
    expect(pay({ usd: 3999, sat: 900_000 }, { usd: 4000, sat: 40_000 })).toBe('sat');
    expect(pay({ sat: 40_000 }, { usd: 4000, sat: 40_000 })).toBe('sat');
  });

  it('never splits a question: short when neither covers it alone, even when the two together would', () => {
    // $0.03 and 30 sat (3 cents) make 6 cents, more than the 4 cent hold, but neither alone covers it.
    expect(pay({ usd: 3000, sat: 30_000 }, { usd: 4000, sat: 40_000 })).toBeNull();
    expect(pay({}, { usd: 1, sat: 1 })).toBeNull();
  });

  it('lets no sat balance pay without a rate (the hold in sats is null then): only the dollars count', () => {
    expect(pay({ usd: 3000, sat: 900_000 }, { usd: 4000, sat: null })).toBeNull();
    expect(pay({ usd: 5000, sat: 900_000 }, { usd: 4000, sat: null })).toBe('usd');
  });

  it('a free model holds nothing: the dollar key pays it, even at 0, else the sat key', () => {
    expect(pay({ usd: 0, sat: 0 }, { usd: 0, sat: 0 })).toBe('usd');
    expect(pay({ sat: 0 }, { usd: 0, sat: 0 })).toBe('sat');
  });
});

describe('the home total (homeTotal)', () => {
  it('is one balance in its own unit when only it holds money, exactly as before', () => {
    expect(B.homeTotal({ usd: { balanceMsub: 120_000, peakMsub: 500_000 }, sat: null, btcUsd: RATE })).toEqual({ unit: 'usd', balanceMsub: 120_000, peakMsub: 500_000, both: false, approx: false });
    expect(B.homeTotal({ usd: null, sat: { balanceMsub: 2_000_000, peakMsub: null }, btcUsd: RATE })).toEqual({ unit: 'sat', balanceMsub: 2_000_000, peakMsub: 2_000_000, both: false, approx: false });
    // A dollar balance at 0 beside sats with money: the sats, in sats.
    expect(B.homeTotal({ usd: { balanceMsub: 0, peakMsub: 9000 }, sat: { balanceMsub: 500_000, peakMsub: 500_000 }, btcUsd: RATE }).unit).toBe('sat');
  });

  it('is dollars when both hold money: the sats at the rate the app has, with both full marks', () => {
    // $1.00 and 2,000 sat ($2.00 at $100,000).
    const t = B.homeTotal({ usd: { balanceMsub: 100_000, peakMsub: 100_000 }, sat: { balanceMsub: 2_000_000, peakMsub: 4_000_000 }, btcUsd: RATE });
    expect(t).toEqual({ unit: 'usd', balanceMsub: 300_000, peakMsub: 500_000, both: true, approx: false });
  });

  it('is the dollar balance alone when both hold money but there is no rate (Funds still shows the sats)', () => {
    expect(B.homeTotal({ usd: { balanceMsub: 100_000, peakMsub: null }, sat: { balanceMsub: 2_000_000, peakMsub: null }, btcUsd: null })).toEqual({ unit: 'usd', balanceMsub: 100_000, peakMsub: 100_000, both: false, approx: true });
  });

  it('is the empty balance kept first when none holds money, and null with no balance read', () => {
    expect(B.homeTotal({ usd: { balanceMsub: 0, peakMsub: null }, sat: { balanceMsub: 0, peakMsub: null } })).toMatchObject({ unit: 'usd', balanceMsub: 0 });
    expect(B.homeTotal({ usd: null, sat: { balanceMsub: 0, peakMsub: 7 } })).toMatchObject({ unit: 'sat', balanceMsub: 0, peakMsub: 7 });
    expect(B.homeTotal({ usd: null, sat: null })).toBeNull();
  });

  it('turns sats into dollars rounded down, never more than held', () => {
    expect(B.satToUsdMsub(1_000, RATE)).toBe(100);
    expect(B.satToUsdMsub(1_234_567, 98_765.43)).toBe(Math.floor((1_234_567 * 98_765.43) / 1e6));
    expect(B.satToUsdMsub(1000, 0)).toBeNull();
    expect(B.satToUsdMsub(1000, null)).toBeNull();
  });

  it('counts the questions left over both balances, each paying whole questions, the sats only with a rate', () => {
    expect(B.questionsOver({ usd: 10_000, sat: 50_000 }, { usd: 1000, sat: 10_000 }, true)).toBe(15);
    expect(B.questionsOver({ usd: 10_000, sat: 50_000 }, { usd: 1000, sat: 10_000 }, false)).toBe(10);
    expect(B.questionsOver({ usd: 1999, sat: 19_999 }, { usd: 1000, sat: 10_000 }, true)).toBe(2);
    expect(B.questionsOver({ usd: null, sat: null }, { usd: 1000, sat: null }, true)).toBe(0);
  });
});

describe('where money goes (landsIn)', () => {
  const held = (usd: boolean, sat: boolean) => ({ usd, sat });

  it('goes to the balance of its own unit, no change of units', () => {
    expect(B.landsIn('sat', { held: held(true, true), siblings: true })).toBe('sat');
    expect(B.landsIn('usd', { held: held(true, true), siblings: true })).toBe('usd');
  });

  it('opens the balance of its unit when the phone has none: the first with an invite, the second with the first key', () => {
    expect(B.landsIn('sat', { held: held(false, false), siblings: false })).toBe('sat');
    expect(B.landsIn('sat', { held: held(true, false), siblings: true })).toBe('sat');
    expect(B.landsIn('usd', { held: held(false, true), siblings: true })).toBe('usd');
    // An engine that is not invite-only opens any balance without one.
    expect(B.landsIn('sat', { held: held(true, false), siblings: false, inviteOnly: false })).toBe('sat');
  });

  it('falls back to the balance the phone has (a change of units) only where the second cannot be opened', () => {
    expect(B.landsIn('sat', { held: held(true, false), siblings: false })).toBe('usd');
    expect(B.landsIn('usd', { held: held(false, true), siblings: false })).toBe('sat');
  });

  it('decides the note screen: a sat note on a dollar phone is added as it is, or changed on an older engine', () => {
    const note = { mint: 'https://mint.example', unit: 'sat', amount: 100 };
    const verdict = (siblings: boolean) => NOTE.noteVerdict(note, { mints: ['https://mint.example'], units: ['usd', 'sat'], balanceUnit: B.landsIn('sat', { held: held(true, false), siblings }), convert: true });
    expect(verdict(true)).toBe('add');
    expect(verdict(false)).toBe('convert');
  });

  it('asks Lightning in sats, for the sat balance, and in dollars only where that balance cannot be opened', () => {
    const wallet = (to: string, units = ['usd', 'sat']) => ({ methods: () => ({ lightning: { units } }), landsIn: () => to, unit: () => 'usd' });
    expect(KIT.lightningUnit(wallet('sat'))).toBe('sat');
    expect(KIT.lightningUnit(wallet('usd'))).toBe('usd');
    expect(KIT.lightningUnit(wallet('sat', ['usd']))).toBe('usd');
  });
});

describe('keeping two keys (storage)', () => {
  function memStorage(init: Record<string, string> = {}) {
    const m = new Map<string, string>(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
  }

  it('reads a key kept before two balances where it always was, and keeps the second beside it', () => {
    const origin = 'https://ai.example';
    expect(ST.keyName('', origin)).toBe('forge.balanceKey');
    expect(B.key2Name('', origin)).toBe('forge2.balanceKey2');
    expect(B.key2Name('https://engine.example', origin)).toBe('forge2.balanceKey2@https://engine.example');
    // A phone from before: one key, in the Classic page's name. It is the first of the two, untouched.
    const store = memStorage({ 'forge.balanceKey': 'sk-forge-old' });
    const slots = [store.getItem(ST.keyName('', origin)), store.getItem(B.key2Name('', origin))];
    expect(slots).toEqual(['sk-forge-old', null]);
    const next = B.withKey(slots, 'sk-forge-sat');
    expect(next).toEqual(['sk-forge-old', 'sk-forge-sat']);
  });

  it('never writes over a key: a new one goes into the empty name, and a third has no place', () => {
    expect(B.withKey([null, null], 'a')).toEqual(['a', null]);
    expect(B.withKey([null, 'b'], 'a')).toEqual(['a', 'b']);
    const both = ['a', 'b'];
    expect(B.withKey(both, 'a')).toBe(both);
    expect(B.withKey(both, 'c')).toBeNull();
    expect(B.withKey(both, null)).toBe(both);
  });

  it('lets one key go and leaves the other where it is', () => {
    expect(B.withoutKey(['a', 'b'], 'a')).toEqual([null, 'b']);
    expect(B.withoutKey(['a', 'b'], 'x')).toEqual(['a', 'b']);
  });

  it('tells which key is which by the unit the engine said, the first come first', () => {
    expect(B.keysByUnit(['k1', 'k2'], { k1: 'sat', k2: 'usd' })).toEqual({ usd: 'k2', sat: 'k1' });
    expect(B.keysByUnit(['k1', null], { k1: 'usd' })).toEqual({ usd: 'k1', sat: null });
    // A second key in a unit already held is kept, not used.
    expect(B.keysByUnit(['k1', 'k2'], { k1: 'usd', k2: 'usd' })).toEqual({ usd: 'k1', sat: null });
    expect(B.unitsPending(['k1', 'k2'], { k1: 'usd' })).toBe(true);
    expect(B.unitsPending(['k1', null], { k1: 'usd' })).toBe(false);
  });
});

describe('opening the second balance through the vault and the engine', () => {
  function memStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the other balance key in X-Forge-Sibling with no key and no invite, and keeps the new key with its unit', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const engine = E.createEngine({
      fetch: async (url: string, init: any) => {
        seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return json({ key: 'sk-forge-sat', unit: 'sat', credited: 100, replay: false });
      },
    });
    const vault = V.createVault(memStorage());
    const setKey = vi.fn();
    const r = await V.topupWithVault({ engine, vault, token: 'cashuBsat', key: null, sibling: 'sk-forge-usd', invite: undefined, setKey });
    expect(r).toMatchObject({ credited: 100, unit: 'sat' });
    expect(seen[0]!.headers['x-forge-sibling']).toBe('sk-forge-usd');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body.invite).toBeUndefined();
    expect(setKey).toHaveBeenCalledWith('sk-forge-sat', 'sat');
  });

  it('sends the key the phone made as the bearer, with the sibling header, so a retry is the same request', async () => {
    const seen: any[] = [];
    const engine = E.createEngine({ fetch: async (_u: string, init: any) => (seen.push(init.headers), json({ unit: 'sat', credited: 1 })) });
    await V.topupWithVault({ engine, vault: V.createVault(memStorage()), token: 'cashuBx', key: 'sk-forge-made', sibling: 'sk-forge-usd', setKey: vi.fn() });
    expect(seen[0].authorization).toBe('Bearer sk-forge-made');
    expect(seen[0]['x-forge-sibling']).toBe('sk-forge-usd');
  });

  it('makes and keeps the second key before anything is sent (prepareFunding, then fundIn)', async () => {
    const kept = new Map<string, string>();
    const keys: Record<string, string | null> = { usd: 'sk-forge-usd', sat: null };
    const made = new Set<string>();
    const make = (unit: string) => {
      const k = B.newKey(new Uint8Array(24).fill(7));
      kept.set(`key:${unit}`, k);
      made.add(k);
      keys[unit] = k;
      return k;
    };
    const wallet = { fundingFor: async (unit: string) => B.prepareFunding(unit, { keys, siblings: true, made: (k: string) => made.has(k), make }), setKey: vi.fn(), siblingRefused: vi.fn(), key: () => 'sk-forge-usd' };
    const sent: any[] = [];
    const send = async (key: any, invite: any, sibling: any) => {
      // At the moment the request leaves, the key is already on the phone.
      sent.push({ key, invite, sibling, keptThen: kept.get('key:sat') });
      throw new Error('the answer was lost');
    };
    await expect(KIT.fundIn(wallet, 'sat', 'inv-x', send)).rejects.toThrow('lost');
    expect(sent[0]).toEqual({ key: kept.get('key:sat'), invite: undefined, sibling: 'sk-forge-usd', keptThen: kept.get('key:sat') });
    expect(sent[0].key).toMatch(/^sk-forge-[A-Za-z0-9_-]{32}$/);
    // Sent again: the same key and the same header, no second key made.
    await expect(KIT.fundIn(wallet, 'sat', 'inv-x', send)).rejects.toThrow('lost');
    expect(sent[1]).toMatchObject({ key: sent[0].key, sibling: 'sk-forge-usd' });
    // Once the engine knows it, it is an ordinary key: no header.
    made.clear();
    expect(B.prepareFunding('sat', { keys, siblings: true, made: () => false, make })).toEqual({ key: sent[0].key, sibling: undefined });
  });

  it('opens nothing with a sibling the engine does not offer, and a first balance takes the invite', async () => {
    const make = vi.fn();
    expect(B.prepareFunding('sat', { keys: { usd: 'k', sat: null }, siblings: false, make })).toEqual({ key: null });
    expect(B.prepareFunding('sat', { keys: { usd: null, sat: null }, siblings: true, make })).toEqual({ key: null });
    expect(make).not.toHaveBeenCalled();
    const sent: any[] = [];
    await KIT.fundIn({ fundingFor: async () => ({ key: null }), setKey: vi.fn(), key: () => null }, 'sat', 'inv-x', async (...a: any[]) => (sent.push(a), { ok: true, body: {} }));
    expect(sent[0]).toEqual([null, 'inv-x', undefined]);
    // A refusal is told to the wallet.
    const w = { fundingFor: async () => ({ key: 'k2', sibling: 'k1' }), setKey: vi.fn(), siblingRefused: vi.fn() };
    await KIT.fundIn(w, 'sat', undefined, async () => ({ ok: false, status: 403, body: { error: { code: 'sibling_refused' } } }));
    expect(w.siblingRefused).toHaveBeenCalled();
  });

  it('keeps aside lists whole: a key is added, never written over', () => {
    expect(B.withAside(null, 'a')).toBe('["a"]');
    expect(B.withAside('["a"]', 'b')).toBe('["a","b"]');
    expect(B.withAside('["a","b"]', 'a')).toBe('["a","b"]');
    // A single key kept the old way stays in the list.
    expect(B.asideKeys(B.withAside('sk-forge-old', 'b'))).toEqual(['sk-forge-old', 'b']);
    expect(B.asideKeys(null)).toEqual([]);
  });
});

// Choose a model marks a model the money on the phone cannot pay for (screens/settings.js), by the
// rules asking uses (app.js blocker, estimateFor short), so the mark agrees with what a tap leads to.
describe('a model the balance cannot pay for (cannotPay)', () => {
  const hold = { usd: 2_000, sat: 20_000 }; // 2 cents, 20 sats
  const ask = (o: object) => B.cannotPay({ free: false, freeUse: false, paidMsub: 100_000, available: { usd: null, sat: null }, hold, btcUsd: RATE, home: 'usd', ...o });

  it('dollars that cover the hold pay; too few dollars do not', () => {
    expect(ask({ available: { usd: 5_000, sat: null } })).toBe(false);
    expect(ask({ available: { usd: 2_000, sat: null } })).toBe(false);
    expect(ask({ paidMsub: 1_000, available: { usd: 1_000, sat: null } })).toBe(true);
  });

  it('sats pay only with a rate, and one balance pays in full, never split', () => {
    expect(ask({ home: 'sat', available: { usd: null, sat: 50_000 } })).toBe(false);
    expect(ask({ home: 'sat', available: { usd: null, sat: 50_000 }, btcUsd: null })).toBe(true);
    // Dollars short, sats enough: the sats pay.
    expect(ask({ available: { usd: 1_000, sat: 50_000 } })).toBe(false);
    // Each short alone, enough together: still short.
    expect(ask({ available: { usd: 1_500, sat: 10_000 } })).toBe(true);
    // The same as the question asked: payUnit picks no balance exactly when this says true.
    for (const available of [{ usd: 1_000, sat: 50_000 }, { usd: 1_500, sat: 10_000 }, { usd: 9_000, sat: null }]) {
      const pays = B.payUnit({ available, hold });
      expect(ask({ available })).toBe(!pays);
    }
  });

  it('a free model, a free question, or an unpriced question are never marked', () => {
    expect(ask({ free: true, paidMsub: 0 })).toBe(false);
    expect(ask({ free: true, available: { usd: 0, sat: null } })).toBe(false);
    expect(ask({ freeUse: true, paidMsub: 0 })).toBe(false);
    expect(ask({ freeUse: true, available: { usd: 0, sat: null } })).toBe(false);
    expect(ask({ available: { usd: 0, sat: null }, hold: { usd: null, sat: null } })).toBe(false);
  });

  it('with no paid balance (no key, or $0) every paid model is marked; before the balance is read, none', () => {
    expect(ask({ paidMsub: 0 })).toBe(true);
    expect(ask({ paidMsub: 0, hold: { usd: null, sat: null } })).toBe(true);
    expect(ask({ paidMsub: null })).toBe(false);
  });
});
