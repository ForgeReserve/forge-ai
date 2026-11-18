import { describe, expect, it, vi } from 'vitest';
import { wavInfo } from '../../../src/audio.ts';

// Hold to talk and read aloud: the recorder state machine, WAV encoding, sentence chunking, voice
// prices, the module choice, the engine client's audio calls, the voice modules, and the controller.
const TALK: any = await import('../../../public/v2/core/talk.js' as string);
const WAV: any = await import('../../../public/v2/core/wav.js' as string);
const SPEECH: any = await import('../../../public/v2/core/speech.js' as string);
const VOICE: any = await import('../../../public/v2/core/voice.js' as string);
const STATE: any = await import('../../../public/v2/core/state.js' as string);
const E: any = await import('../../../public/v2/core/engine.js' as string);
const R: any = await import('../../../public/v2/core/registry.js' as string);
const CTL: any = await import('../../../public/v2/core/talkctl.js' as string);
const VIN: any = await import('../../../public/v2/modules/voice-in/engine/index.js' as string);
const VIN_DEVICE: any = await import('../../../public/v2/modules/voice-in/device/index.js' as string);
const VIN_PHONE: any = await import('../../../public/v2/modules/voice-in/phone/index.js' as string);
const VIN_BUNDLED: any = await import('../../../public/v2/modules/voice-in/bundled/index.js' as string);
const N: any = await import('../../../public/v2/core/native.js' as string);
const VOUT: any = await import('../../../public/v2/modules/voice-out/engine/index.js' as string);
const VOUT_DEVICE: any = await import('../../../public/v2/modules/voice-out/device/index.js' as string);
const ERR: any = await import('../../../public/v2/core/errors.js' as string);
const EN: any = (await import('../../../public/v2/strings/en.js' as string)).default;
const ADAPTERS: any = await import('../../../public/v2/core/adapters.js' as string);

/** Runs events through the state machine from idle; returns the final state and every effect. */
function run(events: object[]) {
  let s = TALK.initial();
  const effects: string[] = [];
  for (const ev of events) {
    const r = TALK.step(s, ev);
    s = r.s;
    effects.push(...r.effects);
  }
  return { s, effects };
}

describe('the recorder state machine', () => {
  it('records on press and sends on release after a hold', () => {
    const r = run([{ type: 'down', at: 0 }, { type: 'tick', at: 500, maxMs: 60_000 }, { type: 'up', at: 2000 }]);
    expect(r.s.phase).toBe('sending');
    expect(r.effects).toEqual(['start', 'haptic:start', 'send', 'haptic:send']);
    expect(run([{ type: 'down', at: 0 }, { type: 'up', at: 2000 }, { type: 'done' }]).s.phase).toBe('idle');
  });

  it('treats a short press as a tap: nothing is sent and the button explains itself', () => {
    const r = run([{ type: 'down', at: 0 }, { type: 'up', at: TALK.HOLD_MS - 1 }]);
    expect(r.s.phase).toBe('idle');
    expect(r.effects).toEqual(['start', 'haptic:start', 'discard', 'explain']);
    expect(r.effects).not.toContain('send');
    expect(run([{ type: 'down', at: 0 }, { type: 'up', at: TALK.HOLD_MS }]).effects).toContain('send');
  });

  it('cancels when the finger slides off and lets go there, and not when it comes back', () => {
    const off = run([{ type: 'down', at: 0 }, { type: 'move', inside: false }, { type: 'up', at: 3000 }]);
    expect(off.s.phase).toBe('idle');
    expect(off.effects).toEqual(['start', 'haptic:start', 'haptic:leave', 'discard', 'haptic:cancel', 'cancelled']);
    const back = run([{ type: 'down', at: 0 }, { type: 'move', inside: false }, { type: 'move', inside: true }, { type: 'up', at: 3000 }]);
    expect(back.effects).toEqual(['start', 'haptic:start', 'haptic:leave', 'haptic:back', 'send', 'haptic:send']);
    // A move that changes nothing has no effect.
    expect(run([{ type: 'down', at: 0 }, { type: 'move', inside: true }]).effects).toEqual(['start', 'haptic:start']);
  });

  it('sends by itself at the longest length, and ignores the release that follows', () => {
    const r = run([{ type: 'down', at: 0 }, { type: 'tick', at: 59_000, maxMs: 60_000 }, { type: 'tick', at: 60_000, maxMs: 60_000 }, { type: 'up', at: 61_000 }]);
    expect(r.s.phase).toBe('sending');
    expect(r.effects.filter((e) => e === 'send')).toHaveLength(1);
    expect(r.effects).toContain('maxed');
  });

  it('drops the recording on cancel or a microphone failure, and a failed send goes back to idle', () => {
    expect(run([{ type: 'down', at: 0 }, { type: 'cancel' }]).effects).toEqual(['start', 'haptic:start', 'discard', 'haptic:cancel', 'cancelled']);
    expect(run([{ type: 'down', at: 0 }, { type: 'failed' }]).effects).toEqual(['start', 'haptic:start', 'discard', 'failed']);
    const r = run([{ type: 'down', at: 0 }, { type: 'up', at: 1000 }, { type: 'failed' }]);
    expect(r.s.phase).toBe('idle');
    expect(r.effects.at(-1)).toBe('failed');
  });

  it('ignores what does not apply: a release while idle, a second press while recording', () => {
    expect(run([{ type: 'up', at: 5 }]).effects).toEqual([]);
    const r = run([{ type: 'down', at: 0 }, { type: 'down', at: 100 }]);
    expect(r.effects).toEqual(['start', 'haptic:start']);
    expect(r.s.at).toBe(0);
    expect(run([{ type: 'down', at: 0 }, { type: 'up', at: 1000 }, { type: 'down', at: 1100 }]).s.phase).toBe('sending');
  });

  it('knows when a finger is on the button, with a margin', () => {
    const rect = { left: 100, right: 300, top: 100, bottom: 300 };
    expect(TALK.inside(rect, 200, 200)).toBe(true);
    expect(TALK.inside(rect, 100 - TALK.SLIDE_MARGIN, 200)).toBe(true);
    expect(TALK.inside(rect, 100 - TALK.SLIDE_MARGIN - 1, 200)).toBe(false);
    expect(TALK.inside(rect, 200, 400)).toBe(false);
  });

  it('shows the time as minutes and seconds', () => {
    expect(TALK.clock(0)).toBe('0:00');
    expect(TALK.clock(7400)).toBe('0:07');
    expect(TALK.clock(65_000)).toBe('1:05');
  });
});

