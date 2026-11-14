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
