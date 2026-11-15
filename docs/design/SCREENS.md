# Forge AI v2 screens

This file describes the owner's design canvas "Forge AI v2: new ways in". Build agents cannot open the canvas, so this is the build reference.

The raw files sit in `docs/design/canvas/`. `canvas.json` holds the page list, each screen's page, title and position. Each `*.dc.html` file is one phone screen, 390 x 844 px, written as plain HTML with inline styles. Open a file in a browser to see it. The `<script>` blocks are empty placeholders, so the screens carry no behaviour. Navigation below is inferred from labels and layout.

Source: claude.ai artifact 4RhbqeTrWTrb5BVGbVDd5o, version 1794600378-b08e, exported 2026-11-13. 106 screen files plus `canvas.json`.

## 1. Pages and screens

The canvas has five pages. **Default mode is final and is built first.** Classic mode and Playful mode are alternate modes the user can switch to in Mode and look. Experiments and Early concepts are history only.

Rows below follow the canvas layout, top to bottom, left to right. Section headings come from the canvas notes.

### Default mode (page id `wk`) - FINAL, build first

Canvas note: "Default mode: Walkie Kit". All screens use the Light look.

| Row (canvas note) | File | Canvas label |
|---|---|---|
| Core | `ZHome1.dc.html` | 1. Home: the rings |
| Core | `ZHome2.dc.html` | 1b. Running low |
| Core | `ZBoth.dc.html` | 1c. Tap the rings: funds and memory |
| Core | `XListenLight.dc.html` | 2. Listening |
| Core | `XAnswerLight.dc.html` | 3. The answer |
| Core | `XHistoryLight.dc.html` | 4. History |
| Core | `XSpendingLight.dc.html` | 5. Spending |
| Core | `XThemes.dc.html` | 6. Mode and look |
| Core | `ZMore.dc.html` | 7. More |
| Core | `ZAdd.dc.html` | 8. Add |
| Money and protection | `DAddFunds.dc.html` | Add funds, ranked by privacy |
| Money and protection | `DCard.dc.html` | Tap your card |
| Money and protection | `DFunded.dc.html` | After the tap |
| Money and protection | `DPrivateOnly.dc.html` | Private only |
| Money and protection | `DLock.dc.html` | Passphrase lock |
| Money and protection | `DErase.dc.html` | Erase |
| First run (built, approved 2026-11-14) | `C-Welcome.dc.html` | Welcome |
| First run (built, approved 2026-11-14) | `C-Pay.dc.html` | How you pay |
| First run (built, approved 2026-11-14) | `C-Limits.dc.html` | What it hides |
| First run (built, approved 2026-11-14) | `C-Private.dc.html` | Private only |
| First run (earlier, superseded by the C boards) | `DWelcome.dc.html` | Welcome |
| First run | `DHowPay.dc.html` | The two rings |
| First run | `DFirstFunds.dc.html` | First funds |
| First run | `DProtect.dc.html` | Protect this phone |
| First run | `DLimits.dc.html` | Know the limits |
| Adding things and sharing | `DPhoto.dc.html` | Photo check |
| Adding things and sharing | `DLink.dc.html` | Read a link |
| Adding things and sharing | `DReview.dc.html` | Review before send |
| Adding things and sharing | `DInbox.dc.html` | Inbox |
| Adding things and sharing | `DShareIn.dc.html` | Shared in from a messenger |
| Adding things and sharing | `DShareOut.dc.html` | Share an answer out |
| Adding things and sharing | `DVoiceNote.dc.html` | Send as a voice note |
| Ask a guide: trusted handbooks, asked by voice | `GLibrary.dc.html` | Guides library |
| Ask a guide | `GOpen.dc.html` | A guide, ready to ask |
| Ask a guide | `GAnswer.dc.html` | An answer from the guide |
| Protection: what Forge does, and expert steps for your phone | `PProtect.dc.html` | Protection: Forge and your phone |
| Protection | `PStep.dc.html` | One step, with a button |
| Protection | `PExpert.dc.html` | Live help: free helpline or paid call |
| Protection | `WRecord.dc.html` | Witness 1: say what happened |
| Protection | `WReview.dc.html` | Witness 2: check it, send to the helpline |
| (no note) | `SHome.dc.html` | Shutdown 1: no internet, still ask |
| (no note) | `STravel.dc.html` | Shutdown 2: sealed and travelling |
| (no note) | `SAnswer.dc.html` | Shutdown 3: answer arrives later |

39 screens.

### Classic mode (page id `flows`)

Canvas note: "Classic mode: the original chat layout". Dark ground (Midnight colours) except `HomeLight`.

| Row (canvas note) | File | Canvas label |
|---|---|---|
| Top | `Card.dc.html` | Tap your card |
| Top | `Bridge.dc.html` | Forge in a private messenger |
| Top | `Shield.dc.html` | Protection details |
| Top | `HomeLight.dc.html` | Home, light theme |
| Top | `HomeTray.dc.html` | Home, tray open |
| Top | `Inbox.dc.html` | Inbox |
| Going deeper: cash funding, private only, phone safety | `Home.dc.html` | A. Home on the real layout |
| Going deeper | `AddFunds.dc.html` | B. Add funds, ranked by privacy |
| Going deeper | `Funded.dc.html` | C. After the tap |
| Going deeper | `PrivateOnly.dc.html` | D. Private only |
| Going deeper | `Lock.dc.html` | E. Passphrase lock |
| Going deeper | `Erase.dc.html` | F. Erase |
| Sharing with secure messengers | `ShareOut.dc.html` | G. Share an answer out |
| Sharing with secure messengers | `ShareIn.dc.html` | H. Shared in from a messenger |
| Sharing with secure messengers | `VoiceNote.dc.html` | M. Send as a voice note |
| Camera, voice and links on the real layout | `Photo.dc.html` | I. Photo check |
| Camera, voice and links | `Speak.dc.html` | J. Speak |
| Camera, voice and links | `Link.dc.html` | K. Read a link |
| Camera, voice and links | `Review.dc.html` | L. Review before send |
| First run, for someone new to eCash | `Welcome.dc.html` | N. Welcome |
| First run | `HowPay.dc.html` | O. How paying works |
| First run | `FirstFunds.dc.html` | P. First funds |
| First run | `Protect.dc.html` | Q. Protect this phone |
| First run | `Limits.dc.html` | R. Know the limits |

24 screens. Most `D*` screens in Default mode are Light copies of these.

### Playful mode (page id `playful`)

Canvas note: "Playful mode: a cover for adults, with limits for children".

| File | Canvas label |
|---|---|
| `KidsCover.dc.html` | S. Opens as a game |
| `KidsHome.dc.html` | T. Playful home: same rings, brighter |
| `KidsChat.dc.html` | U. Playful answer |
| `KidsGrownUp.dc.html` | V. Playful mode setup |
| `CoverPicker.dc.html` | W. Cover picker |

### History only: Experiments (page id `exp`) and Early concepts (page id `early`)

Do not build these. Listed for completeness.

