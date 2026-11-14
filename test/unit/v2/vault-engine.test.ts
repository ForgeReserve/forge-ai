import { describe, expect, it, vi } from 'vitest';

// A token on the phone belongs to the engine it was sent to (public/v2/core/vault.js). After a switch in
// More, Engine, the new engine must never be sent the old engine's tokens, and its answers (a 404 for a
// funding it never saw) must never settle them.
const V: any = await import('../../../public/v2/core/vault.js' as string);
const K: any = await import('../../../public/v2/modules/fund/kit.js' as string);
const E: any = await import('../../../public/v2/core/engine.js' as string);

const A = 'https://a.example';
const B = 'https://b.example';

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Engine B: knows no funding (404) and would credit any token it is sent. */
function engineB() {
  const f = vi.fn(async (url: string) => (String(url).includes('/v1/wallet/fund/') ? json({ error: { code: 'not_found', message: 'unknown funding' } }, 404) : json({ key: 'sk-b', credited: 500, unit: 'usd', replay: false })));
  return { engine: E.createEngine({ base: B, fetch: f }), fetch: f };
}

/** Engine A: credits top-ups and reports the other-mint funding as done with change. */
function engineA() {
  const f = vi.fn(async (url: string) =>
    String(url).includes('/v1/wallet/fund/')
      ? json({ id: 'fund_a', state: 'done', unit: 'usd', credited: 950, foreign: { unit: 'sat', change_token: 'cashuBchange', refund_token: null, payout_pending: false } })
      : json({ key: 'sk-a', credited: 500, unit: 'usd', replay: false }),
  );
  return { engine: E.createEngine({ base: A, fetch: f }), fetch: f };
}

/** A vault with a top-up, a free voucher and an other-mint funding, all left pending at engine A. */
function heldAtA() {
  const vault = V.createVault(memStorage());
  vault.hold('cashuBtopup', 'topup', { engine: A });
  vault.hold('cashuBvoucher', 'free', { engine: A });
  vault.hold('cashuBforeign', 'othermint', { fundingId: 'fund_a', engine: A });
  return vault;
}

describe('vault entries belong to the engine they were sent to', () => {
  it('records the engine a token is sent to', async () => {
    const vault = V.createVault(memStorage());
    const { engine } = engineA();
    const f = vi.fn(async () => json({ error: { code: 'topup_pending', message: 'pending' } }, 503));
    await expect(V.topupWithVault({ engine: E.createEngine({ base: A, fetch: f }), vault, token: 'cashuBx', key: 'k', setKey: () => {} })).rejects.toBeTruthy();
    expect(vault.incoming()).toMatchObject([{ token: 'cashuBx', engine: A, state: 'pending' }]);
    expect(V.engineOf(engine)).toBe(A);
    expect(V.engineOf(E.createEngine({}))).toBe('');
  });

  it('after a switch, the new engine is sent nothing and settles nothing', async () => {
    const vault = heldAtA();
    const before = JSON.stringify(vault.incoming());
    const { engine, fetch } = engineB();
    expect(await V.retryPending({ engine, vault, getKey: () => 'sk-b', setKey: vi.fn() })).toBe(0);
    expect(await V.retryPending({ engine, vault, getKey: () => 'sk-b', setKey: vi.fn(), via: 'free' })).toBe(0);
    expect(await K.settlePendingForeign({ engine, vault, key: 'sk-b' })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(vault.incoming())).toBe(before);
    expect(vault.incoming().every((x: any) => x.state === 'pending')).toBe(true);
    expect(vault.outgoing()).toEqual([]);
  });

  it('back on the engine they were sent to, they settle', async () => {
    const vault = heldAtA();
    const { engine, fetch } = engineA();
    expect(await V.retryPending({ engine, vault, getKey: () => 'sk-a', setKey: vi.fn() })).toBe(1);
    expect(await V.retryPending({ engine, vault, getKey: () => 'sk-a', setKey: vi.fn(), via: 'free' })).toBe(1);
    expect(await K.settlePendingForeign({ engine, vault, key: 'sk-a' })).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vault.incoming()).toEqual([]);
    expect(vault.outgoing()).toMatchObject([{ id: 'fund_a_change', token: 'cashuBchange' }]);
  });

  it('an entry with no engine is from the page origin: kept from another engine, sent to the origin', async () => {
    // Written before entries carried an engine, as the faucet page still writes its vouchers.
    const s = memStorage();
    s.setItem('forge2.vault', JSON.stringify({ in: [{ id: 'in_old', token: 'cashuBold', via: 'topup', at: 1, state: 'pending' }, { id: 'in_oldf', token: 'cashuBoldf', via: 'othermint', fundingId: 'fund_o', at: 1, state: 'pending' }], out: [] }));
    const legacy = V.createVault(s);
    const { engine: b, fetch: fb } = engineB();
    expect(await V.retryPending({ engine: b, vault: legacy, getKey: () => 'k', setKey: vi.fn() })).toBe(0);
    expect(await K.settlePendingForeign({ engine: b, vault: legacy, key: 'k' })).toBe(0);
    expect(fb).not.toHaveBeenCalled();
    expect(legacy.incoming().map((x: any) => x.state)).toEqual(['pending', 'pending']);

    const f = vi.fn(async () => json({ key: 'sk', credited: 1, unit: 'usd', replay: false }));
    expect(await V.retryPending({ engine: E.createEngine({ fetch: f }), vault: legacy, getKey: () => 'k', setKey: vi.fn() })).toBe(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(legacy.incoming().map((x: any) => x.token)).toEqual(['cashuBoldf']);
  });
});
