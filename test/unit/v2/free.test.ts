import { describe, expect, it, vi } from 'vitest';

// Free questions in the v2 app (docs/FREE-TIER.md): which balance pays, the "Free, 2 of 3 left" count,
// the lighter ring segment, the faucet client and the vault for vouchers.
const F: any = await import('../../../public/v2/core/free.js' as string);
const FAUCET: any = await import('../../../public/v2/core/faucet.js' as string);
const RINGS: any = await import('../../../public/v2/core/rings.js' as string);
const POW: any = await import('../../../public/v2/core/pow.js' as string);
const PRICE: any = await import('../../../public/v2/core/price.js' as string);
const V: any = await import('../../../public/v2/core/vault.js' as string);
const E: any = await import('../../../public/v2/core/engine.js' as string);
const ERR: any = await import('../../../public/v2/core/errors.js' as string);
const ROUTER: any = await import('../../../public/v2/core/router.js' as string);
const { default: en }: any = await import('../../../public/v2/strings/en.js' as string);

const INFO = F.freeInfo({ free: { mint: 'https://credits.example/', unit: 'usd', models: ['free-model'], max_input_tokens: 4000, max_output_tokens: 1500, faucet: { questions: 3 } } });
const model = (id: string) => ({ id });

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('free tier info', () => {
  it('reads the engine free block, and nothing when there is none', () => {
    expect(INFO).toEqual({ mint: 'https://credits.example', unit: 'usd', models: ['free-model'], maxIn: 4000, maxOut: 1500, faucet: true });
    expect(F.freeInfo({ free: null })).toBeNull();
    expect(F.freeInfo({})).toBeNull();
  });

  it('knows a voucher by its mint', () => {
    expect(F.isCreditMint(INFO, 'https://credits.example/')).toBe(true);
    expect(F.isCreditMint(INFO, 'https://forge.flashapp.me')).toBe(false);
    expect(F.isCreditMint(null, 'https://credits.example')).toBe(false);
  });

  it('keeps the free key apart from the paid key, one per engine', () => {
    expect(F.freeKeyName('', 'https://a')).toBe('forge2.freeKey');
    expect(F.freeKeyName('https://b', 'https://a')).toBe('forge2.freeKey@https://b');
    expect(F.freeKeyName('', 'https://a')).not.toBe('forge.balanceKey');
  });

  it('counts whole free questions', () => {
    expect(F.freeLeft(3000)).toBe(3);
    expect(F.freeLeft(2999)).toBe(2);
    expect(F.freeLeft(null)).toBe(0);
  });
});

describe('which balance pays', () => {
  it('uses a free question first, only on a free model and within the cap', () => {
    expect(F.useFree({ info: INFO, left: 2, model: model('free-model'), inputTokens: 100 })).toEqual({ use: true });
    expect(F.useFree({ info: INFO, left: 0, model: model('free-model') })).toEqual({ use: false, why: 'none' });
    expect(F.useFree({ info: INFO, left: 2, model: model('paid-model') })).toEqual({ use: false, why: 'model' });
    expect(F.useFree({ info: INFO, left: 2, model: model('free-model'), inputTokens: 4001 })).toEqual({ use: false, why: 'long' });
    expect(F.useFree({ info: null, left: 2, model: model('free-model') })).toEqual({ use: false, why: 'off' });
  });

  it('asks for no more output than the engine allows a free question', () => {
    expect(F.freeMaxTokens(INFO, 4096)).toBe(1500);
    expect(F.freeMaxTokens(INFO, 800)).toBe(800);
    expect(F.freeMaxTokens(null, 4096)).toBe(4096);
  });

  it('says what stops a question for lack of funds', () => {
    expect(F.fundsBlock({ paidMsub: 500, freeLeft: 0, freeTotal: 3, freeUsable: false })).toBeNull();
    expect(F.fundsBlock({ paidMsub: 0, freeLeft: 2, freeTotal: 3, freeUsable: true })).toBeNull();
    expect(F.fundsBlock({ paidMsub: 0, freeLeft: 2, freeTotal: 3, freeUsable: false })).toBe('freeModel');
    expect(F.fundsBlock({ paidMsub: 0, freeLeft: 0, freeTotal: 3, freeUsable: false })).toBe('freeOut');
    expect(F.fundsBlock({ paidMsub: 0, freeLeft: 0, freeTotal: 0, freeUsable: false })).toBe('addFunds');
  });
});

describe('Free, 2 of 3 left', () => {
  it('counts what was added: it starts again after running out, and grows when more come on top', () => {
    expect(F.nextFreeTotal(0, 3, 3)).toBe(3);
    expect(F.nextFreeTotal(1, 3, 3)).toBe(6);
    expect(F.nextFreeTotal(0, 0, 0)).toBe(0);
  });

  it('reads as the price line', () => {
    const p = PRICE.priceLine(5000, 'usd', { left: 2, total: 3 });
    expect(p).toMatchObject({ key: 'price.freeLeft', left: 2, total: 3 });
    expect(en[p.key].replace('{left}', '2').replace('{total}', '3')).toBe('Free, 2 of 3 left');
  });
});

