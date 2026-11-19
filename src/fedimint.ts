/**
 * Fedimint eCash in POST /v1/wallet/topup (docs/PAYMENTS.md, Fedimint notes). The gateway runs no
 * Fedimint client: the receiver service (services/fedimint-receiver, docs/FEDIMINT-RECEIVER.md) holds
 * the notes. This file is the gateway's side of its contract:
 *
 *  1. POST /parse first: the notes' value and federation, with nothing spent. A federation is accepted
 *     only when the receiver has joined it AND the federations table has it active. The caps are checked
 *     here: per payment, and the federation's holdings.
 *  2. The gateway's own incoming row, id fm:<notes_id>, status prepared, holding the notes text, is
 *     written BEFORE POST /receive, so recovery needs nothing but that row.
 *  3. POST /receive with this top-up's key. The receiver answers the first caller's record to everyone:
 *     a record whose key is not ours means someone else gave those notes first, and nothing is credited.
 *  4. Credit only on done, net_msat from the done record, in one transaction with marking the row done.
 *     pending, a network error or a 5xx is unknown: 503 topup_pending, and the sweep (every 30 s, and at
 *     startup) asks again. issuance_failed is never credited: the row stays as stuck for an operator.
 *
 * The notes text is kept on the row only until the receiver has a record of them (any answer carrying
 * the record): from then on GET /receive/{notes_id} is enough, so the bearer notes are not kept longer
 * than needed. Nothing here logs notes or invite codes.
 */
import { PaymentError } from './cashu/wallet.ts';
import { type DB, now, tx } from './db.ts';
import type { Ledger } from './ledger.ts';
import { errText, log } from './log.ts';

/** How often pending Fedimint top-ups are asked about again. */
export const SWEEP_MS = 30_000;
/** How long a top-up request waits for a pending receive to finish before it answers topup_pending. */
export const WAIT_MS = 8_000;
const POLL_MS = 250;
/** How long the list of federations the receiver has joined is kept for GET /v1/wallet/fund/methods. */
const JOINED_TTL_MS = 15_000;

/** An error from the receiver: its own code and status, or status 0 when it did not answer at all. */
export class ReceiverError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Codes the receiver answers before it records anything (docs/FEDIMINT-RECEIVER.md, The API): the notes
 * are untouched and still their holder's. Every other failure (a 5xx, 401, no answer) is an unknown.
 */
const NOTHING_RECORDED = new Set(['bad_request', 'bad_notes', 'not_joined', 'ambiguous_federation', 'module_unsupported', 'fee_exceeds_value']);

export interface ParsedNotes {
  notes_id: string;
  module: string;
  amount_msat: number;
  count: number;
  federation_id: string | null;
  federation_prefix: string;
  joined: boolean;
  resolution: 'joined' | 'not_joined' | 'ambiguous';
  module_supported: boolean | null;
  signatures_valid: boolean | null;
  received: string | null;
}

export interface ReceiveRecord {
  notes_id: string;
  key: string;
  federation_id: string;
  module: string;
  operation_id: string;
  state: 'pending' | 'done' | 'failed';
  gross_msat: number;
  fee_msat: number;
  net_msat: number;
  failure?: 'rejected' | 'refused' | 'issuance_failed';
  reason?: string;
  repeat?: boolean;
}

export interface JoinedFederation {
  id: string;
  name: string | null;
  modules: string[];
  receives: string[];
  balance_msat?: number;
  already_joined?: boolean;
}

/** The receiver's HTTP API, with its bearer token. Never sends a redirect on. */
export class ReceiverClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  constructor(url: string, token: string, timeoutMs = 15_000) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: object): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ReceiverError('unreachable_receiver', 0, `the Fedimint receiver did not answer: ${errText(e)}`);
    }
    const j: any = await res.json().catch(() => undefined);
    if (!res.ok) throw new ReceiverError(String(j?.error?.code ?? 'internal'), res.status, String(j?.error?.message ?? `HTTP ${res.status}`));
    if (j === undefined) throw new ReceiverError('internal', 502, 'the Fedimint receiver answered without JSON');
    return j;
  }

  join(invite: string): Promise<JoinedFederation> {
    return this.call('POST', '/federations', { invite });
  }
  async federations(): Promise<JoinedFederation[]> {
    return (await this.call('GET', '/federations')).federations;
  }
  async balanceMsat(id: string): Promise<number> {
    return Number((await this.call('GET', `/federations/${encodeURIComponent(id)}/balance`)).balance_msat);
  }
  parse(notes: string): Promise<ParsedNotes> {
    return this.call('POST', '/parse', { notes });
  }
  receive(notes: string, key: string): Promise<ReceiveRecord> {
    return this.call('POST', '/receive', { notes, key });
  }
  /** The record of a receive, or undefined when the receiver has none. */
  async status(notesId: string): Promise<ReceiveRecord | undefined> {
    try {
      return await this.call('GET', `/receive/${encodeURIComponent(notesId)}`);
    } catch (e) {
      if (e instanceof ReceiverError && e.status === 404) return undefined;
      throw e;
    }
  }
}

