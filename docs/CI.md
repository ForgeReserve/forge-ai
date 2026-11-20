# CI

One workflow, `.github/workflows/ci.yml`, on every pull request and every push to `main`. It is read-only: it deploys nothing, pushes nothing and holds no secrets. Every action is pinned by commit. A newer push to the same branch cancels the run before it.

## The check to require

Require **`ci-ok`** and nothing else. It always runs and always reports. It fails when a job failed or was cancelled, when a job was skipped although the change needs it, and when the rules (`changes`) did not run. It passes when every needed job passed and the others were skipped by the rules below. The other jobs make poor required checks: their names (`ui (3)`, `repeat (game.ui.test.ts)`) change from one change to the next, and a job the rules skip may never report the name a required check waits for.

## The jobs

| Job | What it does | When |
| --- | --- | --- |
| `changes` | Reads what the pull request changes (`scripts/ci-changes.ts`), sets what the other jobs run and writes the job summary: what runs and why. | Always |
| `check` | Type-check, unit tests, and `node scripts/ui-split.ts verify`: Vitest's own list shows each UI part's command runs its files and every UI file runs once. | Always |
| `e2e` | End to end tests against the local mints. | Unless only the native apps changed. A docs-only change runs `test/e2e/docs.e2e.test.ts` alone. |
| `ui (1)` to `ui (6)` | The UI tests in six parts, in the runner's Chrome against a local gateway and the local mints. Each part keeps its files' times as an artifact (`ui-times-<part>`). | Unless only the native apps changed. A docs-only change runs one job, `ui (docs)`, with `test/ui/docs.ui.test.ts` alone. |
| `android` | Debug builds of both APKs, their JVM tests, and the 16 KB page check. | When `android/`, `public/` (but not `public/docs/`) or `capacitor.config.json` changed, and on any change that runs everything. |
| `receiver` | The Fedimint receiver ([FEDIMINT-RECEIVER.md](FEDIMINT-RECEIVER.md)): `cargo fmt --check`, clippy and its tests against in-process federations, in `services/fedimint-receiver/`; then its two binaries built and the gateway's Fedimint top-ups end to end against them, driven by the gateway's API and by the v2 app's own top-up client (`pnpm test:fedimint`). | When anything under `services/fedimint-receiver/` changed, or the Fedimint top-up code (`src/fedimint.ts`, `src/fedimint-admin.ts`, `src/fedimint-invites.ts`, `test/fedimint/`, the app's `public/v2/core/fedinote.js`, `vault.js` and `engine.js`, and `public/vendor/noble.js`), and on any change that runs everything. |
| `repeat (<file>)` | Runs each UI test file the pull request added or changed 5 more times. | Pull requests that change a UI test file or a helper in `test/ui/`. |
| `ci-ok` | Checks the results above against what `changes` said. | Always |

`e2e`, `ui` and `repeat` start the local mints (`scripts/ci-mints.sh`) right after checkout, in the background, and wait for them just before the tests. The tests themselves are unchanged.

## What a change runs

The rules are in `scripts/ci-changes.ts` and tested in `test/unit/ci.test.ts`. They choose jobs by path, never tests by import: the app loads modules by name at run time, so following imports would miss things. When unsure, everything runs.

