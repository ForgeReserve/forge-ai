# The iPhone app

Status: first pass, 2026-11-16. Built and walked in the iOS Simulator (iPhone 17, iOS 26.5) only. It has not been on a real iPhone.

Forge for iPhone is the v2 web app in a Capacitor shell (`ios/`, Capacitor 6.2.3, the same as `android/`). The app's files are inside the app: it loads no code from the network. It talks only to its engine, `https://ai.forge-reserve.com` until the person sets another in **More, Server**.

- Name **Forge**, bundle id `com.forgereserve.ai`, iPhone only, iOS 16.4 and up, portrait.
- The same web bundle as the APK (`scripts/lib/android-web.ts`): the v2 app, what it imports, the icons and the natural voice (Phonon 31m and its voices, 65 MB), so answers are read aloud offline from the first open. The app is about 93 MB.
- One flavour: the universal app. There is no Forge Private Voice for iPhone.
- No analytics, no tracking, no third-party SDK. The only native code of its own is ForgeBars (below).

## What the iPhone app does in place of the Android app's plugins

The page sees Capacitor's bridge with `getPlatform()` `ios` (`public/v2/core/native.js`). Only ForgeBars is there; every other part is `null`, so the page does what it does in Safari on an iPhone.

| Android feature (plugin) | iPhone app |
|---|---|
| Status and navigation bars (ForgeBars) | Native: `BarsPlugin.swift` sets the status bar text, light on Midnight, Dark and the first run, dark on Light (the Android rule, BarRules.kt). The page draws under the status bar and the home indicator itself (`viewport-fit=cover`, `env(safe-area-inset-*)`). |
| Share out and Save (ForgeShare) | Web: `navigator.share` with the photo file (the iOS share sheet), as in Safari. Saving to Photos needs `NSPhotoLibraryAddUsageDescription`, which is set. |
| Photos shared in (ForgeShareIn) | Not available: there is no share extension yet. |
| Event links, `/j#<pass>` (ForgeJoin) | Not in the app: on an iPhone `/j` opens the web app in Safari (`/v2/#join=<pass>`), as before. No Universal Links yet. |
| Card taps, Cashu eCash cards (ForgeNfc) | Hidden: Tap a card is not listed (`NO_READER` in `core/native.js`). The website lists it and points to the Android app; the iPhone app has nowhere to point. |
| Fedimint cards and the till (ForgeTill) | Hidden, with Tap a card (it needs the reader too). |
| Natural voice, native (ForgeVoice) | Web: the browser's build of the same voice, from the app's own files: on the graphics chip where WebKit has WebGPU, else the processor on one thread (the page is not cross-origin isolated here). Simulator (processor, one thread): RTF 0.18, no gaps. |
| Hold to talk on the phone (ForgeSpeech) | Web: the engine hears it (paid), as in Safari. **This browser** under Voice is the WebKit recogniser (Apple's), offered only with Private only off, as on the website. |
| Hold to talk, Forge Private Voice (ForgeAsr) | Not available (no second app). |
| Back button | iPhones have none: every screen has its own Back. |
| Cross-origin isolation (MainActivity) | Not done: WKWebView gets no isolation headers from Capacitor, so the page never reloads for it and the voice runs on one thread. |

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

## Permissions

`ios/App/App/Info.plist`, each asked for only when it is first used:

- Camera: "Forge uses the camera to read a code, or to take a photo when you ask it to."
- Microphone: "Forge uses the microphone to record a question you speak."
- Speech recognition: "If you pick the phone's speech recognition in Voice, Apple turns a question you speak into words."
- Adding to Photos: "Forge saves a photo to your library only when you pick Save."

Capacitor grants the web view's own camera and microphone prompt once iOS has, so the person sees one prompt, not two.

## Checked in the Simulator (2026-11-16)

Driven with Maestro (taps through the web view's accessibility tree) and, for checks inside the page, a probe put into the installed copy of the app only (never the repository). Seen working: the first run, steps 1 to 4, and its Start free sheet with the keyboard; the home; Type with the keyboard (the visible-height handling in `core/viewport.js` works in WKWebView); More and every screen under it; Funds; Add money and its ways; the camera preview on Scan a note (the Simulator's test feed); the status bar text dark on Light and light on Midnight; safe areas top and bottom on every screen seen; read-only requests to `https://ai.forge-reserve.com` (models and ways to pay) from `capacitor://localhost`; a secure context with `crypto.subtle`; the natural voice loaded from the app's files and played through Web Audio after a tap; the phone's voice (Listen).

Web Audio plays in the app even without a tap (Capacitor lets media play without a gesture), so the Safari unlock path is kept and harmless.

## Not verified

- Anything on a real iPhone: signing, the permission prompts, the camera reading a real code, Hold to talk with a real microphone, the ring switch and `navigator.audioSession`, the share sheet and Save to Photos, screen sizes other than the iPhone 17's.
- Paid requests, funding, Start free with a code: not run against the production engine.
- WebKit's own speech recogniser on a phone: in the Simulator it started and stopped without error.
- Dark look (only Midnight and Light were looked at).
