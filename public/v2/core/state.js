// Shared app state and the rules that read it. Pure helpers are exported for tests; the store itself
// is a small object with subscribe(), so screens repaint when the balance or the conversation changes.
import { freeModelChoice, perQuestion } from './price.js';

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

/**
 * The settings a model choice writes (anywhere: Choose a model, the Private chip, Start free, the slow
 * answer's switch): the model in use, and the last one chosen of its kind (lastPrivate or lastStandard),
 * which the Private chip goes back to (kindSwitch).
 */
export const choiceOf = (m) => ({ model: m.id, [isPrivate(m) ? 'lastPrivate' : 'lastStandard']: m.id });

/**
 * The model of a kind with the lowest price for a typical question (core/price.js perQuestion) in the
 * balance's unit, or in dollars when no model of the list has a price in that unit. A model with no
 * price comes after every priced one; ties keep the engine's order.
 */
export function cheapest(models, unit = 'usd') {
  const price = (u) => models.map((m) => perQuestion(m, u));
  let p = price(unit);
  if (unit !== 'usd' && p.every((x) => x == null)) p = price('usd');
  let best = -1;
  for (let i = 0; i < models.length; i++) if (p[i] != null && (best < 0 || p[i] < p[best])) best = i;
  return models[best < 0 ? 0 : best] ?? null;
}

/**
 * The Private (or Standard) chip at the top left (owner, 2026-11-17): one tap switches the kind of model
 * in use. To Private: the Private model chosen last on this phone (lastPrivate) while the engine lists
 * it, else the cheapest Private one. To Standard: the Standard model chosen last (lastStandard) while
 * listed, else the default free model (core/price.js freeModelChoice: the fast free one first), else the
 * cheapest Standard one; and Private only goes off, since it hides every Standard model. Uncensored
 * models are never chosen. Returns {model, privateOnly}, or null when the engine lists no model of
 * that kind.
 */
export function kindSwitch(models, settings, { toPrivate, unit = 'usd' }) {
  const kind = (models ?? []).filter((m) => !m.uncensored && isPrivate(m) === toPrivate);
  if (!kind.length) return null;
  const last = kind.find((m) => m.id === (toPrivate ? settings.lastPrivate : settings.lastStandard));
  const model = last ?? (toPrivate ? null : freeModelChoice(kind)) ?? cheapest(kind, unit);
  return { model, privateOnly: toPrivate ? !!settings.privateOnly : false };
}

/**
 * Choose a model's groups (owner, 2026-11-15), in this order: the fast free models first (a rabbit), then
 * the private ones, then the other Standard ones, then the slow ones under their own heading (a turtle),
 * below Standard. A model is slow or fast by its speed mark from the engine (config/models.json); one
 * not measured has none. Empty groups are left out. Returns [{id, models}].
 */
export function modelGroups(models, settings, isFree = (m) => !!m?.pricing?.free) {
  const vis = visibleModels(models, settings);
  const fast = vis.filter((m) => m.speed === 'fast' && isFree(m) && !isPrivate(m));
  const slow = vis.filter((m) => m.speed === 'slow');
  const rest = vis.filter((m) => !fast.includes(m) && !slow.includes(m));
  const groups = [
    { id: 'fast', models: fast },
    { id: 'private', models: rest.filter(isPrivate) },
    // Within Standard, the fast ones first.
    { id: 'standard', models: rest.filter((m) => !isPrivate(m)).sort((a, b) => (b.speed === 'fast') - (a.speed === 'fast')) },
    { id: 'slow', models: slow },
  ];
  return groups.filter((g) => g.models.length);
}

/**
 * The model the slow-answer note switches to (screens/answer.js): a fast one this phone can use now,
 * the free ones first (they cost nothing), never the one in use. null when Private only (or the list)
 * leaves none.
 */
export function fastPick(models, settings, { current = null, isFree = (m) => !!m?.pricing?.free, paid = false, prefer = 'glm-5.3-flash' } = {}) {
  const fast = visibleModels(models, settings).filter((m) => m.speed === 'fast' && m.id !== current?.id);
  return fast.find((m) => m.id === prefer && isFree(m)) ?? fast.find(isFree) ?? (paid ? fast[0] : null) ?? null;
}

/** How many models Private only hides. */
export const hiddenCount = (models, settings) => visibleModels(models, { privateOnly: false }).length - visibleModels(models, settings).length;