| Page | Files (canvas label) |
|---|---|
| Experiments, "how Walkie and Kit got here" | `XWalkie` (Walkie: talk first), `XKit` (Kit: tasks, not a prompt), `XWalkieListen`, `XWalkieAnswer`, `XKit2` (colour tiles plus talk), `XHistory` (History, as slips), `XSpending` (Spending, as a receipt), `XKit3Dark`, `XKit3Bright`, `XKit4Outline`, `XKit4Soft` (soft colour, softer dark), `XKit4Tint`, `YOrbit1`, `YOrbit2`, `YHand1`, `YHand2`, `YWheel1`, `YWheel2`, `YTabs1`, `YTabs2` (four ways to tuck six tasks), `ZOrbit1` to `ZOrbit4` (things circling the button), `ZCtx1` to `ZCtx4` (context orbit), `ZRing1` to `ZRing3` (rings: funds and memory), `ZSpace1`, `ZSpace2` (drifting space orbit), `XHomeStack`, `XHomeLight` (earlier home, before the rings). 35 files. |
| Early concepts, "replaced by the Flows page" | `Main` (Retired: standalone intake tray), `Scrub` (2. Scrub before send), `Voice` (3. Private voice). 3 files. |

## 2. Default mode build specs

### Shared parts

**Frame.** 390 x 844. Page background `#F6F5F1`. Text `#14161A`. Font Inter. Page padding 16 px, gap 14 px between blocks.

**Status bar (top of home-type screens).** One row, space between.
- Left: "Private" pill. Padlock icon (16 px) plus the word "Private". Teal text `#0E7C6B` on `#E3F4F0`, 1 px border `#9AD3C8`, radius 22, min height 44. In the markup it is a plain element, not a button.
- Right: balance pill. A 10 px gold dot `#D4A544` then the amount, for example "$9.99". White fill, 1 px border `#C9A24A`, radius 22, min height 44, 15 px semibold. It is a button. Assume it opens Funds and memory (`ZBoth`).

**The two rings.** A 336 x 336 drawing centred in the free space.
- Outer ring = funds. Radius 150, stroke 26, round caps, starts at 12 o'clock and runs clockwise. Track `#F3E3BC`, fill `#D4A544` (gold). The fill length shows how much money is left.
- Inner ring = memory (context). Radius 121, stroke 26. Track `#D5F2EA`, fill `#0E7C6B` (green). The fill length shows how much memory is free.
- No icons, numbers or labels on the rings.
- Tapping either ring opens the one Funds and memory screen (`ZBoth`).
- Sample values on `ZHome1`: funds 85 percent (801 of 942), memory 70 percent (532 of 760).

**Hold-to-talk button.** A 204 px circle in the centre of the rings. Fill `#14161A`. Shadow `inset 0 -9px 0 rgba(0,0,0,0.4), inset 0 3px 0 rgba(255,255,255,0.14)`. White microphone icon 69 px, stroke 1.6. Label under it, 16 px bold white: "Hold to talk". Press and hold to record. Release to send. See `XListenLight` for the held state.

**Bottom row.** Three equal buttons, gap 8, min height 60, radius 20, white fill, raised shadow (token `shadow-raised` below), 15 px bold.
- "Type", keyboard icon. Opens text entry. No Default mode screen shows the typing state.
- "Add", plus icon. Opens the Add sheet (`ZAdd`).
- "More", three dots icon. Opens the More sheet (`ZMore`).
- When a sheet is open, its button turns dark (`#14161A`, white text) and its label changes to "Close".

**Back header (sub screens).** A 48 px round white back button with a left chevron, a centred 18 px bold title, and a 48 px spacer on the right.

**Bottom sheet frame (`D*` sheets).** Backdrop `#D9D6CD` shows 24 px at the top. Sheet `#F6F5F1`, radius 24 24 0 0, padding 10 16 20. Grabber 44 x 5, radius 3, `#C9C6BE`, centred. Sheet title 22 px bold, letter spacing -0.01em.

**Primary button.** Height 56, radius 16, fill `#14161A`, white 16 px semibold, shadow `inset 0 -5px 0 rgba(0,0,0,0.45), inset 0 2px 0 rgba(255,255,255,0.14)`.

**Secondary button.** Transparent, 1 px border `#E3E0D8`, radius 16, height 48 to 52, 15 px medium.

**Danger outline button.** Transparent, 1 px border `#B3402F`, text `#B3402F`.

**Listen chip (first run).** Speaker icon plus "Listen", teal on `#E3F4F0` with border `#9AD3C8`, radius 12, min height 44. Reads the screen aloud.

### Home: the rings (`ZHome1.dc.html`)

Purpose: the one main screen. Talk to ask. Shows money and memory at a glance.

Top to bottom:
1. Status bar: "Private" pill (left), "$9.99" balance pill (right).
2. The two rings with the hold-to-talk button in the middle. Label "Hold to talk".
3. Bottom row: Type, Add, More.

Navigation: hold the button to go to Listening. Tap a ring or the balance pill to go to Funds and memory. Add opens the Add sheet. More opens the More sheet.

### Home, running low (`ZHome2.dc.html`)

Same layout as Home with low values.
- Balance pill "$2.10". Funds ring at 20 percent (188 of 942), still gold.
- Memory ring at 10 percent (76 of 760) and turns orange: fill `#C2600A`, track `#FCE9D6`.
- Centre label reads "Hold to ask" (not "Hold to talk").
- New chip under the rings: layers icon plus "Memory is nearly full. Clear it". Fill `#FCE9D6`, border `#E7B98A`, text `#8A3A12`, radius 24, min height 48, 14 px bold. Tap leads to Funds and memory (or clears memory directly; not specified).

### Funds and memory (`ZBoth.dc.html`)

Purpose: the single screen behind both rings.

Top to bottom:
1. Back header, title "Funds and memory".
2. Funds card (white, radius 26, raised).
   - Left: a 92 px gold ring (track `#F3E3BC`, fill `#D4A544`, stroke 16, at 85 percent).
   - Right: caps label "FUNDS" (12 px bold, `#8A6410`, letter spacing 0.06em), amount "$9.99" (34 px bold), note "Enough for over 900 questions." (13 px, `#5B6068`).
   - Three buttons, height 48, radius 15: "Add" (plus icon, dark primary), "Spending" (receipt icon, `#F6F5F1` fill), "Take out" (arrow up out of a tray icon, `#F6F5F1` fill).
3. Memory card (white, radius 26).
   - Left: a 92 px green ring (track `#D5F2EA`, fill `#0E7C6B`, 70 percent).
   - Right: caps label "MEMORY" (`#0E7C6B`), "70% free" (34 px bold), "Forge is holding 3 things."
   - A list of held items. Each row: a 34 px round tinted icon, the item name (14 px bold), a 5 px usage bar (track `#E6E4DD`, fill `#0E7C6B`), and a 44 px round "x" button labelled "Take out <name>".
     - "Handbook", book icon on `#D5F2EA`, bar 62 percent.
     - "Photo", picture icon on `#F6E9C8`, bar 22 percent.
     - "This conversation", speech bubble icon on `#E8E0FF` (violet `#5B3FC4`), bar 12 percent.
   - Two buttons: "Add" (plus icon, light) and "Clear memory" (trash icon, dark primary).

Navigation: funds Add goes to Add funds (`DAddFunds`). Spending goes to `XSpendingLight`. Take out exports the balance as eCash. Memory Add opens the Add sheet (`ZAdd`). Each "x" removes one item. Clear memory empties memory.

### Listening (`XListenLight.dc.html`)

Purpose: the held state of the talk button.

Top to bottom:
1. Status bar (Private, $9.99).
2. Live transcript card (white, radius 22): caps label "HEARING YOU" in teal, then the words so far in 20 px semibold: "Does the notice apply to side streets, and what should I".
3. Rings as on Home. The centre button shows nine white level bars (9 px wide, heights 22 to 86 px) and the label "Let go to send".
4. Hint under the rings: "0:07. Slide your finger off the button to cancel."
5. Footer row, 13 px semibold: left "Audio stays on this phone" (teal), right "under $0.01" (`#8A6410`).

States: recording with timer. Release sends. Slide off cancels.

