// Forge AI chat page. Plain ES modules, no build step, nothing loaded from another origin.
// Privacy: chats are kept in this browser (IndexedDB) and sent to the gateway only as the messages of
// the request being made. The balance key and settings live in localStorage.
import { renderMarkdown, enhance } from './js/markdown.js';
import { chats, newId } from './js/store.js';
import { $, el, icon, store, load, toast, announce, copyText, confirmDialog, fmtBalance, fmtCost, fmtInt, api } from './js/ui.js';
import { anim, closeSheet, crossfade, DUR, EASE, isPhone, openSheet, reduced, rollText, viewTransition } from './js/motion.js';

// The wallet (funding, QR codes, refunds) loads on first use, keeping the first page load small.
let W = null;
async function wallet() {
  if (!W) {
    W = await import('./js/wallet.js');
    W.initWallet(S, { setKey, refresh: refreshBalance });
  }
  return W;
}
const openWallet = (which) => wallet().then((w) => w.openWallet(which));

const KEY_STORE = 'forge.balanceKey';
const SETTINGS_STORE = 'forge.settings';
const MAX_OUT = 4096; // per-request cap the page asks for; the gateway reserves the worst case up front
const MAX_IMAGES = 4;
export const DEFAULT_PROMPT =
  'You are a helpful assistant in Forge AI, a chat app paid with Cashu eCash. In this app "eCash" means Chaumian eCash as implemented by the Cashu protocol: bearer tokens blind-signed by a mint, which the mint cannot link to the people who hold or spend them. It does not mean Bitcoin ABC, XEC, or any other coin unless the user says so. Answer clearly and use Markdown for structure and code.';

// ------------------------------------------------------------------ state

const S = { key: null, unit: null, balanceMsub: null, availableMsub: null, inviteOnly: true, units: [], mints: [], models: [], invite: '' };
const settings = Object.assign({ theme: 'system', defaultModel: '', effort: '', systemPrompt: DEFAULT_PROMPT, showUncensored: false, encrypt: true, sidebar: true }, safeParse(load(SETTINGS_STORE)));
let list = []; // conversation summaries, newest first
let chat = null; // the open conversation
let gen = null; // {controller, chatId}
let attachments = []; // [{url, bytes}]
let effortSel = '';

function safeParse(s) {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
}
function saveSettings() {
  store(SETTINGS_STORE, JSON.stringify(settings));
}

// ------------------------------------------------------------------ balance

function setKey(key) {
  S.key = key;
  store(KEY_STORE, key);
  if (!key) {
    S.unit = S.balanceMsub = S.availableMsub = null;
  }
  renderBalance();
  renderNotice();
}

let booted = false;
async function refreshBalance() {
  if (!S.key) return renderBalance();
  const before = S.balanceMsub;
  try {
    const r = await api('/v1/wallet', { key: S.key });
    if (r.res.ok) {
      S.unit = r.body.unit;
      S.balanceMsub = r.body.balance_msub;
      S.availableMsub = r.body.available_msub;
    } else if (r.res.status === 401) {
      // The gateway no longer knows this key: a first funding that expired or failed removes the empty
      // balance and reopens the invite. Keep a copy aside (never silently lose a key), then start over.
      store('forge.unrecognizedKey', S.key);
      setKey(null);
      toast('This balance key is not known to the gateway. Add funds again with your invite code.', 5000);
      return;
    }
  } catch {
    /* offline */
  }
  const celebrate = booted && S.balanceMsub != null && S.balanceMsub > (before ?? 0);
  renderBalance({ celebrate });
  renderNotice();
  W?.syncWalletBalance({ celebrate });
}

function renderBalance({ celebrate = false } = {}) {
  const chip = $('balanceChip');
  const text = $('balanceText');
  chip.classList.remove('is-empty', 'is-low');
  const plain = (t) => {
    delete text.dataset.roll;
    text.removeAttribute('aria-label');
    text.textContent = t;
  };
  if (!S.key) {
    plain('Add funds');
    chip.classList.add('is-empty');
  } else if (S.balanceMsub == null) {
    plain('');
    text.append(el('span', { class: 'skel', style: 'width:4em', text: 'Balance' }));
  } else {
    rollText(text, fmtBalance(S.balanceMsub, S.unit), { celebrate });
    const low = S.unit === 'usd' ? 10_000 : 100_000;
    if (S.balanceMsub < low) chip.classList.add('is-low');
  }
  chip.toggleAttribute('data-glow', true);
  chip.setAttribute('aria-label', S.key && S.balanceMsub != null ? `Balance ${fmtBalance(S.balanceMsub, S.unit)}. Open wallet` : 'Open wallet to add funds');
  updatePriceHints();
}

// ------------------------------------------------------------------ models

const currentModel = () => S.models.find((m) => m.id === chat?.model) ?? S.models.find((m) => m.id === settings.defaultModel) ?? visibleModels()[0];
const visibleModels = () => S.models.filter((m) => settings.showUncensored || !m.uncensored);

async function loadModels() {
  try {
    const r = await api('/v1/models');
    S.models = r.body?.data ?? [];
    S.inviteOnly = !!r.body?.invite_only;
    S.units = r.body?.units ?? [];
    S.mints = r.body?.mints ?? [];
  } catch {
    S.models = [];
  }
  if (!S.models.some((m) => m.id === settings.defaultModel)) settings.defaultModel = visibleModels()[0]?.id ?? '';
  renderModel();
  fillSettingsModels();
}

function priceText(m) {
  const unit = S.unit ?? 'usd';
  const p = unit === 'sat' && m.pricing.sat_per_mtok ? m.pricing.sat_per_mtok : m.pricing.usd_per_mtok;
  const f = (n) => (unit === 'sat' && m.pricing.sat_per_mtok ? `${fmtInt(Math.round(n))} sat` : `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}`);
  return `${f(p.input)} in, ${f(p.output)} out per 1M tokens`;
}
const speedLabel = { fast: 'Fast', balanced: 'Balanced', slow: 'Slow' };
const isEncrypted = (m) => m?.tier === 'enclave' && m?.encrypted_passthrough && settings.encrypt;

/** Inline padlock (not a <use>, so the shackle can animate). Open for standard models. */
function lockSvg(closed = true) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'lock');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = closed ? '<rect x="4" y="11" width="16" height="10" rx="2"/><path class="shackle" d="M8 11V7a4 4 0 0 1 8 0v4"/>' : '<rect x="4" y="11" width="16" height="10" rx="2"/><path class="shackle" d="M8 11V7a4 4 0 0 1 7.5-2"/>';
  return s;
}
const tierOf = (m) => (m?.tier === 'enclave' ? 'enclave' : 'standard');

