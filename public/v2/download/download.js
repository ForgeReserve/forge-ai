// The /download page: every way to get Forge, a card each, with an icon, a word or two and its state.
// The ways for this phone come first (view.js waysPlan), the rest under Other ways.
// - Android, from this site: the APK, its version, size and SHA-256 (with Copy), and how to install it.
//   Where the site also has Forge Private Voice (the APK for GrapheneOS), a choice of two first: Android
//   or GrapheneOS, an icon and a word each. With no APK, the card says it is not on this site yet.
// - Google Play: Soon, and no link, until the site has Forge's Play page (FORGE_PLAY_URL).
// - iPhone: Soon, and no link, until the site has the iPhone app's link (FORGE_IOS_URL). On an iPhone,
//   with no link, the web app's card shows how to put Forge on the Home Screen (core/getapp.js), opening
//   Forge first so what goes on the Home Screen is Forge itself. An iPhone is never offered an APK or
//   any other Android way.
// - The web app: Open Forge, always. An event pass in this page's address (#<pass>) goes with it.
// Nothing here is sent anywhere but this site.
import { appOffer, offerNode, thisPhone } from '../core/getapp.js';
import { t } from '../core/i18n.js';
import { passFrom } from '../core/join.js';
import { applyPageLook } from '../core/pagelook.js';
import { el, icon, sayEl } from '../core/ui.js';
import { apkChoices, deviceOf, iosStore, storeLink, waysPlan, webAddress } from './view.js';

applyPageLook();
const phone = thisPhone();
const device = deviceOf({ ua: navigator.userAgent, platform: navigator.platform, touchPoints: navigator.maxTouchPoints });
const web = webAddress(passFrom(location.hash));
document.title = t(device === 'ios' ? 'download.titleIos' : device === 'android' ? 'download.title' : 'download.titleAny');

/** A few facts as chips under the title, an icon each. */
const FACTS = {
  android: [
    ['noName', 'download.noAccount', 'ink'],
    ['shield', 'download.noGoogle', 'blue'],
    ['lock', 'download.private', 'teal'],
  ],
  other: [
    ['noName', 'download.noAccount', 'ink'],
    ['lock', 'download.private', 'teal'],
    ['coins', 'download.payEcash', 'gold'],
  ],
};

const body = el('div', { class: 'dl-body', id: 'downloadBody', 'aria-live': 'polite', 'aria-busy': 'true' });
document.getElementById('download').replaceChildren(
  el(
    'main',
    { class: 'dl-page', id: 'main', 'data-screen': 'download', 'data-device': device },
    el(
      'div',
      { class: 'dl-hero' },
      el('img', { class: 'dl-icon', src: '/icons/icon-192.png', width: '192', height: '192', alt: '' }),
      el('h1', { text: document.title }),
      el('ul', { class: 'dl-facts' }, ...(FACTS[device] ?? FACTS.other).map(([ico, key, tint]) => el('li', { class: 'fact' }, el('span', { class: `fact-ico i-${tint}` }, icon(ico, 18)), el('span', { text: t(key) })))),
    ),
    body,
  ),
);

/** The round tile with a way's icon. */
const tile = (ico, tint) => el('span', { class: `way-tile i-${tint}`, 'aria-hidden': 'true' }, icon(ico, 26));

/** A way's state: Ready, or Soon. */
const tag = (ready) => (ready ? el('span', { class: 'tag-ready' }, icon('check', 14), el('span', { text: t('download.ready') })) : el('span', { class: 'soon', text: t('download.soon') }));

/**
 * A small card: the whole card is a link when the way is there, else a card that is no link and cannot
 * be focused, marked Soon (aria-disabled).
 */
function card({ way, ico, tint, name, sub, href = null, id, subId }) {
  const words = el('span', { class: 'way-words' }, el('span', { class: 'way-name', text: name }), el('span', { class: 'way-sub', id: subId, text: sub }));
  if (href) return el('a', { class: 'way', id, href, 'data-way': way, 'data-state': 'ready' }, tile(ico, tint), words, el('span', { class: 'way-go', 'aria-hidden': 'true' }, icon(href.startsWith('https:') ? 'external' : 'next', 20)));
  return el('div', { class: 'way', id: `way-${way}`, 'data-way': way, 'data-state': 'soon', 'aria-disabled': 'true', role: 'group', 'aria-label': `${name}, ${t('download.soon')}` }, tile(ico, tint), words, tag(false));
}

