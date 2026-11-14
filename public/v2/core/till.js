// A Fedimint card pays the engine's Lightning invoice through a till (slice A14). The till is
// fedimintcard's `till serve --pay-enabled`; its pay routes are documented in fedimintcard-pay
// docs/PAY.md, POS-LINK.md and TILL-API.md, and this file follows them:
//
//   1. The engine makes a Lightning invoice for the amount (POST /v1/wallet/fund/lightning).
//   2. The price is shown before the tap: the invoice, the fee reserve this phone asks for, the
//      till's margin, and the most a card overpays when its notes cannot make exact change.
//   3. The card is held to the phone. The phone opens the card link (a WebSocket at
//      /v1/card/link) and passes each command the till sends to the card, and the card's answer
//      back. The phone never reads or keeps what the card says.
//   4. POST /v1/pay with X-Card-Link, the invoice, the fee reserve, a client_ref made for this
//      payment and the PIN. The till charges the card, then pays the invoice from its own wallet.
//   5. The engine credits the funds once its invoice is paid; the phone asks it until then.
//
// A failed payment (pay_failed) leaves what the card paid with the till, owed to the card:
// POST /v1/pay/{id}/refund with the same card behind a new card link loads it back.
//
// Money first: each payment is written to this phone's storage, and read back, before anything is
// sent to the till, and it stays until the engine credited the funds or the till gave the card its
// money back. The client_ref is kept with it, so a repeat never charges the card twice. The PIN is
// never stored: it is held only in memory for the tap it was typed for.
//
// The till's address and its pay token live with the Android app (ForgeTill, in the Keystore). This
// file gets a transport that sends a request to the paired till, or opens its card link; it never
// sees the token. Pure apart from the storage and transport it is given; tested in Node.

export const PAY_SCHEME = 'fedimintcard-till-pay:';
/** A till's own pairing code, for its POS phones. Never taken for a pay code. */
export const POS_SCHEME = 'fedimintcard-till:';

/** POST /v1/pay can take up to 120 s at the till (PAY.md: a read timeout of at least 120 s). */
export const PAY_TIMEOUT_MS = 130_000;
/** Other requests to the till. */
export const ASK_TIMEOUT_MS = 20_000;
/** What a card may pay above the price when its notes cannot make exact change (PAY.md). */
export const OVERPAY_MSAT = 2048;
/** The till refuses an invoice with less than 120 s left; a little more is asked here. */
export const MIN_LEFT_MS = 150_000;
/** The till's own cap on the fee reserve when its owner set none (TILL-API.md, --pay-max-fee-msat). */
export const TILL_FEE_CAP_MSAT = 1_000_000;

const STORE = 'forge2.tillpays';
const SETTINGS = 'forge2.till';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const TOKEN = /^[0-9a-f]{64}$/i;

// ------------------------------------------------------------------ pairing

/**
 * Reads the text of the QR code `till pair --scope pay` prints: `fedimintcard-till-pay:<url>?t=<token>`.
 * Returns {ok: true, url, token} or {ok: false, why}:
 *   'pos'      a till's own pairing code for its POS phones (fedimintcard-till:), not a pay code
 *   'insecure' plain http to another computer: the PIN and the token would cross the network in clear
 *   'invalid'  anything else
 * The url is scheme, host and port only, without a trailing slash, as the till makes it.
 */
export function parsePairing(text) {
  const s = String(text ?? '').trim();
  if (s.toLowerCase().startsWith(POS_SCHEME) && !s.toLowerCase().startsWith(PAY_SCHEME)) return { ok: false, why: 'pos' };
  if (!s.toLowerCase().startsWith(PAY_SCHEME)) return { ok: false, why: 'invalid' };
  const rest = s.slice(PAY_SCHEME.length);
  const q = rest.lastIndexOf('?t=');
  if (q < 0) return { ok: false, why: 'invalid' };
  const token = rest.slice(q + 3);
  if (!TOKEN.test(token)) return { ok: false, why: 'invalid' };
  const url = tillUrl(rest.slice(0, q));
  if (!url.ok) return url;
  return { ok: true, url: url.value, token: token.toLowerCase() };
}

