// The Cashu card's APDU protocol, version 2 (cashu-javacard spec/APDU.md), ported from flash-pos
// (src/services/cashuCard.ts, read only) with the commands Forge needs to take eCash off a card: read
// it, prove it holds its key, check the PIN, sign one SIG_ALL swap, and load back the card's change.
//
// It knows nothing about NFC. Every command goes through a transceiver, a function that sends the bytes
// of one APDU and resolves to the card's answer (data bytes, then SW1 and SW2). In the Android app that
// is the ForgeNfc plugin (core/native.js); in the tests it is a simulated card. Pure apart from that.
import { randomBytes, schnorrVerify, sha256, toHex, utf8 } from '../cashu.js';

/** The 2.0 package AID: "CASHUCARD" after the proprietary RID byte F0. */
export const PACKAGE_AID = [0xf0, 0x43, 0x41, 0x53, 0x48, 0x55, 0x43, 0x41, 0x52, 0x44];
/** The applet's instance AID, F0 CASHUCARD 01: what a reader selects first. */
export const APPLET_AID = [...PACKAGE_AID, 0x01];
/** The applets 2.0 replaces (0.x and Foxy 1.x): a card that answers one needs an update. */
export const LEGACY_AIDS = [
  [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x02],
  [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x02, 0x01],
  [0xf0, 0x46, 0x4f, 0x58, 0x59, 0x43, 0x41, 0x52, 0x44],
];
export const PROTOCOL_MAJOR = 2;
export const MAX_SLOTS = 128;
export const PROOF_SIZE = 82;
export const PIECE_SIZE = 81;
const CLA = 0xb0;
const OUTPUT_SIZE = 37;
const OUTPUTS_PER_APDU = 6;
const OPENING_SIZE = 80;
const OPENINGS_PER_PAGE = 3;
const MAX_CHANGE_PAGES = 3;
const NAMED_PER_APDU = 3;
/** How many "not yet" answers a signature may take before the phone gives up (cardsim allows 1,100). */
const MAX_SIGN_WAITS = 1100;
const SW_OK = 0x9000;

export const INS = Object.freeze({
  GET_INFO: 0x01,
  GET_PUBKEY: 0x10,
  GET_BALANCE: 0x11,
  AUTH: 0x15,
  GET_CARD: 0x16,
  GET_PIECES: 0x17,
  GET_CHANGE: 0x19,
  SPEND_ALL_BEGIN: 0x22,
  SPEND_ALL_OUTPUTS: 0x23,
  SPEND_ALL_SIGN: 0x24,
  SPEND_ALL_AGAIN: 0x25,
  SPEND_ALL_CHANGE: 0x26,
  LOAD_PROOF: 0x30,
  VERIFY_PIN: 0x40,
});

export const SW = Object.freeze({
  APPLET_NOT_FOUND: 0x6a82,
  ALREADY_OR_PIN: 0x6a94,
  OVER_DAILY_LIMIT: 0x6a8f,
  SECURITY_NOT_SATISFIED: 0x6982,
  PIN_BLOCKED: 0x6983,
  NO_PIN: 0x6984,
  SPENT_OR_NOT_BEGUN: 0x6985,
  LOCKED: 0x6986,
  CARD_FULL: 0x6a84,
});

const hex16 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

/** A command reached the card and the card refused it. sw is the status word. */
export class CardError extends Error {
  constructor(sw, context) {
    super(`${context} failed: ${describeStatusWord(sw, context)} (0x${hex16(sw)})`);
    this.name = 'CardError';
    this.sw = sw;
    this.context = context;
  }
}

/** The card answered 9000 but the answer is malformed (short, wrong length). Never a card refusal. */
export class CardProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CardProtocolError';
  }
}

/** The card runs an older applet (0.x, Foxy 1.x) or another major: nothing is spent from it. */
export class CardNeedsUpdateError extends Error {
  constructor(detail = '') {
    super('This card needs an update');
    this.name = 'CardNeedsUpdateError';
    this.detail = detail;
  }
}