/** A row of the federations table. */
export interface FederationRow {
  id: string;
  name: string | null;
  invite: string;
  modules: string;
  receives: string;
  state: 'active' | 'paused';
  max_sat: number | null;
  cap_sat: number | null;
  joined_at: number;
}

interface FmRow {
  id: string;
  account_id: string;
  mint: string;
  amount: number;
  status: 'prepared' | 'done' | 'rejected' | 'stuck';
  notes: string | null;
  error: string | null;
}

/** What /parse and the policy said about notes about to be taken (FedimintService.check). */
export interface FedimintPlan {
  notes: string;
  parsed: ParsedNotes;
  /** The federation's row; undefined when the gateway already has a row for these notes (a retry). */
  federation?: FederationRow;
  /** The receiver's balance for the federation, and when it was asked (for the holdings cap). */
  balanceMsat: number;
  balanceAt: number;
}

export interface FedimintResult {
  replay: boolean;
  /** What was credited, in msat (0 on a replay). */
  creditedMsat: number;
  notesId: string;
  federationId: string;
}

/** Test-only fault injection: a crash after the row is written (before /receive), or after /receive answered (before the credit). */
export interface FedimintFaults {
  afterRow?: boolean;
  afterReceive?: boolean;
}

export interface FedimintOptions {
  db: DB;
  ledger: Ledger;
  client: ReceiverClient;
  /** Per payment, in sat (FORGE_FEDIMINT_MAX_SAT); a federation's own max_sat overrides it. */
  maxSat: number;
  /** Per federation's holdings, in sat (FORGE_FEDIMINT_FEDERATION_CAP_SAT); its own cap_sat overrides it. */
  capSat: number;
  maxNotesBytes: number;
  waitMs?: number;
  pollMs?: number;
  faults?: FedimintFaults;
}

/** A Fedimint top-up whose outcome is not known yet: answered 503 topup_pending. */
export class FedimintPending extends Error {}

const mintOf = (federationId: string) => `fedimint:${federationId}`;
/** This top-up's key at the receiver: the balance it credits. The same balance giving the same notes again resumes it. */
export const receiveKey = (accountId: string) => `forge:${accountId}`;

/** Whitespace is ignored in notes, as the receiver ignores it. */
const compact = (s: string) => s.replace(/\s+/g, '');

/**
 * True when a top-up's token is meant as Fedimint notes. Anything that starts with "cashu" stays on the
 * Cashu path exactly as before; the rest must look like the notes the receiver reads: "fedimint" followed
 * by base32 (mintv2, or mint v1 in base32), or base64 / base64url (mint v1 OOBNotes).
 */
export function looksLikeFedimintNotes(token: string): boolean {
  const t = compact(token);
  if (t.length < 16 || /^cashu/i.test(token.trimStart())) return false;
  return /^fedimint[a-z0-9]+$/i.test(t) || /^[A-Za-z0-9+/_-]+={0,2}$/.test(t);
}

export class FedimintService {
  private readonly db: DB;
  private readonly ledger: Ledger;
  readonly client: ReceiverClient;
  private readonly o: FedimintOptions;
  private readonly inflight = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<{ checked: number; credited: number }>;
  private joined?: { at: number; ids: Set<string> };
  private joinedLoad?: Promise<Set<string> | undefined>;

  constructor(o: FedimintOptions) {
    this.o = o;
    this.db = o.db;
    this.ledger = o.ledger;
    this.client = o.client;
  }

  isNotes(token: string): boolean {
    return looksLikeFedimintNotes(token);
  }

  // ---------------------------------------------------------------- federations (pnpm admin fedimint:*)

  federation(id: string): FederationRow | undefined {
    return this.db.prepare('SELECT * FROM federations WHERE id = ?').get(id) as FederationRow | undefined;
  }

  federations(): FederationRow[] {
    return this.db.prepare('SELECT * FROM federations ORDER BY joined_at').all() as unknown as FederationRow[];
  }

