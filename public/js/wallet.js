// The wallet sheet: balance, Add funds (eCash, Lightning, On-chain, Other mint), Refund as eCash,
// and, under Advanced, the balance key and the refund lock key. One task per view: a view has a
// header (back, title, close), a scrolling body and one primary button pinned at the bottom. Views
// slide in and out of a stack. Funding UX (invoice QR, copy, open in wallet, countdown, live status)
// follows the cashucard.org/fund kit. Loaded on first use.
import { renderQR, playAnimatedQR, STATIC_MAX } from './qr.js';
import { lockKey, parseLockKey, saveLockKey, shortKey } from './lockkey.js';
import { $, el, icon, api, errMsg, toast, announce, copyText, download, confirmDialog, fmtUnits, fmtBalance, fmtInt, loadScript } from './ui.js';
import { anim, closeSheet, DUR, EASE, flipFrom, openSheet, reduced, rollText, slideSwap, successMark, haptic } from './motion.js';

let S; // shared app state: {key, unit, balanceMsub, availableMsub, inviteOnly, units, mints}
let hooks; // {setKey(key), refresh()}
let methods = null; // GET /v1/wallet/fund/methods, or null when the gateway has only eCash topups
let methodsAt = 0;
let current = 'home'; // name of the view on screen
let heroShown = null; // balance text the hero last showed, so it can roll to the new value
let heroMsub = null;
const timers = new Set(); // live pollers and players, stopped when a view is replaced
let scanJob = null;

const dlg = () => $('walletDialog');
const stack = () => $('walletStack');

export function initWallet(state, h) {
  S = state;
  hooks = h;
  dlg().addEventListener('close', () => {
    stopAll();
    current = 'home';
  });
}

const refundableNow = () => Math.floor((S.availableMsub ?? S.balanceMsub ?? 0) / 1000);

/** Keeps the open wallet's balance in step with the header (called after every balance refresh). */
export function syncWalletBalance({ celebrate = false } = {}) {
  if (!dlg().open) return;
  if (current === 'home') {
    const big = $('walletBig');
    if (!big || big.classList.contains('skel')) return go(home, 0);
    heroShown = fmtBalance(S.balanceMsub, S.unit, true);
    heroMsub = S.balanceMsub;
    rollText(big, heroShown, { celebrate });
    $('walletRefundable').textContent = `Refundable now: ${fmtUnits(refundableNow(), S.unit)}`;
    $('refundBtn').disabled = refundableNow() < 1;
  }
}

const VIEWS = { home: () => home, add: () => chooser, ecash: () => ecashStep, lightning: () => lightningStep, onchain: () => onchainStep, foreign: () => foreignStep, refund: () => refundStep };

export async function openWallet(which) {
  const want = which === 'advanced' ? 'home' : which && VIEWS[which] ? which : 'home';
  if (!dlg().open) {
    stopAll();
    stack().replaceChildren(VIEWS[want]()({ advanced: which === 'advanced' }));
    current = want;
    openSheet(dlg());
  } else go(VIEWS[want](), 0);
  await loadMethods();
  if (current === 'add') go(chooser, 0, null, { quiet: true });
}

async function loadMethods(force = false) {
  if (!force && Date.now() - methodsAt < 60_000) return;
  try {
    const r = await api('/v1/wallet/fund/methods');
    methods = r.res.ok ? r.body : null;
  } catch {
    methods = null;
  }
  methodsAt = Date.now();
}

function stopAll() {
  for (const t of timers) t.stop();
  timers.clear();
  stopScan();
}
function track(stopper) {
  timers.add(stopper);
  return stopper;
}

// ------------------------------------------------------------------ view stack

/**
 * Shows a view. dir: 1 forward (slides left), -1 back, 0 replace in place. `from` is the rect of a
 * method icon, which then travels into the new view's header (a shared element).
 */
function go(builder, dir = 1, from = null, opts = {}) {
  stopAll();
  const scroll = stack().querySelector('.d-body')?.scrollTop ?? 0;
  const v = dir === 0 ? (stack().replaceChildren(builder(opts)), stack().firstElementChild) : slideSwap(stack(), () => builder(opts), dir);
  if (dir === 0 && opts.quiet) {
    const b = v.querySelector('.d-body');
    if (b) b.scrollTop = scroll;
  }
  current = v.dataset.view;
  dlg().setAttribute('aria-label', v.dataset.title);
  if (from) flipFrom(from, v.querySelector('.head-ico'));
  if (dir !== 0) (v.querySelector('.back') ?? v.querySelector('h2'))?.focus({ preventScroll: true });
  return v;
}

/** A view: header (back, icon, title, close), scrolling body, pinned footer. */
function view(name, { title, ico, back, body = [], foot = [] }) {
  const head = el('div', { class: 'd-head' });
  if (back) head.append(el('button', { class: 'icon-btn back', type: 'button', 'aria-label': 'Back', onclick: () => go(back, -1) }, icon('back')));
  head.append(
    el('h2', { tabindex: '-1' }, ico ? el('span', { class: 'head-ico' }, icon(ico)) : null, title),
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close wallet', onclick: () => closeSheet(dlg()) }, icon('x')),
  );
  const f = el('div', { class: 'd-foot pinned' }, ...foot.filter(Boolean));
  return el('div', { class: 'view', 'data-view': name, 'data-title': title }, head, el('div', { class: 'd-body' }, ...body.flat().filter(Boolean)), f);
}

// ------------------------------------------------------------------ shared bits

function msgLine() {
  const p = el('p', { class: 'msgline', role: 'status' });
  p.set = (text, kind = '') => {
    p.textContent = text;
    p.className = 'msgline ' + kind;
  };
  return p;
}

function status(kind, text) {
  const s = el('div', { class: 'status', 'data-kind': kind, role: 'status' }, el('span', { text }));
  s.set = (k, t) => {
    s.setAttribute('data-kind', k);
    s.firstChild.textContent = t;
  };
  return s;
}

/** Applies a funding response: stores a gateway-generated key at once. */
function absorb(f) {
  if (f?.key && f.key !== S.key) hooks.setKey(f.key);
}

const inviteFor = () => (!S.key && S.inviteOnly ? S.invite || undefined : undefined);

/** The invite field, shown at the top of every funding step while it is needed. */
function inviteField() {
  if (S.key || !S.inviteOnly) return null;
  const inv = el('input', { id: 'invite', class: 'input', placeholder: 'inv-...', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: S.invite ?? '' });
  inv.addEventListener('input', () => (S.invite = inv.value.trim()));
  return el('div', { class: 'field' }, el('label', { for: 'invite', text: 'Invite code' }), inv, el('p', { class: 'hint small', text: 'Forge AI is invite only. A new balance needs an invite code, whichever way you pay.' }));
}

