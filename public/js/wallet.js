// The wallet drawer: balance, Add funds (eCash, Lightning, On-chain, Other mint), Refund as eCash,
// and the balance key. Funding UX (invoice QR, copy, open in wallet, countdown, live status) follows
// the cashucard.org/fund kit.
import { renderQR, playAnimatedQR, STATIC_MAX } from './qr.js';
import { lockKey, shortKey } from './lockkey.js';
import { $, el, icon, api, errMsg, toast, announce, copyText, download, confirmDialog, fmtUnits, fmtBalance, unitName, fmtInt, loadScript } from './ui.js';

let S; // shared app state: {key, unit, balanceMsub, availableMsub, inviteOnly, units, mints}
let hooks; // {setKey(key), refresh()}
let methods = null; // GET /v1/wallet/fund/methods, or null when the gateway has only eCash topups
let methodsAt = 0;
let tab = 'ecash';
const timers = new Set(); // live pollers and players, stopped when a panel is replaced
const live = new Map(); // funding id -> latest funding object (kept while the drawer is closed)
let scanJob = null;

const dlg = () => $('walletDialog');
const body = () => $('walletBody');

export function initWallet(state, h) {
  S = state;
  hooks = h;
  dlg().addEventListener('close', () => {
    stopScan();
    for (const t of [...timers]) if (t.player) (t.stop(), timers.delete(t));
  });
  dlg().querySelector('[data-close]').addEventListener('click', () => dlg().close());
  dlg().addEventListener('click', (e) => {
    if (e.target === dlg()) dlg().close(); // backdrop
  });
}

/** Keeps the open drawer's balance in step with the header (called after every balance refresh). */
export function syncWalletBalance() {
  if (!dlg().open) return;
  const big = $('walletBig');
  if (!big) {
    if (S.key && S.balanceMsub != null) body().firstChild?.replaceWith(balanceSection());
    return;
  }
  const refundable = Math.floor((S.availableMsub ?? S.balanceMsub ?? 0) / 1000);
  big.textContent = fmtBalance(S.balanceMsub, S.unit, true);
  $('walletRefundable').textContent = `Refundable now: ${fmtUnits(refundable, S.unit)}`;
  $('refundBtn').disabled = refundable < 1;
}

