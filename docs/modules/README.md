# Modules

The Forge app (the app at `/v2/`, also inside the Android and iPhone apps) is built from modules. A module is a folder with a `manifest.json` and an entry file. One registry loads every module and hands it only the inputs of its kind. The app ships with 24 modules in six kinds.

This guide is for people who want to build a module. Start with [Write your first module](first-module.md), then read the reference page for your kind. The [module list](list.md) describes every module that ships today. The gateway has modules of its own, described in [Engine modules](engine.md).

## The six kinds

| Kind | What it does | What the app hands it | What it must provide | Bundled |
| - | - | - | - | - |
| [`fund`](fund.md) | A way to put money into the balance, shown on Add money | `t`, `ui`, `engine`, `wallet`, `vault`, `format`, `scan`, `qr`, `nfc`, `card`, `till` | `id`, `available(methods)`, `view({done, open, token})` | 8 |
| [`voice-in`](voice-in.md) | Turns the voice into words for Hold to talk | `t`, `mic`, `recognizer`, `audio`, `speech`, `asr` | `id`, `available()`, `private()`, `price(seconds)`, `maxSeconds()`, `start({onLevel, onText})` | 4 |
| [`voice-out`](voice-out.md) | Reads an answer aloud | `t`, `speaker`, `synth`, `audio`, `phonon` | `id`, `available()`, `private()`, `pieceSize()`, `price(pieces, key)`, `speak(pieces, options)` | 3 |
| [`filter`](filter.md) | Checks a photo in Share unseen: hidden details to take out, places to cover | `t` | `id`, `what`, `analyse(photo)` | 3 |
| [`look`](look.md) | The app's colours | nothing | `id`, `scheme`, `tokens` | 3 |
| [`mode`](mode.md) | Draws the home and the answer screen | `t`, `ui`, `state`, `nav`, `actions`, `format` | `id`, `home(options)`, `answer()` | 2 |

`audio`, `speech`, `asr`, `phonon`, `state` and `actions` are handed in part: only the functions the registry names for that kind. Each kind's page lists every input and every function on it.

## Where modules live

Every module is a folder under [`public/v2/modules/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules), one folder per kind:

```text
public/v2/modules/
  fund/        card  ecash  fedimint  free  invite  lightning  note  onchain  (and kit.js)
  voice-in/    bundled  device  engine  phone
  voice-out/   device  engine  phonon
  filter/      cover-faces  cover-numbers  strip-details
  look/        dark  light  midnight
  mode/        default  playful
```

A module folder holds `manifest.json`, the entry file the manifest names (always `index.js` today), and any other files the entry imports. [`public/v2/modules/fund/kit.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/kit.js) holds parts the bundled fund modules share (the invite field, the paste box, the payment QR code, a poller). It has no manifest, and the registry does not load it.

There is no build step. The files are plain ES modules that the browser loads as they are. The Android and iPhone apps carry the same files.

## The manifest

This is the manifest of the Cover faces filter, [`public/v2/modules/filter/cover-faces/manifest.json`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/filter/cover-faces/manifest.json):

```json
{
  "id": "forge.filter.cover-faces",
  "kind": "filter",
  "version": "1.0.0",
  "name": {
    "en": "Cover faces"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

`checkManifest(m, kind)` in [`public/v2/core/registry.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/registry.js) checks every field. A manifest with any problem is refused and its entry is never imported.

| Field | The rule the registry checks |
| - | - |
| `id` | A string of at most 100 characters matching `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`. Bundled modules use `forge.<kind>.<name>`. |
| `kind` | One of the registry's kinds, and the same as the kind folder it is listed under. |
| `version` | Three numbers: `1.0.0`. |
| `name.en` | A name in English that is not empty. |
| `entry` | A file name in the module folder ending in `.js`, matching `^[a-z0-9][a-z0-9-]*\.js$`. No folders. |
| `permissions` | A list. Every entry must be in the registry's `PERMISSIONS`, which is empty, so the list must be empty. |
| `publisher` | Present, as a string or `null`. Not checked further. |
| `sig` | Present, as a string or `null`. Not checked further. |