| Change | What runs |
| --- | --- |
| A push to `main` | Everything |
| Anything under `.github/` or `scripts/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `docker-compose.test.yml`, `vitest.config.*`, any `tsconfig*.json` | Everything (and `repeat` on a pull request) |
| Only docs: `docs/**`, `public/docs/**`, `*.md` outside `public/` | `check`, the docs page's own e2e and UI tests (`ui (docs)`); no Android, no repeat |
| Only `android/` | `check`, `android` |
| Only `ios/` | `check` (its unit tests read the iPhone project files; CI builds no iPhone app) |
| Only `services/fedimint-receiver/` | `check`, `receiver` |
| Native apps and docs, nothing else | `check`, the docs page's own tests, and `android` when `android/` changed |
| Anything else: `src/`, `public/`, `test/`, `config/`, a new top-level file | `check`, `e2e`, all six UI parts, `android` when `public/` or `capacitor.config.json` changed, and `receiver` when `services/fedimint-receiver/` or the Fedimint top-up code (`src/fedimint.ts`, `src/fedimint-admin.ts`, `src/fedimint-invites.ts`, `test/fedimint/`, `public/v2/core/fedinote.js`, `vault.js`, `engine.js`, `public/vendor/noble.js`) changed |
| The changes cannot be read, or the pull request lists no file | Everything |

A Markdown file under `public/` (the licences in `public/vendor/licenses/`, a sources list) is served and goes into the app bundle, so it counts as the web app, not as docs.

The Android bundle is made from `public/` (by `scripts/android-web.ts` and `scripts/lib/android-web.ts`), `capacitor.config.json`, the voice and speech files fetched by `scripts/phonon-model.ts` and `scripts/asr-model.ts`, and the Capacitor runtime in `node_modules` (`android/settings.gradle`). Everything outside `android/` that `android/app/build.gradle` reads is listed there.

## The receiver job

The Fedimint receiver is a Rust crate that compiles fedimint, RocksDB and AWS-LC, so its job runs only when its own directory or the Fedimint top-up code changes (`FEDIMINT_GATEWAY_PATHS` in `scripts/ci-changes.ts`: the gateway's `src/fedimint.ts`, its operator admin `src/fedimint-admin.ts`, its invite export `src/fedimint-invites.ts` and `test/fedimint/`, the v2 app's client that the end to end test drives, `public/v2/core/fedinote.js`, `vault.js` and `engine.js`, and `public/vendor/noble.js`, which the gateway's notes reader works out public keys with), or when everything runs (a push to `main`, a change to CI or the tooling). Any other gateway or app change does not pay for it: the unit tests run the gateway's Fedimint code against a stand-in receiver in every `check`, and a change that breaks the real pairing outside those paths is caught on the next push to `main`, not on its pull request.

After the receiver's own checks the job builds its two binaries with the same `ci` profile (`cargo build --features devfed --bins`, mostly linking: the dependencies are built by then), installs the gateway's packages, and runs `pnpm test:fedimint` with `FORGE_FEDIMINT_BIN_DIR` pointing at them. The file fails, never skips, when a binary is missing, and Vitest fails when the path holds no test file, so a green job means the test ran. Running on every push to `main` also keeps the cache fresh where pull requests can read it: a pull request reads the caches of its own branch and of `main`.

`actions/cache` keeps the Cargo registry and `services/fedimint-receiver/target` under a key from `Cargo.lock` and `rust-toolchain.toml`, so a run with the same lockfile builds only the receiver itself. The job builds with the crate's `ci` profile (no debug info, no incremental state) to keep the cache small. rustup installs the toolchain `rust-toolchain.toml` names. The job does not build the Docker image.

Measured on a Mac with Apple silicon (2026-11-19), `cargo test --profile ci`: from nothing, 175 seconds to compile, then about 30 seconds of tests; with the dependencies built and only the receiver changed, 43 seconds in all, tests included. The `ci` build of `target/` is 3.3 GB, which is what the cache holds. A GitHub runner has fewer cores, so expect a cold run of 10 minutes or more; the first CI runs will give the real figures. The gateway end to end step adds the binaries' build (2 minutes 42 seconds on the same Mac for a dev build of both from a cold target directory; far less once the tests have built the dependencies), the package install, and about 10 seconds of tests. The recovery drill (2026-11-20, same Mac, dev profile) adds one test binary to the crate (6 seconds to build and link it once the crate is built), about 30 seconds to the cargo tests, and about 13 seconds to `pnpm test:fedimint`; expect up to twice that on a runner.

## The UI split

`scripts/ui-split.ts` deals the UI test files into parts by their recorded times in `test/ui/timings.json`: longest first, each file into the part with the least time so far. A file missing from the record goes into the lightest part at the median time, so a new test file always runs; the job log names it. A recorded file that no longer exists is ignored and reported.

Vitest's own `--shard` sorts the files by a hash of their path and gives each part the same number of files, whatever they take. On `main` on 2026-11-17 that left `ui (1/2)` at 8.3 minutes of tests and `ui (2/2)` at 6.5. The natural voice's file (4.7 minutes alone) ran in a third job.

The natural voice's tests are now two files: `phonon.ui.test.ts` (the app, about 1:45) and `phonon-lab.ui.test.ts` (the voice lab, about 3:05), with what they share in `test/ui/phonon-setup.ts`. No test changed. The lab file is the longest single file, so it sets the floor for any part.

**Six parts**, chosen from the numbers: the UI files take about 18.5 minutes in all, and six parts of about 3:05 each put the longest file in a part of its own. With setup (about 1 minute, mostly the mints) each job takes about 4.5 minutes. Fewer parts are slower; more parts are not faster, since the lab file alone takes 3:05.

| Parts | Tests per part | Slowest UI job | Billed minutes for the UI jobs |
| --- | --- | --- | --- |
| Today (2 shards and the voice job) | 8.3, 6.5, 4.7 min | 9.4 min | about 24 |
| 4 | 4:38 | about 6 min | about 24 |
| 5 | 3:45 | about 5 min | 25 to 30 |
| **6** | **3:06** | **about 4.5 min** | **about 30** |
| 8 | 3:05 (the lab file) | about 4.5 min | about 40 |

GitHub bills each job by the minute, rounded up, and each job pays about a minute of setup. Six parts cost about 6 more minutes per run than today. Standard runners are free for a public repository.

To change the number of parts, change `PARTS` in `scripts/ui-split.ts`. The workflow's matrix comes from it.

### Refreshing the recorded times

Each UI part uploads a Vitest JSON report as the artifact `ui-times-<part>`. From a green run on `main`:

```sh
gh run download <run id> -R ForgeReserve/forge-ai -p 'ui-times-*' -D .tmp/ui-times
node scripts/ui-split.ts refresh .tmp/ui-times
git diff test/ui/timings.json      # then commit it in a pull request
```

`refresh` lays the new times over the record, drops files that no longer exist, says which files kept an old time, and prints the new plan. CI never commits the record itself. A local run gives a report too: `pnpm test:ui:linux --reporter=default --reporter=json --outputFile.json=.tmp/ui-times/local.json`. A Mac is faster than the runner, so prefer CI's times.

## The repeat job

A test that passes four times in five reaches `main` and turns it red later. On a pull request, `repeat` runs each UI test file the pull request added or changed 5 more times, on top of the normal run, with the same mints set-up. Every run goes to the end, and the job summary says how many passed.

- A changed file under `test/ui/` that is not a test file (a helper such as `ways.ts`) repeats every UI test file that imports it, directly or through another helper.
- At most 6 files are repeated: files changed themselves first, then those using a changed helper, the largest diff first. The `changes` summary lists the files left out.
- A long file's 5 runs are spread over several jobs, as many runs in a job as fit in 4 minutes and at least one, so a repeat job takes about as long as a UI part (`phonon.ui.test.ts` takes 3 jobs, `phonon-lab.ui.test.ts` 5). There are at most 12 repeat jobs.
- Deleted files, files outside `test/ui/`, and files with unusual names are not repeated. Helpers outside `test/ui/` (`test/e2e/helpers.ts`, `test/support/`) do not trigger repeats.

## The local mints in CI

Starting the four Nutshell mints took 40 to 79 seconds in each of four jobs. Measured from the logs of three green runs on `main`:

| Phase | Time |
| --- | --- |
| Downloading the image (452 MB compressed) | about 6 s |
| Unpacking it (1.1 GB, about 29,000 files, one layer after another) | about 35 s |
| Creating the four containers | 2 s (14 s once) |
| From started to healthy (four mints booting at once) | 10 to 16 s |

Unpacking, not the network, is most of it. Keeping the image in the Actions cache would not help: the runner's Docker 29 keeps images in the containerd store, where `docker load` unpacks the layers again, so it would save only the 6 s download. Tightening the health checks would save under a second, and changing `docker-compose.test.yml` makes every checkout's shared local mints restart on the next `pnpm mint:up`. Starting fewer mints is not safe: some tests skip quietly when a mint they want is missing.

So `scripts/ci-mints.sh` starts the mints right after checkout, in the background, while the job sets up Node, installs and fetches the voice files, and waits for them only before the tests. It keeps the 3 tries with a growing pause for Docker Hub's occasional 5xx, and its log gives the time of each phase and the image store.

Measured on the first two runs of this workflow (2026-11-17): the wait for the mints before the tests fell from 42 to 65 seconds to 26 to 29 seconds, the slowest UI part took 4.3 minutes, and a whole run took 4.9 minutes where it had taken about 9.5.

## Running the same things locally

```sh
node scripts/ci-changes.ts --base origin/main      # what CI would run for this branch, and why
node scripts/ci-changes.ts --paths docs/API.md      # what CI would run for these changed paths
node scripts/ui-split.ts plan                       # the six parts and their expected times
node scripts/ui-split.ts verify                     # every UI file in exactly one part (asks Vitest)
node scripts/ui-split.ts files 3 | xargs pnpm test:ui:linux   # part 3 in Linux, as CI runs it (needs pnpm mint:up)
for i in 1 2 3 4 5; do pnpm test:ui:linux test/ui/game.ui.test.ts || break; done   # the repeat job by hand
pnpm exec vitest run test/unit/ci.test.ts           # the rules' own tests
```

## The test suites

The commands, as you run them on your own computer:

```sh
pnpm typecheck
pnpm test                 # unit tests
pnpm mint:up && pnpm test:e2e    # end to end against real local Nutshell mints (they keep running for every checkout; pnpm mint:down stops them)
pnpm test:ui              # the v2 app in a 412 x 915 browser (installed Chrome, no download); needs pnpm mint:up
pnpm test:ui:linux        # the same UI suite in Linux, as CI runs it (Docker); needs pnpm mint:up. Run it before pushing a change a phone sees
cd android && ./gradlew assembleUniversalDebug assemblePrivatevoiceDebug testUniversalDebugUnitTest testPrivatevoiceDebugUnitTest   # the Android apps (Android SDK, JDK 17)
pnpm test:live            # optional; needs TOKENFACTORY_API_KEY (read from .env if present)
```

**Before pushing a UI change, run `pnpm test:ui:linux`.** A UI test that passes on a Mac can fail in CI for reasons of the machine, not the code: its fonts, its touch events, its speed. `scripts/ui-linux.sh` runs the suite (or the files you name, with any Vitest arguments) in Playwright's pinned Ubuntu image with DejaVu Sans as the fallback font, as on the GitHub runner, against the mints already running on the Mac (Docker Desktop's host networking must be on). The app serves its own font (Inter, `scripts/vendor-inter.sh`), so text has the same metrics on a Mac, on Linux and on phones; a test that measures layout waits for `document.fonts.ready`.

`test/unit/files.test.ts` covers the attachment helpers (file types, text decoding and binary refusal, `.docx` unzip and text, `<file>` blocks, the 200,000-character budget, estimates). `test/unit/sw.test.ts` and `test/e2e/pwa.e2e.test.ts` cover the service worker version and shell list, `/sw.js`, manifest, icons and offline page headers; `test/e2e/files-privacy.e2e.test.ts` checks that file text reaches the supplier (or the enclave, encrypted) and never the logs or the database.

`test/unit/v2/` covers the v2 logic: the module registry (manifest checks, kind isolation), the engine client (stream parsing, 402, 428 proof of work, private models only through the encrypting fetch), the vault (a token is stored before it is sent and kept until credited, refused or pending), ring maths, prices, routes, the string table's copy rules and the looks' text contrast. `test/ui/v2.ui.test.ts` drives `/v2/` with Playwright (`playwright-core`, `channel: 'chrome'`) against a local gateway with the mock supplier and the local mints: fund with a test token and an invite, ask a typed question, read the streamed answer, see the gold ring move, plus Lightning funding, taking funds out, errors, files, a v1 balance carried over, and 360 px layout. `test/ui/note.ui.test.ts` scans paper notes through Chrome's fake camera (a Y4M video of the QR code, made by `test/ui/camera.ts`), so the app's own camera adapter and v1's scanner read it: a still and an animated code, the balance rising, a used note, a note from another mint handed to the eCash box, priced there, and paste. `test/unit/v2/note.test.ts` covers reading a note (checked against cashu-ts) and what the phone says about it; `test/unit/print-notes.test.ts` and `test/e2e/print-notes.e2e.test.ts` cover the print script, the second against the local mint (invoice, 0600 sheet, working notes, no token on the terminal, resume and restore). `test/unit/v2/voice.test.ts` covers hold to talk: the recorder state machine (hold, tap, slide off, longest length), WAV encoding (checked against the gateway's own reader), sentence chunking for speech, voice prices, which voice module is used, the engine client's audio calls and the voice modules with a fake microphone and speaker. `test/unit/audio.test.ts` and `test/e2e/audio.e2e.test.ts` cover the audio routes: recording length, pricing per request, refunds on failure, size and length limits, a sat balance, and no audio or text in the log or database. `test/ui/voice.ui.test.ts` holds the talk button in Chrome with its fake microphone (a beep, through the app's own microphone adapter): the price before sending, release to send, the question as text, the answer read aloud and replayed from memory, a tap, sliding off, the keyboard, reading aloud off, a failed transcription, and no private voice model. `test/unit/v2/history.test.ts` covers History and auto-delete (the five choices, timing on a fake clock for each, on close at open, a conversation started after the last check) and Erase everything against fake browser storage (nothing left, databases the browser cannot list, a database held open elsewhere). `test/ui/history.ui.test.ts` burns one conversation from the answer screen and one from History, burns all (with what waits for the next question), runs auto-delete on open and by its timer, and erases everything with a held button (Classic's worker, caches and settings included); after each it reads every IndexedDB store, every cache entry, `localStorage` and `sessionStorage` and finds nothing of what was removed. `test/unit/v2/photo.test.ts` covers Share unseen with real camera files in `test/unit/fixtures/photos/` (a CC0 phone photo with GPS, a public domain portrait with three faces; sources in its README): every hidden detail read and taken out with the picture's bytes left as they were, PNG and WebP notes, cover block maths, the writing finder on drawn number plates (and nothing on plain pictures or fences), the face filter's boxes, the filter chain (order, a failed or hung filter) and its list of changes, and the share target in the manifest and the worker. `test/ui/photo.ui.test.ts` runs it in Chrome: the three faces found and covered, blocks added and taken away by tap and drag, the file given to a stand-in share sheet (or downloaded) has no hidden details and every block solid black in its pixels, the same file comes out whatever is under the blocks, no request is made, Ask about it, and a photo shared in through the worker (and without it, where the gateway drops it). `test/e2e/v2-share.e2e.test.ts` covers what the gateway serves for it. `test/unit/v2/firstrun.test.ts` covers the first run's steps and routes, when it shows (once, only on a plain open of the home), which ways to pay it shows, and the price line's Free wording. `test/ui/addfunds.ui.test.ts` drives Add money as wallet cards: every card (screenshots under `.tmp/addfunds-c/`), the info lines and Listen, tabs, a touch swipe and the arrow keys, reduced motion, the order (Start free, the way used last, a More way promoted), no scrolling and 48 px targets at 360 x 640 and 412 x 915, Start free with its question and Keep Private only, the home at $0 on a paid and on a free model, and Funds with Take funds out; `test/ui/ways.ts` opens a way from the cards for the other UI tests. `test/ui/firstrun.ui.test.ts` walks it in Chrome on a clean profile (every step, Back, the invite code carried to Add funds, Start, and that it does not show again after a reload; Skip; a deep link past it; Private only turned back on; Listen with a stand-in phone voice and no request to the engine; 360 px; back after Erase everything), and checks the empty states and the price on Ask again and Try again. The other UI tests open the app as a phone that has seen the first run (`test/ui/firstrun-seen.ts`).

The free tier: `test/unit/free.test.ts` covers its settings (off by default), the free question rules, keyset expiry, the faucet's drip, difficulty and proof-of-work check, and the faucet itself on a fake clock (a wrong answer, a stale or reused puzzle, a reused claim, the per-address limit kept only as keyed hashes, an empty drip and day, a failed mint that keeps the ticket). `test/e2e/free.e2e.test.ts` runs it against the local credit mint: a voucher opens a free balance without an invite, one credit per answered question and none for a failed one, the caps, a paid model and speech refused, credits per request refused, a free balance taken out only as credits, money and credits never on each other's balance (Lightning included), credits refused by other-mint funding, expired keysets, revenue, and the faucet (off, on, a claim, replays, a stale puzzle, the address limit, an empty day). `test/unit/issue-credits.test.ts` and `test/e2e/issue-credits.e2e.test.ts` cover the issuing script, `test/unit/credit-mint-deploy.test.ts` the deployment files. `test/unit/v2/free.test.ts` covers which balance pays, the "of 3" count, the ring segments, the faucet client and vouchers in the vault; `test/ui/free.ui.test.ts` gets free questions in the app and on `/free`, uses them, and checks the ways forward, a pasted voucher beside a paid balance and a scanned one.

`docker-compose.test.yml` runs four FakeWallet mints ([OPERATING.md](OPERATING.md#a-local-gateway-with-a-test-mint)). On-chain funding is tested against `test/e2e/onchain-mock.ts`, a NUT-30 proxy over `mint-a` that follows the Forge Nutshell branch's request and response shapes.

The admin tests (`test/unit/admin.test.ts`, `test/e2e/admin.e2e.test.ts`) cover access control (404 when off, 401 on a missing or wrong token, failed-login limit, Origin and JSON checks, no CORS), invites and revoke, the waitlist invite and delete, freeze (spending blocked, refunds allowed), revenue export (never above sweepable, locked export redeemable only with the key, history with token hash and no token, crash after the swap finished once by recovery) and overview numbers against the ledger.

The e2e suite covers the 402 flow with change, sat pricing, topup, spend, refund, wrong mint, wrong unit, double spend, client disconnect mid-stream, upstream failure and retries, a non-stream body that fails after `200` headers (settled at once, nothing charged, change returned), flat pricing, invite gating, crash recovery (both NUT-19 replay and NUT-09 restore), P2PK-locked change and refunds (locked to the key: a plain wallet and the gateway's own wallet cannot redeem them, the key holder can; invalid keys 400; crash after a locked swap recovered by replay, by NUT-09 restore of the stored blinded messages, and left owed when neither answers), funding by Lightning (quote, paid, minted, credited; restart mid-quote; crash after the mint with replay and with restore; concurrent polls credit once), by other-mint eCash (fees shown, credit exact, change returned, cross-unit, crash after the swap and after the melt, refund when the melt no longer fits, quote expiry frees the invite, deny list, plain-http mints refused) and on-chain against the mock (NUT-20 locked quotes, repeated deposits, crash after the mint), and EHBP pass-through against a fake enclave (usage from header and from HTTP trailer; a non-stream body that fails after `200` headers charges nothing, flat pricing included, and returns the full change).

## The receiver's image

`.github/workflows/receiver-image.yml` is a second, separate workflow. On a push to `main` that changes `services/fedimint-receiver/`, or when started by hand, it builds the receiver's Docker image and publishes it to the GitHub container registry as `ghcr.io/forgereserve/forge-ai-fedimint-receiver`, tagged with the commit and `latest`, and prints the image's digest. A host too small to compile fedimint pulls that image by its digest ([FEDIMINT-RECEIVER.md, Turning it on](FEDIMINT-RECEIVER.md#turning-it-on)). It is the only job with `packages: write`, and it runs on no pull request.
