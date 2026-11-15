// Parts shared by the screens: the status bar, the rings and the bottom row.
import { dash, dashAfter, GEOMETRY } from '../core/rings.js';
import { el, icon } from '../core/ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

let ringsN = 0;

/** A gradient across the whole drawing (user space), from the key light's corner to the far one. */
const gradient = (id, c, stops, { onArc = false } = {}) => {
  const [x1, y1, x2, y2] = [0.15, 0.1, 0.85, 0.9];
  const n = svgEl('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: x1 * 2 * c, y1: y1 * 2 * c, x2: x2 * 2 * c, y2: y2 * 2 * c });
  // An arc is turned a quarter back to start at 12 o'clock; its gradient is turned forward to match.
  if (onArc) n.setAttribute('gradientTransform', `rotate(90 ${c} ${c})`);
  for (const [o, colour, a] of stops) n.append(svgEl('stop', { offset: o, 'stop-color': colour, 'stop-opacity': a }));
  return n;
};
const blur = (id, s) => {
  const n = svgEl('filter', { id, x: '-50%', y: '-50%', width: '200%', height: '200%' });
  n.append(svgEl('feGaussianBlur', { stdDeviation: s }));
  return n;
};

/**
 * Two rings (gold funds outside, green memory inside). Returns {node, set(funds, memory, low, free)}.
 * Free questions are a lighter gold segment from 12 o'clock, and the paid balance follows it.
 *
 * Drawn to the first run's standard (screens/firstrun-art.js), with its one light (a key light from the
 * top left, a soft teal rim light from the bottom right): each ring runs in a groove sunk into the
 * ground (shadow under the wall that faces away from the light, a lit edge on the wall that faces it),
 * and its fill is a lit band in that groove, with a soft glow, a specular line along its lit side and a
 * bright tip where it ends. The colours stay the look's tokens (--gold, --memory, --low and their
 * tracks); the light is white and the shade a deep tone laid over them, so every look keeps its colours.
 */
export function rings(size = 'home') {
  const g = GEOMETRY[size];
  const c = g.box / 2;
  const p = `rg${++ringsN}-`;
  const svg = svgEl('svg', { width: g.box, height: g.box, viewBox: `0 0 ${g.box} ${g.box}`, 'aria-hidden': 'true', class: 'rings-svg' });
  const defs = svgEl('defs', {});
  defs.append(
    // The groove's lit edges: the wall facing the key light catches it.
    gradient(`${p}lout`, c, [
      [0, '#FFFFFF', 0],
      [0.55, '#FFFFFF', 0.25],
      [1, '#FFFFFF', 0.95],
    ]),
    gradient(`${p}lin`, c, [
      [0, '#FFFFFF', 0.9],
      [0.5, '#FFFFFF', 0.2],
      [1, '#FFFFFF', 0],
    ]),
    // The fill: lit toward the key light, shaded away from it; its specular line, and the rim light.
    gradient(`${p}tube`, c, [
      [0, '#FFFFFF', 0.42],
      [0.45, '#FFFFFF', 0.06],
      [0.7, '#000000', 0],
      [1, '#000000', 0.2],
    ], { onArc: true }),
    gradient(`${p}spec`, c, [
      [0, '#FFFFFF', 0.95],
      [0.55, '#FFFFFF', 0.35],
      [1, '#FFFFFF', 0.1],
    ], { onArc: true }),
    gradient(`${p}rim`, c, [
      [0, '#3FCFB4', 0],
      [0.6, '#3FCFB4', 0],
      [1, '#9FF5E2', 0.55],
    ], { onArc: true }),
    blur(`${p}b1`, 1),
    blur(`${p}b2`, Math.max(1.2, g.outer.w / 12)),
    blur(`${p}b4`, Math.max(2.4, g.outer.w / 6)),
  );
  svg.append(defs);
  const circle = (r, attrs) => svgEl('circle', { cx: c, cy: c, r, fill: 'none', ...attrs });
  const arc = (r, attrs) => circle(r, { 'stroke-linecap': 'round', transform: `rotate(-90 ${c} ${c})`, 'stroke-dasharray': `0 ${Math.round(2 * Math.PI * r)}`, ...attrs });

  /** One ring: its groove, then the lit band in it. `band` is the fill's width, a little inside the groove. */
  const ring = (key, { r, w }, track, ink) => {
    const band = w - Math.max(2, w * 0.12);
    // The groove's shade, in a deep tone of the ring's own colour: under the outer wall at the top left,
    // under the inner wall at the bottom right.
    defs.append(
      gradient(`${p}${key}gout`, c, [
        [0, ink, 0.3],
        [0.5, ink, 0.06],
        [1, ink, 0],
      ]),
      gradient(`${p}${key}gin`, c, [
        [0, ink, 0],
        [0.5, ink, 0.05],
        [1, ink, 0.26],
      ]),
    );
    // The groove, clipped to itself so its shading stays inside.
    const clip = svgEl('clipPath', { id: `${p}${key}clip` });
    clip.append(svgEl('path', { d: `M${c - r - w / 2} ${c}a${r + w / 2} ${r + w / 2} 0 1 0 ${2 * r + w} 0a${r + w / 2} ${r + w / 2} 0 1 0 ${-2 * r - w} 0ZM${c - r + w / 2} ${c}a${r - w / 2} ${r - w / 2} 0 1 1 ${2 * r - w} 0a${r - w / 2} ${r - w / 2} 0 1 1 ${-2 * r + w} 0Z`, 'clip-rule': 'evenodd' }));
    defs.append(clip);
    const trackEl = circle(r, { stroke: `var(--${track})`, 'stroke-width': w, class: `ring-track ring-track-${key}` });
    const groove = svgEl('g', { 'clip-path': `url(#${p}${key}clip)` });
    groove.append(
      circle(r + w / 2, { stroke: `url(#${p}${key}gout)`, 'stroke-width': w * 0.55, filter: `url(#${p}b2)` }),
      circle(r - w / 2, { stroke: `url(#${p}${key}gin)`, 'stroke-width': w * 0.45, filter: `url(#${p}b2)` }),
      circle(r + w / 2 - 0.6, { stroke: `url(#${p}lout)`, 'stroke-width': 1.2 }),
      circle(r - w / 2 + 0.6, { stroke: `url(#${p}lin)`, 'stroke-width': 1.2 }),
    );
    // The lip around the groove catches the key light (top left of the outer edge).
    const lip = circle(r + w / 2 + 0.7, { stroke: `url(#${p}lin)`, 'stroke-width': 1.1, opacity: 0.8 });
    svg.append(trackEl, groove, lip);
    const fill = svgEl('g', { class: `ring-band ring-band-${key}` });
    const glow = arc(r, { 'stroke-width': band + 6, opacity: 0.32, filter: `url(#${p}b4)`, class: 'ring-lit ring-glow' });
    const lit = arc(r, { stroke: `url(#${p}tube)`, 'stroke-width': band, class: 'ring-lit' });
    const spec = arc(r + band * 0.22, { stroke: `url(#${p}spec)`, 'stroke-width': Math.max(1.2, band * 0.09), class: 'ring-lit ring-spec' });
    const rim = arc(r - band * 0.3, { stroke: `url(#${p}rim)`, 'stroke-width': Math.max(1, band * 0.06), class: 'ring-lit', filter: `url(#${p}b1)` });
    // The tip: a soft glow and a bright dot where the fill ends, turned into place.
    const tip = svgEl('g', { class: 'ring-tip' });
    tip.append(svgEl('circle', { cx: c, cy: c - r, r: band * 0.42, class: 'ring-tip-glow', filter: `url(#${p}b2)`, opacity: 0.75 }), svgEl('circle', { cx: c, cy: c - r, r: Math.max(1.6, band * 0.15), fill: '#FFFBEA', class: 'ring-tip-dot' }));
    tip.style.transformOrigin = `${c}px ${c}px`;
    fill.append(glow);
    return { r, band, trackEl, fill, glow, lit, spec, rim, tip };
  };

  const o = ring('gold', g.outer, 'gold-track', '#5A3C08');
  // Free questions first (lighter gold), then the paid balance: these two keep the class ring-fill.
  const freeArc = arc(o.r, { stroke: 'var(--gold-free)', 'stroke-width': o.band, class: 'ring-fill ring-free' });
  const outer = arc(o.r, { stroke: 'var(--gold)', 'stroke-width': o.band, class: 'ring-fill ring-paid' });
  o.fill.append(freeArc, outer, o.lit, o.spec, o.rim, o.tip);
  svg.append(o.fill);
  const m = ring('memory', g.inner, 'memory-track', '#0A4A40');
  const inner = arc(m.r, { stroke: 'var(--memory)', 'stroke-width': m.band, class: 'ring-fill ring-memory' });
  m.fill.append(inner, m.lit, m.spec, m.rim, m.tip);
  svg.append(m.fill);

  /** Lays the lit layers over a fill of this share of the ring (from 12 o'clock), and turns the tip to its end. */
  const light = (x, share, colour) => {
    const on = dash(share, x.r).length >= 0.5;
    for (const [n, r] of [
      [x.glow, x.r],
      [x.lit, x.r],
      [x.spec, x.r + x.band * 0.22],
      [x.rim, x.r - x.band * 0.3],
    ]) {
      n.setAttribute('stroke-dasharray', dash(share, r).dasharray);
      n.style.opacity = on ? '' : '0';
    }
    x.glow.style.stroke = colour;
    x.tip.firstChild.style.fill = colour;
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
      // The light follows the whole gold fill (free and paid together) and the memory fill.
      light(o, (f.length + a.length) / f.circumference, a.length >= 0.5 ? 'var(--gold)' : 'var(--gold-free)');
      light(m, b.length / b.circumference, low ? 'var(--low)' : 'var(--memory)');
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
    bal.replaceChildren(el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { text, id: 'balanceText' }));
    bal.setAttribute('aria-label', v.balanceText ? t('status.balance', { amount: v.balanceText }) : freeText ? t('status.freeLabel', { free: freeText }) : t('status.noBalanceLabel'));
  };
  update();
  return { node: el('div', { class: 'status-bar' }, pill, bal), update };
}

/** The bottom row: Type, Add, More. `open` is 'add' or 'more' while that sheet is open. */
export function bottomRow({ t, nav, open = null }) {
  const b = (name, ico, label) => {
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
      icon(ico, 20),
      el('span', { text: isOpen ? t('home.close') : label }),
    );
  };
  return el('nav', { class: 'bottom-row', 'aria-label': t('app.name') }, b('type', 'keyboard', t('home.type')), b('add', 'plus', t('home.add')), b('more', 'dots', t('home.more')));
}

/**
 * Search the web, for the next question only (docs/PAYMENTS.md, Web search): a switch where the model can
 * search, off by default and off again once a question is sent, with one honest line while it is on.
 * The price line includes the search fee while it is on. `id` keeps the Type and home switches apart.
 */
export function searchSwitch({ t, state, actions, id }) {
  const sw = el('button', { type: 'button', role: 'switch', class: 'switch', id, 'aria-labelledby': `${id}Label` }, el('span', { class: 'track' }, el('span', { class: 'knob' })));
  sw.addEventListener('click', () => actions.setSearch(!state.view().search.on));
  const note = el('p', { class: 'search-note', id: `${id}Note`, hidden: true, text: t('search.note') });
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
