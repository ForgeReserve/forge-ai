// Forge AI operator page. Plain ES module, no build step. Talks only to /admin/api on this origin.
// The admin token lives in sessionStorage (this tab only) and goes out as X-Forge-Admin-Token, so
// Caddy's basic auth can keep the Authorization header.

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const KEY = 'forge-admin-token';
const SECTIONS = ['overview', 'export', 'invites', 'waitlist', 'balances', 'fundings', 'requests', 'settings'];

// ------------------------------------------------------------------ helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (n, d = 0) => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
/** Whole units (cents or sat) as money. */
const units = (n, unit) => (n == null ? '–' : unit === 'usd' ? '$' + nf(n / 100, 2) : nf(n) + ' sat');
/** msub (thousandths of a cent or sat) as money, with sub-unit precision. */
const msub = (n, unit) => (n == null ? '–' : unit === 'usd' ? '$' + nf(n / 100_000, n % 1000 === 0 ? 2 : 4) : nf(n / 1000, n % 1000 === 0 ? 0 : 3) + ' sat');
const money = (m) => {
  const parts = Object.entries(m || {}).filter(([, v]) => v);
  return parts.length ? parts.map(([u, v]) => msub(v, u)).join(' + ') : '–';
};
const usdEq = (v) => (v == null ? '' : '≈ $' + nf(v, v < 1 ? 4 : 2));
const dur = (s) => (s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd');
const ago = (t) => {
  if (!t) return '–';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 0 ? 'in ' + dur(-s) : dur(s) + ' ago';
};
const when = (t) => (t ? `<span title="${esc(new Date(t).toISOString())}">${esc(ago(t))}</span>` : '–');
const short = (s, n = 10) => (s ? `<span class="id" title="${esc(s)}">${esc(s.length > n + 6 ? s.slice(0, n) + '…' + s.slice(-4) : s)}</span>` : '–');
const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
const stateKind = (s) => (['done', 'settled', 'redeemed', 'ok'].includes(s) ? 'ok' : ['failed', 'expired', 'revoked', 'aborted', 'error'].includes(s) ? 'err' : ['open'].includes(s) ? 'brass' : 'warn');
const table = (cols, rows, empty = 'Nothing here yet.') =>
  rows.length
    ? `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.wrap ? 'wrap' : ''} ${c.h ? '' : 'act'}" data-l="${esc(c.h)}">${c.v(r)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`
    : `<p class="empty">${esc(empty)}</p>`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Copy failed: select the text and copy it by hand');
  }
}

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------------------------ API

const token = () => {
  try {
    return sessionStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
};

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/admin/api' + path, {
    method,
    headers: { 'X-Forge-Admin-Token': token(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.status === 401) {
    signOut('That token was not accepted.');
    throw new ApiError(401, data);
  }
  if (!res.ok && res.status !== 202) throw new ApiError(res.status, data);
  return data;
}

// ------------------------------------------------------------------ session

function signOut(msg) {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  showLogin(msg);
}

function showLogin(msg) {
  $('#login').hidden = false;
  $('#tabs').hidden = true;
  $('#signout').hidden = true;
  $('#refresh').hidden = true;
  view.innerHTML = '';
  const e = $('#login-err');
  e.hidden = !msg;
  e.textContent = msg || '';
  setTimeout(() => $('#token').focus(), 0);
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const t = $('#token').value.trim();
  if (!t) return;
  try {
    sessionStorage.setItem(KEY, t);
  } catch {
    $('#login-err').hidden = false;
    $('#login-err').textContent = 'This browser blocks session storage, so the page cannot keep the token.';
    return;
  }
  $('#token').value = '';
  start();
});
$('#signout').addEventListener('click', () => signOut());
$('#refresh').addEventListener('click', () => route(true));

async function start() {
  if (!token()) return showLogin();
  try {
    await api('/session');
  } catch (e) {
    if (e.status === 401) return;
    if (e.status === 404) return showLogin('The admin API is turned off on this gateway (FORGE_ADMIN_TOKEN_HASH is not set).');
    return showLogin('Could not reach the gateway: ' + e.message);
  }
  $('#login').hidden = true;
  $('#tabs').hidden = false;
  $('#signout').hidden = false;
  $('#refresh').hidden = false;
  const pill = $('#env-pill');
  pill.textContent = location.host;
  pill.hidden = false;
  route();
}

// ------------------------------------------------------------------ router

let current = '';
let cleanup = [];
function route(force = false) {
  if (!token()) return;
  const name = SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  if (name === current && !force) return;
  current = name;
  for (const fn of cleanup) fn();
  cleanup = [];
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('on', a.getAttribute('href') === '#' + name);
  view.innerHTML = '<p class="loading">Loading…</p>';
  RENDER[name]().catch((e) => {
    if (e.status === 401) return;
    view.innerHTML = `<section class="card"><p class="err">${esc(e.message)}</p></section>`;
  });
}
window.addEventListener('hashchange', () => route());

