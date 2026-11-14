// Erase everything (DErase), from More: what is lost, the offer to take funds out first, what is
// removed, and a button that must be held for two seconds (a tap does nothing). Then the Erased screen,
// drawn by the app once nothing is left, or saying what could not be removed.
import { backHeader, el, icon, msgLine } from '../core/ui.js';

export const HOLD_MS = 2000;

export function eraseScreen({ t, state, nav, back, actions, format, vault, native = null }) {
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
      const out = v.refundable > 0 ? format.units(v.refundable, S.unit) : null;
      const [head, sub] = zero ? [t('erase.moneyIncoming'), t('erase.moneyIncomingSub')] : known ? [t('erase.money', { amount: v.balanceText }), t('erase.moneySub')] : [t('erase.moneyUnknown'), t('erase.moneyUnknownSub')];
      money.replaceChildren(
        el('b', { id: 'eraseMoneyHead', text: head }),
        el('p', { text: sub }),
        el('button', { type: 'button', class: 'btn gold-outline block', id: 'eraseTakeOut', onclick: () => nav('takeOut') }, icon('takeout', 20), el('span', { text: out ? t('erase.takeOut', { amount: out }) : t('erase.takeOutAny') })),
      );
      money.hidden = false;
    } else money.hidden = true;
    // eCash that is on this phone and nowhere else: taken out but not saved, or waiting to be added.
    const outs = vault.outgoing().length;
    const ins = vault.incoming().length;
    if (outs || ins) {
      unsaved.replaceChildren(
        el('b', { id: 'eraseUnsavedHead', text: t('erase.unsaved') }),
        el('p', { text: t('erase.unsavedSub') }),
        el('button', { type: 'button', class: 'btn gold-outline block', id: 'eraseSaveFirst', onclick: () => nav(outs ? 'takeOut' : 'funds') }, el('span', { text: t('erase.unsavedBtn') })),
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
  const main = el(
    'main',
    { class: 'screen sub erase', 'data-screen': 'erase' },
    backHeader(t('erase.title'), back, t('common.back')),
    el(
      'div',
      { class: 'scroll' },
      el('p', { class: 'lead', id: 'eraseLine', text: t('erase.line') }),
      money,
      unsaved,
      el('h2', { class: 'caps', text: t('erase.goes') }),
      el(
        'ul',
        { class: 'goes', id: 'eraseGoes' },
        // The Android app has no Classic app and no offline copy (its files are in the app), but it does
        // keep photo files for sharing and from its camera.
        ...(native ? ['goesConversations', 'goesSettings', 'goesKey', 'goesEcash', 'goesPhotos'] : ['goesConversations', 'goesSettings', 'goesKey', 'goesEcash', 'goesClassic', 'goesOffline']).map((k) => el('li', { text: t(`erase.${k}`) })),
      ),
      autoRow,
    ),
    el('div', { class: 'foot' }, msg, el('p', { class: 'note', id: 'eraseHoldHint', text: t('erase.holdHint') }), hold),
  );
  return { node: main, update: draw, destroy: reset, focus: main.querySelector('h1') };
}

/** The screen after Erase everything. ok: nothing was left. Its one button opens the app afresh. */
export function erasedScreen({ t, ok }) {
  const again = el('button', { type: 'button', class: 'btn primary block', id: 'erasedAgain', onclick: () => location.replace('/v2/') }, el('span', { text: t('erased.again') }));
  const main = el(
    'main',
    { class: 'screen sub erased', 'data-screen': 'erased', 'data-ok': String(ok) },
    el('div', { class: 'scroll centre' }, el('span', { class: 'tile-ico big-ico tint-teal' }, icon(ok ? 'check' : 'trash', 30)), el('h1', { tabindex: '-1', text: ok ? t('erased.title') : t('erased.notAll') }), el('p', { id: 'erasedBody', role: 'status', text: ok ? t('erased.body') : t('erased.left') })),
    el('div', { class: 'foot' }, again),
  );
  return { node: main, focus: main.querySelector('h1') };
}
