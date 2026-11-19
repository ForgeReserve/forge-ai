// Forge AI v2. Plain ES modules, no build step, nothing loaded from another origin.
// The app shell: loads the bundled modules through the registry, applies the look, talks to the engine,
// keeps the state and draws one screen at a time from the hash route.
import { fmtBalance, fmtCost, fmtInt, fmtUnits } from '../js/ui.js';
import { kindOf, MAX_FILES, BODY_LIMIT } from '../js/files.js';
import { lockKey } from '../js/lockkey.js';
import * as QR from '../js/qr.js';
import { adapters, setAdapter } from './core/adapters.js';
import { againHistory, lastExchange, memoryView, pendingMessage, apiMessages, systemPromptFor, tokensOf } from './core/conversation.js';
import { chats, kv, onErasedElsewhere, shutdown } from './core/db.js';
import { eraseEverything, isEmpty, leftovers } from './core/erase.js';
import { SEEN_KEY, SEEN_VALUE, shouldShow, STEP_ROUTES, stepOfRoute } from './core/firstrun.js';
import { createSweeper, lastUsed } from './core/history.js';
import { chatPayload, createEngine, EngineError, tinfoilFetch } from './core/engine.js';
import { createNative, defaultEngine, followBars, reloadForIsolation } from './core/native.js';
import { freeInfo, freeKeyName, freeLeft, freeMaxTokens, fundsBlock, isCreditMint, nextFreeTotal, useFree } from './core/free.js';
import { isJoinHash, joinPlan, passFrom } from './core/join.js';
import { tokenKind } from './core/fedinote.js';
import { readNote } from './core/note.js';
import { createTillPays, createTillSettings } from './core/till.js';
import { chargedFor, errorView } from './core/errors.js';
import { t } from './core/i18n.js';
import { MAX_IMAGES, shrinkImage } from './core/image.js';
import { SHARE_CACHE } from './core/photo.js';
import { ehbpBytes, estimate, freeModelChoice, holdMsub, isFreeModel, perQuestion, voicePriceLine } from './core/price.js';
import { SPEAK_MAX_CHARS } from './core/speech.js';
import { watchViewport } from './core/viewport.js';
import { afterPhonePress } from './core/talk.js';
import { createTalk } from './core/talkctl.js';
import { createClips } from './core/clips.js';
import { createPhonon, meterNumbers as phononMeter } from './core/phonon.js';
import { audioModels, audioMsub, CHARS_PER_SECOND, transcribeMsub } from './core/voice.js';
import { refundsToOffer } from './core/refunds.js';
import { asideKeys, cannotPay, homeTotal, key2Name, keysByUnit, landsIn, newKey, newKeysName, payUnit, prepareFunding, questionsOver, UNITS, unitsPending, withAside, withKey, withoutKey } from './core/balances.js';
import { BUNDLED, bundledLoader, createRegistry } from './core/registry.js';
import { fundsSegments, nextPeak } from './core/rings.js';
import { href, parentOf, parse } from './core/router.js';
import { createUpdater } from './core/updates.js';
import { choiceOf, createStore, DEFAULT_SETTINGS, fastPick, hiddenCount, isPrivate, keyName, kindSwitch, loadedSettings, pickMode, pickModel, pickVoiceIn, pickVoiceOut, visibleModels } from './core/state.js';
import * as ui from './core/ui.js';
import { createVault, retryPending, topupWithVault } from './core/vault.js';
import { settlePendingForeign } from './modules/fund/kit.js';
import { engineScreen } from './screens/engine.js';
import { eraseScreen, erasedScreen } from './screens/erase.js';
import { firstRunScreen } from './screens/firstrun.js';
import { freeOutScreen } from './screens/free.js';
import { fundScreen, fundsScreen, takeOutScreen } from './screens/funds.js';
import { askSheet } from './screens/parts.js';
import { askStandard, inviteError, startFreeScreen } from './screens/startfree.js';
import { walletScreen } from './screens/wallet.js';
import { historyScreen } from './screens/history.js';
import { photoScreen } from './screens/photo.js';
import { lookScreen, modelScreen, voiceScreen } from './screens/settings.js';
import { addSheet, moreSheet } from './screens/sheets.js';
import { typeScreen } from './screens/type.js';

const MAX_OUT = 4096; // the most output a question asks for; the engine holds the worst case up front (questionHold)
const MODELS_CACHE = 'forge2.models';
const LOOK_CACHE = 'forge2.look';
// The mode in use when it is not Default, read by index.html to paint its ground before the app loads.
const MODE_CACHE = 'forge2.mode';
// The cover game's name while the mode opens on it (docs/PLAYFUL.md), for index.html's first frame and title.
const COVER_CACHE = 'forge2.cover';

// ------------------------------------------------------------------ storage that survives a reload

// Set by Erase everything: from then on nothing is written anywhere, so a late write cannot bring back
// what was erased, and no screen is drawn but the Erased one.
let erased = false;
/** ui.store, unless everything was erased. */
const keep = (k, v) => !erased && ui.store(k, v);

const storage = {
  getItem: (k) => ui.load(k),
  setItem: (k, v) => {
    if (erased) throw new Error('erased');
    // The vault must know when a write fails, so this one does not swallow errors.
    localStorage.setItem(k, v);
  },
};
const vault = createVault(storage);

// ------------------------------------------------------------------ state

const store = createStore({
  // The paid balances (core/balances.js): up to two keys, one per unit, as kept on the phone (the two
  // storage names, in order), each key's unit once the engine said it, and each unit's balance:
  // {balanceMsub, availableMsub, freeVoice}. The gold ring's full mark is kept per unit (peaks).
  keys: [null, null],
  keyUnits: {},
  bal: { usd: null, sat: null },
  peaks: { usd: null, sat: null },
  // Free voice questions left today on the home balance (the one a free voice question goes on).
  freeVoice: null,
  // The engine refused to open the second balance with the first one's key this session: money in that
  // unit is changed into the balance the phone has instead, as on an engine without two balances.
  siblingRefused: false,
  models: [],
  audioModels: [],
  // Search the web, for the next question only: off by default, and off again once a question is sent.
  search: false,
  inviteOnly: false,
  units: [],
  mints: [],
  mintAliases: [],
  methods: null,
  invite: '',
  settings: { ...DEFAULT_SETTINGS },
  conv: { id: null, messages: [] },
  pending: [],
  draft: '',
  streaming: false,
  // Free questions (core/free.js): the free balance's own key, its balance, how many were added, and
  // the engine's free tier from /v1/models.
  freeKey: null,
  freeMsub: null,
  freeTotal: 0,
  free: null,
  online: navigator.onLine !== false,
  // The cover game's own record (docs/PLAYFUL.md): read at start, kept in the database beside the settings.
  game: null,
});
const S = store.S;

// Inside the Android app (core/native.js): its share sheet, photos shared in, and Forge's engine as the
// default, since the app's own origin (https://localhost) has no engine. null on the website. The iPhone
// app (capacitor://localhost) has Forge's engine as the default and the website's share sheet, with Save
// to Photos in place of the download.
const native = createNative();
if (native?.share) setAdapter('share', { ...adapters.share, ...native.share });

const engineBase = () => S.settings.engine || defaultEngine(native);

// The natural voice made on the phone (core/phonon.js). Its files are on this app's own address, or in
// the APK in the Android app, where there is nothing to download. It runs on the graphics chip or the
// processor (core/phonon.js chooseVoiceDevice); a WebGPU failure is remembered in the settings
// (voiceDevice), so the next start goes straight to the processor.
// In the Android app, native code makes the voice where the phone runs it (core/native.js nativeVoice).
// How fast this phone makes it is kept in the settings (voicePace), so a slow phone waits for sound in
// hand, or reads with its own voice, from the first word of the next answer (core/voicepace.js).
const phonon = createPhonon({
  native: !!native,
  nativeVoice: native?.voice ?? null,
  pace: {
    get: () => S.settings.voicePace || null,
    set: (v) => {
      S.settings.voicePace = v;
      saveSettings();
    },
  },
  prefs: () => ({ preferNatural: !!S.settings.preferNatural }),
  voice: () => S.settings.naturalVoice || null,
  memory: {
    get: () => S.settings.voiceDevice || null,
    set: (v) => {
      S.settings.voiceDevice = v;
      saveSettings();
    },
  },
});
let engine = createEngine({ base: engineBase(), encryptedFetch: tinfoilFetch(engineBase()) });
const keyStore = () => keyName(engine.base, location.origin);
const keyStore2 = () => key2Name(engine.base, location.origin);
const newKeysStore = () => newKeysName(engine.base, location.origin);
const freeKeyStore = () => freeKeyName(engine.base, location.origin);

// ------------------------------------------------------------------ the two balances (core/balances.js)

/** The balance key in each unit, as the engine said it: {usd, sat}, a key or null. */
const keys = () => keysByUnit(S.keys, S.keyUnits);
const keyFor = (unit) => keys()[unit] ?? null;
/** True when the phone keeps a paid balance key, read from the engine yet or not. */
const anyKey = () => S.keys.some(Boolean);
/** A unit's balance as the engine last said it, or null when the phone has none in that unit (or it was not read yet). */
const balOf = (unit) => (keyFor(unit) && S.bal[unit]) || null;
/** What a balance can pay now (the funds not held already), or null without one. */
const availOf = (unit) => {
  const b = balOf(unit);
  return b ? (b.availableMsub ?? b.balanceMsub ?? null) : null;
};
/** The home's one total (core/balances.js homeTotal), or null before any balance was read. */
const total = () => {
  const one = (u) => (balOf(u) ? { balanceMsub: balOf(u).balanceMsub, peakMsub: S.peaks[u] } : null);
  return homeTotal({ usd: one('usd'), sat: one('sat'), btcUsd: S.btcUsd });
};
/** The unit the home speaks in: the total's, else the balance kept first (dollars first), else dollars. */
const homeUnit = () => total()?.unit ?? UNITS.find((u) => keyFor(u)) ?? 'usd';
/** The key of the home's balance: the one a question no balance can pay is sent with (the engine says it is short). */
const homeKey = () => keyFor(homeUnit()) ?? S.keys.find(Boolean) ?? null;

/**
 * The balance that pays a request whose hold in a unit is holdIn(unit) (core/balances.js payUnit): dollars
 * first, sats when dollars cannot cover it, and sats only with a BTC/USD rate. When neither covers it
 * alone, pays is false and the home's balance stands in, so the price is shown in its unit.
 * Returns {unit, key, costMsub, pays}.
 */
function payerFor(holdIn) {
  const raw = { usd: holdIn('usd'), sat: holdIn('sat') };
  const unit = payUnit({ available: { usd: availOf('usd'), sat: availOf('sat') }, hold: { usd: raw.usd, sat: S.btcUsd > 0 ? raw.sat : null } });
  const shown = unit ?? homeUnit();
  return { unit: shown, key: keyFor(shown) ?? homeKey(), costMsub: raw[shown], pays: !!unit };
}

/** The unit prices are shown in before a question is written: the balance that would pay a typical one. */
function priceUnit(model) {
  return model ? payerFor((u) => perQuestion(model, u)).unit : homeUnit();
}

/**
 * Balance keys kept aside on this phone (core/balances.js withAside): a third key that had no place, and
 * keys the engine stopped knowing. Erase everything removes them too, so it counts them.
 */
const keysAside = () => [...new Set([...asideKeys(ui.load('forge2.extraKeys')), ...asideKeys(ui.load('forge2.unrecognizedKeys')), ...asideKeys(ui.load('forge.unrecognizedKey'))])];

/**
 * The paid balances Funds lists, each as its own row with its own Take out: those with money in them,
 * dollars first. {unit, balanceMsub, text, refundable}.
 */
function fundsRows() {
  return UNITS.filter((u) => balOf(u)?.balanceMsub > 0).map((u) => {
    const b = balOf(u);
    return { unit: u, balanceMsub: b.balanceMsub, text: fmtBalance(b.balanceMsub, u), refundable: Math.floor((b.availableMsub ?? b.balanceMsub ?? 0) / 1000) };
  });
}

// ------------------------------------------------------------------ derived view

/**
 * The system prompt for a question ending these messages: the eCash paragraph once the person brings
 * eCash or payments up, and the voice instruction for a question asked by voice, so the answer that is
 * read aloud is short and plain (core/conversation.js).
 */
const promptFor = (msgs) => systemPromptFor(msgs, { base: t('system.prompt'), ecash: t('system.prompt.ecash'), voice: t('system.prompt.voice') });

let memo = { k: '', v: null };
function memoryNow(model) {
  // A conversation the next question leaves (freshNext) no longer counts against the new model's memory.
  const fresh = leavingConv();
  const k = `${S.conv.id}|${S.conv.messages.length}|${S.streaming}|${S.pending.map((a) => a.id + a.status).join(',')}|${model?.id}|${fresh}`;
  if (memo.k !== k) memo = { k, v: memoryView(fresh ? [] : S.conv.messages, S.pending, { systemPrompt: t('system.prompt'), vision: !!model?.capabilities?.vision, contextLength: model?.context_length }) };
  return memo.v;
}

let againMemo = { k: '', models: null, audioModels: null, v: null };
/** What Ask again would cost now ({msub, unit}), or null while an answer streams or with nothing to ask again. */
function againNow(model) {
  if (S.streaming || !model) return null;
  const msgs = S.conv.messages;
  const voice = msgs.findLast?.((m) => m.role === 'user')?.meta?.voice ? 'v' : '';
  // What each balance can pay is part of the key: it decides which one pays, and so the unit.
  const k = `${S.conv.id}|${msgs.length}|${model.id}|${availOf('usd')}|${availOf('sat')}|${S.btcUsd}|${msgs.at(-1)?.meta?.error ? 'e' : ''}|${voice}|${voiceOut()?.id ?? ''}|${leavingConv()}`;
  // The price lists are part of the key by identity: the cached list is replaced by the live one (new
  // prices under the same model id) when the engine answers.
  if (againMemo.k !== k || againMemo.models !== S.models || againMemo.audioModels !== S.audioModels) againMemo = { k, models: S.models, audioModels: S.audioModels, v: estimateAgain(model) };
  return againMemo.v;
}

/** Free questions as the screens see them: how many are left, and whether the next question uses one. */
function freeNow(model, inputTokens = 0) {
  const left = freeLeft(S.freeMsub);
  const u = useFree({ info: S.free, left, model, inputTokens });
  return { left, total: Math.max(left, S.freeTotal ?? 0), use: u.use, why: u.use ? null : u.why };
}