/** A till address: https (or http to this computer, for tests), host and port, nothing more. */
export function tillUrl(input) {
  const s = String(input ?? '').trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, why: 'invalid' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'invalid' };
  if (!u.hostname || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return { ok: false, why: 'invalid' };
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(s)) return { ok: false, why: 'invalid' };
  if (u.protocol === 'http:' && !LOOPBACK.test(u.hostname)) return { ok: false, why: 'insecure' };
  return { ok: true, value: `${u.protocol}//${u.host}` };
}

/** The card link's address for a till: http to ws, https to wss (POS-LINK.md). */
export function linkUrl(base) {
  return `${String(base).replace(/^http/i, 'ws').replace(/\/+$/, '')}/v1/card/link`;
}

/** The address the screens show: the host and port, without https://. */
export function tillLabel(base) {
  try {
    const u = new URL(base);
    return (u.protocol === 'https:' ? '' : `${u.protocol}//`) + u.host;
  } catch {
    return String(base ?? '');
  }
}

// ------------------------------------------------------------------ the invoice

const HRP = /^ln(bcrt|bc|tbs|tb|sb)(\d+)?([munp])?$/;
const NETWORK = { bc: 'bitcoin', tb: 'testnet', tbs: 'signet', bcrt: 'regtest', sb: 'simnet' };
// msat per unit of the amount, by multiplier (BOLT 11); none means whole bitcoin.
const MSAT = { '': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };

