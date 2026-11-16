// The first run (C-Welcome, C-Pay, C-Limits, C-Private, approved 2026-11-14), one step per screen:
// Welcome, How you pay, What it hides, Private only, then the home. Every step can be skipped, and the
// whole guide is under More. Always on the dark Night ground, whatever the look: it is its own screen.
// Each step is the same frame: Listen, the step dots and Skip at the top; a 300 px hero whose two rings
// light a quarter more each step; a heading and its lead; the round Next button; at most one secondary
// link (none on Welcome; its row is kept so nothing moves). The detail behind Learn more and See the full
// list opens in a sheet over the step. Start free (or the invite code) is the last step's link (owner,
// 2026-11-15: once the code is in, the first run should be over), and Private only's Learn more is the
// info button on its card.
// The pure rules (steps, when it shows, which ways to pay, what Listen reads) are in core/firstrun.js.
import { nextStep, payWays, spokenFor, stepNumber, stepOf, STEPS } from '../core/firstrun.js';
import { el, icon, toast } from '../core/ui.js';
import { ART, LIT, PRIVATE_ART, RING } from './firstrun-art.js';
import { listenButton } from './parts.js';
import { codeScanner, startFree } from './startfree.js';

const NIGHT = '#0B0D10';

// The design's own icons (24 px grid), static markup from this file only.
const SVG = {
  listen: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path></svg>',
  next: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>',
  start: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>',
  info: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5.5"></path><circle cx="12" cy="7.8" r="0.6" fill="currentColor"></circle></svg>',
  list: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11"></path><path d="M9 12h11"></path><path d="M9 18h11"></path><circle cx="4.5" cy="6" r="0.9" fill="currentColor"></circle><circle cx="4.5" cy="12" r="0.9" fill="currentColor"></circle><circle cx="4.5" cy="18" r="0.9" fill="currentColor"></circle></svg>',
  padlock: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"></rect><path data-fr="mini-shackle" d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>',
};
const MINI_SHACKLE = { on: 'M8 11V8a4 4 0 0 1 8 0v3', off: 'M16 11V7a4 4 0 0 0-8 0v1' };

/** Static markup from this file as a node. */
function svg(markup) {
  const box = document.createElement('div');
  box.innerHTML = markup;
  return box.firstElementChild;
}

// How much of the rings the last step showed, so the next one fills from there.
let shownLit = null;

/**
 * ctx: t, state, actions, registry, wallet, plus
 * - step: the route param,
 * - go(step): opens another step, finish(): marks the guide seen and goes home,
 * - reader: {available(clip, pieces), read(pieces, clip) -> {done, stop()}}: the step's recorded clip, or
 *   the phone's own voice (both free, on the phone).
 * Back is the phone's own: each step is an entry in its history.
 */