  /**
   * Joins a federation through the receiver and writes its row (active). Joining one already joined
   * refreshes its name and modules and keeps its state and caps, unless new caps are given.
   */
  async join(invite: string, caps: { maxSat?: number; capSat?: number } = {}): Promise<{ row: FederationRow; created: boolean; alreadyJoined: boolean }> {
    const f = await this.client.join(invite.trim());
    const existing = this.federation(f.id);
    if (existing) {
      this.db
        .prepare('UPDATE federations SET name = ?, invite = ?, modules = ?, receives = ?, max_sat = COALESCE(?, max_sat), cap_sat = COALESCE(?, cap_sat) WHERE id = ?')
        .run(f.name, invite.trim(), JSON.stringify(f.modules), JSON.stringify(f.receives), caps.maxSat ?? null, caps.capSat ?? null, f.id);
    } else {
      this.db
        .prepare("INSERT INTO federations (id, name, invite, modules, receives, state, max_sat, cap_sat, joined_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)")
        .run(f.id, f.name, invite.trim(), JSON.stringify(f.modules), JSON.stringify(f.receives), caps.maxSat ?? null, caps.capSat ?? null, now());
    }
    this.joined = undefined;
    log.info('fedimint_federation_joined', { federation: f.id, created: !existing, already_joined: !!f.already_joined });
    return { row: this.federation(f.id)!, created: !existing, alreadyJoined: !!f.already_joined };
  }

  setState(id: string, state: 'active' | 'paused'): boolean {
    const changed = this.db.prepare('UPDATE federations SET state = ? WHERE id = ?').run(state, id).changes > 0;
    if (changed) log.info('fedimint_federation_state', { federation: id, state });
    return changed;
  }

  /** Pending (prepared) and stuck (issuance_failed) top-ups per federation, for the operator. */
  counts(id: string): { pending: number; stuck: number; credited_msat: number } {
    const r = this.db
      .prepare(
        "SELECT SUM(status = 'prepared') AS pending, SUM(status = 'stuck') AS stuck FROM incoming WHERE purpose = 'fedimint' AND mint = ?",
      )
      .get(mintOf(id)) as { pending: number | null; stuck: number | null };
    const c = this.db.prepare("SELECT COALESCE(SUM(amount_msub), 0) AS s FROM ledger WHERE kind = 'topup' AND ref IN (SELECT id FROM incoming WHERE purpose = 'fedimint' AND mint = ?)").get(mintOf(id)) as {
      s: number;
    };
    return { pending: r.pending ?? 0, stuck: r.stuck ?? 0, credited_msat: c.s };
  }

  /** Ids of the federations the receiver reports joined, kept JOINED_TTL_MS; undefined when it cannot be asked. */
  private async joinedIds(): Promise<Set<string> | undefined> {
    if (this.joined && Date.now() - this.joined.at < JOINED_TTL_MS) return this.joined.ids;
    this.joinedLoad ??= this.client
      .federations()
      .then((fs) => {
        this.joined = { at: Date.now(), ids: new Set(fs.map((f) => f.id)) };
        return this.joined.ids;
      })
      .catch((e) => {
        log.warn('fedimint_receiver_unavailable', { err: errText(e) });
        return this.joined?.ids;
      })
      .finally(() => (this.joinedLoad = undefined));
    return this.joinedLoad;
  }

  /** GET /v1/wallet/fund/methods: Fedimint notes are taken while at least one active federation is joined. */
  async methods(): Promise<{ enabled: boolean; unit: 'sat'; max: number; federations: Array<{ id: string; name: string | null; max: number }> }> {
    const joined = await this.joinedIds();
    const federations = this.federations()
      .filter((f) => f.state === 'active' && joined?.has(f.id))
      .map((f) => ({ id: f.id, name: f.name, max: Math.min(f.max_sat ?? this.o.maxSat, this.o.maxSat) }));
    return { enabled: federations.length > 0, unit: 'sat', max: this.o.maxSat, federations };
  }

  // ---------------------------------------------------------------- top-up

  private row(id: string): FmRow | undefined {
    return this.db.prepare("SELECT id, account_id, mint, amount, status, notes, error FROM incoming WHERE id = ? AND purpose = 'fedimint'").get(id) as FmRow | undefined;
  }

