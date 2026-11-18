# Mode modules

A mode module draws the two screens a person sees most: the home and the answer. It may also draw a cover, a game the app opens on with the home behind it. The rest of the app (Type, Funds, Add money, More and its screens) stays the same in every mode. The person picks a mode in More, Mode and look. The app ships with two: Default, with the rings, and Playful, with Pip and its cover game, Pip's Garden.

Read [the overview](README.md) first. The bundled modes are in [`public/v2/modules/mode/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/mode) and described in the [module list](list.md#mode). Playful is described in full in [`docs/PLAYFUL.md`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/PLAYFUL.md).

## Manifest

`kind` is `mode`. The other fields follow [the manifest rules](README.md#the-manifest). For a mode the app has no strings of its own for, More, Mode and look shows the manifest's `name.en`.

## Inputs

A mode gets what the screens show and the actions of the home and the answer. `state` and `actions` are cut down to the functions listed for them.

```js
mode: ['t', 'ui', 'state', 'nav', 'actions', 'format'],
// PROJECTIONS
mode: {
  state: ['view', 'subscribe'],
  actions: ['ask', 'stop', 'again', 'copyAnswer', 'startFresh', 'burn', 'talkDown', 'talkMove', 'talkUp', 'talkCancel', 'speak', 'stopSpeaking', 'setSearch', 'togglePrivate', 'useFastModel', 'getNaturalVoice', 'naturalNotNow', 'coverProgress', 'saveCoverProgress'],
},
```

### `t`

`t(key, params)` returns the text for `key` from the string table. See [Fund](fund.md#t).

### `ui`

The whole of `core/ui.js`, the same object a fund module gets. See [Fund](fund.md#ui) for every function.

### `state`

What the screens show. It never holds the balance key.

| Function | What it does |
| - | - |
| `view()` | Returns the view: a new object with what the screens show now (below). |
| `subscribe(fn)` | Calls `fn()`, with no arguments, after every change. Returns a function that stops it. The app already calls a screen's `update()` after every change, so a mode rarely needs it. |

The fields of `view()`, from `view()` in [`public/v2/app.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/app.js):