describe('the gold ring with free questions', () => {
  it('shows free questions alone as a share of those added', () => {
    expect(RINGS.fundsSegments({ balanceMsub: 0, peakMsub: null, freeLeft: 2, freeTotal: 3 })).toEqual({ free: 2 / 3, paid: 0 });
  });
  it('shows the paid balance alone as before', () => {
    expect(RINGS.fundsSegments({ balanceMsub: 500, peakMsub: 1000, freeLeft: 0, freeTotal: 3 })).toEqual({ free: 0, paid: 0.5 });
  });
  it('puts free questions first and the paid ones after, measured in questions', () => {
    // 3 free of 3, and a paid balance worth 6 questions at its peak, 3 now.
    const s = RINGS.fundsSegments({ balanceMsub: 300, peakMsub: 600, freeLeft: 3, freeTotal: 3, perQuestionMsub: 100 });
    expect(s.free).toBeCloseTo(3 / 9);
    expect(s.paid).toBeCloseTo(3 / 9);
    expect(s.free + s.paid).toBeLessThanOrEqual(1);
    // Without a price, the two share the ring.
    expect(RINGS.fundsSegments({ balanceMsub: 300, peakMsub: 300, freeLeft: 1, freeTotal: 2 })).toEqual({ free: 0.25, paid: 0.5 });
  });
  it('draws the paid part after the free part', () => {
    const d = RINGS.dashAfter(0.5, 0.25, 150);
    expect(d.dasharray).toBe('471 942');
    expect(d.dashoffset).toBe('-236');
  });
});

describe('the faucet client', () => {
  const fastSolve = (challenge: string) => Promise.resolve(`${challenge}:0`);

  it('asks for a puzzle, sends the answer, and claims a voucher', async () => {
    const calls: Array<[string, unknown]> = [];
    const call = vi.fn(async (path: string, o: any = {}) => {
      calls.push([path, o.json]);
      if (path === '/v1/free/challenge') return { ok: true, status: 200, body: { challenge: 'c1', bits: 4 } };
      if (path === '/v1/free/verify') return { ok: true, status: 200, body: { ticket: 't1' } };
      return { ok: true, status: 200, body: { token: 'cashuBv', questions: 3 } };
    });
    const steps: string[] = [];
    expect(await FAUCET.getVoucher({ call, solve: fastSolve, onStep: (s: string) => steps.push(s) })).toEqual({ token: 'cashuBv', questions: 3 });
    expect(calls).toEqual([
      ['/v1/free/challenge', {}],
      ['/v1/free/verify', { solution: 'c1:0' }],
      ['/v1/free/claim', { ticket: 't1' }],
    ]);
    expect(steps).toEqual(['puzzle', 'working', 'claiming']);
  });

  it('says when more come when the faucet is empty', async () => {
    const call = async () => ({ ok: false, status: 429, body: { error: { code: 'faucet_empty', message: 'none' }, next_at: 1234 } });
    await expect(FAUCET.getVoucher({ call, solve: fastSolve })).rejects.toMatchObject({ code: 'faucet_empty', nextAt: 1234 });
    expect(FAUCET.faucetRefusal({ code: 'faucet_empty' })).toBe('faucet.empty');
    expect(FAUCET.faucetRefusal({ code: 'faucet_limit' })).toBe('faucet.limit');
    expect(FAUCET.faucetRefusal({ code: 'claim_used' })).toBe('faucet.failed');
  });

  it('claims again with the same ticket when the engine could not make the voucher', async () => {
    let claims = 0;
    const call = async (path: string) => {
      if (path === '/v1/free/challenge') return { ok: true, status: 200, body: { challenge: 'c', bits: 1 } };
      if (path === '/v1/free/verify') return { ok: true, status: 200, body: { ticket: 't' } };
      return ++claims === 1 ? { ok: false, status: 503, body: { error: { code: 'faucet_unavailable' } } } : { ok: true, status: 200, body: { token: 'cashuBv', questions: 3 } };
    };
    vi.useFakeTimers();
    const p = FAUCET.getVoucher({ call, solve: fastSolve });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ token: 'cashuBv', questions: 3 });
    vi.useRealTimers();
    expect(claims).toBe(2);
  });

  it('words the state: left today, more at the next drip, more tomorrow', () => {
    const fmt = { timeFmt: () => '14:00' };
    expect(FAUCET.faucetLine({ questions_left_today: 2997, available_now: 5, next_at: 1 }, fmt)).toEqual({ key: 'faucet.left', count: '2,997', time: '14:00', now: true });
    expect(FAUCET.faucetLine({ questions_left_today: 30, available_now: 0, next_at: 1 }, fmt)).toEqual({ key: 'faucet.waitDrip', count: '30', time: '14:00', now: false });
    expect(FAUCET.faucetLine({ questions_left_today: 0, available_now: 0, next_at: 1 }, fmt)).toEqual({ key: 'faucet.waitDay', count: '0', time: '14:00', now: false });
    for (const k of ['faucet.left', 'faucet.waitDrip', 'faucet.waitDay', 'faucet.empty', 'faucet.limit', 'faucet.off', 'faucet.offline', 'faucet.failed']) expect(en[k], k).toBeTruthy();
  });
});