export async function openWallet(which) {
  if (which) tab = which;
  if (!dlg().open) dlg().showModal();
  render();
  await loadMethods();
  render();
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

// ------------------------------------------------------------------ layout

function render() {
  stopAll();
  const b = body();
  b.replaceChildren(balanceSection(), addFundsSection(), keySection());
  if (S.key) b.append(historySection());
}

function balanceSection() {
  const card = el('div', { class: 'balance-card' });
  if (S.key && S.balanceMsub != null) {
    const refundable = Math.floor((S.availableMsub ?? S.balanceMsub) / 1000);
    card.append(
      el('div', { class: 'sub', text: S.unit === 'usd' ? 'Balance in US dollars' : 'Balance in bitcoin' }),
      el('div', { class: 'big', id: 'walletBig', text: fmtBalance(S.balanceMsub, S.unit, true) }),
      el('div', { class: 'sub', id: 'walletRefundable', text: `Refundable now: ${fmtUnits(refundable, S.unit)}` }),
    );
    const refundBtn = el('button', { class: 'btn', type: 'button', id: 'refundBtn', disabled: refundable < 1 }, icon('download'), 'Refund as eCash');
    const holder = el('div', { class: 'section' });
    refundBtn.addEventListener('click', () => refundForm(holder, Math.floor((S.availableMsub ?? S.balanceMsub) / 1000)));
    card.append(el('div', { class: 'row', style: 'margin-top:10px' }, refundBtn));
    return el('div', { class: 'section' }, card, holder);
  }
  if (S.key) {
    card.append(el('div', { class: 'big', text: '...' }), el('div', { class: 'sub', text: 'Checking your balance' }));
    return card;
  }
  card.append(el('div', { class: 'sub', text: 'No balance yet' }), el('p', { class: 'hint', text: 'Add funds below to open a balance. Every message is paid from it, and you can take the rest back as eCash at any time.' }));
  return card;
}

function addFundsSection() {
  const sec = el('div', { class: 'section' }, el('h3', { text: 'Add funds' }));
  if (!S.key && S.inviteOnly) {
    const inv = el('input', { id: 'invite', class: 'input', placeholder: 'inv-...', autocomplete: 'off', spellcheck: 'false', value: S.invite ?? '' });
    inv.addEventListener('input', () => (S.invite = inv.value.trim()));
    sec.append(el('div', { class: 'field' }, el('label', { for: 'invite', text: 'Invite code' }), inv, el('p', { class: 'hint small', text: 'Forge AI is invite only. A new balance needs an invite code, whichever way you pay.' })));
  }
  const all = [
    ['ecash', 'eCash'],
    ['lightning', 'Lightning'],
    ['onchain', 'On-chain'],
    ['foreign', 'Other mint'],
  ];
  const avail = all.filter(([id]) => id === 'ecash' || methods?.[id]?.enabled);
  if (!avail.some(([id]) => id === tab)) tab = 'ecash';
  const list = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Ways to add funds' });
  const panel = el('div', { class: 'tabpanel', role: 'tabpanel', id: 'fundPanel' });
  const btns = avail.map(([id, label]) => {
    const t = el('button', { class: 'tab', role: 'tab', type: 'button', id: `tab-${id}`, 'aria-selected': String(id === tab), 'aria-controls': 'fundPanel', tabindex: id === tab ? '0' : '-1', text: label });
    t.addEventListener('click', () => {
      tab = id;
      for (const x of btns) {
        const on = x === t;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
      }
      showPanel(panel);
    });
    return t;
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
    n.focus();
    n.click();
  });
  if (avail.length > 1) list.append(...btns), sec.append(list);
  sec.append(panel);
  showPanel(panel);
  if (!methods) sec.append(el('p', { class: 'hint small', text: 'Lightning, on-chain and other-mint funding are not available on this gateway right now. eCash from an accepted mint works.' }));
  return sec;
}

function showPanel(panel) {
  stopAll();
  panel.setAttribute('aria-labelledby', `tab-${tab}`);
  const f = { ecash: ecashPanel, lightning: lightningPanel, onchain: onchainPanel, foreign: foreignPanel }[tab];
  panel.replaceChildren(...[f(panel)].flat());
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

/** Applies a funding response: stores a gateway-generated key at once, then refreshes the balance. */
function absorb(f) {
  if (f?.key && f.key !== S.key) hooks.setKey(f.key);
  if (f?.id) live.set(f.id, f);
}

function inviteFor() {
  return !S.key && S.inviteOnly ? S.invite || undefined : undefined;
}

function needInvite(msg) {
  if (!S.key && S.inviteOnly && !S.invite) {
    msg.set('Enter your invite code first.', 'err');
    $('invite')?.focus();
    return true;
  }
  return false;
}

function unitPicker(units, current, onChange) {
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Balance unit' });
  for (const u of units) {
    const b = el('button', { type: 'button', 'aria-pressed': String(u === current), text: u === 'usd' ? 'US dollars' : 'Bitcoin (sat)' });
    b.addEventListener('click', () => {
      for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b));
      onChange(u);
    });
    seg.append(b);
  }
  return seg;
}

