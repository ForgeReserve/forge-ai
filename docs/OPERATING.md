# Running a gateway

This page is for people who run their own Forge AI gateway: the production stack, every setting, the model catalog, the suppliers, the admin command line, and the scripts that print paper notes and vouchers. For a first local run, see the README's "Run it yourself". The public API is in [API.md](API.md), the admin page in [ADMIN.md](ADMIN.md), and how money moves in [PAYMENTS.md](PAYMENTS.md).

## A local gateway with a test mint

```sh
pnpm install --frozen-lockfile
pnpm mint:up                                  # four local Nutshell mints with FakeWallet (usd and sat)
export FORGE_TRUSTED_MINTS=http://127.0.0.1:3338 FORGE_MODELS_FILE=config/models.dev.json FORGE_DB_PATH=data/dev.db
pnpm start &                                  # http://localhost:8787
pnpm admin invites:create                     # prints an invite code
pnpm test-token 50 usd                        # prints a test eCash token worth 50 cents
```

The agent demo pays for a request end to end over NUT-24:

```sh
FORGE_URL=http://localhost:8787 FORGE_INVITE=inv-... DEMO_FAKE_MINT=1 pnpm demo:agent "What is eCash?"
```

`config/models.dev.json` adds an in-process mock supplier (`mock-echo`, `mock-slow` and a few others) so everything works without upstream keys. Set `TOKENFACTORY_API_KEY` and `TINFOIL_API_KEY` to use the real suppliers. `pnpm start` does not read `.env`; export the variables in the shell, or use the production stack below.

`docker-compose.test.yml` runs the four FakeWallet mints as one compose project, `forge-ai`, shared by every checkout and worktree on the computer: `mint-a` on port 3338 (the Forge mint in tests), `mint-b` on 3339 (an untrusted mint), `mint-c` on 3340 (a "foreign" mint with input fees, for other-mint funding) and `mint-credit` on 3341 (the credit mint for the free tier, usd only). Their eCash is test money: their invoices are paid on their own.

## Production

`docker-compose.yml` runs the gateway behind Caddy with automatic HTTPS. Replace the domain names in `Caddyfile` with your own, copy `.env.example` to `.env` and fill it in, then:

```sh
docker compose up -d
docker compose exec gateway node src/admin.ts invites:create --count 10
```

`docker compose` needs `FORGE_ADMIN_BASIC_AUTH_HASH` in `.env` for the admin page's basic auth; see [ADMIN.md](ADMIN.md).

The SQLite database in the `forge-data` volume is the gateway's eCash wallet. Back it up. See [PAYMENTS.md](PAYMENTS.md).

## Configuration

Environment variables, validated with zod at startup. `src/config.ts` is the complete list; this table has the ones an operator is likely to set.