let shownModel = null;
function renderModel() {
  const m = currentModel();
  $('modelName').textContent = m ? (m.name ?? m.id) : S.models.length ? 'Choose a model' : 'No models';
  const tier = $('modelTier');
  tier.hidden = !m;
  const changed = m && shownModel && shownModel !== m.id;
  const tierChanged = changed && tierOf(S.models.find((x) => x.id === shownModel)) !== tierOf(m);
  if (m) {
    const t = tierOf(m);
    tier.dataset.tier = t;
    $('modelBtn').dataset.tier = t;
    tier.title = t === 'enclave' ? 'Private: runs in a verified enclave' : 'Standard: the provider can read prompts';
    const lock = lockSvg(t === 'enclave');
    tier.replaceChildren(lock, el('span', { class: 't-label', text: t === 'enclave' ? 'Private' : 'Standard' }));
    if (changed) {
      const b = $('modelBtn');
      b.classList.remove('sweep');
      void b.offsetWidth;
      b.classList.add('sweep');
      if (t === 'enclave' && tierChanged && !reduced()) lock.classList.add('engage');
    }
    shownModel = m.id;
  }
  // Composer controls that depend on the model.
  $('attachBtn').hidden = !m?.capabilities?.vision;
  if (!m?.capabilities?.vision && attachments.length) {
    attachments = [];
    renderAttachments();
  }
  const efforts = m?.capabilities?.reasoning_efforts ?? [];
  $('effortChip').hidden = !efforts.length;
  if (efforts.length) {
    const sel = $('effort');
    sel.replaceChildren(el('option', { value: '', text: 'Default effort' }), ...efforts.map((e) => el('option', { value: e, text: `${e[0].toUpperCase()}${e.slice(1)} effort` })));
    effortSel = pickEffort(efforts, settings.effort);
    sel.value = effortSel;
  } else effortSel = '';
  renderEffort();
  $('encryptChip').hidden = !(m?.tier === 'enclave' && m?.encrypted_passthrough);
  $('encrypt').checked = settings.encrypt;
  $('encryptChip').classList.toggle('on', settings.encrypt);
  $('encryptChip').setAttribute('aria-pressed', String(settings.encrypt));
  $('encryptChip').title = `Encrypt in browser: ${settings.encrypt ? 'on' : 'off'}`;
  renderTierLine(m);
}

/** One short line under the composer, coloured by tier; it cross-fades when the tier changes. */
function renderTierLine(m) {
  const note = $('privacyNote');
  const [kind, ico, text] = !m
    ? ['', null, '']
    : m.tier !== 'enclave'
      ? ['standard', 'cloud', 'Standard: the gateway and provider can read this chat.']
      : isEncrypted(m)
        ? ['enclave', 'lock', 'Private: encrypted to a verified enclave.']
        : ['open', 'unlock', 'Encryption off: the gateway can read this chat in transit.'];
  if (note.dataset.kind === kind && note.textContent === text) return;
  const apply = () => {
    note.dataset.kind = kind;
    note.dataset.tier = kind;
    note.replaceChildren(...(ico ? [icon(ico), el('span', { text })] : []));
  };
  if (note.dataset.kind && note.dataset.kind !== kind) crossfade(note, apply);
  else apply();
}

function pickEffort(efforts, want) {
  if (!want) return '';
  if (efforts.includes(want)) return want;
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const w = order.indexOf(want);
  let best = '';
  let bestD = 99;
  for (const e of efforts) {
    const d = Math.abs(order.indexOf(e) - w);
    if (order.indexOf(e) >= 0 && d < bestD) (best = e), (bestD = d);
  }
  return best;
}

function updatePriceHints() {
  if ($('modelMenu').open) renderMenu();
}

