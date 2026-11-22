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

/**
 * The bridge as the iPhone app has it: Capacitor says 'ios', and lists the plugins the app registered
 * under Capacitor.Plugins (ForgeBars, and ForgeNfc from the build that has it).
 */
function iosCapacitor(answers: Record<string, (opts: any) => any> = {}, plugins: string[] = ['ForgeBars']) {
  const f = fakeCapacitor(answers);
  (f.win.Capacitor as any).getPlatform = () => 'ios';
  (f.win.Capacitor as any).Plugins = Object.fromEntries(plugins.map((p) => [p, {}]));
  return f;
}

/** The iPhone app's ForgeNfc, as NfcPlugin.swift answers: one sheet, one numbered card in it. */
function iosNfc() {
  const sheet = { open: false, card: 0 };
  const f = iosCapacitor(
    {
      'ForgeNfc.status': () => ({ available: true, enabled: true }),
      'ForgeNfc.start': () => void (sheet.open = true),
      'ForgeNfc.transceive': (o) => {
        if (!sheet.open || o.id !== sheet.card) throw Object.assign(new Error('The card is gone.'), { code: 'tag_gone' });
        return { data: '02019000' };
      },
      'ForgeNfc.close': (o) => void (o.id === sheet.card && (sheet.open = false)),
      'ForgeNfc.stop': () => void (sheet.open = false),
    },
    ['ForgeBars', 'ForgeNfc'],
  );
  /** A card is held to the open sheet. */
  const tap = (isoDep = true) => {
    if (!sheet.open) return false;
    if (isoDep) sheet.card += 1;
    for (const [plugin, event, fn] of f.listeners) if (plugin === 'ForgeNfc' && event === 'card') (fn as any)(isoDep ? { id: sheet.card, isoDep: true } : { id: 0, isoDep: false });
    return true;
  };
  return { ...f, sheet, tap };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * ForgeShare's staging calls as SharePlugin.kt answers them: a token per file, its pieces kept in order.
 * files: token -> the pieces' base64.
 */
function staging(more: Record<string, (opts: any) => any> = {}) {
  const files = new Map<string, string[]>();
  let next = 0;
  const answers: Record<string, (opts: any) => any> = {
    'ForgeShare.stageStart': () => {
      const token = String(++next).padStart(32, '0');
      files.set(token, []);
      return { token };
    },
    'ForgeShare.stageAppend': (o) => void files.get(o.token)!.push(o.data),
    'ForgeShare.stageDrop': (o) => void files.delete(o.token),
    ...more,
  };
  const bytes = (token: string) => Buffer.concat((files.get(token) ?? []).map((d) => Buffer.from(d, 'base64')));
  return { answers, files, bytes };
}

describe('the native bridge', () => {
  it('is there only inside the app', () => {
    expect(N.nativeBridge({})).toBeNull();
    expect(N.nativeBridge({ Capacitor: { isNativePlatform: () => false, nativePromise: () => {} } })).toBeNull();
    expect(N.nativeBridge({ Capacitor: { isNativePlatform: () => true } })).toBeNull();
    expect(N.createNative({})).toBeNull();
    expect(N.nativeBridge(fakeCapacitor().win)).not.toBeNull();
  });

  it('links More, Privacy to this site\'s page on the website and to Forge\'s engine\'s page in the apps', () => {
    expect(N.privacyAddress(null)).toBe('/privacy');
    expect(N.privacyAddress(N.createNative(fakeCapacitor().win))).toBe('https://ai.forge-reserve.com/privacy');
    expect(N.privacyAddress(N.createNative(iosCapacitor().win))).toBe('https://ai.forge-reserve.com/privacy');
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
    const st = staging();
    const { win, calls } = fakeCapacitor(st.answers);
    const nat = N.createNative(win);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], 'forge-photo.jpg', { type: 'image/jpeg' });
    expect(nat.share.canShareFiles([file])).toBe(true);
    expect(await nat.share.files([file])).toEqual({ opened: true });
    // The file is staged first; the call that opens the sheet names it by its token only.
    const token = '1'.padStart(32, '0');
    expect(calls).toEqual([
      ['ForgeShare', 'stageStart', { size: 4 }],
      ['ForgeShare', 'stageAppend', { token, data: '/9j/AQ==' }],
      ['ForgeShare', 'share', { token, name: 'forge-photo.jpg', mime: 'image/jpeg' }],
    ]);
    // The photo screen does not say "Shared": the app is not told whether the person sent it.
    expect(await PH.shareOrSave(file, nat.share)).toBe('opened');
  });

  it('says whether the photo was saved or the save screen was closed', async () => {
    let saved = true;
    const { win } = fakeCapacitor(staging({ 'ForgeShare.save': () => ({ saved }) }).answers);
    const nat = N.createNative(win);
    const file = new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' });
    expect(await nat.share.save(file)).toEqual({ saved: true });
    saved = false;
    expect(await nat.share.save(file)).toEqual({ saved: false });
  });

  it('says Saved only for a save the phone confirmed; a web download only started', async () => {
    expect(PH.saveOutcome({ saved: true })).toBe('saved');
    expect(PH.saveOutcome({ saved: true, to: 'photos' })).toBe('savedPhotos');
    expect(PH.saveOutcome({ saved: false })).toBe('notSaved');
    expect(PH.saveOutcome({ started: true })).toBe('downloading');
    expect(PH.saveOutcome(undefined)).toBe('notSaved');
    // With no share sheet for files, Share saves: what it says is what the save came to.
    const file = new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' });
    const noSheet = (save: () => any) => ({ canShareFiles: () => false, files: async () => {}, save });
    expect(await PH.shareOrSave(file, noSheet(() => ({ started: true })))).toBe('downloading');
    expect(await PH.shareOrSave(file, noSheet(async () => ({ saved: true, to: 'photos' })))).toBe('savedPhotos');
    await expect(
      PH.shareOrSave(
        file,
        noSheet(async () => {
          throw Object.assign(new Error('no'), { code: 'denied' });
        }),
      ),
    ).rejects.toMatchObject({ code: 'denied' });
  });

  it('a sheet that fails to open is an error, not a share', async () => {
    const { win } = fakeCapacitor(
      staging({
        'ForgeShare.share': () => {
          throw Object.assign(new Error('no'), { code: 'share_failed' });
        },
      }).answers,
    );
    const nat = N.createNative(win);
    await expect(PH.shareOrSave(new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' }), nat.share)).rejects.toThrow('no');
  });

  it('saves a full size photo with no file in the call that opens the save screen', async () => {
    const st = staging({ 'ForgeShare.save': () => ({ saved: true }) });
    const { win, calls } = fakeCapacitor(st.answers);
    const nat = N.createNative(win);
    // About a 12 megapixel JPEG: several pieces, the last one short.
    const photo = new Uint8Array(5_000_000).map((_, i) => (i * 31) % 256);
    expect(await nat.share.save(new File([photo], 'forge-photo.jpg', { type: 'image/jpeg' }))).toEqual({ saved: true });
    const pieces = calls.filter(([, m]) => m === 'stageAppend').map(([, , o]) => o.data as string);
    expect(pieces).toHaveLength(Math.ceil(photo.length / N.STAGE_CHUNK));
    // Each piece is whole base64 of at most 256 KiB, so no bridge message is large.
    for (const p of pieces.slice(0, -1)) expect(p.length).toBe(256 * 1024);
    expect(pieces.every((p) => p.length <= 256 * 1024)).toBe(true);
    const [, , save] = calls.find(([, m]) => m === 'save')!;
    expect(Object.keys(save).sort()).toEqual(['mime', 'name', 'token']);
    // Capacitor keeps these options in the app's saved state while the save screen is up (ShareStage.MAX_CALL_CHARS).
    expect(JSON.stringify(save).length).toBeLessThan(2048);
    expect(new Uint8Array(st.bytes(save.token))).toEqual(photo);
  });

  it('stages in pieces of any size, each one decoding on its own', async () => {
    const st = staging();
    const { call } = N.nativeBridge(fakeCapacitor(st.answers).win)!;
    const bytes = new Uint8Array(1000).map((_, i) => i % 256);
    for (const chunk of [3, 6, 999, 1000, 3000]) {
      const token = await N.stageFile(call, new File([bytes], 'p.jpg'), chunk);
      expect(new Uint8Array(st.bytes(token))).toEqual(bytes);
      expect(st.files.get(token)!).toHaveLength(Math.ceil(1000 / chunk));
    }
    expect(N.STAGE_CHUNK % 3).toBe(0);
  });

  it('removes a staged file when a piece fails, and opens no screen', async () => {
    let pieces = 0;
    const st = staging({
      'ForgeShare.stageAppend': () => {
        if (++pieces === 2) throw Object.assign(new Error('gone'), { code: 'no_file' });
      },
    });
    const { win, calls } = fakeCapacitor(st.answers);
    const nat = N.createNative(win);
    const file = new File([new Uint8Array(N.STAGE_CHUNK * 2)], 'p.jpg', { type: 'image/jpeg' });
    await expect(nat.share.save(file)).rejects.toMatchObject({ code: 'no_file' });
    await settle();
    expect(calls.map(([p, m]) => `${p}.${m}`)).toEqual(['ForgeShare.stageStart', 'ForgeShare.stageAppend', 'ForgeShare.stageAppend', 'ForgeShare.stageDrop']);
    expect(st.files.size).toBe(0);
    // A file the app would not stage (too large, or empty) is refused before any piece is sent.
    const big = fakeCapacitor({
      'ForgeShare.stageStart': () => {
        throw Object.assign(new Error('too large'), { code: 'too_big' });
      },
    });
    await expect(N.createNative(big.win).share.files([file])).rejects.toMatchObject({ code: 'too_big' });
    expect(big.calls.map(([, m]) => m)).toEqual(['stageStart']);
    // An app that gave no token: nothing is sent.
    const none = fakeCapacitor({});
    await expect(N.createNative(none.win).share.save(file)).rejects.toMatchObject({ code: 'bad_file' });
    expect(none.calls.map(([, m]) => m)).toEqual(['stageStart']);
  });

  it('tells once how a save ended when the phone restarted the app meanwhile', async () => {
    let kept: any = { saved: true };
    const take = () => {
      const k = kept;
      kept = {};
      return k;
    };
    const nat = N.createNative(fakeCapacitor({ 'ForgeShare.restoredSave': take }).win);
    expect(await nat.share.restored()).toBe('saved');
    expect(await nat.share.restored()).toBeNull();
    kept = { saved: false };
    expect(await nat.share.restored()).toBe('notSaved');
    // An app built before restoredSave rejects the call: nothing to say.
    const old = fakeCapacitor({
      'ForgeShare.restoredSave': () => {
        throw new Error('not implemented');
      },
    });
    expect(await N.createNative(old.win).share.restored()).toBeNull();
    // The iPhone app has no save screen to come back from.
    expect(N.createNative(iosCapacitor({}, ['ForgeShare']).win).share.restored).toBeUndefined();
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
    const android = { isolated: true };
    expect(N.reloadForIsolation({ native: android, isolated: false, session: s })).toBe(true);
    expect(N.reloadForIsolation({ native: android, isolated: false, session: s })).toBe(false);
    expect(N.reloadForIsolation({ native: android, isolated: true, session: session() })).toBe(false);
    expect(N.reloadForIsolation({ native: null, isolated: false, session: session() })).toBe(false);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem() {} };
    expect(N.reloadForIsolation({ native: android, isolated: false, session: blocked })).toBe(false);
    // The iPhone app is never served isolated: it does not reload for it.
    expect(N.reloadForIsolation({ native: N.createNative(iosCapacitor().win), isolated: false, session: session() })).toBe(false);
    expect(N.createNative(fakeCapacitor().win).isolated).toBe(true);
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

describe('the iPhone app (ios/, docs/IOS.md)', () => {
  it('knows which app it is in: ios only when Capacitor says so', () => {
    expect(N.nativeBridge(iosCapacitor().win).platform).toBe('ios');
    const android = fakeCapacitor();
    expect(N.nativeBridge(android.win).platform).toBe('android');
    (android.win.Capacitor as any).getPlatform = () => 'android';
    expect(N.createNative(android.win).platform).toBe('android');
  });

  it("talks to Forge's engine, as the Android app does", () => {
    expect(N.defaultEngine(N.createNative(iosCapacitor().win))).toBe('https://ai.forge-reserve.com');
  });

  it('has ForgeBars and ForgeNfc: every other part is left to the website ways', async () => {
    const { win, calls } = iosCapacitor({}, ['ForgeBars', 'ForgeNfc']);
    const nat = N.createNative(win);
    expect(nat.platform).toBe('ios');
    expect(nat.isolated).toBe(false);
    for (const k of ['share', 'shareIn', 'forget', 'join', 'till', 'voice', 'speech', 'asr']) expect(nat[k], k).toBeNull();
    expect(nat.nfc.supported()).toBe(true);
    expect(nat.nfc.sheet).toBe(true);
    // Listed: the card way is offered (Tap a card's available()).
    expect(nat.nfc.listed).toBeUndefined();
    await nat.bars('#0B0D10');
    expect(calls).toEqual([['ForgeBars', 'set', { color: '#0B0D10' }]]);
  });

  it("has ForgeSpeech where the app registered it: Android's calls, events and codes", async () => {
    const f = iosCapacitor(
      {
        'ForgeSpeech.available': () => ({ onDevice: true, reason: null, locale: 'en-US' }),
        'ForgeSpeech.start': (o) => {
          if (o.locale !== 'en-GB') throw Object.assign(new Error('Speech recognition is not allowed.'), { code: 'permission' });
          return undefined;
        },
      },
      ['ForgeBars', 'ForgeNfc', 'ForgeSpeech'],
    );
    const nat = N.createNative(f.win);
    for (const k of ['share', 'shareIn', 'forget', 'join', 'till', 'voice', 'asr']) expect(nat[k], k).toBeNull();
    expect(nat.speech.supported()).toBe(true);
    expect(await nat.speech.available({ locale: 'en-GB' })).toEqual({ onDevice: true, reason: null, locale: 'en-US' });
    const got: any[] = [];
    const s = await nat.speech.start({ locale: 'en-GB', onEvent: (ev: any) => got.push(ev) });
    const fire = f.listeners.find(([p, e]) => p === 'ForgeSpeech' && e === 'speech')![2] as (ev: any) => void;
    for (const ev of [{ type: 'started' }, { type: 'level', level: 0.4 }, { type: 'partial', text: 'Is it' }, { type: 'final', text: 'Is it open?' }, { type: 'end' }]) fire({ id: s.id, ...ev });
    // Another press's events are not this one's.
    fire({ id: 'ask-other', type: 'final', text: 'no' });
    expect(got.map((e) => e.type)).toEqual(['started', 'level', 'partial', 'final', 'end']);
    await s.stop();
    expect(f.calls.map(([p, m, o]) => `${p}.${m}:${JSON.stringify(o)}`)).toEqual([
      'ForgeSpeech.available:{"locale":"en-GB"}',
      `ForgeSpeech.start:{"id":"${s.id}","locale":"en-GB"}`,
      `ForgeSpeech.stop:{"id":"${s.id}"}`,
    ]);
    // A refused permission keeps its code, as on Android.
    await expect(nat.speech.start({ locale: 'en-US' })).rejects.toMatchObject({ code: 'permission' });
  });

  it('saves to Photos through ForgeShare, and says Saved only once Photos has the photo', async () => {
    let answer: () => any = () => ({ saved: true });
    const f = iosCapacitor({ 'ForgeShare.save': () => answer() }, ['ForgeBars', 'ForgeNfc', 'ForgeShare']);
    const nat = N.createNative(f.win);
    // Save only: the share sheet stays the web view's own (navigator.share), as in Safari.
    expect(Object.keys(nat.share)).toEqual(['save']);
    for (const k of ['shareIn', 'forget', 'join', 'till', 'voice', 'asr']) expect(nat[k], k).toBeNull();
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], 'photo.jpg', { type: 'image/jpeg' });
    const r = await nat.share.save(file);
    expect(r).toEqual({ saved: true, to: 'photos' });
    expect(PH.saveOutcome(r)).toBe('savedPhotos');
    // The file's exact bytes go over the bridge.
    expect(f.calls).toEqual([['ForgeShare', 'save', { name: 'photo.jpg', mime: 'image/jpeg', data: '/9j/AQ==' }]]);
    // Refused: Photos is not allowed (the person said no, or it is restricted). The code is kept.
    answer = () => {
      throw Object.assign(new Error('Forge may not add to Photos.'), { code: 'denied' });
    };
    await expect(nat.share.save(file)).rejects.toMatchObject({ code: 'denied' });
    answer = () => {
      throw Object.assign(new Error('The photo could not be saved.'), { code: 'save_failed' });
    };
    await expect(nat.share.save(file)).rejects.toMatchObject({ code: 'save_failed' });
    // An answer that does not say saved is a failure, never a save.
    answer = () => ({});
    await expect(nat.share.save(file)).rejects.toMatchObject({ code: 'save_failed' });
  });

  it('a build without ForgeShare keeps the website Save, as before', () => {
    expect(N.createNative(iosCapacitor({}, ['ForgeBars', 'ForgeNfc', 'ForgeSpeech']).win).share).toBeNull();
  });

  it('a build without ForgeSpeech leaves Hold to talk to the engine, as before', () => {
    expect(N.createNative(iosCapacitor({}, ['ForgeBars', 'ForgeNfc']).win).speech).toBeNull();
  });

  it('a build without ForgeNfc has no card reader, and says to leave the card ways out', async () => {
    const { win, calls } = iosCapacitor();
    const nfc = N.createNative(win).nfc;
    expect(nfc).toBe(N.NO_READER);
    expect(nfc.supported()).toBe(false);
    expect(nfc.listed()).toBe(false);
    expect(await nfc.status()).toEqual({ available: false, enabled: false });
    const r = nfc.start(() => {});
    expect(await r.started).toBe(false);
    r.stop();
    expect(calls).toEqual([]);
  });

  it("reports the iPhone's reader as the plugin does: none in the Simulator or on an iPhone that cannot read tags", async () => {
    const off = iosCapacitor({ 'ForgeNfc.status': () => ({ available: false, enabled: false }) }, ['ForgeBars', 'ForgeNfc']);
    expect(await N.createNative(off.win).nfc.status()).toEqual({ available: false, enabled: false });
    const on = iosCapacitor({ 'ForgeNfc.status': () => ({ available: true, enabled: true }) }, ['ForgeBars', 'ForgeNfc']);
    expect(await N.createNative(on.win).nfc.status()).toEqual({ available: true, enabled: true });
    // A plugin that fails to answer is no reader, never an error for the page.
    const broken = iosCapacitor({ 'ForgeNfc.status': () => Promise.reject(new Error('no')) }, ['ForgeBars', 'ForgeNfc']);
    expect(await N.createNative(broken.win).nfc.status()).toEqual({ available: false, enabled: false });
  });

  it('press, then tap: start opens the sheet with its words, the card is let go (closing the sheet) once the page is done with it, and again() opens the next', async () => {
    const f = iosNfc();
    const nfc = N.createNative(f.win).nfc;
    const words = { hold: 'Hold it.', keep: 'Keep it.', done: 'Done.', lost: 'Gone.', notCard: 'Not one.', one: 'One.' };
    let finish: () => void = () => {};
    const seen: any[] = [];
    const answers: any[] = [];
    const reader = nfc.start(async (c: any) => {
      seen.push(c);
      if (!c) return;
      answers.push(await c.transceive([0x00, 0xa4, 0x04, 0x00]));
      await new Promise<void>((r) => (finish = r));
    }, words);
    await reader.started;
    expect(f.calls.find((c) => c[1] === 'start')).toEqual(['ForgeNfc', 'start', words]);
    expect(f.sheet.open).toBe(true);

    expect(f.tap()).toBe(true);
    await settle();
    expect(answers).toEqual([[0x02, 0x01, 0x90, 0x00]]);
    expect(f.calls.find((c) => c[1] === 'transceive')).toEqual(['ForgeNfc', 'transceive', { id: 1, apdu: '00a40400' }]);
    // While the page works with the card, its sheet stays up and again() opens nothing.
    reader.again();
    await settle();
    expect(f.calls.filter((c) => c[1] === 'start')).toHaveLength(1);
    expect(f.sheet.open).toBe(true);
    finish();
    await settle();
    expect(f.calls.filter((c) => c[1] === 'close')).toEqual([['ForgeNfc', 'close', { id: 1 }]]);
    expect(f.sheet.open).toBe(false);
    // The card is gone with its sheet: a command for it is refused.
    await expect(seen[0].transceive([0x00, 0xb0, 0x00, 0x00])).rejects.toMatchObject({ code: 'tag_gone' });
    // No sheet, no tap.
    expect(f.tap()).toBe(false);

    // A press opens the next sheet; its card has a new number.
    reader.again();
    await settle();
    expect(f.calls.filter((c) => c[1] === 'start')).toHaveLength(2);
    expect(f.calls.filter((c) => c[1] === 'start')[1]).toEqual(['ForgeNfc', 'start', words]);
    f.tap();
    await settle();
    expect(f.calls.filter((c) => c[1] === 'transceive').at(-1)).toEqual(['ForgeNfc', 'transceive', { id: 2, apdu: '00a40400' }]);
    finish();
    await settle();

    // A tag that is not a smart card: null, and nothing to let go of (the plugin ends that sheet itself).
    reader.again();
    await settle();
    const closes = f.calls.filter((c) => c[1] === 'close').length;
    f.tap(false);
    await settle();
    expect(seen.at(-1)).toBeNull();
    expect(f.calls.filter((c) => c[1] === 'close')).toHaveLength(closes);

    reader.stop();
    await settle();
    expect(f.calls.at(-1)).toEqual(['ForgeNfc', 'stop', {}]);
    // Stopped: a late press opens nothing.
    const starts = f.calls.filter((c) => c[1] === 'start').length;
    reader.again();
    await settle();
    expect(f.calls.filter((c) => c[1] === 'start')).toHaveLength(starts);
  });

  it('lets the card go even when the page fails with it, and a sheet that cannot open is not an error for the page', async () => {
    const f = iosNfc();
    const nfc = N.createNative(f.win).nfc;
    const reader = nfc.start(async () => {
      throw new Error('the page broke');
    }, {});
    await reader.started;
    f.tap();
    await settle();
    await settle();
    expect(f.calls.filter((c) => c[1] === 'close')).toEqual([['ForgeNfc', 'close', { id: 1 }]]);

    const refusing = iosCapacitor({ 'ForgeNfc.start': () => Promise.reject(Object.assign(new Error('This phone cannot read cards.'), { code: 'no_nfc' })) }, ['ForgeBars', 'ForgeNfc']);
    const r = N.createNative(refusing.win).nfc.start(() => {}, {});
    await expect(r.started).rejects.toMatchObject({ code: 'no_nfc' });
    r.again();
    await settle();
  });

  it('a bridge that refuses ForgeBars is not an error for the page', async () => {
    const { win } = iosCapacitor();
    (win.Capacitor as any).nativePromise = async () => {
      throw new Error('not implemented');
    };
    await expect(N.createNative(win).bars('#FFFFFF')).resolves.toBeUndefined();
  });
});
