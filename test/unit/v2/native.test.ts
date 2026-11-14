import { describe, expect, it } from 'vitest';

// The Android app's side of the v2 app: the Capacitor bridge (core/native.js), the engine address
// setting (core/engineaddr.js) and what the photo screen does with the app's share sheet.
const N: any = await import('../../../public/v2/core/native.js' as string);
const A: any = await import('../../../public/v2/core/engineaddr.js' as string);
const PH: any = await import('../../../public/v2/core/photo.js' as string);
const R: any = await import('../../../public/v2/core/router.js' as string);
const ST: any = await import('../../../public/v2/core/state.js' as string);

/** A stand-in for the bridge Capacitor puts on window in the app, recording each plugin call. */
function fakeCapacitor(answers: Record<string, (opts: any) => any> = {}) {
  const calls: Array<[string, string, any]> = [];
  const listeners: Array<[string, string, () => void]> = [];
  const Capacitor = {
    isNativePlatform: () => true,
    nativePromise: async (plugin: string, method: string, opts: any) => {
      calls.push([plugin, method, opts]);
      const f = answers[`${plugin}.${method}`];
      return f ? f(opts) : undefined;
    },
    addListener: (plugin: string, event: string, fn: () => void) => {
      listeners.push([plugin, event, fn]);
      return { remove: async () => {} };
    },
  };
  return { win: { Capacitor }, calls, listeners };
}