const head = (title, sub = '', right = '') => `<div class="section-head"><div><p class="kicker">Forge AI</p><h1>${esc(title)}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div>${right}</div>`;

// ------------------------------------------------------------------ overview

let windowKey = 'today';
async function renderOverview() {
  const o = await api('/overview');
  const w = o.windows[windowKey];
  const unitCards = o.units
    .map(
      (u) => `
      <section class="card">
        <div class="card-head"><h3>Revenue and liabilities</h3><span class="unit-tag">${esc(u.unit)}</span></div>
        <div class="grid">
          <div class="kpi"><div class="label">Collected</div><div class="value">${msub(u.collected_msub, u.unit)}</div><div class="sub">all settled requests</div></div>
          <div class="kpi accent"><div class="label">Sweepable now</div><div class="value">${units(u.sweepable, u.unit)}</div><div class="sub">${u.exported ? `${units(u.exported, u.unit)} exported so far` : 'nothing exported yet'}</div></div>
          <div class="kpi"><div class="label">Customer balances</div><div class="value">${msub(u.customer_balances_msub, u.unit)}</div><div class="sub">${nf(u.accounts)} ${u.accounts === 1 ? 'balance' : 'balances'} · ${msub(u.reserved_msub, u.unit)} reserved</div></div>
          <div class="kpi"><div class="label">Owed payouts</div><div class="value">${units(u.owed_payouts, u.unit)}</div><div class="sub">${u.owed_by_purpose.length ? u.owed_by_purpose.map((p) => `${nf(p.n)} ${esc(p.purpose)}`).join(', ') : 'none unfinished'}</div></div>
          <div class="kpi"><div class="label">Wallet, trusted mints</div><div class="value">${units(u.wallet_trusted, u.unit)}</div><div class="sub">${u.wallet_other_mints ? units(u.wallet_other_mints, u.unit) + ' at other mints' : 'no other-mint eCash'}</div></div>
        </div>
      </section>`,
    )
    .join('');

  const moneyCols = [
    { h: 'Requests', num: true, v: (r) => nf(r.requests) },
    { h: 'Failed', num: true, v: (r) => (r.failed ? `<span class="badge err">${nf(r.failed)}</span>` : '0') },
    { h: 'Tokens in', num: true, v: (r) => nf(r.input_tokens) },
    { h: 'Tokens out', num: true, v: (r) => nf(r.output_tokens) },
    { h: 'Revenue', num: true, v: (r) => money(r.revenue_msub) },
  ];
  const costCols = [
    { h: 'Supplier', v: (r) => esc(r.key) },
    { h: 'Requests', num: true, v: (r) => nf(r.requests) },
    { h: 'Revenue', num: true, v: (r) => money(r.revenue_msub) },
    { h: 'Est. cost', num: true, v: (r) => money(r.cost_msub) },
    { h: 'Margin', num: true, v: (r) => `${money(r.margin_msub)} <span class="muted small">${esc(usdEq(r.margin_usd_equiv))}</span>` },
  ];
  const h = o.health;
  const q = h.quote_checks;
  const rate = o.rate;

  view.innerHTML = `
    ${head('Overview', `Markup ×${esc(o.markup)} · BTC/USD ${rate ? '$' + nf(rate.btc_usd, 0) + ` <span class="muted">(${esc(rate.age_s)}s old${rate.usable ? '' : ', stale'})</span>` : '<span class="badge err">no rate</span>'}`)}
    <div class="stack">
      ${unitCards}
      <section class="card">
        <div class="card-head"><h3>Activity</h3>
          <div class="seg" id="win">${[['today', 'Today (UTC)'], ['d7', '7 days'], ['d30', '30 days']].map(([k, l]) => `<button type="button" data-k="${k}" class="${k === windowKey ? 'on' : ''}">${l}</button>`).join('')}</div>
        </div>
        <div class="grid">
          <div class="kpi"><div class="label">Requests</div><div class="value">${nf(w.total.requests)}</div><div class="sub">${nf(w.total.ok)} settled · ${nf(w.total.failed)} failed · ${nf(w.total.encrypted)} encrypted</div></div>
          <div class="kpi"><div class="label">Tokens in / out</div><div class="value">${nf(w.total.input_tokens)} / ${nf(w.total.output_tokens)}</div></div>
          <div class="kpi accent"><div class="label">Revenue</div><div class="value">${money(w.total.revenue_msub)}</div><div class="sub">${esc(usdEq(w.total.revenue_usd_equiv))}</div></div>
          <div class="kpi"><div class="label">Est. margin</div><div class="value">${money(w.total.margin_msub)}</div><div class="sub">cost ≈ revenue ÷ ${esc(o.markup)}</div></div>
        </div>
      </section>
      <div class="grid two">
        <section class="card"><h3>By model</h3>${table([{ h: 'Model', v: (r) => esc(r.key) }, ...moneyCols], w.by_model, 'No requests in this window.')}</section>
        <section class="card"><h3>By tier</h3>${table([{ h: 'Tier', v: (r) => badge(r.key, r.key === 'enclave' ? 'brass' : '') }, ...moneyCols], w.by_tier, 'No requests in this window.')}</section>
      </div>
      <section class="card"><h3>Supplier cost and margin</h3><p class="muted small">Catalog prices include the markup, so cost is estimated as revenue ÷ ${esc(o.markup)}.</p>${table(costCols, w.by_supplier, 'No requests in this window.')}</section>
      <section class="card"><h3>Gateway wallet</h3>
        ${table(
          [
            { h: 'Mint', v: (r) => `${esc(r.mint)} ${r.trusted ? '' : badge('other mint, held aside', 'warn')}` },
            { h: 'Unit', v: (r) => esc(r.unit) },
            { h: 'Unspent', num: true, v: (r) => units(r.unspent, r.unit) },
            { h: 'Reserved', num: true, v: (r) => units(r.reserved, r.unit) },
            { h: 'Owed', num: true, v: (r) => units(r.owed, r.unit) },
          ],
          o.holdings,
          'The wallet holds no eCash yet.',
        )}
      </section>
      <section class="card"><h3>Health</h3>
        <div class="grid two">
          <div>
            ${table(
              [
                { h: 'Supplier', v: (r) => `${esc(r.id)} <span class="muted small">${esc(r.tier)}</span>` },
                { h: 'Key', v: (r) => (r.key_present === null ? badge('none needed') : r.key_present ? badge('set', 'ok') : badge('missing', 'err')) },
                { h: 'Models', num: true, v: (r) => nf(r.models) },
              ],
              h.suppliers,
            )}
          </div>
          <div>
            ${table(
              [
                { h: 'Mint', v: (r) => `<span class="dot ${r.ok ? 'ok' : 'err'}"></span>${esc(r.mint)}${r.mint === h.fund_mint ? ' ' + badge('funding') : ''}` },
                { h: 'Status', v: (r) => (r.ok ? `${esc(r.latency_ms)} ms${r.version ? ` <span class="muted small">${esc(r.version)}</span>` : ''}` : `<span class="err">${esc(r.error)}</span>`) },
              ],
              h.mints,
            )}
            <dl class="kv spaced">
              <dt>Open fundings</dt><dd>${h.fundings_open.length ? h.fundings_open.map((f) => `${nf(f.n)} ${esc(f.state)}`).join(', ') : 'none'} · ${nf(h.fundings_due)} due for a check</dd>
              <dt>Quote checks</dt><dd>${nf(q.used)} of ${nf(q.budget)} this minute ${q.cooldown_until ? badge('paused by mint 429 until ' + new Date(q.cooldown_until).toLocaleTimeString(), 'err') : q.available ? badge('ok', 'ok') : badge('budget used', 'warn')}</dd>
              <dt>Exports</dt><dd>${h.exports_unfinished ? badge(h.exports_unfinished + ' unfinished', 'warn') + ' <a href="#export">finish them</a>' : 'all finished'}</dd>
            </dl>
          </div>
        </div>
      </section>
    </div>`;
  $('#win').addEventListener('click', (e) => {
    const k = e.target.closest('button')?.dataset.k;
    if (k && k !== windowKey) {
      windowKey = k;
      route(true);
    }
  });
}

