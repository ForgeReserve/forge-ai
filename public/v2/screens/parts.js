// Parts shared by the screens: the status bar, the rings and the bottom row.
import { dash, dashAfter, GEOMETRY } from '../core/rings.js';
import { el, icon } from '../core/ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/**
 * Two rings (gold funds outside, green memory inside). Returns {node, set(funds, memory, low, free)}.
 * Free questions are a lighter gold segment from 12 o'clock, and the paid balance follows it.
 */
export function rings(size = 'home') {
  const g = GEOMETRY[size];
  const c = g.box / 2;
  const svg = svgEl('svg', { width: g.box, height: g.box, viewBox: `0 0 ${g.box} ${g.box}`, 'aria-hidden': 'true', class: 'rings-svg' });
  const ring = (r, w, track, fill) => {
    svg.append(svgEl('circle', { cx: c, cy: c, r, fill: 'none', stroke: `var(--${track})`, 'stroke-width': w, class: 'ring-track' }));
    const f = svgEl('circle', { cx: c, cy: c, r, fill: 'none', stroke: `var(--${fill})`, 'stroke-width': w, 'stroke-linecap': 'round', transform: `rotate(-90 ${c} ${c})`, class: 'ring-fill', 'stroke-dasharray': `0 ${Math.round(2 * Math.PI * r)}` });
    svg.append(f);
    return f;
  };
  const outer = ring(g.outer.r, g.outer.w, 'gold-track', 'gold');
  const freeArc = svgEl('circle', { cx: c, cy: c, r: g.outer.r, fill: 'none', stroke: 'var(--gold-free)', 'stroke-width': g.outer.w, 'stroke-linecap': 'round', transform: `rotate(-90 ${c} ${c})`, class: 'ring-fill ring-free', 'stroke-dasharray': `0 ${Math.round(2 * Math.PI * g.outer.r)}` });
  svg.insertBefore(freeArc, outer);
  const innerTrack = svg.childElementCount;
  const inner = ring(g.inner.r, g.inner.w, 'memory-track', 'memory');
  const innerTrackEl = svg.children[innerTrack];
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
      inner.setAttribute('stroke', low ? 'var(--low)' : 'var(--memory)');
      innerTrackEl.setAttribute('stroke', low ? 'var(--low-tint)' : 'var(--memory-track)');
      svg.dataset.funds = String(Math.round(a.length));
      svg.dataset.free = String(Math.round(f.length));
      svg.dataset.memory = String(Math.round(b.length));
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
