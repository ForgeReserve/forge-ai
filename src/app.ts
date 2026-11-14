import { randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { PaymentRequest } from '@cashu/cashu-ts';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { openAccount, releaseIfEmpty } from './accounts.ts';
import { createAdminRouter } from './admin-api.ts';
import { BetaWaitlist, parseContact } from './beta.ts';
import { parseOptionalLockPubkey } from './cashu/lock.ts';
import { type GatewayWallet, PaymentError } from './cashu/wallet.ts';
import type { Config, ModelConfig, Unit } from './config.ts';
import { type DB, now, tx } from './db.ts';
import { FOREIGN_MINTS_PATH, type FundingService } from './funding.ts';
import type { MintDiscovery } from './mint-discovery.ts';
import { type Account, type Invites, type Ledger, LedgerError } from './ledger.ts';
import { errText, log } from './log.ts';
import { parseUsageMetrics, USAGE_HEADER as TINFOIL_USAGE_HEADER } from './suppliers/tinfoil.ts';
import { costFromHeaders, FrameCounter, SseMeter, usageFromJson } from './meter.ts';
import { costNanoUsd, displayPrice, estimateTokensFromBytes, flatCostNanoUsd, MSUB_PER_UNIT, msubToUnitsCeil, nanoUsdToMsub, type Usage } from './pricing.ts';
import { RateLimiter } from './ratelimit.ts';
import type { RateOracle } from './rates.ts';
import { type Supplier, UpstreamError } from './suppliers/types.ts';
import { serviceWorkerScript } from './sw.ts';

export interface Deps {
  config: Config;
  db: DB;
  ledger: Ledger;
  invites: Invites;
  wallet: GatewayWallet;
  rates: RateOracle;
  suppliers: Map<string, Supplier>;
  funding: FundingService;
  discovery: MintDiscovery;
  publicDir?: string;
}

const EXPOSE = [
  'X-Cashu',
  'X-Cashu-Change',
  'X-Forge-Request-Id',
  'X-Forge-Unit',
  'X-Forge-Charged-Msub',
  'X-Forge-Balance-Msub',
  'X-Forge-Change-Url',
  'X-Forge-Privacy',
  'Ehbp-Response-Nonce',
  'Retry-After',
];
const ALLOW = [
  'Accept',
  'Authorization',
  'Content-Type',
  'X-Cashu',
  'X-Cashu-Pubkey',
  'X-Forge-Invite',
  'X-Forge-Request-Id',
  'X-Forge-Unit',
  'Ehbp-Encapsulated-Key',
  'X-Tinfoil-Enclave-Url',
  'X-Tinfoil-Model',
  'X-Tinfoil-Max-Output-Tokens',
  'X-Tinfoil-Completion-Count',
];

function apiError(c: Context, status: number, code: string, message: string, headers: Record<string, string> = {}, extra: object = {}) {
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json({ error: { message, type: code, code }, ...extra }, status as any);
}

/** The shape of a request id this gateway issues; a paid retry may echo one back (see the chat route). */
const REQUEST_ID = /^req_[0-9a-f]{32}$/;

function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization');
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1]?.trim();
}

/** The balance reservation a chat request holds, if any (see the chat route). */
type ChatOwnership = { reservationId?: string };
type Payment = { kind: 'balance'; account: Account; reservationId: string } | { kind: 'nut24'; mint: string; unit: Unit; paid: number };

interface SettleResult {
  chargedMsub: number;
  balanceMsub?: number;
  changeUnits?: number;
  changeToken?: string;
  changeId?: string;
}

