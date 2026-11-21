import { describe, expect, it } from 'vitest';

const A: any = await import('../../../public/v2/core/adapters.js' as string);

describe('how the microphone is asked for', () => {
  // A Galaxy A16's web view gives pure silence to a page that asks for echo cancelling, so every
  // recording read as "nothing was heard". Nothing plays while a person records, so it is not needed.
  it('never asks for echo cancelling, and keeps noise suppression and automatic gain', () => {
    expect(A.MIC_SOUND).toEqual({ channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true });
  });
});

// The microphone adapter (core/adapters.js createMic) against a stand-in Web Audio: a context whose
// state the test sets, a track, a capture worklet that loads, fails or is slow, and a ScriptProcessor.
// iPhone Safari heard nothing on Hold to talk (owner, 2026-11-21): the context was made after the
// microphone opened (outside the tap) and resumed only from 'suspended', and the capture was a
// ScriptProcessorNode, which never fires on iOS with a Bluetooth microphone (WebKit bug 216349).

class FakeNode {
  connected: any[] = [];
  connect(n: any) {
    this.connected.push(n);
  }
  disconnect() {
    this.connected = [];
  }
}

class FakeTrack {
  label = 'iPhone Microphone';
  muted = false;
  readyState = 'live';
  settings: Record<string, unknown> = {};
  getSettings() {
    return this.settings;
  }
  on: Record<string, (() => void)[]> = {};
  addEventListener(k: string, f: () => void) {
    (this.on[k] ??= []).push(f);
  }
  fire(k: string) {
    if (k === 'mute') this.muted = true;
    if (k === 'ended') this.readyState = 'ended';
    for (const f of this.on[k] ?? []) f();
  }
  stop() {
    this.readyState = 'ended';
  }
}

