# Developing Forge

## Run it yourself

You need Node 22.18 or later (CI and the Docker image use Node 24), pnpm, and Docker for the local test mints.

```sh
git clone https://github.com/ForgeReserve/forge-ai.git
cd forge-ai
pnpm install --frozen-lockfile
pnpm mint:up
FORGE_TRUSTED_MINTS=http://127.0.0.1:3338 \
FORGE_MODELS_FILE=config/models.dev.json \
FORGE_DB_PATH=data/dev.db \
FORGE_INVITE_ONLY=false \
FORGE_FOREIGN_DISCOVERY_RELAYS= \
pnpm start
```

Open http://localhost:8787/v2/ for the app.

- `pnpm mint:up` starts four local Cashu mints in Docker, on ports 3338 to 3341. Their eCash is test money. They keep running, and every checkout on your computer shares them. `pnpm mint:down` stops them.
- `config/models.dev.json` adds mock models that answer without any API key. The mock models are Standard models, so turn off Private only in the app to ask them.
- `FORGE_INVITE_ONLY=false` opens balances without an invite code.
- `FORGE_FOREIGN_DISCOVERY_RELAYS=` stops the gateway from reading public Nostr relays to find other mints.

To put test money in the app, run `pnpm test-token 50 usd` in another terminal. It prints an eCash token worth 50 cents from the local mint. Paste it in Add money, eCash.

The natural voice (about 68 MB) is not in the repository. `node scripts/phonon-model.ts` fetches it. Without it the app works and offers the other voices.

To use real models, set `TOKENFACTORY_API_KEY` and `TINFOIL_API_KEY`: `config/models.dev.json` lists the real models beside the mock ones. To run a gateway in production with Docker Compose and HTTPS, and for every setting, read [OPERATING.md](OPERATING.md).

## The API

The API speaks OpenAI chat completions at `https://ai.forge-reserve.com/v1`. Send a balance key as the API key, or pay each request with an eCash token. Speech to text, text to speech and funding routes are there too. With a balance key in `FORGE_KEY`, this asks a free model (from [API.md](API.md)):

```bash
curl -s https://ai.forge-reserve.com/v1/chat/completions \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model": "glm-5.3-flash", "messages": [{"role": "user", "content": "Say hello in five words."}]}'
```

The API guide shows how to open a balance, add funds, encrypt a question to a Private model, and use the OpenAI SDKs for JavaScript and Python.

## Modules

The app is built from modules. A module is a folder with a manifest and a JavaScript file. Six kinds ship today: ways to pay (`fund`), voice in, voice out, photo filters for Share unseen (`filter`), looks (colours) and modes (the home and answer screens). The gateway has modules too: suppliers of models and ways to fund a balance.

Start with [modules/first-module.md](modules/first-module.md). It builds a look and a photo filter step by step. Modules are not signed or sandboxed yet, so a new module reaches people as a pull request that adds it to the app ([modules/README.md](modules/README.md)).

## The phone apps

The Android and iPhone apps carry the same web app inside a Capacitor shell, with a few native parts (card taps, speech on the phone, sharing). The Android app is in `android/` ([ANDROID.md](ANDROID.md)). The iPhone app is in `ios/` ([IOS.md](IOS.md)). Both talk to `https://ai.forge-reserve.com` until you set another server in the app. [APP.md](APP.md) describes every part of the app.

## Bellows

[Bellows](https://github.com/ForgeReserve/bellows) ([site](https://bellows.forgereserve.org)) is a separate public project: an AI gateway that runs inside sealed hardware, so its operator cannot read questions. Its site says what stays sealed and where the limits are. The Forge app's engine client already answers its proof-of-work challenge.

## Run the checks

```sh
pnpm -s typecheck
pnpm -s test                     # unit tests
pnpm mint:up && pnpm test:e2e    # end to end, against the local mints
pnpm test:ui                     # the app in Chrome at phone size; needs the local mints
```

Before you push a change that a phone shows, run `pnpm test:ui:linux`: it runs the UI tests in Linux as CI does. If you change `docs/API.md` or `docs/modules/`, run `pnpm build:docs` and commit the pages it writes under `public/docs/`. CI runs on every pull request, and the one check that must pass is `ci-ok`. [CI.md](CI.md) explains the jobs and what each test suite covers.

## The repository

| Path | What is in it |
| - | - |
| `src/` | The gateway: one Node server (Hono, with SQLite through `node:sqlite`). `src/suppliers/` holds the model suppliers |
| `public/v2/` | The Forge app. Its modules are in `public/v2/modules/` |
| `public/` | The Classic chat page at `/`, the admin page (`public/admin/`), and the built docs (`public/docs/`) |
| `android/`, `ios/` | The Android and iPhone apps (Capacitor) |
| `config/` | The model catalogs: `models.json` and `models.dev.json` (with mock models) |
| `docs/` | Design and reference pages. `docs/modules/` is the module guide |
| `test/` | `unit/`, `e2e/` (local mints), `ui/` (Chrome), `live/` (a real supplier, needs a key), `support/` (fakes: mint, card, till) |
| `scripts/` | Build, vendor, test and printing scripts |
| `examples/` | A program that pays for a request end to end (`pnpm demo:agent`) |
| `deploy/` | Deployment files for the credit mint and the project website |
