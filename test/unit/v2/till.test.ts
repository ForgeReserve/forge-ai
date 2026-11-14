import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeFedimintCard, MockTill } from '../../support/mocktill.ts';
import { nodeTill } from '../../support/tillnode.ts';

// A Fedimint card pays the engine's invoice through a till (slice A14, public/v2/core/till.js),
// against a mock till that implements the routes and states of fedimintcard-pay docs/PAY.md,
// POS-LINK.md and TILL-API.md (test/support/mocktill.ts), over real HTTP and a real card link, with a
// fake card behind the phone.
const T: any = await import('../../../public/v2/core/till.js' as string);

function memStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

/** An invoice for `sats` (only its amount is read, by the phone and by the mock till). */
const invoice = (sats: number) => `lnbcrt${sats * 10}n1p${randomBytes(12).toString('hex').replaceAll('1', 'x')}`;
const token = 'ab'.repeat(32);

describe('pairing with a till', () => {
  it('takes the pay code a till shows, and nothing else', () => {
    expect(T.parsePairing(`fedimintcard-till-pay:https://till.example.org?t=${token}`)).toEqual({ ok: true, url: 'https://till.example.org', token });
    expect(T.parsePairing(` fedimintcard-till-pay:https://Till.example.org:9877/?t=${token.toUpperCase()} `)).toEqual({ ok: true, url: 'https://till.example.org:9877', token });
    expect(T.parsePairing(`fedimintcard-till-pay:http://127.0.0.1:9877?t=${token}`).ok).toBe(true);
    // A till's own code for its POS phones opens the whole till.
    expect(T.parsePairing(`fedimintcard-till:http://192.168.1.4:9877?t=${token}`)).toEqual({ ok: false, why: 'pos' });
    // The PIN and the token would cross the network in clear.
    expect(T.parsePairing(`fedimintcard-till-pay:http://192.168.1.4:9877?t=${token}`)).toEqual({ ok: false, why: 'insecure' });
    for (const bad of ['', 'cashuBxyz', `fedimintcard-till-pay:https://till.example.org`, 'fedimintcard-till-pay:https://till.example.org?t=abc', `fedimintcard-till-pay:https://till.example.org/x?t=${token}`, `fedimintcard-till-pay:https://u@till.example.org?t=${token}`, `fedimintcard-till-pay:till.example.org?t=${token}`])
      expect(T.parsePairing(bad), bad).toEqual({ ok: false, why: 'invalid' });
  });

  it('opens the card link on the same host: http to ws, https to wss', () => {
    expect(T.linkUrl('https://till.example.org')).toBe('wss://till.example.org/v1/card/link');
    expect(T.linkUrl('http://127.0.0.1:9877')).toBe('ws://127.0.0.1:9877/v1/card/link');
    expect(T.tillLabel('https://till.example.org')).toBe('till.example.org');
  });
});