function scanBlock(onText, msg) {
  const video = el('video', { muted: true, playsinline: true, 'aria-label': 'Camera preview' });
  const bar = el('div', { class: 'bar' });
  const text = el('p', { class: 'hint', text: 'Point the camera at the QR code in your wallet.', role: 'status' });
  const box = el('div', { class: 'section', hidden: true }, el('div', { class: 'scanner' }, video, el('div', { class: 'frame' }), bar), text, el('div', { class: 'row end' }, el('button', { class: 'btn small', type: 'button', text: 'Cancel', onclick: () => (stopScan(), (box.hidden = true)) })));
  const open = async () => {
    msg.set('');
    box.hidden = false;
    bar.style.width = '0%';
    announce('Camera open. Point it at the QR code in your wallet.');
    try {
      await loadScript('/js/scan.js');
      stopScan();
      scanJob = window.ForgeScan.scan(video, (p) => {
        bar.style.width = Math.round(p * 100) + '%';
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
  const btn = el('button', { class: 'btn', type: 'button', onclick: open }, icon('scan'), 'Scan');
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
  const note = el('p', { class: 'hint small' });
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
    { class: 'row' },
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

// ------------------------------------------------------------------ eCash tab

function ecashPanel() {
  const ta = el('textarea', { id: 'ecashToken', rows: '4', placeholder: 'cashuB...', spellcheck: 'false', autocomplete: 'off', class: 'input', style: 'font-family:var(--mono);font-size:13px' });
  const msg = msgLine();
  const add = el('button', { class: 'btn primary', type: 'button', text: 'Add to balance' });
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
        if (code === 'untrusted_mint' && methods?.foreign?.enabled) {
          msg.set('This token is from another mint. Use the Other mint tab to add it.', 'err');
        } else msg.set(errMsg(r), 'err');
        return;
      }
      ta.value = '';
      const text = r.body.replay ? 'This token was already added.' : `Added ${fmtUnits(r.body.credited, r.body.unit)} to your balance.`;
      msg.set(text, 'ok');
      announce(text);
      await hooks.refresh();
      render();
      toast(text);
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      add.disabled = false;
    }
  };
  add.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), submit());
  });
  const mints = methods?.ecash?.mints ?? S.mints ?? [];
  return [
    el('div', { class: 'field' }, el('label', { for: 'ecashToken', text: 'eCash token' }), ta),
    el('p', { class: 'hint small', text: mints.length ? `Accepted mint: ${mints.join(', ')}. Tokens from other mints go in the Other mint tab.` : '' }),
    el('div', { class: 'row' }, add, scan.btn),
    scan.box,
    msg,
  ];
}

async function useKey(k, msg) {
  if (!/^sk-forge-[A-Za-z0-9_-]{24,64}$/.test(k)) return msg.set('That is not a balance key.', 'err');
  const r = await api('/v1/wallet', { key: k });
  if (!r.res.ok) return msg.set('This key is not known to the gateway.', 'err');
  hooks.setKey(k);
  await hooks.refresh();
  render();
  toast('Balance key loaded');
}

// ------------------------------------------------------------------ Lightning tab

