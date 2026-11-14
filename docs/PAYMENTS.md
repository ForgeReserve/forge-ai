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
- A non-streaming response whose body fails to arrive after `200` headers is an upstream failure, settled before the error is returned: `502`, nothing charged, the reservation released and, for NUT-24, the full change in `X-Cashu-Change` and at `GET /v1/change/{request_id}` at once.
- Client disconnects mid-stream: the gateway aborts the upstream call and settles on what was produced so far, using upstream usage if it arrived, else the estimate above.
- Encrypted pass-through: see PRIVACY.md. Usage comes from Tinfoil's `X-Tinfoil-Usage-Metrics` header or trailer; without it the supplier's flat schedule (if configured) or the reservation is charged.
- `pricing: "flat"` suppliers always charge the flat schedule: a request-size bucket plus declared max output tokens.

## Flow 3: funding a balance through the Forge mint

For users who do not hold Forge eCash yet. In every method the gateway mints Forge eCash into its own wallet with deterministic (NUT-13) outputs and credits the balance with exactly the minted amount, in the same SQLite transaction that stores the proofs. A new balance needs an invite while invite-only; it is created (and the invite bound to it) when the first quote is made, and released again, with the invite reopened, if that funding expires or fails before anything is credited.

### Lightning

1. `POST /v1/wallet/fund/lightning {amount, unit}`: the gateway asks the Forge mint for a NUT-04 bolt11 mint quote in the balance unit, stores it (`fundings` row, `state=pending`) and only then returns the invoice.
2. A poller (every 3 s for the first 10 minutes, then every 30 s) and every status request ask the mint for the quote state.
3. On `PAID`: prepare the mint with deterministic outputs, store the outputs and the counter range (`state=minting`), call `POST /v1/mint/bolt11`.
4. One transaction: proofs stored, balance credited `amount`, `state=done`.
5. Unpaid a minute past the quote's expiry: `state=expired`.

### On-chain (NUT-30)

The Forge mint advertises `onchain` (sat) in NUT-04 on its Nutshell on-chain branch. The shapes used here come from that branch's source (`cashu/payment/onchain.py`, `cashu/core/models/mint_quote.py`): `POST /v1/mint/quote/onchain {unit, pubkey}` returns a reusable address with `amount_paid` and `amount_issued` and no expiry; `POST /v1/mint/onchain {quote, outputs, signature}` mints. The quote is locked (NUT-20) to a key the gateway generates per funding, so only the gateway can mint it.

1. `POST /v1/wallet/fund/onchain`: quote created and stored, address returned.
2. The poller checks the quote every minute. Whenever `amount_paid > amount_issued`, it mints the difference (same steps 3 and 4 as Lightning, signed for the quote key) and credits it. The address stays watched for `FORGE_ONCHAIN_WATCH_DAYS`, so later deposits are credited too.
3. The mint decides when a deposit counts as paid (Forge: after its deposit wallet sees the configured confirmations). `FORGE_ONCHAIN_CONFIRMATIONS` is only what users are told. With `FORGE_ESPLORA_URL` set the status also shows unconfirmed and confirmed amounts seen on chain.

`FORGE_ONCHAIN_ENABLED` is `false` by default: the flow is tested against a mock that follows those shapes (`test/e2e/onchain-mock.ts`), not against the live mint. Turn it on after one small live deposit.

### eCash from another mint