// ------------------------------------------------------------------ export

const vendor = new Map();
function loadScript(src) {
  if (!vendor.has(src))
    vendor.set(
      src,
      new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = res;
        s.onerror = () => rej(new Error('could not load ' + src));
        document.head.append(s);
      }),
    );
  return vendor.get(src);
}
function qrSvg(text, level = 'M') {
  const qr = window.qrcode(0, level);
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges" role="img" aria-label="QR code of the eCash token"><rect width="100%" height="100%" fill="#fff"/><path fill="#0b0d10" d="${d}"/></svg>`;
}
/** Static QR for short tokens; animated NUT-16 (bc-ur fountain parts) for long ones. Returns a stop function. */
async function showQr(box, text) {
  await loadScript('/vendor/qrcode.js');
  if (text.length <= 700) {
    box.innerHTML = qrSvg(text);
    return () => {};
  }
  await loadScript('/vendor/bcur.js');
  const enc = window.BCUR.encoder(text, 180);
  const frame = () => (box.innerHTML = qrSvg(enc.next(), 'L'));
  frame();
  const timer = setInterval(frame, matchMedia('(prefers-reduced-motion: reduce)').matches ? 333 : 166);
  return () => clearInterval(timer);
}

function tokenResult(r) {
  const name = `forge-revenue-${r.unit}-${r.amount}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`;
  const wrap = document.createElement('section');
  wrap.className = 'card';
  wrap.innerHTML = `
    <div class="card-head"><h3>Exported ${units(r.amount, r.unit)}</h3>${r.locked_to ? badge('P2PK locked', 'brass') : badge('unlocked', 'warn')}</div>
    <p class="note">This token is shown once. Copy it or download it now${r.locked_to ? '. Only the wallet holding the private key for the lock can redeem it.' : ', and redeem it in your wallet soon: until then the gateway seed could still spend it.'}</p>
    <div class="token-out">
      <div class="qr" id="qr"></div>
      <div>
        <textarea readonly rows="8" id="tok">${esc(r.token)}</textarea>
        <div class="actions spaced"><button class="btn primary" type="button" id="cp">Copy token</button><button class="btn" type="button" id="dl">Download .txt</button></div>
        <p class="muted small">From ${esc(r.mint)}${r.locked_to ? ` · locked to <span class="mono">${esc(r.locked_to.slice(0, 12))}…</span>` : ''}</p>
      </div>
    </div>`;
  $('#cp', wrap).addEventListener('click', () => copy(r.token, 'Token copied'));
  $('#dl', wrap).addEventListener('click', () => download(r.token, name));
  showQr($('#qr', wrap), r.token).then((stop) => cleanup.push(stop), () => ($('#qr', wrap).hidden = true));
  return wrap;
}