function lightningPanel(panel) {
  const L = methods.lightning;
  const units = S.key && S.unit ? [S.unit] : L.units;
  let unit = S.unit ?? (units.includes('usd') ? 'usd' : units[0]);
  const msg = msgLine();
  const presetsBox = el('div', { class: 'presets' });
  const input = el('input', { id: 'lnAmount', class: 'input', inputmode: 'decimal', autocomplete: 'off' });
  const label = el('label', { for: 'lnAmount' });
  const limits = el('p', { class: 'hint small' });
  const go = el('button', { class: 'btn primary', type: 'button', text: 'Create invoice' });
  const toUnits = () => {
    const v = input.value.replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(v)) return NaN;
    return unit === 'usd' ? Math.round(Number(v) * 100) : Number.isInteger(Number(v)) ? Number(v) : NaN;
  };
  const setup = () => {
    label.textContent = unit === 'usd' ? 'Amount in US dollars' : 'Amount in sats';
    const presets = unit === 'usd' ? [100, 500, 2000] : [1000, 5000, 21000];
    presetsBox.replaceChildren(
      ...presets.map((n) => {
        const b = el('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false', text: fmtUnits(n, unit) });
        b.addEventListener('click', () => {
          input.value = unit === 'usd' ? (n / 100).toFixed(2) : String(n);
          for (const x of presetsBox.children) x.setAttribute('aria-pressed', String(x === b));
        });
        return b;
      }),
    );
    input.value = unit === 'usd' ? '5.00' : '5000';
    const min = L.min?.[unit];
    const max = L.max?.[unit];
    limits.textContent = [min ? `Minimum ${fmtUnits(min, unit)}` : '', max ? `maximum ${fmtUnits(max, unit)}` : ''].filter(Boolean).join(', ');
  };
  setup();
  go.addEventListener('click', async () => {
    const amount = toUnits();
    if (!Number.isInteger(amount) || amount < 1) return msg.set(unit === 'usd' ? 'Enter an amount like 5.00.' : 'Enter a whole number of sats.', 'err');
    if (L.min?.[unit] && amount < L.min[unit]) return msg.set(`The minimum is ${fmtUnits(L.min[unit], unit)}.`, 'err');
    if (L.max?.[unit] && amount > L.max[unit]) return msg.set(`The maximum is ${fmtUnits(L.max[unit], unit)}.`, 'err');
    if (needInvite(msg)) return;
    go.disabled = true;
    msg.set('Creating your invoice');
    try {
      const r = await api('/v1/wallet/fund/lightning', { key: S.key, json: { amount, unit, invite: inviteFor() } });
      if (r.body?.key) hooks.setKey(r.body.key);
      if (!r.res.ok) return msg.set(errMsg(r), 'err');
      absorb(r.body);
      panel.replaceChildren(...invoiceView(r.body, panel));
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      go.disabled = false;
    }
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  const parts = [];
  if (units.length > 1)
    parts.push(
      unitPicker(units, unit, (u) => {
        unit = u;
        setup();
      }),
    );
  else if (S.key) parts.push(el('p', { class: 'hint small', text: `Credited to your ${S.unit === 'usd' ? 'US dollar' : 'bitcoin'} balance.` }));
  parts.push(presetsBox, el('div', { class: 'field' }, label, input), limits, el('div', { class: 'row' }, go), msg);
  return parts;
}

function invoiceView(f, panel) {
  const box = el('div', { class: 'qr loading', role: 'img', 'aria-label': 'QR code of the Lightning invoice' });
  const st = status('waiting', 'Waiting for payment');
  const expiry = el('span', { class: 'hint small' });
  const back = el('button', { class: 'btn ghost small', type: 'button', text: 'Back', onclick: () => showPanel(panel) });
  const actions = el('div', { class: 'row', style: 'justify-content:center' }, el('button', { class: 'btn primary', type: 'button', onclick: () => copyText(f.request, 'Invoice copied') }, icon('copy'), 'Copy invoice'), el('a', { class: 'btn', href: 'lightning:' + f.request, text: 'Open in wallet' }));
  renderQR(box, ('lightning:' + f.request).toUpperCase(), 'L');
  announce(`Invoice ready for ${fmtUnits(f.amount, f.unit)}. Scan the code or open your wallet.`);
  const update = (x) => {
    if (x.state === 'done') {
      const t = `Paid. Added ${fmtUnits(x.credited, x.unit)} to your balance.`;
      st.set('ok', t);
      announce(t);
      toast(t);
      expiry.textContent = '';
      cd.stop();
      box.hidden = true;
      actions.hidden = true;
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
  const cd = f.expires_at ? countdown(expiry, f.expires_at, () => st.getAttribute('data-kind') === 'waiting' && st.set('error', 'This invoice expired. Create a new one.')) : track({ stop() {} });
  if (!update(f)) poll(f.id, 2000, update);
  return [
    el('dl', { class: 'kv' }, el('dt', { text: 'Amount' }), el('dd', { text: fmtUnits(f.amount, f.unit) })),
    box,
    actions,
    el('div', { class: 'row', style: 'justify-content:center' }, expiry),
    st,
    el('div', { class: 'row' }, back),
  ];
}

// ------------------------------------------------------------------ On-chain tab

function onchainPanel(panel) {
  const O = methods.onchain;
  const msg = msgLine();
  if (S.key && S.unit && S.unit !== 'sat') {
    return [el('p', { class: 'hint', text: 'On-chain deposits credit a bitcoin (sat) balance. Your balance is in US dollars, so use Lightning or eCash instead.' })];
  }
  const go = el('button', { class: 'btn primary', type: 'button', text: 'Get a deposit address' });
  go.addEventListener('click', async () => {
    if (needInvite(msg)) return;
    go.disabled = true;
    msg.set('Getting a fresh address');
    try {
      const r = await api('/v1/wallet/fund/onchain', { key: S.key, json: { invite: inviteFor() } });
      if (r.body?.key) hooks.setKey(r.body.key);
      if (!r.res.ok) return msg.set(errMsg(r), 'err');
      absorb(r.body);
      panel.replaceChildren(...addressView(r.body, panel));
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      go.disabled = false;
    }
  });
  return [
    el('p', { class: 'hint', text: `Send bitcoin to a deposit address at the Forge mint. It is credited to a sat balance after ${O.confirmations || 3} confirmations. Minimum ${fmtUnits(O.min_amount, 'sat')}.` }),
    el('div', { class: 'row' }, go),
    msg,
  ];
}

function addressView(f, panel) {
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
  if (!update(f)) poll(f.id, 15000, update);
  return [
    box,
    el('div', { class: 'keyline', text: f.request.match(/.{1,4}/g).join(' '), 'aria-label': 'Deposit address' }),
    el('div', { class: 'row', style: 'justify-content:center' }, el('button', { class: 'btn primary', type: 'button', onclick: () => copyText(f.request, 'Address copied') }, icon('copy'), 'Copy address'), el('a', { class: 'btn', href: uri, text: 'Open in wallet' })),
    el('dl', { class: 'kv' }, el('dt', { text: 'Minimum' }), el('dd', { text: fmtUnits(f.onchain?.min_amount ?? methods?.onchain?.min_amount ?? 0, 'sat') }), el('dt', { text: 'Confirmations needed' }), el('dd', { text: String(need) }), el('dt', { text: 'Credited so far' }), credited),
    st,
    el('p', { class: 'hint small', text: 'You can close this. The deposit is credited to your balance when it confirms, and it shows under Recent funding.' }),
    el('div', { class: 'row' }, el('button', { class: 'btn ghost small', type: 'button', text: 'Back', onclick: () => showPanel(panel) })),
  ];
}

// ------------------------------------------------------------------ Other mint tab

function foreignPanel(panel) {
  const F = methods.foreign;
  const units = S.key && S.unit ? [S.unit] : methods.lightning?.units?.length ? methods.lightning.units : ['sat', 'usd'];
  let unit = S.unit ?? units[0];
  const ta = el('textarea', { id: 'foreignToken', rows: '4', placeholder: 'cashuB...', spellcheck: 'false', autocomplete: 'off', class: 'input', style: 'font-family:var(--mono);font-size:13px' });
  const msg = msgLine();
  const check = el('button', { class: 'btn primary', type: 'button', text: 'Check token' });
  const scan = scanBlock((t) => {
    ta.value = t;
    check.click();
  }, msg);
  check.addEventListener('click', async () => {
    const token = ta.value.replace(/\s+/g, '').replace(/^cashu:(?=cashu)/i, '');
    if (!/^cashu[AB]/.test(token)) return msg.set('An eCash token starts with cashuB.', 'err');
    if (needInvite(msg)) return;
    check.disabled = true;
    msg.set('Asking the mint for a quote');
    try {
      const r = await api('/v1/wallet/fund/foreign/quote', { key: S.key, json: { token, unit, invite: inviteFor(), pubkey: lockKey() || undefined } });
      if (r.body?.key) hooks.setKey(r.body.key);
      if (!r.res.ok) {
        if (r.body?.error?.code === 'use_topup') {
          msg.set('This token is from an accepted mint. Add it in the eCash tab instead.', 'err');
          return;
        }
        return msg.set(errMsg(r), 'err');
      }
      absorb(r.body);
      panel.replaceChildren(...foreignQuoteView(r.body, token, panel));
    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      check.disabled = false;
    }
  });
  const parts = [el('p', { class: 'hint', text: 'eCash from any other Cashu mint. The gateway receives it at its mint, pays a Forge Lightning invoice with it, and credits what arrives. You see the exact amount before you confirm.' })];
  if (units.length > 1) parts.push(el('div', { class: 'row' }, el('span', { class: 'label', text: 'Credit as' }), unitPicker(units, unit, (u) => (unit = u))));
  const max = F.max ?? {};
  parts.push(
    el('div', { class: 'field' }, el('label', { for: 'foreignToken', text: 'eCash token from another mint' }), ta),
    el('p', { class: 'hint small', text: [max.sat ? `Up to ${fmtUnits(max.sat, 'sat')}` : '', max.usd ? `${fmtUnits(max.usd, 'usd')} per token` : ''].filter(Boolean).join(' or ') }),
    el('div', { class: 'row' }, check, scan.btn),
    scan.box,
    msg,
  );
  return parts;
}

function host(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function foreignQuoteView(f, token, panel) {
  const q = f.foreign;
  const st = status('waiting', 'Review and confirm');
  const msg = msgLine();
  const tokenBox = el('div');
  const confirm = el('button', { class: 'btn primary', type: 'button', text: `Add ${fmtUnits(q.credit, f.unit)}` });
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => showPanel(panel) });
  const expiry = el('span', { class: 'hint small' });
  const buttons = el('div', { class: 'row' }, confirm, cancel, expiry);
  let cd = f.expires_at ? countdown(expiry, f.expires_at, () => st.getAttribute('data-kind') === 'waiting' && (st.set('error', 'This quote expired. Check the token again.'), (confirm.disabled = true))) : null;
  let told = false;
  // A token locked to the wallet key needs one more swap at the other mint; keep polling until it is issued.
  const lockedNote = (xf) => (xf.locked_to ? el('p', { class: 'hint small', text: `Locked to your wallet key ${shortKey(xf.locked_to)}. Only the wallet holding that key can redeem it.` }) : null);
  const pendingNote = () => el('p', { class: 'hint small', text: 'Locking the returned eCash to your wallet key. It appears here in a moment.' });
  const update = (x) => {
    const xf = x.foreign ?? q;
    if (TERMINAL.has(x.state)) buttons.hidden = true;
    if (x.state === 'done') {
      const t = `Added ${fmtUnits(x.credited, x.unit)} to your balance.`;
      st.set('ok', t);
      if (!told) {
        told = true;
        announce(t);
        toast(t);
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
    cancel.disabled = true;
    cd?.stop();
    expiry.textContent = '';
    st.set('loading', 'Receiving the token at its mint');
    try {
      const r = await api('/v1/wallet/fund/foreign/confirm', { key: S.key, json: { id: f.id, token } });
      if (!r.res.ok) {
        st.set('error', errMsg(r));
        cancel.disabled = false;
        return;
      }
      absorb(r.body);
      if (!update(r.body)) poll(f.id, 2000, update);
    } catch (e) {
      st.set('error', e.message);
      msg.set('The gateway did not answer. Recent funding below shows the outcome when it settles.', 'err');
      poll(f.id, 3000, update);
    }
  });
  return [
    el(
      'dl',
      { class: 'kv' },
      el('dt', { text: 'Token' }),
      el('dd', { text: `${fmtUnits(q.token_amount, q.unit)} at ${host(q.mint)}` }),
      el('dt', { text: 'Fees, at most' }),
      el('dd', { text: fmtUnits(q.fee_max, q.unit) }),
      el('dt', { class: 'total', text: 'Credited to your balance' }),
      el('dd', { class: 'total', text: fmtUnits(q.credit, f.unit) }),
    ),
    el('p', { class: 'hint small', text: `Fees are the other mint's own charges and the Lightning routing reserve. Any reserve the payment does not use comes back to you as eCash from ${host(q.mint)}.` }),
    ...(q.locked_to ? [el('p', { class: 'hint small', text: `Returned eCash will be locked to your wallet key ${shortKey(q.locked_to)} (Settings). Only that wallet can redeem it.` })] : []),
    buttons,
    st,
    msg,
    tokenBox,
  ];
}

// ------------------------------------------------------------------ refunds

function refundForm(holder, refundable) {
  holder.replaceChildren();
  const input = el('input', { id: 'refundAmount', class: 'input', inputmode: 'numeric', value: String(refundable) });
  const msg = msgLine();
  const go = el('button', { class: 'btn primary', type: 'button', text: 'Create eCash token' });
  go.addEventListener('click', async () => {
    const n = Number(input.value.replace(/[,\s]/g, ''));
    if (!Number.isInteger(n) || n < 1 || n > refundable) return msg.set(`Enter a whole number from 1 to ${fmtInt(refundable)}.`, 'err');
    go.disabled = true;
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
      holder.replaceChildren(status('ok', t), tokenView(r.body.token, { amount: r.body.amount, unit: r.body.unit }));

    } catch (e) {
      msg.set(e.message, 'err');
    } finally {
      go.disabled = false;
    }
  });
  holder.append(
    el('div', { class: 'field' }, el('label', { for: 'refundAmount', text: `Amount in ${S.unit === 'usd' ? 'cents' : 'sats'}` }), input),
    el('p', { class: 'hint small', text: 'Whole units only. A fraction of a cent or sat stays on the balance.' }),
    lockKey()
      ? el('p', { class: 'hint small', text: `The token will be locked to your wallet key ${shortKey(lockKey())} (set in Settings). Only the wallet holding that key can redeem it; if that is not your wallet, the eCash is lost.` })
      : el('p', { class: 'hint small', text: 'Tip: set "Lock refunds to my wallet key" in Settings so only your wallet can redeem the token.' }),
    el('div', { class: 'row' }, go, el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => holder.replaceChildren() })),
    msg,
  );
  input.focus();
  input.select();
}

