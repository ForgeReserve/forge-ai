// The operator's admin for Fedimint (/admin/api/fedimint*, src/fedimint-admin.ts; docs/ADMIN.md, Fedimint):
// its maths on their own (reconciliation, take out coverage, the suggested rebalance), then every route
// against a stand-in receiver over real HTTP (test/support/fakereceiver.ts): the admin gate, validation,
// each action and what it logs. The real receiver runs in test/fedimint/topup.fedimint.test.ts.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { coverage, reconcile, suggestRebalance } from '../../src/fedimint-admin.ts';
import { receiveKey } from '../../src/fedimint.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { FakeReceiver, RECEIVER_TOKEN } from '../support/fakereceiver.ts';

setLogSilent(true);
const TOKEN = 'admin-test-token-0123456789abcdef';
const HOST = 'gw.test';
const ORIGIN = `http://${HOST}`;
const MINT = 'http://127.0.0.1:1';
const FED = createHash('sha256').update('federation A').digest('hex');
const OTHER = createHash('sha256').update('federation B').digest('hex');
const INVITE_A = 'fed11' + 'a'.repeat(120);
const INVITE_B = 'fed11' + 'b'.repeat(120);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }],
};

let rx: FakeReceiver;
beforeEach(async () => {
  rx = await new FakeReceiver().start();
  rx.invites.set(INVITE_A, { id: FED, name: 'Alpha' });
  rx.invites.set(INVITE_B, { id: OTHER, name: 'Beta' });
});
afterEach(async () => {
  await rx.close();
  vi.restoreAllMocks();
  setLogSilent(true);
});

function gateway(o: { fedimint?: boolean; admin?: boolean; extra?: Record<string, string> } = {}) {
  const e: Record<string, string> = {
    FORGE_DB_PATH: ':memory:',
    FORGE_TRUSTED_MINTS: MINT,
    FORGE_RATE_LIMIT_RPM: '100000',
    FORGE_ADMIN_RATE_LIMIT_RPM: '100000',
    FORGE_FOREIGN_DISCOVERY_RELAYS: '',
    FORGE_INVITE_ONLY: 'true',
    ...(o.admin === false ? {} : { FORGE_ADMIN_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex') }),
    ...(o.fedimint === false ? {} : { FORGE_FEDIMINT_URL: rx.url, FORGE_FEDIMINT_TOKEN: RECEIVER_TOKEN }),
    ...o.extra,
  };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv, fedimint: { waitMs: 0, pollMs: 10 } });
  const app = createApp(deps);
  const call = async (path: string, init: { method?: string; body?: unknown; token?: string | null; origin?: string | null; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { host: HOST, ...init.headers };
    if (init.token !== null) headers['x-forge-admin-token'] = init.token ?? TOKEN;
    if (init.method && init.method !== 'GET') {
      if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
      headers['content-type'] ??= 'application/json';
    }
    const r = await app.request(`${ORIGIN}/admin/api${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const post = (path: string, body: unknown = {}) => call(path, { method: 'POST', body });
  const topup = async (token: string, key?: string) => {
    const r = await app.request(`${ORIGIN}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ token, invite: key ? undefined : deps.invites.create('t').code }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  /** Cashu sat the gateway holds at a mint, as unspent proofs. */
  const holdCashu = (mint: string, amount: number) =>
    deps.db
      .prepare("INSERT INTO proofs (secret, mint, unit, keyset_id, amount, proof, state, op_id, created_at) VALUES (?, ?, 'sat', '00', ?, '{}', 'unspent', NULL, ?)")
      .run(createHash('sha256').update(`${mint} ${amount} ${Math.random()}`).digest('hex'), mint, amount, Date.now());
  const row = (notesId: string) => deps.db.prepare('SELECT * FROM incoming WHERE id = ?').get(`fm:${notesId}`) as any;
  return { app, deps, call, post, topup, holdCashu, row };
}

/** Lines the admin router logged as admin_action while fn ran. */
async function audited(fn: () => Promise<unknown>): Promise<any[]> {
  const lines: string[] = [];
  setLogSilent(false);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => (lines.push(String(s)), true));
  try {
    await fn();
  } finally {
    spy.mockRestore();
    setLogSilent(true);
  }
  return lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'admin_action');
}