const sweepKpis = (o) =>
  o.units
    .map((u) => `<div class="kpi accent"><div class="label">Sweepable ${esc(u.unit)}</div><div class="value">${units(u.sweepable, u.unit)}</div><div class="sub">wallet ${units(u.wallet_trusted, u.unit)} − owed ${units(u.owed_payouts, u.unit)} − balances ${units(u.customer_balances, u.unit)}</div></div>`)
    .join('');

async function renderExport() {
  const [o, hist] = await Promise.all([api('/overview'), api('/exports')]);
  const trusted = o.holdings.filter((h) => h.trusted);
  view.innerHTML = `
    ${head('Revenue export', 'Sweep earned revenue out as an eCash token. Customer balances and owed payouts are never exported.')}
    <div class="stack">
      <div class="grid" id="xkpi">${sweepKpis(o)}</div>
      <section class="card">
        <h3>New export</h3>
        <form id="xf" autocomplete="off">
          <div class="row">
            <label class="field"><span>Unit</span><select name="unit">${o.units.map((u) => `<option value="${esc(u.unit)}">${esc(u.unit)}</option>`).join('')}</select></label>
            <label class="field"><span>Mint</span><select name="mint"><option value="">Most held</option>${[...new Set(trusted.map((h) => h.mint))].map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
            <label class="field"><span>Amount</span><input name="amount" inputmode="numeric" placeholder="All sweepable"></label>
          </div>
          <label class="field"><span>Lock to your key (optional, NUT-11 P2PK)</span><input name="pubkey" spellcheck="false" placeholder="02… / 03… compressed key, or npub1…"><span class="hint">With a key only your wallet can redeem the token, and the gateway cannot spend it. A token locked to a key you do not hold is lost.</span></label>
          <p class="err" id="xerr" hidden></p>
          <button class="btn" type="submit">Preview</button>
        </form>
        <div id="xconfirm" class="spaced"></div>
      </section>
      <div id="xout"></div>
      <section class="card"><h3>History</h3><div id="xhist"></div></section>
    </div>`;

  const form = $('#xf');
  const err = $('#xerr');
  const showErr = (m) => ((err.hidden = !m), (err.textContent = m || ''));
  const histBox = $('#xhist');
  const drawHist = (rows) => {
    histBox.innerHTML = table(
      [
        { h: 'When', v: (r) => when(r.created_at) },
        { h: 'Amount', num: true, v: (r) => units(r.amount, r.unit) },
        { h: 'Lock', v: (r) => (r.locked ? badge('locked', 'brass') : badge('unlocked')) },
        { h: 'Status', v: (r) => badge(r.status, stateKind(r.status)) + (r.error ? ` <span class="err small">${esc(r.error)}</span>` : '') },
        { h: 'Token hash', v: (r) => short(r.token_hash, 12) },
        { h: 'Source', v: (r) => esc(r.source) },
        { h: '', v: (r) => (!r.delivered_at && r.status !== 'failed' ? `<button class="btn small primary" data-finish="${esc(r.id)}">Finish</button>` : r.delivered_at ? '<span class="muted small">delivered</span>' : '') },
      ],
      rows,
      'No exports yet.',
    );
  };
  drawHist(hist.data);
  histBox.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-finish]')?.dataset.finish;
    if (!id) return;
    e.target.disabled = true;
    try {
      const r = await api(`/exports/${id}/finish`, { method: 'POST', body: {} });
      $('#xout').replaceChildren(tokenResult(r));
      drawHist((await api('/exports')).data);
      $('#xkpi').innerHTML = sweepKpis(await api('/overview'));
    } catch (x) {
      toast(x.message);
      e.target.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showErr('');
    const f = new FormData(form);
    const req = { unit: f.get('unit'), mint: f.get('mint') || undefined, amount: f.get('amount') ? Number(f.get('amount')) : undefined, pubkey: String(f.get('pubkey') || '').trim() || undefined };
    let p;
    try {
      p = await api('/export/preview', { method: 'POST', body: req });
    } catch (x) {
      return showErr(x.message);
    }
    const box = $('#xconfirm');
    box.innerHTML = `
      <div class="confirm">
        <p class="kicker">Confirm export</p>
        <div class="big">${units(p.amount, p.unit)}</div>
        <dl class="kv spaced">
          <dt>From mint</dt><dd>${esc(p.mint)}</dd>
          <dt>Sweepable</dt><dd>${units(p.sweepable, p.unit)} (at most ${units(p.max, p.unit)} from this mint)</dd>
          <dt>Lock</dt><dd>${p.locked_to ? `<span class="mono">${esc(p.locked_to)}</span>` : 'none: anyone holding the token can redeem it'}</dd>
        </dl>
        <div class="actions spaced"><button class="btn primary" type="button" id="xgo">Export ${units(p.amount, p.unit)}</button><button class="btn ghost" type="button" id="xcancel">Cancel</button></div>
      </div>`;
    $('#xcancel').addEventListener('click', () => (box.innerHTML = ''));
    $('#xgo').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api('/export', { method: 'POST', body: { ...req, amount: p.amount, mint: p.mint, confirm_amount: p.amount, confirm_mint: p.mint, confirm_pubkey: p.locked_to } });
        box.innerHTML = '';
        if (r.token) $('#xout').replaceChildren(tokenResult(r));
        else $('#xout').innerHTML = `<section class="card"><p class="note">The export of ${units(r.amount, r.unit)} is saved but the mint did not answer (${esc(r.error || 'unknown')}). It counts as owed, so nothing is exported twice. Use Finish in the history when the mint is back.</p></section>`;
        form.reset();
        drawHist((await api('/exports')).data);
        $('#xkpi').innerHTML = sweepKpis(await api('/overview'));
      } catch (x) {
        ev.target.disabled = false;
        showErr(x.message);
      }
    });
  });
}