/** The amount of a BOLT 11 invoice in msat, and its network, or null when it has none or is not one. */
export function readInvoice(bolt11) {
  const s = String(bolt11 ?? '').trim().toLowerCase().replace(/^lightning:/, '');
  const sep = s.lastIndexOf('1');
  if (sep < 4) return null;
  const m = HRP.exec(s.slice(0, sep));
  if (!m || !m[2]) return null;
  const n = BigInt(m[2]);
  let msat;
  if (m[3] === 'p') {
    // A pico amount must be a whole number of tenths of a msat that are whole msat (BOLT 11).
    if (n % 10n) return null;
    msat = n / 10n;
  } else msat = n * MSAT[m[3] ?? ''];
  if (msat <= 0n || msat > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { msat: Number(msat), network: NETWORK[m[1]] };
}

// ------------------------------------------------------------------ the price

/** msat rounded up to whole sats. */
export const ceilSat = (msat) => Math.ceil(msat / 1000) * 1000;

/**
 * The fee reserve this phone asks for: 2 sats and 0.5 percent of the invoice, in whole sats, at most
 * the till's default cap. The till takes all of it (what the Lightning gateway does not use stays
 * with the till, PAY.md). A till that wants more answers fee_reserve_too_low with the gateway's fee,
 * and the price is shown again before the next tap.
 */
export function feeReserveFor(invoiceMsat) {
  return Math.min(TILL_FEE_CAP_MSAT, ceilSat(2000 + Math.ceil((invoiceMsat * 5) / 1000)));
}

/** The till's margin on an invoice, as the till works it out: a fixed part plus basis points. */
export function marginOf(invoiceMsat, margin) {
  const fixed = Math.max(0, Math.floor(Number(margin?.msat) || 0));
  const bps = Math.max(0, Math.floor(Number(margin?.bps) || 0));
  return fixed + Math.floor((invoiceMsat * bps) / 10_000);
}

/**
 * The most the till's margin can be on this invoice: from its settings on this phone, and from what
 * the till took before. A margin is a fixed part plus a share of the invoice, both at least 0, so a
 * margin seen on one invoice bounds it on any other: the same at most for a smaller one, in
 * proportion for a larger one.
 */
export function marginBound(invoiceMsat, { margin, seen = [] } = {}) {
  let most = marginOf(invoiceMsat, margin);
  for (const s of seen) {
    if (!(s?.invoiceMsat > 0) || !(s.marginMsat >= 0)) continue;
    most = Math.max(most, Math.ceil(s.marginMsat * Math.max(1, invoiceMsat / s.invoiceMsat)));
  }
  return most;
}

/**
 * What the card is charged for an invoice, before the tap. The till charges the invoice, the fee
 * reserve (what this phone asks, at most the till's cap) and its margin; a card that cannot make
 * exact change pays up to OVERPAY_MSAT more. mostMsat is the most the card pays; tillMsat the most
 * of it that does not reach the funds.
 */
export function quote({ invoiceMsat, maxFeeMsat, settings }) {
  const margin = marginBound(invoiceMsat, settings);
  const price = invoiceMsat + maxFeeMsat + margin;
  const most = price + OVERPAY_MSAT;
  return { invoiceMsat, feeReserveMsat: maxFeeMsat, marginMsat: margin, priceMsat: price, mostMsat: most, tillMsat: most - invoiceMsat };
}

// ------------------------------------------------------------------ the till's answers

// Refused before the card was touched (PAY.md): nothing moved; fix the input and try again with a
// new client_ref.
const BEFORE = new Set(['bad_request', 'bad_invoice', 'wrong_network', 'invoice_expired', 'over_limit', 'daily_cap', 'invoice_in_use', 'pay_disabled', 'pin_required', 'card_link_required', 'lightning_unavailable', 'fee_reserve_too_low', 'lightning_error', 'conflict']);
// The card refused or was not there, or the till was busy: nothing moved; ask again and resend the
// same client_ref.
const CARD = new Set(['wrong_pin', 'pin_blocked', 'insufficient', 'no_card', 'card_link_gone', 'not_charged', 'card_error', 'card_limit', 'declined', 'busy', 'recovering', 'card_changed', 'unknown_card', 'no_exact_plan', 'ops_unreachable', 'ops_refused', 'ops_not_connected']);
// A card that cannot pay at this till, whatever is tried.
const CARD_FINAL = new Set(['pin_blocked', 'unknown_card']);

const UNSETTLED = new Set(['charging', 'charged', 'paying']);

/** The tries left in a wrong_pin answer ("wrong PIN; 2 tries left before the card blocks"), or null. */
export function triesLeft(detail) {
  const m = /(\d+)\s+tr(?:y|ies)\s+left/i.exec(String(detail ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * What an answer to POST /v1/pay (or a GET of the pay) means for this phone. r is {status, body}, or
 * null when no answer came. Returns {kind, code, state}:
 *   paid       the invoice is paid; the engine credits the funds
 *   undecided  the card paid, or may have; the till is settling it (ask again, never tap again)
 *   pay_failed the card paid and the invoice was certainly not paid: the till owes the card
 *   refunded   what the card paid is back on it
 *   card       the card refused, or was not there; nothing moved; same client_ref, another tap
 *   before     refused before the card was touched; nothing moved; a new client_ref
 *   auth       the till refused the pay token (401, 403): pair again; nothing ran
 *   unknown    no answer, or one that says nothing certain: the payment is kept and asked about
 */
export function readPay(r) {
  if (!r) return { kind: 'unknown', code: 'no_answer' };
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  const code = typeof b.error === 'string' ? b.error : null;
  const state = typeof b.state === 'string' ? b.state : null;
  if (r.status === 401 || r.status === 403) {
    if (code === 'unauthorized' || code === 'forbidden') return { kind: 'auth', code, state };
  }
  if (r.status === 200 && b.ok === true && state) {
    if (state === 'paid') return { kind: 'paid', code: null, state };
    if (state === 'refunded') return { kind: 'refunded', code: null, state };
    if (state === 'pay_failed' || state === 'refunding') return { kind: 'pay_failed', code: null, state };
    if (state === 'not_charged') return { kind: 'card', code: 'not_charged', state };
    if (UNSETTLED.has(state)) return { kind: 'undecided', code: null, state };
    return { kind: 'unknown', code: 'state', state };
  }
  if (r.status === 202 || code === 'undecided') return { kind: 'undecided', code: 'undecided', state };
  if (code === 'pay_failed') return { kind: state === 'refunded' ? 'refunded' : 'pay_failed', code, state };
  // Any answer that says the pay is still being settled is undecided, whatever its code.
  if (state && UNSETTLED.has(state)) return { kind: 'undecided', code, state };
  if (code && BEFORE.has(code)) return { kind: 'before', code, state };
  if (code && CARD.has(code)) return { kind: 'card', code, state, final: CARD_FINAL.has(code) };
  if (state === 'not_charged') return { kind: 'card', code: code ?? 'not_charged', state };
  return { kind: 'unknown', code: code ?? `http_${r.status}`, state };
}

/**
 * What an answer to POST /v1/pay/{id}/refund means. Returns {kind, code}:
 *   refunded   all of it is back on the card
 *   partial    part is on the card; the card needs free slots (spend from it) and another tap
 *   wrong_card another card was held: the card that paid is needed
 *   card_full  the card has no free slot for the refund
 *   card       the card was not there, or the till was busy: tap again
 *   later      the till cannot reach its registry now: try again later
 *   stuck      the till cannot refund this here (card_unknown, no_refund_amount): its owner can help
 *   settled    the pay is not one to refund (it was paid, or is not settled yet): ask the till again
 *   auth       the till refused the pay token
 *   unknown    no answer: try again, a refund load happens at most once
 */
export function readRefund(r) {
  if (!r) return { kind: 'unknown', code: 'no_answer' };
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  const code = typeof b.error === 'string' ? b.error : null;
  if ((r.status === 401 || r.status === 403) && (code === 'unauthorized' || code === 'forbidden')) return { kind: 'auth', code };
  if (r.status === 200 && b.ok === true) {
    if (b.state === 'refunded') return { kind: 'refunded', code: null };
    if (b.state === 'pay_failed') return { kind: 'partial', code: null };
    return { kind: 'unknown', code: 'state' };
  }
  if (code === 'wrong_card') return { kind: 'wrong_card', code };
  if (code === 'card_full') return { kind: 'card_full', code };
  if (code === 'not_refundable') return { kind: 'settled', code };
  if (code === 'card_unknown' || code === 'no_refund_amount') return { kind: 'stuck', code };
  if (code === 'ops_not_connected' || code === 'ops_unreachable' || code === 'ops_refused') return { kind: 'later', code };
  if (code === 'no_card' || code === 'card_link_gone' || code === 'busy' || code === 'recovering' || code === 'card_changed') return { kind: 'card', code };
  return { kind: 'unknown', code: code ?? `http_${r.status}` };
}

// ------------------------------------------------------------------ relaying the card

const hex = (bytes) => Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
function unhex(h) {
  const s = String(h ?? '');
  if (!s || s.length % 2 || !/^[0-9a-f]*$/i.test(s)) return null;
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

/**
 * Answers the till's card commands from the card in the field (POS-LINK.md): each {id, apdu} gets
 * {type: 'rapdu', id, rapdu} with the card's whole answer, or {type: 'lost', id} once the card has
 * gone. A card that failed once is gone for the rest of the link. The bytes are never kept or logged.
 */
export function cardRelay(card) {
  let lost = false;
  return async ({ id, apdu }) => {
    const cmd = unhex(apdu);
    if (lost || !cmd) return { type: 'lost', id };
    try {
      const answer = await card.transceive(cmd);
      if (!answer || answer.length < 2) throw new Error('short answer');
      return { type: 'rapdu', id, rapdu: hex(answer) };
    } catch {
      lost = true;
      return { type: 'lost', id };
    }
  };
}

// ------------------------------------------------------------------ the till's settings on this phone

/**
 * The paired till as the web app keeps it: its address (the token is with the app), its margin as
 * the till's owner set it (0 unless told otherwise, the till's own default), and the margins the till
 * took before, so the price shown is never below what it charges.
 */
export function createTillSettings(storage) {
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(SETTINGS) ?? 'null');
      return v && typeof v.url === 'string' ? { url: v.url, margin: { msat: v.margin?.msat ?? 0, bps: v.margin?.bps ?? 0 }, seen: Array.isArray(v.seen) ? v.seen : [] } : null;
    } catch {
      return null;
    }
  };
  const write = (v) => storage.setItem(SETTINGS, JSON.stringify(v));
  return {
    get: read,
    /** A new pairing: the address only; a new till starts with no margin seen. */
    paired(url) {
      const old = read();
      write(old?.url === url ? old : { url, margin: { msat: 0, bps: 0 }, seen: [] });
    },
    forget: () => storage.setItem(SETTINGS, 'null'),
    setMargin(margin) {
      const v = read();
      if (!v) return;
      v.margin = { msat: Math.max(0, Math.floor(Number(margin?.msat) || 0)), bps: Math.max(0, Math.floor(Number(margin?.bps) || 0)) };
      write(v);
    },
    /** Remembers the margin the till took on an invoice (the five largest by share are kept). */
    learn(invoiceMsat, marginMsat) {
      const v = read();
      if (!v || !(invoiceMsat > 0) || !(marginMsat >= 0)) return;
      const seen = [...v.seen.filter((s) => s.invoiceMsat !== invoiceMsat || s.marginMsat !== marginMsat), { invoiceMsat, marginMsat }];
      seen.sort((a, b) => b.marginMsat / b.invoiceMsat - a.marginMsat / a.invoiceMsat || b.marginMsat - a.marginMsat);
      v.seen = seen.slice(0, 5);
      write(v);
    },
  };
}

// ------------------------------------------------------------------ payments on this phone

export class TillError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

/** The states a payment on this phone can be in. Only 'ready' can be dropped: nothing was sent with it. */
export const STATES = ['ready', 'sent', 'undecided', 'paid', 'pay_failed', 'refunded'];

/**
 * The payments to the engine made with a Fedimint card on this phone.
 *   storage   localStorage in the page, a Map in tests
 *   transport the paired till: request({method, path, link, body, timeoutMs}) -> {status, body}, and
 *             openLink({onApdu}) -> {id, close()}; the app's ForgeTill plugin, or a test double
 *   settings  createTillSettings, for the margins the till took
 */
export function createTillPays({ storage, transport, settings = null, now = () => Date.now(), newRef = () => crypto.randomUUID() }) {
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(STORE) ?? '{}');
      return Array.isArray(v.pays) ? v.pays : [];
    } catch {
      return [];
    }
  };
  const write = (pays) => {
    try {
      storage.setItem(STORE, JSON.stringify({ pays }));
    } catch {
      throw new TillError('not_stored', 'This phone could not store the payment.');
    }
    // A payment that cannot be stored is never sent: read it back to be sure.
    if (JSON.stringify(read()) !== JSON.stringify(pays)) throw new TillError('not_stored', 'This phone could not store the payment.');
  };
  const get = (id) => read().find((p) => p.id === id) ?? null;
  const save = (rec) => {
    rec.updatedAt = now();
    const pays = read();
    const i = pays.findIndex((p) => p.id === rec.id);
    if (i < 0) pays.push(rec);
    else pays[i] = rec;
    write(pays);
    return rec;
  };
  const remove = (id) => write(read().filter((p) => p.id !== id));

  /** Takes what the till said about the pay into the record. */
  const take = (rec, body) => {
    const b = body && typeof body === 'object' ? body : {};
    if (Number.isSafeInteger(b.pay_id)) rec.payId = b.pay_id;
    if (typeof b.short_id === 'string' && /^[0-9a-f]{8}$/i.test(b.short_id)) rec.shortId = b.short_id;
    for (const [k, f] of [
      ['receivedMsat', 'received_msat'],
      ['tillPriceMsat', 'price_msat'],
      ['refundMsat', 'refund_msat'],
      ['refundOwedMsat', 'refund_owed_msat'],
      ['refundDustMsat', 'refund_dust_msat'],
    ])
      if (Number.isSafeInteger(b[f])) rec[k] = b[f];
    if (Number.isSafeInteger(b.margin_msat) && Number.isSafeInteger(b.invoice_msat)) settings?.learn(b.invoice_msat, b.margin_msat);
    rec.detail = typeof b.detail === 'string' ? b.detail.slice(0, 300) : null;
  };

  const ask = (method, path, extra = {}) => transport.request({ method, path, timeoutMs: ASK_TIMEOUT_MS, ...extra }).catch(() => null);

  /** Opens the card link with this card behind it, or throws TillError('link'). */
  async function openLink(card) {
    try {
      return await transport.openLink({ onApdu: cardRelay(card) });
    } catch (e) {
      throw new TillError(e?.code === 'unauthorized' || e?.code === 'forbidden' ? 'auth' : 'link', e?.message);
    }
  }

  /** Applies an answer about the pay (POST /v1/pay or GET /v1/pay/{id}). Returns {kind, code, ...}. */
  function applyPay(rec, r) {
    const out = readPay(r);
    if (r) take(rec, r.body);
    rec.code = out.code;
    switch (out.kind) {
      case 'paid':
      case 'undecided':
      case 'pay_failed':
        rec.state = out.kind;
        break;
      case 'refunded':
        remove(rec.id);
        return { ...out, rec };
      case 'card':
        // Nothing moved: the same client_ref is sent again with the next tap.
        rec.state = 'ready';
        out.triesLeft = out.code === 'wrong_pin' ? triesLeft(rec.detail) : null;
        break;
      case 'before':
        rec.state = 'ready';
        rec.clientRef = newRef();
        if (out.code === 'fee_reserve_too_low' && Number.isSafeInteger(r.body?.gateway_fee_msat)) {
          rec.maxFeeMsat = ceilSat(r.body.gateway_fee_msat);
          Object.assign(rec, priceOf(rec));
          out.kind = 'requote';
        }
        break;
      case 'auth':
        // Nothing ran; a POST sent before stays unknown until the till answers it.
        if (!rec.payId && rec.state === 'sent' && rec.sends <= 1) rec.state = 'ready';
        break;
      default:
        // No answer, or nothing certain: kept, and asked about again (never charged twice).
        if (rec.state === 'ready') rec.state = 'sent';
    }
    save(rec);
    return { ...out, rec };
  }

  const priceOf = (rec) => {
    const q = quote({ invoiceMsat: rec.invoiceMsat, maxFeeMsat: rec.maxFeeMsat, settings: settings?.get() ?? undefined });
    return { priceMsat: q.priceMsat, mostMsat: q.mostMsat, tillMsat: q.tillMsat, marginMsat: q.marginMsat };
  };

  return {
    all: read,
    get,
    /** Payments that wait on the till, the card or the engine (everything but a fresh one). */
    waiting: () => read().filter((p) => p.state !== 'ready'),

    /**
     * A new payment for the engine's invoice, stored before the price is shown. Throws TillError
     * 'no_amount' for an invoice without an amount.
     */
    start({ engine = '', fundingId, bolt11, expiresAt = null, amount, unit, tillUrl: url = null }) {
      const inv = readInvoice(bolt11);
      if (!inv) throw new TillError('no_amount', 'The invoice has no amount.');
      const id = newRef();
      const rec = { id, clientRef: id, engine, fundingId, bolt11, expiresAt, amount, unit, till: url, invoiceMsat: inv.msat, maxFeeMsat: feeReserveFor(inv.msat), state: 'ready', sends: 0, createdAt: now() };
      Object.assign(rec, priceOf(rec));
      return save(rec);
    },

    /** The price again, from the till's settings now (a margin set or learned since). */
    reprice(id) {
      const rec = get(id);
      if (!rec || rec.state !== 'ready') return rec;
      return save(Object.assign(rec, priceOf(rec)));
    },

    /**
     * Pays with the card in the field: opens the card link, then POST /v1/pay with it. pin is the
     * holder's, for this tap only. Returns {kind, code, triesLeft?, rec} (readPay's kinds, plus
     * 'requote' when the till asks a larger fee reserve: the new price is shown before the next tap,
     * and 'expired' when the invoice has too little time left: a new one is needed).
     */
    async pay(id, { card, pin = '' }) {
      const rec = get(id);
      if (!rec) throw new TillError('unknown', 'No such payment.');
      if (rec.state !== 'ready' && rec.state !== 'sent') throw new TillError('not_ready', `This payment is ${rec.state}.`);
      if (rec.state === 'ready' && rec.expiresAt && rec.expiresAt - now() < MIN_LEFT_MS) return { kind: 'expired', code: 'invoice_expired', rec };
      const link = await openLink(card);
      let r;
      try {
        // Saved before the till hears of it: from here the card may pay, so the payment stays.
        rec.state = 'sent';
        rec.sends = (rec.sends ?? 0) + 1;
        save(rec);
        const body = { bolt11: rec.bolt11, max_fee_msat: rec.maxFeeMsat, client_ref: rec.clientRef };
        if (pin) body.pin = pin;
        r = await transport.request({ method: 'POST', path: '/v1/pay', link: link.id, body, timeoutMs: PAY_TIMEOUT_MS }).catch(() => null);
      } finally {
        link.close();
      }
      return applyPay(rec, r);
    },

    /** Asks the till where the pay stands (no card needed). Only once the till has given its id. */
    async check(id) {
      const rec = get(id);
      if (!rec?.payId || rec.state === 'ready') return { kind: 'unknown', code: 'no_pay_id', rec };
      const r = await ask('GET', `/v1/pay/${rec.payId}?client_ref=${encodeURIComponent(rec.clientRef)}`);
      if (!r || r.status === 404) return { kind: 'unknown', code: r ? 'unknown_pay' : 'no_answer', rec };
      // A pay that failed and is not fully refunded stays failed here: GET says refunding while a load
      // is out, and only the refund route finishes it.
      return applyPay(rec, r);
    },

    /**
     * Loads a failed pay back onto the card that paid it: POST /v1/pay/{id}/refund with this card.
     * Returns {kind, code, rec} (readRefund's kinds). 'refunded' removes the payment from the phone.
     */
    async refund(id, { card }) {
      const rec = get(id);
      if (!rec || rec.state !== 'pay_failed' || !rec.payId) throw new TillError('not_failed', 'This payment has nothing to give back.');
      const link = await openLink(card);
      let r;
      try {
        r = await transport.request({ method: 'POST', path: `/v1/pay/${rec.payId}/refund`, link: link.id, timeoutMs: PAY_TIMEOUT_MS }).catch(() => null);
      } finally {
        link.close();
      }
      const out = readRefund(r);
      if (r) take(rec, r.body);
      rec.code = out.code;
      if (out.kind === 'refunded') {
        remove(rec.id);
        return { ...out, rec };
      }
      if (out.kind === 'settled' && r?.body?.state) {
        const again = applyPay(rec, { status: 200, body: { ...r.body, ok: true } });
        return { ...out, rec: again.rec, state: again.kind };
      }
      save(rec);
      return { ...out, rec };
    },

    /**
     * The engine says its invoice was paid and the funds credited. A payment the till still owes the
     * card for (pay_failed) stays until it is refunded; any other is done.
     */
    credited(id) {
      const rec = get(id);
      if (!rec) return null;
      if (rec.state === 'pay_failed') return save(Object.assign(rec, { credited: true }));
      remove(id);
      return null;
    },

    /** Drops a payment nothing was sent with (or the till said nothing moved for). */
    drop(id) {
      const rec = get(id);
      if (!rec) return;
      if (rec.state !== 'ready') throw new TillError('kept', 'This payment may have moved money. It is kept.');
      remove(id);
    },
  };
}
