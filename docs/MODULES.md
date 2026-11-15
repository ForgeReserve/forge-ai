# Modules and protocols

Status: design. Written 2026-11-12.

Forge AI is a **reference build**: one working set of choices, made so anyone can swap any part of it. Two rules make that possible:

1. **Protocols at the seams.** Wherever two parts meet, they speak an open, written protocol. Nothing depends on Forge running the other side.
2. **Modules behind the seams.** Each part sits behind a small interface, so a different module can replace it without touching the rest. A group that dislikes one part changes that module, not the app.

## The seams

| Seam | Protocol | Forge's default | What someone might swap in |
|---|---|---|---|
| App to engine | OpenAI chat completions API | Bellows | Any compatible engine |
| Engine to AI models | OpenAI API, encrypted pass-through with attestation | Tinfoil, Token Factory | Another enclave provider, a local model |
| Paying | Cashu (NUTs), Lightning | Forge mint, discovered mints | Their own mint, a community mint |
| Finding engines | Signed announcements over Nostr | Forge's list of Bellows operators | Their own operator list |
| Finding mints | NIP-87 announcements and reviews | Reviewed mints with 2 or more reviewers | Their own allowlist |
| Guides | Signed guide packages | A short starting list | Their own organisation's guides |
| Free questions | Credit vouchers (FREE-TIER.md) | Forge's daily faucet | Their own faucet or sponsored batches |

## Engine modules (Bellows)

| Module | Interface | Today |
|---|---|---|
| Suppliers | `Supplier` in `src/suppliers/types.ts`: `chat`, optional `forwardEncrypted`, `attestation`, `hpkeKeys` | Built: Tinfoil, OpenAI-compatible, mock |
| Funding methods | `methods()` and per-method handlers in `src/funding.ts` | Built inline: Lightning, on-chain, other mints. To split into one file per method behind one interface |
| Mint policy | `vetForeignMint` and discovery in `src/mint-discovery.ts` | Built: discovered, allowlist, any, deny list |
| Pricing | `src/pricing.ts`, the model catalog JSON | Built: catalog plus markup |
| Exchange rates | rate sources in `src/rates.ts` | Built: several exchanges, median |
| Storage | `src/db.ts` on SQLite | Built. Stays one file: an operator should not need a database server |

Swapping an engine module is a config change plus, at most, one new file implementing the interface.

## App modules

Each app module is a **plugin**: a folder with a manifest and code, loaded from the bundled set or added later.

| Kind | What it does | Interface (input to output) | Default set |
|---|---|---|---|
| `fund` | A way to put money in | a tap, scan or paste to eCash or a paid invoice for the engine | Paper note (scan), Cashu card (tap), Fedimint card (tap), Lightning, on-chain |
| `voice-in` | Speech to text | audio to text | On-device recogniser; enclave transcription as an option |
| `voice-out` | Text to speech | text to audio | The natural voice on the phone (Phonon 31m, docs/VOICE.md), the phone's own voice, the engine's voice |
| `filter` | Share unseen: removes identity from anything sent on | file to file plus a report of what changed | Faces covered, numbers covered, location and metadata stripped, voice changed |
| `cover` | The disguise game | a game screen plus a hidden way in | One puzzle under several names and icons |
| `guides` | Trusted knowledge to answer from | a signed package of documents plus an index | A short starting list |
| `protect` | Phone protection steps | a checklist per platform with deep links | Android and iPhone lists from published advice |
| `language` | Interface text and voices | string table plus voice choices | The December language list |
| `look` | Colours and type | design tokens | Light, Dark, Midnight |
| `mode` | The main layout | a home screen plus an answer screen | Default (rings), Classic (chat), Playful |

### The manifest

```json
{
  "id": "org.example.blur-faces",
  "kind": "filter",
  "version": "1.2.0",
  "name": { "en": "Cover faces" },
  "permissions": [],
  "entry": "index.js",
  "publisher": "npub1...",
  "sig": "..."
}
```

- **Signed by its publisher** with a Nostr key. The app shows who published a plugin and refuses a package whose signature fails.
- **No network by default.** A plugin runs in a sandbox (a web worker or sandboxed frame, the same in the web app and the native shell) and can reach the network only if its manifest asks and the person agrees. A filter or cover never needs it, so one that asks is a warning sign.
- **Declares its kind**, and the app hands it only that kind's inputs. A filter sees the file being shared, never chats or the wallet.