// ------------------------------------------------------------------ invites

async function renderInvites() {
  const { data } = await api('/invites');
  const counts = data.reduce((m, i) => ((m[i.status] = (m[i.status] || 0) + 1), m), {});
  view.innerHTML = `
    ${head('Invites', `${nf(counts.open || 0)} open · ${nf(counts.redeemed || 0)} redeemed · ${nf(counts.revoked || 0)} revoked`)}
    <div class="stack">
      <section class="card"><h3>Create invites</h3>
        <form id="if" class="row" autocomplete="off">
          <label class="field"><span>Count</span><input name="count" type="number" min="1" max="100" value="1"></label>
          <label class="field"><span>Label (optional)</span><input name="label" maxlength="80" placeholder="who it is for"></label>
          <div class="field"><button class="btn primary" type="submit">Create</button></div>
        </form>
        <div id="iout"></div>
      </section>
      <section class="card"><div class="card-head"><h3>All invites</h3><select id="ifilter" class="narrow"><option value="">All</option><option>open</option><option>redeemed</option><option>revoked</option></select></div><div id="ilist"></div></section>
    </div>`;
  const draw = () => {
    const st = $('#ifilter').value;
    $('#ilist').innerHTML = table(
      [
        { h: 'Created', v: (r) => when(r.created_at) },
        { h: 'Label', v: (r) => esc(r.label || '–') },
        { h: 'Status', v: (r) => badge(r.status, stateKind(r.status)) },
        { h: 'Balance', v: (r) => short(r.account_id, 12) },
        { h: 'Requests', num: true, v: (r) => nf(r.requests) },
        { h: 'Per-request uses', num: true, v: (r) => nf(r.nut24_uses) },
        { h: 'Redeemed', v: (r) => when(r.redeemed_at) },
        { h: '', v: (r) => (r.status !== 'revoked' ? `<button class="btn small danger" data-revoke="${esc(r.id)}">Revoke</button>` : '') },
      ],
      data.filter((i) => !st || i.status === st),
      'No invites.',
    );
  };
  draw();
  $('#ifilter').addEventListener('change', draw);
  $('#ilist').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-revoke]')?.dataset.revoke;
    if (!id || !confirm('Revoke this invite? It stops working for new balances and per-request payments.')) return;
    try {
      await api(`/invites/${id}/revoke`, { method: 'POST', body: {} });
      toast('Invite revoked');
      route(true);
    } catch (x) {
      toast(x.message);
    }
  });
  $('#if').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/invites', { method: 'POST', body: { count: Number(f.get('count')), label: f.get('label') || undefined } });
      const codes = r.data.map((x) => x.code).join('\n');
      const out = $('#iout');
      out.innerHTML = `<p class="note">Codes are shown once. Only their hashes are stored.</p><pre class="codes">${esc(codes)}</pre><button class="btn" type="button" id="icp">Copy ${r.data.length > 1 ? 'all' : 'code'}</button>`;
      $('#icp').addEventListener('click', () => copy(codes, 'Copied'));
      const list = await api('/invites');
      data.splice(0, data.length, ...list.data);
      draw();
    } catch (x) {
      toast(x.message);
    }
  });
}

// ------------------------------------------------------------------ waitlist

