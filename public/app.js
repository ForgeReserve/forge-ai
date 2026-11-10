// Forge AI chat page. Plain ES modules, no build step, nothing loaded from another origin.
// Privacy: chats are kept in this browser (IndexedDB) and sent to the gateway only as the messages of
// the request being made. The balance key and settings live in localStorage.
import { renderMarkdown, enhance } from './js/markdown.js';
import { chats, newId } from './js/store.js';
import { $, el, icon, store, load, toast, announce, copyText, confirmDialog, fmtBalance, fmtCost, fmtInt, api, errMsg } from './js/ui.js';
import { initWallet, openWallet, syncWalletBalance } from './js/wallet.js';
import { lockKey, parseLockKey, saveLockKey, shortKey } from './js/lockkey.js';

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

async function refreshBalance() {
  if (!S.key) return renderBalance();
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
  renderBalance();
  renderNotice();
  syncWalletBalance();
}

function renderBalance() {
  const chip = $('balanceChip');
  const text = $('balanceText');
  chip.classList.remove('is-empty', 'is-low');
  if (!S.key) {
    text.textContent = 'Add funds';
    chip.classList.add('is-empty');
  } else if (S.balanceMsub == null) {
    text.textContent = 'Wallet';
    chip.classList.add('is-empty');
  } else {
    text.textContent = fmtBalance(S.balanceMsub, S.unit);
    const low = S.unit === 'usd' ? 10_000 : 100_000;
    if (S.balanceMsub < low) chip.classList.add('is-low');
  }
  chip.setAttribute('aria-label', S.key && S.balanceMsub != null ? `Balance ${text.textContent}. Open wallet` : 'Open wallet to add funds');
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

function renderModel() {
  const m = currentModel();
  $('modelName').textContent = m ? (m.name ?? m.id) : S.models.length ? 'Choose a model' : 'No models';
  const tier = $('modelTier');
  tier.hidden = !m;
  if (m) {
    tier.replaceChildren(...(m.tier === 'enclave' ? [icon('lock'), 'Enclave'] : ['Standard']));
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
  $('encryptChip').hidden = !(m?.tier === 'enclave' && m?.encrypted_passthrough);
  $('encrypt').checked = settings.encrypt;
  $('encryptChip').classList.toggle('on', settings.encrypt);
  $('privacyNote').textContent = !m
    ? ''
    : m.tier !== 'enclave'
      ? 'Standard model: the gateway and the model provider can read this chat. Chats are saved in this browser only.'
      : isEncrypted(m)
        ? 'Enclave model, encrypted in this browser: only the attested enclave can read this chat.'
        : 'Enclave model, not encrypted in the browser: the gateway can read this chat while relaying it.';
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
  if (!$('modelMenu').hidden) renderMenu();
}

// model menu (a listbox popover)
let menuFocus = -1;
function openMenu() {
  const menu = $('modelMenu');
  renderMenu();
  menu.hidden = false;
  positionMenu();
  $('modelBtn').setAttribute('aria-expanded', 'true');
  const opts = [...menu.querySelectorAll('.opt')];
  menuFocus = Math.max(0, opts.findIndex((o) => o.getAttribute('aria-selected') === 'true'));
  focusOpt();
  menu.focus();
}
function closeMenu(refocus = true) {
  $('modelMenu').hidden = true;
  $('modelBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('modelBtn').focus();
}
function positionMenu() {
  const r = $('modelBtn').getBoundingClientRect();
  const menu = $('modelMenu');
  menu.style.top = `${r.bottom + 6}px`;
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(16, Math.min(r.left, window.innerWidth - w - 16))}px`;
}
function renderMenu() {
  const menu = $('modelMenu');
  const cur = currentModel();
  const group = (title, sub, models) => {
    if (!models.length) return [];
    return [
      el('h4', { role: 'presentation' }, title === 'Enclave' ? icon('lock') : null, title, sub ? el('small', { text: sub }) : null),
      ...models.map((m) => {
        const tags = [];
        if (m.capabilities?.vision) tags.push(el('span', { class: 'tag', text: 'Images' }));
        if (m.capabilities?.reasoning) tags.push(el('span', { class: 'tag', text: 'Reasoning' }));
        if (m.speed) tags.push(el('span', { class: 'tag', text: speedLabel[m.speed] }));
        const o = el('div', { class: 'opt', role: 'option', id: `opt-${m.id.replace(/[^\w-]/g, '_')}`, 'aria-selected': String(m.id === cur?.id), 'data-id': m.id }, el('span', { class: 'o-name', text: m.name ?? m.id }), el('span', { class: 'o-tags' }, ...tags), el('span', { class: 'o-sub', text: priceText(m) + (m.pricing?.verified === false ? ' (provisional price)' : '') }));
        o.addEventListener('click', () => chooseModel(m.id));
        return o;
      }),
    ];
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
  menu.replaceChildren(
    ...group('Enclave', 'Runs in an attested enclave', vis.filter((m) => m.tier === 'enclave')),
    ...group('Standard', 'Provider can read prompts', vis.filter((m) => m.tier !== 'enclave')),
    ...(settings.showUncensored ? group('Uncensored', 'Fewer refusals', unc) : []),
    unc.length
      ? el('div', { class: 'menu-foot' }, el('label', { class: 'switch', for: 'uncToggle' }, toggle, el('span', {}, el('b', { text: 'Show uncensored models' }), 'They are tuned to refuse less and can write harmful or explicit text.')))
      : null,
  );
  if (!S.models.length) menu.append(el('p', { class: 'hint', style: 'padding:10px', text: 'The gateway lists no models right now.' }));
}
function focusOpt() {
  const opts = [...$('modelMenu').querySelectorAll('.opt')];
  opts.forEach((o, i) => o.classList.toggle('focus', i === menuFocus));
  const o = opts[menuFocus];
  if (o) {
    $('modelMenu').setAttribute('aria-activedescendant', o.id);
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
  renderModel();
  $('setModel').value = id;
}

// ------------------------------------------------------------------ conversations

function newChat() {
  if (gen) stop();
  chat = { id: newId('c'), title: '', model: currentModel()?.id ?? settings.defaultModel, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  if (location.hash) history.replaceState(null, '', location.pathname);
  renderThread();
  renderList();
  renderModel();
  closeSidebarOnMobile();
  $('composer-input').focus();
}

async function openChat(id) {
  if (gen) stop();
  const c = await chats.get(id);
  if (!c) return newChat();
  chat = c;
  renderThread();
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

function renderThread() {
  const box = $('messages');
  box.replaceChildren(...(chat?.messages ?? []).map((m, i) => msgEl(m, i)));
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
      content.append(el('span', { class: 'cursor', 'aria-hidden': 'true' }));
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

function setGenerating(on) {
  $('sendBtn').hidden = on;
  $('stopBtn').hidden = !on;
  if (!on) updateSend();
}

// ------------------------------------------------------------------ composer

function autosize() {
  const ta = $('composer-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
}
function updateSend() {
  $('sendBtn').disabled = !!gen || (!$('composer-input').value.trim() && !attachments.length);
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
  $('setLockKey').value = lockKey();
  $('lockKeyMsg').textContent = lockKey() ? `Refunds are locked to ${shortKey(lockKey())}.` : 'Not set: refunds are ordinary eCash tokens.';
  $('settingsDialog').showModal();
}

function wireSettings() {
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.addEventListener('change', () => {
      settings.theme = r.value;
      saveSettings();
      applyTheme();
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
  const lockMsg = (text, err = false) => {
    $('lockKeyMsg').textContent = text;
    $('lockKeyMsg').classList.toggle('err', err);
  };
  $('saveLockKey').addEventListener('click', () => {
    const v = $('setLockKey').value.trim();
    if (!v) {
      saveLockKey('');
      return lockMsg('Not set: refunds are ordinary eCash tokens.');
    }
    try {
      const hex = parseLockKey(v);
      saveLockKey(hex);
      $('setLockKey').value = hex;
      lockMsg(`Saved. Refunds are locked to ${shortKey(hex)}.`);
      toast('Refunds will be locked to your wallet key');
    } catch (e) {
      lockMsg(e.message, true);
    }
  });
  $('clearLockKey').addEventListener('click', () => {
    $('setLockKey').value = '';
    saveLockKey('');
    lockMsg('Not set: refunds are ordinary eCash tokens.');
  });
  $('deleteAll').addEventListener('click', async () => {
    if (!(await confirmDialog('Delete all chats?', 'Every chat stored in this browser is removed. Your balance and key are not affected.', 'Delete all', true))) return;
    await chats.clear();
    $('settingsDialog').close();
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
    ...SUGGESTIONS.map(([t, sub, prompt]) =>
      el('button', { class: 'suggestion', type: 'button', onclick: () => ((($('composer-input').value = prompt), autosize(), updateSend()), S.key ? submit() : $('composer-input').focus()) }, el('strong', { text: t }), el('span', { text: sub })),
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
  form.addEventListener('submit', (e) => (e.preventDefault(), submit()));
  form.addEventListener('dragover', (e) => {
    if (currentModel()?.capabilities?.vision && [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) (e.preventDefault(), form.classList.add('drag'));
  });
  form.addEventListener('dragleave', () => form.classList.remove('drag'));
  form.addEventListener('drop', (e) => {
    form.classList.remove('drag');
    if (e.dataTransfer?.files?.length) (e.preventDefault(), addImages(e.dataTransfer.files));
  });
  $('stopBtn').addEventListener('click', stop);
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    addImages(e.target.files);
    e.target.value = '';
  });
  $('effort').addEventListener('change', (e) => (effortSel = e.target.value));
  $('encrypt').addEventListener('change', (e) => {
    settings.encrypt = e.target.checked;
    saveSettings();
    renderModel();
  });

  $('modelBtn').addEventListener('click', () => ($('modelMenu').hidden ? openMenu() : closeMenu()));
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
    if (!$('modelMenu').hidden && !$('modelMenu').contains(e.target) && !$('modelBtn').contains(e.target)) closeMenu(false);
  });
  window.addEventListener('resize', () => {
    if (!$('modelMenu').hidden) positionMenu();
    $('scrim').hidden = !(sidebarOpen() && isMobile());
  });

  $('balanceChip').addEventListener('click', () => openWallet());
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-open-wallet]')) openWallet();
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
  $('openShortcuts').addEventListener('click', () => $('shortcutsDialog').showModal());
  for (const d of document.querySelectorAll('dialog.modal')) {
    d.querySelector('[data-close]')?.addEventListener('click', () => d.close());
    d.addEventListener('click', (e) => e.target === d && d.close());
  }
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
    } else if (mod && k === '/') (e.preventDefault(), $('shortcutsDialog').showModal());
    else if (e.key === '/' && !mod && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      $('composer-input').focus();
    }
  });
}
const isMobileKeyboard = () => window.matchMedia('(pointer: coarse)').matches && isMobile();

// ------------------------------------------------------------------ start

applyTheme();
wire();
wireSettings();
renderSuggestions();
initWallet(S, {
  setKey,
  refresh: refreshBalance,
});
S.key = load(KEY_STORE);
setSidebar(isMobile() ? false : settings.sidebar !== false, false);
renderBalance();
await Promise.all([loadModels(), refreshBalance(), refreshList()]);
const initial = /^#\/c\/(.+)$/.exec(location.hash)?.[1];
if (initial) await openChat(initial);
else newChat();
if (!isMobile()) $('composer-input').focus();
