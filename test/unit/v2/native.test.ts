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

describe("Hold to talk through ForgeSpeech, the phone's on-device recogniser", () => {
  it('asks whether the recogniser has the language, and reads a broken bridge as no', async () => {
    const ok = fakeCapacitor({ 'ForgeSpeech.available': () => ({ onDevice: true, reason: null, locale: 'en-US' }) });
    expect(await N.createNative(ok.win).speech.available({ locale: 'en-GB' })).toEqual({ onDevice: true, reason: null, locale: 'en-US' });
    expect(ok.calls).toEqual([['ForgeSpeech', 'available', { locale: 'en-GB' }]]);
    const no = fakeCapacitor({ 'ForgeSpeech.available': () => ({ onDevice: false, reason: 'no-on-device-recognizer', locale: 'en-US' }) });
    expect((await N.createNative(no.win).speech.available({ locale: 'en-US' })).onDevice).toBe(false);
    const broken = fakeCapacitor({
      'ForgeSpeech.available': () => {
        throw new Error('"ForgeSpeech" plugin is not implemented on android');
      },
    });
    expect(await N.createNative(broken.win).speech.available({ locale: 'en-US' })).toMatchObject({ onDevice: false, locale: 'en-US' });
  });

  it('hands each press its own events, and none after it was cancelled', async () => {
    const f = fakeCapacitor();
    const speech = N.createNative(f.win).speech;
    const a: any[] = [];
    const b: any[] = [];
    const sa = await speech.start({ locale: 'en-US', onEvent: (ev: any) => a.push(ev.type) });
    const sb = await speech.start({ locale: 'en-US', onEvent: (ev: any) => b.push(ev.type) });
    expect(sa.id).not.toBe(sb.id);
    const fire = f.listeners.find(([p, e]) => p === 'ForgeSpeech' && e === 'speech')![2] as (ev: any) => void;
    fire({ id: sa.id, type: 'partial', text: 'hi' });
    fire({ id: sb.id, type: 'final', text: 'there' });
    sa.cancel();
    fire({ id: sa.id, type: 'end' });
    expect(a).toEqual(['partial']);
    expect(b).toEqual(['final']);
    expect(f.calls.map(([p, m, o]) => `${p}.${m}:${o.id === sa.id ? 'a' : 'b'}`)).toEqual(['ForgeSpeech.start:a', 'ForgeSpeech.start:b', 'ForgeSpeech.cancel:a']);
  });

  it('a refused start keeps its code', async () => {
    const f = fakeCapacitor({
      'ForgeSpeech.start': () => {
        throw Object.assign(new Error('Already listening.'), { code: 'busy' });
      },
    });
    await expect(N.createNative(f.win).speech.start({ locale: 'en-US' })).rejects.toMatchObject({ code: 'busy' });
  });
});

describe("Hold to talk through ForgeAsr, Forge Private Voice's own speech to text", () => {
  it('says whether this app carries the model, and reads a broken bridge as no', async () => {
    const ok = fakeCapacitor({ 'ForgeAsr.available': () => ({ available: true, reason: null, model: 'moonshine-tiny-en', language: 'en' }) });
    expect(await N.createNative(ok.win).asr.available()).toEqual({ available: true, reason: null, language: 'en' });
    expect(ok.calls).toEqual([['ForgeAsr', 'available', {}]]);
    const universal = fakeCapacitor({ 'ForgeAsr.available': () => ({ available: false, reason: 'no speech to text in this app', model: null, language: 'en' }) });
    expect(await N.createNative(universal.win).asr.available()).toEqual({ available: false, reason: 'no speech to text in this app', language: 'en' });
    const broken = fakeCapacitor({
      'ForgeAsr.available': () => {
        throw new Error('"ForgeAsr" plugin is not implemented on android');
      },
    });
    expect((await N.createNative(broken.win).asr.available()).available).toBe(false);
  });

  it('hands each press its own events, and a refused start keeps its code', async () => {
    const f = fakeCapacitor();
    const asr = N.createNative(f.win).asr;
    const a: any[] = [];
    const sa = await asr.start({ onEvent: (ev: any) => a.push(ev.type) });
    const fire = f.listeners.find(([p, e]) => p === 'ForgeAsr' && e === 'asr')![2] as (ev: any) => void;
    fire({ id: sa.id, type: 'partial', text: 'Is it' });
    fire({ id: 'another', type: 'final', text: 'no' });
    await sa.stop();
    fire({ id: sa.id, type: 'final', text: 'Is it safe?' });
    fire({ id: sa.id, type: 'end' });
    fire({ id: sa.id, type: 'partial', text: 'late' });
    expect(a).toEqual(['partial', 'final', 'end']);
    expect(f.calls.map(([p, m]) => `${p}.${m}`)).toEqual(['ForgeAsr.start', 'ForgeAsr.stop']);
    const busy = fakeCapacitor({
      'ForgeAsr.start': () => {
        throw Object.assign(new Error('Already listening.'), { code: 'busy' });
      },
    });
    await expect(N.createNative(busy.win).asr.start({})).rejects.toMatchObject({ code: 'busy' });
  });
});

