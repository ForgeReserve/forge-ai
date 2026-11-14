import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCardRelay } from '../../src/cardrelay.ts';
import { PaymentError } from '../../src/cashu/wallet.ts';
import { EnvSchema } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { FundingService } from '../../src/funding.ts';

// The engine's Cashu card relay (src/cardrelay.ts) with the card's mint stood in by a fetch stub: what it
// tells the phone about another mint's caps, and how it words a mint that is busy rather than refusing.
const FORGE = 'https://forge.example';
const LISTED = 'https://listed.example';
const UNLISTED = 'https://unlisted.example';
const KS = '00' + 'ab'.repeat(7);

function relay(env: Record<string, string> = {}) {
  const e = EnvSchema.parse({ FORGE_FOREIGN_DISCOVERY_RELAYS: '', FORGE_FOREIGN_ALLOW_INSECURE: 'true', FORGE_FOREIGN_POLICY: 'allowlist', FORGE_FOREIGN_ALLOW: LISTED, ...env });
  const wallet = { trustedMints: [FORGE], isTrusted: (m: string) => m.replace(/\/+$/, '') === FORGE, isCredit: () => false };
  const funding = new FundingService({ db: openDb(':memory:'), ledger: {} as never, wallet: wallet as never, env: e, rates: {} as never, mint: FORGE, probe: async (url) => ({ url, ok: true, units: ['sat'] }) });
  const app = new Hono();
  app.onError((err, c) => (err instanceof PaymentError ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: 'internal' } }, 500)));
  installCardRelay(app, { wallet: wallet as never, funding, readJson: (c) => c.req.json() });
  const post = async (path: string, body: unknown) => {
    const r = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { post };
}

/** The card's mint: its keysets and keys, and a swap that answers `swap`. */
function mintAnswers(swap: { status: number; body: unknown }) {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/keysets') return json(200, { keysets: [{ id: KS, unit: 'sat', active: true, input_fee_ppk: 0 }] });
    if (path === `/v1/keys/${KS}`) return json(200, { keysets: [{ id: KS, unit: 'sat', keys: { '1': '02' + '11'.repeat(32) } }] });
    if (path === '/v1/swap') return json(swap.status, swap.body);
    return json(404, {});
  });
}

const input = { amount: 1, id: KS, secret: '["P2PK",{}]', C: '02' + '11'.repeat(32) };
const output = { amount: 1, id: KS, B_: '02' + '22'.repeat(32) };

afterEach(() => vi.unstubAllGlobals());

describe('the card relay', () => {
  it("answers another mint's cap with its keys, the lower unlisted one for an unlisted mint, and none for the engine's own", async () => {
    mintAnswers({ status: 200, body: {} });
    const r = relay({ FORGE_FOREIGN_MAX_SAT: '20000', FORGE_FOREIGN_UNLISTED_MAX_SAT: '5000' });
    const own = await r.post('/v1/wallet/fund/card/mint', { mint: FORGE, unit: 'sat' });
    expect(own.status).toBe(200);
    expect(own.body.trusted).toBe(true);
    expect(own.body.max).toBeUndefined();
    const listed = await r.post('/v1/wallet/fund/card/mint', { mint: LISTED, unit: 'sat' });
    expect(listed.body).toMatchObject({ trusted: false, max: 20000 });
    const asked = await r.post('/v1/wallet/fund/card/mint', { mint: UNLISTED, unit: 'sat' });
    expect(asked.body.error.code).toBe('mint_unlisted');
    const unlisted = await r.post('/v1/wallet/fund/card/mint', { mint: UNLISTED, unit: 'sat', accept_unlisted: true });
    expect(unlisted.body).toMatchObject({ trusted: false, max: 5000 });
    // The other-mint cap wins when it is the lower one.
    const low = relay({ FORGE_FOREIGN_MAX_SAT: '3000', FORGE_FOREIGN_UNLISTED_MAX_SAT: '5000' });
    expect((await low.post('/v1/wallet/fund/card/mint', { mint: UNLISTED, unit: 'sat', accept_unlisted: true })).body.max).toBe(3000);
  });

  it.each([429, 408, 502])('a mint that answers %i has refused nothing: 503 mint_unavailable', async (status) => {
    mintAnswers({ status, body: { detail: 'slow down', code: 0 } });
    const r = await relay().post('/v1/wallet/fund/card/swap', { mint: FORGE, inputs: [input], outputs: [output] });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('mint_unavailable');
    expect(r.body.mint_code).toBeUndefined();
  });

  it("a mint's own refusal is passed on with its code", async () => {
    mintAnswers({ status: 400, body: { detail: 'outputs are pending', code: 11004 } });
    const r = await relay().post('/v1/wallet/fund/card/swap', { mint: FORGE, inputs: [input], outputs: [output] });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: 'mint_refused', message: 'outputs are pending' }, mint_code: 11004 });
  });
});