export function firstRunScreen({ t, state, actions, registry, wallet, step: param, go, finish, reader, scan = null }) {
  const S = state.S;
  const step = stepOf(param);
  const n = stepNumber(step);
  const next = nextStep(step);
  const privateOn = () => !!S.settings.privateOnly;

  // Top: Listen, the step dots, Skip (not on the last step, where Start is the way out).
  const listen = el('button', { type: 'button', class: 'fr-listen', id: 'introListen', hidden: true });
  let speech = null;
  const spoken = () => spokenFor(step, privateOn());
  const words = () => spoken().keys.map((k) => t(k));
  const drawListen = () => {
    listen.hidden = !reader.available(spoken().clip, words());
    listen.setAttribute('aria-pressed', String(!!speech));
    listen.replaceChildren(speech ? icon('stop', 20) : svg(SVG.listen), el('span', { text: t(speech ? 'intro.listenStop' : 'intro.listen') }));
  };
  const stopListening = () => {
    const s = speech;
    speech = null;
    s?.stop();
    drawListen();
  };
  // The phone's voices can load after the screen is drawn.
  const synth = globalThis.speechSynthesis;
  synth?.addEventListener?.('voiceschanged', drawListen);
  listen.addEventListener('click', () => {
    if (speech) return stopListening();
    const s = reader.read(words(), spoken().clip);
    if (!s) return;
    speech = s;
    drawListen();
    s.done.catch(() => {}).finally(() => speech === s && ((speech = null), drawListen()));
  });
  const dots = el('div', { class: 'fr-dots', id: 'introStep', role: 'img', 'aria-label': t('intro.step', { n, total: STEPS.length }) }, ...STEPS.map((_, i) => el('span', { class: i + 1 === n ? 'now' : i + 1 < n ? 'done' : '' })));
  const top = el('div', { class: 'fr-top' }, listen, dots, next ? el('button', { type: 'button', class: 'fr-skip', id: 'introSkip', onclick: finish, text: t('intro.skip') }) : null);

  // The hero: the step's art, its rings filling from where the last step left them.
  const hero = el('div', { class: 'fr-hero' });
  hero.innerHTML = ART[step];
  const art = hero.firstElementChild;
  art.setAttribute('aria-label', t(`intro.${step}.art${step === 'private' ? (privateOn() ? 'On' : 'Off') : ''}`));
  fill(art, shownLit ?? 0, LIT[step]);
  shownLit = LIT[step];

  // The titles and lines are the owner's, approved as they are (2026-11-14), and Listen reads them.
  const lead = el('p', { class: 'fr-lead', id: 'introLead', 'data-approved': '' });
  const text = el('div', { class: 'fr-text' }, el('h1', { class: 'intro-title', tabindex: '-1', 'data-approved': '', text: t(`intro.${step}.title`) }), lead);

  const nextBtn = el('button', { type: 'button', class: 'fr-next', id: 'introNext', 'aria-label': t(next ? 'intro.next' : 'intro.start'), onclick: () => (next ? go(next) : finish()) }, svg(next ? SVG.next : SVG.start));
  const linkBtn = (id, ico, key, sheet) => el('button', { type: 'button', class: 'fr-link', id, 'aria-haspopup': 'dialog', onclick: () => open(sheet) }, svg(SVG[ico]), el('span', { text: t(key) }));

  const item = (ico, tint, title, sub) => el('li', { class: 'intro-item' }, el('span', { class: `tile-ico tint-${tint}` }, icon(ico, 22)), el('span', { class: 'row-text' }, el('b', { text: title }), el('small', { text: sub })));

  let link = null;
  let toggle = null;
  let update = () => {};
  const sheets = [];
  sheets.destroyers = [];
  if (step === 'welcome') lead.textContent = t('intro.welcome.lead');
  else if (step === 'pay') ({ link, update } = pay());
  else if (step === 'limits') ({ link } = limits());
  else ({ link, toggle, update } = privateOnly());

  const main = el(
    'main',
    { class: 'screen intro fr', 'data-screen': 'intro', 'data-step': step },
    top,
    hero,
    text,
    el('div', { class: 'fr-space' }),
    toggle,
    nextBtn,
    el('div', { class: 'fr-links' }, link),
    ...sheets,
  );

  /** A sheet over the step, for the detail. Closed by its button, a tap outside or Escape. head: more in its head (Listen). */
  function sheet(id, titleKey, ...content) {
    const dialog = el('dialog', { class: 'fr-sheet', id, 'aria-labelledby': `${id}Title` });
    const close = el('button', { type: 'button', class: 'fr-close', id: `${id}Close`, 'aria-label': t('intro.close'), onclick: () => dialog.close() }, icon('x', 22));
    const head = el('div', { class: 'fr-sheet-head' }, el('h2', { id: `${id}Title`, text: t(titleKey) }), close);
    dialog.head = head;
    dialog.append(el('div', { class: 'fr-sheet-in' }, head, el('div', { class: 'fr-sheet-body' }, ...content)));
    dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
    sheets.push(dialog);
    return dialog;
  }
  function open(dialog) {
    if (!dialog.open) dialog.showModal();
  }

  function pay() {
    lead.textContent = t('intro.pay.lead');
    const grid = el('ul', { class: 'way-grid', id: 'payWays' });
    const none = el('p', { class: 'note', id: 'payNone', hidden: true, text: t('intro.pay.none') });
    const s = sheet(
      'learnSheet',
      'intro.pay.sheet',
      grid,
      none,
      el('p', { class: 'note', text: t('intro.pay.more') }),
      el(
        'ul',
        { class: 'intro-list' },
        el('li', { class: 'intro-item' }, el('span', { class: 'ring-dot gold', 'aria-hidden': 'true' }), el('span', { class: 'row-text' }, el('b', { text: t('intro.pay.gold') }), el('small', { text: t('intro.pay.goldSub') }))),
        el('li', { class: 'intro-item' }, el('span', { class: 'ring-dot memory', 'aria-hidden': 'true' }), el('span', { class: 'row-text' }, el('b', { text: t('intro.pay.green') }), el('small', { text: t('intro.pay.greenSub') }))),
      ),
      el('p', { class: 'callout gold', id: 'payCash', text: t('intro.pay.cash') }),
    );
    let drawn = '';
    const update = () => {
      // The fund modules usable on this engine: the engine's methods load after the first paint. A module
      // whose row is listed but cannot be used on this phone (a card on the website) says so with usable().
      const ways = payWays(registry.list('fund').filter((x) => x.instance.available(S.methods) && x.instance.usable?.() !== false).map((x) => x.instance.id));
      const k = ways.map((w) => w.id).join(',');
      if (k === drawn && grid.childElementCount) return;
      drawn = k;
      grid.replaceChildren(...ways.map((w) => el('li', { class: 'way', 'data-way': w.id }, el('span', { class: 'tile-ico tint-gold' }, icon(w.icon, 26)), el('span', { text: t(w.key) }))));
      none.hidden = ways.length > 0;
    };
    return { link: linkBtn('learnMoreLink', 'info', 'intro.learnMore', s), update };
  }

  function limits() {
    lead.textContent = t('intro.limits.lead');
    const s = sheet(
      'learnSheet',
      'intro.limits.sheet',
      el('h3', { class: 'caps teal', text: t('intro.limits.can') }),
      el(
        'ul',
        { class: 'intro-list can', id: 'limitsCan' },
        item('lock', 'teal', t('intro.limits.questions'), t('intro.limits.questionsSub')),
        item('image', 'teal', t('intro.limits.photos'), t('intro.limits.photosSub')),
        item('user', 'teal', t('intro.limits.name'), t('intro.limits.nameSub')),
      ),
      el('h3', { class: 'caps gold', text: t('intro.limits.cannot') }),
      el(
        'ul',
        { class: 'intro-list cannot', id: 'limitsCannot' },
        item('eye', 'gold', t('intro.limits.address'), t('intro.limits.addressSub')),
        item('mic', 'gold', t('intro.limits.voice'), t('intro.limits.voiceSub')),
        item('bolt', 'gold', t('intro.limits.money'), t('intro.limits.moneySub')),
        item('keyboard', 'gold', t('intro.limits.typed'), t('intro.limits.typedSub')),
        item('phone', 'gold', t('intro.limits.watched'), t('intro.limits.watchedSub')),
        item('unlock', 'gold', t('intro.limits.unlock'), t('intro.limits.unlockSub')),
        item('bulb', 'gold', t('intro.limits.wrong'), t('intro.limits.wrongSub')),
      ),
      el('p', { class: 'note', text: t('intro.limits.always') }),
    );
    return { link: linkBtn('fullListLink', 'list', 'intro.fullList', s) };
  }

  function privateOnly() {
    // The switch is the setting itself. Off opens the padlock and says what that means. The card holds
    // the switch and, beside it, the info button for Learn more (a button cannot hold another).
    const word = el('span', { class: 'fr-toggle-state', id: 'privateState' });
    const pad = svg(SVG.padlock);
    const sw = el(
      'button',
      { type: 'button', class: 'fr-switch', id: 'privateToggle', role: 'switch', 'aria-labelledby': 'privateLabel', onclick: () => actions.setPrivateOnly(!privateOn()) },
      el('span', { class: 'fr-toggle-tile' }, pad),
      el('span', { class: 'fr-toggle-text' }, el('span', { class: 'fr-toggle-label', id: 'privateLabel', text: t('intro.private.label') }), word),
      el('span', { class: 'fr-track', 'aria-hidden': 'true' }, el('span', { class: 'fr-knob' })),
    );
    const offSub = el('p', { class: 'note', id: 'privateOffSub', text: t('intro.private.offSub') });
    const hidden = el('div', { class: 'dashed-box', id: 'privateHidden' }, el('b', { text: t('intro.private.hidden') }), el('p', { text: t('intro.private.hiddenSub') }));
    const s = sheet('learnSheet', 'intro.private.label', el('p', { class: 'note', id: 'privateMore', text: t('intro.private.onSub') }), offSub, el('p', { class: 'note', id: 'privateVoice', text: t('intro.private.voice') }), hidden);
    const info = el('button', { type: 'button', class: 'fr-info', id: 'privateInfo', 'aria-label': t('intro.private.learnMore'), 'aria-haspopup': 'dialog', onclick: () => open(s) }, svg(SVG.info));
    const toggle = el('div', { class: 'fr-toggle', id: 'privateCard' }, sw, info);
    const invite = inviteLink(() => update());
    const update = () => {
      const on = privateOn();
      const look = PRIVATE_ART[on ? 'on' : 'off'];
      sw.setAttribute('aria-checked', String(on));
      toggle.classList.toggle('off', !on);
      word.textContent = t(on ? 'intro.private.on' : 'intro.private.off');
      pad.querySelector('[data-fr=mini-shackle]').setAttribute('d', MINI_SHACKLE[on ? 'on' : 'off']);
      lead.textContent = t(on ? 'intro.private.leadOn' : 'intro.private.leadOff');
      art.setAttribute('aria-label', t(on ? 'intro.private.artOn' : 'intro.private.artOff'));
      for (const p of art.querySelectorAll('[data-fr=shackle]')) p.setAttribute('d', look.shackle);
      for (const p of art.querySelectorAll('[data-fr=glow-stop]')) p.setAttribute('stop-color', look.glow);
      for (const p of art.querySelectorAll('[data-fr=glow-fill]')) p.setAttribute('fill', look.glow);
      art.querySelector('[data-fr=hole]').setAttribute('opacity', look.hole);
      offSub.hidden = on;
      hidden.hidden = !on;
      invite.update();
    };
    return { link: invite.link, toggle, update };
  }

  /**
   * The last step's one link. While the engine has free models and the phone has no balance key: "Start
   * free with an invite" (screens/startfree.js), a sheet that opens a $0 balance with the code and then
   * asks before Private only is turned off. The answer is applied, the switch shows it, and the first run
   * is over: the home opens, the answer's words in a toast (owner, 2026-11-15: once the code is in, the
   * first run should go away). "I'll add money instead" keeps the code for funding and stays on the step.
   * Else, while the engine asks for an invite code to open a balance: "I have an invite code", the field
   * alone, kept in memory for the funding screens. A key from elsewhere: no link. redraw(): the step's update.
   */
  function inviteLink(redraw) {
    const input = el('input', { id: 'introInvite', class: 'field-input', placeholder: t('invite.placeholder'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: wallet.invite() ?? '' });
    input.addEventListener('input', () => wallet.setInvite(input.value.trim()));
    const hint = el('p', { class: 'note', id: 'introInviteHint', text: t('invite.hint') });
    // Scan beside the field: a printed code, or an event's QR code (its link gives the pass).
    const scanner = codeScanner({
      t,
      scan,
      id: 'introInvite',
      cls: 'btn sf-btn fr-scan',
      onCode: (c) => {
        input.value = c;
        wallet.setInvite(c);
        input.dispatchEvent(new Event('input'));
      },
    });
    const box = el('div', { class: 'field' }, el('label', { for: 'introInvite', class: 'sr-only', text: t('invite.label') }), el('div', { class: 'fr-code-row' }, input, scanner.button), scanner.scanner, hint);
    const done = el('button', { type: 'button', class: 'btn primary block', id: 'introInviteDone', onclick: () => s.close(), text: t('intro.inviteDone') });
    const answered = (words) => {
      redraw();
      toast(words, 4000);
      finish();
    };
    const free = startFree({ t, state, actions, wallet, reader }, { id: 'intro', field: { input, box }, after: answered });
    const money = el('button', { type: 'button', class: 'fr-link fr-money', id: 'introAddMoney', onclick: () => (wallet.setInvite(input.value.trim()), s.close()) }, icon('coins', 20), el('span', { text: t('startFree.money') }));
    const s = sheet('inviteSheet', 'invite.label', box, free.node, money, done);
    const title = s.querySelector('h2');
    let shown = null;
    // Listen in the sheet's head: the title and its line, or the question once it is asked.
    const sheetListen = listenButton({ t, reader, id: 'inviteListen', pieces: () => [title.textContent, shown ? t('startFree.note') : t('invite.hint')] });
    // While the question shows, it has its own Listen (startFree): the head's steps aside.
    const listenSlot = el('span', { class: 'fr-sheet-listen' }, sheetListen.node);
    s.head.insertBefore(listenSlot, s.head.lastChild);
    s.addEventListener('close', () => (sheetListen.stop(), scanner.stop()));
    sheets.destroyers.push(() => (sheetListen.destroy(), free.destroy?.()));
    // The way to Start free is a clear choice beside the round Start (owner, 2026-11-15): a picture, a
    // short word and what it needs, never a grey link.
    const label = el('b', { class: 'fr-choice-word', text: t('intro.inviteLink') });
    const sub = el('small', { class: 'fr-choice-sub' });
    let ico = icon('ticket', 24);
    const tile = el('span', { class: 'fr-choice-ico', 'aria-hidden': 'true' }, ico);
    const link = el('button', { type: 'button', class: 'fr-choice', id: 'introInviteLink', 'aria-haspopup': 'dialog', onclick: () => open(s) }, tile, el('span', { class: 'fr-choice-text' }, label, sub));
    const update = () => {
      // Start free while the sheet shows it: a key opened here keeps the sheet's own words until the
      // question is answered.
      const busy = free.busy();
      const free0 = !!S.methods?.open?.enabled && (!wallet.key() || busy);
      link.hidden = (!!wallet.key() && !busy) || !(wallet.inviteOnly() || free0);
      if (free0 !== shown) {
        shown = free0;
        label.textContent = t(free0 ? 'startFree.title' : 'intro.inviteLink');
        sub.textContent = free0 ? t('intro.startFreeSub') : '';
        sub.hidden = !free0;
        link.classList.toggle('free', free0);
        link.setAttribute('aria-label', t(free0 ? 'startFree.link' : 'intro.inviteLink'));
        const swap = icon(free0 ? 'gift' : 'ticket', 24);
        ico.replaceWith(swap);
        ico = swap;
        title.textContent = t(free0 ? 'startFree.title' : 'invite.label');
      }
      sheetListen.update();
      listenSlot.hidden = free.busy();
      hint.hidden = free0 || !wallet.inviteOnly();
      free.node.hidden = !free0;
      money.hidden = !free0 || busy;
      done.hidden = free0;
      if (free0) free.update();
    };
    return { link, update };
  }

  // The first run is dark on every look: the phone's bars match it while it shows.
  const bar = document.querySelector('meta[name="theme-color"]');
  bar?.setAttribute('content', NIGHT);

  const all = () => {
    update();
    drawListen();
  };
  all();
  return {
    node: main,
    update: all,
    destroy: () => {
      stopListening();
      synth?.removeEventListener?.('voiceschanged', drawListen);
      for (const s of sheets) if (s.open) s.close();
      for (const d of sheets.destroyers) d();
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (bg) bar?.setAttribute('content', bg);
    },
    focus: main.querySelector('h1'),
  };
}

/** The dash for `share` of a ring of radius r (the design's own lengths). */
const dash = (r, share) => `${share >= 1 ? RING[r] : Math.round(share * RING[r] * 10) / 10} ${RING[r]}`;

/**
 * Fills the art's rings from `from` to `to` (shares of the circle), gently, unless the phone asks for
 * reduced motion; the end dots fade in once the fill arrives. The art's own lengths are the end state.
 */
function fill(art, from, to) {
  if (from === to || typeof art.animate !== 'function') return;
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const timing = { duration: 700, easing: 'cubic-bezier(.2, .8, .2, 1)' };
  for (const c of art.querySelectorAll('.fr-arc')) {
    const r = Number(c.getAttribute('r'));
    c.animate([{ strokeDasharray: dash(r, from) }, { strokeDasharray: dash(r, to) }], timing);
  }
  for (const c of art.querySelectorAll('.fr-tip')) c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: c.getAttribute('opacity') ?? 1 }], { duration: 900 });
}
