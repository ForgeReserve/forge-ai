// The Android app's native side, as the web app sees it (android/, docs/ANDROID.md). In the app,
// Capacitor puts a bridge on window.Capacitor; on the website there is none and nothing here is used.
// The bridge carries calls to the app's plugins: ForgeShare (the share sheet, Save, and removing the
// photo files the app wrote), ForgeShareIn (a photo shared in from another app) and ForgeNfc (card taps:
// the bytes of each card command and the card's answer). The balance key and chats never pass through
// it; a card's answers carry its pieces, which only the page reads.

/** The engine the app talks to until the person sets another one in More. */
export const DEFAULT_ENGINE = 'https://ai.forge-reserve.com';

/** The bridge, when this page runs inside the Android app, else null. */
export function nativeBridge(win = globalThis) {
  const cap = win?.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform() || typeof cap.nativePromise !== 'function') return null;
  return {
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
 *   share: the share adapter (core/adapters.js) through the app's share sheet and save screen.
 *   shareIn: a photo shared in from another app.
 *   forget(): removes the photo files the app wrote to storage and the web view's cache.
 */
export function createNative(win = globalThis) {
  const bridge = nativeBridge(win);
  if (!bridge) return null;
  const { call, on } = bridge;
  return {
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
    nfc: nativeNfc(call, on),
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
 */
export function nativeNfc(call, on) {
  return {
    supported: () => true,
    async status() {
      const r = await call('ForgeNfc', 'status').catch(() => null);
      return { available: r?.available === true, enabled: r?.enabled === true };
    },
    start(onCard) {
      const handle = on('ForgeNfc', 'card', (ev) => {
        if (ev?.isoDep === false) return onCard(null);
        const id = ev?.id;
        onCard({
          transceive: async (apdu) => unhex((await call('ForgeNfc', 'transceive', { id, apdu: hex(apdu) }))?.data),
          close: () => call('ForgeNfc', 'close', { id }).catch(() => {}),
        });
      });
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
    },
  };
}
