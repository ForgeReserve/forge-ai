# Voice-in modules

A voice-in module turns the voice into words for Hold to talk. The person holds the talk button and speaks; the module listens; on release the words become the question. The app picks one voice-in module at a time.

Read [the overview](README.md) first. The bundled voice-in modules are in [`public/v2/modules/voice-in/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-in) and described in the [module list](list.md#voice-in). The whole voice design is in [`docs/VOICE.md`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/VOICE.md).

## Manifest

`kind` is `voice-in`. The other fields follow [the manifest rules](README.md#the-manifest).

## Inputs

A voice-in module gets these inputs. `audio`, `speech` and `asr` are cut down to the functions listed for them.

```js
'voice-in': ['t', 'mic', 'recognizer', 'audio', 'speech', 'asr'],
// PROJECTIONS
'voice-in': { audio: ['model', 'price', 'transcribe'], speech: ['available', 'start'], asr: ['available', 'start'] },
```

### `t`

`t(key, params)` returns the text for `key` from the string table. See [Fund](fund.md#t).

### `mic`

The microphone as raw sound (`adapters.mic` in [`public/v2/core/adapters.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/adapters.js)).

| Function | What it does |
| - | - |
| `available()` | `true` when the browser has a microphone API and Web Audio. |
| `open()` | Asks for the microphone. Resolves `{sampleRate, onData(fn), stop()}`. `fn` gets each chunk of sound as a `Float32Array` while recording. Nothing is stored or sent. |

### `recognizer`

The browser's own speech recogniser, where it has one (`adapters.recognizer`). The browser decides who hears the voice: Chrome sends it to Google.

| Function | What it does |
| - | - |
| `available()` | `true` when the browser has `SpeechRecognition`. |
| `start({lang = 'en', onText})` | Starts listening. `onText(text)` gets the words heard so far. Resolves `{stop(), cancel()}`; `stop()` resolves the final text. |

### `audio`

The engine's audio calls for speech to text. The app makes the paid call with the balance key, which the module never sees.

