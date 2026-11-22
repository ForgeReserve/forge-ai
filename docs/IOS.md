# The iPhone app

Status: first pass, 2026-11-16. Built and walked in the iOS Simulator (iPhone 17, iOS 26.5) only. It has not been on a real iPhone.

Forge for iPhone is the v2 web app in a Capacitor shell (`ios/`, Capacitor 6.2.3, the same as `android/`). The app's files are inside the app: it loads no code from the network. It talks only to its engine, `https://ai.forge-reserve.com` until the person sets another in **More, Server**.

- Name **Forge**, bundle id `com.forgereserve.ai`, iPhone only, iOS 16.4 and up, portrait.
- The same web bundle as the APK (`scripts/lib/android-web.ts`): the v2 app, what it imports, the icons and the natural voice (Phonon 31m and its voices, 65 MB), so answers are read aloud offline from the first open. The app is about 93 MB.
- One flavour: the universal app. There is no Forge Private Voice for iPhone.
- No analytics, no tracking, no third-party SDK. Its own native code is ForgeBars, ForgeNfc, ForgeSpeech and ForgeShare's Save (below).

## What the iPhone app does in place of the Android app's plugins

The page sees Capacitor's bridge with `getPlatform()` `ios` (`public/v2/core/native.js`). ForgeBars, ForgeNfc, ForgeSpeech and ForgeShare (Save only) are there; every other part is `null`, so the page does what it does in Safari on an iPhone.