// model menu (a listbox popover)
let menuFocus = -1;
function openMenu() {
  const menu = $('modelMenu');
  if (menu.open) return;
  renderMenu();
  // A bottom sheet on phones (modal, drag to dismiss); a dropdown under the button elsewhere.
  if (isPhone()) {
    menu.style.top = menu.style.left = '';
    openSheet(menu);
  } else {
    openSheet(menu, { modal: false });
    positionMenu();
  }
  $('modelBtn').setAttribute('aria-expanded', 'true');
  const opts = [...menu.querySelectorAll('.opt')];
  menuFocus = Math.max(0, opts.findIndex((o) => o.getAttribute('aria-selected') === 'true'));
  focusOpt();
  $('modelList').focus({ preventScroll: true });
}
function closeMenu(refocus = true) {
  const menu = $('modelMenu');
  $('modelBtn').setAttribute('aria-expanded', 'false');
  if (menu.open) closeSheet(menu);
  if (refocus) $('modelBtn').focus();
}
function positionMenu() {
  const menu = $('modelMenu');
  if (!menu.open || menu.matches(':modal')) return;
  const r = $('modelBtn').getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(16, Math.min(r.left, window.innerWidth - w - 16))}px`;
}
const TIERS = {
  enclave: { title: 'Private (enclave)', ico: 'shield', text: 'Encrypted from your device to a verified secure enclave. Nobody else can read it, including Forge and Tinfoil.' },
  standard: { title: 'Standard', ico: 'cloud', text: 'The gateway and the model provider can read these chats.' },
  uncensored: { title: 'Uncensored', ico: 'cloud', text: 'Standard privacy. Tuned to refuse less.' },
};
function shortPrice(m) {
  const sat = (S.unit ?? 'usd') === 'sat' && m.pricing.sat_per_mtok;
  const p = sat ? m.pricing.sat_per_mtok : m.pricing.usd_per_mtok;
  const f = (n) => (sat ? fmtInt(Math.round(n)) : `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}`);
  return `${f(p.input)} in · ${f(p.output)} out${sat ? ' sat' : ''} per 1M`;
}
function renderMenu() {
  const list = $('modelList');
  const cur = currentModel();
  const group = (key, models) => {
    if (!models.length) return [];
    const T = TIERS[key];
    const head = el('div', { class: 'group-head', role: 'presentation' }, el('span', { class: 'g-ico' }, icon(T.ico)), el('h3', { text: T.title, id: `g-${key}` }), el('p', { text: T.text }));
    const box = el('div', { class: 'menu-group', role: 'group', 'aria-labelledby': `g-${key}`, 'data-tier': key }, head);
    for (const m of models) {
      const enc = m.tier === 'enclave';
      const tags = [
        el('span', { class: 'tag ' + (enc ? 't-enc' : 't-std') }, lockSvg(enc), enc ? 'Private' : 'Standard'),
        m.speed ? el('span', { class: 'tag' }, icon('gauge'), speedLabel[m.speed]) : null,
        m.capabilities?.vision ? el('span', { class: 'tag', text: 'Images' }) : null,
        m.capabilities?.reasoning ? el('span', { class: 'tag', text: 'Reasoning' }) : null,
        el('span', { class: 'tag t-price', title: priceText(m), text: shortPrice(m) + (m.pricing?.verified === false ? ' (provisional)' : '') }),
      ];
      const o = el(
        'div',
        { class: 'opt', role: 'option', id: `opt-${m.id.replace(/[^\w-]/g, '_')}`, 'aria-selected': String(m.id === cur?.id), 'data-id': m.id, 'aria-description': `${enc ? 'Private' : 'Standard'}. ${priceText(m)}` },
        el('span', { class: 'o-name', text: m.name ?? m.id }),
        el('span', { class: 'o-check', 'aria-hidden': 'true' }, icon('check')),
        el('span', { class: 'o-tags' }, ...tags),
      );
      o.addEventListener('click', () => chooseModel(m.id));
      box.append(o);
    }
    return [box];
  };
  const vis = S.models.filter((m) => !m.uncensored);
  const unc = S.models.filter((m) => m.uncensored);
  const toggle = el('input', { type: 'checkbox', id: 'uncToggle' });
  toggle.checked = settings.showUncensored;
  toggle.addEventListener('change', () => {
    settings.showUncensored = toggle.checked;
    saveSettings();
    renderMenu();
    fillSettingsModels();
  });
  list.replaceChildren(
    ...group('enclave', vis.filter((m) => m.tier === 'enclave')),
    ...group('standard', vis.filter((m) => m.tier !== 'enclave')),
    ...(settings.showUncensored ? group('uncensored', unc) : []),
    unc.length
      ? el('div', { class: 'menu-foot' }, el('label', { class: 'switch', for: 'uncToggle' }, toggle, el('span', {}, el('b', { text: 'Show uncensored models' }), 'They are tuned to refuse less and can write harmful or explicit text.')))
      : null,
  );
  if (!S.models.length) list.append(el('p', { class: 'hint', style: 'padding:10px', text: 'The gateway lists no models right now.' }));
}
function focusOpt() {
  const opts = [...$('modelMenu').querySelectorAll('.opt')];
  opts.forEach((o, i) => o.classList.toggle('focus', i === menuFocus));
  const o = opts[menuFocus];
  if (o) {
    $('modelList').setAttribute('aria-activedescendant', o.id);
    o.scrollIntoView({ block: 'nearest' });
  }
}
function chooseModel(id) {
  if (chat) {
    chat.model = id;
    if (chat.messages.length) persist();
  }
  settings.defaultModel = id;
  saveSettings();
  closeMenu();
  // Let the sheet start leaving, then play the switch on the top bar.
  setTimeout(renderModel, isPhone() ? 140 : 0);
  $('setModel').value = id;
}

// ------------------------------------------------------------------ conversations

function newChat() {
  if (gen) stop();
  chat = { id: newId('c'), title: '', model: currentModel()?.id ?? settings.defaultModel, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (booted) viewTransition(renderThread);
  else renderThread();
  renderList();
  renderModel();
  closeSidebarOnMobile();
  if (!isMobile()) $('composer-input').focus();
}

async function openChat(id) {
  if (gen) stop();
  const c = await chats.get(id);
  if (!c) return newChat();
  chat = c;
  viewTransition(renderThread);
  if (!list.some((x) => x.id === c.id)) await refreshList();
  else renderList();
  renderModel();
  closeSidebarOnMobile();
  scrollToBottom(true);
}

async function persist() {
  chat.updatedAt = Date.now();
  if (!chat.title) chat.title = titleFrom(chat.messages.find((m) => m.role === 'user')?.content ?? 'New chat');
  await chats.put(chat).catch(() => toast('Could not save this chat in the browser.'));
  if (location.hash !== `#/c/${chat.id}`) history.replaceState(null, '', `#/c/${chat.id}`);
  await refreshList();
}
function titleFrom(t) {
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '...' : s || 'New chat';
}

async function refreshList() {
  list = (await chats.all().catch(() => [])).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, text: c.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ').slice(0, 4000) }));
  renderList();
}

function renderList() {
  const nav = $('chatList');
  const q = $('search').value.trim().toLowerCase();
  const items = q ? list.filter((c) => c.title.toLowerCase().includes(q) || c.text.toLowerCase().includes(q)) : list;
  if (!items.length) {
    nav.replaceChildren(el('p', { class: 'list-empty', text: q ? 'No chats match.' : 'Your chats appear here. They are stored in this browser only.' }));
    return;
  }
  const day = 86_400_000;
  const start = new Date().setHours(0, 0, 0, 0);
  const buckets = [
    ['Today', (t) => t >= start],
    ['Yesterday', (t) => t >= start - day],
    ['Previous 7 days', (t) => t >= start - 7 * day],
    ['Previous 30 days', (t) => t >= start - 30 * day],
    ['Older', () => true],
  ];
  const groups = new Map();
  for (const c of items) {
    const name = buckets.find(([, f]) => f(c.updatedAt))[0];
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(c);
  }
  const out = [];
  for (const [name, cs] of groups) {
    const ul = el('div', { class: 'chat-group', role: 'group', 'aria-label': name }, el('h3', { text: name }));
    for (const c of cs) ul.append(chatItem(c));
    out.push(ul);
  }
  nav.replaceChildren(...out);
}

