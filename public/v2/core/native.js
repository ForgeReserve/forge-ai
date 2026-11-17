// The Android app's native side, as the web app sees it (android/, docs/ANDROID.md). In the app,
// Capacitor puts a bridge on window.Capacitor; on the website there is none and nothing here is used.
// The iPhone app (ios/, docs/IOS.md) has the same bridge with ForgeBars and ForgeNfc: everything else
// there is the website's own way of doing it, or hidden (createNative).
// The bridge carries calls to the app's plugins: ForgeShare (the share sheet, Save, and removing the
// photo files the app wrote), ForgeShareIn (a photo shared in from another app), ForgeNfc (card taps:
// the bytes of each card command and the card's answer), ForgeTill (the till a Fedimint card pays
// through: its pay requests and card link, with its token kept by the app), ForgeVoice (the natural
// voice made by native code: the answer's text goes to the app, which plays the sound itself),
// ForgeSpeech (Hold to talk heard by the phone's own on-device recogniser: only words come back),
// ForgeJoin (an event pass from the link that opened the app, /j#<pass>),
// ForgeAsr (Hold to talk heard by Forge Private Voice's own model, the same way) and ForgeBars (the phone's status and navigation bars in the page's colour). The
// balance key and chats never pass through it; a card's answers carry its pieces, which only the page
// reads.

/** The engine the app talks to until the person sets another one in More. */
export const DEFAULT_ENGINE = 'https://ai.forge-reserve.com';

/**
 * The bridge, when this page runs inside the Android or the iPhone app, else null. platform is 'ios' in
 * the iPhone app and 'android' in the Android one (Capacitor's only other native platform).
 */
export function nativeBridge(win = globalThis) {
  const cap = win?.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform() || typeof cap.nativePromise !== 'function') return null;
  return {
    platform: typeof cap.getPlatform === 'function' && cap.getPlatform() === 'ios' ? 'ios' : 'android',
    call: (plugin, method, options = {}) => cap.nativePromise(plugin, method, options),
    on: (plugin, event, fn) => (typeof cap.addListener === 'function' ? cap.addListener(plugin, event, fn) : null),
  };
}

/** The engine to use when none is set: the same origin on the website, Forge's engine in the app. */
export const defaultEngine = (native) => (native ? DEFAULT_ENGINE : '');

// ------------------------------------------------------------------ base64 for files over the bridge

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const fileData = async (file) => bytesToBase64(new Uint8Array(await file.arrayBuffer()));

/**
 * The app's native parts for the screens, or null on the website.
 *   platform: 'android' or 'ios'.
 *   share: the share adapter (core/adapters.js) through the app's share sheet and save screen.
 *   shareIn: a photo shared in from another app.
 *   forget(): removes the photo files the app wrote to storage and the web view's cache.
 *   isolated: the page is served cross-origin isolated (reloadForIsolation).
 * The iPhone app has two of the Android plugins, ForgeBars and ForgeNfc (card taps, through the
 * iPhone's NFC sheet), so there every other part is null and the page does what it does in Safari on an
 * iPhone: the share sheet through navigator.share, Hold to talk through the browser's own ways, and no
 * till (ForgeTill needs a Swift port first).
 */
