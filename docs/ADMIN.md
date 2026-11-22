# Admin page

`/admin/` is the operator page: revenue and liabilities, revenue export as eCash, invites, balances (with freeze), fundings, Fedimint (federations, reconciliation, take out coverage), the request log and a read-only view of the settings. It is a plain page in `public/admin/` that talks to `/admin/api/*` (`src/admin-api.ts`). The CLI (`pnpm admin ...`) keeps working and shares the revenue code (`src/revenue.ts`).

## Access control

Money moves through this page, so it sits behind two independent locks:

1. **Caddy basic auth** on `/admin*` (production). The bcrypt hash comes from the environment at deploy time and is never committed. Caddy refuses to start without it, and `docker compose` stops with an error before starting anything.
2. **The gateway's admin token.** `FORGE_ADMIN_TOKEN_HASH` is the SHA-256 (hex) of a random token. Without it, everything under `/admin` answers 404. With it, every `/admin/api` request must send the token, or it gets 401. The page asks for the token once and keeps it in `sessionStorage` (that tab only). It sends it as `X-Forge-Admin-Token`, because the browser uses the `Authorization` header for Caddy's basic auth. `Authorization: Bearer <token>` is also accepted for scripts that reach the gateway without Caddy.

Also enforced by the gateway, whatever the proxy does:

