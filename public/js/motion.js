// Motion system: shared tokens (mirrored in style.css), bottom sheets with drag to dismiss, the
// balance number roll, FLIP helpers and the small celebratory bursts. Only transform and opacity are
// animated. With prefers-reduced-motion every helper falls back to a fade or an instant change.

export const DUR = { fast: 120, base: 200, slow: 320 };
export const EASE = {
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  soft: 'cubic-bezier(0.32, 0.72, 0, 1)', // iOS sheet curve
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  in: 'cubic-bezier(0.55, 0, 1, 0.45)',
};

const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
export const reduced = () => rmq.matches;
const mobq = window.matchMedia('(max-width: 860px)');
export const isPhone = () => mobq.matches;

/** element.animate that never throws and resolves when done (or at once with reduced motion). */
export function anim(node, frames, opts) {
  if (!node?.animate) return Promise.resolve();
  try {
    const a = node.animate(frames, { fill: 'none', ...opts, duration: reduced() ? Math.min(opts?.duration ?? 0, 1) : opts?.duration });
    return a.finished.catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Light haptic: a real vibration where the platform has one (Android), nothing elsewhere. */
export function haptic(ms = 10) {
  try {
    if (!reduced()) navigator.vibrate?.(ms);
  } catch {
    /* not allowed */
  }
}

/** Runs fn inside a View Transition where supported and motion is allowed; otherwise just runs it. */
export function viewTransition(fn) {
  if (reduced() || !document.startViewTransition) return void fn();
  try {
    document.startViewTransition(fn);
  } catch {
    fn();
  }
}

// ------------------------------------------------------------------ sheets

const sheets = new WeakMap();

/**
 * Opens a <dialog> as a bottom sheet on phones (or a drawer/modal on wide screens) with a physical
 * spring, a blurred backdrop fade and, on phones, drag to dismiss from the grab handle and header.
 */
export function openSheet(dlg, { modal = true } = {}) {
  if (dlg.open) return;
  setup(dlg);
  if (modal) dlg.showModal();
  else dlg.show();
  document.documentElement.classList.add('sheet-open');
  const phone = isPhone();
  dlg.dataset.mode = phone ? 'sheet' : dlg.classList.contains('drawer') ? 'drawer' : dlg.classList.contains('menu') ? 'pop' : 'modal';
  const from = enterFrom(dlg);
  anim(dlg, [from, { transform: 'none', opacity: 1 }], { duration: phone ? 420 : DUR.slow, easing: phone ? EASE.soft : EASE.out });
  if (modal) anim(dlg, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.slow, easing: EASE.out, pseudoElement: '::backdrop' });
}

function enterFrom(dlg) {
  const m = dlg.dataset.mode;
  if (reduced()) return { opacity: 0, transform: 'none' };
  if (m === 'sheet') return { transform: 'translateY(100%)', opacity: 1 };
  if (m === 'drawer') return { transform: 'translateX(32px)', opacity: 0 };
  if (m === 'pop') return { transform: 'translateY(-6px) scale(0.97)', opacity: 0 };
  return { transform: 'translateY(10px) scale(0.97)', opacity: 0 };
}

/** Animates the sheet away, then closes the dialog. */
export async function closeSheet(dlg, value) {
  if (!dlg.open || dlg.dataset.closing) return;
  dlg.dataset.closing = '1';
  const m = dlg.dataset.mode;
  const cur = getComputedStyle(dlg).transform;
  const to = reduced()
    ? { opacity: 0 }
    : m === 'sheet'
      ? { transform: 'translateY(100%)' }
      : m === 'drawer'
        ? { transform: 'translateX(32px)', opacity: 0 }
        : { transform: 'translateY(-4px) scale(0.98)', opacity: 0 };
  const d = m === 'sheet' ? 280 : DUR.base;
  const backdrop = dlg.matches(':modal') ? anim(dlg, [{ opacity: 1 }, { opacity: 0 }], { duration: d, easing: EASE.out, pseudoElement: '::backdrop', fill: 'forwards' }) : null;
  await Promise.all([anim(dlg, [{ transform: cur === 'none' ? 'none' : cur, opacity: 1 }, to], { duration: d, easing: m === 'sheet' ? 'cubic-bezier(0.4, 0, 1, 1)' : EASE.out, fill: 'forwards' }), backdrop]);
  dlg.style.transform = '';
  dlg.close(value);
  for (const a of dlg.getAnimations({ subtree: false })) a.cancel();
  delete dlg.dataset.closing;
  if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
}

function setup(dlg) {
  if (sheets.has(dlg)) return;
  sheets.set(dlg, true);
  // Escape and the platform back gesture: animate instead of vanishing.
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeSheet(dlg);
  });
  dlg.addEventListener('close', () => {
    if (!document.querySelector('dialog[open]')) document.documentElement.classList.remove('sheet-open');
  });
  // Backdrop click (the dialog box itself is the target only outside its content).
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(dlg);
  });
  for (const b of dlg.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeSheet(dlg));
  drag(dlg);
}

