// Getting Forge as an app, where a page offers it: "Get the app" on the card ways and the /download
// page. Android and computers: the /download page and its APKs, as before. iPhones and iPads have no
// download yet, so there the web app is the product: the button opens the iPhone app's link when the
// site has one (FORGE_IOS_URL, a TestFlight or App Store link, in /download/info as ios.url), and
// otherwise the page shows how to put Forge on the Home Screen (Share, then Add to Home Screen), or
// nothing once Forge is already there. Inside the Android or iPhone app: nothing. The decisions are pure
// and tested in Node; only getAppOffer reads the phone and the site.
import { nativeBridge } from './native.js';

/** An Android phone, by its user agent (the /j page's test, public/v2/join/view.js). */
export const isAndroid = (ua) => /\bAndroid\b/i.test(String(ua ?? ''));

/**
 * An iPhone, iPod or iPad, also an iPad that asks for computer pages (it then says Mac, with a touch
 * screen). The Classic app's test (public/app.js isIOS).
 */
export const isIOS = ({ ua, platform, touchPoints } = {}) => /iPhone|iPad|iPod/.test(String(ua ?? '')) || (platform === 'MacIntel' && touchPoints > 1);

/** True when this page runs as a web app put on the Home Screen (or installed): the Classic app's test. */
export function installedWebApp(win = globalThis) {
  try {
    return win?.matchMedia?.('(display-mode: standalone)')?.matches === true || win?.navigator?.standalone === true;
  } catch {
    return false;
  }
}

/** The iPhone app's link from /download/info: an https address, else null. */
export function iosLink(info) {
  const url = info?.ios?.url;
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * What a place that offers the app shows. ios: an iPhone or iPad; native: inside the Android or iPhone
 * app; installed: a web app on the Home Screen; iosUrl: the iPhone app's link, or null; iphoneApp: false
 * where the iPhone app cannot do what this place needs (Fedimint cards: it has no till).
 *   {kind: 'download'}: the /download page, Android's APKs (Android and computers, as before).
 *   {kind: 'link', url}: the iPhone app's link.
 *   {kind: 'addHome'}: the Home Screen steps.
 *   {kind: 'none'}: nothing to offer.
 */
export function appOffer({ ios = false, native = false, installed = false, iosUrl = null, iphoneApp = true } = {}) {
  if (native) return { kind: 'none' };
  if (!ios) return { kind: 'download' };
  if (!iphoneApp) return { kind: 'none' };
  if (iosUrl) return { kind: 'link', url: iosUrl };
  return installed ? { kind: 'none' } : { kind: 'addHome' };
}

/** This phone, for appOffer: an iPhone or iPad, inside an app, put on the Home Screen. */
export function thisPhone(win = globalThis) {
  const nav = win?.navigator ?? {};
  return { ios: isIOS({ ua: nav.userAgent, platform: nav.platform, touchPoints: nav.maxTouchPoints }), native: !!nativeBridge(win), installed: installedWebApp(win) };
}

/**
 * What this phone is offered (appOffer). Only an iPhone or iPad asks this site's /download/info for the
 * iPhone app's link; with no answer in time, it has none.
 */
export async function getAppOffer({ iphoneApp = true, win = globalThis, timeoutMs = 4000 } = {}) {
  const phone = thisPhone(win);
  let iosUrl = null;
  if (asksSite(phone, iphoneApp)) {
    try {
      const res = await win.fetch('/download/info', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      iosUrl = res.ok ? iosLink(await res.json()) : null;
    } catch {
      /* offline or no answer: no link */
    }
  }
  return appOffer({ ...phone, iosUrl, iphoneApp });
}

/** Whether the offer waits on the site's answer: only on an iPhone or iPad, outside the app. */
const asksSite = (phone, iphoneApp) => phone.ios && !phone.native && iphoneApp;

/**
 * Puts the offer in `slot` (offerNode) and its kind in slot's data-offer: at once on Android and
 * computers, as before, and on an iPhone once the site has said whether it has the iPhone app's link.
 * alive(): false once the screen is gone.
 */
export function showOffer(slot, parts, t, { id, iphoneApp = true, open = null, alive = () => true, win = globalThis } = {}) {
  const put = (offer) => {
    const node = offerNode(offer, parts, t, { id, open });
    slot.replaceChildren(...(node ? [node] : []));
    // What was offered, once it is drawn (the tests wait for it).
    slot.dataset.offer = offer.kind;
  };
  const phone = thisPhone(win);
  if (!asksSite(phone, iphoneApp)) return put(appOffer({ ...phone, iphoneApp }));
  getAppOffer({ iphoneApp, win }).then((offer) => alive() && put(offer));
}

/**
 * The offer drawn with the screen's own parts ({el, icon, sayEl}, core/ui.js): the button, the Home
 * Screen steps or null. id: the button's id. open: on a page outside the web app (/download), the steps
 * start with opening Forge, so what goes on the Home Screen is Forge itself.
 */
export function offerNode(offer, { el, icon, sayEl }, t, { id, open = null } = {}) {
  if (offer.kind === 'download') return el('a', { class: 'btn primary block', id, href: '/download' }, icon('download', 20), el('span', { text: t('fund.card.getApp') }));
  if (offer.kind === 'link') return el('a', { class: 'btn primary block', id, href: offer.url }, icon('download', 20), el('span', { text: t('fund.card.getApp') }));
  if (offer.kind !== 'addHome') return null;
  const step = (ico, key) => el('li', { class: 'add-home-step' }, el('span', { class: 'add-home-ico', 'aria-hidden': 'true' }, icon(ico, 26)), el('span', { text: t(key) }));
  return el(
    'section',
    { class: 'add-home', id: 'addHome', 'aria-labelledby': 'addHomeHead' },
    sayEl('p', { id: 'addHomeHead' }, t('getApp.home')),
    el(
      'ol',
      { class: 'add-home-steps' },
      open ? el('li', { class: 'add-home-step' }, el('a', { class: 'btn primary block', id: 'addHomeOpen', href: open }, icon('external', 20), el('span', { text: t('getApp.open') }))) : null,
      step('iosShare', 'getApp.share'),
      step('addSquare', 'getApp.add'),
    ),
  );
}