/** The card's AUTH signature does not verify under the key it reported. */
export class CardAuthError extends Error {
  constructor() {
    super('This card could not prove it holds its key');
    this.name = 'CardAuthError';
  }
}

/** Status words in words, for logs and errors. Some words mean different things to different commands. */
export function describeStatusWord(sw, context = '') {
  if ((sw & 0xfff0) === 0x63c0) {
    const tries = sw & 0x000f;
    return tries === 0 ? 'wrong PIN, no tries left' : `wrong PIN, ${tries} ${tries === 1 ? 'try' : 'tries'} left`;
  }
  const command = context.split(' ')[0];
  const paying = command === 'SPEND_ALL_OUTPUTS' || command === 'SPEND_ALL_CHANGE' || command === 'SPEND_ALL_SIGN';
  switch (sw) {
    case 0x9000:
      return 'OK';
    case 0x6982:
      return 'PIN required';
    case 0x6983:
      return 'PIN blocked';
    case 0x6984:
      return 'no PIN set';
    case 0x6a82:
      return 'applet not found';
    case 0x6985:
      return paying ? 'no payment begun' : 'proof already spent';
    case 0x6986:
      return 'card locked';
    case 0x6a80:
      return 'wrong data';
    case 0x6a83:
      return 'slot index out of range';
    case 0x6a84:
      return command === 'SPEND_ALL_CHANGE' ? 'no change opening free' : 'card is full, no free slot';
    case 0x6a88:
      return command === 'SPEND_ALL_AGAIN' ? 'the card has no signature to give again' : 'slot is empty';
    case 0x6a8c:
      return 'the card has no record';
    case 0x6a8e:
      return 'a dated piece on a card with no refund key';
    case 0x6a8f:
      return "over the card's daily limit";
    case 0x6a90:
      return 'the card has no owner';
    case 0x6a94:
      return command === 'SPEND_ALL_SIGN' ? 'PIN needed for this payment' : 'already on the card';
    case 0x6a96:
      return 'too many places for one signature';
    case 0x6f00:
      return 'the card failed to sign';
    case 0x6700:
      return 'wrong length';
    case 0x6d00:
      return 'unsupported command';
    case 0x6e00:
      return 'wrong CLA';
    default:
      return 'unexpected status word';
  }
}

/** PIN tries left from a VERIFY_PIN refusal (63CX), or null when the error is something else. */
export function triesLeftOf(error) {
  return error instanceof CardError && (error.sw & 0xfff0) === 0x63c0 ? error.sw & 0x0f : null;
}

export const isPinBlocked = (e) => e instanceof CardError && e.sw === SW.PIN_BLOCKED;
export const isAppletNotFound = (e) => e instanceof CardError && e.sw === SW.APPLET_NOT_FOUND;
/** SPEND_ALL_SIGN's 6A94: the PIN is needed. Nothing was burned. */
export const isPinNeededForPayment = (e) => e instanceof CardError && e.sw === SW.ALREADY_OR_PIN && e.context.startsWith('SPEND_ALL_SIGN');
/** LOAD_PROOF's 6A94: the piece is already on the card. That counts as loaded. */
export const isAlreadyOnCard = (e) => e instanceof CardError && e.sw === SW.ALREADY_OR_PIN && e.context.startsWith('LOAD_PROOF');

export function buildApdu(ins, { cla = CLA, p1 = 0, p2 = 0, data, le } = {}) {
  const apdu = [cla, ins, p1, p2];
  if (data && data.length > 0) {
    // Short-form Lc is one byte: a longer payload would go out with a wrong length.
    if (data.length > 255) throw new CardProtocolError(`APDU data too long for short Lc: ${data.length} bytes (max 255)`);
    apdu.push(data.length, ...data);
  }
  if (le !== undefined) apdu.push(le);
  return apdu;
}

