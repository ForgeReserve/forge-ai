// Shared app state and the rules that read it. Pure helpers are exported for tests; the store itself
// is a small object with subscribe(), so screens repaint when the balance or the conversation changes.

/** The balance key v1 uses on this origin. v2 reads and writes the same key, so a v1 balance carries over. */
export const KEY_STORE = 'forge.balanceKey';

/** The storage name of the balance key for an engine: the v1 name for this origin, a separate one per other engine. */
export function keyName(base, origin) {
  return !base || base === origin ? KEY_STORE : `${KEY_STORE}@${base}`;
}

/** A model is private when it runs in a verified enclave and the app encrypts the request to it. */
export const isPrivate = (m) => m?.tier === 'enclave' && m?.encrypted_passthrough === true;

/** Models the person can choose: with Private only on, only private ones. Uncensored models stay hidden. */
export function visibleModels(models, { privateOnly }) {
  return (models ?? []).filter((m) => !m.uncensored && (!privateOnly || isPrivate(m)));
}

/** The model in use: the saved choice if it is still visible, else the first visible one, else null. */
export function pickModel(models, settings) {
  const vis = visibleModels(models, settings);
  return vis.find((m) => m.id === settings.model) ?? vis[0] ?? null;
}

/** How many models Private only hides. */
export const hiddenCount = (models, settings) => visibleModels(models, { privateOnly: false }).length - visibleModels(models, settings).length;

/**
 * voiceIn: 'auto' (default; the phone's own on-device recogniser in the Android app where it has the
 * language, else the engine's speech to text), 'phone', 'engine' or 'device' (the browser's recogniser,
 * never with Private only on). voiceOut: 'auto' (the natural voice made on the phone where it runs, else the
 * phone's own voice, else the engine's), 'phonon', 'engine', 'device' or 'off'. Voice questions are read
 * aloud unless voiceOut is 'off'.
 */
/**
 * naturalVoice: the natural voice's speaker ('' for the default, Maeve; the app offers Maeve and Freya).
 * voiceDevice: '' until the natural voice failed on the graphics chip (WebGPU) on this phone, then 'cpu'
 * (core/phonon.js GPU_FAILED): it starts on the processor from then on.
 */
/**
 * autoDelete: when conversations are removed from this phone ('off', 'close', 'hour', 'day', 'week';
 * core/history.js). One day by default, as the canvas shows it (DProtect, DErase).
 */
/**
 * preferNatural: keep the natural voice even where this phone makes it too slowly (otherwise such an
 * answer is read by the phone's own voice, core/voicepace.js). voicePace: how fast this phone makes the
 * natural voice, per way of making it ({rtf, spc, n, at}; core/phonon.js notePace).
 */
export const DEFAULT_SETTINGS = Object.freeze({ look: 'light', followSystem: false, privateOnly: true, model: '', voiceIn: 'auto', voiceOut: 'auto', naturalVoice: '', voiceDevice: '', preferNatural: false, voicePace: null, autoDelete: 'day', lastWay: '' });

/**
 * The voice-in module to use: the chosen one when it can be used. Otherwise, and with 'auto' (the
 * default), the phone's own on-device recogniser (Android app only) when it has the language, else the
 * engine's; with 'engine' chosen, the engine's first. The browser's recogniser is never used with
 * Private only on, since the browser may send the sound to its maker, and never unless chosen.
 * mods: {phone, engine, device}, each a module instance or undefined.
 */
export function pickVoiceIn(mods, settings) {
  const ok = (m) => !!m?.available() && (!settings.privateOnly || m.private());
  if (settings.voiceIn === 'device' && ok(mods.device)) return mods.device;
  const order = settings.voiceIn === 'engine' ? [mods.engine, mods.phone] : [mods.phone, mods.engine];
  return order.find(ok) ?? null;
}

/**
 * The settings from what was saved. Until 'auto' came (with the phone's own recogniser), 'engine' was
 * the default and was saved with any other setting, so a saved 'engine' is 'auto' unless the person
 * picked it in More, Voice since then (voiceInPicked).
 */
export function loadedSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  if (s.voiceIn === 'engine' && !s.voiceInPicked) s.voiceIn = 'auto';
  return s;
}

/**
 * The voice-out module to use, or null when answers are not read aloud. 'auto' (the default) is the
 * natural voice made on the phone (phonon) where the phone can run it, else the phone's own voice,
 * else the engine's.
 */
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

export function createStore(initial) {
  const S = { ...initial };
  const subs = new Set();
  return {
    S,
    set(patch) {
      Object.assign(S, patch);
      for (const f of [...subs]) f(S);
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}
