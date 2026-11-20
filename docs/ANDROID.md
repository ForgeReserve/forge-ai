# The Android app

Status: built in slice C1, card taps in A13, the native natural voice on branch v2-voice (docs/V2-BUILD.md, docs/VOICE.md). A debug build was installed on a Galaxy A16 5G for the voice lab only; no real card has been tapped.

Forge for Android is the v2 web app in a Capacitor shell (`android/`, Capacitor 6.2.3). The app's files are inside the APK: it loads no code from the network. It talks only to its engine, and to a till the person paired for Fedimint cards.

- Name **Forge**, application id `com.forgereserve.ai`, Android 9 (API 28) and up. A second APK of the same app, **Forge Private Voice** (`com.forgereserve.ai.privatevoice`), adds its own speech to text for GrapheneOS (Two APKs, below).
- No Google services, no Firebase, no analytics. It should run on GrapheneOS without Google Play; that is not tested on a phone yet.
- The engine is `https://ai.forge-reserve.com` until the person sets another in **More, Engine**. HTTPS only.
- eCash on its way in is tied to the engine it was sent to. After a switch, it is never sent to the new engine. It waits on the phone until the person goes back to the first one (`public/v2/core/vault.js`).
- The web view sends nothing to Google: Safe Browsing link checks and WebView usage metrics are off in `AndroidManifest.xml`.

## What it does that the website does not

| | How |
|---|---|
| Event links | `https://ai.forge-reserve.com/j#<pass>`, the one QR code on an event's slide, opens the app on that pass (App Links; `JoinPlugin.kt`, `JoinRules.kt`, ForgeJoin), cold or while it runs. The web app then opens a free balance with it (Event links, below). |
| Photos shared in | Another app's share sheet sends a photo to Forge. It opens Share unseen with it (`ShareInPlugin.kt`, `public/v2/core/native.js`). The photo is read into memory, never written to storage. |
| Share out | Share unseen's Share opens Android's share sheet with the protected photo only. Save opens the system save screen, so no storage permission is needed (`SharePlugin.kt`). The page says Saved only once the file is written; a closed save screen says nothing, and a failed write says Not saved. |
| Back button | Walks back through the app's screens, then leaves. |
| Status and navigation bars | The colour of the page, as a browser keeps them its theme-color (`BarsPlugin.kt`, `BarRules.kt`, `core/native.js` followBars): dark with light icons on Midnight (the default look, and the colour the app starts in) and the first run, light with dark icons on the Light look. |
| Natural voice, native | Where the phone runs it (64-bit ARM with ARMv8.2), the natural voice is made by Gradium's native runtime (`libptts_ffi.so`, built by `scripts/android-ptts.sh` from a pinned xn-ptts commit and committed with its SHA-256) in a process of its own (`VoiceService`, `:voice`), through ForgeVoice (`VoicePlugin.kt`), and played through an `AudioTrack`. On the Galaxy A16 5G it makes the voice at RTF 0.30 against 0.94 in the browser (docs/VOICE.md, Native voice in the Android app). |
| Natural voice | The APK carries the natural voice (Phonon 31m and seven en-GB voices, docs/VOICE.md), stored uncompressed, so answers are read aloud offline from the first open with no download. The web view reads the files straight from the APK; nothing is copied into its cache. `MainActivity` serves the app's own files with the cross-origin isolation headers (`IsolationRules.kt`) so the voice can run on several threads; on the Galaxy A16 5G (Android System WebView, 2026-11-15) the voice lab shows the page is not isolated (`crossOriginIsolated` false) even so, so there the browser's build runs on one thread; the cause is not found. Where the phone runs it, the native voice below is used instead. |
| Hold to talk, Forge Private Voice | Forge Private Voice hears Hold to talk with its own model first (Moonshine tiny through sherpa-onnx, in a process of its own, `:asr`; `AsrPlugin.kt`, ForgeAsr): free, and the sound never leaves the phone, also where the phone has no recogniser of its own, as on GrapheneOS (docs/VOICE.md, Bundled speech to text). In the universal APK ForgeAsr says it is unavailable. |
| Hold to talk on the phone | Where the phone's on-device speech recogniser has the language (Android 12 and up), Hold to talk is heard on the phone through ForgeSpeech (`SpeechPlugin.kt`, `SpeechRules.kt`): free, and the sound never leaves the phone. Only `createOnDeviceSpeechRecognizer` is used, never a recogniser that may send it to a server; elsewhere the engine hears it, and on a phone whose recogniser heard nothing in two presses in a row while there was sound the app asks first, and the engine hears it only after Go online (docs/VOICE.md, Speech input on the phone). On the Galaxy A16 5G it is offered; on the Pixel 8 Pro with GrapheneOS there is no on-device recogniser. |
| Card taps | Tap a card reads a Cashu eCash card over NFC (`NfcPlugin.kt`, ForgeNfc): IsoDep connect, transceive and close, 5 seconds per command, reading on only while that screen is open. The page builds every command (`public/v2/core/card/`); the plugin checks each is one well formed short APDU and hands back the card's whole answer. The iPhone app has the same plugin in Swift ([IOS.md](IOS.md)). |
| Fedimint cards | Tap a Fedimint card pays the engine's Lightning invoice through a till (`TillPlugin.kt`, ForgeTill; [PAYMENTS.md](PAYMENTS.md)). Pairing scans the till's pairing code; the till's address and pay token are sealed with a key in the Android Keystore and the token never goes back to the page. The plugin sends only the till's pay routes, over https, and holds the card link (a WebSocket, `TillLink.kt`) while the page relays the till's card commands to the card through ForgeNfc. Erase everything forgets the till and deletes the key. |

