// Taking eCash off a Cashu card into the balance (slice A13). The protocol is core/card/apdu.js; the
// Cashu arithmetic is core/cashu.js; the card's mint is reached through the engine (relay below), so
// the phone still talks only to its engine.
//
// The steps, in one tap where the card stays on the phone:
//   1. read: the card proves its key (AUTH) and lists its pieces, its mint and its unit.
//   2. plan: which pieces, what the card's mint charges, how much comes to the phone and what goes back
//      to the card as change.
//   3. pay: the PIN, then the phone makes its outputs and the card signs one SIG_ALL swap over its
//      pieces, the phone's outputs and its own change. Signing burns the pieces on the card.
//   4. settle: the swap at the card's mint. The phone unblinds its outputs into eCash (a cashuB token).
//   5. the card's change goes back onto it (same tap, or the next tap of that card).
//
// Never lose money: before the card is asked to sign, everything needed to finish the swap without the
// card (the pieces' secrets, the phone's outputs and their blinding factors, the card's change outputs)
// is written to the phone's storage and read back. The signature is written the moment it arrives. A
// tap that breaks after that is finished from storage: the swap is sent again, and if the mint already
// did it (its answer was lost), the phone asks the mint for its signatures again (NUT-09 restore). A tap
// that breaks while the card signs is finished at the next tap of the same card: the card either still
// has its pieces (nothing happened) or gives its last signature again (SPEND_ALL_AGAIN), which is
// checked against the stored payment before it is used. The token is kept with the job until the
// caller has it in the vault (handed()). Storage is passed in (localStorage in the page, a Map in tests).
import * as apdu from './apdu.js';
import { blind, cardSecret, fromHex, randomBytes, schnorrVerify, sigAllMessage, splitAmount, toHex, unblind, verifyDleq, encodeToken } from '../cashu.js';

const STORE = 'forge2.cards';
/** Openings a card keeps for its change (spec/APDU.md GET_CHANGE). */
const MAX_OPENINGS = 8;
/**
 * Mint codes (NUT-00, Nutshell 0.22.1 cashu/core/errors.py) that mean this swap may already have been
 * done: the inputs are spent (11001) or in a swap now (11002), or the outputs are signed (11003).
 */
const SPENT = 11001;
const PENDING = 11002;
const OUTPUTS_SIGNED = 11003;

/** Units a card's record can name. Only sat is defined (0). */
const UNITS = { 0: 'sat' };

export class CardFlowError extends Error {
  /**
   * code: not_ecash, needs_update, not_genuine, locked, empty, wrong_unit, pin_wrong (triesLeft),
   * pin_blocked, pin_needed, over_limit, other_card, too_small, all_only, card_full, tap_lost,
   * mint_refused, mint_unavailable, mint_unlisted, not_taken, unfinished, card_error.
   * kept: true when a job holds the money on this phone and will be finished later.
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CardFlowError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** What a failure from the card means, as a CardFlowError. */
export function cardFailure(e) {
  if (e instanceof CardFlowError) return e;
  const tries = apdu.triesLeftOf(e);
  if (tries !== null) return tries === 0 ? new CardFlowError('pin_blocked', e.message) : new CardFlowError('pin_wrong', e.message, { triesLeft: tries });
  if (apdu.isPinBlocked(e)) return new CardFlowError('pin_blocked', e.message);
  if (apdu.isAppletNotFound(e)) return new CardFlowError('not_ecash', e.message);
  if (e instanceof apdu.CardNeedsUpdateError) return new CardFlowError('needs_update', e.message);
  if (e instanceof apdu.CardAuthError) return new CardFlowError('not_genuine', e.message);
  if (apdu.isPinNeededForPayment(e) || (e instanceof apdu.CardError && e.sw === apdu.SW.SECURITY_NOT_SATISFIED)) return new CardFlowError('pin_needed', e.message);
  if (e instanceof apdu.CardError && e.sw === apdu.SW.OVER_DAILY_LIMIT) return new CardFlowError('over_limit', e.message);
  if (e instanceof apdu.CardError && e.sw === apdu.SW.LOCKED) return new CardFlowError('locked', e.message);
  if (e instanceof apdu.CardError && e.sw === apdu.SW.CARD_FULL) return new CardFlowError('card_full', e.message);
  if (e instanceof apdu.CardError || e instanceof apdu.CardProtocolError) return new CardFlowError('card_error', e.message);
  // Anything else came from the transport: the card left the field, or the reader timed out.
  return new CardFlowError('tap_lost', e?.message ?? String(e));
}

// ------------------------------------------------------------------ the store

export function createCardStore(storage) {
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(STORE) ?? '{}');
      return { jobs: Array.isArray(v.jobs) ? v.jobs : [] };
    } catch {
      return { jobs: [] };
    }
  };
  const write = (v) => {
    storage.setItem(STORE, JSON.stringify(v));
    // Nothing is signed on the strength of a write that did not land: read it back to be sure.
    if (JSON.stringify(read()) !== JSON.stringify(v)) throw new CardFlowError('not_stored', 'This phone could not store the card payment. Nothing was taken from the card.');
  };
  return {
    jobs: () => read().jobs,
    get: (id) => read().jobs.find((j) => j.id === id) ?? null,
    put(job) {
      const v = read();
      const i = v.jobs.findIndex((j) => j.id === job.id);
      if (i >= 0) v.jobs[i] = job;
      else v.jobs.push(job);
      write(v);
      return job;
    },
    remove(id) {
      const v = read();
      v.jobs = v.jobs.filter((j) => j.id !== id);
      write(v);
    },
  };
}

