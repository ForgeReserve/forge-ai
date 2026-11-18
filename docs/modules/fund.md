# Fund modules

A fund module is one way to put money into a Forge balance: scan a paper note, paste eCash, pay a Lightning invoice, tap a card. Add money shows every fund module the engine allows, and each one draws its own screen.

Read [the overview](README.md) first for the manifest, the registry and what is built today. The bundled fund modules are in [`public/v2/modules/fund/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund) and described in the [module list](list.md#fund).

## Manifest

`kind` is `fund`. The other fields follow [the manifest rules](README.md#the-manifest). The bundled ones use ids such as `forge.fund.note`.

## Inputs

A fund module gets these inputs, in the registry's `INPUTS.fund` order. Every one is handed whole: no fund input is cut down.

```js
fund: ['t', 'ui', 'engine', 'wallet', 'vault', 'format', 'scan', 'qr', 'nfc', 'card', 'till'],
```

### `t`

`t(key, params)` returns the text for `key` from [`public/v2/strings/en.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/strings/en.js), with named slots such as `{amount}` filled from `params`. It throws `missing string <key>` for a key the table does not have. Every word a module shows comes from there.

### `ui`

The whole of [`public/v2/core/ui.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/ui.js): the helpers the app's own screens are drawn with.

| Function | What it does |
| - | - |
| `el(tag, attrs, ...children)` | Makes an element. `attrs`: `class`, `text`, `on<event>` handlers, `true` for an empty attribute; `null` and `false` are left out. `html` sets inner HTML and is for fixed markup only. Children may be nodes or text. |
| `icon(name, size = 20, stroke = 2)` | An inline SVG icon from the app's set, hidden from screen readers. |
| `ICONS` | The list of icon names `icon` knows. |
| `say(node, text, kind = '', ico = null)` | Writes `text` into `node` headline first: an icon, the first sentence in view, the rest behind a round info button. `kind` is `''`, `'err'`, `'ok'` or `'wait'`. Returns `node`. |
| `sayEl(tag, attrs, text, kind, ico)` | `say` into a new element. |
| `msgLine()` | A status line (`role="status"`) with `set(text, kind)`. A text with no kind that does not end in a full stop shows the wait icon. |
| `toast(text, ms = 2600)` | A short message at the bottom of the screen. |
| `announce(text)` | Says `text` to screen readers only. |
| `hideToast()` | Hides the toast now. |
| `copy(text)` | Copies to the clipboard. Resolves `true` or `false`. |
| `reduced()` | `true` when the person asked for reduced motion. |
| `infoToggle(panel, label, id)` | A round info button that shows and hides `panel`. |
| `tileButton({ico, label, onclick, cls, id, attrs})` | An icon button with a label. |
| `backHeader(title, onBack, backLabel)` | The back button and a centred title. |
| `listRow({ico, tint, title, sub, onclick, id, cls})` | A list row with a tinted icon, a title, a subtitle and a chevron. |
| `meterBar({id, label})` | A progress bar; its `set({fraction, text, phase})` moves it. |
| `headOf(text)` | Splits text into its first sentence and the rest: `[head, rest]`. |
| `catchToasts(fn)` | Lets a screen take the toasts while it shows (Playful mode does). |
| `load(key)` | Reads `localStorage[key]`, or `null`. |
| `store(key, value)` | Writes `localStorage[key]`; `null` removes it. |

### `engine`

The engine client from `createEngine` in [`public/v2/core/engine.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/engine.js), always the engine the person uses now (More, Engine can change it). Calls that take `key` need the balance key, which `wallet.key()` gives.

