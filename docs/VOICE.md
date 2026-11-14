# The natural voice (on-device text to speech)

Status: built on branch `v2-voice` (plan: the voice bake-off). Measured with the voice lab on an iPhone, a Pixel 8 Pro and a Mac (2026-11-14, below); the device the app picks follows from those numbers.

The v2 app reads answers aloud with **Phonon 31m English** (Gradium, Apache-2.0), a 31M-parameter streaming text to speech model, through Gradium's browser package **phonon-tts 0.7.0** (MIT OR Apache-2.0). The model runs in a worker in the page. The answer text is not sent anywhere, and there is no charge.

## Where the files come from

| What | Where it lives | How it gets there |
|---|---|---|
| phonon-tts 0.7.0 (JS, 4 wasm builds) | `public/v2/vendor/phonon-tts/` (committed, about 16 MB) | `scripts/vendor-phonon.sh`: pnpm in a throwaway folder with the 3-day release-age rule, install scripts off, integrity checked |
| Phonon 31m: `model.q8.gguf`, `tokenizer.json`, `config.json` | `public/v2/voice/phonon/31m-en-92741c5/` (not committed) | `node scripts/phonon-model.ts`, at build time |
| The app's two en-GB female voices, Maeve (default) and Freya | `public/v2/voice/phonon/voices-0ee1720/` (not committed) | the same script |
| Five more en-GB female voices and five accent-test voices, voice lab only | the same folder (not committed) | the same script |
| `index.json` (what the app reads) | `public/v2/voice/phonon/index.json` (not committed) | written by the script once every file checks out |
| Licences | `public/vendor/licenses/phonon-tts.txt`, `phonon-tts-THIRD_PARTY_LICENSES.md`, `phonon-models.txt` | committed |

`scripts/phonon/lock.json` pins every file to a Hugging Face commit (`gradium/phonon-31m-en@92741c5b`, `gradium/phonon-voices@0ee17205`) with its size and SHA-256. The script downloads into `.tmp/phonon-download/`, checks size and hash, and only then moves a file into `public/`. It refuses any repo but `phonon-31m-en` (the 40m models are CC BY-NC) and any URL that is not pinned. `--check` checks without the network.

The Docker image runs the script during the build, and so does every Android build (`scripts/android-web.ts`). The app never asks Hugging Face for anything: phonon-tts is always handed a model on the app's own address, never its default model (a test checks no app file names Hugging Face).

## How it runs

