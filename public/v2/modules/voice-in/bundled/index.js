// Voice in through Forge Private Voice's own speech to text (ForgeAsr, core/native.js nativeAsr):
// Moonshine tiny, English, in the app's own process. Only that APK (the one for GrapheneOS, which has no
// on-device recogniser) carries the model; everywhere else this module says it is not available and the
// phone's own recogniser or the engine is used. Free and private: the sound never leaves the phone and
// only the words come back to the page, with live words while the button is held.
// It is the phone module (On this phone) over another bridge: the same events, the same handling.
// Handed only t and the bundled speech to text bridge (null outside the app; core/registry.js).
import { create as recogniser } from '../phone/index.js';

/** nativeAsr in the shape the phone module asks of a recogniser: {onDevice, reason, locale}. */
export function bridgeFor(asr) {
  if (typeof asr?.available !== 'function' || typeof asr?.start !== 'function') return null;
  return {
    async available() {
      const r = await asr.available();
      return { onDevice: r?.available === true, reason: r?.reason ?? null, locale: 'en' };
    },
    start: ({ onEvent }) => asr.start({ onEvent }),
  };
}

export function create({ asr = null }) {
  const mod = recogniser({ speech: bridgeFor(asr) });
  return { ...mod, id: 'bundled' };
}
