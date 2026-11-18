import type { Unit } from './config.ts';
import { type DB, tx } from './db.ts';
import { type Account, type Invites, isApiKeyShape, type Ledger, LedgerError, newApiKey, type Pass, type Passes } from './ledger.ts';

/** The header a phone sends to open its balance in the other unit, carrying the key of a balance it holds. */
export const SIBLING_HEADER = 'X-Forge-Sibling';

/** Funding states that may still credit the balance. */
export const OPEN_FUNDING_STATES = ['quoted', 'receiving', 'melting', 'pending', 'minting'] as const;

export interface OpenedAccount {
  account: Account;
  /** The bearer key, only when the gateway generated it (return it to the client once). */
  generatedKey?: string;
  /** true when this call created the balance (and redeemed the invite). */
  created: boolean;
}

/**
 * Finds the balance for a bearer key, or opens a new one. Shared by every funding method so the
 * invite rule is the same everywhere: a new balance needs an open invite while invite-only, and
 * redeeming it binds the invite to the balance. Only a SHA-256 of the key is stored.
 *
 * free: the funding is credits (docs/FREE-TIER.md). A balance is free or paid for life: credits never
 * go onto a paid balance and money never goes onto a free one, so neither can turn into the other.
 * A free balance needs no invite: it can only ever hold free questions.
 *
 * passes: given only by POST /v1/wallet/open (a balance at 0 for the free models). There, a code that is
 * not an invite may be an event pass, which counts one use instead of being redeemed. Every other caller
 * leaves it out, so a pass never opens a balance for a funded top-up.
 *
 * sibling: the key of a paid balance the caller already holds (X-Forge-Sibling, docs/PAYMENTS.md, Two
 * balances). While invite-only, it opens the balance in the other unit in place of an invite or a pass
 * (siblingProof). The new balance stores the id of the one that proved it (accounts.sibling_of); nothing
 * else links them.
 */
export function openAccount(
  d: { db: DB; ledger: Ledger; invites: Invites; inviteOnly: boolean; passes?: Passes },
  p: { key?: string; invite?: string; unit: Unit; free?: boolean; sibling?: string },
): OpenedAccount {
  const { db, ledger, invites } = d;
  const free = !!p.free;
  if (p.key) {
    const a = ledger.findByKey(p.key);
    if (a) {
      if (!!a.free !== free) {
        throw new LedgerError(
          'wrong_balance',
          a.free ? 'this is a free balance: it takes only free questions (credits), never money' : 'free questions (credits) go on a free balance of their own, never on a paid one',
          409,
        );
      }
      if (a.unit !== p.unit) throw new LedgerError('wrong_unit', `this balance is in ${a.unit}; this funding is in ${p.unit}`);
      return { account: a, created: false };
    }
    if (!isApiKeyShape(p.key)) throw new LedgerError('invalid_key', 'unknown balance key', 401);
  }
  let pass: Pass | undefined;
  let proof: Account | undefined;
  if (d.inviteOnly && !free && p.sibling) {
    proof = siblingProof(db, ledger, p.sibling, p.unit);
  } else if (d.inviteOnly && !free) {
    const inv = p.invite ? invites.lookup(p.invite) : undefined;
    pass = !inv && p.invite && d.passes ? d.passes.lookup(p.invite) : undefined;
    if (pass) {
      const refused = d.passes!.refusal(pass);
      if (refused) throw refused;
    } else {
      if (!inv) throw new LedgerError('invite_required', 'an invite code is required to open a balance', 403);
      if (inv.status === 'redeemed') throw new LedgerError('invite_used', 'invite code was already redeemed', 403);
      if (inv.status !== 'open') throw new LedgerError('invite_invalid', 'invite code is not valid', 403);
    }
  }
  const key = p.key ?? newApiKey();
  const account = tx(db, () => {
    if (proof) siblingProof(db, ledger, p.sibling!, p.unit); // again inside the transaction: two opens at once
    const a = ledger.createAccountRaw(key, p.unit, null, free);
    if (proof) {
      db.prepare('UPDATE accounts SET sibling_of = ? WHERE id = ?').run(proof.id, a.id);
    } else if (pass) {
      // Counted in the same transaction: at the cap, the balance is not created either.
      d.passes!.useRaw(pass.id);
      db.prepare('UPDATE accounts SET pass_id = ? WHERE id = ?').run(pass.id, a.id);
    } else if (d.inviteOnly && !free) {
      const inviteId = invites.redeemRaw(p.invite!, a.id);
      db.prepare('UPDATE accounts SET invite_id = ? WHERE id = ?').run(inviteId, a.id);
    }
    return ledger.get(a.id)!;
  });
  return { account, generatedKey: p.key ? undefined : key, created: true };
}