function needInvite(msg) {
  if (!S.key && S.inviteOnly && !S.invite) {
    msg.set('Enter your invite code first.', 'err');
    $('invite')?.focus();
    return true;
  }
  return false;
}

const unitLabel = (u) => (u === 'usd' ? 'USD' : 'sat');

function seg(units, current, onChange, label = 'Unit') {
  const g = el('div', { class: 'seg', role: 'group', 'aria-label': label });
  for (const u of units) {
    const b = el('button', { type: 'button', 'aria-pressed': String(u === current), text: unitLabel(u) });
    b.addEventListener('click', () => {
      for (const x of g.children) x.setAttribute('aria-pressed', String(x === b));
      onChange(u);
    });
    g.append(b);
  }
  return g;
}

/**
 * Amount entry: quick-pick chips plus a custom field with a unit toggle.
 * Returns {node, value() -> whole units or NaN, unit() -> current unit}.
 */
function amountPicker({ units, unit: start, presets, initial, id = 'amount' }) {
  let unit = start;
  const chips = el('div', { class: 'amounts', role: 'group', 'aria-label': 'Quick amounts' });
  const input = el('input', { id, inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Amount' });
  const pre = el('span', { class: 'pre', 'aria-hidden': 'true', text: '$' });
  const tail = units.length > 1 ? seg(units, unit, (u) => ((unit = u), setup()), 'Amount unit') : el('span', { class: 'suffix', text: unitLabel(unit) });
  const field = el('div', { class: 'amount-field' }, pre, input, tail);
  const short = (n) => (unit === 'usd' ? `$${n / 100}` : n >= 1000 ? `${n / 1000}k sat` : `${n} sat`);
  const show = (n) => (unit === 'usd' ? (n / 100).toFixed(2) : String(n));
  const mark = () => {
    const v = value();
    for (const c of chips.children) c.setAttribute('aria-pressed', String(Number(c.dataset.n) === v));
  };
  const setup = () => {
    pre.hidden = unit !== 'usd';
    input.setAttribute('aria-label', unit === 'usd' ? 'Amount in US dollars' : 'Amount in sats');
    input.inputMode = unit === 'usd' ? 'decimal' : 'numeric';
    chips.replaceChildren(
      ...presets(unit).map((n) => {
        const b = el('button', { class: 'amount-chip', type: 'button', 'data-n': String(n), 'aria-pressed': 'false', text: short(n) });
        b.addEventListener('click', () => {
          input.value = show(n);
          mark();
          haptic(6);
        });
        return b;
      }),
    );
    input.value = show(initial(unit));
    mark();
  };
  const value = () => {
    const v = input.value.replace(/[$,\s]/g, '');
    if (unit === 'usd') return /^\d+(\.\d{0,2})?$/.test(v) ? Math.round(Number(v) * 100) : NaN;
    return /^\d+$/.test(v) ? Number(v) : NaN;
  };
  input.addEventListener('input', mark);
  setup();
  return { node: el('div', { class: 'section' }, chips, field), value, unit: () => unit, input };
}

function scanBlock(onText, msg) {
  const video = el('video', { muted: true, playsinline: true, 'aria-label': 'Camera preview' });
  const bar = el('div', { class: 'bar' });
  const text = el('p', { class: 'hint', text: 'Point the camera at the QR code in your wallet.', role: 'status' });
  const box = el('div', { class: 'section', hidden: true }, el('div', { class: 'scanner' }, video, el('div', { class: 'frame' }), bar), text, el('div', { class: 'row end' }, el('button', { class: 'btn small', type: 'button', text: 'Cancel', onclick: () => (stopScan(), (box.hidden = true)) })));
  const open = async () => {
    msg.set('');
    box.hidden = false;
    bar.style.transform = 'scaleX(0)';
    announce('Camera open. Point it at the QR code in your wallet.');
    try {
      await loadScript('/js/scan.js');
      stopScan();
      scanJob = window.ForgeScan.scan(video, (p) => {
        bar.style.transform = `scaleX(${p})`;
        if (p > 0 && p < 1) text.textContent = `Reading an animated code: ${Math.round(p * 100)}%. Keep it in view.`;
      });
      const out = await scanJob.promise;
      box.hidden = true;
      onText(out);
    } catch (e) {
      box.hidden = true;
      if (e?.message) msg.set(e.message, 'err');
    } finally {
      scanJob = null;
    }
  };
  const btn = el('button', { class: 'btn', type: 'button', onclick: open }, icon('scan'), 'Scan QR code');
  return { btn, box };
}
function stopScan() {
  if (scanJob) scanJob.stop();
  scanJob = null;
}

/** QR + copy + download for an eCash token. Long tokens get an animated NUT-16 code. */
export function tokenView(token, { amount, unit, label = 'eCash' } = {}) {
  const box = el('div', { class: 'qr loading', role: 'img', 'aria-label': 'QR code of the eCash token' });
  const wrap = el('div', { class: 'section' });
  const long = token.length > STATIC_MAX;
  let mode = long ? 'animated' : 'static';
  let player = null;
  const note = el('p', { class: 'hint small', style: 'text-align:center' });
  const draw = async () => {
    player?.stop();
    if (player) timers.delete(player);
    player = null;
    if (mode === 'animated') {
      const p = await playAnimatedQR(box, token);
      player = track({ player: true, stop: p.stop });
      note.textContent = `Animated code in ${p.parts} parts. Hold your wallet's scanner on it until it completes.`;
    } else {
      try {
        await renderQR(box, token, 'L');
        note.textContent = long ? 'One dense code. If your wallet cannot read it, switch back to the animated code.' : '';
      } catch {
        box.textContent = 'Too long for one QR code.';
        note.textContent = '';
      }
    }
  };
  const fname = `forge-ecash-${amount ?? ''}${unit ? '-' + unit : ''}-${new Date().toISOString().slice(0, 10)}.txt`;
  const actions = el(
    'div',
    { class: 'row center' },
    el('button', { class: 'btn primary', type: 'button', onclick: () => copyText(token, `${label} copied`) }, icon('copy'), 'Copy'),
    el('button', { class: 'btn', type: 'button', onclick: () => (download(fname, token + '\n'), toast('Saved as a text file')) }, icon('download'), 'Download'),
  );
  if (long && token.length < 2800) {
    const sw = el('button', { class: 'btn ghost small', type: 'button', text: 'Show one QR code' });
    sw.addEventListener('click', () => {
      mode = mode === 'animated' ? 'static' : 'animated';
      sw.textContent = mode === 'animated' ? 'Show one QR code' : 'Show animated code';
      draw();
    });
    actions.append(sw);
  }
  wrap.append(box, note, actions, el('details', { class: 'more' }, el('summary', { text: 'Show as text' }), el('div', { class: 'mono-box', text: token })));
  draw();
  return wrap;
}

function countdown(target, expiresAt, onExpire) {
  const draw = () => {
    const s = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    target.textContent = s ? `Valid for ${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(sec).padStart(2, '0')}` : 'Expired';
    if (!s) {
      t.stop();
      onExpire?.();
    }
  };
  const id = setInterval(draw, 1000);
  const t = track({ stop: () => clearInterval(id) });
  draw();
  return t;
}

/** Polls GET /v1/wallet/fund/:id until a terminal state; calls onUpdate with each funding. */
function poll(id, everyMs, onUpdate) {
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    if (!document.hidden) {
      try {
        const r = await api(`/v1/wallet/fund/${encodeURIComponent(id)}`, { key: S.key });
        if (r.res.ok && r.body) {
          absorb(r.body);
          const done = onUpdate(r.body);
          if (done) return stop.stop();
        }
      } catch {
        /* offline: keep trying */
      }
    }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  const stop = track({
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  });
  timer = setTimeout(tick, everyMs);
  return stop;
}

const TERMINAL = new Set(['done', 'expired', 'failed', 'refunded']);

/** Swaps a QR code for the success mark: the code collapses, a check draws, a ring and sparks burst. */
async function celebrateQR(stage, box, label) {
  haptic(18);
  await anim(box, [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.35) rotate(-8deg)', opacity: 0 }], { duration: reduced() ? 1 : 260, easing: EASE.in, fill: 'forwards' });
  box.style.visibility = 'hidden';
  stage.append(successMark(label));
}

const doneButton = () => el('button', { class: 'btn primary big block', type: 'button', text: 'Done', onclick: () => go(home, -1) });

// ------------------------------------------------------------------ home

function home({ advanced = false } = {}) {
  const body = [];
  const foot = [];
  const hero = el('div', { class: 'hero' });
  if (S.key && S.balanceMsub != null) {
    const target = fmtBalance(S.balanceMsub, S.unit, true);
    const big = el('div', { class: 'big', id: 'walletBig', 'data-glow': '' });
    const from = heroShown;
    const up = heroMsub != null && S.balanceMsub > heroMsub;
    rollText(big, from ?? target);
    if (from != null && from !== target) setTimeout(() => rollText(big, target, { celebrate: up }), DUR.slow);
    heroShown = target;
    heroMsub = S.balanceMsub;
    const refund = el('button', { class: 'btn small', type: 'button', id: 'refundBtn', disabled: refundableNow() < 1, onclick: () => go(refundStep, 1) }, icon('download'), 'Refund as eCash');
    hero.append(
      el('div', { class: 'cap', text: S.unit === 'usd' ? 'Balance (USD)' : 'Balance (sat)' }),
      big,
      el('div', { class: 'sub', id: 'walletRefundable', text: `Refundable now: ${fmtUnits(refundableNow(), S.unit)}` }),
      el('div', { class: 'row center', style: 'margin-top:8px' }, refund),
    );
  } else if (S.key) {
    hero.append(el('div', { class: 'cap', text: 'Balance' }), el('div', { class: 'big skel', id: 'walletBig', text: '0.00' }), el('div', { class: 'sub', text: 'Checking your balance' }));
  } else {
    hero.append(el('div', { class: 'cap', text: 'Balance' }), el('div', { class: 'big', text: '0' }), el('p', { class: 'hint', style: 'max-width:22rem', text: 'Add funds to open a balance. Every message is paid from it, and you can take the rest back as eCash at any time.' }));
  }
  body.push(hero);
  if (S.key) body.push(historySection());
  const adv = el('details', { class: 'adv' }, el('summary', { text: 'Advanced' }), el('div', { class: 'adv-body' }, keySection(), lockKeySection()));
  adv.open = advanced;
  body.push(adv);
  if (advanced) requestAnimationFrame(() => adv.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }));
  foot.push(el('button', { class: 'btn primary big block', type: 'button', onclick: () => go(chooser, 1) }, icon('plus'), 'Add funds'));
  return view('home', { title: 'Wallet', ico: 'wallet', body, foot });
}

// ------------------------------------------------------------------ method chooser

const METHODS = [
  { id: 'ecash', name: 'eCash', ico: 'coin', desc: 'Paste or scan a Cashu token from your wallet.', step: () => ecashStep },
  { id: 'lightning', name: 'Lightning', ico: 'bolt', desc: 'Pay an invoice from any Lightning wallet.', step: () => lightningStep },
  { id: 'onchain', name: 'On-chain', ico: 'chain', desc: 'Send bitcoin to a deposit address.', step: () => onchainStep },
  { id: 'foreign', name: 'Other mint', ico: 'swap', desc: 'eCash from another Cashu mint, converted.', step: () => foreignStep },
];

function chooser() {
  const avail = METHODS.filter((m) => m.id === 'ecash' || methods?.[m.id]?.enabled);
  const list = el('ul', { class: 'methods', role: 'list' });
  avail.forEach((m, i) => {
    const ico = el('span', { class: 'm-ico' }, icon(m.ico));
    const b = el('button', { class: 'method', type: 'button', style: `--i:${i}` }, ico, el('span', {}, el('b', { text: m.name }), el('small', { text: m.desc })), icon('next'));
    b.addEventListener('click', () => go(m.step(), 1, ico.getBoundingClientRect()));
    list.append(el('li', {}, b));
  });
  const body = [list];
  if (!methods) body.push(el('p', { class: 'hint small', text: 'Lightning, on-chain and other-mint funding are not available on this gateway right now. eCash from an accepted mint works.' }));
  return view('add', { title: 'Add funds', back: home, body });
}

// ------------------------------------------------------------------ eCash

function ecashStep() {
  const ta = el('textarea', { id: 'ecashToken', rows: '4', placeholder: 'cashuB...', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', class: 'input mono' });
  const msg = msgLine();
  const add = el('button', { class: 'btn primary big block', type: 'button', text: 'Add to balance' });
  const scan = scanBlock((text) => {
    ta.value = text;
    submit();
  }, msg);
  const submit = async () => {
    const v = ta.value.replace(/\s+/g, '').replace(/^cashu:(?=cashu)/i, '');
    if (!v) return msg.set('Paste an eCash token.', 'err');
    if (v.startsWith('sk-forge-')) {
      ta.value = '';
      return useKey(v, msg);
    }
    if (!/^cashu[AB]/.test(v)) return msg.set('An eCash token starts with cashuB.', 'err');
    if (needInvite(msg)) return;
    add.disabled = true;
    msg.set('Receiving your eCash');
    try {
      const r = await api('/v1/wallet/topup', { key: S.key, json: { token: v, invite: inviteFor() } });
      if (r.body?.key) hooks.setKey(r.body.key);
      if (!r.res.ok) {
        const code = r.body?.error?.code;
        if (code === 'untrusted_mint' && methods?.foreign?.enabled) msg.set('This token is from another mint. Go back and choose Other mint to add it.', 'err');
        else msg.set(errMsg(r), 'err');
        return;
      }
      ta.value = '';
      const text = r.body.replay ? 'This token was already added.' : `Added ${fmtUnits(r.body.credited, r.body.unit)} to your balance.`;
      announce(text);
      toast(text);
      await hooks.refresh();
      go(home, -1);
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      add.disabled = false;
    }
  };
  add.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) (e.preventDefault(), submit());
  });
  const mints = methods?.ecash?.mints ?? S.mints ?? [];
  return view('ecash', {
    title: 'eCash',
    ico: 'coin',
    back: chooser,
    body: [
      inviteField(),
      el('div', { class: 'field' }, el('label', { for: 'ecashToken', text: 'Paste an eCash token' }), ta),
      el('div', { class: 'row' }, scan.btn),
      scan.box,
      msg,
      mints.length ? el('p', { class: 'hint small', text: `Accepted mint: ${mints.join(', ')}. Tokens from other mints go under Other mint.` }) : null,
    ],
    foot: [add],
  });
}