| Android feature (plugin) | iPhone app |
|---|---|
| Status and navigation bars (ForgeBars) | Native: `BarsPlugin.swift` sets the status bar text, light on Midnight, Dark and the first run, dark on Light (the Android rule, BarRules.kt). The page draws under the status bar and the home indicator itself (`viewport-fit=cover`, `env(safe-area-inset-*)`). |
| Share out and Save (ForgeShare) | Share: web, `navigator.share` with the photo file (the iOS share sheet), as in Safari. Save: native, `SharePlugin.swift` puts the photo into Photos (Save to Photos, below). |
| Photos shared in (ForgeShareIn) | Not available: there is no share extension yet. |
| Event links, `/j#<pass>` (ForgeJoin) | Not in the app: on an iPhone `/j` opens the web app in Safari (`/v2/#join=<pass>`), as before. No Universal Links yet. |
| Card taps, Cashu eCash cards (ForgeNfc) | Native: `NfcPlugin.swift`, below. Tap a card is listed and works as on Android, a press then a tap on iOS's NFC sheet. |
| Fedimint cards and the till (ForgeTill) | Hidden: there is no till plugin yet. The row is left out where a phone reads cards but has no till (`modules/fund/fedimint`). |
| Natural voice, native (ForgeVoice) | Web: the browser's build of the same voice, from the app's own files: on the graphics chip where WebKit has WebGPU, else the processor on one thread (the page is not cross-origin isolated here). Simulator (processor, one thread): RTF 0.18, no gaps. |
| Hold to talk on the phone (ForgeSpeech) | Native: `SpeechPlugin.swift`, below. Where Apple's recogniser hears the language on the phone itself, On this phone is offered and chosen by default, free, and the sound never leaves the phone. Elsewhere the engine hears it (paid), as in Safari. Where Apple's recogniser hears nothing in two presses in a row while the level shows sound, the app asks before the voice goes online, as on Android (docs/VOICE.md, When the phone hears nothing). **This browser** under Voice is the WebKit recogniser (Apple's, which may send the sound to Apple), offered only with Private only off, as on the website. |
| Hold to talk, Forge Private Voice (ForgeAsr) | Not available (no second app). |
| Back button | iPhones have none: every screen has its own Back. |
| Cross-origin isolation (MainActivity) | Not done: WKWebView gets no isolation headers from Capacitor, so the page never reloads for it and the voice runs on one thread. |

## Getting the app

There is no iPhone app to download yet: no TestFlight link and no App Store page. Until there is, the web app in Safari is Forge on an iPhone, and nothing on an iPhone or iPad offers the Android page or its APK (`public/v2/core/getapp.js`, the same tests as the Classic app's `isIOS` and standalone check in `public/app.js`).

- **Tap a Cashu card**, on the website: in place of Get the app, the Home Screen steps: one line, *Put Forge on your Home Screen.*, then Safari's two buttons as icons with their words, **Share** and **Add to Home Screen**. Opened from the Home Screen already (`navigator.standalone`, or `display-mode: standalone`): no steps and no button.
- **Tap a Fedimint card**: no button and no steps, as the iPhone app has no till either.
- **`/download`** (also `/j` with no pass): **Download**, the button opens Forge in the browser (`/v2/` first, so what goes on the Home Screen is Forge itself) and the same steps play under it as pictures; in the row of ways, the iPhone says Soon while there is no link. An APK, Google Play or any other Android way is never offered to an iPhone.
- `/j#<pass>` opens the web app on the pass, as before.

`public/v2/index.html` has what Safari reads when Forge is put on the Home Screen: the web app manifest (`/v2/manifest.webmanifest`, standalone), `apple-mobile-web-app-capable`, the name **Forge AI** (`apple-mobile-web-app-title`) and the 180 by 180 icon (`/icons/apple-touch-icon.png`).

Once there is an app to give, set **`FORGE_IOS_URL`** on the gateway to its TestFlight invitation or its App Store page (https only; the gateway does not start with another link). `/download/info` then carries it as `ios: {available: true, url}`, and on an iPhone or iPad, in Safari or from the Home Screen, Get the app on the Cashu card opens that link in place of the steps, and the `/download` page picks the iPhone first: its button opens that link (named TestFlight or App Store by the link's host), and the browser is the other way in the row. Unset by default. Android and computers keep the `/download` page and its APKs ([ANDROID.md](ANDROID.md)); there the iPhone is one of the ways in the row, Soon until the link is set. Inside the apps Get the app never shows. The App Store listing's privacy policy is `https://ai.forge-reserve.com/privacy` ([PRIVACY.md](PRIVACY.md)).

## Card taps (ForgeNfc)

`ios/App/App/NfcPlugin.swift` is the Android plugin (`NfcPlugin.kt`) in Swift with CoreNFC: the same name, ForgeNfc, the same methods (`status`, `start`, `transceive`, `close`, `stop`), the same `card` event `{id, isoDep}`, the same answers and error codes (`no_nfc`, `bad_apdu`, `tag_gone`, `tag_lost`). It is a bridge for bytes: the page builds every command (`public/v2/core/card/`), the plugin checks each is one well formed short APDU (`NfcRules.swift`, as `NfcRules.kt`), gives each command 5 seconds on the card, and hands back the card's whole answer with its status word. Each card is numbered, and a command for a card that has gone, or for an earlier one, is refused. Nothing from a card is stored or logged.

What iOS changes, and how the page follows it:

- The phone reads only while iOS's own NFC sheet is up, and the sheet opens only when the app asks. Android keeps reading for as long as Tap a card is open; an iPhone cannot. So each step with the card is a press, then a tap: opening Tap a card opens the sheet for the read, and Move (or Finish) opens it again for the payment. Once the page is done with the card, the sheet closes (`close`), so the person can type the PIN and the amount. Wherever the screen waits for the card it has **Scan the card**, which opens the sheet again.
- The sheet's words come from the page (`fund.card.sheet*` in `strings/en.js`): "Hold the card to the top of the back of your iPhone.", "Keep the card there." once the card is connected, "Done. You can take the card away." when it closes, "The card moved away. Scan it again in Forge." when the card is lost, "Not an eCash card." for a tag without the card's applet, and "Hold one card at a time."
- One sheet at a time: a second `start` while one is up keeps it. iOS ends a sheet after about a minute (the `NFCNDEFReaderSession` header gives 60 seconds), when the person taps Cancel, or when the system ends it; the screen then waits with Scan the card. A card lost mid-command, or a command over 5 seconds, ends the sheet with the lost words, and the page asks for the card again, as on Android.
- `status` is `NFCTagReaderSession.readingAvailable` for both `available` and `enabled`: false on an iPhone that cannot read tags and in the Simulator, and Tap a card then says "This phone cannot read cards.", as on an Android phone without NFC. An iPhone has no switch for NFC alone, so there is no "NFC is off".
- iOS selects the card's applet itself before it hands the card over, and refuses any SELECT of an application it was not told about. `Info.plist` lists the AIDs the page selects (`public/v2/core/card/apdu.js`), the applet first: `F043415348554341524401` (the 2.0 applet), `F0434153485543415244` (the package, tried after a 6A82), and the old applets the page names only to say a card needs an update: `D2760000850102`, `D276000085010201`, `F0464F585943415244`. Not `D2760000850101`, the NDEF application.
- `App/App.entitlements` holds `com.apple.developer.nfc.readersession.formats` with `TAG`, wired to the App target (`CODE_SIGN_ENTITLEMENTS`). `NFCReaderUsageDescription`: "Forge reads an eCash card only when you hold it to the phone to add money."

`NfcRules.swift` has unit tests, `ios/App/AppTests` (a test bundle with no host app):

```sh
cd ios/App
xcodebuild test -workspace App.xcworkspace -scheme AppTests -destination 'name=<a simulator>'
```

## Save to Photos (ForgeShare)

In Share unseen, **Save** puts the clean photo into the Photos library. A web download does not work here: WKWebView drops it without a word, so the app said "Saved" while nothing was saved. `ios/App/App/SharePlugin.swift` is ForgeShare with one method, `save` (Android's ForgeShare also has `share` and `forget`; the share sheet here is the web view's own, and the app writes no files).

- `save({name, mime, data})` takes the file the page made (`public/v2/core/photo.js` `makeFile`), in base64, in that one call. That is safe here: the Photos prompt does not send the app to the background, and Capacitor on iOS keeps no plugin call in any saved state, so the size limit that made the Android app stage the photo first (ANDROID.md, Share out and Save) does not apply. It asks for add-only access (`PHPhotoLibrary.requestAuthorization(for: .addOnly)`): Forge can add a photo and never sees the library. iOS asks once, with the words of `NSPhotoLibraryAddUsageDescription`.
- The file goes in as its exact bytes (`PHAssetCreationRequest` `addResource(with: .photo, data:)`): the app does not decode it, encode it again or add anything to it. Photos names it `photo.jpg`. Photos itself writes a small Exif block into the file it keeps: in the Simulator (iOS 26.5) the picture data was the same, byte for byte, and in front of it Photos put the size, resolution, colour space and Exif version, with no time, place or device.
- It resolves `{saved: true}` only once Photos says the change is done. It rejects with `denied` (the person said no, or it is restricted), `save_failed`, `bad_type` (not a JPEG or PNG) or `bad_file`. Nothing is written anywhere else or logged.
- The page (`core/native.js`, used when `Capacitor.Plugins` lists ForgeShare) says **Saved to Photos** only after that answer. A refusal says "Not saved. Forge may not add to Photos. Allow it in Settings, or tap Share."; a failure says "Not saved. Try again, or tap Share.", in the red line above the buttons. An app built before ForgeShare keeps the web download.
- `test/unit/ios.test.ts` checks the source (add-only, the bytes as they are, no image encoding, the codes); `test/unit/v2/native.test.ts` and `test/ui/photo.ui.test.ts` check the page against a stand-in for the plugin: saved, refused, failed.

## Hold to talk on the phone (ForgeSpeech)

`ios/App/App/SpeechPlugin.swift` is the Android plugin (`SpeechPlugin.kt`) in Swift with Apple's Speech framework: the same name, ForgeSpeech, the same methods (`available`, `start`, `stop`, `cancel`), the same `speech` event `{id, type}` with `started`, `level {level}`, `partial {text}`, `final {text}`, `error {code}` and `end` (always last), and the same codes (`permission`, `busy`, `unavailable` from `start`; `permission`, `unavailable`, `no-speech`, `busy`, `audio`, `failure`, `interrupted` in `error`). The page's module (`voice-in/phone`) and the choice (`pickVoiceIn`) are unchanged. The pure parts are in `SpeechRules.swift`, with `SpeechSession` ported from the Kotlin one.

**How the sound stays on the phone.** Apple's recogniser can hear a language on the phone, or send the sound to Apple's servers. The plugin uses only the first:

- Every request is an `SFSpeechAudioBufferRecognitionRequest` with `requiresOnDeviceRecognition = true`. Apple's documentation and the SDK header say a request "only honors this setting if" the recogniser's `supportsOnDeviceRecognition` is also true. So before every request (the first, and each one after a pause) the plugin checks `SpeechRules.onDeviceOnly`: the recogniser must say `supportsOnDeviceRecognition` and the request must require the phone, else no request is made and the page is told `unavailable`. The plugin never sets `supportsOnDeviceRecognition` (the SDK lets an app set it), never makes any other kind of request, and writes nothing to storage.
- `available` offers On this phone only where a recogniser for the language says `supportsOnDeviceRecognition` and `isAvailable`. Where Apple hears the language only on its servers, it says `language-not-on-device` (Android's `language-not-downloaded`), and the app uses the engine as it does today.
- `test/unit/ios.test.ts` checks the source: one place makes a request, it sets `requiresOnDeviceRecognition = true`, the guard comes before the task, and nothing assigns `supportsOnDeviceRecognition`. `SpeechRulesTests.swift` tests the guard.
- What it depends on: Apple keeping its word that a request with `requiresOnDeviceRecognition` does not send audio over the network, and `supportsOnDeviceRecognition` telling the truth. Neither can be checked from the app. The device test below (airplane mode) is the practical check.
- This browser under Voice is WebKit's recogniser, not this plugin: it may send the sound to Apple, so it is never private and is off with Private only on.

**Languages.** The page asks in the phone's English (`en-GB`, `en-IN`, ...) or else `en-US`. The plugin takes Apple's list (`SFSpeechRecognizer.supportedLocales()`) and tries the same tag, then US English, then the language's other regions, never another language, and listens with the first that hears on the phone. A recogniser that falls back to the keyboard's language is not used. Which languages an iPhone hears on the phone depends on the phone and on what it has downloaded; Apple publishes no list for on-device recognition, and none was confirmed on a real iPhone. In a new Simulator (iOS 26.5) Apple first heard none on the device: `en-US`, `en-GB`, `en-JM` and `de-DE` all said `language-not-on-device`. About 12 minutes later the same Simulator said `en-US` is heard on the device (`en-GB` and `en-JM` then listen in `en-US`), while `de-DE`, `fr-FR` and `ja-JP` still said `language-not-on-device`. Most likely the Simulator fetched Apple's on-device English after the first use; that is not proven. The page asks once when the app opens, so a language that arrives later is offered from the next open. To check a language on an iPhone, open More, Voice: On this phone is listed only when Apple's recogniser hears the language on the phone. The availability line (`ForgeSpeech: available locale=... onDevice=... reason=...`) is printed to Xcode's console when Capacitor's logging is on (`loggingBehavior` in the installed copy's `capacitor.config.json`); it never holds words.

Other reasons `available` gives: `recognizer-unavailable` (it hears on the phone but cannot take a request now, `isAvailable` false), `language-not-supported` (no locale of the language at all).

**Permissions.** `start` asks for speech recognition (`SFSpeechRecognizer.requestAuthorization`, the first prompt), then the microphone (the second; `AVAudioApplication` from iOS 17, `AVAudioSession` before). A refusal of either rejects `start` with `permission`, as Android does for the microphone, and the talk button says to allow the microphone. `available` asks for nothing, so no prompt shows until the first press.

**Audio.** The microphone is captured with `AVAudioEngine`; its sound goes only to the request, in memory. For the press only, the audio session is set to `playAndRecord`, mode `measurement` (the least of the system's own processing, the primary microphone), with `duckOthers` (other apps' sound is lowered, not stopped, and the session is mixable, so the web view's own sound is not interrupted) and `defaultToSpeaker`. What was set before is kept. When the press ends the session is let go with `notifyOthersOnDeactivation` (ducking ends, other apps may play again) and the category and mode go back to what they were, so reading the answer aloud afterwards (Web Audio and the phone's voice in the web view) is as before. A call or an alarm that takes the audio (`interruptionNotification`), and leaving the app, end the press with `interrupted` and nothing is asked, as Android's leaving does. Headphones in or out mid-press end that request with its words kept, and the next one listens on the new input. A second `start` while one is open is refused with `busy`; `stop` and `cancel` with nothing running resolve and do nothing.

**Live words and limits.** Words come as `partial` while the button is held, and once after `stop` as `final`. Apple can end a request on its own (a long pause, its limit of about a minute for one request); while the button is held the plugin starts the next request and joins the words (`SpeechSession`, at most 20 times), so nothing heard is lost. The page stops at 60 s (`maxSeconds`), and a request starts after the press, so the page's limit comes first. After `stop`, if the last result has not come within 4 s, the words so far are the question; the plugin's own safety stop is at 90 s. A hold with nothing said ends with `error` `no-speech` (Apple's 1110, "Failed to recognize any speech", or a last result with no words), and the app says "Nothing was heard." and asks nothing. Two such presses in a row with sound on the level open the question of docs/VOICE.md (When the phone hears nothing): Go online or Keep on this phone; nothing goes online without Go online. Apple's errors map as `SpeechRules.errorCode`: 1700 `permission`, 1100 `busy`, kLSR 102, 201, 300 `unavailable` (the next question goes to the engine), kLSR 301 `interrupted`, the Speech framework's audio read error `audio`, anything else `failure`. Nothing is logged but the availability line and an error's domain and code.

### Checking it on an iPhone

Build and run on the iPhone from Xcode (Run on an iPhone, below), with Forge set to an engine with a balance or free questions.

1. Open More, Voice. **On this phone** should be listed first and chosen. If it is not, Apple does not hear the language on this phone (Online is chosen): stop here and note the phone's language and iOS version.
2. Go home and press and hold the talk button. iOS asks to allow speech recognition, with the words "Forge turns a question you speak into words on this phone. Your voice stays on it, unless you pick This browser." Allow. Then it asks for the microphone ("Forge uses the microphone only while you hold the talk button, to hear a question you speak."). Allow. Letting go to answer the prompts ends that press with "Nothing was heard."; hold again. Refusing either should make the talk button say the microphone is blocked; nothing is sent.
3. Hold and say a question. The line under the rings says "Stays on this phone", the level bars move with your voice, and your words show as you speak. A pause in the middle should not cut the question. Let go: the question shown is your words, and the answer comes. If no words show while speaking, the microphone or the recogniser failed: note it.
4. Hold for three seconds saying nothing, and let go. The app should say "Nothing was heard. Hold the button and speak." and ask nothing. If it says "Could not hear it", Apple ended with an error other than no speech: note it.
5. Turn on airplane mode (Wi-Fi off too) and ask by voice again. The words should still show while you hold: that shows the sound is heard on the phone. (The answer then fails, as the engine is out of reach.) If no words show, Apple needs the network for this language here, which the app should never use: report it.
6. Play music in another app, then hold to talk: the music should dip while you hold and come back after. Then tap Listen on an answer: it should be read aloud as before. Silence after a press means the audio session was not put back.
7. Hold to talk and have someone call the phone mid-hold. The press should end; after the call, letting go asks nothing ("Nothing was heard."), and the next hold works. Do the same with headphones plugged in or out mid-hold: the words heard so far should stay and the question should be sent.
8. Hold to talk and press the side button or go home mid-hold: back in Forge, nothing was asked, and the next hold works.

## Build and run in the Simulator

Needs Xcode (26.6 here), CocoaPods 1.17, Node 22.18 or later, and `pnpm install` at the repository root.

```sh
cd ios/App
pod install                       # once, and after a Capacitor update
xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'name=<a simulator>' \
  -derivedDataPath build/DerivedData build
xcrun simctl install <udid> build/DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch <udid> com.forgereserve.ai
```

Or open `ios/App/App.xcworkspace` in Xcode, pick a simulator and press Run. Simulator builds need no team: Xcode signs them ad hoc ("Sign to Run Locally"). Do not turn signing off with `CODE_SIGNING_ALLOWED=NO`: the app still runs, but iOS refuses to read the unsigned launch screen and shows black until the page paints.

Every build first runs the phase **Bundle the web app**: `node scripts/ios-web.ts`, which puts the natural voice's files in place (downloaded at build time when missing, pinned in `scripts/phonon/lock.json`) and copies the web bundle into `ios/App/App/public` with `capacitor.config.json`. `pnpm ios:web` does it alone. The phase looks for `node` in Homebrew's and the usual places, because Xcode runs scripts without the shell's PATH. The copied files and `Pods/` are not committed; the Xcode project, the workspace, `Podfile` and `Podfile.lock` are.

Like `android/`, the project is kept by hand. Do not run `npx cap add ios`, `cap sync` or `cap update`: they would put back the template icon, launch screen and settings.

The app is served from `capacitor://localhost`. Capacitor iOS cannot serve `https://localhost` as Android does: WKWebView does not let an app handle `https` (`server.iosScheme`, Capacitor 6 docs). The engine's `/v1/*` routes answer any origin (`src/app.ts`, CORS `*`), so nothing changes on the server. `capacitor.config.json` `ios` sets the web view's ground to Midnight `#0B0D10`, so there is no white flash before the first paint or at the edges, and Capacitor turns off the rubber-band bounce.

Icons: `scripts/icons.sh` also writes the 1024 app icon (the full-bleed anvil tile, with no alpha channel) and the launch screen's mark (`scripts/icons/ios-splash.svg`) into `ios/App/App/Assets.xcassets`. The launch screen is Midnight with the mark in the middle.

## Run on an iPhone

The repository signs nothing: the team is empty. The owner, once:

1. Open `ios/App/App.xcworkspace` in Xcode (after `pod install`).
2. Select the **App** target, **Signing & Capabilities**, keep **Automatically manage signing**, and pick the team under **Team**. The bundle id `com.forgereserve.ai` must be free in that team, or registered to it.
3. Plug in the iPhone, turn on Developer Mode on it (Settings, Privacy & Security), pick it as the run destination and press Run. The first time, trust the developer on the phone (Settings, General, VPN & Device Management).

Xcode writes the team into `project.pbxproj` (`DEVELOPMENT_TEAM`). Do not commit that line; `test/unit/ios.test.ts` keeps it empty. For TestFlight, `scripts/ios-archive.sh` (TestFlight, below).

Card taps need the **NFC Tag Reading** capability on the App ID `com.forgereserve.ai` in the team (Certificates, Identifiers & Profiles, Identifiers, the App ID, Capabilities). With automatic signing Xcode turns it on when it makes the profile, because the entitlements file asks for it; a profile made by hand must be made again after the capability is on.

## Permissions

`ios/App/App/Info.plist`, each asked for only when it is first used:

- Camera: "Forge uses the camera to read a code, or to take a photo when you ask it to."
- Microphone: "Forge uses the microphone only while you hold the talk button, to hear a question you speak."
- Speech recognition: "Forge turns a question you speak into words on this phone. Your voice stays on it, unless you pick This browser." One permission covers both recognisers: ForgeSpeech, which hears on the phone, and WebKit's This browser in Voice, which may send the sound to Apple. It speaks of the recognisers only: a recording the app sends to the engine (Online, picked, or chosen by the app after Apple's recogniser heard nothing in two presses in a row while there was sound, docs/VOICE.md) uses the microphone's permission, and the app says so on the answer screen and in More, Voice.
- Adding to Photos: "Forge saves a photo to your library only when you pick Save." Asked the first time Save is tapped in Share unseen (ForgeShare), for add-only access.
- NFC: "Forge reads an eCash card only when you hold it to the phone to add money." iOS shows no prompt for it: the NFC sheet itself is the permission.

Capacitor grants the web view's own camera and microphone prompt once iOS has, so the person sees one prompt, not two.

## TestFlight

Status: 2026-11-21, a Release archive was made and an App Store IPA exported from it (68 MB, version 0.1.0, build 1), signed with the team's Apple Distribution certificate and a named App Store profile. Nothing has been uploaded.

**Privacy manifest.** `ios/App/App/PrivacyInfo.xcprivacy` is in the App target's resources and lands at the root of the app. Capacitor and CapacitorCordova carry their own (`Capacitor.framework`, `Cordova.framework`), with no tracking, no data and no required reason API. The app's says:

- No tracking, and no tracking domains.
- No required reason API. The app's Swift calls none of them (UserDefaults, file timestamps, disk space, system boot time, active keyboards); the built app imports none of their symbols, and Capacitor's pods call none either. The web app's storage (IndexedDB, `localStorage`, Cache Storage) is WebKit's, kept by WebKit's own processes. `test/unit/ios.test.ts` fails when a Swift file uses one of those APIs, so it gets declared with its reason.
- Two kinds of data the engine keeps ([PRIVACY.md](PRIVACY.md)), both for the app to work, neither for tracking, and neither linked to a person: **purchase history** (a balance's top-ups, charges and payouts) and **product interaction** (a metering row per request: model, token counts, cost, time). A balance is a random key: the engine has no name, email, phone number or device id for it. Questions, answers, photos and recordings pass through the engine in memory and are never kept, so they are not listed. The answers given in App Store Connect, App Privacy, should match the manifest.

**Building it.** `scripts/ios-archive.sh --team <team id>` (or `FORGE_IOS_TEAM`) bundles the web app (`pnpm -s ios:web`), runs `pod install`, makes a Release archive for any iPhone (`generic/platform=iOS`) with automatic signing and `-allowProvisioningUpdates`, and exports it with method `app-store-connect` and destination `export`: an IPA in a folder. It prints the IPA's path, size, version and build number. It uploads nothing. The team id goes to xcodebuild for that run only; if xcodebuild changes `project.pbxproj`, the script puts it back. Output goes to `dist/ios` (git ignores `dist`) or `--out`, which must be outside the repository or in `dist/`.

The export needs an Apple account of the team in Xcode (Settings, Accounts), so Xcode can make the App Store profile for `com.forgereserve.ai` with the NFC Tag Reading capability. Without one it stops with `No Accounts` and `No profiles for 'com.forgereserve.ai' were found`, after the archive is made. On a Mac with no account in Xcode, give an App Store Connect API key of the team: `--key <file.p8> --key-id <id> --issuer <id>` (or `FORGE_ASC_KEY`, `FORGE_ASC_KEY_ID`, `FORGE_ASC_ISSUER`). The key file stays outside this repository and goes to xcodebuild by path; the script never reads it. Where the key may not sign in the cloud (`Cloud signing permission error`), make an App Store provisioning profile for the App ID with the team's Apple Distribution certificate, install it on the Mac, and name it: `--profile "<profile name>"` (or `FORGE_IOS_PROFILE`). The export then signs with that profile and the Apple Distribution certificate in the keychain.

**What the owner does in App Store Connect.**

1. Make the app record: name, bundle id `com.forgereserve.ai`, SKU, primary language.
2. App Privacy: answer the data questions to match the manifest above.
3. Raise `CURRENT_PROJECT_VERSION` (both configurations) before each upload after the first: App Store Connect refuses a build number it has seen for the version.
4. Upload the IPA with Transporter, or the archive with Xcode's Organizer (Distribute App).
5. Answer the export compliance question for the build. The owner answered it for build 1 (no non-exempt encryption), and `Info.plist` now carries that answer (`ITSAppUsesNonExemptEncryption` false), so later builds are not asked. What it uses: HTTPS (TLS) through iOS; in the web app, HPKE (DHKEM X25519 with HKDF-SHA256 and AES-256-GCM, in JavaScript from Tinfoil's SDK and the noble libraries) to encrypt questions and answers to private models' attested enclaves; ECDSA and Sigstore checks of the enclave's attestation; Cashu's blind signatures, DLEQ proofs and Schnorr signatures on secp256k1; SHA-256 and HMAC-SHA256. The Swift code has no cryptography of its own.
6. TestFlight: add testers. Internal testers can install once the build has processed; external testers need Beta App Review first.

**Checked for upload (2026-11-21, Xcode 26.6, iOS 26.5 SDK):** the 1024 icon is opaque RGB; the built app's Info.plist has the version 0.1.0 and build 1 from the project, `UIRequiredDeviceCapabilities` `arm64` only (NFC is not required: a phone without it says it cannot read cards), portrait only, iPhone only, the launch storyboard, and a usage description for each permission the code asks for (camera, microphone, speech recognition, adding to Photos, NFC); the signed app's entitlements are NFC `TAG` only, with the AIDs in Info.plist; no setting turns on bitcode (Xcode 26 has none); the archive has dSYMs for the app and both frameworks. Not checked: App Store Connect's own validation, which runs on upload, and the distribution signing.

## Checked in the Simulator (2026-11-16)

Driven with Maestro (taps through the web view's accessibility tree) and, for checks inside the page, a probe put into the installed copy of the app only (never the repository). Seen working: the first run, steps 1 to 4, and its Start free sheet with the keyboard; the home; Type with the keyboard (the visible-height handling in `core/viewport.js` works in WKWebView); More and every screen under it; Funds; Add money and its ways; the camera preview on Scan a note (the Simulator's test feed); the status bar text dark on Light and light on Midnight; safe areas top and bottom on every screen seen; read-only requests to `https://ai.forge-reserve.com` (models and ways to pay) from `capacitor://localhost`; a secure context with `crypto.subtle`; the natural voice loaded from the app's files and played through Web Audio after a tap; the phone's voice (Listen).

Web Audio plays in the app even without a tap (Capacitor lets media play without a gesture), so the Safari unlock path is kept and harmless.

## Checked in the Simulator for card taps (2026-11-16)

On a new iPhone 17 simulator (iOS 26.5): the app built (Debug, signed to run locally, with the NFC entitlement in its simulated entitlements) and started. With Capacitor's logging turned on in the installed copy only, and a probe in the installed copy only: `Capacitor.Plugins` has ForgeBars and ForgeNfc, `status` answers `{available: false, enabled: false}`, `start` refuses with `no_nfc`, `transceive` refuses a card that is not there with `tag_gone` and a misframed command with `bad_apdu`, `close` and `stop` resolve. With the plain app, driven with Maestro: Add money lists the card with its privacy badge, not the one that points to the app, Tap a card says "This phone cannot read cards." after one `status` call and no `start`, with no error, and the More card has no Fedimint card. The press then tap flow with a card is tested in Chrome against a stand-in for the plugin (`test/ui/card.ui.test.ts`, the iPhone cases).

## Checked in the Simulator for Hold to talk (2026-11-17)

On a new iPhone 17 simulator, "Forge Speech" (iOS 26.5): the app built (Debug, signed to run locally) and started. With Capacitor's logging and a probe in an installed copy only: `Capacitor.Plugins` has ForgeBars, ForgeNfc and ForgeSpeech; `available` first answered `{onDevice: false, reason: "language-not-on-device"}` for `en-US`, `en-GB`, `en-JM` and `de-DE`; `stop` and `cancel` with nothing running resolve; `start` with no id refuses with `bad_call`. With the plain app, driven with Maestro: the first run and the home show no error, and More, Voice listed Online (the engine, chosen) and This browser (off with Private only on), with no On this phone row: the fallback, with no error. About 12 minutes later, on the same Simulator, `available` said `onDevice: true` for `en-US` (and for `en-GB` and `en-JM`, listening in `en-US`), still no for `de-DE`, `fr-FR` and `ja-JP`, and More, Voice then listed **On this phone** first and chosen, with Private only on. No permission prompt showed (`available` asks for none). A press was not tried: it would need the two permission prompts answered in the Simulator, and the Mac's own microphone permission for the Simulator, which this check does not answer for the owner. `SpeechRulesTests.swift` passes in the test bundle.

## Share unseen in the Simulator (2026-11-17)

On an iPhone 17 simulator (iOS 26.5), with a probe in the installed copy only that feeds `test/unit/fixtures/photos/crew.jpg` through the page's file input: the face check finds the three faces, on the graphics chip (TensorFlow.js WebGL 2). The first check after the app opens takes about 8 seconds (loading the detector and building its shaders), the next ones well under a second; on the processor alone the five passes over a 2048 px photo take about 3 seconds. Before the fix the face check failed with `TypeError: Load failed`: face-api's `loadFromUri` turned `capacitor://localhost/vendor/face-api/model/` into `capacitor:/localhost/...` (`docs/modules/filter.md`, Platforms).

A swipe that was not quite straight moved a screen's scrolling part 10 px to the left and left it there (seen on Share unseen; History had the same overflow): an info button sits 10 px past the edge of its line. Measured in the Simulator with Maestro swipes, before and after the fix in `style.css` (`.scroll`).

### Hold to talk in Safari on an iPhone

Safari (and the app, where Apple's recogniser does not hear the language on the phone) records through the page: the engine's speech to text, paid, with the page's own microphone code (docs/APP.md, Hold to talk). This was never tried with a real iPhone microphone. Before the 2026-11-21 change every hold in iPhone Safari ended "Nothing was heard." with flat level bars and no request sent; the page now makes its recording context inside the press, records with an AudioWorklet, and tells a microphone that gives no sound apart from silence. On a current iPhone after that change (2026-11-21) the capture ran (worklet, context running, 20 pieces at 44.1 kHz from the iPhone Microphone) but a normal voice arrived at a level of 0.024 with a loudest sample of 0.026, about a quarter of what the old rule needed, so it still ended "Nothing was heard." That was with echo cancelling off: WebKit then records through Apple's plain RemoteIO unit, with no voice processing and so no automatic gain (WebKit 258428@main), and it offers no autoGainControl of its own. An iPhone now asks with echo cancelling on (Apple's voice processing, with its gain), opening once more with it off only if that gives pure zeros or nothing; a quiet voice is also judged by the clip's own shape, and the clip is made louder before it is sent (docs/APP.md, Hold to talk). Check it on the phone three ways: with no headphones ever connected since Safari opened the page, with wired headphones connected and then unplugged just before the press (how the owner first met the bug, 2026-11-21: iOS interrupts and re-routes the audio on unplug), and with AirPods or other Bluetooth headphones connected:

1. Open the website's `/v2/` in Safari with a balance or free voice questions, Private only off or a private speech to text model on the engine. More, Voice: **Online** is chosen under When you talk.
2. Go home and tap the talk button once, quickly. Safari asks to use the microphone: Allow. The app should then say "Microphone on. Hold the button and speak." (If a hold was under way when the sheet came, it says "Cancelled." first. Nothing is sent either way.)
3. Hold and say a question for about three seconds. The level bars should move with your voice. Let go: the question shows as your words and the answer comes.
4. Open More, Voice and read **Last recording** at the bottom: Build should be eight characters and nothing more (`saved copy (offline)` means the page opened from the phone's kept copy because the network gave nothing; `newer one ready: reload` means the page still runs the build before the last deploy: reload and start again); Echo cancelling should read `asked yes, got yes`; Applied gives what WebKit says it applied (`gain ?, noise ?` is expected: WebKit does not report them); Heard should be `voice (sent)` (the loud rule) or `a quiet voice (sent)` (the clip's own shape); Gain says how much louder the clip was sent (`x1.0` for a voice already loud, up to `x16.0`); Rule gives the clip's noise floor, the level a piece needed and its loud part; Way should be `worklet`; Sound should end with `running` (on the first hold after the page opened, `running, made again` is expected: the context made in the press could not start, so one was made once the microphone was on); Pieces should be more than 10; Level should be over the voice level beside it; Microphone names the microphone in use; Muted `no`. Note every line if any differs. Heard says which failure it was: `no pieces` (nothing came from the microphone at all), `pieces of exact zeros` (digital silence), or `pieces below the voice level` (sound came, too quiet: compare Level and Loudest, to 4 places, with the voice level).
5. Hold for three seconds saying nothing. The app should say "Nothing was heard." In Last recording, Heard is `pieces below the voice level (quiet)` and Gain `x1.0` (nothing was sent): if a silent hold is sent instead (Heard `a quiet voice (sent)`), note the Rule line, as the quiet rule took the room for a voice; a quiet room is rarely exact zeros, so `pieces of exact zeros` here most likely means the microphone gave digital silence (note whether Echo cancelling says `opened again`).
6. Connect the Bluetooth headphones and do 3 and 4 again. Microphone should name the headphones. If the app says "No sound from the microphone.", note Way, Sound, Pieces, Loudest seen and Echo cancelling: Loudest seen above 0 with Pieces 0 means the capture never fired; both 0 with Sound not ending in `running` means the context never ran. Hold again once: the microphone is opened afresh.
7. If Echo cancelling says `asked no, got no, opened again` (or `asked yes` after an earlier retry), the recording gave pure zeros or nothing with echo cancelling on and was opened a second time with it off: note whether that question was heard, and whether later holds are heard.
8. Lock the phone mid-hold, come back, and hold again: the next hold should be heard.
9. Close the Safari tab, open the page again, and do not connect anything. Connect wired headphones, wait a few seconds, unplug them, and at once hold and say a question. The question should be heard. In Last recording, Microphone should name the iPhone's own microphone, and Sound should end with `running`. If it says "No sound from the microphone.", note every line, then hold once more: that press starts on a new context and should be heard.
10. Plug the wired headphones in during a hold, and let go. That question may or may not be heard; Last recording's Microphone then ends with `, changed`. The next hold should be heard, through the headphones' microphone if they have one.

A long press on a control selected its words and brought up Copy, Look Up and Translate (Add, Photo). The interface's words are not selectable now, on every platform (`style.css`, "What a person can select"); an answer, the question asked, `.mono` lines and fields still are. In the Simulator: a long press on Add, Photo selects nothing; the Type field takes typing, a caret and a paste from the edit menu; answer text selects a word with the Copy menu.

## Not verified

- TestFlight: the App Store IPA export, its distribution signing, the upload and App Store Connect's checks on it (TestFlight, above). Only the Release archive, signed for development, was made.
- A real card tap: the Simulator has no NFC. Nothing in `NfcPlugin.swift` past `status` and the refusals has run: the sheet, a card's connection, a command, the 5 second limit, a card lost mid-command, the sheet's words.
- Hold to talk on the phone (ForgeSpeech) past `available` and the refusals: no request has run, so the permission prompts, live words, the joining after a pause, a silent hold on a phone, Apple's error codes as they really come, the audio session's effect on playback afterwards, a call or a route change mid-hold and airplane mode are all untested (Checking it on an iPhone, above). Which languages an iPhone hears on the phone is not known.
- Hold to talk through the page on a real iPhone (Safari, or the app through the engine): seen once on a current iPhone (2026-11-21), where the capture ran and a voice was too quiet with echo cancelling off. Not yet seen: the level with echo cancelling on (Apple's gain), whether the quiet rule takes a quiet room on an iPhone for a voice or refuses a quiet voice spoken without pauses, how the engine's model hears a clip made up to 16 times louder, Bluetooth and wired headset microphones, and the retry with echo cancelling off. The recording context made in the press, its fallback, and the microphone messages ran only in tests with a stand-in Web Audio, in Chrome with its fake microphone, and in desktop WebKit (Playwright, a mock microphone), which do not follow iOS's audio rules (Hold to talk in Safari on an iPhone, above). Whether the worklet file loads from the app's `capacitor://` address is unseen; where it does not, the page records the old way.
- Anything on a real iPhone: signing, the permission prompts, the camera reading a real code, Hold to talk with a real microphone, the ring switch and `navigator.audioSession`, the share sheet and Save to Photos, screen sizes other than the iPhone 17's.
- Save to Photos (ForgeShare) on an iPhone: the add-only prompt and its words, a refusal and Allow in Settings afterwards, the photo showing in the Photos app, and what Photos writes into the file there. In the Simulator (2026-11-18, iOS 26.5, a probe in the installed copy only): with access allowed `save` resolved `{saved: true}` and the file appeared in the library; with access refused it rejected `denied` and nothing was added; a text file was refused `bad_type`. The prompt itself was not answered there.
- Take a photo inside the app (docs/APP.md, Share unseen): not run in the Simulator or on an iPhone. WKWebView has no ImageCapture, so the photo is a frame of the camera's stream at the largest picture it offers; the size iOS gives the page, the front camera and turning between the two are unseen.
- Paid requests, funding, Start free with a code: not run against the production engine.
- WebKit's own speech recogniser on a phone: in the Simulator it started and stopped without error.
- Dark look (only Midnight and Light were looked at).
- Get the app on a real iPhone or iPad: the Home Screen steps and the `FORGE_IOS_URL` link were checked in Chrome with an iPhone's user agent, and an installed web app with `navigator.standalone` set by the test. What Safari puts on the Home Screen (name, icon, opening full screen) was not tried.