describe('WAV recordings', () => {
  it('encodes 16-bit mono PCM that the engine reads with the same length', () => {
    const samples = new Float32Array(16000 * 1.5).map((_, i) => Math.sin(i / 10) * 0.5);
    const wav = WAV.encodeWav(samples, 16000);
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(WAV.wavSeconds(wav)).toBeCloseTo(1.5, 6);
    // The gateway's own reader agrees.
    expect(wavInfo(wav)).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(wavInfo(wav)!.seconds).toBeCloseTo(1.5, 6);
    const dv = new DataView(wav.buffer);
    expect(dv.getInt16(44 + 2 * 16, true)).toBe(Math.round(Math.sin(1.6) * 0.5 * 0x7fff));
  });

  it('clips out-of-range samples', () => {
    const dv = new DataView(WAV.encodeWav(new Float32Array([2, -2]), 8000).buffer);
    expect(dv.getInt16(44, true)).toBe(0x7fff);
    expect(dv.getInt16(46, true)).toBe(-0x8000);
  });

  it('resamples to 16 kHz, keeping the length in seconds', () => {
    const one = new Float32Array(48000).fill(0.25);
    const down = WAV.resample(one, 48000, 16000);
    expect(down.length).toBe(16000);
    expect(down[100]).toBeCloseTo(0.25, 6);
    expect(WAV.resample(new Float32Array(44100), 44100, 16000).length).toBe(16000);
    expect(WAV.resample(new Float32Array(8000), 8000, 16000).length).toBe(16000);
    expect(WAV.resample(one, 16000, 16000)).not.toBe(one);
    expect(() => WAV.resample(one, 0, 16000)).toThrow();
  });

  it('joins chunks and measures loudness from 0 to 1', () => {
    expect(Array.from(WAV.concat([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3]);
    expect(WAV.level(new Float32Array(100))).toBe(0);
    expect(WAV.level(new Float32Array(100).fill(1))).toBe(1);
    expect(WAV.level(new Float32Array(100).fill(0.1))).toBeCloseTo(0.4, 5);
    expect(WAV.level(new Float32Array())).toBe(0);
  });
});

describe('what is read aloud', () => {
  it('turns Markdown into plain sentences and leaves code out', () => {
    const md = '# Bring\n\nYou need **water** and [your ID](https://x.test).\n\n- a map\n- a phone\n\n| Item | Why |\n| - | - |\n| water | heat |\n\n```js\nconsole.log(1)\n```\nThat is all';
    expect(SPEECH.speakable(md)).toBe('Bring. You need water and your ID. a map. a phone. Item, Why. water, heat. That is all.');
    expect(SPEECH.speakable('Use `npm test` now.')).toBe('Use npm test now.');
  });

  // Spoken answers (owner, 2026-11-16): whatever the model sends, no mark is read aloud.
  it('never reads a mark, an address or an emoji, even from a model that ignored the voice rule', () => {
    const md = '## 🌧️ **Rain** today\n\n* Take an *umbrella* 👍\n* See https://weather.test/today or <https://x.test>\n1. **Leave** at __8 am__.\n\n---\n> Stay dry ~~please~~\n• Done';
    const said = SPEECH.speakable(md);
    expect(said).toBe('Rain today. Take an umbrella. See or. Leave at 8 am. Stay dry please. Done.');
    expect(said).not.toMatch(/[*#_~`|>\u{1F300}-\u{1FAFF}]|https?:/u);
    // A star or hash left open is dropped, and a word with an underscore in it stays one word.
    expect(SPEECH.speakable('**Note: the total is 5 # items')).toBe('Note: the total is 5 items.');
    expect(SPEECH.speakable('Call it max_tokens.')).toBe('Call it max_tokens.');
    expect(SPEECH.speakable('A 🇯🇲 flag and 👋🏽 wave.')).toBe('A flag and wave.');
    // A hash or a "greater than" that belongs to the words is kept, and a bar between words is a pause.
    expect(SPEECH.speakable('C# and F# are #1. 5 > 3 and x >= 2.')).toBe('C# and F# are #1. 5 > 3 and x >= 2.');
    expect(SPEECH.speakable('red | green | blue')).toBe('red, green, blue.');
    expect(SPEECH.speakable('##Heading\n#tag and a -> b')).toBe('Heading. tag and a - b.');
  });

  it('splits sentences and groups them into pieces no longer than the limit', () => {
    expect(SPEECH.sentences('One. Two? Three! Four')).toEqual(['One.', 'Two?', 'Three!', 'Four']);
    const pieces = SPEECH.chunk('First sentence here. Second one. Third sentence is a bit longer than the others.', 40);
    expect(pieces).toEqual(['First sentence here. Second one.', 'Third sentence is a bit longer than the', 'others.']);
    for (const p of pieces) expect([...p].length).toBeLessThanOrEqual(40);
  });

  it('splits a long sentence at a comma, then a space, and cuts a word longer than the limit', () => {
    expect(SPEECH.chunk('Water, bread and a map for the long walk.', 20)).toEqual(['Water, bread and a', 'map for the long', 'walk.']);
    expect(SPEECH.chunk('a'.repeat(25), 10)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
    expect(() => SPEECH.chunk('x', 0)).toThrow();
  });

  it('reads at most the first part of a long answer', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const pieces = SPEECH.speechPieces(long, 100, 500);
    expect(pieces.reduce((s: number, p: string) => s + p.length, 0)).toBeLessThanOrEqual(500);
    expect(pieces[0].startsWith('Sentence number 0.')).toBe(true);
    expect(SPEECH.speechPieces('', 100)).toEqual([]);
    expect(SPEECH.speechPieces('x'.repeat(900), 600, 500)).toEqual(['x'.repeat(500)]);
  });
});

const sttModel = (over: object = {}) => ({ id: 'stt', kind: 'transcription', tier: 'enclave', max_seconds: 30, pricing: { usd: { request: 0.0125, second: 0.001, kchar: 0 }, sat: { request: 12.5, second: 1, kchar: 0 } }, ...over });
const ttsModel = (over: object = {}) => ({ id: 'tts', kind: 'speech', tier: 'enclave', max_chars: 100, voices: ['v1', 'v2'], pricing: { usd: { request: 0.0025, second: 0, kchar: 0.01 }, sat: null }, ...over });

describe('voice prices and models', () => {
  it('uses only private audio models with Private only on', () => {
    const list = [sttModel({ id: 'std', tier: 'standard' }), sttModel(), ttsModel({ tier: 'standard' })];
    expect(VOICE.audioModels(list, { privateOnly: true })).toEqual({ transcription: list[1], speech: null });
    expect(VOICE.audioModels(list, { privateOnly: false })).toEqual({ transcription: list[0], speech: list[2] });
    expect(VOICE.audioModels(undefined, { privateOnly: true })).toEqual({ transcription: null, speech: null });
  });

  it('prices in msub: per request, per second, per character', () => {
    // 0.0125 USD + 3 s x 0.001 = 0.0155 USD = 1.55 cents = 1550 msub.
    expect(VOICE.audioMsub(sttModel(), 'usd', { seconds: 3 })).toBe(1550);
    expect(VOICE.audioMsub(sttModel(), 'sat', { seconds: 3 })).toBe(15_500);
    // Whole seconds, rounded up, so the shown price is never below the bill.
    expect(VOICE.transcribeMsub(sttModel(), 'usd', 2.1)).toBe(1550);
    expect(VOICE.speakMsub(ttsModel(), 'usd', ['Hello there.', 'Bye.'])).toBe(Math.ceil((0.005 + (16 / 1000) * 0.01) * 100_000));
    expect(VOICE.speakMsub(ttsModel(), 'usd', [])).toBe(0);
    expect(VOICE.audioMsub(ttsModel(), 'sat', { chars: 10 })).toBeNull();
    expect(VOICE.audioMsub(null, 'usd', {})).toBeNull();
  });

  const mod = (id: string, available: boolean, priv: boolean) => ({ id, available: () => available, private: () => priv });
  it('chooses voice in: the engine by default, the browser only when chosen and Private only is off', () => {
    const mods = { engine: mod('engine', true, true), device: mod('device', true, false) };
    expect(STATE.DEFAULT_SETTINGS.voiceIn).toBe('auto');
    expect(STATE.pickVoiceIn(mods, { ...STATE.DEFAULT_SETTINGS })?.id).toBe('engine');
    expect(STATE.pickVoiceIn(mods, { privateOnly: true, voiceIn: 'device' })?.id).toBe('engine');
    expect(STATE.pickVoiceIn(mods, { privateOnly: false, voiceIn: 'device' })?.id).toBe('device');
    expect(STATE.pickVoiceIn({ engine: mod('engine', false, true), device: mods.device }, { privateOnly: true, voiceIn: 'engine' })).toBeNull();
    expect(STATE.pickVoiceIn({ engine: mod('engine', true, false) }, { privateOnly: true, voiceIn: 'engine' })).toBeNull();
  });

  it("chooses voice in: the phone's own recogniser first in the app where it has the language, else the engine", () => {
    const engine = mod('engine', true, true);
    const device = mod('device', true, false);
    const phone = mod('phone', true, true);
    const auto = { ...STATE.DEFAULT_SETTINGS };
    // In the app, available: the phone, with Private only on or off.
    expect(STATE.pickVoiceIn({ phone, engine, device }, auto)?.id).toBe('phone');
    expect(STATE.pickVoiceIn({ phone, engine, device }, { ...auto, privateOnly: false })?.id).toBe('phone');
    expect(STATE.pickVoiceIn({ phone, engine }, { ...auto, voiceIn: 'phone' })?.id).toBe('phone');
    // In the app, but the recogniser lacks the language (or there is none): the engine.
    const noLang = mod('phone', false, true);
    expect(STATE.pickVoiceIn({ phone: noLang, engine, device }, auto)?.id).toBe('engine');
    expect(STATE.pickVoiceIn({ phone: noLang, engine }, { ...auto, voiceIn: 'phone' })?.id).toBe('engine');
    // On the website there is no phone module's recogniser to use: the engine.
    expect(STATE.pickVoiceIn({ phone: mod('phone', false, true), engine, device }, auto)?.id).toBe('engine');
    expect(STATE.pickVoiceIn({ engine, device }, auto)?.id).toBe('engine');
    // The engine picked in More, Voice: the engine, and the phone only when the engine has no model.
    expect(STATE.pickVoiceIn({ phone, engine }, { ...auto, voiceIn: 'engine' })?.id).toBe('engine');
    expect(STATE.pickVoiceIn({ phone, engine: mod('engine', false, true) }, { ...auto, voiceIn: 'engine' })?.id).toBe('phone');
    // The browser's recogniser still only when chosen and Private only is off.
    expect(STATE.pickVoiceIn({ phone, engine, device }, { privateOnly: false, voiceIn: 'device' })?.id).toBe('device');
    expect(STATE.pickVoiceIn({ phone, engine, device }, { privateOnly: true, voiceIn: 'device' })?.id).toBe('phone');
  });

  it("chooses Forge Private Voice's own speech to text first, then the phone's recogniser, then the engine", () => {
    const engine = mod('engine', true, true);
    const phone = mod('phone', true, true);
    const bundled = mod('bundled', true, true);
    const auto = { ...STATE.DEFAULT_SETTINGS };
    expect(STATE.pickVoiceIn({ bundled, phone, engine }, auto)?.id).toBe('bundled');
    expect(STATE.pickVoiceIn({ bundled, phone, engine }, { ...auto, voiceIn: 'phone' })?.id).toBe('bundled');
    // The universal APK and the website: no bundled model, so as before.
    const none = mod('bundled', false, true);
    expect(STATE.pickVoiceIn({ bundled: none, phone, engine }, auto)?.id).toBe('phone');
    expect(STATE.pickVoiceIn({ bundled: none, phone: mod('phone', false, true), engine }, auto)?.id).toBe('engine');
    // The engine picked: the engine first, then the phone's ways.
    expect(STATE.pickVoiceIn({ bundled, phone, engine }, { ...auto, voiceIn: 'engine' })?.id).toBe('engine');
    expect(STATE.pickVoiceIn({ bundled, phone, engine: mod('engine', false, true) }, { ...auto, voiceIn: 'engine' })?.id).toBe('bundled');
  });

  it("reads a saved 'engine' as the old default, unless it was picked since 'auto' came", () => {
    expect(STATE.loadedSettings(null).voiceIn).toBe('auto');
    expect(STATE.loadedSettings({ voiceIn: 'engine', look: 'dark' })).toMatchObject({ voiceIn: 'auto', look: 'dark' });
    expect(STATE.loadedSettings({ voiceIn: 'engine', voiceInPicked: true }).voiceIn).toBe('engine');
    expect(STATE.loadedSettings({ voiceIn: 'device' }).voiceIn).toBe('device');
    expect(STATE.loadedSettings({ voiceIn: 'phone', voiceInPicked: true }).voiceIn).toBe('phone');
  });

  it('chooses voice out: the phone voice when it has one, else the engine, or none when off', () => {
    const both = { engine: mod('engine', true, true), device: mod('device', true, true) };
    expect(STATE.DEFAULT_SETTINGS.voiceOut).toBe('auto');
    expect(STATE.pickVoiceOut(both, { voiceOut: 'auto', privateOnly: true })?.id).toBe('device');
    expect(STATE.pickVoiceOut({ ...both, device: mod('device', false, true) }, { voiceOut: 'auto', privateOnly: true })?.id).toBe('engine');
    expect(STATE.pickVoiceOut(both, { voiceOut: 'engine', privateOnly: true })?.id).toBe('engine');
    expect(STATE.pickVoiceOut(both, { voiceOut: 'off', privateOnly: true })).toBeNull();
    expect(STATE.pickVoiceOut({ engine: mod('engine', true, false) }, { voiceOut: 'engine', privateOnly: true })).toBeNull();
  });
});

describe('the engine client audio calls', () => {
  it('sends a recording as multipart and reads the charge from the headers', async () => {
    let seen: any;
    const engine = E.createEngine({
      fetch: async (url: string, init: any) => {
        seen = { url, init };
        return new Response(JSON.stringify({ text: 'Hello' }), { headers: { 'content-type': 'application/json', 'x-forge-charged-msub': '1250', 'x-forge-balance-msub': '98750' } });
      },
    });
    const r = await engine.transcribe('sk-forge-k', { model: 'stt', audio: WAV.encodeWav(new Float32Array(16000)), seconds: 1, language: 'en' });
    expect(r).toEqual({ text: 'Hello', chargedMsub: 1250, balanceMsub: 98750, freeVoiceLeft: null });
    expect(seen.url).toBe('/v1/audio/transcriptions');
    expect(seen.init.headers.authorization).toBe('Bearer sk-forge-k');
    const form: FormData = seen.init.body;
    expect(form.get('model')).toBe('stt');
    expect(form.get('duration')).toBe('1');
    expect(form.get('language')).toBe('en');
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/wav');
    expect(WAV.wavSeconds(new Uint8Array(await file.arrayBuffer()))).toBe(1);
  });

  it('reads what a free voice question leaves for today, and says plainly when they are used up', async () => {
    const engine = E.createEngine({
      fetch: async () => new Response(JSON.stringify({ text: 'Hi' }), { headers: { 'x-forge-charged-msub': '0', 'x-forge-balance-msub': '0', 'x-forge-free-voice-left': '19' } }),
    });
    expect(await engine.transcribe('k', { model: 'stt', audio: new Uint8Array(44) })).toEqual({ text: 'Hi', chargedMsub: 0, balanceMsub: 0, freeVoiceLeft: 19 });
    const used = E.createEngine({ fetch: async () => new Response(JSON.stringify({ error: { code: 'free_voice_limit', message: 'used up' }, free_voice: { left: 0 } }), { status: 402 }) });
    await expect(used.transcribe('k', { model: 'stt', audio: new Uint8Array(44) })).rejects.toMatchObject({ code: 'free_voice_limit', status: 402 });
    expect(ERR.errorView('free_voice_limit', 'used up')).toEqual({ key: 'talk.freeVoiceOut', next: 'addFunds' });
    expect(EN['talk.freeVoiceOut']).toBe('No free voice today. Free voice questions are used up for today. Type instead, or add funds.');
  });

  it('turns a refused or failed audio request into an EngineError, and answers proof of work', async () => {
    const engine = E.createEngine({ fetch: async () => new Response(JSON.stringify({ error: { code: 'insufficient_balance', message: 'low' } }), { status: 402 }) });
    await expect(engine.transcribe('k', { model: 'stt', audio: new Uint8Array(44) })).rejects.toMatchObject({ code: 'insufficient_balance', status: 402 });
    await expect(engine.speech('k', { model: 'tts', input: 'x', voice: 'v' })).rejects.toMatchObject({ code: 'insufficient_balance' });
    const bad = E.createEngine({ fetch: async () => new Response('{}', { status: 200 }) });
    await expect(bad.transcribe('k', { model: 'stt', audio: new Uint8Array(44) })).rejects.toMatchObject({ code: 'bad_answer' });
    let calls = 0;
    const pow = E.createEngine({
      solve: async () => 'solved',
      fetch: async (_u: string, init: any) => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ error: { code: 'pow_required' }, pow: { challenge: 'c', bits: 1 } }), { status: 428 });
        expect(init.headers['X-Bellows-Pow'] ?? init.headers['x-bellows-pow']).toBe('solved');
        return new Response(JSON.stringify({ text: 'ok' }));
      },
    });
    expect((await pow.transcribe('k', { model: 'stt', audio: new Uint8Array(44) })).text).toBe('ok');
  });

  it('asks for WAV speech and returns the sound', async () => {
    let body: any;
    const engine = E.createEngine({
      fetch: async (_u: string, init: any) => {
        body = JSON.parse(init.body);
        return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'audio/wav', 'x-forge-charged-msub': '300' } });
      },
    });
    const r = await engine.speech('k', { model: 'tts', input: 'Hi.', voice: 'v1' });
    expect(body).toEqual({ model: 'tts', input: 'Hi.', voice: 'v1', response_format: 'wav' });
    expect(r.chargedMsub).toBe(300);
    expect(r.balanceMsub).toBeNull();
    expect((await r.blob.arrayBuffer()).byteLength).toBe(4);
  });
});