/** Drag to dismiss: follows the finger downwards, rubber-bands upwards, flings closed past a threshold. */
function drag(dlg) {
  let y0 = 0;
  let t0 = 0;
  let dy = 0;
  let active = false;
  let last = [];
  const handle = (e) => e.target.closest?.('.grab, .d-head, .menu-head') && !e.target.closest('button, a, input, select, textarea');
  const fromBody = (e) => {
    // A drag that starts in the scroll area dismisses only when that area is already at the top.
    const sc = e.target.closest?.('.d-body, .menu-list');
    return sc && sc.scrollTop <= 0 && !e.target.closest('input, textarea, select, .qr, .scanner');
  };
  dlg.addEventListener(
    'touchstart',
    (e) => {
      if (dlg.dataset.mode !== 'sheet' || e.touches.length !== 1) return;
      const h = handle(e);
      if (!h && !fromBody(e)) return;
      active = h ? 'handle' : 'body';
      y0 = e.touches[0].clientY;
      t0 = performance.now();
      dy = 0;
      last = [[t0, y0]];
      for (const a of dlg.getAnimations()) a.cancel();
    },
    { passive: true },
  );
  dlg.addEventListener(
    'touchmove',
    (e) => {
      if (!active) return;
      const y = e.touches[0].clientY;
      dy = y - y0;
      if (active === 'body' && dy < 0) return; // scrolling the content up: not a drag
      if (active === 'body' && dy > 0 && e.cancelable) e.preventDefault();
      last.push([performance.now(), y]);
      if (last.length > 5) last.shift();
      const shown = dy >= 0 ? dy : -rubber(-dy, 60);
      dlg.style.transform = `translateY(${shown}px)`;
      dlg.style.setProperty('--drag', String(Math.max(0, Math.min(1, dy / dlg.offsetHeight))));
    },
    { passive: false },
  );
  const end = () => {
    if (!active) return;
    active = false;
    const [ta, ya] = last[0] ?? [t0, y0];
    const [tb, yb] = last.at(-1) ?? [t0, y0];
    const v = (yb - ya) / Math.max(1, tb - ta); // px per ms
    const h = dlg.offsetHeight;
    if (dy > 0 && (dy > h * 0.28 || v > 0.6)) {
      closeSheet(dlg);
      return;
    }
    const cur = dlg.style.transform || 'none';
    dlg.style.transform = '';
    dlg.style.removeProperty('--drag');
    if (cur !== 'none') anim(dlg, [{ transform: cur }, { transform: 'none' }], { duration: DUR.slow + 80, easing: EASE.spring });
  };
  dlg.addEventListener('touchend', end);
  dlg.addEventListener('touchcancel', end);
}

/** Rubber band: resistance grows with distance, never past `max`. */
export const rubber = (d, max) => max * (1 - 1 / (1 + d / (max * 2.2)));

// ------------------------------------------------------------------ number roll

/**
 * Renders `text` into `node` as an odometer: each digit is a vertical strip of 0-9 moved with
 * transform. Same-shaped strings roll digit by digit; a change of shape rebuilds and fades.
 */
