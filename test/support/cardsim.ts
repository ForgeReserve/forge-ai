import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

// A simulated Cashu card, protocol 2 (cashu-javacard spec/APDU.md), for the tests: the commands Forge
// sends, answered as the applet answers them, with its own key, PIN counter, slots, change openings
// and the one SIG_ALL signature. Written from the spec with noble directly, not from the app's code, so
// the tests hold two implementations to each other. It also breaks a tap on purpose: the card leaves
// the field before a command reaches it, or after the card acted and before its answer came back.
//
// Not covered: limits and the clock (SET_HEADER, the daily limit, the no-PIN allowance), the owner's
// commands, the DLEQ store and the NFC tag application.

const Point = secp256k1.Point;
const enc = new TextEncoder();
const hex = (b: Uint8Array | number[]) => bytesToHex(Uint8Array.from(b));
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const readU32 = (b: number[], at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const sw = (code: number, data: number[] = []) => [...data, code >> 8, code & 0xff];
const OK = 0x9000;

export const APPLET_AID = [0xf0, 0x43, 0x41, 0x53, 0x48, 0x55, 0x43, 0x41, 0x52, 0x44, 0x01];

export function hashToCurve(secret: string) {
  const domain = enc.encode('Secp256k1_HashToCurve_Cashu_');
  const msg = sha256(new Uint8Array([...domain, ...enc.encode(secret)]));
  for (let i = 0; i < 65536; i++) {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, i, true);
    try {
      return Point.fromBytes(new Uint8Array([2, ...sha256(new Uint8Array([...msg, ...c]))]));
    } catch {
      /* next counter */
    }
  }
  throw new Error('hash_to_curve failed');
}

export function cardSecret(nonce: string, key: string, date = 0, refund: string | null = null) {
  const date0 = date ? `["locktime","${date}"],["refund","${refund}"],` : '';
  return `["P2PK",{"nonce":"${nonce}","data":"${key}","tags":[${date0}["sigflag","SIG_ALL"]]}]`;
}

export interface SimPiece {
  /** The keyset as the card stores it: 16 hex chars (the first 8 bytes of a v2 id). */
  keysetId: string;
  amount: number;
  nonce: string;
  C: string;
  date: number;
}

interface Slot extends SimPiece {
  status: 1 | 2;
}

interface Opening {
  amount: number;
  keysetId: string;
  date: number;
  nonce: string;
  r: bigint;
  B_: string;
}

/** Where a tap breaks: before the command reaches the card, or after the card acted (the answer is lost). */
export type Break = { ins: number; when: 'before' | 'after'; times?: number };

export class TagLostError extends Error {
  constructor() {
    super('Tag was lost.');
    this.name = 'TagLostError';
  }
}

export class CardSim {
  readonly priv: Uint8Array;
  readonly pubkey: string;
  pin: string | null;
  tries = 3;
  blocked = false;
  mint: string;
  unit = 0;
  refundKey: string | null;
  slots: (Slot | null)[] = Array(128).fill(null);
  openings: Opening[] = [];
  /** Every APDU, as hex, and its status word: the exchange as a reader saw it. */
  readonly log: { apdu: string; sw: string }[] = [];
  present = true;
  breaks: Break[] = [];
  private pinOk = false;
  private payment: { slots: number[]; sum: number; outputs: { amount: number; B_: string }[]; change: number } | null = null;
  private lastSig: number[] | null = null;
  private paidThisTap = false;
  private changeGrant = false;
  private paidLastTap = false;

  constructor({ priv, pin = '1234', mint = 'http://127.0.0.1:3338', refundKey = null }: { priv?: Uint8Array; pin?: string | null; mint?: string; refundKey?: string | null } = {}) {
    this.priv = priv ?? secp256k1.utils.randomSecretKey();
    this.pubkey = hex(secp256k1.getPublicKey(this.priv, true));
    this.pin = pin;
    this.mint = mint;
    this.refundKey = refundKey;
  }

  /** A new tap: the session state is gone (spec "Session State"); the change grant is taken at SELECT. */
  tap() {
    this.present = true;
    this.pinOk = false;
    this.payment = null;
    this.changeGrant = this.paidLastTap;
    this.paidLastTap = false;
    this.paidThisTap = false;
  }

  /** The card leaves the field. */
  lift() {
    this.present = false;
    this.paidLastTap = this.paidThisTap;
    this.pinOk = false;
    this.payment = null;
  }

  load(pieces: SimPiece[]) {
    for (const p of pieces) {
      const i = this.slots.findIndex((s) => s === null);
      this.slots[i] = { ...p, status: 1 };
    }
  }

  /**
   * The owner's CLEAR_SPENT (spec/APDU.md 0x31): spent slots are freed, so the next LOAD_PROOF reuses
   * them. The last signature stays (SPEND_ALL_AGAIN still answers it).
   */
  clearSpent() {
    this.slots = this.slots.map((s) => (s?.status === 2 ? null : s));
  }