### The answer (`XAnswerLight.dc.html`)

Purpose: show and speak the reply.

Top to bottom:
1. Status bar (Private, $9.99).
2. Answer card (white, radius 26, fills the space, padding 20).
   - Speaker icon plus "Speaking, 0:04 of 0:09" (13 px, teal). The answer is read aloud.
   - Headline: "No. The ban covers the square only." (26 px bold).
   - Detail: "Side streets stay open. Bring water, a copy of your ID, a charged phone and a paper map." (17 px, `#3F4348`).
   - Three action tiles, min height 60, radius 18, icon over an 11 px label: "Again" (speaker icon, replays audio), "Share" (up arrow, opens Share this answer `DShareOut`), "Burn" (flame, deletes this answer).
3. Smaller rings, 200 px (stroke 15), with a 112 px centre button: mic icon and "Hold to reply".
4. Bottom row: Type, Add, More.

### History (`XHistoryLight.dc.html`)

Purpose: answers kept on the phone until their timer burns them.

Top to bottom:
1. Back header, title "History".
2. Intro: "Each answer is kept until its timer runs out, then it is gone."
3. Answer cards (white, radius 22). Each has a 40 px tinted type icon, the question in 16 px bold, an optional answer line, and a burn timer row: flame icon, 6 px bar, time left.
   - Camera icon on `#F6E9C8`: "Does this notice apply to side streets?" Answer "No. The ban covers the square only. Side streets stay open." Bar 96 percent teal, "23h left".
   - Globe icon on `#D5F2EA`: "Translate the letter into Spanish". Bar 38 percent gold `#8A6410`, "9h left".
   - Light bulb icon on `#DCE9FF`: "What should I bring on Saturday?". Bar 6 percent red `#B3402F`, "40 min left".
   - Bar colour shows urgency: teal when plenty, gold when half, red when nearly gone.
4. Button "Burn all now": flame icon, white fill, 2 px border `#B3402F`, red text, min height 60, radius 20.

Reached from More, History.

### Spending (`XSpendingLight.dc.html`)

Purpose: a receipt of costs with no content.

Top to bottom:
1. Back header, title "Spending".
2. Paper receipt, 318 px wide, white, font JetBrains Mono. Shadow `0 1px 2px rgba(20,22,26,0.1), 0 6px 0 rgba(20,22,26,0.05)`.
   - "FORGE AI" (18 px bold, letter spacing 0.2em). "TODAY. NO NAME ON THIS RECEIPT."
   - Dashed rule (2 px `#B9B5AA`).
   - "01 READ A PHOTO $0.001", "02 TRANSLATE $0.002", "03 VOICE QUESTION $0.001".
   - Dashed rule. "ADDED (CARD) $10.00", "SPENT $0.004", "BALANCE $9.99" (bold 15 px).
   - Dashed rule. "Shows what each request cost, never what you asked. Kept on this phone only."
   - Footer "SHREDS ITSELF IN 1 DAY".
3. Three action tiles: "Save" (download arrow), "Share" (up arrow), "Shred" (flame).

Reached from Funds and memory, Spending.

### Mode and look (`XThemes.dc.html`)

Purpose: pick the mode and the colour look.

Top to bottom:
1. Title "Mode and look" (26 px bold). No back button.
2. Caps label "MODE".
3. Large selected card (dark `#14161A`, radius 24, min height 92): grid icon (three squares and a circle), "Default" (22 px bold), "Rings and talk. On now." and a teal `#3FCFB4` dot.
4. Two smaller cards side by side (white, radius 18): "Classic" with speech bubble icon and "Chat layout"; "Playful" with smiley icon and "Game cover".
5. Caps label "LOOK".
6. Three look cards (white, radius 20). Each has a 60 x 84 thumbnail with mini rings, a name, a line and a radio dot.
   - "Light", "Calm and ordinary." Selected: 2 px border `#14161A`, filled radio.
   - "Dark", "Softer on the eyes at night."
   - "Midnight", "Black, for dark rooms."
7. Row "Follow the phone setting" with value "Off".
8. Primary button "Done".

Reached from More, Mode and look. Choosing Classic switches to the Classic mode screens. Choosing Playful leads to Playful mode setup (`KidsGrownUp`).

### More sheet (`ZMore.dc.html`)

Purpose: the menu behind the More button.

Layout: status bar stays. Rings and button stay but fade to 35 percent opacity. A floating white card (radius 26, shadow `0 12px 40px rgba(20,22,26,0.18), inset 0 2px 0 rgba(255,255,255,0.75)`) sits above the bottom row. Rows have a 44 px tinted icon tile, a 16 px bold title, a 12 px subtitle and a right chevron.
- "Guides", book icon on `#D5F2EA`, "Browse and add handbooks". Goes to `GLibrary`.
- "History", clock icon on `#F6E9C8`, "Answers, until they burn". Goes to `XHistoryLight`.
- "Protection", shield icon on `#FBDAD5`, "Forge and your phone". Goes to `PProtect`.
- "Mode and look", sun or gear icon on `#DCE9FF`, "Default, Classic, Playful". Goes to `XThemes`.

Bottom row: Type, Add, and the third button is dark and reads "Close".

### Add sheet (`ZAdd.dc.html`)

Purpose: add something to memory for the next question.

Same overlay as More. Rows:
- "Photo", camera icon on `#F6E9C8`, "Take one or pick one. Faces are covered." Goes to Photo check (`DPhoto`).
- "File", document icon on `#DCE9FF`, "A document. Only its text is used."
- "Link", link icon on `#FBDAD5`, "Fetched for you, out of sight." Goes to Read a link (`DLink`).
- "Guide", book icon on `#D5F2EA`, "Answer from a trusted handbook." Goes to `GLibrary`.

Bottom row: Type, then a dark "Close" in the Add slot, then More.

### Add funds (`DAddFunds.dc.html`)

Bottom sheet. Title "Add funds" with a close "x" button (44 px).

Group 1, caps label in teal: "CANNOT BE LINKED TO YOU". Rows have teal border `#9AD3C8`, a 44 px icon tile with gold `#8A6410` icon, title, subtitle and chevron.
- "Card", card icon, "Tap a Forge eCash card bought with cash." Goes to `DCard`.
- "Voucher", QR code icon, "Scan the code on a paper voucher." Opens the camera scanner.
- "eCash", coin stack icon, "Paste or scan a Cashu token, from your wallet or a friend."

Group 2, caps label in gold: "DEPENDS ON WHERE THE MONEY COMES FROM". Rows have grey border `#E3E0D8`.
- "Lightning", lightning bolt icon, "Private from your own wallet. An exchange that knows your name will see this payment."
- "On-chain", link icon, "Bitcoin payments are public and permanent."
- "Other mint", swap arrows icon, "eCash from another Cashu mint, converted."

### Tap your card (`DCard.dc.html`)

Bottom sheet.
1. Title "Tap your card". Line "No bank, no email, no name. The card holds eCash, like a prepaid card bought with cash."
2. A 260 x 164 card drawing: "FORGE ECASH" (ECASH in gold), contactless waves icon, "$10.00". Border `#D9B45A`.
3. "Hold the card to the back of your phone" (18 px semibold) and "Keep it there until the balance updates."
4. Info box: "Moves to this phone" with "$10.00" in gold. Below: "After the tap the card is empty and the money is in this app. Forge cannot tell who bought the card or who tapped it."
5. Two secondary buttons: "Scan a voucher" and "Other ways" (back to Add funds).

State: waiting for NFC tap. Success goes to `DFunded`.

### After the tap (`DFunded.dc.html`)