function view() {
  const model = pickModel(S.models, S.settings);
  // One total for the home (core/balances.js homeTotal): one balance in its own unit, both in dollars.
  const tot = total();
  const unit = tot?.unit ?? homeUnit();
  const mem = memoryNow(model);
  const hasKey = anyKey();
  const fr = freeNow(model);
  const paidNone = !hasKey || tot?.balanceMsub === 0;
  // A free model (core/price.js isFreeModel): nothing to pay, but the engine wants a balance key.
  const modelFree = isFreeModel(model);
  // The gold ring is the total over the full marks of both balances, in the total's unit.
  const seg = fundsSegments({ balanceMsub: hasKey ? (tot?.balanceMsub ?? null) : 0, peakMsub: tot?.peakMsub ?? null, freeLeft: fr.left, freeTotal: fr.total, perQuestionMsub: perQuestion(model, unit) });
  const rows = fundsRows();
  const again = againNow(model);
  return {
    model,
    // With no model to use, Private only still decides: nothing is sent to a standard model.
    private: model ? isPrivate(model) : !!S.settings.privateOnly,
    online: S.online,
    hasKey,
    balanceMsub: hasKey ? (tot?.balanceMsub ?? null) : null,
    balanceText: hasKey && tot?.balanceMsub != null ? fmtBalance(tot.balanceMsub, unit) : null,
    // The total's unit, and the paid balances that hold money, each a row on Funds (two when both do).
    unit,
    balances: rows,
    // How many balance keys are kept aside (keysAside): Erase everything warns about them.
    keysAside: keysAside().length,
    // The gold ring: free questions as a lighter segment first, then the paid balance (core/rings.js).
    fundsFraction: seg.paid,
    freeFraction: seg.free,
    freeLeft: fr.left,
    freeTotal: fr.total,
    // What stops a question for lack of funds, if anything (core/free.js fundsBlock). Never funds on a free
    // model: only the balance key it needs ('needKey').
    fundsBlock: fundsBlock({ paidMsub: paidNone ? 0 : (tot?.balanceMsub ?? null), freeLeft: fr.left, freeTotal: fr.total, freeUsable: fr.use, freeModel: modelFree, hasKey }),
    modelFree,
    // Start free (screens/startfree.js): this engine has free models, which a $0 balance opened with an
    // invite code can use. Offered while there is no key or the balance is at 0 on a paid model.
    startFree: !!S.methods?.open?.enabled,
    // No funds at all (no balance yet or a balance at zero, and no free questions): the home and Funds
    // show their empty state, and the gold ring invites a paper note scan.
    noFunds: paidNone && fr.left === 0,
    scanNote: paidNone && fr.left === 0 && !!registry?.list('fund').some((x) => x.instance.id === 'note'),
    // What can be taken out of the one balance with money (Take out; with two, each row has its own).
    refundable: rows.length === 1 ? rows[0].refundable : 0,
    // Questions left over both balances, each paying whole questions; the sats only with a rate.
    questionsLeft: hasKey ? questionsOver({ usd: balOf('usd')?.balanceMsub, sat: balOf('sat')?.balanceMsub }, { usd: perQuestion(model, 'usd'), sat: perQuestion(model, 'sat') }, S.btcUsd > 0) : 0,
    memory: mem,
    held: mem.held,
    pendingCount: S.pending.length,
    lastExchange: lastExchange(S.conv.messages),
    streaming: S.streaming,
    hiddenCount: hiddenCount(S.models, S.settings),
    talk: talkView(model, priceUnit(model)),
    // Search the web: offered when the model can search; on for the next question only.
    search: { available: canSearch(model), on: searchOn(model) },
    speak: speakView(),
    // The most Ask again can cost, shown on the button before it is pressed, in the unit of the balance that pays it.
    againMsub: again?.msub ?? null,
    againUnit: again?.unit ?? unit,
    // A free question in place of the balance: the price lines read "Free, 2 of 3 left". A free model: "Free".
    free: modelFree ? true : fr.use ? { left: fr.left, total: fr.total } : null,
    // Goes up whenever conversations are burned, so an open History screen reads the list again.
    historyVersion,
    // Waiting for the first words of an answer (screens/answer.js): since when, for the seconds shown.
    waitSince: S.streaming && S.genStart && !S.conv.messages.at(-1)?.content ? S.genStart : null,
    // The model that wrote the answer on show: its name and kind, small on the answer (owner, 2026-11-15).
    answerModel: answerModelOf(lastExchange(S.conv.messages)?.answer),
    // A fast model the slow-answer note can switch to now, or null (core/state.js fastPick).
    fastModel: fastModelNow(model),
    // Free models this engine lists, whatever Private only hides: the Free questions state on Funds.
    freeModels: S.models.some((m) => isFreeModel(m) && !m.uncensored),
    // The mode opens on its cover game (docs/PLAYFUL.md): its screens show the way back to the game.
    cover: coverOn(),
  };
}

/** {name, private, speed} of the model that wrote an answer, or null. */
function answerModelOf(a) {
  const id = a?.meta?.model;
  if (!id) return null;
  const m = S.models.find((x) => x.id === id);
  return { id, name: m?.name ?? id, private: m ? isPrivate(m) : false, speed: m?.speed ?? null };
}

/** The fast model the slow note offers: a free one, or a paid one when there is money for it. */
function fastModelNow(model) {
  const m = fastPick(S.models, S.settings, { current: model, paid: total()?.balanceMsub > 0 });
  return m ? { id: m.id, name: m.name ?? m.id } : null;
}

// ------------------------------------------------------------------ voice

/** The voice modules by id, for one direction. */
const voiceMods = (kind) => Object.fromEntries((registry?.list(kind) ?? []).map((x) => [x.instance.id, x.instance]));
const voiceIn = () => pickVoiceIn(voiceMods('voice-in'), S.settings);
/** True for a voice-in that hears on the phone itself: the phone's recogniser or Forge Private Voice's own model. */
const onPhone = (m) => m?.id === 'phone' || m?.id === 'bundled';
const voiceOut = () => pickVoiceOut(voiceMods('voice-out'), S.settings);

/**
 * Reads the first run's words aloud: the step's recorded clip (core/clips.js, public/v2/voice/en/), or,
 * when there is none for these words or it cannot play, the phone's own voice. Both are free and nothing
 * leaves the phone. The engine's voice is never used here (it costs money and the guide shows no price),
 * so with neither a clip nor a voice of the phone's own the Listen chip is not shown.
 */
const clips = createClips({ base: new URL('./voice/en/', import.meta.url) });
const reader = {
  mod: () => {
    const m = voiceMods('voice-out').device;
    return m?.available() && m.private() ? m : null;
  },
  available: (step, pieces) => (!!step && clips.has(step, pieces)) || !!reader.mod(),
  read(pieces, step) {
    if (!pieces.length) return null;
    talk.stopSpeaking();
    const phone = () => reader.mod()?.speak(pieces) ?? null;
    const clip = step ? clips.play(step, pieces) : null;
    if (!clip) return phone();
    let current = clip;
    const done = clip.done.catch((e) => {
      const p = phone();
      if (!p) throw e;
      current = p;
      return p.done;
    });
    return { done, stop: () => current.stop() };
  },
};

/**
 * The engine's audio calls as a voice module sees them: the model of each kind that Private only allows,
 * its price, and the paid calls, made with the balance key the module never sees.
 */
const audio = {
  model: (kind) => audioModels(S.audioModels, S.settings)[kind] ?? null,
  price: (kind, usage, unit = priceUnit(pickModel(S.models, S.settings))) => audioMsub(audio.model(kind), unit, usage),
  async transcribe(wav, { seconds, signal } = {}) {
    const m = audio.model('transcription');
    if (!m) throw new EngineError('model_not_found', 'No speech to text model.');
    // Paid by the balance that covers it (dollars first); one that none covers goes on the home balance,
    // where the engine may take it as a free voice question.
    const p = payerFor((u) => transcribeMsub(m, u, Math.max(seconds ?? 0, 0.5)));
    audioUnit = p.unit;
    return engine.transcribe(p.key, { model: m.id, audio: wav, seconds, signal });
  },
  async speak(input, { signal } = {}) {
    const m = audio.model('speech');
    if (!m) throw new EngineError('model_not_found', 'No voice model.');
    const p = payerFor((u) => audioMsub(m, u, { requests: 1, chars: input.length }));
    return engine.speech(p.key, { model: m.id, input, voice: m.voices?.[0], signal });
  },
};
// The unit of the balance the last recording was sent on, so the balance the engine reports after it
// lands on that one (talkctl's balanceAfter).
let audioUnit = null;

/**
 * The most a voice question can cost, for a recording of `seconds`: turning it into text, the question
 * it becomes (about CHARS_PER_SECOND characters a second) and, when the engine reads it aloud, the
 * longest part of the answer that is read. null when a part has no price.
 */
function talkPrice(seconds, inMod, freeVoice = false, unit = 'usd') {
  // A free voice question: turning it into text costs nothing.
  const toText = freeVoice ? 0 : inMod.price(seconds);
  // In the unit the line is shown in (talkView): the balance that would pay a typical question.
  const question = estimateFor('x'.repeat(Math.ceil(Math.max(1, seconds) * CHARS_PER_SECOND)), { voice: true, unit }).costMsub;
  const reading = readingPrice(unit);
  if (question == null || reading == null || (toText == null && inMod.id === 'engine')) return null;
  return (toText ?? 0) + question + reading;
}

/**
 * Free voice questions (docs/PAYMENTS.md): the engine turns a recording into text at no charge for a
 * balance that cannot pay for it, while it has some left today. use: this recording goes free. out: the
 * balance cannot pay and none are left today, so the engine would refuse it.
 */
function freeVoiceNow(inMod, seconds = 0) {
  const fv = S.freeVoice;
  if (!inMod || inMod.id !== 'engine' || !anyKey() || !fv?.enabled) return { use: false, out: false };
  const m = audio.model('transcription');
  // A balance that can pay for it pays; the home balance's free voice questions count only when none can.
  const p = m ? payerFor((u) => transcribeMsub(m, u, Math.max(seconds, 0.5))) : null;
  if (!p || p.costMsub == null || p.pays) return { use: false, out: false };
  return { use: fv.left > 0, out: !(fv.left > 0) };
}

function talkView(model, unit) {
  const inMod = voiceIn();
  const tk = S.talk ?? { phase: 'idle' };
  const fv = freeVoiceNow(inMod, tk.seconds ?? 0);
  return {
    available: !!inMod && !!model,
    // The engine's speech to text is paid from the paid balance unless it is a free voice question. The
    // phone's own recogniser (or the browser's) costs nothing, so then the question can be all free.
    freeOk: inMod?.id === 'device' || onPhone(inMod) || fv.use,
    freeVoice: fv.use,
    freeVoiceOut: fv.out,
    phase: tk.phase,
    seconds: tk.seconds ?? 0,
    level: tk.level ?? 0,
    inside: tk.inside !== false,
    text: tk.text ?? '',
    error: tk.error ?? null,
    unit,
    maxSeconds: inMod?.maxSeconds() ?? 60,
    priceMsub: inMod && tk.phase === 'recording' ? talkPrice(tk.seconds ?? 0, inMod, fv.use, unit) : null,
    // Where the sound goes, for the line under the button: phone, engine-private, engine-standard or device.
    // Forge Private Voice's own speech to text is On this phone too.
    route: !inMod ? null : onPhone(inMod) ? 'phone' : inMod.id === 'device' ? 'device' : inMod.private() ? 'engine-private' : 'engine-standard',
  };
}

function speakView() {
  const out = voiceOut();
  const ex = lastExchange(S.conv.messages);
  const progress = S.speaking?.progress;
  const answerMsg = S.conv.messages.findLast?.((m) => m.role === 'assistant' && m.content) ?? null;
  return {
    available: !!out && !!ex?.answer?.content,
    state: S.speaking?.state ?? 'idle',
    // How much of the natural voice's one-time download is here (0 to 99), while it downloads.
    progress: Number.isInteger(progress) ? progress : null,
    current: !!answerMsg && S.speaking?.key === answerMsg.id,
    // The engine's voice reads the answer in plain form on its way to the model: the line says so.
    viaEngine: out?.id === 'engine',
    priceMsub: out && answerMsg && !S.streaming ? talk.speakPrice(answerMsg) : null,
    // The natural voice, offered under Listen once the phone's own voice read an answer: its size in MB.
    offer: S.voiceOffer ? { mb: Math.max(1, Math.round((S.voiceOffer.bytes ?? 0) / 1e6)) } : null,
  };
}
// subscribe() tells a listener that something changed, never what: the raw state (and the balance key in
// it) stays here. A mode module gets only view and subscribe (core/registry.js, PROJECTIONS).
const state = { S, subscribe: (f) => store.subscribe(() => f()), view };

let frame = 0;
/** Repaints at most once a frame (the answer streams in many small pieces). */
const soon = () => (frame ||= requestAnimationFrame(() => ((frame = 0), store.set({}))));

// ------------------------------------------------------------------ settings and the look

async function saveSettings() {
  await kv.put('settings', S.settings).catch(() => {});
}

let registry = null;
const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');

function applyLook() {
  const looks = registry?.list('look') ?? [];
  let id = S.settings.look;
  if (S.settings.followSystem) id = darkQuery?.matches ? (S.settings.look === 'midnight' ? 'midnight' : 'dark') : 'light';
  const look = looks.find((l) => l.instance.id === id) ?? looks.find((l) => l.instance.id === DEFAULT_SETTINGS.look) ?? looks[0];
  if (!look) return;
  setTokens(look.instance.tokens, look.instance.scheme);
  // index.html paints the first frame from this, before any script of the app has loaded.
  keep(LOOK_CACHE, JSON.stringify({ look: look.instance.id, tokens: look.instance.tokens, scheme: look.instance.scheme }));
}

function setTokens(tokens, scheme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(`--${k}`, v);
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens.bg);
}

// The last look, before the modules load, so a dark look does not flash light. A light one saved before
// Midnight became the default (no `look` in it) is Midnight now unless picked again (core/state.js).
try {
  const c = JSON.parse(ui.load(LOOK_CACHE) ?? 'null');
  if (c?.tokens && (c.look || c.scheme === 'dark')) setTokens(c.tokens, c.scheme);
} catch {
  /* first run */
}
darkQuery?.addEventListener?.('change', () => S.settings.followSystem && applyLook());

// ------------------------------------------------------------------ the mode

// Modes whose screens are in. Default's are loaded with the app; another mode may load its screens,
// styles and fonts only once it is chosen (its ready(), docs/PLAYFUL.md), so Default never pays for them.
const modesReady = new Set(['default']);

/** The mode module that draws the home and the answer now (core/state.js pickMode). */
function modeNow() {
  const list = registry.list('mode');
  const id = pickMode([...modesReady], S.settings);
  return (list.find((x) => x.instance.id === id) ?? list.find((x) => x.instance.id === 'default') ?? list[0]).instance;
}

/** Loads a mode's screens (its ready()). False when it cannot be drawn: not bundled, or offline and not kept. */
async function prepareMode(id) {
  const mode = registry?.list('mode').find((x) => x.instance.id === id)?.instance;
  if (!mode) return false;
  try {
    await mode.ready?.();
  } catch (e) {
    console.warn('mode not ready', id, e);
    return false;
  }
  modesReady.add(id);
  return true;
}

/** Keeps the mode in use for index.html's first frame; Default keeps nothing. */
function keepMode() {
  const id = modeNow().id;
  keep(MODE_CACHE, id === 'default' ? null : id);
  if (!coverOn()) keep(COVER_CACHE, null);
}

/**
 * The cover (docs/PLAYFUL.md): the mode in use has a cover game (its cover()) and "Open as a game first"
 * is on. Then the game is the first screen: opened fresh, back from the background, and under the
 * helper's home, so Back from the home shows it and Back from it never shows the helper.
 */
function coverOn() {
  return !!registry && S.settings.gameFirst !== false && typeof modeNow().cover === 'function';
}
// In the Android app the phone's bars follow the page's colour (core/native.js followBars).
if (native) followBars(native.bars);

// ------------------------------------------------------------------ balance

/**
 * Keeps a new paid balance key (core/balances.js withKey): in the first of the two storage names that is
 * empty, never over a key already kept. unit: the key's unit when the engine said it with the key.
 */
/** The storage name of the first (0) or second (1) balance key. */
const slotName = (i) => (i ? keyStore2() : keyStore());

function setKey(k, unit = null) {
  if (!k) return;
  if (unit) S.keyUnits = { ...S.keyUnits, [k]: unit };
  // A key stored since this page read them (the Classic page in another tab, say) is taken in first,
  // so it is never written over.
  S.keys = S.keys.map((x, i) => x ?? ui.load(slotName(i)) ?? null);
  const next = withKey(S.keys, k);
  if (!next) {
    // Both names hold a key already: the phone never asks for a third (core/balances.js landsIn), so
    // this one is only kept aside, with any other kept so.
    keep('forge2.extraKeys', withAside(ui.load('forge2.extraKeys'), k));
    return;
  }
  const i = next.findIndex((x, j) => x !== S.keys[j]);
  S.keys = next;
  if (i >= 0) keep(slotName(i), k);
  store.set({});
}