export function createNative(win = globalThis) {
  const bridge = nativeBridge(win);
  if (!bridge) return null;
  const { call, on } = bridge;
  const bars = (color) => call('ForgeBars', 'set', { color }).catch(() => {});
  if (bridge.platform === 'ios') {
    // An app built before ForgeNfc has no reader: the card ways are left out there, as before.
    const nfc = hasPlugin(win, 'ForgeNfc') ? nativeNfc(call, on, { sheet: true }) : NO_READER;
    return { platform: 'ios', isolated: false, share: null, shareIn: null, forget: null, join: null, nfc, till: null, voice: null, speech: null, asr: null, bars };
  }
  return {
    platform: 'android',
    isolated: true,
    share: {
      canShareFiles: () => true,
      /** Opens the share sheet. Resolves {opened: true}: the app is not told which app was picked. */
      async files(files) {
        const f = files[0];
        await call('ForgeShare', 'share', { name: f.name, mime: f.type, data: await fileData(f) });
        return { opened: true };
      },
      /** Saves where the person picks. Resolves {saved: boolean}. */
      async save(file) {
        const r = await call('ForgeShare', 'save', { name: file.name, mime: file.type, data: await fileData(file) });
        return { saved: r?.saved === true };
      },
    },
    shareIn: {
      /** True when a photo shared in waits to be taken. */
      waiting: async () => (await call('ForgeShareIn', 'waiting').catch(() => null))?.waiting === true,
      /**
       * Takes the waiting photo: a File, or null when none came. Throws {code} 'missed' when it could not
       * be read and 'none' when the share held no photo, as the share target's routes say.
       */
      async take() {
        const r = await call('ForgeShareIn', 'take');
        if (r?.data) return new File([base64ToBytes(r.data)], 'shared', { type: r.mime || 'image/jpeg' });
        if (r?.problem) throw Object.assign(new Error(r.problem), { code: r.problem });
        return null;
      },
      /** Calls fn when another app shares a photo in while Forge is open. */
      onShared: (fn) => on('ForgeShareIn', 'shared', () => fn()),
      clear: () => call('ForgeShareIn', 'clear').catch(() => {}),
    },
    forget: () => call('ForgeShare', 'forget').catch(() => {}),
    /**
     * An event pass the app was opened on (https://ai.forge-reserve.com/j#<pass>, ForgeJoin), kept in
     * the app's memory only. take() hands it over once (the pass, or null); onJoin(fn) calls fn when a
     * link opens the app while it runs; clear() drops it (Erase everything).
     */
    join: {
      take: async () => {
        const r = await call('ForgeJoin', 'take').catch(() => null);
        return typeof r?.pass === 'string' && r.pass ? r.pass : null;
      },
      onJoin: (fn) => on('ForgeJoin', 'join', () => fn()),
      clear: () => call('ForgeJoin', 'clear').catch(() => {}),
    },
    nfc: nativeNfc(call, on),
    till: nativeTill(call, on),
    voice: nativeVoice(call, on),
    speech: nativeSpeech(call, on),
    asr: nativeAsr(call, on),
    /**
     * The phone's status and navigation bars in this colour (a plain hex colour), with light icons on a
     * dark one and dark icons on a light one (BarsPlugin.kt; on the iPhone, BarsPlugin.swift sets the
     * status bar's text only, as the page draws under it).
     */
    bars,
  };
}

/** Whether the app registered this plugin (Capacitor iOS lists each one under Capacitor.Plugins). */
const hasPlugin = (win, name) => !!win?.Capacitor?.Plugins?.[name];

/**
 * An iPhone app with no card reader (built before ForgeNfc). The website lists the card ways and points
 * to the app; such an app has nowhere to point, so listed() says to leave them out (modules/fund/card
 * and fedimint).
 */
export const NO_READER = Object.freeze({
  supported: () => false,
  listed: () => false,
  status: async () => ({ available: false, enabled: false }),
  start: () => ({ started: Promise.resolve(false), stop() {} }),
});

/**
 * Keeps the phone's bars the colour of the page, as a browser keeps them the theme-color: the look's
 * ground, and the first run's dark one while it shows (screens/firstrun.js). Calls bars(color) now and
 * whenever the colour changes. Returns a function that stops it.
 */
export function followBars(bars, doc = globalThis.document) {
  const meta = doc?.querySelector?.('meta[name="theme-color"]');
  if (!meta || typeof MutationObserver !== 'function') return () => {};
  let last = null;
  const send = () => {
    const c = meta.getAttribute('content');
    if (c && c !== last) bars((last = c));
  };
  const watch = new MutationObserver(send);
  watch.observe(meta, { attributes: true, attributeFilter: ['content'] });
  send();
  return () => watch.disconnect();
}

/**
 * Hold to talk heard by the phone's own on-device speech recogniser through ForgeSpeech (docs/VOICE.md,
 * Speech input). The sound stays on the phone: only the words come over the bridge. available({locale})
 * resolves {onDevice, reason, locale}: onDevice only when the on-device recogniser has the language now,
 * and locale is the one to listen with. start({locale, onEvent}) resolves {id, stop(), cancel()} once
 * it listens, or rejects with {code} permission, busy or unavailable; onEvent gets {type}: started,
 * level {level}, partial {text}, final {text}, error {code}, and end, always last.
 */