### Safety

Plugins are also a way to attack the people this app serves. So:

- The default set is reviewed and pinned in each release.
- Adding a plugin is deliberate: scan a code or open a file, see the publisher and the permissions, confirm.
- "Reviewed only" is on by default and turns off only in settings, with a plain warning.
- A plugin can never read the wallet, the passphrase or other plugins' data.

## Status in the v2 app

Built in slice A1 (`public/v2/`):

- The registry, `public/v2/core/registry.js`. It checks each manifest (id, kind, version, `name.en`, an entry file inside the module folder, `permissions`, and that `publisher` and `sig` are present), refuses a bad one, and hands each kind only its inputs: a `look` gets nothing, a `fund` module gets the engine, the wallet and the vault but never the conversation, a `mode` gets what the screens show (a view with no balance key in it) and the answer actions (ask, stop, ask again, copy, start fresh), but never the raw state, the balance key, the engine, the wallet or an action that moves money such as taking funds out.
- Bundled modules: `look` (Light, Dark, Midnight), `mode` (Default) and `fund` (eCash, Lightning, on-chain, other mint).

Built in slice A2: the `fund` module Scan a note (`public/v2/modules/fund/note/`), first in Add funds. It reaches the camera only through the `scan` input (the camera adapter), reads the note on the phone (`public/v2/core/note.js`) and adds it through the wallet, so the vault keeps the note's eCash until the engine confirms the credit. To hand a note from another mint to the Other mint module, the screen that hosts fund modules gives each view an `open(id, {token})`: it switches to that fund module and passes the token in memory, never through storage or the address bar.

Built in slice A3: `voice-in` and `voice-out`, each with two modules.

- `voice-in/engine` (the default): records through the `mic` adapter, makes a 16 kHz WAV in memory and sends it to the engine's speech to text model. `voice-in/device`: the browser's own recogniser (`recognizer` adapter); it is never private, so it is not used while Private only is on.
- `voice-out/device`: the phone's own voices that run on the phone (`synth` adapter), free. `voice-out/engine`: the engine's text to speech model, one request per piece of the answer, with the sound kept in memory for the last few answers. Automatic reading uses the phone's voice when there is one, else the engine's.
- A voice module gets `t`, its hardware adapters and an `audio` input with only its own direction's calls (`model`, `price`, and `transcribe` or `speak`). The app makes those calls with the balance key; the module never sees it, the engine object or the wallet.
- A voice-in module has `available()`, `private()`, `price(seconds)`, `maxSeconds()` and `start({onLevel, onText})`, which gives a session with `finish({signal})` (resolves to the text and what it cost) and `cancel()`. A voice-out module has `available()`, `private()`, `pieceSize()`, `cached(key)`, `price(pieces, key)` and `speak(pieces, {key, onState})`, which gives `{done, stop()}`.
- The mode gets the talk actions (`talkDown`, `talkMove`, `talkUp`, `talkCancel`) and `speak`, `stopSpeaking`, and draws the button from `view().talk` and `view().speak`.

Built on branch v2-voice (docs/VOICE.md): `voice-out/phonon`, the natural voice made on the phone (Phonon 31m through the vendored phonon-tts). A voice-out module now also gets `phonon`, the phone's Phonon engine with only `available()`, `download()` (whether a first use downloads the model, and its size) and `load()`. The module is private and free, streams the sound to the speaker adapter's `stream()` as it is made, and may have `download()`, which the app uses to ask once before the first download. Automatic reading uses it first where the phone can run it.

Built in slice A4: the mode's answer actions gain `burn` (remove the open conversation from the phone). Burn all, auto-delete and Erase everything stay with the app and are never handed to a module. A `voice-out` module may have `forget(key)`, which drops the sound it keeps in memory for one answer (or for all, with no key); the app calls it when a conversation is burned.