function chatItem(c) {
  const active = chat?.id === c.id;
  const a = el('a', { href: `#/c/${c.id}`, text: c.title || 'New chat', 'aria-current': active ? 'page' : null, title: c.title });
  const row = el('div', { class: 'chat-item' + (active ? ' active' : '') }, a);
  const rename = el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Rename ${c.title}`, title: 'Rename' }, icon('edit'));
  const del = el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${c.title}`, title: 'Delete' }, icon('trash'));
  rename.addEventListener('click', () => {
    const input = el('input', { value: c.title, 'aria-label': 'Chat name', maxlength: '120' });
    row.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v) {
        const full = await chats.get(c.id);
        if (full) {
          full.title = v.slice(0, 120);
          await chats.put(full);
          if (chat?.id === c.id) chat.title = full.title;
        }
      }
      await refreshList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') (e.stopPropagation(), finish(false));
    });
    input.addEventListener('blur', () => finish(true));
  });
  del.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this chat?', `"${c.title}" is removed from this browser. This cannot be undone.`, 'Delete', true))) return;
    await chats.del(c.id);
    if (chat?.id === c.id) newChat();
    await refreshList();
    announce('Chat deleted');
  });
  row.append(el('span', { class: 'item-actions' }, rename, del));
  return row;
}

// ------------------------------------------------------------------ thread rendering

let enterNext = false;
function renderThread() {
  const box = $('messages');
  box.replaceChildren(...(chat?.messages ?? []).map((m, i) => msgEl(m, i)));
  if (enterNext) box.lastElementChild?.classList.add('enter');
  enterNext = false;
  enhance(box);
  $('empty').hidden = !!chat?.messages.length;
  renderNotice();
  markLast();
}

function renderNotice() {
  $('fundNotice').hidden = !!(S.key && S.balanceMsub != null && S.balanceMsub > 0);
}

function markLast() {
  const els = $('messages').querySelectorAll('.msg');
  els.forEach((e, i) => e.classList.toggle('last', i === els.length - 1));
}

function msgEl(m, i) {
  if (m.role === 'user') {
    const wrap = el('div', { class: 'msg user', 'data-i': i });
    if (m.images?.length) wrap.append(el('div', { class: 'imgs' }, ...m.images.map((u) => el('img', { src: u, alt: 'Attached image' }))));
    wrap.append(el('div', { class: 'bubble', text: m.content }));
    const actions = el('div', { class: 'actions' });
    actions.append(
      btnIcon('copy', 'Copy message', () => copyText(m.content, 'Message copied')),
      btnIcon('edit', 'Edit message', () => editMessage(i, wrap)),
    );
    wrap.append(actions);
    return wrap;
  }
  const wrap = el('div', { class: 'msg assistant' + (m.meta?.error ? ' error' : ''), 'data-i': i });
  if (m.reasoning) wrap.append(reasoningEl(m.reasoning, false, m.meta?.thinkMs));
  const content = el('div', { class: 'content md' });
  if (m.meta?.error) {
    content.className = 'content';
    const box = el('div', { class: 'err-box' }, el('span', { text: m.meta.error }));
    if (m.meta.fund) box.append(el('button', { class: 'btn small primary', type: 'button', text: 'Add funds', onclick: () => openWallet() }));
    content.append(box);
  } else content.innerHTML = renderMarkdown(m.content);
  wrap.append(content);
  if (m.meta?.stopped) wrap.append(el('div', { class: 'stopped', text: 'Stopped' }));
  wrap.append(assistantActions(m, i));
  return wrap;
}

function btnIcon(name, label, fn) {
  return el('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(name));
}

function assistantActions(m, i) {
  const actions = el('div', { class: 'actions' });
  if (!m.meta?.error) actions.append(btnIcon('copy', 'Copy reply', () => copyText(m.content, 'Reply copied')));
  const isLast = chat && i === chat.messages.length - 1;
  if (isLast) actions.append(btnIcon('refresh', 'Regenerate reply', () => regenerate()));
  const meta = metaText(m.meta);
  if (meta) actions.append(el('span', { class: 'meta', text: meta }));
  return actions;
}

function metaText(meta) {
  if (!meta || meta.error) return '';
  const parts = [];
  if (meta.cost_msub != null) parts.push(fmtCost(meta.cost_msub, meta.unit));
  if (meta.in != null && meta.out != null) parts.push(`${fmtInt(meta.in)} in, ${fmtInt(meta.out)} out`);
  const model = S.models.find((x) => x.id === meta.model);
  if (model) parts.push(model.name ?? model.id);
  if (meta.encrypted) parts.push('encrypted');
  return parts.join(' · ');
}

function reasoningEl(text, open, ms) {
  const d = el('details', { class: 'reasoning' });
  d.open = open;
  const sum = el('summary', {}, el('span', { class: 'r-label', text: ms ? `Thought for ${Math.max(1, Math.round(ms / 1000))} s` : 'Reasoning' }));
  d.append(sum, el('div', { class: 'r-body', text }));
  return d;
}

// ------------------------------------------------------------------ editing, regenerating

function editMessage(i, wrap) {
  if (gen) return;
  const m = chat.messages[i];
  const ta = el('textarea', { 'aria-label': 'Edit message' });
  ta.value = m.content;
  const save = el('button', { class: 'btn primary small', type: 'button', text: 'Send' });
  const cancel = el('button', { class: 'btn small', type: 'button', text: 'Cancel', onclick: () => renderThread() });
  const box = el('div', { class: 'edit-box' }, ta, el('div', { class: 'row' }, cancel, save));
  wrap.replaceChildren(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const go = async () => {
    const t = ta.value.trim();
    if (!t) return;
    chat.messages = chat.messages.slice(0, i);
    chat.messages.push({ ...m, content: t, id: newId('m') });
    renderThread();
    await persist();
    generate();
  };
  save.addEventListener('click', go);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) (e.preventDefault(), go());
    if (e.key === 'Escape') (e.stopPropagation(), renderThread());
  });
}

async function regenerate() {
  if (gen || !chat) return;
  while (chat.messages.length && chat.messages.at(-1).role === 'assistant') chat.messages.pop();
  if (!chat.messages.length) return;
  renderThread();
  generate();
}

// ------------------------------------------------------------------ sending

function apiMessages(model) {
  const out = [];
  if (settings.systemPrompt.trim()) out.push({ role: 'system', content: settings.systemPrompt.trim() });
  for (const m of chat.messages) {
    if (m.meta?.error) continue;
    if (m.role === 'assistant') {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      continue;
    }
    if (m.images?.length && model?.capabilities?.vision) {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))] });
    } else out.push({ role: 'user', content: m.content });
  }
  return out;
}

