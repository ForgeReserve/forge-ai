// Forge AI v2. Plain ES modules, no build step, nothing loaded from another origin.
// The app shell: loads the bundled modules through the registry, applies the look, talks to the engine,
// keeps the state and draws one screen at a time from the hash route.
import { fmtBalance, fmtCost, fmtInt, fmtUnits } from '../js/ui.js';
import { kindOf, MAX_FILES, BODY_LIMIT } from '../js/files.js';
import { lockKey } from '../js/lockkey.js';
import * as QR from '../js/qr.js';
import { adapters } from './core/adapters.js';
import { lastExchange, memoryView, pendingMessage, apiMessages, tokensOf } from './core/conversation.js';
import { chats, kv } from './core/db.js';
import { createEngine, EngineError, tinfoilFetch } from './core/engine.js';
import { errorView } from './core/errors.js';
import { t } from './core/i18n.js';
import { MAX_IMAGES, shrinkImage } from './core/image.js';
import { estimate, perQuestion } from './core/price.js';
import { BUNDLED, bundledLoader, createRegistry } from './core/registry.js';
import { fundsFraction, nextPeak, questionsLeft } from './core/rings.js';
import { href, parentOf, parse } from './core/router.js';
import { createStore, DEFAULT_SETTINGS, hiddenCount, isPrivate, keyName, pickModel } from './core/state.js';
import * as ui from './core/ui.js';
import { createVault, retryPending, topupWithVault } from './core/vault.js';
import { addFundsScreen, fundScreen, fundsScreen, takeOutScreen } from './screens/funds.js';
import { lookScreen, modelScreen } from './screens/settings.js';
import { addSheet, moreSheet } from './screens/sheets.js';
import { typeScreen } from './screens/type.js';

const MAX_OUT = 4096; // the most output a question asks for; the engine holds the worst case up front
const MODELS_CACHE = 'forge2.models';
const LOOK_CACHE = 'forge2.look';

// ------------------------------------------------------------------ storage that survives a reload

const storage = {
  getItem: (k) => ui.load(k),
  setItem: (k, v) => {
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
  inviteOnly: false,
  units: [],
  mints: [],
  methods: null,
  invite: '',
  settings: { ...DEFAULT_SETTINGS },
  conv: { id: null, messages: [] },
  pending: [],
  draft: '',
  streaming: false,
  online: navigator.onLine !== false,
});
const S = store.S;

const engineBase = () => S.settings.engine ?? '';
let engine = createEngine({ base: engineBase(), encryptedFetch: tinfoilFetch(engineBase()) });
const keyStore = () => keyName(engine.base, location.origin);

// ------------------------------------------------------------------ derived view

let memo = { k: '', v: null };
function memoryNow(model) {
  const k = `${S.conv.id}|${S.conv.messages.length}|${S.streaming}|${S.pending.map((a) => a.id + a.status).join(',')}|${model?.id}`;
  if (memo.k !== k) memo = { k, v: memoryView(S.conv.messages, S.pending, { systemPrompt: t('system.prompt'), vision: !!model?.capabilities?.vision, contextLength: model?.context_length }) };
  return memo.v;
}

function view() {
  const model = pickModel(S.models, S.settings);
  const unit = S.unit ?? 'usd';
  const mem = memoryNow(model);
  const hasKey = !!S.key;
  return {
    model,
    // With no model to use, Private only still decides: nothing is sent to a standard model.
    private: model ? isPrivate(model) : !!S.settings.privateOnly,
    online: S.online,
    hasKey,
    balanceMsub: hasKey ? S.balanceMsub : null,
    balanceText: hasKey && S.balanceMsub != null ? fmtBalance(S.balanceMsub, S.unit) : null,
    fundsFraction: hasKey ? fundsFraction(S.balanceMsub, S.peakMsub) : 0,
    refundable: hasKey ? Math.floor((S.availableMsub ?? S.balanceMsub ?? 0) / 1000) : 0,
    questionsLeft: hasKey ? questionsLeft(S.balanceMsub, perQuestion(model, unit)) : 0,
    memory: mem,
    held: mem.held,
    pendingCount: S.pending.length,
    lastExchange: lastExchange(S.conv.messages),
    streaming: S.streaming,
    hiddenCount: hiddenCount(S.models, S.settings),
  };
}
const state = { S, subscribe: store.subscribe, view };

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
  ui.store(LOOK_CACHE, JSON.stringify({ tokens: look.instance.tokens, scheme: look.instance.scheme }));
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
  ui.store(keyStore(), S.key);
  if (!S.key) Object.assign(S, { unit: null, balanceMsub: null, availableMsub: null, peakMsub: null });
  store.set({});
}

async function savePeak() {
  await kv.put(`peak:${engine.base}`, S.peakMsub).catch(() => {});
}

