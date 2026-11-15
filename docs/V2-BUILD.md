# Forge AI v2: build plan for the December cut

Status: approved by the owner in yolo mode, 2026-11-13. One branch (`v2`), slices in order, one pull request.

Read with: `docs/ROADMAP.md` (why and when), `docs/design/SCREENS.md` (every screen, in words, with the design tokens), `docs/design/canvas/*.dc.html` (the screens themselves), `docs/MODULES.md` (plugin kinds), `docs/FREE-TIER.md` (credits and the faucet).

## What is being built

The v2 app, served at `/v2/` beside the live v1 app, for people who may not read well and cannot afford to be linked to a question. The event is 2 to 4 December 2026. The demo runs on a Pixel with GrapheneOS (no Google services).

Ten slices, in this order: A1, A2, A3, A4, A5, A6, B1, C1, A13, A14.

Not in this run: languages (A7), guides (A8), witness (A9), the cover game (A10), protection steps (A11), the passphrase lock (A12), the plugin sandbox and signature checks (B2), on-device voice (C2). The app must not show an entry that leads nowhere: a menu lists only what exists.

## Rules for every slice

1. **v1 stays exactly as it is.** Nothing under `public/` outside `public/v2/` changes behaviour, and every existing test keeps passing unchanged. If v1's service worker (`src/sw.ts`, `public/sw.js`) would intercept `/v2/`, give `/v2/` its own scope and make v1's worker leave it alone, with a test.
2. **Same stack as v1.** Plain ES modules, no framework, no build step, vendored libraries with their licences in `public/vendor/licenses`. Reuse v1's UI-independent modules by import (`/js/qr.js`, `/js/scan.js`, `/js/lockkey.js`, `/js/files.js`, `/js/extract.js`, `/js/markdown.js`, `/js/store.js` patterns); do not copy them.
3. **Modules from the first slice.** Every swappable part is a module with a manifest (`public/v2/modules/<kind>/<id>/manifest.json` and `index.js`) loaded through one registry (`public/v2/core/registry.js`). The registry hands a module only the inputs of its kind (MODULES.md). In this run only bundled modules load; the manifest carries `publisher` and `sig` fields, and checking them plus the sandbox is B2. Say so in the code and the docs, never claim a sandbox that is not there.
4. **The design is the canvas.** Build the Default mode screens as `docs/design/SCREENS.md` describes them, with its tokens. Icons first, words as short subtitles. Touch targets at least 48 px. Works at 360 px wide and up, portrait first, and is usable on a laptop. Looks: Light (default), Dark, Midnight, each a `look` module of design tokens. Respect reduced motion.
5. **All text comes from one string table** (`public/v2/strings/en.js`), so A7 can translate it. No text is built by joining fragments.
6. **Copy rules.** Spell it eCash. No em dashes. Short plain sentences. Headings are labels. Say what a thing does, in the words on the canvas where they exist.
7. **Honest wording.** Never tell the person something is private, hidden or deleted unless the code makes it so. The operator cannot read answers from private models; network address and timing are hidden only through a relay or Tor. Deleted means removed from this phone.
8. **Privacy by default.** Private only is on. Nothing is sent anywhere but the engine the person chose. No analytics, no remote fonts, no third-party requests. Photos, audio and chats stay in the browser's storage on the phone unless the person sends them.
9. **Money first.** Never lose a token: a token taken from a scan, paste, card or faucet is stored on the phone before it is sent, and removed only after the engine confirms the credit (the v1 wallet already works this way; keep its guarantees). Show the price before sending.
10. **Tests with every slice.** Logic lives in pure modules tested with vitest. The UI is driven in a phone-sized browser by `pnpm test:ui` (Playwright, 412 by 915, using the installed Chrome through `channel: 'chrome'` so no browser download is needed) against a local gateway with the mock supplier and the local test mints. Camera, microphone and NFC are reached through small adapters that tests replace.
11. **Dependencies.** pnpm with the release-age rule. Never add `minimumReleaseAgeExclude` or `onlyBuiltDependencies` entries. If a package cannot be installed under the rule, pick an older version or vendor a file, and say so.
12. **Out of bounds.** No push, no deploy, no change to any server, no reading of keys or `.env` files with real values, no `adb` or other action on a connected phone, no payment with real money. What needs any of these goes on the slice's "not verified" list.

## Architecture

```
public/v2/
  index.html, app.js, style.css, sw registration, manifest.webmanifest (scope /v2/)
  core/      registry.js, engine.js, state.js, router.js, vault.js (tokens awaiting credit), i18n.js
  screens/   home, answer, funds, history, firstrun, more, share
  modules/   fund/*, voice-in/*, voice-out/*, filter/*, look/*, mode/*
  strings/   en.js
```