async function useKey(k, msg) {
  if (!/^sk-forge-[A-Za-z0-9_-]{24,64}$/.test(k)) return msg.set('That is not a balance key.', 'err');
  const r = await api('/v1/wallet', { key: k });
  if (!r.res.ok) return msg.set('This key is not known to the gateway.', 'err');
  hooks.setKey(k);
  await hooks.refresh();
  go(home, 0);
  toast('Balance key loaded');
}

// ------------------------------------------------------------------ Lightning

function lightningStep() {
  const L = methods?.lightning;
  if (!L?.enabled) return view('lightning', { title: 'Lightning', ico: 'bolt', back: chooser, body: [el('p', { class: 'hint', text: 'Lightning funding is not available right now.' })] });
  const units = S.key && S.unit ? [S.unit] : L.units;
  const start = S.unit ?? (units.includes('usd') ? 'usd' : units[0]);
  const msg = msgLine();
  const limits = el('p', { class: 'hint small' });
  const amt = amountPicker({ units, unit: start, presets: (u) => (u === 'usd' ? [100, 500, 1000] : [1000, 5000, 10000]), initial: (u) => (u === 'usd' ? 500 : 5000), id: 'lnAmount' });
  const showLimits = () => {
    const u = amt.unit();
    limits.textContent = [L.min?.[u] ? `Minimum ${fmtUnits(L.min[u], u)}` : '', L.max?.[u] ? `maximum ${fmtUnits(L.max[u], u)}` : ''].filter(Boolean).join(', ');
  };
  showLimits();
  amt.node.addEventListener('click', showLimits);
  const go1 = el('button', { class: 'btn primary big block', type: 'button' }, icon('bolt'), 'Create invoice');
  go1.addEventListener('click', async () => {
    const unit = amt.unit();
    const amount = amt.value();
    if (!Number.isInteger(amount) || amount < 1) return msg.set(unit === 'usd' ? 'Enter an amount like 5.00.' : 'Enter a whole number of sats.', 'err');
    if (L.min?.[unit] && amount < L.min[unit]) return msg.set(`The minimum is ${fmtUnits(L.min[unit], unit)}.`, 'err');
    if (L.max?.[unit] && amount > L.max[unit]) return msg.set(`The maximum is ${fmtUnits(L.max[unit], unit)}.`, 'err');
    if (needInvite(msg)) return;
    go1.disabled = true;
    msg.set('Creating your invoice');
    try {
      const r = await api('/v1/wallet/fund/lightning', { key: S.key, json: { amount, unit, invite: inviteFor() } });
      if (r.body?.key) hooks.setKey(r.body.key);
      if (!r.res.ok) return msg.set(errMsg(r), 'err');
      absorb(r.body);
      go(() => invoiceStep(r.body), 1);
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      go1.disabled = false;
    }
  });
  amt.input.addEventListener('keydown', (e) => e.key === 'Enter' && go1.click());
  return view('lightning', {
    title: 'Lightning',
    ico: 'bolt',
    back: chooser,
    body: [inviteField(), el('div', { class: 'label', text: 'How much?' }), amt.node, limits, S.key ? el('p', { class: 'hint small', text: `Credited to your ${S.unit === 'usd' ? 'US dollar' : 'bitcoin'} balance.` }) : null, msg],
    foot: [go1],
  });
}

