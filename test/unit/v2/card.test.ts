import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blindMessage, createBlindSignature, createDLEQProof, getDecodedToken, hashToCurve, pointFromHex, unblindSignature } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { provision } from '../../support/cards.ts';
import { CardSim } from '../../support/cardsim.ts';
import { FakeMint } from '../../support/fakemint.ts';

// The Cashu card on the phone (slice A13): the Cashu arithmetic (public/v2/core/cashu.js), the card's
// APDU protocol ported from flash-pos (public/v2/core/card/apdu.js), held to the applet's own transcript
// and vectors, and the funding flow (public/v2/core/card/flow.js) against a simulated card and an
// in-memory mint, with taps that break at every point that matters. The fixtures are flash-pos's
// __tests__/fixtures/card-protocol-2.0 (secret.json and transcript-excerpt.json, taken from
// cashu-javacard spec/vectors), copied unchanged.
const C: any = await import('../../../public/v2/core/cashu.js' as string);
const A: any = await import('../../../public/v2/core/card/apdu.js' as string);
const F: any = await import('../../../public/v2/core/card/flow.js' as string);
const N: any = await import('../../../public/v2/core/note.js' as string);

const FIX = join(import.meta.dirname, '..', 'fixtures', 'card');
const vectors = JSON.parse(readFileSync(join(FIX, 'secret.json'), 'utf8'));
const transcript = JSON.parse(readFileSync(join(FIX, 'transcript-excerpt.json'), 'utf8')).steps as { index: number; apdu: string; sw: string; data: string; kind: string }[];
const step = (i: number) => transcript.find((s) => s.index === i)!;
const bytes = (h: string) => Array.from(Buffer.from(h, 'hex'));

/** A transceiver that plays these transcript steps in order and checks each command byte for byte. */
function replay(...indexes: number[]) {
  const queue = indexes.map(step);
  const tx = async (apdu: number[]) => {
    const s = queue.shift();
    if (!s) throw new Error('no more steps');
    expect(Buffer.from(apdu).toString('hex')).toBe(s.apdu);
    return [...bytes(s.data), ...bytes(s.sw)];
  };
  return Object.assign(tx, { left: () => queue.length });
}

function memStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('Cashu arithmetic on the phone (core/cashu.js)', () => {
  it('uses the vendored noble bundle built from the pinned versions, with its licences', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    const head = readFileSync(join(root, 'public/vendor/noble.js'), 'utf8').split('\n')[0]!;
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(head).toContain(`@noble/curves ${pkg.dependencies['@noble/curves']}`);
    expect(head).toContain(`@noble/hashes ${pkg.dependencies['@noble/hashes']}`);
    for (const f of ['noble-curves.txt', 'noble-hashes.txt']) expect(readFileSync(join(root, 'public/vendor/licenses', f), 'utf8')).toMatch(/MIT License/);
  });

  it('hashes to the curve, blinds and unblinds as cashu-ts does', () => {
    const secret = 'a secret';
    expect(C.hashToCurve(C.utf8(secret)).toHex(true)).toBe(hashToCurve(C.utf8(secret)).toHex(true));
    const r = C.randomScalar();
    const ours = C.blind(secret, r);
    const theirs = blindMessage(C.utf8(secret), BigInt('0x' + r));
    expect(ours.B_).toBe(theirs.B_.toHex(true));
    // A mint key k signs B_; unblinding with r and K = k·G gives C = k·Y.
    const k = secp256k1.utils.randomSecretKey();
    const K = secp256k1.Point.BASE.multiply(secp256k1.Point.Fn.fromBytes(k));
    const blindSig = createBlindSignature(theirs.B_, k, '00ffffffffffffff');
    const C_ = blindSig.C_.toHex(true);
    expect(C.unblind(C_, r, K.toHex(true))).toBe(unblindSignature(pointFromHex(C_), BigInt('0x' + r), K).toHex(true));
  });

  it("checks a mint's NUT-12 proof made by cashu-ts, and refuses a changed one", () => {
    const { B_, r } = C.blind('x');
    const k = secp256k1.utils.randomSecretKey();
    const K = secp256k1.Point.BASE.multiply(secp256k1.Point.Fn.fromBytes(k)).toHex(true);
    const C_ = pointFromHex(B_).multiply(secp256k1.Point.Fn.fromBytes(k)).toHex(true);
    const d = createDLEQProof(pointFromHex(B_), k);
    const e = bytesToHex(d.e);
    const s = bytesToHex(d.s);
    expect(C.verifyDleq({ e, s }, B_, C_, K)).toBe(true);
    expect(C.verifyDleq({ e, s }, B_, C.blind('y', r).B_, K)).toBe(false);
    expect(C.verifyDleq({ e: s, s: e }, B_, C_, K)).toBe(false);
  });

  it("rebuilds the card's secrets byte for byte and its SIG_ALL message, from the applet's vectors", () => {
    for (const p of vectors.pieces) {
      const secret = C.cardSecret(p.nonce, vectors.cardKey, p.date, p.date ? vectors.refundKey : null);
      expect(secret).toBe(p.secret);
      expect(C.toHex(C.sigAllMessage([{ secret, C: p.C }], []))).toBe(p.message);
      expect(C.schnorrVerify(p.signature, C.fromHex(p.message), vectors.cardKey)).toBe(true);
      expect(C.schnorrVerify(p.signature, C.sha256(C.utf8('other')), vectors.cardKey)).toBe(false);
    }
    expect(() => C.cardSecret('00'.repeat(32), vectors.cardKey, 5, null)).toThrow(/refund key/);
  });

  it('writes a cashuB token that cashu-ts and the note reader read back', () => {
    const proofs = [64, 4, 2].map((amount, i) => ({ id: '01' + 'ab'.repeat(32), amount, secret: `s${i}`, C: '02' + 'cd'.repeat(32) }));
    const token = C.encodeToken({ mint: 'https://mint.example', unit: 'sat', proofs });
    const d = getDecodedToken(token, ['01' + 'ab'.repeat(32)]);
    expect(d.mint).toBe('https://mint.example');
    expect(d.unit).toBe('sat');
    expect(d.proofs.map((p) => [p.id, p.amount.toNumber(), p.secret, p.C])).toEqual(proofs.map((p) => [p.id, p.amount, p.secret, p.C]));
    expect(N.readNote(token)).toMatchObject({ ok: true, mint: 'https://mint.example', unit: 'sat', amount: 70, proofs: 3 });
    // Larger numbers take the longer CBOR heads.
    expect(N.readCbor(C.writeCbor([23, 24, 255, 256, 65535, 65536, 2 ** 32, 2 ** 40]))).toEqual([23, 24, 255, 256, 65535, 65536, 2 ** 32, 2 ** 40]);
  });

  it('splits an amount into powers of two', () => {
    expect(C.splitAmount(70)).toEqual([64, 4, 2]);
    expect(C.splitAmount(0)).toEqual([]);
    expect(C.splitAmount(2 ** 33 + 1)).toEqual([2 ** 33, 1]);
    expect(() => C.splitAmount(-1)).toThrow();
  });
});

