// The /download page: the Android app's APK, its size and its SHA-256, and how to install it. Where the
// site also has Forge Private Voice (the APK for GrapheneOS), a choice of two first: Android or
// GrapheneOS, an icon and a word each. When the site has no APK yet it says the app is coming and points
// to the web app. Nothing here is sent anywhere but this site. An iPhone or iPad gets Forge for iPhone
// instead (core/getapp.js): the iPhone app's link when the site has one, else the Home Screen steps,
// opening Forge first so what goes on the Home Screen is Forge itself. An iPhone is never offered an APK.
import { getAppOffer, offerNode, thisPhone } from '../core/getapp.js';
import { t } from '../core/i18n.js';
import { applyPageLook } from '../core/pagelook.js';
import { el, icon, sayEl } from '../core/ui.js';
import { apkChoices } from './view.js';

applyPageLook();
const iphone = thisPhone().ios;
document.title = t(iphone ? 'download.titleIos' : 'download.title');

const root = document.getElementById('download');
const body = el('div', { class: 'download-body', id: 'downloadBody', 'aria-live': 'polite' });
root.replaceChildren(el('main', { class: 'screen download-page', 'data-screen': 'download' }, el('h1', { text: document.title }), iphone ? null : sayEl('p', { class: 'lead' }, t('download.lead')), body));

const webApp = () => el('a', { class: 'btn block', href: '/v2/', id: 'openWeb' }, icon('external', 20), el('span', { text: t('download.web') }));

/** The APK picked, its button, size and fingerprint. With two to choose from, an icon and a word each, and a short line behind ⓘ. */
function draw(choices) {
  if (!choices.length) {
    body.replaceChildren(sayEl('p', { class: 'note', id: 'downloadComing' }, t('download.coming')), webApp());
    return;
  }
  let picked = choices[0];
  const get = el('a', { class: 'btn primary block', id: 'downloadApk' });
  const hash = el('p', { class: 'hash', id: 'downloadHash' });
  const about = el('p', { class: 'note', id: 'downloadAbout', hidden: true });
  const show = () => {
    get.href = picked.url;
    get.download = picked.file;
    get.replaceChildren(icon('download', 20), el('span', { text: t('download.get', { mb: picked.mb }) }));
    hash.textContent = picked.hash;
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
              el('button', { type: 'button', role: 'radio', class: 'apk-kind', id: `apk-${c.id}`, 'aria-checked': String(c === picked), onclick: () => choose(c) }, icon(c.icon, 24), el('span', { text: t(`download.${c.id}`) })),
              el('button', { type: 'button', class: 'apk-info', id: `apk-${c.id}-info`, 'aria-label': t('download.about', { name: t(`download.${c.id}`) }), 'aria-controls': 'downloadAbout', onclick: () => info(c) }, icon('info', 20)),
            ),
          ),
        );
  function choose(c) {
    picked = c;
    for (const b of pick.querySelectorAll('.apk-kind')) b.setAttribute('aria-checked', String(b.id === `apk-${c.id}`));
    about.hidden = true;
    show();
  }
  function info(c) {
    const text = t(`download.${c.id}Info`);
    about.hidden = !about.hidden && about.textContent === text;
    about.textContent = text;
  }
  show();
  body.replaceChildren(
    ...(pick ? [pick, about] : []),
    el('div', { class: 'apk-box' }, get, sayEl('p', { class: 'note' }, t('download.noGoogle')), el('h2', { class: 'caps', text: t('download.hash') }), hash, sayEl('p', { class: 'note' }, t('download.hashSub'))),
    el('h2', { class: 'caps', text: t('download.steps') }),
    el('ol', { id: 'downloadSteps' }, ...['download.step1', 'download.step2', 'download.step3', 'download.step4'].map((k) => el('li', {}, sayEl('span', {}, t(k))))),
    sayEl('p', { class: 'note' }, t('download.update')),
    webApp(),
  );
}

if (iphone) {
  const offer = await getAppOffer();
  // The steps open Forge themselves; with a link or nothing to give, Use in browser follows.
  body.replaceChildren(...[offerNode(offer, { el, icon, sayEl }, t, { id: 'downloadIos', open: '/v2/' }), offer.kind === 'addHome' ? null : webApp()].filter(Boolean));
  body.dataset.offer = offer.kind;
} else {
  try {
    const res = await fetch('/download/info', { cache: 'no-store' });
    draw(apkChoices(res.ok ? await res.json() : null));
  } catch {
    draw([]);
  }
}