async function refreshBalance() {
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
      ui.store('forge.unrecognizedKey', S.key);
      setKey(null);
      ui.toast(t('error.key'));
    }
  }
  store.set({});
}

async function loadModels() {
  try {
    const body = await engine.models();
    ui.store(MODELS_CACHE, JSON.stringify(body));
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
  Object.assign(S, { models: body.data ?? [], inviteOnly: !!body.invite_only, units: body.units ?? [], mints: body.mints ?? [] });
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
  lockKey: () => lockKey(),
  /** Adds eCash through the vault: stored on the phone first, removed only once credited. */
  topup: (token, invite) => topupWithVault({ engine, vault, token, key: S.key, invite, setKey }),
};

// ------------------------------------------------------------------ conversation

const newId = (p) => p + '_' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replaceAll('-', '').slice(0, 20);
let gen = null; // {controller}

async function saveConv() {
  if (!S.conv.id) return;
  S.conv.updatedAt = Date.now();
  await chats.put(S.conv.id, S.conv).catch(() => {});
  await kv.put('current', S.conv.id).catch(() => {});
}
async function savePending() {
  await kv.put('pending', S.pending).catch(() => {});
}

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
  const cost = estimate(model, unit, tokens, maxOut);
  return {
    costMsub: cost?.max ?? null,
    unit,
    reading: S.pending.some((a) => a.status === 'reading'),
    overContext: !!model.context_length && tokens + maxOut > model.context_length,
    overBody: bytes > BODY_LIMIT * 0.98,
  };
}

async function ask(text) {
  if (gen) return;
  const model = pickModel(S.models, S.settings);
  if (!model) return nav('model');
  const msg = { id: newId('m'), ...pendingMessage(text, S.pending, { vision: !!model.capabilities?.vision }) };
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
  const reply = { id: newId('m'), role: 'assistant', content: '', meta: { model: model.id, unit: S.unit } };
  conv.messages.push(reply);
  const controller = new AbortController();
  gen = { controller };
  store.set({ streaming: true });
  const maxTokens = Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
  let forge = null;
  try {
    await engine.chat({
      key: S.key,
      body: { model: model.id, messages: apiMessages(history, { systemPrompt: t('system.prompt'), vision }), max_tokens: maxTokens },
      encrypted: isPrivate(model) ? { upstream: model.upstream_model } : null,
      signal: controller.signal,
      onText: (d) => {
        reply.content += d;
        soon();
      },
      onForge: (f) => (forge = f),
    });
  } catch (e) {
    if (e?.name === 'AbortError' || controller.signal.aborted) reply.meta.stopped = true;
    else reply.meta.error = { code: e?.code ?? 'other', message: e?.message ?? String(e) };
  } finally {
    gen = null;
  }
  if (!reply.content && !reply.meta.error && !reply.meta.stopped) reply.meta.error = { code: 'stream_failed', message: t('answer.empty') };
  if (reply.meta.error && reply.content) {
    reply.meta.partial = true;
    delete reply.meta.error;
  }
  if (forge?.balance_msub != null) S.balanceMsub = forge.balance_msub;
  if (forge?.charged_msub != null && !reply.meta.error) reply.meta.cost = forge.charged_msub;
  // A stopped stream is settled by the engine just after the disconnect.
  if (reply.meta.stopped && !forge) await new Promise((r) => setTimeout(r, 900));
  store.set({ streaming: false });
  ui.toast(reply.meta.error ? t(errorKey(reply.meta.error.code), { message: reply.meta.error.message }) : reply.meta.stopped ? t('answer.stopped') : t('answer.done'), 1800);
  await saveConv();
  await refreshBalance();
}

const errorKey = (code) => errorView(code).key;

function again() {
  if (gen) return;
  const msgs = S.conv.messages;
  while (msgs.length && msgs.at(-1).role === 'assistant') msgs.pop();
  if (!msgs.length) return nav('type');
  generate();
}

