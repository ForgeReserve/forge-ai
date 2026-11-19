import { randomBytes } from 'node:crypto';
import type { FakeNotes, FakeReceiver } from './fakereceiver.ts';

// Fedimint notes for the stand-in receiver (test/support/fakereceiver.ts) in the app's browser tests:
// mintv2 ECash with the exact encoding a federation writes (fedimint "fedimint" base32 of the consensus
// encoding: the federation's id, then each note's denomination, secret key and signature), so the phone
// reads them as notes (public/v2/core/fedinote.js) with their amount and federation. The keys and
// signatures are random: only a real federation could check them, and the stand-in does not. Real notes
// from a real federation are in test/unit/fixtures/fedimint/notes.json and test/fedimint/.

const B32 = '0123456789abcdefghijklmnopqrstuv';

function base32(bytes: Uint8Array): string {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf |= b << bits;
    bits += 8;
    while (bits >= 5) {
      out += B32[buf & 31];
      buf >>>= 5;
      bits -= 5;
    }
  }
  return bits > 0 ? out + B32[buf & 31] : out;
}

/** BigSize, as fedimint writes lengths and variants. */
function bigSize(n: number): number[] {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n >> 8, n & 0xff];
  return [0xfe, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/**
 * mintv2 notes of `federationId` (64 hex), one note per denomination (2^d msat each). Returns the text a
 * wallet would hand over.
 */
export function v2Notes(federationId: string, denominations: number[]): string {
  const field = (variant: number, body: number[]) => [...bigSize(variant), ...bigSize(body.length), ...body];
  const id = [...Buffer.from(federationId, 'hex')];
  const notes = denominations.map((d) => {
    const secret = randomBytes(32);
    secret[0] = 1 + (secret[0]! % 0xfe); // a valid secp256k1 secret key
    return field(1, [d, ...secret, ...randomBytes(48)]);
  });
  const bytes = Uint8Array.from([...bigSize(1 + notes.length), ...field(0, id), ...notes.flat()]);
  return 'fedimint' + base32(bytes);
}

/** The denominations (powers of two, in msat) that make exactly `msat`: one note per bit. */
export function denominationsFor(msat: number): number[] {
  const out: number[] = [];
  let left = msat;
  for (let d = 50; d >= 0; d--) {
    if (left >= 2 ** d) {
      out.push(d);
      left -= 2 ** d;
    }
  }
  return out;
}

/**
 * New notes the stand-in receiver knows: the text, with its record of them (outcome, fee, validity).
 * notesId: the id the phone works out for them (core/fedinote.js notesIdOf), so the stand-in uses it too.
 */
export async function fakeNotes(rx: FakeReceiver, federationId: string, amountMsat: number, o: Partial<Pick<FakeNotes, 'outcome' | 'fee_msat' | 'valid' | 'module'>> & { claimMsat?: number } = {}): Promise<FakeNotes> {
  const F: any = await import('../../public/v2/core/fedinote.js' as string);
  const notes = v2Notes(federationId, denominationsFor(amountMsat));
  const n: FakeNotes = {
    notes,
    notes_id: await F.notesIdOf(notes),
    federation_id: federationId,
    module: o.module ?? 'mintv2',
    // What the receiver says they are worth: their face value, unless a test says otherwise.
    amount_msat: o.claimMsat ?? amountMsat,
    valid: o.valid ?? true,
    outcome: o.outcome ?? 'done',
    fee_msat: o.fee_msat ?? 1234,
  };
  rx.notes.set(notes, n);
  return n;
}