1. `POST /v1/wallet/fund/foreign/quote {token, unit}`. Policy first: foreign funding enabled, the mint is not one of ours (`use_topup`), is accepted by `FORGE_FOREIGN_POLICY` (`discovered`: the operator list, meaning `FORGE_FOREIGN_ALLOW` and mints added on the admin page, or the NIP-87 discovered list; `allowlist`: the operator list only; `any`: every mint, or `FORGE_FOREIGN_ALLOW` when set) and is not in `FORGE_FOREIGN_DENY` (`mint_not_allowed`, with a pointer to `GET /v1/wallet/fund/mints`), is `https` and resolves to public addresses only (SSRF guard), and the token is at most `FORGE_FOREIGN_MAX_SAT` / `_USD`. Then pricing: the gateway creates a Forge bolt11 mint quote for a credit and a melt quote for that invoice at the token's mint, shrinking the credit until the melt amount, its fee reserve and both input fees fit the token. Nothing is spent. The response shows the token amount, the exact credit and the most the token's mint can keep (`fee_max`).
   - **Unlisted mints.** Under `discovered` and `allowlist` with `FORGE_FOREIGN_UNLISTED=true`, a mint that is not accepted (and not denied, and not Forge's) passes the URL safety check and then answers 409 `mint_unlisted` with `{unlisted: {mint, max: {sat, usd}}}`. The same request with `accept_unlisted: true` goes ahead once the mint passes the live probe discovery uses (cached 10 minutes, a failure 1 minute; a failure answers `mint_check_failed`). The token is then capped at `FORGE_FOREIGN_UNLISTED_MAX_SAT` / `_USD` (cents) as well as the other-mint cap (`amount_too_large`), and the funding row records `f_unlisted = 1`. With `FORGE_FOREIGN_UNLISTED=false` such a mint gets `mint_not_allowed`. Policy `any` never asks. `GET /v1/wallet/fund/methods` shows `foreign.unlisted: {enabled, max: {sat, usd}}`.
2. `POST /v1/wallet/fund/foreign/confirm {id, token}`: before any mint is loaded or contacted, the token must name the quoted mint (normalised) and unit; otherwise 400 `token_mismatch` and the funding stays `quoted`. It must then be the quoted token by the hash of its secrets (also `token_mismatch`). It is received at its own mint through the normal receive path (`incoming` row, NUT-19/NUT-09 recoverable). The new proofs are stored `reserved` for this funding and never used for payouts.
   - **Every contact with another mint is vetted.** The wallet runs the URL safety check (https, public addresses only, unless `FORGE_FOREIGN_ALLOW_INSECURE`) each time it loads the wallet of a mint outside `FORGE_TRUSTED_MINTS`, cached or not: quote, confirm, melt, refunds, change and recovery. A refusal answers `mint_not_allowed`; a step that already holds the eCash stays where it is and is retried by the poller. Confirm then answers 200 with the in-progress state (`melting`) for the client to poll, never an error, since the token is already taken. No Cashu request follows a redirect (cashu-ts `redirect: "error"` for the whole process, set in `src/cashu/wallet.ts`), so discovery, keysets, keys, swap, melt and the checks only ever reach the vetted address.
3. Melt: deterministic NUT-08 blank outputs and the counter range are stored before `POST /v1/melt/bolt11`. If the melt quote expired meanwhile, a new one is made for the same invoice; if it no longer fits, the held eCash goes back to the user as a token from their mint (`refund_token`, `state=refunded`).
4. Melt paid: the unused fee reserve comes back as change signatures, which are returned to the user as `change_token`. The funding then continues as a Lightning funding whose invoice is already paid: mint at Forge, credit `credit`.

The balance unit and the token unit may differ (a sat token can fund a usd balance); the quote uses the mint's own conversion through the Forge invoice.

### Crash safety

| State | What is stored | If the process dies here |
| - | - | - |
| `pending` | quote id and invoice/address, before the client sees them | The poller resumes the quote on restart |
| `minting` | outputs (serialized) and counter range, before `POST /v1/mint/...` | Replay the identical mint (NUT-19, cached for bolt11 at Forge); else restore the counter range (NUT-09); else, if the quote is still mintable, mint with the same outputs. Credited once |
| `quoted` | the plan, not the token | Nothing spent; the client keeps the token. Expires with the quotes |
| `receiving` | the `incoming` row | `prepared`: replayed or restored now or at startup; `new`: back to `quoted`; rejected: `failed` |
| `melting` | blank outputs and counter range, before `POST /v1/melt/bolt11` | Melt quote `PAID`: change from the quote's signatures or from restore, then mint. `UNPAID` with inputs unspent: retry once, then refund. `PENDING`: wait |

Finalizing a mint runs in one transaction that checks the funding is still `minting` with the same stored outputs, so two pollers, a status request and a restart can race and the balance is credited once. The e2e suite injects faults after the mint, after the foreign swap and after the melt, restarts on the same database (with and without NUT-19 replay) and checks the credit is exact and single.

### Not yet: Fedimint

Fedimint notes need a Fedimint client to reissue them in their federation and pay out to Lightning. The cashucard.org fund kit does this with `fedimint-receiver`, a separate Rust service. Forge AI does not run one, so Fedimint is not offered. Adding it would mean deploying that receiver beside the gateway and treating it like a foreign mint: reissue, pay the Forge bolt11 quote from the federation, mint and credit.

## The gateway's wallet

Received proofs are stored in the `proofs` table with state `unspent`, `reserved` (selected for a payout in progress) or `spent`. The database is the wallet: back it up, and protect it like a hot wallet.

Payouts (change, refunds, revenue export) select proofs, and if no exact set exists, swap them into a send part and a kept part. All outputs are deterministic (NUT-13) from the gateway seed, with counters stored in SQLite, except the send part of a locked payout (below). Kept outputs are always deterministic.

### Locked payouts (NUT-11 P2PK)

A deterministic token can be re-derived from the gateway seed, so until the customer redeems it the gateway could spend it. A customer who gives a public key (`X-Cashu-Pubkey` on a NUT-24 request, `pubkey` on a refund or other-mint funding) gets a token whose send outputs are P2PK-locked to that key: secret `["P2PK", {nonce, data: <key>}]`, plain lock, no locktime and no refund keys (a refund key held by the gateway would bring back exactly the spending power the lock removes). The mint refuses to spend those proofs without a signature from the key, so the gateway cannot spend them at all.

- The key is stored with the payout (`outgoing.lock_pubkey`, and `requests.lock_pubkey` / `fundings.f_lock_pubkey` so change owed after a crash is still locked). It is not logged.
- A locked payout always swaps, even when an exact set of the gateway's proofs exists.
- Other-mint change and refunds are proofs at the token's mint, not the gateway's. With a key, those proofs are moved to a "pinned" payout (`outgoing.pinned = 1`) that swaps exactly them into locked outputs at that mint. The token's mint charges its input fee for that swap, so the locked token is worth slightly less than the unlocked one would be. If the fee would take the whole value, the proofs are handed over unlocked.
- Locked secrets are random, so NUT-13 restore by counter cannot find them. Recovery uses the stored preview instead (next section).

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

### Locked payouts: recovery

The full swap preview, including the locked outputs' secrets and blinding factors, is stored (`status=prepared`) before the swap is sent. Recovery of a locked row:

1. **Replay** the stored request (NUT-19). The Forge mint and the test mints (Nutshell 0.22.1) cache `POST /v1/swap` for 7 days (`nuts.19.ttl = 604800`), so the same signatures come back and the stored secrets turn them into the same locked proofs.
2. If the mint refuses the replay, **restore by blinded message** (NUT-09): the stored blinded messages of every output are sent to `/v1/restore`. The mint returns the signatures it made for exactly those outputs. All signed: build the proofs from the stored secrets, finalize once. None signed: the swap never happened with these outputs, so the row is re-owed as an unlocked payout would be.
3. If neither works (no cache entry and restore refused or unsupported, or a partial answer), the outcome is **unknown**. The row stays `prepared`, counts as owed in `revenue:show`, gets `error = "outcome unknown: ..."` and the API answers `503 payout_unknown`. It is never re-owed and never paid a second time; every later issue attempt and every startup tries steps 1 and 2 again. If the mint never answers, an operator resolves it by hand from the stored preview.

Restoring by counter range (the unlocked path) is never used for a locked row: it would find only the kept outputs and hand over an empty token.

### Reservations

The gateway tracks in memory which reservations belong to requests it is still serving. A request owns its reservation from `reserve` until it settles; an error that escapes the request before settlement gives it up.

- At startup every active reservation is released without charge: a fresh process serves nothing, so each one is abandoned. A crash mid-request therefore costs the gateway the upstream bill for that request, never the user.
- A periodic sweep (every minute) releases, without charge, active reservations older than `FORGE_STALE_RESERVATION_SECONDS` that no request owns, and logs `stale_reservations_released`. A request still being served, such as a long stream, keeps its reservation however old it is.
- If a request settles after its reservation was released anyway, it is still charged what it used (capped at the reservation), up to what the balance covers after other active reservations. Any part the balance cannot cover is recorded as `shortfall_msub` on the reservation and logged as `settled_after_release`. It is never a silent zero charge.

`test/unit/ledger.test.ts` and `test/e2e/stale-reservation.e2e.test.ts` cover the sweep against a live stream, a late charge after release, the shortfall cap and abandoned-request cleanup.

### What these tests prove

`test/e2e/recovery.e2e.test.ts` injects a fault after the mint swap and before the database write, restarts the gateway on the same database, and checks the balance is credited exactly once (through replay and through restore), that a retry is idempotent, that an interrupted refund is recovered by restore and the token redeems at the mint, and that an interrupted NUT-24 request owes full change.

`test/e2e/p2pk.e2e.test.ts` checks locked NUT-24 change, refunds and other-mint change and refunds: the token's proofs all carry the key, a swap at the mint without a witness is refused, a plain wallet and the gateway's own wallet cannot redeem it, and the key holder receives exactly the amount. It crashes a locked refund after the swap and recovers it by replay, by restore of the stored blinded messages, and with both disabled (row stays owed, no second payout) followed by a restart that settles it once.

## Known limits

- One gateway process per database. In-process locks prevent concurrent use of the same token or payout; SQLite transactions guard balances.
- The seed sits in the database unless `FORGE_WALLET_SEED` is set. Losing both the database and the seed loses the wallet.
- Payouts come from one mint. With several trusted mints, a refund needs one mint to hold enough.
- Sub-unit balance remainders cannot be withdrawn.
- Other-mint funding trusts the token's mint for as long as the melt takes. A mint that takes the token and never pays leaves the funding in `melting`; the token's value is then lost to the user, as it would be with any wallet melting at that mint.
- A foreign mint's address is checked against private ranges when quoted, but DNS can change between that check and later requests (rebinding). The gateway sends such a mint only Cashu API calls.
- An on-chain address that receives a deposit after its watch window is not credited automatically. The quote stays at the mint; an operator can extend `expires_at` in `fundings` and set `state` back to `pending`.

## Checking quotes without tripping the mint's rate limit

Every funding's quote checks come from the gateway's one IP, and Nutshell allows 20 transaction requests a minute per IP. So:

- An unpaid Lightning quote is checked every 5 s for its first 2 minutes, then every 15 s to 10 minutes, every minute to an hour, and every 5 minutes after that.
- The status endpoint advances a pending quote only when it is due, however fast a browser polls.
- All quote checks share a budget of `FORGE_MINT_QUOTE_CHECKS_PER_MIN` (default 12).
- A 429 from the mint pauses every quote check for 60 s.
