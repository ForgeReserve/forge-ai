import { randomBytes, randomUUID } from 'node:crypto';
import {
  Amount,
  type CounterSource,
  deserializeProofs,
  deserializeSwapPreview,
  getEncodedToken,
  getTokenMetadata,
  MintOperationError,
  type OperationCounters,
  type Proof,
  serializeProofs,
  serializeSwapPreview,
  type SwapPreview,
  Wallet,
} from '@cashu/cashu-ts';
import { normalizeMintUrl, type Unit } from '../config.ts';
import { type DB, now, tx } from '../db.ts';
import { sha256 } from '../ledger.ts';
import { errText, log } from '../log.ts';

/** NUT error codes we treat as definitive rejections of the inputs. */
const SPENT = 11001;

export class PaymentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface InspectedToken {
  mint: string;
  unit: Unit;
  amount: number;
  hash: string;
  proofs: Proof[];
}

export interface ReceiveOptions {
  purpose: 'topup' | 'nut24';
  expectUnit?: Unit;
  minAmount?: number;
  accountId?: string;
  requestId?: string;
  /** Runs inside the same SQLite transaction that stores the received proofs. */
  onFinalize?: (amount: number) => void;
}

export interface ReceiveResult {
  incomingId: string;
  mint: string;
  unit: Unit;
  amount: number;
  /** true when the same token was already redeemed for the same purpose/account (idempotent replay). */
  replay: boolean;
}

interface IncomingRow {
  id: string;
  token_hash: string;
  mint: string;
  unit: Unit;
  amount: number;
  purpose: 'topup' | 'nut24';
  account_id: string | null;
  request_id: string | null;
  status: 'new' | 'prepared' | 'done' | 'rejected';
  preview: string | null;
  counters: string | null;
  error: string | null;
}

interface OutgoingRow {
  id: string;
  mint: string;
  unit: Unit;
  amount: number;
  purpose: 'change' | 'refund' | 'export';
  account_id: string | null;
  request_id: string | null;
  status: 'owed' | 'reserved' | 'prepared' | 'done' | 'failed';
  inputs: string | null;
  preview: string | null;
  counters: string | null;
  token: string | null;
}

export interface WalletOptions {
  trustedMints: string[];
  units: Unit[];
  maxTokenBytes: number;
  seed?: Uint8Array;
  /** Test-only fault injection: throw after the mint swap, before the DB write. */
  faults?: { afterReceiveSwap?: boolean; afterSendSwap?: boolean; noReplayOnRecovery?: boolean };
}

class SqliteCounterSource implements CounterSource {
  private readonly db: DB;
  private readonly mint: string;
  constructor(db: DB, mint: string) {
    this.db = db;
    this.mint = mint;
  }
  private cur(keysetId: string): number {
    const r = this.db.prepare('SELECT next FROM counters WHERE mint = ? AND keyset_id = ?').get(this.mint, keysetId) as { next: number } | undefined;
    return r?.next ?? 0;
  }
  private set(keysetId: string, next: number) {
    this.db
      .prepare('INSERT INTO counters (mint, keyset_id, next) VALUES (?, ?, ?) ON CONFLICT (mint, keyset_id) DO UPDATE SET next = excluded.next')
      .run(this.mint, keysetId, next);
  }
  async reserve(keysetId: string, n: number) {
    // Synchronous read-modify-write: no await between them, so no interleaving in this process.
    const start = this.cur(keysetId);
    if (n > 0) this.set(keysetId, start + n);
    return { start, count: n };
  }
  async advanceToAtLeast(keysetId: string, minNext: number) {
    if (this.cur(keysetId) < minNext) this.set(keysetId, minNext);
  }
  async snapshot() {
    const rows = this.db.prepare('SELECT keyset_id, next FROM counters WHERE mint = ?').all(this.mint) as Array<{ keyset_id: string; next: number }>;
    return Object.fromEntries(rows.map((r) => [r.keyset_id, r.next]));
  }
}

function isDefinitiveSpent(e: unknown): boolean {
  return e instanceof MintOperationError && e.code === SPENT;
}

function isMintRejection(e: unknown): boolean {
  // A 4xx-class protocol error from the mint (bad proofs, unknown keyset, ...). Network errors are not.
  return e instanceof MintOperationError;
}