| Function | What it does |
| - | - |
| `model(kind)` | The engine's audio model of this kind (`'transcription'` here) that Private only allows, or `null`. It is an entry of `audio` in [`GET /v1/models`](../API.md#get-v1-models): `id`, `tier` (`'enclave'` for a private model), `max_seconds` and its prices. |
| `price(kind, usage)` | What a request costs, in msub: `price('transcription', {seconds})`. `null` when the model has no price in the balance's unit. |
| `transcribe(wav, {seconds, signal})` | Sends a WAV recording to [`POST /v1/audio/transcriptions`](../API.md#post-v1-audio-transcriptions). Resolves `{text, chargedMsub, balanceMsub, freeVoiceLeft}`. Throws `EngineError`, with `model_not_found` when the engine has no model Private only allows. |

### `speech`

The phone's own on-device recogniser, in the Android and iPhone apps (`nativeSpeech` in [`public/v2/core/native.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/native.js)): Android's on-device recogniser, or Apple's restricted to the phone. The sound stays on the phone; only the words come back. Outside the apps it is an empty object.

| Function | What it does |
| - | - |
| `available({locale})` | Resolves `{onDevice, reason, locale}`. `onDevice` is `true` only when the recogniser on the phone has the language now. |
| `start({locale, onEvent})` | Starts listening. Resolves `{id, stop(), cancel()}`, or rejects with `code` `permission`, `busy` or `unavailable`. `onEvent` gets `{type}`: `started`, `level` (`level`), `partial` (`text`), `final` (`text`), `error` (`code`), and `end`, always last. |

### `asr`

Forge Private Voice's own speech to text, a small model inside the Android app (`nativeAsr` in `core/native.js`). Only the Forge Private Voice APK carries the model; in any other build `available()` says no. Outside the Android app it is an empty object.

| Function | What it does |
| - | - |
| `available()` | Resolves `{available, reason, language}`. |
| `start({onEvent})` | The same as `speech.start`, with the same events. |

## What a voice-in module provides

### `id`

Required. The app picks voice-in modules by this id. See [How the app picks one](#how-the-app-picks-one).

### `available()`

Required. `true` when the module can listen on this phone now. The app calls it every time it works out what the screens show, so keep it fast. Return a value you already know; check slow things once in `create` (the phone module asks the phone once and keeps the answer).

### `private()`

Required. `true` only when the sound never leaves the phone or goes only to a model in sealed hardware. With Private only on, the app uses only a module whose `private()` is true.

### `price(seconds)`

Required. What turning `seconds` of sound into words costs, in msub. Return `0` when it is free. The app adds it to the price of the question shown while the person records.

### `maxSeconds()`

Required. The longest recording, in seconds. The app stops the recording there.

### `start({onLevel, onText})`

Required. The app calls it when the talk button goes down. Start listening and resolve a session once it listens. `onLevel(level)` takes the sound level from 0 to 1 for the level bars on the button; `onText(text)` takes the words heard so far, shown live. A rejection whose `name` is `NotAllowedError` or `SecurityError` makes the app say the microphone is blocked; any other says it could not start.

The session has two functions:

| Function | When the app calls it |
| - | - |
| `finish({signal})` | On release. Stop listening and resolve `{text, chargedMsub, balanceMsub}`. `text` becomes the question; an empty `text` makes the app say nothing was heard. A `balanceMsub` that is not `null` is the new balance after a paid request. `signal` aborts when the person cancels while the words are on their way. |
| `cancel()` | When the person slides off the button or the recording is dropped. Stop and keep nothing. |

`checked` (a promise) and `status()` are on the bundled `phone` and `bundled` modules: the app redraws when `checked` resolves, for those two ids only.

## Lifecycle

1. The registry calls `create(inputs)` once when the app starts.
2. The app calls `available()` and `private()` whenever it draws a screen with the talk button.
3. The talk button goes down: `start({onLevel, onText})`. The app counts the seconds itself and stops at `maxSeconds()`.
4. The button comes up: `finish({signal})`, then the text is asked as a question.
5. Slide off, or a recording too short: `cancel()`.

The recording lives in memory only. Drop it in `finish` and `cancel`.

## Errors

- `finish` may throw. An error with a `key` field (a string table key) is shown in those words, as the phone module does with `talk.phoneFailed`. Any other error is shown as the engine's error, from its `code` and `message`.
- An `AbortError` from `finish` is a cancel: the app says the question was cancelled.
- A module that knows it can no longer listen (the phone lost the language) should return `false` from `available()` from then on, so the next question goes another way.

## How the app picks one

`pickVoiceIn` in [`public/v2/core/state.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/state.js) picks one module from the loaded ones, by id:

```js
export function pickVoiceIn(mods, settings) {
  const ok = (m) => !!m?.available() && (!settings.privateOnly || m.private());
  if (settings.voiceIn === 'device' && ok(mods.device)) return mods.device;
  const order = settings.voiceIn === 'engine' ? [mods.engine, mods.bundled, mods.phone] : [mods.bundled, mods.phone, mods.engine];
  return order.find(ok) ?? null;
}
```

`mods` holds the modules by their instance `id`. The person's choice in More, Voice is `voiceIn` in the settings: `auto` (the default), `phone`, `engine` or `device`. The Voice screen in [`public/v2/screens/settings.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/settings.js) shows one row for `bundled` and `phone` together (On this phone), one for `engine` and one for `device`. The line under the talk button names where the sound goes from the module's `id` and `private()`; free voice questions apply to `engine` only.

A voice-in module with any other id loads, and the app never uses it or lists it. To offer a new one, a pull request must also add its id to `pickVoiceIn`, a row to the Voice screen, and its route to `talkView` in [`public/v2/app.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/app.js).

## Platforms

| Module | Website | Android app | iPhone app |
| - | - | - | - |
| `bundled` | Not available | Forge Private Voice APK only | Not available |
| `phone` | Not available | Where the phone's on-device recogniser has the language | Where Apple's recogniser hears the language on the phone itself |
| `engine` | Where there is a microphone and the engine has a speech to text model | The same | The same |
| `device` | Where the browser has a recogniser | Where the web view has one | The WebKit recogniser, Apple's |

`speech` is an empty object on the website, `asr` outside the Android app. `mic` and `recognizer` are the browser's on every platform.

## A minimal voice-in module

This module uses the browser's own recogniser. It is [`docs/modules/examples/voice-in/listen/`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/modules/examples/voice-in/listen), loaded through the registry by [`test/unit/module-docs.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/module-docs.test.ts). Its id is `listen`, so the app loads it and does not use it until `pickVoiceIn` knows that id.

`manifest.json`:

```json
{
  "id": "org.example.voice-in.listen",
  "kind": "voice-in",
  "version": "1.0.0",
  "name": {
    "en": "Listen in the browser"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

`index.js`:

```js
// A voice-in module: the browser's own speech recogniser (the recognizer input). It costs nothing. The
// browser decides where the sound goes (Chrome sends it to Google), so private() is false and the app
// does not use it while Private only is on.
export function create({ recognizer }) {
  return {
    id: 'listen',
    available: () => recognizer.available(),
    private: () => false,
    price: () => 0,
    maxSeconds: () => 30,
    async start({ onText = () => {} } = {}) {
      const r = await recognizer.start({ lang: 'en', onText });
      return {
        async finish() {
          return { text: await r.stop(), chargedMsub: 0, balanceMsub: null };
        },
        cancel: () => r.cancel(),
      };
    },
  };
}
```

## Tests

[`test/unit/v2/voice.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/voice.test.ts) tests the choice (`pickVoiceIn`) and the modules with fake inputs; [`test/ui/voice.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/voice.ui.test.ts) holds the talk button in Chrome with a fake microphone.
