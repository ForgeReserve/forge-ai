import { describe, expect, it, vi } from 'vitest';

// Tokens kept on the phone until credited (public/v2/core/vault.js).
const V: any = await import('../../../public/v2/core/vault.js' as string);
const E: any = await import('../../../public/v2/core/engine.js' as string);

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('vault', () => {
  it('stores the token before it is sent and removes it once credited', async () => {
    const s = memStorage();
    const vault = V.createVault(s);
    const setKey = vi.fn();
    const engine = E.createEngine({
      fetch: async () => {
        // The token is on the phone while the request is in flight.
        expect(s.getItem('forge2.vault')).toContain('cashuBabc');
        return json({ key: 'sk-forge-new', credited: 250, unit: 'usd', replay: false });
      },
    });
    const r = await V.topupWithVault({ engine, vault, token: 'cashuBabc', key: null, invite: 'inv-1', setKey });
    expect(r).toEqual({ credited: 250, unit: 'usd', replay: false });
    // With its unit: the phone keeps one balance per unit (core/balances.js).
    expect(setKey).toHaveBeenCalledWith('sk-forge-new', 'usd');
    expect(vault.incoming()).toEqual([]);
  });

  it('keeps the token and the new key when the outcome is pending, and sends it again later', async () => {
    const s = memStorage();
    const vault = V.createVault(s);
    let key: string | null = null;
    const setKey = (k: string) => (key = k);
    let n = 0;
    const engine = E.createEngine({
      fetch: async (_u: string, init: any) => {
        n++;
        if (n === 1) return json({ error: { code: 'topup_pending', message: 'pending' }, key: 'sk-forge-p' }, 503);
        // The retry uses the same key and the same token.
        expect(init.headers.authorization).toBe('Bearer sk-forge-p');
        expect(JSON.parse(init.body).token).toBe('cashuBpend');
        return json({ credited: 100, unit: 'usd' });
      },
    });
    await expect(V.topupWithVault({ engine, vault, token: 'cashuBpend', key, setKey })).rejects.toMatchObject({ code: 'topup_pending', retryable: true });
    expect(key).toBe('sk-forge-p');
    expect(vault.incoming()).toMatchObject([{ token: 'cashuBpend', state: 'pending' }]);
    expect(await V.retryPending({ engine, vault, getKey: () => key, setKey })).toBe(1);
    expect(vault.incoming()).toEqual([]);
  });

  it('keeps the token when the engine cannot be reached', async () => {
    const vault = V.createVault(memStorage());
    const engine = E.createEngine({ fetch: async () => { throw new TypeError('offline'); } });
    await expect(V.topupWithVault({ engine, vault, token: 'cashuBoff', key: 'k', setKey: () => {} })).rejects.toMatchObject({ code: 'offline' });
    expect(vault.incoming()).toMatchObject([{ token: 'cashuBoff', state: 'pending', code: 'offline' }]);
    // Still offline: retrying stops at once and keeps it.
    expect(await V.retryPending({ engine, vault, getKey: () => 'k', setKey: () => {} })).toBe(0);
    expect(vault.incoming()).toHaveLength(1);
  });

  it('keeps a refused token, marked, so it can be copied back out', async () => {
    const vault = V.createVault(memStorage());
    const engine = E.createEngine({ fetch: async () => json({ error: { code: 'token_spent', message: 'token was already redeemed' } }, 400) });
    await expect(V.topupWithVault({ engine, vault, token: 'cashuBspent', key: 'k', setKey: () => {} })).rejects.toMatchObject({ code: 'token_spent', retryable: false });
    expect(vault.incoming()).toMatchObject([{ token: 'cashuBspent', state: 'refused', code: 'token_spent' }]);
    // A refused token is not sent again on its own.
    const f = vi.fn();
    expect(await V.retryPending({ engine: E.createEngine({ fetch: f }), vault, getKey: () => 'k', setKey: () => {} })).toBe(0);
    expect(f).not.toHaveBeenCalled();
    vault.discard(vault.incoming()[0].id);
    expect(vault.incoming()).toEqual([]);
  });

  it('never sends a token it could not store', async () => {
    const vault = V.createVault({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
    const f = vi.fn();
    await expect(V.topupWithVault({ engine: E.createEngine({ fetch: f }), vault, token: 'cashuBx', key: 'k', setKey: () => {} })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
    const silent = V.createVault({ getItem: () => null, setItem: () => {} });
    await expect(V.topupWithVault({ engine: E.createEngine({ fetch: f }), vault: silent, token: 'cashuBx', key: 'k', setKey: () => {} })).rejects.toThrow(/could not store/);
    expect(f).not.toHaveBeenCalled();
  });

  it('does not hold the same token twice, and leaves other flows to themselves', async () => {
    const vault = V.createVault(memStorage());
    const a = vault.hold('cashuBsame');
    expect(vault.hold('cashuBsame').id).toBe(a.id);
    vault.hold('cashuBforeign', 'othermint');
    const f = vi.fn(async () => json({ credited: 1, unit: 'usd' }));
    expect(await V.retryPending({ engine: E.createEngine({ fetch: f }), vault, getKey: () => 'k', setKey: () => {} })).toBe(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(vault.incoming()).toMatchObject([{ token: 'cashuBforeign', via: 'othermint' }]);
  });

  it('holding a kept token again makes it pending once more, with the new funding id', () => {
    const vault = V.createVault(memStorage());
    const a = vault.hold('cashuBagain', 'othermint', { fundingId: 'f1' });
    vault.refused(a.id, 'quote_expired', 'expired');
    const b = vault.hold('cashuBagain', 'othermint', { fundingId: 'f2' });
    expect(b.id).toBe(a.id);
    expect(vault.incoming()).toMatchObject([{ id: a.id, state: 'pending', fundingId: 'f2', via: 'othermint' }]);
  });

  it('keeps a refund token until the person says they saved it', () => {
    const vault = V.createVault(memStorage());
    vault.keepRefund({ id: 'r1', token: 'cashuBout', amount: 50, unit: 'usd' });
    vault.keepRefund({ id: 'r1', token: 'cashuBout', amount: 50, unit: 'usd' });
    expect(vault.outgoing()).toMatchObject([{ id: 'r1', token: 'cashuBout' }]);
    vault.saved('r1');
    expect(vault.outgoing()).toEqual([]);
  });
});
