import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for the Fedimint receiver (services/fedimint-receiver, docs/FEDIMINT-RECEIVER.md) for the
// gateway's unit tests: the same routes, bearer token, error shape and record states over real HTTP, with
// knobs for what the real one does only under failure (a receive left pending, an answer lost after the
// record was written, a 5xx, issuance_failed). The end to end test (test/fedimint/) runs the real one.

export const RECEIVER_TOKEN = 'test-receiver-token-0123456789abcdef';

export interface FakeNotes {
  notes: string;
  notes_id: string;
  federation_id: string;
  module: 'mint' | 'mintv2';
  amount_msat: number;
  /** Whether the notes' signatures verify under their federation. */
  valid: boolean;
  /** How a receive of them ends: at once, pending until finish(), or failed. */
  outcome: 'done' | 'pending' | 'rejected' | 'issuance_failed' | 'refused';
  fee_msat: number;
}

interface Record_ {
  notes_id: string;
  key: string;
  federation_id: string;
  module: string;
  operation_id: string;
  state: 'pending' | 'done' | 'failed';
  gross_msat: number;
  fee_msat: number;
  net_msat: number;
  failure?: string;
  reason?: string;
  created_at: number;
  updated_at: number;
}

export class FakeReceiver {
  url = '';
  private server?: Server;
  readonly federations = new Map<string, { id: string; name: string | null; modules: string[]; receives: string[]; balance_msat: number }>();
  /** Invite codes the fake knows, and the federation each one joins. */
  readonly invites = new Map<string, { id: string; name: string; receives?: string[] }>();
  readonly notes = new Map<string, FakeNotes>();
  readonly records = new Map<string, Record_>();
  /** Every request, as "METHOD /path" (bodies are not kept). */
  readonly calls: string[] = [];
  /** Bodies of POST /receive, in order. */
  readonly receiveBodies: Array<{ notes: string; key: string }> = [];
  /** Connections are dropped without an answer while set. */
  down = false;
  /** POST /receive records (and starts) the receive, then drops the connection, this many times. */
  loseReceiveAnswer = 0;
  /** POST /receive drops the connection before doing anything, this many times. */
  dropReceive = 0;
  /** POST /receive answers 500 before doing anything, this many times. */
  fail500 = 0;
  /** POST /receive waits this long before answering. */
  receiveDelayMs = 0;
  private n = 0;

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async close() {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** A federation the receiver has joined. */
  joinFederation(id: string, name = `Fed ${id.slice(0, 4)}`, receives = ['mint'], balanceMsat = 0) {
    this.federations.set(id, { id, name, modules: ['mint', 'wallet', 'ln'], receives, balance_msat: balanceMsat });
  }

  /** New notes of a federation (joined or not), as fedimint base32 text. */
  makeNotes(federationId: string, amountMsat: number, o: Partial<Omit<FakeNotes, 'notes' | 'notes_id' | 'federation_id' | 'amount_msat'>> = {}): FakeNotes {
    const i = ++this.n;
    const notes_id = createHash('sha256').update(`notes ${i} ${federationId}`).digest('hex');
    const notes = 'fedimint' + createHash('sha256').update(`text ${i}`).digest('hex').replace(/[^a-z0-9]/g, '') + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const n: FakeNotes = { notes, notes_id, federation_id: federationId, module: 'mint', amount_msat: amountMsat, valid: true, outcome: 'done', fee_msat: 1234, ...o };
    this.notes.set(notes, n);
    return n;
  }

  /** Ends a pending receive. */
  finish(notesId: string, state: 'done' | 'failed', failure?: string) {
    const r = this.records.get(notesId)!;
    r.state = state;
    r.updated_at += 1;
    if (state === 'failed') {
      r.failure = failure;
      r.reason = `test: ${failure}`;
    } else this.federations.get(r.federation_id)!.balance_msat += r.net_msat;
  }

  /** A record someone else started (another caller's key), as if those notes were given first elsewhere. */
  receivedElsewhere(n: FakeNotes, key = 'someone-else') {
    this.records.set(n.notes_id, this.newRecord(n, key));
    this.finish(n.notes_id, 'done');
  }

  private newRecord(n: FakeNotes, key: string): Record_ {
    const t = Math.floor(Date.now() / 1000);
    return {
      notes_id: n.notes_id,
      key,
      federation_id: n.federation_id,
      module: n.module,
      operation_id: createHash('sha256').update(`op ${n.notes_id}`).digest('hex'),
      state: 'pending',
      gross_msat: n.amount_msat,
      fee_msat: n.fee_msat,
      net_msat: n.amount_msat - n.fee_msat,
      created_at: t,
      updated_at: t,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (this.down) return req.socket.destroy();
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    this.calls.push(`${req.method} ${path}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const error = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    if (req.headers.authorization !== `Bearer ${RECEIVER_TOKEN}`) return error(401, 'unauthorized', 'a bearer token is required');
    let body: any = {};
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return error(400, 'bad_request', 'the body is not JSON');
      }
    }
    const fedOf = (n: FakeNotes) => this.federations.get(n.federation_id);

    if (req.method === 'GET' && path === '/federations') {
      return send(200, { federations: [...this.federations.values()] });
    }
    if (req.method === 'POST' && path === '/federations') {
      const inv = this.invites.get(String(body.invite));
      if (!inv) return error(422, 'bad_invite', 'not an invite code');
      const already = this.federations.has(inv.id);
      if (!already) this.joinFederation(inv.id, inv.name, inv.receives);
      const f = this.federations.get(inv.id)!;
      return send(200, { id: f.id, name: f.name, modules: f.modules, receives: f.receives, already_joined: already });
    }
    const bal = /^\/federations\/([0-9a-f]+)\/balance$/.exec(path);
    if (req.method === 'GET' && bal) {
      const f = this.federations.get(bal[1]!);
      return f ? send(200, { id: f.id, balance_msat: f.balance_msat }) : error(404, 'not_found', 'no joined federation has this id');
    }
    if (req.method === 'POST' && path === '/parse') {
      const n = this.notes.get(String(body.notes));
      if (!n) return error(422, 'bad_notes', 'not notes this service reads');
      const f = fedOf(n);
      return send(200, {
        notes_id: n.notes_id,
        module: n.module,
        amount_msat: n.amount_msat,
        count: 3,
        federation_id: n.federation_id,
        federation_prefix: n.federation_id.slice(0, 8),
        joined: !!f,
        resolution: f ? 'joined' : 'not_joined',
        module_supported: f ? f.receives.includes(n.module) : null,
        signatures_valid: f ? n.valid : null,
        received: this.records.get(n.notes_id)?.state ?? null,
      });
    }
    if (req.method === 'POST' && path === '/receive') {
      if (this.dropReceive > 0) {
        this.dropReceive--;
        return req.socket.destroy();
      }
      if (this.fail500 > 0) {
        this.fail500--;
        return error(500, 'internal', 'internal error; see the service log');
      }
      if (this.receiveDelayMs) await new Promise((r) => setTimeout(r, this.receiveDelayMs));
      this.receiveBodies.push({ notes: String(body.notes), key: String(body.key) });
      if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(String(body.key ?? ''))) return error(400, 'bad_request', 'bad key');
      const n = this.notes.get(String(body.notes));
      if (!n) return error(422, 'bad_notes', 'not notes this service reads');
      const existing = this.records.get(n.notes_id);
      if (existing) return send(200, { ...existing, repeat: true });
      const f = fedOf(n);
      if (!f) return error(409, 'not_joined', 'the federation that issued these notes has not been joined');
      if (!f.receives.includes(n.module)) return error(422, 'module_unsupported', 'no such mint module');
      if (!n.valid) return error(422, 'bad_notes', 'signatures do not verify');
      if (n.fee_msat >= n.amount_msat) return error(422, 'fee_exceeds_value', 'fee at least the value');
      const r = this.newRecord(n, String(body.key));
      this.records.set(n.notes_id, r);
      if (n.outcome === 'done') this.finish(n.notes_id, 'done');
      else if (n.outcome !== 'pending') this.finish(n.notes_id, 'failed', n.outcome);
      if (this.loseReceiveAnswer > 0) {
        this.loseReceiveAnswer--;
        return req.socket.destroy();
      }
      return send(200, { ...r, repeat: false });
    }
    const st = /^\/receive\/([0-9a-f]+)$/.exec(path);
    if (req.method === 'GET' && st) {
      const r = this.records.get(st[1]!);
      return r ? send(200, r) : error(404, 'not_found', 'no receive has this notes_id');
    }
    return error(404, 'not_found', 'no such route');
  }
}