/** The APK card when the site has one: the choice, the button, the version, the SHA-256 and the steps. */
function apkCard(choices) {
  let picked = choices[0];
  const sub = el('span', { class: 'way-sub', id: 'apkSub' });
  const get = el('a', { class: 'dl-get', id: 'downloadApk' });
  const hash = el('code', { class: 'dl-hash', id: 'downloadHash' });
  const about = el('p', { class: 'dl-about', id: 'downloadAbout', hidden: true });
  const copied = el('span', { class: 'sr-only', id: 'downloadCopied', role: 'status' });
  const copyWord = el('span', { text: t('download.copy') });
  const copy = el('button', { type: 'button', class: 'dl-copy', id: 'downloadCopy', 'aria-label': t('download.copyLabel') }, icon('copy', 18), copyWord);
  let copyTimer = 0;
  copy.addEventListener('click', async () => {
    const text = picked.hash.replaceAll(' ', '');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard here: select it, so the phone's own Copy takes it.
      getSelection()?.selectAllChildren(hash);
      return;
    }
    copy.dataset.done = '1';
    copy.replaceChildren(icon('check', 18), el('span', { text: t('download.copied') }));
    copied.textContent = t('download.copied');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      delete copy.dataset.done;
      copy.replaceChildren(icon('copy', 18), copyWord);
      copied.textContent = '';
    }, 2500);
  });
  const show = () => {
    get.href = picked.url;
    get.download = picked.file;
    get.replaceChildren(icon('download', 22), el('span', { text: t('download.get', { mb: picked.mb }) }));
    sub.textContent = picked.version ? `${picked.name} · ${t('download.version', { version: picked.version })}` : picked.name;
    const groups = picked.hash.split(' ');
    hash.replaceChildren(...groups.flatMap((g, i) => [el('span', { text: g }), i < groups.length - 1 ? ' ' : null]).filter(Boolean));
  };
  const pick =
    choices.length < 2
      ? null
      : el(
          'div',
          { class: 'apk-pick', role: 'radiogroup', 'aria-label': t('download.pick') },
          ...choices.map((c) =>
            el(
              'div',
              { class: 'apk-choice' },
              el('button', { type: 'button', role: 'radio', class: 'apk-kind', id: `apk-${c.id}`, 'aria-checked': String(c === picked), tabindex: c === picked ? '0' : '-1', onclick: () => choose(c) }, icon(c.icon, 22), el('span', { text: t(`download.${c.id}`) })),
              el('button', { type: 'button', class: 'apk-info', id: `apk-${c.id}-info`, 'aria-label': t('download.about', { name: t(`download.${c.id}`) }), 'aria-controls': 'downloadAbout', 'aria-expanded': 'false', onclick: () => info(c) }, icon('info', 20)),
            ),
          ),
        );
  function choose(c) {
    picked = c;
    for (const b of pick.querySelectorAll('.apk-kind')) {
      const on = b.id === `apk-${c.id}`;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    about.hidden = true;
    for (const b of pick.querySelectorAll('.apk-info')) b.setAttribute('aria-expanded', 'false');
    show();
  }
  function info(c) {
    const text = t(`download.${c.id}Info`);
    about.hidden = !about.hidden && about.textContent === text;
    about.textContent = text;
    for (const b of pick.querySelectorAll('.apk-info')) b.setAttribute('aria-expanded', String(!about.hidden && b.id === `apk-${c.id}-info`));
  }
  // Arrow keys move along the choice, as a radio group does.
  pick?.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = choices[(choices.indexOf(picked) + step + choices.length) % choices.length];
    choose(next);
    document.getElementById(`apk-${next.id}`)?.focus();
  });
  show();
  const STEPS = [
    ['download', 'download.step1'],
    ['file', 'download.step2'],
    ['shield', 'download.step3'],
    ['external', 'download.step4'],
  ];
  return el(
    'section',
    { class: 'way way-apk', id: 'way-apk', 'data-way': 'apk', 'data-state': 'ready', 'aria-labelledby': 'apkHead' },
    el('div', { class: 'way-head' }, tile('android', 'teal'), el('span', { class: 'way-words' }, el('h2', { class: 'way-name', id: 'apkHead', text: t('download.apkName') }), sub), tag(true)),
    ...(pick ? [pick, about] : []),
    get,
    el('ul', { class: 'dl-meta' }, el('li', {}, icon('android', 16), el('span', { text: t('download.android9') })), el('li', {}, icon('server', 16), el('span', { text: t('download.apkSub') }))),
    el(
      'div',
      { class: 'dl-check' },
      el('div', { class: 'dl-check-head' }, el('span', { class: 'dl-label' }, icon('fingerprint', 18), el('h3', { text: t('download.hash') })), copy),
      hash,
      copied,
      sayEl('p', { class: 'dl-note' }, t('download.hashSub')),
    ),
    el(
      'div',
      { class: 'dl-install' },
      el('span', { class: 'dl-label' }, icon('check', 18), el('h3', { text: t('download.steps') })),
      el('ol', { id: 'downloadSteps', class: 'dl-steps' }, ...STEPS.map(([ico, key], i) => el('li', {}, el('span', { class: 'step-ico', 'aria-hidden': 'true' }, icon(ico, 22), el('span', { class: 'step-n', text: String(i + 1) })), el('span', { class: 'step-word', text: t(key) })))),
      sayEl('p', { class: 'dl-note' }, t('download.update'), '', 'again'),
    ),
  );
}