async function renderWaitlist() {
  const { data } = await api('/waitlist');
  const invited = data.filter((s) => s.invited_at).length;
  view.innerHTML = `
    ${head('Beta waitlist', `${nf(data.length)} signups · ${nf(invited)} invited`)}
    <div class="stack">
      <div id="wout"></div>
      <section class="card" id="wlist">${table(
        [
          { h: 'Signed up', v: (r) => when(r.created_at) },
          { h: 'Contact', v: (r) => `${badge(r.kind)} <span class="mono">${esc(r.contact.length > 34 ? r.contact.slice(0, 20) + '…' + r.contact.slice(-8) : r.contact)}</span>` },
          { h: 'Note', wrap: true, v: (r) => esc(r.note || '') },
          { h: 'Invited', v: (r) => (r.invited_at ? badge('invited ' + ago(r.invited_at), 'ok') : badge('waiting', 'warn')) },
          {
            h: '',
            v: (r) =>
              `<div class="actions"><button class="btn small ${r.invited_at ? '' : 'primary'}" data-invite="${esc(r.id)}" data-again="${r.invited_at ? '1' : ''}">${r.invited_at ? 'New code' : 'Invite'}</button><button class="btn small danger ghost" data-del="${esc(r.id)}">Delete</button></div>`,
          },
        ],
        data,
        'No signups yet.',
      )}</section>
    </div>`;
  $('#wlist').addEventListener(
    'click',
    async (e) => {
      const inv = e.target.closest('[data-invite]');
      const del = e.target.closest('[data-del]');
      if (inv) {
        const again = !!inv.dataset.again;
        if (again && !confirm('This signup was already invited. Make a new invite code anyway?')) return;
        try {
          const r = await api(`/waitlist/${inv.dataset.invite}/invite`, { method: 'POST', body: { again } });
          const out = $('#wout');
          out.innerHTML = `
            <section class="card">
              <div class="card-head"><h3>Invite ready for ${esc(r.kind === 'email' ? r.contact : 'this npub')}</h3>${badge('code shown once', 'brass')}</div>
              ${r.kind === 'npub' ? `<p class="muted small">Send it as a Nostr DM to <span class="mono">${esc(r.contact)}</span>.</p>` : ''}
              <textarea readonly rows="8" id="wmsg">${esc(r.message)}</textarea>
              <div class="actions spaced">
                ${r.mailto ? `<a class="btn primary" id="wmail" href="${esc(r.mailto)}">Open in email</a>` : ''}
                <button class="btn ${r.mailto ? '' : 'primary'}" type="button" id="wcp">Copy message</button>
                ${r.kind === 'npub' ? '<button class="btn" type="button" id="wnpub">Copy npub</button>' : ''}
                <button class="btn ghost" type="button" id="wcode">Copy code only</button>
              </div>
            </section>`;
          $('#wcp').addEventListener('click', () => copy(r.message, 'Message copied'));
          $('#wcode').addEventListener('click', () => copy(r.code, 'Code copied'));
          $('#wnpub')?.addEventListener('click', () => copy(r.contact, 'npub copied'));
          const row = inv.closest('tr');
          row.querySelector('td:nth-child(4)').innerHTML = badge('invited just now', 'ok');
          inv.textContent = 'New code';
          inv.classList.remove('primary');
          inv.dataset.again = '1';
          out.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (x) {
          toast(x.message);
        }
      } else if (del) {
        if (!confirm('Delete this signup for good? This removes the contact and note from the database.')) return;
        try {
          await api(`/waitlist/${del.dataset.del}`, { method: 'DELETE', body: {} });
          toast('Signup deleted');
          route(true);
        } catch (x) {
          toast(x.message);
        }
      }
    },
  );
}

// ------------------------------------------------------------------ balances

async function renderBalances() {
  view.innerHTML = `
    ${head('Balances', 'Prepaid balances. Keys are never stored, only their hashes, and are never shown here.')}
    <section class="card">
      <div class="row"><label class="field"><span>Search by balance id or invite id</span><input id="bq" type="search" placeholder="acct_…" spellcheck="false"></label></div>
      <div id="blist"><p class="loading">Loading…</p></div>
    </section>`;
  let t;
  const load = async () => {
    const q = $('#bq').value.trim();
    const r = await api('/accounts?q=' + encodeURIComponent(q));
    $('#blist').innerHTML =
      `<p class="muted small">${nf(r.data.length)} shown of ${nf(r.total)}</p>` +
      table(
        [
          { h: 'Id', v: (a) => short(a.id, 14) },
          { h: 'Unit', v: (a) => esc(a.unit) },
          { h: 'Balance', num: true, v: (a) => msub(a.balance_msub, a.unit) },
          { h: 'Reserved', num: true, v: (a) => msub(a.reserved_msub, a.unit) },
          { h: 'Created', v: (a) => when(a.created_at) },
          { h: 'Last used', v: (a) => when(a.last_used) },
          { h: 'Fundings', num: true, v: (a) => nf(a.fundings) },
          { h: 'Requests', num: true, v: (a) => nf(a.requests) },
          { h: 'State', v: (a) => (a.frozen_at ? badge('frozen', 'err') : badge('active', 'ok')) },
          { h: '', v: (a) => `<button class="btn small ${a.frozen_at ? '' : 'danger'}" data-freeze="${esc(a.id)}" data-to="${a.frozen_at ? '0' : '1'}">${a.frozen_at ? 'Unfreeze' : 'Freeze'}</button>` },
        ],
        r.data,
        q ? 'No balance matches.' : 'No balances yet.',
      );
  };
  await load();
  $('#bq').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => load().catch((e) => toast(e.message)), 250);
  });
  $('#blist').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-freeze]');
    if (!b) return;
    const frozen = b.dataset.to === '1';
    if (frozen && !confirm('Freeze this balance? Spending stops; the holder can still withdraw (refund) it.')) return;
    try {
      await api(`/accounts/${b.dataset.freeze}/freeze`, { method: 'POST', body: { frozen } });
      toast(frozen ? 'Balance frozen' : 'Balance unfrozen');
      await load();
    } catch (x) {
      toast(x.message);
    }
  });
}

