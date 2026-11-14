import type { Context, Hono } from 'hono';
import { normalizeMintUrl } from './config.ts';
import { type GatewayWallet, PaymentError } from './cashu/wallet.ts';
import type { FundingService } from './funding.ts';

/**
 * The Cashu card relay (slice A13). The phone takes eCash off a Cashu card with one SIG_ALL swap at the
 * card's mint (public/v2/core/card/flow.js). The phone talks only to its engine, so the engine carries
 * that swap to the card's mint and the answer back, and does nothing else with it:
 *
 *   POST /v1/wallet/fund/card/mint     {mint, unit, accept_unlisted?}  the mint's keysets and active keys
 *   POST /v1/wallet/fund/card/swap     {mint, inputs, outputs, ...}     POST <mint>/v1/swap
 *   POST /v1/wallet/fund/card/restore  {mint, outputs, ...}             POST <mint>/v1/restore (NUT-09)
 *
 * What the engine sees: the card's pieces (their secrets name the card's key) and the phone's blinded
 * outputs. It cannot unblind those (the blinding factors stay on the phone), so it cannot take the
 * eCash; the phone then adds that eCash to its balance the usual way. Nothing is stored and nothing of
 * the request is logged.
 *
 * Which mints: the engine's own (an alias is reached at its main address), or another mint that passes
 * the same checks as other-mint funding (vetForeignMint: the policy, the URL safety check, the unlisted
 * prompt). The credit mint is refused: credits are not money. Any other address is refused, so this is
 * never a way to make the engine fetch something else.
 */

const HEX = /^[0-9a-f]+$/i;
const MAX_INPUTS = 128;
const MAX_OUTPUTS = 64;
const TIMEOUT_MS = 20_000;

const isHex = (v: unknown, lens: number[]): v is string => typeof v === 'string' && HEX.test(v) && lens.includes(v.length);
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2 ** 32;

type Output = { amount: number; id: string; B_: string };
type Input = { amount: number; id: string; secret: string; C: string; witness?: string };

function outputsOf(raw: unknown): Output[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_OUTPUTS) throw new PaymentError('invalid_request', `send 1 to ${MAX_OUTPUTS} outputs`);
  return raw.map((o: any) => {
    if (!isAmount(o?.amount) || !isHex(o?.id, [16, 66]) || !isHex(o?.B_, [66])) throw new PaymentError('invalid_request', 'each output is {amount, id, B_}');
    return { amount: o.amount, id: o.id, B_: o.B_ };
  });
}

function inputsOf(raw: unknown): Input[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_INPUTS) throw new PaymentError('invalid_request', `send 1 to ${MAX_INPUTS} inputs`);
  return raw.map((p: any, i) => {
    if (!isAmount(p?.amount) || !isHex(p?.id, [16, 66]) || !isHex(p?.C, [66]) || typeof p?.secret !== 'string' || p.secret.length > 1024 || !p.secret.startsWith('["P2PK",')) {
      throw new PaymentError('invalid_request', 'each input is a card piece {amount, id, secret, C}');
    }
    if (p.witness !== undefined && (i !== 0 || typeof p.witness !== 'string' || p.witness.length > 1024)) throw new PaymentError('invalid_request', 'only the first input carries the witness');
    return { amount: p.amount, id: p.id, secret: p.secret, C: p.C, ...(p.witness !== undefined ? { witness: p.witness } : {}) };
  });
}

export function installCardRelay(app: Hono, { wallet, funding, readJson }: { wallet: GatewayWallet; funding: FundingService; readJson: (c: Context) => Promise<any> }) {
  /** The address to reach the card's mint at, after the same checks as other-mint funding. */
  async function mintUrl(raw: unknown, acceptUnlisted: boolean): Promise<{ url: string; trusted: boolean }> {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 200) throw new PaymentError('invalid_request', 'send the card mint address');
    const m = normalizeMintUrl(raw.trim());
    if (wallet.isCredit?.(m)) throw new PaymentError('credits_not_money', 'free questions cannot come from a card');
    if (wallet.isTrusted(m)) return { url: m, trusted: true };
    const vetted = await funding.vetForeignMint(m, { acceptUnlisted });
    return { url: vetted.url, trusted: false };
  }

  async function ask(url: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    let res: Response;
    try {
      res = await fetch(url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PaymentError('mint_unavailable', 'the card mint could not be reached', 503);
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json };
  }

  /** A mint's own refusal, passed on with its code: the phone tells "already spent" from the rest. */
  const refusal = (c: Context, r: { status: number; body: any }) => {
    if (r.status >= 500) return c.json({ error: { message: 'the card mint failed', type: 'mint_unavailable', code: 'mint_unavailable' } }, 503);
    const detail = typeof r.body?.detail === 'string' ? r.body.detail.slice(0, 300) : `the card mint answered HTTP ${r.status}`;
    return c.json({ error: { message: detail, type: 'mint_refused', code: 'mint_refused' }, mint_code: Number.isInteger(r.body?.code) ? r.body.code : null }, 400);
  };

  app.post('/v1/wallet/fund/card/mint', async (c) => {
    const body = await readJson(c);
    const unit = String(body?.unit ?? '');
    if (!/^[a-z]{1,8}$/.test(unit)) throw new PaymentError('invalid_request', 'send the card unit');
    const { url, trusted } = await mintUrl(body?.mint, body?.accept_unlisted === true);
    const ks = await ask(url, '/v1/keysets');
    if (ks.status !== 200 || !Array.isArray(ks.body?.keysets)) return refusal(c, ks);
    const keysets = ks.body.keysets
      .filter((k: any) => isHex(k?.id, [16, 66]) && typeof k?.unit === 'string')
      .map((k: any) => ({ id: k.id, unit: k.unit, active: k.active === true, input_fee_ppk: Number.isSafeInteger(k.input_fee_ppk) ? k.input_fee_ppk : 0 }));
    const keys: Record<string, Record<string, string>> = {};
    for (const k of keysets.filter((k: { active: boolean; unit: string }) => k.active && k.unit === unit)) {
      const r = await ask(url, `/v1/keys/${k.id}`);
      const found = r.body?.keysets?.find((x: any) => x?.id === k.id);
      if (r.status !== 200 || !found?.keys) return refusal(c, r);
      keys[k.id] = Object.fromEntries(Object.entries(found.keys).filter(([a, K]) => /^\d+$/.test(a) && isHex(K, [66]))) as Record<string, string>;
    }
    return c.json({ mint: url, trusted, unit, keysets, keys });
  });

  app.post('/v1/wallet/fund/card/swap', async (c) => {
    const body = await readJson(c);
    const inputs = inputsOf(body?.inputs);
    const outputs = outputsOf(body?.outputs);
    const { url } = await mintUrl(body?.mint, body?.accept_unlisted === true);
    const r = await ask(url, '/v1/swap', { inputs, outputs });
    if (r.status !== 200 || !Array.isArray(r.body?.signatures)) return refusal(c, r);
    return c.json({ signatures: r.body.signatures });
  });

  app.post('/v1/wallet/fund/card/restore', async (c) => {
    const body = await readJson(c);
    const outputs = outputsOf(body?.outputs);
    const { url } = await mintUrl(body?.mint, body?.accept_unlisted === true);
    const r = await ask(url, '/v1/restore', { outputs });
    if (r.status !== 200) return refusal(c, r);
    return c.json({ outputs: r.body?.outputs ?? [], signatures: r.body?.signatures ?? r.body?.promises ?? [] });
  });
}