describe('voice modules get only their own inputs', () => {
  it('hands voice in the microphone and speech to text, voice out the speaker and text to speech', () => {
    const fn = () => {};
    const all = { t: fn, ui: {}, engine: {}, wallet: {}, vault: {}, state: {}, actions: {}, mic: {}, recognizer: {}, speaker: {}, synth: {}, audio: { model: fn, price: fn, transcribe: fn, speak: fn }, speech: { available: fn, start: fn, other: fn }, asr: { available: fn, start: fn, other: fn } };
    const vin = R.inputsFor('voice-in', all);
    expect(Object.keys(vin).sort()).toEqual(['asr', 'audio', 'mic', 'recognizer', 'speech', 't']);
    expect(Object.keys(vin.audio).sort()).toEqual(['model', 'price', 'transcribe']);
    expect(Object.keys(vin.speech).sort()).toEqual(['available', 'start']);
    expect(Object.keys(vin.asr).sort()).toEqual(['available', 'start']);
    const vout = R.inputsFor('voice-out', all);
    expect(Object.keys(vout).sort()).toEqual(['audio', 'speaker', 'synth', 't']);
    expect(Object.keys(vout.audio).sort()).toEqual(['model', 'price', 'speak']);
    for (const x of [vin, vout]) for (const k of ['engine', 'wallet', 'vault', 'state', 'actions']) expect(x).not.toHaveProperty(k);
  });

  it('bundles both ways for each direction', () => {
    const ids = R.BUNDLED.filter((b: any) => b.kind.startsWith('voice')).map((b: any) => `${b.kind}/${b.folder}`);
    expect(ids.sort()).toEqual(['voice-in/bundled', 'voice-in/device', 'voice-in/engine', 'voice-in/phone', 'voice-out/device', 'voice-out/engine', 'voice-out/phonon']);
    // Forge Private Voice's own speech to text is listed first, then the phone's own recogniser.
    expect(R.BUNDLED.filter((b: any) => b.kind === 'voice-in').map((b: any) => b.folder)).toEqual(['bundled', 'phone', 'engine', 'device']);
  });
});

/** A fake microphone that delivers `seconds` of sound at `rate` when started. */
function fakeMic(seconds: number, rate = 48000, loud = 0.2) {
  const m = {
    stopped: 0,
    available: () => true,
    async open() {
      let fn: (b: Float32Array) => void = () => {};
      return {
        sampleRate: rate,
        onData: (f: any) => {
          fn = f;
          for (let i = 0; i < seconds * 10; i++) fn(new Float32Array(rate / 10).fill(loud));
        },
        stop: () => m.stopped++,
      };
    },
  };
  return m;
}