  /**
   * Step 1, before any balance is opened: reads the notes at the receiver and refuses what the gateway
   * does not take. Nothing is spent or recorded. Notes the gateway already has a row for skip the policy:
   * they are resumed (or refused) by receive(), whatever has changed since.
   */
  async check(token: string): Promise<FedimintPlan> {
    const notes = compact(token);
    if (notes.length > this.o.maxNotesBytes) throw new PaymentError('invalid_token', 'notes too large');
    let parsed: ParsedNotes;
    try {
      parsed = await this.client.parse(notes);
    } catch (e) {
      if (e instanceof ReceiverError && (e.code === 'bad_notes' || e.code === 'bad_request')) throw new PaymentError('invalid_token', 'expected a cashuB token or Fedimint notes');
      log.warn('fedimint_receiver_unavailable', { err: errText(e) });
      throw new PaymentError('fedimint_unavailable', 'Fedimint notes cannot be taken right now; nothing was spent, try again later', 503);
    }
    if (this.row(`fm:${parsed.notes_id}`)) return { notes, parsed, balanceMsat: 0, balanceAt: 0 };
    const fed = parsed.resolution === 'joined' && parsed.federation_id ? this.federation(parsed.federation_id) : undefined;
    const ids = { federation_id: parsed.federation_id, federation_prefix: parsed.federation_prefix };
    if (!fed) {
      throw new PaymentError(
        'federation_not_joined',
        parsed.resolution === 'ambiguous' ? 'these notes name their federation too briefly to tell which one issued them' : 'Forge does not take notes from the federation that issued these',
        400,
        { fedimint: ids },
      );
    }
    if (fed.state !== 'active') throw new PaymentError('federation_paused', 'Forge is not taking notes from this federation right now; nothing was spent', 400, { fedimint: ids });
    if (parsed.module_supported === false) throw new PaymentError('notes_unsupported', `notes of the ${parsed.module} module are not taken from this federation`, 400, { fedimint: ids });
    if (parsed.signatures_valid !== true) throw new PaymentError('invalid_token', 'these notes are not valid notes of their federation');
    const max = Math.min(fed.max_sat ?? this.o.maxSat, this.o.maxSat);
    if (parsed.amount_msat > max * 1000) throw new PaymentError('amount_too_large', `Fedimint notes are limited to ${max} sat in one top-up`, 400, { max: { sat: max } });
    const balanceAt = now();
    let balanceMsat: number;
    try {
      balanceMsat = await this.client.balanceMsat(fed.id);
    } catch (e) {
      log.warn('fedimint_receiver_unavailable', { err: errText(e) });
      throw new PaymentError('fedimint_unavailable', 'Fedimint notes cannot be taken right now; nothing was spent, try again later', 503);
    }
    // Checked again, with the notes on their way, when the row is written (receive()).
    this.holdingsCheck(fed, parsed.amount_msat, balanceMsat, balanceAt);
    return { notes, parsed, federation: fed, balanceMsat, balanceAt };
  }

  /**
   * The federation's holdings with these notes added must stay within its cap: the receiver's balance,
   * plus every top-up on its way (prepared), every stuck one, and every one finished since the balance was
   * read (it may or may not be in that balance, so it is counted: the check errs towards refusing).
   * Synchronous with the row's insert, so two top-ups at once cannot both pass on the same room.
   */
  private holdingsCheck(fed: FederationRow, amountMsat: number, balanceMsat: number, balanceAt: number) {
    const cap = fed.cap_sat ?? this.o.capSat;
    const pending = (
      this.db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM incoming WHERE purpose = 'fedimint' AND mint = ? AND (status IN ('prepared', 'stuck') OR (status = 'done' AND updated_at >= ?))")
        .get(mintOf(fed.id), balanceAt) as { s: number }
    ).s;
    if (balanceMsat + pending + amountMsat > cap * 1000) {
      throw new PaymentError('federation_full', 'Forge holds as much of this federation as it takes; nothing was spent', 400, { fedimint: { federation_id: fed.id } });
    }
  }