| Function | What it does |
| - | - |
| `base` | The engine's address: `''` for the page's own origin, else an origin such as `https://ai.forge-reserve.com`. |
| `call(path, {key, json, method, signal})` | Any JSON call. Resolves `{status, ok, body}` and never throws for an HTTP error. Throws `EngineError('offline')` when the engine cannot be reached. Answers a `428` proof-of-work challenge once. |
| `fundMethods()` | [`GET /v1/wallet/fund/methods`](../API.md#get-v1-wallet-fund-methods). Resolves the body; throws `EngineError` on an error. |
| `topup(key, token, invite)` | [`POST /v1/wallet/topup`](../API.md#post-v1-wallet-topup). Resolves `{status, ok, body}`. Use `wallet.topup` instead, which keeps the token safe. |
| `openBalance(invite, unit)` | [`POST /v1/wallet/open`](../API.md#post-v1-wallet-open). Resolves the body; throws `EngineError`. |
| `fundLightning(key, {amount, unit, invite})` | [`POST /v1/wallet/fund/lightning`](../API.md#post-v1-wallet-fund-lightning). Resolves `{status, ok, body}`. |
| `fundOnchain(key, {invite})` | [`POST /v1/wallet/fund/onchain`](../API.md#post-v1-wallet-fund-onchain). Resolves `{status, ok, body}`. |
| `foreignQuote(key, {token, unit, invite, pubkey, accept_unlisted})` | [`POST /v1/wallet/fund/foreign/quote`](../API.md#post-v1-wallet-fund-foreign-quote). Resolves `{status, ok, body}`. |
| `foreignConfirm(key, {id, token, pubkey})` | [`POST /v1/wallet/fund/foreign/confirm`](../API.md#post-v1-wallet-fund-foreign-confirm). Resolves `{status, ok, body}`. |
| `foreignMints(path)` | [`GET /v1/wallet/fund/mints`](../API.md#get-v1-wallet-fund-mints). Resolves the body; throws `EngineError`. |
| `funding(key, id)` | [`GET /v1/wallet/fund/{id}`](../API.md#get-v1-wallet-fund-id): one funding's state. Resolves `{status, ok, body}`. |
| `cardMint(body)`, `cardSwap(body)`, `cardRestore(body)` | The [Cashu card relay](../API.md#cashu-card-relay). No key. Resolve `{status, ok, body}`. |
| `models()`, `wallet(key)`, `refunds(key)`, `refund(key, {amount, pubkey})`, `transcribe(key, ...)`, `speech(key, ...)`, `chat(...)` | The rest of the client. No bundled fund module uses them. |

`EngineError` has `code` (the engine's error code, or `offline`, `http_<status>`, `bad_answer`), `message`, `status` and `retryable`. `retryable` is true for a server error, a `429`, and codes such as `topup_pending` and `mint_unavailable`: the same request may work later.

### `wallet`

The balance as a fund module sees it, from [`public/v2/app.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/app.js).

| Function | What it does |
| - | - |
| `key()` | The balance key, or `null`. |
| `setKey(k)` | Keeps a new balance key on the phone. Call it at once when an engine answer carries `body.key`. |
| `unit()` | The balance's unit, `'usd'` or `'sat'`, or `null`. |
| `inviteOnly()` | `true` when the engine opens new balances only with an invite code. |
| `invite()`, `setInvite(v)` | The invite code typed so far on this phone. |
| `refresh()` | Reads the balance again from the engine. Resolves when done. |
| `methods()` | The engine's [ways to pay](../API.md#get-v1-wallet-fund-methods), or `null` before they arrive. |
| `mints()` | The mints whose eCash the engine takes. |
| `mintAliases()` | Other addresses of those mints. |
| `units()` | The units the engine takes. |
| `lockKey()` | The public key the person locks payouts to, or `''`. |
| `privateOnly()` | Whether Private only is on. |
| `useFreeModels()` | Turns Private only off and chooses a free model. Returns the model, or `null`. Only after the person said yes. |
| `topup(token, invite)` | Adds eCash. Stores the token on the phone first ([the vault](#vault)), sends it, and removes it only once the engine credits it. Resolves `{credited, unit, replay}`, with `free: true` for a voucher of free questions. Throws `EngineError`; when `retryable` is true the token stays on the phone and is sent again later. |
| `topupFree(token)` | The same for a voucher of free questions, onto the free balance. |
| `isCredit(mint)` | `true` for the engine's credit mint, whose eCash is free questions. |
| `open(invite)` | Opens a balance with an invite code and nothing on it, for the free models. Resolves `{created, freeShown}`. |

### `vault`

eCash on its way in or out, kept in the phone's storage so a token is never lost. From `createVault` in [`public/v2/core/vault.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/vault.js). `wallet.topup` uses it for you; use it directly when a token goes somewhere else first, as Other mint does.

| Function | What it does |
| - | - |
| `hold(token, via = 'topup', extra = {})` | Stores a token before it is sent. Returns the entry `{id, token, via, state: 'pending', ...extra}`. Throws when the phone cannot store it: then do not send it. |
| `credited(id)` | Removes the entry once the engine confirmed the credit. |
| `pending(id, code)` | Marks it pending: the outcome is open, it is sent again later. |
| `refused(id, code, message)` | Marks it refused: the engine did not take it. Funds lists it so the person can copy it back out. |
| `discard(id)` | Removes a refused entry the person copied. |
| `incoming()`, `outgoing()` | The entries on their way in, and the payout tokens kept until saved. |
| `keepRefund({id, token, amount, unit})` | Keeps a payout token until the person says they saved it. |
| `saved(id)` | Removes a kept payout token. |

### `format`

Amounts in words. `usd` amounts are whole cents and `sat` amounts whole sats; `msub` is a thousandth of the unit.

| Function | What it does |
| - | - |
| `units(n, unit)` | `'$5.00'` for 500 usd, `'5,000 sat'` for 5000 sat. |
| `int(n)` | A whole number with separators. |
| `cost(msub, unit)` | A price: `'$1.20'` for 120000 msub in usd. |
| `plain(n, unit)` | A number for an input field: `'5.00'` for 500 usd. |
| `parse(s, unit)` | What a person typed, back to cents or sats. `NaN` when it is not an amount. |
| `modelPrice(m)` | A model's input and output price as text. |

### `scan`

The camera, for QR codes (`adapters.camera` in [`public/v2/core/adapters.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/adapters.js)).

| Function | What it does |
| - | - |
| `available()` | `true` when the browser can use a camera. |
| `open(video, onProgress)` | Starts reading single or animated QR codes into the `<video>` element. Resolves `{promise, stop()}`; `promise` resolves the text read. `onProgress(p)` gets 0 to 1 for an animated code. |

### `qr`

Drawing QR codes ([`public/js/qr.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/js/qr.js)).

| Function | What it does |
| - | - |
| `renderQR(box, text, level = 'M')` | Draws one code into `box`. |
| `playAnimatedQR(box, text, {fragment, fps})` | Plays an animated code for long text. Resolves `{parts, stop()}`. |
| `STATIC_MAX` | The longest text put in one code (700). |

### `nfc`

The card reader. In the Android and iPhone apps it is `nativeNfc` in [`public/v2/core/native.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/native.js) (the ForgeNfc plugin); on the website a stand-in that cannot read cards; in an iPhone app built before its reader, `NO_READER`.

| Function | What it does |
| - | - |
| `supported()` | `true` in the apps. |
| `listed()` | Only on `NO_READER`, where it returns `false`: leave card ways out there. Missing elsewhere. |
| `status()` | Resolves `{available, enabled}`: the phone has a reader, and it is on. An iPhone that cannot read tags, and the iOS Simulator, say `false` to both. |
| `start(onCard, words)` | Listens for cards. `onCard` gets `{transceive(bytes), close()}` for each card held to the phone (`transceive` resolves the card's answer as bytes), or `null` for one that is not a smart card. Returns `{started, stop()}`, and on the iPhone also `again()`. `words` is for the iPhone's NFC sheet only. |
| `sheet` | `true` on the iPhone (not a function). There the phone reads only while iOS's NFC sheet is up, and a press opens it: `start` opens it, each card's sheet closes once `onCard` has finished with that card, and `again()` opens the next one from a press. On Android reading stays on while the screen is open. |

### `card`

Taking eCash off a Cashu card.

| Function | What it does |
| - | - |
| `load()` | Loads the card flow the first time. Resolves `{flow, handToken}`: `flow` from `createCardFunding` and `handToken` from [`public/v2/core/card/flow.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/card/flow.js). The flow reaches the card's mint through the engine's card relay and keeps its own records on the phone. |

### `till`

The till a Fedimint card pays through. Only the Android app has one; elsewhere `supported()` is `false`.

| Function | What it does |
| - | - |
| `supported()` | `true` in the Android app. |
| `status()` | Resolves `{paired, url}`. |
| `pair(text)` | Pairs with a till from the pay code it shows. Throws `{code: 'app_only'}` outside the Android app. |
| `forget()` | Forgets the paired till. |
| `pays` | The payments on this phone (`createTillPays` in [`public/v2/core/till.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/till.js)): `all`, `get`, `waiting`, `start`, `reprice`, `pay`, `check`, `refund`, `credited`, `drop`. |
| `settings` | The till's address and margin (`createTillSettings`): `get`, `marginKnown`, `paired`, `forget`, `setMargin`, `learn`. |

## What a fund module provides

`create(inputs)` returns an object with these fields.

### `id`

Required. A short name such as `'note'`. It goes in the address of the module's screen (`#/funds/add/note`), so it must match `^[a-z0-9-]{1,40}$`. It names the module's strings: `fund.<id>.name` must exist in the string table.

### `available(methods)`

Required. Returns `true` when the module can be offered with this engine. `methods` is the body of [`GET /v1/wallet/fund/methods`](../API.md#get-v1-wallet-fund-methods), or `null` before it arrives. The app calls it often: every time Add money, the Funds card stack or the first run is drawn or updated, and before a module's screen opens. Keep it fast and never let it throw.

```js
available: (methods) => !!methods?.lightning?.enabled,
```

### `view(options)`

Required. Draws the module's screen. The app calls it each time the screen opens, and puts the result under a header with the module's name and a back button. `options` holds:

| Field | What it is |
| - | - |
| `done()` | Call it when the money is in: the app goes back to Funds. |
| `open(id, {token})` | Switches to another fund module and hands it a token in memory only, with nothing written to storage or the address. Scan a note hands a note from another mint to Other mint this way. |
| `token` | The token another module handed over with `open`, or `undefined`. |

It returns `{node, update, destroy}`:

| Field | What the app does with it |
| - | - |
| `node` | Required. The element the app shows. |
| `update()` | Optional. Called on every change in the app's state while the screen shows. |
| `destroy()` | Optional. Called when the person leaves the screen. Stop cameras, timers and pollers here. |

### `icon`

Optional. An icon name from `ui.ICONS`. The app draws it on the module's More tile, its tab and its card when it has no picture of its own for this `id`. Without it the app draws `plus`.

### `usable()`

Optional. Return `false` on a phone that cannot use the module. The first run's How you pay then leaves it out; Add money still lists it so its screen can explain. Tap a Cashu card returns `nfc.supported()`.

### `sub()`

Optional. Returns the string key of the line behind the module's info button on Add money. Without it the app uses `fund.<id>.sub` when that key exists. Tap a Fedimint card uses it to say a till is needed until one is paired.

The bundled modules also set `group` (`'unlinked'` or `'depends'`). No app code reads it.

## Lifecycle

1. The registry calls `create(inputs)` once, when the app starts. On the first run that happens after the first screen is drawn. Keep `create` quick and free of side effects; the instance lives as long as the page.
2. The app calls `available(methods)` whenever it draws a list of ways to pay.
3. When the person opens the module, the app calls `view(options)` and shows `node`. Keep everything the screen needs inside `view`: it runs again each time the screen opens.
4. While the screen shows, the app calls `update()` after every change of state: the balance, the engine's methods, the connection.
5. When the person leaves, the app calls `destroy()`.

## Errors

- A `create` that throws gets the module refused. It never shows.
- `available` and `view` run inside the app's own drawing. An exception there breaks the screen. Catch errors and show them in the module's own screen with `ui.msgLine()` and `msg.set(text, 'err')`.
- Never lose a token. Put eCash on the phone before it leaves: through `wallet.topup`, which does it for you, or with `vault.hold` before your own call, then `credited`, `pending` or `refused` once you know the outcome.
- When `wallet.topup` throws an `EngineError` with `retryable` true, the token is still on the phone and the app sends it again on start and when the connection comes back. Say so in words, as eCash does with `fund.ecash.kept`.
- When an engine answer carries `body.key`, call `wallet.setKey` at once, even when the answer is an error, so a new balance key is never lost.

## How the app lists and orders them

Add money ([`public/v2/screens/wallet.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/wallet.js) and [`public/v2/core/ways.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/ways.js)) takes every fund module whose `available(methods)` is true, leaves out `invite`, and orders them:

```js
export const MAIN_WAYS = Object.freeze(['note', 'lightning', 'card', 'ecash']);
```

1. Start free, first, while the engine has free models and the balance is empty.
2. The way used last on this phone (`lastWay` in the settings), on a card of its own.
3. `note`, `lightning`, `card` and `ecash`, in that order, each on a card.
4. The More card, whose tiles are every other module, in the order of `BUNDLED`.

A new fund module is a tile on the More card until a person uses it; then it has a card of its own, first. The Funds screen shows the first three cards as a fanned stack. The first run's How you pay shows a fixed set of ways (`note`, `free`, `card`, `lightning`, from `PAY_WAYS` in [`public/v2/core/firstrun.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/firstrun.js)) where their modules are available and usable.

## Strings

Add these to [`public/v2/strings/en.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/strings/en.js) for a module with the id `paste`:

| Key | Needed | Where it shows |
| - | - | - |
| `fund.paste.name` | Yes | The screen's title, the tile's and tab's names for screen readers |
| `fund.paste.sub` | No | Behind the info button on its card: what the way is, and who sees the payment |
| `ways.paste.word` | No | The one word under its card or tile. Default: the name |
| `ways.paste.go` | No | The word on the big button under its card. Default: `ways.go` |

## Platforms

| Input | Website | Android app | iPhone app |
| - | - | - | - |
| `engine` | The page's own origin | `https://ai.forge-reserve.com` until the person sets another | The same as Android |
| `scan` | The browser's camera | The camera, through the web view | The camera, through the web view |
| `nfc` | `supported()` false: card ways are listed and say they need the app | Reads cards (ForgeNfc) | Reads cards (ForgeNfc), a press then a tap (`sheet`) |
| `till` | `supported()` false | Pairs and pays (ForgeTill) | `supported()` false: no till yet, so Fedimint cards are left out |

A module that needs a card or a till returns `usable()` false where it cannot work, and its `view` says so in one line with a link to `/download`, as Tap a Cashu card does (`showOffer` in `public/v2/core/getapp.js` draws it: on an iPhone, the iPhone app's link or the Home Screen steps).

## A minimal fund module

This module adds pasted eCash. It reuses eCash's strings, so it needs only `fund.paste.name` in the string table. It is [`docs/modules/examples/fund/paste/`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/modules/examples/fund/paste), loaded through the registry by [`test/unit/module-docs.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/module-docs.test.ts).

`manifest.json`:

```json
{
  "id": "org.example.fund.paste",
  "kind": "fund",
  "version": "1.0.0",
  "name": {
    "en": "Paste eCash"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

`index.js`:

```js
// A fund module: paste eCash and add it to the balance. wallet.topup keeps the token on the phone until
// the engine has credited it. It reuses eCash's strings; it needs fund.paste.name in strings/en.js.
export function create({ t, ui, wallet, format }) {
  return {
    id: 'paste',
    icon: 'paste',
    available: () => true,
    view({ done }) {
      const msg = ui.msgLine();
      const box = ui.el('textarea', { id: 'pasteToken', rows: '4', class: 'field-input mono', spellcheck: 'false', 'aria-label': t('fund.ecash.label') });
      const add = ui.el('button', { type: 'button', class: 'btn primary block', id: 'pasteAdd' }, ui.icon('addMoney', 22), ui.el('span', { text: t('fund.ecash.add') }));
      add.addEventListener('click', async () => {
        const token = box.value.replace(/\s+/g, '');
        if (!/^cashu[AB]/.test(token)) return msg.set(t('fund.ecash.bad'), 'err');
        add.disabled = true;
        msg.set(t('fund.ecash.sending'));
        try {
          const r = await wallet.topup(token);
          msg.set(t('fund.ecash.added', { amount: format.units(r.credited, r.unit) }), 'ok');
          await wallet.refresh();
          done();
        } catch (e) {
          msg.set(e?.retryable ? t('fund.ecash.kept') : t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          add.disabled = false;
        }
      });
      const body = ui.el('div', { class: 'scroll fund-body' }, box, msg);
      return { node: ui.el('div', { class: 'fund-view' }, body, ui.el('div', { class: 'foot' }, add)) };
    },
  };
}
```

To try it, copy the folder to `public/v2/modules/fund/paste/`, add `{ kind: 'fund', folder: 'paste' }` to `BUNDLED`, add `'fund.paste.name': 'Paste eCash',` to the string table and run `node scripts/v2-preload.ts`. It shows as a tile on Add money's More card. On an engine that needs an invite code, a first top-up also needs the invite: the bundled modules use `inviteField` from `fund/kit.js` for that.

## Tests

Pure logic belongs in functions the module exports, tested in Node: [`test/unit/v2/card-module.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/card-module.test.ts) tests Tap a Cashu card's `routeFor` and `wordsFor`. The screens are tested in a phone-sized Chrome against a local gateway and the local test mints: [`test/ui/note.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/note.ui.test.ts) scans a note, and [`test/ui/ways.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/ways.ts) opens any way from Add money by its id.