The registry refuses a second module with the same `kind` and `id`. Two bundled modules may share a name (`voice-in/bundled` and `voice-in/phone` are both "On this phone").

## The entry file

The entry file exports `create(inputs)`. The registry calls it once, with the inputs of the module's kind, and keeps what it returns as the module's instance. `create` may return a promise; the registry waits for it.

```js
export function create(inputs) {
  return { id: 'midnight', scheme: 'dark', tokens };
}
```

The app finds a module by the `id` of its instance (`midnight` above). The manifest's `id` (`forge.look.midnight`) is for the registry. The instance `id` is what the settings store when a person picks a look, a mode or a voice, and what the address holds for a fund module (`#/funds/add/note`). Keep it unique within its kind: the registry does not check it.

## How the registry loads modules

[`public/v2/app.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/app.js) makes one registry when the app starts:

```js
const loader = bundledLoader();
registry = createRegistry({
  ...loader,
  inputs: { t, ui, state, nav, actions, format, engine: engineProxy, wallet, vault, scan: adapters.camera, qr: QR, nfc, card: cards, till, mic: adapters.mic, recognizer: adapters.recognizer, speech: native?.speech ?? null, asr: native?.asr ?? null, speaker: adapters.speaker, synth: adapters.synth, audio, phonon },
});
```

Then `registry.loadAll(list)` loads the modules in `BUNDLED`, the list at the end of `registry.js`:

1. For every module in the list, at the same time, `bundledLoader` fetches `/v2/modules/<kind>/<folder>/manifest.json` from the app's own address.
2. `checkManifest` checks it. A manifest with problems goes to `registry.refused`.
3. The entry is imported with `import()`. A module whose `kind` and `id` are already loaded is refused before its `create` runs.
4. The registry calls `create(inputsFor(kind, inputs))`. An entry with no `create`, or a `create` that throws, is refused.
5. The loaded modules are kept in list order. `registry.list(kind)` returns them in that order and `registry.get(kind, id)` finds one by its manifest `id`.

When the app opens on the first run, it waits only for the looks and the modes, draws the first screen, then loads the rest. On any other screen it waits for all of them. The app needs at least one mode: with none it stops with an error. Refused modules are written to the browser console as `modules refused`.

### How the inputs are cut down

`inputsFor(kind, all)` builds each module's inputs from two tables in `registry.js`. `INPUTS` names the inputs of each kind. `PROJECTIONS` names, for some inputs, the only functions a kind gets. Both results are frozen, so a module cannot add to them.

```js
export function inputsFor(kind, all) {
  const out = {};
  for (const k of INPUTS[kind] ?? []) {
    if (!(k in all)) continue;
    const only = PROJECTIONS[kind]?.[k];
    if (!only) out[k] = all[k];
    else {
      const part = {};
      for (const p of only) if (all[k] != null && typeof all[k][p] === 'function') part[p] = all[k][p];
      out[k] = Object.freeze(part);
    }
  }
  return Object.freeze(out);
}
```

An input the app offers as `null` (the phone's recogniser on the website, say) reaches a module as `null`, or as an empty frozen object when the kind gets only part of it.

## How the app uses each kind

| Kind | Where the app uses it |
| - | - |
| `fund` | Add money ([`public/v2/screens/wallet.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/wallet.js)) shows every fund module whose `available(methods)` is true. Note, Lightning, Tap a Cashu card, Tap a Fedimint card and eCash have cards of their own (the two card ways share one, Cards, when both are there); any other module is a tile on the More card. A module's screen is hosted by `fundScreen` in [`public/v2/screens/funds.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/funds.js). |
| `voice-in` | `pickVoiceIn` in [`public/v2/core/state.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/state.js) picks one module; [`public/v2/core/talkctl.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/talkctl.js) runs it while the talk button is held. |
| `voice-out` | `pickVoiceOut` in `core/state.js` picks one module; `core/talkctl.js` runs it for Listen and for answers to a voice question. |
| `filter` | Share unseen ([`public/v2/screens/photo.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/photo.js)) runs every filter on the photo, in list order, through [`public/v2/core/filters.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/filters.js). |
| `look` | More, Mode and look ([`public/v2/screens/settings.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/settings.js)) lists every look. `applyLook` in `app.js` sets its tokens on the page. |
| `mode` | More, Mode and look lists every mode. The chosen one draws the home and the answer screen. |

## What is built and what is designed

[`docs/MODULES.md`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/MODULES.md) describes modules as plugins anyone can publish and a person can add. Most of that is designed and not built. This is what the code does today.

### Built

- The registry checks each manifest's shape and refuses a bad one.
- It hands each kind only the inputs named for it in `INPUTS` and `PROJECTIONS`, as frozen objects.
- It loads the modules listed in `BUNDLED`, from the app's own address (`bundledLoader`), in that order.

### Not built

The registry says so itself, at the top of `registry.js`:

```js
// What it does NOT do yet: it does not check the `publisher` and `sig` fields, and it does not run a
// module in a sandbox. Only the modules bundled with this release load, and they run as ordinary code
// in the page. Signature checks and the sandbox come with slice B2.
```

- **Signatures are not checked.** `publisher` and `sig` must be present, as a string or `null`. Their values are never read. Every bundled manifest has `null` in both.
- **There is no sandbox.** An entry is imported into the page with `import()` and runs as page code. It can reach anything the page can: the page itself, `localStorage` and IndexedDB, `fetch` to any server that accepts the request, and every other file of the app by `import`. Bundled modules do import app files directly: the hidden details filter imports `core/photometa.js`, the Default mode imports `screens/home.js` and `screens/answer.js`. The inputs a kind gets are the interface the app supports, and nothing stops a module from reaching past them.
- **No permission can be granted.** `PERMISSIONS` is an empty list, so a manifest that asks for any permission is refused.
- **Nothing can be installed from outside.** There is no screen, address or file that adds a module. A module loads only when its folder is in `public/v2/modules/` and listed in `BUNDLED`, which is a change to the code and a new release of the app.
- **A fund module can read the balance key.** `wallet.key()` returns it, and the bundled fund modules pass it to the engine's funding calls. A fund module also gets the whole engine client, including `chat`.
- **Four kinds have no module.** `cover`, `guides`, `protect` and `language` are in the registry's `KINDS` and `INPUTS`, so a manifest of those kinds passes the checks. No screen uses a module of those kinds.
- **Voice modules are picked by their ids.** `pickVoiceIn` and `pickVoiceOut` in `core/state.js` and the Voice screen in `screens/settings.js` know the bundled ids only (`bundled`, `phone`, `engine`, `device` for voice in; `phonon`, `device`, `engine` for voice out). A voice module with another id loads and is never used. See [Voice in](voice-in.md#how-the-app-picks-one) and [Voice out](voice-out.md#how-the-app-picks-one).

### Designed

`docs/MODULES.md` sets out what comes with slice B2, the plugin loader, signed manifests and the sandbox ([`docs/ROADMAP.md`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/ROADMAP.md) gives it five days of work):

- A plugin is signed by its publisher with a Nostr key. The app shows who published it and refuses a package whose signature fails.
- A plugin runs in a sandbox, a web worker or a sandboxed frame, the same in the web app and the native shell. It reaches the network only if its manifest asks and the person agrees.
- The app hands a plugin only its kind's inputs, and a plugin can never read the wallet, the passphrase or other plugins' data.
- Adding a plugin is deliberate: scan a code or open a file, see the publisher and the permissions, confirm.
- "Reviewed only" is on by default and turns off only in settings, with a plain warning. The default set is reviewed and pinned in each release.

Still open in that design: which sandbox gives the same guarantees in the web app and the native shell, whether guide packages reuse an existing format, and who reviews plugins for the default set.

Until B2 lands, a new module reaches people only as a pull request that adds it to the bundled set, reviewed like any other code. [Write your first module](first-module.md#send-it-as-a-pull-request) shows how.