// ------------------------------------------------------------------ planning

/** The full keyset id for the 8 bytes a card keeps, from the mint's keysets. */
export function expandKeyset(short, keysets) {
  const s = short.toLowerCase();
  const found = keysets.filter((k) => k.id.toLowerCase().slice(0, 16) === s);
  if (found.length !== 1) throw new CardFlowError('mint_refused', found.length ? 'two of the mint keysets share the card keyset prefix' : "the card's mint does not list this card's keyset");
  return found[0];
}

/** Pieces grouped by date: one payment takes pieces of one date (spec/APDU.md SPEND_ALL_BEGIN). Largest first. */
export function pieceGroups(pieces) {
  const by = new Map();
  for (const p of pieces) {
    if (!by.has(p.date)) by.set(p.date, []);
    by.get(p.date).push(p);
  }
  return [...by.values()].map((ps) => ({ date: ps[0].date, pieces: ps, total: ps.reduce((s, p) => s + p.amount, 0) })).sort((a, b) => b.total - a.total);
}

/**
 * Pieces that cover amount with as little change as a greedy pass finds: the largest pieces that fit
 * what is still needed (exact whenever the pieces allow it, as powers of two mostly do), then the
 * smallest piece that covers the rest.
 */
export function choosePieces(pieces, amount) {
  const total = pieces.reduce((s, p) => s + p.amount, 0);
  if (amount >= total) return [...pieces];
  const desc = [...pieces].sort((a, b) => b.amount - a.amount || a.slot - b.slot);
  const out = [];
  let need = amount;
  for (const p of desc) {
    if (p.amount <= need) {
      out.push(p);
      need -= p.amount;
    }
  }
  if (need > 0) {
    const rest = desc.filter((p) => !out.includes(p));
    const one = rest.filter((p) => p.amount >= need).sort((a, b) => a.amount - b.amount)[0];
    if (one) out.push(one);
    else
      for (const p of rest) {
        out.push(p);
        need -= p.amount;
        if (need <= 0) break;
      }
  }
  let sum = out.reduce((s, p) => s + p.amount, 0);
  // Drop any piece the rest still covers without.
  for (const p of [...out].sort((a, b) => a.amount - b.amount)) {
    if (sum - p.amount >= amount) {
      out.splice(out.indexOf(p), 1);
      sum -= p.amount;
    }
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/**
 * The plan for taking amount off the card. info is the card's mint as the relay gives it: {keysets:
 * [{id, unit, active, input_fee_ppk}], keys: {id: {amount: K}}}. Returns {slots, pieces, selected,
 * amount, fee, receive, outputs (amounts to the phone), change (amounts back to the card), keyset (full
 * id of the outputs), inputKeysets}. Throws CardFlowError too_small or all_only.
 */
export function planTake(summary, info, amount) {
  const group = pieceGroups(summary.pieces)[0];
  if (!group || !group.total) throw new CardFlowError('empty', 'This card is empty.');
  const want = Math.min(Math.max(1, Math.floor(amount ?? group.total)), group.total);
  const pieces = choosePieces(group.pieces, want);
  const selected = pieces.reduce((s, p) => s + p.amount, 0);
  const inputKeysets = pieces.map((p) => expandKeyset(p.keysetId, info.keysets));
  const fee = Math.ceil(inputKeysets.reduce((s, k) => s + (k.input_fee_ppk ?? 0), 0) / 1000);
  const changeTotal = selected - want;
  const first = inputKeysets[0];
  // The card's change is made in the payment's keyset, which it records with the opening: that keyset
  // must still be one the mint signs with.
  if (changeTotal > 0 && !first.active) throw new CardFlowError('all_only', "The card's mint no longer makes change for this card. Take all of it.");
  const out = first.active ? first : info.keysets.find((k) => k.active && k.unit === summary.unit && info.keys?.[k.id]);
  if (!out || !info.keys?.[out.id]) throw new CardFlowError('mint_refused', `the card's mint has no active ${summary.unit} keyset`);
  const receive = want - fee;
  if (receive < 1) throw new CardFlowError('too_small', 'This amount is smaller than what the card mint charges to move it.');
  const change = splitAmount(changeTotal);
  if (change.length > MAX_OPENINGS - (summary.owedOpenings ?? 0)) throw new CardFlowError('all_only', 'The card cannot take that much change back. Take all of it, or another amount.');
  return { slots: pieces.map((p) => p.slot), pieces, selected, amount: want, fee, receive, outputs: splitAmount(receive), change, keyset: out.id, inputKeysets: inputKeysets.map((k) => k.id) };
}

// ------------------------------------------------------------------ the flow

const newId = () => 'card_' + toHex(randomBytes(8));

/**
 * relay: {mint({mint, unit, accept_unlisted}), swap({mint, inputs, outputs}), restore({mint, outputs})},
 * each resolving to {ok, status, body} as the engine client's call() does.
 */
export function createCardFunding({ storage, relay, now = () => Date.now() }) {
  const store = createCardStore(storage);

  /** The card's mint through the engine: its keysets and the keys of the active ones. */
  async function mintInfo(summary, { acceptUnlisted = false } = {}) {
    let r;
    try {
      r = await relay.mint({ mint: summary.mint, unit: summary.unit, ...(acceptUnlisted ? { accept_unlisted: true } : {}) });
    } catch {
      throw new CardFlowError('mint_unavailable', 'The engine could not be reached.');
    }
    if (!r.ok) {
      const code = r.body?.error?.code;
      const message = r.body?.error?.message ?? `HTTP ${r.status}`;
      if (code === 'mint_unlisted') throw new CardFlowError('mint_unlisted', message, { mint: r.body?.unlisted?.mint ?? summary.mint });
      if (r.status >= 500 || r.status === 429 || r.status === 0) throw new CardFlowError('mint_unavailable', message);
      throw new CardFlowError('not_taken', message, { reason: code });
    }
    return r.body;
  }

  /**
   * Step 1. Reads the card: SELECT, GET_INFO, GET_CARD, its key and AUTH. Before listing the pieces it
   * finishes what this card left open on this phone where it can without the PIN (a lost signature on
   * a card with no PIN, change owed in the tap after a payment), and settles those swaps while the card
   * is still here. Then the pieces and the card's open change outputs. unfinished: something for this
   * card still waits for its PIN (finish()).
   */
  async function read(tx) {
    let info;
    let record;
    let pubkey;
    try {
      await apdu.selectApplet(tx);
      info = await apdu.getInfo(tx);
      record = await apdu.getCard(tx);
      pubkey = toHex(await apdu.getPubkey(tx));
      await apdu.auth(tx, fromHex(pubkey));
    } catch (e) {
      throw cardFailure(e);
    }
    if (info.locked) throw new CardFlowError('locked', 'This card is locked.');
    await finishHere(tx, pubkey, info.pinState !== 'set');
    let pieces;
    let openings;
    try {
      pieces = await apdu.getPiecesShort(tx);
      openings = await apdu.getChange(tx);
    } catch (e) {
      throw cardFailure(e);
    }
    const groups = pieceGroups(pieces);
    return {
      pubkey,
      mint: record.mint,
      refundKey: record.refundKey,
      unit: UNITS[record.unit] ?? null,
      pinState: info.pinState,
      triesLeft: info.triesLeft,
      pieces,
      balance: pieces.reduce((s, p) => s + p.amount, 0),
      max: groups[0]?.total ?? 0,
      owedOpenings: openings.length,
      unfinished: owedTo(pubkey).length > 0,
    };
  }

  /** finishOnCard, then the swaps it unblocked, then their change, while the card is on the antenna. */
  async function finishHere(tx, pubkey, pinOk) {
    try {
      await finishOnCard(tx, pubkey, { pinOk });
    } catch (e) {
      throw cardFailure(e);
    }
    for (const job of store.jobs().filter((j) => j.cardKey === pubkey && j.state === 'signed')) {
      try {
        const done = await settle(job);
        if (done?.changeOwed) await loadChange(tx, done);
      } catch {
        // Left for resume(): the money is kept on this phone.
      }
    }
  }

  /** A tap to finish what this card left open, with its PIN. Resolves to the summary read after. */
  async function finish(tx, { summary, pin }) {
    try {
      await sameCard(tx, summary.pubkey);
      if (summary.pinState === 'set') await apdu.verifyPin(tx, pin);
    } catch (e) {
      throw cardFailure(e);
    }
    await finishHere(tx, summary.pubkey, true);
    return read(tx);
  }

  const owedTo = (pubkey) => store.jobs().filter((j) => j.cardKey === pubkey && (j.changeOwed || j.state === 'ready' || j.state === 'signed'));

  /** The same card is on the antenna: SELECT, its key, AUTH. */
  async function sameCard(tx, pubkey) {
    await apdu.selectApplet(tx);
    const key = toHex(await apdu.getPubkey(tx));
    if (key !== pubkey) throw new CardFlowError('other_card', 'This is a different card.');
    await apdu.auth(tx, fromHex(key));
  }

  const cardInputs = (job) => job.inputs.map((i, n) => ({ amount: i.amount, id: i.id, secret: i.secret, C: i.C, ...(n === 0 && job.sig ? { witness: JSON.stringify({ signatures: [job.sig] }) } : {}) }));
  const allOutputs = (job) => [...job.outputs, ...job.change].map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ }));
  const message = (job) => sigAllMessage(job.inputs, [...job.outputs, ...job.change]);

  /**
   * Finishes what this card left open on this phone, at the start of a tap: a payment whose signature
   * was lost (its pieces burned or not), and change still owed to it. Needs the PIN for the lost
   * signature and, outside the tap after a payment, for the change: callers pass pinOk.
   */
  async function finishOnCard(tx, pubkey, { pinOk = false } = {}) {
    const mine = store.jobs().filter((j) => j.cardKey === pubkey);
    for (const job of mine.filter((j) => j.state === 'ready')) {
      const named = await apdu.getPiecesNamed(tx, job.inputs.map((i) => i.slot));
      const burned = named.every((n) => n.status === 'spent' && n.piece?.C === job.inputs.find((i) => i.slot === n.slot)?.C);
      if (!burned) {
        // The card never signed: its pieces are still there and nothing moved.
        if (named.every((n) => n.status === 'unspent')) store.remove(job.id);
        continue;
      }
      if (!pinOk && job.pinSet) continue;
      let sig;
      try {
        sig = await apdu.spendAllAgain(tx);
      } catch (e) {
        // The card left: try again at its next tap. The PIN missing: wait for it.
        if (!(e instanceof apdu.CardError)) throw e;
        if (e.sw === apdu.SW.SECURITY_NOT_SATISFIED) continue;
        // The card has no signature to give (6A88), or refuses another way: this payment cannot be
        // finished from the card. It is kept, marked, and no longer stands in the way of the card.
        store.put({ ...job, state: 'failed', error: `the card could not give its signature again (${e.message})` });
        continue;
      }
      if (!schnorrVerify(sig, message(job), pubkey)) {
        store.put({ ...job, state: 'failed', error: 'the card gave a signature for another payment' });
        continue;
      }
      store.put({ ...job, sig, state: 'signed' });
    }
    for (const job of store.jobs().filter((j) => j.cardKey === pubkey && j.state === 'swapped' && j.changeOwed)) {
      try {
        await loadChange(tx, job);
      } catch (e) {
        // The card left: the change waits for its next tap. A refusal (no PIN in this tap, a full card)
        // keeps it owed too, and never stops the card being read.
        if (!(e instanceof apdu.CardError)) throw e;
      }
    }
  }

  /** Puts the card's change back on it, from the mint's signatures kept with the job. */
  async function loadChange(tx, job) {
    const openings = await apdu.getChange(tx);
    let loaded = 0;
    for (const c of job.change) {
      if (c.loaded) continue;
      const o = openings.find((x) => blind(cardSecret(x.nonce, job.cardKey, x.date, job.refundKey), x.r).B_ === c.B_);
      if (!o) {
        // The card no longer holds the opening: the piece is on it already.
        c.loaded = true;
        continue;
      }
      const C = unblind(c.C_, o.r, c.K);
      try {
        await apdu.loadProof(tx, { keysetId: c.id, amount: c.amount, nonce: o.nonce, C, date: o.date });
      } catch (e) {
        if (!apdu.isAlreadyOnCard(e)) {
          store.put(job);
          throw e;
        }
      }
      c.loaded = true;
      loaded++;
    }
    const done = job.change.every((c) => c.loaded);
    if (done && !job.token) store.remove(job.id);
    else store.put({ ...job, changeOwed: !done });
    return loaded;
  }

  /**
   * Step 4. The swap at the card's mint, through the engine. Resolves to the job with its token. A
   * failure keeps the job (and so the money) on the phone; CardFlowError says whether trying again
   * later can help (mint_unavailable) or the mint said no (mint_refused).
   */
  async function settle(jobOrId) {
    let job = typeof jobOrId === 'string' ? store.get(jobOrId) : jobOrId;
    if (!job || job.state !== 'signed') return job;
    const outputs = allOutputs(job);
    let r;
    try {
      r = await relay.swap({ mint: job.mint, inputs: cardInputs(job), outputs, ...(job.acceptUnlisted ? { accept_unlisted: true } : {}) });
    } catch {
      throw new CardFlowError('mint_unavailable', 'The engine could not be reached. The eCash is kept on this phone.', { kept: true });
    }
    let sigs = r.ok ? r.body?.signatures : null;
    if (!r.ok) {
      const mintCode = r.body?.mint_code;
      if (mintCode === SPENT || mintCode === PENDING || mintCode === OUTPUTS_SIGNED) {
        // The mint has these pieces already: the swap went through and its answer was lost, or it is
        // going through now. Its signatures for our outputs are asked for again.
        let rr;
        try {
          rr = await relay.restore({ mint: job.mint, outputs, ...(job.acceptUnlisted ? { accept_unlisted: true } : {}) });
        } catch {
          throw new CardFlowError('mint_unavailable', 'The engine could not be reached. The eCash is kept on this phone.', { kept: true });
        }
        const got = rr.ok ? matchRestored(outputs, rr.body) : null;
        if (!got) throw new CardFlowError(mintCode === PENDING ? 'mint_unavailable' : 'mint_refused', 'The card mint has not finished this payment yet.', { kept: true });
        sigs = got;
      } else if (r.status >= 500 || r.status === 429 || r.status === 0 || r.body?.error?.code === 'mint_unavailable') {
        throw new CardFlowError('mint_unavailable', r.body?.error?.message ?? `HTTP ${r.status}`, { kept: true });
      } else {
        store.put({ ...job, state: 'failed', error: r.body?.error?.message ?? `HTTP ${r.status}` });
        throw new CardFlowError('mint_refused', r.body?.error?.message ?? `HTTP ${r.status}`, { kept: true });
      }
    }
    if (!Array.isArray(sigs) || sigs.length !== outputs.length) throw new CardFlowError('mint_unavailable', 'The card mint answered without its signatures.', { kept: true });
    const proofs = [];
    const change = [];
    sigs.forEach((sig, i) => {
      const o = i < job.outputs.length ? job.outputs[i] : job.change[i - job.outputs.length];
      const K = job.keys?.[o.id]?.[String(o.amount)];
      if (!K || sig.id !== o.id || Number(sig.amount) !== o.amount) throw new CardFlowError('mint_refused', 'The card mint signed something else.', { kept: true });
      if (sig.dleq && !verifyDleq(sig.dleq, o.B_, sig.C_, K)) throw new CardFlowError('mint_refused', "The card mint's proof does not check out.", { kept: true });
      if (i < job.outputs.length) proofs.push({ id: o.id, amount: o.amount, secret: o.secret, C: unblind(sig.C_, o.r, K) });
      else change.push({ ...o, C_: sig.C_, K, loaded: false });
    });
    const token = encodeToken({ mint: job.mint, unit: job.unit, proofs });
    // The token is written before anything else is done with it; the outputs' secrets go with it.
    job = { ...job, state: 'swapped', token, outputs: job.outputs.map(({ secret: _s, r: _r, ...o }) => o), change, changeOwed: change.length > 0, received: proofs.reduce((s, p) => s + p.amount, 0) };
    store.put(job);
    return job;
  }

  /**
   * Step 3 and on: the PIN, the signature, the swap and the change, all in this tap. route says where the
   * token goes after (kept with the job for resume). Resolves to the job
   * with its token ({state: 'swapped', token, received, changeOwed}). After the card signed, a failure
   * keeps the job: settle() and finishOnCard() finish it later, and the error says kept: true.
   */
  async function pay(tx, { summary, info, plan, pin, acceptUnlisted = false, route = 'topup' }) {
    const pinSet = summary.pinState === 'set';
    try {
      await sameCard(tx, summary.pubkey);
      if (summary.pinState === 'blocked') throw new CardFlowError('pin_blocked', "This card's PIN is blocked.");
      if (pinSet) await apdu.verifyPin(tx, pin);
      await finishOnCard(tx, summary.pubkey, { pinOk: true });
    } catch (e) {
      throw cardFailure(e);
    }
    let job;
    try {
      const named = await apdu.getPiecesNamed(tx, plan.slots);
      const inputs = named.map((n, i) => {
        const listed = plan.pieces[i];
        if (n.status !== 'unspent' || n.piece.amount !== listed.amount || n.piece.keysetId !== listed.keysetId || n.piece.date !== listed.date) throw new CardFlowError('card_error', 'The card changed since it was read. Tap it again.');
        return { slot: n.slot, id: plan.inputKeysets[i], amount: n.piece.amount, secret: cardSecret(n.piece.nonce, summary.pubkey, n.piece.date, summary.refundKey), C: n.piece.C };
      });
      const outputs = plan.outputs.map((amount) => {
        const secret = toHex(randomBytes(32));
        return { amount, id: plan.keyset, secret, ...blind(secret) };
      });
      job = {
        id: newId(),
        at: now(),
        mint: summary.mint,
        unit: summary.unit,
        cardKey: summary.pubkey,
        refundKey: summary.refundKey,
        pinSet,
        acceptUnlisted,
        // Where the eCash goes once it is here: 'topup' (the engine's own mint) or 'othermint'.
        route,
        keys: { [plan.keyset]: info.keys[plan.keyset] },
        inputs,
        outputs,
        change: [],
        sig: null,
        state: 'ready',
      };
      const sum = await apdu.spendAllBegin(tx, plan.slots);
      if (sum !== plan.selected) throw new CardFlowError('card_error', 'The card counts its pieces differently. Nothing was taken.');
      await apdu.spendAllOutputs(tx, outputs);
      for (const amount of plan.change) job.change.push({ amount, id: plan.keyset, B_: await apdu.spendAllChange(tx, amount) });
      // Everything needed to finish without the card is on the phone before it signs.
      store.put(job);
    } catch (e) {
      throw cardFailure(e);
    }
    let sig;
    try {
      sig = await apdu.spendAllSign(tx);
    } catch (e) {
      // A status word is the card refusing before its commit (PIN, limit): nothing was burned, so nothing
      // is kept. Anything else (the card left, a garbled answer) may have come after the commit: kept.
      if (e instanceof apdu.CardError) {
        store.remove(job.id);
        throw cardFailure(e);
      }
      throw new CardFlowError('unfinished', 'The card left before it finished. Tap the same card again.', { kept: true });
    }
    if (!schnorrVerify(sig, message(job), summary.pubkey)) throw new CardFlowError('unfinished', "The card's answer did not check out. Tap the same card again.", { kept: true });
    job = store.put({ ...job, sig, state: 'signed' });
    job = await settle(job);
    if (job.changeOwed) {
      try {
        await loadChange(tx, job);
        job = store.get(job.id) ?? { ...job, changeOwed: false };
      } catch {
        // The card's change waits on this phone for its next tap; the eCash is already here.
        job = store.get(job.id) ?? job;
      }
    }
    return job;
  }

  /** The caller has the job's token safe (in the vault). The job goes once nothing more is owed. */
  function handed(id) {
    const job = store.get(id);
    if (!job) return;
    if (job.changeOwed) store.put({ ...job, token: null, handed: true });
    else store.remove(id);
  }

  /**
   * On start, when the connection comes back and on Funds: swaps not finished are sent again, and a
   * token not yet handed over goes to hand(job). Returns how many jobs moved.
   */
  async function resume(hand) {
    let n = 0;
    for (const job of store.jobs()) {
      try {
        let j = job;
        if (j.state === 'signed') {
          j = await settle(j);
          n++;
        }
        if (j?.state === 'swapped' && j.token && !j.handed) {
          // hand resolves once the token is in the vault, whatever the engine then said about it.
          await hand(j);
          handed(j.id);
          n++;
        }
      } catch (e) {
        if (e?.code === 'mint_unavailable') break;
      }
    }
    return n;
  }

  return {
    store,
    mintInfo,
    read,
    plan: planTake,
    pay,
    finish,
    settle,
    finishOnCard,
    loadChange,
    handed,
    resume,
    /** Jobs this phone still holds: payments not finished, tokens not handed over, change owed to a card. */
    pending: () => store.jobs(),
    owedTo,
  };
}

