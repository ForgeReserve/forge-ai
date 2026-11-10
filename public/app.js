// Forge AI chat page. Plain ES module, no build step.
// Privacy: messages live only in this page's memory; nothing but the balance key is stored locally.

const $ = (id) => document.getElementById(id);
const KEY_STORE = 'forge.balanceKey';
const TINFOIL_SDK = 'https://cdn.jsdelivr.net/npm/tinfoil@1.4.0/+esm';

const state = { key: null, unit: null, balanceMsub: null, models: [], inviteOnly: true, history: [] };

function store(k, v) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: key lives for this tab only */
  }
}
function load(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function fmt(msub, unit) {
  if (msub == null || !unit) return '';
  if (unit === 'usd') {
    const dollars = msub / 100000;
    return dollars >= 0.01 ? `$${dollars.toFixed(4)}` : `${(msub / 1000).toFixed(3)} cents`;
  }
  return `${(msub / 1000).toFixed(3)} sat`;
}

function priceLabel(m) {
  const unit = state.unit ?? 'usd';
  if (unit === 'sat' && m.pricing.sat_per_mtok) {
    const p = m.pricing.sat_per_mtok;
    return `${Math.round(p.input)} sat in, ${Math.round(p.output)} sat out per million tokens`;
  }
  const p = m.pricing.usd_per_mtok;
  return `$${p.input} in, $${p.output} out per million tokens`;
}

function msg(text, kind = '') {
  const el = $('walletMsg');
  el.textContent = text;
  el.className = 'msg ' + kind;
}

function setKey(key) {
  state.key = key;
  store(KEY_STORE, key);
  $('keyDetails').hidden = !key;
  $('keyText').textContent = key ?? '';
  $('refundBtn').disabled = !key;
  $('inviteRow').hidden = !!key || !state.inviteOnly;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (state.key) headers.authorization = `Bearer ${state.key}`;
  if (opts.json) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: opts.method ?? (opts.json ? 'POST' : 'GET'), headers, body: opts.json ? JSON.stringify(opts.json) : undefined });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return { res, body };
}

async function refreshBalance() {
  if (!state.key) {
    $('balance').textContent = 'No balance';
    return;
  }
  const { res, body } = await api('/v1/wallet');
  if (!res.ok) {
    $('balance').textContent = 'Key not recognized';
    return;
  }
  state.unit = body.unit;
  state.balanceMsub = body.balance_msub;
  $('balance').textContent = `Balance ${fmt(body.balance_msub, body.unit)}`;
  renderModelInfo();
}

async function loadModels() {
  const { body } = await api('/v1/models');
  state.models = body?.data ?? [];
  state.inviteOnly = !!body?.invite_only;
  $('inviteRow').hidden = !!state.key || !state.inviteOnly;
  renderModels();
}

