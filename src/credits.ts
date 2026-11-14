/**
 * Credits: free questions that are not money (docs/FREE-TIER.md).
 *
 * A credit is Cashu eCash from a separate mint, the credit mint. A balance funded with credits is a
 * free balance (accounts.free = 1). It pays only for the free model list, one credit per question,
 * within the caps below. Change and refunds come back as credits. Nothing turns money into credits or
 * credits into money: a balance is either free or paid, never both, and the credit mint is never one of
 * the trusted (money) mints.
 *
 * This file holds the rules (pure), the keyset expiry record, and the one function that mints credits,
 * shared by the faucet and scripts/issue-credits.ts.
 */
import { getEncodedToken, type Proof, Wallet } from '@cashu/cashu-ts';
import type { Config, ModelConfig, Unit } from './config.ts';
import type { DB } from './db.ts';
import { MSUB_PER_UNIT } from './pricing.ts';

/** One free question costs one credit: one unit of the credit mint. */
export const CREDIT_MSUB = MSUB_PER_UNIT;

const DAY_MS = 86_400_000;

export interface FreeRules {
  mint: string;
  unit: Unit;
  /** Free model ids that are in the catalog, in the order configured. */
  models: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
  keysetDays: number;
}

/** The free tier's rules, or undefined when no credit mint is set (the free tier is off). */
export function freeRules(config: Config): FreeRules | undefined {
  if (!config.creditMint) return undefined;
  const env = config.env;
  const ids = new Set(config.catalog.models.map((m) => m.id));
  return {
    mint: config.creditMint,
    unit: env.FORGE_CREDIT_UNIT,
    models: env.FORGE_FREE_MODELS.filter((id) => ids.has(id)),
    maxInputTokens: env.FORGE_FREE_MAX_INPUT_TOKENS,
    maxOutputTokens: env.FORGE_FREE_MAX_OUTPUT_TOKENS,
    keysetDays: env.FORGE_CREDIT_KEYSET_DAYS,
  };
}

export type FreeCheck =
  | { ok: true; maxOut: number }
  | { ok: false; status: number; code: 'not_free_model' | 'free_too_long' | 'free_too_much_output'; message: string };

/**
 * Whether a question may be paid from a free balance, and the most output it may ask for.
 * requestedOut: the max tokens the client asked for, or undefined when it did not say (the cap is used).
 */
export function checkFreeQuestion(rules: FreeRules, model: Pick<ModelConfig, 'id' | 'max_output_tokens'>, inputTokens: number, requestedOut: number | undefined): FreeCheck {
  if (!rules.models.includes(model.id)) {
    return { ok: false, status: 403, code: 'not_free_model', message: `free questions work only with ${rules.models.join(', ') || 'no model on this engine'}` };
  }
  if (inputTokens > rules.maxInputTokens) {
    return { ok: false, status: 400, code: 'free_too_long', message: `a free question can be at most about ${rules.maxInputTokens} tokens long; start a new conversation or ask in a shorter way` };
  }
  const cap = Math.min(rules.maxOutputTokens, model.max_output_tokens);
  if (requestedOut !== undefined && requestedOut > cap) {
    return { ok: false, status: 400, code: 'free_too_much_output', message: `a free question can ask for at most ${cap} output tokens` };
  }
  return { ok: true, maxOut: requestedOut ?? cap };
}

/**
 * When the gateway first saw each credit keyset. A keyset is taken for keysetDays from then, or until
 * the mint's own final_expiry when that comes first. Rotating the credit mint's keyset retires credits:
 * the old keyset's credits stop being taken once it expires.
 */
export class CreditKeysets {
  readonly db: DB;
  readonly days: number;
  constructor(db: DB, days: number) {
    this.db = db;
    this.days = days;
  }

  /** Records keysets not seen before. */
  note(ids: string[], at = Date.now()): void {
    const stmt = this.db.prepare('INSERT INTO credit_keysets (keyset_id, first_seen) VALUES (?, ?) ON CONFLICT (keyset_id) DO NOTHING');
    for (const id of ids) stmt.run(id, at);
  }

  firstSeen(id: string): number | undefined {
    return (this.db.prepare('SELECT first_seen FROM credit_keysets WHERE keyset_id = ?').get(id) as { first_seen: number } | undefined)?.first_seen;
  }

  /** When a keyset stops being taken, in ms. mintExpiry: the mint's final_expiry, in seconds, if it has one. */
  expiresAt(id: string, mintExpiry?: number, now = Date.now()): number {
    this.note([id], now);
    const ours = this.firstSeen(id)! + this.days * DAY_MS;
    return mintExpiry ? Math.min(ours, mintExpiry * 1000) : ours;
  }

  expired(id: string, mintExpiry?: number, now = Date.now()): boolean {
    return now >= this.expiresAt(id, mintExpiry, now);
  }
}

/** Sum of proof amounts (cashu-ts 4 hands amounts out as Amount objects). */
const amountOf = (p: Proof): number => {
  const a = p.amount as unknown;
  return typeof a === 'number' ? a : typeof a === 'bigint' ? Number(a) : (a as { toNumber(): number }).toNumber();
};

/**
 * Mints credits at the credit mint and returns one token per amount, each written with the mint's
 * public address. issueUrl is where minting is open (the credit mint's own host: nginx blocks mint and
 * melt everywhere else). The credit mint's backend pays its own quotes (it holds no bitcoin).
 */
export async function mintCredits(o: { issueUrl: string; publicUrl: string; unit: Unit; amounts: number[]; pollMs?: number; tries?: number }): Promise<string[]> {
  const total = o.amounts.reduce((s, a) => s + a, 0);
  if (!o.amounts.length || o.amounts.some((a) => !Number.isInteger(a) || a < 1)) throw new Error('every voucher needs at least one credit');
  const w = new Wallet(o.issueUrl, { unit: o.unit });
  await w.loadMint();
  const q = await w.createMintQuoteBolt11(total);
  let state = q.state;
  for (let i = 0; state !== 'PAID' && i < (o.tries ?? 50); i++) {
    await new Promise((r) => setTimeout(r, o.pollMs ?? 100));
    state = (await w.checkMintQuoteBolt11(q.quote)).state;
  }
  if (state !== 'PAID') throw new Error('the credit mint did not mark its quote paid');
  // Ask for each voucher's pieces (powers of two), so the minted proofs split into the vouchers exactly.
  const proofs = await w.mintProofsBolt11(total, q.quote, undefined, { type: 'random', denominations: o.amounts.flatMap(split) });
  const pool = new Map<number, Proof[]>();
  for (const p of proofs) pool.set(amountOf(p), [...(pool.get(amountOf(p)) ?? []), p]);
  const out: string[] = [];
  for (const want of o.amounts) {
    const pick: Proof[] = [];
    for (const d of split(want)) {
      const p = pool.get(d)?.pop();
      if (!p) throw new Error('the minted pieces do not make up the vouchers');
      pick.push(p);
    }
    // Without the DLEQ proofs, so the code stays small enough to scan from paper or a screen.
    out.push(getEncodedToken({ mint: o.publicUrl, unit: o.unit, proofs: pick }, { removeDleq: true }));
  }
  if ([...pool.values()].some((l) => l.length)) throw new Error('the mint returned more pieces than the vouchers need');
  return out;
}

/** An amount as powers of two, largest first. */
export function split(amount: number): number[] {
  const out: number[] = [];
  for (let bit = 2 ** Math.floor(Math.log2(amount)); bit >= 1; bit /= 2) if (amount >= bit) (out.push(bit), (amount -= bit));
  return out;
}
