// Funds and memory (ZBoth), Add funds (DAddFunds), one funding method (a fund module), and Take funds
// out (refund as eCash, kept on the phone until the person says they saved it).
import { backHeader, copy, el, icon, listRow, msgLine, toast } from '../core/ui.js';
import { cardRing } from './parts.js';

export function fundsScreen({ t, state, nav, back, actions, format, vault }) {
  const S = state.S;
  const fr = cardRing('gold-track', 'gold');
  const mr = cardRing('memory-track', 'memory');
  const amount = el('div', { class: 'big', id: 'fundsAmount' });
  const fundsNote = el('p', { class: 'note', id: 'fundsNote' });
  const refundable = el('p', { class: 'note', id: 'refundable' });
  const memFree = el('div', { class: 'big', id: 'memoryFree' });
  const memNote = el('p', { class: 'note', id: 'memoryNote' });
  const items = el('ul', { class: 'held', id: 'heldItems' });
  const outBtn = el('button', { type: 'button', class: 'btn soft', id: 'takeOutBtn', onclick: () => nav('takeOut') }, icon('takeout', 20), el('span', { text: t('funds.takeOut') }));
  const vaultBox = el('div', { class: 'vault-box', id: 'vaultBox' });
  const fundsCard = el(
    'section',
    { class: 'card big-card', 'aria-labelledby': 'fundsCap' },
    el('div', { class: 'card-top' }, fr.node, el('div', {}, el('h2', { class: 'caps gold', id: 'fundsCap', text: t('funds.funds') }), amount, fundsNote, refundable)),
    el('div', { class: 'card-btns' }, el('button', { type: 'button', class: 'btn primary', id: 'addFundsBtn', onclick: () => nav('addFunds') }, icon('plus', 20), el('span', { text: t('funds.add') })), outBtn),
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
  const main = el('main', { class: 'screen sub funds', 'data-screen': 'funds' }, backHeader(t('funds.title'), back, t('common.back')), el('div', { class: 'scroll' }, vaultBox, fundsCard, memCard));

  const vaultRows = () => {
    const rows = [];
    for (const e of vault.incoming()) {
      const refused = e.state === 'refused';
      // Other-mint tokens settle when the engine answers (the app looks them up on start and on Funds).
      // Once the token was taken, copying it is no use, so those rows have no Copy button.
      const taken = !refused && e.via === 'othermint' && (e.code === 'change_pending' || e.code === 'refund_pending');
      const [title, sub] = refused
        ? [t('funds.notAdded'), t('funds.notAddedSub', { message: e.message ?? '' })]
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
          el('p', { text: sub }),
          el(
            'div',
            { class: 'row-btns' },
            taken ? null : el('button', { type: 'button', class: 'btn small', onclick: async () => toast((await copy(e.token)) ? t('answer.copied') : t('answer.copyFailed')), text: t('funds.copyToken') }),
            refused
              ? el('button', {
                  type: 'button',
                  class: 'btn small danger',
                  text: t('funds.removeToken'),
                  onclick: () => {
                    if (window.confirm(t('funds.removeConfirm'))) {
                      vault.discard(e.id);
                      update();
                    }
                  },
                })
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
          el('p', { text: o.amount == null ? t('funds.unsavedSubReturned') : t('funds.unsavedSub', { amount: format.units(o.amount, o.unit) }) }),
          el('div', { class: 'row-btns' }, el('button', { type: 'button', class: 'btn small', onclick: () => nav('takeOut'), text: t('out.title') })),
        ),
      );
    }
    vaultBox.replaceChildren(...rows);
    vaultBox.hidden = !rows.length;
  };

  const update = () => {
    const v = state.view();
    fr.set(v.fundsFraction);
    amount.textContent = v.balanceText ?? format.units(0, S.unit ?? 'usd');
    fundsNote.textContent = !v.hasKey ? t('funds.empty') : v.questionsLeft > 0 ? t('funds.enough', { count: format.int(v.questionsLeft) }) : t('funds.notEnough');
    refundable.textContent = v.refundable > 0 ? t('funds.refundable', { amount: format.units(v.refundable, S.unit) }) : '';
    outBtn.disabled = !(v.refundable > 0) && !vault.outgoing().length;
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
  return { node: main, update, focus: main.querySelector('h1') };
}

export function addFundsScreen({ t, state, nav, back, registry }) {
  const S = state.S;
  const list = el('div', { class: 'fund-groups' });
  const draw = () => {
    const groups = { unlinked: [], depends: [] };
    for (const { instance } of registry.list('fund')) {
      if (!instance.available(S.methods)) continue;
      groups[instance.group === 'unlinked' ? 'unlinked' : 'depends'].push(
        listRow({ ico: instance.icon, tint: 'gold', title: t(`fund.${instance.id}.name`), sub: t(`fund.${instance.id}.sub`), id: `fund-${instance.id}`, cls: instance.group === 'unlinked' ? 'teal-border' : '', onclick: () => nav('fund', { id: instance.id }) }),
      );
    }
    list.replaceChildren(
      ...(groups.unlinked.length ? [el('h2', { class: 'caps teal', text: t('addFunds.unlinked') }), ...groups.unlinked] : []),
      ...(groups.depends.length ? [el('h2', { class: 'caps gold', text: t('addFunds.depends') }), ...groups.depends] : []),
    );
  };
  draw();
  const main = el('main', { class: 'screen sub add-funds', 'data-screen': 'addFunds' }, backHeader(t('addFunds.title'), back, t('common.back')), el('div', { class: 'scroll' }, list));
  return { node: main, update: draw, focus: main.querySelector('h1') };
}

/** Hosts one fund module's view. The module builds its own body from the inputs it was given. */
export function fundScreen({ t, state, back, backTo, registry }, { id }) {
  const entry = registry.list('fund').find((x) => x.instance.id === id);
  if (!entry || !entry.instance.available(state.S.methods)) {
    const main = el('main', { class: 'screen sub', 'data-screen': 'fund' }, backHeader(t('addFunds.title'), back, t('common.back')), el('p', { class: 'hint pad', text: t('addFunds.unavailable') }));
    return { node: main, focus: main.querySelector('h1') };
  }
  const view = entry.instance.view({ done: () => backTo('funds') });
  const main = el('main', { class: 'screen sub fund', 'data-screen': 'fund', 'data-fund': id }, backHeader(t(`fund.${id}.name`), back, t('common.back')), view.node);
  return { node: main, update: view.update, destroy: view.destroy, focus: main.querySelector('h1') };
}

export function takeOutScreen({ t, state, back, actions, format, vault, qr, wallet }) {
  const S = state.S;
  const msg = msgLine();
  const out = el('div', { class: 'token-out', id: 'tokenOut' });
  const input = el('input', { id: 'outAmount', class: 'field-input', inputmode: 'decimal', autocomplete: 'off', 'aria-label': t('out.amountLabel') });
  const go = el('button', { type: 'button', class: 'btn primary block', id: 'outBtn' }, icon('takeout', 20), el('span', { text: t('out.create') }));
  const lock = wallet.lockKey();
  const form = el(
    'div',
    { class: 'form' },
    el('p', { text: t('out.what') }),
    lock ? el('p', { class: 'note', id: 'outLocked', text: t('out.locked', { key: `${lock.slice(0, 10)}...${lock.slice(-6)}` }) }) : null,
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
    (long ? qr.playAnimatedQR(box, o.token).then((p) => (players.push(p), (parts.textContent = t('out.parts', { count: p.parts })))) : qr.renderQR(box, o.token, 'L')).catch(() => {});
    return el(
      'div',
      { class: 'token-card', 'data-token-id': o.id },
      el('b', { text: o.amount == null ? t('out.readyReturned') : t('out.ready', { amount: format.units(o.amount, o.unit) }) }),
      box,
      parts,
      el('p', { class: 'note', text: t('out.keep') }),
      el('div', { class: 'row-btns' }, el('button', { type: 'button', class: 'btn', onclick: async () => toast((await copy(o.token)) ? t('out.copied') : t('answer.copyFailed')) }, icon('copy', 18), el('span', { text: t('out.copy') })), el('button', { type: 'button', class: 'btn primary', 'data-saved': o.id, onclick: () => (vault.saved(o.id), draw()), text: t('out.saved') })),
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
  const main = el('main', { class: 'screen sub take-out', 'data-screen': 'takeOut' }, backHeader(t('out.title'), back, t('common.back')), el('div', { class: 'scroll' }, out, form), el('div', { class: 'foot' }, go));
  return { node: main, update: draw, destroy: stopPlayers, focus: main.querySelector('h1') };
}
