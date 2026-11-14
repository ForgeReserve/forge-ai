// Hold to talk and read aloud, wired to the app: drives the recorder state machine (core/talk.js) from
// the talk button, runs the chosen voice-in module, sends what was heard as the question, and reads the
// answer aloud with the chosen voice-out module. The recording lives in memory only and is dropped once
// it is sent or cancelled.
import { step, initial } from './talk.js';
import { speechPieces } from './speech.js';

const HAPTIC = { start: 15, leave: [8, 40, 8], back: 8, send: 25, cancel: [20, 60, 20] };
const TICK_MS = 100;

/**
 * deps: store ({S, set}), t, ui, nav, haptics, voiceIn() and voiceOut() (the chosen module instance or
 * null), blocker() (null, or {key, go} when a question cannot be asked now), ask(text, meta),
 * refresh() (the balance), errorText(err, unit), now(), and askDownload(bytes) (resolves true when the
 * person agrees to the one-time download a voice needs before its first use).
 */
export function createTalk({ store, t, ui, nav, haptics, voiceIn, voiceOut, blocker, ask, refresh, errorText, now = () => Date.now(), askDownload = async () => false }) {
  const S = store.S;
  S.talk = { ...initial(), level: 0, seconds: 0, text: '', error: null };
  S.speaking = { key: null, state: 'idle' };

  let rec = null; // {mod, ready: Promise<session|null>, session, dropped}
  let timer = 0;
  let sending = null; // AbortController while the recording is being turned into text
  let speech = null; // {key, ctl}
  let asking = null; // the read waiting for the answer to the download question
  let declined = false; // the download was refused: answers are not read on their own until Listen

  const set = (patch) => store.set({ talk: { ...S.talk, ...patch } });

  function dispatch(ev) {
    const { s, effects } = step(S.talk, ev);
    S.talk = { ...S.talk, ...s, ...(s.phase === 'idle' ? { at: undefined, inside: undefined } : {}) };
    for (const e of effects) run(e);
    store.set({});
  }

  function run(effect) {
    if (effect.startsWith('haptic:')) return haptics.pulse(HAPTIC[effect.slice(7)]);
    switch (effect) {
      case 'start':
        return start();
      case 'discard':
        return discard();
      case 'send':
        return send();
      case 'explain':
        return ui.toast(t('talk.explain'), 4500);
      case 'cancelled':
        return ui.toast(t('talk.cancelled'));
      case 'maxed':
        return ui.toast(t('talk.maxed'));
      default:
        return undefined;
    }
  }

  function stopTimer() {
    clearInterval(timer);
    timer = 0;
  }

  function start() {
    const mod = voiceIn();
    S.talk.error = null;
    S.talk.level = 0;
    S.talk.seconds = 0;
    S.talk.text = '';
    stopSpeaking();
    const r = { mod, session: null, dropped: false };
    r.ready = mod
      .start({ onLevel: (l) => (S.talk.level = l), onText: (text) => (S.talk.text = text) })
      .then((session) => {
        if (r.dropped) {
          session.cancel();
          return null;
        }
        r.session = session;
        return session;
      })
      .catch((e) => {
        if (rec === r && S.talk.phase === 'recording') {
          ui.toast(t(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'talk.micBlocked' : 'talk.micFailed'), 4500);
          dispatch({ type: 'failed' });
        }
        return null;
      });
    rec = r;
    stopTimer();
    timer = setInterval(() => {
      if (S.talk.phase !== 'recording') return stopTimer();
      S.talk.seconds = (now() - S.talk.at) / 1000;
      dispatch({ type: 'tick', at: now(), maxMs: mod.maxSeconds() * 1000 });
    }, TICK_MS);
  }

  function discard() {
    stopTimer();
    const r = rec;
    rec = null;
    if (!r) return;
    r.dropped = true;
    r.session?.cancel();
  }

  async function send() {
    stopTimer();
    const r = rec;
    rec = null;
    nav('answer');
    const session = r ? await r.ready : null;
    if (!session) {
      // The microphone never started (refused, or let go before it was ready).
      dispatch({ type: 'failed' });
      return;
    }
    const ctrl = new AbortController();
    sending = ctrl;
    try {
      const out = await session.finish({ signal: ctrl.signal });
      sending = null;
      if (out.balanceMsub != null) store.set({ balanceMsub: out.balanceMsub });
      const text = String(out.text ?? '').trim();
      dispatch({ type: 'done' });
      if (!text) {
        set({ error: { key: 'talk.empty' } });
        return;
      }
      await ask(text, { voice: true });
    } catch (e) {
      sending = null;
      if (ctrl.signal.aborted || e?.name === 'AbortError') {
        dispatch({ type: 'done' });
        ui.toast(t('talk.cancelled'));
        return;
      }
      dispatch({ type: 'failed' });
      set({ error: { code: e?.code ?? 'other', message: e?.message ?? String(e), charged: e?.status > 0 ? 0 : null } });
      refresh();
    }
  }

  // ---------------------------------------------------------------- the talk button

  function down() {
    if (S.talk.phase !== 'idle') return;
    const b = blocker();
    if (b) {
      ui.toast(t(b.key), 3500);
      if (b.go) b.go();
      return;
    }
    dispatch({ type: 'down', at: now() });
  }

  const up = () => dispatch({ type: 'up', at: now() });
  const move = (isInside) => dispatch({ type: 'move', inside: isInside });

  function cancel() {
    if (S.talk.phase === 'recording') return dispatch({ type: 'cancel' });
    if (S.talk.phase === 'sending') sending?.abort();
  }

  // ---------------------------------------------------------------- reading answers aloud

  function pieces(msg, mod) {
    return speechPieces(msg?.content ?? '', mod.pieceSize());
  }

  /** What reading this answer aloud costs now: 0 when free or already here, null when it cannot be read. */
  function speakPrice(msg) {
    const mod = voiceOut();
    if (!mod || !msg?.content) return null;
    return mod.price(pieces(msg, mod), msg.id);
  }

  /**
   * Reads an answer aloud. auto: the app reads the answer to a voice question on its own. A voice that
   * needs a download first (the natural voice, the first time) asks once; refused, answers are not read
   * on their own again until the person taps Listen.
   */
  function speak(msg, { auto = false } = {}) {
    const mod = voiceOut();
    if (!mod || !msg?.content) return;
    stopSpeaking();
    if (!mod.download) return play(mod, msg);
    const ticket = {};
    asking = ticket;
    (async () => {
      const d = await mod.download().catch(() => ({ needed: false }));
      if (asking !== ticket) return;
      if (d.needed) {
        if (auto && declined) return;
        const ok = await askDownload(d.bytes);
        if (asking !== ticket) return;
        declined = !ok;
        if (!ok) return;
      }
      asking = null;
      play(mod, msg);
    })();
  }

  function play(mod, msg) {
    const key = msg.id;
    const onProgress = (f) => speech?.ctl === ctl && store.set({ speaking: { key, state: 'loading', progress: Math.min(99, Math.floor(f * 100)) } });
    const ctl = mod.speak(pieces(msg, mod), { key, onState: (state) => store.set({ speaking: { key, state } }), onProgress });
    speech = { key, ctl };
    store.set({ speaking: { key, state: 'loading' } });
    ctl.done
      .then((r) => {
        if (r?.chargedMsub) refresh();
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        ui.toast(e?.code ? errorText({ code: e.code, message: e.message, charged: 0 }) : t('speak.failed'), 4000);
        refresh();
      })
      .finally(() => {
        if (speech?.ctl === ctl) {
          speech = null;
          store.set({ speaking: { key: null, state: 'idle' } });
        }
      });
  }

  function stopSpeaking() {
    asking = null;
    if (!speech) return;
    const s = speech;
    speech = null;
    s.ctl.stop();
    store.set({ speaking: { key: null, state: 'idle' } });
  }

  return {
    down,
    up,
    move,
    cancel,
    speak,
    stopSpeaking,
    speakPrice,
    clearError: () => S.talk.error && set({ error: null }),
  };
}
