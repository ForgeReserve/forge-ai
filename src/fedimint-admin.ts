/**
 * The operator's admin for Fedimint (/admin/api/fedimint*, docs/ADMIN.md, Fedimint), mounted by the admin
 * router (src/admin-api.ts), behind its token, origin and JSON checks and its audit log.
 *
 *  - Federations: each joined federation with its state, caps, the receiver's balance there, and the
 *    gateway's own record of its top-ups (src/fedimint.ts stats).
 *  - Reconciliation, per federation: the receiver's balance against what the gateway credited minus what
 *    left the receiver. The receiver's record credits net_msat, the notes' face value less the federation's
 *    fee, and its balance rises by exactly that, so the two agree to the msat; the fee shows as face value
 *    less credited. A difference is explained only by top-ups not finished on the gateway's side.
 *  - Coverage: sat balances are taken out in Cashu from the Forge mint, while the ones funded by Fedimint
 *    are backed by notes at the receiver. Sat liabilities against the Cashu sat the gateway holds.
 *  - Rebalance: the amount to move from the receiver into Cashu. Nothing moves it yet: the receiver has no
 *    route that pays a Lightning invoice (the design is in docs/ADMIN.md, Fedimint).
 *
 * Amounts: msat for Fedimint (a sat balance counts msub, which for sat is msat), whole sat for Cashu.
 * Never shown or logged: notes, invite codes, the receiver's token.
 */
import type { Context, Hono } from 'hono';
import type { Deps } from './app.ts';
import { PaymentError } from './cashu/wallet.ts';
import { type FederationRow, type FederationStats, type JoinedFederation, ReceiverError } from './fedimint.ts';
import { errText, log } from './log.ts';
import { MSUB_PER_UNIT } from './pricing.ts';

// ---------------------------------------------------------------- the maths (pure, tested on their own)

export type ReconcileStatus = 'ok' | 'explained' | 'short' | 'over' | 'unknown';

export interface Reconciliation {
  status: ReconcileStatus;
  /** True when the operator must look: the receiver holds less than it should, or more than explained. */
  flag: boolean;
  /** What the receiver should hold once every top-up is finished: credited less sent out. */
  expected_msat: number;
  /** The receiver's balance less expected_msat; null when the balance is not known. */
  difference_msat: number | null;
  /** The most a positive difference can be explained by, and by what. */
  allowance_msat: number;
  explained: Array<{ what: 'in_flight' | 'stuck' | 'given_elsewhere'; msat: number }>;
}

/**
 * One federation's reconciliation. balanceMsat: the receiver's; creditedMsat: what the gateway credited
 * for its notes (net of fees); sentMsat: what left the receiver (nothing yet: it has no send route);
 * inFlightMsat, stuckMsat, elsewhereMsat: the face value of prepared rows (the receiver may hold them
 * already), stuck rows (the federation took them; if their value is ever issued it lands here) and notes
 * someone else gave the receiver first (held, never credited by this gateway).
 */