/** Splits an answer into body and status word; throws CardError on anything but 9000. */
export function parseResponse(response, context) {
  if (!response || response.length < 2) throw new CardProtocolError(`${context}: truncated response (${response?.length ?? 0} bytes)`);
  const sw = (response[response.length - 2] << 8) | response[response.length - 1];
  if (sw !== SW_OK) throw new CardError(sw, context);
  return Array.from(response.slice(0, -2));
}

async function send(transceive, ins, { context, ...opts }) {
  return parseResponse(await transceive(buildApdu(ins, opts)), context);
}

// ------------------------------------------------------------------ bytes

/** Bytes from hex as an array. */
export function fromHex(hex, what = 'value') {
  const clean = String(hex ?? '').replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new CardProtocolError(`${what} is not valid hex`);
  const out = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const readU32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

function checkU32(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new CardProtocolError(`${what} must be a whole number below 2^32, got ${v}`);
}

function checkSlot(slot, what = 'slot') {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) throw new CardProtocolError(`${what} must be 0..${MAX_SLOTS - 1}, got ${slot}`);
}

/** The 8 keyset bytes a card stores: an 8-byte id whole, or the first 8 bytes of a 33-byte v2 id. */
export function cardKeysetBytes(keysetId) {
  if (keysetId.length !== 16 && keysetId.length !== 66) throw new CardProtocolError(`keyset id must be 16 or 66 hex chars, got ${keysetId.length}`);
  return fromHex(keysetId.slice(0, 16), 'keyset id');
}

// ------------------------------------------------------------------ SELECT

async function selectAid(transceive, aid) {
  return parseResponse(await transceive([0x00, 0xa4, 0x04, 0x00, aid.length, ...aid, 0x00]), 'SELECT');
}

/**
 * SELECT the 2.0 applet: the applet AID first, the package AID only after a 6A82. Resolves to the
 * 2-byte version (02 xx). Any other answer from the applet means the card needs an update; an empty
 * 9000 to the package AID is the opener, not the applet. When neither 2.0 AID answers, the old AIDs
 * are tried only to tell a card that needs an update from one that is not an eCash card at all.
 */
export async function selectApplet(transceive) {
  let notFound = null;
  for (const aid of [APPLET_AID, PACKAGE_AID]) {
    let version;
    try {
      version = await selectAid(transceive, aid);
    } catch (e) {
      if (isAppletNotFound(e)) {
        notFound = e;
        continue;
      }
      if (e instanceof CardError) throw new CardNeedsUpdateError(`SELECT answered 0x${hex16(e.sw)}`);
      throw e;
    }
    if (version.length === 2 && version[0] === PROTOCOL_MAJOR) return version;
    if (aid === PACKAGE_AID && version.length === 0) continue;
    throw new CardNeedsUpdateError(`SELECT answered version ${toHex(version) || '(none)'}`);
  }
  for (const aid of LEGACY_AIDS) {
    let answered = false;
    try {
      await selectAid(transceive, aid);
      answered = true;
    } catch (e) {
      if (!(e instanceof CardError)) throw e;
    }
    if (answered) throw new CardNeedsUpdateError(`old applet ${toHex(aid)}`);
  }
  throw notFound ?? new CardError(SW.APPLET_NOT_FOUND, 'SELECT');
}

// ------------------------------------------------------------------ reads

const PIN_STATES = { 0: 'unset', 1: 'set', 2: 'blocked' };

/** GET_INFO's body: 30 bytes with P1 = 0, 42 with P1 = 1. */
export function parseInfo(body) {
  if (body.length < 30) throw new CardProtocolError(`GET_INFO: expected at least 30 bytes, got ${body.length}`);
  const info = {
    version: `${body[0]}.${body[1]}`,
    major: body[0],
    minor: body[1],
    maxSlots: body[2],
    unspent: body[3],
    spent: body[4],
    empty: body[5],
    pinState: PIN_STATES[body[7]] ?? 'unknown',
    format: body[8],
    triesLeft: body[9],
    locked: body[10] === 1,
    recordSet: body[11] === 1,
    dailyLimit: readU32(body, 12),
    hasOwner: body[16] === 1,
    now: readU32(body, 17),
    windowStart: readU32(body, 21),
    spentToday: readU32(body, 25),
    changeGrant: body[29] === 1,
  };
  if (body.length >= 42) {
    info.paymentLimit = readU32(body, 30);
    info.allowance = readU32(body, 34);
    info.noPinSpent = readU32(body, 38);
  }
  return info;
}