export function nativeSpeech(call, on) {
  const sessions = new Map(); // id -> onEvent
  let wired = null;
  const wire = () => (wired ??= Promise.resolve(on('ForgeSpeech', 'speech', (ev) => sessions.get(ev?.id)?.(ev))));
  let next = 0;
  const fail = (e) => Object.assign(new Error(e?.message ?? String(e)), { code: e?.code ?? 'failure' });
  return {
    supported: () => true,
    async available({ locale } = {}) {
      const r = await call('ForgeSpeech', 'available', { locale }).catch((e) => ({ onDevice: false, reason: e?.message ?? 'no on-device speech in this app' }));
      return { onDevice: r?.onDevice === true, reason: r?.reason ?? null, locale: typeof r?.locale === 'string' ? r.locale : (locale ?? null) };
    },
    async start({ locale, onEvent = () => {} } = {}) {
      await wire();
      next += 1;
      const id = `ask-${Date.now().toString(36)}-${next}`;
      // Before the call: the first events can come before it resolves.
      sessions.set(id, (ev) => {
        if (ev.type === 'end') sessions.delete(id);
        onEvent(ev);
      });
      try {
        await call('ForgeSpeech', 'start', { id, locale });
      } catch (e) {
        sessions.delete(id);
        throw fail(e);
      }
      return {
        id,
        stop: () => call('ForgeSpeech', 'stop', { id }).catch(() => {}),
        cancel() {
          sessions.delete(id);
          call('ForgeSpeech', 'cancel', { id }).catch(() => {});
        },
      };
    },
  };
}

/**
 * Hold to talk heard by Forge Private Voice's own speech to text through ForgeAsr (docs/VOICE.md,
 * Bundled speech to text): Moonshine tiny in the app's own process, so the sound stays on the phone and
 * only the words come over the bridge. Only the privatevoice APK carries the model; in the universal one
 * available() says no. available() resolves {available, reason, language}; start({onEvent}) is
 * nativeSpeech's, with the same events (started, level, partial, final, error, end).
 */
export function nativeAsr(call, on) {
  const sessions = new Map(); // id -> onEvent
  let wired = null;
  const wire = () => (wired ??= Promise.resolve(on('ForgeAsr', 'asr', (ev) => sessions.get(ev?.id)?.(ev))));
  let next = 0;
  const fail = (e) => Object.assign(new Error(e?.message ?? String(e)), { code: e?.code ?? 'failure' });
  return {
    async available() {
      const r = await call('ForgeAsr', 'available').catch((e) => ({ available: false, reason: e?.message ?? 'no speech to text in this app' }));
      return { available: r?.available === true, reason: r?.reason ?? null, language: typeof r?.language === 'string' ? r.language : 'en' };
    },
    async start({ onEvent = () => {} } = {}) {
      await wire();
      next += 1;
      const id = `asr-${Date.now().toString(36)}-${next}`;
      // Before the call: the first events can come before it resolves.
      sessions.set(id, (ev) => {
        if (ev.type === 'end') sessions.delete(id);
        onEvent(ev);
      });
      try {
        await call('ForgeAsr', 'start', { id });
      } catch (e) {
        sessions.delete(id);
        throw fail(e);
      }
      return {
        id,
        stop: () => call('ForgeAsr', 'stop', { id }).catch(() => {}),
        cancel() {
          sessions.delete(id);
          call('ForgeAsr', 'cancel', { id }).catch(() => {});
        },
      };
    },
  };
}

/**
 * The natural voice made by native code through ForgeVoice (docs/VOICE.md, Native voice in the Android
 * app): the same model as the browser's build, run by Gradium's native runtime in a process of its own,
 * which plays the sound through the phone's speaker itself. status() says whether this phone runs it
 * ({available, reason, cores, bigCores, threads, defaultThreads}); speak() resolves with the answer's
 * numbers once it was read ({firstMs, audioS, totalMs, rtf, spc, gaps, underruns, threads, stopped}) and
 * rejects with {code}: too-slow (the phone's own voice should read it, data.rtf says how slow), crashed
 * (the voice process ended), unavailable, load or failed. bench() makes the sound without playing it.
 */
