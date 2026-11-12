# Forge AI v2 build plan

Status: proposed, waiting for the owner's go. Written 2026-11-12.

The design is settled (design canvas, deck, FREE-TIER.md, MODULES.md). This is the order to build it in, and what has to be real for the December talk.

## How the work is organised

- **v1 stays live.** v2 is built beside it as a new front end at `/v2/`, on the same gateway, behind the same invites. When v2 is ready it becomes the default and today's app becomes Classic mode.
- **One slice at a time, each as a pull request** on `ForgeReserve/forge-ai`, with tests, reviewed before merge. Nothing is deployed without the owner's OK.
- **Modules from the first slice.** Voice, filters, covers, guides, languages, looks and modes go behind the interfaces in MODULES.md as they are built, so nothing has to be pulled apart later.
- Sizes are rough and assume one stream of work. Slices in different tracks can run side by side.

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

## Track B: Bellows (the engine)

| # | Slice | What ships | Size |
|---|---|---|---|
| B1 | Free tier | Credit mint, free balance in the gateway, daily faucet at `/free` (FREE-TIER.md) | 6 days |
| B2 | Modules | Funding split into one module per method; plugin loader, signed manifests and sandbox (MODULES.md) | 5 days |
| B3 | Operator-blind | Bellows inside sealed hardware with public proof, several operators with failover, onion address | About 2 weeks, least certain |

## Track C: Android app

| # | Slice | What ships | Size |
|---|---|---|---|
| C1 | App shell | The web app wrapped as an installable Android app, downloadable from the site; share-in, tap cards, settings links | About 1 week |
| C2 | Voice on the phone | The flash-speech engine from flash-mobile, so no audio leaves the device | About 1 week |

## The December cut

The talk's live demo needs these to be real and tested on the demo phone: **A1, A2, A3, A4, A5, A6**. The closing slide's QR code should open the faucet, so **B1** too. That is about five weeks of single-stream work, so the tracks have to overlap.

Recommended order: A1, A2, A3, A5, A4, A6, with B1 alongside from the second week.

Shown on slides but not demoed live, so they can be "in progress" on the day: A8 guides, A9 witness, A10 cover, B3 operator-blind. The script already says to state each one's real status.

**B3 is the largest risk.** It depends on running the gateway, its database and its wallet keys inside Tinfoil's container product, which is untested. Do a two-day spike in the first week to learn whether it is feasible before December. If it is not, the slide says "in progress, here is the design".

After the event: A7 languages checked by native speakers there, then A11, A12, B2, C1, C2.

## Checks before the talk

- A printed note from the Forge mint scans and funds on the demo phone.
- The protected photo shares into a Signal group from the demo phone.
- The demo works on the venue's network, and a recorded backup exists.
- The protection screen no longer names an iPhone-only setting.
- Every "in progress" claim in the script matches what is live that week.

## Open decisions

1. The event date, which sets how much of the cut is realistic.
2. The demo phone: Android or iPhone.
3. Whether slices are tracked as Linear tickets through the plan and build workflows, or built directly as pull requests from this plan.
