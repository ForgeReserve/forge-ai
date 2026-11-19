# Module list

Every module that ships with the Forge app, grouped by kind. Within a kind they are in the order the app loads and lists them (`BUNDLED` in [`public/v2/core/registry.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/registry.js)). Each entry says what the module does, what it needs, where it works, what it costs and where its data goes.

"Private" means here that what the module handles stays on the phone, or goes only to a model in sealed hardware (an enclave), where the engine's operator cannot read it. A test, [`test/unit/module-docs.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/module-docs.test.ts), fails when this list and the module folders disagree.

## At a glance

| Kind | Id | Name | Website | Android app | iPhone app | Cost | Private |
| - | - | - | - | - | - | - | - |
| `fund` | `forge.fund.free` | Free questions | Yes | Yes | Yes | Free | No name or email |
| `fund` | `forge.fund.invite` | Start free | By address | By address | By address | Free | Free models are Standard |
| `fund` | `forge.fund.note` | Scan a note | Yes | Yes | Yes | The note's value | Cannot be linked to you |
| `fund` | `forge.fund.card` | Tap a Cashu card | Points to the app | Yes | Yes, press then tap | The amount taken, fee shown | Cannot be linked to you |
| `fund` | `forge.fund.fedimint` | Tap a Fedimint card | Points to the app | Yes, with a till | Hidden | The amount, till fee shown | The till sees the payment |
| `fund` | `forge.fund.ecash` | eCash | Yes | Yes | Yes | The token's value | Cannot be linked to you |
| `fund` | `forge.fund.lightning` | Lightning | Yes | Yes | Yes | The invoice | Your wallet sees it |
| `fund` | `forge.fund.onchain` | On-chain | When on | When on | When on | The deposit | Public on the chain |
| `fund` | `forge.fund.othermint` | Other mint | Yes | Yes | Yes | The token, less fees | The engine sees the other mint |
| `voice-in` | `forge.voice-in.bundled` | On this phone | No | Forge Private Voice only | No | Free | Yes |
| `voice-in` | `forge.voice-in.phone` | On this phone | No | Where the phone has the language | Where the iPhone hears the language on the phone | Free | Yes |
| `voice-in` | `forge.voice-in.engine` | Engine | Yes | Yes | Yes | Paid per request | With an enclave model |
| `voice-in` | `forge.voice-in.device` | This browser | Where the browser has one | Where the web view has one | Yes | Free | No |
| `voice-out` | `forge.voice-out.phonon` | Natural voice | Where the browser runs it | Yes | Yes | Free | Yes |
| `voice-out` | `forge.voice-out.device` | Phone voice | Yes | Yes | Yes | Free | Yes |
| `voice-out` | `forge.voice-out.engine` | Engine voice | Yes | Yes | Yes | Paid per request | With an enclave model |
| `filter` | `forge.filter.strip-details` | Hidden details | Yes | Yes | Yes | Free | Yes |
| `filter` | `forge.filter.cover-faces` | Cover faces | Yes | Yes | Yes | Free | Yes |
| `filter` | `forge.filter.cover-numbers` | Cover writing and numbers | Yes | Yes | Yes | Free | Yes |
| `look` | `forge.look.light` | Light | Yes | Yes | Yes | Free | Yes |
| `look` | `forge.look.dark` | Dark | Yes | Yes | Yes | Free | Yes |
| `look` | `forge.look.midnight` | Midnight | Yes | Yes | Yes | Free | Yes |
| `mode` | `forge.mode.default` | Default | Yes | Yes | Yes | Free | Yes |
| `mode` | `forge.mode.playful` | Playful | Yes | Yes | Yes | Free | Yes |

## Fund

Ways to put money into the balance, on Add money. See [Fund modules](fund.md). Each one appears only while its `available(methods)` is true for the engine in use.

### Free questions

Opens the engine's daily faucet in the app. The phone works a short proof-of-work puzzle, the engine hands out a voucher of free questions, and the app adds it to the free balance, kept apart from any money.

- **Id:** `forge.fund.free`, known in the app as `free`.
- **Folder:** [`public/v2/modules/fund/free/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/free)
- **Needs:** `engine.call` for [`GET /v1/free`](../API.md#get-v1-free), [`POST /v1/free/challenge`](../API.md#post-v1-free-challenge), [`POST /v1/free/verify`](../API.md#post-v1-free-verify) and [`POST /v1/free/claim`](../API.md#post-v1-free-claim) (through [`public/v2/core/faucet.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/faucet.js)); `wallet.topupFree`. No hardware.
- **Works on:** the website and both apps, while the engine's faucet is on (`free.enabled` in the ways to pay). It is off on the hosted gateway today.
- **Costs:** nothing. The questions are free.
- **Private:** asks for no name and no email. The engine sees the phone's address while it hands out the voucher.