export function createApp(d: Deps) {
  const { config, db, ledger, invites, wallet, rates, suppliers } = d;
  const env = config.env;
  const app = new Hono();
  const limiter = new RateLimiter(env.FORGE_RATE_LIMIT_RPM);
  const models = new Map(config.catalog.models.map((m) => [m.id, m]));

  installRecoveryHooks(d);

  const clientIp = (c: Context): string => {
    if (env.FORGE_TRUST_PROXY) {
      const xff = c.req.header('x-forwarded-for');
      if (xff) return xff.split(',')[0]!.trim();
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });
  app.use('/v1/*', cors({ origin: '*', allowHeaders: ALLOW, exposeHeaders: EXPOSE, allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 }));
  app.use('/attestation', cors({ origin: '*', allowMethods: ['GET'] }));
  app.use('/.well-known/*', cors({ origin: '*', allowMethods: ['GET'] }));
  app.use(
    '/v1/*',
    bodyLimit({ maxSize: env.FORGE_MAX_BODY_BYTES, onError: (c) => apiError(c, 413, 'request_too_large', `request body over ${env.FORGE_MAX_BODY_BYTES} bytes`) }),
  );
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.method === 'GET') return next();
    const key = bearer(c);
    const id = key ? 'k:' + key.slice(-12) : 'ip:' + clientIp(c);
    const wait = limiter.take(id);
    if (wait > 0) return apiError(c, 429, 'rate_limited', 'too many requests', { 'Retry-After': String(wait) });
    return next();
  });

  app.onError((e, c) => {
    if (e instanceof PaymentError) return apiError(c, e.status, e.code, e.message, {}, e.extra ?? {});
    if (e instanceof LedgerError) return apiError(c, e.status, e.code, e.message);
    if (e instanceof UpstreamError) return apiError(c, e.status, 'upstream_error', e.message);
    log.error('unhandled', { path: c.req.path, err: errText(e) });
    return apiError(c, 500, 'internal_error', 'internal error');
  });

  // ------------------------------------------------------------------ meta

  app.get('/healthz', (c) => {
    const r = rates.status();
    return c.json({ ok: true, rate: r ? { btc_usd: r.rate, age_s: Math.round(r.ageMs / 1000) } : null, invite_only: env.FORGE_INVITE_ONLY });
  });

  app.get('/v1/models', async (c) => {
    const rate = env.FORGE_UNITS.includes('sat') ? await rates.get().catch(() => undefined) : undefined;
    const data = config.catalog.models.map((m) => {
      const s = config.catalog.suppliers[m.supplier]!;
      return {
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.supplier,
        name: m.name ?? m.id,
        tier: s.tier,
        privacy: s.tier,
        encrypted_passthrough: s.type === 'tinfoil',
        uncensored: m.uncensored,
        capabilities: { vision: m.vision, reasoning: m.reasoning, reasoning_efforts: m.reasoning_efforts },
        speed: m.speed ?? null,
        context_length: m.context_length ?? null,
        max_output_tokens: m.max_output_tokens,
        pricing: {
          mode: s.pricing,
          usd_per_mtok: { input: round(m.input_usd_per_mtok * env.FORGE_MARKUP), output: round(m.output_usd_per_mtok * env.FORGE_MARKUP) },
          sat_per_mtok: rate
            ? { input: round(displayPrice(m.input_usd_per_mtok, env.FORGE_MARKUP, 'sat', rate)!), output: round(displayPrice(m.output_usd_per_mtok, env.FORGE_MARKUP, 'sat', rate)!) }
            : null,
          verified: m.price_verified,
        },
        upstream_model: s.type === 'tinfoil' ? m.upstream : undefined,
      };
    });
    return c.json({ object: 'list', data, units: env.FORGE_UNITS, mints: wallet.trustedMints, invite_only: env.FORGE_INVITE_ONLY, btc_usd: rate ?? null });
  });

  // ------------------------------------------------------------------ wallet

  app.post('/v1/wallet/topup', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, 'invalid_request', 'expected JSON {"token": "cashuB...", "invite": "..."}');
    }
    const token = String(body?.token ?? '');
    const invite = typeof body?.invite === 'string' ? body.invite : c.req.header('x-forge-invite');
    const t = await wallet.inspect(token);

    const opened = openAccount({ db, ledger, invites, inviteOnly: env.FORGE_INVITE_ONLY }, { key: bearer(c), invite, unit: t.unit });
    const account = opened.account;
    const created = opened.created;
    const generated = !!opened.generatedKey;
    const key = opened.generatedKey;
    const acct = account;
    try {
      const r = await wallet.receive(token, {
        purpose: 'topup',
        accountId: acct.id,
        onFinalize: (amount) => ledger.creditRaw(acct.id, amount * MSUB_PER_UNIT, 'topup', null),
      });
      const a = ledger.get(acct.id)!;
      log.info('topup', { account: a.id, unit: a.unit, amount: r.amount, replay: r.replay });
      return c.json({
        key: generated ? key : undefined,
        account_id: a.id,
        unit: a.unit,
        credited: r.replay ? 0 : r.amount,
        replay: r.replay,
        balance_msub: a.balance_msub,
        balance: a.balance_msub / MSUB_PER_UNIT,
      });
    } catch (e) {
      const definitive = e instanceof PaymentError && e.status < 500;
      if (created && !definitive) {
        // Outcome unknown (mint unreachable or crash mid-swap): keep the account so recovery can credit it,
        // and hand the generated key back so the client can retry with the same key and token.
        log.warn('topup_pending', { account: acct.id, err: errText(e) });
        return c.json(
          {
            error: { message: 'topup outcome pending; retry with this key and the same token', type: 'topup_pending', code: 'topup_pending' },
            key: generated ? key : undefined,
            account_id: acct.id,
          },
          503,
        );
      }
      // Definitive rejection: undo the empty account so the invite can be used again.
      if (created) releaseIfEmpty(db, acct.id);
      throw e;
    }
  });

  const requireAccount = (c: Context): Account => {
    const key = bearer(c);
    const a = key ? ledger.findByKey(key) : undefined;
    if (!a) throw new LedgerError('invalid_key', 'missing or unknown balance key', 401);
    return a;
  };

  app.get('/v1/wallet', (c) => {
    const a = requireAccount(c);
    const reserved = ledger.reservedMsub(a.id);
    return c.json({
      account_id: a.id,
      unit: a.unit,
      balance_msub: a.balance_msub,
      available_msub: a.balance_msub - reserved,
      balance: a.balance_msub / MSUB_PER_UNIT,
      refundable: Math.floor((a.balance_msub - reserved) / MSUB_PER_UNIT),
    });
  });

  const outgoingView = (r: { id: string; amount: number; unit: string; status: string; token: string | null; lock_pubkey?: string | null }) => ({
    id: r.id,
    amount: r.amount,
    unit: r.unit,
    status: r.status,
    token: r.token,
    locked_to: r.lock_pubkey ?? null,
  });

  app.get('/v1/wallet/refunds', (c) => {
    const a = requireAccount(c);
    return c.json({ data: wallet.listOutgoing({ accountId: a.id }).map(outgoingView) });
  });

  app.post('/v1/wallet/refund', async (c) => {
    const a = requireAccount(c);
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body is fine */
    }
    const lockPubkey = parseOptionalLockPubkey(body?.pubkey);
    // Retry anything still owed to this account first.
    for (const r of wallet.listOutgoing({ accountId: a.id })) {
      if (r.status !== 'done' && r.status !== 'failed') await wallet.issue(r.id).catch(() => {});
    }
    const avail = ledger.available(a.id);
    const maxUnits = Math.floor(avail / MSUB_PER_UNIT);
    const units = body?.amount === undefined ? maxUnits : Number(body.amount);
    if (!Number.isInteger(units) || units < 1 || units > maxUnits) {
      return apiError(c, 400, 'invalid_amount', `refundable amount is 1..${maxUnits} ${a.unit}`);
    }
    const mint = pickMint(a.unit, units);
    if (!mint) return apiError(c, 503, 'wallet_insufficient', 'gateway cannot cover this refund from a single mint right now');
    const outId = tx(db, () => {
      ledger.debitRaw(a.id, units * MSUB_PER_UNIT, 'refund', 'pending');
      return wallet.oweRaw({ mint, unit: a.unit, amount: units, purpose: 'refund', accountId: a.id, lockPubkey });
    });
    let token: string | null = null;
    try {
      token = await wallet.issue(outId);
    } catch (e) {
      log.warn('refund_issue_deferred', { id: outId, err: errText(e) });
    }
    const after = ledger.get(a.id)!;
    log.info('refund', { account: a.id, unit: a.unit, amount: units, issued: !!token, locked: !!lockPubkey });
    return c.json(
      {
        id: outId,
        token,
        amount: units,
        unit: a.unit,
        status: token ? 'done' : 'owed',
        locked_to: lockPubkey,
        balance_msub: after.balance_msub,
        refunds: wallet.listOutgoing({ accountId: a.id }).map(outgoingView),
      },
      token ? 200 : 202,
    );
  });

  /** Mint with the most unspent eCash for this unit, if it covers amount. */
  const pickMint = (unit: Unit, amount: number): string | undefined => {
    const h = wallet
      .holdings()
      .filter((x) => x.unit === unit && wallet.isTrusted(x.mint))
      .sort((a, b) => b.unspent - a.unspent)[0];
    return h && h.unspent >= amount ? h.mint : undefined;
  };

  // ------------------------------------------------------------------ funding (Lightning, on-chain, other mints)

  const { funding } = d;
  const readJson = async (c: Context): Promise<any> => {
    try {
      return await c.req.json();
    } catch {
      throw new PaymentError('invalid_request', 'expected a JSON body');
    }
  };
  const unitOf = (v: unknown): Unit => {
    const u = String(v ?? env.FORGE_DEFAULT_UNIT) as Unit;
    if (!env.FORGE_UNITS.includes(u)) throw new PaymentError('wrong_unit', `unit must be one of ${env.FORGE_UNITS.join(', ')}`);
    return u;
  };
  const fundingResponse = (c: Context, row: Parameters<FundingService['view']>[0], key?: string) => c.json({ ...funding.view(row), key });
  /** Opens the balance for a funding; a balance created here is released again if the quote cannot be made. */
  const withAccount = async <T,>(c: Context, unit: Unit, invite: unknown, fn: (accountId: string) => Promise<T>): Promise<{ result: T; key?: string }> => {
    const opened = openAccount({ db, ledger, invites, inviteOnly: env.FORGE_INVITE_ONLY }, { key: bearer(c), invite: typeof invite === 'string' ? invite : undefined, unit });
    try {
      return { result: await fn(opened.account.id), key: opened.generatedKey };
    } catch (e) {
      if (opened.created) releaseIfEmpty(db, opened.account.id);
      throw e;
    }
  };

  app.get('/v1/wallet/fund/methods', async (c) => c.json({ ...(await funding.methods()), invite_only: env.FORGE_INVITE_ONLY }));

  // Other mints whose eCash is accepted for funding. Public; never waits on a relay.
  app.get(FOREIGN_MINTS_PATH, (c) => {
    const a = funding.acceptedForeignMints();
    return c.json({ enabled: env.FORGE_FOREIGN_ENABLED, ...a });
  });

  app.post('/v1/wallet/fund/lightning', async (c) => {
    const body = await readJson(c);
    const unit = unitOf(body?.unit);
    const amount = Number(body?.amount);
    if (!Number.isInteger(amount) || amount < 1) return apiError(c, 400, 'invalid_amount', 'amount must be a whole number of units');
    const { result, key } = await withAccount(c, unit, body?.invite, (id) => funding.createLightning(id, unit, amount));
    return fundingResponse(c, result, key);
  });

  app.post('/v1/wallet/fund/onchain', async (c) => {
    const body = await readJson(c).catch(() => ({}));
    const { result, key } = await withAccount(c, 'sat', body?.invite, (id) => funding.createOnchain(id));
    return fundingResponse(c, result, key);
  });

  app.post('/v1/wallet/fund/foreign/quote', async (c) => {
    const body = await readJson(c);
    const unit = unitOf(body?.unit);
    const token = String(body?.token ?? '').trim();
    if (!token.startsWith('cashuB')) return apiError(c, 400, 'invalid_token', 'expected a cashuB token');
    const lockPubkey = parseOptionalLockPubkey(body?.pubkey);
    const acceptUnlisted = body?.accept_unlisted === true;
    const { result, key } = await withAccount(c, unit, body?.invite, (id) => funding.quoteForeign(id, unit, token, lockPubkey, { acceptUnlisted }));
    return fundingResponse(c, result, key);
  });

  const ownFunding = (c: Context, id: string) => {
    const a = requireAccount(c);
    const row = funding.get(id);
    if (!row || row.account_id !== a.id) throw new PaymentError('not_found', 'unknown funding', 404);
    return row;
  };

  app.post('/v1/wallet/fund/foreign/confirm', async (c) => {
    const body = await readJson(c);
    const lockPubkey = parseOptionalLockPubkey(body?.pubkey);
    const row = ownFunding(c, String(body?.id ?? ''));
    const out = await funding.confirmForeign(row.id, String(body?.token ?? '').trim(), lockPubkey);
    return fundingResponse(c, out);
  });

  app.get('/v1/wallet/fund', (c) => {
    const a = requireAccount(c);
    return c.json({ data: funding.list(a.id).map((r) => funding.view(r)) });
  });

  app.get('/v1/wallet/fund/:id', async (c) => {
    const row = ownFunding(c, c.req.param('id'));
    // Polling drives progress too, so a funding completes even when the background poller is off,
    // but a pending quote only when it is due: a browser polling fast must not hammer the mint's quote checks.
    const due = row.state === 'pending' ? row.next_check <= Date.now() : Date.now() - row.updated_at > 1500 || row.state === 'minting';
    const fresh = due ? ((await funding.advance(row.id)) ?? row) : row;
    return fundingResponse(c, fresh);
  });

  // NUT-24 change re-delivery: the request id is an unguessable capability returned only to the payer.
  app.get('/v1/change/:id', async (c) => {
    const id = c.req.param('id');
    // Other-mint funding change shares purpose 'change' but is delivered with the funding, behind its key.
    const readReq = () => db.prepare('SELECT payment, status FROM requests WHERE id = ?').get(id) as { payment: string; status: string } | undefined;
    const changeRows = () => wallet.listOutgoing({ requestId: id }).filter((r) => r.purpose === 'change');
    const swapUnsettled = () => !!db.prepare("SELECT 1 FROM incoming WHERE request_id = ? AND status = 'prepared'").get(id);
    let req = readReq();
    let rows = req ? changeRows() : [];
    // A paid attempt whose swap outcome is unknown (the mint timed out, or failed after swapping) failed
    // with its token held at the mint. Settle that swap now, so the whole payment is owed back under this id;
    // while the mint stays silent the answer is "not yet", never "nothing".
    if (!rows.length && req?.payment === 'nut24' && req.status === 'failed' && swapUnsettled()) {
      try {
        await wallet.recoverIncomingFor(id);
      } catch (e) {
        log.warn('change_recovery_deferred', { request_id: id, err: errText(e) });
      }
      if (swapUnsettled()) return apiError(c, 409, 'not_settled', 'payment outcome not known yet; the mint has not answered', { 'Retry-After': '5' });
      req = readReq();
      rows = changeRows();
    }
    if (!rows.length) {
      if (req && !['settled', 'failed', 'aborted'].includes(req.status)) return apiError(c, 409, 'not_settled', 'request still running', { 'Retry-After': '2' });
      return apiError(c, 404, 'not_found', 'no change for this request');
    }
    const out = [];
    for (const r of rows) {
      let token = r.token;
      if (r.status !== 'done') token = await wallet.issue(r.id);
      out.push({ ...outgoingView(r), token, status: 'done' });
    }
    return c.json({ request_id: id, data: out, token: out[0]?.token });
  });

  // ------------------------------------------------------------------ attestation (Tinfoil SDK through the gateway)

  const enclaveSupplier = [...suppliers.values()].find((s) => s.config.type === 'tinfoil');
  // EHBP key config, for browser clients whose transport asks the proxy origin for it.
  app.get('/.well-known/hpke-keys', async (c) => {
    if (!enclaveSupplier?.hpkeKeys) return apiError(c, 404, 'not_found', 'no enclave supplier');
    return enclaveSupplier.hpkeKeys();
  });
  app.get('/attestation', async (c) => {
    if (!enclaveSupplier?.attestation) return apiError(c, 404, 'not_found', 'no enclave supplier');
    return enclaveSupplier.attestation();
  });

  // ------------------------------------------------------------------ chat

  // A request owns its balance reservation until it settles (src/ledger.ts). An error that escapes
  // before settlement gives the reservation up, so the abandoned-request sweep can release it.
  app.post('/v1/chat/completions', async (c) => {
    const own: ChatOwnership = {};
    try {
      return await chatCompletion(c, own);
    } catch (e) {
      if (own.reservationId) ledger.disown(own.reservationId);
      throw e;
    }
  });
  const chatCompletion = async (c: Context, own: ChatOwnership) => {
    const t0 = Date.now();
    // A NUT-24 payment may echo the id from its 402 in X-Forge-Request-Id, so the request, its change
    // and any recovery run under the id the payer already holds. Every other request gets a fresh one.
    const echoedId = !bearer(c) && c.req.header('x-cashu') ? c.req.header('x-forge-request-id') : undefined;
    if (echoedId !== undefined && !REQUEST_ID.test(echoedId)) {
      return apiError(c, 400, 'invalid_request', 'X-Forge-Request-Id must be the request id from the 402 (req_ and 32 hex digits)');
    }
    const requestId = echoedId ?? 'req_' + randomUUID().replaceAll('-', '');
    c.header('X-Forge-Request-Id', requestId);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const encrypted = !!c.req.header('ehbp-encapsulated-key');

    // 1. Resolve model, max output, and the body we send upstream.
    let model: ModelConfig | undefined;
    let maxOut: number;
    let stream = false;
    let upstreamBody: Record<string, unknown> | undefined;
    let clientWantsUsage = false;
    if (encrypted) {
      const name = c.req.header('x-tinfoil-model');
      if (!name) return apiError(c, 400, 'invalid_request', 'encrypted requests must send X-Tinfoil-Model');
      model = config.catalog.models.find((m) => config.catalog.suppliers[m.supplier]!.type === 'tinfoil' && (m.upstream === name || m.id === name));
      if (!model) return apiError(c, 404, 'model_not_found', `no enclave model ${name}`);
      const hdr = c.req.header('x-tinfoil-max-output-tokens');
      maxOut = hdr ? Number(hdr) : model.max_output_tokens;
      if (c.req.header('x-tinfoil-completion-count') && c.req.header('x-tinfoil-completion-count') !== '1') {
        return apiError(c, 400, 'invalid_request', 'only one completion per request');
      }
    } else {
      let body: any;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return apiError(c, 400, 'invalid_request', 'body must be JSON');
      }
      if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
        return apiError(c, 400, 'invalid_request', 'model and messages are required');
      }
      model = models.get(body.model);
      if (!model) return apiError(c, 404, 'model_not_found', `unknown model ${body.model}; see GET /v1/models`);
      if (body.n !== undefined && body.n !== 1) return apiError(c, 400, 'invalid_request', 'n must be 1');
      maxOut = Number(body.max_completion_tokens ?? body.max_tokens ?? model.max_output_tokens);
      stream = body.stream === true;
      clientWantsUsage = body.stream_options?.include_usage === true;
      const ub: Record<string, unknown> = { ...body, model: model.upstream };
      if (body.max_completion_tokens == null && body.max_tokens == null) ub.max_tokens = maxOut;
      if (stream) ub.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
      upstreamBody = ub;
    }
    if (!Number.isInteger(maxOut) || maxOut < 1 || maxOut > model.max_output_tokens) {
      return apiError(c, 400, 'invalid_request', `max tokens must be 1..${model.max_output_tokens} for ${model.id}`);
    }
    const supplierCfg = config.catalog.suppliers[model.supplier]!;
    const supplier = suppliers.get(model.supplier)!;
    if (encrypted && !supplier.forwardEncrypted) return apiError(c, 400, 'invalid_request', 'this supplier does not accept encrypted bodies');
    if (!encrypted && supplierCfg.type === 'tinfoil' && !supplierCfg.allowPlaintext) {
      return apiError(c, 400, 'encryption_required', 'this model only accepts EHBP-encrypted requests');
    }
    const privacy = supplierCfg.tier === 'enclave' ? (encrypted ? 'enclave-encrypted' : 'enclave-plaintext') : 'standard';
    c.header('X-Forge-Privacy', privacy);

    // 2. Payment kind and unit.
    const key = bearer(c);
    const cashu = c.req.header('x-cashu');
    // NUT-11: lock this request's change to the payer's key. Stored with the request, never logged.
    const lockPubkey = parseOptionalLockPubkey(c.req.header('x-cashu-pubkey'));
    let account: Account | undefined;
    let unit: Unit;
    if (key) {
      account = ledger.findByKey(key);
      if (!account) return apiError(c, 401, 'invalid_key', 'unknown balance key');
      unit = account.unit;
    } else if (cashu) {
      unit = (await wallet.inspect(cashu)).unit;
    } else {
      const u = (c.req.header('x-forge-unit') ?? env.FORGE_DEFAULT_UNIT) as Unit;
      if (!env.FORGE_UNITS.includes(u)) return apiError(c, 400, 'wrong_unit', `unit must be one of ${env.FORGE_UNITS.join(', ')}`);
      unit = u;
    }
    let rate: number | undefined;
    if (unit === 'sat') {
      rate = await rates.get();
      if (!rate) return apiError(c, 503, 'rate_unavailable', 'BTC/USD rate unavailable; sat pricing is paused. Pay in usd or retry later.');
    }

    // 3. Maximum cost of this request.
    // pricing=flat: always the flat schedule. pricing=metered with a flat schedule: flat is the fallback
    // when no usage signal arrives (e.g. encrypted pass-through without usage metrics).
    const flat = supplierCfg.flat;
    const alwaysFlat = supplierCfg.pricing === 'flat';
    const markup = env.FORGE_MARKUP;
    const flatNano = flat ? flatCostNanoUsd(flat, raw.length, maxOut, markup) : 0;
    const meteredMax = costNanoUsd(model, { inputTokens: estimateTokensFromBytes(raw.length, env.FORGE_BYTES_PER_TOKEN), outputTokens: maxOut }, markup);
    const maxNano = alwaysFlat ? flatNano : Math.max(meteredMax, flatNano);
    const reserveMsub = Math.max(1, nanoUsdToMsub(maxNano, unit, rate));
    const requiredUnits = msubToUnitsCeil(reserveMsub);

    // 4. Payment.
    const inviteOk = () => !env.FORGE_INVITE_ONLY || invites.checkForNut24(c.req.header('x-forge-invite'));
    let pay: Payment;
    if (account) {
      const reservationId = ledger.reserve(account.id, reserveMsub);
      own.reservationId = reservationId;
      pay = { kind: 'balance', account, reservationId };
    } else if (!cashu) {
      if (!inviteOk()) return apiError(c, 403, 'invite_required', 'send X-Forge-Invite with a valid invite code, or use a balance key');
      const quoted = unit === 'sat' ? Math.ceil(requiredUnits * env.FORGE_SAT_PRICE_BUFFER) : requiredUnits;
      // The NUT-18 id is the full request id, the same value as X-Forge-Request-Id.
      const pr = new PaymentRequest(undefined, requestId, quoted, unit, wallet.trustedMints, `Forge AI: ${model.id}`, true);
      const creq = pr.toEncodedRequest();
      return apiError(c, 402, 'payment_required', `pay ${quoted} ${unit} in eCash: retry with X-Cashu: cashuB... Unused value is returned as change.`, { 'X-Cashu': creq }, {
        payment_request: creq,
        amount: quoted,
        unit,
        mints: wallet.trustedMints,
      });
    } else {
      if (!inviteOk()) return apiError(c, 403, 'invite_required', 'send X-Forge-Invite with a valid invite code');
      // One id, one payment: an echoed id that already has a request is refused before the token is touched.
      const created = db
        .prepare(
          "INSERT OR IGNORE INTO requests (id, payment, unit, model, supplier, encrypted, status, reserved_msub, lock_pubkey, created_at) VALUES (?, 'nut24', ?, ?, ?, ?, 'new', ?, ?, ?)",
        )
        .run(requestId, unit, model.id, model.supplier, encrypted ? 1 : 0, reserveMsub, lockPubkey, now());
      if (Number(created.changes) === 0) {
        return apiError(
          c,
          409,
          'request_id_used',
          `request ${requestId} already exists. This attempt did not touch the token it carried. If you are retrying a request that already reached us, its token was spent there and its outcome and any change are at /v1/change/${requestId}. Otherwise ask for a new 402, or send the token without X-Forge-Request-Id.`,
        );
      }
      try {
        const r = await wallet.receive(cashu, {
          purpose: 'nut24',
          expectUnit: unit,
          minAmount: requiredUnits,
          requestId,
          onFinalize: (amount) => db.prepare("UPDATE requests SET status = 'paid', paid_units = ? WHERE id = ?").run(amount, requestId),
        });
        pay = { kind: 'nut24', mint: r.mint, unit, paid: r.amount };
      } catch (e) {
        db.prepare("UPDATE requests SET status = 'failed' WHERE id = ?").run(requestId);
        throw e;
      }
    }
    if (pay.kind === 'balance') {
      db.prepare(
        "INSERT INTO requests (id, account_id, payment, unit, model, supplier, encrypted, status, reserved_msub, created_at) VALUES (?, ?, 'balance', ?, ?, ?, ?, 'running', ?, ?)",
      ).run(requestId, pay.account.id, unit, model.id, model.supplier, encrypted ? 1 : 0, reserveMsub, now());
    } else {
      db.prepare("UPDATE requests SET status = 'running' WHERE id = ?").run(requestId);
    }

    // 5. Settlement, exactly once per request.
    let settled: Promise<SettleResult> | undefined;
    const settle = (usage: Usage | undefined, source: string, status: string): Promise<SettleResult> =>
      (settled ??= (async () => {
        let nano = 0;
        if (alwaysFlat && usage) source = 'flat';
        if (status === 'ok' || status === 'partial') {
          if (alwaysFlat || source === 'flat') nano = flatNano;
          else if (usage) nano = costNanoUsd(model, usage, markup);
        }
        const actualMsub = nanoUsdToMsub(nano, unit, rate);
        // Our cost: the supplier's own figure when it sends one, else the usage at our catalog cost (no markup).
        let costNusd: number | null = null;
        let costSource: string | null = null;
        if (usage && (status === 'ok' || status === 'partial')) {
          if (usage.costUsd !== undefined) {
            costNusd = Math.round(usage.costUsd * 1e9);
            costSource = 'supplier';
          } else if (!alwaysFlat && source !== 'flat') {
            costNusd = Math.round(costNanoUsd(model, usage, 1));
            costSource = 'catalog';
          }
        }
        const res: SettleResult = { chargedMsub: 0 };
        if (pay.kind === 'balance') {
          const s = ledger.settle(pay.reservationId, actualMsub, requestId);
          res.chargedMsub = s.charged;
          res.balanceMsub = s.balance;
          if (actualMsub > reserveMsub) log.warn('usage_over_reservation', { request_id: requestId, actual_msub: actualMsub, reserved_msub: reserveMsub });
        } else {
          const chargedUnits = Math.min(pay.paid, msubToUnitsCeil(actualMsub));
          res.chargedMsub = chargedUnits * MSUB_PER_UNIT;
          res.changeUnits = pay.paid - chargedUnits;
          if (res.changeUnits > 0) {
            const p = pay;
            const changeUnits = res.changeUnits;
            res.changeId = tx(db, () => wallet.oweRaw({ mint: p.mint, unit, amount: changeUnits, purpose: 'change', requestId, lockPubkey }));
          }
        }
        db.prepare(
          'UPDATE requests SET status = ?, input_tokens = ?, output_tokens = ?, usage_source = ?, charged_msub = ?, change_units = ?, latency_ms = ?, price_nusd = ?, supplier_cost_nusd = ?, cost_source = ? WHERE id = ?',
        ).run(
          status === 'ok' || status === 'partial' ? 'settled' : 'failed',
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          source,
          res.chargedMsub,
          res.changeUnits ?? null,
          Date.now() - t0,
          Math.round(nano),
          costNusd,
          costSource,
          requestId,
        );
        if (res.changeId) {
          try {
            res.changeToken = await wallet.issue(res.changeId);
          } catch (e) {
            log.warn('change_deferred', { request_id: requestId, err: errText(e) });
          }
        }
        log.info('request', {
          request_id: requestId,
          model: model.id,
          supplier: model.supplier,
          payment: pay.kind,
          unit,
          status,
          encrypted,
          stream,
          input_tokens: usage?.inputTokens,
          output_tokens: usage?.outputTokens,
          usage_source: source,
          cost_nusd: costNusd,
          cost_source: costSource,
          reserved_msub: reserveMsub,
          charged_msub: res.chargedMsub,
          change_units: res.changeUnits,
          change_locked: res.changeId ? !!lockPubkey : undefined,
          latency_ms: Date.now() - t0,
        });
        return res;
      })());

    const resultHeaders = (r: SettleResult): Record<string, string> => {
      const h: Record<string, string> = { 'X-Forge-Unit': unit, 'X-Forge-Charged-Msub': String(r.chargedMsub) };
      if (r.balanceMsub !== undefined) h['X-Forge-Balance-Msub'] = String(r.balanceMsub);
      if (r.changeToken) h['X-Cashu-Change'] = r.changeToken;
      if (r.changeId) h['X-Forge-Change-Url'] = `/v1/change/${requestId}`;
      return h;
    };

    const upstreamAbort = new AbortController();
    const signal = AbortSignal.any([upstreamAbort.signal, c.req.raw.signal]);
    const estimateInput = () => Math.ceil(raw.length / 4);

    // 6a. Encrypted pass-through.
    if (encrypted) {
      const fwd: Record<string, string> = {
        'content-type': c.req.header('content-type') ?? 'application/json',
        accept: c.req.header('accept') ?? '*/*',
        'ehbp-encapsulated-key': c.req.header('ehbp-encapsulated-key')!,
        'x-tinfoil-model': model.upstream,
        'x-tinfoil-max-output-tokens': String(maxOut),
        'x-tinfoil-completion-count': '1',
      };
      let up;
      try {
        up = await supplier.forwardEncrypted!({ model, path: '/v1/chat/completions', enclaveUrl: c.req.header('x-tinfoil-enclave-url'), headers: fwd, body: raw, signal });
      } catch (e) {
        const r = await settle(undefined, 'none', 'upstream_error');
        const status = e instanceof UpstreamError && e.status < 500 && e.status !== 499 ? e.status : 502;
        return apiError(c, status, 'upstream_error', errText(e), resultHeaders(r));
      }
      const ok = up.status >= 200 && up.status < 300;
      const passHeaders: Record<string, string> = { 'content-type': String(up.headers['content-type'] ?? 'application/octet-stream') };
      const nonce = up.headers['ehbp-response-nonce'];
      if (nonce) passHeaders['Ehbp-Response-Nonce'] = String(nonce);
      const isStream = String(up.headers['content-type'] ?? '').includes('event-stream');
      const frames = new FrameCounter();
      const finish = async (complete: boolean) => {
        const reported = complete ? await up.usage : undefined;
        if (!ok) return settle(undefined, 'none', 'upstream_error');
        if (reported) return settle(reported, 'tinfoil-metrics', complete ? 'ok' : 'partial');
        return settle({ inputTokens: estimateInput(), outputTokens: complete ? maxOut : frames.frames }, flat ? 'flat' : 'estimate', complete ? 'ok' : 'partial');
      };
      if (!isStream) {
        const chunks: Buffer[] = [];
        try {
          for await (const ch of up.body) chunks.push(ch as Buffer);
        } catch (e) {
          // Same as the plaintext non-stream read: no response reached the client, so this settles as an
          // upstream failure (nothing charged, flat schedule included; reservation released; change owed).
          const r = await settle(undefined, 'none', 'upstream_error');
          return apiError(c, 502, 'upstream_error', `enclave response failed: ${errText(e)}. You were not charged.`, resultHeaders(r));
        }
        const r = await finish(true);
        return new Response(Buffer.concat(chunks), { status: up.status, headers: { ...passHeaders, ...resultHeaders(r), 'X-Forge-Request-Id': requestId, 'X-Forge-Privacy': privacy } });
      }
      let cancelled = false;
      const out = new ReadableStream<Uint8Array>({
        start(ctrl) {
          (async () => {
            try {
              for await (const ch of up.body) {
                frames.push(ch as Uint8Array);
                if (!cancelled) ctrl.enqueue(new Uint8Array(ch as Buffer));
              }
              await finish(true);
            } catch {
              await finish(false);
            }
            if (!cancelled) ctrl.close();
          })();
        },
        cancel() {
          cancelled = true;
          up.body.destroy();
          upstreamAbort.abort();
        },
      });
      return new Response(out, {
        status: up.status,
        headers: { ...passHeaders, 'X-Forge-Request-Id': requestId, 'X-Forge-Unit': unit, 'X-Forge-Privacy': privacy, ...(pay.kind === 'nut24' ? { 'X-Forge-Change-Url': `/v1/change/${requestId}` } : {}) },
      });
    }

    // 6b. Plaintext OpenAI-compatible call.
    let res: Response;
    try {
      res = await supplier.chat({ model, body: upstreamBody!, stream, signal });
    } catch (e) {
      const r = await settle(undefined, 'none', 'upstream_error');
      const status = e instanceof UpstreamError && e.status < 500 && e.status !== 499 ? e.status : 502;
      return apiError(c, status, 'upstream_error', errText(e), resultHeaders(r));
    }
    if (!res.ok) {
      let msg = `upstream returned HTTP ${res.status}`;
      try {
        const j: any = JSON.parse((await res.text()).slice(0, 4000));
        if (typeof j?.error?.message === 'string') msg += `: ${j.error.message.slice(0, 300)}`;
      } catch {
        /* not JSON */
      }
      const r = await settle(undefined, 'none', 'upstream_error');
      const status = res.status >= 400 && res.status < 500 && res.status !== 429 ? res.status : 502;
      return apiError(c, status, 'upstream_error', msg + '. You were not charged.', resultHeaders(r));
    }

    if (!stream) {
      // The body read belongs to settlement: a failure here settles as an upstream failure (nothing charged,
      // reservation released, change owed) before the error reaches the client, never left running.
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        const r = await settle(undefined, 'none', 'upstream_error');
        return apiError(c, 502, 'upstream_error', `upstream response failed: ${errText(e)}. You were not charged.`, resultHeaders(r));
      }
      let usage: Usage | undefined;
      let source = 'upstream';
      try {
        usage = usageFromJson(JSON.parse(text));
      } catch {
        /* ignore */
      }
      const headerCost = costFromHeaders(res.headers) ?? parseUsageMetrics(res.headers.get(TINFOIL_USAGE_HEADER) ?? undefined)?.costUsd;
      if (usage && usage.costUsd === undefined && headerCost !== undefined) usage.costUsd = headerCost;
      if (!usage) {
        source = flat ? 'flat' : 'estimate';
        usage = { inputTokens: estimateInput(), outputTokens: maxOut };
      }
      const r = await settle(usage, source, 'ok');
      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'application/json', 'X-Forge-Request-Id': requestId, 'X-Forge-Privacy': privacy, ...resultHeaders(r) },
      });
    }

    const meter = new SseMeter({ dropUsageChunk: !clientWantsUsage });
    const enc = new TextEncoder();
    let cancelled = false;
    const reader = res.body!.getReader();
    const usageNow = (): Usage => meter.usage ?? { inputTokens: estimateInput(), outputTokens: meter.estimatedOutputTokens() };
    const forgeEvent = (r: SettleResult, extra: object = {}) =>
      `event: forge\ndata: ${JSON.stringify({
        request_id: requestId,
        unit,
        charged_msub: r.chargedMsub,
        balance_msub: r.balanceMsub,
        change: r.changeToken,
        change_units: r.changeUnits,
        change_url: r.changeId ? `/v1/change/${requestId}` : undefined,
        ...extra,
      })}\n\n`;
    const out = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (s: string) => {
          if (!cancelled && s) {
            try {
              ctrl.enqueue(enc.encode(s));
            } catch {
              cancelled = true;
            }
          }
        };
        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              send(meter.push(value));
            }
            send(meter.flush());
            const r = await settle(usageNow(), meter.usage ? 'upstream' : flat ? 'flat' : 'estimate', 'ok');
            send(forgeEvent(r));
          } catch (e) {
            const r = await settle(usageNow(), meter.usage ? 'upstream' : 'estimate', 'partial');
            send(`data: ${JSON.stringify({ error: { message: cancelled ? 'client disconnected' : `upstream stream failed: ${errText(e)}`, type: 'upstream_error' } })}\n\n`);
            send(forgeEvent(r, { partial: true }));
          }
          if (!cancelled) {
            try {
              ctrl.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },
      cancel() {
        cancelled = true;
        upstreamAbort.abort();
        reader.cancel().catch(() => {});
      },
    });
    return new Response(out, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'X-Forge-Request-Id': requestId,
        'X-Forge-Unit': unit,
        'X-Forge-Privacy': privacy,
        ...(pay.kind === 'nut24' ? { 'X-Forge-Change-Url': `/v1/change/${requestId}` } : {}),
      },
    });
  };

  // ------------------------------------------------------------------ beta waitlist
  // One contact and an optional note. The client IP is used only by the in-memory rate limiter.
  const waitlist = new BetaWaitlist(d.db);
  const signupLimiter = new RateLimiter(3, 3);
  app.get('/beta', (c) => c.redirect('/beta/', 301));
  app.post('/v1/beta/signup', async (c) => {
    const wait = signupLimiter.take('ip:' + clientIp(c));
    if (wait > 0) return apiError(c, 429, 'rate_limited', 'too many signups from here; try again later', { 'Retry-After': String(wait) });
    const body = (await readJson(c).catch(() => ({}))) as { contact?: unknown; note?: unknown; website?: unknown };
    // Honeypot field the page hides from people: bots that fill it get the same answer and nothing is stored.
    if (body?.website) return c.json({ ok: true });
    const parsed = parseContact(body?.contact);
    if (!parsed) return apiError(c, 400, 'invalid_contact', 'enter an email address or a Nostr npub');
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    const { created } = waitlist.add(parsed.contact, parsed.kind, note);
    if (created) log.info('beta_signup', { kind: parsed.kind });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ operator admin (404 unless FORGE_ADMIN_TOKEN_HASH is set)
  app.route('/', createAdminRouter(d));

  // ------------------------------------------------------------------ static chat page
  if (d.publicDir) {
    // Revalidate the page and its modules on every load (a cheap 304 when unchanged), so a phone never
    // pairs a new index.html with a cached, older app.js.
    app.use('/*', async (c, next) => {
      await next();
      if (c.res.ok && !c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-cache');
    });
    // The service worker, with its version (a hash of the app shell) filled in; see src/sw.ts.
    const sw = serviceWorkerScript(d.publicDir);
    app.get('/sw.js', (c) => {
      const { body, version } = sw();
      return c.body(body, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Forge-SW-Version': version });
    });
    app.use('/*', serveStatic({ root: d.publicDir }));
  }

  return app;
}

/** What to do when recovery finalizes a receive whose HTTP request is gone. Runs inside the finalize transaction. */
function installRecoveryHooks(d: Deps) {
  d.wallet.onRecoveredIncoming = (row) => {
    if (row.purpose === 'topup' && row.account_id) {
      d.ledger.creditRaw(row.account_id, row.amount * MSUB_PER_UNIT, 'topup', 'recovered');
    } else if (row.purpose === 'nut24' && row.request_id) {
      // The attempt that paid is gone, so nothing will run or settle it: owe the whole payment back as change
      // under its id now, as the startup sweep would. That sweep picks only paid or running requests, and the
      // hook fires once per receive, so nothing is owed twice.
      const req = d.db.prepare('SELECT status, lock_pubkey FROM requests WHERE id = ?').get(row.request_id) as { status: string; lock_pubkey: string | null } | undefined;
      if (req?.status === 'settled' || req?.status === 'aborted') return;
      if (row.amount > 0) d.wallet.oweRaw({ mint: row.mint, unit: row.unit, amount: row.amount, purpose: 'change', requestId: row.request_id, lockPubkey: req?.lock_pubkey ?? null });
      d.db.prepare("UPDATE requests SET status = 'aborted', paid_units = ?, change_units = ? WHERE id = ?").run(row.amount, row.amount, row.request_id);
    }
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Startup tasks: recover mint operations, release stale reservations, owe change to interrupted NUT-24 requests. */
export async function startupRecovery(d: Deps, olderThanMs = 0): Promise<void> {
  // At process start nothing is in flight, so every active reservation and running request is orphaned.
  installRecoveryHooks(d);
  const w = await d.wallet.recover();
  const released = d.ledger.releaseStale(olderThanMs);
  const stuck = d.db
    .prepare("SELECT id, unit, paid_units, lock_pubkey FROM requests WHERE payment = 'nut24' AND status IN ('paid', 'running') AND created_at <= ?")
    .all(Date.now() - olderThanMs) as Array<{ id: string; unit: Unit; paid_units: number; lock_pubkey: string | null }>;
  for (const r of stuck) {
    const inc = d.db.prepare("SELECT mint FROM incoming WHERE request_id = ? AND status = 'done'").get(r.id) as { mint: string } | undefined;
    tx(d.db, () => {
      if (inc && r.paid_units > 0) d.wallet.oweRaw({ mint: inc.mint, unit: r.unit, amount: r.paid_units, purpose: 'change', requestId: r.id, lockPubkey: r.lock_pubkey });
      d.db.prepare("UPDATE requests SET status = 'aborted', change_units = ? WHERE id = ?").run(r.paid_units, r.id);
    });
  }
  log.info('startup_recovery', { incoming: w.incoming, outgoing: w.outgoing, errors: w.errors, released_reservations: released, aborted_nut24: stuck.length });
}
