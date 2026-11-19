// The landing page at /: the look this phone keeps from the app (else Midnight), the download panel,
// the moments and the title that turns.
//
// First, an address meant for the Classic chat page (at / before it moved to /classic/) goes on there
// (forward.js).
//
// Download buttons: each button's link is its data-href in index.html. While that is empty the button
// shows Soon and is no link; once it is set the button links there and Soon goes.
//
// The moments (Talk, Private, Pay, Share unseen): the selected tab's ring is a CSS animation, and it is the
// clock. Its first half ending shows the moment's second screen (if it has one); its second half ending
// moves on to the next moment. So anything that pauses the CSS animations (data-play, .held in
// about.css) pauses the moments too, and nothing here keeps time of its own.
// - data-play: intro (the way in), playing, or stopped (Pause, a moment picked, or reduced motion).
// - .held: a short pause while the mouse is over the moments, keyboard focus is on a tab or a link in
//   the words, or the page is out of sight.
//
// The title: the words after "Private AI for" (the list in index.html) move on by a clock of their own,
// quicker than the moments: the word on show runs a CSS animation (who-hold in about.css, 2 s for a word,
// 5 s for a phrase) and the next word comes when it ends. It is paused by the same rule as the rings, so
// whatever pauses the moments (Pause, a moment picked, the mouse, focus, the page out of sight) pauses the
// title, and it goes on from where it stopped. Under reduced motion the title is the whole sentence and
// never turns (about.css).
import { classicAddress } from '/about/forward.js';
import { applyPageLook } from '/v2/core/pagelook.js';

const classic = classicAddress(location.hash, matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
if (classic) location.replace(classic);

applyPageLook();

for (const a of document.querySelectorAll('a[data-download]')) {
  const href = (a.dataset.href ?? '').trim();
  if (!href) {
    a.removeAttribute('href');
    continue;
  }
  a.href = href;
  a.querySelector('.soon')?.remove();
}

// The download panel: the browser's popover (Escape and a tap outside close it). Where there is none, a
// plain toggle that does the same.
const pop = document.getElementById('download');
const dlBtn = document.getElementById('topDownload');
if (pop && dlBtn) {
  const shown = (open) => dlBtn.setAttribute('aria-expanded', String(open));
  if (typeof pop.showPopover === 'function') {
    pop.addEventListener('toggle', (e) => shown(e.newState === 'open'));
  } else {
    pop.removeAttribute('popover');
    const set = (open) => (pop.classList.toggle('open', open), shown(open));
    dlBtn.addEventListener('click', () => set(!pop.classList.contains('open')));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pop.classList.contains('open')) (set(false), dlBtn.focus());
    });
    document.addEventListener('click', (e) => {
      if (pop.classList.contains('open') && !pop.contains(e.target) && !dlBtn.contains(e.target)) set(false);
    });
  }
}

const hero = document.querySelector('.hero');
const tabs = [...document.querySelectorAll('.tab[role=tab]')];
const playBtn = document.getElementById('play');
const stage = document.getElementById('stage');
const caps = document.querySelector('.caps');
const sheenEl = document.querySelector('.sheen');
/** The screens each moment shows, in order (data-frame on the pictures). */
const FRAMES = { talk: ['talk-a', 'talk-b'], private: ['private'], pay: ['pay-a', 'pay-b'], share: ['share'] };
const still = matchMedia('(prefers-reduced-motion: reduce)');

let now = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
if (now < 0) now = 0;
// Where the rings' bright ends point (degrees, clockwise from the top): a quarter turn per moment.
let tip = 90 * (now + 1);