function invoiceStep(f) {
  const box = el('div', { class: 'qr loading', role: 'img', 'aria-label': 'QR code of the Lightning invoice' });
  const stage = el('div', { class: 'qr-stage' }, box);
  const st = status('waiting', 'Waiting for payment');
  const expiry = el('span', { class: 'hint small' });
  const uri = 'lightning:' + f.request;
  const actions = el('div', { class: 'row center' }, el('button', { class: 'btn', type: 'button', onclick: () => copyText(f.request, 'Invoice copied') }, icon('copy'), 'Copy invoice'));
  const open = el('a', { class: 'btn primary big block', href: uri }, icon('external'), 'Open in wallet');
  const foot = el('div', { style: 'display:contents' }, open);
  renderQR(box, uri.toUpperCase(), 'L');
  announce(`Invoice ready for ${fmtUnits(f.amount, f.unit)}. Scan the code or open your wallet.`);
  let cd = { stop() {} };
  const update = (x) => {
    if (x.state === 'done') {
      const t = `Paid. Added ${fmtUnits(x.credited, x.unit)} to your balance.`;
      st.set('ok', t);
      announce(t);
      expiry.textContent = '';
      cd.stop();
      actions.hidden = true;
      celebrateQR(stage, box, 'Paid');
      foot.replaceChildren(doneButton());
      hooks.refresh();
      return true;
    }
    if (x.state === 'minting') st.set('loading', 'Paid. Adding it to your balance');
    if (x.state === 'expired') {
      st.set('error', 'This invoice expired. Create a new one.');
      return true;
    }
    if (x.state === 'failed') {
      st.set('error', x.error ?? 'This funding failed.');
      return true;
    }
    return false;
  };
  const v = view('invoice', {
    title: 'Pay invoice',
    ico: 'bolt',
    back: lightningStep,
    body: [el('div', { class: 'amount-tag', text: fmtUnits(f.amount, f.unit) }), stage, actions, el('div', { class: 'row center' }, expiry), st],
    foot: [foot],
  });
  // Start live work once the view is in place (go() stops the previous view's timers first).
  queueMicrotask(() => {
    cd = f.expires_at ? countdown(expiry, f.expires_at, () => st.getAttribute('data-kind') === 'waiting' && st.set('error', 'This invoice expired. Create a new one.')) : cd;
    if (!update(f)) poll(f.id, 2000, update);
  });
  return v;
}