describe('reconciliation', () => {
  const base = { creditedMsat: 49_876, sentMsat: 0, inFlightMsat: 0, stuckMsat: 0, elsewhereMsat: 0 };

  it('agrees to the msat when the receiver holds what was credited less what was sent', () => {
    expect(reconcile({ ...base, balanceMsat: 49_876 })).toMatchObject({ status: 'ok', flag: false, expected_msat: 49_876, difference_msat: 0, allowance_msat: 0, explained: [] });
    expect(reconcile({ ...base, sentMsat: 9_876, balanceMsat: 40_000 })).toMatchObject({ status: 'ok', expected_msat: 40_000, difference_msat: 0 });
  });

  it('flags a receiver that holds less, whatever is on its way: fees are already out of what was credited', () => {
    expect(reconcile({ ...base, balanceMsat: 49_875 })).toMatchObject({ status: 'short', flag: true, difference_msat: -1 });
    expect(reconcile({ ...base, balanceMsat: 0, inFlightMsat: 1_000_000 })).toMatchObject({ status: 'short', flag: true, difference_msat: -49_876 });
  });

  it('explains a receiver that holds more by top-ups on their way, stuck ones and notes given elsewhere, up to their face value', () => {
    const r = reconcile({ ...base, balanceMsat: 49_876 + 3_000, inFlightMsat: 2_000, stuckMsat: 500, elsewhereMsat: 500 });
    expect(r).toMatchObject({ status: 'explained', flag: false, difference_msat: 3_000, allowance_msat: 3_000 });
    expect(r.explained).toEqual([
      { what: 'in_flight', msat: 2_000 },
      { what: 'stuck', msat: 500 },
      { what: 'given_elsewhere', msat: 500 },
    ]);
    expect(reconcile({ ...base, balanceMsat: 49_876 + 3_001, inFlightMsat: 2_000, stuckMsat: 500, elsewhereMsat: 500 })).toMatchObject({ status: 'over', flag: true, difference_msat: 3_001 });
    expect(reconcile({ ...base, balanceMsat: 49_877 })).toMatchObject({ status: 'over', flag: true });
  });

  it('says unknown, and flags nothing, when the balance is not known', () => {
    expect(reconcile({ ...base, balanceMsat: null, inFlightMsat: 7 })).toMatchObject({ status: 'unknown', flag: false, difference_msat: null, expected_msat: 49_876, allowance_msat: 7 });
  });
});

describe('take out coverage', () => {
  it('covers every sat balance when the Cashu sat, less payouts owed, is at least what they can take out (each its whole sat)', () => {
    const c = coverage({ liabilitiesMsub: 99_001, takeOutSat: 99, largestBalanceMsub: 60_000, mints: [{ mint: 'a', unspent: 70, owed: 0 }, { mint: 'b', unspent: 40, owed: 10 }], fedimintHeldMsat: 99_001 });
    expect(c).toMatchObject({ liabilities_sat: 99, largest_balance_sat: 60, cashu_sat: 100, largest_mint: { mint: 'a', available: 70 }, fedimint_sat: 99, shortfall_sat: 0, largest_short_sat: 0, warnings: [], need_sat: 0 });
    expect(c.mints).toEqual([
      { mint: 'a', unspent: 70, owed: 0, available: 70 },
      { mint: 'b', unspent: 40, owed: 10, available: 30 },
    ]);
  });

  it('warns when Cashu runs short of all balances, when one balance is over what any one mint pays, and when even the notes do not back them', () => {
    const c = coverage({ liabilitiesMsub: 150_000, takeOutSat: 150, largestBalanceMsub: 90_999, mints: [{ mint: 'a', unspent: 60, owed: 0 }, { mint: 'b', unspent: 50, owed: 70 }], fedimintHeldMsat: 30_000 });
    expect(c).toMatchObject({ liabilities_sat: 150, cashu_sat: 60, shortfall_sat: 90, largest_balance_sat: 90, largest_short_sat: 30, fedimint_sat: 30, need_sat: 90 });
    expect(c.warnings).toEqual(['take_out_short', 'largest_balance_short', 'under_backed']);
    // The largest balance alone can be the need: enough Cashu in all, too little at one mint.
    const one = coverage({ liabilitiesMsub: 100_000, takeOutSat: 100, largestBalanceMsub: 80_000, mints: [{ mint: 'a', unspent: 50, owed: 0 }, { mint: 'b', unspent: 50, owed: 0 }], fedimintHeldMsat: 0 });
    expect(one).toMatchObject({ shortfall_sat: 0, largest_short_sat: 30, need_sat: 30, warnings: ['largest_balance_short'] });
  });

  it('calls notes that match the balances to the msat enough, whatever the rounding to whole sat', () => {
    expect(coverage({ liabilitiesMsub: 123_456, takeOutSat: 123, largestBalanceMsub: 0, mints: [], fedimintHeldMsat: 123_456 }).warnings).toEqual(['take_out_short']);
    expect(coverage({ liabilitiesMsub: 123_456, takeOutSat: 123, largestBalanceMsub: 0, mints: [], fedimintHeldMsat: 123_455 }).warnings).toEqual(['take_out_short', 'under_backed']);
  });

  it('counts no notes while the receiver does not answer, and says so', () => {
    const c = coverage({ liabilitiesMsub: 0, takeOutSat: 0, largestBalanceMsub: 0, mints: [], fedimintHeldMsat: null });
    expect(c).toMatchObject({ cashu_sat: 0, largest_mint: null, fedimint_sat: null, need_sat: 0, warnings: ['receiver_unknown'] });
  });
});

