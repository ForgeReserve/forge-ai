// Hold to talk: the recorder's state machine. Press and hold to record, let go to send, slide off the
// button and let go to cancel. A press shorter than HOLD_MS is a tap: nothing is sent and the button
// explains itself. A recording that reaches its longest length is sent on its own. Pure, tested in Node:
// step() returns the next state and the effects for the screen to carry out, in order.
//
// Effects: start (open the recorder), discard (drop what was recorded), send, explain, cancelled,
// failed, maxed, and haptic:<start|leave|back|send|cancel> for a short vibration.

/** A press shorter than this is a tap. */
export const HOLD_MS = 350;
/** How far outside the button a finger may drift before letting go cancels, in CSS pixels. */
export const SLIDE_MARGIN = 24;

export const initial = () => ({ phase: 'idle' });

export function step(s, ev) {
  const same = { s, effects: [] };
  switch (s.phase) {
    case 'idle':
      if (ev.type === 'down') return { s: { phase: 'recording', at: ev.at, inside: true }, effects: ['start', 'haptic:start'] };
      return same;
    case 'recording':
      switch (ev.type) {
        case 'move': {
          const inside = !!ev.inside;
          if (inside === s.inside) return same;
          return { s: { ...s, inside }, effects: [inside ? 'haptic:back' : 'haptic:leave'] };
        }
        case 'up':
          if (ev.at - s.at < HOLD_MS) return { s: initial(), effects: ['discard', 'explain'] };
          if (!s.inside) return { s: initial(), effects: ['discard', 'haptic:cancel', 'cancelled'] };
          return { s: { phase: 'sending' }, effects: ['send', 'haptic:send'] };
        case 'tick':
          if (Number.isFinite(ev.maxMs) && ev.at - s.at >= ev.maxMs) return { s: { phase: 'sending' }, effects: ['send', 'haptic:send', 'maxed'] };
          return same;
        case 'cancel':
          return { s: initial(), effects: ['discard', 'haptic:cancel', 'cancelled'] };
        case 'failed':
          return { s: initial(), effects: ['discard', 'failed'] };
        default:
          return same;
      }
    case 'sending':
      if (ev.type === 'done') return { s: initial(), effects: [] };
      if (ev.type === 'failed') return { s: initial(), effects: ['failed'] };
      return same;
    default:
      return { s: initial(), effects: [] };
  }
}

/** True when (x, y) is on the button or within SLIDE_MARGIN of it. */
export function inside(rect, x, y, margin = SLIDE_MARGIN) {
  return x >= rect.left - margin && x <= rect.right + margin && y >= rect.top - margin && y <= rect.bottom + margin;
}

/** 7400 ms -> '0:07'. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- a phone recogniser that hears nothing
//
// Owner, 2026-11-18: on a Galaxy A16 the phone's own recogniser opened the microphone and its level
// showed sound, yet every press ended with no-speech. When that happens twice in a row, the app asks
// whether the voice may go online to become words (app.js askVoiceOnline). Privacy is the default: only
// the person's yes switches this phone to the engine (phoneOff, core/state.js pickVoiceIn).

/**
 * The level that counts as sound. ForgeSpeech's level runs 0 to 0.6: on Android (rmsdB + 2) / 20, about
 * -2 dB in silence and up to 10 dB for a voice; on the iPhone (dBFS + 50) / 60, about -50 dBFS in a quiet
 * room and -14 for a voice. 0.1 is 2 dB over Android's silence and 6 dB over a quiet room on the iPhone,
 * well under a voice near the phone.
 */
export const SOUND_LEVEL = 0.1;
/**
 * How many readings at SOUND_LEVEL or over a press needs. A level comes at most every 80 ms, but the
 * phone that failed this way sent few and low ones: of three presses with a person speaking, one had two
 * readings at 0.15 or over (measured, 2026-11-18). So one reading over the floor must do.
 */
export const SOUND_READINGS = 1;
/** The shortest press that counts. A tap or a quick press is shorter; the presses that failed were 2 to 6 s. */
export const SOUND_HOLD_MS = 1500;
/** Presses in a row that heard nothing while the sound was there, before the app asks to go online. */
export const PHONE_MISSES = 2;

/**
 * What one press on the phone's recogniser says about it. session: {heard (words came, live or final),
 * noSpeech (it ended with no-speech), holdMs, loud (level readings at SOUND_LEVEL or over)}. 'heard'
 * when words came; 'missed' when it heard nothing in a press long enough and loud enough; else null (a
 * tap, a silent press, any other error), which says nothing either way.
 */
export function phoneHeard(session) {
  if (session?.heard) return 'heard';
  if (session?.noSpeech && session.holdMs >= SOUND_HOLD_MS && session.loud >= SOUND_READINGS) return 'missed';
  return null;
}

/** The misses in a row after this press: words reset them, a miss adds one, anything else keeps them. */
export function nextMisses(misses, session) {
  const r = phoneHeard(session);
  return r === 'heard' ? 0 : r === 'missed' ? (misses ?? 0) + 1 : (misses ?? 0);
}

/**
 * After a press on the phone's recogniser: the misses in a row to keep, and whether to ask now if the
 * voice may go online. It asks when this press makes PHONE_MISSES in a row, another way can hear this
 * phone (otherWay: pickVoiceIn with phoneOff gives one, under the Private only rule), and the person was
 * never asked (phoneAsked) and did not go online already (phoneOff). Once asked, nothing is counted.
 * Nothing is switched here: only the person's yes sets phoneOff.
 */
export function afterPhonePress(settings, session, otherWay) {
  if (settings?.phoneAsked || settings?.phoneOff) return { misses: settings.phoneMisses ?? 0, ask: false };
  const misses = nextMisses(settings?.phoneMisses, session);
  const ask = misses >= PHONE_MISSES && !!otherWay;
  return { misses: ask ? 0 : misses, ask };
}

/** True when these presses, in order, end PHONE_MISSES or more misses in a row (where the app would ask). */
export const asksToGoOnline = (sessions) => sessions.reduce(nextMisses, 0) >= PHONE_MISSES;