export function reconcile(i: { balanceMsat: number | null; creditedMsat: number; sentMsat: number; inFlightMsat: number; stuckMsat: number; elsewhereMsat: number }): Reconciliation {
  const expected = i.creditedMsat - i.sentMsat;
  const explained = (
    [
      ['in_flight', i.inFlightMsat],
      ['stuck', i.stuckMsat],
      ['given_elsewhere', i.elsewhereMsat],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([what, msat]) => ({ what, msat }));
  const allowance = explained.reduce((s, e) => s + e.msat, 0);
  const base = { expected_msat: expected, allowance_msat: allowance, explained };
  if (i.balanceMsat == null) return { status: 'unknown', flag: false, difference_msat: null, ...base };
  const diff = i.balanceMsat - expected;
  if (diff === 0) return { status: 'ok', flag: false, difference_msat: 0, ...base };
  // Fees cannot make the receiver hold less: each receive's fee is already out of what was credited.
  if (diff < 0) return { status: 'short', flag: true, difference_msat: diff, ...base };
  if (diff <= allowance) return { status: 'explained', flag: false, difference_msat: diff, ...base };
  return { status: 'over', flag: true, difference_msat: diff, ...base };
}

export type CoverageWarning = 'take_out_short' | 'largest_balance_short' | 'under_backed' | 'receiver_unknown';

export interface Coverage {
  /** Paid sat balances, msat; and what take out can ask for, all together: each balance's whole sat. */
  liabilities_msub: number;
  liabilities_sat: number;
  /** The largest single sat balance, in whole sat (take out pays whole sat). */
  largest_balance_sat: number;
  /** Cashu sat at each trusted mint: unspent, owed to payouts not finished, and what is left (unspent less owed). */
  mints: Array<{ mint: string; unspent: number; owed: number; available: number }>;
  cashu_sat: number;
  largest_mint: { mint: string; available: number } | null;
  /** Notes at the receiver, in whole sat (rounded down); null when the receiver did not answer. */
  fedimint_sat: number | null;
  /** How far Cashu falls short of every sat balance taken out at once. */
  shortfall_sat: number;
  /** How far the largest single balance is over what one mint can pay (a take out comes from one mint). */
  largest_short_sat: number;
  warnings: CoverageWarning[];
  /** What a rebalance must bring into Cashu for both to be covered. */
  need_sat: number;
}

/**
 * Sat liabilities against Cashu sat holdings. A take out (POST /v1/wallet/refund) pays Cashu from the
 * trusted mint that holds the most, and answers 503 wallet_insufficient when that mint cannot cover it;
 * notes at the receiver never pay a take out.
 */
export function coverage(i: { liabilitiesMsub: number; takeOutSat: number; largestBalanceMsub: number; mints: Array<{ mint: string; unspent: number; owed: number }>; fedimintHeldMsat: number | null }): Coverage {
  const liabilitiesSat = i.takeOutSat;
  const largestBalanceSat = Math.floor(i.largestBalanceMsub / MSUB_PER_UNIT);
  const mints = i.mints.map((m) => ({ ...m, available: Math.max(0, m.unspent - m.owed) }));
  const cashu = mints.reduce((s, m) => s + m.available, 0);
  const largest = mints.reduce<{ mint: string; available: number } | null>((b, m) => (!b || m.available > b.available ? { mint: m.mint, available: m.available } : b), null);
  const held = i.fedimintHeldMsat == null ? null : Math.floor(i.fedimintHeldMsat / 1000);
  const shortfall = Math.max(0, liabilitiesSat - cashu);
  const largestShort = Math.max(0, largestBalanceSat - (largest?.available ?? 0));
  const warnings: CoverageWarning[] = [];
  if (shortfall > 0) warnings.push('take_out_short');
  if (largestShort > 0) warnings.push('largest_balance_short');
  if (held == null) warnings.push('receiver_unknown');
  // In msat: rounding each side to whole sat would call notes that match the balances exactly short.
  else if (cashu * 1000 + i.fedimintHeldMsat! < i.liabilitiesMsub) warnings.push('under_backed');
  return {
    liabilities_msub: i.liabilitiesMsub,
    liabilities_sat: liabilitiesSat,
    largest_balance_sat: largestBalanceSat,
    mints,
    cashu_sat: cashu,
    largest_mint: largest,
    fedimint_sat: held,
    shortfall_sat: shortfall,
    largest_short_sat: largestShort,
    warnings,
    need_sat: Math.max(shortfall, largestShort),
  };
}

export interface RebalancePlan {
  need_sat: number;
  /** What the receiver can give towards it: the need, at most what it holds. */
  suggested_sat: number;
  /** Where it would come from: the federations holding the most first, each up to its balance. */
  from: Array<{ federation_id: string; name: string | null; sat: number }>;
  /** What is still missing after every federation gave what it holds. */
  short_after_sat: number;
  /** Where it would go: the Forge mint, through a Lightning invoice of its own. */
  to_mint: string;
  /** Always false for now: the receiver cannot pay a Lightning invoice yet. */
  possible: false;
}

/** The suggested rebalance: Lightning fees come on top, out of the notes. */
export function suggestRebalance(needSat: number, federations: Array<{ id: string; name: string | null; balance_msat: number | null }>, toMint: string): RebalancePlan {
  let left = Math.max(0, needSat);
  const from: RebalancePlan['from'] = [];
  for (const f of [...federations].filter((x) => (x.balance_msat ?? 0) >= 1000).sort((a, b) => b.balance_msat! - a.balance_msat!)) {
    if (left <= 0) break;
    const sat = Math.min(left, Math.floor(f.balance_msat! / 1000));
    from.push({ federation_id: f.id, name: f.name, sat });
    left -= sat;
  }
  return { need_sat: Math.max(0, needSat), suggested_sat: Math.max(0, needSat) - left, from, short_after_sat: left, to_mint: toMint, possible: false };
}

// ---------------------------------------------------------------- the routes

export interface AdminHelpers {
  fail: (c: Context, status: number, code: string, message: string, extra?: object) => Response;
  body: (c: Context) => Promise<any>;
  audit: (action: string, fields?: Record<string, string | number | boolean | null | undefined>) => void;
}

const NOTES_ID = /^[0-9a-f]{64}$/;
const FEDERATION_ID = /^[0-9a-f]{64}$/;
const RECEIPT_FILTERS: Record<string, Array<'prepared' | 'done' | 'rejected' | 'stuck'>> = {
  attention: ['stuck', 'prepared'],
  stuck: ['stuck'],
  prepared: ['prepared'],
  done: ['done'],
  rejected: ['rejected'],
  all: ['stuck', 'prepared', 'done', 'rejected'],
};

/** What nothing has sent out of the receiver yet: it has no send route (docs/ADMIN.md, Fedimint, Rebalance). */
const SENT_MSAT = 0;

export function fedimintAdminRoutes(r: Hono, d: Deps, { fail, body, audit }: AdminHelpers) {
  const env = d.config.env;
  const off = (c: Context) => fail(c, 409, 'fedimint_off', 'Fedimint is off on this gateway: set FORGE_FEDIMINT_URL and FORGE_FEDIMINT_TOKEN (docs/FEDIMINT-RECEIVER.md, Turning it on)');
  const satsOf = (v: unknown, name: string, nullable: boolean): number | null | undefined => {
    if (v === undefined || v === '') return undefined;
    if (v === null) {
      if (nullable) return null;
      throw new PaymentError('invalid_request', `${name} must be a whole number of sats`);
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1) throw new PaymentError('invalid_request', `${name} must be a whole number of sats, 1 or more`);
    return n;
  };
  /** The caps in force, as the view names them. */
  const capsOf = (f: FederationRow) => {
    const x = d.fedimint!.caps(f);
    return { max_sat: x.maxSat, cap_sat: x.capSat };
  };
  const receiverFail = (c: Context, e: unknown) => {
    if (e instanceof ReceiverError) {
      if (e.code === 'bad_invite') return fail(c, 422, 'bad_invite', 'the receiver did not take this invite code: ' + e.message);
      if (e.code === 'unreachable') return fail(c, 502, 'federation_unreachable', "the federation's guardians did not answer the receiver");
      return fail(c, 503, 'fedimint_unavailable', `the receiver did not answer (${e.code})`);
    }
    throw e;
  };

  /** The whole view: federations, reconciliation, coverage, the rebalance, and the top-ups that need the operator. */
  r.get('/admin/api/fedimint', async (c) => {
    const fm = d.fedimint;
    if (!fm) return c.json({ enabled: false });
    let joined: JoinedFederation[] | undefined;
    let receiverError: string | null = null;
    try {
      joined = await fm.client.federations();
    } catch (e) {
      receiverError = e instanceof ReceiverError ? `${e.code}: ${e.message}` : errText(e);
      log.warn('fedimint_receiver_unavailable', { err: errText(e) });
    }
    const stats = fm.stats();
    const blank: FederationStats = { count: { done: 0, prepared: 0, stuck: 0, rejected: 0 }, face_msat: { done: 0, prepared: 0, stuck: 0, rejected: 0 }, given_elsewhere_msat: 0, credited_msat: 0, last_receipt_at: null };
    const federations = fm.federations().map((f: FederationRow) => {
      const s = stats.get(f.id) ?? blank;
      const j = joined?.find((x) => x.id === f.id);
      const balance = joined ? (j ? Number(j.balance_msat ?? 0) : 0) : null;
      const caps = fm.caps(f);
      const used = balance == null ? null : balance + s.face_msat.prepared + s.face_msat.stuck;
      return {
        id: f.id,
        name: f.name,
        state: f.state,
        receives: JSON.parse(f.receives) as string[],
        joined: joined ? !!j : null,
        joined_at: f.joined_at,
        caps: { max_sat: caps.maxSat, cap_sat: caps.capSat, max_default: f.max_sat == null, cap_default: f.cap_sat == null },
        receiver_balance_msat: balance,
        holdings: { used_msat: used, room_sat: used == null ? null : Math.max(0, Math.floor((caps.capSat * 1000 - used) / 1000)) },
        gateway: {
          received_msat: s.face_msat.done,
          credited_msat: s.credited_msat,
          fees_msat: s.face_msat.done - s.credited_msat,
          sent_msat: SENT_MSAT,
        },
        count: s.count,
        face_msat: { prepared: s.face_msat.prepared, stuck: s.face_msat.stuck },
        last_receipt_at: s.last_receipt_at,
        reconciliation: reconcile({
          balanceMsat: balance,
          creditedMsat: s.credited_msat,
          sentMsat: SENT_MSAT,
          inFlightMsat: s.face_msat.prepared,
          stuckMsat: s.face_msat.stuck,
          elsewhereMsat: s.given_elsewhere_msat,
        }),
      };
    });
    // The Cashu side: sat at the trusted mints (never the credit mint), and the paid sat balances.
    const mints = d.wallet
      .holdings()
      .filter((h) => h.unit === 'sat' && d.wallet.isTrusted(h.mint) && !d.wallet.isCredit(h.mint))
      .map((h) => ({ mint: h.mint, unspent: h.unspent, owed: h.owed }));
    const largest = (d.db.prepare("SELECT COALESCE(MAX(balance_msub), 0) AS m FROM accounts WHERE unit = 'sat' AND free = 0").get() as { m: number }).m;
    const held = joined ? federations.reduce((s, f) => s + (f.receiver_balance_msat ?? 0), 0) : null;
    // A take out pays whole sat: the most every sat balance can ask for is the sum of their whole sat.
    const takeOut = (d.db.prepare(`SELECT COALESCE(SUM(balance_msub / ${MSUB_PER_UNIT}), 0) AS s FROM accounts WHERE unit = 'sat' AND free = 0 AND balance_msub > 0`).get() as { s: number }).s;
    const cov = coverage({ liabilitiesMsub: d.ledger.liabilities().sat ?? 0, takeOutSat: takeOut, largestBalanceMsub: largest, mints, fedimintHeldMsat: held });
    const sum = (f: (x: (typeof federations)[number]) => number) => federations.reduce((s, x) => s + f(x), 0);
    return c.json({
      enabled: true,
      at: Date.now(),
      defaults: { max_sat: env.FORGE_FEDIMINT_MAX_SAT, cap_sat: env.FORGE_FEDIMINT_FEDERATION_CAP_SAT },
      receiver: { ok: !!joined, error: receiverError, joined: joined?.length ?? null },
      federations,
      totals: {
        receiver_balance_msat: held,
        received_msat: sum((f) => f.gateway.received_msat),
        credited_msat: sum((f) => f.gateway.credited_msat),
        fees_msat: sum((f) => f.gateway.fees_msat),
        sent_msat: SENT_MSAT,
        flagged: federations.filter((f) => f.reconciliation.flag).length,
        stuck: sum((f) => f.count.stuck),
        prepared: sum((f) => f.count.prepared),
      },
      coverage: cov,
      rebalance: suggestRebalance(
        cov.need_sat,
        federations.map((f) => ({ id: f.id, name: f.name, balance_msat: f.receiver_balance_msat })),
        d.funding.mint,
      ),
      attention: fm.receipts(RECEIPT_FILTERS.attention!),
    });
  });

  r.get('/admin/api/fedimint/receipts', (c) => {
    const fm = d.fedimint;
    if (!fm) return off(c);
    const which = c.req.query('state') ?? 'attention';
    const states = RECEIPT_FILTERS[which];
    if (!states) return fail(c, 400, 'invalid_request', `state must be one of ${Object.keys(RECEIPT_FILTERS).join(', ')}`);
    const limit = Math.min(1000, Math.max(1, Number(c.req.query('limit')) || 200));
    return c.json({ data: fm.receipts(states, limit) });
  });

  // Join by invite: the invite goes to the receiver and into the federations row, never into a log or an answer.
  r.post('/admin/api/fedimint/federations', async (c) => {
    const fm = d.fedimint;
    if (!fm) return off(c);
    const b = await body(c);
    const invite = typeof b.invite === 'string' ? b.invite.trim() : '';
    if (!invite || invite.length > 8000 || /\s/.test(invite)) return fail(c, 400, 'invalid_request', 'send {"invite": "fed11..."}, the invite code alone');
    const maxSat = satsOf(b.max_sat, 'max_sat', false) ?? undefined;
    const capSat = satsOf(b.cap_sat, 'cap_sat', false) ?? undefined;
    let out;
    try {
      out = await fm.join(invite, { maxSat, capSat });
    } catch (e) {
      return receiverFail(c, e);
    }
    audit('fedimint_join', { federation: out.row.id, created: out.created, already_joined: out.alreadyJoined, max_sat: maxSat ?? null, cap_sat: capSat ?? null });
    return c.json({ id: out.row.id, name: out.row.name, state: out.row.state, created: out.created, already_joined: out.alreadyJoined, caps: capsOf(out.row) });
  });

  const federationOr404 = (c: Context) => {
    const id = c.req.param('id') ?? '';
    const f = FEDERATION_ID.test(id) ? d.fedimint!.federation(id) : undefined;
    return f ?? fail(c, 404, 'not_found', 'no joined federation has this id');
  };

  for (const [verb, state] of [
    ['pause', 'paused'],
    ['resume', 'active'],
  ] as const) {
    r.post(`/admin/api/fedimint/federations/:id/${verb}`, (c) => {
      const fm = d.fedimint;
      if (!fm) return off(c);
      const f = federationOr404(c);
      if (f instanceof Response) return f;
      fm.setState(f.id, state);
      audit(`fedimint_${verb}`, { federation: f.id, was: f.state });
      return c.json({ id: f.id, state });
    });
  }

  r.post('/admin/api/fedimint/federations/:id/cap', async (c) => {
    const fm = d.fedimint;
    if (!fm) return off(c);
    const f = federationOr404(c);
    if (f instanceof Response) return f;
    const b = await body(c);
    if (!('cap_sat' in b)) return fail(c, 400, 'invalid_request', 'send {"cap_sat": N} in sat, or {"cap_sat": null} for the gateway default');
    const cap = satsOf(b.cap_sat, 'cap_sat', true) ?? null;
    fm.setCap(f.id, cap);
    audit('fedimint_cap', { federation: f.id, cap_sat: cap, was: f.cap_sat });
    return c.json({ id: f.id, caps: capsOf(fm.federation(f.id)!), cap_default: cap == null });
  });

  const notesIdOr400 = (c: Context): string | Response => {
    const id = (c.req.param('id') ?? '').replace(/^fm:/, '');
    return NOTES_ID.test(id) ? id : fail(c, 400, 'invalid_request', 'a notes id is 64 hex characters');
  };

  r.post('/admin/api/fedimint/receipts/:id/check', async (c) => {
    const fm = d.fedimint;
    if (!fm) return off(c);
    const id = notesIdOr400(c);
    if (id instanceof Response) return id;
    const before = fm.receipt(id)?.status;
    const out = await fm.checkReceipt(id);
    if (!out) return fail(c, 404, 'not_found', 'no Fedimint top-up has this notes id');
    audit('fedimint_receipt_check', { notes_id: id, before: before ?? null, after: out.status, credited: out.credited, receiver: out.record?.state ?? out.receiver_error });
    return c.json({ notes_id: id, ...out });
  });

  r.post('/admin/api/fedimint/receipts/:id/resolve', async (c) => {
    const fm = d.fedimint;
    if (!fm) return off(c);
    const id = notesIdOr400(c);
    if (id instanceof Response) return id;
    const b = await body(c);
    const note = typeof b.note === 'string' ? b.note.trim() : '';
    if (!note || note.length > 200) return fail(c, 400, 'invalid_request', 'send {"note": "..."}: how it was settled, 1 to 200 characters');
    const out = await fm.resolveReceipt(id, note);
    // The note is the operator's own words and may name the person: it stays on the row, out of the log.
    audit('fedimint_receipt_resolve', { notes_id: id });
    return c.json({ notes_id: id, ...out });
  });
}
