/**
 * Operator admin API (/admin/api/*) and the gate in front of the admin page (/admin/).
 *
 * Access control, in order:
 *  - FORGE_ADMIN_TOKEN_HASH unset: everything under /admin answers 404.
 *  - Its own rate limit per client IP, separate from the public API.
 *  - Token: X-Forge-Admin-Token: <token> (or Authorization: Bearer <token> when no proxy auth sits in
 *    front); sha256(token) must equal FORGE_ADMIN_TOKEN_HASH. Wrong or missing: 401. The token is
 *    never logged.
 *  - Every non-GET request: same-origin Origin header (CSRF) and a JSON body.
 *  - No CORS: these routes never send Access-Control-* headers, so browsers block other origins.
 * In production Caddy adds HTTP basic auth on /admin* in front of all of this (docs/ADMIN.md).
 *
 * Every action is logged as admin_action with counts and amounts only: no tokens, codes or contacts.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { OPEN_FUNDING_STATES } from './accounts.ts';
import type { Deps } from './app.ts';
import { BetaWaitlist, mailtoLink } from './beta.ts';
import { parseOptionalLockPubkey } from './cashu/lock.ts';
import { PaymentError } from './cashu/wallet.ts';
import type { Config, Unit } from './config.ts';
import type { DB } from './db.ts';
import { LedgerError } from './ledger.ts';
import { errText, log } from './log.ts';
import { displayPrice, MSUB_PER_UNIT } from './pricing.ts';
import { RateLimiter } from './ratelimit.ts';
import { ExportError, exportHistory, holdings, issueExport, oweExport, planExport, revenue } from './revenue.ts';

export const BETA_LINK = 'https://ai.forge-reserve.com';
const DAY = 86_400_000;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function json(c: Context, status: number, body: unknown) {
  return c.json(body as any, status as any);
}

function fail(c: Context, status: number, code: string, message: string, extra: object = {}) {
  return json(c, status, { error: { code, message }, ...extra });
}

/** The message an operator sends to a waitlist signup with their invite code. */
export function inviteMessage(code: string): string {
  return [
    'Hi, your Forge AI beta invite is ready.',
    '',
    `Invite code: ${code}`,
    '',
    `Open ${BETA_LINK}, add funds with eCash, Lightning or bitcoin, and enter the code when it asks for an invite. The code works once.`,
    '',
    'Forge AI',
  ].join('\n');
}

/** Where supplier API keys are read from: the env given to buildDeps (tests), else the process env. */
const keyEnvs = new WeakMap<object, NodeJS.ProcessEnv>();
export function setSupplierKeyEnv(d: object, env: NodeJS.ProcessEnv) {
  keyEnvs.set(d, env);
}
const supplierKeyEnv = (d: object): NodeJS.ProcessEnv => keyEnvs.get(d) ?? process.env;

