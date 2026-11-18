// Get the app (public/v2/core/getapp.js): which phone is which, and what each is offered. Android and
// computers keep the /download page; an iPhone or iPad gets the iPhone app's link when the site has one,
// else the Home Screen steps, and nothing once Forge is on its Home Screen; inside the apps, nothing.
import { describe, expect, it } from 'vitest';

const A: any = await import('../../../public/v2/core/getapp.js' as string);

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const LINK = 'https://testflight.apple.com/join/AbCd1234';

describe('which phone', () => {
  it('tells an iPhone, an iPad and an iPad asking for computer pages; never Android or a computer', () => {
    expect(A.isIOS({ ua: IPHONE, platform: 'iPhone', touchPoints: 5 })).toBe(true);
    expect(A.isIOS({ ua: IPHONE_CHROME, platform: 'iPhone', touchPoints: 5 })).toBe(true);
    expect(A.isIOS({ ua: IPAD_DESKTOP, platform: 'MacIntel', touchPoints: 5 })).toBe(true);
    expect(A.isIOS({ ua: IPAD_DESKTOP, platform: 'MacIntel', touchPoints: 0 })).toBe(false);
    expect(A.isIOS({ ua: MAC, platform: 'MacIntel', touchPoints: 0 })).toBe(false);
    expect(A.isIOS({ ua: ANDROID, platform: 'Linux armv8l', touchPoints: 5 })).toBe(false);
    expect(A.isIOS()).toBe(false);
    expect(A.isAndroid(ANDROID)).toBe(true);
    expect(A.isAndroid(IPHONE)).toBe(false);
  });

  it('knows a web app on the Home Screen, by Safari’s flag or the display mode', () => {
    const win = (standalone: boolean, mode: boolean) => ({ navigator: { standalone }, matchMedia: (q: string) => ({ matches: mode && q === '(display-mode: standalone)' }) });
    expect(A.installedWebApp(win(true, false))).toBe(true);
    expect(A.installedWebApp(win(false, true))).toBe(true);
    expect(A.installedWebApp(win(false, false))).toBe(false);
    expect(A.installedWebApp({})).toBe(false);
  });

  it('reads the phone from the window: an iPhone, inside an app, on the Home Screen', () => {
    const win = (ua: string, extra: object = {}) => ({ navigator: { userAgent: ua, platform: '', maxTouchPoints: 5 }, matchMedia: () => ({ matches: false }), ...extra });
    expect(A.thisPhone(win(IPHONE))).toEqual({ ios: true, native: false, installed: false });
    expect(A.thisPhone(win(ANDROID))).toEqual({ ios: false, native: false, installed: false });
    const app = { Capacitor: { isNativePlatform: () => true, nativePromise: () => Promise.resolve(), getPlatform: () => 'ios' } };
    expect(A.thisPhone(win(IPHONE, app))).toEqual({ ios: true, native: true, installed: false });
  });
});

describe('the iPhone link', () => {
  it('is taken only as an https address', () => {
    expect(A.iosLink({ available: false, ios: { available: true, url: LINK } })).toBe(LINK);
    for (const bad of [null, {}, { ios: null }, { ios: { url: 'http://testflight.apple.com/join/x' } }, { ios: { url: 'javascript:alert(1)' } }, { ios: { url: '/download/forge.apk' } }, { ios: { url: 42 } }]) {
      expect(A.iosLink(bad)).toBeNull();
    }
  });
});

describe('what is offered', () => {
  it('Android and computers: the /download page, link or not, as before', () => {
    for (const p of [{}, { iosUrl: LINK }, { installed: true }, { iphoneApp: false }]) expect(A.appOffer({ ios: false, ...p })).toEqual({ kind: 'download' });
  });

  it('an iPhone: the link when the site has one, else the Home Screen steps, and nothing once there', () => {
    expect(A.appOffer({ ios: true, iosUrl: LINK })).toEqual({ kind: 'link', url: LINK });
    expect(A.appOffer({ ios: true, iosUrl: LINK, installed: true })).toEqual({ kind: 'link', url: LINK });
    expect(A.appOffer({ ios: true })).toEqual({ kind: 'addHome' });
    expect(A.appOffer({ ios: true, installed: true })).toEqual({ kind: 'none' });
  });

  it('an iPhone where its app cannot help (Fedimint cards): nothing, never the Android page', () => {
    expect(A.appOffer({ ios: true, iphoneApp: false })).toEqual({ kind: 'none' });
    expect(A.appOffer({ ios: true, iphoneApp: false, iosUrl: LINK })).toEqual({ kind: 'none' });
  });

  it('inside the Android or iPhone app: nothing', () => {
    for (const ios of [true, false]) expect(A.appOffer({ ios, native: true, iosUrl: LINK })).toEqual({ kind: 'none' });
  });

  it('asks the site for the link only on an iPhone, outside the app', async () => {
    const asked: string[] = [];
    const win = (ua: string, answer: object) => ({
      navigator: { userAgent: ua, platform: '', maxTouchPoints: 5 },
      matchMedia: () => ({ matches: false }),
      fetch: async (url: string) => (asked.push(url), { ok: true, json: async () => answer }),
    });
    expect(await A.getAppOffer({ win: win(ANDROID, { ios: { url: LINK } }) })).toEqual({ kind: 'download' });
    expect(await A.getAppOffer({ win: win(IPHONE, { ios: { url: LINK } }), iphoneApp: false })).toEqual({ kind: 'none' });
    expect(asked).toEqual([]);
    expect(await A.getAppOffer({ win: win(IPHONE, { available: false, ios: { available: true, url: LINK } }) })).toEqual({ kind: 'link', url: LINK });
    expect(await A.getAppOffer({ win: win(IPHONE, { available: false }) })).toEqual({ kind: 'addHome' });
    expect(asked).toEqual(['/download/info', '/download/info']);
    // No answer (offline): the steps.
    const offline = { ...win(IPHONE, {}), fetch: async () => Promise.reject(new TypeError('offline')) };
    expect(await A.getAppOffer({ win: offline })).toEqual({ kind: 'addHome' });
  });
});