async function startFresh() {
  gen?.controller.abort();
  const old = S.conv.id;
  S.conv = { id: null, messages: [] };
  S.pending = [];
  await savePending();
  await kv.del('current').catch(() => {});
  // There is no history screen yet (slice A4), so the old conversation is removed from this phone's storage.
  if (old) await chats.del(old).catch(() => {});
  store.set({});
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

async function removePending(id) {
  S.pending = S.pending.filter((a) => a.id !== id);
  await savePending();
  store.set({});
}

async function takeOut(amount) {
  const r = await engine.refund(S.key, { amount, pubkey: lockKey() || undefined });
  if (!r.ok && r.status !== 202) throw new EngineError(r.body?.error?.code ?? `http_${r.status}`, r.body?.error?.message ?? `HTTP ${r.status}`, { status: r.status });
  if (r.body?.token) vault.keepRefund({ id: r.body.id, token: r.body.token, amount: r.body.amount, unit: r.body.unit });
  await refreshBalance();
  // Taking money out lowers the full mark of the gold ring to what is left.
  S.peakMsub = S.balanceMsub;
  await savePeak();
  store.set({});
  return { later: !r.body?.token };
}

/**
 * Refunds the engine issued but this phone has not shown yet (a 202 earlier, or a closed tab). The first
 * time a balance is seen here, refunds already issued (in v1, say) are taken as shown, not offered again.
 */
async function collectRefunds() {
  if (!S.key) return;
  const name = `refundsShown:${S.key.slice(-12)}`;
  try {
    const before = await kv.get(name);
    const shown = new Set(before ?? []);
    const list = await engine.refunds(S.key);
    let changed = false;
    for (const r of list.data ?? []) {
      if (r.status !== 'done' || !r.token || shown.has(r.id)) continue;
      shown.add(r.id);
      if (before === undefined && !vault.outgoing().some((o) => o.id === r.id)) continue;
      vault.keepRefund({ id: r.id, token: r.token, amount: r.amount, unit: r.unit });
      changed = true;
    }
    for (const o of vault.outgoing()) shown.add(o.id);
    await kv.put(name, [...shown]);
    if (changed) store.set({});
  } catch {
    /* offline */
  }
}

const actions = {
  ask,
  stop: () => gen?.controller.abort(),
  again,
  startFresh,
  forgetConversation,
  attach,
  removePending,
  estimate: estimateFor,
  saveDraft: (v) => {
    S.draft = v;
    kv.put('draft', v).catch(() => {});
  },
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

/** Goes back to the nearest earlier `name` on the stack, or replaces this screen with it. */
function backTo(name) {
  for (let i = depth() - 1; i >= 0; i--) if (trail[i] === name) return history.go(i - depth());
  nav(name, {}, { replace: true });
}

function screenFor(name, params) {
  const mode = registry.list('mode')[0].instance;
  const ctx = { t, ui, state, nav, back, backTo, actions, format, registry, vault, wallet, qr: QR };
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
    case 'look':
      return lookScreen(ctx);
    case 'model':
      return modelScreen(ctx);
    default:
      return mode.home();
  }
}

function render() {
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
  if (name === 'takeOut' || name === 'funds') collectRefunds();
}

// ------------------------------------------------------------------ start

async function start() {
  document.title = t('app.name');
  const saved = await kv.get('settings').catch(() => null);
  S.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  engine = createEngine({ base: engineBase(), encryptedFetch: tinfoilFetch(engineBase()) });
  S.key = ui.load(keyStore());
  S.peakMsub = (await kv.get(`peak:${engine.base}`).catch(() => null)) ?? null;
  const cur = await kv.get('current').catch(() => null);
  if (cur) S.conv = (await chats.get(cur).catch(() => null)) ?? { id: null, messages: [] };
  // An answer that was streaming when the tab was killed is kept as stopped.
  for (const m of S.conv.messages) if (m.role === 'assistant' && !m.content && !m.meta?.error && !m.meta?.stopped) m.meta = { ...m.meta, stopped: true };
  S.pending = ((await kv.get('pending').catch(() => null)) ?? []).filter((a) => a.status === 'ready');
  S.draft = (await kv.get('draft').catch(() => null)) ?? '';

  const loader = bundledLoader();
  registry = createRegistry({ ...loader, inputs: { t, ui, state, nav, actions, format, engine: engineProxy, wallet, vault, scan: adapters.camera, qr: QR } });
  await registry.loadAll(BUNDLED);
  if (registry.refused.length) console.warn('modules refused', registry.refused);
  if (!registry.list('mode').length) throw new Error('no mode module');
  applyLook();

  addEventListener('popstate', render);
  addEventListener('online', () => {
    store.set({ online: true });
    retryPending({ engine, vault, getKey: () => S.key, invite: S.invite, setKey }).then((n) => n && refreshBalance());
  });
  addEventListener('offline', () => store.set({ online: false }));
  render();
  document.documentElement.dataset.ready = '1';

  await loadModels();
  await refreshBalance();
  const n = await retryPending({ engine, vault, getKey: () => S.key, invite: S.invite, setKey });
  if (n) await refreshBalance();
  registerWorker();
}

/** The engine as fund modules see it: always the current engine object. */
const engineProxy = new Proxy({}, { get: (_, k) => engine[k] });

function registerWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('/v2/sw.js', { scope: '/v2/', updateViaCache: 'none' }).catch(() => {});
}

start().catch((e) => {
  console.error(e);
  root.replaceChildren(ui.el('p', { class: 'fatal', role: 'alert', text: t('app.failed') }));
});
