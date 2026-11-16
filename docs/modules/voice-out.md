# Voice-out modules

A voice-out module reads an answer aloud. The app reads the answer to a question asked by voice on its own, and any answer when the person taps Listen. The app picks one voice-out module at a time.

Read [the overview](README.md) first. The bundled voice-out modules are in [`public/v2/modules/voice-out/`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/modules/voice-out) and described in the [module list](list.md#voice-out). The natural voice is described in full in [`docs/VOICE.md`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/VOICE.md).

## Manifest

`kind` is `voice-out`. The other fields follow [the manifest rules](README.md#the-manifest).

## Inputs

A voice-out module gets these inputs. `audio` and `phonon` are cut down to the functions listed for them.

```js
'voice-out': ['t', 'speaker', 'synth', 'audio', 'phonon'],
// PROJECTIONS
'voice-out': { audio: ['model', 'price', 'speak'], phonon: ['available', 'download', 'load', 'native', 'nativeFailed', 'voice', 'paceKey', 'pace', 'notePace', 'preferNatural'] },
```

### `t`

`t(key, params)` returns the text for `key` from the string table. See [Fund](fund.md#t).

### `speaker`

Sound out (`adapters.speaker` in [`public/v2/core/adapters.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/adapters.js)). All streamed sound goes through one Web Audio context. On an iPhone the sound starts only after a tap; the app calls `unlock()` inside every tap that may lead to sound.

| Function | What it does |
| - | - |
| `play(blob)` | Plays a sound file. Returns `{done, stop()}`; `done` resolves when it ends. |
| `stream({sampleRate})` | Plays sound as it is made. Returns `{push(samples), end(), done, stop(), underruns(), blocked()}`. `push` queues a `Float32Array` right after the one before; `underruns()` counts the gaps a listener heard. |
| `unlock()` | Starts the sound inside a tap. |
| `ready(ms = 1000)` | Resolves `true` when the sound can play, after giving it up to `ms`. |
| `state()` | The Web Audio context's state, or `'none'`. |

### `synth`

The phone's own voices (`adapters.synth`), only those that run on the phone, so the answer is never sent to a voice service.

| Function | What it does |
| - | - |
| `voices(lang = 'en')` | The phone's own voices for the language. |
| `speak(text, lang = 'en')` | Reads `text`. Returns `{done, stop()}`. |

### `audio`

The engine's audio calls for text to speech. The app makes the paid call with the balance key, which the module never sees.

| Function | What it does |
| - | - |
| `model(kind)` | The engine's audio model of this kind (`'speech'` here) that Private only allows, or `null`. It is an entry of `audio` in [`GET /v1/models`](../API.md#get-v1-models): `id`, `tier`, `max_chars`, `voices` and its prices. |
| `price(kind, usage)` | What requests cost, in msub: `price('speech', {requests, chars})`. `null` when the model has no price in the balance's unit. |
| `speak(input, {signal})` | Sends text to [`POST /v1/audio/speech`](../API.md#post-v1-audio-speech) with the model's first voice. Resolves `{blob, chargedMsub, balanceMsub}`; `blob` is WAV. Throws `EngineError`. |

### `phonon`

The natural voice made on the phone, Phonon 31m, from `createPhonon` in [`public/v2/core/phonon.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/phonon.js).

| Function | What it does |
| - | - |
| `available()` | `true` once the app's voice files are known and this phone can run the model: the browser has WebAssembly SIMD and workers, or the Android app's native voice works. |
| `download()` | Resolves `{needed, bytes}`: whether a first use downloads the model, and how much. |
| `load({onMeter, onProgress})` | Loads the model, from the phone's cache when it is there. Resolves a handle with `sampleRate` and `stream(text, {signal})`, which yields the sound as `Float32Array` pieces. `onMeter` gets `{loaded, total, fraction}` while it downloads. |
| `native()` | Resolves the Android app's native voice when this phone runs it, else `null`. |
| `nativeFailed(error)` | Tells the app the native voice failed, so it is not used again this session. |
| `voice()` | The name of the voice picked in More, Voice, or the default. |
| `paceKey(nativeUsed)` | The name this phone's speed is kept under. |
| `pace(key)` | The speed kept for that name, `{rtf, spc, n, at}`, or `null`. |
| `notePace(key, {rtf, spc})` | Adds one answer's speed to what is kept. |
| `preferNatural()` | `true` when the person asked to keep the natural voice on a slow phone. |

## What a voice-out module provides

### `id`

Required. The app picks voice-out modules by this id. See [How the app picks one](#how-the-app-picks-one).

### `available()`

Required. `true` when the module can read aloud on this phone now. The app calls it whenever it draws a screen with Listen. Keep it fast.

### `private()`

Required. `true` only when the answer's text never leaves the phone or goes only to a model in sealed hardware. With Private only on, the app uses only a module whose `private()` is true.

### `pieceSize()`

Required. The most characters in one piece. The app cuts the answer into plain-text pieces of this size (`speechPieces` in [`public/v2/core/speech.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/speech.js), at most 1,500 characters in all) and hands them to `price` and `speak`.

### `price(pieces, key)`

Required. What reading these pieces costs, in msub. `key` is the answer's message id, so a module that keeps sound already paid for can return `0` for it. Return `0` when it is free. The app shows it on Listen.

### `speak(pieces, options)`

Required. Reads the pieces aloud. Returns `{done, stop()}` at once. `done` resolves `{chargedMsub}` when the reading ends; the app reads the balance again when `chargedMsub` is more than 0. `stop()` stops at once.

| Option | What it is |
| - | - |
| `key` | The answer's message id. |
| `onState(state)` | Tell the app `'loading'`, `'buffering'` or `'playing'`. The Listen button follows it. |
| `onProgress(p)` | `{loaded, total, fraction, phase}` while a model downloads and gets ready, then `{fraction, phase: 'buffering'}` while sound is made ahead. |
| `onNotice(kind)` | `'slow'`: the natural voice is too slow on this phone and the phone's own voice reads this answer. The app says so once a session. |

### `download()`

Optional. Resolves `{needed, bytes}`. When a module has it and `needed` is true, the app asks before the first download, or lets the phone's own voice read while it offers the download under Listen.

### `forget(key)`

Optional. Drops the sound kept for one answer, or for all with no `key`. The app calls it when a conversation is burned and on Erase everything.

The bundled modules also have `cached(key)`. No app code calls it.

## Lifecycle

1. The registry calls `create(inputs)` once when the app starts.
2. The app calls `available()` and `private()` whenever it draws a screen with Listen, and `price(pieces, key)` for the answer on show.
3. Listen, or an answer to a voice question: `download()` first when the module has it, then `speak(pieces, options)`.
4. Stop, a new question, or the screen gone: `stop()`.
5. A conversation burned: `forget(key)` for each of its messages.

## Errors

The app reads the error `done` rejects with:

- `name` `AbortError`: a stop. Nothing is said.
- `name` `AudioBlocked`: the phone kept the sound off until a tap. The app says to tap Listen.
- an error with a `code`: shown as the engine's error.
- any other error: the app says the answer could not be read aloud. When a download window is open, it shows the message there with Try again.

## How the app picks one

`pickVoiceOut` in [`public/v2/core/state.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/state.js) picks one module by id:

```js
export function pickVoiceOut(mods, settings) {
  const ok = (m) => !!m?.available() && (!settings.privateOnly || m.private());
  switch (settings.voiceOut) {
    case 'off':
      return null;
    case 'phonon':
      return ok(mods.phonon) ? mods.phonon : null;
    case 'engine':
      return ok(mods.engine) ? mods.engine : null;
    case 'device':
      return ok(mods.device) ? mods.device : null;
    default:
      return [mods.phonon, mods.device, mods.engine].find(ok) ?? null;
  }
}
```

`voiceOut` in the settings is `auto` (the default), `phonon`, `device`, `engine` or `off`, set in More, Voice. The Voice screen in [`public/v2/screens/settings.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/screens/settings.js) has one row for each of the three ids and Off. The first run's Listen uses `device` only, and only when it is private. The price of a voice question counts the engine's reading only for `engine`.

A voice-out module with any other id loads, and the app never uses it or lists it. To offer a new one, a pull request must also add its id to `pickVoiceOut` and a row to the Voice screen.

## Platforms

| Module | Website | Android app | iPhone app |
| - | - | - | - |
| `phonon` | Where the browser can run the model; the first use downloads it | The app carries the files; native code makes the voice where the phone runs it, else the web build | The app carries the files; the web build runs it on the graphics chip where WebKit has WebGPU, else on one thread |
| `device` | Where the phone has its own voice for English | The same | The same |
| `engine` | Where the engine has a text to speech model | The same | The same |

## A minimal voice-out module

This module reads with the phone's own voices. It is [`docs/modules/examples/voice-out/say/`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/modules/examples/voice-out/say), loaded through the registry by [`test/unit/module-docs.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/module-docs.test.ts). Its id is `say`, so the app loads it and does not use it until `pickVoiceOut` knows that id.

`manifest.json`:

```json
{
  "id": "org.example.voice-out.say",
  "kind": "voice-out",
  "version": "1.0.0",
  "name": {
    "en": "Say it on the phone"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

`index.js`:

```js
// A voice-out module: the phone's own voices (the synth input), one piece of the answer at a time. Only
// voices that run on the phone are used, so the answer is not sent anywhere and it costs nothing.
export function create({ synth }) {
  return {
    id: 'say',
    available: () => synth.voices('en').length > 0,
    private: () => true,
    pieceSize: () => 200,
    price: () => 0,
    speak(pieces, { onState = () => {} } = {}) {
      let stopped = false;
      let current = null;
      const done = (async () => {
        for (const piece of pieces) {
          if (stopped) break;
          onState('playing');
          current = synth.speak(piece, 'en');
          await current.done;
        }
        return { chargedMsub: 0 };
      })();
      return {
        done,
        stop() {
          stopped = true;
          current?.stop();
        },
      };
    },
  };
}
```

## Tests

[`test/unit/v2/phonon.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/phonon.test.ts) runs the natural voice module against a fake engine; [`test/unit/v2/voice.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/voice.test.ts) tests `pickVoiceOut`; [`test/ui/phonon.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/phonon.ui.test.ts) reads answers aloud in Chrome.
