import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

// A mock of fedimintcard's till (`till serve --pay-enabled`) for the Fedimint card tests (slice A14).
// It implements what fedimintcard-pay docs/PAY.md, POS-LINK.md and TILL-API.md say a phone app sees:
// the pay token and its scope, the card link (a WebSocket that sends card commands to the phone), and
// POST /v1/pay, GET /v1/pay/{id}, POST /v1/pay/{id}/refund with their states and error bodies:
// paid, undecided (settled later), pay_failed and the refund, with partial refunds and the wrong card.
//
// The card commands are this mock's own (a SELECT of the Fedimint card AID, then GET_ID, VERIFY,
// SPEND and LOAD below): the phone only relays bytes it never reads, so the real applet's commands
// are not needed to test the phone. A real till and card are on the not verified list.

const AID = 'f0464d4341524401';
export const APDU = {
  select: `00a4040008${AID}`,
  getId: '8010000004',
  verify: (pin: string) => `80200000${pin.length.toString(16).padStart(2, '0')}${Buffer.from(pin).toString('hex')}`,
  spend: (msat: number) => `8030000008${BigInt(msat).toString(16).padStart(16, '0')}`,
  load: (msat: number) => `8040000008${BigInt(msat).toString(16).padStart(16, '0')}`,
};

/** A Fedimint card as far as the mock till's commands go. */
export class FakeFedimintCard {
  shortId: string;
  pin: string;
  tries: number;
  balanceMsat: number;
  /** How much a load can put on the card (its free slots). */
  roomMsat: number;
  /** False once the card has left the phone: every command fails. */
  present = true;
  /** The INS byte of each command, for the tests. */
  ins: string[] = [];

  constructor({ shortId = '0a1b2c3d', pin = '1234', tries = 3, balanceMsat = 100_000_000, roomMsat = Number.MAX_SAFE_INTEGER } = {}) {
    this.shortId = shortId;
    this.pin = pin;
    this.tries = tries;
    this.balanceMsat = balanceMsat;
    this.roomMsat = roomMsat;
  }

  async transceive(cmd: number[]): Promise<number[]> {
    if (!this.present) throw Object.assign(new Error('The card left the phone.'), { code: 'tag_lost' });
    const h = Buffer.from(cmd).toString('hex');
    this.ins.push(h.slice(2, 4));
    const ok = [0x90, 0x00];
    if (h === APDU.select) return ok;
    if (h === APDU.getId) return [...Buffer.from(this.shortId, 'hex'), ...ok];
    if (h.startsWith('80200000')) {
      if (this.tries === 0) return [0x69, 0x83];
      const pin = Buffer.from(h.slice(10), 'hex').toString();
      if (pin !== this.pin) {
        this.tries -= 1;
        return [0x63, 0xc0 | this.tries];
      }
      this.tries = 3;
      return ok;
    }
    const amount = Number(BigInt(`0x${h.slice(10) || '0'}`));
    if (h.startsWith('80300000')) {
      if (amount > this.balanceMsat) return [0x6a, 0x84];
      this.balanceMsat -= amount;
      return ok;
    }
    if (h.startsWith('80400000')) {
      if (amount > this.roomMsat) return [0x6a, 0x84];
      this.balanceMsat += amount;
      this.roomMsat -= amount;
      return ok;
    }
    return [0x6d, 0x00];
  }
}

type State = 'charging' | 'not_charged' | 'charged' | 'paying' | 'paid' | 'pay_failed' | 'refunding' | 'refunded';
type Outcome = 'paid' | 'pay_failed' | 'undecided';

interface Pay {
  pay_id: number;
  client_ref: string;
  bolt11: string;
  payment_hash: string;
  invoice_msat: number;
  fee_reserve_msat: number;
  margin_msat: number;
  price_msat: number;
  state: State;
  short_id?: string;
  received_msat?: number;
  refund_msat?: number;
  refund_txid?: string;
  detail?: string;
  preimage?: string;
  sale_id?: number;
  created_at_ms: number;
}

interface Link {
  id: string;
  apdu(hex: string): Promise<string>;
  close(): void;
  open: boolean;
}

class Fault extends Error {}

