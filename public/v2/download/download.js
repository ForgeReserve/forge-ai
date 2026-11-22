// The /download page: the app's own button in its two rings, and under it a row of ways to get Forge, a
// picture and a word each. Picking a way changes what the button does and says, and turns the rings'
// bright tips towards it. The ways (view.js waysRow):
// - Android and GrapheneOS, from this site: the button downloads the APK (Forge, or Forge Private Voice).
//   Under it, quietly: the version, the SHA-256 behind Check (with Copy), and four pictures of how to
//   install, which play in turn once the download has started. With no APK, Android says Soon.
// - Google Play: Soon, and no way to pick it, until the site has Forge's Play page (FORGE_PLAY_URL).
// - iPhone: Soon until the site has the iPhone app's link (FORGE_IOS_URL). An iPhone sees only the
//   iPhone and the browser, never an Android way; with no link, the browser is picked and the pictures
//   show how to put Forge on the Home Screen.
// - The browser: the button opens Forge, with an event pass from this page's address (#<pass>).
// A Soon way is in the row, dim, marked aria-disabled and left out of the keyboard's way. Nothing here is
// sent anywhere but this site.
import { appOffer, thisPhone } from '../core/getapp.js';
import { t } from '../core/i18n.js';
import { passFrom } from '../core/join.js';
import { applyPageLook } from '../core/pagelook.js';
import { el, icon, sayEl } from '../core/ui.js';
import { apkChoices, deviceOf, iosStore, storeLink, tipAngle, waysRow, webAddress } from './view.js';

applyPageLook();
const phone = thisPhone();
const device = deviceOf({ ua: navigator.userAgent, platform: navigator.platform, touchPoints: navigator.maxTouchPoints });
const web = webAddress(passFrom(location.hash));
document.title = t('download.heading');

const main = document.getElementById('main');
const stage = document.getElementById('stage');
const row = document.getElementById('ways');
const more = document.getElementById('downloadBody');
let go = document.getElementById('downloadGo');
const still = matchMedia('(prefers-reduced-motion: reduce)');
main.dataset.device = device;

/** Each way's picture and word in the row, and its name for a screen reader. */
const WAYS = {
  android: { ico: 'android', word: 'download.wayAndroid', name: 'download.android' },
  graphene: { ico: 'shield', word: 'download.wayGraphene', name: 'download.graphene' },
  play: { ico: 'play', word: 'download.wayPlay', name: 'download.playName' },
  iphone: { ico: 'apple', word: 'download.wayIphone', name: 'download.iosName' },
  web: { ico: 'globe', word: 'download.wayWeb', name: 'download.webName' },
};

/** A row of numbered pictures, a word or three under each (the number comes from the list). */
const pictures = (id, cls, steps) => el('ol', { class: `steps ${cls}`, id }, ...steps.map(([ico, key]) => el('li', { class: cls === 'home' ? 'add-home-step' : '' }, el('span', { class: 'step-ico', 'aria-hidden': 'true' }, icon(ico, 26)), el('span', { class: 'step-word', text: t(key) }))));

/** Lets the steps play in turn, from the first. */
function play(list) {
  if (!list || still.matches) return;
  list.removeAttribute('data-play');
  void list.offsetWidth;
  list.dataset.play = '';
}

