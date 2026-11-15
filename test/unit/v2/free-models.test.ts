import { describe, expect, it, vi } from 'vitest';

// Free models in the v2 app (docs/PAYMENTS.md, Free models): a model whose /v1/models pricing says
// free: true shows "Free", holds nothing, is never "not enough funds", and asks only for a balance key.
const PRICE: any = await import('../../../public/v2/core/price.js' as string);
const F: any = await import('../../../public/v2/core/free.js' as string);
const ERR: any = await import('../../../public/v2/core/errors.js' as string);
const E: any = await import('../../../public/v2/core/engine.js' as string);
const { default: en }: any = await import('../../../public/v2/strings/en.js' as string);

/** A free model as GET /v1/models lists it (src/app.ts), and a paid one. */
const free = {
  id: 'glm-5.3-flash',
  pricing: {
    free: true,
    free_reason: 'Token Factory beta: no charge to Forge (owner, 2026-11-15)',
    mode: 'metered',
    usd_per_mtok: { input: 0, output: 0 },
    sat_per_mtok: { input: 0, output: 0 },
    hold: { basis: 'metered', bytes_per_token: 2, input_nano_usd_per_token: 0, output_nano_usd_per_token: 0, web_search: null },
  },
};
const paid = {
  id: 'tinfoil/gpt-oss-120b',
  pricing: { free: false, mode: 'metered', usd_per_mtok: { input: 0.1875, output: 0.75 }, sat_per_mtok: null, hold: { basis: 'metered', bytes_per_token: 2, input_nano_usd_per_token: 188, output_nano_usd_per_token: 750, web_search: null } },
};

describe('price of a free model', () => {
  it('holds 0 and costs 0, in usd and in sat, even with no rate', () => {
    expect(PRICE.isFreeModel(free)).toBe(true);
    expect(PRICE.isFreeModel(paid)).toBe(false);
    expect(PRICE.isFreeModel({ id: 'old', pricing: { usd_per_mtok: { input: 0, output: 0 } } })).toBe(false);
    for (const unit of ['usd', 'sat']) {
      expect(PRICE.holdMsub(free, unit, { bodyBytes: 100_000, maxOut: 4096 })).toBe(0);
      expect(PRICE.perQuestion(free, unit)).toBe(0);
      expect(PRICE.estimate(free, unit, 5000, 4096)).toEqual({ max: 0, likely: 0 });
    }
    // A paid model is held as before: at least 1 msub.
    expect(PRICE.holdMsub(paid, 'usd', { bodyBytes: 100, maxOut: 10 })).toBe(Math.ceil((50 * 188 + 10 * 750) / 10_000));
  });

  it('reads "Free" on the price line', () => {
    const p = PRICE.priceLine(0, 'usd', true);
    expect(p.key).toBe('price.free');
    expect(en[p.key]).toBe('Free');
  });

  it('an old engine (no pricing.free) still prices from the hold figures', () => {
    const old = { id: 'x', pricing: { ...paid.pricing, free: undefined } };
    expect(PRICE.holdMsub(old, 'usd', { bodyBytes: 100, maxOut: 10 })).toBeGreaterThan(0);
  });
});

describe('funds on a free model', () => {
  it('never blocks with a balance key, at 0 or not; without one it asks for a key, not for funds', () => {
    expect(F.fundsBlock({ paidMsub: 0, freeLeft: 0, freeTotal: 0, freeUsable: false, freeModel: true, hasKey: true })).toBeNull();
    expect(F.fundsBlock({ paidMsub: 0, freeLeft: 0, freeTotal: 3, freeUsable: false, freeModel: true, hasKey: true })).toBeNull();
    expect(F.fundsBlock({ paidMsub: 0, freeLeft: 2, freeTotal: 3, freeUsable: false, freeModel: true, hasKey: false })).toBe('needKey');
    // A paid model, as before.
    expect(F.fundsBlock({ paidMsub: 0, freeLeft: 0, freeTotal: 0, freeUsable: false, hasKey: true })).toBe('addFunds');
    expect(F.fundsBlock({ paidMsub: 10, freeLeft: 0, freeTotal: 0, freeUsable: false })).toBeNull();
  });

  it('says plainly what the engine\'s refusal means, with Add funds as the next step', () => {
    const v = ERR.errorView('balance_key_required', 'x');
    expect(v).toEqual({ key: 'error.needKey', next: 'addFunds' });
    for (const k of ['error.needKey', 'type.needKey', 'type.openBalance', 'funds.needKey', 'funds.modelFree', 'model.free', 'model.freeSub', 'home.free', 'home.freeChip']) expect(en[k], k).toBeTruthy();
  });
});

