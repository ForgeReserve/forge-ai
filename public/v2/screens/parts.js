// Parts shared by the screens: the status bar, the rings and the bottom row.
import { dash, dashAfter, GEOMETRY } from '../core/rings.js';
import { el, icon, sayEl } from '../core/ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

let ringsN = 0;

/** The bright dot at the end of each lit arc, as the first run draws it: a near white of the ring's colour. */
const TIP = { gold: '#FFF6DC', memory: '#E6FFF9', low: '#FFF1E4' };

/**
 * Two rings (gold funds outside, teal memory inside). Returns {node, set(funds, memory, low, free)}.
 * Free questions are a lighter gold segment from 12 o'clock, and the paid balance follows it.
 *
 * Drawn as the first run draws its rings (screens/firstrun-art.js; owner, 2026-11-15): a thin ring (its
 * stroke the same share of the diameter) on a faint track, one soft glow under the lit arc, the arc
 * shaded light to deep along the same diagonal, and a small bright dot with a soft halo where it ends.
 * The colours are the look's tokens (--gold, --gold-free, --memory, --low and their tracks); on the
 * Light look the glow is a little stronger, so it still reads on the pale ground, and the light on the
 * arc softer, so the deep Light colours do not wash out (style.css).
 */
export function rings(size = 'home') {
  const g = GEOMETRY[size];
  const c = g.box / 2;
  const w = g.outer.w;
  const p = `rg${++ringsN}-`;
  const svg = svgEl('svg', { width: g.box, height: g.box, viewBox: `0 0 ${g.box} ${g.box}`, 'aria-hidden': 'true', class: 'rings-svg' });
  const defs = svgEl('defs', {});
  // The first run's arc gradient (light, the colour, deep) as a light and a shade over the token colour.
  const sheen = svgEl('linearGradient', { id: `${p}sheen`, x1: 0, y1: 0, x2: 1, y2: 1 });
  for (const [o, colour, a, cls] of [
    [0, '#FFFFFF', 0.38, 'ring-sheen-light'],
    [0.5, '#FFFFFF', 0, 'ring-sheen-mid'],
    [1, '#000000', 0.1, 'ring-sheen-deep'],
  ])
    sheen.append(svgEl('stop', { offset: o, 'stop-color': colour, 'stop-opacity': a, class: cls }));
  const blur = (id, s) => {
    const n = svgEl('filter', { id, x: '-50%', y: '-50%', width: '200%', height: '200%' });
    n.append(svgEl('feGaussianBlur', { stdDeviation: s }));
    return n;
  };
  // As on the first run's 10 wide rings: the glow blurs by 4, the tip's halo by 2.
  defs.append(sheen, blur(`${p}glow`, w * 0.4), blur(`${p}halo`, w * 0.2));
  svg.append(defs);
  const circle = (r, attrs) => svgEl('circle', { cx: c, cy: c, r, fill: 'none', ...attrs });
  const arc = (r, attrs) => circle(r, { 'stroke-linecap': 'round', transform: `rotate(-90 ${c} ${c})`, 'stroke-dasharray': `0 ${Math.round(2 * Math.PI * r)}`, ...attrs });

  /** One ring: its faint track, then its band: the glow, the fills (added by the caller), the shade, the tip. */
  const ring = (key, { r }, track) => {
    const trackEl = circle(r, { stroke: `var(--${track})`, 'stroke-width': w, class: `ring-track ring-track-${key}` });
    const fill = svgEl('g', { class: `ring-band ring-band-${key}` });
    const glow = arc(r, { 'stroke-width': w * 1.4, filter: `url(#${p}glow)`, class: 'ring-lit ring-glow' });
    const shade = arc(r, { stroke: `url(#${p}sheen)`, 'stroke-width': w, class: 'ring-lit ring-shade' });
    const tip = svgEl('g', { class: 'ring-tip' });
    tip.append(
      svgEl('circle', { cx: c, cy: c - r, r: w * 0.7, class: 'ring-tip-glow', filter: `url(#${p}halo)`, opacity: 0.6 }),
      svgEl('circle', { cx: c, cy: c - r, r: w * 0.26, class: 'ring-tip-dot' }),
    );
    tip.style.transformOrigin = `${c}px ${c}px`;
    fill.append(glow);
    svg.append(trackEl, fill);
    return { r, trackEl, fill, glow, shade, tip };
  };

  const o = ring('gold', g.outer, 'gold-track');
  // Free questions first (lighter gold), then the paid balance: these two keep the class ring-fill.
  const freeArc = arc(o.r, { stroke: 'var(--gold-free)', 'stroke-width': w, class: 'ring-fill ring-free' });
  const outer = arc(o.r, { stroke: 'var(--gold)', 'stroke-width': w, class: 'ring-fill ring-paid' });
  o.fill.append(freeArc, outer, o.shade, o.tip);
  const m = ring('memory', g.inner, 'memory-track');
  const inner = arc(m.r, { stroke: 'var(--memory)', 'stroke-width': w, class: 'ring-fill ring-memory' });
  m.fill.append(inner, m.shade, m.tip);

  /** Lays the glow and the shade over a fill of this share of the ring (from 12 o'clock), and turns the tip to its end. */
  const light = (x, share, colour, dot) => {
    const d = dash(share, x.r);
    const on = d.length >= 0.5;
    for (const n of [x.glow, x.shade]) {
      n.setAttribute('stroke-dasharray', d.dasharray);
      n.style.opacity = on ? '' : '0';
    }
    x.glow.style.stroke = colour;
    x.tip.firstChild.style.fill = colour;
    x.tip.lastChild.style.fill = dot;
    x.tip.style.transform = `rotate(${Math.round(Math.min(1, Math.max(0, share)) * 3600) / 10}deg)`;
    x.tip.style.opacity = on ? '' : '0';
  };

  return {
    node: svg,
    set(funds, memoryFree, low = false, free = 0) {
      const f = dash(free, g.outer.r);
      const a = dashAfter(funds, free, g.outer.r);
      const b = dash(memoryFree, g.inner.r);
      // A zero-length round cap still draws a dot; hide the fill instead.
      freeArc.setAttribute('stroke-dasharray', f.dasharray);
      freeArc.style.opacity = f.length < 0.5 ? '0' : '1';
      outer.setAttribute('stroke-dasharray', a.dasharray);
      outer.setAttribute('stroke-dashoffset', a.dashoffset);
      outer.style.opacity = a.length < 0.5 ? '0' : '1';
      inner.setAttribute('stroke-dasharray', b.dasharray);
      inner.style.opacity = b.length < 0.5 ? '0' : '1';
      inner.style.stroke = low ? 'var(--low)' : 'var(--memory)';
      m.trackEl.style.stroke = low ? 'var(--low-tint)' : 'var(--memory-track)';
      // The glow follows the whole gold fill (free and paid together) and the memory fill.
      light(o, (f.length + a.length) / f.circumference, a.length >= 0.5 ? 'var(--gold)' : 'var(--gold-free)', TIP.gold);
      light(m, b.length / b.circumference, low ? 'var(--low)' : 'var(--memory)', low ? TIP.low : TIP.memory);
      svg.dataset.funds = String(Math.round(a.length));
      svg.dataset.free = String(Math.round(f.length));
      svg.dataset.memory = String(Math.round(b.length));
      svg.dataset.low = String(!!low);
    },
  };
}

