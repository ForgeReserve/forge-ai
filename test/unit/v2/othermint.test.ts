import { describe, expect, it, vi } from 'vitest';

// Other-mint funding on the phone: what the vault keeps for each outcome (public/v2/modules/fund/kit.js).
const K: any = await import('../../../public/v2/modules/fund/kit.js' as string);
const V: any = await import('../../../public/v2/core/vault.js' as string);

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, body });
const view = (state: string, foreign: object = {}, extra: object = {}) => ({ id: 'fund_1', state, unit: 'usd', credited: state === 'done' ? 950 : 0, foreign: { unit: 'sat', token_amount: 1000, credit: 950, fee_max: 20, change_token: null, refund_token: null, payout_pending: false, ...foreign }, ...extra });

function held() {
  const vault = V.createVault(memStorage());
  const entry = vault.hold('cashuBforeign', 'othermint', { fundingId: 'fund_1' });
  return { vault, entry };
}

describe('settling an other-mint funding', () => {
  it('stores the funding id with the held token', () => {
    const { vault } = held();
    expect(vault.incoming()).toMatchObject([{ token: 'cashuBforeign', via: 'othermint', fundingId: 'fund_1', state: 'pending' }]);
  });

  it('done: credits the token and keeps the change with no amount (only the unused fee comes back)', () => {
    const { vault, entry } = held();
    expect(K.settleForeign(vault, entry, view('done', { change_token: 'cashuBchange' }))).toEqual({ final: true, state: 'done' });
    expect(vault.incoming()).toEqual([]);
    const [o] = vault.outgoing();
    expect(o).toMatchObject({ id: 'fund_1_change', token: 'cashuBchange', unit: 'sat' });
    // Never the token's full amount.
    expect(o.amount).toBeNull();
  });

  it('done with a locked change still to come: keeps the entry pending until the change arrives', () => {
    const { vault, entry } = held();
    expect(K.settleForeign(vault, entry, view('done', { payout_pending: true }))).toEqual({ final: false, state: 'done' });
    expect(vault.incoming()).toMatchObject([{ state: 'pending', code: 'change_pending' }]);
    K.settleForeign(vault, vault.incoming()[0], view('done', { change_token: 'cashuBlate' }));
    expect(vault.incoming()).toEqual([]);
    expect(vault.outgoing()).toMatchObject([{ token: 'cashuBlate', amount: null }]);
  });

  it('refunded: keeps the refund (no amount) and drops the spent input token', () => {
    const { vault, entry } = held();
    expect(K.settleForeign(vault, entry, view('refunded', { refund_token: 'cashuBback' })).final).toBe(true);
    expect(vault.incoming()).toEqual([]);
    expect(vault.outgoing()).toMatchObject([{ id: 'fund_1_refund', token: 'cashuBback', amount: null }]);
  });

  it('a locked refund not issued yet is resolved later, not left pending for ever', () => {
    const { vault, entry } = held();
    expect(K.settleForeign(vault, entry, view('refunded', { payout_pending: true }))).toEqual({ final: false, state: 'refunded' });
    expect(vault.incoming()).toMatchObject([{ state: 'pending', code: 'refund_pending' }]);
    // The next look-up (on start or on Funds) finds the refund issued.
    K.settleForeign(vault, vault.incoming()[0], view('refunded', { refund_token: 'cashuBlocked' }));
    expect(vault.incoming()).toEqual([]);
    expect(vault.outgoing()).toMatchObject([{ token: 'cashuBlocked' }]);
  });

  it('failed or expired: the token is kept, marked, so it can be copied', () => {
    for (const s of ['failed', 'expired']) {
      const { vault, entry } = held();
      expect(K.settleForeign(vault, entry, view(s, {}, { error: 'no route' })).final).toBe(true);
      expect(vault.incoming()).toMatchObject([{ state: 'refused', code: s }]);
    }
  });

  it('a step in between leaves the token pending', () => {
    const { vault, entry } = held();
    for (const s of ['quoted', 'receiving', 'melting', 'pending', 'minting']) expect(K.settleForeign(vault, entry, view(s)).final).toBe(false);
    expect(vault.incoming()).toMatchObject([{ state: 'pending' }]);
    expect(vault.outgoing()).toEqual([]);
  });
});

describe('a failed confirm', () => {
  it('is refused only when the engine is sure it did not take the token', () => {
    expect(K.confirmOutcome(400, { error: { code: 'token_mismatch' } })).toBe('refused');
    expect(K.confirmOutcome(409, { error: { code: 'quote_expired' } })).toBe('refused');
    expect(K.confirmOutcome(404, { error: { code: 'not_found' } })).toBe('refused');
  });

  it('keeps the token pending when the funding is being processed or the engine failed', () => {
    expect(K.confirmOutcome(409, { error: { code: 'in_flight' } })).toBe('wait');
    expect(K.confirmOutcome(500, null)).toBe('wait');
    expect(K.confirmOutcome(502, { error: { code: 'mint_error' } })).toBe('wait');
    expect(K.confirmOutcome(503, { error: { code: 'mint_unavailable' } })).toBe('wait');
    expect(K.confirmOutcome(429, null)).toBe('wait');
  });
});

describe('settling what is pending when the screen is gone', () => {
  it('looks up each pending other-mint token and settles it', async () => {
    const vault = V.createVault(memStorage());
    vault.hold('cashuBa', 'othermint', { fundingId: 'fund_a' });
    vault.hold('cashuBb', 'othermint', { fundingId: 'fund_b' });
    vault.hold('cashuBtop'); // a plain top-up: not this flow's
    const engine = {
      funding: vi.fn(async (_k: string, id: string) =>
        id === 'fund_a' ? json({ ...view('done', { change_token: 'cashuBchg' }), id }) : json({ ...view('refunded', { payout_pending: true }), id }),
      ),
    };
    expect(await K.settlePendingForeign({ engine, vault, key: 'sk' })).toBe(2);
    expect(engine.funding).toHaveBeenCalledTimes(2);
    expect(vault.incoming().map((e: any) => [e.token, e.state, e.code ?? null])).toEqual([
      ['cashuBb', 'pending', 'refund_pending'],
      ['cashuBtop', 'pending', null],
    ]);
    expect(vault.outgoing()).toMatchObject([{ id: 'fund_a_change', token: 'cashuBchg', amount: null }]);
  });

  it('marks a funding the engine does not know as not added, and stops when offline', async () => {
    const vault = V.createVault(memStorage());
    vault.hold('cashuBx', 'othermint', { fundingId: 'gone' });
    await K.settlePendingForeign({ engine: { funding: async () => json({ error: { code: 'not_found', message: 'unknown funding' } }, 404) }, vault, key: 'sk' });
    expect(vault.incoming()).toMatchObject([{ state: 'refused', code: 'not_found' }]);

    const v2 = V.createVault(memStorage());
    v2.hold('cashuBy', 'othermint', { fundingId: 'f' });
    expect(await K.settlePendingForeign({ engine: { funding: async () => { throw new Error('offline'); } }, vault: v2, key: 'sk' })).toBe(0);
    expect(v2.incoming()).toMatchObject([{ state: 'pending' }]);
    expect(await K.settlePendingForeign({ engine: { funding: vi.fn() }, vault: v2, key: null })).toBe(0);
  });
});