describe('the price before the tap', () => {
  it('reads the amount of an invoice', () => {
    // The example invoice of BOLT 11: 2500 micro-bitcoin.
    expect(T.readInvoice('lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs')).toEqual({ msat: 250_000_000, network: 'bitcoin' });
    expect(T.readInvoice('LIGHTNING:lnbcrt10n1pqqq')).toEqual({ msat: 1000, network: 'regtest' });
    expect(T.readInvoice('lntb20m1pqqq')).toEqual({ msat: 2_000_000_000, network: 'testnet' });
    expect(T.readInvoice('lnbc10p1pqqq')).toEqual({ msat: 1, network: 'bitcoin' });
    expect(T.readInvoice('lnbc1p1pqqq')).toBeNull(); // a pico amount that is not whole msat
    expect(T.readInvoice('lnbc1pvjluez')).toBeNull(); // no amount
    expect(T.readInvoice('cashuBxyz')).toBeNull();
  });

  it('asks a fee reserve of 2 sats and 0.5 percent, in whole sats, at most the till cap', () => {
    expect(T.feeReserveFor(5_000_000)).toBe(27_000);
    expect(T.feeReserveFor(1000)).toBe(3000);
    expect(T.feeReserveFor(10_000_000_000)).toBe(1_000_000);
  });

  it('works out the till margin as the till does, and never shows less than a margin it took', () => {
    expect(T.marginOf(1_000_000, { msat: 500, bps: 100 })).toBe(10_500);
    expect(T.marginOf(1_000_000, null)).toBe(0);
    // Seen: 2,000 msat on a 1,000,000 msat invoice. A larger invoice is bounded in proportion, a smaller one by the same.
    const seen = [{ invoiceMsat: 1_000_000, marginMsat: 2000 }];
    expect(T.marginBound(2_000_000, { margin: { msat: 0, bps: 0 }, seen })).toBe(4000);
    expect(T.marginBound(500_000, { margin: { msat: 0, bps: 0 }, seen })).toBe(2000);
    expect(T.marginBound(500_000, { margin: { msat: 9000, bps: 0 }, seen })).toBe(9000);
  });

  it('shows the most the card pays: invoice, fee reserve, margin and the overpay a card can make', () => {
    const q = T.quote({ invoiceMsat: 5_000_000, maxFeeMsat: 27_000, settings: { margin: { msat: 1000, bps: 0 }, seen: [] } });
    expect(q).toEqual({ invoiceMsat: 5_000_000, feeReserveMsat: 27_000, marginMsat: 1000, priceMsat: 5_028_000, mostMsat: 5_030_048, tillMsat: 30_048 });
  });
});

describe('what the till answers', () => {
  const r = (status: number, body: object) => T.readPay({ status, body });

  it('reads every outcome of POST /v1/pay as PAY.md gives them', () => {
    expect(r(200, { ok: true, state: 'paid' }).kind).toBe('paid');
    expect(r(202, { ok: false, error: 'undecided', state: 'paying' }).kind).toBe('undecided');
    expect(r(502, { ok: false, error: 'pay_failed', state: 'pay_failed' }).kind).toBe('pay_failed');
    expect(r(502, { ok: false, error: 'pay_failed', state: 'refunded' }).kind).toBe('refunded');
    for (const code of ['bad_invoice', 'wrong_network', 'invoice_expired', 'over_limit', 'daily_cap', 'invoice_in_use', 'pay_disabled', 'pin_required', 'card_link_required', 'lightning_unavailable', 'fee_reserve_too_low', 'bad_request', 'lightning_error', 'conflict'])
      expect(r(400, { ok: false, error: code }).kind, code).toBe('before');
    for (const code of ['wrong_pin', 'insufficient', 'no_card', 'card_link_gone', 'not_charged', 'busy', 'card_limit'])
      expect(r(409, { ok: false, error: code, state: 'not_charged' }).kind, code).toBe('card');
    expect(r(423, { ok: false, error: 'pin_blocked', state: 'not_charged' })).toMatchObject({ kind: 'card', final: true });
    expect(r(401, { ok: false, error: 'unauthorized' }).kind).toBe('auth');
    expect(r(403, { ok: false, error: 'forbidden' }).kind).toBe('auth');
    // A card error from a charge that is still settling is undecided, never another tap.
    expect(r(502, { ok: false, error: 'card_error', state: 'charged' }).kind).toBe('undecided');
    // Nothing certain: kept and asked about again.
    expect(r(500, { ok: false, error: 'internal' }).kind).toBe('unknown');
    expect(T.readPay(null).kind).toBe('unknown');
    // The record GET /v1/pay/{id} gives.
    expect(r(200, { ok: true, state: 'charging' }).kind).toBe('undecided');
    expect(r(200, { ok: true, state: 'refunding' }).kind).toBe('pay_failed');
    expect(r(200, { ok: true, state: 'not_charged' }).kind).toBe('card');
    expect(T.triesLeft('wrong PIN; 2 tries left before the card blocks')).toBe(2);
    expect(T.triesLeft('wrong PIN; 1 try left')).toBe(1);
  });

  it('reads every outcome of a refund', () => {
    const f = (status: number, body: object) => T.readRefund({ status, body }).kind;
    expect(f(200, { ok: true, state: 'refunded' })).toBe('refunded');
    expect(f(200, { ok: true, state: 'pay_failed', refund_owed_msat: 5000 })).toBe('partial');
    expect(f(409, { error: 'wrong_card' })).toBe('wrong_card');
    expect(f(409, { error: 'card_full' })).toBe('card_full');
    expect(f(409, { error: 'not_refundable' })).toBe('settled');
    expect(f(409, { error: 'card_unknown' })).toBe('stuck');
    expect(f(422, { error: 'no_refund_amount' })).toBe('stuck');
    expect(f(503, { error: 'ops_not_connected' })).toBe('later');
    expect(f(409, { error: 'no_card' })).toBe('card');
    expect(T.readRefund(null).kind).toBe('unknown');
  });

  it('relays the till commands to the card, and says lost once the card is gone', async () => {
    const card = new FakeFedimintCard();
    const relay = T.cardRelay(card);
    expect(await relay({ id: 1, apdu: '00a4040008f0464d4341524401' })).toEqual({ type: 'rapdu', id: 1, rapdu: '9000' });
    card.present = false;
    expect(await relay({ id: 2, apdu: '8010000004' })).toEqual({ type: 'lost', id: 2 });
    card.present = true;
    // Gone for the rest of the link, even if the card answers again.
    expect(await relay({ id: 3, apdu: '8010000004' })).toEqual({ type: 'lost', id: 3 });
    expect(await T.cardRelay(card)({ id: 4, apdu: 'zz' })).toEqual({ type: 'lost', id: 4 });
  });
});

