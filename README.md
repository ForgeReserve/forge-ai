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
| `FORGE_RATE_LIMIT_RPM` | `60` | POST requests under `/v1` per minute per client IP, whatever key a request carries; a key that verifies is also held to the same rate across all its addresses. The faucet (`/v1/free/*`) and card relay (`/v1/wallet/fund/card/*`) routes take no balance, so they count by client IP only and never look a bearer up |
| `FORGE_MAX_BODY_BYTES` | `1000000` | Request size limit |
| `FORGE_AUDIO_MAX_BYTES` | `4000000` | Size limit for `POST /v1/audio/transcriptions` only (a recording is larger than a question) |
| `FORGE_FREE_VOICE_PER_DAY` | `20` | Free voice questions: speech to text served free to a balance that cannot pay for it, this many per balance per UTC day (docs/PAYMENTS.md). `0`: off |
| `FORGE_FREE_VOICE_BUDGET_USD` | `5.00` | The most the operator pays for free voice questions per UTC day, at the supplier's cost. `0`: off |
| `FORGE_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting (set behind Caddy) |
| `FORGE_UPSTREAM_TIMEOUT_MS` / `FORGE_UPSTREAM_RETRIES` | `180000` / `2` | Time to upstream response headers (a timeout is final); retries only failures before the request was sent (refused, DNS, connect timeout, certificate), plus 408, 425, 429, 5xx and resets for a supplier with `idempotencyHeader` |
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
| `FORGE_CREDIT_MINT` | unset | The credit mint for free questions ([docs/FREE-TIER.md](docs/FREE-TIER.md)). Unset: the free tier is off and credits are refused like any unknown mint. It must not be one of `FORGE_TRUSTED_MINTS` |
| `FORGE_CREDIT_MINT_ISSUE_URL` | `FORGE_CREDIT_MINT` | Where the faucet mints vouchers (the credit mint's own host, where minting is open) |
| `FORGE_CREDIT_UNIT` | `usd` | The credit mint's unit (Nutshell has no custom unit, so 1 credit = 1 cent of usd) |
| `FORGE_FREE_MODELS` | `tinfoil/gpt-oss-120b,tinfoil/gemma4-31b` | Models a free balance may use |
| `FORGE_FREE_MAX_INPUT_TOKENS` / `FORGE_FREE_MAX_OUTPUT_TOKENS` | `4000` / `1500` | Caps on one free question (input estimated from the body size, like any request) |
| `FORGE_CREDIT_KEYSET_DAYS` | `90` | A credit keyset is taken this long after the gateway first saw it, or until its own `final_expiry` |
| `FORGE_FAUCET_ENABLED` | `false` | The daily faucet at `/free` and `/v1/free/*`. Needs `FORGE_CREDIT_MINT`. Off: both answer 404 |
| `FORGE_FAUCET_DAILY_VOUCHERS` / `FORGE_FAUCET_QUESTIONS` | `1000` / `3` | Vouchers per UTC day, and free questions per voucher |
| `FORGE_FAUCET_DRIPS_PER_DAY` | `24` | The day's budget is released in this many equal drips |
| `FORGE_FAUCET_POW_BITS` / `FORGE_FAUCET_POW_MAX_BITS` | `22` / `28` | Proof of work per claim (SHA-256 leading zero bits); it rises one bit per doubling of claims over the drip, up to the most |
| `FORGE_FAUCET_PER_ADDRESS` | `3` | Claims per address per day, counted in memory only (never stored or logged). `0`: off |
| `FORGE_FAUCET_CHALLENGE_SECONDS` | `300` | How long a puzzle may be worked on |
| `FORGE_APK_PATH` | unset | The signed Android APK `/download` offers ([docs/ANDROID.md](docs/ANDROID.md)). Unset: the page says the app is coming |
| `FORGE_ANDROID_CERT_SHA256` | unset | SHA-256 fingerprints of the APKs' signing certificates, comma separated. Set: `/.well-known/assetlinks.json` links both apps, so event links (`/j#<pass>`) open in the app. Unset: that file is 404 |
| `FORGE_APK_PRIVATE_VOICE_PATH` | unset | The signed Forge Private Voice APK (for GrapheneOS). Set: `/download` offers Android or GrapheneOS. Unset: that choice is hidden |
| `TOKENFACTORY_API_KEY`, `TINFOIL_API_KEY` | | Supplier keys |

### Other mints (NIP-87 discovery)

Under `FORGE_FOREIGN_POLICY=discovered` the gateway accepts eCash from the mints the operator lists plus the mints Cashu wallets recommend, found the way wallet.cashu.me finds them: kind 38172 mint announcements and kind 38000 reviews (`#k=38172`) from `FORGE_FOREIGN_DISCOVERY_RELAYS`. Event ids and BIP-340 signatures are checked, reviews older than 24 months are ignored, and a reviewer counts once per mint. A mint is accepted when it has at least `FORGE_FOREIGN_MIN_REVIEWERS` distinct reviewers (plus a verified mainnet announcement when `FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT=true`) and passes a probe: `GET /v1/info` and `GET /v1/keysets` answer, an active keyset exists in a Forge unit, and NUT-05 bolt11 melt is enabled in that unit (the gateway melts the eCash there). The list is kept in the database, served at once after a restart, and refreshed in the background; a request never waits on a relay. The URL safety check still runs on every accepted mint, and again whenever the gateway loads that mint's wallet; no Cashu request follows a redirect. The code is ported from cashucard/cashucard `ops/src/discovery.ts`.

The operator can add mints from the admin page (Settings, Other mints). An added mint goes through the URL safety check and the same probe, keeps the name from its `/v1/info`, is stored in the `operator_mints` table and is accepted like `FORGE_FOREIGN_ALLOW` under every policy (under `any` it never limits the policy). Forge's own mints and denied mints cannot be added. Both kinds are listed with `source: "operator"`.

A customer can still use a mint that is not on the list (`FORGE_FOREIGN_UNLISTED=true`, policy `discovered` or `allowlist`). The first quote answers 409 `mint_unlisted` with `{unlisted: {mint, max: {sat, usd}}}`; the chat app shows an inline warning with the mint and the cap, and **Continue** resends the quote with `accept_unlisted: true`. The mint must then pass the live probe (results are cached for 10 minutes, a failure for 1 minute), the token is capped at `FORGE_FOREIGN_UNLISTED_MAX_SAT` / `_USD`, and the funding is marked unlisted (`fundings.f_unlisted`, `foreign.unlisted` in the funding view, a badge on the admin Fundings page). Denied mints are always refused.

### Model catalog

`config/models.json` lists suppliers and models. Each model has a public `id`, its `supplier`, the `upstream` model name, the supplier's cost in USD per million input and output tokens, `max_output_tokens`, and `uncensored` (the chat page hides those behind an explicit toggle). A model with `"pricing": "free"` (and a `free_reason`) costs users nothing and carries no token price: every Token Factory model is free while Token Factory charges Forge nothing during its beta (owner decision, 2026-11-15). A free model needs a balance key and is never held or charged; see docs/PAYMENTS.md, Free models. When the beta ends, set those models back to paid with prices from the Token Factory rate card. Tinfoil prices were read from `https://inference.tinfoil.sh/v1/models` on 2026-11-09.

The optional `audio` list holds speech to text (`kind: "transcription"`) and text to speech (`kind: "speech"`) models. Each is priced per request: `request_usd` (the supplier's cost per request), plus `usd_per_second` of audio in or `usd_per_kchar` (per 1,000 characters) of text out, with `FORGE_MARKUP` on top. A transcription model sets `max_seconds` and the `formats` it takes (`wav` only, since a WAV file states its own length); a speech model sets `max_chars` and its `voices` (the first is the default). The shipped catalog lists Tinfoil's `whisper-large-v3-turbo` (0.01 USD a request) and `voxtral-tts` (0.002 USD a request), read from Tinfoil's public model config (`https://api.tinfoil.sh/api/config/models`) on 2026-11-13.

A supplier sets `pricing: "metered"` (charge on reported usage) or `pricing: "flat"` (charge a schedule by request body size plus declared max output). A metered request holds the model's own metered worst case (input estimated from the body plus max output, at the model's prices with markup), and a response without a usage count is charged that worst case, never more than the hold. A `flat` schedule on a metered supplier is ignored. `GET /v1/models` lists the hold figures under `pricing.hold`; see docs/PAYMENTS.md, The funds hold.

A resent request can run, and bill, a second time upstream, so a request that may have reached the supplier is never resent blindly. A supplier that documents de-duplication by an idempotency key can set `idempotencyHeader` (for example `"Idempotency-Key"`): every plaintext request then carries a fresh key, the same on each of its attempts, and retryable statuses and resets are retried. No shipped supplier sets it.

### Suppliers

| Supplier | Tier | How |
| - | - | - |
| Token Factory | standard | OpenAI-compatible LiteLLM proxy at `https://gateway.trytokenfactory.dev/v1`. Its models are free to users during Token Factory's beta (`pricing: "free"`) |
| Tinfoil | enclave | Plaintext OpenAI-compatible calls, or EHBP encrypted pass-through (see [docs/PRIVACY.md](docs/PRIVACY.md)) |
| mock | standard | In-process, deterministic, for tests and local demos |

Add a supplier by implementing `Supplier` in `src/suppliers/types.ts` (one `chat()` method for OpenAI-compatible upstreams, plus `transcribe()` and `speech()` if it serves audio) and registering its `type` in `src/suppliers/index.ts`. The OpenAI-compatible and Tinfoil suppliers implement both audio calls.

## API

The public guide for builders is [docs/API.md](docs/API.md), served by the gateway at `/docs/`. The page is built from the Markdown with `pnpm build:docs` (`scripts/build-docs.ts`); `test/unit/api-docs.test.ts` fails when the two drift or when a `/v1` route is not documented.

All amounts in `*_msub` fields are thousandths of the unit: milli-cents for `usd`, millisatoshi for `sat`.

### `POST /v1/chat/completions`

OpenAI chat completions, streaming and non-streaming. `tools`, `tool_choice` and other fields pass through untouched. `n` must be 1. `max_tokens` (or `max_completion_tokens`) is capped per model; if absent, the cap is applied.

Payment headers:

- `Authorization: Bearer sk-forge-...` spends from a balance.
- `X-Cashu: cashuB...` pays this request (NUT-24). Add `X-Forge-Invite` while invite-only.
- `X-Cashu-Pubkey: 02...` (optional) locks this request's change to your wallet key (NUT-11 P2PK). See [Locking tokens to your wallet key](#locking-tokens-to-your-wallet-key).
- A free model (`pricing.free` in `GET /v1/models`) takes a balance key only, even one at 0: nothing is held or charged. Without one it is `401 balance_key_required`, with no payment request, and an `X-Cashu` token sent with it is left untouched; a free-question balance key gets `403 balance_key_required`.
- Neither: `402 Payment Required` with `X-Cashu: creqA...` (NUT-18: amount, unit, accepted mints, and the request id). The amount is the request's maximum cost. `X-Forge-Unit: sat` asks for a sat quote.
- `X-Forge-Web-Search: 1` (encrypted requests) declares that the encrypted body turns on web search (`web_search_options`), so the hold takes the search fee. A plaintext body with `web_search_options` is read directly. Only on a model whose `capabilities.web_search` is true; else `400 web_search_unavailable`; never on a free question (`403 web_search_not_free`). See docs/PAYMENTS.md, Web search.
- `X-Forge-Request-Id: req_...` (optional, with `X-Cashu`) pays under the id from the 402, so the request and its change at `GET /v1/change/{request_id}` use the id you already hold, even if the paid response never reaches you. Each id can be used for one paid attempt, even one that fails: reusing one is `409 request_id_used` and the token is left untouched. Without the header the paid request gets a new id.

Response headers: `X-Forge-Request-Id`, `X-Forge-Unit`, `X-Forge-Charged-Msub`, `X-Forge-Balance-Msub` (balance payments), `X-Forge-Privacy` (`standard`, `enclave-plaintext`, `enclave-encrypted`), and for NUT-24 `X-Cashu-Change` plus `X-Forge-Change-Url`.

Streams end with the upstream's `data: [DONE]`, followed by one gateway event:

```
event: forge
data: {"request_id":"req_...","unit":"usd","charged_msub":1300,"balance_msub":98700,"change":"cashuB..."}
```

The OpenAI JavaScript SDK ignores events after `[DONE]` (checked in its `core/streaming.js`), so the extra event does not reach its callers; other clients that parse every event should skip `event: forge`. Clients that want the change token read it, or fetch `GET /v1/change/{request_id}`.

### `GET /v1/models`

OpenAI model list plus `tier` (`enclave` or `standard`), `uncensored`, `max_output_tokens`, `context_length`, `capabilities` (`vision`, `reasoning`, `web_search`), and `pricing` (`free` and `free_reason` for a free model, `usd_per_mtok`, `sat_per_mtok` at the current rate, `mode`, `verified`, and `hold`: the figures the gateway holds funds by, `web_search` included, see docs/PAYMENTS.md; a free model lists every figure as 0). The response also lists accepted `mints`, `units` and `invite_only`, and the audio models apart from chat in `audio`: `id`, `kind`, `tier`, `max_seconds` or `max_chars`, `formats`, `voices`, and `pricing.usd` / `pricing.sat` (`request`, `second`, `kchar`, after markup).

### `POST /v1/audio/transcriptions` and `POST /v1/audio/speech`

OpenAI-compatible speech to text (multipart: `file`, `model`, optional `language`, `response_format: json`) and text to speech (JSON: `model`, `input`, optional `voice`, `response_format: wav`). Paid from a balance only (`Authorization: Bearer sk-forge-...`): the price is held first, charged when the model answers, and released when it fails, with the same `X-Forge-*` response headers as chat. A recording must be WAV and is billed by the length its header gives; MP3 is refused, because its length cannot be read from its size. Errors: `audio_too_long` (over the model's `max_seconds`), `audio_too_short` (under 0.3 seconds), `unsupported_audio` (not WAV), `text_too_long` (over `max_chars`), `request_too_large` (over `FORGE_AUDIO_MAX_BYTES`). Audio and text are held in memory for the request only and never logged or stored; the log and the `requests` table carry the model, price and status. A transcription a balance cannot pay for is a free voice question while the balance's daily allowance and the operator's daily budget last (`X-Forge-Charged-Msub: 0`, `X-Forge-Free-Voice-Left`); used up, it is `402 free_voice_limit` with `free_voice: {left, per_day, resets_at, reason}` (docs/PAYMENTS.md, Free voice questions). Speech output is never free.

### Wallet

| Endpoint | Body / auth | Result |
| - | - | - |
| `POST /v1/wallet/topup` | `{"token": "cashuB...", "invite": "inv-..."}`; optional `Authorization: Bearer sk-forge-...` to top up an existing key, or to choose your own key for a new balance | `{key?, account_id, unit, credited, balance_msub}`. `key` is returned only when the gateway generated it |
| `POST /v1/wallet/open` | `{"invite": "inv-...", "unit"?: "usd"\|"sat"}`; optional bearer key | Opens a balance at 0 for the free models: `{key?, account_id, unit, created, balance_msub, free_models}`. Always needs an invite or an event pass, even with `FORGE_INVITE_ONLY=false`; a pass counts one use per balance and is refused (`pass_used_up`, `pass_expired`) at its cap or expiry. A known bearer key is answered as it is |
| `GET /v1/wallet` | bearer key | `{unit, balance_msub, available_msub, refundable, free_voice: {enabled, per_day, left, resets_at, reason?}}` |
| `POST /v1/wallet/refund` | bearer key; optional `{"amount": N, "pubkey": "02..."}`, amount in whole units | `{token, amount, unit, status, locked_to}`. Sub-unit remainders stay on the balance. With `pubkey` the token is P2PK-locked to it |
| `GET /v1/wallet/refunds` | bearer key | Every withdrawal with its token and `locked_to`, for re-delivery |
| `GET /v1/change/{request_id}` | none (the id is an unguessable capability) | NUT-24 change for that request, under the id from the 402 when the paid request echoed it |

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

### Free questions (credits) and the faucet

Not the free models (docs/PAYMENTS.md, Free models), which need a balance key and take no credit. Off by default. With `FORGE_CREDIT_MINT` set, eCash from that mint is **credits**: one free question each, not money ([docs/FREE-TIER.md](docs/FREE-TIER.md)). `POST /v1/wallet/topup` with a credit token opens or fills a **free balance** (`free: true` in the answer and in `GET /v1/wallet`), with no invite needed. The rules:

- A free balance pays only for `FORGE_FREE_MODELS`, one credit (1,000 msub) per answered question and nothing for a failed one. A question over `FORGE_FREE_MAX_INPUT_TOKENS` is refused with `free_too_long`, one asking for more than `FORGE_FREE_MAX_OUTPUT_TOKENS` with `free_too_much_output`; a question that does not say gets the cap. Another model gets 403 `not_free_model` (with `free_models`), and so does speech.
- Credits and money never mix: money on a free balance, or credits on a paid one, is 409 `wrong_balance` (Lightning and on-chain funding included). Credits sent per request (`X-Cashu`) get `credits_need_balance`, and other-mint funding refuses them with `credits_not_money`. A free balance is taken out (`POST /v1/wallet/refund`) only as credits from the credit mint.
- Credits from a keyset past `FORGE_CREDIT_KEYSET_DAYS` (or its own `final_expiry`) are refused with `credits_expired`.
- Free balances and the credit mint's eCash are left out of revenue and customer balances.
- `GET /v1/models` carries `free: {mint, unit, models, max_input_tokens, max_output_tokens, faucet}` (null while off).

With `FORGE_FAUCET_ENABLED=true`, the faucet gives out vouchers:

| Endpoint | Body | Result |
| - | - | - |
| `GET /v1/free` | | `{questions, vouchers_left_today, questions_left_today, available_now, next_at, bits}` |
| `POST /v1/free/challenge` | `{}` | `{challenge, bits, expires_at}`. 429 `faucet_empty` (with `next_at`) when nothing can be claimed now, 429 `faucet_limit` when this address has had its share today |
| `POST /v1/free/verify` | `{solution}` | `solution` is `"<challenge>:<nonce>"` whose SHA-256 has `bits` leading zero bits. Spends the challenge and returns `{ticket, expires_at}`. Refused: `pow_invalid`, `challenge_unknown`, 409 `challenge_used`, 410 `challenge_expired` |
| `POST /v1/free/claim` | `{ticket}` | `{token, questions, mint, unit}`: the voucher. 409 `claim_used` for a ticket already claimed; 503 `faucet_unavailable` when it could not be made (the ticket stays good) |

`GET /free` serves the faucet page while the faucet is on. `pnpm issue-credits` prints vouchers from a credit mint on the same computer. The credit mint's deployment files are in [deploy/credit-mint](deploy/credit-mint/README.md).

### Locking tokens to your wallet key

Every token the gateway hands back (NUT-24 change, refunds, other-mint change and refunds) is by default ordinary eCash made from the gateway's seed, so until you redeem it the gateway could spend it too. Give a public key and the token is P2PK-locked to it (NUT-11, plain lock, no timelock or refund key): only the wallet holding the private key can redeem it, and the gateway cannot spend it at all.

- NUT-24: `X-Cashu-Pubkey` request header. Refunds: `"pubkey"` in the body. Other-mint funding: `"pubkey"` at quote or confirm.
- Accepted forms: a 33-byte compressed key in hex (`02...`/`03...`, 66 characters; cashu.me shows it as "P2PK Key" under Receive > eCash, and in Settings > P2PK), an `npub1...`, or a 64-hex x-only key. The last two become `"02" + x`, the convention cashu.me, Minibits and cashu-ts use for nostr keys. Anything else, including a point not on secp256k1 or an uncompressed key, is `400 invalid_pubkey` before any eCash moves.
- Redeem with any NUT-11 wallet that holds the key (cashu-ts: `wallet.receive(token, { privkey })`; `examples/agent-pays.ts` shows it with `CASHU_PUBKEY=generate`).
- A token locked to a key you do not hold is lost. Nobody, including Forge, can unlock it.

### Other

- `GET /healthz`: liveness, current BTC/USD rate and age.
- `GET /j`: the event link's page (the pass stays in the fragment); `GET /.well-known/assetlinks.json`: Android App Links for both apps (`FORGE_ANDROID_CERT_SHA256`).
- `GET /attestation`, `GET /.well-known/hpke-keys`: Tinfoil attestation bundle and HPKE key config, proxied so browser clients can verify and encrypt through the gateway origin.

### Errors

OpenAI-style `{"error": {"message", "type", "code"}}`. Payment problems: `untrusted_mint`, `wrong_unit`, `insufficient_amount`, `token_spent`, `invalid_token`, `invalid_pubkey` (400, per NUT-24); `payout_unknown` (503: a locked payout whose outcome the mint has not confirmed; it stays owed and is never paid twice); `insufficient_balance` (402); `balance_key_required` (401 with no key, 403 with a free-question key: a free model needs a balance key); `invite_required`, `invite_used` (403); `mint_unavailable` (503, retry with the same token). Funding adds `method_unavailable`, `invalid_amount`, `use_topup`, `mint_not_allowed`, `amount_too_large`, `token_mismatch`, `foreign_mint_error` (400), `quote_expired` (409) and `too_many_pending` (429). Upstream failures charge nothing and return all NUT-24 change.

## Admin CLI

```sh
pnpm admin invites:create [--count N] [--label TEXT]   # codes shown once, stored hashed
pnpm admin invites:list
pnpm admin invites:revoke <invite-id|code>
pnpm admin passes:create --uses N --expires YYYY-MM-DD [--label TEXT]   # event pass: code + /j link shown once
pnpm admin passes:list
pnpm admin passes:revoke <pass-id|code>
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

## The v2 app (in progress)

`/v2/` serves the next app beside the chat page, for the December cut (plan: [docs/V2-BUILD.md](docs/V2-BUILD.md), screens: [docs/design/SCREENS.md](docs/design/SCREENS.md)). It is built the same way: plain ES modules in `public/v2/`, no build step, nothing from other origins. It reuses v1's helpers by import (`/js/files.js`, `/js/extract.js`, `/js/markdown.js`, `/js/qr.js`, `/js/scan.js`, `/js/lockkey.js`).

- **Home:** two rings. Gold is funds (full means the balance right after money last came in), green is memory (how much of the model's context is still free). Tapping either opens Funds and memory. Hold to talk sits in the middle; Type, Add (photo and file) and More sit below.
- **First run:** a phone that opens the home for the first time sees four short steps first, each one idea: icons first, a short heading and one short sentence, with the detail under Learn more on the same step. Welcome (no account, paid with eCash, private questions, history kept on the phone, and the invite code when the engine needs one), How you pay (the ways to add funds by icon, only those this engine offers and this phone can use: a paper note, free questions while the engine gives them out, a card in the Android app, and Lightning; under Learn more, what the two rings mean and that funds are lost with the phone), What it can and cannot hide (under Learn more, what Forge hides, and what it cannot: the network address unless Tor or a relay is used, the voice on its way through the engine, where money came from, what you type, a watched phone, being forced to unlock, wrong answers), and Private only (on by default; under Learn more, what it covers and what it does not; Turn it on if it was turned off). Every step can be skipped; Skip or Start marks it seen (`forge2.firstRun` in `localStorage`), so it shows once. An address that names another screen, or a photo shared in, opens that screen instead. More, How Forge works opens it again. Listen plays the step's heading and sentence from a clip recorded once, offline, in the app's own natural voice (Phonon 31m English, voice Maeve, British English; docs/VOICE.md), in `public/v2/voice/en/` (Opus in Ogg), which the service worker keeps for offline use. A clip plays only when its manifest says it was recorded from exactly the words the step shows; otherwise, or where it cannot play, Listen uses the phone's own voice where it has one that runs on the phone. The engine's voice is never used there (`public/v2/core/firstrun.js`, `public/v2/core/clips.js`, `public/v2/screens/firstrun.js`). After changing those words, record the clips again with `scripts/record-voice/record.py` (setup in its header; no key, no network service: Phonon runs in headless Chrome on this computer from the model files the build already has, with a fixed seed so the same words give the same sound; `--engine kokoro` still records with Kokoro's Emma); `test/unit/v2/voice-clips.test.ts` fails until you do.
- **Search the web:** for a model that can search (the private Tinfoil models), Type has a Search the web switch, and so does the home (for a question asked by voice) once there are funds. It is off by default and off again once a question is sent. While it is on, one line says that the sealed machine sends the search to a search service, which sees the search but not who asked; the price line includes the search fee; and the question carries `web_search_options` with both of Tinfoil's safety filters (`pii_check_options`, `prompt_injection_check_options`) inside the encrypted body, plus `X-Forge-Web-Search: 1` so the engine holds the fee. A search is never a free question.
- **Price before sending:** every request that costs money shows its price first: the Type screen, the line under the talk button while recording, Ask again and Try again on the answer screen, and Listen when the engine reads aloud. The price line reads Free, or Free, 2 of 3 left, when a free question pays; the free tier wires that in.
- **Empty states:** with no funds, the home shows one Add money button under the rings (on a free model at $0: the model's name with FREE, and a small Add money button); Add money is the wallet cards, one picture card with one word per way (docs/design/SCREENS.md); Funds and memory offers Add money as a fanned stack of those cards, with no Take out button while there is nothing to take out; History with nothing in it says what will be kept there and offers Ask a question.
- **Hold to talk:** press and hold to record, let go to send, slide off the button and let go to cancel; a tap explains it, and Space or Enter work too. While it records, the button shows level bars, and a line under the rings gives the time, where the sound goes and the price before sending (turning the voice into words, the question, and reading the answer aloud when the engine does it). The recording goes straight to the answer, which shows the question as text and reads the answer aloud; Listen replays it and Stop stops it. Voice in and voice out are `voice-in` and `voice-out` modules, each with an `engine` way (the engine's audio routes above) and a `device` way (the browser's own recogniser, and the phone's own voices). The engine is the default for voice in. The browser recogniser may send the voice to the browser's maker, so it is never used with Private only on; with Private only on, voice goes only to an audio model in sealed hardware (tier `enclave`). It passes through the engine in plain form to get there, unlike a private question, which is encrypted end to end. Answers are read by the phone's own voice when it has one that runs on the phone, else by the engine; More, Voice changes either, or turns reading aloud off. Sound recorded on the phone stays in memory and is dropped once sent or cancelled; each piece of a spoken answer is kept in memory as soon as it arrives, for the last few answers, so Listen never pays twice for a piece, even after Stop part way or a refused play. The line under the button, the Voice screen and the answer screen while the engine reads aloud all say that the engine could hear or read what passes through it.
- **Engine client** (`public/v2/core/engine.js`): the OpenAI-compatible API above, streamed. It answers a `428 pow_required` challenge once per request, the way a Bellows asks (`X-Bellows-Pow-Challenge`, solved into `X-Bellows-Pow`). This gateway does not send 428; the client is tested against a stub. Private models (enclave and encrypted in the browser) go through the vendored Tinfoil SDK, as in v1.
- **Money first:** eCash is written to the phone (`forge2.vault` in localStorage) before it is sent and removed only when the engine confirms the credit. Taken-out eCash stays there until the person taps I saved it. v2 uses v1's balance key (`forge.balanceKey`), so a v1 balance carries over.
- **Modules:** every swappable part has a manifest under `public/v2/modules/<kind>/<id>/` and loads through `public/v2/core/registry.js`, which refuses a bad manifest and hands a module only its kind's inputs. Bundled in this release: looks (Light, Dark, Midnight), Default mode, and fund modules for paper notes, free questions, Cashu cards, eCash, Lightning, on-chain and other mints. The registry does not yet check the `publisher` and `sig` fields and runs no sandbox: only the bundled modules load, as ordinary page code (see [docs/MODULES.md](docs/MODULES.md)).
- **Paper notes:** Scan a note is the first way to add funds. The camera (through the camera adapter and v1's scanner, so single and animated codes both work) reads the eCash on a paper note; the phone shows the amount and the mint before anything is sent, and adds it on one tap through the vault. A note from a mint this engine does not take says so and offers Other mint, with the note handed over. A note that was already used says so (the engine learns that from the mint when the note is added). With no funds, a chip right under the gold ring opens the scanner, and Funds and memory shows Scan a note first. If the camera cannot be used, the code can be pasted.
- **Share unseen (photos):** Add, Photo opens it; so does a photo shared in from another app (the manifest's `share_target`, caught by the v2 service worker). Take a photo or pick one, and the `filter` modules run on the phone, in order: `strip-details` lists what the file holds (where, which phone, when, a hidden thumbnail, other notes), `cover-faces` finds faces with the vendored face-api tiny face detector (MIT, on TensorFlow.js, model file bundled in `public/vendor/face-api/`, about 190 KB) and `cover-numbers` finds lines of writing such as plates, signs and name tags with a small finder in plain JavaScript (`textfind.js`, no model). The person sees After and Before, adds a block with a tap or a drag, takes one away with a tap, and reads the list of what changed, including blocks taken away and any check that did not run. Share opens the phone's share sheet with the new file (a download where the browser has no sheet for files), Save downloads it, Ask about it adds it to the next question (a paid question, with the price on the Type screen). The new file is the photo drawn again with solid black blocks, widened to the JPEG encoder's 16 px grid so nothing under a block reaches the file, made into a new JPEG named `photo.jpg`, stripped of every APPn segment, comment and trailing data, and checked before it can leave (`public/v2/core/photo.js`, `photometa.js`). It needs no balance. The photo is held in the screen's memory only; the original is never stored or sent. The automatic checks can miss things (a face turned away, small or slanted writing) and the screen says so.
- **Free models** (docs/PAYMENTS.md, Free models): the model list shows a Free badge, the price line reads Free, the answer says "That was free.", and "not enough funds" never stops a question to one. **Start free:** an invite code alone opens a balance with nothing on it (`POST /v1/wallet/open`), from the first run's last step (its "Start free with an invite" link; answering the Private only question ends the first run) or from the Start free card, first on Add money while the engine has free models and the phone has no key or $0 on a paid model (its own screen: the code, Paste and Scan, then the question); a free model is then chosen if Private only allows one, and the free models work at $0. Paid models still need funds. With no balance key yet, Type says a free model needs a balance and opens Start free. The v1 app's model menu reads Free.
- **Event links** (docs/ANDROID.md, Event links): one QR code, `https://ai.forge-reserve.com/j#<pass>`, from an event pass (`pnpm admin passes:create`). On an iPhone or a computer `/j` opens the web app on `/v2/#join=<pass>`, which drops the pass from the address, opens a free balance with it, ends the first run and asks the Private only question once, then shows the home. On Android `/j` shows two steps (get the app, open it on the pass) and Use in browser; the app takes the pass through Android App Links or the page's intent link. A phone with a balance key already spends nothing.
- **Free questions** (off until the engine has a credit mint, [docs/FREE-TIER.md](docs/FREE-TIER.md)): Free questions is a tile on Add money's More card while the engine gives them out. The phone works the faucet's puzzle with a progress ring, and the voucher goes through the vault onto a **free balance** with its own key (`forge2.freeKey`), apart from the paid one. A voucher pasted as eCash or scanned as a note is counted in questions, never as an amount of money, and needs no invite. A free question is used first when the model is on the engine's free list and the question fits the caps: the price line reads "Free, 2 of 3 left", the answer says how many are left, the balance pill counts them when there is no paid balance, and the gold ring shows them as a lighter segment ahead of the paid balance. A voice question is never all free: the engine's speech to text is paid from the paid balance. When they run out, Type and the home lead to the three ways forward: more free questions, Scan a note, or Add money. The `/free` page gives a voucher as a QR code with Add to Forge (kept in the vault, then added when the app opens), Copy and Print.
- **Cashu cards** (Android app only; on the website the row says a page cannot read cards and points to `/download`): Tap a card reads the card over NFC (the app's ForgeNfc plugin), shows what it holds and its mint, asks for its PIN (a wrong one shows the tries left) and how much (all of it by default), and shows what arrives and what the card's mint takes. The card then signs one swap and the phone makes it at the card's mint through the engine (`/v1/wallet/fund/card/*`), unblinds its eCash and adds it like any eCash: a top-up for the engine's own mint, Other mint for another. Change goes back onto the card in the same tap. Before the card signs, everything needed to finish without it is stored on the phone (`forge2.cards`), so a tap that breaks loses nothing: the swap is sent again, the mint's signatures are asked for again (NUT-09), or the next tap of the same card gives its signature again. The protocol is ported from flash-pos and tested against the applet's own transcript and vectors, a simulated card, and the local mints ([docs/PAYMENTS.md](docs/PAYMENTS.md)). Not yet tried with a real card.
- **Fedimint cards** (Android app only): Tap a Fedimint card pays through a till (fedimintcard's `till serve --pay-enabled`), paired once by scanning its pay code; the app keeps the till's token in the Android Keystore. The engine makes a Lightning invoice, the screen shows the price before the tap (what reaches the funds, the most the card pays, and the till's part), the phone relays the till's card commands to the card over the till's card link, and the till charges the card and pays the invoice. A payment is stored on the phone before the till hears of it and is never charged twice; one the till could not pay is given back to the same card with Get it back ([docs/PAYMENTS.md](docs/PAYMENTS.md)). Tested against a mock till; not yet tried with a real till and card.
- **Storage:** IndexedDB `forge2` for settings, conversations and attachments, on this phone only. Start fresh clears the memory and starts a new conversation; the old one stays in History.
- **History, burn and auto-delete:** History (from More) lists past conversations, newest first, with their first words, time and, when auto-delete is timed, a bar with the time left. Tap one to open it and ask a follow-up to continue it; the flame burns it. Burn on the answer screen removes the open conversation at once; Burn all now removes every one and what waits for the next question. Auto-delete is Never, On close, 1 hour, 1 day (the default) or 1 week, applied when the app opens and by a timer while it is open (`public/v2/core/history.js`).
- **Erase everything** (from More): shows the balance that would be lost with Take funds out, warns about eCash not yet saved, and needs the button held for two seconds. It removes all of the site's `localStorage`, `sessionStorage`, IndexedDB databases, caches and service workers (v2 and the Classic app share them), then checks that nothing is left (`public/v2/core/erase.js`). What each of these removes and what it cannot reach: [docs/PRIVACY.md](docs/PRIVACY.md#the-v2-app-what-it-keeps-and-how-it-removes-it).
- **Service worker:** `public/v2/sw.js`, scope `/v2/`, network first with a cached copy for offline. It also catches a photo shared to `/v2/share` and keeps it in its own cache only until the page takes it. v1's worker passes `/v2/` by. Only the worker's install creates its cache, so once Erase everything has removed it, nothing puts it back.
- **Strings:** every word is in `public/v2/strings/en.js`, the printed notes' words too.
- **Engine:** More, Engine sets the address questions and payments go to (HTTPS only; the engine must answer before the app switches). The website's default is its own engine.
- **Android app:** `android/` wraps the v2 app in Capacitor, with its files in the APK, application id `com.forgereserve.ai`, Android 9 and up, no Google services. It takes photos shared from other apps into Share unseen and shares out through Android's share sheet. `scripts/android-release.sh` signs a release with the owner's keystore, and `/download` offers the APK set in `FORGE_APK_PATH` with its SHA-256. A second APK, **Forge Private Voice** (`com.forgereserve.ai.privatevoice`, the `privatevoice` flavour, 68 MB more), hears Hold to talk with its own speech to text on the phone (Moonshine tiny through sherpa-onnx), for GrapheneOS, which has no recogniser; `FORGE_APK_PRIVATE_VOICE_PATH` makes `/download` offer it beside the universal one. See [docs/ANDROID.md](docs/ANDROID.md) and [docs/VOICE.md](docs/VOICE.md).
- **iPhone app:** `ios/` wraps the same bundle in Capacitor iOS, bundle id `com.forgereserve.ai`, iPhone only, iOS 16.4 and up. Only the status bar is native; sharing, voice and Hold to talk work as in Safari, and the card ways are left out. Built and walked in the Simulator only. See [docs/IOS.md](docs/IOS.md).

### Printing free question vouchers

`scripts/issue-credits.ts` prints vouchers of free questions from a credit mint on the same computer (minting is open only there; see [deploy/credit-mint](deploy/credit-mint/README.md)):

```bash
pnpm issue-credits --mint http://127.0.0.1:3348 --public-mint https://credits.forge-reserve.com --count 50 --questions 3
```

`--mint` must be on this computer. The vouchers carry `--public-mint`. Credits cost nothing to make, so nothing is paid. It writes one sheet in the paper note layout with file mode 0600, with words that say the vouchers are free questions, not money. Vouchers never go to the terminal.

### Printing paper notes

`scripts/print-notes.ts` makes a batch of notes to hand out:

```bash
pnpm print-notes --count 20 --amount 1.00              # 20 notes of $1.00 at the Forge mint
pnpm print-notes --count 10 --amount 1000 --unit sat --out event.html
pnpm print-notes --resume event.html.pending.json      # carry on with a batch that was stopped
```

It asks the mint for one Lightning invoice for the whole batch, shows it (as text and as a code in the terminal) and waits until it is paid. Then it mints the eCash, one token per note, and writes one printable HTML sheet with file mode 0600: each note is a QR code with its amount, a short how-to line and a random serial that means nothing. The sheet loads nothing from anywhere. Tokens never go to the terminal or a log; only the sheet holds them. Mode 0600 means only your user account on this computer can open the file; it does not keep out an administrator, a backup or a synced folder. Print it, cut the notes apart, then delete the file.

Before the invoice is shown, the batch (the quote and a fresh seed the eCash is made from) is written to `<out>.pending.json`, mode 0600, and removed once the sheet is written. If the script stops after the payment, `--resume` finishes it. The batch file is removed when the invoice expires only once the mint answers that it is still unpaid; when the mint cannot be reached, the file is kept for `--resume`; if the mint signed but its answer was lost, the eCash is restored from the seed (NUT-09) and checked unspent. `--mint` points it at another mint (the tests use the local one). The default is the mint the engine trusts by default.

## Logs and privacy

Logs are JSON lines with request id, model, supplier, token counts, cost, status and latency. Prompt and completion content is never logged or stored. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Tests

```sh
pnpm typecheck
pnpm test                 # unit tests
pnpm mint:up && pnpm test:e2e && pnpm mint:down    # end to end against real local Nutshell mints
pnpm test:ui              # the v2 app in a 412 x 915 browser (installed Chrome, no download); needs pnpm mint:up
pnpm test:ui:linux        # the same UI suite in Linux, as CI runs it (Docker); needs pnpm mint:up. Run it before pushing a change a phone sees
cd android && ./gradlew assembleUniversalDebug assemblePrivatevoiceDebug testUniversalDebugUnitTest testPrivatevoiceDebugUnitTest   # the Android apps (Android SDK, JDK 17)
pnpm test:live            # optional; needs TOKENFACTORY_API_KEY (read from .env if present)
```

CI (`.github/workflows/ci.yml`) runs all of these except the live tests on every pull request and every push to `main`, read-only and without credentials, in parallel jobs: type-check and unit tests, end to end, the Android apps, and the UI suite in six parts dealt by recorded time (`scripts/ui-split.ts`, `test/ui/timings.json`). A pull request that only changes docs or a native app skips the jobs it cannot affect, and each UI test file it adds or changes runs 5 more times. The one check to require is `ci-ok`. [docs/CI.md](docs/CI.md) explains the jobs, the rules and how to run them locally; `test/unit/ci.test.ts` and `test/unit/images.test.ts` test them.

**Before pushing a UI change, run `pnpm test:ui:linux`.** A UI test that passes on a Mac can fail in CI for reasons of the machine, not the code: its fonts, its touch events, its speed. `scripts/ui-linux.sh` runs the suite (or the files you name, with any Vitest arguments) in Playwright's pinned Ubuntu image with DejaVu Sans as the fallback font, as on the GitHub runner, against the mints already running on the Mac (Docker Desktop's host networking must be on). The app serves its own font (Inter, `scripts/vendor-inter.sh`), so text has the same metrics on a Mac, on Linux and on phones; a test that measures layout waits for `document.fonts.ready`.

`test/unit/files.test.ts` covers the attachment helpers (file types, text decoding and binary refusal, `.docx` unzip and text, `<file>` blocks, the 200,000-character budget, estimates). `test/unit/sw.test.ts` and `test/e2e/pwa.e2e.test.ts` cover the service worker version and shell list, `/sw.js`, manifest, icons and offline page headers; `test/e2e/files-privacy.e2e.test.ts` checks that file text reaches the supplier (or the enclave, encrypted) and never the logs or the database.

`test/unit/v2/` covers the v2 logic: the module registry (manifest checks, kind isolation), the engine client (stream parsing, 402, 428 proof of work, private models only through the encrypting fetch), the vault (a token is stored before it is sent and kept until credited, refused or pending), ring maths, prices, routes, the string table's copy rules and the looks' text contrast. `test/ui/v2.ui.test.ts` drives `/v2/` with Playwright (`playwright-core`, `channel: 'chrome'`) against a local gateway with the mock supplier and the local mints: fund with a test token and an invite, ask a typed question, read the streamed answer, see the gold ring move, plus Lightning funding, taking funds out, errors, files, a v1 balance carried over, and 360 px layout. `test/ui/note.ui.test.ts` scans paper notes through Chrome's fake camera (a Y4M video of the QR code, made by `test/ui/camera.ts`), so the app's own camera adapter and v1's scanner read it: a still and an animated code, the balance rising, a used note, a note from another mint handed to Other mint, and paste. `test/unit/v2/note.test.ts` covers reading a note (checked against cashu-ts) and what the phone says about it; `test/unit/print-notes.test.ts` and `test/e2e/print-notes.e2e.test.ts` cover the print script, the second against the local mint (invoice, 0600 sheet, working notes, no token on the terminal, resume and restore). `test/unit/v2/voice.test.ts` covers hold to talk: the recorder state machine (hold, tap, slide off, longest length), WAV encoding (checked against the gateway's own reader), sentence chunking for speech, voice prices, which voice module is used, the engine client's audio calls and the voice modules with a fake microphone and speaker. `test/unit/audio.test.ts` and `test/e2e/audio.e2e.test.ts` cover the audio routes: recording length, pricing per request, refunds on failure, size and length limits, a sat balance, and no audio or text in the log or database. `test/ui/voice.ui.test.ts` holds the talk button in Chrome with its fake microphone (a beep, through the app's own microphone adapter): the price before sending, release to send, the question as text, the answer read aloud and replayed from memory, a tap, sliding off, the keyboard, reading aloud off, a failed transcription, and no private voice model. `test/unit/v2/history.test.ts` covers History and auto-delete (the five choices, timing on a fake clock for each, on close at open, a conversation started after the last check) and Erase everything against fake browser storage (nothing left, databases the browser cannot list, a database held open elsewhere). `test/ui/history.ui.test.ts` burns one conversation from the answer screen and one from History, burns all (with what waits for the next question), runs auto-delete on open and by its timer, and erases everything with a held button (Classic's worker, caches and settings included); after each it reads every IndexedDB store, every cache entry, `localStorage` and `sessionStorage` and finds nothing of what was removed. `test/unit/v2/photo.test.ts` covers Share unseen with real camera files in `test/unit/fixtures/photos/` (a CC0 phone photo with GPS, a public domain portrait with three faces; sources in its README): every hidden detail read and taken out with the picture's bytes left as they were, PNG and WebP notes, cover block maths, the writing finder on drawn number plates (and nothing on plain pictures or fences), the face filter's boxes, the filter chain (order, a failed or hung filter) and its list of changes, and the share target in the manifest and the worker. `test/ui/photo.ui.test.ts` runs it in Chrome: the three faces found and covered, blocks added and taken away by tap and drag, the file given to a stand-in share sheet (or downloaded) has no hidden details and every block solid black in its pixels, the same file comes out whatever is under the blocks, no request is made, Ask about it, and a photo shared in through the worker (and without it, where the gateway drops it). `test/e2e/v2-share.e2e.test.ts` covers what the gateway serves for it. `test/unit/v2/firstrun.test.ts` covers the first run's steps and routes, when it shows (once, only on a plain open of the home), which ways to pay it shows, and the price line's Free wording. `test/ui/addfunds.ui.test.ts` drives Add money as wallet cards: every card (screenshots under `.tmp/addfunds-c/`), the info lines and Listen, tabs, a touch swipe and the arrow keys, reduced motion, the order (Start free, the way used last, a More way promoted), no scrolling and 48 px targets at 360 x 640 and 412 x 915, Start free with its question and Keep Private only, the home at $0 on a paid and on a free model, and Funds with Take funds out; `test/ui/ways.ts` opens a way from the cards for the other UI tests. `test/ui/firstrun.ui.test.ts` walks it in Chrome on a clean profile (every step, Back, the invite code carried to Add funds, Start, and that it does not show again after a reload; Skip; a deep link past it; Private only turned back on; Listen with a stand-in phone voice and no request to the engine; 360 px; back after Erase everything), and checks the empty states and the price on Ask again and Try again. The other UI tests open the app as a phone that has seen the first run (`test/ui/firstrun-seen.ts`).

The free tier: `test/unit/free.test.ts` covers its settings (off by default), the free question rules, keyset expiry, the faucet's drip, difficulty and proof-of-work check, and the faucet itself on a fake clock (a wrong answer, a stale or reused puzzle, a reused claim, the per-address limit kept only as keyed hashes, an empty drip and day, a failed mint that keeps the ticket). `test/e2e/free.e2e.test.ts` runs it against the local credit mint: a voucher opens a free balance without an invite, one credit per answered question and none for a failed one, the caps, a paid model and speech refused, credits per request refused, a free balance taken out only as credits, money and credits never on each other's balance (Lightning included), credits refused by other-mint funding, expired keysets, revenue, and the faucet (off, on, a claim, replays, a stale puzzle, the address limit, an empty day). `test/unit/issue-credits.test.ts` and `test/e2e/issue-credits.e2e.test.ts` cover the issuing script, `test/unit/credit-mint-deploy.test.ts` the deployment files. `test/unit/v2/free.test.ts` covers which balance pays, the "of 3" count, the ring segments, the faucet client and vouchers in the vault; `test/ui/free.ui.test.ts` gets free questions in the app and on `/free`, uses them, and checks the ways forward, a pasted voucher beside a paid balance and a scanned one.

`docker-compose.test.yml` runs four FakeWallet mints (one compose project, `forge-ai`, from any checkout or worktree): `mint-a` (the Forge mint in tests), `mint-b` (an untrusted mint), `mint-c` (a "foreign" mint with input fees, for other-mint funding) and `mint-credit` (the credit mint for the free tier, usd only, port 3341). On-chain funding is tested against `test/e2e/onchain-mock.ts`, a NUT-30 proxy over `mint-a` that follows the Forge Nutshell branch's request and response shapes.

The admin tests (`test/unit/admin.test.ts`, `test/e2e/admin.e2e.test.ts`) cover access control (404 when off, 401 on a missing or wrong token, failed-login limit, Origin and JSON checks, no CORS), invites and revoke, the waitlist invite and delete, freeze (spending blocked, refunds allowed), revenue export (never above sweepable, locked export redeemable only with the key, history with token hash and no token, crash after the swap finished once by recovery) and overview numbers against the ledger.

The e2e suite covers the 402 flow with change, sat pricing, topup, spend, refund, wrong mint, wrong unit, double spend, client disconnect mid-stream, upstream failure and retries, a non-stream body that fails after `200` headers (settled at once, nothing charged, change returned), flat pricing, invite gating, crash recovery (both NUT-19 replay and NUT-09 restore), P2PK-locked change and refunds (locked to the key: a plain wallet and the gateway's own wallet cannot redeem them, the key holder can; invalid keys 400; crash after a locked swap recovered by replay, by NUT-09 restore of the stored blinded messages, and left owed when neither answers), funding by Lightning (quote, paid, minted, credited; restart mid-quote; crash after the mint with replay and with restore; concurrent polls credit once), by other-mint eCash (fees shown, credit exact, change returned, cross-unit, crash after the swap and after the melt, refund when the melt no longer fits, quote expiry frees the invite, deny list, plain-http mints refused) and on-chain against the mock (NUT-20 locked quotes, repeated deposits, crash after the mint), and EHBP pass-through against a fake enclave (usage from header and from HTTP trailer; a non-stream body that fails after `200` headers charges nothing, flat pricing included, and returns the full change).

## License

MIT. See [LICENSE](LICENSE).
