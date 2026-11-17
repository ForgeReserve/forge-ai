// Voice in through the phone's own on-device speech recogniser, in the Android and iPhone apps
// (ForgeSpeech, core/native.js nativeSpeech: Android's on-device recogniser, Apple's restricted to the
// phone). The sound never leaves the phone: the app uses only the recogniser that runs on the phone,
// never one that sends it to a server, and only the words come back to the page. Free and private.
// Offered only where the phone says its on-device recogniser has the language now; elsewhere (the
// website, an older phone, a phone without one) the engine's speech to text is used.
// Handed only t and the native speech bridge (null outside the app; core/registry.js).

/** How long the last words may take to come after the button is let go. */
export const FINISH_MS = 6000;

/**
 * The language to listen in. The app speaks English, so the phone's own English (en-GB, en-IN, ...)
 * when its language is English, else US English.
 */
export function localeFor(lang) {
  const l = String(lang ?? '').replace('_', '-');
  return /^en(-|$)/i.test(l) ? l : 'en-US';
}

export function create({ speech: bridge = null }) {
  // On the website the app has no bridge (the registry then hands an empty one).
  const speech = typeof bridge?.available === 'function' && typeof bridge?.start === 'function' ? bridge : null;
  let state = { onDevice: false, reason: speech ? 'checking' : 'not in the app', locale: localeFor(globalThis.navigator?.language) };
  const check = async () => {
    if (!speech) return state;
    state = { ...state, ...(await speech.available({ locale: state.locale }).catch(() => ({ onDevice: false, reason: 'check failed' }))) };
    return state;
  };
  // Asked once when the app opens; the app redraws when the answer comes (app.js).
  const checked = check();
  const unavailable = (reason) => (state = { ...state, onDevice: false, reason });
  return {
    id: 'phone',
    checked,
    /** Why it is or is not offered: {onDevice, reason, locale}. */
    status: () => ({ ...state }),
    available: () => state.onDevice === true,
    private: () => true,
    price: () => 0,
    maxSeconds: () => 60,
    async start({ onText = () => {}, onLevel = () => {} } = {}) {
      let heard = '';
      let final = null;
      let error = null;
      let ended;
      const end = new Promise((res) => (ended = res));
      const onEvent = (ev) => {
        switch (ev?.type) {
          case 'level':
            return onLevel(Number(ev.level) || 0);
          case 'partial':
            heard = String(ev.text ?? '');
            return onText(heard);
          case 'final':
            final = String(ev.text ?? '');
            return onText(final);
          case 'error':
            error = ev.code ?? 'failure';
            // The phone lost the language or the recogniser: the engine hears the next question.
            if (error === 'unavailable') unavailable('the recogniser stopped working');
            return undefined;
          case 'end':
            return ended();
          default:
            return undefined;
        }
      };
      let s;
      try {
        s = await speech.start({ locale: state.locale, onEvent });
      } catch (e) {
        if (e?.code === 'unavailable') unavailable(e.message);
        // Said as the microphone adapter says it, so the talk button explains it the same way.
        if (e?.code === 'permission') throw Object.assign(new Error(e.message), { name: 'NotAllowedError' });
        throw e;
      }
      return {
        async finish({ signal } = {}) {
          s.stop();
          let timer = 0;
          const aborted = new Promise((_, rej) => signal?.addEventListener('abort', () => rej(Object.assign(new Error('Cancelled.'), { name: 'AbortError' })), { once: true }));
          try {
            await Promise.race([end, aborted, new Promise((res) => (timer = setTimeout(res, FINISH_MS)))]);
          } catch (e) {
            s.cancel();
            throw e;
          } finally {
            clearTimeout(timer);
          }
          // Nothing heard, or the app was left while listening: no question (talk.empty).
          if (error && error !== 'no-speech' && error !== 'interrupted') {
            throw Object.assign(new Error(`The phone's recogniser failed: ${error}.`), { code: 'phone_speech', key: 'talk.phoneFailed' });
          }
          return { text: error ? '' : (final ?? heard).trim(), chargedMsub: 0, balanceMsub: null };
        },
        cancel: () => s.cancel(),
      };
    },
  };
}