function draw(info) {
  const choices = device === 'ios' ? [] : apkChoices(info);
  const apk = Object.fromEntries(choices.map((c) => [c.id, c]));
  const ios = storeLink(info, 'ios');
  const playUrl = storeLink(info, 'play');
  const { ways, pick } = waysRow(device, { apk: !!apk.android, graphene: !!apk.graphene, play: !!playUrl, iphone: !!ios });
  // On an iPhone, what Get the app offers there (core/getapp.js): the link, the Home Screen steps or nothing.
  const offer = device === 'ios' ? appOffer({ ...phone, iosUrl: ios }) : null;

  /** What the button does and says for each way: its address, its id, a picture, a word and a quiet line. */
  const action = {
    android: () => ({ href: apk.android.url, file: apk.android.file, id: 'downloadApk', ico: 'download', word: t('download.go'), sub: t('download.mb', { mb: apk.android.mb }) }),
    graphene: () => ({ href: apk.graphene.url, file: apk.graphene.file, id: 'downloadApk', ico: 'download', word: t('download.go'), sub: t('download.mb', { mb: apk.graphene.mb }) }),
    play: () => ({ href: playUrl, id: 'downloadPlay', ico: 'external', word: t('download.getIt'), sub: t('download.playName') }),
    iphone: () => ({ href: ios, id: 'downloadIos', ico: 'external', word: t('download.getIt'), sub: t(`download.${iosStore(ios)}`) }),
    web: () => ({ href: web, id: 'openWeb', ico: 'external', word: t('download.open'), sub: t('download.forge') }),
  };

  /** The quiet part under the row for the way picked. */
  function details(way) {
    if (way === 'android' || way === 'graphene') {
      const c = apk[way];
      const hash = el('code', { class: 'hash', id: 'downloadHash' }, ...c.hash.split(' ').flatMap((g, i) => [el('span', { text: g }), i < 7 ? ' ' : null]).filter(Boolean));
      const copied = el('span', { class: 'sr-only', id: 'downloadCopied', role: 'status' });
      const copyWord = el('span', { text: t('download.copy') });
      const copy = el('button', { type: 'button', class: 'quiet', id: 'downloadCopy', 'aria-label': t('download.copyLabel') }, icon('copy', 20), copyWord);
      let timer = 0;
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(c.hash.replaceAll(' ', ''));
        } catch {
          // No clipboard here: select it, so the phone's own Copy takes it.
          getSelection()?.selectAllChildren(hash);
          return;
        }
        copy.dataset.done = '';
        copy.replaceChildren(icon('check', 20), el('span', { text: t('download.copied') }));
        copied.textContent = t('download.copied');
        clearTimeout(timer);
        timer = setTimeout(() => (delete copy.dataset.done, copy.replaceChildren(icon('copy', 20), copyWord), (copied.textContent = '')), 2500);
      });
      const print = el('div', { class: 'print', id: 'downloadPrint', hidden: true }, hash, el('div', { class: 'print-foot' }, sayEl('p', { class: 'note' }, t('download.hashSub')), copy), copied);
      const check = el('button', { type: 'button', class: 'quiet', id: 'downloadCheck', 'aria-expanded': 'false', 'aria-controls': 'downloadPrint', 'aria-label': t('download.checkLabel') }, icon('fingerprint', 20), el('span', { text: t('download.check') }));
      check.addEventListener('click', () => {
        const open = print.hidden;
        print.hidden = !open;
        check.setAttribute('aria-expanded', String(open));
      });
      // With both APKs, one line on what the one picked is, behind the info button.
      const about = el('p', { class: 'about', id: 'downloadAbout', hidden: true, text: t(`download.${way}Info`) });
      const info = apk.android && apk.graphene ? el('button', { type: 'button', class: 'quiet round', id: 'downloadInfo', 'aria-expanded': 'false', 'aria-controls': 'downloadAbout', 'aria-label': t('download.about', { name: t(`download.${way}`) }) }, icon('info', 20)) : null;
      info?.addEventListener('click', () => {
        about.hidden = !about.hidden;
        info.setAttribute('aria-expanded', String(!about.hidden));
      });
      const name = way === 'graphene' ? 'Forge Private Voice' : 'Forge';
      return [
        el('div', { class: 'line' }, el('span', { class: 'meta', id: 'apkSub', text: c.version ? `${name} · ${t('download.version', { version: c.version })}` : name }), info, check),
        about,
        print,
        el('h2', { class: 'sr-only', text: t('download.steps') }),
        pictures('downloadSteps', 'install', [
          ['download', 'download.s1'],
          ['file', 'download.s2'],
          ['shield', 'download.s3'],
          ['external', 'download.s4'],
        ]),
        sayEl('p', { class: 'note' }, t('download.update'), '', 'again'),
      ];
    }
    if (way === 'web' && offer?.kind === 'addHome') {
      // The Home Screen steps, as Safari's own buttons look: open Forge first, so what goes on the Home
      // Screen is Forge itself. They play in turn.
      return [el('section', { class: 'add-home', id: 'addHome', 'aria-labelledby': 'addHomeHead' }, el('h2', { class: 'sr-only', id: 'addHomeHead', text: t('getApp.home') }), pictures('addHomeSteps', 'home', [['external', 'getApp.open'], ['iosShare', 'getApp.share'], ['addSquare', 'getApp.add']]))];
    }
    return [];
  }

  /** Shows a way: the button changes face, the rings turn, the details change in place. */
  let picked = null;
  function choose(way, { first = false } = {}) {
    if (way === picked) return;
    picked = way;
    const i = ways.findIndex((w) => w.id === way);
    for (const b of row.querySelectorAll('[role=radio]')) {
      const on = b.dataset.way === way;
      b.setAttribute('aria-checked', String(on));
      if (b.getAttribute('aria-disabled') !== 'true') b.tabIndex = on ? 0 : -1;
    }
    row.style.setProperty('--i', String(i));
    stage.style.setProperty('--a', `${tipAngle(i, ways.length)}deg`);
    main.dataset.way = way;
    main.dataset.state = 'ready';
    const a = action[way]();
    const face = el('span', { class: 'face' }, icon(a.ico, 34), el('span', { class: 'go-word', text: a.word }), el('span', { class: 'go-sub', text: a.sub }));
    const next = el('a', { class: 'go', id: a.id, href: a.href }, face);
    if (a.file) next.download = a.file;
    next.addEventListener('click', () => started(way));
    next.addEventListener('pointerdown', () => ripple());
    const old = go.querySelector('.face');
    if (!first && !still.matches && old && typeof old.animate === 'function') {
      // The old face leaves upward as the new one comes up into place.
      old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px) scale(0.96)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      face.animate([{ opacity: 0, transform: 'translateY(12px) scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 120, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' });
      setTimeout(() => swap(next), 150);
    } else swap(next);
    more.replaceChildren(...details(way));
    if (!first && !still.matches && typeof more.animate === 'function') more.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    play(document.getElementById('addHomeSteps'));
  }
  function swap(next) {
    go.replaceWith(next);
    go = next;
  }

  /** The download started (or the link is opening): the rings close once around, the button shows a check, and the steps play. */
  function started(way) {
    if (way !== 'android' && way !== 'graphene') return;
    main.dataset.state = 'ready';
    void stage.offsetWidth;
    main.dataset.state = 'started';
    go.querySelector('.face')?.replaceWith(el('span', { class: 'face' }, icon('check', 34), el('span', { class: 'go-word', text: t('download.started') }), el('span', { class: 'go-sub', text: t('download.mb', { mb: apk[way].mb }) })));
    play(document.getElementById('downloadSteps'));
  }

  /** A ring of light goes out from the button under the finger. */
  function ripple() {
    if (still.matches) return;
    stage.classList.remove('pressed');
    void stage.offsetWidth;
    stage.classList.add('pressed');
  }

  row.replaceChildren(
    ...ways.map((w, i) => {
      const meta = WAYS[w.id];
      const b = el(
        'button',
        { type: 'button', role: 'radio', class: 'way', id: `way-${w.id}`, 'data-way': w.id, 'data-state': w.ready ? 'ready' : 'soon', 'aria-checked': 'false', 'aria-label': w.ready ? t(meta.name) : `${t(meta.name)}, ${t('download.soon')}`, tabindex: '-1' },
        el('span', { class: 'way-ico', 'aria-hidden': 'true' }, icon(meta.ico, 30)),
        el('span', { class: 'way-word', 'aria-hidden': 'true', text: w.ready ? t(meta.word) : t('download.soon') }),
      );
      b.style.setProperty('--n', String(i));
      if (w.ready) b.addEventListener('click', () => choose(w.id));
      else b.setAttribute('aria-disabled', 'true');
      return b;
    }),
    el('span', { class: 'mark', 'aria-hidden': 'true' }),
  );
  row.style.setProperty('--count', String(ways.length));
  // Arrows move along the ways that are there, as in any radio group.
  row.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const open = ways.filter((w) => w.ready);
    const next = open[(open.findIndex((w) => w.id === picked) + step + open.length) % open.length];
    choose(next.id);
    document.getElementById(`way-${next.id}`)?.focus();
  });
  choose(pick, { first: true });
  if (offer) more.dataset.offer = offer.kind;
  more.dataset.plan = ways.map((w) => `${w.id}${w.ready ? '' : '?'}`).join(' ');
  more.removeAttribute('aria-busy');
}

let info = null;
try {
  const res = await fetch('/download/info', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
  info = res.ok ? await res.json() : null;
} catch {
  /* offline or no answer: the browser, and the rest as Soon */
}
draw(info);