export function nativeVoice(call, on) {
  const handlers = new Map(); // id -> {started, buffering}
  let wired = null;
  const wire = () =>
    (wired ??= Promise.all(['started', 'buffering'].map((type) => on('ForgeVoice', type, (ev) => handlers.get(ev?.id)?.[type]?.(ev)))));
  let status = null;
  let next = 0;
  const newId = (p) => `${p}-${Date.now().toString(36)}-${++next}`;
  const fail = (e) => Object.assign(new Error(e?.message ?? String(e)), { code: e?.code ?? 'failed', data: e?.data ?? null });
  return {
    supported: () => true,
    status() {
      status ??= call('ForgeVoice', 'status')
        .then((r) => ({ available: r?.available === true, reason: r?.reason ?? null, cores: r?.cores ?? null, bigCores: r?.bigCores ?? [], threads: r?.threads ?? null, chosenThreads: r?.chosenThreads ?? 0, defaultThreads: r?.defaultThreads ?? null }))
        .catch(() => ({ available: false, reason: 'no native voice in this app' }));
      return status;
    },
    /**
     * Reads pieces aloud. rtf, spc: this phone's kept speed (core/voicepace.js), for when to start;
     * preferNatural, phoneVoice: whether too slow may give up (rejects too-slow). onStarted when the
     * sound starts, onBuffering({fraction}) while it waits for sound in hand.
     */
    async speak({ pieces, voice = null, rtf = null, spc = null, preferNatural = false, phoneVoice = false, threads = 0, onStarted, onBuffering } = {}) {
      await wire();
      const id = newId('say');
      handlers.set(id, { started: () => onStarted?.(), buffering: (ev) => onBuffering?.({ fraction: Number(ev?.fraction) || 0 }) });
      const p = call('ForgeVoice', 'speak', { id, pieces, voice, rtf, spc, preferNatural, phoneVoice, threads })
        .catch((e) => {
          throw fail(e);
        })
        .finally(() => handlers.delete(id));
      return { id, done: p, stop: () => call('ForgeVoice', 'stop', { id }).catch(() => {}) };
    },
    bench: ({ text, voice = null, threads = 0 }) =>
      call('ForgeVoice', 'bench', { id: newId('bench'), text, voice, threads }).catch((e) => {
        throw fail(e);
      }),
    /** The threads the app reads with from now on (0: the phone's default). */
    async config(threads) {
      status = null;
      return call('ForgeVoice', 'config', { threads });
    },
    /** Ends the voice process, freeing its memory. */
    release: () => call('ForgeVoice', 'release').catch(() => {}),
    /** Keeps the voice lab's results in the app's own files (files/voice-lab/name), for adb to read. */
    saveLab: async (name, json) => (await call('ForgeVoice', 'saveLab', { name, json }))?.saved === true,
  };
}

/**
 * The paired till through ForgeTill (slice A14, core/till.js). The app keeps the till's address and its
 * pay token in the Android Keystore and adds the token to every request itself: the page never holds
 * it after pairing. The plugin sends only the pay routes (POST /v1/pay, GET /v1/pay/{id}, POST
 * /v1/pay/{id}/refund, GET /v1/health) and opens the card link; the page answers the card commands that
 * come down the link (core/till.js cardRelay) and the plugin writes the answers back.
 */