describe('paying through a till', () => {
  let till: MockTill;
  beforeAll(async () => {
    till = await new MockTill().start();
  });
  afterAll(() => till.close());

  let storage: ReturnType<typeof memStorage>;
  let transport: ReturnType<typeof nodeTill>;
  let settings: any;
  let pays: any;
  let card: FakeFedimintCard;
  beforeEach(async () => {
    Object.assign(till, { next: [], requirePin: true, marginMsat: 0, marginBps: 0, gatewayFeeMsat: 1000, overpayMsat: 0, onOps: true, dropNextAnswer: false, onPaid: null, payEnabled: true, maxFeeCapMsat: 1_000_000 });
    till.log = [];
    storage = memStorage();
    transport = nodeTill();
    await transport.pair(till.pairText());
    settings = T.createTillSettings(storage);
    settings.paired(till.url);
    pays = T.createTillPays({ storage, transport, settings });
    card = new FakeFedimintCard({ balanceMsat: 20_000_000 });
  });

  const start = (sats = 5000) => pays.start({ engine: '', fundingId: 'fund_1', bolt11: invoice(sats), expiresAt: Date.now() + 600_000, amount: sats, unit: 'sat' });

  it('pays: the card is charged the price over its link, the invoice is paid, and the funds end it', async () => {
    const paid: string[] = [];
    till.onPaid = (b) => void paid.push(b);
    const rec = start();
    expect(rec).toMatchObject({ state: 'ready', invoiceMsat: 5_000_000, maxFeeMsat: 27_000, priceMsat: 5_027_000, mostMsat: 5_029_048 });
    const out = await pays.pay(rec.id, { card, pin: '1234' });
    expect(out.kind).toBe('paid');
    expect(out.rec).toMatchObject({ state: 'paid', payId: 1, shortId: '0a1b2c3d', receivedMsat: 5_027_000 });
    expect(paid).toEqual([rec.bolt11]);
    expect(card.balanceMsat).toBe(20_000_000 - 5_027_000);
    // POST /v1/pay with the card link, the invoice, the fee reserve, the client_ref and the PIN.
    const post = till.log.find((l) => l.path === '/v1/pay')!;
    expect(post).toMatchObject({ method: 'POST', scope: 'pay', body: { bolt11: rec.bolt11, max_fee_msat: 27_000, client_ref: rec.clientRef, pin: '1234' } });
    expect(post.link).toMatch(/^[0-9a-f]{16}$/);
    // The PIN is never stored on the phone.
    expect([...storage.m.values()].join('')).not.toContain('1234');
    expect(pays.waiting().map((p: any) => p.id)).toEqual([rec.id]);
    pays.credited(rec.id);
    expect(pays.all()).toEqual([]);
  });

  it('a wrong PIN: nothing moved, the tries left, and the same client_ref with the next PIN', async () => {
    const rec = start();
    const wrong = await pays.pay(rec.id, { card, pin: '9999' });
    expect(wrong).toMatchObject({ kind: 'card', code: 'wrong_pin', triesLeft: 2 });
    expect(wrong.rec).toMatchObject({ state: 'ready', clientRef: rec.clientRef });
    expect(card.balanceMsat).toBe(20_000_000);
    const ok = await pays.pay(rec.id, { card, pin: '1234' });
    expect(ok.kind).toBe('paid');
    expect(till.log.filter((l) => l.path === '/v1/pay').map((l) => l.body.client_ref)).toEqual([rec.clientRef, rec.clientRef]);
    expect(card.balanceMsat).toBe(20_000_000 - 5_027_000);
  });

  it('a till that needs the PIN says so before the card is touched', async () => {
    const rec = start();
    const out = await pays.pay(rec.id, { card, pin: '' });
    expect(out).toMatchObject({ kind: 'before', code: 'pin_required' });
    // A new client_ref for the next try (PAY.md), and the card never saw a command.
    expect(out.rec.clientRef).not.toBe(rec.clientRef);
    expect(card.ins).toEqual([]);
  });

  it('a card taken away: no_card, nothing moved, and the next tap goes on with the same client_ref', async () => {
    const rec = start();
    card.present = false;
    const out = await pays.pay(rec.id, { card, pin: '1234' });
    expect(out).toMatchObject({ kind: 'card', code: 'no_card' });
    expect(out.rec.state).toBe('ready');
    card.present = true;
    expect((await pays.pay(rec.id, { card, pin: '1234' })).kind).toBe('paid');
  });

  it('undecided: the card paid, the phone asks the till until it settles, and never taps again', async () => {
    till.next = ['undecided'];
    const rec = start();
    const out = await pays.pay(rec.id, { card, pin: '1234' });
    expect(out.kind).toBe('undecided');
    expect((await pays.check(rec.id)).kind).toBe('undecided');
    await till.settle(out.rec.payId, 'paid');
    const now = await pays.check(rec.id);
    expect(now.kind).toBe('paid');
    // GET /v1/pay/{id} with the pay's own client_ref, as the pay token requires.
    const get = `/v1/pay/${out.rec.payId}?client_ref=${rec.clientRef}`;
    expect(till.log.filter((l) => l.method === 'GET').map((l) => l.path)).toEqual([get, get]);
    expect(till.log.filter((l) => l.path === '/v1/pay')).toHaveLength(1);
    expect(card.balanceMsat).toBe(20_000_000 - 5_027_000);
  });

  it('pay_failed: the till holds what the card paid, and gives it back to that card, in parts when it is full', async () => {
    till.next = ['pay_failed'];
    till.overpayMsat = 1500;
    const rec = start();
    const out = await pays.pay(rec.id, { card, pin: '1234' });
    expect(out.kind).toBe('pay_failed');
    expect(out.rec).toMatchObject({ state: 'pay_failed', receivedMsat: 5_028_500, refundOwedMsat: 5_028_500, shortId: '0a1b2c3d' });
    // Another card is refused, and nothing is loaded.
    const other = new FakeFedimintCard({ shortId: 'ffffffff' });
    expect((await pays.refund(rec.id, { card: other })).kind).toBe('wrong_card');
    // A card with little room takes part, and is owed the rest.
    card.roomMsat = 3_000_000;
    const part = await pays.refund(rec.id, { card });
    expect(part.kind).toBe('partial');
    expect(part.rec.refundOwedMsat).toBeGreaterThan(0);
    expect(pays.get(rec.id).state).toBe('pay_failed');
    card.roomMsat = Number.MAX_SAFE_INTEGER;
    const done = await pays.refund(rec.id, { card });
    expect(done.kind).toBe('refunded');
    // Back to the last whole note; the dust under one note stays with the till.
    expect(card.balanceMsat).toBe(20_000_000 - 500);
    expect(pays.all()).toEqual([]);
  });

  it('a failed pay the engine somehow credited still waits for its refund', async () => {
    till.next = ['pay_failed'];
    const rec = start();
    await pays.pay(rec.id, { card, pin: '1234' });
    pays.credited(rec.id);
    expect(pays.get(rec.id)).toMatchObject({ state: 'pay_failed', credited: true });
  });

  it('a till that asks a larger fee reserve: a new price before the next tap, and nothing charged', async () => {
    till.gatewayFeeMsat = 40_500;
    const rec = start();
    const out = await pays.pay(rec.id, { card, pin: '1234' });
    expect(out).toMatchObject({ kind: 'requote', code: 'fee_reserve_too_low' });
    expect(out.rec).toMatchObject({ state: 'ready', maxFeeMsat: 41_000, priceMsat: 5_041_000 });
    expect(out.rec.clientRef).not.toBe(rec.clientRef);
    expect(card.balanceMsat).toBe(20_000_000);
    expect((await pays.pay(rec.id, { card, pin: '1234' })).kind).toBe('paid');
    expect(card.balanceMsat).toBe(20_000_000 - 5_041_000);
  });

  it('an answer lost on the way: kept as sent, and the same request replays it without a second charge', async () => {
    till.dropNextAnswer = true;
    const rec = start();
    const out = await pays.pay(rec.id, { card, pin: '1234' });
    expect(out.kind).toBe('unknown');
    expect(out.rec.state).toBe('sent');
    expect(() => pays.drop(rec.id)).toThrow(/kept/);
    // A phone opened again later sees it (it is stored), and finishes it with the next tap.
    const again = T.createTillPays({ storage, transport, settings });
    expect(again.waiting().map((p: any) => p.state)).toEqual(['sent']);
    const replay = await again.pay(rec.id, { card, pin: '1234' });
    expect(replay.kind).toBe('paid');
    expect(card.balanceMsat).toBe(20_000_000 - 5_027_000);
  });

  it('an unanswered pay stays sent through refusals the till gives before it looks up the client_ref', async () => {
    till.dropNextAnswer = true;
    const rec = start();
    const first = await pays.pay(rec.id, { card, pin: '1234' });
    expect(first.kind).toBe('unknown');
    // The card was charged; the phone never heard.
    expect(card.balanceMsat).toBe(20_000_000 - 5_027_000);
    // The next tap: the card link drops before the POST lands, and the till answers card_link_gone.
    const deadLink = {
      ...transport,
      openLink: async (o: any) => {
        (await transport.openLink(o)).close();
        return { id: 'deadbeefdeadbeef', close() {} };
      },
    };
    const gone = await T.createTillPays({ storage, transport: deadLink, settings }).pay(rec.id, { card, pin: '1234' });
    expect(gone).toMatchObject({ kind: 'card', code: 'card_link_gone' });
    expect(gone.rec).toMatchObject({ state: 'sent', clientRef: rec.clientRef });
    expect(pays.get(rec.id)).toMatchObject({ state: 'sent', clientRef: rec.clientRef });
    expect(() => pays.drop(rec.id)).toThrow(/kept/);
    // And pay switched off at the till: still sent, the same client_ref (no new one).
    till.payEnabled = false;
    const off = await pays.pay(rec.id, { card, pin: '1234' });
    expect(off).toMatchObject({ kind: 'before', code: 'pay_disabled' });
    expect(off.rec).toMatchObject({ state: 'sent', clientRef: rec.clientRef });
    expect(() => pays.drop(rec.id)).toThrow(/kept/);
    // The third tap replays the pay the till holds: paid, with the one charge.
    till.payEnabled = true;
    const third = await pays.pay(rec.id, { card, pin: '1234' });
    expect(third.kind).toBe('paid');
    expect(card.balanceMsat).toBe(20_000_000 - 5_027_000);
    expect(new Set(till.log.filter((l) => l.path === '/v1/pay').map((l) => l.body.client_ref))).toEqual(new Set([rec.clientRef]));
    expect(till.pays.filter((p) => p.client_ref === rec.clientRef)).toHaveLength(1);
  });

  it('a till whose fee cap is below the gateway fee: one new price, then no endless requote', async () => {
    till.maxFeeCapMsat = 30_000;
    till.gatewayFeeMsat = 40_500;
    const rec = start();
    const first = await pays.pay(rec.id, { card, pin: '1234' });
    expect(first).toMatchObject({ kind: 'requote', code: 'fee_reserve_too_low' });
    expect(first.rec.maxFeeMsat).toBe(41_000);
    // The till caps 41,000 at 30,000 and asks the same fee again: nothing new to ask for.
    const second = await pays.pay(rec.id, { card, pin: '1234' });
    expect(second).toMatchObject({ kind: 'before', code: 'fee_reserve_too_low' });
    expect(second.rec).toMatchObject({ state: 'ready', maxFeeMsat: 41_000, priceMsat: first.rec.priceMsat });
    expect(card.balanceMsat).toBe(20_000_000);
  });

  it('a payment made through one till is never sent to another', async () => {
    till.next = ['pay_failed'];
    const failed = pays.start({ engine: '', fundingId: 'fund_1', bolt11: invoice(5000), expiresAt: Date.now() + 600_000, amount: 5000, unit: 'sat', tillUrl: till.url });
    expect((await pays.pay(failed.id, { card, pin: '1234' })).kind).toBe('pay_failed');
    const fresh = pays.start({ engine: '', fundingId: 'fund_2', bolt11: invoice(100), expiresAt: Date.now() + 600_000, amount: 100, unit: 'sat', tillUrl: till.url });
    settings.paired('https://other.example.org');
    const before = till.log.length;
    await expect(pays.pay(fresh.id, { card, pin: '1234' })).rejects.toMatchObject({ code: 'other_till' });
    await expect(pays.check(failed.id)).rejects.toMatchObject({ code: 'other_till' });
    await expect(pays.refund(failed.id, { card })).rejects.toMatchObject({ code: 'other_till' });
    expect(till.log.length).toBe(before);
    // Forgotten: no till at all.
    settings.forget();
    await expect(pays.check(failed.id)).rejects.toMatchObject({ code: 'other_till' });
    // Back with its own till, the refund goes through.
    settings.paired(till.url);
    expect((await pays.refund(failed.id, { card })).kind).toBe('refunded');
  });

  it('an answer that cannot be stored after the request: not_stored_after, kept as sent, and the next tap finishes it', async () => {
    // Storage fills up once the 'sent' write is done and the POST is on its way (the first one only).
    let full = false;
    let posts = 0;
    const flaky = { getItem: storage.getItem, setItem: (k: string, v: string) => { if (full) throw new Error('full'); storage.setItem(k, v); } };
    const tx = { ...transport, request: (r: any) => { if (r.path === '/v1/pay' && ++posts === 1) full = true; return transport.request(r); } };
    const p5 = T.createTillPays({ storage: flaky, transport: tx, settings });
    const rec = start();
    await expect(p5.pay(rec.id, { card, pin: '1234' })).rejects.toMatchObject({ code: 'not_stored_after' });
    expect(till.log.filter((l) => l.path === '/v1/pay')).toHaveLength(1);
    expect(pays.get(rec.id).state).toBe('sent');
    expect(() => pays.drop(rec.id)).toThrow(/kept/);
    full = false;
    expect((await p5.pay(rec.id, { card, pin: '1234' })).kind).toBe('paid');
    expect(card.balanceMsat).toBe(20_000_000 - 5_027_000);
  });

  it('says whether the till margin is known: saved here, or seen in an answer', async () => {
    const rec = start();
    expect(rec.marginKnown).toBe(false);
    settings.setMargin({ msat: 0, bps: 0 });
    expect(pays.reprice(rec.id).marginKnown).toBe(true);
    // The saved flag stays with the stored settings, and get() shows the margin alone.
    expect(settings.get().margin).toEqual({ msat: 0, bps: 0 });
    settings.paired(till.url);
    expect(settings.marginKnown()).toBe(true);
    // A new till starts unknown, and learns it from the till's first answer.
    settings.paired('https://other.example.org');
    settings.paired(till.url);
    expect(settings.marginKnown()).toBe(false);
    const next = start();
    expect(next.marginKnown).toBe(false);
    await pays.pay(next.id, { card, pin: '1234' });
    expect(settings.marginKnown()).toBe(true);
    expect(start().marginKnown).toBe(true);
  });

  it('learns the till margin from its answers, so the next price includes it', async () => {
    till.marginMsat = 3000;
    const rec = start();
    expect(rec.marginMsat).toBe(0);
    const out = await pays.pay(rec.id, { card, pin: '1234' });
    expect(out.rec.tillPriceMsat).toBe(5_030_000);
    expect(settings.get().seen).toEqual([{ invoiceMsat: 5_000_000, marginMsat: 3000 }]);
    const next = start();
    expect(next.marginMsat).toBe(3000);
    expect(next.priceMsat).toBe(5_030_000);
  });

  it('nothing is sent when the payment cannot be stored first', async () => {
    const broken = { getItem: storage.getItem, setItem: () => { throw new Error('full'); } };
    const p2 = T.createTillPays({ storage: broken, transport, settings });
    expect(() => p2.start({ engine: '', fundingId: 'f', bolt11: invoice(10), amount: 10, unit: 'sat' })).toThrow(/could not store/);
    // And when the write of 'sent' fails, the till never hears of it.
    const rec = start();
    const flaky = { getItem: storage.getItem, setItem: () => { throw new Error('full'); } };
    const p3 = T.createTillPays({ storage: flaky, transport, settings });
    await expect(p3.pay(rec.id, { card, pin: '1234' })).rejects.toMatchObject({ code: 'not_stored' });
    expect(till.log.filter((l) => l.path === '/v1/pay')).toEqual([]);
  });

  it('an invoice about to run out is not sent: a new one is needed', async () => {
    const rec = pays.start({ engine: '', fundingId: 'f', bolt11: invoice(100), expiresAt: Date.now() + 60_000, amount: 100, unit: 'sat' });
    expect((await pays.pay(rec.id, { card, pin: '1234' })).kind).toBe('expired');
    expect(till.log).toEqual([]);
  });

  it('a pay token the till does not know: nothing ran, pair again', async () => {
    const bad = nodeTill();
    await bad.pair(till.pairText('cd'.repeat(32)));
    const p4 = T.createTillPays({ storage, transport: bad, settings });
    const rec = start();
    await expect(p4.pay(rec.id, { card, pin: '1234' })).rejects.toMatchObject({ code: 'auth' });
    expect(p4.get(rec.id).state).toBe('ready');
  });

  it('the mock holds the pay token to its scope, as the till does', async () => {
    const r = await fetch(`${till.url}/v1/pays`, { headers: { authorization: `Bearer ${till.token}` } });
    expect(r.status).toBe(403);
    const noLink = await fetch(`${till.url}/v1/pay`, { method: 'POST', headers: { authorization: `Bearer ${till.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect((await noLink.json()).error).toBe('card_link_required');
    // GET of a pay with another client_ref is no pay at all.
    const rec = start();
    await pays.pay(rec.id, { card, pin: '1234' });
    const other = await fetch(`${till.url}/v1/pay/${pays.get(rec.id).payId}?client_ref=nope`, { headers: { authorization: `Bearer ${till.token}` } });
    expect(other.status).toBe(404);
  });
});

describe('the till settings on this phone', () => {
  it('keep the address and the margin, start over for a new till, and are forgotten', () => {
    const s = T.createTillSettings(memStorage());
    expect(s.get()).toBeNull();
    s.paired('https://till.example.org');
    s.setMargin({ msat: 2000, bps: 50 });
    s.learn(1_000_000, 7000);
    s.paired('https://till.example.org');
    expect(s.get()).toEqual({ url: 'https://till.example.org', margin: { msat: 2000, bps: 50 }, seen: [{ invoiceMsat: 1_000_000, marginMsat: 7000 }] });
    s.paired('https://other.example.org');
    expect(s.get()).toEqual({ url: 'https://other.example.org', margin: { msat: 0, bps: 0 }, seen: [] });
    s.forget();
    expect(s.get()).toBeNull();
  });
});