describe('the native bridge', () => {
  it('is there only inside the app', () => {
    expect(N.nativeBridge({})).toBeNull();
    expect(N.nativeBridge({ Capacitor: { isNativePlatform: () => false, nativePromise: () => {} } })).toBeNull();
    expect(N.nativeBridge({ Capacitor: { isNativePlatform: () => true } })).toBeNull();
    expect(N.createNative({})).toBeNull();
    expect(N.nativeBridge(fakeCapacitor().win)).not.toBeNull();
  });

  it('uses this site on the website and Forge\'s engine in the app', () => {
    expect(N.defaultEngine(null)).toBe('');
    expect(N.defaultEngine({})).toBe('https://ai.forge-reserve.com');
    expect(N.DEFAULT_ENGINE).toBe('https://ai.forge-reserve.com');
    // The app's balance key is stored under the engine's name, never as this origin's v1 key.
    expect(ST.keyName(N.DEFAULT_ENGINE, 'https://localhost')).toBe('forge.balanceKey@https://ai.forge-reserve.com');
  });

  it('moves files across as base64, any byte value and size', () => {
    const big = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect(N.base64ToBytes(N.bytesToBase64(big))).toEqual(big);
    expect(N.bytesToBase64(new Uint8Array([0, 255, 128]))).toBe('AP+A');
    expect(N.base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('shares the protected photo through the app\'s sheet', async () => {
    const { win, calls } = fakeCapacitor();
    const nat = N.createNative(win);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], 'forge-photo.jpg', { type: 'image/jpeg' });
    expect(nat.share.canShareFiles([file])).toBe(true);
    expect(await nat.share.files([file])).toEqual({ opened: true });
    expect(calls).toEqual([['ForgeShare', 'share', { name: 'forge-photo.jpg', mime: 'image/jpeg', data: '/9j/AQ==' }]]);
    // The photo screen does not say "Shared": the app is not told whether the person sent it.
    expect(await PH.shareOrSave(file, nat.share)).toBe('opened');
  });

  it('says whether the photo was saved or the save screen was closed', async () => {
    let saved = true;
    const { win } = fakeCapacitor({ 'ForgeShare.save': () => ({ saved }) });
    const nat = N.createNative(win);
    const file = new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' });
    expect(await nat.share.save(file)).toEqual({ saved: true });
    saved = false;
    expect(await nat.share.save(file)).toEqual({ saved: false });
  });

  it('a sheet that fails to open is an error, not a share', async () => {
    const { win } = fakeCapacitor({
      'ForgeShare.share': () => {
        throw Object.assign(new Error('no'), { code: 'share_failed' });
      },
    });
    const nat = N.createNative(win);
    await expect(PH.shareOrSave(new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' }), nat.share)).rejects.toThrow('no');
  });

  it('takes a photo shared in once, as a file', async () => {
    let waiting: any = { mime: 'image/png', data: N.bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) };
    const { win, calls, listeners } = fakeCapacitor({
      'ForgeShareIn.waiting': () => ({ waiting: !!waiting }),
      'ForgeShareIn.take': () => {
        const w = waiting;
        waiting = null;
        return w ?? {};
      },
    });
    const nat = N.createNative(win);
    expect(await nat.shareIn.waiting()).toBe(true);
    const f = await nat.shareIn.take();
    expect(f).toBeInstanceOf(File);
    expect(f.type).toBe('image/png');
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(await nat.shareIn.waiting()).toBe(false);
    expect(await nat.shareIn.take()).toBeNull();
    let opened = 0;
    nat.shareIn.onShared(() => opened++);
    expect(listeners.map(([p, e]) => `${p}.${e}`)).toEqual(['ForgeShareIn.shared']);
    listeners[0]![2]();
    expect(opened).toBe(1);
    await nat.shareIn.clear();
    await nat.forget();
    expect(calls.map(([p, m]) => `${p}.${m}`).slice(-2)).toEqual(['ForgeShareIn.clear', 'ForgeShare.forget']);
  });

  it('passes on why a shared photo did not come through', async () => {
    for (const problem of ['none', 'missed']) {
      const nat = N.createNative(fakeCapacitor({ 'ForgeShareIn.take': () => ({ problem }) }).win);
      await expect(nat.shareIn.take()).rejects.toMatchObject({ code: problem });
    }
  });

  it('a broken bridge reads as nothing waiting', async () => {
    const nat = N.createNative(
      fakeCapacitor({
        'ForgeShareIn.waiting': () => {
          throw new Error('bridge');
        },
      }).win,
    );
    expect(await nat.shareIn.waiting()).toBe(false);
  });
});

describe('the engine address', () => {
  it('takes an https address, with or without https://, without its trailing slash', () => {
    expect(A.normalizeEngine('https://ai.forge-reserve.com/')).toEqual({ ok: true, value: 'https://ai.forge-reserve.com' });
    expect(A.normalizeEngine('  ai.example.org ')).toEqual({ ok: true, value: 'https://ai.example.org' });
    expect(A.normalizeEngine('HTTPS://AI.Example.org:8443/bellows/')).toEqual({ ok: true, value: 'https://ai.example.org:8443/bellows' });
  });

  it('allows plain http only to this computer', () => {
    expect(A.normalizeEngine('http://127.0.0.1:8787')).toEqual({ ok: true, value: 'http://127.0.0.1:8787' });
    expect(A.normalizeEngine('http://localhost:3000/')).toEqual({ ok: true, value: 'http://localhost:3000' });
    expect(A.normalizeEngine('http://ai.example.org')).toEqual({ ok: false, why: 'insecure' });
    expect(A.normalizeEngine('http://192.168.1.10')).toEqual({ ok: false, why: 'insecure' });
    expect(A.normalizeEngine('http://127.0.0.1.example.org')).toEqual({ ok: false, why: 'insecure' });
  });

  it('refuses what is not an engine address', () => {
    expect(A.normalizeEngine('')).toEqual({ ok: false, why: 'empty' });
    expect(A.normalizeEngine('   ')).toEqual({ ok: false, why: 'empty' });
    expect(A.normalizeEngine(null)).toEqual({ ok: false, why: 'empty' });
    expect(A.normalizeEngine('javascript:alert(1)')).toMatchObject({ ok: false });
    expect(A.normalizeEngine('ftp://ai.example.org')).toEqual({ ok: false, why: 'invalid' });
    expect(A.normalizeEngine('not an address')).toEqual({ ok: false, why: 'invalid' });
    expect(A.normalizeEngine('https://user:pw@ai.example.org')).toEqual({ ok: false, why: 'extra' });
    expect(A.normalizeEngine('https://ai.example.org/?x=1')).toEqual({ ok: false, why: 'extra' });
    expect(A.normalizeEngine('https://ai.example.org/#k')).toEqual({ ok: false, why: 'extra' });
  });

  it('shows the address without https://', () => {
    expect(A.engineLabel('https://ai.forge-reserve.com')).toBe('ai.forge-reserve.com');
    expect(A.engineLabel('https://ai.example.org:8443/bellows')).toBe('ai.example.org:8443/bellows');
    expect(A.engineLabel('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(A.engineLabel('')).toBe('');
  });

  it('has its own screen under More', () => {
    expect(R.parse('#/more/engine')).toEqual({ name: 'engine', params: {} });
    expect(R.href('engine')).toBe('#/more/engine');
    expect(R.parentOf('engine')).toBe('more');
  });
});

describe('cross-origin isolation in the app', () => {
  const session = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it('reloads once when the app page came up without isolation, never on the website or when isolated', () => {
    const s = session();
    expect(N.reloadForIsolation({ native: {}, isolated: false, session: s })).toBe(true);
    expect(N.reloadForIsolation({ native: {}, isolated: false, session: s })).toBe(false);
    expect(N.reloadForIsolation({ native: {}, isolated: true, session: session() })).toBe(false);
    expect(N.reloadForIsolation({ native: null, isolated: false, session: session() })).toBe(false);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem() {} };
    expect(N.reloadForIsolation({ native: {}, isolated: false, session: blocked })).toBe(false);
  });
});