  unspent() {
    return this.slots.flatMap((s, slot) => (s?.status === 1 ? [{ slot, ...s }] : []));
  }

  balance() {
    return this.unspent().reduce((n, s) => n + s.amount, 0);
  }

  /** The transceiver a reader gets: bytes of one APDU in, the answer out. */
  readonly transceive = async (apdu: number[]): Promise<number[]> => {
    if (!this.present) throw new TagLostError();
    const ins = apdu[1]!;
    const br = this.breaks.find((b) => b.ins === ins);
    const take = () => {
      if (br && --br.times! <= 0) this.breaks.splice(this.breaks.indexOf(br), 1);
    };
    if (br) br.times ??= 1;
    if (br?.when === 'before') {
      take();
      this.lift();
      throw new TagLostError();
    }
    const out = this.handle(apdu);
    this.log.push({ apdu: hex(apdu), sw: hex(out.slice(-2)) });
    if (br?.when === 'after') {
      take();
      this.lift();
      throw new TagLostError();
    }
    return out;
  };

  private handle(apdu: number[]): number[] {
    const [cla, ins, p1, p2] = apdu as [number, number, number, number];
    const lc = apdu.length > 5 ? apdu[4]! : 0;
    const data = apdu.length > 5 ? apdu.slice(5, 5 + lc) : [];
    if (cla === 0x00 && ins === 0xa4) {
      const aid = apdu.slice(5, 5 + apdu[4]!);
      if (hex(aid) !== hex(APPLET_AID)) return sw(0x6a82);
      return sw(OK, [0x02, 0x01]);
    }
    if (cla !== 0xb0) return sw(0x6e00);
    // Any command but the payment's own gives a payment up.
    if (this.payment && ![0x23, 0x24, 0x26].includes(ins)) this.payment = null;
    switch (ins) {
      case 0x01: {
        const unspent = this.unspent().length;
        const spent = this.slots.filter((s) => s?.status === 2).length;
        const pinState = this.pin === null ? 0 : this.blocked ? 2 : 1;
        const body = [2, 1, 128, unspent, spent, 128 - unspent - spent, 0xff, pinState, 4, this.pin === null ? 0 : this.tries, 0, 1, ...u32(0), 1, ...u32(0), ...u32(0), ...u32(0), this.changeGrant ? 1 : 0];
        return sw(OK, p1 === 1 ? [...body, ...u32(0), ...u32(0), ...u32(0)] : body);
      }
      case 0x10:
        return sw(OK, Array.from(hexToBytes(this.pubkey)));
      case 0x16: {
        const mint = Array.from(enc.encode(this.mint));
        const refund = this.refundKey ? Array.from(hexToBytes(this.refundKey)) : Array(33).fill(0);
        const body = [4, 1, this.unit, ...u32(0), ...refund, ...Array(4).fill(0), ...Array(32).fill(0), 0, 7, 0, ...Array(26).fill(0), mint.length, ...mint, 0, 0, 0];
        return sw(OK, body);
      }
      case 0x15: {
        if (data.length !== 16) return sw(0x6700);
        const cardNonce = Array.from(randomBytes(16));
        const tag = sha256(enc.encode('CashuCard/auth'));
        const msg = sha256(new Uint8Array([...tag, ...tag, ...data, ...cardNonce, ...hexToBytes(this.pubkey)]));
        return sw(OK, [...cardNonce, ...schnorr.sign(msg, this.priv)]);
      }
      case 0x17: {
        if (p2 === 0x03) return sw(OK, this.shortListing(p1));
        if (p2 === 0x02) {
          const out: number[] = [];
          for (const slot of data) {
            const s = this.slots[slot];
            out.push(...(s ? [s.status, ...this.pieceBytes(s)] : Array(82).fill(0)));
          }
          return sw(OK, out);
        }
        return sw(0x6a86);
      }
      case 0x40: {
        if (this.pin === null) return sw(0x6984);
        if (this.blocked) return sw(0x6983);
        if (String.fromCharCode(...data) === this.pin) {
          this.tries = 3;
          this.pinOk = true;
          return sw(OK);
        }
        this.tries--;
        if (this.tries <= 0) {
          this.blocked = true;
          return sw(0x6983);
        }
        return sw(0x63c0 | this.tries);
      }
      case 0x22: {
        if (!data.length) return sw(0x6700);
        if (new Set(data).size !== data.length) return sw(0x6a80);
        let sum = 0;
        const date = this.slots[data[0]!]?.date;
        for (const slot of data) {
          if (slot > 127) return sw(0x6a83);
          const s = this.slots[slot];
          if (!s) return sw(0x6a88);
          if (s.status === 2) return sw(0x6985);
          if (s.date !== date) return sw(0x6a80);
          sum += s.amount;
        }
        this.payment = { slots: data, sum, outputs: [], change: 0 };
        return sw(OK, u32(sum));
      }
      case 0x23: {
        if (!this.payment) return sw(0x6985);
        if (data.length % 37) {
          this.payment = null;
          return sw(0x6700);
        }
        for (let i = 0; i < data.length; i += 37) this.payment.outputs.push({ amount: readU32(data, i), B_: hex(data.slice(i + 4, i + 37)) });
        return sw(OK);
      }
      case 0x26: {
        if (!this.payment) return sw(0x6985);
        const amount = readU32(data, 0);
        if (amount === 0 || this.payment.change + amount > this.payment.sum) return sw(0x6a80);
        if (this.openings.length >= 8) return sw(0x6a84);
        const first = this.slots[this.payment.slots[0]!]!;
        const nonce = bytesToHex(randomBytes(32));
        const r = secp256k1.Point.Fn.fromBytes(secp256k1.utils.randomSecretKey());
        const B_ = hashToCurve(cardSecret(nonce, this.pubkey, first.date, this.refundKey)).add(Point.BASE.multiply(r)).toHex(true);
        this.openings.push({ amount, keysetId: first.keysetId, date: first.date, nonce, r, B_ });
        this.payment.outputs.push({ amount, B_ });
        this.payment.change += amount;
        return sw(OK, Array.from(hexToBytes(B_)));
      }
      case 0x24: {
        const p = this.payment;
        if (!p) return sw(0x6985);
        if (this.pin !== null && !this.pinOk) {
          this.payment = null;
          return sw(0x6a94);
        }
        let text = '';
        for (const slot of p.slots) {
          const s = this.slots[slot]!;
          text += cardSecret(s.nonce, this.pubkey, s.date, this.refundKey) + s.C;
        }
        for (const o of p.outputs) text += String(o.amount) + o.B_;
        const sig = Array.from(schnorr.sign(sha256(enc.encode(text)), this.priv));
        for (const slot of p.slots) this.slots[slot]!.status = 2;
        this.lastSig = sig;
        this.payment = null;
        this.paidThisTap = true;
        return sw(OK, sig);
      }
      case 0x25:
        if (!this.lastSig) return sw(0x6a88);
        if (this.pin !== null && !this.pinOk) return sw(0x6982);
        return sw(OK, this.lastSig);
      case 0x19: {
        const page = this.openings.slice(p1 * 3, p1 * 3 + 3);
        return sw(OK, [page.length, ...page.flatMap((o) => [...u32(o.amount), ...hexToBytes(o.keysetId), ...u32(o.date), ...hexToBytes(o.nonce), ...hexToBytes(o.r.toString(16).padStart(64, '0'))])]);
      }
      case 0x30: {
        if (data.length !== 81) return sw(0x6700);
        const piece: SimPiece = { keysetId: hex(data.slice(0, 8)), amount: readU32(data, 8), nonce: hex(data.slice(12, 44)), C: hex(data.slice(44, 77)), date: readU32(data, 77) };
        const isChange = this.openings.some((o) => o.nonce === piece.nonce);
        const allowed = this.pin === null || this.pinOk || (isChange && (this.changeGrant || this.paidThisTap));
        if (!allowed) return sw(0x6982);
        if (this.slots.some((s) => s?.nonce === piece.nonce)) return sw(0x6a94);
        try {
          Point.fromHex(piece.C);
        } catch {
          return sw(0x6a80);
        }
        const free = this.slots.findIndex((s) => s === null);
        if (free < 0) return sw(0x6a84);
        this.slots[free] = { ...piece, status: 1 };
        this.openings = this.openings.filter((o) => o.nonce !== piece.nonce);
        return sw(OK, [free]);
      }
      default:
        return sw(0x6d00);
    }
  }

  private pieceBytes(s: SimPiece) {
    return [...hexToBytes(s.keysetId), ...u32(s.amount), ...hexToBytes(s.nonce), ...hexToBytes(s.C), ...u32(s.date)];
  }

  private shortListing(from: number) {
    const out: number[] = [];
    let prev: { keysetId: string; date: number } | null = null;
    let slot = from;
    for (; slot < 128; slot++) {
      const s = this.slots[slot];
      if (!s || s.status !== 1) continue;
      const named = !prev || prev.keysetId !== s.keysetId || prev.date !== s.date;
      const pow = Math.log2(s.amount);
      const size = Number.isInteger(pow) && pow <= 31 ? [pow] : [0xff, ...u32(s.amount)];
      const entry = [slot | (named ? 0x80 : 0), ...(named ? [...hexToBytes(s.keysetId), ...u32(s.date)] : []), ...size];
      if (out.length + entry.length > 250) break;
      out.push(...entry);
      prev = s;
    }
    return [slot, ...out];
  }
}