/** One ring for the cards on Funds and memory. The funds card shows free questions as a lighter segment first. */
export function cardRing(track, fill) {
  const g = GEOMETRY.card;
  const c = g.box / 2;
  const svg = svgEl('svg', { width: g.box, height: g.box, viewBox: `0 0 ${g.box} ${g.box}`, 'aria-hidden': 'true', class: 'card-ring' });
  svg.append(svgEl('circle', { cx: c, cy: c, r: g.r, fill: 'none', stroke: `var(--${track})`, 'stroke-width': g.w }));
  const freeArc = svgEl('circle', { cx: c, cy: c, r: g.r, fill: 'none', stroke: 'var(--gold-free)', 'stroke-width': g.w, 'stroke-linecap': 'round', transform: `rotate(-90 ${c} ${c})`, class: 'ring-fill ring-free' });
  svg.append(freeArc);
  const f = svgEl('circle', { cx: c, cy: c, r: g.r, fill: 'none', stroke: `var(--${fill})`, 'stroke-width': g.w, 'stroke-linecap': 'round', transform: `rotate(-90 ${c} ${c})`, class: 'ring-fill' });
  svg.append(f);
  return {
    node: svg,
    set(fraction, color, free = 0) {
      const fd = dash(free, g.r);
      const d = dashAfter(fraction, free, g.r);
      freeArc.setAttribute('stroke-dasharray', fd.dasharray);
      freeArc.style.opacity = fd.length < 0.5 ? '0' : '1';
      f.setAttribute('stroke-dasharray', d.dasharray);
      f.setAttribute('stroke-dashoffset', d.dashoffset);
      f.style.opacity = d.length < 0.5 ? '0' : '1';
      if (color) f.setAttribute('stroke', `var(--${color})`);
      svg.dataset.free = String(Math.round(fd.length));
    },
  };
}

