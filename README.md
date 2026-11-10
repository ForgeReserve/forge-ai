# Forge AI

Forge AI is an OpenAI-compatible AI gateway that charges per request in Cashu eCash. Point any OpenAI client at it, pay with eCash from the Forge mint, and it forwards the request to a pluggable upstream supplier. Licensed Apache-2.0.

Two ways to pay:

- **Per request (NUT-24).** Call the API with no credentials. You get `HTTP 402` with an `X-Cashu` header holding a NUT-18 payment request. Retry with `X-Cashu: cashuB...`. The gateway runs the request, charges the actual cost, and returns the unused value as eCash change. No account, no key.
- **Prepaid balance.** Send an eCash token to `POST /v1/wallet/topup` and get an `sk-forge-...` key. Use it as a normal bearer key. Withdraw the remainder as eCash at any time.

## How it differs from Routstr

[Routstr](https://github.com/routstr/routstr-core) is the established Cashu-paid AI proxy. Forge AI makes different choices:

| | Forge AI | Routstr (routstr-core, checked 2026-11-09) |
| - | - | - |
| License | Apache-2.0 | GPL-3.0 |
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

The SQLite database in the `forge-data` volume is the gateway's eCash wallet. Back it up. See [docs/PAYMENTS.md](docs/PAYMENTS.md).

## Configuration

Environment variables, validated with zod at startup (`src/config.ts`):

| Variable | Default | Meaning |
| - | - | - |
| `FORGE_TRUSTED_MINTS` | `https://forge.flashapp.me` | Comma-separated mints whose eCash is accepted. Tokens from other mints get HTTP 400 |
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
| `TOKENFACTORY_API_KEY`, `TINFOIL_API_KEY` | | Supplier keys |

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
| `POST /v1/wallet/refund` | bearer key; optional `{"amount": N}` in whole units | `{token, amount, unit, status}`. Sub-unit remainders stay on the balance |
| `GET /v1/wallet/refunds` | bearer key | Every withdrawal with its token, for re-delivery |
| `GET /v1/change/{request_id}` | none (the id is an unguessable capability) | NUT-24 change for that request |

A balance has one unit, set by its first topup. Topping up with another unit is rejected.

### Other

- `GET /healthz`: liveness, current BTC/USD rate and age.
- `GET /attestation`, `GET /.well-known/hpke-keys`: Tinfoil attestation bundle and HPKE key config, proxied so browser clients can verify and encrypt through the gateway origin.

### Errors

OpenAI-style `{"error": {"message", "type", "code"}}`. Payment problems: `untrusted_mint`, `wrong_unit`, `insufficient_amount`, `token_spent`, `invalid_token` (400, per NUT-24); `insufficient_balance` (402); `invite_required`, `invite_used` (403); `mint_unavailable` (503, retry with the same token). Upstream failures charge nothing and return all NUT-24 change.

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

`revenue:export` never exports eCash that backs customer balances or unpaid change.

## Logs and privacy

Logs are JSON lines with request id, model, supplier, token counts, cost, status and latency. Prompt and completion content is never logged or stored. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Tests

```sh
pnpm typecheck
pnpm test                 # unit tests
pnpm mint:up && pnpm test:e2e && pnpm mint:down    # end to end against real local Nutshell mints
pnpm test:live            # optional; needs TOKENFACTORY_API_KEY (read from .env if present)
```

The e2e suite covers the 402 flow with change, sat pricing, topup, spend, refund, wrong mint, wrong unit, double spend, client disconnect mid-stream, upstream failure and retries, flat pricing, invite gating, crash recovery (both NUT-19 replay and NUT-09 restore), and EHBP pass-through against a fake enclave (usage from header and from HTTP trailer).

## License

Apache-2.0. See [LICENSE](LICENSE).