export async function getInfo(transceive, { p1 = 1 } = {}) {
  const info = parseInfo(await send(transceive, INS.GET_INFO, { p1, le: 0x00, context: 'GET_INFO' }));
  if (info.major !== PROTOCOL_MAJOR) throw new CardNeedsUpdateError(`GET_INFO version ${info.version}`);
  return info;
}

/** The card's compressed secp256k1 key (33 bytes): its P2PK identity. */
export async function getPubkey(transceive) {
  const body = await send(transceive, INS.GET_PUBKEY, { le: 0x21, context: 'GET_PUBKEY' });
  if (body.length !== 33) throw new CardProtocolError(`GET_PUBKEY: expected 33 bytes, got ${body.length}`);
  return body;
}

/** VERIFY_PIN for this tap. A wrong PIN rejects with 63CX (X tries left), a blocked one with 6983. */
export async function verifyPin(transceive, pin) {
  const s = String(pin);
  if (!/^[0-9]{4,8}$/.test(s)) throw new CardProtocolError('a card PIN is 4 to 8 digits');
  await send(transceive, INS.VERIFY_PIN, { data: Array.from(s, (c) => c.charCodeAt(0)), context: 'VERIFY_PIN' });
}

function parsePiece(slot, status, b, at) {
  return {
    slot,
    status,
    keysetId: toHex(b.slice(at, at + 8)),
    amount: readU32(b, at + 8),
    nonce: toHex(b.slice(at + 12, at + 44)),
    C: toHex(b.slice(at + 44, at + 77)),
    date: readU32(b, at + 77),
  };
}

/**
 * GET_PIECES P2 = 3's body: next, then for each unspent slot its number (0x80 set where its keyset (8)
 * and date (4) follow), then the power of two it is worth, or FF and its amount (4).
 */
export function parseShortListing(body, from) {
  if (body.length < 1) throw new CardProtocolError('GET_PIECES (short): empty answer');
  const next = body[0];
  if (next <= from || next > MAX_SLOTS) throw new CardProtocolError(`GET_PIECES (short): an answer from ${from} says it ends at ${next}`);
  const pieces = [];
  let keysetId = null;
  let date = 0;
  let last = from - 1;
  let at = 1;
  const need = (n, what) => {
    if (at + n > body.length) throw new CardProtocolError(`GET_PIECES (short): ${what} is cut short at byte ${at}`);
  };
  while (at < body.length) {
    const tag = body[at++];
    const slot = tag & 0x7f;
    if (slot <= last || slot >= next) throw new CardProtocolError(`GET_PIECES (short): slot ${slot} out of order in ${from}..${next - 1}`);
    last = slot;
    if (tag & 0x80) {
      need(12, `slot ${slot}'s keyset and date`);
      keysetId = toHex(body.slice(at, at + 8));
      date = readU32(body, at + 8);
      at += 12;
    } else if (keysetId === null) throw new CardProtocolError(`GET_PIECES (short): slot ${slot} names no keyset and none came before it`);
    need(1, `slot ${slot}'s size`);
    const size = body[at++];
    let amount;
    if (size === 0xff) {
      need(4, `slot ${slot}'s amount`);
      amount = readU32(body, at);
      at += 4;
    } else if (size <= 31) amount = 2 ** size;
    else throw new CardProtocolError(`GET_PIECES (short): slot ${slot}'s size byte 0x${size.toString(16)}`);
    pieces.push({ slot, keysetId, amount, date });
  }
  return { next, pieces };
}