describe('the suggested rebalance', () => {
  const feds = [
    { id: 'small', name: 'S', balance_msat: 20_999 },
    { id: 'big', name: 'B', balance_msat: 50_000 },
    { id: 'down', name: null, balance_msat: null },
    { id: 'dust', name: 'D', balance_msat: 999 },
  ];
  it('takes from the federations holding the most first, each up to its whole sat, and says what is still missing', () => {
    expect(suggestRebalance(60, feds, 'http://mint')).toEqual({
      need_sat: 60,
      suggested_sat: 60,
      from: [
        { federation_id: 'big', name: 'B', sat: 50 },
        { federation_id: 'small', name: 'S', sat: 10 },
      ],
      short_after_sat: 0,
      to_mint: 'http://mint',
      possible: false,
    });
    expect(suggestRebalance(100, feds, 'm')).toMatchObject({ suggested_sat: 70, short_after_sat: 30, from: [{ sat: 50 }, { sat: 20 }] });
    expect(suggestRebalance(0, feds, 'm')).toMatchObject({ need_sat: 0, suggested_sat: 0, from: [], short_after_sat: 0 });
  });
});

describe('the admin gate in front of /admin/api/fedimint', () => {
  it('is 404 without an admin token hash, 401 without the token, and refuses changes from another origin or without JSON', async () => {
    expect((await gateway({ admin: false }).call('/fedimint')).status).toBe(404);
    const g = gateway();
    expect((await g.call('/fedimint', { token: null })).status).toBe(401);
    expect((await g.call('/fedimint', { token: 'wrong' })).status).toBe(401);
    expect((await g.call('/fedimint/federations', { method: 'POST', body: { invite: INVITE_A }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await g.call('/fedimint/federations', { method: 'POST', body: { invite: INVITE_A }, origin: null })).status).toBe(403);
    expect((await g.call('/fedimint/federations', { method: 'POST', body: { invite: INVITE_A }, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    for (const p of [`/fedimint/federations/${FED}/pause`, `/fedimint/federations/${FED}/resume`, `/fedimint/federations/${FED}/cap`, `/fedimint/receipts/${'0'.repeat(64)}/check`, `/fedimint/receipts/${'0'.repeat(64)}/resolve`]) {
      expect((await g.call(p, { method: 'POST', body: {}, token: null })).status, p).toBe(401);
    }
    // Nothing reached the receiver.
    expect(rx.calls).toEqual([]);
  });

  it('says Fedimint is off, and refuses every action, while FORGE_FEDIMINT_URL is unset', async () => {
    const g = gateway({ fedimint: false });
    expect(await g.call('/fedimint')).toEqual({ status: 200, body: { enabled: false } });
    for (const p of ['/fedimint/federations', `/fedimint/federations/${FED}/pause`, `/fedimint/federations/${FED}/cap`, `/fedimint/receipts/${'0'.repeat(64)}/check`]) {
      const r = await g.post(p, { invite: INVITE_A, cap_sat: 5 });
      expect(r.status, p).toBe(409);
      expect(r.body.error.code).toBe('fedimint_off');
    }
    expect((await g.call('/fedimint/receipts')).body.error.code).toBe('fedimint_off');
  });
});

describe('joining, pausing, resuming and the holdings cap', () => {
  it('joins by invite through the receiver, with or without caps, and logs it without the invite', async () => {
    const g = gateway();
    let r: any;
    const lines = await audited(async () => {
      r = await g.post('/fedimint/federations', { invite: `  ${INVITE_A}  `, cap_sat: 500 });
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: FED, name: 'Alpha', state: 'active', created: true, already_joined: false, caps: { max_sat: 100_000, cap_sat: 500 } });
    expect(lines).toEqual([expect.objectContaining({ action: 'fedimint_join', federation: FED, created: true, already_joined: false, max_sat: null, cap_sat: 500 })]);
    expect(JSON.stringify(lines) + JSON.stringify(r.body)).not.toContain(INVITE_A);
    expect(g.deps.fedimint!.federation(FED)).toMatchObject({ state: 'active', cap_sat: 500, max_sat: null, invite: INVITE_A });
    // Again: already joined, the caps kept unless given.
    const again = await g.post('/fedimint/federations', { invite: INVITE_A, max_sat: 300 });
    expect(again.body).toMatchObject({ created: false, already_joined: true, caps: { max_sat: 300, cap_sat: 500 } });
    const view = await g.call('/fedimint');
    expect(view.body.federations).toHaveLength(1);
    expect(JSON.stringify(view.body)).not.toContain(INVITE_A);
  });

  it('refuses a missing or malformed invite and bad caps before asking the receiver, and passes on what the receiver says', async () => {
    const g = gateway();
    for (const b of [{}, { invite: '' }, { invite: 42 }, { invite: 'fed11 two parts' }, { invite: 'x'.repeat(8001) }]) {
      const r = await g.post('/fedimint/federations', b);
      expect(r.status, JSON.stringify(b).slice(0, 40)).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
    }
    for (const b of [{ max_sat: 0 }, { cap_sat: -5 }, { cap_sat: 1.5 }, { max_sat: 'many' }, { cap_sat: null }]) {
      const r = await g.post('/fedimint/federations', { invite: INVITE_A, ...b });
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
    expect(rx.calls).toEqual([]);
    const bad = await g.post('/fedimint/federations', { invite: 'fed11notaninvite' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('bad_invite');
    rx.down = true;
    const down = await g.post('/fedimint/federations', { invite: INVITE_A });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('fedimint_unavailable');
    expect(g.deps.fedimint!.federations()).toEqual([]);
  });

  it('pauses and resumes a federation, which the top-up follows at once, and logs each', async () => {
    const g = gateway();
    await g.post('/fedimint/federations', { invite: INVITE_A });
    expect((await g.post(`/fedimint/federations/${OTHER}/pause`)).status).toBe(404);
    expect((await g.post('/fedimint/federations/nothex/pause')).status).toBe(404);
    let lines = await audited(async () => expect((await g.post(`/fedimint/federations/${FED}/pause`)).body).toEqual({ id: FED, state: 'paused' }));
    expect(lines).toEqual([expect.objectContaining({ action: 'fedimint_pause', federation: FED, was: 'active' })]);
    const n = rx.makeNotes(FED, 10_000);
    expect((await g.topup(n.notes)).body.error.code).toBe('federation_paused');
    lines = await audited(async () => expect((await g.post(`/fedimint/federations/${FED}/resume`)).body).toEqual({ id: FED, state: 'active' }));
    expect(lines).toEqual([expect.objectContaining({ action: 'fedimint_resume', federation: FED, was: 'paused' })]);
    expect((await g.topup(n.notes)).status).toBe(200);
  });

  it('changes the holdings cap, which the top-up follows, and goes back to the default with null', async () => {
    const g = gateway();
    await g.post('/fedimint/federations', { invite: INVITE_A });
    for (const b of [{}, { cap_sat: 0 }, { cap_sat: '1e3x' }, { cap_sat: 2.5 }]) expect((await g.post(`/fedimint/federations/${FED}/cap`, b)).status, JSON.stringify(b)).toBe(400);
    let lines = await audited(async () => expect((await g.post(`/fedimint/federations/${FED}/cap`, { cap_sat: 15 })).body).toEqual({ id: FED, caps: { max_sat: 100_000, cap_sat: 15 }, cap_default: false }));
    expect(lines).toEqual([expect.objectContaining({ action: 'fedimint_cap', federation: FED, cap_sat: 15, was: null })]);
    const n = rx.makeNotes(FED, 20_000);
    expect((await g.topup(n.notes)).body.error.code).toBe('federation_full');
    lines = await audited(async () => expect((await g.post(`/fedimint/federations/${FED}/cap`, { cap_sat: null })).body).toMatchObject({ caps: { cap_sat: 1_000_000 }, cap_default: true }));
    expect(lines).toEqual([expect.objectContaining({ action: 'fedimint_cap', cap_sat: null, was: 15 })]);
    expect((await g.topup(n.notes)).status).toBe(200);
    expect((await g.post(`/fedimint/federations/${OTHER}/cap`, { cap_sat: 5 })).status).toBe(404);
  });
});

describe('the view: federations, reconciliation and coverage', () => {
  it("shows each federation with the receiver's balance, the gateway's record, its caps and its top-ups by state, and reconciles them", async () => {
    const g = gateway();
    await g.post('/fedimint/federations', { invite: INVITE_A, max_sat: 40 });
    await g.post('/fedimint/federations', { invite: INVITE_B, cap_sat: 900 });
    // Alpha: two credited, one on its way, one stuck, one given elsewhere first.
    const a = await g.topup(rx.makeNotes(FED, 30_000, { fee_msat: 300 }).notes);
    expect(a.status).toBe(200);
    expect((await g.topup(rx.makeNotes(FED, 10_000, { fee_msat: 100 }).notes, a.body.key)).status).toBe(200);
    const pending = rx.makeNotes(FED, 5_000, { outcome: 'pending', fee_msat: 50 });
    expect((await g.topup(pending.notes, a.body.key)).body.error.code).toBe('topup_pending');
    expect((await g.topup(rx.makeNotes(FED, 7_000, { outcome: 'issuance_failed' }).notes, a.body.key)).body.error.code).toBe('issuance_failed');
    const elsewhere = rx.makeNotes(FED, 4_000, { fee_msat: 40 });
    rx.receivedElsewhere(elsewhere);
    expect((await g.topup(elsewhere.notes, a.body.key)).body.error.code).toBe('token_spent');
    const r = await g.call('/fedimint');
    expect(r.status).toBe(200);
    const v = r.body;
    expect(v).toMatchObject({ enabled: true, defaults: { max_sat: 100_000, cap_sat: 1_000_000 }, receiver: { ok: true, error: null, joined: 2 } });
    const [alpha, beta] = v.federations;
    expect(alpha).toMatchObject({
      id: FED,
      name: 'Alpha',
      state: 'active',
      receives: ['mint'],
      joined: true,
      caps: { max_sat: 40, cap_sat: 1_000_000, max_default: false, cap_default: true },
      // 29,700 + 9,900 credited, plus the 3,960 of the notes given elsewhere first.
      receiver_balance_msat: 43_560,
      gateway: { received_msat: 40_000, credited_msat: 39_600, fees_msat: 400, sent_msat: 0 },
      count: { done: 2, prepared: 1, stuck: 1, rejected: 1 },
      face_msat: { prepared: 5_000, stuck: 7_000 },
      holdings: { used_msat: 43_560 + 5_000 + 7_000, room_sat: 1_000_000 - 56 },
      reconciliation: { status: 'explained', flag: false, expected_msat: 39_600, difference_msat: 3_960, allowance_msat: 16_000 },
    });
    expect(alpha.last_receipt_at).toBeGreaterThan(Date.now() - 60_000);
    expect(beta).toMatchObject({ id: OTHER, receiver_balance_msat: 0, caps: { cap_sat: 900, cap_default: false }, count: { done: 0, prepared: 0, stuck: 0, rejected: 0 }, last_receipt_at: null, reconciliation: { status: 'ok' } });
    expect(v.totals).toMatchObject({ receiver_balance_msat: 43_560, received_msat: 40_000, credited_msat: 39_600, fees_msat: 400, sent_msat: 0, flagged: 0, stuck: 1, prepared: 1 });
    // The stuck and the pending one need the operator, newest first, with no notes text.
    expect(v.attention.map((x: any) => x.status)).toEqual(['stuck', 'prepared']);
    expect(v.attention[1]).toMatchObject({ notes_id: pending.notes_id, federation_id: FED, account_id: a.body.account_id, face_msat: 5_000, status: 'prepared' });
    expect(JSON.stringify(v)).not.toContain(pending.notes);
    // The pending one finishes: the difference is gone and it agrees to the msat once credited.
    rx.finish(pending.notes_id, 'done');
    expect((await g.call('/fedimint')).body.federations[0].reconciliation).toMatchObject({ status: 'explained', difference_msat: 3_960 + 4_950 });
    await g.deps.fedimint!.sweep();
    expect((await g.call('/fedimint')).body.federations[0]).toMatchObject({ gateway: { credited_msat: 44_550 }, reconciliation: { status: 'explained', difference_msat: 3_960, allowance_msat: 11_000 } });
  });

  it('flags a receiver holding less than was credited, or more than explained, and says unknown while it is down', async () => {
    const g = gateway();
    await g.post('/fedimint/federations', { invite: INVITE_A });
    expect((await g.topup(rx.makeNotes(FED, 30_000, { fee_msat: 300 }).notes)).status).toBe(200);
    expect((await g.call('/fedimint')).body.federations[0].reconciliation).toMatchObject({ status: 'ok', difference_msat: 0 });
    rx.federations.get(FED)!.balance_msat -= 1;
    let v = (await g.call('/fedimint')).body;
    expect(v.federations[0].reconciliation).toMatchObject({ status: 'short', flag: true, difference_msat: -1 });
    expect(v.totals.flagged).toBe(1);
    rx.federations.get(FED)!.balance_msat += 2;
    expect((await g.call('/fedimint')).body.federations[0].reconciliation).toMatchObject({ status: 'over', flag: true, difference_msat: 1 });
    rx.down = true;
    v = (await g.call('/fedimint')).body;
    expect(v.receiver).toMatchObject({ ok: false, joined: null });
    expect(v.receiver.error).toMatch(/unreachable_receiver/);
    expect(v.federations[0]).toMatchObject({ joined: null, receiver_balance_msat: null, holdings: { used_msat: null, room_sat: null }, reconciliation: { status: 'unknown', flag: false } });
    expect(v.totals).toMatchObject({ receiver_balance_msat: null, flagged: 0 });
    expect(v.coverage.warnings).toContain('receiver_unknown');
  });

  it('reports a federation the receiver no longer lists as not joined, holding nothing', async () => {
    const g = gateway();
    await g.post('/fedimint/federations', { invite: INVITE_A });
    rx.federations.delete(FED);
    expect((await g.call('/fedimint')).body.federations[0]).toMatchObject({ joined: false, receiver_balance_msat: 0 });
  });

  it('warns that take out can fail when sat balances funded by notes exceed the Cashu sat held, and suggests the rebalance', async () => {
    const g = gateway();
    await g.post('/fedimint/federations', { invite: INVITE_A });
    const t = await g.topup(rx.makeNotes(FED, 80_000, { fee_msat: 0 }).notes);
    expect(t.status).toBe(200);
    let c = (await g.call('/fedimint')).body;
    expect(c.coverage).toMatchObject({ liabilities_msub: 80_000, liabilities_sat: 80, largest_balance_sat: 80, cashu_sat: 0, fedimint_sat: 80, shortfall_sat: 80, largest_short_sat: 80, need_sat: 80 });
    expect(c.coverage.warnings).toEqual(['take_out_short', 'largest_balance_short']);
    expect(c.rebalance).toEqual({ need_sat: 80, suggested_sat: 80, from: [{ federation_id: FED, name: 'Alpha', sat: 80 }], short_after_sat: 0, to_mint: g.deps.funding.mint, possible: false });
    // The take out the warning is about: refused for want of Cashu, nothing taken off the balance.
    const out = await g.app.request(`${ORIGIN}/v1/wallet/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.body.key}` }, body: '{}' });
    expect(out.status).toBe(503);
    expect(((await out.json()) as any).error.code).toBe('wallet_insufficient');
    // Cashu at the trusted mint: 50 sat covers part; a USD balance and a free balance are not counted.
    g.holdCashu(MINT, 50);
    g.deps.ledger.createAccountRaw(newApiKey(), 'usd', null);
    c = (await g.call('/fedimint')).body;
    expect(c.coverage).toMatchObject({ cashu_sat: 50, largest_mint: { mint: MINT, available: 50 }, shortfall_sat: 30, largest_short_sat: 30, need_sat: 30 });
    expect(c.rebalance).toMatchObject({ suggested_sat: 30 });
    g.holdCashu(MINT, 30);
    c = (await g.call('/fedimint')).body;
    expect(c.coverage).toMatchObject({ shortfall_sat: 0, need_sat: 0, warnings: [] });
    expect(c.rebalance).toMatchObject({ need_sat: 0, suggested_sat: 0, from: [] });
    // Payouts owed at that mint come off what it can pay.
    g.deps.db.prepare("INSERT INTO outgoing (id, mint, unit, amount, purpose, status, created_at, updated_at) VALUES ('o1', ?, 'sat', 10, 'refund', 'owed', 0, 0)").run(MINT);
    expect((await g.call('/fedimint')).body.coverage).toMatchObject({ cashu_sat: 70, shortfall_sat: 10, need_sat: 10 });
    // Take out pays whole sat: two balances of 1.999 sat can take out 1 sat each, 2 in all.
    for (let i = 0; i < 2; i++) {
      const k = newApiKey();
      g.deps.ledger.createAccountRaw(k, 'sat', null);
      g.deps.ledger.creditRaw(g.deps.ledger.findByKey(k)!.id, 1_999, 'topup', null);
    }
    expect((await g.call('/fedimint')).body.coverage).toMatchObject({ liabilities_msub: 83_998, liabilities_sat: 82, shortfall_sat: 12 });
  });
});

describe('top-ups that need the operator', () => {
  async function stuckOne(g: ReturnType<typeof gateway>) {
    await g.post('/fedimint/federations', { invite: INVITE_A });
    const n = rx.makeNotes(FED, 7_000, { outcome: 'issuance_failed', fee_msat: 70 });
    const r = await g.topup(n.notes);
    expect(r.body.error.code).toBe('issuance_failed');
    return { n, key: r.body.key as string, account: r.body.account_id as string };
  }

  it('lists them by state, never with the notes', async () => {
    const g = gateway();
    const { n } = await stuckOne(g);
    const done = rx.makeNotes(FED, 1_000, { fee_msat: 0 });
    expect((await g.topup(done.notes)).status).toBe(200);
    expect((await g.call('/fedimint/receipts')).body.data.map((x: any) => x.notes_id)).toEqual([n.notes_id]);
    expect((await g.call('/fedimint/receipts?state=done')).body.data.map((x: any) => x.notes_id)).toEqual([done.notes_id]);
    expect((await g.call('/fedimint/receipts?state=all')).body.data).toHaveLength(2);
    expect((await g.call('/fedimint/receipts?state=nope')).status).toBe(400);
    expect(JSON.stringify((await g.call('/fedimint/receipts?state=all')).body)).not.toContain(n.notes);
  });

  it('Check now finishes one on its way at once, as the sweep would, crediting once', async () => {
    const g = gateway();
    await g.post('/fedimint/federations', { invite: INVITE_A });
    const n = rx.makeNotes(FED, 5_000, { outcome: 'pending', fee_msat: 50 });
    const t = await g.topup(n.notes);
    expect(t.body.error.code).toBe('topup_pending');
    let r: any;
    let lines = await audited(async () => (r = await g.post(`/fedimint/receipts/${n.notes_id}/check`)));
    expect(r.body).toEqual({ notes_id: n.notes_id, status: 'prepared', credited: false, record: { state: 'pending', failure: null, ours: true }, receiver_error: null });
    expect(lines).toEqual([expect.objectContaining({ action: 'fedimint_receipt_check', notes_id: n.notes_id, before: 'prepared', after: 'prepared', credited: false, receiver: 'pending' })]);
    rx.finish(n.notes_id, 'done');
    lines = await audited(async () => (r = await g.post(`/fedimint/receipts/fm:${n.notes_id}/check`)));
    expect(r.body).toMatchObject({ status: 'done', credited: true, record: { state: 'done' } });
    expect(lines[0]).toMatchObject({ before: 'prepared', after: 'done', credited: true });
    expect(g.deps.ledger.findByKey(t.body.key)!.balance_msub).toBe(4_950);
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/check`)).body).toMatchObject({ status: 'done', credited: false });
    expect(g.deps.ledger.findByKey(t.body.key)!.balance_msub).toBe(4_950);
  });

  it('Check now leaves a stuck one stuck while the receiver says it failed, credits it once if the receiver says done, and says when the receiver is down', async () => {
    const g = gateway();
    const { n, key, account } = await stuckOne(g);
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/check`)).body).toMatchObject({ status: 'stuck', credited: false, record: { state: 'failed', failure: 'issuance_failed', ours: true } });
    rx.down = true;
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/check`)).body).toMatchObject({ status: 'stuck', credited: false, record: null, receiver_error: 'unreachable_receiver' });
    rx.down = false;
    // A record that turned done under someone else's key credits nothing.
    const rec = rx.records.get(n.notes_id)!;
    Object.assign(rec, { state: 'done', failure: undefined, key: 'someone-else' });
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/check`)).body).toMatchObject({ status: 'stuck', credited: false, record: { state: 'done', ours: false } });
    rec.key = receiveKey(account);
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/check`)).body).toMatchObject({ status: 'done', credited: true });
    expect(g.deps.ledger.findByKey(key)!.balance_msub).toBe(7_000 - 70);
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/check`)).body).toMatchObject({ status: 'done', credited: false });
    expect(g.deps.ledger.findByKey(key)!.balance_msub).toBe(7_000 - 70);
  });

  it('Check now answers 404 for notes it has no top-up of, and 400 for what is not a notes id', async () => {
    const g = gateway();
    expect((await g.post(`/fedimint/receipts/${'a'.repeat(64)}/check`)).status).toBe(404);
    expect((await g.post('/fedimint/receipts/xyz/check')).status).toBe(400);
  });

  it('Resolve closes a stuck one only on the receiver saying it failed, keeps the note out of the log, and the same notes are refused after', async () => {
    const g = gateway();
    const { n, key } = await stuckOne(g);
    for (const b of [{}, { note: '' }, { note: '   ' }, { note: 'x'.repeat(201) }, { note: 7 }]) expect((await g.post(`/fedimint/receipts/${n.notes_id}/resolve`, b)).status, JSON.stringify(b)).toBe(400);
    rx.down = true;
    const down = await g.post(`/fedimint/receipts/${n.notes_id}/resolve`, { note: 'refunded by hand' });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('fedimint_unavailable');
    rx.down = false;
    const rec = rx.records.get(n.notes_id)!;
    rec.state = 'pending';
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/resolve`, { note: 'refunded by hand' })).body.error.code).toBe('receiver_pending');
    rec.state = 'done';
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/resolve`, { note: 'refunded by hand' })).body.error.code).toBe('receiver_done');
    rx.records.delete(n.notes_id);
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/resolve`, { note: 'refunded by hand' })).body.error.code).toBe('receiver_no_record');
    rx.records.set(n.notes_id, { ...rec, state: 'failed', failure: 'issuance_failed' });
    expect(g.row(n.notes_id).status).toBe('stuck');
    let r: any;
    const lines = await audited(async () => (r = await g.post(`/fedimint/receipts/${n.notes_id}/resolve`, { note: 'refunded 7 sat in Cashu to the person' })));
    expect(r.body).toEqual({ notes_id: n.notes_id, status: 'rejected' });
    expect(lines).toEqual([expect.objectContaining({ action: 'fedimint_receipt_resolve', notes_id: n.notes_id })]);
    expect(JSON.stringify(lines)).not.toContain('refunded 7 sat');
    expect(g.row(n.notes_id)).toMatchObject({ status: 'rejected', error: 'resolved by the operator (issuance_failed): refunded 7 sat in Cashu to the person' });
    // Done for good: not stuck any more, never credited, and the notes sent again are refused.
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/resolve`, { note: 'again' })).body.error.code).toBe('not_stuck');
    const again = await g.topup(n.notes, key);
    expect(again.body.error.code).toBe('token_spent');
    expect(g.deps.ledger.findByKey(key)!.balance_msub).toBe(0);
    expect((await g.call('/fedimint')).body.totals).toMatchObject({ stuck: 0 });
  });

  it('Resolve refuses a top-up that is not stuck, and one it does not know', async () => {
    const g = gateway();
    await g.post('/fedimint/federations', { invite: INVITE_A });
    const n = rx.makeNotes(FED, 1_000, { fee_msat: 0 });
    expect((await g.topup(n.notes)).status).toBe(200);
    expect((await g.post(`/fedimint/receipts/${n.notes_id}/resolve`, { note: 'x' })).body.error.code).toBe('not_stuck');
    expect((await g.post(`/fedimint/receipts/${'b'.repeat(64)}/resolve`, { note: 'x' })).status).toBe(404);
  });
});
