# Forge AI

Forge AI lets people ask AI models questions and pay for each answer with eCash, without an account. It has a phone app made for people who read with difficulty, and an OpenAI-compatible API for developers.

- **No accounts.** No name, email or password. You pay with eCash (digital cash from a Cashu mint), per request or from a balance.
- **Private models** run in sealed hardware, and the app encrypts the question to that machine, so the gateway passes on data it cannot read. **Standard models** run at an ordinary supplier that can read the question. The app says which kind a model is before you use it.
- **Built from modules.** Ways to pay, voice in, voice out, photo filters, looks and modes are folders you can add to.

## Try it

- **The app:** https://ai.forge-reserve.com/v2/ works in the browser of any phone or computer. Hold one button and talk.
- **The API guide:** https://ai.forge-reserve.com/docs/
- **The module guide:** https://ai.forge-reserve.com/docs/modules/

The hosted gateway is invite only. Ask for an invite at https://ai.forge-reserve.com/beta/.

The hosted gateway charges the suppliers' cost with no margin: it runs with `FORGE_MARKUP=1`, and its hosting is paid by its operator. `FORGE_MARKUP` defaults to 1.25, so a gateway you run yourself adds 25 percent unless you change it. To check the hosted prices, compare each model's `pricing.usd_per_mtok` in https://ai.forge-reserve.com/v1/models with its `input_usd_per_mtok` and `output_usd_per_mtok` (and `cached_input` with `cached_input_usd_per_mtok`, where a model has one) in [config/models.json](config/models.json). [docs/PAYMENTS.md](docs/PAYMENTS.md#what-a-request-costs) lists the other figures to compare and where a charge can differ from the supplier's bill.

## Run it

```sh
git clone https://github.com/ForgeReserve/forge-ai.git
cd forge-ai
pnpm install --frozen-lockfile
pnpm mint:up
FORGE_TRUSTED_MINTS=http://127.0.0.1:3338 FORGE_MODELS_FILE=config/models.dev.json \
FORGE_DB_PATH=data/dev.db FORGE_INVITE_ONLY=false FORGE_FOREIGN_DISCOVERY_RELAYS= pnpm start
```

Open http://localhost:8787/v2/. [docs/DEVELOPING.md](docs/DEVELOPING.md) explains each step, test money, the checks and the layout of the repository.

## Read more

| To learn about | Read |
| - | - |
| Paying, Private and Standard models, what the operator can see | [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md), [docs/PRIVACY.md](docs/PRIVACY.md), [docs/PAYMENTS.md](docs/PAYMENTS.md) |
| Building on the API | [docs/API.md](docs/API.md) |
| Writing a module | [docs/modules/first-module.md](docs/modules/first-module.md) |
| The app, and the Android and iPhone apps | [docs/APP.md](docs/APP.md), [docs/ANDROID.md](docs/ANDROID.md), [docs/IOS.md](docs/IOS.md) |
| Running a gateway in production | [docs/OPERATING.md](docs/OPERATING.md) |
| The Fedimint receiver, and turning on Fedimint notes in top-ups (off by default) | [docs/FEDIMINT-RECEIVER.md](docs/FEDIMINT-RECEIVER.md) |
| Tests and CI | [docs/CI.md](docs/CI.md) |
| What is planned | [docs/ROADMAP.md](docs/ROADMAP.md) |
| The sealed engine, a separate project | [Bellows](https://github.com/ForgeReserve/bellows) |

## Contribute

Help is welcome, at the hackathon of 2 to 4 December 2026 and after it:

- **Guides:** an organisation's signed guidance, asked by voice on the phone. [docs/GUIDES.md](docs/GUIDES.md) lists pieces to build.
- **Cover games:** small games that hide the app in Playful mode. [docs/PLAYFUL.md](docs/PLAYFUL.md)
- **Modules:** a new look, photo filter or way to pay. [docs/modules/](docs/modules/README.md)

Report a security problem to **security@forge-reserve.com** ([SECURITY.md](SECURITY.md)). Forge AI is released under the MIT licence ([LICENSE](LICENSE)).
