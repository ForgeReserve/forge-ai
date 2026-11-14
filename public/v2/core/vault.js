// eCash on its way in or out, kept on the phone so a token is never lost.
//
// In: a token from a paste, scan, card or faucet is written here BEFORE it is sent to the engine, and
// removed only after the engine confirms the credit. If the engine is unreachable or says the outcome is
// pending, the token stays and is sent again later with the same balance key. If the engine refuses it
// (spent, wrong mint), it stays marked as refused, so the person can copy it back out.
//
// Out: a refund token stays here until the person says they saved it.
//
// Storage is passed in (localStorage in the page, a Map in tests). Pure apart from that.
import { errorFrom } from './engine.js';

const STORE = 'forge2.vault';

export function createVault(storage) {
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(STORE) ?? '{}');
      return { in: Array.isArray(v.in) ? v.in : [], out: Array.isArray(v.out) ? v.out : [] };
    } catch {
      return { in: [], out: [] };
    }
  };
  const write = (v) => {
    storage.setItem(STORE, JSON.stringify(v));
    // A token that cannot be stored must not be sent: read it back to be sure.
    if (JSON.stringify(read()) !== JSON.stringify(v)) throw new Error('This phone could not store the eCash. It was not sent.');
  };
  return {
    incoming: () => read().in,
    outgoing: () => read().out,
    /**
     * Stores a token before it is sent. Returns the entry (an existing one for the same token).
     * extra: fields kept with it, such as fundingId for other-mint funding, so the outcome can be
     * looked up later. An existing entry is being sent again: it takes the new flow and fields and is
     * pending once more.
     */
    hold(token, via = 'topup', extra = {}) {
      const v = read();
      const have = v.in.find((x) => x.token === token);
      if (have) {
        const next = { via, ...extra, state: 'pending' };
        if (Object.entries(next).some(([k, x]) => have[k] !== x)) {
          Object.assign(have, next);
          write(v);
        }
        return have;
      }
      const e = { id: 'in_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), token, via, ...extra, at: Date.now(), state: 'pending' };
      v.in.push(e);
      write(v);
      return e;
    },
    /** Removes a token once the engine has confirmed the credit. */
    credited(id) {
      const v = read();
      v.in = v.in.filter((x) => x.id !== id);
      write(v);
    },
    refused(id, code, message) {
      const v = read();
      for (const x of v.in) if (x.id === id) Object.assign(x, { state: 'refused', code, message });
      write(v);
    },
    pending(id, code) {
      const v = read();
      for (const x of v.in) if (x.id === id) Object.assign(x, { state: 'pending', code });
      write(v);
    },
    /** The person removed a refused token by hand (after copying it). */
    discard(id) {
      const v = read();
      v.in = v.in.filter((x) => x.id !== id || x.state !== 'refused');
      write(v);
    },
    /** Keeps a refund token until the person confirms they saved it. */
    keepRefund({ id, token, amount, unit }) {
      const v = read();
      if (!v.out.some((x) => x.id === id)) v.out.push({ id, token, amount, unit, at: Date.now() });
      write(v);
    },
    saved(id) {
      const v = read();
      v.out = v.out.filter((x) => x.id !== id);
      write(v);
    },
  };
}

/**
 * Sends a token to the engine through the vault. setKey is called at once with a balance key the
 * engine creates, before anything else, so a key is never lost either. When the engine says the key
 * is for a free balance (free: true) and setFreeKey is given, that key goes to setFreeKey instead, so
 * a free balance key never lands in the paid slot (a voucher sent the paid way, when the app did not
 * yet know the credit mint).
 * Returns {credited, unit, replay}, plus free: true when the token went on a free balance. Throws EngineError (with .retryable) when the token was not credited.
 */
export async function topupWithVault({ engine, vault, token, key, invite, setKey, setFreeKey, via = 'topup' }) {
  const entry = vault.hold(token, via);
  let r;
  try {
    r = await engine.topup(key, token, invite);
  } catch (e) {
    vault.pending(entry.id, e?.code ?? 'offline');
    throw e;
  }
  if (r.body?.key && r.body.key !== key) (r.body.free === true && setFreeKey ? setFreeKey : setKey)(r.body.key);
  if (r.ok) {
    vault.credited(entry.id);
    return { credited: r.body?.credited ?? 0, unit: r.body?.unit, replay: !!r.body?.replay, ...(r.body?.free === true ? { free: true } : {}) };
  }
  const err = errorFrom(r.status, r.body);
  if (err.retryable) vault.pending(entry.id, err.code);
  else vault.refused(entry.id, err.code, err.message);
  throw err;
}

/**
 * Sends every pending top-up token again (on start and when the connection comes back). Tokens held
 * by another flow (other-mint funding) are left to that flow. Returns how many were credited.
 * via: 'topup' for the paid balance, 'free' for free question vouchers, which go on the free balance
 * with its own key (core/free.js).
 */
export async function retryPending({ engine, vault, getKey, invite, setKey, setFreeKey, via = 'topup' }) {
  let n = 0;
  for (const e of vault.incoming().filter((x) => x.state === 'pending' && (x.via ?? 'topup') === via)) {
    try {
      await topupWithVault({ engine, vault, token: e.token, key: getKey(), invite, setKey, setFreeKey, via });
      n++;
    } catch (err) {
      if (err?.code === 'offline') break;
    }
  }
  return n;
}