// ------------------------------------------------------------------ key and history

function keySection() {
  const sec = el('div', { class: 'section' }, el('h3', { text: 'Balance key' }));
  if (!S.key) {
    const input = el('input', { id: 'keyInput', class: 'input', placeholder: 'sk-forge-...', autocomplete: 'off', spellcheck: 'false' });
    const msg = msgLine();
    const go = el('button', { class: 'btn', type: 'button', text: 'Use this key', onclick: () => useKey(input.value.trim(), msg) });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
    sec.append(el('p', { class: 'hint', text: 'Already have a balance? Paste its key.' }), el('div', { class: 'row' }, el('div', { class: 'grow' }, input), go), msg);
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
          render();
        },
      }),
    ),
  );
  return sec;
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
      for (const x of (r.body?.data ?? []).slice(-5).reverse()) {
        const li = { what: x.locked_to ? 'Refund (locked to your key)' : 'Refund', amount: fmtUnits(x.amount, x.unit), state: x.status === 'done' ? 'issued' : 'pending', token: x.token };
        items.push(li);
      }
    if (!items.length) return;
    sec.append(el('h3', { text: 'Recent funding and refunds' }), list);
    for (const it of items) {
      const li = el('li', {}, el('span', { class: 'what', text: it.what }), el('span', { text: [it.amount, it.state].filter(Boolean).join(', ') }));
      if (it.token) {
        const b = el('button', { class: 'btn small', type: 'button', text: 'Show token' });
        b.addEventListener('click', () => li.after(el('li', { style: 'display:block' }, tokenView(it.token, { label: 'eCash' }))), { once: true });
        li.append(b);
      }
      list.append(li);
    }
  })();
  return sec;
}