async function submit() {
  const ta = $('composer-input');
  const text = ta.value.trim();
  if ((!text && !attachments.length) || gen) return;
  if (!S.key) {
    toast('Add funds to start chatting');
    openWallet();
    return;
  }
  const model = currentModel();
  if (!model) return toast('No model available');
  if (!chat) newChat();
  chat.model = model.id;
  const msg = { id: newId('m'), role: 'user', content: text };
  if (attachments.length) msg.images = attachments.map((a) => a.url);
  chat.messages.push(msg);
  enterNext = true;
  ta.value = '';
  attachments = [];
  renderAttachments();
  autosize();
  updateSend();
  renderThread();
  scrollToBottom(true);
  await persist();
  generate();
}

let secureClientPromise = null;
async function secureFetch() {
  // Tinfoil's browser SDK (vendored, loaded only now): verifies the enclave attestation, then
  // HPKE-encrypts each body (EHBP). The gateway forwards the ciphertext without being able to read it.
  secureClientPromise ??= (async () => {
    const mod = await import('./vendor/tinfoil.js');
    const opts = { baseURL: `${location.origin}/v1/` };
    if (location.protocol === 'https:') opts.attestationBundleURL = location.origin;
    const client = new mod.SecureClient(opts);
    await client.ready();
    return client;
  })();
  secureClientPromise.catch(() => (secureClientPromise = null));
  return (await secureClientPromise).fetch;
}

async function generate() {
  const model = currentModel();
  const encrypted = isEncrypted(model);
  const target = chat;
  const reply = { id: newId('m'), role: 'assistant', content: '', reasoning: '', meta: { model: model.id, unit: S.unit, encrypted } };
  target.messages.push(reply);
  const box = $('messages');
  const node = msgEl(reply, target.messages.length - 1);
  node.querySelector('.actions').replaceChildren();
  const content = node.querySelector('.content');
  content.append(el('span', { class: 'thinking-dots', text: 'Thinking' }));
  node.classList.add('enter');
  box.append(node);
  $('empty').hidden = true;
  markLast();
  scrollToBottom(true);

  const controller = new AbortController();
  gen = { controller, chatId: target.id };
  setGenerating(true);
  const before = S.balanceMsub;
  const maxTokens = Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
  const payload = { model: encrypted ? model.upstream_model : model.id, messages: apiMessages(model), stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens };
  if (effortSel) payload.reasoning_effort = effortSel;
  const body = JSON.stringify(payload);

  let reasoningBox = null;
  let thinkStart = 0;
  let frame = 0;
  const fresh = []; // [start, end, time] of text that arrived recently, faded in across repaints
  let shownLen = 0;
  const caret = el('span', { class: 'cursor', 'aria-hidden': 'true' });
  const paint = () => {
    frame = 0;
    if (reply.reasoning && !reasoningBox) {
      reasoningBox = reasoningEl('', true);
      node.insertBefore(reasoningBox, content);
      thinkStart ||= performance.now();
    }
    if (reasoningBox) reasoningBox.querySelector('.r-body').textContent = reply.reasoning;
    if (reply.content) {
      if (reasoningBox && reasoningBox.open && !reply.meta.thinkMs) {
        reply.meta.thinkMs = performance.now() - thinkStart;
        reasoningBox.querySelector('.r-label').textContent = `Thought for ${Math.max(1, Math.round(reply.meta.thinkMs / 1000))} s`;
        reasoningBox.open = false;
      }
      content.innerHTML = renderMarkdown(reply.content);
      const now = performance.now();
      const len = content.textContent.length;
      if (len > shownLen) fresh.push([shownLen, len, now]);
      shownLen = len;
      while (fresh.length && now - fresh[0][2] > 280) fresh.shift();
      if (!reduced()) markFresh(content, fresh, now);
      caretTarget(content).append(caret);
    } else if (reply.reasoning) {
      content.replaceChildren();
    }
    if (stick) scrollToBottom();
  };
  const schedule = () => (frame ||= requestAnimationFrame(paint));

  let forge = null;
  let usage = null;
  try {
    let res;
    if (encrypted) {
      const f = await secureFetch().catch((e) => {
        throw new Error(`Encrypted mode is unavailable: ${e.message}. Turn off "Encrypt in browser" to send without it.`);
      });
      res = await f('chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${S.key}`, 'X-Tinfoil-Model': model.upstream_model, 'X-Tinfoil-Max-Output-Tokens': String(maxTokens) },
        body,
        signal: controller.signal,
      });
    } else {
      res = await fetch('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${S.key}` }, body, signal: controller.signal });
    }
    if (!res.ok) {
      let e = {};
      try {
        e = (await res.json()).error ?? {};
      } catch {
        /* not JSON */
      }
      const err = new Error(e.message ?? `The gateway answered HTTP ${res.status}.`);
      err.code = e.code;
      err.status = res.status;
      throw err;
    }
    await readStream(
      res,
      (d) => {
        reply.content += d;
        schedule();
      },
      (r) => {
        reply.reasoning += r;
        schedule();
      },
      (u) => (usage = u),
      (f) => (forge = f),
    );
  } catch (e) {
    if (e.name === 'AbortError' || controller.signal.aborted) {
      reply.meta.stopped = true;
    } else {
      reply.meta.error = friendlyError(e);
      reply.meta.fund = e.code === 'insufficient_balance' || e.status === 402 || e.code === 'invalid_key';
    }
  } finally {
    cancelAnimationFrame(frame);
    gen = null;
    setGenerating(false);
  }
  if (!reply.content && !reply.meta.error && !reply.meta.stopped) reply.meta.error = 'The model returned an empty reply.';
  if (reply.meta.error && reply.content) {
    reply.meta.partialError = reply.meta.error;
    delete reply.meta.error;
  }
  if (forge?.balance_msub != null) {
    S.balanceMsub = forge.balance_msub;
    renderBalance();
  }
  // A stopped stream is settled by the gateway just after the disconnect; give it a moment.
  if (reply.meta.stopped && !forge) await new Promise((r) => setTimeout(r, 900));
  await refreshBalance();
  if (!reply.meta.error) {
    const diff = before != null && S.balanceMsub != null ? Math.max(0, before - S.balanceMsub) : null;
    reply.meta.cost_msub = forge?.charged_msub ?? (diff || null);
    reply.meta.unit = forge?.unit ?? S.unit;
    if (usage) {
      reply.meta.in = usage.prompt_tokens;
      reply.meta.out = usage.completion_tokens;
    }
  }
  if (!reply.reasoning) delete reply.reasoning;
  if (target === chat) {
    node.replaceWith(msgEl(reply, target.messages.indexOf(reply)));
    enhance($('messages'));
    markLast();
    // Earlier assistant messages lose their regenerate button.
    renderActionsOnly();
  }
  await chats.put(target).catch(() => {});
  await refreshList();
  announce(reply.meta.error ? `Error: ${reply.meta.error}` : reply.meta.stopped ? 'Stopped.' : 'Reply complete.');
}

