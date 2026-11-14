# Forge AI

Forge AI is an OpenAI-compatible AI gateway that charges per request in Cashu eCash. Point any OpenAI client at it, pay with eCash from the Forge mint, and it forwards the request to a pluggable upstream supplier. Licensed MIT.

Two ways to pay:

- **Per request (NUT-24).** Call the API with no credentials. You get `HTTP 402` with an `X-Cashu` header holding a NUT-18 payment request. Retry with `X-Cashu: cashuB...`. The gateway runs the request, charges the actual cost, and returns the unused value as eCash change. No account, no key.
- **Prepaid balance.** Send an eCash token to `POST /v1/wallet/topup` and get an `sk-forge-...` key. Use it as a normal bearer key. Withdraw the remainder as eCash at any time.

A balance can also be funded without holding Forge eCash first: pay a Lightning invoice, send bitcoin on-chain (NUT-30, off by default), or hand over eCash from another Cashu mint, which the gateway melts into a Forge Lightning quote. The gateway mints Forge eCash for itself and credits the exact minted amount. See [Funding](#funding-a-balance).

## How it differs from Routstr

[Routstr](https://github.com/routstr/routstr-core) is the established Cashu-paid AI proxy. Forge AI makes different choices:

| | Forge AI | Routstr (routstr-core, checked 2026-11-09) |
| - | - | - |
| License | MIT | GPL-3.0 |
| Units | USD eCash (`usd`, cents) and bitcoin eCash (`sat`). USD balances stay in USD, metered in milli-cents | Balances and 402 amounts in msat |
| Prices | Set in USD per million tokens; sat prices derive from a median BTC/USD rate | USD upstream prices converted to sats with an exchange buffer |
| Per-request payment | NUT-24: 402 with a NUT-18 `creqA` request, `X-Cashu` token, change returned | `X-Cashu` token header; its 402 body is a custom JSON error format |
| Private inference | Encrypted pass-through to Tinfoil enclaves (EHBP): the gateway forwards ciphertext and still meters it | Not in scope of this comparison |
| Suppliers | Small adapter interface (`src/suppliers/`), config-driven model catalog | Upstream providers configured in a dashboard |

The Routstr column comes from its README and docs on the date shown; check upstream for changes.

## Quickstart (local, with a test mint)

Requirements: Node 22.18+ (24 recommended), pnpm, Docker.

```sh
pnpm install
pnpm mint:up                                  # two local Nutshell mints with FakeWallet (usd + sat)
export FORGE_TRUSTED_MINTS=http://127.0.0.1:3338 FORGE_MODELS_FILE=config/models.dev.json FORGE_DB_PATH=data/dev.db
pnpm start &                                  # http://localhost:8787
pnpm admin invites:create                     # prints an invite code
pnpm test-token 50 usd                        # prints a test eCash token worth 50 cents
open http://localhost:8787                    # chat page: paste the token and the invite
```

The agent demo pays for a request end to end over NUT-24:

```sh
FORGE_URL=http://localhost:8787 FORGE_INVITE=inv-... DEMO_FAKE_MINT=1 pnpm demo:agent "What is eCash?"
```

`config/models.dev.json` adds an in-process mock supplier (`mock-echo`, `mock-slow`) so everything works without upstream keys. Set `TOKENFACTORY_API_KEY` and `TINFOIL_API_KEY` to use the real suppliers.

## Production

`docker-compose.yml` runs the gateway behind Caddy with automatic HTTPS. Edit the placeholder domain `ai.forge-reserve.com` in `Caddyfile`, copy `.env.example` to `.env`, then:

```sh
docker compose up -d
docker compose exec gateway node src/admin.ts invites:create --count 10
```

`docker compose` needs `FORGE_ADMIN_BASIC_AUTH_HASH` in `.env` for the admin page's basic auth; see [docs/ADMIN.md](docs/ADMIN.md).

The SQLite database in the `forge-data` volume is the gateway's eCash wallet. Back it up. See [docs/PAYMENTS.md](docs/PAYMENTS.md).

## Configuration

Environment variables, validated with zod at startup (`src/config.ts`):

| Variable | Default | Meaning |
| - | - | - |
| `FORGE_TRUSTED_MINTS` | `https://forge.flashapp.me` | Comma-separated mints whose eCash is accepted. Tokens from other mints get HTTP 400 |
| `FORGE_MINT_ALIASES` | `https://mint.forge-reserve.com=https://forge.flashapp.me` | Other addresses of the same mint, as comma-separated `alias=main` pairs. Tokens under an alias are accepted and stored under the main address, so the wallet keeps one counter per keyset |
| `FORGE_UNITS` | `usd,sat` | Accepted units |
| `FORGE_DEFAULT_UNIT` | `usd` | Unit of a 402 request unless the client sends `X-Forge-Unit` |
| `FORGE_INVITE_ONLY` | `true` | Require invites for topups and NUT-24 requests |
| `FORGE_MARKUP` | `1.25` | Multiplier on supplier cost |
| `FORGE_MODELS_FILE` | `config/models.json` | Supplier and model catalog |
| `FORGE_DB_PATH` | `data/forge.db` | SQLite ledger and wallet |
| `FORGE_WALLET_SEED` | generated, stored in DB | 64-byte hex seed for deterministic eCash outputs (NUT-13) |
| `FORGE_RATE_SOURCES` | `coinbase,kraken,bitstamp` | BTC/USD sources (also `coingecko`); add one by implementing `RateSource` in `src/rates.ts` |
| `FORGE_RATE_MIN_SOURCES` | `2` | Sources that must answer for a rate to be used |
| `FORGE_RATE_TTL_SECONDS` / `FORGE_RATE_MAX_STALE_SECONDS` | `60` / `900` | Cache time; after max staleness sat pricing returns 503 instead of guessing |
| `FORGE_SAT_PRICE_BUFFER` | `1.02` | Headroom on sat 402 amounts so a rate move between quote and payment does not reject the token |
| `FORGE_BYTES_PER_TOKEN` | `2` | Conservative bytes per input token used to size the reservation |
| `FORGE_RATE_LIMIT_RPM` | `60` | Requests per minute per key or IP |
| `FORGE_MAX_BODY_BYTES` | `1000000` | Request size limit |
| `FORGE_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting (set behind Caddy) |
| `FORGE_UPSTREAM_TIMEOUT_MS` / `FORGE_UPSTREAM_RETRIES` | `180000` / `2` | Time to upstream response headers (a timeout is final); retries on connection errors, 408, 429 and 5xx |
| `FORGE_FUND_MINT` | first trusted mint | Mint used for Lightning, on-chain and other-mint funding |
| `FORGE_LIGHTNING_ENABLED` | `true` | Lightning funding (NUT-04 bolt11 quotes) |
| `FORGE_FUND_MAX_SAT` / `FORGE_FUND_MAX_USD` | `1000000` / `50000` | Largest Lightning funding, in sat / cents (the mint's own limit also applies) |
| `FORGE_ONCHAIN_ENABLED` | `false` | On-chain funding (NUT-30). Off until tested against the live mint |
| `FORGE_ONCHAIN_CONFIRMATIONS` | `3` | Confirmations shown to users; the mint decides when a deposit is paid |
| `FORGE_ONCHAIN_WATCH_DAYS` | `30` | How long an on-chain address is watched for deposits |
| `FORGE_ESPLORA_URL` | unset | Optional Esplora API used to show unconfirmed deposits. Unset: the gateway asks only the mint |
| `FORGE_FOREIGN_ENABLED` | `true` | Accept eCash from other mints (melted into a Forge Lightning quote) |
| `FORGE_FOREIGN_POLICY` | `discovered` | Which other mints are accepted. `discovered`: the operator list (`FORGE_FOREIGN_ALLOW` and mints added on the admin page) plus mints found through NIP-87 reviews (below). `allowlist`: the operator list only. `any`: every https mint, limited to `FORGE_FOREIGN_ALLOW` when that is set. `FORGE_FOREIGN_DENY` always wins |
| `FORGE_FOREIGN_ALLOW` / `FORGE_FOREIGN_DENY` | empty | Operator list of accepted mints (the admin page can add more), and mints never accepted |
| `FORGE_FOREIGN_UNLISTED` | `true` | Under `discovered` and `allowlist`, let a customer fund from a mint that is not accepted after a warning (`mint_unlisted`, then `accept_unlisted: true`), with the lower cap below. `false`: such mints get `mint_not_allowed` |
| `FORGE_FOREIGN_UNLISTED_MAX_SAT` / `FORGE_FOREIGN_UNLISTED_MAX_USD` | `5000` / `500` | Largest token from an unlisted mint, in sat / cents. The other-mint cap still applies when lower |
| `FORGE_FOREIGN_MIN_REVIEWERS` | `2` | Distinct verified NIP-87 reviewers a discovered mint needs |
| `FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT` | `false` | Also require the mint's own verified kind 38172 announcement (the Cashu Card provisioner's rule; few mints publish one today) |
| `FORGE_FOREIGN_DISCOVERY_RELAYS` | `wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net` | Nostr relays read for mint announcements (kind 38172) and reviews (kind 38000). Empty: no discovery |
| `FORGE_FOREIGN_DISCOVERY_TTL_MINUTES` | `60` | How long a discovered list is served before a background refresh (a failed refresh retries after a minute) |
| `FORGE_FOREIGN_MAX_DISCOVERED` | `25` | Most discovered mints accepted at once, best reviewed first |
| `FORGE_FOREIGN_MAX_SAT` / `FORGE_FOREIGN_MAX_USD` | `100000` / `5000` | Largest token from another mint, in sat / cents |
| `FORGE_FUND_MAX_PENDING` | `5` | Unfinished fundings per balance |
| `FORGE_ADMIN_TOKEN_HASH` | unset | SHA-256 (hex) of the admin token. Unset: `/admin` answers 404. See [docs/ADMIN.md](docs/ADMIN.md) |
| `FORGE_ADMIN_ORIGIN` | request `Host` | Origin admin changes must come from |
| `FORGE_ADMIN_RATE_LIMIT_RPM` | `120` | Admin API requests per minute per IP |
| `TOKENFACTORY_API_KEY`, `TINFOIL_API_KEY` | | Supplier keys |

### Other mints (NIP-87 discovery)

Under `FORGE_FOREIGN_POLICY=discovered` the gateway accepts eCash from the mints the operator lists plus the mints Cashu wallets recommend, found the way wallet.cashu.me finds them: kind 38172 mint announcements and kind 38000 reviews (`#k=38172`) from `FORGE_FOREIGN_DISCOVERY_RELAYS`. Event ids and BIP-340 signatures are checked, reviews older than 24 months are ignored, and a reviewer counts once per mint. A mint is accepted when it has at least `FORGE_FOREIGN_MIN_REVIEWERS` distinct reviewers (plus a verified mainnet announcement when `FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT=true`) and passes a probe: `GET /v1/info` and `GET /v1/keysets` answer, an active keyset exists in a Forge unit, and NUT-05 bolt11 melt is enabled in that unit (the gateway melts the eCash there). The list is kept in the database, served at once after a restart, and refreshed in the background; a request never waits on a relay. The URL safety check still runs on every accepted mint, and again whenever the gateway loads that mint's wallet; no Cashu request follows a redirect. The code is ported from cashucard/cashucard `ops/src/discovery.ts`.

The operator can add mints from the admin page (Settings, Other mints). An added mint goes through the URL safety check and the same probe, keeps the name from its `/v1/info`, is stored in the `operator_mints` table and is accepted like `FORGE_FOREIGN_ALLOW` under every policy (under `any` it never limits the policy). Forge's own mints and denied mints cannot be added. Both kinds are listed with `source: "operator"`.

A customer can still use a mint that is not on the list (`FORGE_FOREIGN_UNLISTED=true`, policy `discovered` or `allowlist`). The first quote answers 409 `mint_unlisted` with `{unlisted: {mint, max: {sat, usd}}}`; the chat app shows an inline warning with the mint and the cap, and **Continue** resends the quote with `accept_unlisted: true`. The mint must then pass the live probe (results are cached for 10 minutes, a failure for 1 minute), the token is capped at `FORGE_FOREIGN_UNLISTED_MAX_SAT` / `_USD`, and the funding is marked unlisted (`fundings.f_unlisted`, `foreign.unlisted` in the funding view, a badge on the admin Fundings page). Denied mints are always refused.

### Model catalog

`config/models.json` lists suppliers and models. Each model has a public `id`, its `supplier`, the `upstream` model name, the supplier's cost in USD per million input and output tokens, `max_output_tokens`, and `uncensored` (the chat page hides those behind an explicit toggle). Token Factory prices in the shipped catalog are placeholders marked `price_verified: false`; set them from your rate card. Tinfoil prices were read from `https://inference.tinfoil.sh/v1/models` on 2026-11-09.

A supplier sets `pricing: "metered"` (charge on reported usage) or `pricing: "flat"` (charge a schedule by request body size plus declared max output). A metered supplier may also carry a `flat` schedule, used only when no usage signal arrives.

### Suppliers

| Supplier | Tier | How |
| - | - | - |
| Token Factory | standard | OpenAI-compatible LiteLLM proxy at `https://gateway.trytokenfactory.dev/v1` |
| Tinfoil | enclave | Plaintext OpenAI-compatible calls, or EHBP encrypted pass-through (see [docs/PRIVACY.md](docs/PRIVACY.md)) |
| mock | standard | In-process, deterministic, for tests and local demos |

Add a supplier by implementing `Supplier` in `src/suppliers/types.ts` (one `chat()` method for OpenAI-compatible upstreams) and registering its `type` in `src/suppliers/index.ts`.

## API

All amounts in `*_msub` fields are thousandths of the unit: milli-cents for `usd`, millisatoshi for `sat`.

### `POST /v1/chat/completions`

OpenAI chat completions, streaming and non-streaming. `tools`, `tool_choice` and other fields pass through untouched. `n` must be 1. `max_tokens` (or `max_completion_tokens`) is capped per model; if absent, the cap is applied.

Payment headers:

- `Authorization: Bearer sk-forge-...` spends from a balance.
- `X-Cashu: cashuB...` pays this request (NUT-24). Add `X-Forge-Invite` while invite-only.
- `X-Cashu-Pubkey: 02...` (optional) locks this request's change to your wallet key (NUT-11 P2PK). See [Locking tokens to your wallet key](#locking-tokens-to-your-wallet-key).
- Neither: `402 Payment Required` with `X-Cashu: creqA...` (NUT-18: amount, unit, accepted mints). The amount is the request's maximum cost. `X-Forge-Unit: sat` asks for a sat quote.

Response headers: `X-Forge-Request-Id`, `X-Forge-Unit`, `X-Forge-Charged-Msub`, `X-Forge-Balance-Msub` (balance payments), `X-Forge-Privacy` (`standard`, `enclave-plaintext`, `enclave-encrypted`), and for NUT-24 `X-Cashu-Change` plus `X-Forge-Change-Url`.

Streams end with the upstream's `data: [DONE]`, followed by one gateway event:

```
event: forge
data: {"request_id":"req_...","unit":"usd","charged_msub":1300,"balance_msub":98700,"change":"cashuB..."}
```

The OpenAI JavaScript SDK ignores events after `[DONE]` (checked in its `core/streaming.js`), so the extra event does not reach its callers; other clients that parse every event should skip `event: forge`. Clients that want the change token read it, or fetch `GET /v1/change/{request_id}`.

### `GET /v1/models`

OpenAI model list plus `tier` (`enclave` or `standard`), `uncensored`, `max_output_tokens`, `context_length`, and `pricing` (`usd_per_mtok`, `sat_per_mtok` at the current rate, `mode`, `verified`). The response also lists accepted `mints`, `units` and `invite_only`.

### Wallet

| Endpoint | Body / auth | Result |
| - | - | - |
| `POST /v1/wallet/topup` | `{"token": "cashuB...", "invite": "inv-..."}`; optional `Authorization: Bearer sk-forge-...` to top up an existing key, or to choose your own key for a new balance | `{key?, account_id, unit, credited, balance_msub}`. `key` is returned only when the gateway generated it |
| `GET /v1/wallet` | bearer key | `{unit, balance_msub, available_msub, refundable}` |
| `POST /v1/wallet/refund` | bearer key; optional `{"amount": N, "pubkey": "02..."}`, amount in whole units | `{token, amount, unit, status, locked_to}`. Sub-unit remainders stay on the balance. With `pubkey` the token is P2PK-locked to it |
| `GET /v1/wallet/refunds` | bearer key | Every withdrawal with its token and `locked_to`, for re-delivery |
| `GET /v1/change/{request_id}` | none (the id is an unguessable capability) | NUT-24 change for that request |

A balance has one unit, set by its first topup. Topping up with another unit is rejected.

### Funding a balance

Each method opens a balance on first use (an invite is required while invite-only, exactly as for a topup) and returns `key` once when the gateway generated it. Send `Authorization: Bearer sk-forge-...` to fund an existing balance, or to choose your own key for a new one. Every response is a funding object:

```
{id, method: "lightning"|"onchain"|"foreign", state, unit, amount, request, expires_at, credited, balance_msub, account_id,
 onchain?: {confirmations_required, paid_sat, seen_sat, confirmed_sat, confirmations, watch_until},
 foreign?: {mint, unit, token_amount, credit, fee_max, change_token, refund_token, locked_to, payout_pending}, error?, key?}
```

`credited` is the exact amount, in whole units of `unit`, added to the balance so far.

| Endpoint | Body | Result |
| - | - | - |
| `GET /v1/wallet/fund/methods` | | What the Forge mint and config allow: Lightning units and limits, on-chain minimum and confirmations, other-mint limits |
| `POST /v1/wallet/fund/lightning` | `{amount, unit, invite?}` | `request` is a bolt11 invoice from the Forge mint; `state` goes `pending` -> `minting` -> `done` (or `expired`) |
| `POST /v1/wallet/fund/onchain` | `{invite?}` | `request` is a bitcoin address (sat only). Each deposit the mint counts as paid is minted and credited; the address is watched for `FORGE_ONCHAIN_WATCH_DAYS` |
| `GET /v1/wallet/fund/mints` | | Other mints accepted for funding: `{enabled, policy, mints: [{url, name?, reviewers?, source: "discovered"\|"operator"}], updated_at}`. Denied mints are never listed. `GET /v1/wallet/fund/methods` carries the same URLs as `foreign.mints` |
| `POST /v1/wallet/fund/foreign/quote` | `{token, unit, invite?, pubkey?}` | Prices a token from another mint: `foreign.credit` is what the balance gets, `foreign.fee_max` the most the token's mint can keep. Nothing is spent yet. A token from an accepted mint gets `use_topup`; one from a denied mint, or any mint the policy does not accept while `FORGE_FOREIGN_UNLISTED=false`, gets `mint_not_allowed`. Otherwise an unaccepted mint gets 409 `mint_unlisted` until the request carries `accept_unlisted: true` |
| `POST /v1/wallet/fund/foreign/confirm` | `{id, token, pubkey?}` + bearer | Receives the token at its mint, melts it to pay the Forge invoice, mints and credits `credit`. Unused fee reserve comes back as `foreign.change_token`; if the melt cannot go through, the token's value comes back as `foreign.refund_token` (state `refunded`). With `pubkey` (here or at quote) both are locked to it; `payout_pending` is true until the locking swap at the token's mint is done, and polling the status finishes it |
| `GET /v1/wallet/fund/{id}` | bearer | Status; polling also moves the funding forward |
| `GET /v1/wallet/fund` | bearer | Recent fundings of this balance |

Fedimint eCash is not accepted yet; see [docs/PAYMENTS.md](docs/PAYMENTS.md#not-yet-fedimint).

### Locking tokens to your wallet key

Every token the gateway hands back (NUT-24 change, refunds, other-mint change and refunds) is by default ordinary eCash made from the gateway's seed, so until you redeem it the gateway could spend it too. Give a public key and the token is P2PK-locked to it (NUT-11, plain lock, no timelock or refund key): only the wallet holding the private key can redeem it, and the gateway cannot spend it at all.

- NUT-24: `X-Cashu-Pubkey` request header. Refunds: `"pubkey"` in the body. Other-mint funding: `"pubkey"` at quote or confirm.
- Accepted forms: a 33-byte compressed key in hex (`02...`/`03...`, 66 characters; cashu.me shows it as "P2PK Key" under Receive > eCash, and in Settings > P2PK), an `npub1...`, or a 64-hex x-only key. The last two become `"02" + x`, the convention cashu.me, Minibits and cashu-ts use for nostr keys. Anything else, including a point not on secp256k1 or an uncompressed key, is `400 invalid_pubkey` before any eCash moves.
- Redeem with any NUT-11 wallet that holds the key (cashu-ts: `wallet.receive(token, { privkey })`; `examples/agent-pays.ts` shows it with `CASHU_PUBKEY=generate`).
- A token locked to a key you do not hold is lost. Nobody, including Forge, can unlock it.

### Other

- `GET /healthz`: liveness, current BTC/USD rate and age.
- `GET /attestation`, `GET /.well-known/hpke-keys`: Tinfoil attestation bundle and HPKE key config, proxied so browser clients can verify and encrypt through the gateway origin.

### Errors

OpenAI-style `{"error": {"message", "type", "code"}}`. Payment problems: `untrusted_mint`, `wrong_unit`, `insufficient_amount`, `token_spent`, `invalid_token`, `invalid_pubkey` (400, per NUT-24); `payout_unknown` (503: a locked payout whose outcome the mint has not confirmed; it stays owed and is never paid twice); `insufficient_balance` (402); `invite_required`, `invite_used` (403); `mint_unavailable` (503, retry with the same token). Funding adds `method_unavailable`, `invalid_amount`, `use_topup`, `mint_not_allowed`, `amount_too_large`, `token_mismatch`, `foreign_mint_error` (400), `quote_expired` (409) and `too_many_pending` (429). Upstream failures charge nothing and return all NUT-24 change.

## Admin CLI

```sh
pnpm admin invites:create [--count N] [--label TEXT]   # codes shown once, stored hashed
pnpm admin invites:list
pnpm admin invites:revoke <invite-id|code>
pnpm admin balances:list
pnpm admin revenue:show                                # wallet holdings vs customer balances and owed payouts
pnpm admin revenue:export --unit usd [--mint URL] [--amount N]   # sweep revenue as an eCash token
pnpm admin prices:show [--unit sat]
```

`revenue:export` never exports eCash that backs customer balances or unpaid change. Exports are recorded in `revenue_exports` (amount, lock, token hash; never the token).

## Admin page

`/admin/` is an operator page for the same tasks and more: revenue, liabilities and wallet holdings, activity by model, tier and supplier with estimated supplier cost, health (rate, supplier keys, mints, quote-check budget), revenue export as an eCash token (QR, copy, download, optional P2PK lock), invites, the beta waitlist (invite with a ready message, delete), balances with freeze, fundings with re-check, the request log and a read-only settings view. It is off (404) until `FORGE_ADMIN_TOKEN_HASH` is set, and in production Caddy adds basic auth on `/admin*`. Setup and the security model: [docs/ADMIN.md](docs/ADMIN.md).

## Chat page

`/` serves a chat app from `public/` (plain ES modules, no build step, nothing from third-party origins). It has a chat history sidebar kept in the browser's IndexedDB (search, rename, delete), streaming replies with a reasoning disclosure, Markdown with highlighted code and tables, stop, regenerate, edit and resend, copy, file attachments (documents for every model, images for models with `vision: true`), per-message cost and token counts, a model picker grouped by tier with price and speed hints (uncensored models behind an explicit opt-in), and Settings for theme, default model, reasoning effort, the system prompt and "Lock refunds to my wallet key" (a P2PK key kept in localStorage; refunds and other-mint change are then locked to it). The wallet drawer adds funds by eCash (paste or camera scan, including animated NUT-16 codes), Lightning, on-chain and eCash from other mints, and refunds as eCash with copy, a text-file download and a QR code (animated for long tokens). Keyboard shortcuts are listed under `Ctrl+/`.

**Files.** One attach button takes images (vision models) and documents (every model): text and code files, PDF and Word `.docx`. Files are read in the browser and only their text goes into the message, as `<file name="..." pages="...">...</file>` blocks before the typed text (at most 200,000 characters per message, cut with a note). Scanned PDF pages can be sent as images to vision models (up to 4, rendered on the device). Chips above the message box show name, size, pages and reading progress; the line under them estimates input tokens and cost and warns when the model's `context_length` would be exceeded. Drag and drop and paste work too. Extraction code (`public/js/extract.js`) and pdf.js load only when a document is attached; `.docx` is unzipped with the browser's `DecompressionStream`, so it needs no library.

**Installable app.** `public/manifest.webmanifest` (icons in `public/icons/`, built from the anvil mark by `scripts/icons.sh` with `rsvg-convert`; shortcuts `/#new` and `/#fund`), iOS home-screen meta tags, and a service worker. The gateway serves `/sw.js` from the template `public/sw.js`, filling in a version that is a SHA-256 of the app shell files (every file under `public/` the page needs: `index.html`, `app.js`, `js/*.js`, CSS, icons, manifest, offline page) and a second hash of `public/vendor` (`src/sw.ts`). It is computed when the gateway starts and again when a file changes, so a deploy needs no build step and every deploy that changes the page changes `/sw.js`. The worker precaches the shell as one set per version and serves it cache first, so new HTML is never paired with old JS; vendor files are cache first in their own versioned cache. A new version waits: the page shows "Update available" with Reload, and otherwise switches on the next launch. API calls, `/admin`, `/beta`, POSTs and requests with `Authorization` or `X-Cashu` bypass the worker. Offline, the app opens from the cache with the chat history, and sending is disabled until the connection returns; other pages fall back to `public/offline.html`. Settings offers "Install app" where the browser supports it, and on iOS a one-time Share > Add to Home Screen hint.

First-load JavaScript is about 59 KB gzipped (page code and the Markdown libraries). The attachment helpers load when the page is idle; the highlighter, QR, scanner, document extraction, pdf.js and Tinfoil SDK load on first use. Rebuild the vendored libraries with `scripts/vendor.sh`. Privacy details: [docs/PRIVACY.md](docs/PRIVACY.md#chat-page).

## Logs and privacy

Logs are JSON lines with request id, model, supplier, token counts, cost, status and latency. Prompt and completion content is never logged or stored. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Tests

```sh
pnpm typecheck
pnpm test                 # unit tests
pnpm mint:up && pnpm test:e2e && pnpm mint:down    # end to end against real local Nutshell mints
pnpm test:live            # optional; needs TOKENFACTORY_API_KEY (read from .env if present)
```

`test/unit/files.test.ts` covers the attachment helpers (file types, text decoding and binary refusal, `.docx` unzip and text, `<file>` blocks, the 200,000-character budget, estimates). `test/unit/sw.test.ts` and `test/e2e/pwa.e2e.test.ts` cover the service worker version and shell list, `/sw.js`, manifest, icons and offline page headers; `test/e2e/files-privacy.e2e.test.ts` checks that file text reaches the supplier (or the enclave, encrypted) and never the logs or the database.

`docker-compose.test.yml` runs three FakeWallet mints: `mint-a` (the Forge mint in tests), `mint-b` (an untrusted mint) and `mint-c` (a "foreign" mint with input fees, for other-mint funding). On-chain funding is tested against `test/e2e/onchain-mock.ts`, a NUT-30 proxy over `mint-a` that follows the Forge Nutshell branch's request and response shapes.

The admin tests (`test/unit/admin.test.ts`, `test/e2e/admin.e2e.test.ts`) cover access control (404 when off, 401 on a missing or wrong token, failed-login limit, Origin and JSON checks, no CORS), invites and revoke, the waitlist invite and delete, freeze (spending blocked, refunds allowed), revenue export (never above sweepable, locked export redeemable only with the key, history with token hash and no token, crash after the swap finished once by recovery) and overview numbers against the ledger.

The e2e suite covers the 402 flow with change, sat pricing, topup, spend, refund, wrong mint, wrong unit, double spend, client disconnect mid-stream, upstream failure and retries, flat pricing, invite gating, crash recovery (both NUT-19 replay and NUT-09 restore), P2PK-locked change and refunds (locked to the key: a plain wallet and the gateway's own wallet cannot redeem them, the key holder can; invalid keys 400; crash after a locked swap recovered by replay, by NUT-09 restore of the stored blinded messages, and left owed when neither answers), funding by Lightning (quote, paid, minted, credited; restart mid-quote; crash after the mint with replay and with restore; concurrent polls credit once), by other-mint eCash (fees shown, credit exact, change returned, cross-unit, crash after the swap and after the melt, refund when the melt no longer fits, quote expiry frees the invite, deny list, plain-http mints refused) and on-chain against the mock (NUT-20 locked quotes, repeated deposits, crash after the mint), and EHBP pass-through against a fake enclave (usage from header and from HTTP trailer).

## License

MIT. See [LICENSE](LICENSE).