describe("the card's APDU protocol, held to the applet's transcript (core/card/apdu.js)", () => {
  it('reads GET_INFO, both forms', async () => {
    const info = await A.getInfo(replay(1), { p1: 0 });
    expect(info).toMatchObject({ major: 2, maxSlots: 128, unspent: 0, pinState: 'unset', format: 4 });
    const full = await A.getInfo(replay(406));
    expect(full.paymentLimit).toBeTypeOf('number');
    expect(full.allowance).toBeTypeOf('number');
  });

  it('reads a record not yet written', async () => {
    expect(await A.getCard(replay(3))).toMatchObject({ format: 4, recordSet: false, refundKey: null, mint: '' });
  });

  it('frames a payment: BEGIN, SIGN, "not yet", and the refusals', async () => {
    expect(await A.spendAllBegin(replay(96), [0])).toBe(16);
    expect(await A.spendAllSign(replay(97))).toBe(step(97).data);
    // Not yet, then the signature.
    const tx = replay(110, 97);
    expect(await A.spendAllSign(tx)).toBe(step(97).data);
    expect(tx.left()).toBe(0);
    const over = await A.spendAllSign(replay(101)).catch((e: unknown) => e);
    expect(F.cardFailure(over).code).toBe('over_limit');
    const pin = await A.spendAllSign(replay(251)).catch((e: unknown) => e);
    expect(A.isPinNeededForPayment(pin)).toBe(true);
    expect(F.cardFailure(pin).code).toBe('pin_needed');
    const twice = await A.spendAllBegin(replay(567), [3, 3]).catch((e: unknown) => e);
    expect(twice.sw).toBe(0x6a80);
    const spent = await A.spendAllBegin(replay(186), [0]).catch((e: unknown) => e);
    expect(A.describeStatusWord(spent.sw, spent.context)).toBe('proof already spent');
  });

  it("frames the phone's outputs and the card's change", async () => {
    // Step 474: one output of 90, then (475) the card's own change of 40.
    const s474 = step(474);
    const B_ = s474.apdu.slice(10 + 8);
    await A.spendAllOutputs(replay(474), [{ amount: 90, B_ }]);
    expect(await A.spendAllChange(replay(475), 40)).toBe(step(475).data);
    const noPayment = await A.spendAllChange(replay(472), 10).catch((e: unknown) => e);
    expect(A.describeStatusWord(noPayment.sw, noPayment.context)).toBe('no payment begun');
    // Two openings on the first page, none on the next.
    const openings = await A.getChange(replay(485));
    expect(openings).toHaveLength(2);
    expect(openings[0]).toMatchObject({ amount: 40 });
    expect(openings[0].r).toMatch(/^[0-9a-f]{64}$/);
    expect(await A.spendAllAgain(replay(557))).toMatch(/^[0-9a-f]{128}$/);
    const again = await A.spendAllAgain(replay(770)).catch((e: unknown) => e);
    expect(again.sw).toBe(0x6982);
  });

  it('reads the short listing page by page, and named slots whole', async () => {
    const page = A.parseShortListing(bytes(step(588).data), 0);
    expect(page.pieces.length).toBeGreaterThan(0);
    expect(page.pieces[0].keysetId).toMatch(/^[0-9a-f]{16}$/);
    const all = await A.getPiecesShort(replay(657, 658, 659));
    expect(all.map((p: { slot: number }) => p.slot)).toEqual([...all.map((p: { slot: number }) => p.slot)].sort((a: number, b: number) => a - b));
    expect(all.length).toBeGreaterThan(3);
    expect(await A.getPiecesShort(replay(619))).toEqual([]);
    const named = await A.getPiecesNamed(replay(662), [127, 64]);
    expect(named[0]).toMatchObject({ slot: 127, status: 'empty', piece: null });
    expect(named[1]).toMatchObject({ slot: 64, status: 'unspent' });
    expect(() => A.parseShortListing([5, 0x01, 0x00], 0)).toThrow(/names no keyset/);
    expect(() => A.parseShortListing([5, 0x81], 0)).toThrow(/cut short/);
    expect(() => A.parseShortListing([1], 3)).toThrow(/ends at/);
  });

  it('loads a piece, and tells "already on the card" and "PIN needed" apart', async () => {
    const s = step(90);
    const d = bytes(s.apdu).slice(5, 5 + 81);
    const piece = { keysetId: Buffer.from(d.slice(0, 8)).toString('hex'), amount: Buffer.from(d.slice(8, 12)).readUInt32BE(), nonce: Buffer.from(d.slice(12, 44)).toString('hex'), C: Buffer.from(d.slice(44, 77)).toString('hex'), date: Buffer.from(d.slice(77, 81)).readUInt32BE() };
    expect(await A.loadProof(replay(90), piece)).toBe(0);
    const p141 = bytes(step(141).apdu).slice(5, 86);
    const again = { keysetId: Buffer.from(p141.slice(0, 8)).toString('hex'), amount: Buffer.from(p141.slice(8, 12)).readUInt32BE(), nonce: Buffer.from(p141.slice(12, 44)).toString('hex'), C: Buffer.from(p141.slice(44, 77)).toString('hex'), date: Buffer.from(p141.slice(77, 81)).readUInt32BE() };
    const already = await A.loadProof(replay(141), again).catch((e: unknown) => e);
    expect(A.isAlreadyOnCard(already)).toBe(true);
    const p255 = bytes(step(255).apdu).slice(5, 86);
    const locked = await A.loadProof(replay(255), { keysetId: Buffer.from(p255.slice(0, 8)).toString('hex'), amount: Buffer.from(p255.slice(8, 12)).readUInt32BE(), nonce: Buffer.from(p255.slice(12, 44)).toString('hex'), C: Buffer.from(p255.slice(44, 77)).toString('hex'), date: Buffer.from(p255.slice(77, 81)).readUInt32BE() }).catch((e: unknown) => e);
    expect(locked.sw).toBe(0x6982);
  });

  it("checks AUTH with the applet's vector", async () => {
    const a = vectors.auth;
    expect(C.toHex(A.authMessage(bytes(a.readerNonce), bytes(a.cardNonce), bytes(vectors.cardKey)))).toBe(a.message);
    const card = async () => [...bytes(a.cardNonce), ...bytes(a.signature), 0x90, 0x00];
    await A.auth(card, bytes(vectors.cardKey), bytes(a.readerNonce));
    const other = bytes(vectors.refundKey);
    await expect(A.auth(card, other, bytes(a.readerNonce))).rejects.toBeInstanceOf(A.CardAuthError);
  });

  it('selects the applet, and tells a card that needs an update from one that is not an eCash card', async () => {
    const answers = (map: Record<string, string>) => async (apdu: number[]) => bytes(map[Buffer.from(apdu).toString('hex')] ?? '6a82');
    const applet = '00a404000bf04341534855434152440100';
    const pkg = '00a404000af043415348554341524400';
    expect(await A.selectApplet(answers({ [applet]: '02019000' }))).toEqual([2, 1]);
    // The opener answers the package AID with an empty 9000: not the applet.
    await expect(A.selectApplet(answers({ [pkg]: '9000' }))).rejects.toSatisfy((e: unknown) => A.isAppletNotFound(e));
    await expect(A.selectApplet(answers({ [applet]: '01149000' }))).rejects.toBeInstanceOf(A.CardNeedsUpdateError);
    await expect(A.selectApplet(answers({ '00a4040007d276000085010200': '9000' }))).rejects.toBeInstanceOf(A.CardNeedsUpdateError);
    expect(F.cardFailure(await A.selectApplet(answers({})).catch((e: unknown) => e)).code).toBe('not_ecash');
  });

  it('refuses to build what the card could not read', () => {
    expect(() => A.buildApdu(0x30, { data: Array(256).fill(0) })).toThrow(/too long/);
    expect(() => A.parseResponse([0x90], 'X')).toThrow(/truncated/);
    expect(A.describeStatusWord(0x63c2, 'VERIFY_PIN')).toBe('wrong PIN, 2 tries left');
    expect(A.triesLeftOf(new A.CardError(0x63c1, 'VERIFY_PIN'))).toBe(1);
  });
});

