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
 * The ways to get Forge, in the order the page shows them: `lead`, the ones for this phone, and
 * `other`, the rest under Other ways. Each is 'apk' (the APKs from this site), 'play' (Google Play),
 * 'iphone' (TestFlight or the App Store) or 'web' (Forge in the browser, always there). `ready` says
 * which are there now: {apk, play, iphone}.
 *   An iPhone: the iPhone app and the web app, the one that works first; never an Android way.
 *   Android: the APK and Google Play where they are there; else the web app first, with the APK's card
 *   saying it is not here yet.
 *   A computer: the web app, then the APK when there is one.
 * Under Other ways, the ones that are there come first.
 */
export function waysPlan(device, ready = {}) {
  const ok = { web: true, apk: !!ready.apk, play: !!ready.play, iphone: !!ready.iphone };
  if (device === 'ios') return { lead: ok.iphone ? ['iphone', 'web'] : ['web', 'iphone'], other: [] };
  let lead;
  if (device === 'android') {
    lead = ['apk', 'play'].filter((w) => ok[w]);
    if (!lead.length) lead = ['web', 'apk'];
  } else lead = ok.apk ? ['web', 'apk'] : ['web'];
  const rest = ['web', 'apk', 'play', 'iphone'].filter((w) => !lead.includes(w));
  return { lead, other: [...rest.filter((w) => ok[w]), ...rest.filter((w) => !ok[w])] };
}

/** The web app's address: with an event pass from this page's address (#<pass> or #join=<pass>), it opens a free balance with it. */
export const webAddress = (pass) => (pass ? webJoin(pass) : '/v2/');
