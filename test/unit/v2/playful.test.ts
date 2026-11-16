import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inBundle } from '../../../scripts/lib/android-web.ts';
import { preloads } from '../../../scripts/lib/v2-preload.ts';

// Playful mode (docs/PLAYFUL.md): the mode setting, the star chip's words, what Pip says, the answer's
// first sentence, the colours' contrast, and the two vendored typefaces loaded only with Playful.
const ROOT = resolve(import.meta.dirname, '../../..');
const V2 = join(ROOT, 'public/v2');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const STATE: any = await import('../../../public/v2/core/state.js' as string);
const L: any = await import('../../../public/v2/modules/mode/playful/logic.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;

// A model at $1 in and $2 out per million tokens: a typical question (1000 in, 400 out) is 0.18 cents, 180 msub.
const paid = { id: 'p', pricing: { usd_per_mtok: { input: 1, output: 2 } } };
const free = { id: 'f', pricing: { free: true } };
const base = { model: paid, unit: 'usd', balanceMsub: null, freeLeft: 0, fundsBlock: null };

describe('the mode setting', () => {
  it('is Default unless another mode is chosen and its screens are in', () => {
    expect(STATE.DEFAULT_SETTINGS.mode).toBe('default');
    expect(STATE.loadedSettings(null).mode).toBe('default');
    expect(STATE.loadedSettings({ mode: 'playful' }).mode).toBe('playful');
    expect(STATE.pickMode(['default', 'playful'], { mode: 'playful' })).toBe('playful');
    // Chosen but not loaded (offline, not kept): Default draws.
    expect(STATE.pickMode(['default'], { mode: 'playful' })).toBe('default');
    expect(STATE.pickMode(['default', 'playful'], { mode: 'gone' })).toBe('default');
    expect(STATE.pickMode(['default'], {})).toBe('default');
  });
});

describe('the star chip', () => {
  it('says how much is left in words, from the balance at the model price, never a price', () => {
    expect(L.starLevel({ ...base, balanceMsub: 180 * 10 })).toBe('lots');
    expect(L.starLevel({ ...base, balanceMsub: 180 * 9 })).toBe('little');
    expect(L.starLevel({ ...base, balanceMsub: 100 })).toBe('little'); // under one typical question
    expect(L.starLevel({ ...base, balanceMsub: 0, fundsBlock: 'addFunds' })).toBe('none');
    expect(L.starLevel({ ...base, fundsBlock: 'addFunds' })).toBe('none');
    for (const k of ['lots', 'little', 'none', 'free', 'start', 'some']) expect(en[`playful.star.${k}`]).not.toMatch(/\$|sat|\d/);
  });

  it('counts free questions where they can be used, and says Free or Start free on a free model', () => {
    expect(L.starLevel({ ...base, freeLeft: 3 })).toBe('little');
    expect(L.starLevel({ ...base, freeLeft: 12 })).toBe('lots');
    expect(L.starLevel({ ...base, freeLeft: 12, fundsBlock: 'freeModel' })).toBe('none');
    expect(L.starLevel({ ...base, model: free, balanceMsub: 0 })).toBe('free');
    expect(L.starLevel({ ...base, model: free, fundsBlock: 'needKey' })).toBe('start');
    // A sat balance on a model with no sat price: how many is not known.
    expect(L.starLevel({ ...base, unit: 'sat', balanceMsub: 50_000 })).toBe('some');
  });
});

describe('what Pip says', () => {
  const v = { online: true, talk: { phase: 'idle' }, fundsBlock: null, noFunds: false, modelFree: false, memory: { low: false }, pendingCount: 0, startFree: true };
  it('on the home: the greeting, or the one thing in the way and where to go about it', () => {
    expect(L.homeMessage(v)).toEqual({ key: 'playful.hello', mood: 'idle' });
    expect(L.homeMessage({ ...v, talk: { phase: 'recording' } })).toEqual({ key: null, mood: 'listening' });
    expect(L.homeMessage({ ...v, online: false }).key).toBe('playful.offline');
    expect(L.homeMessage({ ...v, fundsBlock: 'needKey', noFunds: true, modelFree: true }).go).toBe('startFree');
    expect(L.homeMessage({ ...v, fundsBlock: 'needKey', startFree: false }).go).toBe('addFunds');
    expect(L.homeMessage({ ...v, noFunds: true, fundsBlock: 'addFunds' })).toMatchObject({ key: 'playful.noFunds', go: 'addFunds' });
    expect(L.homeMessage({ ...v, noFunds: true, fundsBlock: 'freeOut' })).toMatchObject({ key: 'playful.freeOut', go: 'freeOut' });
    // A free model with a balance key at $0 costs nothing: no block, as on the Default home.
    expect(L.homeMessage({ ...v, noFunds: true, modelFree: true }).key).toBe('playful.hello');
    expect(L.homeMessage({ ...v, memory: { low: true } })).toMatchObject({ key: 'playful.memoryLow', go: 'funds' });
    expect(L.homeMessage({ ...v, pendingCount: 2 })).toMatchObject({ key: 'home.attached', count: 2 });
  });

  it('on the answer: what Pip is doing, green only while the answer is read aloud', () => {
    const ex = { question: 'q', answer: { content: 'Hi.', meta: {} } };
    const a = { talk: { phase: 'idle' }, lastExchange: ex, streaming: false, speak: { current: false, state: 'idle' } };
    expect(L.answerLine(a)).toEqual({ key: 'playful.found', mood: 'idle' });
    expect(L.answerLine({ ...a, speak: { current: true, state: 'playing' } })).toEqual({ key: 'playful.reading', mood: 'reading', reading: true });
    expect(L.answerLine({ ...a, speak: { current: true, state: 'loading' } }).key).toBe('playful.gettingVoice');
    expect(L.answerLine({ ...a, speak: { current: false, state: 'playing' } }).key).toBe('playful.found');
    expect(L.answerLine({ ...a, streaming: true, lastExchange: { question: 'q', answer: { content: '' } } }).key).toBe('playful.thinking');
    expect(L.answerLine({ ...a, streaming: true }).key).toBe('playful.writing');
    expect(L.answerLine({ ...a, lastExchange: { question: 'q', answer: { content: '', meta: { error: { code: 'x' } } } } })).toEqual({ key: 'playful.oops', mood: 'oops' });
    expect(L.answerLine({ ...a, lastExchange: { question: 'q', answer: { content: 'a', meta: { stopped: true } } } }).key).toBe('playful.stopped');
    expect(L.answerLine({ ...a, talk: { phase: 'sending' } }).mood).toBe('listening');
    expect(L.answerLine({ ...a, talk: { phase: 'idle', error: { key: 'talk.empty' } } }).mood).toBe('oops');
    expect(L.answerLine({ ...a, lastExchange: null }).key).toBe('playful.none');
    for (const k of ['found', 'reading', 'gettingVoice', 'thinking', 'writing', 'oops', 'stopped', 'none', 'hearing', 'hello', 'offline', 'needKey', 'noFunds', 'freeOut', 'memoryLow']) expect(en[`playful.${k}`], k).toBeTruthy();
  });
});

describe("the answer's first sentence", () => {
  it('is split off as the big line, and lead + rest is the text', () => {
    const t = 'The sun lights up our sky in the day. At night, our side of the Earth turns away from the sun.';
    expect(L.splitLead(t)).toEqual({ lead: 'The sun lights up our sky in the day.', rest: ' At night, our side of the Earth turns away from the sun.' });
    for (const s of [t, 'One line', 'Is it? Yes.\n\nMore here.', '# Title\nText', '']) {
      const { lead, rest } = L.splitLead(s);
      expect(lead + rest).toBe(s);
    }
  });

  it('keeps abbreviations and numbers inside the sentence, and grows while it streams', () => {
    expect(L.splitLead('Use about 3.5 cups, e.g. of flour. Then stir.').lead).toBe('Use about 3.5 cups, e.g. of flour.');
    expect(L.splitLead('The sun lights up our').lead).toBe('The sun lights up our');
    expect(L.splitLead('Here is a short answer with code:\n\n```js\nx\n```').lead).toBe('Here is a short answer with code:');
  });

  it('has no lead for a Markdown block or a long first sentence', () => {
    for (const s of ['- one\n- two', '1. one', '> quote', '```js\nx\n```', '| a | b |', '## Head']) expect(L.splitLead(s).lead).toBe('');
    expect(L.splitLead(`${'word '.repeat(40)}end. Next.`).lead).toBe('');
  });
});

/** WCAG contrast of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe('colours and type', () => {
  const css = read('public/v2/modules/mode/playful/playful.css');
  const token = (name: string) => new RegExp(`--${name}: (#[0-9A-F]{6});`).exec(css)?.[1]!;

  it('keeps text at 4.5:1 or more: white on the purple, the green reading line and the soft ink on white, ink on the buttons', () => {
    const [ground, ink, ink2, read, lilac] = ['pf-ground', 'pf-ink', 'pf-ink-2', 'pf-read', 'pf-lilac'].map(token);
    expect(ground).toBe('#4B3FC9');
    expect(contrast('#FFFFFF', ground!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(read!, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink2!, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink2!, lilac!)).toBeGreaterThanOrEqual(4.5);
    for (const b of ['pf-yellow', 'pf-green', 'pf-coral', 'pf-lilac']) expect(contrast(ink!, token(b)!), b).toBeGreaterThanOrEqual(4.5);
    // The recording's route on the white bubble, the Standard one in red.
    expect(contrast('#A3392A', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });

  it('vendors Baloo 2 and Nunito from the exact-pinned fontsource packages, with their licence', () => {
    const pins = JSON.parse(read('package.json')).devDependencies as Record<string, string>;
    for (const [id, pkg] of [
      ['baloo-2', '@fontsource-variable/baloo-2'],
      ['nunito', '@fontsource-variable/nunito'],
    ] as const) {
      const v = JSON.parse(read(`public/v2/vendor/${id}/VERSION.json`));
      expect(pins[pkg]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(v.version).toBe(pins[pkg]);
      expect(v.license).toBe('OFL-1.1');
      expect(Object.keys(v.files).sort()).toEqual(readdirSync(join(V2, 'vendor', id)).filter((f) => f.endsWith('.woff2')).sort());
      for (const [f, sha] of Object.entries(v.files)) {
        expect(createHash('sha256').update(readFileSync(join(V2, 'vendor', id, f))).digest('hex'), f).toBe(sha);
        expect(css).toContain(`url("/v2/vendor/${id}/${f}") format("woff2")`);
        expect(inBundle(`v2/vendor/${id}/${f}`)).toBe(true);
      }
      expect(read(`public/vendor/licenses/${id}.txt`)).toMatch(/SIL Open Font License, Version 1\.1/);
      expect(inBundle(`vendor/licenses/${id}.txt`)).toBe(true);
    }
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('loads nothing of Playful with Default: not in the stylesheet, the worker shell or the first paint', async () => {
    expect(read('public/v2/style.css')).not.toMatch(/baloo|nunito|playful/i);
    expect(read('public/v2/sw.js')).not.toMatch(/baloo|nunito|playful/i);
    const html = read('public/v2/index.html');
    expect(html).not.toMatch(/rel="preload"[^>]*(baloo|nunito)/);
    // The mode's entry has no imports; its screens, styles and fonts come with ready().
    const { first, later } = await preloads();
    expect([...first, ...later].filter((p) => p.includes('/mode/playful/'))).toEqual(['/v2/modules/mode/playful/index.js']);
    expect(read('public/v2/modules/mode/playful/index.js')).not.toMatch(/^\s*import\s/m);
  });
});
