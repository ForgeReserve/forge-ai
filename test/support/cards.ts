import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { CardSim, cardSecret, hashToCurve, type SimPiece } from './cardsim.ts';

// Loading a simulated card with real pieces: format-4 SIG_ALL secrets locked to the card's key, blinded,
// signed by a mint, unblinded, and stored in the card's slots, as a card's owner loads it (spec/APDU.md
// "Provisioning Flow"). signer gets the blinded outputs and resolves to the mint's C_ for each.

const Point = secp256k1.Point;

export interface Signer {
  keysetId: string;
  keys: Record<string, string>;
  sign(outputs: { amount: number; id: string; B_: string }[]): Promise<string[]> | string[];
}

export async function provision(card: CardSim, signer: Signer, amounts: number[], date = 0): Promise<SimPiece[]> {
  const made = amounts.map((amount) => {
    const nonce = bytesToHex(randomBytes(32));
    const r = Point.Fn.fromBytes(secp256k1.utils.randomSecretKey());
    const B_ = hashToCurve(cardSecret(nonce, card.pubkey, date, card.refundKey)).add(Point.BASE.multiply(r));
    return { amount, nonce, r, B_: B_.toHex(true) };
  });
  const C_ = await signer.sign(made.map((m) => ({ amount: m.amount, id: signer.keysetId, B_: m.B_ })));
  const pieces = made.map((m, i) => ({
    keysetId: signer.keysetId.slice(0, 16),
    amount: m.amount,
    nonce: m.nonce,
    // C = C_ - r·K
    C: Point.fromHex(C_[i]!).subtract(Point.fromHex(signer.keys[String(m.amount)]!).multiply(m.r)).toHex(true),
    date,
  }));
  card.load(pieces);
  return pieces;
}

/** A signer at a real mint (the local Nutshell mints): a FakeWallet quote is paid at once. */
export async function mintSigner(mint: string, unit = 'sat'): Promise<Signer> {
  const keysets = (await (await fetch(`${mint}/v1/keysets`)).json()).keysets as { id: string; unit: string; active: boolean }[];
  const ks = keysets.find((k) => k.unit === unit && k.active)!;
  const keys = (await (await fetch(`${mint}/v1/keys/${ks.id}`)).json()).keysets[0].keys as Record<string, string>;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(mint + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
    return j;
  };
  return {
    keysetId: ks.id,
    keys,
    async sign(outputs) {
      const amount = outputs.reduce((s, o) => s + o.amount, 0);
      const q = await post('/v1/mint/quote/bolt11', { amount, unit });
      for (let i = 0; i < 50; i++) {
        const s = await (await fetch(`${mint}/v1/mint/quote/bolt11/${q.quote}`)).json();
        if (s.state === 'PAID') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const m = await post('/v1/mint/bolt11', { quote: q.quote, outputs });
      return m.signatures.map((s: { C_: string }) => s.C_);
    },
  };
}
