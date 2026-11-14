import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Prepaid balances. Only a SHA-256 of the bearer key is stored.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL,
  balance_msub INTEGER NOT NULL DEFAULT 0 CHECK (balance_msub >= 0),
  invite_id TEXT,
  created_at INTEGER NOT NULL,
  frozen_at INTEGER,                -- set by the operator: spending blocked, refunds allowed
  free INTEGER NOT NULL DEFAULT 0   -- 1: a free balance, funded with credits (docs/FREE-TIER.md); never money
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount_msub INTEGER NOT NULL,
  status TEXT NOT NULL,             -- active | settled | released
  charged_msub INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS reservations_active ON reservations(account_id, status);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- topup | charge | refund
  amount_msub INTEGER NOT NULL,     -- signed
  ref TEXT,
  created_at INTEGER NOT NULL
);

-- Incoming tokens (topups and NUT-24 payments). token_hash makes redemption idempotent.
CREATE TABLE IF NOT EXISTS incoming (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,            -- topup | nut24
  account_id TEXT,
  request_id TEXT,
  status TEXT NOT NULL,             -- new | prepared | done | rejected
  preview TEXT,                     -- serialized SwapPreview (NUT-19 replay)
  counters TEXT,                    -- JSON {keysetId,start,count} (NUT-09 restore)
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outgoing tokens (change, refunds, revenue export).
CREATE TABLE IF NOT EXISTS outgoing (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,            -- change | refund | export
  account_id TEXT,
  request_id TEXT,
  status TEXT NOT NULL,             -- owed | reserved | prepared | done | failed
  inputs TEXT,                      -- JSON array of proof secrets reserved for this op
  preview TEXT,
  counters TEXT,
  token TEXT,
  error TEXT,
  lock_pubkey TEXT,                 -- NUT-11: send outputs locked to this key (random secrets, not NUT-13)
  pinned INTEGER NOT NULL DEFAULT 0, -- 1: pays out exactly the proofs reserved under op_id = id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outgoing_request ON outgoing(request_id);
CREATE INDEX IF NOT EXISTS outgoing_account ON outgoing(account_id);

-- The gateway's own eCash wallet.
CREATE TABLE IF NOT EXISTS proofs (
  secret TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  keyset_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  proof TEXT NOT NULL,
  state TEXT NOT NULL,              -- unspent | reserved | spent
  op_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proofs_state ON proofs(mint, unit, state);

-- NUT-13 deterministic secret counters per mint keyset.
CREATE TABLE IF NOT EXISTS counters (
  mint TEXT NOT NULL,
  keyset_id TEXT NOT NULL,
  next INTEGER NOT NULL,
  PRIMARY KEY (mint, keyset_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  status TEXT NOT NULL,             -- open | redeemed | revoked
  account_id TEXT,
  nut24_uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER
);

-- Funding a balance through the Forge mint: Lightning (NUT-04 bolt11), on-chain (NUT-30) or eCash
-- from another mint (received there, melted to pay a Forge bolt11 quote). Keys never appear here.
-- Beta waitlist: one contact (email or Nostr npub) and an optional note. No IP or other metadata.
CREATE TABLE IF NOT EXISTS beta_signups (
  id TEXT PRIMARY KEY,
  contact TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,               -- email | npub
  note TEXT,
  created_at INTEGER NOT NULL,
  invited_at INTEGER
);

CREATE TABLE IF NOT EXISTS fundings (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,             -- lightning | onchain | foreign
  account_id TEXT NOT NULL,
  unit TEXT NOT NULL,               -- balance unit = unit of the Forge mint quote
  mint TEXT NOT NULL,               -- Forge mint
  quote TEXT,                       -- Forge mint quote id
  request TEXT,                     -- bolt11 invoice or bitcoin address
  amount INTEGER,                   -- units to mint (lightning, foreign); NULL for onchain
  expires_at INTEGER,               -- ms; for onchain: end of the watch window
  lock_key TEXT,                    -- onchain: NUT-20 private key the quote is locked to
  state TEXT NOT NULL,              -- quoted | receiving | melting | pending | minting | done | expired | failed | refunded
  credited INTEGER NOT NULL DEFAULT 0,
  mint_op TEXT,                     -- JSON: in-flight mint (amount, outputs, counters); NUT-19 replay / NUT-09 restore
  next_check INTEGER NOT NULL DEFAULT 0,
  observed TEXT,                    -- JSON: last quote state seen at the mint
  f_mint TEXT,                      -- foreign: the token's mint
  f_unit TEXT,
  f_token_hash TEXT,
  f_amount INTEGER,                 -- foreign: token value after its input fees
  f_melt_quote TEXT,
  f_fee_max INTEGER,                -- foreign: most the foreign mint can keep (input fees + fee reserve)
  f_melt_op TEXT,                   -- JSON: in-flight melt (outputs, counters)
  f_attempts INTEGER NOT NULL DEFAULT 0,
  f_change_token TEXT,
  f_refund_token TEXT,
  f_lock_pubkey TEXT,               -- foreign: lock change and refund tokens to this key (NUT-11)
  f_unlisted INTEGER NOT NULL DEFAULT 0, -- foreign: 1 when the customer chose a mint that is not accepted (lower cap)
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS fundings_quote ON fundings(mint, quote);
CREATE INDEX IF NOT EXISTS fundings_due ON fundings(state, next_check);
CREATE INDEX IF NOT EXISTS fundings_account ON fundings(account_id);

-- Other mints the operator accepts from the admin page, on top of FORGE_FOREIGN_ALLOW. url is the
-- normalized key (mintKey in funding.ts); name is the mint's own /v1/info name at the time it was added.
CREATE TABLE IF NOT EXISTS operator_mints (
  url TEXT PRIMARY KEY,
  name TEXT,
  note TEXT,
  added_at INTEGER NOT NULL
);

-- Revenue exports from the admin page or CLI. The token itself is never stored here (the payout row
-- in outgoing holds it for re-delivery, as for every payout); this is the operator's history.
CREATE TABLE IF NOT EXISTS revenue_exports (
  id TEXT PRIMARY KEY,
  outgoing_id TEXT NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount INTEGER NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  lock_pubkey TEXT,
  source TEXT NOT NULL,             -- admin | cli
  token_hash TEXT,                  -- sha256 of the issued token, set once it is issued
  created_at INTEGER NOT NULL,
  delivered_at INTEGER              -- when the token was handed to the operator (shown once)
);

CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id);

-- Credit mint keysets and when the gateway first saw each one: a keyset is taken for
-- FORGE_CREDIT_KEYSET_DAYS from then (or until the mint's own final_expiry, if sooner).
CREATE TABLE IF NOT EXISTS credit_keysets (
  keyset_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL
);

-- The faucet's count of vouchers given out per UTC day. Only the count: no address, no time of a claim.
CREATE TABLE IF NOT EXISTS faucet_days (
  day TEXT PRIMARY KEY,
  claimed INTEGER NOT NULL DEFAULT 0
);

-- Metering log. No prompt or completion content, ever.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  payment TEXT NOT NULL,            -- balance | nut24
  unit TEXT NOT NULL,
  model TEXT NOT NULL,
  supplier TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  usage_source TEXT,                -- upstream | estimate | flat | tinfoil-metrics
  reserved_msub INTEGER,
  charged_msub INTEGER,
  paid_units INTEGER,
  change_units INTEGER,
  latency_ms INTEGER,
  lock_pubkey TEXT,                 -- nut24: X-Cashu-Pubkey, change is locked to it
  price_nusd INTEGER,               -- what the request was priced at, nano-USD (before unit conversion)
  supplier_cost_nusd INTEGER,       -- what it cost us, nano-USD
  cost_source TEXT,                 -- supplier (reported by the supplier) | catalog (usage x our catalog cost)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at);
CREATE INDEX IF NOT EXISTS requests_account ON requests(account_id);
`;

/** Columns added after the first release: CREATE TABLE IF NOT EXISTS does not add them to an existing file. */
const ADDED_COLUMNS: Array<[table: string, column: string, decl: string]> = [
  ['outgoing', 'lock_pubkey', 'TEXT'],
  ['outgoing', 'pinned', 'INTEGER NOT NULL DEFAULT 0'],
  ['fundings', 'f_lock_pubkey', 'TEXT'],
  ['requests', 'lock_pubkey', 'TEXT'],
  ['accounts', 'frozen_at', 'INTEGER'],
  ['requests', 'price_nusd', 'INTEGER'],
  ['requests', 'supplier_cost_nusd', 'INTEGER'],
  ['requests', 'cost_source', 'TEXT'],
  ['fundings', 'f_unlisted', 'INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'free', 'INTEGER NOT NULL DEFAULT 0'],
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  return db;
}

/** Runs fn inside BEGIN IMMEDIATE / COMMIT. fn must be synchronous. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function now(): number {
  return Date.now();
}