describe('proof of work progress', () => {
  it('reports the share of the expected work, and 1 when solved', async () => {
    const seen: number[] = [];
    const s = await POW.solvePow('progress-test', 14, { onProgress: (p: number) => seen.push(p) });
    expect(s.startsWith('progress-test:')).toBe(true);
    expect(seen.at(-1)).toBe(1);
    expect(seen.slice(0, -1).every((p) => p > 0 && p < 1)).toBe(true);
    expect(POW.expectedShare(2 ** 20, 2 ** 20)).toBeCloseTo(1 - Math.exp(-1));
    expect(POW.expectedShare(2 ** 30, 2 ** 20)).toBe(0.97);
  });
});

describe('vouchers in the vault', () => {
  it('keeps a voucher until the engine credits it to the free balance, apart from paid eCash', async () => {
    const vault = V.createVault(memStorage());
    let sent: any = null;
    const engine = E.createEngine({
      fetch: async (url: string, init: any) => {
        sent = { url, auth: init.headers.authorization, inVault: vault.incoming().map((x: any) => x.via) };
        return json({ key: 'sk-forge-free', credited: 3, unit: 'usd', free: true });
      },
    });
    vault.hold('cashuBpaid', 'topup');
    vault.pending(vault.incoming()[0].id, 'offline');
    let freeKey: string | null = null;
    vault.hold('cashuBvoucher', 'free');
    const n = await V.retryPending({ engine, vault, getKey: () => freeKey, setKey: (k: string) => (freeKey = k), via: 'free' });
    expect(n).toBe(1);
    expect(sent.inVault).toEqual(['topup', 'free']);
    expect(sent.auth).toBeUndefined();
    expect(freeKey).toBe('sk-forge-free');
    // The paid token waits for the paid balance; only the voucher went.
    expect(vault.incoming().map((x: any) => x.token)).toEqual(['cashuBpaid']);
  });

  it('puts a free balance key in the free slot even when the voucher went the paid way', async () => {
    // The app had not read the credit mint yet (no /v1/models), so a voucher was sent as eCash.
    const vault = V.createVault(memStorage());
    const engine = E.createEngine({ fetch: async () => json({ key: 'sk-forge-free', credited: 3, unit: 'usd', free: true }) });
    const setKey = vi.fn();
    const setFreeKey = vi.fn();
    const r = await V.topupWithVault({ engine, vault, token: 'cashuBvoucher', key: null, setKey, setFreeKey });
    expect(setFreeKey).toHaveBeenCalledWith('sk-forge-free');
    expect(setKey).not.toHaveBeenCalled();
    expect(r).toMatchObject({ credited: 3, free: true });
    expect(vault.incoming()).toEqual([]);

    // The same on a retry from the vault.
    vault.hold('cashuBvoucher2', 'topup');
    vault.pending(vault.incoming()[0].id, 'offline');
    const setKey2 = vi.fn();
    const setFreeKey2 = vi.fn();
    expect(await V.retryPending({ engine, vault, getKey: () => null, setKey: setKey2, setFreeKey: setFreeKey2 })).toBe(1);
    expect(setFreeKey2).toHaveBeenCalledWith('sk-forge-free');
    expect(setKey2).not.toHaveBeenCalled();
  });

  it('still puts a paid balance key in the paid slot', async () => {
    const vault = V.createVault(memStorage());
    const engine = E.createEngine({ fetch: async () => json({ key: 'sk-forge-paid', credited: 50, unit: 'usd', free: false }) });
    const setKey = vi.fn();
    const setFreeKey = vi.fn();
    const r = await V.topupWithVault({ engine, vault, token: 'cashuBmoney', key: null, setKey, setFreeKey });
    expect(setKey).toHaveBeenCalledWith('sk-forge-paid');
    expect(setFreeKey).not.toHaveBeenCalled();
    expect(r.free).toBeUndefined();
  });
});

describe('free question words', () => {
  it('maps the engine refusals to plain words with one next step', () => {
    expect(ERR.errorView('not_free_model')).toEqual({ key: 'error.freeModel', next: 'chooseModel' });
    expect(ERR.errorView('free_too_long')).toEqual({ key: 'error.freeLong', next: 'startFresh' });
    expect(ERR.errorView('credits_expired')).toEqual({ key: 'error.freeExpired', next: 'freeOut' });
    expect(en['next.freeOut']).toBe('See the ways forward');
  });

  it('has a route for the ways forward that goes back to Funds', () => {
    expect(ROUTER.parse('#/funds/free-out')).toEqual({ name: 'freeOut', params: {} });
    expect(ROUTER.parentOf('freeOut')).toBe('funds');
  });
});