function fakeAudio({ state = 'suspended', resumeWorks = true, worklet = 'loads' as 'loads' | 'fails' | 'slow' | 'none', ios = false, slowSuspend = false, onlyWhileCapturing = false, quietMs = 60_000 } = {}) {
  const all: any[] = [];
  const asked: any[] = [];
  const streams: any[] = [];
  let clock = 0;
  let pendingAsk: ((s: any) => void) | null = null;
  let holdAsk = false;
  let refuse: any = null;
  class Ctx {
    state = state;
    sampleRate = 48000;
    resumes = 0;
    suspends = 0;
    listeners: (() => void)[] = [];
    destination = new FakeNode();
    worklets: any[] = [];
    processors: any[] = [];
    sources: any[] = [];
    modules: string[] = [];
    audioWorklet: any =
      worklet === 'none'
        ? undefined
        : {
            addModule: (url: string) => {
              this.modules.push(url);
              if (worklet === 'fails') return Promise.reject(Object.assign(new Error('cannot load'), { name: 'AbortError' }));
              if (worklet === 'slow') return new Promise(() => {});
              return Promise.resolve();
            },
          };
    ok = true;
    constructor() {
      all.push(this);
      // WebKit's rule as the phonon UI tests play it: sound starts only in a tap, or while recording.
      if (onlyWhileCapturing) {
        this.ok = streams.some((s: any) => s.track.readyState === 'live');
        if (this.ok) this.state = 'running';
      }
    }
    addEventListener(_k: string, f: () => void) {
      this.listeners.push(f);
    }
    removeEventListener(_k: string, f: () => void) {
      this.listeners = this.listeners.filter((g) => g !== f);
    }
    set(s: string) {
      this.state = s;
      for (const f of this.listeners) f();
    }
    resume() {
      this.resumes++;
      if (resumeWorks && this.ok && this.state !== 'closed') this.set('running');
      return Promise.resolve();
    }
    suspend() {
      this.suspends++;
      // A real suspend lands later: the state reads 'running' until it does.
      if (slowSuspend) return Promise.resolve().then(() => this.set('suspended'));
      this.set('suspended');
      return Promise.resolve();
    }
    close() {
      this.set('closed');
      return Promise.resolve();
    }
    createMediaStreamSource(s: any) {
      const n: any = new FakeNode();
      n.stream = s;
      this.sources.push(n);
      return n;
    }
    createGain() {
      return Object.assign(new FakeNode(), { gain: { value: 1 } });
    }
    createAnalyser() {
      return Object.assign(new FakeNode(), { fftSize: 0, getFloatTimeDomainData: (a: Float32Array) => a.fill(0) });
    }
    createScriptProcessor() {
      const n: any = Object.assign(new FakeNode(), { onaudioprocess: null });
      this.processors.push(n);
      return n;
    }
  }
  class WorkletNode extends FakeNode {
    port: any = { onmessage: null, sent: [] as unknown[], postMessage: (m: unknown) => this.port.sent.push(m) };
    name: string;
    opts: any;
    constructor(ctx: any, name: string, opts: any) {
      super();
      this.name = name;
      this.opts = opts;
      ctx.worklets.push(this);
    }
  }
  const mediaOn: Record<string, (() => void)[]> = {};
  let label = 'iPhone Microphone';
  const media = {
    addEventListener: (k: string, f: () => void) => (mediaOn[k] ??= []).push(f),
    getUserMedia: (c: any) => {
      asked.push(c.audio);
      if (refuse) return Promise.reject(refuse);
      const track = new FakeTrack();
      track.label = label;
      // As WebKit says it: echo cancelling and the rate, nothing about gain or noise. Chrome says all five.
      track.settings = ios ? { echoCancellation: c.audio.echoCancellation, sampleRate: 48000, channelCount: 1 } : { echoCancellation: c.audio.echoCancellation, autoGainControl: true, noiseSuppression: true, sampleRate: 48000, channelCount: 1 };
      const s = { track, getTracks: () => [track], getAudioTracks: () => [track] };
      streams.push(s);
      if (holdAsk) return new Promise((res) => (pendingAsk = () => res(s)));
      return Promise.resolve(s);
    },
  };
  const logged: any[] = [];
  const mic = A.createMic({ media: () => media, Context: () => Ctx, WorkletNode: () => WorkletNode, ios: () => ios, workletUrl: '/v2/core/mic-worklet.js', workletWaitMs: 20, runWaitMs: 20, quietMs, now: () => clock, log: (f: any) => logged.push(f) });
  return {
    mic,
    all,
    asked,
    streams,
    logged,
    advance: (ms: number) => (clock += ms),
    holdAsk: () => (holdAsk = true),
    letAsk: () => pendingAsk?.(null),
    refuse: (e: any) => (refuse = e),
    /** The phone's inputs change (headphones in or out): devicechange, and the input iOS picks next. */
    reroute: (to: string) => {
      label = to;
      for (const f of mediaOn.devicechange ?? []) f();
    },
  };
}

