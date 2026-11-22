// What the /download page shows, from GET /download/info and the phone it is on. Pure, tested in Node.
import { isAndroid, isIOS } from '../core/getapp.js';
import { webJoin } from '../core/join.js';

/** {available, size, sha256, version?} -> the parts the page draws. fallback is the file's address when info has none. */
export function apkView(info, fallback = '/download/forge.apk') {
  const ok = !!info?.available && typeof info.sha256 === 'string' && /^[0-9a-f]{64}$/.test(info.sha256) && Number.isFinite(info.size) && info.size > 0;
  if (!ok) return { available: false };
  return {
    available: true,
    url: typeof info.url === 'string' && info.url.startsWith('/') ? info.url : fallback,
    // Megabytes with one decimal, never 0.0.
    mb: Math.max(0.1, Math.round(info.size / 104857.6) / 10).toFixed(1),
    // In groups of eight, so it can be read out and compared.
    hash: info.sha256.match(/.{8}/g).join(' '),
    // The app's own version, from the APK's manifest, when the site could read it.
    version: typeof info.version === 'string' && /^[\w.+-]{1,40}$/.test(info.version) ? info.version : null,
  };
}

/**
 * The APKs to offer, in order: Android (Forge, for every phone) and GrapheneOS (Forge Private Voice, with
 * its own speech to text; only when the site has it, info.privateVoice). Each is {id, icon, file, name, ...apkView}.
 */
export function apkChoices(info) {
  const out = [];
  const android = apkView(info);
  if (android.available) out.push({ id: 'android', icon: 'phone', file: 'forge.apk', name: 'Forge', ...android });
  const graphene = apkView(info?.privateVoice, '/download/forge-private-voice.apk');
  if (graphene.available) out.push({ id: 'graphene', icon: 'shield', file: 'forge-private-voice.apk', name: 'Forge Private Voice', ...graphene });
  return out;
}

/** A store's link from /download/info (info.ios or info.play): an https address, else null. */
export function storeLink(info, key) {
  const url = info?.[key]?.url;
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Which of Apple's two the iPhone app's link opens, by its host: TestFlight, or else the App Store. */
export const iosStore = (url) => {
  try {
    return new URL(url).hostname === 'testflight.apple.com' ? 'testflight' : 'appstore';
  } catch {
    return 'appstore';
  }
};

/** The phone the page is on: 'ios' (an iPhone or iPad), 'android', or 'computer' (anything else). */
export function deviceOf({ ua, platform, touchPoints } = {}) {
  if (isIOS({ ua, platform, touchPoints })) return 'ios';
  return isAndroid(ua) ? 'android' : 'computer';
}

/**
 * The row of ways under the button, in order, and the one picked first. Each way is 'android' (Forge,
 * from this site), 'graphene' (Forge Private Voice, from this site; only while the site has it), 'play'
 * (Google Play), 'iphone' (TestFlight or the App Store) or 'web' (Forge in the browser, always there).
 * `ready` says which are there now: {apk, graphene, play, iphone}.
 *   An iPhone: the iPhone app and the browser only, never an Android way; the iPhone app is picked once
 *   its link is set, else the browser.
 *   Android: its own ways first; the APK is picked, else Google Play, else the browser.
 *   A computer: the browser first and picked, then the rest.
 */
export function waysRow(device, ready = {}) {
  const ok = { android: !!ready.apk, graphene: !!ready.graphene, play: !!ready.play, iphone: !!ready.iphone, web: true };
  const order = device === 'ios' ? ['iphone', 'web'] : device === 'android' ? ['android', 'graphene', 'play', 'iphone', 'web'] : ['web', 'android', 'graphene', 'play', 'iphone'];
  const ways = order.filter((w) => w !== 'graphene' || ok.graphene).map((id) => ({ id, ready: ok[id] }));
  const first = device === 'ios' ? ['iphone', 'web'] : device === 'android' ? ['android', 'play', 'web'] : ['web'];
  return { ways, pick: first.find((w) => ok[w]) };
}

/**
 * Where the rings' bright tips point for the way at index i of n: degrees clockwise from the top, spread
 * over the bottom of the rings so the tips lean towards that way in the row under them.
 */
export const tipAngle = (i, n) => (n < 2 ? 180 : Math.round(180 + 40 - (80 * i) / (n - 1)));

/** The web app's address: with an event pass from this page's address (#<pass> or #join=<pass>), it opens a free balance with it. */
export const webAddress = (pass) => (pass ? webJoin(pass) : '/v2/');

/** The ways a row can show. */
export const WAY_IDS = ['android', 'graphene', 'play', 'iphone', 'web'];

/** A way named in the page's address (#way=android, as the landing page's Download panel links), or null. */
export function wayFrom(hash) {
  const m = /^#way=([a-z]+)$/.exec(String(hash ?? ''));
  return m && WAY_IDS.includes(m[1]) ? m[1] : null;
}

/** The way to pick: the one the address names when it is there in the row, else the row's own pick. */
export const pickWay = ({ ways, pick }, wanted) => (ways.some((w) => w.id === wanted && w.ready) ? wanted : pick);