export function createAdminRouter(d: Deps): Hono {
  const { config, db, ledger, invites, wallet, rates, funding, discovery } = d;
  const env = config.env;
  const tokenHash = env.FORGE_ADMIN_TOKEN_HASH?.toLowerCase();
  const limiter = new RateLimiter(env.FORGE_ADMIN_RATE_LIMIT_RPM, Math.max(20, Math.ceil(env.FORGE_ADMIN_RATE_LIMIT_RPM / 3)));
  const authFailures = new RateLimiter(10, 10);
  const waitlist = new BetaWaitlist(db);
  const markup = env.FORGE_MARKUP;
  const r = new Hono();

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

  const tokenOk = (c: Context): boolean => {
    if (!tokenHash) return false;
    let t = c.req.header('x-forge-admin-token')?.trim();
    if (!t) {
      const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
      t = m?.[1]?.trim();
    }
    if (!t) return false;
    const a = Buffer.from(sha256hex(t), 'hex');
    const b = Buffer.from(tokenHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header('origin');
    if (!origin || origin === 'null') return false;
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin') return false;
    const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
    if (env.FORGE_ADMIN_ORIGIN) return norm(origin) === norm(env.FORGE_ADMIN_ORIGIN);
    try {
      return new URL(origin).host.toLowerCase() === (c.req.header('host') ?? '').toLowerCase();
    } catch {
      return false;
    }
  };

  const audit = (action: string, fields: Record<string, string | number | boolean | null | undefined> = {}) => log.info('admin_action', { action, ...fields });

  r.onError((e, c) => {
    if (e instanceof PaymentError) return fail(c, e.status, e.code, e.message, e.extra ?? {});
    if (e instanceof ExportError || e instanceof LedgerError) return fail(c, e.status, e.code, e.message);
    log.error('admin_error', { path: c.req.path, err: errText(e) });
    return fail(c, 500, 'internal_error', 'internal error');
  });

  // Gate for the page and the API alike.
  const gate = async (c: Context, next: () => Promise<void>) => {
    if (!tokenHash) return c.text('Not Found', 404);
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    if (!c.req.path.startsWith('/admin/api/') && c.req.path !== '/admin/api') {
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      if (c.req.path === '/admin') return c.redirect('/admin/', 301);
      return next();
    }
    const ip = clientIp(c);
    const wait = limiter.take('ip:' + ip);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return fail(c, 429, 'rate_limited', 'too many admin requests');
    }
    if (!tokenOk(c)) {
      const w = authFailures.take('ip:' + ip);
      log.warn('admin_auth_failed', { path: c.req.path });
      if (w > 0) {
        c.header('Retry-After', String(w));
        return fail(c, 429, 'rate_limited', 'too many failed admin logins');
      }
      return fail(c, 401, 'unauthorized', 'admin token required');
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!sameOrigin(c)) {
        log.warn('admin_origin_rejected', { path: c.req.path });
        return fail(c, 403, 'bad_origin', 'admin changes must come from the admin page');
      }
      if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) return fail(c, 415, 'json_required', 'send Content-Type: application/json');
    }
    return next();
  };
  r.use('/admin', gate);
  r.use('/admin/*', gate);
  r.use('/admin/api/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => fail(c, 413, 'request_too_large', 'request too large') }));

  const body = async (c: Context): Promise<any> => {
    try {
      const b = await c.req.json();
      return b && typeof b === 'object' ? b : {};
    } catch {
      throw new ExportError('invalid_request', 'expected a JSON object');
    }
  };
  const unitOf = (v: unknown): Unit => {
    const u = String(v ?? '') as Unit;
    if (!env.FORGE_UNITS.includes(u)) throw new ExportError('wrong_unit', `unit must be one of ${env.FORGE_UNITS.join(', ')}`);
    return u;
  };
  const tierOf = (supplier: string) => config.catalog.suppliers[supplier]?.tier ?? 'unknown';

  // ---------------------------------------------------------------- mint health (GET /v1/info only)
  const mintHealth = new Map<string, { at: number; value: { mint: string; ok: boolean; name?: string; version?: string; latency_ms?: number; error?: string } }>();
  const checkMint = async (mint: string) => {
    const hit = mintHealth.get(mint);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const t0 = Date.now();
    let value;
    try {
      const res = await fetch(`${mint}/v1/info`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info: any = await res.json();
      value = { mint, ok: true, name: typeof info?.name === 'string' ? info.name : undefined, version: typeof info?.version === 'string' ? info.version : undefined, latency_ms: Date.now() - t0 };
    } catch (e) {
      value = { mint, ok: false, error: errText(e) };
    }
    mintHealth.set(mint, { at: Date.now(), value });
    return value;
  };

  // ---------------------------------------------------------------- Tinfoil credit (read-only admin API)
  // Tinfoil has no balance endpoint: remaining = opening credit + credits added - all-time spend.
  let tinfoilCache: { at: number; value: unknown } | undefined;
  const tinfoilBilling = async () => {
    const key = env.TINFOIL_ADMIN_KEY;
    if (!key) return null;
    if (tinfoilCache && Date.now() - tinfoilCache.at < 60_000) return tinfoilCache.value;
    const get = async (path: string) => {
      const res = await fetch(`${env.FORGE_TINFOIL_ADMIN_URL}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Tinfoil admin API ${path.split('?')[0]}: HTTP ${res.status}`);
      return (await res.json()) as any;
    };
    let value;
    try {
      const [all, d30, tx] = await Promise.all([get('/api/billing/usage'), get('/api/billing/usage?time=30d'), get('/api/billing/transactions')]);
      const transactions: any[] = Array.isArray(tx?.transactions) ? tx.transactions : [];
      // The transaction format is not documented and the list is empty so far: count positive amounts as credit added.
      const added = transactions.reduce((s, x) => {
        const v = Number(x?.amount_usd ?? x?.amount ?? 0);
        return Number.isFinite(v) && v > 0 ? s + v : s;
      }, 0);
      const spent = Number(all?.cost ?? 0);
      const opening = env.FORGE_TINFOIL_OPENING_CREDIT_USD;
      const remaining = opening + added - spent;
      value = {
        ok: true,
        opening_usd: opening,
        added_usd: added,
        transactions: transactions.length,
        spent_usd: spent,
        spent_30d_usd: Number(d30?.cost ?? 0),
        requests: Number(all?.requests ?? 0),
        requests_30d: Number(d30?.requests ?? 0),
        tokens: Number(all?.tokens ?? 0),
        remaining_usd: remaining,
        low: remaining < env.FORGE_TINFOIL_LOW_USD,
        low_threshold_usd: env.FORGE_TINFOIL_LOW_USD,
      };
    } catch (e) {
      value = { ok: false, error: errText(e) };
    }
    tinfoilCache = { at: Date.now(), value };
    return value;
  };

  // ---------------------------------------------------------------- Token Factory key (LiteLLM /key/info)
  // The inference key can read its own record: spend as Token Factory costs it, budget, limits, expiry.
  let tfCache: { at: number; value: unknown } | undefined;
  const tokenFactoryKey = async () => {
    const s = config.catalog.suppliers.tokenfactory as { baseUrl?: string; apiKeyEnv?: string } | undefined;
    const key = s?.apiKeyEnv ? supplierKeyEnv(d)[s.apiKeyEnv] : undefined;
    if (!s?.baseUrl || typeof key !== 'string' || !key) return null;
    if (tfCache && Date.now() - tfCache.at < 60_000) return tfCache.value;
    let value;
    try {
      const base = s.baseUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(`${base}/key/info`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Token Factory /key/info: HTTP ${res.status}`);
      const info = ((await res.json()) as any)?.info ?? {};
      const spent = Number(info.spend ?? 0);
      const budget = info.max_budget == null ? null : Number(info.max_budget);
      value = {
        ok: true,
        alias: typeof info.key_alias === 'string' ? info.key_alias : null,
        spent_usd: spent,
        max_budget_usd: budget,
        remaining_usd: budget == null ? null : budget - spent,
        budget_duration: info.budget_duration ?? null,
        budget_reset_at: info.budget_reset_at ?? null,
        rpm_limit: info.rpm_limit ?? null,
        tpm_limit: info.tpm_limit ?? null,
        expires: info.expires ?? null,
        blocked: !!info.blocked,
      };
    } catch (e) {
      value = { ok: false, error: errText(e) };
    }
    tfCache = { at: Date.now(), value };
    return value;
  };

  // ---------------------------------------------------------------- stats
  type Money = Partial<Record<Unit, number>>;
  const add = (m: Money, unit: Unit, v: number) => (m[unit] = (m[unit] ?? 0) + v);
  const usdEquiv = (m: Money, rate: number | undefined): number | null => {
    let usd = (m.usd ?? 0) / MSUB_PER_UNIT / 100;
    if (m.sat) {
      if (!rate) return null;
      usd += (m.sat / MSUB_PER_UNIT / 1e8) * rate;
    }
    return Math.round(usd * 1e6) / 1e6;
  };

  const windowStats = (since: number, rate: number | undefined) => {
    const rows = db
      .prepare(
        `SELECT unit, model, supplier, COUNT(*) AS n,
          SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) AS ok,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(encrypted) AS enc,
          COALESCE(SUM(input_tokens), 0) AS tin, COALESCE(SUM(output_tokens), 0) AS tout,
          COALESCE(SUM(charged_msub), 0) AS rev
         FROM requests WHERE created_at >= ? GROUP BY unit, model, supplier`,
      )
      .all(since) as Array<{ unit: Unit; model: string; supplier: string; n: number; ok: number; failed: number; enc: number; tin: number; tout: number; rev: number }>;
    type Agg = { requests: number; ok: number; failed: number; encrypted: number; input_tokens: number; output_tokens: number; revenue_msub: Money };
    const blank = (): Agg => ({ requests: 0, ok: 0, failed: 0, encrypted: 0, input_tokens: 0, output_tokens: 0, revenue_msub: {} });
    const total = blank();
    const by = { model: new Map<string, Agg>(), tier: new Map<string, Agg>(), supplier: new Map<string, Agg>() };
    for (const row of rows) {
      const keys = { model: row.model, tier: tierOf(row.supplier), supplier: row.supplier };
      for (const agg of [total, ...(['model', 'tier', 'supplier'] as const).map((k) => by[k].get(keys[k]) ?? by[k].set(keys[k], blank()).get(keys[k])!)]) {
        agg.requests += row.n;
        agg.ok += row.ok;
        agg.failed += row.failed;
        agg.encrypted += row.enc;
        agg.input_tokens += row.tin;
        agg.output_tokens += row.tout;
        add(agg.revenue_msub, row.unit, row.rev);
      }
    }
    const withMoney = (key: string, a: Agg) => {
      // Catalog prices include FORGE_MARKUP, so supplier cost is estimated as revenue / markup.
      const cost: Money = {};
      const margin: Money = {};
      for (const [u, v] of Object.entries(a.revenue_msub) as Array<[Unit, number]>) {
        cost[u] = Math.round(v / markup);
        margin[u] = v - cost[u]!;
      }
      return { key, ...a, revenue_usd_equiv: usdEquiv(a.revenue_msub, rate), cost_msub: cost, margin_msub: margin, cost_usd_equiv: usdEquiv(cost, rate), margin_usd_equiv: usdEquiv(margin, rate) };
    };
    const list = (m: Map<string, Agg>) => [...m.entries()].map(([k, a]) => withMoney(k, a)).sort((x, y) => y.requests - x.requests);
    return { since, total: withMoney('total', total), by_model: list(by.model), by_tier: list(by.tier), by_supplier: list(by.supplier) };
  };

  const supplierStatus = () =>
    Object.entries(config.catalog.suppliers).map(([id, s]) => {
      const models = config.catalog.models.filter((m) => m.supplier === id).length;
      // loadConfig drops the models of a supplier whose key env var is unset.
      return { id, type: s.type, tier: s.tier, pricing: s.pricing, key_env: s.apiKeyEnv ?? null, key_present: s.apiKeyEnv ? models > 0 : null, models };
    });

  // ---------------------------------------------------------------- routes

  r.get('/admin/api/session', (c) => json(c, 200, { ok: true }));

  r.get('/admin/api/overview', async (c) => {
    const rate = rates.current() ?? (env.FORGE_UNITS.includes('sat') ? await rates.get().catch(() => undefined) : undefined);
    const rs = rates.status();
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const t = Date.now();
    const collected = db
      .prepare("SELECT unit, COALESCE(SUM(charged_msub), 0) AS s, COUNT(*) AS n FROM requests WHERE status = 'settled' GROUP BY unit")
      .all() as Array<{ unit: Unit; s: number; n: number }>;
    const exported = db
      .prepare("SELECT e.unit, COALESCE(SUM(e.amount), 0) AS s, COUNT(*) AS n FROM revenue_exports e JOIN outgoing o ON o.id = e.outgoing_id WHERE o.status = 'done' GROUP BY e.unit")
      .all() as Array<{ unit: Unit; s: number; n: number }>;
    const units = env.FORGE_UNITS.map((u) => {
      const rv = revenue(d, u);
      const owedBy = db
        .prepare("SELECT purpose, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM outgoing WHERE unit = ? AND status IN ('owed', 'reserved', 'prepared') GROUP BY purpose")
        .all(u) as Array<{ purpose: string; n: number; s: number }>;
      return {
        unit: u,
        collected_msub: collected.find((x) => x.unit === u)?.s ?? 0,
        exported: exported.find((x) => x.unit === u)?.s ?? 0,
        wallet_trusted: rv.unspent,
        wallet_other_mints: rv.other_unspent,
        owed_payouts: rv.owed,
        owed_by_purpose: owedBy,
        customer_balances_msub: rv.liabilities_msub,
        customer_balances: rv.liabilities,
        reserved_msub: rv.reserved_msub,
        sweepable: rv.sweepable,
        accounts: (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE unit = ?').get(u) as { n: number }).n,
      };
    });
    const marks = OPEN_FUNDING_STATES.map(() => '?').join(',');
    const openFundings = db.prepare(`SELECT state, COUNT(*) AS n FROM fundings WHERE state IN (${marks}) GROUP BY state`).all(...OPEN_FUNDING_STATES) as Array<{ state: string; n: number }>;
    const due = (db.prepare(`SELECT COUNT(*) AS n FROM fundings WHERE state IN (${marks}) AND next_check <= ?`).get(...OPEN_FUNDING_STATES, t) as { n: number }).n;
    const mints = [...new Set([...wallet.trustedMints, funding.mint])];
    return json(c, 200, {
      at: t,
      markup,
      rate: rs ? { btc_usd: rs.rate, age_s: Math.round(rs.ageMs / 1000), sources: rs.sources, usable: rates.current() !== undefined } : null,
      units,
      holdings: holdings(d),
      tinfoil: await tinfoilBilling(),
      tokenfactory: await tokenFactoryKey(),
      windows: {
        today: windowStats(midnight.getTime(), rate),
        d7: windowStats(t - 7 * DAY, rate),
        d30: windowStats(t - 30 * DAY, rate),
      },
      health: {
        suppliers: supplierStatus(),
        mints: await Promise.all(mints.map(checkMint)),
        fund_mint: funding.mint,
        fundings_open: openFundings,
        fundings_due: due,
        quote_checks: funding.quoteCheckStatus(),
        exports_unfinished: (db.prepare("SELECT COUNT(*) AS n FROM revenue_exports e JOIN outgoing o ON o.id = e.outgoing_id WHERE o.status <> 'done'").get() as { n: number }).n,
      },
    });
  });

  // -------------------------------------------------------------- revenue export
  const planFrom = (b: any) => {
    const unit = unitOf(b.unit);
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? undefined : Number(b.amount);
    const mint = typeof b.mint === 'string' && b.mint ? b.mint : undefined;
    const lockPubkey = parseOptionalLockPubkey(b.pubkey);
    const plan = planExport(d, unit, { mint, amount });
    return { plan, lockPubkey };
  };

  r.post('/admin/api/export/preview', async (c) => {
    const { plan, lockPubkey } = planFrom(await body(c));
    return json(c, 200, { unit: plan.unit, mint: plan.mint, amount: plan.amount, max: plan.max, sweepable: plan.revenue.sweepable, locked_to: lockPubkey });
  });

  r.post('/admin/api/export', async (c) => {
    const b = await body(c);
    const { plan, lockPubkey } = planFrom(b);
    // The confirm step: the page sends back the exact amount, mint and key it showed.
    if (Number(b.confirm_amount) !== plan.amount || b.confirm_mint !== plan.mint || (b.confirm_pubkey ?? null) !== lockPubkey) {
      return fail(c, 409, 'confirm_mismatch', 'confirm the exact amount, mint and lock key shown in the preview');
    }
    const { id } = oweExport(d, { unit: plan.unit, mint: plan.mint, amount: plan.amount, lockPubkey, source: 'admin' });
    audit('revenue_export', { unit: plan.unit, amount: plan.amount, locked: !!lockPubkey, export_id: id });
    try {
      const token = await issueExport(d, id);
      return json(c, 200, { id, status: 'done', unit: plan.unit, mint: plan.mint, amount: plan.amount, locked_to: lockPubkey, token });
    } catch (e) {
      // The payout is owed and recorded; recovery or "Finish" completes it, never twice.
      log.warn('admin_export_deferred', { export_id: id, err: errText(e) });
      return json(c, 202, { id, status: 'owed', unit: plan.unit, mint: plan.mint, amount: plan.amount, locked_to: lockPubkey, token: null, error: errText(e) });
    }
  });

  r.get('/admin/api/exports', (c) => json(c, 200, { data: exportHistory(d) }));

  r.post('/admin/api/exports/:id/finish', async (c) => {
    const id = c.req.param('id');
    const row = exportHistory(d, 1000).find((x) => x.id === id);
    if (!row) return fail(c, 404, 'not_found', 'unknown export');
    // A token is handed out once. One that recovery finished after a crash was never delivered, so it may be.
    if (row.delivered_at) return fail(c, 409, 'already_delivered', 'this export was already delivered; its token is shown only once');
    const token = await issueExport(d, id);
    audit('revenue_export_finish', { export_id: id, unit: row.unit, amount: row.amount });
    return json(c, 200, { id, status: 'done', unit: row.unit, mint: row.mint, amount: row.amount, locked_to: row.lock_pubkey, token });
  });

  // -------------------------------------------------------------- invites
  r.get('/admin/api/invites', (c) => {
    const rows = db
      .prepare(
        `SELECT i.id, i.label, i.status, i.account_id, i.nut24_uses, i.created_at, i.redeemed_at,
           (SELECT COUNT(*) FROM requests q WHERE q.account_id = i.account_id) AS requests
         FROM invites i ORDER BY i.created_at DESC LIMIT 1000`,
      )
      .all();
    return json(c, 200, { data: rows });
  });

  r.post('/admin/api/invites', async (c) => {
    const b = await body(c);
    const count = b.count === undefined ? 1 : Number(b.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) return fail(c, 400, 'invalid_count', 'count must be 1..100');
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 80) : undefined;
    const out = Array.from({ length: count }, () => invites.create(label));
    audit('invites_create', { count });
    return json(c, 200, { data: out });
  });

  r.post('/admin/api/invites/:id/revoke', (c) => {
    const id = c.req.param('id');
    const inv = db.prepare('SELECT status FROM invites WHERE id = ?').get(id) as { status: string } | undefined;
    if (!inv) return fail(c, 404, 'not_found', 'unknown invite');
    invites.revoke(id);
    audit('invite_revoke', { invite_id: id, was: inv.status });
    return json(c, 200, { ok: true, id, status: 'revoked' });
  });

  // -------------------------------------------------------------- beta waitlist
  r.get('/admin/api/waitlist', (c) => json(c, 200, { data: [...waitlist.list()].reverse() }));

  r.post('/admin/api/waitlist/:id/invite', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    const s = waitlist.get(id);
    if (!s) return fail(c, 404, 'not_found', 'unknown signup');
    if (s.invited_at && b.again !== true) return fail(c, 409, 'already_invited', 'this signup was already invited; send again to make a new code');
    const inv = invites.create(`beta:${s.id}`);
    db.prepare('UPDATE beta_signups SET invited_at = ? WHERE id = ?').run(Date.now(), id);
    const message = inviteMessage(inv.code);
    audit('waitlist_invite', { signup_id: id, kind: s.kind, again: !!s.invited_at });
    return json(c, 200, {
      signup_id: id,
      invite_id: inv.id,
      code: inv.code,
      kind: s.kind,
      contact: s.contact,
      link: BETA_LINK,
      message,
      mailto: s.kind === 'email' ? mailtoLink(s.contact, 'Your Forge AI beta invite', message) : null,
    });
  });

  r.delete('/admin/api/waitlist/:id', (c) => {
    const ok = waitlist.delete(c.req.param('id'));
    if (!ok) return fail(c, 404, 'not_found', 'unknown signup');
    audit('waitlist_delete', { signup_id: c.req.param('id') });
    return json(c, 200, { ok: true });
  });

  // -------------------------------------------------------------- balances
  r.get('/admin/api/accounts', (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit')) || 200));
    const rows = db
      .prepare(
        `SELECT a.id, a.unit, a.balance_msub, a.created_at, a.frozen_at, a.invite_id,
           (SELECT COALESCE(SUM(r.amount_msub), 0) FROM reservations r WHERE r.account_id = a.id AND r.status = 'active') AS reserved_msub,
           (SELECT MAX(l.created_at) FROM ledger l WHERE l.account_id = a.id) AS last_used,
           (SELECT COUNT(*) FROM fundings f WHERE f.account_id = a.id) AS fundings,
           (SELECT COUNT(*) FROM requests q WHERE q.account_id = a.id) AS requests
         FROM accounts a
         WHERE (? = '' OR a.id LIKE ? ESCAPE '\\' OR COALESCE(a.invite_id, '') LIKE ? ESCAPE '\\')
         ORDER BY COALESCE(last_used, a.created_at) DESC LIMIT ?`,
      )
      .all(q, like, like, limit);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
    return json(c, 200, { data: rows, total });
  });

  r.post('/admin/api/accounts/:id/freeze', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    if (typeof b.frozen !== 'boolean') return fail(c, 400, 'invalid_request', 'send {"frozen": true|false}');
    if (!ledger.setFrozen(id, b.frozen)) return fail(c, 404, 'not_found', 'unknown account');
    audit(b.frozen ? 'account_freeze' : 'account_unfreeze', { account_id: id });
    return json(c, 200, { id, frozen: b.frozen });
  });

  // -------------------------------------------------------------- fundings
  const fundingRow = (f: any) => ({
    id: f.id,
    method: f.method,
    account_id: f.account_id,
    unit: f.unit,
    amount: f.amount,
    credited: f.credited,
    state: f.state,
    error: f.error,
    created_at: f.created_at,
    updated_at: f.updated_at,
    expires_at: f.expires_at,
    next_check: f.next_check,
    foreign_mint: f.f_mint,
    foreign_amount: f.f_amount,
    unlisted: !!f.f_unlisted,
    open: (OPEN_FUNDING_STATES as readonly string[]).includes(f.state),
    ...fundingStatus(f),
  });

  /** A plain reading of a funding for the admin page, and whether it needs the operator. */
  const fundingStatus = (f: any): { status: string; detail: string; attention: boolean; paid: number | null } => {
    let obs: any = {};
    try {
      obs = f.observed ? JSON.parse(f.observed) : {};
    } catch {
      /* ignore */
    }
    const paid = f.method === 'onchain' && Number.isFinite(Number(obs.amount_paid)) ? Number(obs.amount_paid) : null;
    const stuck = ['receiving', 'melting', 'minting'].includes(f.state) && Date.now() - f.updated_at > 10 * 60_000;
    const attention = f.state === 'failed' || stuck || (!!f.error && (OPEN_FUNDING_STATES as readonly string[]).includes(f.state));
    if (f.state === 'pending' && f.method === 'onchain')
      return f.credited > 0
        ? { status: 'credited', detail: 'Credited; the address stays watched for more deposits', attention, paid }
        : { status: 'awaiting deposit', detail: 'No deposit seen yet', attention, paid };
    if (f.state === 'pending') return { status: 'awaiting payment', detail: obs.state ? `Mint says ${obs.state}` : 'Invoice not paid yet', attention, paid };
    if (f.state === 'expired') return { status: 'expired', detail: 'Never paid; nothing to do', attention, paid };
    if (f.state === 'refunded') return { status: 'refunded', detail: 'Returned to the customer as eCash', attention, paid };
    return { status: f.state, detail: '', attention, paid };
  };

  r.get('/admin/api/fundings', (c) => {
    const which = c.req.query('state') ?? 'attention';
    const states = which === 'all' ? null : which === 'attention' ? [...OPEN_FUNDING_STATES, 'failed'] : which === 'open' ? [...OPEN_FUNDING_STATES] : which.split(',');
    const rows = states
      ? db.prepare(`SELECT * FROM fundings WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 500`).all(...states)
      : db.prepare('SELECT * FROM fundings ORDER BY created_at DESC LIMIT 500').all();
    let data = rows.map(fundingRow);
    if (which === 'attention') data = data.filter((f) => f.attention);
    return json(c, 200, { data, quote_checks: funding.quoteCheckStatus() });
  });

  r.post('/admin/api/fundings/:id/recheck', async (c) => {
    const id = c.req.param('id');
    const f = funding.get(id);
    if (!f) return fail(c, 404, 'not_found', 'unknown funding');
    if (!(OPEN_FUNDING_STATES as readonly string[]).includes(f.state)) return fail(c, 409, 'not_open', `funding is ${f.state}; only unfinished fundings can be re-checked`);
    const q = funding.quoteCheckStatus();
    if (f.state === 'pending' && !q.available) {
      const retry = q.cooldown_until ? Math.ceil((q.cooldown_until - Date.now()) / 1000) : 60;
      c.header('Retry-After', String(Math.max(1, retry)));
      return fail(c, 429, 'quote_budget', q.cooldown_until ? 'the mint asked us to slow down; quote checks are paused' : 'the shared quote-check budget for this minute is used up', {
        quote_checks: q,
      });
    }
    const after = await funding.advance(id);
    audit('funding_recheck', { funding_id: id, before: f.state, after: after?.state });
    return json(c, 200, { data: after ? fundingRow(after) : null, quote_checks: funding.quoteCheckStatus() });
  });

  // -------------------------------------------------------------- supplier costs and margin
  r.get('/admin/api/costs', (c) => json(c, 200, supplierCosts(db, config, Math.min(365, Math.max(1, Number(c.req.query('days')) || 30)))));

  // -------------------------------------------------------------- requests log (no content is ever stored)
  r.get('/admin/api/requests', (c) => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit')) || 100));
    const rows = db
      .prepare(
        `SELECT id, created_at, model, supplier, unit, payment, encrypted, status, input_tokens, output_tokens, usage_source,
           reserved_msub, charged_msub, latency_ms, account_id
         FROM requests ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as any[];
    return json(c, 200, { data: rows.map((x) => ({ ...x, encrypted: !!x.encrypted, tier: tierOf(x.supplier) })) });
  });

  // -------------------------------------------------------------- other-mint discovery (NIP-87)
  const discoveryView = () => {
    const accepted = funding.acceptedForeignMints();
    return {
      policy: env.FORGE_FOREIGN_POLICY,
      enabled: env.FORGE_FOREIGN_ENABLED,
      allow: env.FORGE_FOREIGN_ALLOW,
      deny: env.FORGE_FOREIGN_DENY,
      /** Mints added on this page (removable here); env FORGE_FOREIGN_ALLOW entries are not. */
      operator_mints: funding.operatorMints(),
      accepted: accepted.mints,
      unlisted: {
        enabled: env.FORGE_FOREIGN_UNLISTED,
        max: { sat: Math.min(env.FORGE_FOREIGN_UNLISTED_MAX_SAT, env.FORGE_FOREIGN_MAX_SAT), usd: Math.min(env.FORGE_FOREIGN_UNLISTED_MAX_USD, env.FORGE_FOREIGN_MAX_USD) },
      },
      discovery: discovery.status(),
    };
  };
  const REFRESH_EVERY_MS = 60_000;
  let lastManualRefresh = 0;

  r.get('/admin/api/mints/discovery', (c) => json(c, 200, discoveryView()));

  r.post('/admin/api/mints/discovery/refresh', async (c) => {
    if (!discovery.enabled) return fail(c, 409, 'discovery_off', 'no discovery relays are set (FORGE_FOREIGN_DISCOVERY_RELAYS)');
    const wait = lastManualRefresh + REFRESH_EVERY_MS - Date.now();
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return fail(c, 429, 'rate_limited', 'discovery was refreshed less than a minute ago');
    }
    lastManualRefresh = Date.now();
    await discovery.refresh();
    const view = discoveryView();
    audit('mint_discovery_refresh', { ok: view.discovery.last_refresh?.ok ?? false, accepted: view.discovery.mints.length });
    return json(c, 200, view);
  });

  // Operator-added mints: accepted like FORGE_FOREIGN_ALLOW. Adding one runs the URL safety check and the
  // live probe discovery uses; force adds a mint that failed the probe (the response says so).
  r.post('/admin/api/mints/allowed', async (c) => {
    const b = await body(c);
    if (typeof b.url !== 'string') return fail(c, 400, 'invalid_request', 'send {"url": "https://mint.example"}');
    if (b.note != null && typeof b.note !== 'string') return fail(c, 400, 'invalid_request', 'note must be a string');
    const out = await funding.addOperatorMint(b.url, b.note ?? null, b.force === true);
    audit('mint_allow_add', { url: out.mint.url, probe_ok: out.probe.ok, forced: out.forced, added: out.added });
    return json(c, 200, { ...out, view: discoveryView() });
  });

  const removeMint = (c: Context, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) return fail(c, 400, 'invalid_request', 'send the mint url');
    if (!funding.removeOperatorMint(url)) return fail(c, 404, 'not_found', 'that mint was not added on the admin page');
    audit('mint_allow_remove', { url: url.trim() });
    return json(c, 200, { ok: true, view: discoveryView() });
  };
  r.delete('/admin/api/mints/allowed', (c) => removeMint(c, c.req.query('url')));
  r.post('/admin/api/mints/allowed/remove', async (c) => removeMint(c, (await body(c)).url));

  // -------------------------------------------------------------- settings (read-only)
  r.get('/admin/api/settings', async (c) => {
    const rate = rates.current();
    let methods: unknown = null;
    try {
      methods = await funding.methods();
    } catch (e) {
      methods = { error: errText(e) };
    }
    return json(c, 200, {
      invite_only: env.FORGE_INVITE_ONLY,
      markup,
      units: env.FORGE_UNITS,
      default_unit: env.FORGE_DEFAULT_UNIT,
      trusted_mints: wallet.trustedMints,
      fund_mint: funding.mint,
      caps: {
        fund_max_sat: env.FORGE_FUND_MAX_SAT,
        fund_max_usd: env.FORGE_FUND_MAX_USD,
        foreign_max_sat: env.FORGE_FOREIGN_MAX_SAT,
        foreign_max_usd: env.FORGE_FOREIGN_MAX_USD,
        fund_max_pending: env.FORGE_FUND_MAX_PENDING,
        quote_checks_per_min: env.FORGE_MINT_QUOTE_CHECKS_PER_MIN,
        rate_limit_rpm: env.FORGE_RATE_LIMIT_RPM,
        max_body_bytes: env.FORGE_MAX_BODY_BYTES,
      },
      enabled: { lightning: env.FORGE_LIGHTNING_ENABLED, onchain: env.FORGE_ONCHAIN_ENABLED, foreign: env.FORGE_FOREIGN_ENABLED },
      foreign: {
        allow: env.FORGE_FOREIGN_ALLOW,
        deny: env.FORGE_FOREIGN_DENY,
        policy: env.FORGE_FOREIGN_POLICY,
        min_reviewers: env.FORGE_FOREIGN_MIN_REVIEWERS,
        unlisted: env.FORGE_FOREIGN_UNLISTED,
        unlisted_max_sat: env.FORGE_FOREIGN_UNLISTED_MAX_SAT,
        unlisted_max_usd: env.FORGE_FOREIGN_UNLISTED_MAX_USD,
      },
      methods,
      rate_sources: env.FORGE_RATE_SOURCES,
      btc_usd: rate ?? null,
      suppliers: supplierStatus(),
      models: config.catalog.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        supplier: m.supplier,
        tier: tierOf(m.supplier),
        uncensored: m.uncensored,
        verified: m.price_verified,
        max_output_tokens: m.max_output_tokens,
        cost_usd_per_mtok: { input: m.input_usd_per_mtok, output: m.output_usd_per_mtok },
        price_usd_per_mtok: { input: displayPrice(m.input_usd_per_mtok, markup, 'usd'), output: displayPrice(m.output_usd_per_mtok, markup, 'usd') },
        price_sat_per_mtok: rate ? { input: displayPrice(m.input_usd_per_mtok, markup, 'sat', rate), output: displayPrice(m.output_usd_per_mtok, markup, 'sat', rate) } : null,
      })),
    });
  });

  r.all('/admin/api/*', (c) => fail(c, 404, 'not_found', 'no such admin endpoint'));

  return r;
}

