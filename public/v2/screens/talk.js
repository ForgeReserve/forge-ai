// The hold-to-talk button (ZHome1, XListenLight): press and hold to record, let go to send, slide off
// and let go to cancel. A tap explains it. While it records, the button shows level bars and "Let go to
// send", and a line under the rings gives the time, where the sound goes and the price before sending.
// With no way to turn voice into words here, the button opens Type, so it never leads nowhere.
// Works with a finger, a mouse, and the keyboard (hold Space or Enter; Escape cancels).
import { clock, inside } from '../core/talk.js';
import { priceLine } from '../core/price.js';
import { el, icon } from '../core/ui.js';

const BARS = 9;
const SHAPE = [0.45, 0.7, 0.9, 0.6, 1, 0.65, 0.85, 0.55, 0.4];

/**
 * Makes `button` the talk button. size: 'big' (home) or 'small' (answer). Returns {info, update}:
 * `info` is the line shown under the rings while recording.
 */
export function holdToTalk(button, { t, state, actions, nav, hintId, size = 'big' }) {
  const mic = icon('mic', size === 'big' ? 69 : 34, 1.6);
  const bars = el('span', { class: 'level-bars', 'aria-hidden': 'true', hidden: true }, ...Array.from({ length: BARS }, () => el('span', { class: 'bar' })));
  const label = el('span', { class: 'talk-label' });
  button.replaceChildren(mic, bars, label);
  const hint = el('p', { class: 'sr-only', id: hintId });

  const time = el('p', { class: 'listen-time', id: size === 'big' ? 'talkTime' : 'replyTime' });
  const heard = el('p', { class: 'listen-text', hidden: true });
  const route = el('span', { class: 'listen-route' });
  const price = el('span', { class: 'listen-price', id: size === 'big' ? 'talkPrice' : 'replyPrice' });
  const info = el('div', { class: 'listen-info', role: 'status', hidden: true }, heard, time, el('p', { class: 'listen-foot' }, route, price));

  let rect = null;
  let active = false; // this button started the recording
  const ok = () => state.view().talk.available;

  const begin = () => {
    rect = button.getBoundingClientRect();
    active = true;
    actions.talkDown();
  };
  const end = () => {
    if (!active) return;
    active = false;
    actions.talkUp();
  };

  button.addEventListener('pointerdown', (e) => {
    if (!ok() || e.button > 0 || active) return;
    e.preventDefault();
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    begin();
  });
  button.addEventListener('pointermove', (e) => {
    if (active && rect) actions.talkMove(inside(rect, e.clientX, e.clientY));
  });
  button.addEventListener('pointerup', (e) => {
    if (!active) return;
    if (rect) actions.talkMove(inside(rect, e.clientX, e.clientY));
    end();
  });
  button.addEventListener('pointercancel', () => {
    if (!active) return;
    active = false;
    actions.talkCancel();
  });
  // A long press must not open the text menu or select the label.
  button.addEventListener('contextmenu', (e) => ok() && e.preventDefault());
  button.addEventListener('keydown', (e) => {
    if (!ok()) return;
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      if (!active) {
        rect = null;
        active = true;
        actions.talkDown();
      }
    } else if (e.key === 'Escape' && active) {
      active = false;
      actions.talkCancel();
    }
  });
  button.addEventListener('keyup', (e) => {
    if (ok() && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      end();
    }
  });
  button.addEventListener('blur', () => {
    if (active && !rect) {
      active = false;
      actions.talkCancel();
    }
  });
  button.addEventListener('click', (e) => {
    // With voice, the press does the work. Without it, a tap opens Type.
    if (ok()) e.preventDefault();
    else nav('type');
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden' && active) {
      active = false;
      actions.talkCancel();
    }
  };
  document.addEventListener('visibilitychange', onHide);

  const update = () => {
    const v = state.view();
    const tk = v.talk;
    const recording = tk.phase === 'recording';
    if (!recording) active = false;
    button.classList.toggle('recording', recording);
    button.classList.toggle('leaving', recording && !tk.inside);
    button.classList.toggle('sending', tk.phase === 'sending');
    button.dataset.phase = tk.phase;
    mic.style.display = recording ? 'none' : '';
    bars.hidden = !recording;
    if (recording) [...bars.children].forEach((b, i) => b.style.setProperty('--h', String(Math.max(0.12, Math.min(1, tk.level * 1.6 * SHAPE[i])))));
    label.textContent = recording ? (tk.inside ? t('talk.letGo') : t('talk.letGoCancel')) : tk.phase === 'sending' ? t('talk.sending') : t('home.talk');
    hint.textContent = tk.available ? t('home.talkHintVoice') : t('home.talkHint');
    info.hidden = !recording;
    if (recording) {
      const ms = tk.seconds * 1000;
      time.textContent = tk.inside ? t('talk.recording', { time: clock(ms) }) : t('talk.leaving', { time: clock(ms) });
      heard.hidden = !tk.text;
      heard.textContent = tk.text;
      route.textContent = t({ phone: 'talk.routePhone', 'engine-private': 'talk.routePrivate', 'engine-standard': 'talk.routeStandard', device: 'talk.routeDevice' }[tk.route] ?? 'talk.routeStandard');
      route.dataset.route = tk.route ?? '';
      // The engine's speech to text is paid, so a voice question reads as free only when the phone (or the browser) hears it.
      const p = priceLine(tk.priceMsub, tk.unit, tk.freeOk ? v.free : null);
      price.textContent = t(p.key, p);
    }
  };
  update();
  const destroy = () => {
    document.removeEventListener('visibilitychange', onHide);
    // Leaving the screen while holding (the back button, say) cancels: nothing is sent unseen.
    if (active && state.view().talk.phase === 'recording') actions.talkCancel();
    active = false;
  };
  return { info, hint, update, destroy };
}