describe('the native natural voice through ForgeVoice', () => {
  it('says whether this phone runs it, once, and asks again after the thread count changes', async () => {
    let asked = 0;
    const { win, calls } = fakeCapacitor({ 'ForgeVoice.status': () => (asked++, { available: true, reason: null, cores: 8, bigCores: [6, 7], threads: 2, chosenThreads: 0, defaultThreads: 2 }), 'ForgeVoice.config': () => ({}) });
    const v = N.createNative(win).voice;
    expect(await v.status()).toEqual({ available: true, reason: null, cores: 8, bigCores: [6, 7], threads: 2, chosenThreads: 0, defaultThreads: 2 });
    await v.status();
    expect(asked).toBe(1);
    await v.config(4);
    expect(calls.at(-1)).toEqual(['ForgeVoice', 'config', { threads: 4 }]);
    await v.status();
    expect(asked).toBe(2);
  });

  it('is unavailable when the app has no such plugin', async () => {
    const { win } = fakeCapacitor({
      'ForgeVoice.status': () => {
        throw Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' });
      },
    });
    expect((await N.createNative(win).voice.status()).available).toBe(false);
  });

  it("speaks the pieces with this phone's speed, hands each answer's own events to it, and stops it by id", async () => {
    let finish: (v: any) => void = () => {};
    const { win, calls, listeners } = fakeCapacitor({ 'ForgeVoice.speak': () => new Promise((r) => (finish = r)) });
    const v = N.createNative(win).voice;
    const seen: any[] = [];
    const h = await v.speak({ pieces: ['One.', 'Two.'], voice: 'Maeve', rtf: 1.1, spc: 0.07, phoneVoice: true, onStarted: () => seen.push('started'), onBuffering: (b: any) => seen.push(b) });
    const [, , opts] = calls.find((c) => c[1] === 'speak')!;
    expect(opts).toEqual({ id: h.id, pieces: ['One.', 'Two.'], voice: 'Maeve', rtf: 1.1, spc: 0.07, preferNatural: false, phoneVoice: true, threads: 0 });
    const fire = (event: string, ev: any) => listeners.filter(([p, e]) => p === 'ForgeVoice' && e === event).forEach(([, , fn]) => (fn as any)(ev));
    fire('buffering', { id: 'someone-else', fraction: 0.9 });
    fire('buffering', { id: h.id, fraction: 0.4 });
    fire('started', { id: h.id });
    expect(seen).toEqual([{ fraction: 0.4 }, 'started']);
    await h.stop();
    expect(calls.at(-1)).toEqual(['ForgeVoice', 'stop', { id: h.id }]);
    finish({ rtf: 1.2, stopped: true });
    expect(await h.done).toEqual({ rtf: 1.2, stopped: true });
    // Its handlers are gone once it ended.
    fire('started', { id: h.id });
    expect(seen).toHaveLength(2);
  });

  it('gives a failure its code: too-slow (with how slow), crashed and the rest', async () => {
    const { win } = fakeCapacitor({
      'ForgeVoice.speak': () => {
        throw Object.assign(new Error('too slow'), { code: 'too-slow', data: { rtf: 2.1 } });
      },
      'ForgeVoice.bench': () => {
        throw Object.assign(new Error('The voice stopped working.'), { code: 'crashed' });
      },
    });
    const v = N.createNative(win).voice;
    await expect((await v.speak({ pieces: ['x'] })).done).rejects.toMatchObject({ code: 'too-slow', data: { rtf: 2.1 } });
    await expect(v.bench({ text: 'Yes.', threads: 4 })).rejects.toMatchObject({ code: 'crashed' });
  });

  it('measures a line at a thread count, and keeps the lab results in the app', async () => {
    const { win, calls } = fakeCapacitor({ 'ForgeVoice.bench': () => ({ firstMs: 40, audioS: 1, genMs: 300 }), 'ForgeVoice.saveLab': () => ({ saved: true }) });
    const v = N.createNative(win).voice;
    expect(await v.bench({ text: 'Yes.', voice: 'Maeve', threads: 6 })).toEqual({ firstMs: 40, audioS: 1, genMs: 300 });
    expect(calls[0]![2]).toMatchObject({ text: 'Yes.', voice: 'Maeve', threads: 6 });
    expect(calls[0]![2].id).toMatch(/^bench-/);
    expect(await v.saveLab('forge-voice-lab-1.json', '{}')).toBe(true);
    expect(calls[1]).toEqual(['ForgeVoice', 'saveLab', { name: 'forge-voice-lab-1.json', json: '{}' }]);
  });
});