describe('voice in through the engine', () => {
  const audioFor = (model: any) => {
    const sent: any[] = [];
    return {
      sent,
      model: (k: string) => (k === 'transcription' ? model : null),
      price: (_k: string, u: any) => VOICE.audioMsub(model, 'usd', u),
      transcribe: async (wav: Uint8Array, o: any) => {
        sent.push({ wav, ...o });
        return { text: 'What should I bring?', chargedMsub: 1300, balanceMsub: 5000 };
      },
    };
  };

  it('records, makes a 16 kHz WAV of it and sends it, stopping the microphone', async () => {
    const mic = fakeMic(2);
    const audio = audioFor(sttModel());
    const m = VIN.create({ mic, audio });
    expect(m.available()).toBe(true);
    expect(m.private()).toBe(true);
    expect(m.maxSeconds()).toBe(30);
    const levels: number[] = [];
    const session = await m.start({ onLevel: (l: number) => levels.push(l) });
    expect(session.seconds()).toBeCloseTo(2, 5);
    expect(levels.length).toBe(20);
    const r = await session.finish({});
    expect(r.text).toBe('What should I bring?');
    expect(mic.stopped).toBe(1);
    expect(audio.sent[0].seconds).toBeCloseTo(2, 5);
    expect(wavInfo(audio.sent[0].wav)).toMatchObject({ sampleRate: 16000, channels: 1 });
    expect(wavInfo(audio.sent[0].wav)!.seconds).toBeCloseTo(2, 3);
  });

  it('sends nothing when cancelled, and is not available without a model or a microphone', async () => {
    const mic = fakeMic(1);
    const audio = audioFor(sttModel());
    const session = await VIN.create({ mic, audio }).start({});
    session.cancel();
    expect(mic.stopped).toBe(1);
    expect(audio.sent).toHaveLength(0);
    expect(VIN.create({ mic, audio: audioFor(null) }).available()).toBe(false);
    expect(VIN.create({ mic: { ...mic, available: () => false }, audio }).available()).toBe(false);
    expect(VIN.create({ mic, audio: audioFor(sttModel({ tier: 'standard' })) }).private()).toBe(false);
  });

  it('sends nothing and pays nothing for a recording under half a second, or none at all', async () => {
    // A hold on first use lasts while the person taps Allow, so the microphone may start just before
    // the finger lifts: 0.2 s, or no sound at all, must not reach the engine (which refuses under 0.3 s).
    expect(VIN.MIN_SEND_SECONDS).toBeGreaterThan(0.3);
    for (const secs of [0.2, 0]) {
      const mic = fakeMic(secs);
      const audio = audioFor(sttModel());
      const session = await VIN.create({ mic, audio }).start({});
      expect(await session.finish({})).toEqual({ text: '', chargedMsub: 0, balanceMsub: null });
      expect(audio.sent).toHaveLength(0);
      expect(mic.stopped).toBe(1);
    }
    // A little over half a second is sent.
    const audio = audioFor(sttModel());
    await (await VIN.create({ mic: fakeMic(0.6), audio }).start({})).finish({});
    expect(audio.sent).toHaveLength(1);
  });

  it('sends nothing and pays nothing for a hold with no voice in it, however long', async () => {
    // Three seconds of a quiet room (no sound at all, then a faint hiss): the button was held and
    // nothing was said. The level bars still get their readings.
    for (const hiss of [0, 0.005]) {
      const mic = fakeMic(3, 48000, hiss);
      const audio = audioFor(sttModel());
      const levels: number[] = [];
      const session = await VIN.create({ mic, audio }).start({ onLevel: (l: number) => levels.push(l) });
      expect(Math.max(...levels)).toBeLessThan(VIN.VOICE_LEVEL);
      expect(await session.finish({})).toEqual({ text: '', chargedMsub: 0, balanceMsub: null });
      expect(audio.sent).toHaveLength(0);
      expect(mic.stopped).toBe(1);
    }
    // A quiet voice is still sent: a chunk only has to reach the voice level.
    const audio = audioFor(sttModel());
    await (await VIN.create({ mic: fakeMic(2, 48000, 0.02), audio }).start({})).finish({});
    expect(audio.sent).toHaveLength(1);
  });

  it('the browser recogniser is free and never private', async () => {
    const recognizer = { available: () => true, start: async ({ onText }: any) => (onText('Hello'), { stop: async () => 'Hello there', cancel: vi.fn() }) };
    const m = VIN_DEVICE.create({ recognizer });
    expect(m.private()).toBe(false);
    expect(m.price(10)).toBeNull();
    const heard: string[] = [];
    const s = await m.start({ onText: (x: string) => heard.push(x) });
    expect(heard).toEqual(['Hello']);
    expect(await s.finish()).toEqual({ text: 'Hello there', chargedMsub: 0, balanceMsub: null });
  });
});

/**
 * The ForgeSpeech plugin as nativeSpeech sees it, over a fake bridge: availability as given, and each
 * start answered by `script(emit, opts)`, which plays the plugin's events.
 */
function fakeSpeech({ onDevice = true, reason = null as string | null, startError = null as any, onStop = (emit: (ev: any) => void) => (emit({ type: 'final', text: 'What should I bring?' }), emit({ type: 'end' })) } = {}) {
  const calls: Array<[string, any]> = [];
  let listener: (ev: any) => void = () => {};
  const call = async (plugin: string, method: string, opts: any) => {
    expect(plugin).toBe('ForgeSpeech');
    calls.push([method, opts]);
    if (method === 'available') return { onDevice, reason, locale: 'en-US' };
    if (method === 'start') {
      if (startError) throw startError;
      const emit = (ev: any) => listener({ id: opts.id, ...ev });
      emit({ type: 'started' });
      emit({ type: 'level', level: 0.4 });
      emit({ type: 'partial', text: 'What should' });
      fake.emit = emit;
      return {};
    }
    if (method === 'stop') setTimeout(() => onStop(fake.emit), 5);
    return {};
  };
  const on = (_plugin: string, _event: string, fn: any) => ((listener = fn), { remove: async () => {} });
  const fake = { speech: N.nativeSpeech(call, on), calls, emit: (_ev: any) => {} };
  return fake;
}

/** A stand-in for ForgeAsr over the bridge, as nativeAsr sees it. */
function fakeAsr({ available = true, reason = null as string | null, onStop = (emit: (ev: any) => void) => (emit({ type: 'final', text: 'Is it safe to swim?' }), emit({ type: 'end' })) } = {}) {
  const calls: Array<[string, any]> = [];
  let listener: (ev: any) => void = () => {};
  let emit: (ev: any) => void = () => {};
  const call = async (plugin: string, method: string, opts: any) => {
    expect(plugin).toBe('ForgeAsr');
    calls.push([method, opts]);
    if (method === 'available') return { available, reason, model: available ? 'moonshine-tiny-en' : null, language: 'en' };
    if (method === 'start') {
      emit = (ev: any) => listener({ id: opts.id, ...ev });
      emit({ type: 'started' });
      emit({ type: 'partial', text: 'Is it' });
      return {};
    }
    if (method === 'stop') setTimeout(() => onStop(emit), 5);
    return {};
  };
  const on = (plugin: string, event: string, fn: any) => (expect([plugin, event]).toEqual(['ForgeAsr', 'asr']), (listener = fn), { remove: async () => {} });
  return { asr: N.nativeAsr(call, on), calls };
}

describe("voice in on this phone (Forge Private Voice's own speech to text)", () => {
  it('is offered only where the app carries the model, free and private', async () => {
    const m = VIN_BUNDLED.create({ asr: fakeAsr().asr });
    expect(m.id).toBe('bundled');
    expect(m.available()).toBe(false); // until the app answers
    await m.checked;
    expect(m.available()).toBe(true);
    expect(m.private()).toBe(true);
    expect(m.price(30)).toBe(0);
    // The universal APK, the website, and what the registry hands on the website.
    for (const asr of [fakeAsr({ available: false, reason: 'no speech to text in this app' }).asr, null]) {
      const x = VIN_BUNDLED.create({ asr });
      await x.checked;
      expect(x.available()).toBe(false);
    }
    const projected = VIN_BUNDLED.create(R.inputsFor('voice-in', { t: () => '', asr: null }));
    await projected.checked;
    expect(projected.available()).toBe(false);
    expect(VIN_BUNDLED.bridgeFor({})).toBeNull();
  });

  it('shows the words as they come and sends the whole recording heard when the button is let go', async () => {
    const f = fakeAsr();
    const m = VIN_BUNDLED.create({ asr: f.asr });
    await m.checked;
    const heard: string[] = [];
    const s = await m.start({ onText: (x: string) => heard.push(x) });
    expect(heard).toEqual(['Is it']);
    expect(await s.finish()).toEqual({ text: 'Is it safe to swim?', chargedMsub: 0, balanceMsub: null });
    expect(f.calls.map(([x]) => x)).toEqual(['available', 'start', 'stop']);
  });

  it('a crash or failed load in the app hands the next question to the next way', async () => {
    const f = fakeAsr({ onStop: (emit) => (emit({ type: 'error', code: 'unavailable' }), emit({ type: 'end' })) });
    const m = VIN_BUNDLED.create({ asr: f.asr });
    await m.checked;
    await expect((await m.start()).finish()).rejects.toMatchObject({ key: 'talk.phoneFailed' });
    expect(m.available()).toBe(false);
  });
});