Built in slice A5: three `filter` modules for Share unseen, run in this order on the phone: `strip-details`, `cover-faces` and `cover-numbers` (`public/v2/modules/filter/`). A filter gets only `t`, and per photo the photo itself (`{width, height, canvas, pixels, bytes}`), never chats, the wallet or the engine. It has `id`, `what` (`details`, `faces` or `writing`) and `analyse(photo)`, which resolves to `{found}` (hidden details in the file) and, or, `{covers}` (blocks to paint); it may have `finish(bytes)`, which gets the new JPEG and returns it cleaned, and `prepare()`, which starts loading a model early. The chain (`public/v2/core/filters.js`) reports each step, carries on past a filter that fails or takes longer than 45 seconds (listed as not checked), and builds the list of changes. Whatever the filters do, the app draws the photo again, paints the blocks and checks the new file (`public/v2/core/photo.js`). The face filter loads the vendored face-api library and its model from this app's own address; it fetches nothing else.

Built in slice B1: the `fund` module Free questions (`public/v2/modules/fund/free/`), first in Add funds and listed only while the engine's faucet is on (`free.enabled` in `GET /v1/wallet/fund/methods`). It uses the engine's `call` for the faucet (`public/v2/core/faucet.js`) and adds the voucher through `wallet.topupFree`, which keeps it in the vault and puts it on the free balance, a second balance key the module never sees (`public/v2/core/free.js`). It does not rely on the app knowing the credit mint yet. If a voucher still reaches the engine the paid way (`wallet.topup`), the key the engine marks `free: true` goes to the free balance, never to the paid one. `wallet.isCredit(mint)` tells the other fund modules a voucher from the credit mint, so Scan a note and eCash count it in questions, never as money.

The `fund` module Start free (`public/v2/modules/fund/invite/`) opens a $0 balance with an invite code through `wallet.open`. Free models are Standard models, so it reads `wallet.privateOnly()` and, with Private only on, asks first; only after a yes does it call `wallet.useFreeModels()`, which turns Private only off and chooses a free model. A fund module gets no other way to change a setting.

Built in slice A13: the `fund` module Tap a card (`public/v2/modules/fund/card/`), after Scan a note in Add funds. A fund module now also gets two inputs: `nfc`, the card reader (the Android app's ForgeNfc plugin through `core/native.js`; on the website a stand-in whose `supported()` is false, so the row says cards need the app), and `card`, whose `load()` gives the card flow (`core/card/flow.js`, loaded the first time it is needed). The flow keeps its own records on the phone (`forge2.cards`) and reaches the card's mint only through the engine; the module never sees the balance key. A fund module may have `usable()`: false hides it from How you pay on a phone that cannot use it, while its Add funds row still explains. The card's eCash goes on through `wallet.topup` (the engine's own mint) or, kept in the vault, to the Other mint module with `open('othermint', {token})`.

Built in slice A14: the `fund` module Tap a Fedimint card (`public/v2/modules/fund/fedimint/`), after Tap a card. A fund module now also gets `till`: the till a Fedimint card pays through (the Android app's ForgeTill plugin, which holds the till's pay token; on the website a stand-in whose `supported()` is false), with `pays` (the payments on the phone, `core/till.js`) and `settings` (the till's address and margin). The module asks the engine for a Lightning invoice and the till pays it; it never sees the balance key or the till's token. A fund module may have `sub()`, the string key of its Add funds line: this one says a till is needed until one is paired.

Not built yet, and not claimed: the `publisher` and `sig` fields are not checked, there is no sandbox, and no permission can be granted (a manifest that asks for one is refused). Only the modules bundled with the release load, and they run as ordinary code in the page. Signatures, the sandbox and adding a plugin come with slice B2.

## What changes in the code

1. Split `src/funding.ts` into one module per funding method behind a shared interface.
2. Add the plugin loader, manifest checks and sandbox to the web app, then the native shell.
3. Move filters, covers, guides and protection lists into plugins from the start, since none are built yet.
4. Add an on-device `voice-in` module (C2). On-device `voice-out` is the natural voice (docs/VOICE.md); the module kinds exist since slice A3.
5. Publish the Bellows operator announcement and the guide package format as short written specs, so others can implement them without reading Forge's code.

## Open questions

- Which sandbox gives the same guarantees in the web app and the native shell.
- Whether guide packages reuse an existing format (for example a signed ZIM file) or need their own.
- Who reviews plugins for the default set, and how often.