/** The status bar: Private (or Standard) pill on the left, the balance pill on the right. */
export function statusBar({ t, state, nav }) {
  const pill = el('div', { class: 'pill-private', id: 'privacyPill' });
  const bal = el('button', { type: 'button', class: 'pill-balance', id: 'balancePill', onclick: () => nav('funds') });
  const update = () => {
    const v = state.view();
    pill.replaceChildren(icon(v.private ? 'lock' : 'unlock', 16), el('span', { text: v.private ? t('status.private') : t('status.standard') }));
    pill.dataset.kind = v.private ? 'private' : 'standard';
    pill.setAttribute('title', v.private ? t('status.privateLabel') : t('status.standardLabel'));
    pill.setAttribute('aria-label', v.private ? t('status.privateLabel') : t('status.standardLabel'));
    // With no paid balance, free questions left are what the pill shows.
    const freeText = !v.balanceText && v.freeLeft > 0 ? t(v.freeLeft === 1 ? 'status.freeOne' : 'status.free', { count: v.freeLeft }) : null;
    const text = v.balanceText ?? freeText ?? (v.online ? t('status.noBalance') : t('status.offline'));
    // With nothing to show, the pill is Add money: its plus in place of the dot.
    bal.replaceChildren(v.balanceText || freeText ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : icon(v.online ? 'addMoney' : 'alert', 18), el('span', { text, id: 'balanceText' }));
    bal.setAttribute('aria-label', v.balanceText ? t('status.balance', { amount: v.balanceText }) : freeText ? t('status.freeLabel', { free: freeText }) : t('status.noBalanceLabel'));
  };
  update();
  return { node: el('div', { class: 'status-bar' }, pill, bal), update };
}

/**
 * The bottom row: Type, Add, More. `open` is 'add' or 'more' while that sheet is open. A mode may give
 * its own pictures (ico: {type, add, more}).
 */
export function bottomRow({ t, nav, open = null, ico = {} }) {
  const b = (name, picture, label) => {
    const isOpen = open === name;
    return el(
      'button',
      {
        type: 'button',
        class: `bottom-btn${isOpen ? ' is-open' : ''}`,
        id: `btn-${name}`,
        'aria-expanded': name === 'type' ? null : String(isOpen),
        onclick: () => (isOpen ? nav('home') : nav(name)),
      },
      icon(ico[name] ?? picture, 20),
      el('span', { text: isOpen ? t('home.close') : label }),
    );
  };
  return el('nav', { class: 'bottom-row', 'aria-label': t('app.name') }, b('type', 'keyboard', t('home.type')), b('add', 'clip', t('home.add')), b('more', 'dots', t('home.more')));
}

