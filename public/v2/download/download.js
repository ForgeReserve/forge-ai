// The /download page: the Android app's APK, its size and its SHA-256, and how to install it. When the
// site has no APK yet it says the app is coming and points to the web app. Nothing here is sent anywhere
// but this site.
import { t } from '../core/i18n.js';
import { el, icon } from '../core/ui.js';
import { tokens as dark } from '../modules/look/dark/index.js';
import { tokens as light } from '../modules/look/light/index.js';
import { apkView } from './view.js';

const scheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const look = scheme === 'dark' ? dark : light;
for (const [k, v] of Object.entries(look)) document.documentElement.style.setProperty(`--${k}`, v);
document.documentElement.style.colorScheme = scheme;
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', look.bg);
document.title = t('download.title');

const root = document.getElementById('download');
const body = el('div', { class: 'download-body', id: 'downloadBody', 'aria-live': 'polite' });
root.replaceChildren(el('main', { class: 'screen download-page', 'data-screen': 'download' }, el('h1', { text: t('download.title') }), el('p', { class: 'lead', text: t('download.lead') }), body));

const webApp = () => el('a', { class: 'btn block', href: '/v2/', id: 'openWeb' }, icon('external', 20), el('span', { text: t('download.web') }));

function draw(v) {
  if (!v.available) {
    body.replaceChildren(el('p', { class: 'note', id: 'downloadComing', text: t('download.coming') }), webApp());
    return;
  }
  body.replaceChildren(
    el(
      'div',
      { class: 'apk-box' },
      el('a', { class: 'btn primary block', href: v.url, download: 'forge.apk', id: 'downloadApk' }, icon('download', 20), el('span', { text: t('download.get', { mb: v.mb }) })),
      el('p', { class: 'note', text: t('download.noGoogle') }),
      el('h2', { class: 'caps', text: t('download.hash') }),
      el('p', { class: 'hash', id: 'downloadHash', text: v.hash }),
      el('p', { class: 'note', text: t('download.hashSub') }),
    ),
    el('h2', { class: 'caps', text: t('download.steps') }),
    el('ol', { id: 'downloadSteps' }, ...['download.step1', 'download.step2', 'download.step3', 'download.step4'].map((k) => el('li', { text: t(k) }))),
    el('p', { class: 'note', text: t('download.update') }),
    webApp(),
  );
}

try {
  const res = await fetch('/download/info', { cache: 'no-store' });
  draw(apkView(res.ok ? await res.json() : null));
} catch {
  draw({ available: false });
}