  /**
   * Steps 2 to 4 for the balance accountId (opened by the caller after check()). Resolves when the notes
   * are credited (or were before, a replay); throws a PaymentError on a refusal, FedimintPending when the
   * outcome is not known yet.
   */
  async receive(plan: FedimintPlan, accountId: string): Promise<FedimintResult> {
    const id = `fm:${plan.parsed.notes_id}`;
    if (this.inflight.has(id)) throw new PaymentError('token_in_flight', 'these notes are already being processed', 409);
    this.inflight.add(id);
    try {
      let row = this.row(id);
      if (row) {
        // The notes went to the receiver for one balance only.
        if (row.account_id !== accountId) throw new PaymentError('token_spent', 'these notes were already given');
        if (row.status === 'done') return { replay: true, creditedMsat: 0, notesId: plan.parsed.notes_id, federationId: row.mint.slice('fedimint:'.length) };
        if (row.status === 'rejected') throw new PaymentError('token_spent', `these notes were refused: ${row.error ?? 'spent'}`);
        if (row.status === 'stuck') throw this.stuckError();
      } else {
        // check() found a row that has gone since (refused meanwhile): the caller asks again.
        if (!plan.federation) throw new PaymentError('token_in_flight', 'these notes are being processed; try again', 409);
        const fed = plan.federation;
        this.holdingsCheck(fed, plan.parsed.amount_msat, plan.balanceMsat, plan.balanceAt);
        const t = now();
        this.db
          .prepare(
            "INSERT INTO incoming (id, token_hash, mint, unit, amount, purpose, account_id, request_id, status, notes, created_at, updated_at) VALUES (?, ?, ?, 'sat', ?, 'fedimint', ?, NULL, 'prepared', ?, ?, ?)",
          )
          .run(id, id, mintOf(fed.id), plan.parsed.amount_msat, accountId, plan.notes, t, t);
        row = this.row(id)!;
      }
      if (this.o.faults?.afterRow) throw new Error('fault injected after the Fedimint row');
      let outcome = await this.settle(row);
      // Usually the federation finishes in a moment: wait a little before answering topup_pending.
      const deadline = Date.now() + (this.o.waitMs ?? WAIT_MS);
      while (outcome.kind === 'pending' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, this.o.pollMs ?? POLL_MS));
        outcome = await this.settle(this.row(id)!);
      }
      switch (outcome.kind) {
        case 'done':
          return { replay: false, creditedMsat: outcome.netMsat, notesId: plan.parsed.notes_id, federationId: row.mint.slice('fedimint:'.length) };
        case 'pending':
          throw new FedimintPending('the Fedimint receive is not finished yet');
        default:
          throw outcome.error;
      }
    } finally {
      this.inflight.delete(id);
    }
  }

  private stuckError() {
    return new PaymentError(
      'issuance_failed',
      'the federation took these notes but has not issued their value yet; nothing was credited and the notes are not lost: an operator will look at it',
      502,
    );
  }

  /**
   * One step for a prepared row: POST /receive while the gateway still holds the notes (idempotent at the
   * receiver), else GET /receive/{notes_id}; then apply the record. Runs only while the caller holds the
   * row's in-flight mark.
   */
  private async settle(row: FmRow): Promise<{ kind: 'done'; netMsat: number } | { kind: 'pending' } | { kind: 'refused'; error: PaymentError }> {
    if (row.status === 'done') return { kind: 'done', netMsat: 0 };
    if (row.status !== 'prepared') return { kind: 'refused', error: row.status === 'stuck' ? this.stuckError() : new PaymentError('token_spent', `these notes were refused: ${row.error ?? 'spent'}`) };
    const notesId = row.id.slice('fm:'.length);
    const key = receiveKey(row.account_id);
    let rec: ReceiveRecord | undefined;
    try {
      rec = row.notes ? await this.o.client.receive(row.notes, key) : await this.o.client.status(notesId);
    } catch (e) {
      if (e instanceof ReceiverError && row.notes && NOTHING_RECORDED.has(e.code)) {
        // The receiver recorded nothing and spent nothing: the row goes, and the notes stay their holder's.
        this.db.prepare("DELETE FROM incoming WHERE id = ? AND status = 'prepared'").run(row.id);
        log.info('fedimint_topup_refused', { id: row.id, code: e.code });
        return { kind: 'refused', error: refusal(e) };
      }
      log.warn('fedimint_topup_unknown', { id: row.id, err: errText(e) });
      return { kind: 'pending' };
    }
    if (this.o.faults?.afterReceive) throw new Error('fault injected after the Fedimint receive');
    if (!rec) {
      // The receiver has no record although it acknowledged one (the notes were dropped then): an operator must look.
      log.error('fedimint_receive_missing', { id: row.id });
      return { kind: 'pending' };
    }
    return this.apply(row, rec, key);
  }

  private apply(row: FmRow, rec: ReceiveRecord, key: string): { kind: 'done'; netMsat: number } | { kind: 'pending' } | { kind: 'refused'; error: PaymentError } {
    const end = (status: 'rejected' | 'stuck', error: string) =>
      this.db.prepare("UPDATE incoming SET status = ?, error = ?, notes = NULL, updated_at = ? WHERE id = ? AND status = 'prepared'").run(status, error, now(), row.id);
    if (rec.key !== key) {
      // Someone gave these notes to the receiver first: they are theirs, not this balance's.
      end('rejected', 'given first by someone else');
      log.warn('fedimint_topup_given_elsewhere', { id: row.id });
      return { kind: 'refused', error: new PaymentError('token_spent', 'these notes were already given') };
    }
    if (rec.state === 'done') {
      const net = Math.trunc(Number(rec.net_msat));
      if (!Number.isSafeInteger(net) || net < 0) throw new Error(`receiver answered a done record with net_msat ${rec.net_msat}`);
      const credited = tx(this.db, () => {
        const cur = this.db.prepare('SELECT status FROM incoming WHERE id = ?').get(row.id) as { status: string } | undefined;
        if (cur?.status !== 'prepared') return false;
        this.ledger.creditRaw(row.account_id, net, 'topup', row.id);
        this.db.prepare("UPDATE incoming SET status = 'done', notes = NULL, error = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
        return true;
      });
      if (credited) log.info('fedimint_topup_credited', { id: row.id, account: row.account_id, federation: rec.federation_id, net_msat: net, fee_msat: rec.fee_msat });
      return { kind: 'done', netMsat: credited ? net : 0 };
    }
    if (rec.state === 'failed') {
      if (rec.failure === 'issuance_failed') {
        end('stuck', `issuance_failed: ${rec.reason ?? ''}`.slice(0, 300));
        log.error('fedimint_issuance_failed', { id: row.id, account: row.account_id, federation: rec.federation_id, gross_msat: rec.gross_msat });
        return { kind: 'refused', error: this.stuckError() };
      }
      end('rejected', `${rec.failure ?? 'failed'}: ${rec.reason ?? ''}`.slice(0, 300));
      log.info('fedimint_topup_rejected', { id: row.id, failure: rec.failure ?? null });
      return {
        kind: 'refused',
        error: rec.failure === 'rejected' ? new PaymentError('token_spent', 'the federation refused these notes: they were spent already') : new PaymentError('invalid_token', 'these notes could not be taken'),
      };
    }
    // pending: the receiver has the notes on record, so the gateway no longer needs to hold them.
    if (row.notes) {
      this.db.prepare("UPDATE incoming SET notes = NULL, updated_at = ? WHERE id = ? AND status = 'prepared'").run(now(), row.id);
      row.notes = null;
    }
    return { kind: 'pending' };
  }

  // ---------------------------------------------------------------- recovery

  /**
   * Asks about every pending Fedimint top-up once: at startup and every SWEEP_MS. Idempotent: a row is
   * credited only in the transaction that moves it from prepared to done, and a row a request is working
   * on is left to that request. Overlapping calls share one pass.
   */
  sweep(): Promise<{ checked: number; credited: number }> {
    this.sweeping ??= (async () => {
      const rows = this.db.prepare("SELECT id, account_id, mint, amount, status, notes, error FROM incoming WHERE purpose = 'fedimint' AND status = 'prepared' ORDER BY created_at").all() as unknown as FmRow[];
      let checked = 0;
      let credited = 0;
      for (const r of rows) {
        if (this.inflight.has(r.id)) continue;
        this.inflight.add(r.id);
        try {
          checked++;
          const cur = this.row(r.id);
          if (cur?.status === 'prepared' && (await this.settle(cur)).kind === 'done') credited++;
        } catch (e) {
          log.warn('fedimint_sweep_failed', { id: r.id, err: errText(e) });
        } finally {
          this.inflight.delete(r.id);
        }
      }
      if (credited > 0) log.info('fedimint_sweep', { checked, credited });
      return { checked, credited };
    })().finally(() => (this.sweeping = undefined));
    return this.sweeping;
  }

  start(intervalMs = SWEEP_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The gateway's answer for a receiver refusal that spent and recorded nothing. */
function refusal(e: ReceiverError): PaymentError {
  switch (e.code) {
    case 'not_joined':
    case 'ambiguous_federation':
      return new PaymentError('federation_not_joined', 'Forge does not take notes from the federation that issued these');
    case 'module_unsupported':
      return new PaymentError('notes_unsupported', 'these notes are not of a kind taken from this federation');
    case 'fee_exceeds_value':
      return new PaymentError('insufficient_amount', 'the federation would charge at least what these notes are worth to take them');
    default:
      return new PaymentError('invalid_token', 'these notes are not valid notes of their federation');
  }
}
