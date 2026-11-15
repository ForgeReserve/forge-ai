// The /j page, the one QR code on an event's slide (docs/ANDROID.md, Event links). The pass is in the
// address's fragment, so it never left this phone. Not Android: straight into the web app, which opens a
// free balance with it. Android: two big steps, Get the app (the /download page's APKs) and Open the app
// on the pass, and a small Use in browser. No pass: the /download page.
import { t } from '../core/i18n.js';
import { applyPageLook } from '../core/pagelook.js';
import { el, icon, sayEl } from '../core/ui.js';
import { apkChoices } from '../download/view.js';
import { joinRoute, noAppUrl, openAppUrl, PACKAGES, webJoin } from './view.js';

// The app picked here last (the one downloaded), so Open opens that one.
const PICKED = 'forge2.join.apk';
const load = () => {
  try {
    return localStorage.getItem(PICKED);
  } catch {
    return null;
  }
};
const keep = (id) => {
  try {
    localStorage.setItem(PICKED, id);
  } catch {
    /* no storage: Open opens the first choice */
  }
};

const first = joinRoute({ hash: location.hash, ua: navigator.userAgent });
if (first.go) location.replace(first.go);
else await show(first.show);

async function show(pass) {
  let choices = [];
  try {
    const res = await fetch('/download/info', { cache: 'no-store' });
    choices = apkChoices(res.ok ? await res.json() : null);
  } catch {
    /* offline: no APK to offer */
  }
  const route = joinRoute({ hash: location.hash, ua: navigator.userAgent, apks: choices.length });
  if (route.go) return location.replace(route.go);

  applyPageLook();
  document.title = t('join.title');
  const noApp = new URLSearchParams(location.search).get('app') === 'none';
  let picked = choices.find((c) => c.id === load()) ?? choices[0];

  const get = el('a', { class: 'btn primary block', id: 'joinGet' });
  const open = el('a', { class: 'btn primary block', id: 'joinOpen' }, icon('external', 20), el('span', { text: t('join.open') }));
  const about = el('p', { class: 'note', id: 'joinAbout', hidden: true });
  const draw = () => {
    get.href = picked.url;
    get.download = picked.file;
    get.replaceChildren(icon('download', 20), el('span', { text: t('download.get', { mb: picked.mb }) }));
    open.href = openAppUrl({ host: location.host, pass, pkg: PACKAGES[picked.id], fallback: noAppUrl({ origin: location.origin, pass }) });
    for (const b of document.querySelectorAll('.apk-kind')) b.setAttribute('aria-checked', String(b.id === `apk-${picked.id}`));
  };
  const choose = (c) => {
    picked = c;
    keep(c.id);
    about.hidden = true;
    draw();
  };
  get.addEventListener('click', () => keep(picked.id));
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
              el('button', { type: 'button', role: 'radio', class: 'apk-kind', id: `apk-${c.id}`, 'aria-checked': 'false', onclick: () => choose(c) }, icon(c.icon, 24), el('span', { text: t(`download.${c.id}`) })),
              el(
                'button',
                {
                  type: 'button',
                  class: 'apk-info',
                  id: `apk-${c.id}-info`,
                  'aria-label': t('download.about', { name: t(`download.${c.id}`) }),
                  'aria-controls': 'joinAbout',
                  onclick: () => {
                    const text = t(`download.${c.id}Info`);
                    about.hidden = !about.hidden && about.textContent === text;
                    about.textContent = text;
                  },
                },
                icon('info', 20),
              ),
            ),
          ),
        );
  const step = (n, key, attention, ...kids) =>
    el('section', { class: `join-step${attention ? ' attention' : ''}`, id: `joinStep${n}`, 'aria-labelledby': `joinStep${n}Head` }, el('h2', { id: `joinStep${n}Head` }, el('span', { class: 'join-num', 'aria-hidden': 'true', text: String(n) }), el('span', { text: t(key) })), ...kids);
  const root = document.getElementById('join');
  root.replaceChildren(
    el(
      'main',
      { class: 'screen download-page join-page', 'data-screen': 'join' },
      el('h1', {}, icon('gift', 30), el('span', { text: t('join.title') })),
      sayEl('p', { class: 'lead' }, t('join.lead')),
      step(1, 'join.step1', noApp, ...(pick ? [pick, about] : []), get, noApp ? sayEl('p', { class: 'note', id: 'joinNoApp', role: 'status' }, t('join.noApp'), '', 'alert') : null, sayEl('p', { class: 'note' }, t('download.step3'))),
      step(2, 'join.step2', false, open),
      el('a', { class: 'btn join-web', href: webJoin(pass), id: 'joinWeb' }, icon('globe', 20), el('span', { text: t('download.web') })),
    ),
  );
  draw();
}