/** Shows one screen in the phone, with a glint across the glass. */
function frame(name) {
  if (hero.dataset.frame === name) return;
  hero.dataset.frame = name;
  if (still.matches || typeof sheenEl?.animate !== 'function' || hero.dataset.play === 'intro') return;
  sheenEl.animate(
    [
      { transform: 'translateX(0) rotate(10deg)', opacity: 0 },
      { opacity: 1, offset: 0.35 },
      { transform: 'translateX(420%) rotate(10deg)', opacity: 0 },
    ],
    { duration: 1300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  );
}

/** The title's words, in order. */
const whos = [...document.querySelectorAll('#whos .who')];

// The title's clock: when the word on show has stayed its time, the next word (and after the last, the
// first). The new word's own animation starts with its class.
whos[0]?.parentElement.addEventListener('animationend', (e) => {
  if (e.animationName !== 'who-hold' || whos.length < 2 || still.matches) return;
  const who = whos.indexOf(e.target);
  if (who < 0 || !e.target.classList.contains('on')) return;
  for (const w of whos) w.classList.remove('was', 'on');
  e.target.classList.add('was');
  whos[(who + 1) % whos.length].classList.add('on');
});

/** Shows moment i (its first screen) and starts its ring again. */
function select(i) {
  now = (i + tabs.length) % tabs.length;
  const target = 90 * (now + 1);
  // The shortest way round, so the last moment turns on into the first.
  tip += ((((target - tip) % 360) + 540) % 360) - 180 || 0;
  for (const [k, t] of tabs.entries()) {
    t.setAttribute('aria-selected', 'false');
    t.tabIndex = k === now ? 0 : -1;
  }
  void tabs[now].offsetWidth; // the same tab again starts its ring again
  tabs[now].setAttribute('aria-selected', 'true');
  const moment = tabs[now].dataset.moment;
  hero.dataset.moment = moment;
  hero.dataset.step = String(now);
  hero.style.setProperty('--tip', `${tip}deg`);
  frame(FRAMES[moment][0]);
}

function setPlay(state) {
  hero.dataset.play = state;
  playBtn.setAttribute('aria-label', state === 'stopped' ? 'Play' : 'Pause');
  // While the moments move on by themselves, a screen reader is not told each change.
  caps.setAttribute('aria-live', state === 'stopped' ? 'polite' : 'off');
}
const stop = () => setPlay('stopped');

// The clock: the selected tab's ring (see the top of this file).
hero.addEventListener('animationend', (e) => {
  if (e.animationName !== 'arc' || e.target.closest('[role=tab]') !== tabs[now]) return;
  if (e.target.parentElement.classList.contains('ha')) {
    const next = FRAMES[tabs[now].dataset.moment][1];
    if (next) frame(next);
  } else select(now + 1);
});

// Picking a moment shows it and stops the rest; arrows, Home and End move along the tabs.
for (const [i, t] of tabs.entries()) t.addEventListener('click', () => (select(i), stop()));
tabs[0].parentElement.addEventListener('keydown', (e) => {
  const to = { ArrowRight: now + 1, ArrowDown: now + 1, ArrowLeft: now - 1, ArrowUp: now - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  select(to);
  stop();
  tabs[now].focus();
});

playBtn.addEventListener('click', () => setPlay(hero.dataset.play === 'stopped' ? 'playing' : 'stopped'));

// A tap on the phone stops it, or starts it again. A click counts as leaving it, so it is not held.
const holds = new Set();
const held = () => hero.classList.toggle('held', holds.size > 0);
stage.addEventListener('click', () => {
  holds.delete(stage);
  held();
  setPlay(hero.dataset.play === 'stopped' ? 'playing' : 'stopped');
});
for (const area of [stage, tabs[0].parentElement, caps]) {
  area.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && (holds.add(area), held()));
  area.addEventListener('pointerleave', () => (holds.delete(area), held()));
}
for (const area of [tabs[0].parentElement, caps]) {
  area.addEventListener('focusin', (e) => e.target.matches(':focus-visible') && (holds.add(e.currentTarget.className), held()));
  area.addEventListener('focusout', (e) => !area.contains(e.relatedTarget) && (holds.delete(e.currentTarget.className), held()));
}
document.addEventListener('visibilitychange', () => (document.hidden ? holds.add('hidden') : holds.delete('hidden'), held()));

// The way in, then the moments start; under reduced motion they never move by themselves.
if (still.matches) stop();
else setTimeout(() => hero.dataset.play === 'intro' && setPlay('playing'), 1500);
still.addEventListener('change', () => still.matches && stop());
