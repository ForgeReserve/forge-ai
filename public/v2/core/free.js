// Free questions in the app (docs/FREE-TIER.md). Pure, tested in Node.
//
// Free questions are credits: eCash from the engine's credit mint, held on a free balance of their own
// (a second balance key). The engine keeps the two balances apart: credits never pay a paid question and
// money never goes on the free balance. The app uses a free question first, when the model is on the
// engine's free list and the question fits its caps; otherwise the paid balance pays.

/** Where the free balance key is stored: one per engine, like the paid key (core/state.js keyName). */
export const FREE_KEY_STORE = 'forge2.freeKey';
export const freeKeyName = (base, origin) => (!base || base === origin ? FREE_KEY_STORE : `${FREE_KEY_STORE}@${base}`);

/** One free question is one credit: 1,000 msub on the free balance. */
export const CREDIT_MSUB = 1000;

/** Whole free questions on a free balance. */
export const freeLeft = (msub) => (Number.isFinite(msub) && msub > 0 ? Math.floor(msub / CREDIT_MSUB) : 0);

/** The engine's free tier, from /v1/models `free`, or null when it has none. */
export function freeInfo(models) {
  const f = models?.free;
  if (!f || typeof f.mint !== 'string' || !Array.isArray(f.models)) return null;
  return { mint: f.mint.trim().replace(/\/+$/, ''), unit: f.unit ?? 'usd', models: f.models, maxIn: f.max_input_tokens ?? null, maxOut: f.max_output_tokens ?? null, faucet: !!f.faucet };
}

/** True when a token's mint (core/note.js readNote) is the engine's credit mint. */
export const isCreditMint = (info, mint) => !!info && String(mint ?? '').trim().replace(/\/+$/, '') === info.mint;

/**
 * The count of free questions "added": what the "of 3" in "Free, 2 of 3 left" counts. It starts again
 * when free questions are added after they had run out, and grows when more are added on top.
 */
export function nextFreeTotal(prevLeft, prevTotal, added) {
  const a = Number.isFinite(added) && added > 0 ? added : 0;
  if (!(prevLeft > 0)) return a + Math.max(0, prevLeft || 0);
  return Math.max(prevLeft, prevTotal || 0) + a;
}

/**
 * Whether the next question is paid with a free question, and why not when it is not.
 * Returns {use: true} or {use: false, why}: why is 'none' (no free questions), 'off' (the engine has no
 * free tier), 'model' (the chosen model is not on the free list) or 'long' (the question is over the cap).
 */
export function useFree({ info, left, model, inputTokens = 0 }) {
  if (!info) return { use: false, why: 'off' };
  if (!(left > 0)) return { use: false, why: 'none' };
  if (!model || !info.models.includes(model.id)) return { use: false, why: 'model' };
  if (info.maxIn && inputTokens > info.maxIn) return { use: false, why: 'long' };
  return { use: true };
}

/** The most output a free question asks for: the app's own limit, under the engine's cap. */
export const freeMaxTokens = (info, maxTokens) => (info?.maxOut ? Math.min(info.maxOut, maxTokens) : maxTokens);

/**
 * What the person can do when a question cannot be asked for lack of funds.
 *   'freeOut': free questions were used up and there is no paid balance: the three ways forward.
 *   'freeModel': free questions are left but the chosen model is not free, and there is no paid balance.
 *   'addFunds': nothing yet.
 *   null: the question can be paid.
 */
export function fundsBlock({ paidMsub, freeLeft: left, freeTotal, freeUsable }) {
  if (paidMsub > 0) return null;
  if (left > 0) return freeUsable ? null : 'freeModel';
  return freeTotal > 0 ? 'freeOut' : 'addFunds';
}
