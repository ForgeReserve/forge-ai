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
 * refresh() (the balance), errorText(err, unit), now(), askDownload(bytes) (resolves true when the
 * person agrees to the one-time download a voice needs before its first use), showDownload(bytes) (opens the
 * download's progress and returns {progress(p), fail(message, retry) -> shown, close()}), and
 * unlockAudio(), called
 * inside every tap that may lead to sound, before anything is awaited (iPhone Safari starts sound only
 * there: adapters.js speaker.unlock), phoneVoice() (the phone's own voice-out module, or null) and
 * naturalDeclined {get(), set()} (Not now on the natural voice's offer, kept on the phone).
 *
 * Listen speaks at once (owner, 2026-11-15): while the natural voice is not on the phone yet, the phone's
 * own voice reads the answer, and the natural voice is offered after, as an upgrade (S.voiceOffer, shown
 * under Listen), until the person gets it or says Not now. Only a phone with no voice of its own asks
 * before the download, as before.
 */
export function createTalk({ store, t, ui, nav, haptics, voiceIn, voiceOut, blocker, ask, refresh, errorText, now = () => Date.now(), askDownload = async () => false, showDownload = () => null, unlockAudio = () => {}, phoneVoice = () => null, naturalDeclined = { get: () => false, set: () => {} } }) {
  const S = store.S;
  S.talk = { ...initial(), level: 0, seconds: 0, text: '', error: null };
  S.speaking = { key: null, state: 'idle' };
  // {bytes}: the natural voice is offered under Listen (its size), or null.
  S.voiceOffer = null;

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
      // A free voice question: the engine says how many are left today.
      if (out.freeVoiceLeft != null && S.freeVoice) store.set({ freeVoice: { ...S.freeVoice, left: out.freeVoiceLeft } });
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
      // A voice-in module may name the words for its own failure (key); else the engine's error says it.
      set({ error: e?.key ? { key: e.key } : { code: e?.code ?? 'other', message: e?.message ?? String(e), charged: e?.status > 0 ? 0 : null } });
      refresh();
    }
  }

  // ---------------------------------------------------------------- the talk button

  function down() {
    unlockAudio();
    if (S.talk.phase !== 'idle') return;
    const b = blocker();
    if (b) {
      ui.toast(t(b.key), 3500);
      if (b.go) b.go();
      return;
    }
    dispatch({ type: 'down', at: now() });
  }

  // Letting go is the tap the answer is read after: the sound is unlocked here, the answer comes later.
  const up = () => {
    unlockAudio();
    dispatch({ type: 'up', at: now() });
  };
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
   * on their own again until the person taps Listen. retry: Try again after a failed download, which
   * the person already agreed to (no second question).
   */
  function speak(msg, { auto = false, retry = false, natural = false } = {}) {
    if (!auto) unlockAudio();
    const mod = voiceOut();
    if (!mod || !msg?.content) return;
    stopSpeaking();
    if (!mod.download) return play(mod, msg);
    const ticket = {};
    asking = ticket;
    (async () => {
      const d = await mod.download().catch(() => ({ needed: false }));
      if (asking !== ticket) return;
      let view = null;
      if (d.needed) {
        const phone = retry || natural ? null : phoneVoice();
        if (phone) {
          // The phone's own voice reads now; the natural voice waits for the person to ask for it.
          asking = null;
          if (!naturalDeclined.get()) store.set({ voiceOffer: { bytes: d.bytes ?? 0 } });
          return play(phone, msg);
        }
        if (auto && declined) return;
        const ok = retry || natural || (await askDownload(d.bytes));
        if (asking !== ticket) return;
        declined = !ok;
        if (!ok) return;
        // The download the person agreed to: its progress shows until the voice starts reading.
        view = showDownload(d.bytes);
      }
      asking = null;
      if (S.voiceOffer) store.set({ voiceOffer: null });
      play(mod, msg, view);
    })();
  }

  /** Get on the natural voice's offer: it downloads now (its progress shows), then reads the answer. */
  function getNatural(msg) {
    unlockAudio();
    store.set({ voiceOffer: null });
    if (msg?.content) speak(msg, { natural: true });
  }

  /** Not now on the offer: kept, so it is not offered on every Listen. */
  function naturalNotNow() {
    naturalDeclined.set();
    store.set({ voiceOffer: null });
  }

  /**
   * p: {loaded, total, fraction, phase} from the voice module, while it downloads and gets ready, then
   * {fraction, phase: 'buffering'} while a slow phone makes sound ahead before the start.
   */
  function play(mod, msg, view = null) {
    const key = msg.id;
    let ctl = null;
    const onProgress = (p) => {
      if (speech?.ctl !== ctl) return;
      const pct = Math.min(99, Math.floor((p?.fraction ?? 0) * 100));
      if (p?.phase === 'buffering') return store.set({ speaking: { key, state: 'buffering', progress: pct } });
      view?.progress(p);
      store.set({ speaking: { key, state: 'loading', progress: pct } });
    };
    const onState = (state) => {
      if (state === 'playing' || state === 'buffering') view?.close();
      if (state === 'buffering' && S.speaking?.state === 'buffering') return;
      store.set({ speaking: { key, state } });
    };
    // The natural voice is too slow on this phone for this answer, so the phone's own voice reads it:
    // said once a session, in plain words (More, Voice can keep the natural voice anyway).
    const onNotice = (kind) => {
      if (kind !== 'slow' || slowSaid) return;
      slowSaid = true;
      ui.toast(t('speak.slowPhone'), 6000);
    };
    // Loading first: a voice that starts at once (the phone's own) says so from inside speak().
    store.set({ speaking: { key, state: 'loading' } });
    ctl = mod.speak(pieces(msg, mod), { key, onState, onProgress, onNotice });
    speech = { key, ctl, view };
    ctl.done
      .then((r) => {
        if (r?.chargedMsub) refresh();
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return view?.close();
        // A failed download says why, with Try again, in the window that showed its progress.
        if (view && e?.name !== 'AudioBlocked' && !e?.code && view.fail(e?.message ?? String(e), () => speak(msg, { retry: true }))) return;
        view?.close();
        if (e?.name === 'AudioBlocked') return ui.toast(t('speak.blocked'), 4500);
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

  let slowSaid = false;

  function stopSpeaking() {
    asking = null;
    if (!speech) return;
    const s = speech;
    speech = null;
    s.ctl.stop();
    s.view?.close();
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
    getNatural,
    naturalNotNow,
    clearError: () => S.talk.error && set({ error: null }),
  };
}