| Field | What it is |
| - | - |
| `model` | The model questions go to: an entry of [`GET /v1/models`](../API.md#get-v1-models), or `null`. |
| `private` | `true` when that model is private (with no model, when Private only is on). The chip at the top left shows it, and `togglePrivate()` switches it. |
| `online` | `false` while the phone is offline. |
| `hasKey` | `true` when the phone has a balance key. |
| `balanceMsub`, `balanceText` | The balance in msub and in words, or `null`. |
| `fundsFraction`, `freeFraction` | How full the gold ring is: the paid part and the free questions part, 0 to 1. |
| `freeLeft`, `freeTotal` | Free questions left, and how many there were. |
| `fundsBlock` | What stops a question for lack of funds: `null`, or a reason such as `'needKey'` or `'freeOut'`. |
| `modelFree` | `true` when the model costs nothing. |
| `startFree` | `true` when the engine has free models a balance opened with an invite code can use. |
| `noFunds` | `true` with no balance and no free questions. |
| `scanNote` | `true` when the home should invite a paper note scan. |
| `refundable` | What can be taken out, in the balance's unit. |
| `questionsLeft` | About how many questions the balance pays for. |
| `memory`, `held` | How much of the model's memory the conversation uses (`memory.free`, `memory.low`, `memory.percentFree`, ...), and what is held for the next question. |
| `pendingCount` | Files and photos waiting for the next question. |
| `lastExchange` | The last question and its answer: `{question, answer}`, where `answer` has `content` and `meta`. `meta.error` is set when it failed. `null` before any question. |
| `streaming` | `true` while an answer comes in. |
| `waitSince` | When the app started waiting for the first words, or `null`. |
| `hiddenCount` | Models Private only hides. |
| `talk` | The talk button: `available`, `phase` (`idle`, `recording`, `sending`), `seconds`, `level`, `inside`, `text`, `error`, `maxSeconds`, `priceMsub`, `route`, `freeOk`, `freeVoice`, `freeVoiceOut`, `unit`. |
| `search` | Search the web: `{available, on}`. |
| `speak` | Listen: `available`, `state`, `progress`, `current`, `viaEngine`, `priceMsub`, `offer`. |
| `againMsub` | The most Ask again can cost, or `null`. |
| `free` | `true` on a free model, `{left, total}` when the next question uses a free question, else `null`. |
| `historyVersion` | Goes up when conversations are burned. |
| `answerModel` | The model that wrote the answer on show: `{id, name, private, speed}`, or `null`. |
| `fastModel` | A fast model the slow-answer note can switch to, or `null`. |
| `freeModels` | `true` when the engine lists free models. |
| `cover` | `true` when the app opens on this mode's cover (it has `cover()` and "Open as a game first" is on). Playful shows its game button then. |

### `nav`

`nav(name, params = {}, {replace = false})` opens a screen by its route name from `ROUTES` in [`public/v2/core/router.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/router.js): `home`, `game`, `type`, `answer`, `add`, `more`, `funds`, `addFunds`, `model`, `voice`, `history`, `photo`, and the others there. `replace` replaces the current history entry instead of adding one. While the cover is on, `nav('game')` goes back to the cover at the start of the history, and `nav('home')` goes back to the home just above it, so Back from the home shows the game and Back from the game never shows the home.

### `actions`

The answer and voice actions. None of them takes money out.

| Function | What it does |
| - | - |
| `ask(text)` | Asks a question with the files waiting for it, opens the answer screen and starts the answer. |
| `stop()` | Stops the answer coming in. |
| `again()` | Asks the last question again. |
| `copyAnswer()` | Copies the last answer and says so. |
| `startFresh()` | Starts a new conversation. |
| `burn()` | Removes the open conversation from the phone, then goes home. |
| `talkDown()`, `talkMove(inside)`, `talkUp()`, `talkCancel()` | Hold to talk: the button goes down, the finger moves (`inside` is `false` when it slid off), comes up, or the recording is cancelled. |
| `speak()` | Reads the last answer aloud. |
| `stopSpeaking()` | Stops reading aloud. |
| `setSearch(on)` | Search the web for the next question only. |
| `togglePrivate()` | Switches between a Private and a Standard model: the chip at the top left of the home and the answer. The first time it leaves Private on a phone, the app asks Start free's question first. |
| `useFastModel()` | Switches a slow answer to a fast model and asks again there. |
| `getNaturalVoice()` | Downloads the natural voice, then reads the answer. |
| `naturalNotNow()` | Stops offering the natural voice on this phone. |
| `coverProgress()` | The cover game's own record on this phone (whatever it saved last), or `null`. |
| `saveCoverProgress(data)` | Keeps the cover game's record, in the app's database beside the settings. Erase everything removes it. |

### `format`

Amounts in words: `units`, `int`, `cost`, `plain`, `parse` and `modelPrice`. See [Fund](fund.md#format).

## What a mode provides

### `id`

Required. A short name such as `'default'`. The settings keep it when the person picks the mode.

### `home(options)`

Required. Draws the home. `options` is `{sheet, open}` when the person opened the Add or More menu: `sheet` is the menu's element, which the mode must show over or in its home, and `open` is `'add'` or `'more'`. With no menu open it is called with no argument. Returns a screen.

### `answer()`

Required. Draws the answer screen for the open conversation. Returns a screen.

### `cover()`

Optional. Draws the cover: a game the app opens on, with the home behind it ([`docs/PLAYFUL.md`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/PLAYFUL.md), The cover game). Returns a screen, which shows at the route `game`. A mode with a cover opens on it while "Open as a game first" is on (on by default; More, Mode and look shows the switch for Playful): fresh, after a reload, and whenever the app comes back from the background. The cover goes to the home with `nav('home')`. While it shows it should show nothing of the app: Playful's sets the page's title and icon to the game's and holds the app's short messages until the home opens.

### `ready()`

Optional. Loads what the mode's screens need. The app calls it before it first draws the mode, when the person picks it and at start on a phone where it is chosen, and draws Default until it resolves. A rejection leaves Default on; when the person just picked the mode, the app says it could not load. Playful keeps its screens, stylesheet and typefaces out of the first paint this way.

### The screen

`home` and `answer` return a screen, the same shape every screen of the app has:

| Field | What the app does with it |
| - | - |
| `node` | Required. The app puts it in the page in place of the screen before. |
| `update()` | Optional. Called after every change of state while the screen shows. Read `state.view()` here. |
| `destroy()` | Optional. Called when the screen is replaced. |
| `focus` | Optional. An element the app moves the focus to when the person arrives on the screen (never on the first paint, and never on the home). |

## Lifecycle

1. The registry calls `create(inputs)` once when the app starts, with the looks, before the first screen is drawn.
2. A chosen mode other than Default: the app calls `ready()` before the first frame.
3. On every navigation to the home, the Add or More menu, the answer or the cover, the app calls `home(options)`, `answer()` or `cover()` again and calls `destroy()` on the screen before.
4. While a screen shows, the app calls its `update()` after every change of state.

## Errors

- A `create` that throws gets the mode refused, and it is not listed. The app needs at least one mode: with none it stops.
- A rejected `ready()` leaves Default on. When the person just picked the mode, the app says it could not load (`look.modeFailed`).
- `home`, `answer` and `update` run inside the app's drawing. An exception there stops the screen from being drawn. Catch errors inside them.
- An answer that failed has `lastExchange.answer.meta.error` set, with `code` and `message`. The Default mode shows it in plain words with one next step.

## How the app lists and orders them

More, Mode and look ([`public/v2/screens/settings.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/settings.js)) lists every mode in the order of `BUNDLED`, the one in use as the big card. Default and Playful have a name, a line and an icon in the app's strings; any other mode shows its manifest's `name.en` and the `grid` icon. `pickMode` in [`public/v2/core/state.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/state.js) uses the chosen mode once its `ready()` has resolved, else `default`.

## Platforms

A mode works the same on the website and in both apps. Classic, the chat page at `/`, is a plain link in Mode and look on the website; the apps do not show it.

## A minimal mode

This mode draws a plain home and a plain answer. It uses only its inputs and the app's existing strings. It is [`docs/modules/examples/mode/plain/`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/modules/examples/mode/plain), loaded through the registry by [`test/unit/module-docs.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/module-docs.test.ts).