/**
 * voiceIn: 'auto' (default; Forge Private Voice's own speech to text, else the phone's own on-device
 * recogniser in the Android app where it has the language, else the engine's speech to text), 'phone'
 * (the same On this phone order), 'engine' or 'device' (the browser's recogniser,
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
/**
 * lastPrivate, lastStandard: the Private and the Standard model chosen last on this phone (choiceOf), ''
 * before any. standardOk: true once the person said yes to Standard models (Start free's question, asked
 * by Start free or by the Private chip the first time it leaves Private); the chip does not ask again.
 */
/**
 * look: 'midnight' by default (the owner, 2026-11-15), 'light' or 'dark'. lookPicked: true once the
 * person picked a look in More, Mode and look. mode: the home and answer screens' mode module ('default',
 * or 'playful': docs/PLAYFUL.md), chosen in the same place. gameFirst: a mode with a cover game (Playful)
 * opens on the game, its helper behind it; on by default, turned off in the same place.
 */
/**
 * phoneOff: true once the person said Go online when the app asked, after the phone's own recogniser
 * heard nothing twice in a row while its level showed sound (core/talk.js afterPhonePress), so the engine
 * hears this phone (pickVoiceIn). phoneMisses: such presses in a row so far. phoneAsked: true once the
 * app asked (either answer, or the sheet dismissed): it never asks again on this phone.
 */
export const DEFAULT_SETTINGS = Object.freeze({ look: 'midnight', followSystem: false, privateOnly: true, model: '', lastPrivate: '', lastStandard: '', standardOk: false, voiceIn: 'auto', phoneOff: false, phoneMisses: 0, phoneAsked: false, voiceOut: 'auto', naturalVoice: '', voiceDevice: '', preferNatural: false, voicePace: null, autoDelete: 'day', lastWay: '', mode: 'default', gameFirst: true });

/**
 * The mode to draw the home and the answer with: the chosen one when it can be drawn now (`ready`, the
 * ids of the mode modules whose screens are in), else Default.
 */
export function pickMode(ready, settings) {
  return ready.includes(settings?.mode) ? settings.mode : 'default';
}

/**
 * The voice-in module to use: the chosen one when it can be used. Otherwise, and with 'auto' (the
 * default) or 'phone', On this phone: Forge Private Voice's own speech to text (its APK only), else the
 * phone's own on-device recogniser (in the Android and iPhone apps) when it has the language; else the engine's. With
 * 'engine' chosen, the engine's first. The browser's recogniser is never used with Private only on,
 * since the browser may send the sound to its maker, and never unless chosen.
 * phoneOff: the person chose to go online after the phone's recogniser heard nothing twice in a row
 * (core/talk.js PHONE_MISSES), so the next way hears it, under the same Private only rule; the phone only
 * when no other way can. Picking On this phone in More, Voice clears it.
 * mods: {bundled, phone, engine, device}, each a module instance or undefined.
 */
export function pickVoiceIn(mods, settings) {
  const ok = (m) => !!m?.available() && (!settings.privateOnly || m.private());
  if (settings.voiceIn === 'device' && ok(mods.device)) return mods.device;
  const order = (settings.voiceIn === 'engine' ? [mods.engine, mods.bundled, mods.phone] : [mods.bundled, mods.phone, mods.engine]).filter(ok);
  return (settings.phoneOff ? order.find((m) => m !== mods.phone) : null) ?? order[0] ?? null;
}

/**
 * The settings from what was saved. Until 'auto' came (with the phone's own recogniser), 'engine' was
 * the default and was saved with any other setting, so a saved 'engine' is 'auto' unless the person
 * picked it in More, Voice since then (voiceInPicked). In the same way Light was the default look until
 * Midnight, so a saved 'light' is Midnight unless the person picked a look since then (lookPicked).
 * A build before the question switched a phone to the engine on its own (phoneOff with no phoneAsked):
 * that phone hears with its own recogniser again, with a fresh count, so it is asked.
 */
export function loadedSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  if (s.voiceIn === 'engine' && !s.voiceInPicked) s.voiceIn = 'auto';
  if (s.look === 'light' && !s.lookPicked) s.look = DEFAULT_SETTINGS.look;
  if (s.phoneOff && !s.phoneAsked) Object.assign(s, { phoneOff: false, phoneMisses: 0 });
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
