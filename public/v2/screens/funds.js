// Funds and memory (ZBoth, with the add area of AddFunds-C4), one funding method (a fund module), and
// Take funds out (refund as eCash, kept on the phone until the person says they saved it). Add money
// itself is the wallet cards (screens/wallet.js).
import { backHeader, copy, el, icon, msgLine, say, sayEl, toast } from '../core/ui.js';
import { cardRing, listenButton, listenHeader, screenListen } from './parts.js';
import { takeSaid } from './startfree.js';
import { fundsRing } from './wallet-art.js';
import { cardStack } from './wallet.js';

export function fundsScreen(ctx) {
  const { t, state, nav, back, actions, format, vault, reader } = ctx;
  const S = state.S;
  // What Start free said when it chose the free model (AddFunds-C4), once.
  const said = takeSaid();
  const done = el('div', { class: 'funds-said', id: 'fundsSaid', role: 'status', hidden: !said }, el('span', { class: 'funds-said-ico' }, icon('check', 16, 3)), sayEl('p', { id: 'fundsSaidText' }, said ?? ''));
  const fr = fundsRing();
  const mr = cardRing('memory-track', 'memory');
  const amount = el('div', { class: 'big', id: 'fundsAmount' });
  // On a free model at $0, the ring's centre is teal and says FREE (AddFunds-C4).
  const freeTag = el('span', { class: 'funds-free-tag', id: 'fundsFreeTag', hidden: true, text: t('funds.freeTag') });
  const ringBox = el('div', { class: 'funds-ring' }, fr.node, el('div', { class: 'funds-ring-mid' }, amount, freeTag));
  const fundsNote = el('p', { class: 'note', id: 'fundsNote' });
  const refundable = el('p', { class: 'note', id: 'refundable' });
  // Free questions (credits): counted apart from the money, and never taken out as money.
  const freeNote = el('p', { class: 'note free-note', id: 'fundsFree', hidden: true });
  const freeModel = el('button', { type: 'button', class: 'btn small', id: 'fundsUseFree', hidden: true, onclick: () => actions.useFreeModel() }, icon('gift', 18), el('span', { text: t('funds.useFreeModel') }));
  const memFree = el('div', { class: 'big', id: 'memoryFree' });
  const memNote = el('p', { class: 'note', id: 'memoryNote' });
  const items = el('ul', { class: 'held', id: 'heldItems' });
  // Take funds out: an icon button on the funds card (its screen is unchanged).
  const outBtn = el('button', { type: 'button', class: 'round funds-out', id: 'takeOutBtn', 'aria-label': t('out.title'), title: t('out.title'), onclick: () => nav('takeOut') }, icon('takeout', 22));
  const vaultBox = el('div', { class: 'vault-box', id: 'vaultBox' });
  // Ask now, on a free model at $0: questions are free, so the next thing is to ask.
  const askBtn = el('button', { type: 'button', class: 'funds-ask', id: 'fundsAsk', hidden: true, onclick: () => nav('home') }, el('span', { class: 'funds-ask-ico' }, icon('mic', 34, 1.8)), el('span', { text: t('funds.ask') }));
  // Add money: the fanned cards, opening the wallet cards.
  const stack = cardStack(ctx);
  const fundsCard = el(
    'section',
    { class: 'card big-card funds-card', 'aria-labelledby': 'fundsCap' },
    el('div', { class: 'funds-top' }, el('h2', { class: 'caps gold', id: 'fundsCap', text: t('funds.funds') }), outBtn),
    ringBox,
    el('div', { class: 'funds-notes' }, fundsNote, refundable, freeNote, freeModel),
  );
  const memCard = el(
    'section',
    { class: 'card big-card', 'aria-labelledby': 'memCap' },
    el('div', { class: 'card-top' }, mr.node, el('div', {}, el('h2', { class: 'caps teal', id: 'memCap', text: t('funds.memory') }), memFree, memNote)),
    items,
    el(
      'div',
      { class: 'card-btns' },
      el('button', { type: 'button', class: 'btn soft', id: 'memAddBtn', onclick: () => nav('add') }, icon('plus', 20), el('span', { text: t('funds.add') })),
      el('button', { type: 'button', class: 'btn primary', id: 'startFresh', onclick: () => (actions.startFresh(), toast(t('funds.started'))) }, icon('trash', 20), el('span', { text: t('funds.startFresh') })),
    ),
  );
  const listen = listenButton({ t, reader, id: 'fundsListen', pieces: () => [amount.textContent, freeTag.hidden ? '' : t('funds.freeTag'), said ?? '', fundsNote.textContent, freeNote.hidden ? '' : freeNote.textContent] });
  const main = el('main', { class: 'screen sub funds', 'data-screen': 'funds' }, listenHeader(t('funds.title'), back, t('common.back'), listen.node), el('div', { class: 'scroll' }, done, vaultBox, fundsCard, askBtn, stack.node, memCard));

  const vaultRows = () => {
    const rows = [];
    for (const e of vault.incoming()) {
      const refused = e.state === 'refused';
      // Other-mint tokens settle when the engine answers (the app looks them up on start and on Funds).
      // Once the token was taken, copying it is no use, so those rows have no Copy button.
      const taken = !refused && e.via === 'othermint' && (e.code === 'change_pending' || e.code === 'refund_pending');
      const [title, sub] = refused
        ? [t('funds.notAdded'), t('funds.notAddedSub', { message: e.message ?? '' })]
        : e.via === 'free'
          ? [t('funds.freeWaiting'), t('funds.waitingSub')]
          : e.via === 'othermint'
          ? e.code === 'change_pending'
            ? [t('funds.changeWaiting'), t('funds.changeWaitingSub')]
            : e.code === 'refund_pending'
              ? [t('funds.notAdded'), t('funds.refundWaitingSub')]
              : [t('funds.waiting'), t('funds.waitingOther')]
          : [t('funds.waiting'), t('funds.waitingSub')];
      rows.push(
        el(
          'div',
          { class: `vault-row ${refused ? 'refused' : 'waiting'}`, 'data-vault-in': e.id },
          el('b', { text: title }),
          sayEl('p', {}, sub),
          el(
            'div',
            { class: 'row-btns' },
            taken ? null : el('button', { type: 'button', class: 'btn small', onclick: async () => toast((await copy(e.token)) ? t('answer.copied') : t('answer.copyFailed')) }, icon('copy', 18), el('span', { text: t('funds.copyToken') })),
            refused
              ? el('button', {
                  type: 'button',
                  class: 'btn small danger',
                  onclick: () => {
                    if (window.confirm(t('funds.removeConfirm'))) {
                      vault.discard(e.id);
                      update();
                    }
                  },
                }, icon('trash', 18), el('span', { text: t('funds.removeToken') }))
              : null,
          ),
        ),
      );
    }
    for (const o of vault.outgoing()) {
      rows.push(
        el(
          'div',
          { class: 'vault-row waiting', 'data-vault-out': o.id },
          // eCash that came back from another mint has no amount the phone knows.
          el('b', { text: o.amount == null ? t('funds.returned') : t('funds.unsaved') }),
          sayEl('p', {}, o.amount == null ? t('funds.unsavedSubReturned') : t('funds.unsavedSub', { amount: format.units(o.amount, o.unit) })),
          el('div', { class: 'row-btns' }, el('button', { type: 'button', class: 'btn small', onclick: () => nav('takeOut') }, icon('takeout', 18), el('span', { text: t('out.title') }))),
        ),
      );
    }
    vaultBox.replaceChildren(...rows);
    vaultBox.hidden = !rows.length;
  };

  const update = () => {
    const v = state.view();
    amount.textContent = v.balanceText ?? format.units(0, S.unit ?? 'usd');
    // A free model at $0: the ring's centre is teal and says FREE, and Ask now leads.
    const freeZero = v.modelFree && !(v.balanceMsub > 0);
    fr.set(v.fundsFraction, v.freeFraction, freeZero);
    freeTag.hidden = !freeZero;
    ringBox.classList.toggle('free', freeZero);
    askBtn.hidden = !(freeZero && v.hasKey);
    // A free model costs nothing: never "not enough" for it.
    say(fundsNote, !v.hasKey ? (v.freeLeft > 0 ? '' : v.modelFree ? t('funds.needKey') : t('funds.empty')) : v.modelFree ? t('funds.modelFree') : v.questionsLeft > 0 ? t('funds.enough', { count: format.int(v.questionsLeft) }) : t('funds.notEnough'));
    fundsNote.hidden = !fundsNote.textContent;
    freeNote.hidden = !(v.freeLeft > 0) && v.fundsBlock !== 'freeOut';
    freeNote.textContent = v.freeLeft > 0 ? t(v.freeLeft === 1 ? 'funds.freeLeftOne' : 'funds.freeLeft', { count: v.freeLeft }) : v.fundsBlock === 'freeOut' ? t('funds.freeUsed') : '';
    freeModel.hidden = v.fundsBlock !== 'freeModel';
    refundable.textContent = v.refundable > 0 ? t('funds.refundable', { amount: format.units(v.refundable, S.unit) }) : '';
    refundable.hidden = !refundable.textContent;
    // With nothing to take out and nothing waiting to be saved, there is no dead button.
    outBtn.hidden = !(v.refundable > 0) && !vault.outgoing().length;
    stack.update();
    listen.update();
    mr.set(v.memory.free, v.memory.low ? 'low' : 'memory');
    memFree.textContent = t('funds.free', { percent: v.memory.percentFree });
    const held = v.held;
    memNote.textContent = held.length === 0 ? t('funds.holdingNone') : held.length === 1 ? t('funds.holdingOne') : t('funds.holding', { count: held.length });
    items.replaceChildren(
      ...held.map((h) =>
        el(
          'li',
          { class: 'held-item' },
          el('span', { class: `tile-ico small tint-${h.kind === 'image' ? 'gold' : h.kind === 'conversation' ? 'violet' : 'blue'}` }, icon(h.kind === 'image' ? 'image' : h.kind === 'conversation' ? 'chat' : 'file', 18)),
          el('span', { class: 'held-text' }, el('b', { text: h.kind === 'conversation' ? t('funds.conversation') : h.name }), el('span', { class: 'bar' }, el('span', { style: `width:${Math.max(2, Math.round(h.share * 100))}%` }))),
          el('button', { type: 'button', class: 'round small', 'aria-label': t('funds.remove', { name: h.kind === 'conversation' ? t('funds.conversation') : h.name }), onclick: () => (h.kind === 'conversation' ? actions.forgetConversation() : actions.removePending(h.id)) }, icon('x', 16)),
        ),
      ),
    );
    vaultRows();
  };
  update();
  return { node: main, update, destroy: listen.destroy, focus: main.querySelector('h1') };
}