/** Every unspent piece's slot, keyset, date and amount: the short listing, answer by answer. */
export async function getPiecesShort(transceive) {
  const pieces = [];
  let from = 0;
  while (from < MAX_SLOTS) {
    const page = parseShortListing(await send(transceive, INS.GET_PIECES, { p1: from, p2: 0x03, le: 0x00, context: `GET_PIECES short from ${from}` }), from);
    pieces.push(...page.pieces);
    from = page.next;
  }
  return pieces;
}

/** GET_PIECES P2 = 2: the named slots whole (status, then 81 bytes), three to an APDU. */
export async function getPiecesNamed(transceive, slots) {
  slots.forEach((s) => checkSlot(s));
  const out = [];
  for (let i = 0; i < slots.length; i += NAMED_PER_APDU) {
    const asked = slots.slice(i, i + NAMED_PER_APDU);
    const body = await send(transceive, INS.GET_PIECES, { p2: 0x02, data: asked, le: 0x00, context: `GET_PIECES slots ${asked.join(',')}` });
    if (body.length !== asked.length * PROOF_SIZE) throw new CardProtocolError(`GET_PIECES (named): expected ${asked.length * PROOF_SIZE} bytes, got ${body.length}`);
    asked.forEach((slot, k) => {
      const at = k * PROOF_SIZE;
      const status = body[at];
      if (status === 0x00) return out.push({ slot, status: 'empty', piece: null });
      if (status !== 0x01 && status !== 0x02) throw new CardProtocolError(`GET_PIECES (named): slot ${slot} has status byte 0x${status.toString(16)}`);
      const state = status === 0x01 ? 'unspent' : 'spent';
      out.push({ slot, status: state, piece: parsePiece(slot, state, body, at + 1) });
    });
  }
  return out;
}

/** GET_CARD's record: the unit (0 is sat), the refund key and the mint the card's pieces belong to. */
export function parseCardRecord(b) {
  if (b.length < 106) throw new CardProtocolError(`GET_CARD: expected at least 106 bytes, got ${b.length}`);
  const mintLength = b[105];
  if (106 + mintLength > b.length) throw new CardProtocolError(`GET_CARD: the mint is ${mintLength} bytes and the record ${b.length}`);
  const refund = b.slice(7, 40);
  return {
    format: b[0],
    recordSet: b[1] === 1,
    unit: b[2],
    dailyLimit: readU32(b, 3),
    refundKey: refund.every((x) => x === 0) ? null : toHex(refund),
    mint: new TextDecoder().decode(Uint8Array.from(b.slice(106, 106 + mintLength))),
  };
}

export async function getCard(transceive) {
  return parseCardRecord(await send(transceive, INS.GET_CARD, { le: 0x00, context: 'GET_CARD' }));
}

// ------------------------------------------------------------------ AUTH

export const AUTH_TAG = 'CashuCard/auth';

/** SHA-256(T ‖ T ‖ reader (16) ‖ card (16) ‖ card key (33)), T = SHA-256("CashuCard/auth"). */
export function authMessage(readerNonce, cardNonce, cardPubkey) {
  const tag = sha256(utf8(AUTH_TAG));
  const body = new Uint8Array(32 + 32 + 16 + 16 + 33);
  body.set(tag, 0);
  body.set(tag, 32);
  body.set(Uint8Array.from(readerNonce), 64);
  body.set(Uint8Array.from(cardNonce), 80);
  body.set(Uint8Array.from(cardPubkey), 96);
  return sha256(body);
}

