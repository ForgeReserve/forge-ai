// Forge AI v2. Plain ES modules, no build step, nothing loaded from another origin.
// The app shell: loads the bundled modules through the registry, applies the look, talks to the engine,
// keeps the state and draws one screen at a time from the hash route.
import { fmtBalance, fmtCost, fmtInt, fmtUnits } from '../js/ui.js';
import { kindOf, MAX_FILES, BODY_LIMIT } from '../js/files.js';
import { lockKey } from '../js/lockkey.js';
import * as QR from '../js/qr.js';
import { adapters, setAdapter } from './core/adapters.js';
import { againHistory, lastExchange, memoryView, pendingMessage, apiMessages, tokensOf } from './core/conversation.js';
import { chats, kv, onErasedElsewhere, shutdown } from './core/db.js';
import { eraseEverything, isEmpty, leftovers } from './core/erase.js';
import { SEEN_KEY, SEEN_VALUE, shouldShow, STEP_ROUTES, stepOfRoute } from './core/firstrun.js';
import { createSweeper, lastUsed } from './core/history.js';
import { chatPayload, createEngine, EngineError, tinfoilFetch } from './core/engine.js';
import { createNative, defaultEngine, reloadForIsolation } from './core/native.js';
import { freeInfo, freeKeyName, freeLeft, freeMaxTokens, fundsBlock, isCreditMint, nextFreeTotal, useFree } from './core/free.js';
import { readNote } from './core/note.js';
import { createTillPays, createTillSettings } from './core/till.js';
import { chargedFor, errorView } from './core/errors.js';
import { t } from './core/i18n.js';
import { MAX_IMAGES, shrinkImage } from './core/image.js';
import { SHARE_CACHE } from './core/photo.js';
import { ehbpBytes, estimate, holdMsub, perQuestion } from './core/price.js';
import { SPEAK_MAX_CHARS } from './core/speech.js';
import { watchViewport } from './core/viewport.js';
import { createTalk } from './core/talkctl.js';
import { createClips } from './core/clips.js';
import { createPhonon, meterNumbers as phononMeter } from './core/phonon.js';
import { audioModels, audioMsub, CHARS_PER_SECOND } from './core/voice.js';
import { refundsToOffer } from './core/refunds.js';
import { BUNDLED, bundledLoader, createRegistry } from './core/registry.js';
import { fundsSegments, nextPeak, questionsLeft } from './core/rings.js';
import { href, parentOf, parse } from './core/router.js';
import { createStore, DEFAULT_SETTINGS, hiddenCount, isPrivate, keyName, pickModel, pickVoiceIn, pickVoiceOut } from './core/state.js';
import * as ui from './core/ui.js';
import { createVault, retryPending, topupWithVault } from './core/vault.js';
import { settlePendingForeign } from './modules/fund/kit.js';
import { engineScreen } from './screens/engine.js';
import { eraseScreen, erasedScreen } from './screens/erase.js';
import { firstRunScreen } from './screens/firstrun.js';
import { freeOutScreen } from './screens/free.js';
import { addFundsScreen, fundScreen, fundsScreen, takeOutScreen } from './screens/funds.js';
import { historyScreen } from './screens/history.js';
import { photoScreen } from './screens/photo.js';
import { lookScreen, modelScreen, voiceScreen } from './screens/settings.js';
import { addSheet, moreSheet } from './screens/sheets.js';
import { typeScreen } from './screens/type.js';

const MAX_OUT = 4096; // the most output a question asks for; the engine holds the worst case up front (questionHold)
const MODELS_CACHE = 'forge2.models';
const LOOK_CACHE = 'forge2.look';

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
  key: null,
  unit: null,
  balanceMsub: null,
  availableMsub: null,
  peakMsub: null,
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
});
const S = store.S;

// Inside the Android app (core/native.js): its share sheet, photos shared in, and Forge's engine as the
// default, since the app's own origin (https://localhost) has no engine. null on the website.
const native = createNative();
if (native) setAdapter('share', native.share);

const engineBase = () => S.settings.engine || defaultEngine(native);

