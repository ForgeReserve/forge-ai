# The natural voice (on-device text to speech)

Status: built on branch `v2-voice` (plan: the voice bake-off). Measured in desktop Chrome only. Not yet run on a phone.

The v2 app reads answers aloud with **Phonon 31m English** (Gradium, Apache-2.0), a 31M-parameter streaming text to speech model, through Gradium's browser package **phonon-tts 0.7.0** (MIT OR Apache-2.0). The model runs in a worker in the page. The answer text is not sent anywhere, and there is no charge.

## Where the files come from

| What | Where it lives | How it gets there |
|---|---|---|
| phonon-tts 0.7.0 (JS, 4 wasm builds) | `public/v2/vendor/phonon-tts/` (committed, about 16 MB) | `scripts/vendor-phonon.sh`: pnpm in a throwaway folder with the 3-day release-age rule, install scripts off, integrity checked |
| Phonon 31m: `model.q8.gguf`, `tokenizer.json`, `config.json` | `public/v2/voice/phonon/31m-en-92741c5/` (not committed) | `node scripts/phonon-model.ts`, at build time |
| The seven en-GB female voices | `public/v2/voice/phonon/voices-0ee1720/` (not committed) | the same script |
| `index.json` (what the app reads) | `public/v2/voice/phonon/index.json` (not committed) | written by the script once every file checks out |
| Licences | `public/vendor/licenses/phonon-tts.txt`, `phonon-tts-THIRD_PARTY_LICENSES.md`, `phonon-models.txt` | committed |

`scripts/phonon/lock.json` pins every file to a Hugging Face commit (`gradium/phonon-31m-en@92741c5b`, `gradium/phonon-voices@0ee17205`) with its size and SHA-256. The script downloads into `.tmp/phonon-download/`, checks size and hash, and only then moves a file into `public/`. It refuses any repo but `phonon-31m-en` (the 40m models are CC BY-NC) and any URL that is not pinned. `--check` checks without the network.

The Docker image runs the script during the build, and so does every Android build (`scripts/android-web.ts`). The app never asks Hugging Face for anything: phonon-tts is always handed a model on the app's own address, never its default model (a test checks no app file names Hugging Face).

## How it runs

- **Voice out module** `forge.voice-out.phonon` (`public/v2/modules/voice-out/phonon/`): `private()` true, `price()` 0. It streams each 80 ms piece of sound to the speaker adapter's `stream()` (Web Audio) as the model makes it, so reading starts before the sentence is done. Stop aborts the stream and silences the speaker at once.
- **The engine wrapper** `public/v2/core/phonon.js`: reads `index.json`, checks the browser can run the model (WebAssembly SIMD and module workers), knows whether the model is downloaded, and loads it once.
- **Choice:** More, Voice lists Natural voice, Phone voice, Engine voice and Off. Until the person picks one, answers are read with the natural voice where the phone runs it, else the phone's own voice, else the engine's (`pickVoiceOut`, setting `auto`).
- **First use on the website:** before downloading, the app asks once and shows the size (about 65 MB: the model and the default voice). Not now reads nothing; answers to spoken questions are then not read on their own until the person taps Listen, which asks again. phonon-tts keeps the files in Cache Storage (`phonon-tts-v1`), so later uses load from the phone.
- **Offline:** the voice package lives under `/v2/` so the v2 service worker controls its worker too (a service worker only controls a worker whose script is inside its scope). The package files are kept by the service worker; the model files are left to phonon-tts's own cache, so they are not kept twice. Tested: after one use, the app reloads and reads aloud with the network off.
- **Threads:** the gateway serves `/v2/` and `/vendor/` with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` (`src/app.ts`), so the page is cross-origin isolated and the model runs on 3 threads. `/vendor/` needs them because pdf.js starts a worker from there, and an isolated page cannot start a worker without them. Without isolation, phonon-tts runs on one thread.
- **Android:** the APK carries the model and voices (stored uncompressed, `noCompress 'gguf', 'safetensors'`), read straight from the APK, never copied into Cache Storage, so the first open reads aloud with no download. `MainActivity` adds the same isolation headers to the app's own files (`IsolationRules.kt`). If the very first page load came up without them, the page reloads once (`reloadForIsolation`).

## What cross-origin isolation changes

With `require-corp`, the v2 page may only load other sites' files that opt in. The v2 app loads none: it talks to its engine with CORS requests (allowed), and every script, style, image and worker is its own. Checked with every UI and e2e test passing with the headers on: private (EHBP) answers, Lightning and eCash funding, camera notes, photos shared in, card taps, the Android bundle. Classic (v1) at `/` gets no new headers.

## The voice lab

`/v2/#/voice-lab`, linked from no menu. It reads a fixed corpus of 60 lines (short replies, numbers and money, names, hard cases, long answers; `public/v2/core/voicelab.js`) with each way of reading this phone has: the natural voice on the processor with threads, on one thread, on the graphics chip (WebGPU), and the phone's own voice. Per line: time to the first sound, real-time factor, gaps a listener would hear (from when each piece arrived, or from the real speaker with Play on), NaN or silent sound, clipping. Per way: model load time, first and again, and the memory the browser reports. Save results writes a JSON file to send on. Kokoro is not in this build (it would need ONNX Runtime Web, a new dependency); its baseline is flash-mobile's measured numbers and the Emma clips.

## Updating

- A new phonon-tts: change `VERSION` and `INTEGRITY` in `scripts/vendor-phonon.sh` (a version at least 3 days old), run it, run the tests.
- Another voice or model commit: edit `scripts/phonon/lock.json` (URL with the commit, size, SHA-256), run `node scripts/phonon-model.ts`. The model's folder name carries the commit, because the gateway tells phones to keep these files for a year.

## Not verified

Real phones (the Pixel 8 Pro on GrapheneOS, a low-end phone): speed, memory, threads and WebGPU there, and whether the Android web view grants cross-origin isolation (`crossOriginIsolated`, shown in the voice lab). Which voice sounds best: the default (Maeve) was not chosen by ear. The licence of the Mimi codec weights inside Phonon (the model card puts the whole file under Apache-2.0 and credits Kyutai's Pocket TTS and Mimi).