function proofAmount(p: { amount: unknown }): number {
  const a = p.amount as any;
  return typeof a === 'number' ? a : typeof a?.toNumber === 'function' ? a.toNumber() : Number(a);
}

function sumProofs(proofs: Array<{ amount: unknown }>): number {
  return proofs.reduce((s, p) => s + proofAmount(p), 0);
}

function outputSecret(o: { secret: Uint8Array }): string {
  return new TextDecoder().decode(o.secret);
}

export class GatewayWallet {
  private readonly db: DB;
  private readonly opts: WalletOptions;
  private readonly seed: Uint8Array;
  private readonly wallets = new Map<string, Promise<Wallet>>();
  private readonly inflight = new Set<string>();

  constructor(db: DB, opts: WalletOptions) {
    this.db = db;
    this.opts = { ...opts, trustedMints: opts.trustedMints.map(normalizeMintUrl) };
    this.seed = opts.seed ?? this.loadOrCreateSeed();
  }

  private loadOrCreateSeed(): Uint8Array {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'wallet_seed'").get() as { value: string } | undefined;
    if (row) return Buffer.from(row.value, 'hex');
    const seed = randomBytes(64);
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('wallet_seed', ?)").run(seed.toString('hex'));
    return seed;
  }

  isTrusted(mint: string): boolean {
    return this.opts.trustedMints.includes(normalizeMintUrl(mint));
  }

  get trustedMints(): string[] {
    return this.opts.trustedMints;
  }

  async wallet(mint: string, unit: Unit): Promise<Wallet> {
    const m = normalizeMintUrl(mint);
    const key = `${m}|${unit}`;
    let p = this.wallets.get(key);
    if (!p) {
      p = (async () => {
        const w = new Wallet(m, { unit, bip39seed: this.seed, counterSource: new SqliteCounterSource(this.db, m) });
        await w.loadMint();
        return w;
      })();
      p.catch(() => this.wallets.delete(key));
      this.wallets.set(key, p);
    }
    return p;
  }

  /** Decodes and validates a token without contacting the mint beyond loading its keysets. */
  async inspect(token: string, expectUnit?: Unit): Promise<InspectedToken> {
    if (typeof token !== 'string' || !token.startsWith('cashuB')) throw new PaymentError('invalid_token', 'expected a cashuB token');
    if (token.length > this.opts.maxTokenBytes) throw new PaymentError('invalid_token', 'token too large');
    let meta: { mint: string; unit: string };
    try {
      meta = getTokenMetadata(token);
    } catch {
      throw new PaymentError('invalid_token', 'could not decode token');
    }
    const mint = normalizeMintUrl(meta.mint);
    if (!this.isTrusted(mint)) throw new PaymentError('untrusted_mint', `mint not accepted: ${mint}. Accepted: ${this.trustedMints.join(', ')}`);
    const unit = (meta.unit ?? 'sat') as Unit;
    if (!this.opts.units.includes(unit)) throw new PaymentError('wrong_unit', `unit not accepted: ${unit}`);
    if (expectUnit && unit !== expectUnit) throw new PaymentError('wrong_unit', `expected unit ${expectUnit}, got ${unit}`);
    let w: Wallet;
    try {
      w = await this.wallet(mint, unit);
    } catch (e) {
      throw new PaymentError('mint_unavailable', `could not reach mint: ${errText(e)}`, 503);
    }
    let proofs: Proof[];
    try {
      proofs = w.decodeToken(token).proofs;
    } catch {
      throw new PaymentError('invalid_token', 'token keysets do not match the mint/unit');
    }
    if (!proofs.length) throw new PaymentError('invalid_token', 'empty token');
    for (const p of proofs) {
      try {
        const ks = w.getKeyset(p.id);
        if (ks.unit !== unit) throw new Error('unit');
      } catch {
        throw new PaymentError('wrong_unit', 'token proofs are not from this mint/unit keyset');
      }
    }
    const hash = sha256(
      proofs
        .map((p) => p.secret)
        .sort()
        .join('|'),
    );
    const fees = w.getFeesForProofs(proofs).toNumber();
    return { mint, unit, amount: sumProofs(proofs) - fees, hash, proofs };
  }