/** Hands `n` chunks of `value` to the open recording, through whichever capture it uses. */
function feed(ctx: any, n: number, value = 0.2) {
  for (let i = 0; i < n; i++) {
    const buf = new Float32Array(A.MIC_CHUNK).fill(value);
    const w = ctx.worklets.at(-1);
    if (w?.port.onmessage) w.port.onmessage({ data: buf });
    else ctx.processors.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => buf } });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the microphone adapter', () => {
  it('makes and wakes the recording context inside the press, before the microphone is asked for', async () => {
    for (const state of ['suspended', 'interrupted']) {
      const x = fakeAudio({ state });
      x.holdAsk();
      const opening = x.mic.open();
      // Nothing awaited yet: still inside the tap.
      expect(x.all).toHaveLength(1);
      expect(x.all[0].resumes, state).toBe(1);
      expect(x.all[0].state).toBe('running');
      x.letAsk();
      const rec = await opening;
      expect(rec.sampleRate).toBe(48000);
      rec.stop();
    }
  });

  it('resumes again once the microphone is open, and whenever the context stops running while it records', async () => {
    const x = fakeAudio({ state: 'suspended' });
    const rec = await x.mic.open();
    const ctx = x.all[0];
    expect(ctx.resumes).toBe(1); // in the press; it ran at once, so no more were needed
    for (const state of ['interrupted', 'suspended', 'interrupted']) {
      const n = ctx.resumes;
      ctx.state = state; // iOS takes the audio (a call, a route change) ...
      ctx.set(state); // ... and says so
      expect(ctx.resumes, state).toBe(n + 1);
      expect(ctx.state).toBe('running');
    }
    rec.stop();
    // Between recordings a state change resumes nothing.
    const n = ctx.resumes;
    ctx.listeners.forEach((f: () => void) => f());
    expect(ctx.resumes).toBe(n);
    expect(rec.facts().states).toEqual(['running', 'interrupted', 'running', 'suspended', 'running', 'interrupted', 'running']);
  });

  it('a context the press could not start is made again once the microphone is open (WebKit: sound may start while it records)', async () => {
    const x = fakeAudio({ state: 'suspended', onlyWhileCapturing: true });
    const rec = await x.mic.open();
    const got: number[] = [];
    rec.onData((b: Float32Array) => got.push(b.length));
    expect(x.all).toHaveLength(2);
    expect(x.all[0].state).toBe('closed');
    expect(x.all[1].state).toBe('running');
    feed(x.all[1], 2);
    rec.stop();
    expect(got).toEqual([4096, 4096]);
    expect(x.mic.last()).toMatchObject({ remade: true, method: 'worklet', chunks: 2 });
    expect(x.mic.last().states.at(-1)).toBe('running');
    // That context ran once: the next press wakes it and keeps it.
    const next = await x.mic.open();
    expect(x.all).toHaveLength(2);
    expect(next.facts().remade).toBe(false);
    next.stop();
    expect(x.mic.contexts()).toEqual({ made: 2, open: 1, using: 0 });
  });

  it('a context that never runs, even made again, gives no pieces and is let go', async () => {
    const x = fakeAudio({ state: 'interrupted', resumeWorks: false });
    const rec = await x.mic.open();
    expect(x.all).toHaveLength(2);
    expect(x.all[1].resumes).toBeGreaterThan(0);
    x.advance(1500);
    rec.stop();
    expect(x.mic.last()).toMatchObject({ chunks: 0, remade: true });
    expect(x.all.every((c: any) => c.state === 'closed')).toBe(true);
  });

  it('records through the capture worklet, loaded once per context, in chunks of 4096', async () => {
    const x = fakeAudio({ state: 'running' });
    const chunks: Float32Array[] = [];
    for (let i = 0; i < 3; i++) {
      const rec = await x.mic.open();
      rec.onData((b: Float32Array) => chunks.push(b));
      feed(x.all[0], 2);
      x.advance(500);
      rec.stop();
    }
    const ctx = x.all[0];
    expect(ctx.modules).toEqual(['/v2/core/mic-worklet.js']);
    expect(ctx.worklets).toHaveLength(3);
    expect(ctx.processors).toHaveLength(0);
    expect(ctx.worklets[0].name).toBe('forge-mic');
    expect(ctx.worklets[0].opts.processorOptions.size).toBe(4096);
    expect(ctx.worklets[0].port.sent).toEqual(['stop']);
    expect(chunks).toHaveLength(6);
    expect(chunks.every((c) => c.length === 4096)).toBe(true);
    expect(x.mic.last()).toMatchObject({ method: 'worklet', worklet: 'loaded', chunks: 2, samples: 8192, label: 'iPhone Microphone', muted: false, ms: 500 });
    expect(x.mic.last().peak).toBeCloseTo(0.2, 5);
    expect(x.logged).toHaveLength(3);
    expect(JSON.stringify(x.logged)).not.toMatch(/Float32Array|"0":/);
  });

  it('falls back to a ScriptProcessor where the worklet fails to load, is slow, or is missing', async () => {
    for (const worklet of ['fails', 'slow', 'none'] as const) {
      const x = fakeAudio({ state: 'running', worklet });
      const rec = await x.mic.open();
      const got: number[] = [];
      rec.onData((b: Float32Array) => got.push(b.length));
      feed(x.all[0], 3);
      rec.stop();
      expect(got, worklet).toEqual([4096, 4096, 4096]);
      expect(x.mic.last()).toMatchObject({ method: 'script', worklet: { fails: 'AbortError', slow: 'slow', none: 'none' }[worklet] });
      expect(x.all[0].worklets).toHaveLength(0);
    }
  });

  it('keeps one context for the page: suspended between presses, woken in each, none left open', async () => {
    const x = fakeAudio({ state: 'suspended' });
    for (let i = 0; i < 6; i++) {
      const rec = await x.mic.open();
      feed(x.all[0], 1);
      expect(x.all[0].state).toBe('running');
      rec.stop();
      expect(x.all[0].state).toBe('suspended');
    }
    expect(x.all).toHaveLength(1);
    expect(x.mic.contexts()).toEqual({ made: 1, open: 1, using: 0 });
    expect(x.streams.every((s: any) => s.track.readyState === 'ended')).toBe(true);
    // Two at once (a second press while the first is still opening) share it.
    const a = await x.mic.open();
    const b = await x.mic.open();
    a.stop();
    expect(x.all[0].state).toBe('running');
    b.stop();
    expect(x.all[0].state).toBe('suspended');
    expect(x.mic.contexts().made).toBe(1);
  });

  it('a press right after the last one wakes the context its suspend is still putting to sleep, inside the press', async () => {
    const x = fakeAudio({ state: 'suspended', slowSuspend: true });
    const first = await x.mic.open();
    first.stop();
    const ctx = x.all[0];
    expect(ctx.state).toBe('running'); // the suspend has not landed
    const before = ctx.resumes;
    const opening = x.mic.open();
    expect(ctx.resumes).toBe(before + 1);
    const rec = await opening;
    await flush();
    // The suspend that lands while it records is undone at once.
    expect(ctx.state).toBe('running');
    rec.stop();
    await flush();
    expect(ctx.state).toBe('suspended');
  });

  it('lets the context go after a recording with no sample at all for a second, so the next press starts afresh', async () => {
    const x = fakeAudio({ state: 'suspended' });
    const rec = await x.mic.open();
    x.advance(1500);
    expect(rec.facts().chunks).toBe(0);
    rec.stop();
    expect(x.all[0].state).toBe('closed');
    expect(x.mic.last()).toMatchObject({ chunks: 0, ms: 1500 });
    const next = await x.mic.open();
    expect(x.all).toHaveLength(2);
    expect(x.mic.contexts()).toEqual({ made: 2, open: 1, using: 1 });
    next.stop();
    // A short tap with no sound keeps the context.
    const tap = await x.mic.open();
    x.advance(200);
    tap.stop();
    expect(x.all).toHaveLength(2);
  });

  // Owner, 2026-11-21: wired headphones were unplugged just before Hold to talk in iPhone Safari. iOS
  // interrupts and re-routes the audio then; nothing of the old route may carry into the next press.
  it('a route change between two presses: the first track ends, and the next press opens a new context and a new stream, and records', async () => {
    const x = fakeAudio({ state: 'suspended' });
    x.reroute('Headphones');
    const first = await x.mic.open();
    first.onData(() => {});
    feed(x.all[0], 3);
    expect(first.facts().label).toBe('Headphones');
    // Unplugged mid-press: the track ends and the inputs change.
    x.streams[0].track.fire('ended');
    x.reroute('iPhone Microphone');
    x.advance(800);
    first.stop();
    expect(x.mic.last()).toMatchObject({ ended: true, changed: true, label: 'Headphones', chunks: 3 });
    expect(x.all[0].state).toBe('closed');
    const got: number[] = [];
    const next = await x.mic.open();
    next.onData((b: Float32Array) => got.push(b.length));
    expect(x.all).toHaveLength(2);
    expect(x.streams).toHaveLength(2);
    expect(x.streams[0].track.readyState).toBe('ended');
    expect(x.all[1].state).toBe('running');
    feed(x.all[1], 4);
    next.stop();
    expect(got).toEqual([4096, 4096, 4096, 4096]);
    expect(x.mic.last()).toMatchObject({ label: 'iPhone Microphone', ended: false, changed: false, chunks: 4, method: 'worklet' });
  });

  it('headphones in or out between presses let the idle context go at once; the next press starts afresh inside its tap', async () => {
    const x = fakeAudio({ state: 'suspended' });
    const a = await x.mic.open();
    feed(x.all[0], 2);
    a.stop();
    expect(x.all[0].state).toBe('suspended');
    x.reroute('Headphones');
    expect(x.all[0].state).toBe('closed');
    x.holdAsk();
    const opening = x.mic.open();
    expect(x.all).toHaveLength(2); // made in the press, before the microphone is asked for
    expect(x.all[1].resumes).toBe(1);
    x.letAsk();
    const b = await opening;
    expect(b.facts().label).toBe('Headphones');
    b.stop();
  });

  it('a track muted while recording, or a context that ends a recording not running, is not kept for the next press', async () => {
    const x = fakeAudio({ state: 'running' });
    const a = await x.mic.open();
    feed(x.all[0], 2);
    x.streams[0].track.fire('mute');
    a.stop();
    expect(x.all[0].state).toBe('closed');
    const b = await x.mic.open();
    feed(x.all[1], 2);
    x.all[1].state = 'interrupted'; // iOS took the audio and gave it no statechange back
    b.stop();
    expect(x.all[1].state).toBe('closed');
    const c = await x.mic.open();
    expect(x.all).toHaveLength(3);
    expect(x.all[2].state).toBe('running');
    c.stop();
    expect(x.all[2].state).toBe('suspended');
  });

  it('a refused microphone leaves nothing open', async () => {
    const x = fakeAudio({ state: 'suspended' });
    x.refuse(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await expect(x.mic.open()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(x.mic.contexts().using).toBe(0);
    expect(x.all[0].state).toBe('suspended');
  });

  it('says a track was muted or ended in its facts', async () => {
    const x = fakeAudio({ state: 'running' });
    const rec = await x.mic.open();
    x.streams[0].track.fire('mute');
    x.streams[0].track.fire('ended');
    expect(rec.facts()).toMatchObject({ muted: true, ended: true });
    rec.stop();
  });

  // Owner's iPhone, 2026-11-21: with echo cancelling off (WebKit's RemoteIO unit, no voice processing,
  // no automatic gain) a voice came in at a quarter of the level needed. An iPhone asks with it on.
  it('on an iPhone, asks with echo cancelling on, and says what the browser applied', async () => {
    const x = fakeAudio({ state: 'running', ios: true });
    const rec = await x.mic.open();
    expect(x.asked).toEqual([A.MIC_IOS]);
    expect(A.MIC_IOS).toEqual({ ...A.MIC_SOUND, echoCancellation: true });
    feed(x.all[0], 3, 0.01);
    rec.stop();
    expect(x.mic.last()).toMatchObject({ echoCancellation: true, reopened: false, got: { echoCancellation: true, autoGainControl: null, noiseSuppression: null, sampleRate: 48000, channelCount: 1 } });
  });

  it('on an iPhone, a start of pure zeros opens the microphone again once, with echo cancelling off; when that brings sound, the page keeps it', async () => {
    const x = fakeAudio({ state: 'running', ios: true });
    const rec = await x.mic.open();
    const got: number[] = [];
    rec.onData((b: Float32Array) => got.push(b[0]!));
    feed(x.all[0], 6, 0); // 24576 samples: over half a second at 48 kHz
    await flush();
    expect(x.asked).toEqual([A.MIC_IOS, A.MIC_SOUND]);
    // The first stream was stopped before the second was asked for.
    expect(x.streams[0].track.readyState).toBe('ended');
    expect(x.all[0].sources).toHaveLength(2);
    expect(x.all[0].sources[1].connected).toContain(x.all[0].worklets[0]);
    feed(x.all[0], 12, 0);
    await flush();
    expect(x.asked).toHaveLength(2); // once only
    feed(x.all[0], 2, 0.3);
    rec.stop();
    expect(got.at(-1)).toBeCloseTo(0.3, 5);
    expect(x.mic.last()).toMatchObject({ reopened: true, echoCancellation: false, got: { echoCancellation: false }, chunks: 20, zeroChunks: 18 });
    // It brought sound: the next recording asks that way from the start.
    const next = await x.mic.open();
    expect(x.asked.at(-1)).toEqual(A.MIC_SOUND);
    feed(x.all[0], 20, 0.2);
    await flush();
    next.stop();
    expect(x.asked).toHaveLength(3);
  });

  it('on an iPhone, no piece at all opens the microphone again once, the other way', async () => {
    const x = fakeAudio({ state: 'running', ios: true, quietMs: 30 });
    const rec = await x.mic.open();
    await new Promise((r) => setTimeout(r, 60));
    expect(x.asked).toEqual([A.MIC_IOS, A.MIC_SOUND]);
    await new Promise((r) => setTimeout(r, 60));
    expect(x.asked).toHaveLength(2);
    rec.stop();
    // Nothing came after it either: the page keeps asking with echo cancelling on.
    const next = await x.mic.open();
    expect(x.asked.at(-1)).toEqual(A.MIC_IOS);
    next.stop();
  });

  it('on an iPhone, a quiet start (not pure zeros) and any sound at the start leave the microphone as it is; elsewhere zeros never reopen it', async () => {
    const quiet = fakeAudio({ state: 'running', ios: true });
    const r1 = await quiet.mic.open();
    feed(quiet.all[0], 20, 0.001);
    await flush();
    r1.stop();
    expect(quiet.asked).toHaveLength(1);
    // An Android phone or a computer (a Galaxy A16 needs echo cancelling off): zeros are just silence.
    const android = fakeAudio({ state: 'running', ios: false });
    const r2 = await android.mic.open();
    feed(android.all[0], 20, 0);
    await flush();
    r2.stop();
    expect(android.asked).toEqual([A.MIC_SOUND]);
    expect(android.mic.last()).toMatchObject({ reopened: false, echoCancellation: false, got: { echoCancellation: false, autoGainControl: true, noiseSuppression: true } });
  });

  it('a reopen that is refused, or that lands after the recording stopped, leaves nothing open', async () => {
    const x = fakeAudio({ state: 'running', ios: true });
    const rec = await x.mic.open();
    x.holdAsk();
    feed(x.all[0], 6, 0);
    rec.stop();
    x.letAsk();
    await flush();
    expect(x.streams).toHaveLength(2);
    expect(x.streams.every((s: any) => s.track.readyState === 'ended')).toBe(true);
    expect(x.mic.contexts().using).toBe(0);
  });

  it("keeps the voice-in module's verdict with the recording's facts: no pieces, exact zeros, or under the voice level", async () => {
    const VIN: any = await import('../../../public/v2/modules/voice-in/engine/index.js' as string);
    const audio = { model: () => ({ tier: 'enclave' }), price: () => 0, transcribe: async () => ({ text: 'hi', chargedMsub: 0, balanceMsub: null }) };
    for (const [value, n, verdict, zeroChunks] of [[0, 0, 'dead', 0], [0, 20, 'quiet', 20], [0.002, 20, 'quiet', 0], [0.2, 20, 'sent', 0]] as const) {
      const x = fakeAudio({ state: 'running' });
      let clock = 0;
      const session = await VIN.create({ mic: x.mic, audio, now: () => clock }).start({});
      feed(x.all[0], n, value);
      clock += 2000;
      x.advance(2000);
      await session.finish({}).catch(() => {});
      expect(x.mic.last(), `${value} x ${n}`).toMatchObject({ verdict, zeroChunks, chunks: n, voiceLevel: VIN.VOICE_LEVEL });
    }
  });

  it('is an iPhone only by its user agent (an iPad asking for computer pages has a touch screen)', async () => {
    const G: any = await import('../../../public/v2/core/getapp.js' as string);
    expect(G.isIOS({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15' })).toBe(true);
    expect(G.isIOS({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', touchPoints: 5 })).toBe(true);
    expect(G.isIOS({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', touchPoints: 0 })).toBe(false);
    expect(G.isIOS({ ua: 'Mozilla/5.0 (Linux; Android 15; SM-A165F) AppleWebKit/537.36 Chrome/131' })).toBe(false);
  });
});