/** The web app's card: Open Forge, or on an iPhone with nothing else to give, the Home Screen steps. */
function webCard(offer) {
  if (offer?.kind === 'addHome') return el('section', { class: 'way way-home', 'data-way': 'web', 'data-state': 'ready' }, offerNode(offer, { el, icon, sayEl }, t, { open: web }));
  return card({ way: 'web', ico: 'globe', tint: 'teal', name: t('download.webName'), sub: t('download.webSub'), href: web, id: 'openWeb' });
}

function draw(info) {
  const choices = device === 'ios' ? [] : apkChoices(info);
  const ios = storeLink(info, 'ios');
  const play = storeLink(info, 'play');
  const plan = waysPlan(device, { apk: choices.length > 0, play: !!play, iphone: !!ios });
  // On an iPhone, what Get the app offers there (core/getapp.js): the link, the Home Screen steps or nothing.
  const offer = device === 'ios' ? appOffer({ ...phone, iosUrl: ios }) : null;
  const make = {
    apk: () => (choices.length ? apkCard(choices) : card({ way: 'apk', ico: 'android', tint: 'teal', name: t('download.apkName'), sub: t('download.coming'), subId: 'downloadComing' })),
    play: () => card({ way: 'play', ico: 'play', tint: 'green', name: t('download.playName'), sub: t('download.playSub'), href: play, id: 'downloadPlay' }),
    iphone: () => card({ way: 'iphone', ico: 'apple', tint: 'ink', name: t('download.iosName'), sub: t(ios ? `download.${iosStore(ios)}` : 'download.appstore'), href: ios, id: 'downloadIos' }),
    web: () => webCard(offer),
  };
  // The APK's big card stands on its own (on a wide screen, the left column); the rest beside it.
  const big = choices.length > 0 && plan.lead.includes('apk');
  const leadCards = plan.lead.filter((w) => !(big && w === 'apk')).map((w) => make[w]());
  const other = plan.other.length
    ? el('section', { class: 'dl-other', id: 'downloadOther', 'aria-labelledby': 'otherHead' }, el('h2', { class: 'dl-other-head', id: 'otherHead', text: t('download.other') }), el('div', { class: 'dl-grid' }, ...plan.other.map((w) => make[w]())))
    : null;
  const side = el('div', { class: 'dl-side' }, leadCards.length ? el('div', { class: 'dl-lead', id: 'downloadLead' }, ...leadCards) : null, other);
  body.replaceChildren(...(big ? [el('div', { class: 'dl-main' }, apkCard(choices))] : []), side);
  body.classList.toggle('split', big);
  if (offer) body.dataset.offer = offer.kind;
  body.dataset.plan = [...plan.lead, '|', ...plan.other].join(' ');
  body.removeAttribute('aria-busy');
}

let info = null;
try {
  const res = await fetch('/download/info', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
  info = res.ok ? await res.json() : null;
} catch {
  /* offline or no answer: the web app, and the rest as not here yet */
}
draw(info);
