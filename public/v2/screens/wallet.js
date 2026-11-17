// Add money: the wallet cards (AddFunds-C1 in docs/design/canvas, direction C chosen 2026-11-15). Each
// way to add money is one big picture card with one word. Swipe between them, or tap the icon tabs
// under them; the one big button changes to match the card. What a way is, and what it shows to whom,
// sits behind the card's info button and is read by Listen; the screen itself has no sentences.
//
// The order (core/ways.js): Start free first while it is wanted, then the way used last on this phone,
// then Scan a note, Lightning, the Cashu card, the Fedimint card and eCash, then More, whose tiles open the
// other ways. Ways the engine turns off get no card. Each card opens the way's own screen (a fund module,
// or Start free), which works exactly as before.
import { has } from '../core/i18n.js';
import { el, icon, reduced } from '../core/ui.js';
import { CARD_WAYS, cardOf, orderWays } from '../core/ways.js';
import { cardFace } from './brands/cards.js';
import { listenButton, listenHeader } from './parts.js';
import { startFreeWanted } from './startfree.js';
import { cardArt, spotArt, stackCard, tabIcon } from './wallet-art.js';

/** The ways as cards: {cards, more, mods} (core/ways.js orderWays), from the engine's methods and the registry. */
export function waysNow({ state, registry }) {
  const S = state.S;
  const mods = {};
  for (const { instance } of registry.list('fund')) if (instance.id !== 'invite' && instance.available(S.methods)) mods[instance.id] = instance;
  return { ...orderWays({ ids: Object.keys(mods), start: startFreeWanted(state.view()), last: S.settings.lastWay ?? '' }), mods };
}

// What a card's privacy badge says: the way cannot be linked to you, or someone sees the payment.
const BADGE = { note: 'unlinked', ecash: 'unlinked', card: 'unlinked', lightning: 'seen', onchain: 'seen', start: 'free' };
/** A way that reads a card, which only the Android app can do: on the website its card says so. */
const appOnly = (id, mod) => CARD_WAYS.includes(id) && !!mod?.usable && !mod.usable();
const BADGE_ICON = { unlinked: 'shield', seen: 'eye', free: 'gift', app: 'phone' };

/** One way's word, its button's word, its full name and its info lines. mods: every way's module. */
function wayWords(t, id, mod, more = [], mods = {}) {
  const known = (k) => (has(k) ? t(k) : null);
  // The two card ways together: each one's name and its line, and where cards are read.
  if (id === 'cards') {
    const info = CARD_WAYS.flatMap((m) => [t(`fund.${m}.name`), ...wayWords(t, m, mods[m]).info.filter((x) => x !== t('ways.cardApp'))]);
    if (CARD_WAYS.some((m) => appOnly(m, mods[m]))) info.push(t('ways.cardApp'));
    return { name: t('ways.cards.name'), word: t('ways.cards.word'), go: t('ways.go'), info };
  }
  const name = id === 'start' ? t('startFree.title') : id === 'more' ? t('ways.more.name') : t(`fund.${id}.name`);
  const word = known(`ways.${id}.word`) ?? name;
  const go = known(`ways.${id}.go`) ?? t('ways.go');
  let info;
  if (id === 'start') info = [t('fund.invite.sub')];
  else if (id === 'more') info = more.map((m) => t(`fund.${m}.name`));
  else {
    const sub = mod?.sub?.() ?? `fund.${id}.sub`;
    info = has(sub) ? [t(sub)] : [];
    // Cards are read by the Android app; on the website the card's screen points there.
    if (appOnly(id, mod)) info.push(t('ways.cardApp'));
  }
  return { name, word, go, info };
}

/** Opens a way: Start free's screen or the fund module's, after keeping it as the way used last. */
function openWay({ nav, actions }, id) {
  actions.setLastWay(id === 'start' ? '' : id);
  if (id === 'start') nav('startFree');
  else nav('fund', { id });
}