/** Wraps recently arrived text in fading spans; a negative delay keeps each fade continuous across repaints. */
function markFresh(root, ranges, now) {
  if (!ranges.length) return;
  const nodes = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let off = 0;
  for (let n; (n = w.nextNode()); ) {
    nodes.push([n, off]);
    off += n.length;
  }
  for (let r = ranges.length - 1; r >= 0; r--) {
    const [s, e, t] = ranges[r];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const [n, o] = nodes[i];
      const a = Math.max(s, o);
      const b = Math.min(e, o + n.length);
      if (a >= b || /^(TABLE|THEAD|TBODY|TR|UL|OL)$/.test(n.parentNode.nodeName) || !n.data.trim()) continue;
      let mid = n;
      if (a > o) mid = n.splitText(a - o);
      if (b - a < mid.length) mid.splitText(b - a);
      const span = document.createElement('span');
      span.className = 'fresh';
      span.style.animationDelay = `-${Math.round(now - t)}ms`;
      mid.replaceWith(span);
      span.append(mid);
    }
  }
}
/** The caret sits at the end of the last paragraph or list item, not on a line of its own. */
function caretTarget(content) {
  let t = content.lastElementChild;
  while (t?.lastElementChild && /^(UL|OL|LI|BLOCKQUOTE)$/.test(t.tagName)) t = t.lastElementChild;
  return t && /^(P|LI|H[1-6])$/.test(t.tagName) ? t : content;
}

function renderActionsOnly() {
  for (const node of $('messages').querySelectorAll('.msg.assistant')) {
    const i = Number(node.dataset.i);
    const m = chat.messages[i];
    if (!m) continue;
    node.querySelector('.actions')?.replaceWith(assistantActions(m, i));
  }
}

function friendlyError(e) {
  if (e.code === 'insufficient_balance' || e.status === 402) return 'Your balance is too low for this request. Add funds, or choose a cheaper model.';
  if (e.code === 'invalid_key' || e.status === 401) return 'The gateway does not recognize this balance key.';
  if (e.code === 'rate_limited') return 'Too many requests. Wait a moment and try again.';
  if (e.code === 'request_too_large' || e.status === 413) return 'This request is too large. Remove an image or start a new chat.';
  if (e instanceof TypeError) return 'The gateway could not be reached. Check your connection and try again.';
  return e.message;
}

/** Reads an OpenAI SSE stream: content, reasoning (reasoning_content or reasoning), usage, and the gateway's final event. */
async function readStream(res, onDelta, onReasoning, onUsage, onForge) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const lines = block.split(/\r?\n/);
      const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      let o;
      try {
        o = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev === 'forge') {
        onForge(o);
        continue;
      }
      if (o.error) throw new Error(o.error.message ?? 'The stream failed.');
      if (o.usage) onUsage(o.usage);
      const d = o.choices?.[0]?.delta;
      if (!d) continue;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) onReasoning(r);
      if (typeof d.content === 'string' && d.content) onDelta(d.content);
    }
  }
}

function stop() {
  gen?.controller.abort();
}

/** One button morphs between send and stop. */
function setGenerating(on) {
  const b = $('sendBtn');
  $('composer').classList.toggle('busy', on);
  b.setAttribute('aria-label', on ? 'Stop generating' : 'Send message');
  b.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  if (on) b.disabled = false;
  else updateSend();
}

// ------------------------------------------------------------------ composer

/** Grows the box to fit; the composer glides to its new place (FLIP on transform, no height animation). */
function autosize() {
  const ta = $('composer-input');
  const form = $('composer');
  const before = form.getBoundingClientRect().top;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  const dy = before - form.getBoundingClientRect().top;
  if (Math.abs(dy) > 2 && !reduced()) anim(form, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: DUR.fast + 40, easing: EASE.out });
}
function updateSend() {
  if (gen) return;
  $('sendBtn').disabled = !$('composer-input').value.trim() && !attachments.length;
}

async function addImages(files) {
  const model = currentModel();
  if (!model?.capabilities?.vision) return toast('This model does not read images');
  for (const f of [...files]) {
    if (!f.type.startsWith('image/')) continue;
    if (attachments.length >= MAX_IMAGES) {
      toast(`Up to ${MAX_IMAGES} images per message`);
      break;
    }
    try {
      attachments.push(await shrink(f));
    } catch {
      toast('That image could not be read');
    }
  }
  const total = attachments.reduce((s, a) => s + a.bytes, 0);
  if (total > 700_000) toast('Large images cost more: the gateway holds funds by request size until the reply is metered.', 4000);
  renderAttachments();
  updateSend();
}

/** Downscales to at most 1024 px and re-encodes as JPEG, which also drops EXIF data such as location. */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 1024 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const out = c.toDataURL('image/jpeg', 0.82);
      resolve({ url: out, bytes: out.length });
    };
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error('bad image')));
    img.src = url;
  });
}

function renderAttachments() {
  const box = $('attachments');
  box.hidden = !attachments.length;
  box.replaceChildren(
    ...attachments.map((a, i) =>
      el(
        'div',
        { class: 'attachment' },
        el('img', { src: a.url, alt: `Attached image ${i + 1}` }),
        el('button', { type: 'button', 'aria-label': `Remove image ${i + 1}`, onclick: () => (attachments.splice(i, 1), renderAttachments(), updateSend()) }, icon('x')),
      ),
    ),
  );
}

// ------------------------------------------------------------------ scrolling

let stick = true;
function scrollToBottom(force = false) {
  const t = $('thread');
  if (force) stick = true;
  if (stick) t.scrollTop = t.scrollHeight;
}
function onScroll() {
  const t = $('thread');
  const dist = t.scrollHeight - t.scrollTop - t.clientHeight;
  stick = dist < 80;
  $('jump').hidden = stick || !chat?.messages.length;
  $('topbar').classList.toggle('scrolled', t.scrollTop > 4);
}

// ------------------------------------------------------------------ sidebar, theme, settings