- **Engine client** (`core/engine.js`): one base URL, same origin by default, stored per operator so a Bellows can be added later. It speaks the existing API (`/v1/models`, `/v1/wallet*`, `/v1/chat/completions` streamed) and answers a `428` proof-of-work challenge the way Bellows asks for it (port `solvePow` from the Bellows client; SHA-256 leading zero bits, header name as Bellows uses). The gateway in this repo does not send 428 today, so test this against a stub.
- **Balance carries over.** v2 uses the same balance key as v1 on the same origin, so a person with a v1 balance sees it in v2.
- **Storage.** IndexedDB, database `forge2`, for chats, attachments and settings. One `eraseEverything()` that removes all of it, caches and the balance key included, behind a clear confirmation (A4).
- **Routing.** Hash routes, one screen at a time, back button works, state restores after the tab is killed.

## Slices

### A1. Shell and rings home

The `/v2/` shell, service worker and manifest; the module registry; the engine client; the three looks; Default mode as a `mode` module.

- **Home:** two rings. Gold is funds, green is memory (how much of the model's context this conversation uses). No icons on the rings. Tapping either opens one Funds and memory screen. Below: the hold-to-talk button (present, and until A3 it opens Type), and the row Type, Add, More.
- **Type:** a text field, the price line before send, send. **Answer screen:** the streamed answer with markdown, stop, copy, ask again, follow-up. Errors in plain words with one next step.
- **Add:** Photo and File attach to the next question (reuse v1's files and extract code and limits). Link and Guide wait for their slices and are not shown.
- **More:** History (A4), Mode and look (the three looks; Classic opens v1 at `/`). Only entries that work.
- **Funds and memory:** balance, refundable amount, Add funds, Take funds out (refund as eCash, with the token kept on the phone until the person confirms they saved it), and the memory meter with Start fresh. Add money (since 2026-11-15 the wallet cards, docs/design/SCREENS.md) shows the `fund` modules: eCash (paste), Lightning, on-chain, another mint. Each wraps the existing endpoints and v1's proven flows.
- **Model choice** lives in More, not on the home. Private only is on by default and hides models that are not private.

Tests: registry (kind isolation, bad manifest refused), engine client (stream parsing, 402 and 428 handling, token kept until credited), ring maths, and a `test:ui` run: open `/v2/`, fund with a test token, ask a typed question, read the streamed answer, see the gold ring move.

### A2. Paper notes

- A `fund` module, the first wallet card on Add money: **Scan a note.** The camera opens, reads a QR code (single or animated, through v1's scanner), shows the amount and the mint, and adds it on one tap. A note from a mint the engine does not take says so and offers the other-mint path. A spent note says it has been used.
- The home's gold ring is the fastest way in: with a zero balance, the ring invites a scan.
- `scripts/print-notes.ts`: makes a batch of notes for printing. It asks the trusted mint for a Lightning invoice for the batch, shows it, waits until the owner pays it, mints the tokens, and writes one printable HTML file (a sheet of notes, each a QR code with its amount, a short how-to line and a serial with no meaning) with file mode 0600. Tokens never go to the terminal or a log. A `--mint` flag lets the tests use the local mint.

Tests: note parsing, wrong mint, spent note, the print script against the local mint, and a `test:ui` run that feeds a QR image through the camera adapter and sees the balance rise.

### A3. Hold to talk

- **Interaction:** press and hold the button to record, release to send, slide off to cancel, with clear motion and haptics. A tap (no hold) explains it once. The answer screen shows the question as text and speaks the answer; a speaker control stops and replays.
- **Modules:** `voice-in` (audio to text) and `voice-out` (text to audio), each with two implementations: `engine` (the gateway, in sealed hardware) and `device` (the browser's own speech recognition and synthesis, used when present and when the person chooses it). On the demo phone there is no device recogniser, so `engine` is the default for voice in. For voice out, use `device` when the browser has a voice for the language, else `engine`.
- **Gateway:** `POST /v1/audio/transcriptions` and `POST /v1/audio/speech`, OpenAI-compatible, behind the `Supplier` interface, priced per request from the catalogue (per second of audio in, per character out), paid from the balance like chat, with the same refund-on-failure rule. Before writing code, check Tinfoil's current documentation for the audio models it serves and their request formats, and use those names and prices; if one direction is not offered, build the route against the mock supplier, leave the real supplier unconfigured, and say so plainly in the slice notes. Audio is held in memory only and never logged or stored.
- **Private only** applies: audio goes only to a private model.
- The price line shows the estimate before the recording is sent (by its length).

Tests: route pricing and refunds, size and length limits, the recorder state machine, sentence chunking for speech, and a `test:ui` run with a fake microphone adapter.

### A4. History, burn and auto-delete

- **History** (from More): past conversations, newest first, each with its first words and time; open, continue, burn one.
- **Burn** on the answer screen removes that conversation from the phone at once. **Burn all** removes every conversation.
- **Auto-delete:** off, on close, 1 hour, 1 day, 1 week. Applied on open and by a timer while open.
- **Erase everything:** chats, attachments, settings, caches, service worker and the balance key. It warns first that the balance is lost unless funds are taken out, and offers Take funds out.
- State what burn does and does not do: it removes the conversation from this phone; the engine keeps no copy of private-model conversations.

Tests: every deletion path leaves nothing in IndexedDB, caches or localStorage; auto-delete timing with a fake clock; `test:ui` for burn and erase.

### A5. Share unseen (photos)

- **In:** Add, Photo (camera or gallery), and share-in from another app (Web Share Target in the manifest; the Android intent comes in C1).
- **Protection runs on the phone, before anything is sent or shared.** `filter` modules, applied in order, each reporting what it changed:
  - `strip-details`: re-encodes the image so location, device, time and thumbnail data are gone. Tested with a real EXIF sample.
  - `cover-faces`: finds faces on the device and covers them with a solid block (not a blur, which can be undone). Vendor a small face detector that runs in the browser with its licence. The model file is bundled, never fetched from a third party.
  - `cover-numbers`: finds text regions such as plates, signs and documents and covers them. If no detector fits in a reasonable size and speed on a low-end phone, ship the manual tool below alone and say so in the notes.
  - Manual: tap or drag to add a cover block, tap a block to remove it. Always available.
- **Before and after:** the person sees both, and the list of what was changed, then chooses Share, Ask about it (attach to a question) or Save.
- **Out:** the system share sheet with the protected file (Web Share with files; a download where that is missing). The original never leaves the app.
- Free: no balance needed (FREE-TIER.md, layer 1).

Tests: metadata gone, cover blocks are opaque in the output pixels, the filter chain report, and `test:ui` with a sample photo with faces.

### A6. First run

- Welcome, then How you pay (paper note, free questions, a card, Lightning: shown by icon), then What it can and cannot hide (the limits screen, honest wording), then Private only (on, explained), then the home. Skippable, shown once, reachable again from More.
- Price before send everywhere a request costs money, with "Free" when a free question is used (B1 wires that in).
- Empty states for home (no balance), history and funds.

Tests: `test:ui` walks the first run on a clean profile; it does not show again.

### B1. Free tier and the faucet

Build FREE-TIER.md, steps 1 to 4, plus a minimal issuing tool.

- **Credit mint:** a second local mint in `docker-compose.test.yml` for the tests, and deployment files under `deploy/credit-mint/` (compose file, nginx location blocks that expose only info, keys, keysets, swap and checkstate, and a README with the steps). Nothing is deployed in this run. Confirm what unit the mint can use and record the answer.
- **Gateway:** a credit mint setting; a balance funded with credits is a free balance; it pays only for the free model list with the caps; change and refunds come back as credits; expired keysets are refused. A free balance can never be refunded as money, and money can never be converted to credits by a user.
- **Faucet:** `/free` page and its API: challenge, verify, claim. Daily budget, hourly drip, proof of work with rising difficulty, an in-memory per-address limit that is never written to disk or logged, and a clear "more at ..." state when empty. The voucher appears as a QR code with Add to Forge.
- **App:** Free questions as a tile on Add money's More card; the gold ring shows free questions as a lighter segment used first; the price line says "Free, 2 of 3 left"; when they run out, the three ways forward.
- **Issuing tool:** `scripts/issue-credits.ts`, localhost only, writes vouchers to a 0600 file for printing with the note layout from A2.
- All settings off by default, so deploying this branch changes nothing until the owner turns the faucet on.

Tests: unit and e2e for every rule above against the local credit mint, including the attempts that must fail (refund credits as money, spend credits on a paid model, replay a claim, a stale challenge).

### C1. Android app

- A Capacitor project in `android/` wrapping the same web app, with the assets bundled in the app (no remote code). The engine address defaults to `https://ai.forge-reserve.com` and can be changed in More. Check the gateway's CORS and headers allow the app's origin for every route v2 uses, and fix them with tests.
- Share-in: receives images from other apps into Share unseen. Share-out through the native sheet. Camera and microphone permissions asked only when first used. NFC declared as optional.
- App name Forge, application id `com.forgereserve.ai`, minimum Android 9. No Google services, no Firebase, no analytics: it must run on GrapheneOS.
- Build: `./gradlew assembleDebug` works on this Mac (Android SDK and JDK 17 are installed). `scripts/android-release.sh` builds a release APK signed with a keystore the owner supplies at a prompt; no keystore is created or committed. The site serves the APK at `/download` from a path set in config (`FORGE_APK_PATH`), with its SHA-256 shown on the page; unset means the page says the app is coming.
- A short `docs/ANDROID.md`: build, sign, install, update.

Tests: Kotlin unit tests where there is logic, the web tests still pass from the bundled build, and the debug APK builds. Installing on a phone is not part of the run.

### A13. Cashu card

- A `fund` module: **Tap a card.** Android app only (a web page cannot talk to these cards); in the browser the row explains that and points to the app.
- A small Capacitor NFC plugin (IsoDep: connect, transceive, close; 5 second timeout) and a port of the card protocol from flash-pos (`~/Repos/flash-pos/src/services/cashuCard.ts`, which takes a transceiver function; read it, do not change that repo).
- Flow: tap, read the card's mint and balance, enter the PIN, choose an amount (default: all), the card signs, the app swaps at the card's mint and adds the eCash to the balance. If the card's mint is not one the engine takes, use the other-mint funding path. The card stays on the phone for one tap where the protocol allows it.
- Failure rules: a wrong PIN shows the tries left; a tap lost midway never loses money (the proofs taken from the card are stored before the swap and the swap is retried).

Tests: the protocol port against recorded or simulated card exchanges (use what flash-pos and `~/Repos/cashucard` provide), the flow with a fake transceiver, the Kotlin plugin's framing. A real card is on the not verified list.

### A14. Fedimint card

- A `fund` module: **Tap a Fedimint card.** Android app only. A Fedimint card is redeemed by a till; the phone only relays.
- Read `~/Repos/fedimintcard-pay/docs/PAY.md`, `POS-LINK.md` and `TILL-API.md` first and follow them exactly. Flow: the app asks the engine for a Lightning invoice for the amount, opens the card link to the till, the person taps and enters the PIN, the till charges the card and pays the invoice (`POST /v1/pay`), the app polls the engine until the funds arrive. A failed pay offers the refund to the same card (`POST /v1/pay/{id}/refund`).
- Settings: the till's address and a pay-scope token, paired by scanning a QR code from the till; stored on the phone. Without a till set, the row explains what is needed.
- The till's fee and the price charged to the card are shown before the tap.

Tests: against a mock till that implements the documented routes and states (paid, pay_failed and refund, undecided), with a fake transceiver. A real till and card are on the not verified list.

## Checks

- `pnpm typecheck`
- `pnpm test`
- `pnpm mint:up && pnpm test:e2e`
- `pnpm test:ui` (from A1 on)
- from C1 on: `cd android && ./gradlew assembleDebug testDebugUnitTest`

## What the pull request must list as not verified

Real phones (Pixel on GrapheneOS, Galaxy A16, iPhone Safari), real microphone and camera, the real Tinfoil audio models, a real paper note from the Forge mint, the share into Signal, a real Cashu card, a real till and Fedimint card, the credit mint in production, the release-signed APK, and the app talking to a sealed Bellows.

## Decisions where the canvas is silent or disagrees with itself

`docs/design/SCREENS.md` lists the open contradictions. These settle the ones this run touches:

1. The button reads **Hold to talk** everywhere.
2. Voice goes **straight to the answer** on release. The review step (DReview) is for photos, files and links only.
3. Default mode shows **no model name** on the home or the answer header, and no chat wording ("Add to chat", "Start chatting"). Amounts follow the person's unit.
4. **More** holds what the canvas leaves unreachable: Private only, Know the limits, History, Mode and look, the model choice, and the engine address.
5. Screens the canvas does not draw are built from its tokens and patterns, in the same voice: the **Type** screen, the **note scanner**, **Share unseen** (before and after, the list of changes, Share, Ask about it, Save), the faucet page, and the card taps. Keep them as plain as the screens around them.
6. The Light look's memory ring is **#0E7C6B**.
7. The Shutdown, Guides, Witness and Protection screens are **not built** in this run, and placeholder text in brackets is never shipped.
8. Dark and Midnight take their tokens from SCREENS.md; where a token is missing, derive it from the same scale and check contrast (4.5 to 1 for text).
