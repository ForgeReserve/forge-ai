// History (XHistoryLight), from More: past conversations, newest first, each with its first words, its
// time and, when auto-delete is timed, the time left. Tap a card to open it (and ask a follow-up to
// continue it), the flame to burn it, Burn all now to burn every one. The auto-delete choice sits on top.
import { agoText, AUTO_DELETE_IDS, leftText, listHistory } from '../core/history.js';
import { backHeader, el, icon } from '../core/ui.js';

const KIND_ICON = { image: ['camera', 'gold'], file: ['file', 'blue'], voice: ['mic', 'violet'], text: ['bulb', 'teal'] };

export function historyScreen({ t, state, back, actions }) {
  const S = state.S;
  const intro = el('p', { class: 'note', id: 'historyIntro' });
  const seg = el('div', { class: 'seg wrap', role: 'radiogroup', 'aria-labelledby': 'autoHead', id: 'autoDelete' });
  const list = el('div', { class: 'hist-list', id: 'historyList' });
  const confirmBox = el('div', { class: 'confirm-box', id: 'burnAllConfirm', role: 'alert', hidden: true });
  const burnAll = el('button', { type: 'button', class: 'btn danger-outline block', id: 'burnAll' }, icon('flame', 20), el('span', { text: t('history.burnAll') }));
  let convs = [];
  let loaded = false;

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
    return el(
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
        el('button', { type: 'button', class: 'round burn-one', 'data-burn': h.id, 'aria-label': t('history.burn', { words }), onclick: () => burnOne(h.id) }, icon('flame', 22)),
      ),
      timer,
    );
  };

  const draw = () => {
    const setting = S.settings.autoDelete;
    intro.textContent = t(setting === 'off' ? 'history.introOff' : setting === 'close' ? 'history.introClose' : 'history.intro');
    seg.replaceChildren(
      ...AUTO_DELETE_IDS.map((id) =>
        el('button', { type: 'button', role: 'radio', 'aria-checked': String(setting === id), id: `auto-${id}`, onclick: () => actions.setAutoDelete(id), text: t(`auto.${id}`) }),
      ),
    );
    const items = listHistory(convs, setting, Date.now());
    list.replaceChildren(...(items.length ? items.map(card) : loaded ? [el('p', { class: 'hint', id: 'historyEmpty', text: t('history.empty') })] : []));
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
    confirmBox.replaceChildren(
      el('p', { text: t('history.burnAllAsk') }),
      el(
        'div',
        { class: 'row-btns' },
        el('button', { type: 'button', class: 'btn', id: 'burnAllNo', onclick: () => ((confirmBox.hidden = true), burnAll.focus()), text: t('history.keep') }),
        el(
          'button',
          {
            type: 'button',
            class: 'btn danger-fill',
            id: 'burnAllYes',
            onclick: async () => {
              confirmBox.hidden = true;
              await actions.burnAll();
              await reload();
            },
          },
          icon('flame', 18),
          el('span', { text: t('history.burnAllYes') }),
        ),
      ),
    );
    confirmBox.hidden = false;
    confirmBox.querySelector('#burnAllNo').focus();
  });

  // The times on the cards move on; auto-delete may remove a card while the screen is open.
  const tick = setInterval(reload, 30_000);
  let seen = state.view().historyVersion;
  const update = () => {
    const v = state.view().historyVersion;
    if (v !== seen) {
      seen = v;
      reload();
    } else draw();
  };
  draw();
  reload();
  const main = el(
    'main',
    { class: 'screen sub history', 'data-screen': 'history' },
    backHeader(t('history.title'), back, t('common.back')),
    el(
      'div',
      { class: 'scroll' },
      intro,
      el('h2', { class: 'caps', id: 'autoHead', text: t('history.auto') }),
      seg,
      list,
      el('p', { class: 'note', id: 'burnWhat', text: t('history.what') }),
    ),
    el('div', { class: 'foot' }, confirmBox, burnAll),
  );
  return { node: main, update, destroy: () => clearInterval(tick), focus: main.querySelector('h1') };
}
