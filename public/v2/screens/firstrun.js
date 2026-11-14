// The first run (DWelcome, DHowPay, DLimits, DPrivateOnly), one step per screen: Welcome, How you pay,
// What it can and cannot hide, Private only, then the home. Every step can be skipped, and the whole
// guide is under More. Built from the canvas tokens: the Listen chip top right, a plain Back top left
// from step 2, the primary button and "Step n of 4" at the foot.
// The pure rules (steps, when it shows, which ways to pay) are in core/firstrun.js.
import { nextStep, payWays, prevStep, stepNumber, stepOf, STEPS } from '../core/firstrun.js';
import { el, icon } from '../core/ui.js';

/**
 * ctx: t, state, actions, registry, wallet, plus
 * - step: the route param,
 * - go(step): opens another step, finish(): marks the guide seen and goes home, stepBack(): back a step,
 * - reader: {available(), read(pieces) -> {done, stop()}}, the phone's own voice (free, on the phone).
 */
export function firstRunScreen({ t, state, actions, registry, wallet, step: param, go, finish, stepBack, reader }) {
  const S = state.S;
  const step = stepOf(param);
  const n = stepNumber(step);
  const next = nextStep(step);

  const item = (ico, tint, title, sub) => el('li', { class: 'intro-item' }, el('span', { class: `tile-ico tint-${tint}` }, icon(ico, 22)), el('span', { class: 'row-text' }, el('b', { text: title }), el('small', { text: sub })));

  const listen = el('button', { type: 'button', class: 'listen-chip', id: 'introListen', hidden: true });
  let speech = null;
  const drawListen = () => {
    listen.hidden = !reader.available();
    listen.setAttribute('aria-pressed', String(!!speech));
    listen.replaceChildren(icon(speech ? 'stop' : 'speaker', 18), el('span', { text: t(speech ? 'intro.listenStop' : 'intro.listen') }));
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
    const s = reader.read(words());
    if (!s) return;
    speech = s;
    drawListen();
    s.done.catch(() => {}).finally(() => speech === s && ((speech = null), drawListen()));
  });

  const top = el(
    'div',
    { class: 'intro-top' },
    prevStep(step) ? el('button', { type: 'button', class: 'btn text', id: 'introBack', onclick: () => stepBack(prevStep(step)) }, icon('back', 18), el('span', { text: t('intro.back') })) : el('span', { class: 'wordmark', text: t('app.name') }),
    el('span', { class: 'intro-top-end' }, listen, el('button', { type: 'button', class: 'btn text', id: 'introSkip', onclick: finish, text: t('intro.skip') })),
  );

  let body;
  let update = () => {};
  if (step === 'welcome') ({ body, update } = welcome());
  else if (step === 'pay') ({ body, update } = pay());
  else if (step === 'limits') body = limits();
  else ({ body, update } = privateOnly());

  const primary = el('button', { type: 'button', class: 'btn primary block', id: 'introNext', text: t(next ? 'intro.continue' : 'intro.start'), onclick: () => (next ? go(next) : finish()) });
  const main = el(
    'main',
    { class: 'screen intro', 'data-screen': 'intro', 'data-step': step },
    top,
    el('div', { class: 'scroll intro-body' }, body),
    el('div', { class: 'foot' }, primary, el('p', { class: 'note center', id: 'introStep', text: t('intro.step', { n, total: STEPS.length }) })),
  );

  function welcome() {
    // An invite code, only while this engine asks for one to open a balance. Kept in memory for the
    // funding screens, as they keep it.
    const input = el('input', { id: 'introInvite', class: 'field-input', placeholder: t('invite.placeholder'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: wallet.invite() ?? '' });
    input.addEventListener('input', () => wallet.setInvite(input.value.trim()));
    const invite = el('div', { class: 'field', id: 'introInviteField', hidden: true }, el('label', { for: 'introInvite', class: 'label', text: t('invite.label') }), input, el('p', { class: 'note', text: t('invite.hint') }));
    const node = el(
      'div',
      { class: 'intro-content' },
      el('h1', { class: 'intro-title', tabindex: '-1', text: t('intro.welcome.title') }),
      el(
        'ul',
        { class: 'intro-list' },
        item('user', 'teal', t('intro.welcome.account'), t('intro.welcome.accountSub')),
        item('coins', 'gold', t('intro.welcome.cash'), t('intro.welcome.cashSub')),
        item('lock', 'teal', t('intro.welcome.sealed'), t('intro.welcome.sealedSub')),
        item('phone', 'blue', t('intro.welcome.phone'), t('intro.welcome.phoneSub')),
      ),
      invite,
    );
    return { body: node, update: () => (invite.hidden = !!wallet.key() || !wallet.inviteOnly()) };
  }

  function pay() {
    const grid = el('ul', { class: 'way-grid', id: 'payWays' });
    const none = el('p', { class: 'note', id: 'payNone', hidden: true, text: t('intro.pay.none') });
    const node = el(
      'div',
      { class: 'intro-content' },
      el('h1', { class: 'intro-title', tabindex: '-1', text: t('intro.pay.title') }),
      el('p', { class: 'intro-lead', text: t('intro.pay.lead') }),
      el('h2', { class: 'caps gold', text: t('intro.pay.ways') }),
      grid,
      none,
      el('p', { class: 'note', text: t('intro.pay.more') }),
      el(
        'ul',
        { class: 'intro-list' },
        el('li', { class: 'intro-item' }, el('span', { class: 'ring-dot gold', 'aria-hidden': 'true' }), el('span', { class: 'row-text' }, el('b', { text: t('intro.pay.gold') }), el('small', { text: t('intro.pay.goldSub') }))),
        el('li', { class: 'intro-item' }, el('span', { class: 'ring-dot memory', 'aria-hidden': 'true' }), el('span', { class: 'row-text' }, el('b', { text: t('intro.pay.green') }), el('small', { text: t('intro.pay.greenSub') }))),
      ),
      el('p', { class: 'callout gold', text: t('intro.pay.cash') }),
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
    return { body: node, update };
  }

  function limits() {
    return el(
      'div',
      { class: 'intro-content' },
      el('h1', { class: 'intro-title', tabindex: '-1', text: t('intro.limits.title') }),
      el('h2', { class: 'caps teal', text: t('intro.limits.can') }),
      el(
        'ul',
        { class: 'intro-list can', id: 'limitsCan' },
        item('lock', 'teal', t('intro.limits.questions'), t('intro.limits.questionsSub')),
        item('image', 'teal', t('intro.limits.photos'), t('intro.limits.photosSub')),
        item('user', 'teal', t('intro.limits.name'), t('intro.limits.nameSub')),
      ),
      el('h2', { class: 'caps gold', text: t('intro.limits.cannot') }),
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
  }

  function privateOnly() {
    // The panel's heading is the state itself: On or Off.
    const stateHead = el('b', { id: 'privateState' });
    const sub = el('p', { id: 'privateSub' });
    const turnOn = el('button', { type: 'button', class: 'btn primary', id: 'privateTurnOn', hidden: true, onclick: () => actions.setPrivateOnly(true), text: t('intro.private.turnOn') });
    const hidden = el('div', { class: 'dashed-box', id: 'privateHidden' }, el('b', { text: t('intro.private.hidden') }), el('p', { text: t('intro.private.hiddenSub') }));
    const node = el(
      'div',
      { class: 'intro-content' },
      el('h1', { class: 'intro-title', tabindex: '-1', text: t('intro.private.title') }),
      el('section', { class: 'teal-panel intro-panel', id: 'privatePanel', 'aria-labelledby': 'privateState' }, el('div', { class: 'teal-panel-head' }, icon('lock', 22), stateHead), sub, turnOn),
      el('p', { class: 'note', id: 'privateVoice', text: t('intro.private.voice') }),
      hidden,
    );
    const update = () => {
      const on = !!S.settings.privateOnly;
      stateHead.textContent = t(on ? 'intro.private.on' : 'intro.private.off');
      node.querySelector('#privatePanel').classList.toggle('off', !on);
      sub.textContent = t(on ? 'intro.private.onSub' : 'intro.private.offSub');
      turnOn.hidden = on;
      hidden.hidden = !on;
    };
    return { body: node, update };
  }

  /** What Listen reads: the words shown on this step, top to bottom. */
  function words() {
    const shown = [...body.querySelectorAll('h1, h2, b, small, p, .way > span:last-child')].filter((n) => !n.closest('[hidden]'));
    return shown.map((n) => n.textContent.trim()).filter(Boolean);
  }

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
    },
    focus: main.querySelector('h1'),
  };
}
