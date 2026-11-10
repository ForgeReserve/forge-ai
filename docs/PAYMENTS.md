# Payments

This document describes how Forge AI takes, holds and returns eCash, and what happens when something fails halfway.

## Units and precision

A token's unit is `usd` (amounts are cents) or `sat`. Internally every amount is tracked in **msub**, a thousandth of the unit: milli-cents for `usd`, millisatoshi for `sat`. Prices are set in USD per million tokens and computed in nano-USD, then rounded up once into msub.

- Balances keep sub-cent precision. A request that costs 0.164 cents takes 164 msub from the balance; a hundred of them take 16.4 cents, not a dollar.
- NUT-24 payments are whole tokens, so a per-request charge rounds up to a whole cent or sat. The rest comes back as change.
- Withdrawals are whole units. A sub-unit remainder stays on the balance.
- Sat prices use the median BTC/USD rate from at least `FORGE_RATE_MIN_SOURCES` sources, cached for `FORGE_RATE_TTL_SECONDS`. If sources fail, the last good rate is used until it is `FORGE_RATE_MAX_STALE_SECONDS` old; after that, sat requests get HTTP 503 and USD keeps working. Within one request, reservation and settlement use the same rate.

## Accepting a token

Every token is checked before the mint is contacted: it must be `cashuB`, under `FORGE_MAX_TOKEN_BYTES`, from a trusted mint (URL compared after normalization), in an accepted unit, with proofs from that mint's keysets for that unit, and worth enough after input fees. Failures are HTTP 400 with `untrusted_mint`, `wrong_unit`, `insufficient_amount` or `invalid_token`, and the token is left untouched.

The token is then swapped at the mint into new proofs that only the gateway knows. A token the mint reports as spent is `token_spent` (400).

## Flow 1: NUT-24 per request

1. Client sends the request with no credentials.
2. The gateway prices the worst case: input tokens estimated as `body bytes / FORGE_BYTES_PER_TOKEN` (default 2, deliberately high) plus `max_tokens` at the output price. It answers `402` with `X-Cashu: creqA...`, a NUT-18 request with `a` (amount), `u` (unit), `m` (trusted mints), `s: true` and an id. Sat quotes carry `FORGE_SAT_PRICE_BUFFER` headroom.
3. Client retries with `X-Cashu: cashuB...` (and `X-Forge-Invite` while invite-only).
4. The gateway re-prices, checks the token covers it, swaps it, calls the supplier, and charges `ceil(actual cost)` capped at what was paid.
5. Change, if any, is issued as a new token from the same mint: in the `X-Cashu-Change` response header for non-streaming responses, in the final `event: forge` of a stream, and always at `GET /v1/change/{request_id}`.

NUT-24 does not specify change. Forge AI's choice (header, final stream event, re-fetch URL) is documented here and in the README. Upstream failures charge nothing and return everything.

## Flow 2: prepaid balance

1. `POST /v1/wallet/topup` with a token (and an invite for a new balance). The gateway returns a new `sk-forge-...` key, or credits the key in `Authorization`. A client may also choose its own key (`sk-forge-` plus 24 to 64 URL-safe characters) so that a lost response never loses the key.
2. Each request reserves its worst-case cost against the balance (`available = balance - active reservations`), runs, then settles: it charges the actual cost (capped at the reservation) and releases the rest. Settlement is idempotent.
3. `POST /v1/wallet/refund` debits whole units and issues a token. `GET /v1/wallet/refunds` re-delivers every token issued to the key.

Only a SHA-256 of each key is stored.

## Metering

- Plaintext requests: the gateway asks the supplier for usage (`stream_options.include_usage` on streams) and settles on it. If the client did not ask for usage, the usage-only chunk is removed from the stream it sees.
- No usage reported: input is estimated as `body bytes / 4` and output from the stream (at least one token per content chunk, or characters / 4 if larger). Non-streaming responses without usage are charged at `max_tokens`.
- Client disconnects mid-stream: the gateway aborts the upstream call and settles on what was produced so far, using upstream usage if it arrived, else the estimate above.
- Encrypted pass-through: see PRIVACY.md. Usage comes from Tinfoil's `X-Tinfoil-Usage-Metrics` header or trailer; without it the supplier's flat schedule (if configured) or the reservation is charged.
- `pricing: "flat"` suppliers always charge the flat schedule: a request-size bucket plus declared max output tokens.

