// Small DOM and formatting helpers shared by the chat and the wallet.

export const $ = (id) => document.getElementById(id);

/** el('div', {class: 'x', onclick}, child, 'text') */
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v; // only ever passed trusted, static markup
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export function icon(name, cls = 'i') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(ns, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.append(u);
  return s;
}

export function store(k, v) {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: lives for this tab only */
  }
}
export function load(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

let toastTimer;
export function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  // A manual popover sits in the top layer, so the toast shows above an open wallet or dialog too.
  try {
    t.hidePopover();
    t.showPopover();
  } catch {
    t.style.display = 'block';
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    try {
      t.hidePopover();
    } catch {
      t.style.display = 'none';
    }
  }, ms);
}

export function announce(text) {
  const a = $('announcer');
  a.textContent = '';
  setTimeout(() => (a.textContent = text), 30);
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
    return true;
  } catch {
    toast('Copy failed. Select the text and copy it by hand.');
    return false;
  }
}

export function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function confirmDialog(title, text, ok = 'OK', danger = false) {
  const d = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = ok;
  $('confirmOk').className = danger ? 'btn primary danger' : 'btn primary';
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

const nf = new Intl.NumberFormat('en-US');
/** Whole units of a balance unit, e.g. 50 usd -> "$0.50", 1200 sat -> "1,200 sat". */
export function fmtUnits(n, unit) {
  if (n == null) return '';
  if (unit === 'usd') return `$${(n / 100).toFixed(2)}`;
  return `${nf.format(n)} sat`;
}
/** msub (thousandths of the unit) for the header and drawer. */
export function fmtBalance(msub, unit, precise = false) {
  if (msub == null || !unit) return '';
  if (unit === 'usd') {
    const dollars = msub / 100000;
    // Whole cents show as cents; a balance with a fraction of a cent shows the fraction too.
    if (msub % 1000 === 0 || dollars >= 100) return `$${dollars.toFixed(2)}`;
    return `$${dollars.toFixed(precise ? 4 : 3)}`;
  }
  const sats = msub / 1000;
  return precise && sats % 1 ? `${sats.toFixed(3)} sat` : `${nf.format(Math.floor(sats))} sat`;
}
/** Small per-message costs. */
export function fmtCost(msub, unit) {
  if (msub == null || !unit) return '';
  if (unit === 'usd') {
    const cents = msub / 1000;
    if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
    return `${cents < 0.01 ? cents.toFixed(4) : cents < 1 ? cents.toFixed(3) : cents.toFixed(2)} cents`;
  }
  const sats = msub / 1000;
  return `${sats < 1 ? sats.toFixed(3) : sats < 100 ? sats.toFixed(2) : nf.format(Math.round(sats))} sat`;
}
export function unitName(unit, n = 2) {
  return unit === 'usd' ? (n === 1 ? 'cent' : 'cents') : 'sat';
}
export const fmtInt = (n) => nf.format(n);

/** Fetch JSON from the gateway; returns {res, body}. Never throws for HTTP errors. */
export async function api(path, { key, json, method, signal } = {}) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method: method ?? (json !== undefined ? 'POST' : 'GET'), headers, body: json !== undefined ? JSON.stringify(json) : undefined, signal, cache: 'no-store' });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return { res, body };
}
export const errMsg = (r) => r.body?.error?.message ?? `The gateway answered HTTP ${r.res.status}.`;

/** Loads a classic script once (vendored UMD libraries). */
const scripts = new Map();
export function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(
      src,
      new Promise((resolve, reject) => {
        const s = el('script', { src });
        s.onload = resolve;
        s.onerror = () => {
          scripts.delete(src);
          reject(new Error(`Could not load ${src}`));
        };
        document.head.append(s);
      }),
    );
  }
  return scripts.get(src);
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