Bottom sheet titled "Wallet".
1. Balance card: "BALANCE", "$10.00" (52 px bold), "Added from card. The card is now empty." in teal.
2. Info list: "A typical private message" / "under $0.01". "This balance covers" / "over 1,000 messages". Note: "You only pay for what you send. Take the rest back as eCash at any time."
3. Gold-bordered warning: "This money lives on this phone". "There is no account to recover. If the phone is lost or erased, the balance is gone. Keep small amounts here."
4. Primary "Start chatting" (goes to Home). Secondary "Take balance out as eCash".

### Private only (`DPrivateOnly.dc.html`)

Bottom sheet titled "Choose a model".
1. Teal panel: "Private only" with "Show only models nobody else can read, including Forge and Tinfoil." and a switch, on (52 x 30 track `#0E7C6B`).
2. Model cards. Each has a name, tag chips (radius 999, 12 px) and a price line.
   - "gpt-oss-120b" (selected, 1 px border `#14161A`): chips "Private" (padlock, teal), "Fast" (gauge), "Reasoning" (bulb). "$0.19 in, $0.75 out per 1M. A typical message is under $0.01."
   - "Gemma 4 31B": Private, Fast, Images (picture). "$0.50 in, $1.25 out per 1M".
   - "Kimi K3.1 Pro": Private, Images, Reasoning. "$5 in, $25 out per 1M".
3. "3 more private models".
4. Dashed box: "Standard models are hidden". "The gateway and the model provider can read Standard chats. Turn off Private only to see them."

No Default mode screen links here (see open questions).

### Passphrase lock (`DLock.dc.html`)

Full screen, padding 24 20.
1. 56 px round teal padlock badge.
2. "Locked" (26 px bold). "Chats and balance on this phone are encrypted. Enter your passphrase to open them."
3. Label "Passphrase", password field (height 56, radius 16), primary "Open".
4. Box: "Forge cannot reset this". "There is no account and no recovery. After 10 wrong tries, everything on this phone is erased."
5. Danger outline button "Erase everything now".

### Erase (`DErase.dc.html`)

Bottom sheet titled "Erase". Line "This cannot be undone. Nothing is kept on Forge servers, so nothing can be restored."
1. Option "Chats only", speech bubble icon. "Removes every chat and attached text. Your $10.00 balance stays."
2. Option "Everything", red trash icon, red title and red border `#B3402F`. "Removes chats, settings and the wallet. Your $10.00 balance is destroyed unless you take it out first."
3. Gold box: "Have a minute? Save the balance as an eCash code you can scan back in later." with gold outline button "Take out $10.00 first".
4. Settings list: clock icon "Delete chats automatically after" / "1 day" (teal). Key icon "Second passphrase opens an empty app" / "Off".
5. Red filled button "Hold to erase everything" (hold, not tap).

Reached from the trash button on Protection (`PProtect`).

### First run