// ------------------------------------------------------------------ On-chain

function onchainStep() {
  const O = methods?.onchain;
  const msg = msgLine();
  if (!O?.enabled) return view('onchain', { title: 'On-chain', ico: 'chain', back: chooser, body: [el('p', { class: 'hint', text: 'On-chain funding is not available right now.' })] });
  if (S.key && S.unit && S.unit !== 'sat') {
    return view('onchain', { title: 'On-chain', ico: 'chain', back: chooser, body: [el('p', { class: 'hint', text: 'On-chain deposits credit a bitcoin (sat) balance. Your balance is in US dollars, so use Lightning or eCash instead.' })] });
  }
  const go1 = el('button', { class: 'btn primary big block', type: 'button', text: 'Get a deposit address' });
  go1.addEventListener('click', async () => {
    if (needInvite(msg)) return;
    go1.disabled = true;
    msg.set('Getting a fresh address');
    try {
      const r = await api('/v1/wallet/fund/onchain', { key: S.key, json: { invite: inviteFor() } });
      if (r.body?.key) hooks.setKey(r.body.key);
      if (!r.res.ok) return msg.set(errMsg(r), 'err');
      absorb(r.body);
      go(() => addressStep(r.body), 1);
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      go1.disabled = false;
    }
  });
  return view('onchain', {
    title: 'On-chain',
    ico: 'chain',
    back: chooser,
    body: [
      inviteField(),
      el('p', { class: 'hint', text: 'Send bitcoin to a deposit address at the Forge mint. It is credited to a sat balance once it confirms.' }),
      el('dl', { class: 'kv' }, el('dt', { text: 'Minimum' }), el('dd', { text: fmtUnits(O.min_amount, 'sat') }), el('dt', { text: 'Confirmations' }), el('dd', { text: String(O.confirmations || 3) })),
      msg,
    ],
    foot: [go1],
  });
}

function addressStep(f) {
  const box = el('div', { class: 'qr loading', role: 'img', 'aria-label': 'QR code of the bitcoin address' });
  const uri = 'bitcoin:' + f.request;
  renderQR(box, uri, 'M');
  const need = f.onchain?.confirmations_required ?? methods?.onchain?.confirmations ?? 3;
  const st = status('waiting', 'Watching the address');
  const credited = el('dd', { text: fmtUnits(f.credited ?? 0, 'sat') });
  const update = (x) => {
    const o = x.onchain ?? {};
    credited.textContent = fmtUnits(x.credited ?? 0, 'sat');
    if (x.state === 'failed') {
      st.set('error', x.error ?? 'This deposit address failed.');
      return true;
    }
    if (x.credited > 0 && x.state !== 'minting') st.set('ok', `Credited ${fmtUnits(x.credited, 'sat')}. More deposits to this address are credited too.`);
    else if (x.state === 'minting') st.set('loading', 'Confirmed. Adding it to your balance');
    else if (o.seen_sat) st.set('waiting', `Seen ${fmtUnits(o.seen_sat, 'sat')}, ${o.confirmations ?? 0} of ${need} confirmations`);
    if (x.credited > 0 && x.credited !== update.last) {
      update.last = x.credited;
      hooks.refresh();
    }
    return x.state === 'expired' || x.state === 'failed';
  };
  update.last = f.credited ?? 0;
  queueMicrotask(() => {
    if (!update(f)) poll(f.id, 15000, update);
  });
  return view('address', {
    title: 'Deposit address',
    ico: 'chain',
    back: onchainStep,
    body: [
      box,
      el('div', { class: 'keyline', text: f.request.match(/.{1,4}/g).join(' '), 'aria-label': 'Deposit address' }),
      el('div', { class: 'row center' }, el('button', { class: 'btn', type: 'button', onclick: () => copyText(f.request, 'Address copied') }, icon('copy'), 'Copy address'), el('a', { class: 'btn', href: uri }, icon('external'), 'Open in wallet')),
      el('dl', { class: 'kv' }, el('dt', { text: 'Minimum' }), el('dd', { text: fmtUnits(f.onchain?.min_amount ?? methods?.onchain?.min_amount ?? 0, 'sat') }), el('dt', { text: 'Confirmations needed' }), el('dd', { text: String(need) }), el('dt', { text: 'Credited so far' }), credited),
      st,
      el('p', { class: 'hint small', text: 'You can close this. The deposit is credited when it confirms, and it shows under Recent activity.' }),
    ],
    foot: [doneButton()],
  });
}

// ------------------------------------------------------------------ Other mint

/** "Accepted mints" disclosure for the Other mint step; the list loads from the gateway when opened. */
function acceptedMintsBlock(F) {
  if (F.policy === 'any' && !F.mints?.length) return null;
  const list = el('ul', { class: 'hint small mint-list' });
  const box = el('details', { class: 'adv' }, el('summary', { text: `Accepted mints${F.mints ? ` (${F.mints.length})` : ''}` }), el('div', { class: 'adv-body' }, list));
  let loaded = false;
  box.addEventListener('toggle', async () => {
    if (!box.open || loaded) return;
    loaded = true;
    list.replaceChildren(el('li', { text: 'Loading' }));
    try {
      const r = await api(F.mints_url || '/v1/wallet/fund/mints');
      const mints = r.res.ok ? (r.body?.mints ?? []) : [];
      if (!r.res.ok) loaded = false;
      list.replaceChildren(
        ...(mints.length
          ? mints.map((m) => el('li', {}, el('span', { class: 'mono', text: m.url }), m.name ? ` ${m.name}` : '', m.reviewers ? ` (${m.reviewers} ${m.reviewers === 1 ? 'review' : 'reviews'})` : ''))
          : [el('li', { text: r.res.ok ? 'No other mint is accepted right now.' : errMsg(r) })]),
      );
    } catch (e) {
      loaded = false;
      list.replaceChildren(el('li', { text: e.message }));
    }
  });
  return box;
}