### Start free

Opens a balance with an invite code and nothing on it, for the free models. Free models are Standard models, so with Private only on it asks before turning Private only off.

- **Id:** `forge.fund.invite`, known in the app as `invite`.
- **Folder:** [`public/v2/modules/fund/invite/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/invite)
- **Needs:** `wallet.open` for [`POST /v1/wallet/open`](../API.md#post-v1-wallet-open), `wallet.privateOnly` and `wallet.useFreeModels`. No hardware.
- **Works on:** the website and both apps, while the engine has free models and the phone has no balance key. Add money leaves it out and uses Start free's own screen (`public/v2/screens/startfree.js`) instead, so the module opens only at its own address, `#/funds/add/invite`.
- **Costs:** nothing.
- **Private:** no. The free models it leads to are Standard models: the company running them can read what is typed.

### Scan a note

Reads a paper eCash note with the camera, single or animated QR code, or a pasted code. It shows the amount and the mint before anything is sent, then adds it on one tap. A note from a mint the engine does not take offers Other mint.

- **Id:** `forge.fund.note`, known in the app as `note`.
- **Folder:** [`public/v2/modules/fund/note/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/note)
- **Needs:** `scan` (the camera); `wallet.topup` for [`POST /v1/wallet/topup`](../API.md#post-v1-wallet-topup); `wallet.mints`, `mintAliases`, `units` and `isCredit`; `open('othermint', {token})`. It reads the note with [`public/v2/core/note.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/note.js).
- **Works on:** the website and both apps. Without a camera it asks for the code to be pasted.
- **Costs:** the note's value goes into the balance.
- **Private:** eCash, which the app marks as a way that cannot be linked to you. The note's token stays on the phone until the engine credits it.

### Tap a Cashu card

Takes eCash off a Cashu card held to the phone. The card proves its key, the person enters its PIN and picks how much, the card signs one swap at its own mint, and the eCash goes into the balance. A card from another mint the engine takes goes on through Other mint.

- **Id:** `forge.fund.card`, known in the app as `card`.
- **Folder:** [`public/v2/modules/fund/card/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/card)
- **Needs:** `nfc` (a card reader); `card.load()`, whose flow uses the [Cashu card relay](../API.md#cashu-card-relay); `wallet.topup`, `vault`, `open('othermint', {token})`.
- **Works on:** the Android and iPhone apps. On the iPhone each step with the card is a press, then a tap on iOS's NFC sheet: the read, then Move or Finish. The website lists it and says it needs the app (`usable()` is false).
- **On Add money:** the printed Cashu card, with the word Cashu. With Tap a Fedimint card there too, the two cards share one wallet card, Cards, side by side.
- **Costs:** the amount taken off the card. Any fee and what goes back on the card are shown before the card signs.
- **Private:** eCash, which the app marks as a way that cannot be linked to you.

### Tap a Fedimint card

Pays the engine's Lightning invoice from a Fedimint card, through a till. The engine makes the invoice, the price shows, the person holds the card to the phone, the phone passes the till's card commands to the card, and the till charges the card and pays the invoice.

- **Id:** `forge.fund.fedimint`, known in the app as `fedimint`.
- **Folder:** [`public/v2/modules/fund/fedimint/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/fedimint)
- **Needs:** `nfc`; `till`, paired once by scanning the till's pairing code with `scan`; `engine.fundLightning` for [`POST /v1/wallet/fund/lightning`](../API.md#post-v1-wallet-fund-lightning) and `engine.funding` for [`GET /v1/wallet/fund/{id}`](../API.md#get-v1-wallet-fund-id). Its payments are kept by [`public/v2/core/till.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/till.js).
- **Works on:** the Android app, with a paired till, while the engine has Lightning. The website lists it and says it needs the Android app. The iPhone app leaves it out: it reads cards, but has no till.
- **On Add money:** the printed Fedimint card, with the word Fedimint, beside the Cashu card on the Cards wallet card (a card of its own when Tap a Cashu card is not there).
- **Costs:** the invoice, plus the till's fee and margin, shown before the tap. A failed payment offers the money back to the same card.
- **Private:** the till sees the card and the payment; the engine sees a Lightning payment.

### eCash

Paste, or scan, a Cashu token from a mint the engine takes, and add it.

- **Id:** `forge.fund.ecash`, known in the app as `ecash`.
- **Folder:** [`public/v2/modules/fund/ecash/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/ecash)
- **Needs:** `wallet.topup` for [`POST /v1/wallet/topup`](../API.md#post-v1-wallet-topup); `scan` when the phone has a camera.
- **Works on:** the website and both apps.
- **Costs:** the token's value goes into the balance.
- **Private:** eCash, which the app marks as a way that cannot be linked to you.

### Lightning

Pick an amount, pay the invoice from any Lightning wallet, and the engine credits it.

- **Id:** `forge.fund.lightning`, known in the app as `lightning`.
- **Folder:** [`public/v2/modules/fund/lightning/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/lightning)
- **Needs:** `engine.fundLightning` for [`POST /v1/wallet/fund/lightning`](../API.md#post-v1-wallet-fund-lightning); `engine.funding` for [`GET /v1/wallet/fund/{id}`](../API.md#get-v1-wallet-fund-id), every 2 seconds until it is paid; `qr` for the invoice.
- **The code:** `lightning:<invoice>` in lowercase, the same string as Open in wallet (`qrPayload` in `modules/fund/kit.js`). BOLT 11 suggests upper case for a smaller code, but Primal on the iPhone strips only a lowercase `lightning:` and reads `LIGHTNING:LNBC...` as an invalid checksum. The lowercase code is denser (65 modules for a 250-character invoice), so it is drawn up to 340 px wide: over 4 px a module at 360 px.
- **Works on:** the website and both apps, while the engine has Lightning.
- **Costs:** the invoice's amount, between the engine's least and most.
- **Private:** no. The person's wallet sees a Lightning payment, and so does an exchange that knows their name.

### On-chain

A bitcoin deposit address. The deposit is credited to a sat balance once it has its confirmations.

- **Id:** `forge.fund.onchain`, known in the app as `onchain`.
- **Folder:** [`public/v2/modules/fund/onchain/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/onchain)
- **Needs:** `engine.fundOnchain` for [`POST /v1/wallet/fund/onchain`](../API.md#post-v1-wallet-fund-onchain); `engine.funding` for [`GET /v1/wallet/fund/{id}`](../API.md#get-v1-wallet-fund-id), every 15 seconds; `qr`.
- **Works on:** the website and both apps, while the engine has on-chain funding on. It is off unless the operator turns it on (`FORGE_ONCHAIN_ENABLED`). Only for a sat balance.
- **Costs:** the deposit, at least the engine's least.
- **Private:** no. Bitcoin payments are public and permanent.

### Other mint

eCash from another Cashu mint. The engine quotes what it will credit, then on confirm pays a Lightning invoice from the other mint and credits what arrives. eCash the engine sends back (unused fees, or the whole token when the payment fails) is kept on the phone until the person saves it.

- **Id:** `forge.fund.othermint`, known in the app as `othermint`.
- **Folder:** [`public/v2/modules/fund/othermint/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/fund/othermint)
- **Needs:** `engine.foreignQuote` and `engine.foreignConfirm` for [`POST /v1/wallet/fund/foreign/quote`](../API.md#post-v1-wallet-fund-foreign-quote) and [`POST /v1/wallet/fund/foreign/confirm`](../API.md#post-v1-wallet-fund-foreign-confirm); `engine.funding`; `vault`, which holds the token from confirm to the outcome; `wallet.lockKey`; `scan` when the phone has a camera.
- **Works on:** the website and both apps, while the engine takes other mints.
- **Costs:** the token's value, less the Lightning fees. The most the fees can be is shown before confirm.
- **Private:** the engine and the other mint see one Lightning payment between them.

## Voice in

Hold to talk: turning the voice into words. See [Voice-in modules](voice-in.md). The app picks one at a time, by id.

### On this phone (Forge Private Voice)

Forge Private Voice's own speech to text, a small English model (Moonshine tiny) inside the app. Live words show while the button is held. It is the phone module over another bridge.

- **Id:** `forge.voice-in.bundled`, known in the app as `bundled`.
- **Folder:** [`public/v2/modules/voice-in/bundled/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-in/bundled)
- **Needs:** `asr` (ForgeAsr). It reuses the code of `voice-in/phone`.
- **Works on:** the Android app built as Forge Private Voice, the APK made for phones with no on-device recogniser, such as GrapheneOS. It says it is not available everywhere else.
- **Costs:** nothing.
- **Private:** yes. The sound never leaves the phone.

### On this phone (the phone's recogniser)

The phone's own on-device speech recogniser, offered where it has the language now.

- **Id:** `forge.voice-in.phone`, known in the app as `phone`.
- **Folder:** [`public/v2/modules/voice-in/phone/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-in/phone)
- **Needs:** `speech` (ForgeSpeech). The app uses only a recogniser that runs on the phone.
- **Works on:** the Android app, on a phone whose recogniser has the language, and the iPhone app, where Apple's recogniser hears the language on the phone itself (it never sends the sound to Apple). Not on the website.
- **Costs:** nothing.
- **Private:** yes. The sound never leaves the phone; only the words come back to the page.

### Engine

Records on the phone, makes a 16 kHz WAV file in memory, and sends it to the engine's speech to text model. The recording is dropped once it is sent or cancelled.

- **Id:** `forge.voice-in.engine`, known in the app as `engine`.
- **Folder:** [`public/v2/modules/voice-in/engine/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-in/engine)
- **Needs:** `mic`; `audio.transcribe` for [`POST /v1/audio/transcriptions`](../API.md#post-v1-audio-transcriptions); `audio.model` and `audio.price`. It makes the WAV with [`public/v2/core/wav.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/wav.js).
- **Works on:** the website and both apps, where there is a microphone and the engine has a speech to text model.
- **Costs:** paid per request from the balance, by the recording's length. A balance that cannot pay gets a few free voice questions a day, where the engine gives them.
- **Private:** only when the engine's model runs in an enclave. With Private only on, the app uses no other.

### This browser

The browser's own speech recogniser, where the browser has one and the person picks it.

- **Id:** `forge.voice-in.device`, known in the app as `device`.
- **Folder:** [`public/v2/modules/voice-in/device/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-in/device)
- **Needs:** `recognizer`.
- **Works on:** browsers that have `SpeechRecognition`. In the iPhone app it is WebKit's, Apple's.
- **Costs:** nothing.
- **Private:** no. The browser decides where the sound goes: Chrome sends it to Google, WebKit to Apple. The app never uses it while Private only is on.

## Voice out

Reading an answer aloud. See [Voice-out modules](voice-out.md). The app picks one at a time, by id.

### Natural voice

The natural voice made on the phone, Phonon 31m. In the Android app native code makes the voice where the phone runs it; elsewhere the model runs in the page and its sound streams to the speaker as it is made. On a phone too slow for it, the phone's own voice reads the answer instead.

- **Id:** `forge.voice-out.phonon`, known in the app as `phonon`.
- **Folder:** [`public/v2/modules/voice-out/phonon/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-out/phonon)
- **Needs:** `phonon`, `speaker` and `synth`. It paces itself with [`public/v2/core/voicepace.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/voicepace.js). The model files come from the app's own address, `/v2/voice/phonon/`, fetched at build time by `scripts/phonon-model.ts`.
- **Works on:** the website where the browser can run it (WebAssembly SIMD and workers): the first use downloads about 65 MB, after the person agrees. The Android and iPhone apps carry the files.
- **Costs:** nothing.
- **Private:** yes. The answer's text never leaves the phone.

### Phone voice

The phone's own voices, only those that run on the phone.

- **Id:** `forge.voice-out.device`, known in the app as `device`.
- **Folder:** [`public/v2/modules/voice-out/device/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-out/device)
- **Needs:** `synth`.
- **Works on:** the website and both apps, where the phone has an English voice of its own. The first run's Listen uses it.
- **Costs:** nothing.
- **Private:** yes.

### Engine voice

Sends each piece of the answer to the engine's text to speech model and plays it as it arrives. The sound of the last four answers stays in the page's memory, so Listen never pays twice for a piece; burning a conversation drops it.

- **Id:** `forge.voice-out.engine`, known in the app as `engine`.
- **Folder:** [`public/v2/modules/voice-out/engine/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-out/engine)
- **Needs:** `audio.speak` for [`POST /v1/audio/speech`](../API.md#post-v1-audio-speech); `audio.model`, `audio.price`; `speaker`.
- **Works on:** the website and both apps, where the engine has a text to speech model.
- **Costs:** paid per request from the balance, by the characters read.
- **Private:** only when the engine's model runs in an enclave. The answer reaches the model as plain text through the engine.

## Filter

The checks of Share unseen, run in this order on every photo, on the phone. See [Filter modules](filter.md).

### Hidden details

Reads which hidden details the original file holds (where, when, which phone, a small copy of the picture), for the list of changes. On the new file it takes out every place a JPEG keeps notes: Exif, XMP, IPTC, the colour profile, comments and trailing data.

- **Id:** `forge.filter.strip-details`, known in the app as `strip-details`.
- **Folder:** [`public/v2/modules/filter/strip-details/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/filter/strip-details)
- **Needs:** the photo's `bytes`. It uses [`public/v2/core/photometa.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/photometa.js). No network.
- **Works on:** the website and both apps.
- **Costs:** nothing.
- **Private:** yes. It runs on the phone.

### Cover faces

Finds faces and covers each with a flat ellipse. The person sees every cover before anything is shared and can add more; it can miss a face turned away, very small or in shadow.

- **Id:** `forge.filter.cover-faces`, known in the app as `cover-faces`.
- **Folder:** [`public/v2/modules/filter/cover-faces/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/filter/cover-faces)
- **Needs:** the photo's `canvas`. It loads face-api's tiny face detector on TensorFlow.js and its model (about 190 KB) from the app's own address, `public/vendor/face-api/`, on the graphics chip when it can.
- **Works on:** the website and both apps.
- **Costs:** nothing.
- **Private:** yes. The photo never leaves the page.

### Cover writing and numbers

Covers places that look like a line of writing: number plates, signs, papers, name tags. Plain JavaScript on the photo's pixels, with no model file. It can miss small or slanted writing, and can cover a row of similar marks such as a fence.

- **Id:** `forge.filter.cover-numbers`, known in the app as `cover-numbers`.
- **Folder:** [`public/v2/modules/filter/cover-numbers/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/filter/cover-numbers)
- **Needs:** the photo's `pixels`.
- **Works on:** the website and both apps.
- **Costs:** nothing.
- **Private:** yes. It runs on the phone.

## Look

The app's colours. See [Look modules](look.md).

### Light

Calm and ordinary: dark text on a light warm grey.

- **Id:** `forge.look.light`, known in the app as `light`.
- **Folder:** [`public/v2/modules/look/light/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/look/light)
- **Needs:** nothing.
- **Works on:** the website and both apps. Follow the phone uses it while the phone is light.
- **Costs:** nothing.
- **Private:** yes.

### Dark

Softer on the eyes at night: light text on a dark blue grey.

- **Id:** `forge.look.dark`, known in the app as `dark`.
- **Folder:** [`public/v2/modules/look/dark/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/look/dark)
- **Needs:** nothing.
- **Works on:** the website and both apps.
- **Costs:** nothing.
- **Private:** yes.

### Midnight

Black, for dark rooms. The default look.

- **Id:** `forge.look.midnight`, known in the app as `midnight`.
- **Folder:** [`public/v2/modules/look/midnight/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/look/midnight)
- **Needs:** nothing.
- **Works on:** the website and both apps. The `/free` and `/download` pages use it unless the app keeps another look on the phone.
- **Costs:** nothing.
- **Private:** yes.

## Mode

The home and the answer screen. See [Mode modules](mode.md).

### Default

The rings home, with the funds and memory rings around the talk button, and the answer screen with Copy, Ask again and Burn.

- **Id:** `forge.mode.default`, known in the app as `default`.
- **Folder:** [`public/v2/modules/mode/default/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/mode/default)
- **Needs:** `t`, `ui`, `state`, `nav`, `actions`. Its screens are the app's own, [`public/v2/screens/home.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/home.js) and [`public/v2/screens/answer.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/answer.js).
- **Works on:** the website and both apps.
- **Costs:** nothing. Questions asked from it cost what the model costs.
- **Private:** yes. It draws on the phone.

### Playful

Pip, bright colours and big buttons on the home and the answer screen, for people who read poorly and for children. It opens on a cover game, Pip's Garden, with the helper behind it: hold Pip 3 seconds to open the helper. "Open as a game first" in Mode and look turns the game off.

- **Id:** `forge.mode.playful`, known in the app as `playful`.
- **Folder:** [`public/v2/modules/mode/playful/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/mode/playful)
- **Needs:** the same inputs as Default, and the game's record (`coverProgress`, `saveCoverProgress`). Its `ready()` loads its screens, the game, `playful.css`, the game's stylesheet and two typefaces, Baloo 2 and Nunito, from `public/v2/vendor/`, once Playful is chosen.
- **Works on:** the website and both apps. Offline, it opens only once it has been loaded before.
- **Costs:** nothing. Questions asked from it cost what the model costs.
- **Private:** yes. It draws on the phone.