// A token handed from one fund module to another (a note from another mint goes to Other mint). Kept
// in memory only, for the one screen change; it is not stored, since the note it came from still has it.
let handoff = null;

/**
 * Hosts one fund module's view. The module builds its own body from the inputs it was given.
 * open(id, {token}) switches to another fund module and hands it the token.
 */
export function fundScreen({ t, state, nav, back, backTo, registry, reader }, { id }) {
  const given = handoff?.id === id ? handoff : null;
  handoff = null;
  const entry = registry.list('fund').find((x) => x.instance.id === id);
  if (!entry || !entry.instance.available(state.S.methods)) {
    const main = el('main', { class: 'screen sub', 'data-screen': 'fund' }, backHeader(t('ways.title'), back, t('common.back')), sayEl('p', { class: 'hint pad' }, t('addFunds.unavailable'), '', 'alert'));
    return { node: main, focus: main.querySelector('h1') };
  }
  const open = (to, { token } = {}) => {
    handoff = { id: to, token };
    nav('fund', { id: to }, { replace: true });
  };
  const view = entry.instance.view({ done: () => backTo('funds'), open, token: given?.token });
  const listen = screenListen({ t, reader, id: 'fundListen', root: () => main });
  const main = el('main', { class: 'screen sub fund', 'data-screen': 'fund', 'data-fund': id }, listenHeader(t(`fund.${id}.name`), back, t('common.back'), listen.node), view.node);
  listen.update();
  return { node: main, update: () => (view.update?.(), listen.update()), destroy: () => (view.destroy?.(), listen.destroy()), focus: main.querySelector('h1') };
}