- **Voice out module** `forge.voice-out.phonon` (`public/v2/modules/voice-out/phonon/`): `private()` true, `price()` 0. It streams each 80 ms piece of sound to the speaker adapter's `stream()` (Web Audio) as the model makes it, so reading starts before the sentence is done. Stop aborts the stream and silences the speaker at once.
- **The engine wrapper** `public/v2/core/phonon.js`: reads `index.json`, checks the browser can run the model (WebAssembly SIMD and module workers), knows whether the model is downloaded, and loads it once.
- **Choice:** More, Voice lists Natural voice, Phone voice, Engine voice and Off. Until the person picks one, answers are read with the natural voice where the phone runs it, else the phone's own voice, else the engine's (`pickVoiceOut`, setting `auto`).
- **Speaker:** while the natural voice is the one in use, More, Voice also offers its speaker: **Maeve** (the default) or **Freya** (setting `naturalVoice`, `''` for the default). These two are the lock's `voices`, the only ones the app's model is handed. The other five en-GB voices (Pippa, Elodie-Rose, Imogen, Lottie, Bryony) are `labVoices` with `use: "lab-only"`: the voice lab offers them under "Other voices, lab only" to compare by ear, the app never does. A speaker picked before the first use is the one the first download fetches (the same 256 KB as Maeve); another is fetched the first time it reads.
- **First use on the website:** before downloading, the app asks once and shows the size (about 65 MB: the model and the default voice). Not now reads nothing; answers to spoken questions are then not read on their own until the person taps Listen, which asks again. After Download, a window shows the download as it goes (below) and closes once the voice starts reading. phonon-tts keeps the files in Cache Storage (`phonon-tts-v1`), so later uses load from the phone.
- **Download progress:** a bar with MB done of MB in all and the percent, then the phase in words: Downloading, Getting ready (every byte is here and the model is being set up), and in the voice lab Reading line 3 of 10. The numbers are phonon-tts's own progress reports (`onProgress`, one stream of `{file, loaded, total, cached}` per file), added up by `createMeter` in `core/phonon.js` over the files a load reads: the weights, the tokenizer, the config and the voice it starts with. A file's size is the server's `Content-Length`, or the size the lock pins when there is none; a file read from the cache counts as done at once. The package still fetches and caches the files itself, so Cache Storage and offline use are as before. A failed download says so ("The download stopped. Check the connection and try again.") with Try again; in the app Try again does not ask the download question a second time, and Hide leaves the download running (Listen shows the percent).
- **Sound on iPhone:** iOS (Safari, and every browser there) starts Web Audio only inside a tap. A context made or resumed later, after an await, stays suspended: it plays nothing and never ends a sound. So the speaker (`core/adapters.js`) keeps one Web Audio context for the page, and `speaker.unlock()` (make or resume it, and play one sample of silence) runs first, before any await, in every tap that leads to sound: Run in the voice lab, Listen, Download, Try again, and pressing and letting go of the talk button (the answer to a spoken question is read after the release). While it plays, a stream sets the iOS 17+ audio session to `playback`, so the ring switch on silent does not mute it, and puts back `auto` after. A stream whose context never runs ends on a timer rather than waiting for ever, and if the sound is still off when the voice is ready, the answer screen says "Tap Listen to hear the answer" and the lab measures without playing and says so.
- **Offline:** the voice package lives under `/v2/` so the v2 service worker controls its worker too (a service worker only controls a worker whose script is inside its scope). The package files are kept by the service worker; the model files are left to phonon-tts's own cache, so they are not kept twice. Tested: after one use, the app reloads and reads aloud with the network off.
- **Threads:** the gateway serves `/v2/` and `/vendor/` with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` (`src/app.ts`), so the page is cross-origin isolated and the model runs on 3 threads. `/vendor/` needs them because pdf.js starts a worker from there, and an isolated page cannot start a worker without them. Without isolation, phonon-tts runs on one thread.
- **Android:** the APK carries the model and voices (stored uncompressed, `noCompress 'gguf', 'safetensors'`), read straight from the APK, never copied into Cache Storage, so the first open reads aloud with no download. `MainActivity` adds the same isolation headers to the app's own files (`IsolationRules.kt`). If the very first page load came up without them, the page reloads once (`reloadForIsolation`).

## Where it runs (measured)

The voice lab on real phones, 2026-11-14, voice Maeve, 3 short lines each (first sound is the median; RTF is time per second of sound, under 1 keeps up):

| Phone | Browser | Processor, threads | Processor, one thread | Graphics chip (WebGPU) |
|---|---|---|---|---|
| iPhone, iOS 18.7, 4 cores, WebGPU vendor `apple` | Safari 26.6.1 | 38 ms, RTF 0.147 | 53 ms, RTF 0.203 | **27 ms, RTF 0.045** (load 8.0 s first, 3.2 s again) |
| Pixel 8 Pro, GrapheneOS, 9 cores, WebGPU vendor `arm`, architecture `valhall` | Chrome 155 | **36 ms, RTF 0.220** (load 21.4 s first with the download, 4.1 s again) | 46 ms, RTF 0.294 | 179 ms, RTF 0.461 (load 11.4 s again) |
| Mac, 8 cores, WebGPU vendor `apple` | Safari 26.5 | **26 ms, RTF 0.084** | 32 ms, RTF 0.171 | loaded (3.3 s) but read no line and said no error: a lab bug, see The voice lab |

So the app picks (`chooseVoiceDevice` in `core/phonon.js`, a pure function with a unit test per case):

1. **WebGPU** when the adapter's vendor is `apple` and it is not a software fallback adapter (on Apple's chips WebGPU is 3 times faster than threads).
2. Otherwise the **processor with threads** (`threads: 'auto'`) on a cross-origin isolated page (on the Pixel's Mali, WebGPU is 2 times slower than threads; every other vendor is unmeasured, so it gets the processor too).
3. Otherwise the **processor on one thread**.

On WebGPU the app asks phonon-tts for `device: 'auto'`, so a WebGPU that fails to start falls back to the processor inside the same worker, with the files it already downloaded. If WebGPU fails to start, or on its first use errors, ends with no sound, or makes no sound within 20 s (`GPU_FIRST_SOUND_MS`), the app frees it, reads the same line again on the processor (threads where the page is isolated), stays there for the rest of the session, and remembers it in the settings (`voiceDevice: 'cpu'`), so the next start goes straight to the processor without asking for an adapter. Erase everything clears that, like every setting. The voice lab shows which the app would pick ("The app reads with") and saves it in its results (`env.appDevice`); the lab itself still runs each way exactly as asked, with no fallback.

## What cross-origin isolation changes

With `require-corp`, the v2 page may only load other sites' files that opt in. The v2 app loads none: it talks to its engine with CORS requests (allowed), and every script, style, image and worker is its own. Checked with every UI and e2e test passing with the headers on: private (EHBP) answers, Lightning and eCash funding, camera notes, photos shared in, card taps, the Android bundle. Classic (v1) at `/` gets no new headers.

## The voice lab

`/v2/#/voice-lab`, linked from no menu. Press Run to start (the tap also unlocks the sound on iPhone; see above). It reads a fixed corpus of 60 lines (short replies, numbers and money, names, hard cases, long answers; `public/v2/core/voicelab.js`) with each way of reading this phone has: the natural voice on the processor with threads, on one thread, on the graphics chip (WebGPU), and the phone's own voice. Per line: time to the first sound, real-time factor, gaps a listener would hear (from when each piece arrived, or from the real speaker with Play on), NaN or silent sound, clipping. Per way: model load time, first and again, and the memory the browser reports. While the model loads, the download bar and its phases show above the results; a failed download stops the run with Try again (the other ways read the same files). The lab waits for the model to be in the cache before its second load, so it does not download it twice. The phone's own voice: the browser's voice list is often empty until it has loaded it (iOS Safari), so the lab waits for the `voiceschanged` event (and looks again every 250 ms) for up to 4 s before it says there is none, and counts every English voice the browser marks local (`localService`; WebKit marks every iOS voice local, with languages like `en-GB`, `en-US`, or `en_US` on older WebKit), British first. The Run tap also speaks a silent utterance, since iOS lets a page speak later only once it spoke inside a tap, and a line that does not start in 10 s fails rather than hold the run. The results list what the browser offered (`listed`). On GrapheneOS, which has no speech engine, it still says there is none. Save results writes a JSON file to send on (with the voice, its locale, and whether it was an accent test). Kokoro is not in this build (it would need ONNX Runtime Web, a new dependency); its baseline is flash-mobile's measured numbers and the Emma clips.