/**
 * The balance whose key proves that a phone may open its balance in the other unit without an invite,
 * or throws 403 sibling_refused. It must be a paid balance (a free one proves nothing), not frozen, in
 * the other unit, in use (a ledger line, so releaseIfEmpty never deletes it and gives its invite or pass
 * use back), not itself opened this way, and with no balance opened this way yet. So each balance opened
 * with an invite or a pass use gains at most one more, and that one gains none: a key in the other unit
 * never takes an invite nobody spent. A sibling released empty (its first funding failed) frees the place.
 */
export function siblingProof(db: DB, ledger: Ledger, key: string, unit: Unit): Account {
  const refuse = (why: string) => new LedgerError('sibling_refused', `this key cannot open a balance in ${unit}: ${why}`, 403);
  const a = ledger.findByKey(key);
  if (!a) throw refuse('unknown balance key');
  if (a.free) throw refuse('a free-question balance proves nothing');
  if (ledger.isFrozen(a.id)) throw refuse('the balance is frozen');
  if (a.unit === unit) throw refuse(`the balance is in ${unit} already`);
  const row = db.prepare('SELECT sibling_of FROM accounts WHERE id = ?').get(a.id) as { sibling_of: string | null };
  if (row.sibling_of) throw refuse('it was opened this way itself');
  if (!db.prepare('SELECT 1 FROM ledger WHERE account_id = ? LIMIT 1').get(a.id)) throw refuse('the balance has not been used yet');
  if (db.prepare('SELECT 1 FROM accounts WHERE sibling_of = ? LIMIT 1').get(a.id)) throw refuse('it opened its balance in the other unit already');
  return a;
}

/**
 * Deletes a balance that never received anything, was never used, and has nothing in flight, and reopens
 * its invite, or gives its event pass its use back. Used when the first funding of a new balance fails or
 * expires. A balance opened with a sibling key (siblingProof) has no invite or pass use of its own: deleting
 * it gives nothing back, and lets the balance that proved it open one again.
 */
export function releaseIfEmpty(db: DB, accountId: string): boolean {
  return tx(db, () => {
    const a = db.prepare('SELECT balance_msub FROM accounts WHERE id = ?').get(accountId) as { balance_msub: number } | undefined;
    if (!a || a.balance_msub !== 0) return false;
    // A ledger line ('open' from POST /v1/wallet/open included) or a request made with the key (a free
    // model, at 0) means the key is in use: it is never deleted under the person using it.
    const ledgerRows = (db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE account_id = ?').get(accountId) as { n: number }).n;
    if (ledgerRows > 0) return false;
    if (db.prepare('SELECT 1 FROM requests WHERE account_id = ? LIMIT 1').get(accountId)) return false;
    const marks = OPEN_FUNDING_STATES.map(() => '?').join(',');
    const busy = (
      db.prepare(`SELECT COUNT(*) AS n FROM fundings WHERE account_id = ? AND (state IN (${marks}) OR credited > 0)`).get(accountId, ...OPEN_FUNDING_STATES) as {
        n: number;
      }
    ).n;
    if (busy > 0) return false;
    const pendingIn = (
      db.prepare("SELECT COUNT(*) AS n FROM incoming WHERE account_id = ? AND status = 'prepared'").get(accountId) as { n: number }
    ).n;
    if (pendingIn > 0) return false;
    db.prepare("UPDATE invites SET status = 'open', account_id = NULL, redeemed_at = NULL WHERE account_id = ?").run(accountId);
    // A pass is never bound to one balance: the use this balance took is given back, never below 0.
    db.prepare('UPDATE passes SET uses = uses - 1 WHERE uses > 0 AND id = (SELECT pass_id FROM accounts WHERE id = ?)').run(accountId);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    return true;
  });
}
