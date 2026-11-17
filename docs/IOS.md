# The iPhone app

Status: first pass, 2026-11-16. Built and walked in the iOS Simulator (iPhone 17, iOS 26.5) only. It has not been on a real iPhone.

Forge for iPhone is the v2 web app in a Capacitor shell (`ios/`, Capacitor 6.2.3, the same as `android/`). The app's files are inside the app: it loads no code from the network. It talks only to its engine, `https://ai.forge-reserve.com` until the person sets another in **More, Server**.

- Name **Forge**, bundle id `com.forgereserve.ai`, iPhone only, iOS 16.4 and up, portrait.
- The same web bundle as the APK (`scripts/lib/android-web.ts`): the v2 app, what it imports, the icons and the natural voice (Phonon 31m and its voices, 65 MB), so answers are read aloud offline from the first open. The app is about 93 MB.
- One flavour: the universal app. There is no Forge Private Voice for iPhone.
- No analytics, no tracking, no third-party SDK. Its own native code is ForgeBars and ForgeNfc (below).

## What the iPhone app does in place of the Android app's plugins

The page sees Capacitor's bridge with `getPlatform()` `ios` (`public/v2/core/native.js`). ForgeBars and ForgeNfc are there; every other part is `null`, so the page does what it does in Safari on an iPhone.

| Android feature (plugin) | iPhone app |
|---|---|
| Status and navigation bars (ForgeBars) | Native: `BarsPlugin.swift` sets the status bar text, light on Midnight, Dark and the first run, dark on Light (the Android rule, BarRules.kt). The page draws under the status bar and the home indicator itself (`viewport-fit=cover`, `env(safe-area-inset-*)`). |
| Share out and Save (ForgeShare) | Web: `navigator.share` with the photo file (the iOS share sheet), as in Safari. Saving to Photos needs `NSPhotoLibraryAddUsageDescription`, which is set. |
| Photos shared in (ForgeShareIn) | Not available: there is no share extension yet. |
| Event links, `/j#<pass>` (ForgeJoin) | Not in the app: on an iPhone `/j` opens the web app in Safari (`/v2/#join=<pass>`), as before. No Universal Links yet. |
| Card taps, Cashu eCash cards (ForgeNfc) | Native: `NfcPlugin.swift`, below. Tap a card is listed and works as on Android, a press then a tap on iOS's NFC sheet. |
| Fedimint cards and the till (ForgeTill) | Hidden: there is no till plugin yet. The row is left out where a phone reads cards but has no till (`modules/fund/fedimint`). |
| Natural voice, native (ForgeVoice) | Web: the browser's build of the same voice, from the app's own files: on the graphics chip where WebKit has WebGPU, else the processor on one thread (the page is not cross-origin isolated here). Simulator (processor, one thread): RTF 0.18, no gaps. |
| Hold to talk on the phone (ForgeSpeech) | Web: the engine hears it (paid), as in Safari. **This browser** under Voice is the WebKit recogniser (Apple's), offered only with Private only off, as on the website. |
| Hold to talk, Forge Private Voice (ForgeAsr) | Not available (no second app). |
| Back button | iPhones have none: every screen has its own Back. |
| Cross-origin isolation (MainActivity) | Not done: WKWebView gets no isolation headers from Capacitor, so the page never reloads for it and the voice runs on one thread. |

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

Xcode writes the team into `project.pbxproj` (`DEVELOPMENT_TEAM`). Do not commit that line; `test/unit/ios.test.ts` keeps it empty. For TestFlight: Product, Archive, then Distribute App.

Card taps need the **NFC Tag Reading** capability on the App ID `com.forgereserve.ai` in the team (Certificates, Identifiers & Profiles, Identifiers, the App ID, Capabilities). With automatic signing Xcode turns it on when it makes the profile, because the entitlements file asks for it; a profile made by hand must be made again after the capability is on.

## Permissions

`ios/App/App/Info.plist`, each asked for only when it is first used:

- Camera: "Forge uses the camera to read a code, or to take a photo when you ask it to."
- Microphone: "Forge uses the microphone to record a question you speak."
- Speech recognition: "If you pick the phone's speech recognition in Voice, Apple turns a question you speak into words."
- Adding to Photos: "Forge saves a photo to your library only when you pick Save."
- NFC: "Forge reads an eCash card only when you hold it to the phone to add money." iOS shows no prompt for it: the NFC sheet itself is the permission.

Capacitor grants the web view's own camera and microphone prompt once iOS has, so the person sees one prompt, not two.

## Checked in the Simulator (2026-11-16)

Driven with Maestro (taps through the web view's accessibility tree) and, for checks inside the page, a probe put into the installed copy of the app only (never the repository). Seen working: the first run, steps 1 to 4, and its Start free sheet with the keyboard; the home; Type with the keyboard (the visible-height handling in `core/viewport.js` works in WKWebView); More and every screen under it; Funds; Add money and its ways; the camera preview on Scan a note (the Simulator's test feed); the status bar text dark on Light and light on Midnight; safe areas top and bottom on every screen seen; read-only requests to `https://ai.forge-reserve.com` (models and ways to pay) from `capacitor://localhost`; a secure context with `crypto.subtle`; the natural voice loaded from the app's files and played through Web Audio after a tap; the phone's voice (Listen).

Web Audio plays in the app even without a tap (Capacitor lets media play without a gesture), so the Safari unlock path is kept and harmless.

## Checked in the Simulator for card taps (2026-11-16)

On a new iPhone 17 simulator (iOS 26.5): the app built (Debug, signed to run locally, with the NFC entitlement in its simulated entitlements) and started. With Capacitor's logging turned on in the installed copy only, and a probe in the installed copy only: `Capacitor.Plugins` has ForgeBars and ForgeNfc, `status` answers `{available: false, enabled: false}`, `start` refuses with `no_nfc`, `transceive` refuses a card that is not there with `tag_gone` and a misframed command with `bad_apdu`, `close` and `stop` resolve. With the plain app, driven with Maestro: Add money lists the card with its privacy badge, not the one that points to the app, Tap a card says "This phone cannot read cards." after one `status` call and no `start`, with no error, and the More card has no Fedimint card. The press then tap flow with a card is tested in Chrome against a stand-in for the plugin (`test/ui/card.ui.test.ts`, the iPhone cases).

## Not verified

- A real card tap: the Simulator has no NFC. Nothing in `NfcPlugin.swift` past `status` and the refusals has run: the sheet, a card's connection, a command, the 5 second limit, a card lost mid-command, the sheet's words.
- Anything on a real iPhone: signing, the permission prompts, the camera reading a real code, Hold to talk with a real microphone, the ring switch and `navigator.audioSession`, the share sheet and Save to Photos, screen sizes other than the iPhone 17's.
- Paid requests, funding, Start free with a code: not run against the production engine.
- WebKit's own speech recogniser on a phone: in the Simulator it started and stopped without error.
- Dark look (only Midnight and Light were looked at).