/** The amount of an invoice in msat, from its human-readable part (BOLT 11), or null. */
function invoiceMsat(bolt11: string): number | null {
  const s = bolt11.toLowerCase().replace(/^lightning:/, '');
  const m = /^ln(bcrt|bc|tbs|tb)(\d+)([munp])?1/.exec(s);
  if (!m) return null;
  const n = BigInt(m[2]!);
  const per: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n };
  if (m[3] === 'p') return Number(n / 10n);
  return Number(n * (m[3] ? per[m[3]]! : 100_000_000_000n));
}

const json = (res: ServerResponse, status: number, body: object) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const fail = (status: number, error: string, detail: string, extra: object = {}) => ({ status, body: { ok: false, error, detail, ...extra } });

export class MockTill {
  url = '';
  token = randomBytes(32).toString('hex');
  posToken = randomBytes(32).toString('hex');
  server!: Server;
  // Settings, as `till serve` takes them.
  payEnabled = true;
  requirePin = true;
  marginMsat = 0;
  marginBps = 0;
  maxFeeCapMsat = 1_000_000;
  /** What the Lightning gateway asks to pay an invoice. */
  gatewayFeeMsat = 1000;
  /** What a card pays above the price (its notes could not make exact change). */
  overpayMsat = 0;
  /** Whether the till is on a registry (a refund is a load recorded there). */
  onOps = true;
  /** Outcomes for the next pays the card pays for; 'paid' when empty. */
  next: Outcome[] = [];
  /** Called when the till pays an invoice. */
  onPaid: ((bolt11: string) => void | Promise<void>) | null = null;
  /** Closes the connection without an answer after the next pay's outcome (an answer lost on the way). */
  dropNextAnswer = false;
  pays: Pay[] = [];
  /** Every request, for the tests: method, path, the bearer's scope, X-Card-Link, body. */
  log: { method: string; path: string; scope: string; link: string | null; body: any }[] = [];
  private links = new Map<string, Link>();
  private sockets = new Set<Duplex>();