`manifest.json`:

```json
{
  "id": "org.example.mode.plain",
  "kind": "mode",
  "version": "1.0.0",
  "name": {
    "en": "Plain"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

`index.js`:

```js
// A mode module: a plain home with the balance, one big Type button and More, and an answer screen with
// the question, the answer as plain text, Stop while it comes in, and Back. It uses only its inputs and
// the app's existing strings.
export function create({ t, ui, state, nav, actions }) {
  const btn = (id, icon, word, onclick, primary = false) => ui.el('button', { type: 'button', class: `btn block${primary ? ' primary' : ''}`, id, onclick }, ui.icon(icon, 22), ui.el('span', { text: word }));

  /** The home. With `sheet` (the Add or More menu) it shows the menu and a Close button. */
  function home({ sheet = null } = {}) {
    const balance = ui.el('p', { class: 'hint', id: 'plainBalance' });
    const type = btn('plainType', 'keyboard', t('home.type'), () => nav('type'), true);
    const more = sheet ? btn('plainClose', 'x', t('home.close'), () => nav('home')) : btn('plainMore', 'dots', t('home.more'), () => nav('more'));
    const node = ui.el('main', { class: 'screen sub', 'data-screen': 'home' }, ui.el('div', { class: 'scroll' }, balance, type, sheet), ui.el('div', { class: 'foot' }, more));
    const update = () => {
      balance.textContent = state.view().balanceText ?? '';
    };
    update();
    return { node, update, focus: type };
  }

  /** The answer to the last question, as it streams in. */
  function answer() {
    const question = ui.el('p', { class: 'hint', id: 'plainQuestion' });
    const text = ui.el('p', { id: 'plainAnswer' });
    const stop = btn('plainStop', 'stop', t('answer.stop'), () => actions.stop());
    const back = btn('plainBack', 'back', t('common.back'), () => nav('home'), true);
    const node = ui.el('main', { class: 'screen sub', 'data-screen': 'answer' }, ui.el('div', { class: 'scroll' }, question, text), ui.el('div', { class: 'foot' }, stop, back));
    const update = () => {
      const v = state.view();
      const ex = v.lastExchange;
      question.textContent = typeof ex?.question === 'string' ? ex.question : '';
      text.textContent = ex?.answer.meta?.error?.message ?? ex?.answer.content ?? '';
      stop.hidden = !v.streaming;
    };
    update();
    return { node, update, focus: back };
  }

  return { id: 'plain', home, answer };
}
```

To try it, copy the folder to `public/v2/modules/mode/plain/`, add `{ kind: 'mode', folder: 'plain' }` to `BUNDLED`, run `node scripts/v2-preload.ts`, and pick Plain in More, Mode and look.

## Tests

[`test/unit/v2/playful.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/playful.test.ts) tests Playful's pure rules and [`test/unit/v2/garden.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/garden.test.ts) its cover game's; [`test/ui/playful.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/playful.ui.test.ts) picks Playful in Chrome and walks its home and answer, and [`test/ui/game.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/game.ui.test.ts) plays the cover game and opens the helper behind it.