/** The mint's restore answer, in the order of outputs, or null when it does not cover every one. */
function matchRestored(outputs, body) {
  const outs = body?.outputs ?? [];
  const sigs = body?.signatures ?? body?.promises ?? [];
  const by = new Map(outs.map((o, i) => [String(o.B_).toLowerCase(), sigs[i]]));
  const got = outputs.map((o) => by.get(o.B_.toLowerCase()));
  return got.every(Boolean) ? got : null;
}

/**
 * Puts a card job's token where it goes, so the job can let it go. The engine's own mint: wallet.topup,
 * which stores it in the vault before sending it, and keeps it there when the engine refuses it or does
 * not answer. Another mint: the vault, marked not added, until the person adds it through Other mint
 * (Funds lists it, with Copy). Resolves once the vault has the token; throws only when it does not.
 * Returns {route, credited, unit, replay, error} as far as known.
 */
export async function handToken(job, { wallet, vault, engineBase = '', message = '' }) {
  if (job.route === 'othermint') {
    const e = vault.hold(job.token, 'card', { engine: engineBase });
    vault.refused(e.id, 'card_other_mint', message);
    return { route: 'othermint' };
  }
  try {
    return { route: 'topup', ...(await wallet.topup(job.token, wallet.invite?.() || undefined)) };
  } catch (error) {
    if (!vault.incoming().some((x) => x.token === job.token)) throw error;
    return { route: 'topup', error };
  }
}