function foreignStep() {
  const F = methods?.foreign;
  if (!F?.enabled) return view('foreign', { title: 'Other mint', ico: 'swap', back: chooser, body: [el('p', { class: 'hint', text: 'Other-mint funding is not available right now.' })] });
  const units = S.key && S.unit ? [S.unit] : methods.lightning?.units?.length ? methods.lightning.units : ['sat', 'usd'];
  let unit = S.unit ?? units[0];
  const ta = el('textarea', { id: 'foreignToken', rows: '4', placeholder: 'cashuB...', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', class: 'input mono' });
  const msg = msgLine();
  const check = el('button', { class: 'btn primary big block', type: 'button', text: 'Check token' });
  const scan = scanBlock((t) => {
    ta.value = t;
    check.click();
  }, msg);
  // Inline confirm for a mint that is not on the accepted list (no browser dialog).
  const unlistedBox = el('div', { class: 'unlisted-confirm', hidden: '' });
  const hideUnlisted = () => {
    unlistedBox.hidden = true;
    unlistedBox.replaceChildren();
  };
  const askUnlisted = (info, token) => {
    const cap = info?.max ?? F.unlisted?.max ?? {};
    const limit = [cap.sat ? fmtUnits(cap.sat, 'sat') : '', cap.usd ? fmtUnits(cap.usd, 'usd') : ''].filter(Boolean).join(' / ');
    const cont = el('button', { class: 'btn primary', type: 'button', text: 'Continue' });
    const cancel = el('button', { class: 'btn ghost', type: 'button', text: 'Cancel' });
    cont.addEventListener('click', () => quote(token, true));
    cancel.addEventListener('click', () => {
      hideUnlisted();
      msg.set('');
      check.focus();
    });
    unlistedBox.replaceChildren(
      el('p', { class: 'unlisted-mint mono', text: info?.mint ?? '' }),
      el('p', { text: `This mint is not on Forge's recommended list. Only continue if you trust it.${limit ? ` Limit: ${limit}.` : ''}` }),
      el('div', { class: 'row' }, cont, cancel),
    );
    unlistedBox.hidden = false;
    msg.set('');
    cont.focus();
  };
  const quote = async (token, acceptUnlisted = false) => {
    check.disabled = true;
    for (const b of unlistedBox.querySelectorAll('button')) b.disabled = true;
    msg.set('Asking the mint for a quote');
    try {
      const r = await api('/v1/wallet/fund/foreign/quote', { key: S.key, json: { token, unit, invite: inviteFor(), pubkey: lockKey() || undefined, ...(acceptUnlisted ? { accept_unlisted: true } : {}) } });
      if (r.body?.key) hooks.setKey(r.body.key);
      if (!r.res.ok) {
        const code = r.body?.error?.code;
        if (code === 'mint_unlisted') return askUnlisted(r.body?.unlisted, token);
        hideUnlisted();
        if (code === 'use_topup') return msg.set('This token is from an accepted mint. Go back and choose eCash instead.', 'err');
        if (code === 'mint_not_allowed' && accepted && !accepted.open) accepted.open = true;
        return msg.set(errMsg(r), 'err');
      }
      hideUnlisted();
      absorb(r.body);
      go(() => quoteStep(r.body, token), 1);
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      check.disabled = false;
      for (const b of unlistedBox.querySelectorAll('button')) b.disabled = false;
    }
  };
  ta.addEventListener('input', hideUnlisted);
  check.addEventListener('click', () => {
    const token = ta.value.replace(/\s+/g, '').replace(/^cashu:(?=cashu)/i, '');
    if (!/^cashu[AB]/.test(token)) return msg.set('An eCash token starts with cashuB.', 'err');
    if (needInvite(msg)) return;
    hideUnlisted();
    quote(token);
  });
  const max = F.max ?? {};
  const accepted = acceptedMintsBlock(F);
  return view('foreign', {
    title: 'Other mint',
    ico: 'swap',
    back: chooser,
    body: [
      inviteField(),
      el('p', {
        class: 'hint',
        text: `${F.policy && F.policy !== 'any' ? 'eCash from an accepted Cashu mint (see the list below).' : 'eCash from any other Cashu mint.'} The gateway pays a Forge Lightning invoice with it and credits what arrives. You see the exact amount before you confirm.`,
      }),
      units.length > 1 ? el('div', { class: 'field' }, el('span', { class: 'label', text: 'Credit as' }), el('div', {}, seg(units, unit, (u) => (unit = u), 'Credit as'))) : null,
      el('div', { class: 'field' }, el('label', { for: 'foreignToken', text: 'eCash token from another mint' }), ta),
      el('div', { class: 'row' }, scan.btn),
      scan.box,
      msg,
      unlistedBox,
      el('p', { class: 'hint small', text: [max.sat ? `Up to ${fmtUnits(max.sat, 'sat')}` : '', max.usd ? `${fmtUnits(max.usd, 'usd')} per token` : ''].filter(Boolean).join(' or ') }),
      accepted,
    ],
    foot: [check],
  });
}

function host(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function quoteStep(f, token) {
  const q = f.foreign;
  const st = status('waiting', 'Review and confirm');
  const msg = msgLine();
  const tokenBox = el('div', { class: 'section' });
  const confirm = el('button', { class: 'btn primary big block', type: 'button', text: `Add ${fmtUnits(q.credit, f.unit)}` });
  const expiry = el('span', { class: 'hint small' });
  const foot = el('div', { style: 'display:contents' }, confirm);
  let cd = null;
  let told = false;
  const lockedNote = (xf) => (xf.locked_to ? el('p', { class: 'hint small', text: `Locked to your wallet key ${shortKey(xf.locked_to)}. Only the wallet holding that key can redeem it.` }) : null);
  const pendingNote = () => el('p', { class: 'hint small', text: 'Locking the returned eCash to your wallet key. It appears here in a moment.' });
  const update = (x) => {
    const xf = x.foreign ?? q;
    if (TERMINAL.has(x.state)) foot.replaceChildren(doneButton());
    if (x.state === 'done') {
      const t = `Added ${fmtUnits(x.credited, x.unit)} to your balance.`;
      st.set('ok', t);
      if (!told) {
        told = true;
        announce(t);
        toast(t);
        haptic(18);
        hooks.refresh();
      }
      if (xf.change_token) tokenBox.replaceChildren(el('h3', { text: `Unused fees, returned as eCash from ${host(xf.mint)}`, style: 'font-size:14px;margin:0' }), ...[lockedNote(xf)].filter(Boolean), tokenView(xf.change_token, { label: 'Change' }));
      else if (xf.payout_pending) tokenBox.replaceChildren(pendingNote());
      return !xf.payout_pending;
    }
    if (x.state === 'refunded') {
      st.set('error', x.error ? `The payment did not go through: ${x.error}. Your eCash is returned below.` : 'The payment did not go through. Your eCash is returned below.');
      if (xf.refund_token) tokenBox.replaceChildren(...[lockedNote(xf)].filter(Boolean), tokenView(xf.refund_token, { amount: xf.token_amount, unit: xf.unit, label: 'eCash' }));
      else if (xf.payout_pending) tokenBox.replaceChildren(pendingNote());
      return !xf.payout_pending;
    }
    if (x.state === 'failed') {
      st.set('error', x.error ?? 'This funding failed.');
      return true;
    }
    if (x.state === 'expired') {
      st.set('error', 'This quote expired. Check the token again.');
      return true;
    }
    const steps = { receiving: 'Receiving the token at its mint', melting: 'Paying the Forge invoice from that mint', pending: 'Waiting for the Forge mint to see the payment', minting: 'Paid. Adding it to your balance' };
    if (steps[x.state]) st.set('loading', steps[x.state]);
    return false;
  };
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    cd?.stop();
    expiry.textContent = '';
    st.set('loading', 'Receiving the token at its mint');
    try {
      const r = await api('/v1/wallet/fund/foreign/confirm', { key: S.key, json: { id: f.id, token } });
      if (!r.res.ok) {
        st.set('error', errMsg(r));
        return;
      }
      absorb(r.body);
      if (!update(r.body)) poll(f.id, 2000, update);
    } catch (e) {
      st.set('error', e.message);
      msg.set('The gateway did not answer. Recent activity in the wallet shows the outcome when it settles.', 'err');
      poll(f.id, 3000, update);
    }
  });
  queueMicrotask(() => {
    cd = f.expires_at ? countdown(expiry, f.expires_at, () => st.getAttribute('data-kind') === 'waiting' && (st.set('error', 'This quote expired. Check the token again.'), (confirm.disabled = true))) : null;
  });
  return view('quote', {
    title: 'Confirm',
    ico: 'swap',
    back: foreignStep,
    body: [
      el('div', { class: 'amount-tag', text: fmtUnits(q.credit, f.unit) }),
      el('dl', { class: 'kv' }, el('dt', { text: 'Token' }), el('dd', { text: `${fmtUnits(q.token_amount, q.unit)} at ${host(q.mint)}` }), el('dt', { text: 'Fees, at most' }), el('dd', { text: fmtUnits(q.fee_max, q.unit) }), el('dt', { class: 'total', text: 'Credited to your balance' }), el('dd', { class: 'total', text: fmtUnits(q.credit, f.unit) })),
      el('p', { class: 'hint small', text: `Fees are the other mint's own charges and the Lightning routing reserve. Any reserve the payment does not use comes back to you as eCash from ${host(q.mint)}.` }),
      q.unlisted ? el('p', { class: 'hint small', text: `${host(q.mint)} is not on Forge's recommended list. You chose to continue with it.` }) : null,
      q.locked_to ? el('p', { class: 'hint small', text: `Returned eCash will be locked to your wallet key ${shortKey(q.locked_to)}. Only that wallet can redeem it.` }) : null,
      el('div', { class: 'row center' }, expiry),
      st,
      msg,
      tokenBox,
    ],
    foot: [foot],
  });
}

// ------------------------------------------------------------------ refunds

function refundStep() {
  const refundable = refundableNow();
  const unit = S.unit;
  const msg = msgLine();
  const out = el('div', { class: 'section' });
  const half = Math.floor(refundable / 2);
  const presets = [...new Set([unit === 'usd' ? 100 : 1000, half, refundable])].filter((n) => n >= 1 && n <= refundable).sort((a, b) => a - b);
  const amt = amountPicker({ units: [unit], unit, presets: () => presets, initial: () => refundable, id: 'refundAmount' });
  // Chips read "All" and "Half" where they match.
  for (const c of amt.node.querySelectorAll('.amount-chip')) {
    const n = Number(c.dataset.n);
    if (n === refundable) c.textContent = 'All';
    else if (n === half) c.textContent = 'Half';
  }
  const go1 = el('button', { class: 'btn primary big block', type: 'button' }, icon('download'), 'Create eCash token');
  const foot = el('div', { style: 'display:contents' }, go1);
  const form = el('div', { class: 'section' }, el('div', { class: 'label', text: `Refundable now: ${fmtUnits(refundable, unit)}` }), amt.node, el('p', { class: 'hint small', text: 'Whole cents or sats only. A fraction stays on the balance.' }));
  const note = lockKey()
    ? el('p', { class: 'hint small', text: `The token will be locked to your wallet key ${shortKey(lockKey())} (Wallet, Advanced). Only the wallet holding that key can redeem it; if that is not your wallet, the eCash is lost.` })
    : el('p', { class: 'hint small', text: 'Tip: set a wallet key under Advanced so only your wallet can redeem the token.' });
  go1.addEventListener('click', async () => {
    const n = amt.value();
    if (!Number.isInteger(n) || n < 1 || n > refundable) return msg.set(`Enter an amount from ${fmtUnits(1, unit)} to ${fmtUnits(refundable, unit)}.`, 'err');
    go1.disabled = true;
    msg.set('Creating your eCash');
    try {
      const pk = lockKey();
      const r = await api('/v1/wallet/refund', { key: S.key, json: { amount: n, pubkey: pk || undefined } });
      if (!r.res.ok && r.res.status !== 202) return msg.set(errMsg(r), 'err');
      await hooks.refresh();
      if (!r.body.token) return msg.set('The mint did not answer. The refund is saved; open the wallet again in a minute to collect it.', 'err');
      const locked = r.body.locked_to;
      const t = locked
        ? `Refunded ${fmtUnits(r.body.amount, r.body.unit)} as eCash locked to your wallet key ${shortKey(locked)}. Only the wallet holding that key can redeem it.`
        : `Refunded ${fmtUnits(r.body.amount, r.body.unit)} as eCash. Save it in a Cashu wallet.`;
      announce(t);
      form.hidden = true;
      note.hidden = true;
      msg.set('');
      out.replaceChildren(status('ok', t), tokenView(r.body.token, { amount: r.body.amount, unit: r.body.unit }));
      anim(out, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.slow, easing: EASE.out });
      foot.replaceChildren(doneButton());
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      go1.disabled = false;
    }
  });
  return view('refund', { title: 'Refund as eCash', ico: 'download', back: home, body: [form, note, msg, out], foot: [foot] });
}