  /**
   * Swaps a token into the gateway wallet. Crash safety, step by step:
   *  1. INSERT incoming(status=new) keyed by token hash (UNIQUE). A second submission of the same proofs
   *     finds the row and never reaches the mint twice.
   *  2. Prepare the swap with deterministic (NUT-13) outputs; the counter range is persisted by the
   *     counter source before any request, then the serialized preview is stored (status=prepared).
   *  3. Swap at the mint.
   *  4. One transaction: store new proofs, status=done, run onFinalize (ledger credit).
   * A crash between 3 and 4 leaves status=prepared; recover() replays the identical swap (NUT-19) or
   * restores the signatures from the counter range (NUT-09), then finalizes exactly once.
   */
  async receive(token: string, o: ReceiveOptions): Promise<ReceiveResult> {
    const t = await this.inspect(token, o.expectUnit);
    if (o.minAmount !== undefined && t.amount < o.minAmount) {
      throw new PaymentError('insufficient_amount', `token is worth ${t.amount} ${t.unit} after fees, need ${o.minAmount}`);
    }
    if (this.inflight.has(t.hash)) throw new PaymentError('token_in_flight', 'this token is already being processed', 409);
    this.inflight.add(t.hash);
    try {
      let row = this.db.prepare('SELECT * FROM incoming WHERE token_hash = ?').get(t.hash) as IncomingRow | undefined;
      if (row) {
        if (row.status === 'prepared') {
          await this.recoverIncoming(row);
          row = this.db.prepare('SELECT * FROM incoming WHERE id = ?').get(row.id) as unknown as IncomingRow;
        }
        if (row.status === 'done') {
          const same = row.purpose === o.purpose && row.purpose === 'topup' && row.account_id === (o.accountId ?? null);
          if (same) return { incomingId: row.id, mint: row.mint, unit: row.unit, amount: row.amount, replay: true };
          throw new PaymentError('token_spent', 'token was already redeemed');
        }
        if (row.status === 'rejected') throw new PaymentError('token_spent', `token rejected by mint: ${row.error ?? 'spent'}`);
        // status=new: nothing reached the mint; reuse the row with this caller's context.
        this.db
          .prepare('UPDATE incoming SET purpose = ?, account_id = ?, request_id = ?, updated_at = ? WHERE id = ?')
          .run(o.purpose, o.accountId ?? null, o.requestId ?? null, now(), row.id);
      } else {
        const id = 'in_' + randomUUID();
        this.db
          .prepare(
            "INSERT INTO incoming (id, token_hash, mint, unit, amount, purpose, account_id, request_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)",
          )
          .run(id, t.hash, t.mint, t.unit, t.amount, o.purpose, o.accountId ?? null, o.requestId ?? null, now(), now());
        row = this.db.prepare('SELECT * FROM incoming WHERE id = ?').get(id) as unknown as IncomingRow;
      }

      const w = await this.wallet(t.mint, t.unit);
      let counters: OperationCounters | undefined;
      let preview: SwapPreview;
      try {
        preview = await w.prepareSwapToReceive(t.proofs, { onCountersReserved: (c) => (counters = c) }, { type: 'deterministic', counter: 0 });
      } catch (e) {
        throw new PaymentError('invalid_token', `could not prepare swap: ${errText(e)}`);
      }
      this.db
        .prepare("UPDATE incoming SET status = 'prepared', preview = ?, counters = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(serializeSwapPreview(preview)), JSON.stringify(counters ?? null), now(), row.id);

      let proofs: Proof[];
      try {
        proofs = (await w.completeSwap(preview)).keep;
      } catch (e) {
        if (isMintRejection(e)) {
          this.markRejected(row.id, errText(e));
          throw new PaymentError(isDefinitiveSpent(e) ? 'token_spent' : 'invalid_token', `mint rejected token: ${errText(e)}`);
        }
        // Unknown outcome (network). Leave it prepared; recover() settles it.
        throw new PaymentError('mint_unavailable', `mint did not answer; retry with the same token: ${errText(e)}`, 503);
      }
      if (this.opts.faults?.afterReceiveSwap) throw new Error('fault injected after receive swap');
      this.finalizeIncoming(row.id, proofs, o.onFinalize);
      return { incomingId: row.id, mint: t.mint, unit: t.unit, amount: t.amount, replay: false };
    } finally {
      this.inflight.delete(t.hash);
    }
  }

  private markRejected(id: string, error: string) {
    this.db.prepare("UPDATE incoming SET status = 'rejected', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
  }

  private insertProofs(proofs: Proof[], mint: string, unit: Unit, state: 'unspent' | 'spent' = 'unspent') {
    const stmt = this.db.prepare(
      'INSERT INTO proofs (secret, mint, unit, keyset_id, amount, proof, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (secret) DO NOTHING',
    );
    for (const p of proofs) stmt.run(p.secret, mint, unit, p.id, proofAmount(p), serializeProofs(p)[0]!, state, now());
  }

  private finalizeIncoming(id: string, proofs: Proof[], onFinalize?: (amount: number) => void) {
    tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM incoming WHERE id = ?').get(id) as unknown as IncomingRow;
      if (row.status === 'done') return;
      this.insertProofs(proofs, row.mint, row.unit);
      this.db.prepare("UPDATE incoming SET status = 'done', updated_at = ? WHERE id = ?").run(now(), id);
      onFinalize?.(row.amount);
    });
  }

