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
| Native apps and docs, nothing else | `check`, the docs page's own tests, and `android` when `android/` changed |
| Anything else: `src/`, `public/`, `test/`, `config/`, a new top-level file | `check`, `e2e`, all six UI parts, and `android` when `public/` or `capacitor.config.json` changed |
| The changes cannot be read, or the pull request lists no file | Everything |

A Markdown file under `public/` (the licences in `public/vendor/licenses/`, a sources list) is served and goes into the app bundle, so it counts as the web app, not as docs.

The Android bundle is made from `public/` (by `scripts/android-web.ts` and `scripts/lib/android-web.ts`), `capacitor.config.json`, the voice and speech files fetched by `scripts/phonon-model.ts` and `scripts/asr-model.ts`, and the Capacitor runtime in `node_modules` (`android/settings.gradle`). Everything outside `android/` that `android/app/build.gradle` reads is listed there.

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
