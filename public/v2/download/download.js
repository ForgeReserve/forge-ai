// The /download page: the Android app's APK, its size and its SHA-256, and how to install it. When the
// site has no APK yet it says the app is coming and points to the web app. Nothing here is sent anywhere
// but this site.
import { t } from '../core/i18n.js';
import { applyPageLook } from '../core/pagelook.js';
import { el, icon, sayEl } from '../core/ui.js';
import { apkView } from './view.js';

applyPageLook();
document.title = t('download.title');

const root = document.getElementById('download');
const body = el('div', { class: 'download-body', id: 'downloadBody', 'aria-live': 'polite' });
root.replaceChildren(el('main', { class: 'screen download-page', 'data-screen': 'download' }, el('h1', { text: t('download.title') }), sayEl('p', { class: 'lead' }, t('download.lead')), body));

const webApp = () => el('a', { class: 'btn block', href: '/v2/', id: 'openWeb' }, icon('external', 20), el('span', { text: t('download.web') }));

function draw(v) {
  if (!v.available) {
    body.replaceChildren(sayEl('p', { class: 'note', id: 'downloadComing' }, t('download.coming')), webApp());
    return;
  }
  body.replaceChildren(
    el(
      'div',
      { class: 'apk-box' },
      el('a', { class: 'btn primary block', href: v.url, download: 'forge.apk', id: 'downloadApk' }, icon('download', 20), el('span', { text: t('download.get', { mb: v.mb }) })),
      sayEl('p', { class: 'note' }, t('download.noGoogle')),
      el('h2', { class: 'caps', text: t('download.hash') }),
      el('p', { class: 'hash', id: 'downloadHash', text: v.hash }),
      sayEl('p', { class: 'note' }, t('download.hashSub')),
    ),
    el('h2', { class: 'caps', text: t('download.steps') }),
    el('ol', { id: 'downloadSteps' }, ...['download.step1', 'download.step2', 'download.step3', 'download.step4'].map((k) => el('li', {}, sayEl('span', {}, t(k))))),
    sayEl('p', { class: 'note' }, t('download.update')),
    webApp(),
  );
}

try {
  const res = await fetch('/download/info', { cache: 'no-store' });
  draw(apkView(res.ok ? await res.json() : null));
} catch {
  draw({ available: false });
}
