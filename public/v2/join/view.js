// What the /j page does with the event link it was opened on (/j#<pass>). Pure, tested in Node.
import { isAndroid } from '../core/getapp.js';
import { passFrom, webJoin } from '../core/join.js';

export { isAndroid, passFrom, webJoin };

/** The two Android apps, by the id the /download page gives each choice (download/view.js apkChoices). */
export const PACKAGES = { android: 'com.forgereserve.ai', graphene: 'com.forgereserve.ai.privatevoice' };

/**
 * Where /j goes: {go} to leave at once, or {show: pass} for the two steps. No pass: the download page
 * (Forge for iPhone on an iPhone).
 * Not Android (an iPhone, a computer): the web app. Android with no APK on this site: the web app too.
 */
export function joinRoute({ hash, ua, apks = 1 }) {
  const pass = passFrom(hash);
  if (!pass) return { go: '/download' };
  if (!isAndroid(ua) || !apks) return { go: webJoin(pass) };
  return { show: pass };
}

/**
 * The link that opens the app on the pass: Chrome's intent: form, so the app is named and the link
 * never opens in the browser instead. The app gets https://<host>/j#<pass> (Intent.parseUri cuts the
 * intent at its last '#', so the pass's own '#' stays in the address). When the app is not installed,
 * Chrome goes to fallback rather than to an app store.
 */
export function openAppUrl({ host, pass, pkg, fallback }) {
  return `intent://${host}/j#${pass}#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/** Where Chrome goes when the app is not there: this page again, saying to get the app first. */
export const noAppUrl = ({ origin, pass }) => `${origin}/j?app=none#${pass}`;