/** AUTH: the card on the antenna proves it holds cardPubkey. Throws CardAuthError when it cannot. */
export async function auth(transceive, cardPubkey, readerNonce = Array.from(randomBytes(16))) {
  if (readerNonce.length !== 16) throw new CardProtocolError(`AUTH: the reader's nonce is 16 bytes, got ${readerNonce.length}`);
  const body = await send(transceive, INS.AUTH, { data: readerNonce, le: 0x50, context: 'AUTH' });
  if (body.length !== 80) throw new CardProtocolError(`AUTH: expected 80 bytes, got ${body.length}`);
  const message = authMessage(readerNonce, body.slice(0, 16), cardPubkey);
  if (!schnorrVerify(toHex(body.slice(16)), message, toHex(cardPubkey))) throw new CardAuthError();
}

// ------------------------------------------------------------------ paying: one SIG_ALL signature

/** SPEND_ALL_BEGIN: the slots, in the order their pieces go into the message. Resolves to their sum. */
export async function spendAllBegin(transceive, slots) {
  if (slots.length < 1 || slots.length > MAX_SLOTS) throw new CardProtocolError(`SPEND_ALL_BEGIN: a payment names 1 to ${MAX_SLOTS} slots, got ${slots.length}`);
  slots.forEach((s) => checkSlot(s));
  const body = await send(transceive, INS.SPEND_ALL_BEGIN, { data: slots, le: 0x04, context: 'SPEND_ALL_BEGIN' });
  if (body.length !== 4) throw new CardProtocolError(`SPEND_ALL_BEGIN: expected 4 bytes, got ${body.length}`);
  return readU32(body, 0);
}

/** SPEND_ALL_OUTPUTS: the phone's outputs ({amount, B_}), in order, six to an APDU. */
export async function spendAllOutputs(transceive, outputs) {
  if (!outputs.length) throw new CardProtocolError('SPEND_ALL_OUTPUTS: no outputs');
  const encoded = outputs.map((o) => {
    checkU32(o.amount, 'output amount');
    const B_ = fromHex(o.B_, 'B_');
    if (B_.length !== 33) throw new CardProtocolError(`SPEND_ALL_OUTPUTS: B_ must be 33 bytes, got ${B_.length}`);
    return [...u32(o.amount), ...B_];
  });
  for (let i = 0; i < encoded.length; i += OUTPUTS_PER_APDU) {
    const data = encoded.slice(i, i + OUTPUTS_PER_APDU).flat();
    if (data.length % OUTPUT_SIZE !== 0) throw new CardProtocolError('SPEND_ALL_OUTPUTS: misframed outputs');
    await send(transceive, INS.SPEND_ALL_OUTPUTS, { data, context: 'SPEND_ALL_OUTPUTS' });
  }
}

/** SPEND_ALL_CHANGE: one change output the card makes for itself. Resolves to its B_ (hex). */
export async function spendAllChange(transceive, amount) {
  checkU32(amount, 'change amount');
  if (amount === 0) throw new CardProtocolError('SPEND_ALL_CHANGE: change of 0');
  const body = await send(transceive, INS.SPEND_ALL_CHANGE, { data: u32(amount), le: 0x21, context: 'SPEND_ALL_CHANGE' });
  if (body.length !== 33) throw new CardProtocolError(`SPEND_ALL_CHANGE: expected 33 bytes, got ${body.length}`);
  return toHex(body);
}

const signature = (sig, command) => {
  if (sig.length !== 64) throw new CardProtocolError(`${command}: expected a 64-byte signature, got ${sig.length}`);
  return toHex(sig);
};

/**
 * SPEND_ALL_SIGN: the one signature over the whole payment (hex). Irreversible: every slot named at
 * BEGIN is burned in the commit that releases it. A card lifted after the commit and before the answer
 * has burned its pieces and the answer is lost; SPEND_ALL_AGAIN gives it again. "Not yet" (00 01) while
 * the payment is over the card's limit on one payment: asked again.
 */
export async function spendAllSign(transceive) {
  for (let waits = 0; waits <= MAX_SIGN_WAITS; waits++) {
    const body = await send(transceive, INS.SPEND_ALL_SIGN, { le: 0x40, context: 'SPEND_ALL_SIGN' });
    if (body.length === 2 && body[0] === 0x00 && body[1] === 0x01) continue;
    return signature(body, 'SPEND_ALL_SIGN');
  }
  throw new CardProtocolError(`SPEND_ALL_SIGN: the card made the payment wait more than ${MAX_SIGN_WAITS} times`);
}