export interface ModelCost {
  model: string;
  name: string | null;
  supplier: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  /** Customer price, nano-USD. */
  price_nusd: number;
  /** Our cost, nano-USD; supplier_reported of the requests used the supplier's own figure. */
  cost_nusd: number;
  supplier_reported: number;
  /** Our catalog cost per million tokens (before markup). */
  catalog: { input: number; output: number; verified: boolean };
  /** Per-million prices fitted to the supplier's reported costs, when there is enough data. */
  derived: { input: number; output: number; samples: number } | null;
  /** Fitted price differs from the catalog by more than 10% (either way). */
  drift: boolean;
}

/**
 * Supplier cost per model over a window: what customers paid (price_nusd), what it cost us (the
 * supplier's reported cost, else usage at catalog cost), and per-million prices fitted to the reported
 * costs by least squares (cost = a*input + b*output), to replace placeholder catalog prices.
 */
export function supplierCosts(db: DB, config: Config, days: number) {
  const since = Date.now() - days * 86_400_000;
  const rows = db
    .prepare(
      `SELECT model, supplier, input_tokens AS i, output_tokens AS o, price_nusd AS p, supplier_cost_nusd AS c, cost_source AS s
       FROM requests WHERE created_at >= ? AND status = 'settled' AND price_nusd IS NOT NULL`,
    )
    .all(since) as Array<{ model: string; supplier: string; i: number | null; o: number | null; p: number; c: number | null; s: string | null }>;
  const by = new Map<string, typeof rows>();
  for (const x of rows) by.set(x.model, [...(by.get(x.model) ?? []), x]);
  const models: ModelCost[] = [];
  for (const [id, rs] of by) {
    const m = config.catalog.models.find((x: { id: string }) => x.id === id);
    const rep = rs.filter((x) => x.s === 'supplier' && x.c != null && x.i != null && x.o != null);
    let derived: ModelCost['derived'] = null;
    if (rep.length >= 2) {
      let ii = 0, io = 0, oo = 0, ic = 0, oc = 0;
      for (const x of rep) {
        ii += x.i! * x.i!; io += x.i! * x.o!; oo += x.o! * x.o!; ic += x.i! * x.c!; oc += x.o! * x.c!;
      }
      const det = ii * oo - io * io;
      // Needs requests with different input/output mixes to separate the two prices.
      if (det > 1e-9 * ii * oo) {
        const a = (ic * oo - oc * io) / det;
        const b = (oc * ii - ic * io) / det;
        if (a >= 0 && b >= 0) derived = { input: a / 1000, output: b / 1000, samples: rep.length };
      }
    }
    const catalog = { input: m?.input_usd_per_mtok ?? 0, output: m?.output_usd_per_mtok ?? 0, verified: !!m?.price_verified };
    const off = (d: number, c: number) => (c === 0 ? d > 0 : Math.abs(d - c) / c > 0.1);
    models.push({
      model: id,
      name: m?.name ?? null,
      supplier: rs[0]!.supplier,
      requests: rs.length,
      input_tokens: rs.reduce((t, x) => t + (x.i ?? 0), 0),
      output_tokens: rs.reduce((t, x) => t + (x.o ?? 0), 0),
      price_nusd: rs.reduce((t, x) => t + x.p, 0),
      cost_nusd: rs.reduce((t, x) => t + (x.c ?? 0), 0),
      supplier_reported: rep.length,
      catalog,
      derived,
      drift: !!derived && (off(derived.input, catalog.input) || off(derived.output, catalog.output)),
    });
  }
  models.sort((a, b) => b.price_nusd - a.price_nusd);
  const suppliers = [...new Set(models.map((x) => x.supplier))].map((id) => {
    const ms = models.filter((x) => x.supplier === id);
    return { supplier: id, requests: ms.reduce((t, x) => t + x.requests, 0), price_nusd: ms.reduce((t, x) => t + x.price_nusd, 0), cost_nusd: ms.reduce((t, x) => t + x.cost_nusd, 0) };
  });
  const total = { requests: rows.length, price_nusd: models.reduce((t, x) => t + x.price_nusd, 0), cost_nusd: models.reduce((t, x) => t + x.cost_nusd, 0) };
  return { days, since, markup: config.env.FORGE_MARKUP, total, suppliers, models };
}