export function walletScreen(ctx) {
  const { t, state, back, format, reader } = ctx;
  const S = state.S;
  let ways = waysNow(ctx);
  let order = [];
  let now = 0;
  let target = null; // the card a tab is scrolling to: the scroll in between does not move the tabs
  let moved = false; // the person moved to a card: a change in the ways keeps that card on show

  const ring = el('span', { class: 'way-bal-ring', 'aria-hidden': 'true' });
  const amount = el('span', { id: 'waysAmount' });
  const bal = el('div', { class: 'way-bal', id: 'waysBalance' }, ring, amount);
  const track = el('div', { class: 'way-track', id: 'wayTrack' });
  const stage = el('div', { class: 'way-stage' }, track);
  const tabs = el('div', { class: 'way-tabs', role: 'tablist', id: 'wayTabs', 'aria-label': t('ways.tabs') });
  const goWord = el('span');
  const go = el('button', { type: 'button', class: 'btn primary block way-go', id: 'wayGo' }, goWord, icon('next', 22, 2.6));
  const cards = []; // {id, node, words, info (its button), lines}
  const spoken = () => {
    const c = cards[now];
    return c ? [c.words.word, ...c.words.info] : [];
  };
  const listen = listenButton({ t, reader, id: 'waysListen', pieces: () => spoken() });
  const main = el('main', { class: 'screen sub wallet', 'data-screen': 'addFunds' }, listenHeader(t('ways.title'), back, t('common.back'), listen.node), bal, stage, tabs, el('div', { class: 'foot' }, go));

  /** One card: picture, badge, word, and the info line behind its button. */
  const makeCard = (id, i) => {
    const mod = ways.mods[id];
    const words = wayWords(t, id, mod, ways.more, ways.mods);
    const node = el('section', { class: 'way-card', 'data-way': id, id: `way-${id}`, role: 'tabpanel', 'aria-labelledby': `tab-${id}`, 'aria-roledescription': t('ways.card') });
    const lines = el('div', { class: 'way-info', id: `wayInfo-${id}`, hidden: true }, ...words.info.map((x) => el('p', { text: x })));
    const kind = (id === 'cards' ? CARD_WAYS.every((m) => appOnly(m, ways.mods[m])) : appOnly(id, mod)) ? 'app' : BADGE[id];
    const badge = kind ? el('span', { class: `way-badge badge-${kind}`, role: 'img', 'aria-label': t(`ways.badge.${kind}`), title: t(`ways.badge.${kind}`) }, icon(BADGE_ICON[kind], 16)) : null;
    let info = null;
    if (id === 'more') {
      // The More card is its tiles: each opens its way.
      const grid = el(
        'div',
        { class: 'way-tiles' },
        ...ways.more.map((m) => el('button', { type: 'button', class: 'way-tile', id: `more-${m}`, 'aria-label': t(`fund.${m}.name`), onclick: () => openWay(ctx, m) }, spotArt(m, ways.mods[m]), el('span', { text: wayWords(t, m, ways.mods[m]).word }))),
      );
      node.append(el('div', { class: 'way-art' }, grid), el('div', { class: 'way-foot' }, el('b', { class: 'way-word', text: words.word })));
    } else {
      let art;
      if (id === 'cards') {
        // The two cards as they are printed, side by side: a tap on one opens its way.
        art = el(
          'div',
          { class: 'way-art way-pair' },
          ...CARD_WAYS.map((m) => el('button', { type: 'button', class: 'way-pair-btn', 'data-brand': m, id: `pair-${m}`, 'aria-label': t(`fund.${m}.name`), onclick: () => (i === now ? openWay(ctx, m) : show(i)) }, cardFace(m), el('span', { text: t(`ways.${m}.word`) }))),
        );
      }
      info = el('button', { type: 'button', class: 'way-info-btn', id: `wayInfoBtn-${id}`, 'aria-label': t('ways.info', { name: words.name }), 'aria-expanded': 'false', 'aria-controls': `wayInfo-${id}` }, icon('info', 22));
      info.addEventListener('click', () => {
        lines.hidden = !lines.hidden;
        info.setAttribute('aria-expanded', String(!lines.hidden));
      });
      // A tap on the picture does what the big button does.
      art ??= el('button', { type: 'button', class: 'way-art', tabindex: '-1', 'aria-hidden': 'true', onclick: () => (i === now ? openWay(ctx, id) : show(i)) }, cardArt(id, mod, words.name));
      node.append(art, info, el('div', { class: 'way-foot' }, badge, el('b', { class: 'way-word', text: words.word }), lines));
    }
    return { id, node, words, info, lines };
  };

  const tabFor = (id, i) =>
    el('button', { type: 'button', role: 'tab', class: `way-tab tab-${id}`, id: `tab-${id}`, 'aria-label': id === 'start' ? t('startFree.title') : id === 'more' ? t('ways.more.name') : id === 'cards' ? t('ways.cards.name') : t(`fund.${id}.name`), 'aria-controls': `way-${id}`, onclick: () => show(i, true) }, tabIcon(id, ways.mods[id]));

  /**
   * Builds the cards and tabs for the ways there are now, keeping the card on show when it is still there.
   * Until the person moves, the card on show is ctx.first (a way's id) when it is among them.
   */
  const build = () => {
    const keep = moved ? order[now] : ctx.first ? cardOf(ctx.first, ways.cards) : null;
    order = ways.cards;
    cards.splice(0, cards.length, ...order.map(makeCard));
    track.replaceChildren(...cards.map((c) => c.node));
    tabs.replaceChildren(...order.map(tabFor));
    const i = keep ? order.indexOf(keep) : -1;
    now = i >= 0 ? i : 0;
    requestAnimationFrame(() => (track.scrollLeft = now * stride()));
    mark();
  };

  const stride = () => {
    const a = cards[0]?.node;
    const b = cards[1]?.node;
    return a && b ? b.offsetLeft - a.offsetLeft : track.clientWidth;
  };

  /** Marks the card on show: its tab, the big button and Listen. */
  const mark = () => {
    cards.forEach((c, i) => c.node.classList.toggle('now', i === now));
    for (const [i, b] of [...tabs.children].entries()) {
      b.setAttribute('aria-selected', String(i === now));
      b.tabIndex = i === now ? 0 : -1;
    }
    const c = cards[now];
    if (!c) return;
    goWord.textContent = c.words.go;
    // The More card's tiles, and the two cards, are their buttons: the big one waits, so nothing jumps.
    const idle = c.id === 'more' || c.id === 'cards';
    go.classList.toggle('way-go-idle', idle);
    go.disabled = idle;
    go.dataset.way = c.id;
    listen.stop();
    listen.update();
  };

  /** Shows card i: scrolls the track to it (no animation with reduced motion). */
  const show = (i, focusTab = false) => {
    if (i < 0 || i >= cards.length) return;
    moved = true;
    now = i;
    target = i;
    track.scrollTo({ left: i * stride(), behavior: reduced() ? 'auto' : 'smooth' });
    mark();
    if (focusTab) tabs.children[i]?.focus();
  };

  // A swipe: the card nearest the middle is the one on show.
  let frame = 0;
  track.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const i = Math.max(0, Math.min(cards.length - 1, Math.round(track.scrollLeft / Math.max(1, stride()))));
      if (target != null) {
        if (i !== target) return;
        target = null;
      }
      if (i !== now) {
        moved = true;
        now = i;
        mark();
      }
    });
  });
  // A finger on the track takes over from a tab's scroll.
  track.addEventListener('pointerdown', () => (target = null));
  track.addEventListener('wheel', () => (target = null), { passive: true });
  tabs.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    show((now + step + cards.length) % cards.length, true);
  });
  go.addEventListener('click', () => {
    const c = cards[now];
    if (c && c.id !== 'more' && c.id !== 'cards') openWay(ctx, c.id);
  });

  const update = () => {
    const v = state.view();
    amount.textContent = v.balanceText ?? format.units(0, S.unit ?? 'usd');
    ring.classList.toggle('empty', !(v.balanceMsub > 0));
    const next = waysNow(ctx);
    const k = (w) => `${w.cards.join(',')}|${w.more.join(',')}`;
    if (k(next) !== k(ways) || !cards.length) {
      ways = next;
      build();
    } else listen.update();
  };
  update();
  return { node: main, update, destroy: listen.destroy, focus: main.querySelector('h1') };
}

/**
 * The fanned card stack on Funds (AddFunds-C4): the first three ways' cards, fanned, with one word. A
 * tap opens the wallet cards. Returns {node, update}.
 */
export function cardStack(ctx) {
  const { t, nav } = ctx;
  const fan = el('span', { class: 'stack-fan', 'aria-hidden': 'true' });
  const node = el('button', { type: 'button', class: 'card-stack', id: 'addFundsBtn', onclick: () => nav('addFunds') }, el('span', { class: 'stack-head' }, icon('addMoney', 24), el('span', { text: t('funds.addMoney') })), fan);
  let shown = null;
  const update = () => {
    const w = waysNow(ctx);
    const ids = w.cards.filter((x) => x !== 'more').slice(0, 3);
    const k = ids.join(',');
    if (k === shown) return;
    shown = k;
    // Centre first, then left and right, as the design draws them.
    const pos = ['centre', 'left', 'right'];
    const kids = ids.map((id, i) => stackCard(id, w.mods[id], pos[i]));
    fan.replaceChildren(...[kids[1], kids[2], kids[0]].filter(Boolean));
  };
  update();
  return { node, update };
}
