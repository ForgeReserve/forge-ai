# Free tier design

Status: steps 1 to 4 built in the v2 branch (slice B1), off by default; step 5 not built. Written 2026-11-12. See "What is built" at the end.

People on the front line often have no money and no way to buy bitcoin, and most private AI tools they could use instead have a free tier. Forge has to be free where it counts without asking anyone who they are. It does that in three layers.

| Layer | What is free | Who pays | Abuse limit |
|---|---|---|---|
| 1. On the phone | Everything that runs on the device | Nobody: it costs nothing per use | None needed |
| 2. Sponsored notes | Questions on printed notes handed out by organisations | The sponsor | The sponsor's batch size |
| 3. Daily faucet | A few free vouchers a day on the website | Forge, from a fixed daily budget | The daily budget, released in drips |

## Layer 1: free on the phone

These never touch a paid model, so they are free and need no balance:

- Protection steps and the cover game.
- Share unseen: voice change, faces and numbers covered, location and sender stripped. All on the device.
- On-device voice in and out (the flash-speech engine).
- Browsing and searching the guides library. A spoken answer drawn from a guide is a question, so it uses layer 2 or 3 or a balance.
- History, burn and erase.

The app never shows a paywall on these. A zero balance only stops new questions.

## Credits: free questions that are not money

Layers 2 and 3 hand out **credits**, not dollars. A credit pays for one question and nothing else.

**Why not plain eCash:** a free dollar note can be swapped for bitcoin and cashed out, so a faucet of real eCash would be farmed for money within a day. Credits are worth nothing outside Forge, so there is no reason to farm them beyond using them.

**How credits work:** credits are Cashu eCash from a second, separate mint (the credit mint), with the same blind signatures, so the credit mint cannot link a credit it signed to the person who spends it. Faucet vouchers are made by the gateway itself, so the gateway sees each voucher it hands out and again when it is added. It stores no voucher and no address of a claim, but its logs have the time of each claim and of each top-up (see PRIVACY.md).

- The credit mint runs beside the Forge mint, behind nginx. Only the endpoints a holder needs are public: `/v1/info`, `/v1/keys`, `/v1/keysets`, `/v1/swap`, `/v1/checkstate`. Minting and melting are blocked at nginx, so nobody outside can create credits or turn them into bitcoin. Forge issues credits from localhost only.
- Unit: one credit is one question. If Nutshell will not take a custom unit, the credit mint uses `usd` with 1 credit = 1 cent and the gateway treats that mint's eCash as credits (to verify).
- The gateway trusts the credit mint for spending only. A balance funded with credits is a **free balance**:
  - It pays only for the free model list. Start with `tinfoil/gpt-oss-120b`, which is private and cheap, and add `tinfoil/gemma4-31b` for images.
  - Each question is capped (proposed: 4,000 tokens in, 1,500 out).
  - Change and refunds come back as credits, never as money, so nothing leaks out.
- Credits from a keyset can be retired by rotating the credit mint's keyset. The gateway stops accepting an old keyset after its expiry date (proposed: 90 days), which returns unused budget.

**Cost:** at gpt-oss-120b's catalog price ($0.15 in, $0.60 out per million tokens), a capped question costs Forge at most about $0.0015. Three questions cost under half a cent, so **1,000 faucet vouchers a day cost about $4.50**. That is an estimate from catalog prices, before real usage data.

## Layer 2: sponsored notes

An organisation buys a batch of notes and hands them out: at a training, in a shelter, at this hackathon.

- **Credit notes** (recommended for wide handouts): AI-only, so a lost or stolen note is not lost money. The sponsor chooses questions per note.
- **Cash notes**: real USD eCash from the Forge mint, for people who should also be able to spend or move the money. Riskier to hand out, since a lost note is lost money.
- Notes are printed as scratch-off paper (BitNotes) or QR cards, or tapped from NFC cards.
- The sponsor sees how many notes in a batch have been redeemed, never by whom. Redemption is checked by whether the note's eCash is spent; no record ties a note to a phone.
- The sponsor's name can appear on the note ("Questions on us, from ..."), with their agreement.

## Layer 3: the daily faucet

A page on the website, `ai.forge-reserve.com/free`, gives out free vouchers every day, like the bitcoin faucets of the early years.

**What a person sees:**

1. "Free questions today: 412 left." A drip timer shows when the next batch is released.
2. A button: "Get 3 free questions". The phone works a puzzle for about 20 seconds (proof of work), with a progress ring. No CAPTCHA, no email, no name.
3. The voucher appears as a QR code and an "Add to Forge" button. It can be saved, printed or passed on.

**How it limits use:**

- **Fixed daily budget** (proposed: 1,000 vouchers of 3 questions). When it runs out, the page says when more come.
- **Released in drips** (proposed: 1/24 of the budget each hour), so one person cannot take the whole day's supply at midnight.
- **Proof of work per claim.** The server hands out a random challenge; the browser searches for a nonce whose SHA-256 has enough leading zero bits. Difficulty is tuned for about 20 seconds on a mid-range phone, and rises automatically when claims come faster than the drip.
- **No identity.** The faucet keeps no IP log. A short in-memory limit per address (proposed: 3 claims a day) blunts scripts, is never written to disk, and is skipped for Tor exits, where proof of work alone applies.
- **Small value.** A voucher is three questions on one model and cannot be turned into money, so farming it buys little.

