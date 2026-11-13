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
    /** Stores a token before it is sent. Returns the entry (an existing one for the same token). */
    hold(token, via = 'topup') {
      const v = read();
      const have = v.in.find((x) => x.token === token);
      if (have) return have;
      const e = { id: 'in_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), token, via, at: Date.now(), state: 'pending' };
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
 * engine creates, before anything else, so a key is never lost either.
 * Returns {credited, unit, replay}. Throws EngineError (with .retryable) when the token was not credited.
 */
export async function topupWithVault({ engine, vault, token, key, invite, setKey }) {
  const entry = vault.hold(token);
  let r;
  try {
    r = await engine.topup(key, token, invite);
  } catch (e) {
    vault.pending(entry.id, e?.code ?? 'offline');
    throw e;
  }
  if (r.body?.key && r.body.key !== key) setKey(r.body.key);
  if (r.ok) {
    vault.credited(entry.id);
    return { credited: r.body?.credited ?? 0, unit: r.body?.unit, replay: !!r.body?.replay };
  }
  const err = errorFrom(r.status, r.body);
  if (err.retryable) vault.pending(entry.id, err.code);
  else vault.refused(entry.id, err.code, err.message);
  throw err;
}

/**
 * Sends every pending top-up token again (on start and when the connection comes back). Tokens held
 * by another flow (other-mint funding) are left to that flow. Returns how many were credited.
 */
export async function retryPending({ engine, vault, getKey, invite, setKey }) {
  let n = 0;
  for (const e of vault.incoming().filter((x) => x.state === 'pending' && (x.via ?? 'topup') === 'topup')) {
    try {
      await topupWithVault({ engine, vault, token: e.token, key: getKey(), invite, setKey });
      n++;
    } catch (err) {
      if (err?.code === 'offline') break;
    }
  }
  return n;
}
