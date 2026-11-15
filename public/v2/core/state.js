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
 * voiceIn: 'engine' (default; the engine's speech to text) or 'device' (the browser's recogniser, never
 * with Private only on). voiceOut: 'auto' (the natural voice made on the phone where it runs, else the
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
export const DEFAULT_SETTINGS = Object.freeze({ look: 'light', followSystem: false, privateOnly: true, model: '', voiceIn: 'engine', voiceOut: 'auto', naturalVoice: '', voiceDevice: '', autoDelete: 'day' });

/**
 * The voice-in module to use: the chosen one when it can be used, else the engine's. The browser's
 * recogniser is never used with Private only on, since the browser may send the sound to its maker.
 * mods: {engine, device}, each a module instance or undefined.
 */
export function pickVoiceIn(mods, settings) {
  const ok = (m) => !!m?.available() && (!settings.privateOnly || m.private());
  if (settings.voiceIn === 'device' && ok(mods.device)) return mods.device;
  return ok(mods.engine) ? mods.engine : null;
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