| Variable | Default | Meaning |
| - | - | - |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Where the gateway listens |
| `FORGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
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
| `FORGE_FREE_VOICE_PER_DAY` | `20` | Free voice questions: speech to text served free to a balance that cannot pay for it, this many per balance per UTC day ([PAYMENTS.md](PAYMENTS.md)). `0`: off |
| `FORGE_FREE_VOICE_BUDGET_USD` | `5.00` | The most the operator pays for free voice questions per UTC day, at the supplier's cost. `0`: off |
| `FORGE_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting (set behind Caddy) |
| `FORGE_UPSTREAM_TIMEOUT_MS` / `FORGE_UPSTREAM_RETRIES` | `180000` / `2` | Time to upstream response headers (a timeout is final); retries only failures before the request was sent (refused, DNS, connect timeout, certificate), plus 408, 425, 429, 5xx and resets for a supplier with `idempotencyHeader` |
| `FORGE_FUND_MINT` | first trusted mint | Mint used for Lightning, on-chain and other-mint funding |
| `FORGE_LIGHTNING_ENABLED` | `true` | Lightning funding (NUT-04 bolt11 quotes) |
| `FORGE_FUND_MAX_SAT` / `FORGE_FUND_MAX_USD` | `1000000` / `50000` | Largest Lightning funding, in sat / cents (the mint's own limit also applies) |
| `FORGE_MINT_QUOTE_CHECKS_PER_MIN` | `12` | Mint quote checks per minute across all fundings: the gateway's one address shares the mint's own rate limit |
| `FORGE_ONCHAIN_ENABLED` | `false` | On-chain funding (NUT-30). Off until tested against the live mint |
| `FORGE_ONCHAIN_CONFIRMATIONS` | `3` | Confirmations shown to users; the mint decides when a deposit is paid |
| `FORGE_ONCHAIN_WATCH_DAYS` | `30` | How long an on-chain address is watched for deposits |
| `FORGE_ESPLORA_URL` | unset | Optional Esplora API used to show unconfirmed deposits. Unset: the gateway asks only the mint |
| `FORGE_FOREIGN_ENABLED` | `true` | Accept eCash from other mints (melted into a Forge Lightning quote) |
| `FORGE_CONVERT_ENABLED` | `true` | Accept eCash from Forge's own mints in the other unit (a sat token for a usd balance, or the reverse): melted at its mint into a Forge Lightning quote in the balance's unit, at the mint's price, after the person sees the quote |
| `FORGE_FOREIGN_POLICY` | `discovered` | Which other mints are accepted. `discovered`: the operator list (`FORGE_FOREIGN_ALLOW` and mints added on the admin page) plus mints found through NIP-87 reviews (below). `allowlist`: the operator list only. `any`: every https mint, limited to `FORGE_FOREIGN_ALLOW` when that is set. `FORGE_FOREIGN_DENY` always wins |
| `FORGE_FOREIGN_ALLOW` / `FORGE_FOREIGN_DENY` | empty | Operator list of accepted mints (the admin page can add more), and mints never accepted |
| `FORGE_FOREIGN_UNLISTED` | `true` | Under `discovered` and `allowlist`, let a customer fund from a mint that is not accepted after a warning (`mint_unlisted`, then `accept_unlisted: true`), with the lower cap below. `false`: such mints get `mint_not_allowed` |
| `FORGE_FOREIGN_UNLISTED_MAX_SAT` / `FORGE_FOREIGN_UNLISTED_MAX_USD` | `5000` / `500` | Largest token from an unlisted mint, in sat / cents. The other-mint cap still applies when lower |
| `FORGE_FOREIGN_MIN_REVIEWERS` | `2` | Distinct verified NIP-87 reviewers a discovered mint needs |
| `FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT` | `false` | Also require the mint's own verified kind 38172 announcement (few mints publish one today) |
| `FORGE_FOREIGN_DISCOVERY_RELAYS` | `wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net` | Nostr relays read for mint announcements (kind 38172) and reviews (kind 38000). Empty: no discovery |
| `FORGE_FOREIGN_DISCOVERY_TTL_MINUTES` | `60` | How long a discovered list is served before a background refresh (a failed refresh retries after a minute) |
| `FORGE_FOREIGN_MAX_DISCOVERED` | `25` | Most discovered mints accepted at once, best reviewed first |
| `FORGE_FOREIGN_MAX_SAT` / `FORGE_FOREIGN_MAX_USD` | `100000` / `5000` | Largest token from another mint, in sat / cents |
| `FORGE_FUND_MAX_PENDING` | `5` | Unfinished fundings per balance |
| `FORGE_FEDIMINT_URL` | unset | The Fedimint receiver, e.g. `http://fedimint-receiver:8790`. Set: `POST /v1/wallet/topup` takes Fedimint notes of the joined, active federations ([FEDIMINT-RECEIVER.md](FEDIMINT-RECEIVER.md#turning-it-on)). Unset or empty: off |
| `FORGE_FEDIMINT_TOKEN` | unset | The receiver's bearer token (its `FEDIMINT_RECEIVER_TOKEN`; `docker-compose.yml` passes that one unless this is set). Required with the URL |
| `FORGE_FEDIMINT_MAX_SAT` | `100000` | Largest Fedimint top-up, in sat of face value. A federation's own `--max-sat` may be lower |
| `FORGE_FEDIMINT_FEDERATION_CAP_SAT` | `1000000` | Most Forge holds of one federation, in sat; a top-up that would go over is refused. A federation's own `--cap-sat` overrides it |
| `FORGE_ADMIN_TOKEN_HASH` | unset | SHA-256 (hex) of the admin token. Unset: `/admin` answers 404. See [ADMIN.md](ADMIN.md) |
| `FORGE_ADMIN_ORIGIN` | request `Host` | Origin admin changes must come from |
| `FORGE_ADMIN_RATE_LIMIT_RPM` | `120` | Admin API requests per minute per IP |
| `FORGE_CREDIT_MINT` | unset | The credit mint for free questions ([FREE-TIER.md](FREE-TIER.md)). Unset: the free tier is off and credits are refused like any unknown mint. It must not be one of `FORGE_TRUSTED_MINTS` |
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
| `FORGE_APK_PATH` | unset | The signed Android APK `/download` offers ([ANDROID.md](ANDROID.md)). Unset: the page says the app is coming |
| `FORGE_ANDROID_CERT_SHA256` | unset | SHA-256 fingerprints of the APKs' signing certificates, comma separated. Set: `/.well-known/assetlinks.json` links both apps, so event links (`/j#<pass>`) open in the app. Unset: that file is 404 |
| `FORGE_APK_PRIVATE_VOICE_PATH` | unset | The signed Forge Private Voice APK (for GrapheneOS). Set: `/download` offers Android or GrapheneOS. Unset: that choice is hidden |
| `FORGE_IOS_URL` | unset | The iPhone app's link, a TestFlight invitation or the App Store page, https only ([IOS.md](IOS.md), Getting the app). Set: `/download/info` carries it and Get the app on an iPhone opens it. Unset: an iPhone is shown how to put Forge on its Home Screen |
| `TOKENFACTORY_API_KEY`, `TINFOIL_API_KEY` | | Supplier keys, named by `apiKeyEnv` in the model catalog |

### Other mints (NIP-87 discovery)

Under `FORGE_FOREIGN_POLICY=discovered` the gateway accepts eCash from the mints the operator lists plus the mints Cashu wallets recommend, found the way wallet.cashu.me finds them: kind 38172 mint announcements and kind 38000 reviews (`#k=38172`) from `FORGE_FOREIGN_DISCOVERY_RELAYS`. Event ids and BIP-340 signatures are checked, reviews older than 24 months are ignored, and a reviewer counts once per mint. A mint is accepted when it has at least `FORGE_FOREIGN_MIN_REVIEWERS` distinct reviewers (plus a verified mainnet announcement when `FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT=true`) and passes a probe: `GET /v1/info` and `GET /v1/keysets` answer, an active keyset exists in a Forge unit, and NUT-05 bolt11 melt is enabled in that unit (the gateway melts the eCash there). The list is kept in the database, served at once after a restart, and refreshed in the background; a request never waits on a relay. The URL safety check still runs on every accepted mint, and again whenever the gateway loads that mint's wallet; no Cashu request follows a redirect. The code is ported from cashucard/cashucard `ops/src/discovery.ts`.

The operator can add mints from the admin page (Settings, Other mints). An added mint goes through the URL safety check and the same probe, keeps the name from its `/v1/info`, is stored in the `operator_mints` table and is accepted like `FORGE_FOREIGN_ALLOW` under every policy (under `any` it never limits the policy). Forge's own mints and denied mints cannot be added. Both kinds are listed with `source: "operator"`.

A customer can still use a mint that is not on the list (`FORGE_FOREIGN_UNLISTED=true`, policy `discovered` or `allowlist`). The first quote answers 409 `mint_unlisted` with `{unlisted: {mint, max: {sat, usd}}}`; the chat app shows an inline warning with the mint and the cap, and **Continue** resends the quote with `accept_unlisted: true`. The mint must then pass the live probe (results are cached for 10 minutes, a failure for 1 minute), the token is capped at `FORGE_FOREIGN_UNLISTED_MAX_SAT` / `_USD`, and the funding is marked unlisted (`fundings.f_unlisted`, `foreign.unlisted` in the funding view, a badge on the admin Fundings page). Denied mints are always refused.

## Model catalog

`config/models.json` lists suppliers and models. Each model has a public `id`, its `supplier`, the `upstream` model name, the supplier's cost in USD per million input and output tokens, `max_output_tokens`, and `uncensored` (the chat page hides those behind an explicit toggle). A model with `"pricing": "free"` (and a `free_reason`) costs users nothing and carries no token price: every Token Factory model is free while Token Factory charges Forge nothing during its beta. A free model needs a balance key and is never held or charged; see [PAYMENTS.md](PAYMENTS.md), Free models. When the beta ends, set those models back to paid with prices from the Token Factory rate card. Tinfoil prices were read from `https://inference.tinfoil.sh/v1/models` on 2026-11-09. A model can also set `cached_input_usd_per_mtok`, the supplier's price per million input tokens served from its prompt cache, at most the input price: the shipped catalog sets it for the three Tinfoil models whose rate card listed one on 2026-11-20 ([PAYMENTS.md](PAYMENTS.md), Cached input). [Engine modules](modules/engine.md) describes every field.

The optional `audio` list holds speech to text (`kind: "transcription"`) and text to speech (`kind: "speech"`) models. Each is priced per request: `request_usd` (the supplier's cost per request), plus `usd_per_second` of audio in or `usd_per_kchar` (per 1,000 characters) of text out, with `FORGE_MARKUP` on top. A transcription model sets `max_seconds` and the `formats` it takes (`wav` only, since a WAV file states its own length); a speech model sets `max_chars` and its `voices` (the first is the default). The shipped catalog lists Tinfoil's `whisper-large-v3-turbo` (0.01 USD a request) and `voxtral-tts` (0.002 USD a request), read from Tinfoil's public model config (`https://api.tinfoil.sh/api/config/models`) on 2026-11-13.

A supplier sets `pricing: "metered"` (charge on reported usage) or `pricing: "flat"` (charge a schedule by request body size plus declared max output). A metered request holds the model's own metered worst case (input estimated from the body plus max output, at the model's prices with markup), and a response without a usage count is charged that worst case, never more than the hold. A `flat` schedule on a metered supplier is ignored. `GET /v1/models` lists the hold figures under `pricing.hold`; see [PAYMENTS.md](PAYMENTS.md), The funds hold.

A resent request can run, and bill, a second time upstream, so a request that may have reached the supplier is never resent blindly. A supplier that documents de-duplication by an idempotency key can set `idempotencyHeader` (for example `"Idempotency-Key"`): every plaintext request then carries a fresh key, the same on each of its attempts, and retryable statuses and resets are retried. No shipped supplier sets it.

## Suppliers

| Supplier | Tier | How |
| - | - | - |
| Token Factory | standard | OpenAI-compatible LiteLLM proxy at `https://gateway.trytokenfactory.dev/v1`. Its models are free to users during Token Factory's beta (`pricing: "free"`) |
| Tinfoil | enclave | Plaintext OpenAI-compatible calls, or EHBP encrypted pass-through (see [PRIVACY.md](PRIVACY.md)) |
| mock | standard | In-process, deterministic, for tests and local demos |

Add a supplier by implementing `Supplier` in `src/suppliers/types.ts` (one `chat()` method for OpenAI-compatible upstreams, plus `transcribe()` and `speech()` if it serves audio) and registering its `type` in `src/suppliers/index.ts`. The OpenAI-compatible and Tinfoil suppliers implement both audio calls. [Engine modules](modules/engine.md#adding-a-supplier) walks through it.

## Admin command line

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
pnpm admin fedimint:join [--max-sat N] [--cap-sat N] < invite.txt   # join a federation (invite on stdin, never printed)
pnpm admin fedimint:list                               # federations: state, caps, joined, balance, pending, stuck
pnpm admin fedimint:pause <federation-id>              # stop taking its notes; fedimint:resume takes them again
```

`revenue:export` never exports eCash that backs customer balances or unpaid change. Exports are recorded in `revenue_exports` (amount, lock, token hash; never the token). The admin page at `/admin/` does the same tasks and more; see [ADMIN.md](ADMIN.md).

## Printing paper notes

`scripts/print-notes.ts` makes a batch of notes to hand out:

```bash
pnpm print-notes --count 20 --amount 1.00              # 20 notes of $1.00 at the Forge mint
pnpm print-notes --count 10 --amount 1000 --unit sat --out event.html
pnpm print-notes --resume event.html.pending.json      # carry on with a batch that was stopped
```

It asks the mint for one Lightning invoice for the whole batch, shows it (as text and as a code in the terminal) and waits until it is paid. Then it mints the eCash, one token per note, and writes one printable HTML sheet with file mode 0600: each note is a QR code with its amount, a short how-to line and a random serial that means nothing. The sheet loads nothing from anywhere. Tokens never go to the terminal or a log; only the sheet holds them. Mode 0600 means only your user account on this computer can open the file; it does not keep out an administrator, a backup or a synced folder. Print it, cut the notes apart, then delete the file.

Before the invoice is shown, the batch (the quote and a fresh seed the eCash is made from) is written to `<out>.pending.json`, mode 0600, and removed once the sheet is written. If the script stops after the payment, `--resume` finishes it. The batch file is removed when the invoice expires only once the mint answers that it is still unpaid; when the mint cannot be reached, the file is kept for `--resume`; if the mint signed but its answer was lost, the eCash is restored from the seed (NUT-09) and checked unspent. `--mint` points it at another mint (the tests use the local one). The default is the mint the engine trusts by default.

## Printing free question vouchers

`scripts/issue-credits.ts` prints vouchers of free questions from a credit mint on the same computer (minting is open only there; see [deploy/credit-mint](../deploy/credit-mint/README.md)):

```bash
pnpm issue-credits --mint http://127.0.0.1:3348 --public-mint https://credits.forge-reserve.com --count 50 --questions 3
```

`--mint` must be on this computer. The vouchers carry `--public-mint`. Credits cost nothing to make, so nothing is paid. It writes one sheet in the paper note layout with file mode 0600, with words that say the vouchers are free questions, not money. Vouchers never go to the terminal.

## Logs

Logs are JSON lines with request id, model, supplier, token counts, cost, status and latency. Prompt and completion content is never logged or stored. See [PRIVACY.md](PRIVACY.md).