/**
 * Search the web, for the next question only (docs/PAYMENTS.md, Web search): a switch where the model can
 * search, off by default and off again once a question is sent, with one honest line while it is on.
 * The price line includes the search fee while it is on. `id` keeps the Type and home switches apart.
 */
export function searchSwitch({ t, state, actions, id }) {
  const sw = el('button', { type: 'button', role: 'switch', class: 'switch', id, 'aria-labelledby': `${id}Label` }, el('span', { class: 'track' }, el('span', { class: 'knob' })));
  sw.addEventListener('click', () => actions.setSearch(!state.view().search.on));
  const note = sayEl('p', { class: 'search-note', id: `${id}Note`, hidden: true }, t('search.note'), '', 'eye');
  const node = el('div', { class: 'search-box', hidden: true }, el('div', { class: 'search-row' }, icon('globe', 20), el('span', { id: `${id}Label`, text: t('search.label') }), sw), note);
  const update = () => {
    const s = state.view().search;
    node.hidden = !s.available;
    sw.setAttribute('aria-checked', String(!!s.on));
    note.hidden = !s.on;
  };
  update();
  return { node, update };
}

/**
 * Listen on a screen: reads `pieces()` aloud with the phone's own voice (the reader the first run uses,
 * free and on the phone). Shown only where the phone has such a voice. Returns {node, update, destroy}.
 */
export function listenButton({ t, reader, pieces, id }) {
  const btn = el('button', { type: 'button', class: 'listen-chip', id, hidden: true });
  let speech = null;
  const draw = () => {
    btn.hidden = !reader?.available(null, pieces());
    btn.setAttribute('aria-pressed', String(!!speech));
    btn.replaceChildren(icon(speech ? 'stop' : 'speaker', 18), el('span', { text: t(speech ? 'intro.listenStop' : 'intro.listen') }));
  };
  const stop = () => {
    const s = speech;
    speech = null;
    s?.stop();
    draw();
  };
  btn.addEventListener('click', () => {
    if (speech) return stop();
    const s = reader.read(pieces().filter(Boolean), null);
    if (!s) return;
    speech = s;
    draw();
    s.done.catch(() => {}).finally(() => speech === s && ((speech = null), draw()));
  });
  // The phone's voices can load after the screen is drawn.
  const synth = globalThis.speechSynthesis;
  synth?.addEventListener?.('voiceschanged', draw);
  draw();
  return {
    node: btn,
    update: draw,
    stop,
    destroy: () => {
      stop();
      synth?.removeEventListener?.('voiceschanged', draw);
    },
  };
}

/**
 * Listen for a whole sub screen (reading load, owner 2026-11-15): reads the title, then every message in
 * full (the words in view and the detail behind its info button: core/ui.js say), and each choice with
 * its info. `root()` is the screen's node. Returns listenButton's {node, update, stop, destroy}.
 */
export function screenListen({ t, reader, id, root }) {
  const pieces = () => {
    let r = null;
    try {
      r = root();
    } catch {
      /* the screen is still being built */
    }
    if (!r) return [];
    const out = [r.querySelector('h1')?.textContent];
    for (const n of r.querySelectorAll('.say, .opt')) {
      if (n.closest('[hidden]') || n.parentElement?.closest('.opt')) continue;
      if (n.matches('.opt')) out.push([n.querySelector('b')?.textContent, n.querySelector('.info-more')?.textContent].filter(Boolean).join('. '));
      else out.push(n.textContent);
    }
    return out.filter((x) => x?.trim());
  };
  return listenButton({ t, reader, id, pieces });
}

/** A sub screen's header with Listen on the right: back, the centred title, Listen. */
export function listenHeader(title, onBack, backLabel, listen) {
  return el(
    'header',
    { class: 'back-head listen-head' },
    el('button', { type: 'button', class: 'round', 'aria-label': backLabel, onclick: onBack }, icon('back', 22)),
    el('h1', { text: title, tabindex: '-1' }),
    el('span', { class: 'listen-slot' }, listen),
  );
}
