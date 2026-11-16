# Playful mode

Status: first two screens built, 2026-11-16, on branch `playful`. The home and the answer work with the real app. The set-up sheet, child limits and the cover game are not built (Build next, below).

Playful is a second `mode` module (docs/MODULES.md): the same app with Pip, bright colours and big buttons on the home and the answer screen. It is made for people who read poorly and for children, and as a friendly cover. The owner's design is four artboards (390 by 844): Playful home (`KidsHome`), Playful answer (`KidsChat`), the set-up sheet (`KidsGrownUp`) and the cover game (`KidsCover`). The first two are built here.

## What exists

- **Choosing it.** More, Mode and look lists the modes as choices: Default (rings and talk) and Playful. The chosen one is the big card with "On now." Choosing either takes one tap, and Default is the default. The choice is kept in the settings and stays after a reload.
- **Playful home.** The Private (or Standard) chip and the star chip at the top; Pip with a speech bubble; the gold and green rings round a white Hold to talk button; the bar of Type (yellow), Add (green) and More (coral). Hold to talk is the Default button (hold, slide off to cancel, haptics, the blockers). Type, Add and More open what they open on Default. The rings open Funds and memory.
- **Playful answer.** The same chips; a white card with a small Pip and a line that says what Pip is doing ("Pip is reading it to you" while the answer is read aloud, in green); the answer's first sentence big and the rest under it; Again, Share and Burn in the card; the smaller rings round Hold to reply; the bar; and "Pip can get things wrong. Check big things with a grown-up you trust."
- **Pip.** One small module that draws Pip at any size in five moods, for any screen to reuse.
- **The fonts.** Baloo 2 (display) and Nunito (text), vendored, loaded only while Playful is on.

## How it is wired

| File | What it is |
|---|---|
| `public/v2/modules/mode/playful/manifest.json` | The module's manifest (`forge.mode.playful`, kind `mode`). Listed in `core/registry.js` BUNDLED after Default. |
| `public/v2/modules/mode/playful/index.js` | `create(inputs)` returns `{id: 'playful', ready, home, answer}`. It has no imports, so a phone in Default fetches only this file. `ready()` loads the two screens, `playful.css` and the two typefaces (waiting up to 1.5 s for them). |
| `public/v2/modules/mode/playful/home.js` | The Playful home. |
| `public/v2/modules/mode/playful/answer.js` | The Playful answer. |
| `public/v2/modules/mode/playful/parts.js` | The top chips, the bar, Pip taking the app's short messages, the phone's bar colour. |
| `public/v2/modules/mode/playful/logic.js` | The pure rules, tested in Node: the star chip's words (`starLevel`), what Pip says on the home (`homeMessage`) and on the answer (`answerLine`), and the answer's first sentence (`splitLead`). |
| `public/v2/modules/mode/playful/pip.js` | Pip. |
| `public/v2/modules/mode/playful/playful.css` | The styles, all under `.pf` (the two Playful screens), and the two `@font-face` pairs. Put in the page after `style.css` by `ready()`. |
| `public/v2/vendor/baloo-2/`, `public/v2/vendor/nunito/` | The typefaces (Latin and Latin Extended variable woff2) with a VERSION.json of their SHA-256. |
| `public/vendor/licenses/baloo-2.txt`, `nunito.txt` | Their licences (SIL Open Font License 1.1). |
| `scripts/vendor-playful-fonts.ts` | Copies the fonts from the fontsource packages pinned in package.json. |

### The mode setting

- `mode` in the settings (`core/state.js` DEFAULT_SETTINGS: `'default'`). `pickMode(ready, settings)` gives the mode to draw: the chosen one once its screens are in, else Default.
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
- **The cover game** (`KidsCover`: "Pip's Garden", a match-three board with Moves and Flowers, Pip saying "Nice move!"). It belongs in a `cover` module (docs/MODULES.md), reusing `pip.js` (the artboard's Pip without the sprout is the same drawing) and the same colours.

## Build next (for the event)

1. The set-up sheet (Me or A child), opened from Playful's card in Mode and look.
2. Child limits for A child: answers suited to their age (a system prompt line), uncensored models blocked (they are hidden already), a daily spending cap, sharing off, conversations deleted on close (the auto-delete setting).
3. The cover game as a `cover` module, and the hold-Pip-to-open gesture (hold Pip 3 seconds) to go from the game to the helper.
4. Hiding prices everywhere while Playful hides them: Funds, Add money, Type's price line, the recording line, Ask again.
5. Restyling Type, the Add and More cards, Funds and History for Playful.
6. More Pip moods and short sounds (a chirp when listening starts, a pop when the answer comes).
7. Other languages: Pip's words are in the string table (`playful.*`), so they translate with the rest.

## Tests

- `test/unit/v2/playful.test.ts`: the mode setting, the star chip's words, what Pip says, the first sentence, the colours' contrast, and that the fonts are the pinned files with their licence, loaded only by Playful.
- `test/ui/playful.ui.test.ts` (`pnpm test:ui:linux test/ui/playful.ui.test.ts`): choosing Playful and back, kept after a reload, with Default fetching nothing of Playful; the home (Pip, the rings and the bar in their colours, 48 px controls, Type, Add and More); no money; a typed question answered in the card with Again, Share and a held Burn; Hold to talk recorded, cancelled and sent; the fit at 360 by 640, 390 by 844 and 412 by 915. `PLAYFUL_SHOTS=1` saves screenshots of the home and the answer to `.tmp/playful-shots/`.