**Known weakness:** a determined attacker with fast hardware can solve puzzles faster than a phone and drain a drip. The drip and the daily budget cap the damage at the day's budget, and the difficulty rise slows them. If abuse becomes real, the next step is blind-signed tokens from partner organisations (Privacy Pass style), not identity checks.

**Distribution beyond the website:** because a voucher is just a QR code, people can print and share faucet vouchers. Organisations with no budget can still hand out free questions this way.

## In the app

- **Add funds** gains a first row: "Free questions", which opens the faucet in the app and adds the voucher in one step. Scanning or pasting a credit note or voucher works from the same sheet.
- **The gold ring** shows free questions as a lighter segment ahead of the paid balance. Free questions are used first.
- **Before send**, the price line reads "Free, 2 of 3 left" instead of a dollar amount. If the chosen model is not on the free list, the app says so and offers the free model.
- **When free questions run out**, the app shows the three ways forward with no pressure: wait for tomorrow's faucet, scan a note, or add money. Layer 1 features keep working.

## Build order

1. Credit mint: deploy beside the Forge mint, with nginx blocking mint and melt; issuing script on localhost. Confirm whether Nutshell accepts a custom unit.
2. Gateway: trust the credit mint for spending; free balance flag; free model list; per-question caps; change and refunds in credits; keyset expiry.
3. Faucet: `/free` page, challenge and verify endpoints, daily budget and hourly drip, difficulty adjustment, in-memory rate limit.
4. App: Free questions row, gold ring segment, "Free, n of 3" price line, out-of-free-questions sheet.
5. Sponsored batches: batch issuing tool, print layout, redeemed count per batch.

## Open questions

- Daily budget and questions per voucher: 1,000 vouchers of 3 questions is a starting guess.
- Whether a free question may use voice transcription in the enclave (costs more) or only on-device voice.
- Who funds the faucet budget: Forge revenue, a grant, or sponsors topping it up.
- Expiry period for credits.

## What is built

Slice B1 of `docs/V2-BUILD.md` built steps 1 to 4 and a minimal issuing tool. Everything is off until the owner sets `FORGE_CREDIT_MINT` (credits) and `FORGE_FAUCET_ENABLED` (the faucet); with neither, a deploy changes nothing.

- **Unit, answered:** Nutshell 0.22.1 takes only sat, msat, usd, eur, btc and auth (read from its `Unit` enum in the image). There is no custom unit, so the credit mint uses usd and 1 credit = 1 cent. The gateway treats every token from the credit mint as credits, whatever its unit says.
- **Credit mint:** `mint-credit` in `docker-compose.test.yml` for the tests (port 3341). `deploy/credit-mint/`: a compose file (127.0.0.1 only, FakeWallet), nginx blocks that make only info, keys, keysets, swap and checkstate public, and the steps. Not deployed.
- **Gateway** (`src/credits.ts`, `src/accounts.ts`, `src/app.ts`): a balance funded with credits is a free balance. It pays only `FORGE_FREE_MODELS`, one credit per answered question, none for a failed one, within the caps (4,000 tokens in, 1,500 out by default). Change and refunds are credits. Money never goes on a free balance and credits never go on a paid one; credits per request and other-mint funding with credits are refused. A credit keyset is taken for 90 days after the gateway first saw it, or until its own `final_expiry`. Free balances and credits are left out of revenue.
- **Faucet** (`src/faucet.ts`): `/free` and `/v1/free` (status, challenge, verify, claim). A daily budget in drips, proof of work rising with the claim rate, an in-memory per-address limit (never stored or logged), and "More at" when empty. A harder puzzle gets more time: the base `FORGE_FAUCET_CHALLENGE_SECONDS` doubles with each bit over the base, up to an hour. Claims still being minted count against the per-address limit, so claims sent all at once cannot pass it together. A challenge is not stored: it carries its bits and expiry, signed with a key made fresh at each start, so asking for challenges costs the server no memory; only a solved one is kept until it expires, so it cannot be used twice. The faucet and card relay routes are rate limited by address, whatever bearer comes with a request, since they need no balance.
- **App:** Free questions first in Add funds; a free balance with its own key; the lighter ring segment; "Free, 2 of 3 left"; the three ways forward when they run out. See README, The v2 app.
- **Issuing tool:** `scripts/issue-credits.ts`, from a credit mint on the same computer only, writes a 0600 sheet in the paper note layout.

Differences from the design above, and why:

- The faucet's limit per address is not skipped for Tor exits: the gateway has no list of exits yet, so people on Tor share an exit's limit.
- Credits sent per request (NUT-24 `X-Cashu`) are refused: free questions are paid from a free balance, where the caps and the free list apply in one place.
- A free question may not use speech to text or text to speech on the engine (the open question above): they are refused on a free balance. A voice question in the app uses the paid balance for the speech part.
- A free balance needs no invite, even on an invite-only engine: it can only ever hold free questions.

Not verified: the credit mint in production (its DNS name, certificate, the nginx blocks on a live server, a gateway minting faucet vouchers there), the default proof-of-work difficulty on a real mid-range phone (22 bits is a guess at about 20 seconds; tune `FORGE_FAUCET_POW_BITS`), and real usage costs.