// ------------------------------------------------------------------ fundings

let fundFilter = 'attention';
async function renderFundings() {
  const r = await api('/fundings?state=' + fundFilter);
  const q = r.quote_checks;
  view.innerHTML = `
    ${head(
      'Fundings',
      `Quote checks: ${nf(q.used)} of ${nf(q.budget)} this minute${q.cooldown_until ? ' · paused by the mint until ' + esc(new Date(q.cooldown_until).toLocaleTimeString()) : ''}. A re-check uses the same shared budget as the poller.`,
      `<div class="seg" id="ff">${[['attention', 'Needs attention'], ['all', 'All']].map(([k, l]) => `<button type="button" data-k="${k}" class="${k === fundFilter ? 'on' : ''}">${l}</button>`).join('')}</div>`,
    )}
    <section class="card">${table(
      [
        { h: 'Age', v: (f) => when(f.created_at) },
        { h: 'Method', v: (f) => esc(f.method) + (f.foreign_mint ? `<div class="muted small">${esc(f.foreign_mint)}</div>` : '') },
        { h: 'Amount', num: true, v: (f) => (f.amount != null ? units(f.amount, f.unit) : '–') },
        { h: 'Credited', num: true, v: (f) => units(f.credited, f.unit) },
        { h: 'State', v: (f) => badge(f.state, stateKind(f.state)) },
        { h: 'Balance', v: (f) => short(f.account_id, 12) },
        { h: 'Error', wrap: true, v: (f) => (f.error ? `<span class="err small">${esc(f.error)}</span>` : '') },
        { h: 'Next check', v: (f) => (f.open ? when(f.next_check) : '–') },
        { h: '', v: (f) => (f.open ? `<button class="btn small" data-recheck="${esc(f.id)}">Re-check now</button>` : '') },
      ],
      r.data,
      fundFilter === 'all' ? 'No fundings yet.' : 'Nothing pending, failed or expired.',
    )}</section>`;
  $('#ff').addEventListener('click', (e) => {
    const k = e.target.closest('button')?.dataset.k;
    if (k && k !== fundFilter) {
      fundFilter = k;
      route(true);
    }
  });
  view.querySelector('.card').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-recheck]');
    if (!b) return;
    b.disabled = true;
    try {
      const x = await api(`/fundings/${b.dataset.recheck}/recheck`, { method: 'POST', body: {} });
      toast(`Checked: ${x.data?.state ?? 'unknown'}`);
      route(true);
    } catch (x) {
      toast(x.message);
      b.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ requests

let reqLimit = 100;
async function renderRequests() {
  const r = await api('/requests?limit=' + reqLimit);
  view.innerHTML = `
    ${head(
      'Requests',
      'Metering log. No prompt or completion content is stored, so none is shown.',
      `<label class="field"><span>Show</span><select id="rl">${[50, 100, 250, 500].map((n) => `<option ${n === reqLimit ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`,
    )}
    <section class="card">${table(
      [
        { h: 'Time', v: (x) => when(x.created_at) },
        { h: 'Request', v: (x) => short(x.id, 12) },
        { h: 'Model', v: (x) => esc(x.model) },
        { h: 'Tier', v: (x) => badge(x.tier, x.tier === 'enclave' ? 'brass' : '') + (x.encrypted ? ' ' + badge('encrypted', 'ok') : '') },
        { h: 'Pay', v: (x) => esc(x.payment === 'nut24' ? 'per request' : 'balance') },
        { h: 'In', num: true, v: (x) => nf(x.input_tokens) },
        { h: 'Out', num: true, v: (x) => nf(x.output_tokens) },
        { h: 'Charged', num: true, v: (x) => msub(x.charged_msub, x.unit) },
        { h: 'Status', v: (x) => badge(x.status, stateKind(x.status)) },
        { h: 'Latency', num: true, v: (x) => (x.latency_ms != null ? nf(x.latency_ms) + ' ms' : '–') },
      ],
      r.data,
      'No requests yet.',
    )}</section>`;
  $('#rl').addEventListener('change', (e) => {
    reqLimit = Number(e.target.value);
    route(true);
  });
}

// ------------------------------------------------------------------ settings

async function renderSettings() {
  const s = await api('/settings');
  const yes = (b) => (b ? badge('on', 'ok') : badge('off'));
  const m = s.methods || {};
  view.innerHTML = `
    ${head('Settings', 'Read-only. Change these in the gateway environment and model catalog, then restart.')}
    <div class="stack">
      <div class="grid two">
        <section class="card"><h3>Access and pricing</h3><dl class="kv">
          <dt>Invite only</dt><dd>${yes(s.invite_only)}</dd>
          <dt>Markup</dt><dd>×${esc(s.markup)}</dd>
          <dt>Units</dt><dd>${esc(s.units.join(', '))} (default ${esc(s.default_unit)})</dd>
          <dt>BTC/USD</dt><dd>${s.btc_usd ? '$' + nf(s.btc_usd) : '–'} from ${esc(s.rate_sources.join(', '))}</dd>
          <dt>Trusted mints</dt><dd>${s.trusted_mints.map(esc).join('<br>')}</dd>
          <dt>Funding mint</dt><dd>${esc(s.fund_mint)}</dd>
          <dt>Rate limit</dt><dd>${nf(s.caps.rate_limit_rpm)} requests per minute per key or IP</dd>
        </dl></section>
        <section class="card"><h3>Funding</h3><dl class="kv">
          <dt>Lightning</dt><dd>${yes(s.enabled.lightning)} ${m.lightning ? `<span class="muted small">mint offers ${esc((m.lightning.units || []).join(', ') || 'none')}</span>` : ''}</dd>
          <dt>On-chain</dt><dd>${yes(s.enabled.onchain)}</dd>
          <dt>Other mints</dt><dd>${yes(s.enabled.foreign)}${s.foreign.allow.length ? ` <span class="muted small">allow ${esc(s.foreign.allow.join(', '))}</span>` : ''}${s.foreign.deny.length ? ` <span class="muted small">deny ${esc(s.foreign.deny.join(', '))}</span>` : ''}</dd>
          <dt>Lightning cap</dt><dd>${units(s.caps.fund_max_usd, 'usd')} · ${units(s.caps.fund_max_sat, 'sat')}</dd>
          <dt>Other-mint cap</dt><dd>${units(s.caps.foreign_max_usd, 'usd')} · ${units(s.caps.foreign_max_sat, 'sat')}</dd>
          <dt>Unfinished per balance</dt><dd>${nf(s.caps.fund_max_pending)}</dd>
          <dt>Quote checks</dt><dd>${nf(s.caps.quote_checks_per_min)} per minute</dd>
        </dl></section>
      </div>
      <section class="card"><h3>Suppliers</h3>${table(
        [
          { h: 'Supplier', v: (r) => esc(r.id) },
          { h: 'Type', v: (r) => esc(r.type) },
          { h: 'Tier', v: (r) => badge(r.tier, r.tier === 'enclave' ? 'brass' : '') },
          { h: 'Pricing', v: (r) => esc(r.pricing) },
          { h: 'Key', v: (r) => (r.key_present === null ? badge('none needed') : r.key_present ? badge(r.key_env + ' set', 'ok') : badge(r.key_env + ' missing', 'err')) },
          { h: 'Models', num: true, v: (r) => nf(r.models) },
        ],
        s.suppliers,
      )}</section>
      <section class="card"><h3>Models</h3>${table(
        [
          { h: 'Model', v: (r) => `${esc(r.id)}${r.uncensored ? ' ' + badge('uncensored', 'warn') : ''}` },
          { h: 'Supplier', v: (r) => esc(r.supplier) },
          { h: 'Tier', v: (r) => badge(r.tier, r.tier === 'enclave' ? 'brass' : '') },
          { h: 'Cost in/out $/Mtok', num: true, v: (r) => `${nf(r.cost_usd_per_mtok.input, 2)} / ${nf(r.cost_usd_per_mtok.output, 2)}` },
          { h: 'Price in/out $/Mtok', num: true, v: (r) => `${nf(r.price_usd_per_mtok.input, 2)} / ${nf(r.price_usd_per_mtok.output, 2)}` },
          { h: 'Price sat/Mtok', num: true, v: (r) => (r.price_sat_per_mtok ? `${nf(r.price_sat_per_mtok.input)} / ${nf(r.price_sat_per_mtok.output)}` : '–') },
          { h: 'Max out', num: true, v: (r) => nf(r.max_output_tokens) },
          { h: 'Price checked', v: (r) => (r.verified ? badge('yes', 'ok') : badge('no', 'warn')) },
        ],
        s.models,
      )}</section>
    </div>`;
}

const RENDER = {
  overview: renderOverview,
  export: renderExport,
  invites: renderInvites,
  waitlist: renderWaitlist,
  balances: renderBalances,
  fundings: renderFundings,
  requests: renderRequests,
  settings: renderSettings,
};

start();
