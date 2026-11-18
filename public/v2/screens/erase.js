// Erase everything (DErase), from More: what is lost, the offer to take funds out first, what is
// removed, and a button that must be held for two seconds (a tap does nothing). Then the Erased screen,
// drawn by the app once nothing is left, or saying what could not be removed.
import { el, icon, msgLine, sayEl } from '../core/ui.js';
import { listenHeader, screenListen } from './parts.js';

export const HOLD_MS = 2000;

// What Erase removes, each with its picture.
const GOES_ICON = { goesConversations: 'chat', goesSettings: 'sun', goesKey: 'lock', goesEcash: 'coins', goesClassic: 'grid', goesOffline: 'download', goesPhotos: 'image' };

export function eraseScreen({ t, state, nav, back, actions, format, vault, reader, native = null, cardJobs = () => 0, tillJobs = () => 0 }) {
  const S = state.S;
  const money = el('section', { class: 'warn-box', id: 'eraseMoney', 'aria-labelledby': 'eraseMoneyHead' });
  const unsaved = el('section', { class: 'warn-box', id: 'eraseUnsaved', 'aria-labelledby': 'eraseUnsavedHead' });
  const autoRow = el('button', { type: 'button', class: 'setting-row', id: 'eraseAuto', onclick: () => nav('history') });
  const msg = msgLine();
  const label = el('span', { text: t('erase.hold') });
  const hold = el('button', { type: 'button', class: 'btn danger-fill block hold', id: 'eraseHold', 'aria-describedby': 'eraseHoldHint' }, icon('trash', 20), label);

  const draw = () => {
    const v = state.view();
    // Money first: the balance this phone holds the key to, and how to take it out. Shown whenever there
    // is a key, even at zero: a deposit still on its way (on-chain, say) is added to this balance later,
    // and once the key is gone nobody can spend it.
    if (v.hasKey) {
      const known = v.balanceText != null;
      const zero = v.balanceMsub === 0;
      // One balance with money: its own Take out. Two: Funds, where each has its row and its Take out.
      const one = v.balances.length === 1 ? v.balances[0] : null;
      const out = one?.refundable > 0 ? format.units(one.refundable, one.unit) : null;
      const [head, sub] = zero ? [t('erase.moneyIncoming'), t('erase.moneyIncomingSub')] : known ? [t('erase.money', { amount: v.balanceText }), t('erase.moneySub')] : [t('erase.moneyUnknown'), t('erase.moneyUnknownSub')];
      money.replaceChildren(
        el('b', { id: 'eraseMoneyHead', text: head }),
        sayEl('p', { id: 'eraseMoneySub' }, sub, '', 'alert'),
        el('button', { type: 'button', class: 'btn gold-outline block', id: 'eraseTakeOut', onclick: () => nav(v.balances.length > 1 ? 'funds' : 'takeOut') }, icon('takeout', 20), el('span', { text: out ? t('erase.takeOut', { amount: out }) : t('erase.takeOutAny') })),
      );
      money.hidden = false;
    } else money.hidden = true;
    // eCash that is on this phone and nowhere else: taken out but not saved, or waiting to be added.
    const outs = vault.outgoing().length;
    const ins = vault.incoming().length;
    // A card payment not finished, or change owed to a card: only this phone can finish it.
    const cards = cardJobs();
    // A Fedimint card payment the till has not settled, or money the till holds for a card.
    const tills = tillJobs();
    if (outs || ins || cards || tills) {
      unsaved.replaceChildren(
        ...[
          el('b', { id: 'eraseUnsavedHead', text: t('erase.unsaved') }),
          outs || ins ? sayEl('p', { id: 'eraseUnsavedSub' }, t('erase.unsavedSub'), '', 'alert') : null,
          cards ? sayEl('p', { id: 'eraseCards' }, t('erase.cardsSub'), '', 'card') : null,
          tills ? sayEl('p', { id: 'eraseTill' }, t('erase.tillSub'), '', 'card') : null,
          el('button', { type: 'button', class: 'btn gold-outline block', id: 'eraseSaveFirst', onclick: () => (outs ? nav('takeOut') : ins ? nav('funds') : cards ? nav('fund', { id: 'card' }) : nav('fund', { id: 'fedimint' })) }, icon('takeout', 20), el('span', { text: t('erase.unsavedBtn') })),
        ].filter(Boolean),
      );
      unsaved.hidden = false;
    } else unsaved.hidden = true;
    autoRow.replaceChildren(el('span', {}, icon('clock', 20), el('span', { text: t('erase.auto') })), el('span', { class: 'value', text: t(`auto.${S.settings.autoDelete}`) }));
  };

  // ------------------------------------------------------------ hold to erase
  let timer = 0;
  let raf = 0;
  let started = 0;
  let fired = false;
  const reset = () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    timer = 0;
    hold.classList.remove('holding');
    hold.style.setProperty('--p', '0');
    if (!fired) label.textContent = t('erase.hold');
  };
  const frame = () => {
    hold.style.setProperty('--p', String(Math.min(1, (performance.now() - started) / HOLD_MS)));
    raf = requestAnimationFrame(frame);
  };
  const begin = () => {
    if (fired || timer) return;
    started = performance.now();
    msg.set('');
    hold.classList.add('holding');
    label.textContent = t('erase.keepHolding');
    raf = requestAnimationFrame(frame);
    timer = setTimeout(async () => {
      timer = 0;
      fired = true;
      cancelAnimationFrame(raf);
      hold.style.setProperty('--p', '1');
      hold.disabled = true;
      label.textContent = t('erase.erasing');
      await actions.eraseEverything();
    }, HOLD_MS);
  };
  const end = () => {
    if (fired) return;
    const short = timer && performance.now() - started < HOLD_MS;
    reset();
    if (short) msg.set(t('erase.tapped'), 'err');
  };
  hold.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    hold.setPointerCapture?.(e.pointerId);
    begin();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) hold.addEventListener(ev, end);
  hold.addEventListener('contextmenu', (e) => e.preventDefault());
  hold.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) begin();
  });
  hold.addEventListener('keyup', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    end();
  });
  // A click never erases: only the two-second hold does.
  hold.addEventListener('click', (e) => e.preventDefault());

  draw();
  const listen = screenListen({ t, reader, id: 'eraseListen', root: () => main });
  const main = el(
    'main',
    { class: 'screen sub erase', 'data-screen': 'erase' },
    listenHeader(t('erase.title'), back, t('common.back'), listen.node),
    el(
      'div',
      { class: 'scroll' },
      sayEl('p', { class: 'lead', id: 'eraseLine' }, t('erase.line'), '', 'alert'),
      money,
      unsaved,
      el('h2', { class: 'caps', text: t('erase.goes') }),
      el(
        'ul',
        { class: 'goes', id: 'eraseGoes' },
        // The apps have no Classic app and no offline copy (their files are in the app). The Android app
        // keeps photo files for sharing and from its camera; the iPhone app writes none (native.forget).
        ...['goesConversations', 'goesSettings', 'goesKey', 'goesEcash', ...(!native ? ['goesClassic', 'goesOffline'] : native.forget ? ['goesPhotos'] : [])].map((k) => sayEl('li', { id: `erase-${k}` }, t(`erase.${k}`), '', GOES_ICON[k])),
      ),
      autoRow,
    ),
    el('div', { class: 'foot' }, msg, sayEl('p', { class: 'note', id: 'eraseHoldHint' }, t('erase.holdHint'), '', 'hand'), hold),
  );
  listen.update();
  return { node: main, update: draw, destroy: () => (reset(), listen.destroy()), focus: main.querySelector('h1') };
}

/** The screen after Erase everything. ok: nothing was left. Its one button opens the app afresh. */
export function erasedScreen({ t, ok }) {
  const again = el('button', { type: 'button', class: 'btn primary block', id: 'erasedAgain', onclick: () => location.replace('/v2/') }, icon('again', 20), el('span', { text: t('erased.again') }));
  const main = el(
    'main',
    { class: 'screen sub erased', 'data-screen': 'erased', 'data-ok': String(ok) },
    el('div', { class: 'scroll centre' }, el('span', { class: 'tile-ico big-ico tint-teal' }, icon(ok ? 'check' : 'trash', 30)), el('h1', { tabindex: '-1', text: ok ? t('erased.title') : t('erased.notAll') }), sayEl('p', { id: 'erasedBody', role: 'status' }, ok ? t('erased.body') : t('erased.left'), ok ? 'ok' : 'err')),
    el('div', { class: 'foot' }, again),
  );
  return { node: main, focus: main.querySelector('h1') };
}