const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
function setSidebar(open, save = true) {
  $('app').classList.toggle('sb-collapsed', !open);
  $('scrim').hidden = !(open && isMobile());
  if (save && !isMobile()) {
    settings.sidebar = open;
    saveSettings();
  }
}
const sidebarOpen = () => !$('app').classList.contains('sb-collapsed');
function closeSidebarOnMobile() {
  if (isMobile()) setSidebar(false, false);
}

function applyTheme() {
  const t = settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

function fillSettingsModels() {
  const sel = $('setModel');
  sel.replaceChildren(...visibleModels().map((m) => el('option', { value: m.id, text: `${m.name ?? m.id} (${m.tier === 'enclave' ? 'Enclave' : 'Standard'})` })));
  sel.value = settings.defaultModel;
}

function openSettings() {
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === settings.theme;
  fillSettingsModels();
  $('setEffort').value = settings.effort;
  $('setPrompt').value = settings.systemPrompt;
  openSheet($('settingsDialog'));
}

function wireSettings() {
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.addEventListener('change', () => {
      settings.theme = r.value;
      saveSettings();
      viewTransition(applyTheme);
    });
  }
  $('setModel').addEventListener('change', (e) => {
    settings.defaultModel = e.target.value;
    saveSettings();
    if (chat && !chat.messages.length) {
      chat.model = settings.defaultModel;
      renderModel();
    }
  });
  $('setEffort').addEventListener('change', (e) => {
    settings.effort = e.target.value;
    saveSettings();
    renderModel();
  });
  let t;
  $('setPrompt').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      settings.systemPrompt = e.target.value;
      saveSettings();
    }, 250);
  });
  $('resetPrompt').addEventListener('click', () => {
    $('setPrompt').value = DEFAULT_PROMPT;
    settings.systemPrompt = DEFAULT_PROMPT;
    saveSettings();
    toast('Default system prompt restored');
  });
  $('deleteAll').addEventListener('click', async () => {
    if (!(await confirmDialog('Delete all chats?', 'Every chat stored in this browser is removed. Your balance and key are not affected.', 'Delete all', true))) return;
    await chats.clear();
    closeSheet($('settingsDialog'));
    newChat();
    await refreshList();
    toast('All chats deleted');
  });
}

// ------------------------------------------------------------------ suggestions

const SUGGESTIONS = [
  ['Explain eCash', 'How Cashu blind signatures keep payments private', 'Explain how Cashu eCash blind signatures keep payments private. Keep it short and use a simple analogy.'],
  ['Write code', 'A TypeScript function that formats sats as BTC', 'Write a TypeScript function that formats an amount in sats as BTC with 8 decimals, with a few test cases.'],
  ['Make a plan', 'Learn Rust in a week, an hour a day', 'Make a 7 day plan to learn the basics of Rust, one hour a day, with a small project at the end.'],
  ['Compare', 'Custodial and self-custodial bitcoin wallets', 'Compare custodial and self-custodial bitcoin wallets in a short table: security, recovery, privacy, convenience.'],
];
function renderSuggestions() {
  $('suggestions').replaceChildren(
    ...SUGGESTIONS.map(([t, sub, prompt], i) =>
      el('button', { class: 'suggestion', type: 'button', style: `--i:${i}`, onclick: () => ((($('composer-input').value = prompt), autosize(), updateSend()), S.key ? submit() : $('composer-input').focus()) }, el('strong', { text: t }), el('span', { text: sub })),
    ),
  );
}

// ------------------------------------------------------------------ events

