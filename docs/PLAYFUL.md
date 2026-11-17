# Playful mode

Status: the home, the answer and the cover game built, 2026-11-16 (the game on branch `playful-game`); the game made harder, 2026-11-17 (Tuning the difficulty). The home and the answer work with the real app, and Playful opens on the game, Pip's Garden, with the helper behind it. The set-up sheet and child limits are not built (Build next, below).

Playful is a second `mode` module (docs/MODULES.md): the same app with Pip, bright colours and big buttons on the home and the answer screen. It is made for people who read poorly and for children, and as a friendly cover. The owner's design is four artboards (390 by 844): Playful home (`KidsHome`), Playful answer (`KidsChat`), the set-up sheet (`KidsGrownUp`) and the cover game (`KidsCover`). The home, the answer and the cover game are built here, and of the set-up sheet two of its lines: "Open as a game first" and its warning.

## What exists

- **Choosing it.** More, Mode and look lists the modes as choices: Default (rings and talk) and Playful. The chosen one is the big card with "On now." Choosing either takes one tap, and Default is the default. The choice is kept in the settings and stays after a reload.
- **Playful home.** The Private (or Standard) chip and the star chip at the top (with the game button before them while the game opens first: their words are never cut, and on a phone set to larger text the star chip's words go onto two lines); Pip with a speech bubble; the gold and green rings round a white Hold to talk button; the bar of Type (yellow), Add (green) and More (coral). Hold to talk is the Default button (hold, slide off to cancel, haptics, the blockers). Type, Add and More open what they open on Default. The rings open Funds and memory.
- **Playful answer.** The same chips; a white card with a small Pip and a line that says what Pip is doing ("Pip is reading it to you" while the answer is read aloud, in green); the answer's first sentence big and the rest under it; Again, Share and Burn in the card; the smaller rings round Hold to reply; the bar; and "Pip can get things wrong. Check big things with a grown-up you trust."
- **Pip.** One small module that draws Pip at any size in five moods, for any screen to reuse.
- **The cover game.** Playful opens on Pip's Garden, a match-three, with the helper behind it. Hold Pip for 3 seconds to open the helper. See The cover game, below.
- **The fonts.** Baloo 2 (display) and Nunito (text), vendored, loaded only while Playful is on.

## How it is wired

| File | What it is |
|---|---|
| `public/v2/modules/mode/playful/manifest.json` | The module's manifest (`forge.mode.playful`, kind `mode`). Listed in `core/registry.js` BUNDLED after Default. |
| `public/v2/modules/mode/playful/index.js` | `create(inputs)` returns `{id: 'playful', ready, home, answer, cover}`. It has no imports, so a phone in Default fetches only this file. `ready()` loads the screens (the home, the answer and the cover with its game), `playful.css`, the game's stylesheet and the two typefaces (waiting up to 1.5 s for them). |
| `public/v2/modules/mode/playful/home.js` | The Playful home. |
| `public/v2/modules/mode/playful/answer.js` | The Playful answer. |
| `public/v2/modules/mode/playful/parts.js` | The top chips (with the game button), the bar, Pip taking the app's short messages, the phone's bar colour. |
| `public/v2/modules/mode/playful/cover.js`, `games/garden/` | The cover game (The cover game, below). |
| `public/v2/modules/mode/playful/logic.js` | The pure rules, tested in Node: the star chip's words (`starLevel`), what Pip says on the home (`homeMessage`) and on the answer (`answerLine`), and the answer's first sentence (`splitLead`). |
| `public/v2/modules/mode/playful/pip.js` | Pip. |
| `public/v2/modules/mode/playful/playful.css` | The styles, all under `.pf` (the two Playful screens), and the two `@font-face` pairs. Put in the page after `style.css` by `ready()`. |
| `public/v2/vendor/baloo-2/`, `public/v2/vendor/nunito/` | The typefaces (Latin and Latin Extended variable woff2) with a VERSION.json of their SHA-256. |
| `public/vendor/licenses/baloo-2.txt`, `nunito.txt` | Their licences (SIL Open Font License 1.1). |
| `scripts/vendor-playful-fonts.ts` | Copies the fonts from the fontsource packages pinned in package.json. |

### The mode setting

- `mode` in the settings (`core/state.js` DEFAULT_SETTINGS: `'default'`), and `gameFirst` (`true`): Playful opens on its cover game. `pickMode(ready, settings)` gives the mode to draw: the chosen one once its screens are in, else Default.
- `app.js`: `modeNow()` picks the mode module that draws the home and the answer; `prepareMode(id)` calls the module's `ready()`; `actions.setMode(id)` (Mode and look) waits for `ready()`, then saves the setting. A mode that cannot load (offline and never fetched) leaves Default on and says so.
- At start, on a phone where Playful is chosen, the app calls `ready()` before the first frame. `index.html` paints the Playful ground and ring tracks on the boot frame from `forge2.mode` in localStorage (written only while a mode other than Default is on), so the phone does not flash the look's ground first.
- The mode module gets the same inputs as Default (`core/registry.js` INPUTS and PROJECTIONS) and no new action. Share uses the phone's own share sheet (`navigator.share`) where there is one; Copy is the existing `copyAnswer`.

### Reused, not forked

- Hold to talk is `screens/talk.js` `holdToTalk`, with two new options a mode may pass: its own microphone drawing (`glyph`) and its own words (`word`, "Hold to reply"). The state machine (`core/talkctl.js`) is untouched.
- The rings are `screens/parts.js` `rings()` with two new geometries in `core/rings.js` (`playful`, `playfulAnswer`: the design's 26 and 15 wide bands). The colours are the look's token names set under `.pf`, so the same code draws them; the glow, light and tip are hidden.
- The bar is `screens/parts.js` `bottomRow()`, which now takes optional pictures per button (Add is a plus).
- The answer uses the same Markdown loader (`screens/answer.js` `loadMarkdown`, now exported), `SLOW_MS`, `core/errors.js` `errorView`, `actions.speak` and `stopSpeaking`, `copyAnswer`, `again`, `burn` and `screens/burn.js` `holdToBurn`.
- Short messages: `core/ui.js` gains `catchToasts(fn)`. While a Playful screen shows, `ui.toast()` hands it the text, and Pip says it (the bubble on the home, the line on the answer). A message sent just before the screen changes (a blocker's toast, then Add money opens) is passed on to the next Playful screen or shown as the ordinary toast. Default never sets a catcher.

### Pip

`pip({size, mood, label})` returns `{node, set(mood)}`. Moods (`MOODS`): `idle` (the design's smile), `listening` (wide eyes, a round mouth, the sprout up), `thinking` (eyes up, a flat mouth, a thought), `reading` (happy closed eyes, a moving mouth), `oops` (worried brows, a wavy mouth, a drop). Each moves a little with SVG animation; with reduced motion nothing moves. With a `label` Pip is an image with that name; without one Pip is decoration beside words. The home uses the design's label ("Pip, a round yellow helper with a small sprout").

### The fonts

- From the fontsource npm packages, exact-pinned devDependencies installed with pnpm under the repo's minimum release age: `@fontsource-variable/baloo-2@5.3.0` and `@fontsource-variable/nunito@5.3.0` (published 2026-07-19). Nothing was added to `minimumReleaseAgeExclude` or `allowBuilds`.
- `node scripts/vendor-playful-fonts.ts` copies `*-latin-wght-normal.woff2` and `*-latin-ext-wght-normal.woff2` (about 33 and 27 KB for Baloo 2, 39 and 36 KB for Nunito), writes VERSION.json and the licences. The Latin Extended files load only for letters in their range.
- Only `playful.css` names them. They are not in `style.css`, the service worker's shell or the page's preload list, so Default never fetches them. The v2 worker keeps a copy once they are fetched (network first, like any app file), and the Android app carries them (every file under `public/v2/vendor` is bundled).
- Fallback where they cannot load: a rounded system face (`ui-rounded`, Arial Rounded MT Bold), then the system face.

## The cover game

The design's `KidsCover`: "Pip's Garden", a header with the level, "Match three to grow the garden.", a 5 by 5 board in four colours on a darker panel, Moves and Flowers with the level's goal between them, and Pip's card at the bottom. It is a real game, and it is the first screen while Playful is on and "Open as a game first" is on (the default).

### Playing

- **The board.** `SIZE` (5) tiles on a side and `KINDS` (4) kinds, constants in `games/garden/logic.js`. Each kind has its colour and its own picture, so colour is never the only cue: a sun on yellow (#FFD23F), a leaf on green (#3DDC97), a flower on coral (#FF8A7A), a drop on sky blue (#7FD4FF). The pictures are inline SVG in the ink colour.
- **Moves.** Drag a tile onto a neighbour, or tap one (it lifts) and then a neighbour. A swap that makes no run of three slides back and costs nothing; Pip says "No match." Runs of three or more clear, the tiles above fall, new ones drop in from the top, and new runs clear in turn (a chain). The board never starts or settles with no possible move: a board left stuck is reshuffled ("No moves left. New tiles!").
- **Flowers** (the score): 10 for each tile cleared, 10 more for each tile past three in one run, times the round's place in the chain (2 for the first cascade, 3 for the next). A chain grows many flowers; it does not count toward the goal.
- **Levels.** A level asks for so many tiles of one kind within 15 moves (`goalFor`): suns at level 1, leaves at 2, flowers at 3, drops at 4, then round again. Only the tiles the player's own swap matches count, not the ones a chain clears after it. Level 1 asks for 10 suns, and each level a little more, to 24 from level 15 on (`GOALS`). One swap can match at most 9 tiles of a kind (a row and a column through the cell its tile moved to), so no level is won in one move. Level done: "The garden bloomed!" and Next level. Out of moves: "Out of moves." and Play again (the same level, the flowers kept).
- **The goal** shows between Moves and Flowers: the kind's tile and how many are left ("10"). A screen reader hears its name first ("Suns to match: 10").
- **Pip's card** says what happened in a few words: "Nice move!" (or "Wow, a chain!") and how many are left, in words up to ten ("Three more suns to bloom."). A swap that matched none of the level's kind still grows flowers, and Pip points at the goal: "Match the suns!" A short tap on Pip makes Pip say a game line.
- **Motion.** The tiles move with transform and opacity only (a swap 170 ms, a clear 200 ms, a fall 260 ms). With reduced motion each step shows at once.
- **Kept on the phone.** The level, the flowers, the moves left, the goal tiles matched and the board, as `{v: 2, level, flowers, moves, got, board}`, in the app's database beside the settings (`kv` key `game`), through two actions the mode gets (`coverProgress`, `saveCoverProgress`). A reload opens the same board. A level just done is kept as the next level, so a phone closed then opens on it. Erase everything removes it with the rest of the database, and no write follows an erase.
- **A game kept under the first rules** (`v: 1`, which counted matches, chains too) keeps its level and its flowers and opens on a new board under these rules, with all 15 moves and none of the goal matched (`restore`). Nothing else changes, so the app needs no change for it.

### Tuning the difficulty

The first rules were far too easy. A 5 by 5 board with four kinds cascades a lot, and every match of a chain counted toward the goal, so one ordinary swap could finish a level (on a phone at Level 4, one swap chained into all eight matches). `node scripts/garden-sim.ts` plays every level many times from fresh boards with three simple players, using the real `logic.js` and a seeded random source, so the same arguments print the same table. The players see the board as a person does, and nothing of the tiles still to come: **random** takes any swap that matches; **greedy** takes the swap that matches most of the level's kind now (then most tiles), ties at random; **careless** is greedy, but one move in three is any swap.

Under the first rules every player won every level to 20, whatever it did (1,000 games a level):

| Level | Goal | Greedy won | Random won | Greedy moves used | Greedy won in 1 move | in 1 or 2 |
|---|---|---|---|---|---|---|
| 1 | 5 matches in 15 | 100% | 100% | 2.4 | 15% | 55% |
| 2 | 6 in 15 | 100% | 100% | 2.8 | 11% | 41% |
| 3 | 7 in 15 | 100% | 100% | 3.2 | 7% | 31% |
| 5 | 9 in 16 | 100% | 100% | 4.0 | 2% | 14% |
| 10 | 14 in 17 | 100% | 100% | 5.9 | 0% | 2% |
| 15 | 19 in 18 | 100% | 100% | 7.8 | 0% | 0% |
| 20 | 24 in 19 | 100% | 100% | 10.0 | 0% | 0% |

These rules (1,000 games a level):

| Level | Goal | Greedy won | Careless won | Random won | Greedy moves used | Fewest moves to a win |
|---|---|---|---|---|---|---|
| 1 | 10 suns in 15 | 100% | 97% | 72% | 7.2 | 3 |
| 2 | 11 leaves | 99% | 97% | 68% | 7.9 | 2 |
| 3 | 12 flowers | 99% | 97% | 65% | 8.0 | 3 |
| 5 | 15 suns | 96% | 86% | 37% | 10.2 | 4 |
| 10 | 22 leaves | 51% | 30% | 2% | 14.0 | 7 |
| 15 | 24 flowers | 34% | 17% | 1% | 14.5 | 8 |
| 20 | 24 drops | 38% | 16% | 1% | 14.5 | 8 |

No level was won in one move, by any player (it cannot be: see Levels). A chain still follows about every second move (1.85 rounds of clearing a move), and grows flowers.

The levers, all in `games/garden/logic.js`:

- `GOALS`: how many tiles each level asks for; levels past the table keep the last. The main lever: one more tile is about 5 to 8 points of the greedy player's wins around level 10.
- `MOVES`: moves in every level.
- What counts: `move` counts `goalTiles(steps[0].runs, kind)`, the tiles of the swap's own runs. Counting the chain's too (`steps`) puts luck back: a lucky chain wins a level.
- `KINDS`: a fifth kind cuts cascades (1.45 rounds of clearing a move against 1.85), but it is a cliff: the same 10 tiles that greedy wins 99% of the time with four kinds it wins 79% of the time with five, and a sixth on a 5 by 5 board leaves few moves. It also needs a new colour and picture. Since only the swap's own tiles count, cascades no longer decide a level, so the board keeps the design's four kinds at every level.
- `SIZE`: a 6 by 6 board does not keep 48 px targets at 360 by 640.

`test/unit/v2/garden.test.ts` (the difficulty) plays 300 seeded games a level with the greedy and random players, and fails when the curve leaves its bands: greedy wins level 1 to 3 at least 95% of the time and never wins level 1 in fewer than three moves; greedy wins level 10 between 40% and 60%, every level to 20 at least 25%, each level at most 12 points above the one before, and falls by five-level spans; random wins level 1 at least half the time, every level from 5 under half and from 10 under a tenth; no player wins any level in one move. After a change to the levers, run the script, then the test.

### Keyboard and screen readers

- The board is a grid of 25 buttons over the tiles, one tab stop: the arrow keys move along it, Enter or Space picks a tile up, an arrow key then swaps it that way, and Escape puts it down. Each button is named by its tile and place ("Yellow sun, row 1, column 2") and says whether it is picked. What happened is said in a live region ("No match. The tiles went back.", "Nice move! Two more suns to bloom. Flowers 60.").
- Pip is a button named only "Pip". Enter or Space held for 3 seconds opens the helper, as the hold does; a short press is a game line.
- A screen reader's activation cannot hold. As with Burn (`screens/burn.js`), the first activation of Pip makes Pip say a game line, and a second within 6 seconds opens the helper. Nothing on the screen or in the live region says so: a person glancing at the screen sees a game. Mode and look tells screen reader users ("With a screen reader, activate Pip two times in a row."), out of sight.

### The way in, and the way back

- **In:** hold Pip for 3 seconds (`cover.js` `HOLD_MS`). While Pip is held nothing on the screen fills, counts or changes. A release before 3 seconds is a tap.
- **Back to the game:** the helper's top row has a game button (four coloured tiles, named "Show the game"), on the home and the answer. The phone's Back button and the browser's Back from the helper's home also show the game.
- **Always the game first:** opened fresh, after a reload, or back from the background (the page was hidden: the phone's home button, another app, another tab), the app shows the game, whatever screen was open. It goes to the game as the page is hidden, so the phone's list of open apps shows the game too. Two exceptions: a file or photo picker the person opened from the app (the file comes back to the screen that asked for it), and a photo shared in from another app, which still opens Share unseen.
- **How it is routed** (`app.js`, `coverOn()`): the game is the route `game` (`#/game`) and always the first entry of the app's history; the helper's home is the entry above it. `nav('game')` goes back to that first entry (`leave`), `nav('home')` back to the home above it, a home with nothing under it gets the game put under it, and a Back or Forward that would leave the game for the helper (a page reloaded deep in the helper still has older entries) keeps the game. The Android app's back button walks the web history (`MainActivity`), so the same rules hold there; from the game it leaves the app. The iPhone app has no back button; leaving and coming back shows the game.

### What the cover hides, and what it does not

On the game screen there is no Forge name, logo, price, balance, model name or wallet control. The page's title is "Pip's Garden" and its icon a Pip face (`games/garden/icon.svg`), and index.html titles the very first frame so (`forge2.cover` in localStorage) and paints no rings on it. The phone's bar is the Playful purple. The app's short messages (a top-up finishing, say) are held while the game shows and said by Pip once the helper opens; one that a later message says is over (`hideToast`) is dropped.

Still showing through, not fixed in this pass:

- The app's name and icon on the phone's home screen, in the list of open apps, and in the phone's settings stay Forge (Android and iPhone), and so does the name in the web app's manifest (an installed web app). This pass does not change them, and nothing in the app says it does.
- Android's own splash screen at a cold start shows the app's icon for a moment.
- On the website: the address bar (the site's address and `#/game`), the browser's history, and Forward from the game (which the app turns back to the game, but the address changes for a moment).
- The app's storage names (`forge2`, `forge.balanceKey`) for someone who searches the phone or the browser's data. The warning says so: "This hides Forge from a quick look at your screen. It does not hide it from someone who searches the phone."
- Screen reader announcements made by other screens before the game came up are already spoken.

### The switch

"Open as a game first" is one row on More, Mode and look, under the modes, shown only while Playful is chosen. On by default (`gameFirst` in the settings, `core/state.js`), kept like the mode. Off, Playful opens straight to the helper, as before, and the helper has no game button. Under it: "Hold Pip 3 seconds to open the helper." (while it is on) and the design's warning, shown whenever Playful is chosen.

### Files

| File | What it is |
|---|---|
| `public/v2/modules/mode/playful/cover.js` | The cover screen: the game in Playful's frame, Pip and the hold (`holdPip`, `HOLD_MS`), the title, icon and bar colour, and the held messages. `GAME` names the game it shows. |
| `public/v2/modules/mode/playful/games/garden/logic.js` | The game's rules, with no imports: the board, runs, swaps, gravity and refill, no moves and the reshuffle, flowers, level goals (`GOALS`, `MOVES`), one whole move, and the record checked on load. Every chance comes from a `rand()` passed in. |
| `public/v2/modules/mode/playful/games/garden/index.js` | The game on screen: `mount(node, host)`. |
| `public/v2/modules/mode/playful/games/garden/garden.css` | Its styles, under `.gd`. |
| `public/v2/modules/mode/playful/games/garden/icon.svg` | The page's icon while it shows. |
| `scripts/garden-sim.ts` | Plays the levels many times with simple players and prints how hard each is (Tuning the difficulty). The unit test uses its players. |

### Add a cover game

A cover game is a folder in `public/v2/modules/mode/playful/games/`. It imports nothing of the app; the cover screen hands it all it gets. Its `index.js` exports:

- `title`: the string key of its name, the page's title while it shows (`'garden.title'`).
- `icon`: the address of the page's icon while it shows (`new URL('./icon.svg', import.meta.url).href`).
- `styles`: the address of its stylesheet, loaded with Playful's screens.
- `mount(node, {t, el, reduced, pip, progress})`: draws the game into `node` (the cover's `main`, on the Playful ground). `t` is the string table, `el` the app's element helper, `reduced()` true with reduced motion. `pip` is `{node, set(mood)}`: Pip as the button the cover owns (its hold opens the helper); the game places `pip.node` where Pip belongs and sets Pip's mood (`pip.js` MOODS). `progress` is `{load(), save(data)}`: the game's own record, any value that survives structured clone; check it on load. Returns `{tap(), held(), destroy()}`: `tap()` when Pip was tapped (say a line), `held()` when Pip was held and the helper is opening (keep the game), `destroy()` when the screen goes.

Then name it in `cover.js` (`GAME`), put its words in `public/v2/strings/en.js` under its own prefix, with nothing that names the app, and give it a unit test of its rules. Only one game shows today; choosing among several would be a setting beside "Open as a game first".

The registry has a `cover` kind (docs/MODULES.md: "a game screen plus a hidden way in"), with the inputs `t` and `ui`, and no module of it yet. The game's interface is made to move there: a cover module's `create({t, ui})` would return `{id, title, icon, styles, mount}`, and the mode (or the app) would pick the cover module in use instead of `GAME`. What it needs from the app is two things the `cover` kind does not have yet: Pip (from the mode) and its record (`coverProgress`, `saveCoverProgress`), which would become cover inputs. That move is not made here: it needs the registry to list cover modules, a setting to choose one, and the app to route to a cover without a mode, more than this pass needs.

## Where the design and the app differed

| Difference | Decision |
|---|---|
| Default's home shows the chosen model as a chip (with FREE on a free model) and an Add money or Start free button when there is no balance. The design has no model chip. | No model chip. With no balance key on a free model, Pip says "Start free first. Then ask me anything." with a Start free button (or Add money where the engine does not open free balances). With no money on a paid model: "Add money first." with Add money. Free questions used up: "Other ways". Choose a model stays in More. Holding the talk button with nothing to pay with still runs the app's blocker: its words, then Add money or Start free. |
| The money chip shows the balance. | The star chip says how much is left in words, never a price (`logic.js` starLevel): Lots left (10 or more typical questions at the model's listed price, `core/price.js` perQuestion, plus usable free questions), A little left (fewer, or a balance under one question), Some left (a balance on a model with no price in this unit), None left, Free to ask (a free model), Start free (a free model and no balance key). Offline with nothing known: Offline. Tapping it opens Funds and memory, as the money chip does; at Start free it opens Start free. |
| Default's answer has Listen, Copy, Ask again and Burn; the design has Again, Share, Burn. | Again is Listen (it reads the answer aloud again, or Stop while it reads; its price under it when the engine's voice is used). Share opens a row under the actions: Send (the phone's share sheet, only where the phone has one), Copy, and Ask again with its price. Burn is the held Burn. When an error's next step is Try again, Ask again is not offered twice. |
| The design's card has no question line. | The question is shown small above the answer, so a person can see what Pip heard. |
| The design shows no cost line under the answer. | No cost line on the Playful answer. The balance and each question's cost stay in Funds and History. Every paid step still shows its price before it is taken (Ask again, Try again, a recording, the engine's voice). |
| Errors, the wait before the first words, a cancelled recording, no funds, a blocked microphone. | Pip says them. The bubble on the home holds the app's short messages (Cancelled, Microphone blocked, Wait for the answer) with Pip worried, and the no-funds ways forward. On the answer, the line beside Pip says "Pip is thinking" with the seconds while the first words are awaited, the slow-model offer shows in the card after 20 s, and an error shows in the card with its one next step, Pip worried. |
| While a question is recorded Default shows a line under the rings (time, where the sound goes, the price). | On the home it is inside Pip's bubble, Pip listening. On the answer it shows under the small rings in place of the "Pip can get things wrong" line. |
| Default's home has Search the web for a spoken question. | Not on the Playful home. It is on Type, as on Default. |
| Default's answer offers the natural voice after the phone's voice read an answer. | Not offered on the Playful answer. It is in More, Voice. |
| Design sizes at 390 by 844. | At 360 by 640 Pip and the bar get smaller and the rings shrink to fit. The answer is one screen high: the card's words scroll inside it, the actions, the reply button and the bar stay in view. |
| The cover game's design has no Pip sprout, and fixed numbers (Level 7, Moves 12, Flowers 340). | The module's Pip, with its sprout. The level, moves and flowers are the game's own: a new phone starts at Level 1, Moves 15, Flowers 0. |
| The design's cover shows only words for Moves and Flowers. | Each has a small picture beside it (two arrows, a flower), for people who read poorly. |
| The design's goal is matches ("Three more matches to bloom."). | Each level asks for tiles of one kind, so one lucky chain cannot finish it (Tuning the difficulty): "Three more suns to bloom.", and the kind's tile with the number between Moves and Flowers. |
| The design has no way back from the helper to the game. | A game button in the helper's top row, and Back from the helper's home. |
| Contrast. | White on the purple is 7.4:1. The design's green line (#2E7D5B) on white is 5.0:1 and its soft ink (#4A4470) 8.9:1, both kept. A Standard route on the white bubble uses #A3392A (6.6:1). |

## Known gaps

- The other screens (the first run, Type, More's list, Add money, Funds, History, Mode and look and the rest) keep the look's style when opened from Playful. The phone's bar turns back to the look's colour on them, and the Add and More cards over the Playful home are the look's cards.
- The phone's bar flashes the look's colour for a moment while the app starts on a Playful phone (the page's ground does not).
- The Playful answer has no voice-offer card and no model line (see above).
- A phone that chooses Playful while offline, and never fetched it, stays on Default and says so.
- Pip's moods are simple and have no sound.
- English only.

## Not built yet, and how the built part leaves room for them

- **The set-up sheet** (`KidsGrownUp`: Who is it for, Me or A child; Open as a game first; How to open the helper, Hold Pip 3 seconds; Home screen name and icon; Hide prices and wallet). Choosing Playful in Mode and look is one tap today. The sheet would open from that card, and its answers would sit beside `mode` in the settings (for example `playful: {who, cover, hidePrices}`). Nothing in the built screens assumes there is no sheet.
- **The rest of the set-up sheet's lines**: "How to open the helper" (Hold Pip 3 seconds is the only way today), "Home screen name and icon: Pip's Garden" (the phone's app name and icon do not change in this pass; that needs Android's activity aliases and iPhone's alternate icons, and a web app's manifest), and "Hide prices and wallet".

## Build next (for the event)

1. The set-up sheet (Me or A child), opened from Playful's card in Mode and look.
2. Child limits for A child: answers suited to their age (a system prompt line), uncensored models blocked (they are hidden already), a daily spending cap, sharing off, conversations deleted on close (the auto-delete setting).
3. The cover game as a `cover` module (see Add a cover game), more games, and the phone's app name and icon as the game's.
4. Hiding prices everywhere while Playful hides them: Funds, Add money, Type's price line, the recording line, Ask again.
5. Restyling Type, the Add and More cards, Funds and History for Playful.
6. More Pip moods and short sounds (a chirp when listening starts, a pop when the answer comes).
7. Other languages: Pip's words are in the string table (`playful.*`), so they translate with the rest.

## Tests

- `test/unit/v2/playful.test.ts`: the mode setting, the star chip's words, what Pip says, the first sentence, the colours' contrast, and that the fonts are the pinned files with their licence, loaded only by Playful.
- `test/unit/v2/garden.test.ts`: the cover game's rules with a seeded random source (boards, runs, swaps, gravity and refill, chains, no moves and the reshuffle, flowers, level goals and what counts toward them, the record and a record kept under the first rules), the difficulty's bands (Tuning the difficulty), the setting, that Erase everything takes the record, that the game's words never name the app, and that the game imports nothing of the app.
- `test/ui/game.ui.test.ts` (`pnpm test:ui:linux test/ui/game.ui.test.ts`): Playful opens on the game and the game shows nothing of the app (the words, the title, the icon and the bar); a swap that matches and one that slides back; a level done and out of moves, seeded through the record so no test leans on luck; a record kept under the first rules; Pip held 3 seconds opens the helper and 1 second does not; the game button and Back; a reload, the app put away and brought back, and a helper address all show the game; messages held until the helper opens; the switch off opens the helper; the fit at 360 by 640, 390 by 844 and 412 by 915 (with a middle and a late level, and a six-figure score); the helper's top row with the game button, every chip's words in full on the home and the answer from 360 to 412 px wide, with the phone's text at 100 % and 130 %; keyboard play and the keyboard and screen reader ways in; Erase everything removes the record; Default fetches nothing of the game. `GAME_SHOTS=1` saves screenshots to `.tmp/game-shots/`.
- `test/ui/playful.ui.test.ts` (`pnpm test:ui:linux test/ui/playful.ui.test.ts`), with "Open as a game first" off: choosing Playful and back, kept after a reload, with Default fetching nothing of Playful; the home (Pip, the rings and the bar in their colours, 48 px controls, Type, Add and More); no money; a typed question answered in the card with Again, Share and a held Burn; Hold to talk recorded, cancelled and sent; the fit at 360 by 640, 390 by 844 and 412 by 915. `PLAYFUL_SHOTS=1` saves screenshots of the home and the answer to `.tmp/playful-shots/`.