- Changes (POST, DELETE) need a same-origin `Origin` header (`FORGE_ADMIN_ORIGIN` when set, else the request's `Host`) and a JSON body. A `Sec-Fetch-Site` other than `same-origin` is refused.
- No CORS: admin routes never send `Access-Control-*` headers.
- A separate rate limit (`FORGE_ADMIN_RATE_LIMIT_RPM`, default 120 per IP) and at most 10 failed token checks a minute per IP.
- `Cache-Control: no-store`, `X-Frame-Options: DENY` and a strict CSP (no inline script or style, nothing from other origins) on the page.
- Every action is logged as `admin_action` with its name, ids, counts and amounts. Tokens, invite codes and contacts are never logged.

## Deploy

On the droplet, in the repo directory:

```sh
# 1. Admin token: keep it in your password manager. Only its hash goes into .env.
TOKEN=$(openssl rand -base64 32 | tr -d '=+/')
echo "admin token: $TOKEN"
printf 'FORGE_ADMIN_TOKEN_HASH=%s\n' "$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)" >> .env
echo 'FORGE_ADMIN_ORIGIN=https://ai.forge-reserve.com' >> .env
unset TOKEN

# 2. Basic auth password: also in your password manager. Caddy prompts for it twice.
HASH=$(docker run --rm -it caddy:2.11.9@sha256:4e2425f6009577e7c651010f16679c28f7d12df3e7b1914f941a7a3370746b3c caddy hash-password | tr -d '\r')
echo 'FORGE_ADMIN_BASIC_AUTH_USER=forge' >> .env
# Single quotes: a bcrypt hash contains "$", which compose would otherwise expand.
printf "FORGE_ADMIN_BASIC_AUTH_HASH='%s'\n" "$HASH" >> .env
unset HASH

# 3. Restart both containers with the new Caddyfile and environment.
docker compose up -d --build
```

Then open `https://ai.forge-reserve.com/admin/`, sign in to the browser prompt (basic auth), and paste the admin token.

Checks after deploying:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://ai.forge-reserve.com/admin/                 # 401 (basic auth)
curl -s -o /dev/null -w '%{http_code}\n' -u forge:<password> https://ai.forge-reserve.com/admin/api/session   # 401 (no token)
curl -s -o /dev/null -w '%{http_code}\n' https://ai.forge-reserve.com/v1/models              # 200 (public API untouched)
```

To rotate the token, replace `FORGE_ADMIN_TOKEN_HASH` and run `docker compose up -d gateway`. To turn the admin page off, remove it: everything under `/admin` then answers 404.

## What each section does

- **Overview:** per unit: revenue collected (settled requests), sweepable, customer balances (and active reservations), owed payouts by purpose, and the wallet at trusted mints and at other mints (eCash held for other-mint fundings, never sweepable). Requests, tokens and revenue for today (UTC), 7 and 30 days by model, tier and supplier, from the `requests` table. Supplier cost is estimated as revenue / `FORGE_MARKUP`, since catalog prices include the markup. Health: the BTC/USD rate and its age, supplier keys (a supplier whose key env var is unset has no models), each mint's `GET /v1/info` (cached 30 s), open and due fundings, the shared quote-check budget and any 429 pause, unfinished exports.
- **Export:** the same computation as `pnpm admin revenue:export`: sweepable = eCash at trusted mints - owed payouts - customer balances (rounded up). Preview shows the exact amount, mint and lock; the export call must echo them back. The export becomes an owed payout and a `revenue_exports` row in one transaction that re-checks the amount, then goes through the normal payout machinery (NUT-19 replay, NUT-09 restore). An export interrupted by a crash counts as owed, is finished by startup recovery, and its token can be fetched once with **Finish**. A delivered token is never shown again. Optional P2PK lock to your key (`02.../03...` or `npub`): only that key can redeem it. History keeps time, unit, amount, lock and the token's SHA-256, never the token. (As for every payout, the `outgoing` row keeps the token for crash re-delivery.)
- **Invites:** create (codes shown once, stored hashed), list with status and usage, revoke. A revoked invite cannot open a balance or pay per request.
- **Event passes** (CLI only, below): not on this page yet. Balances opened with one show no invite id.
- **Balances:** id, unit, balance, reserved, created, last used, funding and request counts, search by balance or invite id. **Freeze** blocks all spending from the balance (`account_frozen`, 403); topups, fundings and refunds still work. Keys are not stored and never shown.
- **Fundings:** unfinished, failed and expired fundings with method, amount, state, error and age. Fundings from a mint the customer chose off the list carry an **unlisted mint** badge (`unlisted: true` in `GET /admin/api/fundings`). **Re-check now** advances one funding; for an unpaid quote it uses the same shared quote-check budget as the poller and answers 429 while the budget is used up or the mint has asked us to slow down.
- **Fedimint:** the federations the receiver holds notes of, what the gateway credited from them, whether the two agree, whether take out can be paid, and the top-ups that need the operator. Join, pause, resume and the holdings cap are here as well as in the CLI. Below, [Fedimint](#fedimint).
- **Requests:** the latest requests (id, time, model, tier, encrypted, tokens, charged, status, latency). No content is stored, so none is shown. `GET /admin/api/requests` and `GET /admin/api/costs` also give the input tokens the supplier served from its prompt cache (`cached_input_tokens`, charged at the cached input price on a model that has one; [PAYMENTS.md](PAYMENTS.md), Cached input).
- **Settings:** read-only apart from the mints added under Other mints: invite-only, units, markup, mints, funding caps and methods, rate limits, suppliers with key status, models with cost and sale prices.
- **Settings, Other mints:** the `FORGE_FOREIGN_POLICY`, the review rule (`FORGE_FOREIGN_MIN_REVIEWERS`, `FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT`, `FORGE_FOREIGN_MAX_DISCOVERED`, `FORGE_FOREIGN_DISCOVERY_TTL_MINUTES`), each relay's answer on the last refresh, when the served list was fetched, the accepted mints with source and reviewer count, and the candidates that were not accepted with the reason (too few reviewers, failed probe, over the cap). **Refresh** reads the relays and probes the candidates now (`POST /admin/api/mints/discovery/refresh`, at most once a minute, logged as `mint_discovery_refresh`); if no relay answers, the previous list stays. `GET /admin/api/mints/discovery` returns the same data. The rejected list lives in memory and is empty after a restart until the next refresh.
- **Settings, Other mints, Add mint:** enter a mint URL (and an optional note) and **Add**. The gateway refuses Forge's own mints (`own_mint`) and denied mints (`mint_denied`), runs the URL safety check, then probes the mint live (info, an active keyset in a Forge unit, NUT-05 bolt11 melt). A pass stores it in `operator_mints` with its `/v1/info` name; a failure answers 400 `mint_check_failed` with the reason, and the card offers **Add anyway**, which resends with `force: true` (the response carries `forced: true`). **Remove** on a row added here takes it off the list; env `FORGE_FOREIGN_ALLOW` entries are changed in the environment. The card also shows whether customers may use unlisted mints and the cap.
  - `POST /admin/api/mints/allowed {url, note?, force?}` answers `{mint: {url, name, note, added_at}, probe: {ok, reason?, units?, name?}, forced, added, view}`, logged as `mint_allow_add`.
  - `DELETE /admin/api/mints/allowed?url=...` or `POST /admin/api/mints/allowed/remove {url}` answers `{ok, view}` (404 when the mint was not added here), logged as `mint_allow_remove`.
  - `GET /admin/api/mints/discovery` adds `operator_mints` and `unlisted: {enabled, max: {sat, usd}}`.

## Fedimint

The Fedimint section (`#fedimint`) reads `GET /admin/api/fedimint` (`src/fedimint-admin.ts`). With `FORGE_FEDIMINT_URL` unset it answers `{"enabled": false}`, the section says Fedimint is off, and every Fedimint action answers `409 fedimint_off`. The receiver's token, invite codes and notes are never shown or logged; the page asks the receiver once per load (`GET /federations`, its balances included).

**Federations.** Each federation in the `federations` table: name, id, the notes it takes, state (active or paused), whether the receiver still lists it, the receiver's balance there, and the gateway's own record of its top-ups: the face value of those credited, what was credited (net of the federation's fee) and the fee (face value less credited), the caps in force (per payment, `FORGE_FEDIMINT_MAX_SAT` or its own lower one; holdings, `FORGE_FEDIMINT_FEDERATION_CAP_SAT` or its own) with the room left under the holdings cap, the top-ups by state (`done`, `prepared` shown as on their way, `stuck`, `rejected` shown as refused) and when the last one came in.

**Actions,** each behind the admin token, the same-origin check and a JSON body, and each logged as `admin_action`:

| Action | Route | Logged as |
| - | - | - |
| Join by invite, with optional caps | `POST /admin/api/fedimint/federations {invite, max_sat?, cap_sat?}` | `fedimint_join` with the federation id, whether it was new, and the caps; never the invite |
| Pause, Resume | `POST /admin/api/fedimint/federations/{id}/pause`, `.../resume` | `fedimint_pause`, `fedimint_resume`, with the state before |
| Holdings cap | `POST /admin/api/fedimint/federations/{id}/cap {cap_sat}`, a whole number of sat, or `null` for the gateway default | `fedimint_cap`, with the cap before |
| Check now | `POST /admin/api/fedimint/receipts/{notes_id}/check` | `fedimint_receipt_check`, with the state before and after and the receiver's state |
| Resolve | `POST /admin/api/fedimint/receipts/{notes_id}/resolve {note}` | `fedimint_receipt_resolve`, with the notes id; the note stays on the row and out of the log |

Join refuses an empty invite or one with spaces in it (`400`), passes on the receiver's `bad_invite` (`422`) and a federation that does not answer (`502 federation_unreachable`), and answers `503 fedimint_unavailable` while the receiver is down. Joining one already joined refreshes its name and modules and keeps its state and caps unless new ones are given, as `fedimint:join` does.

**Reconciliation, per federation.** The receiver credits a top-up `net_msat` of its record (the face value less the federation's fee) and its balance rises by exactly that, so its balance should equal what the gateway credited from that federation, less what left the receiver: nothing yet, since it cannot send. The fee is shown as face value less credited, and is never part of the difference. The readings:

| Reading | When | Flag |
| - | - | - |
| Agrees | The balance equals credited less sent, to the msat | no |
| Agrees once top-ups finish | The balance is higher by no more than the face value of top-ups on their way (`prepared`: the receiver may hold them already), stuck ones (if their value is ever issued it lands here) and notes someone else gave the receiver first (held, never credited here) | no |
| Receiver holds less | The balance is lower than credited less sent. Fees cannot explain it: they were out of the notes before the credit. Balances funded by these notes are not fully backed | yes |
| Receiver holds more | Higher than those top-ups explain: notes given to the receiver outside the gateway, or a credit the gateway missed | yes |
| Unknown | The receiver did not answer | no |

Any flag puts a line at the top of the section. Checked end to end against the real receiver and a real federation: after real top-ups with real fees, the reading is Agrees with a difference of 0 msat.

**Take out coverage.** A take out (`POST /v1/wallet/refund`) pays Cashu from the trusted mint holding the most sat and answers `503 wallet_insufficient` when that mint cannot cover it; notes at the receiver never pay one. The card compares what every paid sat balance can take out (each balance's whole sat, summed) with the Cashu sat at the trusted mints, less payouts owed there, and warns when:

- the Cashu sat is less than all the sat balances could take out (the last take outs would fail);
- the largest single sat balance is more than any one mint can pay;
- Cashu and the notes at the receiver together are less than the sat balances (counted in msat).

**Rebalance, the suggestion.** The amount a rebalance must bring into Cashu for both of the first two to clear: the larger of the shortfall and the largest balance's excess over the best mint. It is taken from the federations holding the most first, each up to its whole sat, to the Forge mint (the funding mint, `FORGE_FUND_MINT`); Lightning fees come on top, out of the notes. If the receiver holds too little, the card says how much would still be missing.

**Top-ups that need you.** Every top-up `stuck` or `prepared`, newest first, with its notes id, federation, face value, state, the receiver's reason and the balance it is for (as Fundings shows it). `GET /admin/api/fedimint/receipts?state=attention|stuck|prepared|done|rejected|all` returns the same rows; none carries the notes.

- **Check now** does for one top-up what the sweep does every 30 seconds: for one on its way, asks the receiver and credits the `done` record once. For a stuck one it asks the receiver for its record and credits it once only if that record is now `done` under this balance's key, moving the row to `done` in the same transaction; otherwise it stays stuck. It answers the row's state after, and the receiver's state and failure (or that it did not answer).
- **Resolve** closes a stuck top-up for good, once the operator has settled it with the person by hand (refunded in Cashu, say). It asks the receiver first and goes ahead only when the receiver reports the receive `failed`: a record that is `done` answers `409 receiver_done` (Check now credits it), one still `pending` `409 receiver_pending`, no record `409 receiver_no_record`, and no answer `503 fedimint_unavailable`. The row becomes `rejected` with the error `resolved by the operator (<failure>): <note>`, nothing is ever credited for it, and the same notes sent again answer `token_spent`. Only a `stuck` top-up can be resolved (`409 not_stuck`).

### Rebalance: the design

Moving value from the receiver into Cashu needs the receiver to pay a Lightning invoice from its Fedimint balance, through the federation's Lightning gateway. The receiver has no such route yet, so nothing here moves money. The intended design:

1. The gateway asks the Forge mint for a mint quote (NUT-04, bolt11) for the amount, as a Lightning funding does, owned by the operator and by no balance, and writes a `fedimint_moves` row (federation, amount, quote id, state `planned`) before anything is paid.
2. It asks the receiver to pay the invoice: a new route, `POST /federations/{id}/pay {invoice, max_fee_msat, key}`, idempotent on `key` (the move's id) and recorded on disk before the payment starts, as `/receive` is. It answers a record that is `pending`, `paid` (with the fee) or `failed`.
3. Once the quote is `PAID` at the mint, the gateway mints the proofs into its own wallet with the NUT-13 counters it reserved, as a funding does (NUT-09 restore after a crash), and marks the move `done`.
4. Reconciliation then subtracts each paid move, amount plus fee, as "sent out"; a move that is `pending` at the receiver counts as on its way.
5. A move is started only from the admin page with an exact confirm (as Export is), never more than the suggestion, and is logged as `admin_action`.

## Event passes

One code for a room full of people (a hackathon, a talk): each use opens one balance at 0 for the free models, up to a cap, until it expires. It goes behind one QR code, `https://ai.forge-reserve.com/j#<pass>` ([ANDROID.md](ANDROID.md), Event links).

```sh
pnpm admin passes:create --uses 500 --expires 2026-12-05 --label hrf   # prints the code and the link once
pnpm admin passes:list                                                  # uses so far, cap, expiry, status
pnpm admin passes:revoke <pass-id|code>
```

- `--expires` takes a date (that day's start in UTC: `2026-12-05` ends the pass at 2026-12-05 00:00 UTC) or a full ISO time (`2026-12-05T12:00Z`). `--site URL` changes the link's site (default `https://ai.forge-reserve.com`).
- Only a SHA-256 of the code is stored (table `passes`), as for invites. The code and link are shown once.
- A pass works only on `POST /v1/wallet/open`. It never stands in for an invite on a funded top-up (`/v1/wallet/topup`, `/v1/wallet/fund/*`) or a NUT-24 payment (`X-Forge-Invite`): those answer `invite_required` as for any wrong code. A balance it opened takes funds later with its key, like any balance.
- Refusals (403): `pass_used_up` at the cap, `pass_expired` from the expiry on, `invite_invalid` once revoked. A key the gateway already knows is answered as it is and counts no use.
- Each balance carries the pass's id (`accounts.pass_id`). If such a balance is ever given back unused (`releaseIfEmpty`), its use is given back to the pass.