function wire() {
  const ta = $('composer-input');
  ta.addEventListener('input', () => (autosize(), updateSend()));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isMobileKeyboard()) {
      e.preventDefault();
      submit();
    }
  });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length && currentModel()?.capabilities?.vision) (e.preventDefault(), addImages(files));
  });
  const form = $('composer');
  form.addEventListener('submit', (e) => (e.preventDefault(), gen ? stop() : submit()));
  form.addEventListener('dragover', (e) => {
    if (currentModel()?.capabilities?.vision && [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) (e.preventDefault(), form.classList.add('drag'));
  });
  form.addEventListener('dragleave', () => form.classList.remove('drag'));
  form.addEventListener('drop', (e) => {
    form.classList.remove('drag');
    if (e.dataTransfer?.files?.length) (e.preventDefault(), addImages(e.dataTransfer.files));
  });
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    addImages(e.target.files);
    e.target.value = '';
  });
  $('effort').addEventListener('change', (e) => {
    effortSel = e.target.value;
    renderEffort();
  });
  // Composer buttons keep focus in the message box: on iOS a tap that blurs it closes the keyboard,
  // the composer jumps while the viewport resizes, and the tap misses the button.
  for (const id of ['effortBtn', 'encryptChip', 'attachBtn', 'effortPop']) {
    $(id).addEventListener('pointerdown', (e) => {
      if (document.activeElement === $('composer-input')) e.preventDefault();
    });
  }
  $('effortBtn').addEventListener('click', () => ($('effortPop').hidden ? openEffort() : closeEffort()));
  $('effortPop').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    const sel = $('effort');
    sel.value = b.dataset.value;
    sel.dispatchEvent(new Event('change'));
    closeEffort(true);
  });
  $('effortPop').addEventListener('keydown', (e) => {
    const items = [...$('effortPop').querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeEffort(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('effortPop').hidden && !e.target.closest('#effortChip')) closeEffort();
  });
  $('encryptChip').addEventListener('click', () => {
    const box = $('encrypt');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    toast(box.checked ? 'Encryption in browser on' : 'Encryption in browser off: the gateway can read this chat', 2600);
  });
  $('encrypt').addEventListener('change', (e) => {
    settings.encrypt = e.target.checked;
    saveSettings();
    renderModel();
  });

  $('modelBtn').addEventListener('click', () => (!$('modelMenu').open ? openMenu() : closeMenu()));
  $('modelMenu').addEventListener('close', () => $('modelBtn').setAttribute('aria-expanded', 'false'));
  $('modelMenu').addEventListener('keydown', (e) => {
    const opts = [...$('modelMenu').querySelectorAll('.opt')];
    if (e.key === 'ArrowDown') (e.preventDefault(), (menuFocus = Math.min(opts.length - 1, menuFocus + 1)), focusOpt());
    else if (e.key === 'ArrowUp') (e.preventDefault(), (menuFocus = Math.max(0, menuFocus - 1)), focusOpt());
    else if (e.key === 'Home') (e.preventDefault(), (menuFocus = 0), focusOpt());
    else if (e.key === 'End') (e.preventDefault(), (menuFocus = opts.length - 1), focusOpt());
    else if (e.key === 'Enter' || e.key === ' ') {
      if (e.target.id === 'uncToggle') return;
      e.preventDefault();
      opts[menuFocus] && chooseModel(opts[menuFocus].dataset.id);
    } else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), closeMenu());
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('mousedown', (e) => {
    if ($('modelMenu').open && !$('modelMenu').matches(':modal') && !$('modelMenu').contains(e.target) && !$('modelBtn').contains(e.target)) closeMenu(false);
  });
  window.addEventListener('resize', () => {
    positionMenu();
    $('scrim').hidden = !(sidebarOpen() && isMobile());
  });

  $('balanceChip').addEventListener('click', () => openWallet());
  for (const ev of ['pointerenter', 'touchstart']) $('balanceChip').addEventListener(ev, () => wallet(), { once: true, passive: true });
  document.addEventListener('click', (e) => {
    const ow = e.target.closest?.('[data-open-wallet]');
    if (ow) {
      if ($('settingsDialog').open) closeSheet($('settingsDialog'));
      openWallet(ow.dataset.openWallet || undefined);
    }
    const cc = e.target.closest?.('.copy-code');
    if (cc) {
      const code = cc.closest('.code')?.querySelector('code')?.textContent ?? '';
      copyText(code, 'Code copied');
      cc.textContent = 'Copied';
      setTimeout(() => (cc.textContent = 'Copy'), 1500);
    }
  });
  $('newChat').addEventListener('click', newChat);
  $('newChatTop').addEventListener('click', newChat);
  $('sbClose').addEventListener('click', () => setSidebar(false));
  $('sbOpen').addEventListener('click', () => setSidebar(true));
  $('scrim').addEventListener('click', () => setSidebar(false, false));
  $('search').addEventListener('input', renderList);
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') (($('search').value = ''), renderList(), $('composer-input').focus());
  });
  $('openSettings').addEventListener('click', openSettings);
  $('openShortcuts').addEventListener('click', () => openSheet($('shortcutsDialog')));
  $('confirmDialog').addEventListener('click', (e) => e.target === $('confirmDialog') && $('confirmDialog').close());
  $('thread').addEventListener('scroll', onScroll, { passive: true });
  $('jump').addEventListener('click', () => (scrollToBottom(true), onScroll()));
  window.addEventListener('hashchange', () => {
    const id = /^#\/c\/(.+)$/.exec(location.hash)?.[1];
    if (id && id !== chat?.id) openChat(id);
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) for (const k of document.querySelectorAll('[data-mod]')) k.textContent = 'Cmd';

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape' && gen && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      stop();
      return;
    }
    if (mod && e.shiftKey && k === 'o') (e.preventDefault(), newChat());
    else if (mod && e.shiftKey && k === 's') (e.preventDefault(), setSidebar(!sidebarOpen()));
    else if (mod && e.shiftKey && k === 'm') (e.preventDefault(), openMenu());
    else if (mod && e.shiftKey && k === 'w') (e.preventDefault(), openWallet());
    else if (mod && e.shiftKey && k === 'c') {
      const last = [...(chat?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content);
      if (last) (e.preventDefault(), copyText(last.content, 'Reply copied'));
    } else if (mod && k === 'k') {
      e.preventDefault();
      setSidebar(true, false);
      $('search').focus();
    } else if (mod && k === '/') (e.preventDefault(), openSheet($('shortcutsDialog')));
    else if (e.key === '/' && !mod && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      $('composer-input').focus();
    }
  });
}
const isMobileKeyboard = () => window.matchMedia('(pointer: coarse)').matches && isMobile();

/**
 * Keeps the app inside the visible area when an on-screen keyboard opens. Android follows the
 * interactive-widget=resizes-content viewport; iOS Safari ignores it and only shrinks the visual
 * viewport, so the app takes the visual viewport's height and offset. Pinch zoom is left alone.
 */
function fitViewport() {
  const vv = window.visualViewport;
  const r = document.documentElement.style;
  if (!vv || vv.scale > 1.01) {
    r.removeProperty('--app-h');
    r.removeProperty('--app-top');
    return;
  }
  r.setProperty('--app-h', `${Math.round(vv.height)}px`);
  r.setProperty('--app-top', `${Math.max(0, Math.round(vv.pageTop ?? vv.offsetTop))}px`);
  if (document.activeElement?.id === 'composer-input' && stick) scrollToBottom();
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);

// ------------------------------------------------------------------ start

applyTheme();
fitViewport();
wire();
wireSettings();
renderSuggestions();
S.key = load(KEY_STORE);
setSidebar(isMobile() ? false : settings.sidebar !== false, false);
renderBalance();
await Promise.all([loadModels(), refreshBalance(), refreshList()]);
const initial = /^#\/c\/(.+)$/.exec(location.hash)?.[1];
if (initial) await openChat(initial);
else newChat();
booted = true;
if (!isMobile()) $('composer-input').focus();

// ------------------------------------------------------------------ composer controls

/** The effort button: an icon with a one-letter badge; its menu lists the options of the hidden select. */
function renderEffort() {
  const sel = $('effort');
  const opt = sel.selectedOptions[0];
  const v = sel.value;
  const badge = $('effortBadge');
  badge.hidden = !v;
  badge.textContent = v ? v[0].toUpperCase() : '';
  $('effortLabel').textContent = `Reasoning effort: ${opt ? opt.text.replace(/ effort$/i, '').toLowerCase() : 'default'}`;
  $('effortBtn').classList.toggle('on', !!v);
  $('effortPop').replaceChildren(
    ...[...sel.options].map((o) =>
      el('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(o.value === v), 'data-value': o.value, class: o.value === v ? 'on' : '', text: o.text.replace(/ effort$/i, '') }),
    ),
  );
}
function openEffort() {
  const pop = $('effortPop');
  pop.hidden = false;
  $('effortBtn').setAttribute('aria-expanded', 'true');
  if (document.activeElement !== $('composer-input')) (pop.querySelector('[aria-checked="true"]') ?? pop.querySelector('button'))?.focus();
}
function closeEffort(refocus = false) {
  $('effortPop').hidden = true;
  $('effortBtn').setAttribute('aria-expanded', 'false');
  if (refocus && document.activeElement !== $('composer-input')) $('effortBtn').focus();
}