export function nativeTill(call, on) {
  const links = new Map(); // sock -> {onApdu}
  let wired = null;
  const wire = () =>
    (wired ??= Promise.all([
      on('ForgeTill', 'apdu', async (ev) => {
        const l = links.get(ev?.sock);
        if (!l) return;
        const frame = await l.onApdu({ id: ev.id, apdu: ev.apdu });
        call('ForgeTill', 'linkSend', { sock: ev.sock, ...frame }).catch(() => {});
      }),
      on('ForgeTill', 'closed', (ev) => links.delete(ev?.sock)),
    ]));
  let next = 0;
  return {
    supported: () => true,
    async status() {
      const r = await call('ForgeTill', 'status').catch(() => null);
      return { paired: r?.paired === true, url: typeof r?.url === 'string' ? r.url : null };
    },
    /** Pairs with the till in a scanned pay code. Resolves {url}; rejects with {code} when it is not one. */
    async pair(text) {
      const r = await call('ForgeTill', 'pair', { text });
      return { url: r?.url ?? null };
    },
    forget: () => call('ForgeTill', 'forget').catch(() => {}),
    async request({ method, path, link = null, body, timeoutMs }) {
      const r = await call('ForgeTill', 'request', { method, path, link, body: body === undefined ? null : JSON.stringify(body), timeoutMs });
      let parsed = null;
      try {
        parsed = JSON.parse(r?.body ?? '');
      } catch {
        /* not JSON */
      }
      return { status: r?.status ?? 0, body: parsed };
    },
    async openLink({ onApdu }) {
      await wire();
      next += 1;
      const sock = next;
      links.set(sock, { onApdu });
      try {
        const r = await call('ForgeTill', 'linkOpen', { sock });
        return {
          id: r.link,
          close: () => {
            links.delete(sock);
            call('ForgeTill', 'linkClose', { sock }).catch(() => {});
          },
        };
      } catch (e) {
        links.delete(sock);
        throw e;
      }
    },
  };
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => {
  const s = String(h ?? '');
  if (s.length % 2 || !/^[0-9a-f]*$/i.test(s)) throw new Error('the card answer is not hex');
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
};

/**
 * Card taps through ForgeNfc, as the nfc adapter (core/adapters.js) describes it. Each card that comes
 * into the field is numbered by the app; its transceiver sends that number with every command, so a
 * command meant for one card never reaches the next.
 *
 * sheet: the iPhone app (ios/App/App/NfcPlugin.swift). There the phone reads only while iOS's own NFC
 * sheet is up, and the sheet opens only when the app asks, after a press: start(onCard, words) opens it
 * with words for it ({hold, keep, done, lost, notCard, one}, Android takes none), the sheet holds the
 * one card that is tapped, and once onCard has finished with that card it is let go (close), which
 * closes the sheet. again() opens the sheet for the next tap, from a press; it does nothing while a card
 * is being handled, as that sheet is still up. On Android reading stays on while the screen is open.
 */
export function nativeNfc(call, on, { sheet = false } = {}) {
  return {
    supported: () => true,
    ...(sheet ? { sheet: true } : {}),
    async status() {
      const r = await call('ForgeNfc', 'status').catch(() => null);
      return { available: r?.available === true, enabled: r?.enabled === true };
    },
    start(onCard, words) {
      let handling = false;
      const handle = on('ForgeNfc', 'card', (ev) => {
        if (ev?.isoDep === false) return onCard(null);
        const id = ev?.id;
        const card = {
          transceive: async (apdu) => unhex((await call('ForgeNfc', 'transceive', { id, apdu: hex(apdu) }))?.data),
          close: () => call('ForgeNfc', 'close', { id }).catch(() => {}),
        };
        if (!sheet) return onCard(card);
        handling = true;
        Promise.resolve()
          .then(() => onCard(card))
          .catch(() => {})
          .finally(() => {
            handling = false;
            card.close();
          });
      });
      if (!sheet) {
        const started = call('ForgeNfc', 'start');
        return {
          started,
          stop() {
            Promise.resolve(handle)
              .then((h) => h?.remove?.())
              .catch(() => {});
            call('ForgeNfc', 'stop').catch(() => {});
          },
        };
      }
      const open = () => call('ForgeNfc', 'start', { ...(words ?? {}) });
      const started = open();
      // Nothing waits on it: a sheet that could not open leaves the screen's Scan button to try again.
      started.catch(() => {});
      let stopped = false;
      return {
        started,
        again() {
          if (!handling && !stopped) open().catch(() => {});
        },
        stop() {
          stopped = true;
          Promise.resolve(handle)
            .then((h) => h?.remove?.())
            .catch(() => {});
          call('ForgeNfc', 'stop').catch(() => {});
        },
      };
    },
  };
}

/**
 * Inside the Android app (native.isolated), the page is served cross-origin isolated (MainActivity adds the headers, so
 * the natural voice can run on several threads). The very first load can start before those headers
 * are in place; then the page reloads once. True when this page should reload now. `session` is
 * sessionStorage: the flag in it makes sure that happens once, also where the web view cannot isolate
 * a page at all (the voice then runs on one thread).
 */
export function reloadForIsolation({ native, isolated, session }) {
  if (!native?.isolated || isolated) return false;
  try {
    if (session.getItem('forge2.isolationReload')) return false;
    session.setItem('forge2.isolationReload', '1');
    return true;
  } catch {
    return false;
  }
}
