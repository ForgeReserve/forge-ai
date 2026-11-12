# Forge AI v2 build plan

Status: approved in yolo mode on 2026-11-12. Bellows is being built first.

The design is settled (design canvas, deck, FREE-TIER.md, MODULES.md). This is the order to build it in, and what has to be real for the December talk.

## How the work is organised (yolo mode)

Decided by the owner on 2026-11-12. The event is 2 to 4 December 2026.

- **No pull request per slice and no review between slices.** Each effort is built slice by slice on one local branch, with tests, an adversarial review of every slice and of the whole diff, and every check run locally. The owner reviews **one pull request per effort** and approves it for deployment.
- **Two efforts, in this order:**
  1. **Bellows**, the operator-blind engine, in its own public repository. It is a prerequisite: the app talks to a Bellows. Its design and slices are in that repo's `docs/DESIGN.md`. Track B3 below now lives there.
  2. **Forge AI v2**, the app, in this repo, on one branch: Track A, then B1 and B2, then Track C.
- **v1 stays live** until the v2 pull request is approved. v2 is built at `/v2/` beside it.
- **Tested locally as far as possible:** unit and end-to-end tests against local mints, the app driven in a phone-sized browser, then the real phones.
- **What cannot be tested locally is listed, not hidden.** Each pull request carries a "not verified" list (real sealed hardware, real payments, real phones), so the one review knows exactly what was never run.
- **Modules from the first slice** (MODULES.md).

## Demo devices

| Device | Role | Consequence |
|---|---|---|
| Pixel on GrapheneOS | The demo phone | No Google services, so no built-in speech recogniser: voice in must run in sealed hardware or from a model bundled in the app |
| Samsung Galaxy A16 5G, stock Android | Second test phone | The low-end check: speed, memory and the share sheet on a mainstream phone |
| iPhone (Max) | Backup, loaded by hand | Web app in Safari, or a development build; no public TestFlight by December |

## Track A: the app

| # | Slice | What ships | Size |
|---|---|---|---|
| A1 | Shell and rings home | `/v2/` shell, two-ring home, answer screen, typed questions, Type / Add / More, Light look, wallet and funding reused from v1 | 4 to 5 days |
| A2 | Paper notes | Scan a note with the camera to add funds; printed test batch from the Forge mint with BitNotes | 2 days |
| A3 | Hold to talk | Voice in and voice out behind `voice-in` and `voice-out`; speech handled in sealed hardware for the web app; audio priced per request | 4 to 5 days |
| A4 | History, burn, auto-delete | Burn one, burn all, auto-delete timer, erase everything | 2 to 3 days |
| A5 | Share unseen, photos | Faces and numbers covered on the phone, location and file details stripped, before and after view, share to a messenger; first `filter` plugins | 5 days |
| A6 | First run | Onboarding, the limits screen, Private only on by default, price before send | 3 days |
| A7 | Languages | Translation framework, right-to-left layout, first ten languages for native speakers to check | 4 days |
| A8 | Guides | Signed guide packages, search on the phone, spoken answers with the source passage | 6 days |
| A9 | Witness | Record, write up, hide names and places, seal with the time, send or keep | 4 days |
| A10 | Cover | Install under a chosen name and icon, one puzzle game, hidden way in | 5 days |
| A11 | Protection steps | Checklist per platform, merged with Forge's own status | 2 days |
| A12 | Passphrase lock | Chats and balance encrypted on the phone | 3 to 4 days |
| A13 | Cashu card | Tap a Cashu card in the Android app to add funds, as a `fund` module reusing the card code from flash-pos | To be sized after a code check |
| A14 | Fedimint card | Tap a Fedimint card in the Android app to add funds, as a `fund` module reusing the fedimintcard POS core | To be sized after a code check |

## Track B: Bellows (the engine)

| # | Slice | What ships | Size |
|---|---|---|---|
| B1 | Free tier | Credit mint, free balance in the gateway, daily faucet at `/free` (FREE-TIER.md) | 6 days |
| B2 | Modules | Funding split into one module per method; plugin loader, signed manifests and sandbox (MODULES.md) | 5 days |
| B3 | Operator-blind | Moved to the Bellows repository and built first | See that repo |

## Track C: Android app

| # | Slice | What ships | Size |
|---|---|---|---|
| C1 | App shell | The web app wrapped as an installable Android app, downloadable from the site; share-in, tap cards, settings links | About 1 week |
| C2 | Voice on the phone | The flash-speech engine from flash-mobile, so no audio leaves the device | About 1 week |

## The December cut

Twenty days from the plan to the event. In order:

1. **Bellows** built locally and reviewed in one pull request. Running it on real sealed hardware depends on a hosting account; until then the talk says "in progress, here is the design".
2. **The demo path**, which must be real on the Pixel: A1, A2, A3, A4, A5, A6, with B1 (the faucet behind the closing QR code).
3. **C1**, the Android app, so the room can install it from the site. Without it the web app is the fallback and still works on every phone.

**Cards in the room.** Paper notes lead the demo. Cashu cards and Fedimint cards are on the table for people to tap afterwards (A13, A14), which needs the Android app (C1) because a web page cannot talk to these cards. They are mentioned in the script, not demoed on stage.

Shown on slides but not demoed live, so they can be "in progress" on the day: A8 guides, A9 witness, A10 cover. The script already says to state each one's real status.

After the event: A7 languages checked by native speakers there, then A11, A12, B2, C2.

## Checks before the talk

- A printed note from the Forge mint scans and funds on the demo phone.
- The protected photo shares into a Signal group from the demo phone.
- The demo works on the venue's network, and a recorded backup exists.
- The protection screen no longer names an iPhone-only setting.
- Every "in progress" claim in the script matches what is live that week.

## Open decisions

1. A hosting account for sealed hardware (Tinfoil Containers first), which the owner has to request.
2. Who runs the relay that hides network addresses. It has to be someone other than the Bellows operator.