  pairText(token = this.token) {
    return `fedimintcard-till-pay:${this.url}?t=${token}`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => this.handle(req, res).catch((e) => json(res, 500, { ok: false, error: 'internal', detail: String(e) })));
    this.server.on('upgrade', (req, socket) => this.upgrade(req, socket));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }

  /** Settles a pay the till left undecided, as its sweeper would. */
  async settle(payId: number, outcome: 'paid' | 'pay_failed') {
    const p = this.pays.find((x) => x.pay_id === payId)!;
    if (outcome === 'paid') {
      p.state = 'paid';
      p.preimage = randomBytes(32).toString('hex');
      await this.onPaid?.(p.bolt11);
    } else {
      p.state = 'pay_failed';
      p.detail = 'no route';
    }
  }

  private scope(req: IncomingMessage): 'pay' | 'pos' | null {
    const a = req.headers.authorization ?? '';
    if (a === `Bearer ${this.token}`) return 'pay';
    if (a === `Bearer ${this.posToken}`) return 'pos';
    return null;
  }

  // ---------------------------------------------------------------- HTTP

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = undefined;
    }
    const scope = this.scope(req);
    const link = (req.headers['x-card-link'] as string | undefined) ?? null;
    this.log.push({ method: req.method ?? '', path: u.pathname + u.search, scope: scope ?? 'none', link, body });
    if (!scope) return json(res, 401, { ok: false, error: 'unauthorized' });
    const route = `${req.method} ${u.pathname.replace(/\/\d+(?=\/|$)/, '/{id}')}`;
    const payRoutes = ['POST /v1/pay', 'GET /v1/pay/{id}', 'POST /v1/pay/{id}/refund', 'GET /v1/health'];
    if (scope === 'pay' && !payRoutes.includes(route)) return json(res, 403, { ok: false, error: 'forbidden', detail: 'the pay token opens only the pay routes' });
    if (route === 'GET /v1/health') return json(res, 200, { ok: true });
    if (route === 'GET /v1/pays') return json(res, 200, { count: this.pays.length, pays: this.pays.map((p) => this.record(p, false)) });
    const id = Number(/\/v1\/pay\/(\d+)/.exec(u.pathname)?.[1]);
    let out: { status: number; body: any } | null;
    if (route === 'POST /v1/pay') out = await this.pay(scope, link, body);
    else if (route === 'GET /v1/pay/{id}') {
      const p = this.pays.find((x) => x.pay_id === id);
      out = !p || (scope === 'pay' && u.searchParams.get('client_ref') !== p.client_ref) ? fail(404, 'unknown_pay', 'no such pay') : { status: 200, body: this.record(p, false) };
    } else if (route === 'POST /v1/pay/{id}/refund') out = await this.refund(scope, link, id);
    else out = fail(404, 'not_found', 'no such route');
    if (link) this.links.get(link)?.close();
    if (out === null) return req.socket.destroy();
    json(res, out.status, out.body);
  }

  private record(p: Pay, preimage: boolean) {
    const v: any = {
      ok: true,
      pay_id: p.pay_id,
      client_ref: p.client_ref,
      state: p.state,
      payment_hash: p.payment_hash,
      invoice_msat: p.invoice_msat,
      fee_reserve_msat: p.fee_reserve_msat,
      margin_msat: p.margin_msat,
      price_msat: p.price_msat,
      sale_id: p.sale_id ?? null,
      created_at_ms: p.created_at_ms,
      updated_at_ms: Date.now(),
      invoice_expires_at_ms: p.created_at_ms + 600_000,
    };
    if (p.state === 'paid') {
      v.fee_paid_msat = this.gatewayFeeMsat;
      v.fee_refund_msat = p.fee_reserve_msat - this.gatewayFeeMsat;
      if (preimage) v.preimage = p.preimage;
    }
    if (p.detail) v.detail = p.detail;
    if (p.short_id) v.short_id = p.short_id;
    if (p.received_msat != null) {
      v.received_msat = p.received_msat;
      v.overpaid_msat = p.received_msat - p.price_msat;
    }
    if (p.state === 'refunding' || p.state === 'refunded' || (p.refund_msat ?? 0) > 0) v.refund_msat = p.refund_msat ?? 0;
    if (p.state === 'pay_failed') v.refund_owed_msat = this.owed(p);
    if (p.state === 'refunded') {
      v.refund_dust_msat = this.owed(p);
      v.refund_txid = p.refund_txid;
    }
    return v;
  }

  private owed = (p: Pay) => (p.received_msat ?? 0) - (p.refund_msat ?? 0);

  /** An error answer about a pay, with the pay's fields (TILL-API.md: failures add pay_id, state, ...). */
  private about(r: { status: number; body: any }, p: Pay) {
    Object.assign(r.body, { pay_id: p.pay_id, state: p.state, price_msat: p.price_msat, sale_id: p.sale_id ?? null });
    if (p.short_id) r.body.short_id = p.short_id;
    if (p.received_msat != null) r.body.received_msat = p.received_msat;
    if (p.state === 'pay_failed') {
      r.body.refund_owed_msat = this.owed(p);
      if ((p.refund_msat ?? 0) > 0) r.body.refund_msat = p.refund_msat;
    }
    return r;
  }

  private final(p: Pay) {
    switch (p.state) {
      case 'paid':
        return { status: 200, body: this.record(p, true) };
      case 'pay_failed':
      case 'refunding':
      case 'refunded':
        return this.about(fail(502, 'pay_failed', `the invoice was not paid (${p.detail ?? 'the payment failed'})`), p);
      case 'not_charged':
        return this.about(fail(409, 'not_charged', p.detail ?? 'the card was not charged'), p);
      default:
        return this.about(fail(202, 'undecided', 'the pay is still being settled; nothing was charged or paid again'), p);
    }
  }

  private async pay(scope: string, link: string | null, body: any) {
    if (scope === 'pay' && !link) return fail(400, 'card_link_required', 'a pay token pays only with the card behind its own card link');
    const l = link ? this.links.get(link) : null;
    if (link && !l?.open) return fail(409, 'card_link_gone', 'the card link is unknown or closed');
    if (!this.payEnabled) return fail(503, 'pay_disabled', 'this till does not pay invoices');
    const ref = body?.client_ref;
    if (typeof ref !== 'string' || !ref || ref.length > 124) return fail(400, 'bad_request', 'client_ref is required');
    if (body.pin != null && !/^\d{4,8}$/.test(body.pin)) return fail(400, 'bad_request', 'pin must be 4 to 8 digits');
    const inv = typeof body.bolt11 === 'string' ? invoiceMsat(body.bolt11) : null;
    if (!inv) return fail(400, 'bad_invoice', 'the invoice does not decode, or has no amount');
    const hash = createHash('sha256').update(body.bolt11.toLowerCase()).digest('hex');
    let p = this.pays.find((x) => x.client_ref === ref);
    if (p && p.payment_hash !== hash) return fail(409, 'conflict', 'client_ref was used for another invoice');
    if (p && p.state !== 'not_charged' && p.state !== 'charging') return this.final(p);
    // Every check that guards the card.
    const reserve = Math.min(body.max_fee_msat ?? this.maxFeeCapMsat, this.maxFeeCapMsat);
    const margin = this.marginMsat + Math.floor((inv * this.marginBps) / 10_000);
    const price = inv + reserve + margin;
    if (this.requirePin && !body.pin) return fail(400, 'pin_required', 'this till charges only with the holder\'s PIN');
    if (p && (p.fee_reserve_msat !== reserve || p.price_msat !== price)) return fail(409, 'conflict', 'client_ref was used for another price');
    if (this.pays.some((x) => x !== p && x.payment_hash === hash && x.state !== 'not_charged')) return fail(409, 'invoice_in_use', 'another pay holds this invoice');
    if (this.gatewayFeeMsat > reserve) return fail(400, 'fee_reserve_too_low', 'the gateway asks more than the fee reserve', { gateway_fee_msat: this.gatewayFeeMsat });
    if (!p) {
      p = { pay_id: this.pays.length + 1, client_ref: ref, bolt11: body.bolt11, payment_hash: hash, invoice_msat: inv, fee_reserve_msat: reserve, margin_msat: margin, price_msat: price, state: 'charging', created_at_ms: Date.now() };
      this.pays.push(p);
    }
    p.state = 'charging';
    // The charge: over the card link, the card answering on the phone.
    try {
      if ((await l!.apdu(APDU.select)).slice(-4) !== '9000') throw new Fault();
      const id = await l!.apdu(APDU.getId);
      p.short_id = id.slice(0, 8);
      if (body.pin) {
        const sw = (await l!.apdu(APDU.verify(body.pin))).slice(-4);
        if (sw === '6983') {
          p.state = 'not_charged';
          return this.about(fail(423, 'pin_blocked', "the card's PIN is blocked after too many wrong tries; the card cannot pay"), p);
        }
        if (sw.startsWith('63c')) {
          p.state = 'not_charged';
          const left = parseInt(sw[3]!, 16);
          return this.about(fail(403, 'wrong_pin', `wrong PIN; ${left} tries left before the card blocks`), p);
        }
      }
      const received = price + this.overpayMsat;
      const sw = (await l!.apdu(APDU.spend(received))).slice(-4);
      if (sw === '6a84') {
        p.state = 'not_charged';
        return this.about(fail(402, 'insufficient', "the card's notes do not cover the price"), p);
      }
      p.received_msat = received;
      p.sale_id = p.pay_id;
      p.state = 'charged';
    } catch {
      p.state = 'not_charged';
      return this.about(fail(409, 'no_card', 'card link: the card moved away'), p);
    }
    const outcome = this.next.shift() ?? 'paid';
    if (outcome === 'paid') {
      p.state = 'paid';
      p.preimage = randomBytes(32).toString('hex');
      await this.onPaid?.(p.bolt11);
    } else if (outcome === 'pay_failed') {
      p.state = 'pay_failed';
      p.detail = 'no route';
    } else p.state = 'paying';
    if (this.dropNextAnswer) {
      this.dropNextAnswer = false;
      return null;
    }
    return this.final(p);
  }

  private async refund(scope: string, link: string | null, id: number) {
    if (scope === 'pay' && !link) return fail(400, 'card_link_required', 'a pay token refunds only with the card behind its own card link');
    const l = link ? this.links.get(link) : null;
    if (link && !l?.open) return fail(409, 'card_link_gone', 'the card link is unknown or closed');
    const p = this.pays.find((x) => x.pay_id === id);
    if (!p) return fail(404, 'unknown_pay', 'no such pay');
    if (p.state === 'refunded') return { status: 200, body: this.record(p, false) };
    if (p.state !== 'pay_failed' && p.state !== 'refunding') return this.about(fail(409, 'not_refundable', `only a pay_failed pay is refunded, and pay ${p.pay_id} is ${p.state}`), p);
    if (!p.short_id) return this.about(fail(409, 'card_unknown', 'the till did not record which card paid'), p);
    if (!this.onOps) return this.about(fail(503, 'ops_not_connected', 'a refund is a load recorded in the registry'), p);
    try {
      if ((await l!.apdu(APDU.select)).slice(-4) !== '9000') throw new Fault();
      const card = (await l!.apdu(APDU.getId)).slice(0, 8);
      if (card !== p.short_id) return this.about(fail(409, 'wrong_card', 'the card presented is not the card that paid'), p);
      // Whole notes of 1,000 msat, never more than is owed; less when the card has too little room.
      let load = Math.floor(this.owed(p) / 1000) * 1000;
      while (load > 0 && (await l!.apdu(APDU.load(load))).slice(-4) !== '9000') load = Math.floor(load / 2000) * 1000;
      if (load === 0) return this.about(fail(409, 'card_full', 'the card has no free slot for the refund'), p);
      p.refund_msat = (p.refund_msat ?? 0) + load;
      p.refund_txid = randomBytes(32).toString('hex');
    } catch {
      return this.about(fail(409, 'no_card', 'card link: the card moved away'), p);
    }
    p.state = this.owed(p) < 1000 ? 'refunded' : 'pay_failed';
    return { status: 200, body: this.record(p, false) };
  }

  // ---------------------------------------------------------------- the card link

  private upgrade(req: IncomingMessage, socket: Duplex) {
    const u = new URL(req.url ?? '/', 'http://x');
    const scope = this.scope(req);
    if (u.pathname !== '/v1/card/link' || !scope) {
      socket.end(`HTTP/1.1 ${scope ? 404 : 401} No\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const id = randomBytes(8).toString('hex');
    let seq = 0;
    const waiting = new Map<number, { resolve: (h: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    const send = (text: string) => socket.write(frame(1, Buffer.from(text)));
    const link: Link = {
      id,
      open: true,
      apdu: (hex) =>
        new Promise((resolve, reject) => {
          if (!link.open) return reject(new Fault('closed'));
          const n = ++seq;
          const timer = setTimeout(() => (waiting.delete(n), reject(new Fault('timeout'))), 10_000);
          waiting.set(n, { resolve, reject, timer });
          send(JSON.stringify({ type: 'apdu', id: n, apdu: hex }));
        }),
      close: () => {
        if (!link.open) return;
        end();
        socket.end(frame(8, Buffer.alloc(0)));
      },
    };
    const end = () => {
      link.open = false;
      this.links.delete(id);
      for (const w of waiting.values()) (clearTimeout(w.timer), w.reject(new Fault('closed')));
      waiting.clear();
    };
    this.links.set(id, link);
    let buf = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const f = readFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.size);
        if (f.op === 8) {
          end();
          socket.end();
          return;
        }
        if (f.op !== 1) continue;
        let m: any;
        try {
          m = JSON.parse(f.data.toString());
        } catch {
          continue;
        }
        const w = waiting.get(m.id);
        if (!w) continue;
        waiting.delete(m.id);
        clearTimeout(w.timer);
        if (m.type === 'rapdu' && typeof m.rapdu === 'string') w.resolve(m.rapdu);
        else w.reject(new Fault('lost'));
      }
    });
    socket.on('close', end);
    socket.on('error', end);
    send(JSON.stringify({ type: 'ready', link: id }));
    // The till closes a link after 120 s at most (POS-LINK.md); the tests never get near it.
    setTimeout(() => link.close(), 120_000).unref();
  }
}

function frame(op: number, data: Buffer): Buffer {
  const head = data.length < 126 ? Buffer.from([0x80 | op, data.length]) : Buffer.from([0x80 | op, 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([head, data]);
}

function readFrame(buf: Buffer): { op: number; data: Buffer; size: number } | null {
  if (buf.length < 2) return null;
  const op = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const mask = masked ? buf.subarray(off, off + 4) : null;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  const data = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
  return { op, data, size: off + len };
}