function renderModels() {
  const sel = $('model');
  const prev = sel.value;
  const show = $('showUncensored').checked;
  sel.innerHTML = '';
  for (const m of state.models) {
    if (m.uncensored && !show) continue;
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${m.name ?? m.id} (${m.tier === 'enclave' ? 'enclave' : 'standard'}${m.uncensored ? ', uncensored' : ''})`;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  renderModelInfo();
}

function currentModel() {
  return state.models.find((m) => m.id === $('model').value);
}

function renderModelInfo() {
  const m = currentModel();
  if (!m) return;
  const enclave = m.tier === 'enclave';
  $('encryptRow').hidden = !enclave;
  const tier = enclave
    ? $('encrypt').checked
      ? 'Enclave tier, encrypted in your browser: the gateway forwards ciphertext and cannot read your messages.'
      : 'Enclave tier, not encrypted in the browser: the gateway can read this request in transit.'
    : 'Standard tier: the gateway and the supplier can read your messages.';
  $('modelInfo').textContent = `${priceLabel(m)}. ${tier}`;
}

function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = `m ${role}`;
  el.textContent = text;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
  return el;
}

function setMeta(el, text) {
  let meta = el.querySelector('.meta');
  if (!meta) {
    meta = document.createElement('span');
    meta.className = 'meta';
    el.appendChild(meta);
  }
  meta.textContent = text;
}

/** Reads an OpenAI SSE stream, calling onDelta for text and onForge for the gateway's final event. */
async function readStream(res, onDelta, onForge) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const lines = block.split('\n');
      const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let o;
      try {
        o = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev === 'forge') onForge(o);
      else if (o.error) throw new Error(o.error.message);
      else {
        const d = o.choices?.[0]?.delta;
        if (d?.content) onDelta(d.content);
      }
    }
  }
}

let secureClientPromise = null;
async function secureFetch() {
  // Tinfoil's browser SDK: verifies the enclave attestation, then HPKE-encrypts bodies (EHBP).
  // Requests go to this gateway, which forwards the ciphertext without being able to read it.
  secureClientPromise ??= (async () => {
    const mod = await import(TINFOIL_SDK);
    const opts = { baseURL: `${location.origin}/v1/` };
    if (location.protocol === 'https:') opts.attestationBundleURL = location.origin;
    const client = new mod.SecureClient(opts);
    await client.ready();
    return client;
  })();
  secureClientPromise.catch(() => (secureClientPromise = null));
  return (await secureClientPromise).fetch;
}

async function send(text) {
  const m = currentModel();
  if (!m) return;
  if (!state.key) {
    addMessage('error', 'Add funds first: paste an eCash token in the wallet panel.');
    return;
  }
  state.history.push({ role: 'user', content: text });
  addMessage('user', text);
  const out = addMessage('assistant', '');
  const before = state.balanceMsub;
  const encrypted = m.tier === 'enclave' && $('encrypt').checked;
  const body = JSON.stringify({ model: encrypted ? m.upstream_model : m.id, messages: state.history, stream: true, max_tokens: Math.min(2048, m.max_output_tokens) });
  let reply = '';
  $('send').disabled = true;
  try {
    let res;
    if (encrypted) {
      const f = await secureFetch();
      res = await f('chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${state.key}`,
          'X-Tinfoil-Model': m.upstream_model,
          'X-Tinfoil-Max-Output-Tokens': String(Math.min(2048, m.max_output_tokens)),
        },
        body,
      });
    } else {
      res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${state.key}` },
        body,
      });
    }
    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      try {
        err = (await res.json()).error?.message ?? err;
      } catch {
        /* ignore */
      }
      throw new Error(err);
    }
    let forge = null;
    await readStream(
      res,
      (d) => {
        reply += d;
        out.firstChild ? (out.firstChild.textContent = reply) : (out.textContent = reply);
        $('log').scrollTop = $('log').scrollHeight;
      },
      (f) => (forge = f),
    );
    state.history.push({ role: 'assistant', content: reply });
    await refreshBalance();
    const cost = forge?.charged_msub ?? (before != null && state.balanceMsub != null ? before - state.balanceMsub : null);
    setMeta(out, `${cost != null ? `Cost ${fmt(cost, state.unit)}` : ''}${encrypted ? ' · encrypted end to end' : ''}`);
  } catch (e) {
    state.history.pop();
    out.className = 'm error';
    out.textContent = encrypted && !secureClientPromise ? `Encrypted mode unavailable: ${e.message}` : e.message;
  } finally {
    $('send').disabled = false;
  }
}

async function topup() {
  const v = $('pasteBox').value.trim();
  if (!v) return msg('Paste an eCash token or a balance key.', 'err');
  if (v.startsWith('sk-forge-')) {
    setKey(v);
    $('pasteBox').value = '';
    await refreshBalance();
    return msg(state.balanceMsub != null ? 'Balance key loaded.' : 'Key not recognized.', state.balanceMsub != null ? 'ok' : 'err');
  }
  if (!v.startsWith('cashuB')) return msg('That does not look like an eCash token (cashuB...).', 'err');
  $('topupBtn').disabled = true;
  msg('Redeeming eCash...');
  try {
    const { res, body } = await api('/v1/wallet/topup', { json: { token: v, invite: $('invite').value.trim() || undefined } });
    if (body?.key) setKey(body.key);
    if (!res.ok) return msg(body?.error?.message ?? `HTTP ${res.status}`, 'err');
    $('pasteBox').value = '';
    msg(body.replay ? 'This token was already added.' : `Added ${body.credited} ${body.unit === 'usd' ? 'cents' : 'sat'}.`, 'ok');
    await refreshBalance();
    renderModels();
  } finally {
    $('topupBtn').disabled = false;
  }
}

async function refund() {
  if (!confirm('Withdraw your whole balance as an eCash token?')) return;
  $('refundBtn').disabled = true;
  try {
    const { res, body } = await api('/v1/wallet/refund', { json: {} });
    if (!res.ok && res.status !== 202) return msg(body?.error?.message ?? `HTTP ${res.status}`, 'err');
    if (body.token) {
      $('refundBox').hidden = false;
      $('refundToken').value = body.token;
      msg(`Withdrew ${body.amount} ${body.unit === 'usd' ? 'cents' : 'sat'}. Copy the token below into your wallet.`, 'ok');
    } else {
      msg('The mint did not answer. Your withdrawal is saved; press Withdraw again to retry.', 'err');
    }
    await refreshBalance();
  } finally {
    $('refundBtn').disabled = !state.key;
  }
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    msg(`${label} copied.`, 'ok');
  } catch {
    msg('Copy failed; select the text and copy it by hand.', 'err');
  }
}

$('topupBtn').addEventListener('click', topup);
$('refundBtn').addEventListener('click', refund);
$('copyRefund').addEventListener('click', () => copy($('refundToken').value, 'eCash token'));
$('copyKey').addEventListener('click', () => copy(state.key ?? '', 'Balance key'));
$('forgetKey').addEventListener('click', () => {
  if (!confirm('Forget the balance key on this device? Without a copy of it, the balance cannot be used again.')) return;
  setKey(null);
  state.unit = null;
  state.balanceMsub = null;
  refreshBalance();
});
$('showUncensored').addEventListener('change', renderModels);
$('model').addEventListener('change', renderModelInfo);
$('encrypt').addEventListener('change', renderModelInfo);
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('input').value.trim();
  if (!t) return;
  $('input').value = '';
  send(t);
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('form').requestSubmit();
  }
});

setKey(load(KEY_STORE));
await loadModels();
await refreshBalance();