Camera and microphone are asked for the first time they are used (scanning a note, taking a photo inside the app, holding Hold to talk), through Capacitor's web view, or by ForgeSpeech the first time the phone's recogniser listens (the same `RECORD_AUDIO` permission). Camera, microphone and NFC are optional features, so the app installs on phones without them. NFC is used by Tap a card (slice A13) and Tap a Fedimint card (slice A14). A phone with NFC turned off is asked to turn it on; one without NFC is told it cannot read cards.

The app has no Classic mode (it carries only the v2 app) and no service worker (its files are already on the phone).

## What it keeps on the phone

The same as the web app (docs/PRIVACY.md), inside the app's own web view storage. On top of that:

- Backups are off (`allowBackup="false"` and data extraction rules that exclude everything), so no copy of the balance key, chats or photos goes to a cloud backup or a phone to phone transfer.
- Two kinds of photo file: the protected photo handed to the share sheet (in the app's cache, `shared-out/`), and a photo taken with the phone's own camera app for Share unseen (Capacitor writes it to the app's own pictures folder). Take a photo uses the camera inside the app (getUserMedia in the web view, [APP.md](APP.md)), which writes no file; the phone's camera app is used only where that camera cannot open. Both files are removed when the app starts, when Share unseen closes, and by Erase everything, which also clears the web view's cache.
- Uninstalling the app removes everything it kept.

## Two APKs

One app, two Gradle product flavours (dimension `voice`, `android/app/build.gradle`):

| Flavour | Name | Application id | What it adds | Debug APK, 2026-11-15 |
|---|---|---|---|---|
| `universal` | Forge | `com.forgereserve.ai` | Nothing: today's app, for every phone | 92.2 MB (92,216,164 bytes; 91,914,904 before the flavours: ForgeAsr's code, the web module that says it is unavailable, and zip alignment) |
| `privatevoice` | Forge Private Voice | `com.forgereserve.ai.privatevoice` | Its own speech to text: `libsherpa-onnx-jni.so` (arm64, 24.2 MB, ONNX Runtime inside) and Moonshine tiny English (44.2 MB, stored uncompressed), plus their licences | 160.6 MB (160,557,306 bytes), 68.3 MB more |

- The two have different application ids, so both can be installed on one phone side by side, each with its own balance, chats and settings. A phone moving from one to the other does not carry them over (back up the balance key first).
- Everything else is the same code and the same web app. The flavour differs only in `src/universal/` (`AsrBundle.kt`: no model) and `src/privatevoice/` (`AsrBundle.kt` with the model, sherpa-onnx's Kotlin API files, a manifest that adds the `:asr` service, and the name).
- The model, the library and the privatevoice-only licences are put in place by `node scripts/asr-model.ts` (Gradle task `forgeAsrFiles`, before every privatevoice build only; pinned in `scripts/asr/lock.json`, about 79 MB to download the first time). Not committed.
- Forge Private Voice is for GrapheneOS, which has no on-device recogniser; on another Android phone it works too, and hears with its own model before the phone's recogniser.
- Native libraries sit on 16 KB boundaries in both APKs (`zipalign -c -P 16`), and the sherpa-onnx library's segments are 16 KB aligned.

## Build

Needs: `pnpm install` at the repository root (the Gradle build uses `node_modules/@capacitor/android`), the Android SDK (`ANDROID_HOME`, or `android/local.properties`), JDK 17, and Node 22.18 or later.

```sh
cd android
./gradlew assembleUniversalDebug assemblePrivatevoiceDebug testUniversalDebugUnitTest testPrivatevoiceDebugUnitTest
# app/build/outputs/apk/universal/debug/app-universal-debug.apk
# app/build/outputs/apk/privatevoice/debug/app-privatevoice-debug.apk
```

CI builds both and checks both for 16 KB alignment, and that the universal APK carries no model or sherpa-onnx library.

Every build first runs `node scripts/android-web.ts`. It puts the natural voice's files in place (`scripts/phonon-model.ts`: downloaded from Hugging Face at build time when missing, pinned by commit and SHA-256 in `scripts/phonon/lock.json`), then copies the v2 app and what it imports (`public/v2`, `public/js`, `public/vendor` with the licences, the icons) into `android/app/src/main/assets/public`, with the v2 page as its start page. v1, the admin and beta pages, `/free` and `/download` stay on the website. The copied files are not committed. The voice makes the debug APK about 92 MB (2026-11-15: the model and voices 65 MB, the native voice library 5.9 MB; 12 MB without them). The native libraries in `android/app/src/main/jniLibs/` are committed; rebuild them only with `scripts/android-ptts.sh` (Rust, cargo-ndk and the NDK), which checks them against `scripts/ptts/lock.json` (`--record` to accept a new build).

The Android project is kept by hand. Do not run `npx cap add`, `cap sync` or `cap update`: they would put back the Cordova module, the Google services hook and the template icons.

Capacitor 6 is used because it builds with JDK 17; Capacitor 7 and 8 need JDK 21.

## Sign

A release APK is signed with the owner's key. Make the key once, outside this repository, and keep it and its password safe: a phone takes an update only when it is signed with the same key.

```sh
keytool -genkeypair -v -keystore ~/keys/forge-release.jks -alias forge -keyalg RSA -keysize 4096 -validity 10000
```

Then, for each release:

```sh
scripts/android-release.sh                      # asks for the keystore file and alias
scripts/android-release.sh --keystore ~/keys/forge-release.jks --alias forge
scripts/android-release.sh --keystore ~/keys/forge-release.jks --alias forge --flavour privatevoice
```

The script asks for the keystore before building anything and refuses one inside the repository. `apksigner` asks for the password itself, so it never passes through the script. It writes `dist/forge-<version>.apk` (with `--flavour privatevoice`, `dist/forge-private-voice-<version>.apk`) and prints its SHA-256 and the signing certificate's SHA-256. It aligns native libraries to 16 KB (`zipalign -P 16`). The same key can sign both: they are different apps to Android.

## Install

From the website: put the signed APK on the server and set `FORGE_APK_PATH` to it (for example `/data/forge.apk` on the gateway's data volume). `/download` then offers it with its size, its SHA-256 and four install steps. `/download/info` gives the same values as JSON, and `/download/forge.apk` is the file. Unset, or no file there, the page says the app is coming and points to the web app. A new file put in place is picked up without a restart. An iPhone or iPad is never offered the APK: `/download` shows it Forge for iPhone ([IOS.md](IOS.md), Getting the app), and `/download/info` adds `ios` only while `FORGE_IOS_URL` is set.

Forge Private Voice: put its signed APK on the server too and set `FORGE_APK_PRIVATE_VOICE_PATH` to it (for example `/data/forge-private-voice.apk`). `/download` then starts with a choice of two, an icon and one word each: a phone, **Android** (picked first), and a shield, **GrapheneOS**; an info button beside each says in one line what it is. The download button, size and SHA-256 follow the choice. `/download/info` adds `privateVoice` with the same fields, and `/download/forge-private-voice.apk` is the file. Unset, or no file there, the choice is hidden and the page is as before.

On the phone: open `/download`, download, open the file, and allow the browser to install apps when Android asks.

From a computer, for testing: `adb install -r app-debug.apk`.

## Update

1. Raise `versionCode` in `android/app/build.gradle` by one (and the version in `package.json` if it changed); both APKs share it.
2. Run `scripts/android-release.sh` with the same keystore, once per APK offered (`--flavour privatevoice` for Forge Private Voice).
3. Replace the file at `FORGE_APK_PATH` (and at `FORGE_APK_PRIVATE_VOICE_PATH`).

Installing the new APK over the old one keeps the balance, chats and settings. An APK signed with another key does not install over it.

## Event links

One QR code gets a room full of people into Forge with a free balance, on the web app or in the Android app, with no code to copy. The operator makes an event pass (`pnpm admin passes:create`, [ADMIN.md](ADMIN.md), Event passes), which prints its link: `https://ai.forge-reserve.com/j#<pass>`. That link goes in the QR code. The pass is in the fragment, so it never reaches the server or its logs.

- **`/j`** (`public/v2/join/`, served by the gateway; not in the APK) reads the fragment on the phone. Not Android (an iPhone, a computer): it goes straight to `/v2/#join=<pass>`. Android: two big steps, **1 Get the app** (the `/download` page's APKs, with the Android or GrapheneOS choice when both are offered) and **2 Open the app**, plus a small **Use in browser**. No pass: `/download` (Forge for iPhone on an iPhone). Android with no APK on the site: the web app.
- **Open Forge** is a Chrome intent link, `intent://ai.forge-reserve.com/j#<pass>#Intent;scheme=https;package=<id>;S.browser_fallback_url=<encoded /j?app=none#<pass>>;end`. Android reads the intent from the last `#`, so the app receives `https://ai.forge-reserve.com/j#<pass>`. The package is the one picked in step 1 (`com.forgereserve.ai`, or `com.forgereserve.ai.privatevoice` for GrapheneOS), remembered on the phone. When that app is not installed, Chrome comes back to `/j?app=none#<pass>`, which says to get the app first, instead of going to an app store.
- **App Links:** both apps have an `android:autoVerify="true"` VIEW filter for `https://ai.forge-reserve.com/j` (`AndroidManifest.xml`). Once Android has verified the site, a QR code scanned on a phone with the app opens the app directly and `/j` is never shown. Verification reads `/.well-known/assetlinks.json`, which the gateway serves for both package names with the certificate fingerprints in `FORGE_ANDROID_CERT_SHA256` (comma separated; `keytool -list -v -keystore <keystore>` prints them). Unset, that file answers 404 and the links open in the browser, where `/j` takes over. `ai.forgereserve.org` is left out: it only redirects to `ai.forge-reserve.com`, and Android does not verify through a redirect.
- **In the app**, `JoinPlugin` takes the pass from the launch intent and from every new one (`MainActivity` is `singleTask`), keeps it in memory only, and hands it to the page once (`take`); a reopen from recent apps is ignored. **In the web app** (`/v2/#join=<pass>`, or the pass from ForgeJoin) the pass is removed from the address at once. With no balance key yet, `app.js` `joinWith` opens a free balance with it through the same path as Start free (`POST /v1/wallet/open`), marks the first run seen, and asks Start free's Private only question once (Use free models, or Keep Private only), then the home. A phone that already has a key keeps it and spends nothing. A used up or expired pass is said in a toast, and the phone goes on to the first run with its own Start free.

## The engine and CORS

The app's pages come from `https://localhost` (Capacitor), so every engine call is cross-origin. The gateway allows any origin on `/v1/*`, `/attestation` and `/.well-known/*` (no cookies are used), the request headers the app sends (including `X-Bellows-Pow`), and exposes the answer headers it reads (including `X-Bellows-Pow-Challenge`). `test/unit/cors.test.ts` runs each route the way the app calls it.

## Tests

- `cd android && ./gradlew testUniversalDebugUnitTest testPrivatevoiceDebugUnitTest` (the same tests, once per flavour): Forge Private Voice's speech to text rules (`AsrRulesTest`, docs/VOICE.md), the bars' colour and icons (`BarRulesTest`), the share rules (what counts as a shared photo, size limits, the type read from the file's bytes, safe file names, base64 limits), the back button, the phone's speech recogniser rules (`SpeechRulesTest`: languages, availability, error codes, one press with pauses), and the native voice's rules (`VoiceRulesTest`: which processors, threads and cores, the model folder, the adb lab run; `VoicePaceTest`: the slow-phone start, with the web test's numbers).
- `JoinRulesTest` (in both flavours' unit tests): which intents carry an event pass, including the data Android makes from the `/j` page's intent link.
- `test/unit/passes.test.ts`, `test/ui/join.ui.test.ts`: event passes, `/j`, `assetlinks.json` and the web app's join; `test/ui/android.ui.test.ts` also opens the app on a pass through the ForgeJoin stand-in, cold and while it runs.
- `test/unit/android.test.ts`: the manifest and Gradle files (app id, Android 9, no Google services, the permissions, optional features, no backups, no cleartext, the share filter and file paths), the bundle, and Forge Private Voice (the flavours, the `:asr` process, `scripts/asr/lock.json` and its refusals, the Kotlin API files, the licences the universal APK leaves out).
- `test/unit/v2/native.test.ts`: the web side of the bridge and the engine address rules.
- `test/ui/android.ui.test.ts`: the bundle served from its own origin with a stand-in for Capacitor's bridge, against a gateway on another origin: the default engine, switching engine, funding, a streamed answer, a photo shared in and shared out, the bars following the look, Back from the home an event link opened with the game first (Playful), and the `/download` page.
- `test/unit/download.test.ts` (both APKs, the choice shown only with both, the iPhone app's link), `test/unit/android-release.test.ts` (both flavours, 16 KB alignment).

## Not verified

- Event links on a phone: App Link verification needs `assetlinks.json` live on `ai.forge-reserve.com` with the release certificate's fingerprint, and the intent link from `/j` was checked against Android's parsing rules in tests, not tapped in Chrome on a phone.

- Forge Private Voice: its debug APK was installed on both phones (2026-11-15) and synthetic clips heard through ForgeAsr's path (docs/VOICE.md, Bundled speech to text); Hold to talk with the microphone in its screen was not tried on either, nor a release build of it, nor two apps side by side in daily use.

- The app on a real phone beyond the natural voice: the debug APK was installed on the Galaxy A16 5G (2026-11-15) and its voice lab run there; nothing else was tried on it, and the Pixel on GrapheneOS has not had it.
- Camera and microphone permission prompts, the camera capture and Hold to talk inside the web view.
- Take a photo inside the app on a phone: whether the Android web view offers ImageCapture and what size of still it gives, the still's turn when the phone is held sideways (a still turned against the screen is dropped for the frame the screen showed), the front camera, turning between cameras, memory on the Galaxy A16 with a full size still, and Share unseen opened again after Android stops the app during the gallery picker. Only Chrome's fake camera has run it.
- The status and navigation bars on a phone: only the page's calls to ForgeBars and the JVM rules are tested. The app's theme stays a light AppCompat theme (so the web view's colour scheme is unchanged), so Follow the phone setting may not see a dark phone inside the app.
- Hold to talk heard by the phone's recogniser: only its availability was checked on the two phones (2026-11-15, debug `forge.speechCheck`: the A16 offers it for `en-US`, the GrapheneOS Pixel has none); nothing was recorded or heard on a phone.
- A photo shared in from Signal or another app, and the share sheet and save screen on a phone.
- The release-signed APK (the script was run only up to its keystore checks) and installing it from `/download`.
- The app talking to `https://ai.forge-reserve.com` or a sealed Bellows.
- Links to Lightning and Bitcoin wallets from Add funds (Capacitor hands them to Android).