/** Keys this phone made for a second balance that the engine has not answered for yet: {key: unit}. */
function newKeys() {
  try {
    const v = JSON.parse(ui.load(newKeysStore()) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
const setNewKeys = (m) => keep(newKeysStore(), Object.keys(m).length ? JSON.stringify(m) : null);

/**
 * Makes the key of a second balance on the phone and keeps it (its storage name, and newKeys with its
 * unit) before anything is sent with it, so an answer that never arrives loses nothing: the same key
 * and the same eCash sent again find the balance the engine opened. null when it has no place.
 */
function makeKey(unit) {
  const k = newKey(crypto.getRandomValues(new Uint8Array(24)));
  if (!withKey(S.keys.map((x, i) => x ?? ui.load(slotName(i)) ?? null), k)) return null;
  setNewKeys({ ...newKeys(), [k]: unit });
  setKey(k, unit);
  return S.keys.includes(k) ? k : null;
}

/** Lets a key go (the engine no longer knows it); the other key stays where it is. */
function dropKey(k) {
  const i = S.keys.indexOf(k);
  if (i < 0) return;
  const unit = S.keyUnits[k];
  S.keys = withoutKey(S.keys, k);
  // Only a name that still holds this very key is emptied.
  if (ui.load(slotName(i)) === k) keep(slotName(i), null);
  if (unit && !keyFor(unit)) S.bal = { ...S.bal, [unit]: null };
  store.set({});
}

async function savePeak() {
  await kv.put(`peaks:${engine.base}`, S.peaks).catch(() => {});
}

function setFreeKey(k) {
  S.freeKey = k || null;
  keep(freeKeyStore(), S.freeKey);
  if (!S.freeKey) S.freeMsub = null;
  store.set({});
}

async function saveFreeTotal() {
  await kv.put(`freeTotal:${engine.base}`, S.freeTotal).catch(() => {});
}

/** Reads the free balance. When it went up, the "of 3" count grows with it (core/free.js nextFreeTotal). */
async function refreshFree() {
  if (!S.freeKey) return;
  try {
    const w = await engine.wallet(S.freeKey);
    const before = S.freeMsub == null ? null : freeLeft(S.freeMsub);
    const now = freeLeft(w.balance_msub);
    if (before == null) S.freeTotal = Math.max(S.freeTotal ?? 0, now);
    else if (now > before) S.freeTotal = nextFreeTotal(before, S.freeTotal, now - before);
    S.freeMsub = w.balance_msub;
    await saveFreeTotal();
  } catch (e) {
    if (e instanceof EngineError && e.status === 401) {
      keep('forge2.unrecognizedFreeKey', S.freeKey);
      setFreeKey(null);
    }
  }
}

// The gold ring's full mark as kept before two balances (one number, for the one key): it becomes the
// mark of that key's unit once the engine says which unit that is.
let legacyPeak = null;

/**
 * Reads every paid balance the phone keeps: each key's unit and balance. A key the engine no longer knows
 * is let go: with a toast when it was the only one, as before two balances. With two, the one let go is
 * an empty balance whose first funding failed (the engine deletes only those), and it goes without a word.
 */
async function refreshBalance() {
  await refreshFree();
  if (!anyKey()) return store.set({});
  for (const k of S.keys) {
    if (!k) continue;
    try {
      const w = await engine.wallet(k);
      S.keyUnits = { ...S.keyUnits, [k]: w.unit };
      // The engine knows a key this phone made: it is an ordinary key from now on.
      const made = newKeys();
      if (k in made) {
        delete made[k];
        setNewKeys(made);
      }
      if (keyFor(w.unit) !== k) continue;
      if (k === S.keys[0]) {
        if (legacyPeak != null && S.peaks[w.unit] == null) S.peaks = { ...S.peaks, [w.unit]: legacyPeak };
        legacyPeak = null;
      }
      // Free voice questions left today (docs/PAYMENTS.md): speech to text the operator pays for.
      S.bal = { ...S.bal, [w.unit]: { balanceMsub: w.balance_msub, availableMsub: w.available_msub, freeVoice: w.free_voice ?? null } };
      S.peaks = { ...S.peaks, [w.unit]: nextPeak(S.peaks[w.unit], w.balance_msub) };
    } catch (e) {
      // Only a definite 401 lets a key go: an engine that cannot be reached or fails (5xx) says nothing
      // about it. A key this phone made and the engine does not know yet is kept: it opens its balance
      // with the next money in its unit (makeKey).
      if (e instanceof EngineError && e.status === 401 && !(k in newKeys())) {
        // The engine no longer knows this key. Keep a copy aside, as v1 does (in a list that is never
        // written over), then let it go.
        const alone = S.keys.filter(Boolean).length === 1;
        if (alone) keep('forge.unrecognizedKey', k);
        keep('forge2.unrecognizedKeys', withAside(ui.load('forge2.unrecognizedKeys'), k));
        dropKey(k);
        if (alone) ui.toast(t('error.key'));
      }
    }
  }
  // The free voice questions of the home balance, the one a recording no balance can pay goes on.
  S.freeVoice = balOf(homeUnit())?.freeVoice ?? null;
  await savePeak();
  store.set({});
}

async function loadModels() {
  try {
    const body = await engine.models();
    keep(MODELS_CACHE, JSON.stringify(body));
    applyModels(body);
  } catch {
    try {
      applyModels(JSON.parse(ui.load(MODELS_CACHE) ?? 'null'));
    } catch {
      /* nothing cached */
    }
  }
  await loadMethods();
}

// The ways to pay the engine offers, Start free among them. A read that fails is tried again: a little
// later, when the phone is back online, and when the app comes back to the front (retryMethods).
const METHODS_RETRY_MS = [2000, 5000, 15000, 30000];
let methodsTries = 0;
let methodsTimer = 0;
let methodsLoading = false;

async function loadMethods() {
  if (methodsLoading || erased) return;
  methodsLoading = true;
  clearTimeout(methodsTimer);
  try {
    S.methods = await engine.fundMethods();
    methodsTries = 0;
  } catch {
    methodsTimer = setTimeout(loadMethods, METHODS_RETRY_MS[Math.min(methodsTries++, METHODS_RETRY_MS.length - 1)]);
  }
  methodsLoading = false;
  store.set({});
}

const retryMethods = () => !S.methods && loadMethods();

function applyModels(body) {
  if (!body) return;
  Object.assign(S, { models: body.data ?? [], audioModels: Array.isArray(body.audio) ? body.audio : [], inviteOnly: !!body.invite_only, units: body.units ?? [], mints: body.mints ?? [], mintAliases: body.mint_aliases ?? [], btcUsd: body.btc_usd ?? null, free: freeInfo(body) });
}

/** Adds free questions (a credit voucher) to the free balance, through the vault like any eCash. */
async function topupFree(token) {
  const r = await topupWithVault({ engine, vault, token, key: S.freeKey, setKey: setFreeKey, via: 'free' });
  await refreshFree();
  store.set({});
  return { ...r, free: true };
}

/**
 * Where money in `unit` goes (core/balances.js landsIn): its own balance, made now if the phone has none
 * (the second one opened with the first one's key where the engine offers that), or, on an engine that
 * does not, the balance the phone has, where the engine changes units after showing the price.
 */
const landing = (unit) => landsIn(unit, { held: { usd: !!keyFor('usd'), sat: !!keyFor('sat') }, siblings: siblingsOn(), inviteOnly: S.inviteOnly });
/** The engine opens the second balance with the first one's key (methods.sibling), and has not refused it here. */
const siblingsOn = () => !!S.methods?.sibling?.enabled && !S.siblingRefused;
/**
 * What money in `unit` is sent with: {key} of the balance in that unit. With none, while the phone
 * holds the other balance, the key of a new one is made and kept first (makeKey) and goes with
 * {sibling}, the other balance's key, which opens it with no invite; the same goes for a key made so
 * that the engine has not answered for yet. With no balance at all, {key: null}: the invite opens one.
 */
const fundingFor = (unit) => prepareFunding(unit, { keys: keys(), siblings: siblingsOn(), made: (k) => k in newKeys(), make: makeKey });
/**
 * The unit a token the phone can read goes to: Fedimint notes to sats (docs/PAYMENTS.md, Fedimint notes);
 * a token it cannot read goes to the home balance, as before.
 */
const landingOf = (token) => {
  if (tokenKind(token) === 'fedimint') return landing('sat');
  const n = readNote(token);
  return n.ok ? landing(n.unit) : homeUnit();
};

/**
 * Waits for the engine to say which unit each kept key is, so money is never sent as if a balance were
 * missing (a second balance opened in a unit the phone holds, or the wrong key sent to open one). False
 * while a key's unit is still not known (the engine could not be reached): then nothing is sent.
 */
async function unitsKnown() {
  if (unitsPending(S.keys, S.keyUnits)) await refreshBalance();
  return !unitsPending(S.keys, S.keyUnits);
}
const unitsUnknown = () => new EngineError('offline', t('fund.balancesUnread'), { retryable: true });

/** Sends every voucher and token still waiting on the phone: free ones on the free balance. One run at a time. */
let retrying = null;
function retryAll() {
  retrying ??= (async () => {
    // Each token to the balance of its unit (landingOf), opening it with the other key when it is the
    // second. Not while a kept key's unit is unknown: the tokens wait for the next try.
    const paid = !(await unitsKnown()) ? 0 : await retryPending({ engine, vault, getKey: (token) => fundingFor(landingOf(token)).key, getSibling: (token) => fundingFor(landingOf(token)).sibling, invite: S.invite, setKey, setFreeKey });
    const free = await retryPending({ engine, vault, getKey: () => S.freeKey, setKey: setFreeKey, via: 'free' });
    return paid + free;
  })().finally(() => (retrying = null));
  return retrying;
}

const wallet = {
  /** The key of the home balance: whether the phone has a paid balance at all (no invite is asked then). */
  key: () => homeKey(),
  /** The key of the balance in a unit, or null. */
  keyFor,
  /** Keeps a new balance key, with its unit when the engine said it. */
  setKey,
  /** The home balance's unit, or null with no balance read yet. */
  unit: () => (anyKey() ? (total()?.unit ?? UNITS.find((u) => keyFor(u)) ?? null) : null),
  /** The unit money in this unit is added to (landing). */
  landsIn: (unit) => landing(unit),
  /** {key} or {sibling} to send money in a unit with (fundingFor), once the kept keys' units are known. */
  fundingFor: async (unit) => {
    if (!(await unitsKnown())) throw unitsUnknown();
    return fundingFor(unit);
  },
  /**
   * After the engine refused to open the second balance with the first one's key (sibling_refused): money
   * in that unit goes the way an engine without two balances takes it, changed into the balance the phone has.
   */
  siblingRefused: () => {
    // Only a refusal of a key whose unit was known: one sent while units were unknown proves nothing.
    if (unitsPending(S.keys, S.keyUnits)) return;
    S.siblingRefused = true;
    store.set({});
  },
  inviteOnly: () => S.inviteOnly,
  invite: () => S.invite,
  setInvite: (v) => (S.invite = v),
  refresh: refreshBalance,
  methods: () => S.methods,
  mints: () => S.mints,
  /** Other addresses of the mints the engine takes: a note made under one of them is taken too. */
  mintAliases: () => S.mintAliases,
  units: () => S.units,
  lockKey: () => lockKey(),
  /** Whether Private only is on: Start free asks before the free (Standard) models are used. */
  privateOnly: () => !!S.settings.privateOnly,
  /** Start free's choice, after a yes (actions.useFreeModels): Private only off, a free model chosen. */
  useFreeModels: () => actions.useFreeModels(),
  /**
   * Adds eCash through the vault: stored on the phone first, removed only once credited. A voucher of
   * free questions (from the engine's credit mint) goes on the free balance; the result says free: true.
   * Fedimint notes go the same way, to the sat balance. extra: fields kept with the vault entry.
   */
  topup: async (token, invite, extra = {}) => {
    const note = readNote(token);
    if (note.ok && isCreditMint(S.free, note.mint)) return topupFree(token);
    if (!(await unitsKnown())) {
      // The token waits on the phone, sent again once the balances can be read (retryAll).
      vault.pending(vault.hold(token, 'topup', { engine: engine.base ?? '', ...extra }).id, 'offline');
      throw unitsUnknown();
    }
    // To the balance of the token's unit, no change of units and no fee (landing): a second balance is
    // opened with the first one's key.
    const unit = landingOf(token);
    const f = fundingFor(unit);
    try {
      // The engine may still find a voucher here (the credit mint was not known yet): its free balance
      // key then goes to the free slot, never the paid one.
      const r = await topupWithVault({ engine, vault, token, key: f.key, sibling: f.sibling, invite, setKey, setFreeKey, extra });
      if (r.free) {
        await refreshFree();
        store.set({});
      }
      return r;
    } catch (e) {
      // The engine would not open the second balance: from now on this unit is changed into the balance
      // the phone has, and this token is offered that way now, price first (as a wrong_unit top-up is).
      // Fedimint notes are never changed: they need the sat balance, and the refusal says so.
      if (e?.code !== 'sibling_refused') throw e;
      wallet.siblingRefused();
      if (!note.ok) throw e;
      const to = landing(note.unit);
      if (to === note.unit || !S.methods?.convert?.units?.includes(to)) throw e;
      throw new EngineError('wrong_unit', e.message, { status: 400, body: { convert: { quote: '/v1/wallet/fund/foreign/quote', unit: to, token_unit: note.unit } } });
    }
  },
  /** Adds a voucher of free questions, known to be one (the Free questions module), to the free balance. */
  topupFree,
  /** True for the engine's credit mint: its eCash is free questions, not money. */
  isCredit: (mint) => isCreditMint(S.free, mint),
  /**
   * Opens a balance with an invite code and nothing on it, for the free models (Start free: the first
   * run and the fund module invite). The new key is kept like any balance key; funds can be added to it
   * later. When the chosen model is not free, the free model Private only allows (core/price.js
   * freeModelChoice) is chosen; Private only itself is never changed here (Start free asks first).
   * Resolves {created, freeShown}: freeShown is false when Private only hides every free model.
   */
  open: async (invite) => {
    if (!anyKey()) {
      const r = await engine.openBalance(invite);
      if (r?.key) setKey(r.key, r.unit);
      S.invite = '';
      await refreshBalance();
    }
    const shown = visibleModels(S.models, S.settings).filter(isFreeModel);
    if (shown.length && !isFreeModel(pickModel(S.models, S.settings))) {
      Object.assign(S.settings, choiceOf(freeModelChoice(shown)));
      await saveSettings();
      store.set({});
    }
    return { created: true, freeShown: shown.length > 0 };
  },
};

// ------------------------------------------------------------------ conversation

let historyVersion = 0;
// Conversations burned in this page: never written again, even by an answer still on its way.
const burned = new Set();
const newId = (p) => p + '_' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replaceAll('-', '').slice(0, 20);
let gen = null; // {controller, quiet}
// Resolves once the answer being made is settled and saved (actions.useFastModel waits for it).
let genIdle = Promise.resolve();
// True while actions.useFastModel moves the question to a fast model.
let switching = false;
// The conversation the Private chip switched the model under while it was on show (an answer coming in,
// or the answer screen): the next question leaves it (actions.togglePrivate). null for none.
let freshNext = null;
const leavingConv = () => !!S.conv.id && S.conv.id === freshNext;
// True while the Private chip's question is open.
let askingKind = false;

/** Saves a conversation (the open one by default). A burned one is never written back. */
async function saveConv(conv = S.conv) {
  if (!conv.id || burned.has(conv.id)) return;
  conv.updatedAt = Date.now();
  await chats.put(conv.id, conv).catch(() => {});
  if (conv === S.conv) await kv.put('current', conv.id).catch(() => {});
}
/** What waits for the next question (attachments, the typed draft) is timed by auto-delete too. */
const SCRATCH = 'next-question';
async function scratchChanged() {
  await kv.put('scratchAt', Date.now()).catch(() => {});
}
async function savePending() {
  await kv.put('pending', S.pending).catch(() => {});
  await scratchChanged();
}

/**
 * The funds hold for a question with these API messages, as a function of the unit, in msub: exactly
 * what the engine holds before sending it on (core/price.js holdMsub), from the body generate() sends,
 * encrypted for a private model. Falls back to the per-token estimate when the engine lists no hold
 * figures. null when unpriced. A function, so the balance that pays it can be chosen (payerFor).
 */
function questionHold(model, api, maxOut, inputTokens, search = false) {
  const enc = isPrivate(model) ? { upstream: model.upstream_model } : null;
  const plain = new TextEncoder().encode(chatPayload(chatBody(model, api, maxOut, search), enc)).length;
  return (unit) => {
    const held = holdMsub(model, unit, { bodyBytes: enc ? ehbpBytes(plain) : plain, maxOut, btcUsd: S.btcUsd, search });
    if (held != null || search) return held;
    return estimate(model, unit, inputTokens, maxOut)?.max ?? null;
  };
}

/**
 * Search the web (docs/PAYMENTS.md, Web search): the model searches from its sealed machine, through
 * Tinfoil's search service, with both of its safety filters on (personal details taken out of the search,
 * and instructions planted in pages dropped). Only on a model that offers it.
 */
const SEARCH_FIELDS = { web_search_options: {}, pii_check_options: {}, prompt_injection_check_options: {} };
const canSearch = (model) => !!model?.capabilities?.web_search;
const searchOn = (model) => !!S.search && canSearch(model);
/** The chat request body generate() sends, also used to price it. */
const chatBody = (model, api, maxOut, search) => ({ model: model.id, messages: api, max_tokens: maxOut, ...(search ? SEARCH_FIELDS : {}) });

/**
 * The price of the next question with these words, and whether it can be paid. Priced in the unit of the
 * balance that pays it (payerFor: dollars first, sats when the dollars are short), or in `unit` when given.
 * model: the question to that model as if it were chosen now (the model list), which starts a new
 * conversation when it is not the one in use (modelChanged).
 */
function estimateFor(text, { voice = false, unit: asked = null, model: chosen = null } = {}) {
  const current = pickModel(S.models, S.settings);
  const model = chosen ?? current;
  if (!model) return { costMsub: null, unit: asked ?? homeUnit() };
  const vision = !!model.capabilities?.vision;
  const next = pendingMessage(text, S.pending, { vision });
  if (voice) next.meta = { voice: true };
  const before = model.id === current?.id ? S.conv.messages.filter((m) => !m.meta?.error) : [];
  const msgs = [...before, next];
  const systemPrompt = promptFor(msgs);
  const api = apiMessages(msgs, { systemPrompt, vision });
  const bytes = new TextEncoder().encode(JSON.stringify(api)).length;
  const tokens = tokensOf(msgs, { systemPrompt, vision });
  const maxOut = Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
  const search = searchOn(model);
  const modelFree = isFreeModel(model);
  const holdIn = questionHold(model, api, maxOut, tokens, search);
  const payer = payerFor(holdIn);
  const unit = asked ?? payer.unit;
  const costMsub = asked ? holdIn(asked) : payer.costMsub;
  const money = total()?.balanceMsub > 0;
  // A search is never a free question: it is paid from the balance.
  const fr = search ? { ...freeNow(model, bodyTokens(bytes)), use: false } : freeNow(model, bodyTokens(bytes));
  return {
    costMsub,
    search,
    // The engine refuses a question whose hold is more than the funds not already held: say so first.
    // One balance pays a question in full, so it is short when neither covers it alone. A free model
    // holds nothing, so it is never short.
    short: !modelFree && !fr.use && anyKey() && payer.costMsub != null && money && !payer.pays,
    // Not enough money for even this question, with no paid balance or not enough in either (core/balances.js
    // cannotPay): what the model list marks.
    needsMoney: cannotPay({ free: modelFree, freeUse: fr.use, paidMsub: anyKey() ? (total()?.balanceMsub ?? null) : 0, available: { usd: availOf('usd'), sat: availOf('sat') }, hold: { usd: holdIn('usd'), sat: holdIn('sat') }, btcUsd: S.btcUsd, home: homeUnit() }),
    unit,
    // Paid with a free question: the price line reads "Free, 2 of 3 left". A free model: "Free".
    free: modelFree ? true : fr.use ? { left: fr.left, total: fr.total } : null,
    // Free questions left, but this one is too long for one, and there is no paid balance.
    freeTooLong: !modelFree && !fr.use && fr.why === 'long' && !money,
    reading: S.pending.some((a) => a.status === 'reading'),
    overContext: !!model.context_length && tokens + maxOut > model.context_length,
    overBody: bytes > BODY_LIMIT * 0.98,
  };
}

/**
 * Input tokens as the engine counts them for the free caps: the request body's bytes over two
 * (FORGE_BYTES_PER_TOKEN), with room for the parts of the body around the messages.
 */
const bodyTokens = (bytes) => Math.ceil((bytes + 256) / 2);

/**
 * The most the engine can charge to read up to SPEAK_MAX_CHARS of an answer aloud: 0 when the phone
 * reads it (or nothing does), null when the engine's voice has no price.
 */
function readingPrice(unit) {
  const out = voiceOut();
  if (out?.id !== 'engine') return 0;
  return audio.price('speech', { requests: Math.ceil(SPEAK_MAX_CHARS / out.pieceSize()), chars: SPEAK_MAX_CHARS }, unit);
}

/**
 * The most Ask again can cost: again() drops the answers after the last question and asks the model
 * again with the conversation up to it (againHistory). A question asked by voice is answered by voice,
 * so when the engine reads it aloud that is in the price too, as on the talk line. null when there is
 * no question to ask again, or a part has no price.
 */
function estimateAgain(model) {
  // After the Private chip switched the model, Ask again asks the question alone, in a new conversation.
  const history = leavingConv() ? againHistory(S.conv.messages).slice(-1) : againHistory(S.conv.messages);
  if (!history.length) return null;
  const vision = !!model.capabilities?.vision;
  const systemPrompt = promptFor(history);
  const tokens = tokensOf(history, { systemPrompt, vision });
  const maxOut = Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
  const payer = payerFor(questionHold(model, apiMessages(history, { systemPrompt, vision }), maxOut, tokens, searchOn(model)));
  const reading = history.at(-1).meta?.voice ? readingPrice(payer.unit) : 0;
  if (payer.costMsub == null || reading == null) return null;
  return { msub: payer.costMsub + reading, unit: payer.unit };
}

async function ask(text, meta = null) {
  if (gen) return;
  const model = pickModel(S.models, S.settings);
  if (!model) return nav('model');
  talk.clearError();
  talk.stopSpeaking();
  const msg = { id: newId('m'), ...pendingMessage(text, S.pending, { vision: !!model.capabilities?.vision }) };
  if (meta?.voice) msg.meta = { voice: true };
  if (!msg.content && !msg.images && !msg.files) return;
  // The Private chip switched the model while this conversation was on show: it stays in History, and
  // the question goes to the new model with nothing from it.
  if (leavingConv()) S.conv = { id: null, messages: [] };
  freshNext = null;
  if (!S.conv.id) S.conv = { id: newId('c'), messages: [], createdAt: Date.now() };
  S.conv.messages.push(msg);
  S.pending = [];
  await savePending();
  await saveConv();
  nav('answer');
  generate();
}

function generate() {
  if (gen || !pickModel(S.models, S.settings)) return;
  const p = makeAnswer();
  genIdle = p.catch(() => {});
  return p;
}

async function makeAnswer() {
  const model = pickModel(S.models, S.settings);
  if (!model || gen) return;
  const vision = !!model.capabilities?.vision;
  const conv = S.conv;
  const history = conv.messages.filter((m) => !m.meta?.error);
  const api = apiMessages(history, { systemPrompt: promptFor(history), vision });
  // A free question is used first, when the model is on the free list and the question fits its caps.
  const fr = freeNow(model, bodyTokens(new TextEncoder().encode(JSON.stringify(api)).length));
  // Search the web applies to this question only, and is never a free question.
  const search = searchOn(model);
  if (S.search) S.search = false;
  // A free model is asked with the balance key: the engine never takes a free question (credit) for it.
  const useF = fr.use && !!S.freeKey && !search && !isFreeModel(model);
  const maxTokens = useF ? freeMaxTokens(S.free, Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT)) : Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
  // One balance pays the whole question: dollars first, sats when the dollars cannot cover its hold
  // (payerFor). When neither can, it goes on the home balance and the engine says it is short.
  const payer = payerFor(questionHold(model, api, maxTokens, tokensOf(history, { systemPrompt: promptFor(history), vision }), search));
  const reply = { id: newId('m'), role: 'assistant', content: '', meta: { model: model.id, unit: payer.unit } };
  if (useF) reply.meta.free = true;
  // A free model: the note under the answer says it was free, never "That cost 0 cents".
  if (isFreeModel(model)) reply.meta.freeModel = true;
  if (search) reply.meta.search = true;
  conv.messages.push(reply);
  const controller = new AbortController();
  // quiet: the answer is stopped to ask again elsewhere (actions.useFastModel), so no "Stopped." is said.
  const me = { controller, quiet: false };
  gen = me;
  store.set({ streaming: true, genStart: Date.now() });
  let forge = null;
  let failure = null;
  try {
    await engine.chat({
      key: useF ? S.freeKey : payer.key,
      body: chatBody(model, api, maxTokens, search),
      encrypted: isPrivate(model) ? { upstream: model.upstream_model } : null,
      search,
      signal: controller.signal,
      onText: (d) => {
        reply.content += d;
        soon();
      },
      onForge: (f) => (forge = f),
    });
  } catch (e) {
    if (e?.name === 'AbortError' || controller.signal.aborted) reply.meta.stopped = true;
    else {
      failure = e;
      reply.meta.error = { code: e?.code ?? 'other', message: e?.message ?? String(e) };
    }
  } finally {
    gen = null;
  }
  if (!reply.content && !reply.meta.error && !reply.meta.stopped) reply.meta.error = { code: 'stream_failed', message: t('answer.empty') };
  // What a failure cost comes from the engine's final event, kept on the error path too, so the words
  // never say "not charged" when the engine charged for the question.
  if (reply.meta.error) reply.meta.error.charged = chargedFor(forge, failure);
  // A free question's charge is a credit, not money: never shown as an amount. If one was used on a
  // failure, the words say to check the funds instead.
  if (useF && reply.meta.error) reply.meta.error.charged = reply.meta.error.charged > 0 ? null : reply.meta.error.charged;
  if (reply.meta.error && reply.content) {
    reply.meta.partial = true;
    delete reply.meta.error;
  }
  if (forge?.balance_msub != null) {
    if (useF) S.freeMsub = forge.balance_msub;
    else if (balOf(payer.unit)) S.bal = { ...S.bal, [payer.unit]: { ...S.bal[payer.unit], balanceMsub: forge.balance_msub } };
  }
  if (!useF && forge?.charged_msub != null && (!reply.meta.error || forge.charged_msub > 0)) reply.meta.cost = forge.charged_msub;
  if (useF && forge?.charged_msub > 0) reply.meta.freeLeft = freeLeft(forge.balance_msub ?? S.freeMsub);
  // A stopped stream is settled by the engine just after the disconnect.
  if (reply.meta.stopped && !forge) await new Promise((r) => setTimeout(r, 900));
  store.set({ streaming: false });
  // Burned while it streamed: nothing more to say or save, but the balance did change.
  if (burned.has(conv.id)) return refreshBalance();
  if (!me.quiet) {
    const words = reply.meta.error ? errorText(reply.meta.error, reply.meta.unit) : reply.meta.stopped ? t('answer.stopped') : t('answer.done');
    // On the answer itself the words are on the screen already (the error box, the note): a toast there
    // would cover the answer, so it is only said to screen readers.
    if (currentName === 'answer' && S.conv === conv) ui.announce(words);
    else ui.toast(words, 1800);
  }
  await saveConv(conv);
  await refreshBalance();
  // A question asked by voice is answered by voice, unless reading aloud is off.
  const asked = history.at(-1);
  if (asked?.meta?.voice && reply.content && !reply.meta.error && !reply.meta.stopped && S.conv === conv) talk.speak(reply, { auto: true });
}

/** The plain words for a failed answer, with what it cost when the engine charged for it. */
const errorText = (err, unit) => {
  const ev = errorView(err.code, err.message, err.charged);
  // Said aloud and in a toast: the plain words only. The engine's reason stays on the answer screen.
  const key = ev.key === 'error.modelWhy' ? 'error.model' : ev.key;
  return t(key, { message: ev.message ?? '', amount: ev.charged > 0 ? format.cost(ev.charged, unit) : '' });
};

function again() {
  if (gen) return;
  if (leavingConv()) {
    // The Private chip switched the model since this answer: the question alone, in a new conversation.
    const question = S.conv.messages.findLast?.((x) => x.role === 'user');
    freshNext = null;
    if (!question) return nav('type');
    S.conv = { id: newId('c'), messages: [{ ...question, id: newId('m') }], createdAt: Date.now() };
    saveConv();
    return generate();
  }
  const msgs = S.conv.messages;
  while (msgs.length && msgs.at(-1).role === 'assistant') msgs.pop();
  if (!msgs.length) return nav('type');
  generate();
}

/** Clears the memory: the next question starts a new conversation. The old one stays in History. */
async function startFresh() {
  gen?.controller.abort();
  S.conv = { id: null, messages: [] };
  S.pending = [];
  await savePending();
  await kv.del('current').catch(() => {});
  store.set({});
}

// ------------------------------------------------------------------ history, burn and auto-delete

/** Every stored conversation. */
const allConversations = async () => (await chats.all().catch(() => [])) ?? [];

/**
 * Removes conversations from this phone: from IndexedDB, from this page's memory and, for the open one,
 * its answer read aloud and the sound kept for it. SCRATCH stands for what waits for the next question.
 */
async function burnIds(ids) {
  const set = new Set(ids);
  if (!set.size) return;
  const voiceOuts = registry?.list('voice-out') ?? [];
  if (S.conv.id && set.has(S.conv.id)) {
    const conv = S.conv;
    burned.add(conv.id);
    gen?.controller.abort();
    talk.stopSpeaking();
    for (const m of conv.messages) for (const x of voiceOuts) x.instance.forget?.(m.id);
    if (S.talk?.phase === 'idle') S.talk = { ...S.talk, text: '', error: null };
    S.conv = { id: null, messages: [] };
    memo = { k: '', v: null };
    await kv.del('current').catch(() => {});
  }
  for (const id of set) {
    if (id === SCRATCH) continue;
    burned.add(id);
    const c = await chats.get(id).catch(() => null);
    for (const m of c?.messages ?? []) for (const x of voiceOuts) x.instance.forget?.(m.id);
    await chats.del(id).catch(() => {});
  }
  if (set.has(SCRATCH)) {
    S.pending = [];
    S.draft = '';
    await kv.del('pending').catch(() => {});
    await kv.del('draft').catch(() => {});
    await kv.del('scratchAt').catch(() => {});
  }
  historyVersion++;
  store.set({});
}

/** Burns every conversation and what waits for the next question. */
async function burnEverything() {
  const ids = (await allConversations()).map((c) => c.id);
  if (S.conv.id) ids.push(S.conv.id);
  await burnIds([...ids, SCRATCH]);
  await chats.clear().catch(() => {});
  for (const x of registry?.list('voice-out') ?? []) x.instance.forget?.();
}

/** What auto-delete looks at: each conversation and, when there is one, the next question's things. */
async function timedItems() {
  const items = (await allConversations()).map((c) => ({ id: c.id, at: lastUsed(c) }));
  if (S.pending.length || S.draft) items.push({ id: SCRATCH, at: (await kv.get('scratchAt').catch(() => null)) ?? 0 });
  return items;
}

// True once the first screen is drawn: a timed removal after that is said in a toast. The removal on
// open happens before anything is shown, so it has nothing to point at.
let live = false;
async function sweepBurn(ids) {
  await burnIds(ids);
  if (live && !erased && ids.some((id) => id !== SCRATCH)) ui.toast(t('history.autoBurned'), 3000);
}
const sweeper = createSweeper({ setting: () => S.settings.autoDelete, list: timedItems, burn: sweepBurn });

async function openConversation(id) {
  if (S.conv.id === id) return nav('answer');
  const c = await chats.get(id).catch(() => null);
  if (!c) return;
  // An answer still streaming finishes in its own conversation, which saves itself.
  gen?.controller.abort();
  talk.stopSpeaking();
  S.conv = c;
  await kv.put('current', id).catch(() => {});
  store.set({});
  nav('answer');
}

async function forgetConversation() {
  const pending = S.pending;
  await startFresh();
  // What was added meanwhile stays too: a photo for a model just chosen (attachPhoto), say.
  S.pending = [...pending, ...S.pending];
  await savePending();
  store.set({});
}

async function attach(files, want) {
  const model = pickModel(S.models, S.settings);
  nav('home');
  for (const f of files) {
    const kind = kindOf(f);
    if (want === 'image' || kind === 'image') {
      if (kind !== 'image') continue;
      if (!model?.capabilities?.vision) {
        ui.toast(t('add.noPhotos'), 3500);
        continue;
      }
      if (S.pending.filter((a) => a.kind === 'image').length >= MAX_IMAGES) {
        ui.toast(t('add.tooMany'));
        continue;
      }
      try {
        const img = await shrinkImage(f);
        S.pending.push({ id: newId('a'), kind: 'image', name: f.name || t('add.photo'), status: 'ready', ...img });
        ui.toast(t('add.added', { name: f.name || t('add.photo') }));
      } catch {
        ui.toast(t('fund.failed', { message: f.name }));
      }
      continue;
    }
    if (S.pending.filter((a) => a.kind !== 'image').length >= MAX_FILES) {
      ui.toast(t('add.tooMany'));
      break;
    }
    const a = { id: newId('a'), kind: kind ?? 'text', name: f.name, size: f.size, status: 'reading' };
    S.pending.push(a);
    store.set({});
    ui.toast(t('add.reading', { name: f.name }));
    try {
      const x = await import('../js/extract.js');
      const r = await x.extract(f);
      x.release?.(r.doc);
      Object.assign(a, { status: 'ready', text: r.text, pages: r.pages });
      if (!r.text.trim()) throw new Error('empty');
      ui.toast(t('add.added', { name: f.name }));
    } catch (e) {
      S.pending = S.pending.filter((x) => x !== a);
      ui.toast(t('fund.failed', { message: e?.code ? e.message : f.name }), 3500);
    }
  }
  await savePending();
  store.set({});
}

/**
 * Share unseen, Ask about it: the protected photo (never the original) waits for the next question,
 * like a photo added from Add. Then the Type screen opens, with the price before sending.
 */
/**
 * Ask about it (Share unseen): the photo goes with the next question, on the Type screen. When the model
 * in use cannot see photos, Choose a model opens with only the models that can (modelPhoto), the photo
 * held in this page's memory only (photoWaiting); the one picked takes it on to Type. When no model on
 * this engine can see photos, a toast says so.
 */
async function attachPhoto(file, { replace = false } = {}) {
  const model = pickModel(S.models, S.settings);
  if (!model) return nav('model');
  if (!model.capabilities?.vision) {
    if (!visibleModels(S.models, { privateOnly: false }).some((m) => m.capabilities?.vision)) return ui.toast(t('add.noPhotosAny'), 3500);
    photoWaiting = file;
    return nav('modelPhoto');
  }
  if (S.pending.filter((a) => a.kind === 'image').length >= MAX_IMAGES) return ui.toast(t('add.tooMany'));
  const img = await shrinkImage(file);
  S.pending.push({ id: newId('a'), kind: 'image', name: t('add.photo'), status: 'ready', ...img });
  await savePending();
  store.set({});
  nav('type', {}, { replace });
}

/** The photo Ask about it waits to send while a model that can see it is chosen (attachPhoto). Memory only. */
let photoWaiting = null;

/**
 * Choose a model for a photo (modelPhoto): the photo view's two steps. chosen(): the model is chosen, so
 * the photo goes on to Type in place of the list. standard(): no private model can see photos, so the
 * Private chip's question is asked (askStandard) before Private only is turned off, unless the person
 * said yes to it before on this phone.
 */
const photoChoice = {
  chosen: () => {
    const file = photoWaiting;
    photoWaiting = null;
    if (file) attachPhoto(file, { replace: true }).catch(() => ui.toast(t('photo.bad'), 3500));
  },
  standard: async () => {
    if (askingKind) return;
    if (!S.settings.standardOk) {
      askingKind = true;
      let yes = false;
      try {
        yes = await askStandard({ t, reader, free: false, back: () => document.getElementById('modelPhotoStandard') ?? document.querySelector('[data-screen=model] .model-card') });
      } finally {
        askingKind = false;
      }
      if (!yes) return;
      S.settings.standardOk = true;
    }
    actions.setPrivateOnly(false);
    // The button is gone with the list drawn again: the first model that can see the photo takes the focus.
    document.querySelector('[data-screen=model] .model-card')?.focus();
  },
  // Back, or any other screen: the photo is let go (chosen() took it already).
  leave: () => {
    photoWaiting = null;
  },
};

async function removePending(id) {
  S.pending = S.pending.filter((a) => a.id !== id);
  await savePending();
  store.set({});
}

/** Takes `amount` (whole units) out of the balance in `unit` as eCash, kept on the phone until saved. */
async function takeOut(amount, unit = homeUnit()) {
  const key = keyFor(unit);
  if (!key) throw new EngineError('invalid_key', t('error.key'));
  const r = await engine.refund(key, { amount, pubkey: lockKey() || undefined });
  if (!r.ok && r.status !== 202) throw new EngineError(r.body?.error?.code ?? `http_${r.status}`, r.body?.error?.message ?? `HTTP ${r.status}`, { status: r.status });
  if (r.body?.token) vault.keepRefund({ id: r.body.id, token: r.body.token, amount: r.body.amount, unit: r.body.unit });
  // Issued later: remember the id, so collectRefunds offers it whatever this phone saw before.
  else if (r.body?.id) {
    const name = refundNames(key).awaited;
    const list = (await kv.get(name).catch(() => null)) ?? [];
    if (!list.includes(r.body.id)) await kv.put(name, [...list, r.body.id]).catch(() => {});
  }
  await refreshBalance();
  // Taking money out lowers the full mark of the gold ring to what is left.
  S.peaks = { ...S.peaks, [unit]: balOf(unit)?.balanceMsub ?? null };
  await savePeak();
  store.set({});
  return { later: !r.body?.token };
}

/** Where a balance's shown and awaited refund ids are stored (core/refunds.js): per key, so per balance. */
const refundNames = (key) => ({ shown: `refundsShown:${key.slice(-12)}`, awaited: `refundsAwaited:${key.slice(-12)}` });

/**
 * Refunds the engine issued but this phone has not shown yet (a 202 earlier, or a closed tab), for each
 * balance. The first time a balance is seen here, refunds already issued (in v1, say) are taken as
 * shown, not offered again; a refund this phone was told to collect later is always offered (core/refunds.js).
 */
async function collectRefunds() {
  for (const key of Object.values(keys())) {
    if (!key) continue;
    const names = refundNames(key);
    try {
      const before = await kv.get(names.shown);
      const awaited = (await kv.get(names.awaited)) ?? [];
      const list = await engine.refunds(key);
      const r = refundsToOffer({ list: list.data, shownBefore: before, awaited, outgoing: vault.outgoing().map((o) => o.id) });
      for (const x of r.keep) vault.keepRefund({ id: x.id, token: x.token, amount: x.amount, unit: x.unit });
      await kv.put(names.shown, r.shown);
      await kv.put(names.awaited, r.awaited);
      if (r.keep.length) store.set({});
    } catch {
      /* offline */
    }
  }
}

/**
 * Other-mint tokens still pending on this phone (the person left the fund screen before the outcome):
 * looks each funding up and settles it, so a token is never left waiting for a screen that is gone. A
 * funding belongs to one balance: each key asks about its own, and a 404 from the other key is no answer.
 */
async function settleOtherMint() {
  try {
    let n = 0;
    for (const key of Object.values(keys())) if (key) n += await settlePendingForeign({ engine, vault, key, mine: (e) => (e.unit ? keyFor(e.unit) === key : key === S.keys[0]) });
    if (n) {
      store.set({});
      await refreshBalance();
    }
  } catch {
    /* offline: next time */
  }
}

/**
 * Card payments this phone holds (core/card/flow.js): a swap at the card's mint not finished yet is sent
 * again, and a token not yet in the vault goes there. Change owed to a card waits for that card's tap.
 */
async function resumeCards() {
  if (!cardJobsWaiting()) return;
  try {
    const { flow, handToken } = await loadCards();
    const n = await flow.resume((job) => handToken(job, { wallet, vault, engineBase: engine.base ?? '', message: t('fund.card.toOtherMint') }));
    if (n) {
      store.set({});
      await refreshBalance();
    }
  } catch {
    /* offline: next time */
  }
}

/** Where a person with no balance key goes to open one for a free model: Start free, else Add money. */
function openBalance() {
  if (S.methods?.open?.enabled) return nav('startFree');
  return nav('addFunds');
}

/** Why a question cannot be asked right now, with where to go about it, or null. */
function blocker() {
  if (!S.online) return { key: 'type.offline' };
  if (S.streaming) return { key: 'talk.busy' };
  if (!anyKey() || total()?.balanceMsub === 0) {
    const v = view();
    // A voice question the phone turns into words can be a free question; the engine's speech to text
    // is paid from the paid balance, or free while the balance has free voice questions left today.
    if (v.fundsBlock === null && v.talk.freeVoiceOut) return { key: 'talk.freeVoiceOut' };
    if (!(v.talk.freeOk && v.fundsBlock === null)) {
      if (v.fundsBlock === 'needKey') return { key: 'type.needKey', go: openBalance };
      if (v.fundsBlock === 'freeOut') return { key: 'type.freeOut', go: () => nav('freeOut') };
      return { key: 'type.noFunds', go: () => nav('addFunds') };
    }
  }
  if (!pickModel(S.models, S.settings)) return { key: 'type.noModel', go: () => nav('model') };
  // Even a short question would hold more than the funds left.
  if (estimateFor('').short) return { key: 'type.short', go: () => nav('addFunds') };
  return null;
}

const talk = createTalk({
  store,
  t,
  ui,
  nav: (name) => nav(name),
  haptics: adapters.haptics,
  voiceIn: () => voiceIn(),
  voiceOut: () => voiceOut(),
  blocker,
  ask,
  refresh: () => refreshBalance(),
  errorText: (err) => errorText(err, priceUnit(pickModel(S.models, S.settings))),
  // The balance a transcription reports goes on the balance it was paid from (audio.transcribe).
  balanceAfter: (msub) => {
    const u = audioUnit ?? homeUnit();
    if (balOf(u)) store.set({ bal: { ...S.bal, [u]: { ...S.bal[u], balanceMsub: msub } } });
  },
  askDownload: (bytes) => askVoiceDownload(bytes),
  showDownload: (bytes) => showVoiceDownload(bytes),
  // Web Audio, and the phone's own voice, which iPhone Safari lets a page use only after it spoke in a tap.
  unlockAudio: () => {
    adapters.speaker.unlock?.();
    adapters.synth.unlock?.();
  },
  // The phone's own voice, which reads at once while the natural voice is not on the phone yet.
  phoneVoice: () => reader.mod(),
  voicesReady: () => adapters.synth.ready?.(2000) ?? Promise.resolve(false),
  readAloudOff: () => S.settings.voiceOut === 'off',
  notePhone: (session) => notePhone(session),
  naturalDeclined: {
    get: () => !!S.settings.naturalNotNow,
    set: () => {
      S.settings.naturalNotNow = true;
      saveSettings();
    },
  },
});

/**
 * Counts a press heard by the phone's own recogniser (core/talk.js afterPhonePress). After PHONE_MISSES
 * in a row that heard nothing while the sound was there, the app asks once whether the voice may go
 * online to become words (askVoiceOnline). Privacy is the default (owner, 2026-11-18): nothing switches
 * on its own. Asked only when another way can hear it here, under the same Private only rule as a phone
 * with no recogniser: otherwise the phone keeps listening and nothing is asked.
 */
function notePhone(session) {
  const was = S.settings.phoneMisses ?? 0;
  const other = pickVoiceIn(voiceMods('voice-in'), { ...S.settings, phoneOff: true });
  const { misses, ask } = afterPhonePress(S.settings, session, other && other.id !== 'phone' ? other : null);
  if (misses === was && !ask) return;
  S.settings.phoneMisses = misses;
  if (ask) S.settings.phoneAsked = true;
  saveSettings();
  if (ask) askVoiceOnline(other, (session.holdMs ?? 0) / 1000);
}

/**
 * The question after the phone heard nothing twice (askSheet, as the Private chip's): the voice can go
 * online to become words. Go online sets phoneOff (More, Voice shows it and On this phone takes it back);
 * Keep on this phone, or the sheet dismissed, keeps the phone's recogniser. Either way it is not asked
 * again (phoneAsked, set before it opens). It names who could hear it when that way is a standard model,
 * and the price as the talk line shows it, for a recording as long as this press: what turning it into
 * words costs, or the free voice questions left today.
 */
async function askVoiceOnline(way, seconds) {
  const extra = [];
  if (!way.private()) extra.push(ui.el('span', { class: 'tags' }, ui.el('span', { class: 'tag warn' }, ui.icon('eye', 14), ui.el('span', { text: t('voice.tag.provider') }))));
  const p = onlinePrice(way, seconds);
  if (p) extra.push(ui.el('p', { class: 'price-line', id: 'voiceAskPrice' }, ui.el('span', { class: 'cap', text: t('price.label') }), ui.el('span', { class: 'amount', text: t(p.key, p) })));
  const yes = await askSheet({
    t,
    reader,
    id: 'voiceAsk',
    text: t('voiceAsk.text'),
    ico: 'ear',
    extra,
    yes: { id: 'voiceGo', ico: 'globe', text: t('voiceAsk.go') },
    no: { id: 'voiceKeep', ico: 'phone', text: t('voiceAsk.keep') },
    back: () => document.getElementById('replyBtn') ?? document.getElementById('talkBtn'),
  });
  if (!yes) return;
  Object.assign(S.settings, { phoneOff: true, phoneMisses: 0 });
  saveSettings();
  store.set({});
}

/** The price line of a recording of `seconds` heard by `way` (the engine), in the talk line's unit (talkView). */
function onlinePrice(way, seconds) {
  const free = freeVoiceNow(way, seconds).use;
  return voicePriceLine(free ? 0 : way.price(seconds), priceUnit(pickModel(S.models, S.settings)), free ? S.freeVoice : null);
}

/**
 * Asks once before the natural voice is downloaded, with its size. Resolves true for Download. While
 * the question is open, nothing is fetched.
 */
function askVoiceDownload(bytes) {
  return new Promise((resolve) => {
    const size = Math.max(1, Math.round(bytes / 1e6));
    const close = (ok) => {
      dlg.close();
      dlg.remove();
      resolve(ok);
    };
    const dlg = ui.el(
      'dialog',
      { class: 'float-card voice-dl', id: 'voiceDownload', 'aria-labelledby': 'voiceDlTitle' },
      ui.el('h2', { id: 'voiceDlTitle', text: t('voiceDl.title') }),
      ui.el('p', { text: t('voiceDl.body', { size }) }),
      ui.el('div', { class: 'row-btns' }, ui.el('button', { type: 'button', class: 'btn', id: 'voiceDlNo', text: t('voiceDl.no'), onclick: () => close(false) }), ui.el('button', { type: 'button', class: 'btn primary', id: 'voiceDlYes', text: t('voiceDl.yes'), onclick: () => (adapters.speaker.unlock?.(), close(true)) })),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/**
 * The natural voice's first download, once the person said Download: a bar with MB done of MB in all and
 * the percent, then the phase in words, until the voice starts reading. A failed download says so here,
 * with Try again. Hide leaves it downloading (Listen shows the percent).
 */
function showVoiceDownload(bytes = 0) {
  let open = true;
  const meter = ui.meterBar({ id: 'voiceMeter', label: t('voiceDl.label') });
  const error = ui.el('p', { class: 'msg err', id: 'voiceDlError', role: 'alert', hidden: true });
  const hide = ui.el('button', { type: 'button', class: 'btn', id: 'voiceDlHide', text: t('voiceDl.hide'), onclick: () => close() });
  const retry = ui.el('button', { type: 'button', class: 'btn primary', id: 'voiceDlRetry', text: t('dl.retry'), hidden: true });
  const dlg = ui.el('dialog', { class: 'float-card voice-dl', id: 'voiceProgress', 'aria-labelledby': 'voiceProgTitle' }, ui.el('h2', { id: 'voiceProgTitle', text: t('voiceDl.getting') }), meter, error, ui.el('div', { class: 'row-btns' }, hide, retry));
  const close = () => {
    if (!open) return;
    open = false;
    dlg.close();
    dlg.remove();
  };
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  meter.set({ fraction: 0, text: t('dl.amount', phononMeter({ total: bytes })), phase: t('dl.downloading') });
  document.body.append(dlg);
  dlg.showModal();
  return {
    progress(p) {
      if (!open) return;
      const n = phononMeter(p);
      meter.set({ fraction: p.fraction, text: t('dl.amount', n), phase: t(p.phase === 'ready' ? 'dl.ready' : 'dl.downloading') });
    },
    fail(message, again) {
      if (!open) return false;
      error.textContent = t('dl.failed', { message });
      error.hidden = false;
      meter.set({ phase: '' });
      hide.textContent = t('voiceDl.close');
      retry.hidden = false;
      retry.onclick = () => {
        close();
        again();
      };
      return true;
    },
    close,
  };
}

const lastAnswer = () => S.conv.messages.findLast?.((m) => m.role === 'assistant' && m.content) ?? null;

/**
 * A new model starts a new conversation (owner, 2026-11-15): the answers already given stay in History,
 * and the next question goes to the new model with nothing from the old one. What waits for the next
 * question (photos, files) stays. True when a conversation was left.
 */
function modelChanged(before) {
  const now = pickModel(S.models, S.settings);
  if (!S.conv.messages.length || before?.id === now?.id) return false;
  // An answer still coming is stopped with the conversation it belongs to (it stays in History): the
  // toast says a new conversation began, and a "Stopped." a moment later must not cover it.
  if (gen) gen.quiet = true;
  forgetConversation();
  return true;
}

const actions = {
  /** Opens the invite module, where a balance for the free models is opened (or Add funds without it). */
  openBalance: () => openBalance(),
  ask,
  talkDown: () => talk.down(),
  talkUp: () => talk.up(),
  talkMove: (inside) => talk.move(inside),
  talkCancel: () => talk.cancel(),
  speak: () => talk.speak(lastAnswer()),
  stopSpeaking: () => talk.stopSpeaking(),
  setVoiceIn: (id) => {
    S.settings.voiceIn = id;
    S.settings.voiceInPicked = true;
    // On this phone, picked again after going online: it listens again. Not asked again (phoneAsked stays).
    if (id === 'phone') Object.assign(S.settings, { phoneOff: false, phoneMisses: 0 });
    saveSettings();
    store.set({});
  },
  setNaturalVoice: (name) => {
    S.settings.naturalVoice = name;
    saveSettings();
    store.set({});
  },
  setPreferNatural: (on) => {
    S.settings.preferNatural = !!on;
    saveSettings();
    store.set({});
  },
  setVoiceOut: (id) => {
    S.settings.voiceOut = id;
    if (id === 'off') talk.stopSpeaking();
    saveSettings();
    store.set({});
  },
  stop: () => gen?.controller.abort(),
  again,
  startFresh,
  forgetConversation,
  attach,
  attachPhoto,
  removePending,
  estimate: estimateFor,
  /** True when a short question to model m would stop for want of money once m is chosen (Choose a model's mark). */
  needsMoney: (m) => !!estimateFor('', { model: m }).needsMoney,
  /** Search the web for the next question (off again once it is sent). */
  setSearch: (on) => {
    S.search = !!on;
    store.set({});
  },
  saveDraft: (v) => {
    S.draft = v;
    kv.put('draft', v).catch(() => {});
    scratchChanged();
  },
  /**
   * Burns the open conversation (the answer screen's Burn), then goes home: in place of the answer, or
   * with the cover on back to the helper's home just above the game (backTo), so Back from it shows the
   * game.
   */
  burn: async () => {
    if (S.conv.id) await burnIds([S.conv.id]);
    const said = () => ui.toast(t('history.burned'), 3000);
    if (!coverOn()) {
      said();
      return nav('home', {}, { replace: true });
    }
    // A step back in the history, drawn when it lands: the home says it burned, the answer no longer can.
    onArrival = said;
    backTo('home');
  },
  burnConversation: async (id) => {
    await burnIds([id]);
    ui.toast(t('history.burned'), 3000);
  },
  burnAll: async () => {
    await burnEverything();
    ui.toast(t('history.burnedAll'), 3000);
  },
  listConversations: allConversations,
  openConversation,
  setAutoDelete: (id) => {
    S.settings.autoDelete = id;
    saveSettings();
    store.set({});
    sweeper.sweep();
  },
  eraseEverything: eraseAll,
  copyAnswer: async () => ui.toast((await ui.copy(lastExchange(S.conv.messages)?.answer.content ?? '')) ? t('answer.copied') : t('answer.copyFailed')),
  takeOut,
  /** The balance keys kept aside, for Erase everything's Copy keys. */
  keysAside: () => keysAside(),
  setLook: (id) => {
    S.settings.look = id;
    S.settings.lookPicked = true;
    applyLook();
    saveSettings();
    store.set({});
  },
  /** Mode and look: "Open as a game first" for a mode with a cover game (docs/PLAYFUL.md). */
  setGameFirst: (on) => {
    S.settings.gameFirst = !!on;
    keepMode();
    saveSettings();
    store.set({});
  },
  /** The cover game's own record on this phone, or null. */
  coverProgress: () => S.game ?? null,
  /** Keeps the cover game's record beside the settings; Erase everything removes it with them. */
  saveCoverProgress: (data) => {
    if (erased) return;
    S.game = data ?? null;
    kv.put('game', S.game).catch(() => {});
  },
  /** Mode and look: the mode that draws the home and the answer. Its screens load first; then it is saved. */
  setMode: async (id) => {
    if (!(await prepareMode(id))) return ui.toast(t('look.modeFailed'), 4000);
    S.settings.mode = id;
    keepMode();
    saveSettings();
    store.set({});
  },
  setFollowSystem: (on) => {
    S.settings.followSystem = on;
    applyLook();
    saveSettings();
    store.set({});
  },
  setPrivateOnly: (on) => {
    const before = pickModel(S.models, S.settings);
    S.settings.privateOnly = on;
    saveSettings();
    const m = pickModel(S.models, S.settings);
    if (modelChanged(before)) ui.toast(t('model.chosenNew', { name: m?.name ?? m?.id ?? '' }), 3000);
    store.set({});
  },
  /**
   * Start free's choice (screens/startfree.js): turns Private only off and chooses a free model (the
   * chosen one if it is free, else core/price.js freeModelChoice). Called only after the person said yes to using Standard models,
   * or with Private only off already. Returns the model, or null when the engine lists none.
   */
  useFreeModels: () => {
    // A free model already chosen stays chosen.
    const cur = pickModel(S.models, { ...S.settings, privateOnly: false });
    const m = isFreeModel(cur) ? cur : freeModelChoice(S.models);
    if (!m) return null;
    const before = pickModel(S.models, S.settings);
    // With Private only on, this follows a yes to Start free's question: the Private chip does not ask it again.
    if (S.settings.privateOnly) S.settings.standardOk = true;
    S.settings.privateOnly = false;
    Object.assign(S.settings, choiceOf(m));
    saveSettings();
    modelChanged(before);
    store.set({});
    return m;
  },
  /** Keeps the way to add money used last on this phone, so Add money shows its card first ('' for none). */
  setLastWay: (id) => {
    if (S.settings.lastWay === id) return;
    S.settings.lastWay = id;
    saveSettings();
  },
  /** Chooses the first free model Private only allows (Funds and Type offer it when free questions are left). */
  useFreeModel: () => {
    const m = (S.free?.models ?? []).map((id) => S.models.find((x) => x.id === id)).find((x) => x && pickModel([x], { ...S.settings, model: x.id }));
    if (!m) return nav('model');
    actions.chooseModel(m.id);
  },
  /**
   * Switches the engine (More, Engine): checks that the new one answers, saves it, then opens the app
   * again on it, so every part (balance key, prices, models) is read from the new engine. null: the
   * default. Resolves {ok: false} when the engine does not answer; nothing changes then.
   */
  setEngine: async (base) => {
    const next = base ?? defaultEngine(native);
    try {
      await createEngine({ base: next }).models();
    } catch {
      return { ok: false };
    }
    gen?.controller.abort();
    S.settings.engine = base ?? undefined;
    await saveSettings();
    history.replaceState(null, '', href('home'));
    location.reload();
    return { ok: true };
  },
  chooseModel: (id) => {
    const before = pickModel(S.models, S.settings);
    const m = S.models.find((x) => x.id === id);
    if (m) Object.assign(S.settings, choiceOf(m));
    else S.settings.model = id;
    saveSettings();
    const fresh = modelChanged(before);
    ui.toast(t(fresh ? 'model.chosenNew' : 'model.chosen', { name: m?.name ?? id }), fresh ? 3000 : 2600);
    store.set({});
  },
  /**
   * The Private (or Standard) chip at the top left of the home and the answer (owner, 2026-11-17): one tap
   * switches the kind of model in use (core/state.js kindSwitch: the one of that kind chosen last on this
   * phone, else the cheapest, or for Standard the free one). Leaving Private asks Start free's question
   * first, until the person says yes once on this phone; a no changes nothing. Switching to Private never
   * asks: with no money, asking says Not enough funds as on any paid model. A conversation on show (an
   * answer coming in, or the answer screen) stays on the screen, and the next question leaves it; on the
   * home a new conversation begins at once, as with Choose a model. With no model of the other kind, a
   * toast says so and nothing changes.
   */
  togglePrivate: async () => {
    if (askingKind) return;
    const toPrivate = !view().private;
    let next = kindSwitch(S.models, S.settings, { toPrivate, unit: homeUnit() });
    if (!next) return ui.toast(t(toPrivate ? 'privacy.noPrivate' : 'privacy.noStandard'), 3000);
    if (!toPrivate && !S.settings.standardOk) {
      askingKind = true;
      let yes = false;
      try {
        yes = await askStandard({ t, reader, free: isFreeModel(next.model) });
      } finally {
        askingKind = false;
      }
      if (!yes) return;
      S.settings.standardOk = true;
      // The list may have changed while the question was open.
      next = kindSwitch(S.models, S.settings, { toPrivate, unit: homeUnit() });
      if (!next) {
        saveSettings();
        return ui.toast(t('privacy.noStandard'), 3000);
      }
    }
    const before = pickModel(S.models, S.settings);
    S.settings.privateOnly = next.privateOnly;
    Object.assign(S.settings, choiceOf(next.model));
    saveSettings();
    const name = next.model.name ?? next.model.id;
    const moved = before?.id !== next.model.id;
    let key = 'model.chosen';
    if (moved && S.conv.messages.length && (gen || currentName === 'answer')) {
      // Left on the screen: the answer's own line names the model that wrote it.
      freshNext = S.conv.id;
      key = 'model.chosenNext';
    } else if (modelChanged(before)) key = 'model.chosenNew';
    ui.toast(t(key, { name }), 3000);
    store.set({});
  },
  /**
   * The slow-answer note's one tap (screens/answer.js): stops the answer still waiting, chooses a fast
   * model (core/state.js fastPick) and asks the same question there, in a new conversation. The slow
   * one stays in History. With no fast model to use, Choose a model opens.
   */
  useFastModel: async () => {
    // One switch at a time: a second tap while the slow answer is being settled would ask twice, and the
    // later switch would stop the earlier one's answer.
    if (switching) return;
    const v = view();
    const m = v.fastModel && S.models.find((x) => x.id === v.fastModel.id);
    if (!m) return nav('model');
    switching = true;
    try {
      const question = S.conv.messages.findLast?.((x) => x.role === 'user');
      if (gen) {
        gen.quiet = true;
        gen.controller.abort();
        await genIdle;
      }
      Object.assign(S.settings, choiceOf(m));
      saveSettings();
      await forgetConversation();
      ui.toast(t('answer.fastChosen', { name: m.name ?? m.id }), 3000);
      if (!question) return store.set({});
      S.conv = { id: newId('c'), messages: [{ ...question, id: newId('m') }], createdAt: Date.now() };
      await saveConv();
      nav('answer');
      generate();
    } finally {
      switching = false;
    }
  },
  /** The natural voice, asked for from the offer under Listen: it downloads now, then reads the answer. */
  getNaturalVoice: () => talk.getNatural(lastAnswer()),
  /** Not now on that offer: it is not offered again on this phone (More, Voice still has it). */
  naturalNotNow: () => talk.naturalNotNow(),
};

const format = {
  units: fmtUnits,
  int: fmtInt,
  cost: (msub, unit) => fmtCost(msub, unit ?? homeUnit()),
  plain: (n, unit) => (unit === 'usd' ? (n / 100).toFixed(2) : String(n)),
  parse: (s, unit) => {
    const v = String(s ?? '').replace(/[$,\s]/g, '');
    if (unit === 'usd') return /^\d+(\.\d{0,2})?$/.test(v) ? Math.round(Number(v) * 100) : NaN;
    return /^\d+$/.test(v) ? Number(v) : NaN;
  },
  modelPrice: (m) => {
    const unit = homeUnit();
    const p = unit === 'sat' && m.pricing?.sat_per_mtok ? m.pricing.sat_per_mtok : m.pricing?.usd_per_mtok;
    if (!p) return null;
    const f = (n) => (unit === 'sat' && m.pricing?.sat_per_mtok ? `${fmtInt(Math.round(n))} sat` : `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}`);
    return { input: f(p.input), output: f(p.output) };
  },
};

// ------------------------------------------------------------------ routing

const root = document.getElementById('app');
let current = null;
let currentName = 'home';
let rendered = false;
let unsub = null;

// The routes on the in-app history stack, by depth, so Done can go back to a screen instead of
// stacking a new copy of it. Each entry the app makes keeps the routes under it (its state's trail), and
// the trail is read back from it whenever an entry is shown: Back and Forward over entries the app did not
// make (an address typed or pasted, a link, the hash set by hand: no depth, so a new first entry) never
// leave it holding routes of other entries.
const trail = [];
const depth = () => history.state?.forge2 ?? 0;
/** The state of an entry at depth `d`, with the routes under it. */
const entry = (d) => ({ forge2: d, trail: trail.slice(0, d) });
// The depth of the entry on show, so a pop knows whether it went back.
let shownDepth = 0;
// Said once the next screen is drawn (the burn's words, after a step back that lands later).
let onArrival = null;

// Each screen drawn has its own number. A click whose press began on an earlier screen is dropped: the
// finger that held Pip or Burn is still down when the next screen is drawn, and lifting it must not press
// what is now under it (holding Pip opens the helper with Type where Pip was).
let screenNo = 0;
let pressedOn = -1;
function guardPresses() {
  addEventListener('pointerdown', () => (pressedOn = screenNo), true);
  addEventListener(
    'click',
    (e) => {
      // detail 0: a click with no press (a key, a screen reader), always for the screen it is on.
      if (e.detail === 0 || pressedOn === screenNo) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}

function nav(name, params = {}, { replace = false } = {}) {
  // With the cover on: the game is always the first entry, so Back from it never reaches the helper, and
  // the helper's home is the one just above it, so Back from the home shows the game. With no home under
  // this screen (it was opened by an address), the first entry becomes the home, the game put under it.
  if (!replace && coverOn()) {
    if (name === 'game') return leave('game');
    if (name === 'home' && currentName !== 'game' && currentName !== 'home') {
      for (let i = depth() - 1; i >= 0; i--) if (trail[i] === 'home') return history.go(i - depth());
      return leave('home');
    }
  }
  const h = href(name, params);
  if (h === location.hash || (h === '#/' && !location.hash)) return render();
  // An answer's entry keeps whose answer it is, so it is never shown again once that one is burned (onPop).
  const conv = name === 'answer' && S.conv.id ? { conv: S.conv.id } : {};
  if (replace) history.replaceState({ ...entry(depth()), ...conv }, '', h);
  else history.pushState({ ...entry(depth() + 1), ...conv }, '', h);
  render();
}

function back() {
  if (depth() > 0) history.back();
  else nav(parentOf(currentName), {}, { replace: true });
}

// Set by leave(): once the history stack has gone back to its first entry, that entry becomes `name`.
let afterPop = null;

/**
 * Leaves a flow of screens (the first run) for `name`: back to the nearest earlier `name` on the stack,
 * or else back to the first entry, which then becomes `name`. So the phone's back button does not walk
 * through the flow again afterwards.
 */
function leave(name) {
  for (let i = depth() - 1; i >= 0; i--) if (trail[i] === name) return history.go(i - depth());
  const d = depth();
  if (!d) return nav(name, {}, { replace: true });
  afterPop = name;
  history.go(-d);
}

function onPop() {
  // An event link opened while this page was open (only the address's #join=<pass> changed): the pass
  // leaves the address and is used, as on a fresh open.
  if (isJoinHash(location.hash)) {
    const pass = passFrom(location.hash);
    history.replaceState(history.state, '', location.pathname + location.search);
    if (live) joinWith(pass);
  }
  const to = parse(location.hash).name;
  if (afterPop) {
    const name = afterPop;
    afterPop = null;
    history.replaceState({ forge2: 0 }, '', href(name));
  } else if (to === 'answer' && burned.has(history.state?.conv)) {
    // The answer of a burned conversation (Burn in History or Burn all, opened from that answer): Back
    // (or Forward) never shows it again, but the home under it, or a home in its place.
    const i = (history.state.trail ?? []).lastIndexOf('home');
    if (i >= 0) return history.go(i - depth());
    history.replaceState({ forge2: depth(), trail: history.state.trail ?? [] }, '', href('home'));
  } else if (currentName === 'home' && coverOn() && history.state?.forge2 != null && depth() < shownDepth && to !== 'game') {
    // Back from the helper's home always shows the game (the first entry), however the home was reached:
    // an event link that reaches the app while the helper is open puts a home over Type (joinOnce), say.
    // Only Back onto an entry the app made: an address set by hand is a new first entry, shown as it is.
    if (depth() > 0) return history.go(-depth());
    history.replaceState({ forge2: 0 }, '', href('game'));
  } else if (currentName === 'game' && coverOn() && to !== 'game') {
    // Back (or Forward) from the cover game never shows the helper: the game stays. On a page reloaded
    // deep in the helper, older entries are still behind it.
    history.replaceState({ forge2: 0 }, '', href('game'));
  }
  render();
}

// ------------------------------------------------------------------ event links (core/join.js)

// A file or photo picker is up (the cover waits for it; see start()).
let picking = false;
/** The routes a photo shared in from another app opens: the cover does not take their place at start. */
const SHARED_IN = ['photoShared', 'photoMissed', 'photoNone', 'photoSent'];

// Set by joinWith for the Start free screen it opens: that screen starts on the question.
let joinAsk = false;

/**
 * An event pass (/j#<pass> on an event's slide; docs/ANDROID.md, Event links), from the address
 * (#join=<pass>) or from the Android app (ForgeJoin). With no balance key yet, it opens a free balance
 * the way Start free does (wallet.open), the first run is over, and the person is asked, in Start free's
 * words, before Private only is turned off for the free models; then the home. A phone that holds a key
 * already keeps it and spends nothing. A refused pass (used up, expired) is said in a toast, and the
 * phone goes on as on any first open: the first run, with its own Start free.
 *
 * One at a time: a pass that comes while one is being used (the QR code scanned twice on slow wifi, so
 * the app gets the link twice) is dropped, not queued. The key is only kept once wallet.open answers, so a
 * second open would make a second balance, spend a second use of the pass and orphan the first key; and
 * once the first open is done, joinPlan keeps that key anyway.
 */
let joinJob = null;
function joinWith(pass) {
  if (joinJob) return joinJob;
  joinJob = joinOnce(pass).finally(() => {
    joinJob = null;
  });
  return joinJob;
}

async function joinOnce(pass) {
  if (erased) return;
  const plan = joinPlan({ pass, hasKey: anyKey() });
  if (plan !== 'open') return;
  ui.toast(t('fund.invite.opening'), 8000);
  try {
    await wallet.open(pass);
  } catch (e) {
    ui.toast(inviteError(e, t), 5000);
    if (ui.load(SEEN_KEY) !== SEEN_VALUE && currentName === 'home') nav(STEP_ROUTES.welcome, {}, { replace: true });
    return;
  }
  keep(SEEN_KEY, SEEN_VALUE);
  if (!S.settings.privateOnly) {
    // Private only is off already: a free model is chosen, no question.
    const m = actions.useFreeModels();
    ui.toast(m ? t('startFree.ready', { name: m.name ?? m.id }) : t('startFree.opened'), 4000);
    if (currentName !== 'home') leave('home');
    else store.set({});
    return;
  }
  // Start free's question says "Your balance is open." above itself.
  ui.hideToast();
  joinAsk = true;
  if (currentName !== 'home') nav('home', {}, { replace: true });
  nav('startFree');
}

/** The Android app was opened on an event link while it ran: the pass it holds is taken and used. */
async function joinFromApp() {
  const pass = await native?.join?.take();
  if (pass) await joinWith(pass);
}

/** First run: marks it seen (Skip or Start), then goes to the home. */
function finishIntro() {
  keep(SEEN_KEY, SEEN_VALUE);
  leave('home');
}

// The card Add money opens on, once (introAddMoney).
let firstWay = null;

/** First run, "I'll add money instead": marks it seen, then opens Add money on the paper note's card, the home under it. */
function introAddMoney() {
  keep(SEEN_KEY, SEEN_VALUE);
  firstWay = 'note';
  nav('home', {}, { replace: true });
  nav('addFunds');
}

/** Goes back to the nearest earlier `name` on the stack, or replaces this screen with it. */
function backTo(name) {
  // With the cover on, the helper's home is only ever the one just above the game (nav).
  if (name === 'home' && coverOn()) return nav('home');
  for (let i = depth() - 1; i >= 0; i--) if (trail[i] === name) return history.go(i - depth());
  nav(name, {}, { replace: true });
}

let voiceLab = null; // screens/voicelab.js, once the voice lab was opened
let voiceLabError = null; // why the voice lab could not load, shown on its page
/** The voice lab's page when it cannot load or draw: the error in words, with the browser's own message. */
function labErrorScreen(e) {
  return {
    node: ui.el(
      'main',
      { class: 'screen sub', 'data-screen': 'voiceLabError' },
      ui.el('h1', { text: t('lab.title') }),
      ui.el('p', { class: 'hint', id: 'labLoadError', text: t('lab.loadFailed') }),
      ui.el('pre', { class: 'hint', id: 'labLoadErrorDetail', text: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}\n${navigator.userAgent}` }),
    ),
  };
}

function screenFor(name, params) {
  const mode = modeNow();
  const ctx = { t, ui, state, nav, back, backTo, actions, format, registry, vault, wallet, qr: QR, native, reader, scan: adapters.camera, engineBase: engine.base, cardJobs: cardJobCount, tillJobs: () => tillPays.waiting().length };
  switch (name) {
    case 'add':
      return mode.home({ sheet: addSheet(ctx), open: 'add' });
    case 'more':
      return mode.home({ sheet: moreSheet(ctx), open: 'more' });
    case 'answer':
      return mode.answer();
    case 'game':
      return coverOn() ? mode.cover() : mode.home();
    case 'type':
      return typeScreen(ctx);
    case 'funds':
      return fundsScreen(ctx);
    case 'addFunds': {
      const first = firstWay;
      firstWay = null;
      return walletScreen({ ...ctx, first });
    }
    case 'startFree': {
      // Opened by an event link (joinWith): on the question, then home.
      const joined = joinAsk;
      joinAsk = false;
      return startFreeScreen({ ...ctx, joined });
    }
    case 'fund':
      return fundScreen(ctx, params);
    case 'takeOut':
    case 'takeOutUnit':
      return takeOutScreen(ctx, params);
    case 'freeOut':
      return freeOutScreen({ ...ctx, engine: engineProxy });
    case 'look':
      return lookScreen(ctx);
    case 'model':
      // A model chosen closes the list: home when it was opened from the More menu (or by its address),
      // else back where it was opened (an error's Choose a model, say). Home is gone back to, not pushed
      // over the list, so the phone's Back does not open the More menu again.
      // A model with the Add money mark goes on to Add money in place of the list, so Back from there goes
      // where the list was opened from; once money is in, Ask now goes home with that model chosen.
      return modelScreen({ ...ctx, done: () => (depth() === 0 || trail[depth() - 1] === 'more' ? backTo('home') : back()), addMoney: () => nav('addFunds', {}, { replace: true }) });
    case 'modelPhoto':
      // With no photo waiting (the page was opened again on this address), the plain list.
      if (!photoWaiting) return modelScreen({ ...ctx, done: () => backTo('home'), addMoney: () => nav('addFunds', {}, { replace: true }) });
      return modelScreen({ ...ctx, photo: photoChoice });
    case 'voice':
      return voiceScreen({ ...ctx, voice: { inMods: () => voiceMods('voice-in'), outMods: () => voiceMods('voice-out'), outUsed: () => voiceOut()?.id ?? null, audio, natural: { voices: () => phonon.index()?.voices ?? [], picked: () => phonon.voice() } } });
    case 'history':
      return historyScreen(ctx);
    case 'voiceLab':
      // A developer page, linked from nowhere: measures the voices this phone can run. Loaded only
      // when opened, so the app's first paint never waits for it.
      if (voiceLabError) return labErrorScreen(voiceLabError);
      if (!voiceLab) {
        import('./screens/voicelab.js').then(
          (m) => {
            voiceLab = m.voiceLabScreen;
            if (currentName === 'voiceLab') render();
          },
          (e) => {
            // A developer page: say what failed instead of staying blank (an older Safari, say).
            voiceLabError = e;
            if (currentName === 'voiceLab') render();
          },
        );
        return { node: ui.el('main', { class: 'screen sub', 'data-screen': 'voiceLabLoading' }, ui.el('p', { class: 'hint', text: t('lab.opening') })) };
      }
      try {
        return voiceLab({ ...ctx, phonon, speaker: adapters.speaker, nativeVoice: native?.voice ?? null });
      } catch (e) {
        return labErrorScreen(e);
      }
    case 'intro':
    case 'introPay':
    case 'introLimits':
    case 'introPrivate':
      // The recorded Listen clips: their manifest is read once, and Listen shows when it is in.
      clips.load().then((m) => m && store.set({}));
      return firstRunScreen({ ...ctx, step: stepOfRoute(name), go: (step) => nav(STEP_ROUTES[step]), finish: finishIntro, addMoney: introAddMoney, reader });
    case 'erase':
      return eraseScreen(ctx);
    case 'engine':
      return engineScreen({ ...ctx, engine: { current: () => engine.base, fallback: defaultEngine(native), set: actions.setEngine } });
    case 'photo':
    case 'photoShared':
    case 'photoMissed':
    case 'photoNone':
    case 'photoSent':
      return photoScreen({
        ...ctx,
        params: { from: { photoShared: 'shared', photoMissed: 'missed', photoNone: 'none', photoSent: 'sent' }[name] },
        filters: (registry.list('filter') ?? []).map((x) => x.instance),
        share: adapters.share,
        ...(native?.shareIn ? { take: native.shareIn.take, forget: native.forget } : {}),
      });
    default:
      return mode.home();
  }
}

function render() {
  if (erased) return;
  // A new build took over while the person was busy: it loads now, on the way to the next screen.
  if (updater?.screenChanged()) return;
  // A balance key stored after this page read it (the Classic app in another tab, say) is picked up here.
  if (registry) {
    const stored = [ui.load(keyStore()), ui.load(keyStore2())];
    if (stored.some((k, i) => k && !S.keys[i])) {
      S.keys = S.keys.map((k, i) => k ?? stored[i] ?? null);
      refreshBalance();
    }
  }
  // The same for the free balance key, and for a voucher the /free page left on this phone to add.
  if (registry) {
    const fk = !S.freeKey && ui.load(freeKeyStore());
    if (fk) S.freeKey = fk;
    if (fk || vault.incoming().some((x) => x.via === 'free' && x.state === 'pending' && !x.code)) retryAll().then(() => refreshBalance());
  }
  const { name, params } = parse(location.hash);
  // The helper's home with nothing under it while the cover is on (the cover just turned on, a first run
  // left for the home): the game goes under it, so Back shows the game.
  if (name === 'home' && depth() === 0 && coverOn()) {
    history.replaceState({ forge2: 0 }, '', href('game'));
    trail[0] = 'game';
    history.pushState(entry(1), '', href('home'));
  }
  unsub?.();
  current?.destroy?.();
  currentName = name;
  screenNo++;
  const below = history.state?.trail;
  if (Array.isArray(below)) trail.splice(0, trail.length, ...below);
  trail[depth()] = name;
  trail.length = depth() + 1;
  shownDepth = depth();
  current = screenFor(name, params);
  root.replaceChildren(current.node);
  root.dataset.route = name;
  // The cover game's name and icon, for index.html's first frame next time.
  if (name === 'game' && coverOn()) keep(COVER_CACHE, JSON.stringify({ title: document.title, icon: new URL(document.querySelector('link[rel="icon"]')?.href ?? '/', location.href).pathname }));
  // index.html's first frame in a mode's ground (data-boot-mode) is over: the screen draws its own.
  delete document.documentElement.dataset.bootMode;
  unsub = store.subscribe(() => current?.update?.());
  // Move focus to the new screen on navigation (not on the first paint, and not on the home).
  if (rendered && name !== 'home') current.focus?.focus?.({ preventScroll: true });
  rendered = true;
  if (onArrival) {
    const say = onArrival;
    onArrival = null;
    say();
  }
  if (name === 'takeOut' || name === 'takeOutUnit' || name === 'funds') {
    collectRefunds();
    settleOtherMint();
    resumeCards();
    resumeTillPays();
  }
}

// ------------------------------------------------------------------ erase everything

/**
 * Erase everything (core/erase.js): stops all work, wipes what this page holds in memory, removes
 * every trace of Forge from this browser's storage, then shows the Erased screen. Nothing is drawn or
 * written after this until the page is opened again.
 */
async function eraseAll() {
  if (erased) return;
  halt();
  await workerSettled();
  // In the Android app: a photo shared in and not yet taken, the photo files the app wrote, the web
  // view's own cache, and the till a Fedimint card pays through (its address and token).
  if (native) await Promise.all([native.shareIn?.clear(), native.join?.clear(), native.forget?.(), native.till?.forget()]);
  const r = await eraseEverything(browserStorage(), { closeOwn: shutdown });
  if (!r.ok) console.warn('erase left', r.left, r.blocked);
  showErased(r.ok);
}

/** The browser's storage for this site, as core/erase.js takes it. */
const browserStorage = () => ({ localStorage, sessionStorage, indexedDB: globalThis.indexedDB, caches: globalThis.caches, serviceWorker: navigator.serviceWorker });

/** Stops all work and wipes what this page holds in memory. From here on nothing is written or drawn. */
function halt() {
  erased = true;
  sweeper.stop();
  gen?.controller.abort();
  talk.cancel();
  talk.stopSpeaking();
  for (const x of registry?.list('voice-out') ?? []) x.instance.forget?.();
  unsub?.();
  current?.destroy?.();
  Object.assign(S, { keys: [null, null], keyUnits: {}, bal: { usd: null, sat: null }, freeKey: null, freeMsub: null, freeTotal: 0, conv: { id: null, messages: [] }, pending: [], draft: '', invite: '', game: null });
}

/**
 * Erase everything was done in another tab of this site: localStorage was cleared there, or the
 * database is being deleted. This tab stops too, so it cannot write anything back (a look, a cached
 * model list, a conversation), then waits a few seconds for the other tab to finish and shows the
 * Erased screen. It says everything is gone only when its own check finds nothing left.
 */
async function erasedElsewhere() {
  if (erased) return;
  halt();
  await shutdown();
  const env = browserStorage();
  let left = await leftovers(env);
  for (let i = 0; i < 24 && !isEmpty(left); i++) {
    await new Promise((r) => setTimeout(r, 250));
    left = await leftovers(env);
  }
  showErased(isEmpty(left));
}

/** Draws the Erased screen in place of the app. */
function showErased(ok) {
  current = erasedScreen({ t, ok });
  currentName = 'erased';
  screenNo++;
  root.replaceChildren(current.node);
  root.dataset.route = 'erased';
  // The address no longer points at a screen of the app that was.
  history.replaceState(null, '', '#/');
  current.focus?.focus?.({ preventScroll: true });
}

// ------------------------------------------------------------------ start

/**
 * Waits for the stylesheet. It sits after the page's own first paint (index.html), so it does not hold
 * that up; the app's screens are drawn only once it is in.
 */
function stylesReady() {
  const link = document.querySelector('link[rel="stylesheet"][href="/v2/style.css"]');
  if (!link || link.sheet) return null;
  return new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
  });
}

async function start() {
  if (reloadForIsolation({ native, isolated: globalThis.crossOriginIsolated === true, session: sessionStorage })) return location.reload();
  // index.html titled the first frame with the cover game's name (docs/PLAYFUL.md): the game keeps it.
  if (!document.documentElement.dataset.bootCover) document.title = t('app.name');
  // The visible height above a phone keyboard, for Type (core/viewport.js).
  watchViewport();
  // Erase everything in another tab clears localStorage there (key null) and deletes the database.
  onErasedElsewhere(erasedElsewhere);
  addEventListener('storage', (e) => e.key === null && e.storageArea === localStorage && erasedElsewhere());
  const saved = await kv.get('settings').catch(() => null);
  S.settings = loadedSettings(saved);
  // The cover game's own record (its level, flowers and board), kept beside the settings.
  S.game = (await kv.get('game').catch(() => null)) ?? null;
  engine = createEngine({ base: engineBase(), encryptedFetch: tinfoilFetch(engineBase()) });
  // The two balance keys: the first where it always was (the Classic page's name), the second beside it.
  S.keys = [ui.load(keyStore()) ?? null, ui.load(keyStore2()) ?? null];
  // The units of keys this phone made itself are known before the engine answers (makeKey).
  S.keyUnits = Object.fromEntries(Object.entries(newKeys()).filter(([k]) => S.keys.includes(k)));
  S.freeKey = ui.load(freeKeyStore());
  S.freeTotal = (await kv.get(`freeTotal:${engine.base}`).catch(() => null)) ?? 0;
  S.peaks = { usd: null, sat: null, ...((await kv.get(`peaks:${engine.base}`).catch(() => null)) ?? {}) };
  // The one full mark kept before two balances: the first key's, once its unit is known (refreshBalance).
  legacyPeak = (await kv.get(`peak:${engine.base}`).catch(() => null)) ?? null;
  S.pending = ((await kv.get('pending').catch(() => null)) ?? []).filter((a) => a.status === 'ready');
  S.draft = (await kv.get('draft').catch(() => null)) ?? '';
  // Auto-delete on open: what is past its time (or everything, with "on close") goes before anything is shown.
  await sweeper.sweep({ opening: true }).catch(() => {});
  // A photo shared in from another app waits only for the page it opened (Share unseen). Opened any
  // other way, an old one that was never read is removed.
  if (parse(location.hash).name !== 'photoShared') await globalThis.caches?.delete(SHARE_CACHE).catch(() => {});
  // An event link (core/join.js): the pass leaves the address at once, so it stays out of the history
  // and any bookmark, and is used once the models are in (joinWith). In the Android app it comes from
  // the link that opened the app (ForgeJoin).
  let joinPass = null;
  if (isJoinHash(location.hash)) {
    joinPass = passFrom(location.hash);
    history.replaceState(history.state, '', location.pathname + location.search);
  }
  if (native?.join) joinPass ??= await native.join.take();
  // In the Android app a photo shared in waits in the app (ForgeShareIn), and opens Share unseen.
  if (native?.shareIn && (await native.shareIn.waiting())) history.replaceState(history.state, '', href('photoShared'));
  // First run: a phone that has not seen it opens on Welcome instead of the home (core/firstrun.js). A
  // pass that will open a balance decides instead (joinWith).
  const joining = joinPlan({ pass: joinPass, hasKey: anyKey() }) === 'open';
  if (!joining && shouldShow({ seen: ui.load(SEEN_KEY) === SEEN_VALUE, route: parse(location.hash).name })) history.replaceState(history.state, '', href(STEP_ROUTES.welcome));
  const cur = await kv.get('current').catch(() => null);
  if (cur) S.conv = (await chats.get(cur).catch(() => null)) ?? { id: null, messages: [] };
  // An answer that was streaming when the tab was killed is kept as stopped.
  for (const m of S.conv.messages) if (m.role === 'assistant' && !m.content && !m.meta?.error && !m.meta?.stopped) m.meta = { ...m.meta, stopped: true };

  // Which natural-voice files this app has (a small index, read once); the voice is offered once it is in.
  phonon.init().then((x) => x && store.set({}));
  // The phone's own voices are often listed only a while after the page opens (iOS Safari): the Phone
  // voice is offered once they are.
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', () => store.set({}));
  const loader = bundledLoader();
  registry = createRegistry({
    ...loader,
    inputs: { t, ui, state, nav, actions, format, engine: engineProxy, wallet, vault, scan: adapters.camera, qr: QR, nfc, card: cards, till, mic: adapters.mic, recognizer: adapters.recognizer, speech: native?.speech ?? null, asr: native?.asr ?? null, speaker: adapters.speaker, synth: adapters.synth, audio, phonon },
  });
  // The looks and the mode are all a screen needs to be drawn. On the first run they are the only
  // modules waited for: its steps are drawn at once, and the rest (fund, voice, filter) load behind them
  // (the How you pay step fills in its ways when they arrive). Any other screen waits for all of them,
  // which load at the same time (core/registry.js).
  const firstRun = stepOfRoute(parse(location.hash).name) !== null;
  const drawFirst = BUNDLED.filter((m) => m.kind === 'look' || m.kind === 'mode');
  const rest = BUNDLED.filter((m) => !drawFirst.includes(m));
  await registry.loadAll(firstRun ? drawFirst : BUNDLED);
  if (!registry.list('mode').length) throw new Error('no mode module');
  applyLook();
  // A mode other than Default: its screens, styles and fonts before the first frame (else Default draws).
  if (S.settings.mode && S.settings.mode !== 'default') await prepareMode(S.settings.mode);
  keepMode();
  // The cover: opened fresh, the app shows the game, never the helper. A photo shared in from another app
  // still opens Share unseen, and the first run its own steps.
  const opening = parse(location.hash).name;
  if (coverOn() && !SHARED_IN.includes(opening) && stepOfRoute(opening) === null) history.replaceState({ forge2: 0 }, '', href('game'));
  // No cover after all (its mode could not load offline, say): the app's own title again.
  if (!coverOn() && document.documentElement.dataset.bootCover) {
    delete document.documentElement.dataset.bootCover;
    document.title = t('app.name');
  }
  await stylesReady();

  addEventListener('popstate', onPop);
  guardPresses();
  native?.shareIn?.onShared(() => !erased && nav('photoShared'));
  native?.join?.onJoin(() => !erased && live && joinFromApp());
  addEventListener('online', () => {
    store.set({ online: true });
    retryMethods();
    retryAll().then((n) => n && refreshBalance());
    settleOtherMint();
    resumeCards();
    resumeTillPays();
  });
  addEventListener('offline', () => store.set({ online: false }));
  // Auto-delete while open: the sweeper's timer, and a check whenever the app comes back to the front
  // (timers sleep while a phone screen is off). "On close" starts removing everything as the page goes.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && !erased && sweeper.sweep());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && retryMethods());
  // The cover: the app put away shows the game when it comes back (and in the phone's list of open apps),
  // whatever screen was open. Not while a file or photo picker the person opened is up: the file comes back
  // to the screen that asked for it.
  document.addEventListener('click', (e) => e.target instanceof HTMLInputElement && e.target.type === 'file' && (picking = true), true);
  addEventListener('focus', () => (picking = false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') picking = false;
    else if (!picking && !erased && currentName !== 'game' && coverOn()) leave('game');
  });
  addEventListener('pagehide', () => S.settings.autoDelete === 'close' && !erased && burnEverything());
  addEventListener('pageshow', (e) => e.persisted && S.settings.autoDelete === 'close' && !erased && burnEverything().then(() => nav('home', {}, { replace: true })));
  render();
  live = true;
  if (firstRun) {
    await registry.loadAll(rest);
    store.set({});
  }
  // The phone's own recogniser says whether it has the language a moment after the app opens: then Hold to talk uses it.
  for (const m of ['bundled', 'phone']) voiceMods('voice-in')[m]?.checked?.then(() => store.set({}));
  if (registry.refused.length) console.warn('modules refused', registry.refused);
  document.documentElement.dataset.ready = '1';

  await loadModels();
  await refreshBalance();
  await joinWith(joinPass);
  const n = await retryAll();
  if (n) await refreshBalance();
  await settleOtherMint();
  await resumeCards();
  await resumeTillPays();
  registerWorker();
}

/** The engine as fund modules see it: always the current engine object. */
const engineProxy = new Proxy({}, { get: (_, k) => engine[k] });

/** Card taps: the app's reader (Android or iPhone), or the website's stand-in that says a page cannot read cards. */
const nfc = native?.nfc ?? adapters.nfc;
/**
 * Taking eCash off a Cashu card (core/card/flow.js), with the card's mint reached through the current
 * engine. Loaded the first time it is needed, so its curve library is not fetched with every page.
 */
let cardsLoading = null;
const loadCards = () =>
  (cardsLoading ??= import('./core/card/flow.js').then((m) => ({
    flow: m.createCardFunding({ storage, relay: { mint: (b) => engine.cardMint(b), swap: (b) => engine.cardSwap(b), restore: (b) => engine.cardRestore(b) } }),
    handToken: m.handToken,
  })));
/** How many card payments this phone holds (core/card/flow.js keeps them under forge2.cards). */
function cardJobCount() {
  try {
    return (JSON.parse(storage.getItem('forge2.cards') ?? '{}').jobs ?? []).length;
  } catch {
    return 0;
  }
}
const cardJobsWaiting = () => cardJobCount() > 0;
const cards = { load: loadCards };

/**
 * Fedimint cards (core/till.js): the till they pay through is the Android app's (ForgeTill, which keeps
 * its token); on the website a stand-in that has none. Payments are kept under forge2.tillpays.
 */
const tillTransport = native?.till ?? adapters.till;
const tillSettings = createTillSettings(storage);
const tillPays = createTillPays({ storage, transport: tillTransport, settings: tillSettings });
const till = {
  supported: () => tillTransport.supported(),
  status: () => tillTransport.status(),
  pair: (text) => tillTransport.pair(text),
  forget: () => tillTransport.forget(),
  pays: tillPays,
  settings: tillSettings,
};

/**
 * Fedimint card payments this phone holds that wait on the engine or the till (the person left the
 * screen): the engine is asked whether its invoice was paid, then the till where its pay stands. A
 * payment the till owes the card for waits for that card's tap in Tap a Fedimint card.
 */
async function resumeTillPays() {
  const list = tillPays.waiting().filter((p) => (p.engine ?? '') === (engine.base ?? ''));
  if (!list.length || !anyKey()) return;
  let credited = 0;
  for (const p of list) {
    try {
      // A payment's funding is the balance's in its unit.
      const key = (p.unit && keyFor(p.unit)) || homeKey();
      if (key && p.fundingId && p.state !== 'pay_failed') {
        const f = await engine.funding(key, p.fundingId);
        if (f.ok && f.body?.state === 'done') {
          tillPays.credited(p.id);
          credited++;
          continue;
        }
      }
      if (p.payId && (p.state === 'undecided' || p.state === 'sent')) await tillPays.check(p.id);
    } catch {
      /* offline: next time */
    }
  }
  if (credited) await refreshBalance();
  store.set({});
}

let workerReg = null;
let updater = null;

/**
 * Whether the person is mid-way, so a new build waits for the next screen (core/updates.js): Listen
 * playing (the first run's or a screen's), words typed and not sent, a recording, a question being
 * sent or answered, or an answer read aloud.
 */
function busyForUpdate() {
  const v = state.view();
  if (v.talk.phase === 'recording' || v.talk.phase === 'sending' || v.streaming) return true;
  if (v.speak.current && v.speak.state !== 'idle') return true;
  if (document.querySelector('.fr-listen[aria-pressed="true"], .listen-chip[aria-pressed="true"]')) return true;
  return [...document.querySelectorAll('input:not([readonly]):not([type=file]), textarea:not([readonly])')].some((f) => f.value !== f.defaultValue);
}

function registerWorker() {
  // The apps have their files on the phone, so they need no offline copy and no worker.
  if (erased || native || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const sw = navigator.serviceWorker;
  let storage = null;
  try {
    storage = sessionStorage;
  } catch {
    /* no session storage: the updater never reloads on its own */
  }
  // Only v2's own worker counts as an older build of this app. v1's worker has the whole origin until
  // v2's takes /v2/ over, and that first takeover must not reload the page under the person's finger.
  const ours = (w) => !!w && new URL(w.scriptURL).pathname === '/v2/sw.js';
  updater = createUpdater({ storage, hadController: ours(sw.controller), busy: busyForUpdate, reload: () => location.reload() });
  // A new worker (a new build: its script carries the build id) took over: reload once into its files.
  sw.addEventListener('controllerchange', () => {
    if (!erased) updater.controllerChanged();
    showBuild();
  });
  workerReg = sw.register('/v2/sw.js', { scope: '/v2/', updateViaCache: 'none' }).catch(() => null);
  // A tab brought back (from the background, or restored from the back-forward cache) asks for a newer
  // build; one left waiting is told to take over, which fires controllerchange above.
  const check = async () => {
    const reg = await workerReg;
    if (!reg || erased) return;
    await reg.update().catch(() => {});
    reg.waiting?.postMessage({ type: 'skipWaiting' });
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  addEventListener('pageshow', (e) => e.persisted && check());
  showBuild();
  check();
}

/** Puts the build id of the worker that serves this page on <html data-build>, so a stale page can be told apart. */
function showBuild() {
  const c = navigator.serviceWorker?.controller;
  if (!c || typeof MessageChannel !== 'function') return;
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => {
    if (e.data?.version) document.documentElement.dataset.build = e.data.version;
  };
  c.postMessage({ type: 'version' }, [ch.port2]);
}

/** Waits (a few seconds at most) for a worker that is still installing, so it cannot fill a cache after Erase. */
async function workerSettled() {
  const reg = await workerReg;
  const w = reg?.installing;
  if (!w) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    w.addEventListener('statechange', () => w.state !== 'installing' && (clearTimeout(timer), resolve()));
  });
}

start().catch((e) => {
  console.error(e);
  root.replaceChildren(ui.el('p', { class: 'fatal', role: 'alert', text: t('app.failed') }));
});
