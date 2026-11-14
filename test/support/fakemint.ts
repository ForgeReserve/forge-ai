import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { hashToCurve } from './cardsim.ts';

// An in-memory Cashu mint for the card unit tests: one sat keyset (plus, on request, an older inactive
// one), blind signatures with their NUT-12 proofs, a SIG_ALL swap that checks the card's one signature
// the way NUT-11 says, spent-proof tracking and NUT-09 restore. It answers in the shapes the engine's
// card relay (src/cardrelay.ts) passes on, so it stands in for relay + mint. Written with noble directly.

const Point = secp256k1.Point;
const Fn = Point.Fn;
const enc = new TextEncoder();

interface Keyset {
  id: string;
  active: boolean;
  fee: number;
  priv: Map<number, bigint>;
}

const AMOUNTS = Array.from({ length: 24 }, (_, i) => 2 ** i);

function keyset(seed: string, active: boolean, fee: number): Keyset {
  const priv = new Map<number, bigint>();
  for (const a of AMOUNTS) priv.set(a, Fn.fromBytes(sha256(enc.encode(`${seed}/${a}`))));
  const pubs = AMOUNTS.map((a) => Point.BASE.multiply(priv.get(a)!).toHex(true)).join('');
  return { id: '01' + bytesToHex(sha256(enc.encode(pubs))), active, fee, priv };
}

type Reply = { ok: boolean; status: number; body: any };
const ok = (body: unknown): Reply => ({ ok: true, status: 200, body });
const refused = (code: number, detail: string): Reply => ({ ok: false, status: 400, body: { error: { code: 'mint_refused', message: detail }, mint_code: code } });

export class FakeMint {
  readonly url: string;
  keysets: Keyset[];
  readonly spent = new Set<string>();
  readonly signed = new Map<string, any>();
  /** The swap's answer is lost after the mint did it, this many times. */
  loseSwapAnswer = 0;
  /** The mint (or the engine) cannot be reached, this many times. */
  down = 0;
  readonly calls: string[] = [];

  constructor({ url = 'https://mint.example', fee = 0, oldKeyset = false } = {}) {
    this.url = url;
    this.keysets = [keyset(url + '/now', true, fee)];
    if (oldKeyset) this.keysets.push(keyset(url + '/old', false, fee));
  }

  get active() {
    return this.keysets[0]!;
  }

  keys(k: Keyset) {
    return Object.fromEntries(AMOUNTS.map((a) => [String(a), Point.BASE.multiply(k.priv.get(a)!).toHex(true)]));
  }

  private sign(k: Keyset, amount: number, B_: string) {
    const key = k.priv.get(amount);
    if (!key) throw new Error(`no key for ${amount}`);
    const B = Point.fromHex(B_);
    const C_ = B.multiply(key);
    // NUT-12: r random, R1 = r·G, R2 = r·B_, e = hash(R1, R2, K, C_), s = r + e·k.
    const r = Fn.fromBytes(secp256k1.utils.randomSecretKey());
    const K = Point.BASE.multiply(key);
    const e = Fn.fromBytes(sha256(enc.encode([Point.BASE.multiply(r), B.multiply(r), K, C_].map((p) => p.toHex(false)).join(''))));
    const s = Fn.add(r, Fn.mul(e, key));
    const sig = { id: k.id, amount, C_: C_.toHex(true), dleq: { e: e.toString(16).padStart(64, '0'), s: s.toString(16).padStart(64, '0') } };
    this.signed.set(B_, sig);
    return sig;
  }

  /** Mints pieces for outputs {amount, B_} in the active keyset (as a card is loaded). */
  mintFor(outputs: { amount: number; B_: string }[], k = this.active) {
    return outputs.map((o) => this.sign(k, o.amount, o.B_).C_);
  }

  /** The relay the card flow takes (core/card/flow.js). */
  relay = {
    mint: async (_b: any): Promise<Reply> => {
      this.calls.push('mint');
      if (this.down > 0) {
        this.down--;
        throw new TypeError('Failed to fetch');
      }
      return ok({ mint: this.url, trusted: true, unit: 'sat', keysets: this.keysets.map((k) => ({ id: k.id, unit: 'sat', active: k.active, input_fee_ppk: k.fee })), keys: Object.fromEntries(this.keysets.filter((k) => k.active).map((k) => [k.id, this.keys(k)])) });
    },
    swap: async ({ inputs, outputs }: any): Promise<Reply> => {
      this.calls.push('swap');
      if (this.down > 0) {
        this.down--;
        throw new TypeError('Failed to fetch');
      }
      const r = this.swap(inputs, outputs);
      if (r.ok && this.loseSwapAnswer > 0) {
        this.loseSwapAnswer--;
        throw new TypeError('Failed to fetch');
      }
      return r;
    },
    restore: async ({ outputs }: any): Promise<Reply> => {
      this.calls.push('restore');
      const known = outputs.filter((o: any) => this.signed.has(o.B_));
      return ok({ outputs: known, signatures: known.map((o: any) => this.signed.get(o.B_)) });
    },
  };

  swap(inputs: any[], outputs: any[]): Reply {
    const sumIn = inputs.reduce((s, p) => s + p.amount, 0);
    const fee = Math.ceil(inputs.reduce((s, p) => s + (this.keysets.find((k) => k.id === p.id)?.fee ?? 0), 0) / 1000);
    const sumOut = outputs.reduce((s, o) => s + o.amount, 0);
    if (sumIn - fee !== sumOut) return refused(11005, `inputs ${sumIn} - fee ${fee} != outputs ${sumOut}`);
    for (const p of inputs) {
      const k = this.keysets.find((x) => x.id === p.id);
      if (!k) return refused(12001, 'unknown keyset');
      const Y = hashToCurve(p.secret);
      if (Y.multiply(k.priv.get(p.amount)!).toHex(true) !== p.C) return refused(10003, 'proof not valid');
      if (this.spent.has(p.secret)) return refused(11001, 'Token already spent.');
    }
    for (const o of outputs) if (this.signed.has(o.B_)) return refused(11003, 'outputs have already been signed before.');
    if (outputs.some((o) => !this.keysets.find((k) => k.id === o.id)?.active)) return refused(12002, 'keyset inactive');
    // NUT-11 SIG_ALL: every input names the same key and tags; one signature on the first input.
    const secrets = inputs.map((p) => JSON.parse(p.secret));
    const key = secrets[0][1].data;
    const tags = JSON.stringify(secrets[0][1].tags);
    if (secrets.some((s) => s[0] !== 'P2PK' || s[1].data !== key || JSON.stringify(s[1].tags) !== tags)) return refused(10001, 'SIG_ALL inputs differ');
    let text = '';
    for (const p of inputs) text += p.secret + p.C;
    for (const o of outputs) text += String(o.amount) + o.B_;
    const sig = JSON.parse(inputs[0].witness ?? '{}').signatures?.[0];
    if (!sig || !schnorr.verify(hexToBytes(sig), sha256(enc.encode(text)), hexToBytes(key).slice(1))) return refused(20008, 'Witness is missing or invalid');
    for (const p of inputs) this.spent.add(p.secret);
    return ok({ signatures: outputs.map((o) => this.sign(this.keysets.find((k) => k.id === o.id)!, o.amount, o.B_)) });
  }
}