**As built (`C-Welcome`, `C-Pay`, `C-Limits`, `C-Private`, approved by the owner 2026-11-14).** Four steps on the dark Night ground (`#0B0D10`, text `#F5F5F7`, body `#A1A4AB`, gold `#E2B552`, teal `#3FCFB4`) in every look, then the home. One frame on every step (390 by 844): a top row with the teal "Listen" pill left, the step dots centred (the current one 22 px wide) and "Skip" right (no Skip on step 4); a 300 px hero at the same place on every step, two rings (gold outer, teal inner) lit a quarter, a half, three quarters and fully, around a picture in a dark disc; a 32 px heading and a 17 px lead; a 76 px round white Next button with an arrow (a check named "Start" on step 4); at most one icon-and-text link below it (none on step 1; its 48 px row is kept on every step, so the hero, the text and Next stay in place).
1. Welcome: a hooded person with no face. "AI that doesn't know who you are." / "No account. No name. You pay like cash." No link: the round Next button only. (Until 2026-11-15 the invite code and Start free were this step's link; the owner, after trying it on a phone: "when I added the invite code I expected the first run screens to go away", so they moved to the last step.)
2. How you pay: a stack of gold coins. "Pay a little, per question." / "You see the price before you send." Link: info icon, "Learn more" (the ways to pay, the two rings, funds work like cash).
3. What it hides: an eye with a line through it (a slashed eye). "Know what it hides." / "Only the AI can read what you type. Your connection shows, unless you use Tor." Link: list icon, "See the full list" (what Forge hides and cannot hide).
4. Private only: a padlock. "Private by default." A "Private only" switch card, On by default (teal, closed padlock): "Only private models. Forge cannot read what you type." Off (warm red, the padlock opens): "Standard models are shown too. They can read what you type." Learn more is a small info ("i") icon button at the card's right end, after the switch (48 px, "Learn more about Private only"), opening the same sheet; the C-Private board's "Learn more" link is replaced by it. Link: while the engine has free models and the phone has no balance key, gift icon, "Start free with an invite": a "Start free" sheet with the invite field, a primary "Start free", "Free models answer at no cost. Add money later for private models." and a small "I'll add money instead" (keeps the code for funding and closes the sheet; the step stays). Once the balance is open, the Private only question (docs/PAYMENTS.md, Free models); either answer is applied (Use free models turns Private only off and chooses the free model; Keep Private only leaves it on), the switch shows it, and the first run ends on the home, as the check button does, the answer's words in a toast. Else, while the engine asks for an invite code, ticket icon, "I have an invite code" (the field in a sheet, kept for funding). With a balance key already, no link.

The phone's Back goes to the step before. On a shorter phone the gaps, then the hero, shrink alike on every step so nothing scrolls. The rings fill between steps unless reduced motion is on.

The earlier boards below are kept for reference; the C boards replace them.

Four numbered steps, then the limits screen. Every step has a "Listen" chip top right. Steps 2 to 4 have a plain "Back" text button top left.

**Welcome (`DWelcome.dc.html`).** Step 1 of 4.
1. Top row: wordmark "FORGE AI" (AI in gold, letter spacing 0.2em); buttons "English" (language picker) and "Listen".
2. Headline "AI that doesn't know who you are." (32 px bold).
3. List card: "No account, no name, no email" / "There is nothing to sign up for." "Paid like cash" / "eCash cannot be traced back to you." "Read only inside sealed hardware" / "Not by Forge, not by the model provider. You can check the proof." "Kept on this phone only" / "Chats and money. Erase both whenever you want."
4. Field "Invite code", placeholder "Paste or scan your code".
5. Primary "Continue". Footer "Step 1 of 4. Takes about two minutes."

**The two rings (`DHowPay.dc.html`).** Step 2 of 4.
1. Headline "Two rings to watch".
2. A 190 px ring sample with an empty 102 px centre button.
3. Card with a gold ring dot: "Gold is your funds". "Load it with a paper note or a card. Each question uses a little, usually under one cent, and you see the price first."
4. Card with a green ring dot: "Green is memory". "How much more Forge can hold in mind: photos, guides, the conversation. Clear it whenever you like."
5. Gold-bordered note: "Funds work like cash in a pocket. If this phone is lost, the money on it is lost. Keep small amounts."
6. Primary "Continue". "Step 2 of 4".

**First funds (`DFirstFunds.dc.html`).** Step 3 of 4.
1. "What do you have?" and "Pick one. You can add more later."
2. Four options (52 px icon tiles, gold icons). The first two have teal borders.
   - "A card or paper voucher", card icon, "Tap the card or scan the code."
   - "Someone is giving me some", gift icon, "Scan the code on their phone. It works with no internet between you."
   - "Bitcoin", lightning icon, "Lightning or on-chain. We explain how to keep it unlinked from you."
   - "Nothing yet", question icon, "See where to get a card or voucher, or ask the person who invited you."
3. Secondary "Skip and look around first". "Step 3 of 4".

**Protect this phone (`DProtect.dc.html`).** Step 4 of 4.
1. "If someone takes this phone". "Two choices now. Both can be changed later."
2. "Lock the app with a passphrase" with a password field, placeholder "Four or more words is best". Note "Forge cannot reset it. If you forget it, chats and money on this phone are gone."
3. "Delete chats automatically" with four segments: "On close", "1 day" (selected, dark), "7 days", "Never".
4. Teal panel "Already on": "Private models only. Your network address hidden from Forge. Photos and files cleaned before sending."
5. Primary "Continue". Text button "Not now". "Step 4 of 4".

**Know the limits (`DLimits.dc.html`).** After step 4.
1. "You are set. Know the limits." "Forge protects a lot. It cannot protect against these."
2. Gold-bordered list: "What you type" / "Names, places and details in your own words can identify you. Leave out what the question does not need." "A phone that is already watched" / "Spyware or someone looking at the screen sees everything you see." "Being forced to unlock" / "Auto-delete helps here. Deleted chats cannot be shown to anyone." "Wrong answers" / "AI makes mistakes. Check anything your safety depends on."
3. Teal call-out button: white shield-check icon on a teal tile, "Protect this phone now", "6 steps. A few minutes.", chevron. Goes to `PProtect`.
4. Primary "Start" (goes to Home).
5. Footer "This list and the steps are always under More."

### Photo check (`DPhoto.dc.html`)

Bottom sheet titled "Check this photo". "Tap anything else you want covered. The original stays on this phone."
1. Photo preview (300 px tall) with gold-outlined cover boxes: "Face", "Face", "Phone number".
2. Three tool buttons (min height 64): "Cover" (eye with slash, selected dark), "Crop" (crop icon), "Text only" (T icon).
3. List: "Location and device details" / "Removed" (teal). "2 faces, 1 phone number" / "Covered" (gold).
4. "Automatic detection can miss things. Look before you send."
5. Footer row: "Gemma 4 31B, private" (teal) and "under $0.01" (gold).
6. Primary "Add to message". Goes to Review before send.

### Read a link (`DLink.dc.html`)

Bottom sheet titled "Read a link". "The page is fetched for you inside the enclave. The site never sees your phone or your address."
1. Field "Link" with "https://example.org/notice".
2. List: "Tracking codes in the link" / "Removed". "What the site sees" / "An anonymous visitor". "What Forge sees" / "Nothing readable". Values in teal.
3. Preview card: "PAGE TEXT, ABOUT 900 WORDS" and the opening text.
4. Gold note: "Pages behind a login cannot be read this way. Share the page text or a screenshot instead."
5. Footer: "Fetch and read" / "under $0.01". Primary "Add to message".

### Review before send (`DReview.dc.html`)

Full screen.
1. Header: teal padlock badge plus model name "Gemma 4 31B"; balance pill "$10.00" (border `#D9B45A`).
2. Space.
3. Composer panel (radius 24, border `#E3E0D8`): caps "READY TO SEND"; a 76 px photo thumb "Photo" / "3 covered"; "From your voice, 0:12" (teal) and "Recording erased. Tap the text to fix it."; an editable text area with "Does the notice I photographed apply to side streets, and what should I bring?"; a list "Leaves this phone" / "1 image, 15 words", "Who can read it" / "Only the enclave", "Price" / "under $0.01"; primary "Send".
4. Footer in teal: "Private: encrypted to a verified enclave."

### Inbox (`DInbox.dc.html`)

Bottom sheet titled "Inbox". "Sent here from other apps. Cleaned on this phone. Nothing leaves until you ask about it."
- "Photo", picture icon, "From Signal. 2 faces covered. Sender removed."
- "Voice note, 0:42", mic icon, "From SimpleX. Turned into text on this phone."
- "Link", link icon, "example.org/notice. Tracking codes removed."
- "PDF, 3 pages", document icon, "From Files. Text only, the file stays here."
Each row has a chevron. Footer: clock icon, "Items are deleted after 1 day, or when you clear the inbox." Danger outline button with trash icon: "Clear inbox".

### Shared in from a messenger (`DShareIn.dc.html`)

Bottom sheet titled "Shared to Forge". Opens from the phone's share sheet. "From Signal. Cleaned on this phone before anything is sent."
1. Shared item card: dashed photo placeholder "Photo of a notice" and the shared text "Can someone check if this applies to us on Saturday?"
2. List: "Sender name and number" / "Removed". "Photo location and device details" / "Removed". "Faces and phone numbers" with a gold outline button "Review 2" (goes to Photo check).
3. Field "What do you want to know?" with "Does this apply to side streets?"
4. Footer "Gemma 4 31B, private" / "under $0.01".
5. Buttons: secondary "Add to chat" (1 part) and primary "Ask in a new chat" (2 parts).

### Share an answer out (`DShareOut.dc.html`)

Bottom sheet titled "Share this answer". "Sent straight from this phone. No link is created and nothing is uploaded to Forge."
1. Card "WHAT WILL BE SHARED" with the answer text, and the teal note "Answer text only. No model name, time, cost or your question."
2. Format tiles (min height 64): "Text" (T icon, selected dark), "Voice" (mic, goes to `DVoiceNote`), "Image" (picture), "PDF" (document).
3. Row "Include my question" / "Off".
4. Caps teal label "END-TO-END ENCRYPTED APPS ON THIS PHONE" and three buttons with teal borders: "Signal", "SimpleX", "Session".
5. Secondary "Copy. Clipboard clears in 60 seconds".
6. Gold-bordered button "Other apps" with "Email, SMS and most social apps keep a readable copy on their servers."

Reached from Share on the answer screen.

### Send as a voice note (`DVoiceNote.dc.html`)

Bottom sheet. "Send as a voice note". "Changed on this phone. Your real voice is never sent."
1. Player row: 44 px dark play button "Play the changed voice", "Listen before you send", "0:18, in the new voice".
2. Option "New voice, same words" (selected, 2 px dark border), tag "Moderate protection" (gold). "Works in any language or dialect. Harder to recognise, not impossible. Your rhythm and dialect stay."
3. Option "Read by a synthetic voice" (disabled, dashed border), tag "Strong protection" (teal). "No trace of your voice. Tone is lost. Not reliable in the language you spoke, so it is turned off for this note."
4. Option "Type it instead", tag "No voice at all". "The safest choice when you can write the message."
5. Row "Voice" with button "Neutral 2. Change".
6. Note "The original recording is erased when you send or cancel. Background sounds are removed."
7. Primary "Choose where to send" (goes back to the app picker in Share this answer).

### Guides library (`GLibrary.dc.html`)

1. Back header "Guides".
2. "Ask a trusted guide out loud, in your language. Nobody learns which guide you opened or what you asked."
3. Guide cards (white, radius 22, 56 px tinted icon tile, chevron):
   - "Freeing a political prisoner", "World Liberty Congress", "Handbook. Ask in [N] languages." Book icon on `#D5F2EA`.
   - "Country reports", "Human Rights Foundation, Tyranny Tracker", "179 countries and territories." Globe icon on `#DCE9FF`.
   - "[GUIDE TITLE]", "Human Rights Foundation", "[TOPIC]. Ask in [N] languages." Book icon on `#F6E9C8`.
   - "Add a guide", "Scan a code from an organisation you trust", "It is checked and stored on this phone." QR icon on `#E8E0FF`.
4. Bottom: a 60 px round "Type" button (keyboard), a 196 px ring set with a 108 px centre button "Ask all guides", and a 60 px round "Scan" button (QR).

Tap a guide to open `GOpen`.

### A guide, ready to ask (`GOpen.dc.html`)

1. Back header "Guide".
2. Title "Freeing a political prisoner" (24 px bold). "World Liberty Congress. Updated [DATE]."
3. Teal panel with shield-check icon: "Answers come only from this guide. If it does not cover your question, Forge says so."
4. Caps "PEOPLE OFTEN ASK" and three tappable questions: "Someone was arrested. What do I do first?", "Who should I contact, and who should I not?", "What is safe to say on the phone?"
5. Bottom: "Type" round button, rings with "Hold to ask", "Read" round button (book icon, opens the guide text).

### An answer from the guide (`GAnswer.dc.html`)

1. Back header titled with the guide name.
2. Answer card: "Speaking in Persian, 0:05 of 0:21" (teal, speaker icon); headline placeholder "[THE FIRST STEPS, AS THE GUIDE GIVES THEM, IN THE PERSON'S OWN LANGUAGE]"; a quote box "THE GUIDE'S OWN WORDS" with a quote icon, "[SHORT PASSAGE QUOTED FROM THE GUIDE]" and a button "Open this page, section [N]"; source line "From the World Liberty Congress handbook, not from the AI's own knowledge. That cost under $0.01."
3. Four action tiles: "Again" (speaker), "Simpler" (lines icon), "Share" (up arrow), "Burn" (flame).
4. Bottom: "Type", rings with "Hold to ask more", "Read".

### Protection (`PProtect.dc.html`)

1. Back header "Protection", with a red trash button on the right labelled "Erase" (goes to `DErase`).
2. Caps "FORGE IS DOING THIS FOR YOU" and a 2 x 2 grid of teal chips: "Address hidden" (globe), "Messages private" (speech bubble), "Payments unlinked" (coins), "Hardware checked" (shield check).
3. Caps "YOUR PHONE, 2 OF 6 DONE" with "iPhone" on the right, and an 8 px progress bar at 33 percent.
4. Six step rows (white, radius 18, 42 px tinted icon). Each ends in a small dark "Do it" button or a teal check plus "Done".
   - "Turn on Lockdown Mode", shield on `#FBDAD5`, "Blocks many advanced spyware attacks." Do it.
   - "Update the phone", download arrow on `#DCE9FF`, "Updates close the holes spyware uses." Done.
   - "Use a passcode, not your face", padlock on `#F6E9C8`, "A face or finger can be forced." Do it.
   - "Restart every day", power icon on `#E8E0FF`, "Clears some spyware that does not survive a restart." Do it.
   - "Make messages disappear", stopwatch on `#D5F2EA`, "In the messengers you use." Done.
   - "Talk to a security expert", person on `#E9F5C9` (green `#4C7A12`), "A free helpline for people at risk." Do it (goes to `PExpert`).
5. Footer "Forge cannot scan your phone or change its settings. It shows you where to go, using published advice from security researchers."

"Do it" opens that step (`PStep`).

### One step, with a button (`PStep.dc.html`)

1. Back header "Step 1 of 6".
2. Step card: shield tile and "Turn on Lockdown Mode" (24 px bold). Four labelled blocks: "WHAT IT DOES" / "Blocks many of the ways advanced spyware gets into an iPhone." "WHAT YOU GIVE UP" / "[WHAT STOPS WORKING, FROM THE SOURCE]". "WHERE IT IS" / "Settings, Privacy and Security, Lockdown Mode." "ADVICE FROM" / "Amnesty International Security Lab. [OTHER SOURCES]" (teal).
3. Primary "Open Settings" with external link icon (deep link to the phone setting). Two light buttons: "I did it" and "Not for me".
4. Bottom: round "Listen" (reads the step aloud), rings with "Hold to ask why", round "Helpline" (person icon, goes to `PExpert`).

### Live help (`PExpert.dc.html`)

1. Back header "Live help".
2. "Talk to a security expert" (26 px bold). "A real person. They never see your name, number or address unless you tell them."
3. Card "Free helpline", speech bubble on teal tile. "For activists and journalists. Answers within about two hours." Teal tags "Free", "Day and night", "10 languages". "Say what is wrong. Forge writes it up and removes details that identify you. You check it before it goes." Primary "Ask for help" (goes to `WRecord`).
4. Card "Call an expert now", phone handset on gold tile. "A checked expert answers in minutes. Phone to phone, no phone number." Gold tags "Paid by the minute", "From your balance", "2 online". Outline button "Start a call".
5. Footer "Experts are independent. Forge connects you and carries the payment. It cannot hear the call."

### Witness: say what happened (`WRecord.dc.html`)

1. Back header "Witness".
2. "Say what happened." (26 px bold). "In your own words, in your language. It stays on this phone until you choose to send it."
3. A 220 px red talk button (`#B3402F`), white mic icon, "Hold to talk". No rings on this screen.
4. Two buttons: "Add a photo" (camera) and "Add a file" (download arrow).
5. Info card with padlock: "Forge writes it up, marks the time, and seals it so it cannot be changed later."

### Witness: check it and send (`WReview.dc.html`)

1. Back header "Your account".
2. Sealed card: padlock "Sealed 12 Nov, 14:02. 1 photo." The written account with two dark redaction chips "a name" and "a place". "2 details are hidden. Tap one to show it again."
3. Caps "SEND IT TO". Dark button with speech bubble: "The free helpline", "A security expert answers within about two hours."
4. Two buttons: "Someone I trust" (up arrow) and "Keep it sealed" (download arrow).
5. Footer "The seal shows the account was not changed after this time. It does not prove the account is true."

### Shutdown: no internet, still ask (`SHome.dc.html`)

Home in offline state.
- Left pill changes to "No internet" with a wifi-off icon. Colours: text `#9A4B06`, fill `#FBEBDB`, border `#E5B98A`.
- Balance pill "$9.99".
- Card above the rings: two phones icon, "You can still ask." "Your question travels phone to phone until one of them is online."
- Rings and centre button "Hold to ask". Bottom row Type, Add, More.

### Shutdown: on its way (`STravel.dc.html`)

1. Back header "On its way".
2. Card "YOU ASKED": "How do I wash tear gas out of someone's eyes?"
3. Progress card with four steps. Done steps have a teal 32 px circle with a white check.
   - "Sealed" (done): "Only Forge can open it. Not the phones that carry it."
   - "Paid for" (done): "Under $0.01 is locked inside. Only Forge can spend it."
   - "Travelling" (current, orange ring `#C2600A` on `#FBEBDB`): "Passed to 3 phones near you so far."
   - "Answer comes back" (pending, grey outline): "The same way, sealed so only this phone can open it."
4. Clock icon note: "This can take hours. If no answer comes in 3 days, the money returns to you."
5. Buttons "Show as a code" (QR icon) and "Hand to a phone" (two phones icon). Footer "Someone leaving the area can carry it out for you."

### Shutdown: answer arrives later (`SAnswer.dc.html`)

1. Top row: "No internet" pill and a teal "Answer arrived" pill with a check.
2. Answer card: "You asked 4 hours ago". Headline "Rinse with clean water for 10 to 15 minutes." Body "Tilt the head so the water runs away from the other eye. Do not rub. Take out contact lenses." Orange note "Answered 3 hours ago. It reached you through other phones." Buttons "Again", "Share", "Burn".
3. A 132 px dark "Hold to ask" button with no rings.

### Implied navigation map

- First launch: Welcome, The two rings, First funds, Protect this phone, Know the limits, then Home. Know the limits can jump to Protection.
- Home: hold the button, Listening, release, The answer. Tap either ring or the balance pill, Funds and memory. Add, Add sheet. More, More sheet.
- Funds and memory: Add (funds), Add funds, Card, After the tap. Spending, Spending. Take out, eCash export. Add (memory), Add sheet. Clear memory.
- Add sheet: Photo, Photo check, Review before send. Link, Read a link, Review before send. Guide, Guides library. File, text extraction (no screen).
- More sheet: Guides, History, Protection, Mode and look.
- Answer: Share, Share this answer, Voice, Send as a voice note. Burn deletes. History, Burn all now.
- Protection: Do it, One step. Helpline, Live help, Ask for help, Witness record, Witness review. Trash, Erase.
- Phone share sheet: Shared to Forge. Items not asked about yet wait in Inbox.
- App start with a passphrase set: Passphrase lock.
- Offline: Home shows No internet, On its way, Answer arrived.

## 3. Classic and Playful in brief

**Classic mode** is the original chat layout on a dark ground (`#0B0D10`). Home (`Home`, `HomeLight`) has a model chip "gpt-oss-120b" and a "$10.00" balance at the top, a status line "Private only is on. Address hidden. Chats locked on this phone." with "Details", a prompt "What can I help with?" with two suggestion cards ("Read a document for me", "Ask by voice"), and a composer "Message Forge AI" with More, File, Photo, Speak and Send, a price "under $0.01" and "Private: encrypted to a verified enclave." `HomeTray` opens a tray with Link, Inbox and Add funds. `Shield` lists who can see what, a hardware check with "See proof", and Erase. `Bridge` shows Forge as a contact inside a private messenger: eCash attached, a reply with its cost, and "refund" returning change locked to your key. `Speak` transcribes on the phone with an option to use the enclave. The other Classic screens match the `D*` screens in Default mode, in dark colours. Small wording differences: Classic `HowPay` explains pay as you go in three numbered steps instead of the two rings, and Classic `Limits` ends "You can read this again in Settings."

**Playful mode** is a cover. `KidsCover` opens as a game ("Pip's Garden", Level 7, match three); holding the character opens the helper. `KidsHome` is the same rings home on purple `#4B3FC9` with a round yellow helper "Pip", "Private", "Lots left" in place of a price, "Hi! What are you wondering about?", "Hold to talk" and Type, Add, More. `KidsChat` is the answer read by Pip with Again, Share, Burn, "Hold to reply" and "Pip can get things wrong. Check big things with a grown-up you trust." `KidsGrownUp` (dark) sets it up: "Who is it for?" Me (a cover, everything works) or A child (age-suited answers, uncensored models blocked, a daily spending cap, sharing off, chats deleted on close), "Open as a game first" On, "How to open the helper" Hold Pip 3 seconds, name and icon "Pip's Garden", "Hide prices and wallet" On, and "Turn on playful mode". `CoverPicker` offers six covers (Momo Orchard, Zuri Blocks, Sol Dash, Noor Lanterns, Tala Stars, Kai Waves) or a custom name, with "Surprise me" and "Use this cover".

## 4. Design tokens

No oklch values appear in the canvas. All colours are hex. The canvas has no design system attached (`designSystems` is empty).

### Light (Default mode; all `wk` page files, for example `ZHome1`, `ZBoth`, `DAddFunds`)

| Token | Value | Use |
|---|---|---|
| bg | `#F6F5F1` | Page background, light button fill, icon tile fill |
| sheet-backdrop | `#D9D6CD` | Strip above bottom sheets |
| surface | `#FFFFFF` | Cards and buttons |
| ink | `#14161A` | Text, primary buttons, talk button |
| text-2 | `#5B6068` | Secondary text, chevrons |
| text-body | `#3F4348` | Answer body, receipt small print |
| line | `#E3E0D8` | Borders and dividers |
| line-2 | `#DAD8D0` | Thumbnail and quote button borders |
| bar-track | `#E6E4DD` | Progress bar track |
| grabber | `#C9C6BE` | Sheet grabber |
| dash | `#B9B5AA` | Dashed rules and placeholders |
| teal | `#0E7C6B` | Private, memory ring fill, good values |
| teal-tint | `#E3F4F0` | Private pill and teal panel fill |
| teal-line | `#9AD3C8` | Teal borders |
| memory-track | `#D5F2EA` | Memory ring track, teal icon tiles |
| teal-bright | `#3FCFB4` | Selected dot in Mode and look |
| gold | `#D4A544` | Funds ring fill, balance dot |
| gold-track | `#F3E3BC` | Funds ring track |
| gold-ink | `#8A6410` | Gold text and icons, prices |
| gold-line | `#C9A24A` | Balance pill border |
| gold-callout | `#D9B45A` | Gold warning box borders |
| gold-tint | `#F6E9C8` | Gold icon tiles |
| danger | `#B3402F` | Erase, burn soon, witness talk button |
| danger-tint | `#FBDAD5` | Red icon tiles |
| low | `#C2600A` | Memory ring when low, travelling step |
| low-tint | `#FCE9D6` | Low ring track, low chip fill |
| low-line | `#E7B98A` | Low chip border |
| low-ink | `#8A3A12` | Low chip text |
| offline-ink | `#9A4B06` | No internet pill text |
| offline-tint | `#FBEBDB` | No internet pill fill |
| offline-line | `#E5B98A` | No internet pill border |
| blue / blue-tint | `#2459B8` / `#DCE9FF` | Category icon |
| violet / violet-tint | `#5B3FC4` / `#E8E0FF` | Category icon |
| green / green-tint | `#4C7A12` / `#E9F5C9` | Category icon |

### Dark (from `XThemes.dc.html` thumbnail and `XKit4Soft.dc.html`)

The canvas does not draw any final screen in Dark. Values found:

| Token | Value | Source |
|---|---|---|
| bg | `#161B24` | XThemes thumbnail, XKit4Soft page |
| surface | `#1E2530` | XKit4Soft cards |
| line | `#313A48` | XKit4Soft borders |
| text | `#F1EFE9` | XKit4Soft |
| text-2 | `#A9AFB8` | XKit4Soft |
| gold | `#D4A544` | Funds ring fill |
| gold-track | `#3A3320` | XThemes thumbnail |
| memory | `#3FCFB4` | Inner ring fill |
| memory-track | `#16302C` | XThemes thumbnail |
| talk button | `#F1EFE9` | XThemes thumbnail centre dot (light button on dark) |

### Midnight (from `XThemes.dc.html` thumbnail and the Classic mode screens, for example `Home.dc.html`, `AddFunds.dc.html`)

| Token | Value | Use |
|---|---|---|
| bg | `#0B0D10` | Page background |
| surface | `#111317` | Cards, input fill |
| surface-2 | `#171A22` | Sheets, chat bubbles |
| line | `#2A2F3A` | Borders |
| grabber | `#3A404C` | Sheet grabber |
| text | `#F1EFE9` | Text, primary button fill (with `#0B0D10` text) |
| text-2 | `#9A9DA3` | Secondary text |
| teal | `#3FCFB4` | Private and good values |
| teal-line | `#2C5A55` | Teal borders |
| teal-tint | `#16292A` | Teal panel fill |
| gold | `#D4A544` | Funds, prices, gold icons |
| gold-line | `#6B5527` | Gold borders |
| danger | `#F0685A` | Erase |
| ring tracks | `#3A3320` gold, `#16302C` memory | XThemes thumbnail |

Extra accents in the dark experiments (`XKit3Dark`, `XKit4Soft`): `#7FB4FF` blue, `#B9A2FF` violet, `#C6E66B` lime.

### Playful (from `KidsHome.dc.html`, `CoverPicker.dc.html`)

`#4B3FC9` background purple, `#3A30A6` deeper purple, `#1B1440` ink, `#FFD23F` and `#FFC21A` yellow, `#FF8A7A` coral, `#3DDC97` green, `#FFFFFF`.

### Fonts

- Inter, weights 400, 500, 600, 700 (Google Fonts). Used everywhere.
- JetBrains Mono, 400 and 700. Spending receipt only (`XSpendingLight`).
- Classic `Bridge` also loads Space Grotesk 500/600 and JetBrains Mono 400/500, but the visible text uses Inter.

Type sizes in Default mode: 34 (big numbers in Funds and memory), 32 (welcome headline), 26 to 28 (page headlines, answer headline), 22 (sheet titles), 18 (header titles), 20 (live transcript), 15 to 17 (body and buttons), 13 to 14 (secondary), 12 (caps labels, letter spacing 0.06em, uppercase), 11 (action tile labels). Wordmarks use letter spacing 0.2em.

### Radii

Most used: 18 (list cards, option cards), 16 (buttons, inputs), 14 and 12 (tool tiles, segments, chips), 20 to 22 (pills, bottom row, answer and history cards), 24 (sheet top, mode card), 26 (big cards in Funds and memory, answer card, floating menu). Full circles for round buttons. Tags use 999.

### Spacing

Frame 390 x 844. Page padding 16 (first run and lock use 20 or 24). Block gap 14 (sheets 10 to 14). Bottom row gap 8. Card padding 14 to 20. Minimum touch target 44 px. Bottom row buttons 60 px tall. Primary buttons 56 px tall.

### Shadows

| Name | Value | Use |
|---|---|---|
| shadow-raised | `inset 0 -5px 0 rgba(20,22,26,0.09), inset 0 2px 0 rgba(255,255,255,0.75), 0 1px 2px rgba(20,22,26,0.08)` | White buttons and cards on Default core screens |
| shadow-raised-sm | `inset 0 -4px 0 rgba(20,22,26,0.08), inset 0 2px 0 rgba(255,255,255,0.75), 0 1px 2px rgba(20,22,26,0.08)` | White cards on `D*` sheets |
| shadow-primary | `inset 0 -5px 0 rgba(0,0,0,0.45), inset 0 2px 0 rgba(255,255,255,0.14)` | Dark primary buttons (`-4px` on small ones, `-7px` on the Default mode card) |
| shadow-talk | `inset 0 -9px 0 rgba(0,0,0,0.4), inset 0 3px 0 rgba(255,255,255,0.14)` | 204 px talk button (`-5px` on the 108 to 112 px versions) |
| shadow-witness | `inset 0 -9px 0 rgba(0,0,0,0.3), inset 0 3px 0 rgba(255,255,255,0.18)` | Red witness talk button |
| shadow-float | `0 12px 40px rgba(20,22,26,0.18), inset 0 2px 0 rgba(255,255,255,0.75)` | More and Add floating menus |
| shadow-receipt | `0 1px 2px rgba(20,22,26,0.1), 0 6px 0 rgba(20,22,26,0.05)` | Spending receipt |
| shadow-teal | `inset 0 -4px 0 rgba(14,124,107,0.14)` | Teal call-out on Know the limits |

The look is tactile: buttons have a darker inner bottom edge and a light inner top edge, so they read as pressable keys.

### Ring geometry

| Size | Box | Outer r / stroke | Inner r / stroke | Centre button |
|---|---|---|---|---|
| Home | 336 | 150 / 26 | 121 / 26 | 204 |
| Answer | 200 | 87.5 / 15 | 69.5 / 15 | 112 |
| Guides, step | 196 | 85.5 / 15 | 67.5 / 15 | 108 |
| First run sample | 190 | 82.5 / 15 | 64.5 / 15 | 102 |
| Funds and memory | 92 | 37 / 16 (one ring each) | | none |

Round caps. Start at 12 o'clock (rotate -90). Fill length = circumference x fraction.

## 5. Open contradictions and gaps

Each item names the version on the Default mode page.

1. **Talk button label.** "Hold to talk" on `ZHome1`, `ZMore`, `ZAdd`. "Hold to ask" on `ZHome2`, `SHome`, `SAnswer`, `GOpen`. Pick one for the home.
2. **Voice goes straight to the answer, or through review?** `XListenLight` says "Let go to send". `DReview` shows "From your voice, 0:12. Recording erased. Tap the text to fix it." before Send. Decide when Review appears (perhaps only when something was added).
3. **Model name and chat words leak from Classic.** `DReview` shows "Gemma 4 31B" and "$10.00" in a chat-style header. `DPhoto` and `DShareIn` show "Gemma 4 31B, private". `DShareIn` buttons say "Add to chat" and "Ask in a new chat". `DFunded` says "Start chatting" and "over 1,000 messages", while `ZBoth` says "over 900 questions". The rings home has no model name and no chats.
4. **Screens with no way in.** In Default mode nothing links to Private only (`DPrivateOnly`), Inbox (`DInbox`), Passphrase lock settings, or Know the limits. `DLimits` says "This list and the steps are always under More", but `ZMore` lists only Guides, History, Protection, Mode and look.
5. **No typing screen.** The Type button appears on every home screen, but Default mode has no screen for typing.
6. **File from the Add sheet** has no follow-up screen (only Photo and Link do).
7. **Inner ring colour in the Light thumbnail.** `XThemes` draws the Light inner ring in `#3FCFB4`. The Light screens use `#0E7C6B`.
8. **Running low.** `ZHome2` turns only the memory ring orange. The funds ring stays gold at 20 percent with $2.10. No low-funds warning or threshold is shown.
9. **Ring scale.** No screen says what a full funds ring means (85 percent at $9.99).
10. **Burn, Shred, Erase, Delete.** Answers "Burn" (`XAnswerLight`, `XHistoryLight`). The receipt "Shred" and "SHREDS ITSELF IN 1 DAY" (`XSpendingLight`). Settings "Delete chats automatically" (`DProtect`, `DErase`). Whole app "Erase". Default mode has no chat list, so "chats" in these strings needs a decision.
11. **Private pill** is not a button in the markup. Decide whether it opens Protection.
12. **Close button icons.** `ZAdd` "Close" keeps the plus icon. `ZMore` "Close" keeps the dots icon.
13. **Placeholders.** `GLibrary`, `GOpen`, `GAnswer` and `PStep` contain bracketed placeholders such as "[N]", "[GUIDE TITLE]", "[DATE]", "[WHAT STOPS WORKING, FROM THE SOURCE]", "[OTHER SOURCES]". Classic `Speak` and early `Voice` contain "[PRICE]".
14. **Witness review header** reads "Your account" while the canvas label says "Witness 2". `WRecord` uses a red talk button with no rings.
15. **Paper note scan.** `DHowPay` says "Load it with a paper note or a card". No screen scans a paper note. The nearest is "Voucher: Scan the code on a paper voucher." in `DAddFunds` and "Scan a voucher" in `DCard`. No scanner screen exists.
16. **Share unseen (photo protection with before and after)** is not in the canvas. The nearest is Photo check (`DPhoto`), which shows cover boxes on one image, not a before and after pair.
17. **Dark and Midnight** exist only as thumbnails in `XThemes` and as the Classic and experiment screens. No Default mode screen is drawn in Dark or Midnight.
18. **Duplicate screens across pages.** Most `D*` files in Default mode are Light copies of Classic files (for example `DAddFunds` and `AddFunds`). Build from the `D*` version.