  /** Hook used by recover() to credit a topup/nut24 whose original request is gone. */
  onRecoveredIncoming?: (row: { purpose: string; account_id: string | null; request_id: string | null; amount: number; unit: Unit; mint: string }) => void;

  private async recoverIncoming(row: IncomingRow): Promise<void> {
    if (!row.preview) {
      this.markRejected(row.id, 'no preview');
      return;
    }
    const w = await this.wallet(row.mint, row.unit);
    const preview = deserializeSwapPreview(JSON.parse(row.preview));
    const finalize = (proofs: Proof[]) => this.finalizeIncoming(row.id, proofs, () => this.onRecoveredIncoming?.(row));
    // 1) Replay the identical swap. With NUT-19 caching the mint returns the same signatures.
    if (!this.opts.faults?.noReplayOnRecovery) {
      try {
        const res = await w.completeSwap(preview);
        finalize(res.keep);
        log.info('incoming_recovered', { id: row.id, via: 'replay' });
        return;
      } catch (e) {
        if (!isMintRejection(e)) throw e; // still offline: try later
      }
    }
    // 2) Outputs may already be signed: restore them from the persisted counter range (NUT-09).
    const c = row.counters ? (JSON.parse(row.counters) as OperationCounters | null) : null;
    if (c && c.count > 0) {
      const { proofs } = await w.restore(c.start, c.count, { keysetId: c.keysetId });
      if (proofs.length) {
        finalize(proofs);
        log.info('incoming_recovered', { id: row.id, via: 'restore' });
        return;
      }
    }
    // 3) No signatures for our outputs: the inputs were spent elsewhere (or never swapped).
    const states = await w.checkProofsStates(preview.inputs);
    if (states.every((s) => s.state === 'UNSPENT')) {
      const res = await w.completeSwap(preview);
      finalize(res.keep);
      log.info('incoming_recovered', { id: row.id, via: 'retry' });
      return;
    }
    this.markRejected(row.id, 'inputs spent elsewhere');
    log.warn('incoming_rejected_on_recovery', { id: row.id });
  }

  // ---------------------------------------------------------------- outgoing

  /** Records an amount owed to someone; caller provides the transaction. */
  oweRaw(p: { mint: string; unit: Unit; amount: number; purpose: OutgoingRow['purpose']; accountId?: string | null; requestId?: string | null }): string {
    const id = 'out_' + randomUUID();
    this.db
      .prepare(
        "INSERT INTO outgoing (id, mint, unit, amount, purpose, account_id, request_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'owed', ?, ?)",
      )
      .run(id, normalizeMintUrl(p.mint), p.unit, p.amount, p.purpose, p.accountId ?? null, p.requestId ?? null, now(), now());
    return id;
  }

  getOutgoing(id: string): OutgoingRow | undefined {
    return this.db.prepare('SELECT * FROM outgoing WHERE id = ?').get(id) as OutgoingRow | undefined;
  }

  listOutgoing(where: { requestId?: string; accountId?: string }): OutgoingRow[] {
    if (where.requestId) return this.db.prepare('SELECT * FROM outgoing WHERE request_id = ? ORDER BY created_at').all(where.requestId) as unknown as OutgoingRow[];
    return this.db.prepare('SELECT * FROM outgoing WHERE account_id = ? ORDER BY created_at').all(where.accountId ?? '') as unknown as OutgoingRow[];
  }