export function rollText(node, text, { celebrate = false } = {}) {
  const prev = node.dataset.roll;
  if (prev === text) return;
  node.dataset.roll = text;
  node.setAttribute('aria-label', text);
  const shape = (s) => s.replace(/\d/g, '0');
  if (reduced() || prev == null || shape(prev) !== shape(text) || !node.querySelector('.roll-d')) {
    node.replaceChildren(...[...text].map((c) => cell(c)));
    if (prev != null && !reduced()) anim(node, [{ opacity: 0.2, transform: 'translateY(0.15em)' }, { opacity: 1, transform: 'none' }], { duration: DUR.slow, easing: EASE.out });
  } else {
    const cells = node.children;
    [...text].forEach((c, i) => {
      const strip = cells[i]?.firstChild;
      if (strip?.classList?.contains('roll-strip')) {
        strip.style.transitionDelay = `${(text.length - i) * 28}ms`;
        strip.style.transform = `translateY(${-Number(c) * 10}%)`;
      }
    });
  }
  if (celebrate) pulse(node.closest('[data-glow]') ?? node);
}

function cell(c) {
  const s = document.createElement('span');
  s.setAttribute('aria-hidden', 'true');
  if (!/\d/.test(c)) {
    s.className = 'roll-c';
    s.textContent = c;
    return s;
  }
  s.className = 'roll-d';
  const strip = document.createElement('span');
  strip.className = 'roll-strip';
  strip.textContent = '0123456789'.split('').join('\n');
  strip.style.transform = `translateY(${-Number(c) * 10}%)`;
  s.append(strip);
  return s;
}

/** Brief brass glow and a haptic-style scale pulse. */
export function pulse(node) {
  haptic(12);
  node.classList.remove('glow');
  void node.offsetWidth;
  node.classList.add('glow');
  setTimeout(() => node.classList.remove('glow'), 1400);
  anim(node, [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(0.99)' }, { transform: 'scale(1)' }], { duration: 520, easing: EASE.out });
}

// ------------------------------------------------------------------ FLIP and bursts

/** Moves `node` from a previous rect to where it is now (shared-element feel). */
export function flipFrom(rect, node) {
  if (!rect || !node || reduced()) return;
  const r = node.getBoundingClientRect();
  if (!r.width) return;
  const dx = rect.left - r.left;
  const dy = rect.top - r.top;
  const s = rect.width / r.width;
  anim(node, [{ transform: `translate(${dx}px, ${dy}px) scale(${s})`, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: DUR.slow + 60, easing: EASE.soft });
}

/** Success: a check that draws itself, a ring and a few sparks. Returns the element to insert. */
export function successMark(label = 'Done') {
  const ns = 'http://www.w3.org/2000/svg';
  const wrap = document.createElement('div');
  wrap.className = 'success';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', label);
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.innerHTML = '<circle class="s-disc" cx="32" cy="32" r="30"/><path class="s-check" pathLength="1" d="M19 33.5 28 42l17-19"/>';
  const ring = document.createElement('span');
  ring.className = 's-ring';
  wrap.append(ring, svg);
  if (!reduced()) {
    for (let i = 0; i < 12; i++) {
      const p = document.createElement('span');
      p.className = 's-spark';
      const a = (i / 12) * Math.PI * 2 + (i % 2) * 0.2;
      const d = 54 + (i % 3) * 14;
      p.style.setProperty('--tx', `${Math.cos(a) * d}px`);
      p.style.setProperty('--ty', `${Math.sin(a) * d}px`);
      p.style.animationDelay = `${120 + (i % 4) * 25}ms`;
      wrap.append(p);
    }
  }
  return wrap;
}

/** Cross-fades a text change (used by the tier line under the composer). */
export async function crossfade(node, apply) {
  if (reduced() || !node.textContent) return void apply();
  await anim(node, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(3px)' }], { duration: DUR.fast, easing: EASE.in, fill: 'forwards' });
  apply();
  for (const a of node.getAnimations()) a.cancel();
  anim(node, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.base, easing: EASE.out });
}

/** Slides between two views of a stack: forward goes left, back goes right. */
export function slideSwap(container, build, dir = 1) {
  const old = container.firstElementChild;
  const next = build();
  if (!old || reduced()) {
    container.replaceChildren(next);
    if (old && reduced()) anim(next, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.base });
    return next;
  }
  old.style.position = 'absolute';
  old.style.inset = '0';
  old.style.pointerEvents = 'none';
  container.append(next);
  const d = DUR.slow;
  anim(old, [{ transform: 'none', opacity: 1 }, { transform: `translateX(${-dir * 28}%)`, opacity: 0 }], { duration: d, easing: EASE.soft, fill: 'forwards' }).then(() => old.remove());
  anim(next, [{ transform: `translateX(${dir * 40}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: d + 40, easing: EASE.soft });
  return next;
}