### Accent test (English model)

Phonon 31m English is the only model we can ship (the multilingual 40m model is CC BY-NC and is not used or downloaded). The lab can hand it a speaker from another locale, to hear whether it then reads English with that accent. Five female speakers from `gradium/phonon-voices` at the same pinned commit (`0ee17205`), picked from its `voices.jsonl` (whose SHA-256 the lock pins), each 256,136 bytes:

| Name | Locale | Catalog description |
|---|---|---|
| Regina | es-MX | A confident, upbeat Mexican Spanish adult voice with the natural assurance of a closer. Ideal for proactive assistants and sales-led customer interactions. |
| Ximena | es-MX | A playful, expressive Mexican Spanish adult voice that turns everyday moments into stories. Great for engaging assistants and personable conversational AI. |
| Alba | es-ES | A sweet, expressive young Castilian Spanish voice, soft and girly with lively emphasis, sparky and to the point for efficient support. |
| Isadora | pt-BR | An upbeat young voice with a light girlish tone and warm bounce, quick and to the point, ideal for efficient, caring customer service. |
| Maëlys | fr-FR | A young French voice, energetic and enthusiastic with a welcoming, upbeat delivery, sparky and to the point for responsive support. |

They are `labVoices` in `scripts/phonon/lock.json` (with `use: "accent-test"`; the other en-GB voices there say `use: "lab-only"`) and in `index.json`, never in `voices`, so the app never offers them: its model spec leaves them out, and only the lab loads a model with them (`load({lab: true})`, kept apart from the app's). The lab's Voice list groups them under "Accent test (English model)" and shows each one's catalog description. `checkLock` refuses a lab voice that does not say what it is for (`lab-only` or `accent-test`), does not come from the pinned voice repo, or reuses a name, and still refuses any model repo but `phonon-31m-en`. They add 1.3 MB to the files the build fetches (and to the Android APK); a first use on the website still fetches only the model and the default voice. Whether any of them gives a usable accent has to be judged by ear; nothing here measures it.

## Updating

- A new phonon-tts: change `VERSION` and `INTEGRITY` in `scripts/vendor-phonon.sh` (a version at least 3 days old), run it, run the tests.
- Another voice or model commit: edit `scripts/phonon/lock.json` (URL with the commit, size, SHA-256), run `node scripts/phonon-model.ts`. A voice for the lab only goes in `labVoices` with `use: "lab-only"` or `"accent-test"`, never in `voices`; a voice the app offers goes in `voices` and needs a line in More, Voice (`voice.natural.<name>` in `strings/en.js`). The model's folder name carries the commit, because the gateway tells phones to keep these files for a year.

## Tests

The UI tests (`test/ui/phonon.ui.test.ts`, Chrome only) hold Chrome to Safari's rule for sound: an init script makes any Web Audio context made or resumed outside the handling of a tap (pointerup, click, key, touchend, and the microtasks they queue) stay suspended, and counts only sound queued on a running context. Before the iPhone fix, the lab run with Play on hung on its first line and the answer after Download was never heard; both are heard now. The lab's phone voice is tested with a voice list that starts empty and fills 1.5 s later (as iOS Safari does), and with one that never fills (GrapheneOS). Other tests: the bar moves and reaches 100% with every phase seen, a download of the weights made to fail shows Try again, which then downloads and reads (lab and app), and the accent group lists the five speakers and reads with one.

## Not verified

Real iPhone Safari: the tests run in Chrome with Safari's rule imitated, not in WebKit. Not checked on an iPhone: that the unlock in each tap is enough there (including after the microphone has been on), that `navigator.audioSession` set to `playback` plays with the ring switch on silent and does not upset the microphone, threads (cross-origin isolation, workers inside a worker), WebGPU, Cache Storage keeping a 65 MB entry, and the memory a phone allows. Measured on the iPhone, the Pixel 8 Pro (in Chrome) and a Mac with 3 short lines each (above), not with the full corpus or on a low-end phone; memory on phones; whether the Android web view grants cross-origin isolation (`crossOriginIsolated`, shown in the voice lab). The fallback from WebGPU to the processor is tested in Chrome with a faked Apple adapter and a WebGPU engine made to fail to start (`test/ui/phonon.ui.test.ts`), and its first-use cases (an error, no sound, no sound in time) with a fake phonon-tts in Node; not on an iPhone, where WebGPU has not failed yet. Which voice sounds best: Maeve and Freya were picked by the owner; Freya has not been heard on a phone in the app. The licence of the Mimi codec weights inside Phonon (the model card puts the whole file under Apache-2.0 and credits Kyutai's Pocket TTS and Mimi).