export function takeOutScreen({ t, state, back, actions, format, vault, qr, wallet, reader }) {
  const S = state.S;
  const msg = msgLine();
  const out = el('div', { class: 'token-out', id: 'tokenOut' });
  const input = el('input', { id: 'outAmount', class: 'field-input', inputmode: 'decimal', autocomplete: 'off', 'aria-label': t('out.amountLabel') });
  const go = el('button', { type: 'button', class: 'btn primary block', id: 'outBtn' }, icon('takeout', 20), el('span', { text: t('out.create') }));
  const lock = wallet.lockKey();
  const form = el(
    'div',
    { class: 'form' },
    sayEl('p', { id: 'outWhat' }, t('out.what'), '', 'coins'),
    lock ? sayEl('p', { class: 'note', id: 'outLocked' }, t('out.locked', { key: `${lock.slice(0, 10)}...${lock.slice(-6)}` }), '', 'lock') : null,
    el('p', { class: 'note', id: 'outAll' }),
    el('label', { for: 'outAmount', class: 'label', text: t('out.amountLabel') }),
    input,
    msg,
  );
  let players = [];
  const stopPlayers = () => {
    for (const p of players) p.stop();
    players = [];
  };
  const showToken = (o) => {
    const box = el('div', { class: 'qr', role: 'img', 'aria-label': t('out.qr') });
    const parts = el('p', { class: 'note' });
    const long = o.token.length > qr.STATIC_MAX;
    (long ? qr.playAnimatedQR(box, o.token).then((p) => (players.push(p), say(parts, t('out.parts', { count: p.parts }), '', 'qr'))) : qr.renderQR(box, o.token, 'L')).catch(() => {});
    return el(
      'div',
      { class: 'token-card', 'data-token-id': o.id },
      el('b', { text: o.amount == null ? t('out.readyReturned') : t('out.ready', { amount: format.units(o.amount, o.unit) }) }),
      box,
      parts,
      sayEl('p', { class: 'note' }, t('out.keep'), '', 'phone'),
      el('div', { class: 'row-btns' }, el('button', { type: 'button', class: 'btn', onclick: async () => toast((await copy(o.token)) ? t('out.copied') : t('answer.copyFailed')) }, icon('copy', 18), el('span', { text: t('out.copy') })), el('button', { type: 'button', class: 'btn primary', 'data-saved': o.id, onclick: () => (vault.saved(o.id), draw()) }, icon('check', 20), el('span', { text: t('out.saved') }))),
      el('textarea', { class: 'field-input mono', readonly: true, rows: '3', 'aria-label': t('out.copy'), text: o.token }),
    );
  };
  let shown = null;
  const draw = () => {
    const v = state.view();
    const kept = vault.outgoing();
    // Rebuild the codes only when the kept tokens change, not on every balance update.
    const ids = kept.map((o) => o.id).join(',');
    if (ids !== shown) {
      shown = ids;
      stopPlayers();
      out.replaceChildren(...kept.map(showToken));
    }
    const can = v.refundable > 0;
    form.hidden = !can;
    go.hidden = !can;
    if (can) {
      form.querySelector('#outAll').textContent = t('out.all', { amount: format.units(v.refundable, S.unit) });
      if (!input.value) input.value = format.plain(v.refundable, S.unit);
    }
    if (!can && !kept.length) {
      shown = null;
      out.replaceChildren(el('p', { class: 'hint', id: 'outNone', text: t('out.none') }));
    }
  };
  go.addEventListener('click', async () => {
    const v = state.view();
    const n = format.parse(input.value, S.unit);
    if (!Number.isInteger(n) || n < 1 || n > v.refundable) return msg.set(t('out.bad', { min: format.units(1, S.unit), max: format.units(v.refundable, S.unit) }), 'err');
    go.disabled = true;
    msg.set(t('out.creating'));
    try {
      const r = await actions.takeOut(n);
      msg.set(r.later ? t('out.later') : '');
      input.value = '';
      draw();
    } catch (e) {
      msg.set(t('fund.failed', { message: e.message }), 'err');
    } finally {
      go.disabled = false;
    }
  });
  draw();
  const listen = screenListen({ t, reader, id: 'outListen', root: () => main });
  const main = el('main', { class: 'screen sub take-out', 'data-screen': 'takeOut' }, listenHeader(t('out.title'), back, t('common.back'), listen.node), el('div', { class: 'scroll' }, out, form), el('div', { class: 'foot' }, go));
  listen.update();
  return { node: main, update: draw, destroy: () => (stopPlayers(), listen.destroy()), focus: main.querySelector('h1') };
}