// The natural voice made on the phone (core/phonon.js). Its files are on this app's own address, or in
// the APK in the Android app, where there is nothing to download. It runs on the graphics chip or the
// processor (core/phonon.js chooseVoiceDevice); a WebGPU failure is remembered in the settings
// (voiceDevice), so the next start goes straight to the processor.
const phonon = createPhonon({
  native: !!native,
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
const freeKeyStore = () => freeKeyName(engine.base, location.origin);

// ------------------------------------------------------------------ derived view

let memo = { k: '', v: null };
function memoryNow(model) {
  const k = `${S.conv.id}|${S.conv.messages.length}|${S.streaming}|${S.pending.map((a) => a.id + a.status).join(',')}|${model?.id}`;
  if (memo.k !== k) memo = { k, v: memoryView(S.conv.messages, S.pending, { systemPrompt: t('system.prompt'), vision: !!model?.capabilities?.vision, contextLength: model?.context_length }) };
  return memo.v;
}

let againMemo = { k: '', models: null, audioModels: null, v: null };
/** What Ask again would cost now, or null while an answer streams or with nothing to ask again. */
function againNow(model) {
  if (S.streaming || !model) return null;
  const msgs = S.conv.messages;
  const voice = msgs.findLast?.((m) => m.role === 'user')?.meta?.voice ? 'v' : '';
  const k = `${S.conv.id}|${msgs.length}|${model.id}|${S.unit}|${msgs.at(-1)?.meta?.error ? 'e' : ''}|${voice}|${voiceOut()?.id ?? ''}`;
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
  const unit = S.unit ?? 'usd';
  const mem = memoryNow(model);
  const hasKey = !!S.key;
  const fr = freeNow(model);
  const paidNone = !hasKey || S.balanceMsub === 0;
  const seg = fundsSegments({ balanceMsub: hasKey ? S.balanceMsub : 0, peakMsub: S.peakMsub, freeLeft: fr.left, freeTotal: fr.total, perQuestionMsub: perQuestion(model, unit) });
  return {
    model,
    // With no model to use, Private only still decides: nothing is sent to a standard model.
    private: model ? isPrivate(model) : !!S.settings.privateOnly,
    online: S.online,
    hasKey,
    balanceMsub: hasKey ? S.balanceMsub : null,
    balanceText: hasKey && S.balanceMsub != null ? fmtBalance(S.balanceMsub, S.unit) : null,
    // The gold ring: free questions as a lighter segment first, then the paid balance (core/rings.js).
    fundsFraction: seg.paid,
    freeFraction: seg.free,
    freeLeft: fr.left,
    freeTotal: fr.total,
    // What stops a question for lack of funds, if anything (core/free.js fundsBlock).
    fundsBlock: fundsBlock({ paidMsub: paidNone ? 0 : S.balanceMsub, freeLeft: fr.left, freeTotal: fr.total, freeUsable: fr.use }),
    // No funds at all (no balance yet or a balance at zero, and no free questions): the home and Funds
    // show their empty state, and the gold ring invites a paper note scan.
    noFunds: paidNone && fr.left === 0,
    scanNote: paidNone && fr.left === 0 && !!registry?.list('fund').some((x) => x.instance.id === 'note'),
    refundable: hasKey ? Math.floor((S.availableMsub ?? S.balanceMsub ?? 0) / 1000) : 0,
    questionsLeft: hasKey ? questionsLeft(S.balanceMsub, perQuestion(model, unit)) : 0,
    memory: mem,
    held: mem.held,
    pendingCount: S.pending.length,
    lastExchange: lastExchange(S.conv.messages),
    streaming: S.streaming,
    hiddenCount: hiddenCount(S.models, S.settings),
    talk: talkView(model, unit),
    // Search the web: offered when the model can search; on for the next question only.
    search: { available: canSearch(model), on: searchOn(model) },
    speak: speakView(),
    // The most Ask again can cost, shown on the button before it is pressed.
    againMsub: againNow(model),
    // A free question in place of the balance: the price lines read "Free, 2 of 3 left".
    free: fr.use ? { left: fr.left, total: fr.total } : null,
    // Goes up whenever conversations are burned, so an open History screen reads the list again.
    historyVersion,
  };
}

// ------------------------------------------------------------------ voice

/** The voice modules by id, for one direction. */
const voiceMods = (kind) => Object.fromEntries((registry?.list(kind) ?? []).map((x) => [x.instance.id, x.instance]));
const voiceIn = () => pickVoiceIn(voiceMods('voice-in'), S.settings);
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
  price: (kind, usage) => audioMsub(audio.model(kind), S.unit ?? 'usd', usage),
  async transcribe(wav, { seconds, signal } = {}) {
    const m = audio.model('transcription');
    if (!m) throw new EngineError('model_not_found', 'No speech to text model.');
    return engine.transcribe(S.key, { model: m.id, audio: wav, seconds, signal });
  },
  async speak(input, { signal } = {}) {
    const m = audio.model('speech');
    if (!m) throw new EngineError('model_not_found', 'No voice model.');
    return engine.speech(S.key, { model: m.id, input, voice: m.voices?.[0], signal });
  },
};

/**
 * The most a voice question can cost, for a recording of `seconds`: turning it into text, the question
 * it becomes (about CHARS_PER_SECOND characters a second) and, when the engine reads it aloud, the
 * longest part of the answer that is read. null when a part has no price.
 */
function talkPrice(seconds, inMod) {
  const toText = inMod.price(seconds);
  const question = estimateFor('x'.repeat(Math.ceil(Math.max(1, seconds) * CHARS_PER_SECOND))).costMsub;
  const reading = readingPrice();
  if (question == null || reading == null || (toText == null && inMod.id === 'engine')) return null;
  return (toText ?? 0) + question + reading;
}

function talkView(model, unit) {
  const inMod = voiceIn();
  const tk = S.talk ?? { phase: 'idle' };
  return {
    available: !!inMod && !!model,
    // The engine's speech to text is paid from the paid balance, so a voice question is never all free.
    freeOk: inMod?.id === 'device',
    phase: tk.phase,
    seconds: tk.seconds ?? 0,
    level: tk.level ?? 0,
    inside: tk.inside !== false,
    text: tk.text ?? '',
    error: tk.error ?? null,
    unit,
    maxSeconds: inMod?.maxSeconds() ?? 60,
    priceMsub: inMod && tk.phase === 'recording' ? talkPrice(tk.seconds ?? 0, inMod) : null,
    // Where the sound goes, for the line under the button: engine-private, engine-standard or device.
    route: !inMod ? null : inMod.id === 'device' ? 'device' : inMod.private() ? 'engine-private' : 'engine-standard',
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
  const look = looks.find((l) => l.instance.id === id) ?? looks[0];
  if (!look) return;
  setTokens(look.instance.tokens, look.instance.scheme);
  keep(LOOK_CACHE, JSON.stringify({ tokens: look.instance.tokens, scheme: look.instance.scheme }));
}

function setTokens(tokens, scheme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(`--${k}`, v);
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens.bg);
}

// The last look, before the modules load, so a dark look does not flash light.
try {
  const c = JSON.parse(ui.load(LOOK_CACHE) ?? 'null');
  if (c?.tokens) setTokens(c.tokens, c.scheme);
} catch {
  /* first run */
}
darkQuery?.addEventListener?.('change', () => S.settings.followSystem && applyLook());

// ------------------------------------------------------------------ balance

function setKey(k) {
  S.key = k || null;
  keep(keyStore(), S.key);
  if (!S.key) Object.assign(S, { unit: null, balanceMsub: null, availableMsub: null, peakMsub: null });
  store.set({});
}

async function savePeak() {
  await kv.put(`peak:${engine.base}`, S.peakMsub).catch(() => {});
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

async function refreshBalance() {
  await refreshFree();
  if (!S.key) return store.set({});
  try {
    const w = await engine.wallet(S.key);
    S.unit = w.unit;
    S.balanceMsub = w.balance_msub;
    S.availableMsub = w.available_msub;
    S.peakMsub = nextPeak(S.peakMsub, w.balance_msub);
    await savePeak();
  } catch (e) {
    if (e instanceof EngineError && e.status === 401) {
      // The engine no longer knows this key. Keep a copy aside, as v1 does, then start over.
      keep('forge.unrecognizedKey', S.key);
      setKey(null);
      ui.toast(t('error.key'));
    }
  }
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
  try {
    S.methods = await engine.fundMethods();
  } catch {
    S.methods = null;
  }
  store.set({});
}

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

/** Sends every voucher and token still waiting on the phone: free ones on the free balance. One run at a time. */
let retrying = null;
function retryAll() {
  retrying ??= (async () => {
    const paid = await retryPending({ engine, vault, getKey: () => S.key, invite: S.invite, setKey, setFreeKey });
    const free = await retryPending({ engine, vault, getKey: () => S.freeKey, setKey: setFreeKey, via: 'free' });
    return paid + free;
  })().finally(() => (retrying = null));
  return retrying;
}

const wallet = {
  key: () => S.key,
  setKey,
  unit: () => S.unit,
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
  /**
   * Adds eCash through the vault: stored on the phone first, removed only once credited. A voucher of
   * free questions (from the engine's credit mint) goes on the free balance; the result says free: true.
   */
  topup: async (token, invite) => {
    const note = readNote(token);
    if (note.ok && isCreditMint(S.free, note.mint)) return topupFree(token);
    // The engine may still find a voucher here (the credit mint was not known yet): its free balance
    // key then goes to the free slot, never the paid one.
    const r = await topupWithVault({ engine, vault, token, key: S.key, invite, setKey, setFreeKey });
    if (r.free) {
      await refreshFree();
      store.set({});
    }
    return r;
  },
  /** Adds a voucher of free questions, known to be one (the Free questions module), to the free balance. */
  topupFree,
  /** True for the engine's credit mint: its eCash is free questions, not money. */
  isCredit: (mint) => isCreditMint(S.free, mint),
};

// ------------------------------------------------------------------ conversation

let historyVersion = 0;
// Conversations burned in this page: never written again, even by an answer still on its way.
const burned = new Set();
const newId = (p) => p + '_' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replaceAll('-', '').slice(0, 20);
let gen = null; // {controller}

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
 * The funds hold for a question with these API messages, in msub: exactly what the engine holds before
 * sending it on (core/price.js holdMsub), from the body generate() sends, encrypted for a private model.
 * Falls back to the per-token estimate when the engine lists no hold figures. null when unpriced.
 */
function questionHold(model, api, maxOut, inputTokens, search = false) {
  const unit = S.unit ?? 'usd';
  const enc = isPrivate(model) ? { upstream: model.upstream_model } : null;
  const plain = new TextEncoder().encode(chatPayload(chatBody(model, api, maxOut, search), enc)).length;
  const held = holdMsub(model, unit, { bodyBytes: enc ? ehbpBytes(plain) : plain, maxOut, btcUsd: S.btcUsd, search });
  if (held != null || search) return held;
  return estimate(model, unit, inputTokens, maxOut)?.max ?? null;
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

function estimateFor(text) {
  const model = pickModel(S.models, S.settings);
  const unit = S.unit ?? 'usd';
  if (!model) return { costMsub: null, unit };
  const vision = !!model.capabilities?.vision;
  const msgs = [...S.conv.messages.filter((m) => !m.meta?.error), pendingMessage(text, S.pending, { vision })];
  const api = apiMessages(msgs, { systemPrompt: t('system.prompt'), vision });
  const bytes = new TextEncoder().encode(JSON.stringify(api)).length;
  const tokens = tokensOf(msgs, { systemPrompt: t('system.prompt'), vision });
  const maxOut = Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
  const search = searchOn(model);
  const costMsub = questionHold(model, api, maxOut, tokens, search);
  // A search is never a free question: it is paid from the balance.
  const fr = search ? { ...freeNow(model, bodyTokens(bytes)), use: false } : freeNow(model, bodyTokens(bytes));
  return {
    costMsub,
    search,
    // The engine refuses a question whose hold is more than the funds not already held: say so first.
    short: !fr.use && !!S.key && costMsub != null && S.balanceMsub > 0 && costMsub > (S.availableMsub ?? S.balanceMsub),
    unit,
    // Paid with a free question: the price line reads "Free, 2 of 3 left".
    free: fr.use ? { left: fr.left, total: fr.total } : null,
    // Free questions left, but this one is too long for one, and there is no paid balance.
    freeTooLong: !fr.use && fr.why === 'long' && !(S.key && S.balanceMsub > 0),
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
function readingPrice() {
  const out = voiceOut();
  if (out?.id !== 'engine') return 0;
  return audio.price('speech', { requests: Math.ceil(SPEAK_MAX_CHARS / out.pieceSize()), chars: SPEAK_MAX_CHARS });
}

/**
 * The most Ask again can cost: again() drops the answers after the last question and asks the model
 * again with the conversation up to it (againHistory). A question asked by voice is answered by voice,
 * so when the engine reads it aloud that is in the price too, as on the talk line. null when there is
 * no question to ask again, or a part has no price.
 */
function estimateAgain(model) {
  const unit = S.unit ?? 'usd';
  const history = againHistory(S.conv.messages);
  if (!history.length) return null;
  const vision = !!model.capabilities?.vision;
  const tokens = tokensOf(history, { systemPrompt: t('system.prompt'), vision });
  const maxOut = Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
  const chat = questionHold(model, apiMessages(history, { systemPrompt: t('system.prompt'), vision }), maxOut, tokens, searchOn(model));
  const reading = history.at(-1).meta?.voice ? readingPrice() : 0;
  if (chat == null || reading == null) return null;
  return chat + reading;
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
  if (!S.conv.id) S.conv = { id: newId('c'), messages: [], createdAt: Date.now() };
  S.conv.messages.push(msg);
  S.pending = [];
  await savePending();
  await saveConv();
  nav('answer');
  generate();
}

async function generate() {
  const model = pickModel(S.models, S.settings);
  if (!model || gen) return;
  const vision = !!model.capabilities?.vision;
  const conv = S.conv;
  const history = conv.messages.filter((m) => !m.meta?.error);
  const api = apiMessages(history, { systemPrompt: t('system.prompt'), vision });
  // A free question is used first, when the model is on the free list and the question fits its caps.
  const fr = freeNow(model, bodyTokens(new TextEncoder().encode(JSON.stringify(api)).length));
  // Search the web applies to this question only, and is never a free question.
  const search = searchOn(model);
  if (S.search) S.search = false;
  const useF = fr.use && !!S.freeKey && !search;
  const reply = { id: newId('m'), role: 'assistant', content: '', meta: { model: model.id, unit: S.unit } };
  if (useF) reply.meta.free = true;
  if (search) reply.meta.search = true;
  conv.messages.push(reply);
  const controller = new AbortController();
  gen = { controller };
  store.set({ streaming: true });
  const maxTokens = useF ? freeMaxTokens(S.free, Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT)) : Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
  let forge = null;
  let failure = null;
  try {
    await engine.chat({
      key: useF ? S.freeKey : S.key,
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
    else S.balanceMsub = forge.balance_msub;
  }
  if (!useF && forge?.charged_msub != null && (!reply.meta.error || forge.charged_msub > 0)) reply.meta.cost = forge.charged_msub;
  if (useF && forge?.charged_msub > 0) reply.meta.freeLeft = freeLeft(forge.balance_msub ?? S.freeMsub);
  // A stopped stream is settled by the engine just after the disconnect.
  if (reply.meta.stopped && !forge) await new Promise((r) => setTimeout(r, 900));
  store.set({ streaming: false });
  // Burned while it streamed: nothing more to say or save, but the balance did change.
  if (burned.has(conv.id)) return refreshBalance();
  ui.toast(reply.meta.error ? errorText(reply.meta.error, reply.meta.unit) : reply.meta.stopped ? t('answer.stopped') : t('answer.done'), 1800);
  await saveConv(conv);
  await refreshBalance();
  // A question asked by voice is answered by voice, unless reading aloud is off.
  const asked = history.at(-1);
  if (asked?.meta?.voice && reply.content && !reply.meta.error && !reply.meta.stopped && S.conv === conv) talk.speak(reply, { auto: true });
}

/** The plain words for a failed answer, with what it cost when the engine charged for it. */
const errorText = (err, unit) => {
  const ev = errorView(err.code, err.message, err.charged);
  return t(ev.key, { message: ev.message ?? '', amount: ev.charged > 0 ? format.cost(ev.charged, unit) : '' });
};

function again() {
  if (gen) return;
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
  S.pending = pending;
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
async function attachPhoto(file) {
  const model = pickModel(S.models, S.settings);
  if (!model) return nav('model');
  if (!model.capabilities?.vision) return ui.toast(t('add.noPhotos'), 3500);
  if (S.pending.filter((a) => a.kind === 'image').length >= MAX_IMAGES) return ui.toast(t('add.tooMany'));
  const img = await shrinkImage(file);
  S.pending.push({ id: newId('a'), kind: 'image', name: t('add.photo'), status: 'ready', ...img });
  await savePending();
  store.set({});
  nav('type');
}

async function removePending(id) {
  S.pending = S.pending.filter((a) => a.id !== id);
  await savePending();
  store.set({});
}

async function takeOut(amount) {
  const r = await engine.refund(S.key, { amount, pubkey: lockKey() || undefined });
  if (!r.ok && r.status !== 202) throw new EngineError(r.body?.error?.code ?? `http_${r.status}`, r.body?.error?.message ?? `HTTP ${r.status}`, { status: r.status });
  if (r.body?.token) vault.keepRefund({ id: r.body.id, token: r.body.token, amount: r.body.amount, unit: r.body.unit });
  // Issued later: remember the id, so collectRefunds offers it whatever this phone saw before.
  else if (r.body?.id) {
    const name = refundNames().awaited;
    const list = (await kv.get(name).catch(() => null)) ?? [];
    if (!list.includes(r.body.id)) await kv.put(name, [...list, r.body.id]).catch(() => {});
  }
  await refreshBalance();
  // Taking money out lowers the full mark of the gold ring to what is left.
  S.peakMsub = S.balanceMsub;
  await savePeak();
  store.set({});
  return { later: !r.body?.token };
}

/** Where this balance's shown and awaited refund ids are stored (core/refunds.js). */
const refundNames = () => ({ shown: `refundsShown:${S.key.slice(-12)}`, awaited: `refundsAwaited:${S.key.slice(-12)}` });

/**
 * Refunds the engine issued but this phone has not shown yet (a 202 earlier, or a closed tab). The first
 * time a balance is seen here, refunds already issued (in v1, say) are taken as shown, not offered again;
 * a refund this phone was told to collect later is always offered (core/refunds.js).
 */
async function collectRefunds() {
  if (!S.key) return;
  const names = refundNames();
  try {
    const before = await kv.get(names.shown);
    const awaited = (await kv.get(names.awaited)) ?? [];
    const list = await engine.refunds(S.key);
    const r = refundsToOffer({ list: list.data, shownBefore: before, awaited, outgoing: vault.outgoing().map((o) => o.id) });
    for (const x of r.keep) vault.keepRefund({ id: x.id, token: x.token, amount: x.amount, unit: x.unit });
    await kv.put(names.shown, r.shown);
    await kv.put(names.awaited, r.awaited);
    if (r.keep.length) store.set({});
  } catch {
    /* offline */
  }
}

/**
 * Other-mint tokens still pending on this phone (the person left the fund screen before the outcome):
 * looks each funding up and settles it, so a token is never left waiting for a screen that is gone.
 */
async function settleOtherMint() {
  try {
    const n = await settlePendingForeign({ engine, vault, key: S.key });
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

/** Why a question cannot be asked right now, with where to go about it, or null. */
function blocker() {
  if (!S.online) return { key: 'type.offline' };
  if (S.streaming) return { key: 'talk.busy' };
  if (!S.key || S.balanceMsub === 0) {
    const v = view();
    // A voice question the phone turns into words can be a free question; the engine's speech to text
    // is paid from the paid balance.
    if (!(v.talk.freeOk && v.fundsBlock === null)) {
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
  errorText: (err) => errorText(err, S.unit),
  askDownload: (bytes) => askVoiceDownload(bytes),
  showDownload: (bytes) => showVoiceDownload(bytes),
  unlockAudio: () => adapters.speaker.unlock?.(),
});

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

const actions = {
  ask,
  talkDown: () => talk.down(),
  talkUp: () => talk.up(),
  talkMove: (inside) => talk.move(inside),
  talkCancel: () => talk.cancel(),
  speak: () => talk.speak(lastAnswer()),
  stopSpeaking: () => talk.stopSpeaking(),
  setVoiceIn: (id) => {
    S.settings.voiceIn = id;
    saveSettings();
    store.set({});
  },
  setNaturalVoice: (name) => {
    S.settings.naturalVoice = name;
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
  /** Burns the open conversation (the answer screen's Burn), then goes home. */
  burn: async () => {
    if (S.conv.id) await burnIds([S.conv.id]);
    ui.toast(t('history.burned'), 3000);
    nav('home', {}, { replace: true });
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
  setLook: (id) => {
    S.settings.look = id;
    applyLook();
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
    S.settings.privateOnly = on;
    saveSettings();
    store.set({});
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
    S.settings.model = id;
    saveSettings();
    const m = S.models.find((x) => x.id === id);
    ui.toast(t('model.chosen', { name: m?.name ?? id }));
    store.set({});
  },
};

const format = {
  units: fmtUnits,
  int: fmtInt,
  cost: (msub, unit) => fmtCost(msub, unit ?? S.unit ?? 'usd'),
  plain: (n, unit) => (unit === 'usd' ? (n / 100).toFixed(2) : String(n)),
  parse: (s, unit) => {
    const v = String(s ?? '').replace(/[$,\s]/g, '');
    if (unit === 'usd') return /^\d+(\.\d{0,2})?$/.test(v) ? Math.round(Number(v) * 100) : NaN;
    return /^\d+$/.test(v) ? Number(v) : NaN;
  },
  modelPrice: (m) => {
    const unit = S.unit ?? 'usd';
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
// stacking a new copy of it.
const trail = [];
const depth = () => history.state?.forge2 ?? 0;

function nav(name, params = {}, { replace = false } = {}) {
  const h = href(name, params);
  if (h === location.hash || (h === '#/' && !location.hash)) return render();
  if (replace) history.replaceState({ forge2: depth() }, '', h);
  else history.pushState({ forge2: depth() + 1 }, '', h);
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
  if (afterPop) {
    const name = afterPop;
    afterPop = null;
    history.replaceState({ forge2: 0 }, '', href(name));
  }
  render();
}

/** First run: marks it seen (Skip or Start), then goes to the home. */
function finishIntro() {
  keep(SEEN_KEY, SEEN_VALUE);
  leave('home');
}

/** First run, Back: the step before, by the phone's own history when that is where it came from. */
function introBack(prev) {
  if (depth() > 0 && trail[depth() - 1] === STEP_ROUTES[prev]) history.back();
  else nav(STEP_ROUTES[prev], {}, { replace: true });
}

/** Goes back to the nearest earlier `name` on the stack, or replaces this screen with it. */
function backTo(name) {
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
  const mode = registry.list('mode')[0].instance;
  const ctx = { t, ui, state, nav, back, backTo, actions, format, registry, vault, wallet, qr: QR, native, engineBase: engine.base, cardJobs: cardJobCount, tillJobs: () => tillPays.waiting().length };
  switch (name) {
    case 'add':
      return mode.home({ sheet: addSheet(ctx), open: 'add' });
    case 'more':
      return mode.home({ sheet: moreSheet(ctx), open: 'more' });
    case 'answer':
      return mode.answer();
    case 'type':
      return typeScreen(ctx);
    case 'funds':
      return fundsScreen(ctx);
    case 'addFunds':
      return addFundsScreen(ctx);
    case 'fund':
      return fundScreen(ctx, params);
    case 'takeOut':
      return takeOutScreen(ctx);
    case 'freeOut':
      return freeOutScreen({ ...ctx, engine: engineProxy });
    case 'look':
      return lookScreen(ctx);
    case 'model':
      return modelScreen(ctx);
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
        return { node: ui.el('main', { class: 'screen sub', 'data-screen': 'voiceLabLoading' }, ui.el('p', { class: 'hint', text: t('lab.loading') })) };
      }
      try {
        return voiceLab({ ...ctx, phonon, speaker: adapters.speaker });
      } catch (e) {
        return labErrorScreen(e);
      }
    case 'intro':
    case 'introPay':
    case 'introLimits':
    case 'introPrivate':
      // The recorded Listen clips: their manifest is read once, and Listen shows when it is in.
      clips.load().then((m) => m && store.set({}));
      return firstRunScreen({ ...ctx, step: stepOfRoute(name), go: (step) => nav(STEP_ROUTES[step]), finish: finishIntro, stepBack: introBack, reader });
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
        ...(native ? { take: native.shareIn.take, forget: native.forget } : {}),
      });
    default:
      return mode.home();
  }
}

function render() {
  if (erased) return;
  // A balance key stored after this page read it (the Classic app in another tab, say) is picked up here.
  if (!S.key && registry) {
    const k = ui.load(keyStore());
    if (k) {
      S.key = k;
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
  unsub?.();
  current?.destroy?.();
  currentName = name;
  trail[depth()] = name;
  trail.length = depth() + 1;
  current = screenFor(name, params);
  root.replaceChildren(current.node);
  root.dataset.route = name;
  unsub = store.subscribe(() => current?.update?.());
  // Move focus to the new screen on navigation (not on the first paint, and not on the home).
  if (rendered && name !== 'home') current.focus?.focus?.({ preventScroll: true });
  rendered = true;
  if (name === 'takeOut' || name === 'funds') {
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
  if (native) await Promise.all([native.shareIn.clear(), native.forget(), native.till.forget()]);
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
  Object.assign(S, { key: null, balanceMsub: null, availableMsub: null, freeKey: null, freeMsub: null, freeTotal: 0, conv: { id: null, messages: [] }, pending: [], draft: '', invite: '' });
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
  document.title = t('app.name');
  // The visible height above a phone keyboard, for Type (core/viewport.js).
  watchViewport();
  // Erase everything in another tab clears localStorage there (key null) and deletes the database.
  onErasedElsewhere(erasedElsewhere);
  addEventListener('storage', (e) => e.key === null && e.storageArea === localStorage && erasedElsewhere());
  const saved = await kv.get('settings').catch(() => null);
  S.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  engine = createEngine({ base: engineBase(), encryptedFetch: tinfoilFetch(engineBase()) });
  S.key = ui.load(keyStore());
  S.freeKey = ui.load(freeKeyStore());
  S.freeTotal = (await kv.get(`freeTotal:${engine.base}`).catch(() => null)) ?? 0;
  S.peakMsub = (await kv.get(`peak:${engine.base}`).catch(() => null)) ?? null;
  S.pending = ((await kv.get('pending').catch(() => null)) ?? []).filter((a) => a.status === 'ready');
  S.draft = (await kv.get('draft').catch(() => null)) ?? '';
  // Auto-delete on open: what is past its time (or everything, with "on close") goes before anything is shown.
  await sweeper.sweep({ opening: true }).catch(() => {});
  // A photo shared in from another app waits only for the page it opened (Share unseen). Opened any
  // other way, an old one that was never read is removed.
  if (parse(location.hash).name !== 'photoShared') await globalThis.caches?.delete(SHARE_CACHE).catch(() => {});
  // In the Android app a photo shared in waits in the app (ForgeShareIn), and opens Share unseen.
  if (native && (await native.shareIn.waiting())) history.replaceState(history.state, '', href('photoShared'));
  // First run: a phone that has not seen it opens on Welcome instead of the home (core/firstrun.js).
  if (shouldShow({ seen: ui.load(SEEN_KEY) === SEEN_VALUE, route: parse(location.hash).name })) history.replaceState(history.state, '', href(STEP_ROUTES.welcome));
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
    inputs: { t, ui, state, nav, actions, format, engine: engineProxy, wallet, vault, scan: adapters.camera, qr: QR, nfc, card: cards, till, mic: adapters.mic, recognizer: adapters.recognizer, speaker: adapters.speaker, synth: adapters.synth, audio, phonon },
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
  await stylesReady();

  addEventListener('popstate', onPop);
  native?.shareIn.onShared(() => !erased && nav('photoShared'));
  addEventListener('online', () => {
    store.set({ online: true });
    retryAll().then((n) => n && refreshBalance());
    settleOtherMint();
    resumeCards();
    resumeTillPays();
  });
  addEventListener('offline', () => store.set({ online: false }));
  // Auto-delete while open: the sweeper's timer, and a check whenever the app comes back to the front
  // (timers sleep while a phone screen is off). "On close" starts removing everything as the page goes.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && !erased && sweeper.sweep());
  addEventListener('pagehide', () => S.settings.autoDelete === 'close' && !erased && burnEverything());
  addEventListener('pageshow', (e) => e.persisted && S.settings.autoDelete === 'close' && !erased && burnEverything().then(() => nav('home', {}, { replace: true })));
  render();
  live = true;
  if (firstRun) {
    await registry.loadAll(rest);
    store.set({});
  }
  if (registry.refused.length) console.warn('modules refused', registry.refused);
  document.documentElement.dataset.ready = '1';

  await loadModels();
  await refreshBalance();
  const n = await retryAll();
  if (n) await refreshBalance();
  await settleOtherMint();
  await resumeCards();
  await resumeTillPays();
  registerWorker();
}

/** The engine as fund modules see it: always the current engine object. */
const engineProxy = new Proxy({}, { get: (_, k) => engine[k] });

/** Card taps: the Android app's reader, or the website's stand-in that says a page cannot read cards. */
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
  if (!list.length || !S.key) return;
  let credited = 0;
  for (const p of list) {
    try {
      if (p.fundingId && p.state !== 'pay_failed') {
        const f = await engine.funding(S.key, p.fundingId);
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
function registerWorker() {
  // The Android app has its files in the APK, so it needs no offline copy and no worker.
  if (erased || native || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  workerReg = navigator.serviceWorker.register('/v2/sw.js', { scope: '/v2/', updateViaCache: 'none' }).catch(() => null);
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