// ------------------------------------------------------------------ Advanced: keys, history

function keySection() {
  const sec = el('div', { class: 'section' }, el('h3', { text: 'Balance key' }));
  if (!S.key) {
    const input = el('input', { id: 'keyInput', class: 'input mono', placeholder: 'sk-forge-...', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const msg = msgLine();
    const go1 = el('button', { class: 'btn', type: 'button', text: 'Use this key', onclick: () => useKey(input.value.trim(), msg) });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go1.click());
    sec.append(el('p', { class: 'hint', text: 'Already have a balance? Paste its key.' }), input, el('div', { class: 'row' }, go1), msg);
    return sec;
  }
  let shown = false;
  const line = el('div', { class: 'keyline', 'aria-live': 'polite' });
  const draw = () => (line.textContent = shown ? S.key : `sk-forge-${'•'.repeat(12)}${S.key.slice(-4)}`);
  draw();
  const showBtn = el('button', { class: 'btn small', type: 'button', text: 'Show' });
  showBtn.addEventListener('click', () => {
    shown = !shown;
    showBtn.textContent = shown ? 'Hide' : 'Show';
    draw();
  });
  sec.append(
    el('p', { class: 'hint', text: 'This key is your balance. It is kept in this browser only. Save a copy to use the balance on another device or after clearing this browser.' }),
    line,
    el(
      'div',
      { class: 'row' },
      showBtn,
      el('button', { class: 'btn small', type: 'button', onclick: () => copyText(S.key, 'Balance key copied') }, icon('copy'), 'Copy'),
      el('button', { class: 'btn small', type: 'button', onclick: () => download('forge-ai-balance-key.txt', S.key + '\n') }, icon('download'), 'Download'),
      el('button', {
        class: 'btn small danger',
        type: 'button',
        text: 'Forget on this device',
        onclick: async () => {
          if (!(await confirmDialog('Forget the balance key?', 'Without a saved copy of the key, the balance cannot be used again. Refund it as eCash first if you are unsure.', 'Forget key', true))) return;
          hooks.setKey(null);
          heroShown = heroMsub = null;
          go(home, 0);
        },
      }),
    ),
  );
  return sec;
}

/** Lock refunds (and change from other-mint funding) to the user's own wallet key (NUT-11 P2PK). */
function lockKeySection() {
  const input = el('input', { id: 'setLockKey', class: 'input mono', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '02… or npub1…', value: lockKey(), 'aria-describedby': 'lockKeyMsg lockKeyWarn' });
  const msg = el('p', { class: 'hint small', id: 'lockKeyMsg', role: 'status', text: lockKey() ? `Refunds are locked to ${shortKey(lockKey())}.` : 'Not set: refunds are ordinary eCash tokens.' });
  const say = (t, err = false) => ((msg.textContent = t), msg.classList.toggle('err', err));
  const save = el('button', { class: 'btn small', type: 'button', text: 'Save key' });
  save.addEventListener('click', () => {
    const v = input.value.trim();
    if (!v) {
      saveLockKey('');
      return say('Not set: refunds are ordinary eCash tokens.');
    }
    try {
      const hex = parseLockKey(v);
      saveLockKey(hex);
      input.value = hex;
      say(`Saved. Refunds are locked to ${shortKey(hex)}.`);
      toast('Refunds will be locked to your wallet key');
    } catch (e) {
      say(e.message, true);
    }
  });
  const clear = el('button', { class: 'btn small', type: 'button', text: 'Clear', onclick: () => ((input.value = ''), saveLockKey(''), say('Not set: refunds are ordinary eCash tokens.')) });
  return el(
    'div',
    { class: 'section' },
    el('h3', { text: 'Lock refunds to my wallet key' }),
    el('p', { class: 'hint small', text: 'Refunds, and change or returned eCash from other-mint funding, are locked to this key (Cashu NUT-11 P2PK). Only the wallet holding the matching private key can redeem them. In cashu.me the key is under Receive, then eCash, then the lock icon, starting 02. Minibits and other nostr-based wallets lock to your npub. Leave it empty for ordinary tokens.' }),
    el('div', { class: 'field' }, el('label', { for: 'setLockKey', text: 'Wallet public key (02… or npub1…)' }), input),
    el('div', { class: 'row' }, save, clear),
    msg,
    el('p', { class: 'hint small warn', id: 'lockKeyWarn', text: 'Use a key from a wallet you control. eCash locked to a key you do not hold is lost: nobody, including Forge, can unlock it.' }),
  );
}

function historySection() {
  const sec = el('div', { class: 'section' });
  const list = el('ul', { class: 'list' });
  (async () => {
    const [f, r] = await Promise.all([api('/v1/wallet/fund', { key: S.key }).catch(() => null), api('/v1/wallet/refunds', { key: S.key }).catch(() => null)]);
    const items = [];
    const names = { lightning: 'Lightning', onchain: 'On-chain', foreign: 'Other mint' };
    const states = { pending: 'waiting', minting: 'crediting', done: 'credited', expired: 'expired', failed: 'failed', quoted: 'not confirmed', receiving: 'in progress', melting: 'in progress', refunded: 'returned' };
    if (f?.res.ok) for (const x of (f.body?.data ?? []).slice(0, 8)) items.push({ what: names[x.method] ?? x.method, amount: x.credited ? fmtUnits(x.credited, x.unit) : x.amount ? fmtUnits(x.amount, x.unit) : '', state: states[x.state] ?? x.state });
    if (r?.res.ok)
      for (const x of (r.body?.data ?? []).slice(-5).reverse()) items.push({ what: x.locked_to ? 'Refund (locked to your key)' : 'Refund', amount: fmtUnits(x.amount, x.unit), state: x.status === 'done' ? 'issued' : 'pending', token: x.token });
    if (!items.length) return;
    sec.append(el('h3', { text: 'Recent activity' }), list);
    items.forEach((it, i) => {
      const li = el('li', { style: `animation: rise 360ms var(--ease-out) ${i * 40}ms both` }, el('span', { class: 'what', text: it.what }), el('span', {}, el('span', { class: 'amt', text: it.amount }), it.state ? el('span', { class: 'what', text: `, ${it.state}` }) : null));
      if (it.token) {
        const b = el('button', { class: 'btn small', type: 'button', text: 'Show token' });
        b.addEventListener('click', () => li.after(el('li', { style: 'display:block' }, tokenView(it.token, { label: 'eCash' }))), { once: true });
        li.append(b);
      }
      list.append(li);
    });
  })();
  return sec;
}