// ------------------------------------------------------------------ the flow

function setup({ pin = '1234' as string | null, amounts = [64, 32, 4], fee = 0, oldKeyset = false } = {}) {
  const mint = new FakeMint({ fee, oldKeyset });
  const card = new CardSim({ pin, mint: mint.url });
  const storage = memStorage();
  const flow = F.createCardFunding({ storage, relay: mint.relay });
  const signer = { keysetId: mint.active.id, keys: mint.keys(mint.active), sign: (o: { amount: number; B_: string }[]) => mint.mintFor(o) };
  return { mint, card, storage, flow, signer, ready: provision(card, signer, amounts) };
}

/** The card is tapped, read, planned and paid in one go. */
async function take(s: ReturnType<typeof setup>, amount?: number, pin = '1234') {
  await s.ready;
  s.card.tap();
  const summary = await s.flow.read(s.card.transceive);
  const info = await s.flow.mintInfo(summary);
  const plan = s.flow.plan(summary, info, amount ?? summary.max);
  return { summary, info, plan, job: await s.flow.pay(s.card.transceive, { summary, info, plan, pin }) };
}

const tokenAmount = (t: string) => N.readNote(t).amount as number;
const tokenOf = (t: string) => N.readNote(t);

describe('taking eCash off a card (core/card/flow.js)', () => {
  it('reads the mint, unit, PIN state and balance, after the card proved its key', async () => {
    const s = setup();
    await s.ready;
    s.card.tap();
    const summary = await s.flow.read(s.card.transceive);
    expect(summary).toMatchObject({ pubkey: s.card.pubkey, mint: s.mint.url, unit: 'sat', pinState: 'set', triesLeft: 3, balance: 100, max: 100, owedOpenings: 0, unfinished: false });
    // The read writes nothing to the card.
    expect(s.card.log.map((l) => l.apdu.slice(0, 4))).not.toContain('b030');
  });

  it('takes all: the card is empty, the token holds the amount, nothing is left on the phone but the token', async () => {
    const s = setup();
    const { job } = await take(s);
    expect(job.state).toBe('swapped');
    expect(job.received).toBe(100);
    expect(tokenOf(job.token)).toMatchObject({ ok: true, mint: s.mint.url, unit: 'sat', amount: 100 });
    expect(s.card.balance()).toBe(0);
    // Until the token is handed to the vault, the job keeps it, and only it: the secrets went with the swap.
    const kept = s.flow.pending();
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0].outputs)).not.toMatch(/"r"|"secret"/);
    s.flow.handed(job.id);
    expect(s.flow.pending()).toEqual([]);
  });

  it('stores everything needed to finish the swap before the card is asked to sign', async () => {
    const s = setup();
    await s.ready;
    let atSign: any = null;
    const tx = async (apdu: number[]) => {
      if (apdu[1] === 0x24) atSign = JSON.parse(s.storage.m.get('forge2.cards')!).jobs[0];
      return s.card.transceive(apdu);
    };
    s.card.tap();
    const summary = await s.flow.read(tx);
    const info = await s.flow.mintInfo(summary);
    await s.flow.pay(tx, { summary, info, plan: s.flow.plan(summary, info, 100), pin: '1234' });
    expect(atSign.state).toBe('ready');
    expect(atSign.inputs).toHaveLength(3);
    expect(atSign.outputs.every((o: any) => o.secret && /^[0-9a-f]{64}$/.test(o.r))).toBe(true);
  });

  it('takes part: the card signs its own change and gets it back in the same tap', async () => {
    const s = setup();
    const { plan, job } = await take(s, 70);
    expect(plan).toMatchObject({ amount: 70, selected: 96, receive: 70, change: [16, 8, 2] });
    expect(job.received).toBe(70);
    expect(job.changeOwed).toBe(false);
    expect(s.card.balance()).toBe(30);
    expect(s.card.openings).toEqual([]);
  });

  it("pays the card mint's input fee from the amount moved", async () => {
    const s = setup({ fee: 400 });
    const { plan, job } = await take(s);
    // Three pieces at 400 ppk: 1.2, so 2 sat.
    expect(plan).toMatchObject({ fee: 2, receive: 98 });
    expect(tokenAmount(job.token)).toBe(98);
    expect(s.card.balance()).toBe(0);
  });

  it('a card with no PIN pays with no PIN', async () => {
    const s = setup({ pin: null });
    const { job } = await take(s, undefined, '');
    expect(job.received).toBe(100);
  });

  it('a wrong PIN shows the tries left and takes nothing; the third blocks the PIN', async () => {
    const s = setup();
    await s.ready;
    s.card.tap();
    const summary = await s.flow.read(s.card.transceive);
    const info = await s.flow.mintInfo(summary);
    const plan = s.flow.plan(summary, info, 100);
    const e1 = await s.flow.pay(s.card.transceive, { summary, info, plan, pin: '9999' }).catch((e: any) => e);
    expect(e1).toMatchObject({ code: 'pin_wrong', triesLeft: 2 });
    const e2 = await s.flow.pay(s.card.transceive, { summary, info, plan, pin: '9999' }).catch((e: any) => e);
    expect(e2).toMatchObject({ code: 'pin_wrong', triesLeft: 1 });
    const e3 = await s.flow.pay(s.card.transceive, { summary, info, plan, pin: '9999' }).catch((e: any) => e);
    expect(e3.code).toBe('pin_blocked');
    expect(s.card.balance()).toBe(100);
    expect(s.flow.pending()).toEqual([]);
    expect((await s.flow.read(s.card.transceive)).pinState).toBe('blocked');
  });

  it('a card lifted before it signs loses nothing: the next tap finds its pieces and drops the payment', async () => {
    const s = setup();
    await s.ready;
    s.card.breaks.push({ ins: 0x24, when: 'before' });
    const e = await take(s).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'unfinished', kept: true });
    expect(s.card.balance()).toBe(100);
    s.card.tap();
    // The read finds the pieces still on the card, so the payment is dropped: no PIN needed for that.
    const again = await s.flow.read(s.card.transceive);
    expect(again.unfinished).toBe(false);
    expect(again.balance).toBe(100);
    expect(s.flow.pending()).toEqual([]);
  });

  it('a card lifted after it signed (its answer lost): the next tap gets the signature again and the money arrives', async () => {
    const s = setup();
    await s.ready;
    s.card.breaks.push({ ins: 0x24, when: 'after' });
    const e = await take(s, 70).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'unfinished', kept: true });
    // The pieces are burned on the card; the phone holds the payment.
    expect(s.card.balance()).toBe(4);
    expect(s.flow.pending()[0].state).toBe('ready');
    s.card.tap();
    const r1 = await s.flow.read(s.card.transceive);
    expect(r1.unfinished).toBe(true);
    s.card.tap();
    const r2 = await s.flow.finish(s.card.transceive, { summary: r1, pin: '1234' });
    expect(r2.unfinished).toBe(false);
    // The change went back on the card in that tap; the token waits for the vault.
    expect(s.card.balance()).toBe(30);
    const [job] = s.flow.pending();
    expect(job.state).toBe('swapped');
    expect(tokenAmount(job.token)).toBe(70);
  });

  it('a card with no PIN finishes a lost signature in the read of the next tap', async () => {
    const s = setup({ pin: null });
    await s.ready;
    s.card.breaks.push({ ins: 0x24, when: 'after' });
    await take(s, undefined, '').catch(() => {});
    s.card.tap();
    const r = await s.flow.read(s.card.transceive);
    expect(r.unfinished).toBe(false);
    expect(s.flow.pending()[0]).toMatchObject({ state: 'swapped' });
    expect(tokenAmount(s.flow.pending()[0].token)).toBe(100);
  });

  it("the swap's answer lost: the job is kept, and the next try asks the mint for its signatures again", async () => {
    const s = setup();
    await s.ready;
    s.mint.loseSwapAnswer = 1;
    const e = await take(s, 70).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'mint_unavailable', kept: true });
    expect(s.flow.pending()[0].state).toBe('signed');
    const handed: string[] = [];
    expect(await s.flow.resume(async (j: any) => void handed.push(j.token))).toBe(2);
    expect(s.mint.calls.filter((c) => c === 'restore')).toHaveLength(1);
    expect(tokenAmount(handed[0]!)).toBe(70);
    // The change is still owed to the card (the tap broke off at the swap): it goes on at the next tap.
    expect(s.flow.pending()[0]).toMatchObject({ changeOwed: true, handed: true, token: null });
    expect(s.card.balance()).toBe(4);
    s.card.lift();
    s.card.tap();
    const r = await s.flow.read(s.card.transceive);
    expect(r.balance).toBe(30);
    expect(s.flow.pending()).toEqual([]);
  });

  it('the mint unreachable at the swap: nothing is lost, resume finishes it later', async () => {
    const s = setup();
    await s.ready;
    s.card.tap();
    const summary = await s.flow.read(s.card.transceive);
    const info = await s.flow.mintInfo(summary);
    const plan = s.flow.plan(summary, info, 100);
    s.mint.down = 1;
    const e = await s.flow.pay(s.card.transceive, { summary, info, plan, pin: '1234' }).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'mint_unavailable', kept: true });
    expect(s.card.balance()).toBe(0);
    const handed: string[] = [];
    await s.flow.resume(async (j: any) => void handed.push(j.token));
    expect(tokenAmount(handed[0]!)).toBe(100);
    expect(s.flow.pending()).toEqual([]);
  });

  it('a mint that refuses the swap: kept and marked, never retried as if it might pass', async () => {
    const s = setup();
    await s.ready;
    const swap = s.mint.relay.swap;
    s.mint.relay.swap = async () => ({ ok: false, status: 400, body: { error: { code: 'mint_refused', message: 'Witness is missing or invalid' }, mint_code: 20008 } });
    const e = await take(s).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'mint_refused', kept: true });
    expect(s.flow.pending()[0]).toMatchObject({ state: 'failed', error: 'Witness is missing or invalid' });
    s.mint.relay.swap = swap;
    expect(await s.flow.resume(async () => {})).toBe(0);
  });

  it('a refused payment can be tried again: Try again sends the swap once more and the money arrives', async () => {
    const s = setup();
    await s.ready;
    const swap = s.mint.relay.swap;
    s.mint.relay.swap = async () => ({ ok: false, status: 400, body: { error: { code: 'mint_refused', message: 'Witness is missing or invalid' }, mint_code: 20008 } });
    await take(s, 70).catch(() => {});
    const [f] = s.flow.failed();
    expect(f).toMatchObject({ state: 'failed', error: 'Witness is missing or invalid' });
    expect(f.outputs.reduce((n: number, o: any) => n + o.amount, 0)).toBe(70);
    s.mint.relay.swap = swap;
    const job = await s.flow.retry(f.id);
    expect(job.state).toBe('swapped');
    expect(job.error).toBeUndefined();
    expect(tokenAmount(job.token)).toBe(70);
    expect(s.flow.failed()).toEqual([]);
    // Refused again: failed again, and still listed.
    const s2 = setup();
    await s2.ready;
    s2.mint.relay.swap = async () => ({ ok: false, status: 400, body: { error: { code: 'mint_refused', message: 'no' }, mint_code: 20008 } });
    await take(s2).catch(() => {});
    const e = await s2.flow.retry(s2.flow.failed()[0].id).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'mint_refused', kept: true });
    expect(s2.flow.failed()).toHaveLength(1);
  });

  it.each([
    ["the engine's live check of an unlisted mint failed once", { error: { code: 'mint_check_failed', message: "this mint did not pass Forge's checks (probe threw)" } }],
    ['other-mint funding switched off meanwhile', { error: { code: 'method_unavailable', message: 'eCash from other mints is not accepted here' } }],
    ['a mint answer with no mint code (a rate limit, say)', { error: { code: 'mint_refused', message: 'the card mint answered HTTP 429' }, mint_code: null }],
    ['the outputs are being signed now (11004)', { error: { code: 'mint_refused', message: 'outputs are pending' }, mint_code: 11004 }],
  ])('an answer that may pass later (%s): the payment stays signed and resume finishes it', async (_name, body) => {
    const s = setup();
    await s.ready;
    const swap = s.mint.relay.swap;
    let first = true;
    s.mint.relay.swap = async (b: any) => {
      if (!first) return swap(b);
      first = false;
      return { ok: false, status: 400, body };
    };
    const e = await take(s).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'mint_unavailable', kept: true });
    expect(s.flow.pending()[0].state).toBe('signed');
    expect(s.flow.failed()).toEqual([]);
    const handed: string[] = [];
    await s.flow.resume(async (j: any) => void handed.push(j.token));
    expect(tokenAmount(handed[0]!)).toBe(100);
    expect(s.flow.pending()).toEqual([]);
  });

  it.each(['empty', 'reloaded'])('the owner cleared the spent slots (%s) after a tap broke past the commit: the next tap with the PIN still gets the money', async (after) => {
    const s = setup();
    await s.ready;
    s.card.breaks.push({ ins: 0x24, when: 'after' });
    await take(s, 70).catch(() => {});
    const [held] = s.flow.pending();
    expect(held.state).toBe('ready');
    const slots = held.inputs.map((i: any) => i.slot);
    // CLEAR_SPENT, and maybe a top-up that lands new pieces in the same slots.
    s.card.clearSpent();
    if (after === 'reloaded') {
      await provision(s.card, s.signer, [64, 32]);
      expect(s.card.unspent().filter((p) => slots.includes(p.slot))).toHaveLength(slots.length);
    } else expect(s.card.slots.filter((x, i) => slots.includes(i) && x)).toEqual([]);
    s.card.tap();
    const r1 = await s.flow.read(s.card.transceive);
    // Not dropped: the slots say nothing about this payment. It waits for the PIN.
    expect(r1.unfinished).toBe(true);
    expect(s.flow.pending()[0].state).toBe('ready');
    s.card.tap();
    await s.flow.finish(s.card.transceive, { summary: r1, pin: '1234' });
    const [job] = s.flow.pending();
    expect(job.state).toBe('swapped');
    expect(tokenAmount(job.token)).toBe(70);
  });

  it('every failure after the card signed says the payment is kept, never that nothing was taken', async () => {
    const M: any = await import('../../../public/v2/modules/fund/card/index.js' as string);
    const I18N: any = await import('../../../public/v2/core/i18n.js' as string);
    const t = (k: string, v?: object) => I18N.t(k, v);
    // The phone cannot store the signature it just got.
    const s = setup();
    await s.ready;
    let full = false;
    const storage = { getItem: (k: string) => s.storage.getItem(k), setItem: (k: string, v: string) => (full ? undefined : s.storage.setItem(k, v)) };
    const flow = F.createCardFunding({ storage, relay: s.mint.relay });
    const tx = async (apdu: number[]) => {
      const r = await s.card.transceive(apdu);
      if (apdu[1] === 0x24) full = true;
      return r;
    };
    s.card.tap();
    const summary = await flow.read(tx);
    const info = await flow.mintInfo(summary);
    const e = await flow.pay(tx, { summary, info, plan: flow.plan(summary, info, 100), pin: '1234' }).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'unfinished', kept: true });
    expect(M.wordsFor(e, t)).not.toMatch(/Nothing was taken/);
    expect(s.card.balance()).toBe(0);
    // Room again: the next tap of the card finishes it.
    full = false;
    s.card.lift();
    s.card.tap();
    const r1 = await flow.read(s.card.transceive);
    s.card.tap();
    await flow.finish(s.card.transceive, { summary: r1, pin: '1234' });
    expect(tokenAmount(flow.pending()[0].token)).toBe(100);

    // The mint's answer cannot be unblinded: kept as signed, and resume finishes it from the mint.
    const s2 = setup();
    await s2.ready;
    const swap = s2.mint.relay.swap;
    let garble = true;
    s2.mint.relay.swap = async (b: any) => {
      const r = await swap(b);
      if (!garble) return r;
      garble = false;
      return { ...r, body: { signatures: r.body.signatures.map((x: any) => ({ id: x.id, amount: x.amount, C_: 'zz' })) } };
    };
    const e2 = await take(s2).catch((x: any) => x);
    expect(e2).toMatchObject({ code: 'mint_unavailable', kept: true });
    expect(M.wordsFor(e2, t)).toBe(t('fund.card.kept'));
    expect(s2.flow.pending()[0].state).toBe('signed');
    const handed: string[] = [];
    await s2.flow.resume(async (j: any) => void handed.push(j.token));
    expect(tokenAmount(handed[0]!)).toBe(100);
    // Any kept error, whatever its code, is worded as kept.
    for (const code of ['not_stored', 'card_error', 'tap_lost', 'something new']) expect(M.wordsFor({ code, kept: true }, t)).toBe(t('fund.card.kept'));
  });

  it("another mint's cap: the plan never takes more off the card than the engine then accepts", async () => {
    const s = setup();
    await s.ready;
    s.card.tap();
    const summary = await s.flow.read(s.card.transceive);
    const info = { ...(await s.flow.mintInfo(summary)), max: 40 };
    expect(s.flow.plan(summary, info)).toMatchObject({ amount: 40 });
    expect(s.flow.plan(summary, info, 40)).toMatchObject({ amount: 40, selected: 64 });
    expect(() => s.flow.plan(summary, info, 41)).toThrow(expect.objectContaining({ code: 'over_max', max: 40 }));
    // No cap (the engine's own mint): all of it.
    expect(s.flow.plan(summary, { ...info, max: undefined })).toMatchObject({ amount: 100 });
  });

  it('a phone that cannot store the payment asks the card for nothing', async () => {
    const s = setup();
    await s.ready;
    const bad = { getItem: () => null, setItem: () => {} };
    const flow = F.createCardFunding({ storage: bad, relay: s.mint.relay });
    s.card.tap();
    const summary = await flow.read(s.card.transceive);
    const info = await flow.mintInfo(summary);
    const e = await flow.pay(s.card.transceive, { summary, info, plan: flow.plan(summary, info, 100), pin: '1234' }).catch((x: any) => x);
    expect(e.code).toBe('not_stored');
    expect(s.card.balance()).toBe(100);
    expect(s.card.log.some((l) => l.apdu.startsWith('b024'))).toBe(false);
  });

  it('another card on the antenna at the pay step is refused before anything is asked of it', async () => {
    const s = setup();
    await s.ready;
    s.card.tap();
    const summary = await s.flow.read(s.card.transceive);
    const info = await s.flow.mintInfo(summary);
    const other = new CardSim({ mint: s.mint.url });
    other.tap();
    const e = await s.flow.pay(other.transceive, { summary, info, plan: s.flow.plan(summary, info, 100), pin: '1234' }).catch((x: any) => x);
    expect(e.code).toBe('other_card');
    expect(other.log.some((l) => l.apdu.startsWith('b040'))).toBe(false);
  });

  it('plans: one date at a time, too small for the fee, and all only when the old keyset cannot make change', async () => {
    const s = setup({ fee: 1000 });
    await s.ready;
    await provision(s.card, s.signer, [8], 1700000000).catch(() => {});
    s.card.tap();
    const summary = await s.flow.read(s.card.transceive);
    expect(summary.balance).toBe(100 + 8);
    expect(summary.max).toBe(100);
    const info = await s.flow.mintInfo(summary);
    expect(() => s.flow.plan(summary, info, 1)).toThrow(expect.objectContaining({ code: 'too_small' }));
    expect(F.choosePieces([{ slot: 0, amount: 64 }, { slot: 1, amount: 32 }, { slot: 2, amount: 4 }], 36).map((p: any) => p.slot)).toEqual([1, 2]);
    const old = setup({ oldKeyset: true });
    const oldSigner = { keysetId: old.mint.keysets[1]!.id, keys: old.mint.keys(old.mint.keysets[1]!), sign: (o: any) => old.mint.mintFor(o, old.mint.keysets[1]!) };
    const card = new CardSim({ mint: old.mint.url });
    await provision(card, oldSigner, [8, 4]);
    card.tap();
    const sum2 = await old.flow.read(card.transceive);
    const info2 = await old.flow.mintInfo(sum2);
    expect(() => old.flow.plan(sum2, info2, 5)).toThrow(expect.objectContaining({ code: 'all_only' }));
    // All of it needs no change, so it goes out in the active keyset.
    expect(old.flow.plan(sum2, info2, 12)).toMatchObject({ keyset: old.mint.active.id, change: [] });
  });
});