## The gateway's wallet

Received proofs are stored in the `proofs` table with state `unspent`, `reserved` (selected for a payout in progress) or `spent`. The database is the wallet: back it up, and protect it like a hot wallet.

Payouts (change, refunds, revenue export) select proofs, and if no exact set exists, swap them into a send part and a kept part. All outputs are deterministic (NUT-13) from the gateway seed, with counters stored in SQLite.

`pnpm admin revenue:export` sweeps eCash that is not backing customer balances or owed payouts into a token you can redeem elsewhere.

## Crash safety

Two mechanisms make every mint operation recoverable:

- **NUT-19 replay.** The serialized swap request (inputs and blinded outputs) is stored before the swap is sent. Replaying the identical request to a mint with a response cache returns the same signatures.
- **NUT-09 restore.** Outputs are derived from the seed and a counter range that is persisted before the request leaves. If the replay is not cached, the gateway asks the mint to restore signatures for that counter range.

### Receiving (topup or NUT-24 payment)

| Step | State written | If the process dies here |
| - | - | - |
| 1 | `incoming` row, `status=new`, keyed by a hash of the token's secrets (UNIQUE) | Nothing reached the mint. The row is deleted at startup; the client's token is still valid |
| 2 | counters reserved, swap preview stored, `status=prepared` | Startup recovery replays or restores; see below |
| 3 | swap sent to the mint | Same as 2 |
| 4 | one transaction: proofs stored, `status=done`, balance credited (or request marked paid) | Done exactly once |

Recovery of a `prepared` row: (a) replay the stored swap; (b) else restore the counter range and, if signatures come back, finalize with them; (c) else, if the input proofs are still unspent, perform the swap; (d) else the token was spent elsewhere and the row is rejected. Finalizing runs in one transaction that checks the row is not already `done`, so a topup is credited once even if recovery and a client retry race.

A second submission of the same token never reaches the mint twice: it finds the row. For a topup to the same key it returns `replay: true` with the current balance; anything else is `token_spent`. When a topup's outcome is unknown (mint timeout), the gateway keeps the new balance and returns its key with HTTP 503 `topup_pending`; retrying with that key and the same token completes it.

A NUT-24 request interrupted after payment (process died during the upstream call) is marked aborted at startup, and its full payment is owed back as change at `GET /v1/change/{request_id}`.

### Paying out (change, refund, export)

| Step | State written | If the process dies here |
| - | - | - |
| 1 | balance debited and `outgoing` row `status=owed` in one transaction (refunds) | The payout is owed; it is issued on the next refund call or change fetch |
| 2 | proofs marked `reserved` for this row, `status=reserved` | Nothing reached the mint. Startup returns the proofs and sets `status=owed` |
| 3 | counters reserved, swap preview stored, `status=prepared` | Replay or restore, as for receiving. Restored proofs are split into send and keep by matching the stored send-output secrets |
| 4 | one transaction: inputs `spent`, kept proofs stored, token stored, `status=done` | Done; the token is re-deliverable |

If the mint rejects a payout because the gateway's own proofs are already spent (a restored backup, for example), those proofs are marked spent and the payout goes back to `owed`.

### Reservations

At startup every active reservation is released without charge (nothing is in flight in a fresh process), and a periodic sweep releases any older than `FORGE_STALE_RESERVATION_SECONDS`. A crash mid-request therefore costs the gateway the upstream bill for that request, never the user.

### What these tests prove

`test/e2e/recovery.e2e.test.ts` injects a fault after the mint swap and before the database write, restarts the gateway on the same database, and checks the balance is credited exactly once (through replay and through restore), that a retry is idempotent, that an interrupted refund is recovered by restore and the token redeems at the mint, and that an interrupted NUT-24 request owes full change.

## Known limits

- One gateway process per database. In-process locks prevent concurrent use of the same token or payout; SQLite transactions guard balances.
- The seed sits in the database unless `FORGE_WALLET_SEED` is set. Losing both the database and the seed loses the wallet.
- Payouts come from one mint. With several trusted mints, a refund needs one mint to hold enough.
- Sub-unit balance remainders cannot be withdrawn.