  /**
   * Turns an owed row into a token. Steps:
   *  1. Transaction: pick unspent proofs, mark them reserved for this row (status=reserved).
   *  2. Exact match: the token is those proofs (no mint call). Otherwise prepare a swap with
   *     deterministic outputs, persist preview + counters (status=prepared), swap.
   *  3. Transaction: inputs spent, keep proofs stored, token stored (status=done).
   * The stored token is returned on every later call, so a lost HTTP response can be re-fetched.
   */
  async issue(id: string): Promise<string> {
    let row = this.getOutgoing(id);
    if (!row) throw new Error('unknown outgoing');
    if (row.status === 'done') return row.token!;
    if (row.status === 'failed') throw new PaymentError('issue_failed', 'this payout failed');
    if (this.inflight.has(id)) throw new PaymentError('in_flight', 'payout in progress, retry shortly', 409);
    this.inflight.add(id);
    try {
      if (row.status === 'prepared' || row.status === 'reserved') {
        await this.recoverOutgoing(row);
        row = this.getOutgoing(id)!;
        if (row.status === 'done') return row.token!;
      }
      const w = await this.wallet(row.mint, row.unit);
      const amount = row.amount;
      const selected = tx(this.db, () => {
        const rows = this.db.prepare("SELECT proof FROM proofs WHERE mint = ? AND unit = ? AND state = 'unspent'").all(row!.mint, row!.unit) as Array<{
          proof: string;
        }>;
        const avail = deserializeProofs(rows.map((r) => r.proof));
        const pick = w.selectProofsToSend(avail, amount, true);
        if (!pick.send.length || sumProofs(pick.send) < amount) throw new PaymentError('wallet_insufficient', 'gateway wallet cannot cover this payout', 503);
        const mark = this.db.prepare("UPDATE proofs SET state = 'reserved', op_id = ? WHERE secret = ? AND state = 'unspent'");
        for (const p of pick.send) {
          if (Number(mark.run(id, p.secret).changes) !== 1) throw new Error('proof race');
        }
        this.db
          .prepare("UPDATE outgoing SET status = 'reserved', inputs = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(pick.send.map((p) => p.secret)), now(), id);
        return pick.send;
      });

      const fees = w.getFeesForProofs(selected).toNumber();
      if (sumProofs(selected) - fees === amount) {
        const token = getEncodedToken({ mint: row.mint, unit: row.unit, proofs: selected });
        this.finalizeOutgoing(id, token, []);
        return token;
      }

      let counters: OperationCounters | undefined;
      const preview = await w.prepareSwapToSend(
        amount,
        selected,
        { includeFees: true, onCountersReserved: (c) => (counters = c) },
        { send: { type: 'deterministic', counter: 0 }, keep: { type: 'deterministic', counter: 0 } },
      );
      this.db
        .prepare("UPDATE outgoing SET status = 'prepared', preview = ?, counters = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(serializeSwapPreview(preview)), JSON.stringify(counters ?? null), now(), id);
      let res;
      try {
        res = await w.completeSwap(preview);
      } catch (e) {
        if (isDefinitiveSpent(e)) {
          // Our own proofs were spent elsewhere (should not happen). Burn them and re-owe.
          this.reowe(id, true);
          throw new PaymentError('wallet_inconsistent', 'gateway proofs were already spent; retry', 503);
        }
        throw new PaymentError('mint_unavailable', `mint did not answer; payout is saved and can be retried: ${errText(e)}`, 503);
      }
      if (this.opts.faults?.afterSendSwap) throw new Error('fault injected after send swap');
      const token = getEncodedToken({ mint: row.mint, unit: row.unit, proofs: res.send });
      this.finalizeOutgoing(id, token, res.keep);
      return token;
    } finally {
      this.inflight.delete(id);
    }
  }

  private finalizeOutgoing(id: string, token: string, keep: Proof[]) {
    tx(this.db, () => {
      const row = this.getOutgoing(id)!;
      if (row.status === 'done') return;
      this.db.prepare("UPDATE proofs SET state = 'spent' WHERE op_id = ? AND state = 'reserved'").run(id);
      this.insertProofs(keep, row.mint, row.unit);
      this.db.prepare("UPDATE outgoing SET status = 'done', token = ?, updated_at = ? WHERE id = ?").run(token, now(), id);
    });
  }

  private reowe(id: string, inputsSpent: boolean) {
    tx(this.db, () => {
      this.db.prepare(`UPDATE proofs SET state = ?, op_id = NULL WHERE op_id = ? AND state = 'reserved'`).run(inputsSpent ? 'spent' : 'unspent', id);
      this.db.prepare("UPDATE outgoing SET status = 'owed', inputs = NULL, preview = NULL, counters = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    });
  }

  private async recoverOutgoing(row: OutgoingRow): Promise<void> {
    if (row.status === 'reserved' || !row.preview) {
      // Crash before the swap was prepared: nothing reached the mint.
      this.reowe(row.id, false);
      return;
    }
    const w = await this.wallet(row.mint, row.unit);
    const preview = deserializeSwapPreview(JSON.parse(row.preview));
    if (!this.opts.faults?.noReplayOnRecovery) {
      try {
        const res = await w.completeSwap(preview);
        this.finalizeOutgoing(row.id, getEncodedToken({ mint: row.mint, unit: row.unit, proofs: res.send }), res.keep);
        log.info('outgoing_recovered', { id: row.id, via: 'replay' });
        return;
      } catch (e) {
        if (!isMintRejection(e)) throw e;
      }
    }
    const c = row.counters ? (JSON.parse(row.counters) as OperationCounters | null) : null;
    if (c && c.count > 0) {
      const { proofs } = await w.restore(c.start, c.count, { keysetId: c.keysetId });
      if (proofs.length) {
        const sendSecrets = new Set((preview.sendOutputs ?? []).map(outputSecret));
        const send = proofs.filter((p) => sendSecrets.has(p.secret));
        const keep = proofs.filter((p) => !sendSecrets.has(p.secret));
        this.finalizeOutgoing(row.id, getEncodedToken({ mint: row.mint, unit: row.unit, proofs: send }), keep);
        log.info('outgoing_recovered', { id: row.id, via: 'restore' });
        return;
      }
    }
    const states = await w.checkProofsStates(preview.inputs);
    this.reowe(row.id, !states.every((s) => s.state === 'UNSPENT'));
    log.warn('outgoing_reowed', { id: row.id });
  }

  /** Startup recovery for every interrupted mint operation. */
  async recover(): Promise<{ incoming: number; outgoing: number; errors: number }> {
    let errors = 0;
    const inc = this.db.prepare("SELECT * FROM incoming WHERE status = 'prepared'").all() as unknown as IncomingRow[];
    for (const r of inc) {
      try {
        await this.recoverIncoming(r);
      } catch (e) {
        errors++;
        log.warn('recover_incoming_failed', { id: r.id, err: errText(e) });
      }
    }
    // status=new rows never reached the mint; the client still holds a valid token, so forget them.
    this.db.prepare("DELETE FROM incoming WHERE status = 'new'").run();
    const out = this.db.prepare("SELECT * FROM outgoing WHERE status IN ('reserved', 'prepared')").all() as unknown as OutgoingRow[];
    for (const r of out) {
      try {
        await this.recoverOutgoing(r);
      } catch (e) {
        errors++;
        log.warn('recover_outgoing_failed', { id: r.id, err: errText(e) });
      }
    }
    return { incoming: inc.length, outgoing: out.length, errors };
  }

  /** Holdings and obligations per mint+unit, in whole units. */
  holdings(): Array<{ mint: string; unit: string; unspent: number; reserved: number; owed: number }> {
    const rows = this.db
      .prepare(
        "SELECT mint, unit, SUM(CASE WHEN state = 'unspent' THEN amount ELSE 0 END) AS unspent, SUM(CASE WHEN state = 'reserved' THEN amount ELSE 0 END) AS reserved FROM proofs GROUP BY mint, unit",
      )
      .all() as Array<{ mint: string; unit: string; unspent: number; reserved: number }>;
    const owed = this.db
      .prepare("SELECT mint, unit, SUM(amount) AS owed FROM outgoing WHERE status IN ('owed', 'reserved', 'prepared') GROUP BY mint, unit")
      .all() as Array<{ mint: string; unit: string; owed: number }>;
    return rows.map((r) => ({ ...r, owed: owed.find((o) => o.mint === r.mint && o.unit === r.unit)?.owed ?? 0 }));
  }
}

export { Amount };