describe("voice in on this phone (the Android app's on-device recogniser)", () => {
  it('asks the phone once whether its on-device recogniser has the language, and is free and private', async () => {
    const f = fakeSpeech();
    const m = VIN_PHONE.create({ speech: f.speech });
    expect(m.available()).toBe(false); // until the phone answers
    await m.checked;
    expect(m.available()).toBe(true);
    expect(m.private()).toBe(true);
    expect(m.price(30)).toBe(0);
    expect(f.calls.filter(([x]) => x === 'available')).toHaveLength(1);
    expect(f.calls[0]![1].locale).toMatch(/^en/);
  });

  it('is not offered on the website or where the phone lacks the language', async () => {
    const web = VIN_PHONE.create({ speech: null });
    await web.checked;
    expect(web.available()).toBe(false);
    // What the registry hands on the website: the projection of no bridge, an empty object.
    const projected = VIN_PHONE.create(R.inputsFor('voice-in', { t: () => '', speech: null }));
    await projected.checked;
    expect(projected.available()).toBe(false);
    const none = VIN_PHONE.create({ speech: fakeSpeech({ onDevice: false, reason: 'language-not-downloaded' }).speech });
    await none.checked;
    expect(none.available()).toBe(false);
    expect(none.status().reason).toBe('language-not-downloaded');
  });

  it('listens in English: the phone\'s own English, else US English', () => {
    expect(VIN_PHONE.localeFor('en-GB')).toBe('en-GB');
    expect(VIN_PHONE.localeFor('en_IN')).toBe('en-IN');
    expect(VIN_PHONE.localeFor('de-DE')).toBe('en-US');
    expect(VIN_PHONE.localeFor(undefined)).toBe('en-US');
  });

  it('shows the words as they come and sends the final words when the button is let go', async () => {
    const f = fakeSpeech();
    const m = VIN_PHONE.create({ speech: f.speech });
    await m.checked;
    const heard: string[] = [];
    const levels: number[] = [];
    const s = await m.start({ onText: (x: string) => heard.push(x), onLevel: (l: number) => levels.push(l) });
    expect(heard).toEqual(['What should']);
    expect(levels).toEqual([0.4]);
    expect(await s.finish()).toEqual({ text: 'What should I bring?', chargedMsub: 0, balanceMsub: null });
    expect(f.calls.map(([x]) => x)).toEqual(['available', 'start', 'stop']);
  });

  it('nothing heard is an empty question; a failure says so in its own words; cancel drops it', async () => {
    const quiet = fakeSpeech({ onStop: (emit) => (emit({ type: 'error', code: 'no-speech' }), emit({ type: 'end' })) });
    const a = VIN_PHONE.create({ speech: quiet.speech });
    await a.checked;
    expect((await (await a.start()).finish()).text).toBe('');

    const broken = fakeSpeech({ onStop: (emit) => (emit({ type: 'error', code: 'unavailable' }), emit({ type: 'end' })) });
    const b = VIN_PHONE.create({ speech: broken.speech });
    await b.checked;
    await expect((await b.start()).finish()).rejects.toMatchObject({ key: 'talk.phoneFailed' });
    // The phone lost its recogniser: the next question goes to the engine.
    expect(b.available()).toBe(false);

    const c = fakeSpeech();
    const cm = VIN_PHONE.create({ speech: c.speech });
    await cm.checked;
    (await cm.start()).cancel();
    expect(c.calls.map(([x]) => x)).toEqual(['available', 'start', 'cancel']);
  });

  it('a refused microphone reads as the microphone adapter says it', async () => {
    const f = fakeSpeech({ startError: { message: 'The microphone is not allowed.', code: 'permission' } });
    const m = VIN_PHONE.create({ speech: f.speech });
    await m.checked;
    await expect(m.start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(m.available()).toBe(true);
  });
});

describe('voice out through the engine', () => {
  /**
   * fail: every fetch fails. playFails: how many plays are refused first (autoplay refused, say).
   * onPlayed(n): called as the nth piece starts to sound.
   */
  const setup = (fail = false, { playFails = 0, onPlayed = (_n: number) => {} } = {}) => {
    const fetched: string[] = [];
    const played: string[] = [];
    let refused = 0;
    const audio = {
      model: (k: string) => (k === 'speech' ? ttsModel() : null),
      price: (_k: string, u: any) => VOICE.audioMsub(ttsModel(), 'usd', u),
      speak: async (input: string) => {
        fetched.push(input);
        if (fail) throw Object.assign(new Error('upstream'), { code: 'upstream_error' });
        return { blob: new Blob([input]), chargedMsub: 260 };
      },
    };
    const speaker = {
      play: (blob: Blob) => {
        let stop = () => {};
        if (refused < playFails) {
          refused++;
          return { done: Promise.reject(Object.assign(new Error('play() was refused'), { name: 'NotAllowedError' })), stop };
        }
        const done = blob.text().then((x) => {
          played.push(x);
          onPlayed(played.length);
          return new Promise<void>((r) => {
            stop = r;
            setTimeout(r, 5);
          });
        });
        return { done, stop: () => stop() };
      },
    };
    return { fetched, played, m: VOUT.create({ audio, speaker }) };
  };

  it('fetches and plays each piece in order, pays once, and replays from memory', async () => {
    const { fetched, played, m } = setup();
    const pieces = ['One.', 'Two.', 'Three.'];
    expect(m.price(pieces, 'a1')).toBe(VOICE.audioMsub(ttsModel(), 'usd', { requests: 3, chars: 14 }));
    const states: string[] = [];
    const r = await m.speak(pieces, { key: 'a1', onState: (s: string) => states.push(s) }).done;
    expect(r.chargedMsub).toBe(780);
    expect(fetched).toEqual(pieces);
    expect(played).toEqual(pieces);
    expect(states[0]).toBe('loading');
    expect(m.cached('a1')).toBe(true);
    expect(m.price(pieces, 'a1')).toBe(0);
    expect((await m.speak(pieces, { key: 'a1' }).done).chargedMsub).toBe(0);
    expect(fetched).toHaveLength(3);
    expect(played).toHaveLength(6);
  });

  it('stops when asked and keeps nothing half fetched', async () => {
    const { fetched, m } = setup();
    const ctl = m.speak(['One.', 'Two.', 'Three.'], { key: 'b' });
    ctl.stop();
    await ctl.done.catch(() => {});
    expect(fetched.length).toBeLessThanOrEqual(2);
    expect(m.cached('b')).toBe(false);
  });

  it('keeps each piece once paid: after a stop part way, Listen pays only for the pieces not fetched', async () => {
    let ctl: any;
    // Stop while the first piece sounds. The second was fetched (and paid) while the first played.
    const { fetched, played, m } = setup(false, { onPlayed: (n) => n === 1 && ctl.stop() });
    const pieces = ['One.', 'Two.', 'Three.'];
    ctl = m.speak(pieces, { key: 'd' });
    expect((await ctl.done).chargedMsub).toBe(520);
    expect(fetched).toEqual(['One.', 'Two.']);
    expect(m.cached('d')).toBe(false);
    // Only the third piece is priced and fetched again; the first two play from memory.
    expect(m.price(pieces, 'd')).toBe(VOICE.audioMsub(ttsModel(), 'usd', { requests: 1, chars: 6 }));
    expect((await m.speak(pieces, { key: 'd' }).done).chargedMsub).toBe(260);
    expect(fetched).toEqual(['One.', 'Two.', 'Three.']);
    expect(played).toEqual(['One.', 'One.', 'Two.', 'Three.']);
    expect(m.cached('d')).toBe(true);
    expect(m.price(pieces, 'd')).toBe(0);
  });

  it('keeps a paid piece when playing it was refused, so Listen does not pay for it again', async () => {
    const { fetched, played, m } = setup(false, { playFails: 1 });
    const pieces = ['One.', 'Two.'];
    await expect(m.speak(pieces, { key: 'e' }).done).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(played).toEqual([]);
    const paid = fetched.length;
    expect(paid).toBeGreaterThanOrEqual(1);
    expect(m.price(pieces, 'e')).toBe(paid === 2 ? 0 : VOICE.audioMsub(ttsModel(), 'usd', { requests: 1, chars: 4 }));
    expect((await m.speak(pieces, { key: 'e' }).done).chargedMsub).toBe((2 - paid) * 260);
    expect(fetched).toEqual(pieces);
    expect(played).toEqual(pieces);
  });

  it('does not take a kept piece for a different text under the same key', async () => {
    const { fetched, m } = setup();
    await m.speak(['One.'], { key: 'f' }).done;
    expect(m.price(['Uno.'], 'f')).toBe(VOICE.audioMsub(ttsModel(), 'usd', { requests: 1, chars: 4 }));
    await m.speak(['Uno.'], { key: 'f' }).done;
    expect(fetched).toEqual(['One.', 'Uno.']);
  });

  it('reports a failed piece', async () => {
    const { m } = setup(true);
    await expect(m.speak(['One.'], { key: 'c' }).done).rejects.toMatchObject({ code: 'upstream_error' });
    expect(m.cached('c')).toBe(false);
  });

  it('the phone voice is free and private, and stops', async () => {
    const spoken: string[] = [];
    const synth = { voices: () => [{}], speak: (p: string) => (spoken.push(p), { done: Promise.resolve(), stop: () => {} }) };
    const m = VOUT_DEVICE.create({ synth });
    expect(m.available()).toBe(true);
    expect(m.private()).toBe(true);
    expect(m.price(['x'])).toBe(0);
    expect((await m.speak(['A.', 'B.']).done).chargedMsub).toBe(0);
    expect(spoken).toEqual(['A.', 'B.']);
    expect(VOUT_DEVICE.create({ synth: { ...synth, voices: () => [] } }).available()).toBe(false);
  });
});

describe('the talk controller', () => {
  function setup({ blocked = null as any, failWith = null as any, text = 'What should I bring?', result = null as any } = {}) {
    let now = 0;
    const S: any = {};
    const store = { S, set: (p: object) => Object.assign(S, p) };
    const toasts: string[] = [];
    const navs: string[] = [];
    const asked: any[] = [];
    const pulses: unknown[] = [];
    let cancelled = 0;
    const voiceInMod = {
      id: 'engine',
      maxSeconds: () => 30,
      start: async () => ({
        finish: async () => {
          if (failWith) throw failWith;
          return result ?? { text, chargedMsub: 1300, balanceMsub: 4000 };
        },
        cancel: () => cancelled++,
      }),
    };
    const ctl = CTL.createTalk({
      store,
      t: (k: string) => k,
      ui: { toast: (x: string) => toasts.push(x) },
      nav: (n: string) => navs.push(n),
      haptics: { pulse: (p: unknown) => pulses.push(p) },
      voiceIn: () => voiceInMod,
      voiceOut: () => null,
      blocker: () => blocked,
      ask: async (q: string, meta: any) => asked.push({ q, meta }),
      refresh: () => {},
      errorText: () => 'error',
      now: () => now,
    });
    return { S, ctl, toasts, navs, asked, pulses, advance: (ms: number) => (now += ms), cancelled: () => cancelled };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('asks the heard words as a voice question and keeps the new balance', async () => {
    const x = setup();
    x.ctl.down();
    expect(x.S.talk.phase).toBe('recording');
    await flush();
    x.advance(1500);
    x.ctl.up();
    expect(x.navs).toEqual(['answer']);
    await flush();
    await flush();
    expect(x.asked).toEqual([{ q: 'What should I bring?', meta: { voice: true } }]);
    expect(x.S.balanceMsub).toBe(4000);
    expect(x.S.talk.phase).toBe('idle');
    expect(x.pulses.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps what a free voice question leaves for today', async () => {
    const x = setup({ result: { text: 'Hi', chargedMsub: 0, balanceMsub: 0, freeVoiceLeft: 4 } });
    x.S.freeVoice = { enabled: true, per_day: 20, left: 5, resets_at: 1 };
    x.ctl.down();
    await flush();
    x.advance(1500);
    x.ctl.up();
    await flush();
    await flush();
    expect(x.S.freeVoice).toEqual({ enabled: true, per_day: 20, left: 4, resets_at: 1 });
    expect(x.S.balanceMsub).toBe(0);
  });

  it('does not record when a question cannot be asked, and says why', () => {
    const go = vi.fn();
    const x = setup({ blocked: { key: 'type.noFunds', go } });
    x.ctl.down();
    expect(x.S.talk.phase).toBe('idle');
    expect(x.toasts).toEqual(['type.noFunds']);
    expect(go).toHaveBeenCalled();
  });

  it('explains on a tap and cancels the recording it started', async () => {
    const x = setup();
    x.ctl.down();
    await flush();
    x.advance(100);
    x.ctl.up();
    expect(x.toasts).toEqual(['talk.explain']);
    expect(x.cancelled()).toBe(1);
    expect(x.asked).toEqual([]);
  });

  it('keeps a failed transcription as an error for the answer screen, not charged when the engine refused it', async () => {
    const x = setup({ failWith: Object.assign(new Error('upstream failed'), { code: 'upstream_error', status: 502 }) });
    x.ctl.down();
    await flush();
    x.advance(2000);
    x.ctl.up();
    await flush();
    await flush();
    expect(x.S.talk.error).toEqual({ code: 'upstream_error', message: 'upstream failed', charged: 0 });
    expect(x.asked).toEqual([]);
    x.ctl.clearError();
    expect(x.S.talk.error).toBeNull();
  });

  it('says so when nothing was heard', async () => {
    const x = setup({ text: '   ' });
    x.ctl.down();
    await flush();
    x.advance(2000);
    x.ctl.up();
    await flush();
    await flush();
    expect(x.S.talk.error).toEqual({ key: 'talk.empty' });
    expect(x.asked).toEqual([]);
  });
});

// Owner, 2026-11-18: a phone whose own recogniser hears nothing twice in a row while its level shows
// sound goes to the engine (core/talk.js, core/state.js pickVoiceIn phoneOff).
describe("a phone recogniser that hears nothing", () => {
  const loud = { heard: false, noSpeech: true, holdMs: 3000, loud: 10 };
  const words = { heard: true, noSpeech: false, holdMs: 3000, loud: 10 };

  it('counts a press only when it was long enough and loud enough and ended with no-speech', () => {
    expect(TALK.phoneHeard(loud)).toBe('missed');
    expect(TALK.phoneHeard(words)).toBe('heard');
    // Words that came live count as heard even when the recogniser then says no-speech.
    expect(TALK.phoneHeard({ ...loud, heard: true })).toBe('heard');
    // A silent hold, a short press, a press with one blip of sound: nothing either way.
    expect(TALK.phoneHeard({ ...loud, loud: 0 })).toBeNull();
    expect(TALK.phoneHeard({ ...loud, loud: TALK.SOUND_READINGS - 1 })).toBeNull();
    expect(TALK.phoneHeard({ ...loud, holdMs: TALK.SOUND_HOLD_MS - 1 })).toBeNull();
    expect(TALK.phoneHeard({ ...loud, holdMs: TALK.SOUND_HOLD_MS, loud: TALK.SOUND_READINGS })).toBe('missed');
    // Any other ending (permission, busy, unavailable: thrown, so noSpeech is false) says nothing.
    expect(TALK.phoneHeard({ ...loud, noSpeech: false })).toBeNull();
    expect(TALK.phoneHeard(null)).toBeNull();
    // The threshold sits on the plugins' 0 to 0.6 scale, above silence (0) and under a voice.
    expect(TALK.SOUND_LEVEL).toBeGreaterThan(0);
    expect(TALK.SOUND_LEVEL).toBeLessThan(0.6);
  });

  it('switches after two misses in a row, and never on taps, silent holds, or with words between', () => {
    const tap = { ...loud, holdMs: 400 };
    const silent = { ...loud, loud: 0 };
    expect(TALK.switchesToEngine([loud, loud])).toBe(true);
    expect(TALK.switchesToEngine([loud])).toBe(false);
    expect(TALK.switchesToEngine([tap, tap, tap])).toBe(false);
    expect(TALK.switchesToEngine([silent, silent, silent])).toBe(false);
    expect(TALK.switchesToEngine([loud, words, loud])).toBe(false);
    expect(TALK.switchesToEngine([loud, loud, words])).toBe(false);
    // A tap or a silent hold between two misses neither counts nor resets.
    expect(TALK.switchesToEngine([loud, tap, silent, loud])).toBe(true);
    expect(TALK.nextMisses(1, words)).toBe(0);
    expect(TALK.nextMisses(1, tap)).toBe(1);
    expect(TALK.nextMisses(undefined, loud)).toBe(1);
  });

  const mod = (id: string, available: boolean, priv: boolean) => ({ id, available: () => available, private: () => priv });
  it('phoneOff: the next way hears it under the same Private only rule, the phone only when none can', () => {
    const phone = mod('phone', true, true);
    const engine = mod('engine', true, true);
    const standard = mod('engine', true, false);
    const bundled = mod('bundled', true, true);
    const off = { ...STATE.DEFAULT_SETTINGS, phoneOff: true };
    expect(STATE.DEFAULT_SETTINGS.phoneOff).toBe(false);
    expect(STATE.pickVoiceIn({ phone, engine }, off)?.id).toBe('engine');
    expect(STATE.pickVoiceIn({ phone, engine }, { ...off, voiceIn: 'phone' })?.id).toBe('engine');
    // Private only with only a standard model: as on a phone without a recogniser, that model is never
    // used; the phone keeps listening, since nothing else can hear it here.
    expect(STATE.pickVoiceIn({ phone, engine: standard }, off)?.id).toBe('phone');
    expect(STATE.pickVoiceIn({ phone, engine: standard }, { ...off, privateOnly: false })?.id).toBe('engine');
    // Forge Private Voice's own model still comes first; the browser's recogniser still only when chosen.
    expect(STATE.pickVoiceIn({ bundled, phone, engine }, off)?.id).toBe('bundled');
    expect(STATE.pickVoiceIn({ phone, engine, device: mod('device', true, false) }, off)?.id).toBe('engine');
  });

  /** A talk controller over the phone module, whose recogniser plays `levels` and then ends with `end`. */
  function phoneTalk({ levels = [0.5, 0.5, 0.5, 0.5], partial = '', end = { type: 'error', code: 'no-speech' } as any, switched = false } = {}) {
    let now = 0;
    const S: any = {};
    const noted: any[] = [];
    let listener: (ev: any) => void = () => {};
    const speech = {
      available: async () => ({ onDevice: true, reason: null, locale: 'en-US' }),
      start: async ({ onEvent }: any) => {
        listener = onEvent;
        for (const level of levels) onEvent({ type: 'level', level });
        if (partial) onEvent({ type: 'partial', text: partial });
        return { stop: () => (listener(end), listener({ type: 'end' })), cancel: () => listener({ type: 'end' }) };
      },
    };
    const phone = VIN_PHONE.create({ speech });
    const ctl = CTL.createTalk({
      store: { S, set: (p: object) => Object.assign(S, p) },
      t: (k: string) => k,
      ui: { toast() {} },
      nav() {},
      haptics: { pulse() {} },
      voiceIn: () => phone,
      voiceOut: () => null,
      blocker: () => null,
      ask: async () => {},
      refresh() {},
      errorText: () => 'error',
      now: () => now,
      notePhone: (x: any) => (noted.push(x), switched),
    });
    return { S, ctl, noted, phone, advance: (ms: number) => (now += ms) };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  async function press(x: ReturnType<typeof phoneTalk>, ms: number) {
    await x.phone.checked;
    x.ctl.down();
    await flush();
    x.advance(ms);
    x.ctl.up();
    for (let i = 0; i < 4; i++) await flush();
  }

  it('the controller hands each press on the phone to notePhone: hold, sound readings, words, no-speech', async () => {
    const a = phoneTalk();
    await press(a, 3000);
    expect(a.noted).toEqual([{ heard: false, noSpeech: true, holdMs: 3000, loud: 4 }]);
    expect(a.S.talk.error).toEqual({ key: 'talk.empty' });
    // Quiet readings are not sound.
    const b = phoneTalk({ levels: [0, 0.05, 0.1, 0.14] });
    await press(b, 3000);
    expect(b.noted[0].loud).toBe(0);
    // Live words came: heard.
    const c = phoneTalk({ partial: 'Where is' });
    await press(c, 3000);
    expect(c.noted[0].heard).toBe(true);
    // The press that switches says so, with the usual Hold to say it again under it (screens/answer.js).
    const d = phoneTalk({ switched: true });
    await press(d, 3000);
    expect(d.S.talk.error).toEqual({ key: 'talk.phoneOff' });
    expect(EN['talk.phoneOff']).toMatch(/^Nothing was heard\. /);
    expect(EN['voice.in.phoneOff']).toBeTruthy();
    // Another failure of the recogniser is said as before and not counted.
    const e = phoneTalk({ end: { type: 'error', code: 'busy' } });
    await press(e, 3000);
    expect(e.noted).toEqual([]);
    expect(e.S.talk.error).toEqual({ key: 'talk.phoneFailed' });
  });
});

// Spoken answers (owner, 2026-11-16): a question asked by voice carries the voice instruction to the
// model, on top of the usual prompt; a typed one, even right after a spoken one, carries the usual one.
describe('the system prompt and eCash', () => {
  // "ping" was answered "pong... what would you like to know about eCash?", and after "great" the model
  // said it was ready for a question about eCash: a prompt that names eCash at all primes a small model.
  // Now the eCash paragraph goes only with a conversation whose own words bring eCash or payments up.
  const load = async () => {
    const C: any = await import('../../../public/v2/core/conversation.js' as string);
    const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
    const opts = { base: en['system.prompt'], ecash: en['system.prompt.ecash'], voice: en['system.prompt.voice'] };
    const user = (content: string, meta?: object) => ({ role: 'user', content, ...(meta ? { meta } : {}) });
    const bot = (content: string) => ({ role: 'assistant', content });
    return { C, en, opts, user, bot };
  };
  const MONEY = /e-?cash|cashu|fedimint|mint|token|\bsats?\b|satoshi|lightning|bitcoin|wallet|balance|\bpay|payment|money|invoice/i;

  it('names no money at all in a conversation about something else', async () => {
    const { C, en, opts, user, bot } = await load();
    expect(en['system.prompt']).not.toMatch(MONEY);
    expect(en['system.prompt.voice']).not.toMatch(MONEY);
    for (const conv of [
      [user('ping')],
      [user('ping'), bot('pong'), user('great')],
      [user('Thanks Forge!'), bot('You are welcome.'), user('What is a good name for a cat?')],
      [user('Will it rain?', { voice: true })],
      // "sat" is a verb here, and a word is matched whole (payday and repaint are words of their own).
      [user('I sat down on payday to repaint the shed.')],
    ]) {
      const p = C.systemPromptFor(conv, opts);
      expect(p, JSON.stringify(conv)).not.toMatch(MONEY);
      expect(C.apiMessages(conv, { systemPrompt: p })[0].content).not.toMatch(MONEY);
    }
  });

  it('adds the eCash paragraph once the person brings eCash or payments up, in any turn and any case', async () => {
    const { C, en, opts, user, bot } = await load();
    expect(en['system.prompt.ecash']).toContain('Chaumian eCash as in the Cashu and Fedimint protocols');
    expect(en['system.prompt.ecash']).not.toMatch(/[–—]/);
    const said = [
      'What is eCash?',
      'what is ECASH',
      'Is e-cash private?',
      'e cash please',
      'Tell me about Cashu.',
      'How does a Fedimint federation work?',
      'Which mint should I trust?',
      'Where do I paste my token?',
      'How many sats is a dollar?',
      'What is a satoshi?',
      'Can I pay with Lightning?',
      'Is Bitcoin money?',
      'Which wallet should I use?',
      'Why is my balance low?',
      'How do I pay for this?',
      'I paid twice!',
      'Where is my payment?',
      'The invoice failed.',
      'Scan this LNURL',
      'Is a BOLT12 offer better?',
    ];
    for (const words of said) {
      const p = C.systemPromptFor([user(words)], opts);
      expect(p, words).toBe(`${en['system.prompt']}\n\n${en['system.prompt.ecash']}`);
    }
    // An earlier turn counts: the whole conversation so far keeps the paragraph.
    const later = [user('What is eCash?'), bot('Digital cash.'), user('great')];
    expect(C.systemPromptFor(later, opts)).toContain(en['system.prompt.ecash']);
    // The model's own words do not: it cannot bring the paragraph back by itself.
    const echo = [user('ping'), bot('Ask me about eCash!'), user('great')];
    expect(C.systemPromptFor(echo, opts)).toBe(en['system.prompt']);
    // A spoken question about it: the base, then eCash, then the voice instruction.
    const spoken = [user('What is a mint?', { voice: true })];
    expect(C.systemPromptFor(spoken, opts)).toBe([en['system.prompt'], en['system.prompt.ecash'], en['system.prompt.voice']].join('\n\n'));
    // Without an eCash paragraph to give, the prompt is the base.
    expect(C.systemPromptFor([user('What is eCash?')], { base: en['system.prompt'] })).toBe(en['system.prompt']);
  });

  it('aboutEcash reads only the person\'s words', async () => {
    const { C, user, bot } = await load();
    expect(C.aboutEcash([])).toBe(false);
    expect(C.aboutEcash(undefined)).toBe(false);
    expect(C.aboutEcash([bot('Your balance is low.')])).toBe(false);
    expect(C.aboutEcash([user('ecashcard')])).toBe(false);
    expect(C.aboutEcash([user('Mints?')])).toBe(true);
    expect(C.aboutEcash([user('Bitcoin!'), bot('Yes.')])).toBe(true);
  });
});

describe('the system prompt of a spoken question', () => {
  it('adds the voice instruction to a voice question only', async () => {
    const C: any = await import('../../../public/v2/core/conversation.js' as string);
    const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
    const opts = { base: en['system.prompt'], voice: en['system.prompt.voice'] };
    const spoken = [{ role: 'user', content: 'Will it rain?', meta: { voice: true } }];
    const api = C.apiMessages(spoken, { systemPrompt: C.systemPromptFor(spoken, opts) });
    expect(api[0].role).toBe('system');
    expect(api[0].content).toContain(en['system.prompt']);
    expect(api[0].content).toContain('will hear your answer read aloud');
    expect(api[0].content).toContain('under 60 words');
    expect(en['system.prompt.voice']).not.toMatch(/[–—]/);
    // A typed follow-up: the usual prompt alone.
    const typed = [...spoken, { role: 'assistant', content: 'Yes, after noon.' }, { role: 'user', content: 'How much?' }];
    const api2 = C.apiMessages(typed, { systemPrompt: C.systemPromptFor(typed, opts) });
    expect(api2[0].content).toBe(en['system.prompt']);
    expect(api2[0].content).not.toContain('read aloud');
    // The longer prompt is counted in the request size the hold is worked out from.
    expect(C.tokensOf(spoken, { systemPrompt: C.systemPromptFor(spoken, opts) })).toBeGreaterThan(C.tokensOf(spoken, { systemPrompt: en['system.prompt'] }));
  });
});

// No sound on the web before the natural voice is downloaded (owner, 2026-11-17). While the natural voice
// is not on the phone, the phone's own voice reads at once. Two things kept it silent: iPhone Safari drops
// an utterance started outside a tap with no event at all, so the reading never started and never ended;
// and the phone's voices are listed a moment after the page opens, so a read asked for in that moment
// found no voice, asked about the download instead, or did nothing.
describe("the phone's own voice in the browser (core/adapters.js synth)", () => {
  const synth = ADAPTERS.adapters.synth;

  /** A speechSynthesis stand-in. mode: 'speak' (start, then end), 'drop' (iPhone Safari outside a tap: nothing at all), 'refuse' (Chrome with no tap yet). */
  function fakeSynth({ voices = [] as any[], mode = 'speak' } = {}) {
    const listeners = new Set<() => void>();
    const spoken: any[] = [];
    const s: any = {
      list: voices,
      speaking: false,
      pending: false,
      getVoices: () => s.list,
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
      speak(u: any) {
        spoken.push(u);
        if (mode === 'drop') return;
        if (mode === 'refuse') return setTimeout(() => u.onerror?.({ error: 'not-allowed' }), 0);
        setTimeout(() => u.onstart?.(), 0);
        setTimeout(() => u.onend?.(), 5);
      },
      cancel() {},
      list_later(v: any[]) {
        s.list = v;
        for (const f of listeners) f();
      },
    };
    (globalThis as any).speechSynthesis = s;
    (globalThis as any).SpeechSynthesisUtterance = class {
      text: string;
      volume = 1;
      voice: unknown = null;
      lang = '';
      onstart: any;
      onend: any;
      onerror: any;
      constructor(text: string) {
        this.text = text;
      }
    };
    return { s, spoken, listeners };
  }
  const voice = (name: string, lang = 'en-US', extra = {}) => ({ name, lang, localService: true, default: false, ...extra });

  it('lists only voices on the phone for the language, the default first', () => {
    fakeSynth({ voices: [voice('Albert'), { ...voice('Google US English'), localService: false }, voice('Samantha', 'en-US', { default: true }), voice('Thomas', 'fr-FR')] });
    expect(synth.voices('en').map((v: any) => v.name)).toEqual(['Samantha', 'Albert']);
  });

  it('ready() waits for voices listed late, and gives up after its time with none', async () => {
    const f = fakeSynth();
    const late = synth.ready(1000);
    setTimeout(() => f.s.list_later([voice('Samantha')]), 20);
    expect(await late).toBe(true);
    expect(f.listeners.size).toBe(0);
    fakeSynth();
    expect(await synth.ready(30)).toBe(false);
  });

  it('reads and ends; an utterance the phone dropped is AudioBlocked, not a silence for ever', async () => {
    fakeSynth({ voices: [voice('Samantha')] });
    await expect(synth.speak('Hello.', 'en', { startMs: 50 }).done).resolves.toBeUndefined();
    fakeSynth({ voices: [voice('Samantha')], mode: 'drop' });
    await expect(synth.speak('Hello.', 'en', { startMs: 50 }).done).rejects.toMatchObject({ name: 'AudioBlocked' });
    fakeSynth({ voices: [voice('Samantha')], mode: 'refuse' });
    await expect(synth.speak('Hello.', 'en', { startMs: 50 }).done).rejects.toMatchObject({ name: 'AudioBlocked' });
  });

  it('one still waiting its turn is not taken for dropped', async () => {
    const f = fakeSynth({ voices: [voice('Samantha')], mode: 'drop' });
    f.s.pending = true;
    const r = synth.speak('Hello.', 'en', { startMs: 20 });
    const settled = await Promise.race([r.done.then(() => 'settled', () => 'settled'), new Promise((res) => setTimeout(() => res('waiting'), 80))]);
    expect(settled).toBe('waiting');
    r.stop();
  });

  it('unlock() speaks one silent utterance, once a page', () => {
    const f = fakeSynth({ voices: [voice('Samantha')] });
    synth.unlock();
    synth.unlock();
    expect(f.spoken.map((u) => [u.text, u.volume])).toEqual([[' ', 0]]);
  });
});

describe('reading an answer with the phone voice while the natural voice is not here', () => {
  function setup({ phoneAfterWait = true, out = 'phonon' as 'phonon' | null, off = false } = {}) {
    const S: any = {};
    const store = { S, set: (p: object) => Object.assign(S, p) };
    const asked: number[] = [];
    const spoken: string[] = [];
    const toasts: string[] = [];
    let listed = false;
    const phone = { id: 'device', pieceSize: () => 300, speak: (p: string[]) => (spoken.push(`phone:${p.join(' ')}`), { done: Promise.resolve({ chargedMsub: 0 }), stop() {} }) };
    const natural = { id: 'phonon', pieceSize: () => 1500, download: async () => ({ needed: true, bytes: 65e6 }), speak: (p: string[]) => (spoken.push(`natural:${p.join(' ')}`), { done: Promise.resolve({ chargedMsub: 0 }), stop() {} }) };
    const ctl = CTL.createTalk({
      store,
      t: (k: string) => k,
      ui: { toast: (x: string) => toasts.push(x) },
      nav() {},
      haptics: { pulse() {} },
      voiceIn: () => null,
      // With no natural voice to offer (out null), the phone's own voice is the one picked once listed.
      voiceOut: () => (out === 'phonon' ? natural : listed ? phone : null),
      blocker: () => null,
      ask: async () => {},
      refresh() {},
      errorText: () => 'error',
      askDownload: async (bytes: number) => (asked.push(bytes), false),
      phoneVoice: () => (listed ? phone : null),
      voicesReady: async () => {
        await new Promise((r) => setTimeout(r, 5));
        listed = phoneAfterWait;
        return listed;
      },
      readAloudOff: () => off,
    });
    return { S, ctl, asked, spoken, toasts };
  }
  const msg = { id: 'a1', content: 'An answer.' };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('waits for voices listed late and reads with them, offering the natural voice after', async () => {
    const x = setup();
    x.ctl.speak(msg, { auto: true });
    await settle();
    expect(x.spoken).toEqual(['phone:An answer.']);
    expect(x.asked).toEqual([]);
    expect(x.S.voiceOffer).toEqual({ bytes: 65e6 });
  });

  it('with no voice of its own at all, asks about the download as before', async () => {
    const x = setup({ phoneAfterWait: false });
    x.ctl.speak(msg);
    await settle();
    expect(x.asked).toEqual([65e6]);
    expect(x.spoken).toEqual([]);
  });

  it('with no voice to read with at all, a spoken answer says so; Off stays quiet', async () => {
    const late = setup({ out: null });
    late.ctl.speak(msg, { auto: true });
    await settle();
    expect(late.spoken).toEqual(['phone:An answer.']);
    expect(late.toasts).toEqual([]);
    const none = setup({ out: null, phoneAfterWait: false });
    none.ctl.speak(msg, { auto: true });
    await settle();
    expect(none.toasts).toEqual(['speak.noVoice']);
    const off = setup({ out: null, phoneAfterWait: false, off: true });
    off.ctl.speak(msg, { auto: true });
    await settle();
    expect(off.toasts).toEqual([]);
  });

  it('says the sound is blocked when the phone dropped the reading', async () => {
    const x = setup();
    const blocked = { id: 'device', pieceSize: () => 300, speak: () => ({ done: Promise.reject(Object.assign(new Error('off'), { name: 'AudioBlocked' })), stop() {} }) };
    const S: any = {};
    const toasts: string[] = [];
    const ctl = CTL.createTalk({ store: { S, set: (p: object) => Object.assign(S, p) }, t: (k: string) => k, ui: { toast: (t: string) => toasts.push(t) }, nav() {}, haptics: { pulse() {} }, voiceIn: () => null, voiceOut: () => blocked, blocker: () => null, ask: async () => {}, refresh() {}, errorText: () => 'error' });
    ctl.speak(msg, { auto: true });
    await settle();
    expect(toasts).toEqual(['speak.blocked']);
    expect(x.toasts).toEqual([]);
  });
});

/**
 * The iPhone app's ForgeSpeech as SpeechPlugin.swift answers, through the real bridge code
 * (core/native.js createNative): Capacitor says 'ios' and lists the plugin; available() says whether
 * Apple's recogniser hears the language on the phone; start() asks the two permissions, then events
 * {id, type} come on "speech": started, level, partial; stop() ends with final (or, for a silent hold,
 * error no-speech), then end.
 */
function iosSpeech({ onDevice = true, refuse = false, silent = false, plugin = true } = {}) {
  const calls: string[] = [];
  const listeners: Array<(ev: any) => void> = [];
  const emit = (ev: any) => listeners.forEach((fn) => fn(ev));
  const Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: { ForgeBars: {}, ForgeNfc: {}, ...(plugin ? { ForgeSpeech: {} } : {}) },
    nativePromise: async (p: string, method: string, opts: any) => {
      calls.push(`${p}.${method}`);
      if (p !== 'ForgeSpeech') return undefined;
      if (method === 'available') return onDevice ? { onDevice: true, reason: null, locale: 'en-US' } : { onDevice: false, reason: 'language-not-on-device', locale: 'en-US' };
      if (method === 'start') {
        if (refuse) throw Object.assign(new Error('Speech recognition is not allowed.'), { code: 'permission' });
        emit({ id: opts.id, type: 'started' });
        emit({ id: opts.id, type: 'level', level: 0.3 });
        if (!silent) emit({ id: opts.id, type: 'partial', text: 'Where is' });
        return {};
      }
      if (method === 'stop') {
        if (silent) emit({ id: opts.id, type: 'error', code: 'no-speech' });
        else emit({ id: opts.id, type: 'final', text: 'Where is the market?' });
        emit({ id: opts.id, type: 'end' });
      }
      if (method === 'cancel') emit({ id: opts.id, type: 'end' });
      return {};
    },
    addListener: (p: string, event: string, fn: (ev: any) => void) => {
      if (p === 'ForgeSpeech' && event === 'speech') listeners.push(fn);
      return { remove: async () => {} };
    },
  };
  const native = N.createNative({ Capacitor });
  return { native, calls };
}

describe("voice in on this phone in the iPhone app (Apple's recogniser, on the phone only)", () => {
  const engine = { id: 'engine', available: () => true, private: () => true };
  const device = { id: 'device', available: () => true, private: () => false };

  it('is offered and picked first where Apple hears the language on the phone, also with Private only on', async () => {
    const { native, calls } = iosSpeech();
    expect(native.platform).toBe('ios');
    const phone = VIN_PHONE.create(R.inputsFor('voice-in', { t: () => '', speech: native.speech }));
    await phone.checked;
    expect(phone.available()).toBe(true);
    expect(phone.private()).toBe(true);
    expect(phone.price(30)).toBe(0);
    expect(STATE.pickVoiceIn({ phone, engine, device }, { ...STATE.DEFAULT_SETTINGS })?.id).toBe('phone');
    expect(STATE.pickVoiceIn({ phone, engine, device }, { privateOnly: true, voiceIn: 'auto' })?.id).toBe('phone');
    expect(STATE.pickVoiceIn({ phone, engine, device }, { privateOnly: false, voiceIn: 'phone' })?.id).toBe('phone');
    expect(calls).toEqual(['ForgeSpeech.available']);
  });

  it('shows the words as they come, sends the final words, and asks the engine nothing', async () => {
    const { native, calls } = iosSpeech();
    const phone = VIN_PHONE.create({ speech: native.speech });
    await phone.checked;
    const heard: string[] = [];
    const levels: number[] = [];
    const s = await phone.start({ onText: (x: string) => heard.push(x), onLevel: (l: number) => levels.push(l) });
    expect(heard).toEqual(['Where is']);
    expect(levels).toEqual([0.3]);
    expect(await s.finish()).toEqual({ text: 'Where is the market?', chargedMsub: 0, balanceMsub: null });
    expect(calls).toEqual(['ForgeSpeech.available', 'ForgeSpeech.start', 'ForgeSpeech.stop']);
  });

  it('a silent hold is an empty question, so the app says nothing was heard and sends nothing', async () => {
    const { native } = iosSpeech({ silent: true });
    const phone = VIN_PHONE.create({ speech: native.speech });
    await phone.checked;
    expect(await (await phone.start()).finish()).toEqual({ text: '', chargedMsub: 0, balanceMsub: null, noSpeech: true });
    expect(EN['talk.empty']).toBe('Nothing was heard. Hold the button and speak.');
  });

  it('a refused permission reads as the microphone adapter says it, as on Android', async () => {
    const { native } = iosSpeech({ refuse: true });
    const phone = VIN_PHONE.create({ speech: native.speech });
    await phone.checked;
    await expect(phone.start()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(phone.available()).toBe(true);
  });

  it('where Apple hears the language only on its servers, or in an app without the plugin, the engine hears it', async () => {
    const off = iosSpeech({ onDevice: false });
    const a = VIN_PHONE.create({ speech: off.native.speech });
    await a.checked;
    expect(a.available()).toBe(false);
    expect(a.status().reason).toBe('language-not-on-device');
    expect(STATE.pickVoiceIn({ phone: a, engine }, { ...STATE.DEFAULT_SETTINGS })?.id).toBe('engine');
    const old = iosSpeech({ plugin: false });
    expect(old.native.speech).toBeNull();
    const b = VIN_PHONE.create(R.inputsFor('voice-in', { t: () => '', speech: old.native.speech }));
    await b.checked;
    expect(b.available()).toBe(false);
    expect(old.calls).toEqual([]);
  });
});
