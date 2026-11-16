// History (XHistoryLight), from More: past conversations, newest first, each with its first words, its
// time and, when auto-delete is timed, the time left. Tap a card to open it (and ask a follow-up to
// continue it), the flame to burn it, Burn all now to burn every one. The auto-delete choice sits on top.
import { agoText, AUTO_DELETE_IDS, leftText, listHistory } from '../core/history.js';
import { el, icon, say, sayEl, toast } from '../core/ui.js';
import { holdToBurn } from './burn.js';
import { listenHeader, screenListen } from './parts.js';

const KIND_ICON = { image: ['camera', 'gold'], file: ['file', 'blue'], voice: ['mic', 'violet'], text: ['bulb', 'teal'] };

export function historyScreen({ t, state, back, backTo, actions, reader }) {
  const S = state.S;
  const intro = el('p', { class: 'note', id: 'historyIntro' });
  const seg = el('div', { class: 'seg wrap', role: 'radiogroup', 'aria-labelledby': 'autoHead', id: 'autoDelete' });
  const list = el('div', { class: 'hist-list', id: 'historyList' });
  const confirmBox = el('div', { class: 'confirm-box', id: 'burnAllConfirm', role: 'alert', hidden: true });
  const burnAll = el('button', { type: 'button', class: 'btn danger-outline block', id: 'burnAll' }, icon('flame', 20), el('span', { text: t('history.burnAll') }));
  let convs = [];
  let loaded = false;
  // Burn is held, never one tap (screens/burn.js): the card burns away under the finger.
  // The cards' holds go with the cards when the list is drawn again; Burn all's lives with its own
  // question, so a redraw of the list never leaves it running unowned.
  const holders = new Set();
  let allHolder = null;
  const holdBurn = (btn, target, onBurn) => holdToBurn(btn, { target, onBurn, onTap: () => toast(t('burn.tap'), 2600) });

  const card = (h) => {
    const [ico, tint] = KIND_ICON[h.kind] ?? KIND_ICON.text;
    const words = h.words || h.fileName || t(h.kind === 'image' ? 'history.photo' : 'history.voice');
    const ago = agoText(Date.now() - h.at);
    const timer = h.left
      ? (() => {
          const lt = leftText(h.left.ms);
          const fill = el('span');
          fill.style.width = `${Math.round(h.left.fraction * 100)}%`;
          return el('div', { class: `burn-timer ${h.left.urgency}` }, icon('flame', 16), el('span', { class: 'bar', 'aria-hidden': 'true' }, fill), el('small', { class: 'left', text: t(lt.key, { n: lt.n }) }));
        })()
      : null;
    const burnBtn = el('button', { type: 'button', class: 'round burn-one', 'data-burn': h.id, 'aria-label': t('history.burn', { words }) }, icon('flame', 22));
    const node = el(
      'article',
      { class: 'hist-card', 'data-conv': h.id },
      el(
        'div',
        { class: 'hist-top' },
        el(
          'button',
          { type: 'button', class: 'hist-open', 'aria-label': t('history.open', { words }), onclick: () => actions.openConversation(h.id) },
          el('span', { class: `tile-ico tint-${tint}` }, icon(ico, 22)),
          el(
            'span',
            { class: 'hist-text' },
            el('b', { text: words }),
            h.answer ? el('small', { class: 'hist-answer', text: h.answer }) : null,
            el('span', { class: 'hist-meta' }, el('small', { class: 'hist-time', text: t(ago.key, { n: ago.n }) }), S.conv.id === h.id ? el('small', { class: 'tag teal', text: t('history.current') }) : null),
          ),
        ),
        burnBtn,
      ),
      timer,
    );
    holders.add(holdBurn(burnBtn, () => node, () => burnOne(h.id)));
    return node;
  };

  /** No conversations: what will be kept here, and the way to ask the first question. */
  const emptyState = () =>
    el(
      'div',
      { class: 'empty-state', id: 'historyEmpty' },
      el('span', { class: 'tile-ico big tint-gold', 'aria-hidden': 'true' }, icon('clock', 28)),
      el('b', { text: t('history.emptyTitle') }),
      sayEl('p', { class: 'note' }, t('history.empty')),
      el('button', { type: 'button', class: 'btn', id: 'historyAsk', onclick: () => backTo('home') }, icon('mic', 18), el('span', { text: t('history.emptyAsk') })),
    );

  // What the cards show beyond the stored conversations: the auto-delete choice and which one is open.
  const shown = () => `${S.settings.autoDelete}|${S.conv.id}`;
  let drawnFor = '';
  const draw = () => {
    drawnFor = shown();
    const setting = S.settings.autoDelete;
    say(intro, t(setting === 'off' ? 'history.introOff' : setting === 'close' ? 'history.introClose' : 'history.intro'), '', 'clock');
    seg.replaceChildren(
      ...AUTO_DELETE_IDS.map((id) =>
        el('button', { type: 'button', role: 'radio', 'aria-checked': String(setting === id), id: `auto-${id}`, onclick: () => actions.setAutoDelete(id) }, icon(id === 'off' ? 'x' : id === 'close' ? 'flame' : 'clock', 16), el('span', { text: t(`auto.${id}`) })),
      ),
    );
    const items = listHistory(convs, setting, Date.now());
    for (const h of holders) h.destroy();
    holders.clear();
    list.replaceChildren(...(items.length ? items.map(card) : loaded ? [emptyState()] : []));
    burnAll.hidden = !items.length;
    if (!items.length) confirmBox.hidden = true;
  };

  const reload = async () => {
    convs = await actions.listConversations();
    loaded = true;
    draw();
  };
  const burnOne = async (id) => {
    await actions.burnConversation(id);
    await reload();
  };
  burnAll.addEventListener('click', () => {
    const yes = el('button', { type: 'button', class: 'btn danger-fill', id: 'burnAllYes', 'aria-label': t('history.burnAllLabel') }, icon('flame', 18), el('span', { text: t('history.burnAllYes') }));
    allHolder?.destroy();
    allHolder = holdBurn(
      yes,
      () => list,
      async () => {
        confirmBox.hidden = true;
        await actions.burnAll();
        await reload();
      },
    );
    confirmBox.replaceChildren(
      sayEl('p', {}, t('history.burnAllAsk'), '', 'flame'),
      el(
        'div',
        { class: 'row-btns' },
        el('button', { type: 'button', class: 'btn', id: 'burnAllNo', onclick: () => ((confirmBox.hidden = true), burnAll.focus()) }, icon('x', 18), el('span', { text: t('history.keep') })),
        yes,
      ),
    );
    confirmBox.hidden = false;
    confirmBox.querySelector('#burnAllNo').focus();
  });

  // The times on the cards move on; auto-delete may remove a card while the screen is open.
  const tick = setInterval(reload, 30_000);
  let seen = state.view().historyVersion;
  // The app's state changes many times a second while an answer streams. Redrawing each time would
  // replace the buttons under a finger and lose the tap (a flame pressed to burn that very answer), so
  // the list is drawn again only when something it shows has changed.
  const update = () => {
    const v = state.view().historyVersion;
    if (v !== seen) {
      seen = v;
      reload();
    } else if (shown() !== drawnFor) draw();
  };
  draw();
  reload();
  const listen = screenListen({ t, reader, id: 'historyListen', root: () => main });
  const main = el(
    'main',
    { class: 'screen sub history', 'data-screen': 'history' },
    listenHeader(t('history.title'), back, t('common.back'), listen.node),
    el(
      'div',
      { class: 'scroll' },
      intro,
      el('h2', { class: 'caps', id: 'autoHead', text: t('history.auto') }),
      seg,
      list,
      sayEl('p', { class: 'note', id: 'burnWhat' }, t('history.what'), '', 'flame'),
    ),
    el('div', { class: 'foot' }, confirmBox, burnAll),
  );
  listen.update();
  return { node: main, update, destroy: () => (clearInterval(tick), listen.destroy(), [...holders].forEach((h) => h.destroy()), allHolder?.destroy()), focus: main.querySelector('h1') };
}