/** SPEND_ALL_AGAIN: the last signature SPEND_ALL_SIGN gave, again (hex). The caller checks it against its payment. */
export async function spendAllAgain(transceive) {
  return signature(await send(transceive, INS.SPEND_ALL_AGAIN, { le: 0x40, context: 'SPEND_ALL_AGAIN' }), 'SPEND_ALL_AGAIN');
}

// ------------------------------------------------------------------ the card's own change

export function parseChangePage(body) {
  if (body.length < 1) throw new CardProtocolError('GET_CHANGE: empty answer');
  const count = body[0];
  if (count > OPENINGS_PER_PAGE || body.length !== 1 + count * OPENING_SIZE) throw new CardProtocolError(`GET_CHANGE: ${count} openings in ${body.length} bytes`);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = 1 + i * OPENING_SIZE;
    out.push({ amount: readU32(body, at), keysetId: toHex(body.slice(at + 4, at + 12)), date: readU32(body, at + 12), nonce: toHex(body.slice(at + 16, at + 48)), r: toHex(body.slice(at + 48, at + 80)) });
  }
  return out;
}

/** GET_CHANGE, every page: openings of change the card signed for and that are not back on it yet. */
export async function getChange(transceive) {
  const out = [];
  for (let page = 0; page < MAX_CHANGE_PAGES; page++) {
    const openings = parseChangePage(await send(transceive, INS.GET_CHANGE, { p1: page, le: 0x00, context: `GET_CHANGE page ${page}` }));
    out.push(...openings);
    if (openings.length < OPENINGS_PER_PAGE) break;
  }
  return out;
}

/**
 * LOAD_PROOF: stores a piece {keysetId, amount, nonce, C, date} in the next free slot. Needs the PIN in
 * this tap, the tap after a payment (the change grant), or a card with no PIN. 6A94 means the piece is
 * already there (isAlreadyOnCard): the caller counts it as loaded. Resolves to the slot.
 */
export async function loadProof(transceive, piece) {
  const keyset = cardKeysetBytes(piece.keysetId);
  checkU32(piece.amount, 'LOAD_PROOF amount');
  const date = piece.date ?? 0;
  checkU32(date, 'LOAD_PROOF date');
  const nonce = fromHex(piece.nonce, 'nonce');
  const C = fromHex(piece.C, 'C');
  if (nonce.length !== 32 || C.length !== 33) throw new CardProtocolError(`LOAD_PROOF: expected 32-byte nonce and 33-byte C, got ${nonce.length}/${C.length}`);
  const body = await send(transceive, INS.LOAD_PROOF, { p1: 0x00, data: [...keyset, ...u32(piece.amount), ...nonce, ...C, ...u32(date)], le: 0x01, context: 'LOAD_PROOF' });
  if (body.length !== 1) throw new CardProtocolError(`LOAD_PROOF: expected 1 byte, got ${body.length}`);
  return body[0];
}

// ------------------------------------------------------------------ the read

/**
 * The read at the start of every tap: SELECT, GET_INFO, GET_CARD, GET_PUBKEY, AUTH, then the short
 * listing of the unspent pieces. Touches nothing on the card. AUTH makes the read honest: what is shown
 * is what the card that proved its key holds.
 */
export async function readCard(transceive) {
  const version = await selectApplet(transceive);
  const info = await getInfo(transceive);
  const record = await getCard(transceive);
  const pubkey = await getPubkey(transceive);
  await auth(transceive, pubkey);
  const pieces = await getPiecesShort(transceive);
  return {
    appletVersion: `${version[0]}.${version[1]}`,
    info,
    record,
    pubkey: toHex(pubkey),
    pieces,
    balance: pieces.reduce((s, p) => s + p.amount, 0),
  };
}