describe('opening a balance with an invite', () => {
  it('posts the invite to /v1/wallet/open and returns the new key', async () => {
    const fetch = vi.fn(async (_url: string, init: any) => new Response(JSON.stringify({ key: 'sk-forge-new', created: true, balance_msub: 0, body: JSON.parse(init.body) }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const engine = E.createEngine({ base: 'https://engine.example', fetch });
    const r = await engine.openBalance('INVITE1');
    expect(r).toMatchObject({ key: 'sk-forge-new', created: true });
    expect(fetch.mock.calls[0]![0]).toBe('https://engine.example/v1/wallet/open');
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ invite: 'INVITE1' });
  });

  it('the invite module is listed only while the engine has free models and the phone has no key', async () => {
    const mod: any = await import('../../../public/v2/modules/fund/invite/index.js' as string);
    let key: string | null = null;
    const m = mod.create({ t: (k: string) => k, ui: {}, wallet: { key: () => key, invite: () => '', setInvite() {}, open: async () => ({}) } });
    expect(m.available({ open: { enabled: true, free_models: ['x'] } })).toBe(true);
    expect(m.available({ open: { enabled: false, free_models: [] } })).toBe(false);
    expect(m.available(null)).toBe(false);
    key = 'sk-forge-x';
    expect(m.available({ open: { enabled: true, free_models: ['x'] } })).toBe(false);
    for (const k of ['name', 'sub', 'what', 'open', 'opening', 'used', 'bad', 'later']) expect(en[`fund.invite.${k}`], k).toBeTruthy();
  });
});

describe('Start free: which free model, and when the card shows', () => {
  it('chooses glm-5.3-flash when listed, else the first free model, never an uncensored or paid one', () => {
    const f = (id: string, extra: any = {}) => ({ ...free, id, ...extra });
    expect(PRICE.PREFERRED_FREE).toBe('glm-5.3-flash');
    expect(PRICE.freeModelChoice([paid, f('kimi-k3'), f('glm-5.3-flash')])?.id).toBe('glm-5.3-flash');
    expect(PRICE.freeModelChoice([paid, f('glm-5.3-flash', { uncensored: true }), f('kimi-k3')])?.id).toBe('kimi-k3');
    expect(PRICE.freeModelChoice([paid])).toBeNull();
    expect(PRICE.freeModelChoice(null)).toBeNull();
  });

  it('shows the card with free models and no key, or a $0 balance on a paid model', async () => {
    const SF: any = await import('../../../public/v2/screens/startfree.js' as string);
    const v = (o: any) => ({ startFree: true, hasKey: false, balanceMsub: null, modelFree: false, ...o });
    expect(SF.startFreeWanted(v({}))).toBe(true);
    expect(SF.startFreeWanted(v({ modelFree: true }))).toBe(true); // a free model still needs a key
    expect(SF.startFreeWanted(v({ hasKey: true, balanceMsub: 0 }))).toBe(true);
    expect(SF.startFreeWanted(v({ hasKey: true, balanceMsub: 0, modelFree: true }))).toBe(false);
    expect(SF.startFreeWanted(v({ hasKey: true, balanceMsub: 500 }))).toBe(false);
    expect(SF.startFreeWanted(v({ startFree: false }))).toBe(false);
  });

  it('has the words, short and plain', () => {
    for (const k of ['link', 'title', 'go', 'note', 'money', 'opened', 'ask', 'use', 'keep', 'using', 'ready', 'kept', 'noModel', 'useModel']) expect(en[`startFree.${k}`], k).toBeTruthy();
    expect(en['startFree.ask']).toBe('Free models are Standard models: the company running them can read what you type. Use them?');
    expect(en['startFree.note']).toBe('Free models answer at no cost. Add money later for private models.');
  });
});
