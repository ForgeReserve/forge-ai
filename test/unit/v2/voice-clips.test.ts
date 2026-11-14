import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The first run's Listen clips (F5): recorded once with Kokoro, voice Emma (scripts/record-voice), from
// the exact words Listen reads (core/firstrun.js SPOKEN). A copy edit to those words without recording
// again fails here, so stale audio cannot ship. The app checks the same thing at run time and falls back
// to the phone's own voice.
const PUBLIC = join(import.meta.dirname, '../../../public');
const DIR = join(PUBLIC, 'v2/voice/en');
const FR: any = await import('../../../public/v2/core/firstrun.js' as string);
const CLIPS: any = await import('../../../public/v2/core/clips.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const REGENERATE = '.tmp/voice/venv/bin/python scripts/record-voice/record.py';

const recorded = existsSync(join(DIR, 'manifest.json'));
if (!recorded) console.warn(`The first run's Listen clips are not recorded yet (no public/v2/voice/en/manifest.json): their checks are skipped and Listen uses the phone's own voice. Record them with: ${REGENERATE}`);

describe.skipIf(!recorded)('Listen clips match the first run words', () => {
  const manifest = recorded ? JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) : null;

  for (const step of FR.STEPS as string[]) {
    it(`${step}: recorded from the words the step shows now (else run ${REGENERATE})`, () => {
      const pieces = FR.SPOKEN[step].map((k: string) => en[k]);
      const c = manifest.clips[step];
      expect(c, `no clip for ${step}`).toBeTruthy();
      expect(c.text_sha256, `the words of ${step} changed since its clip was recorded`).toBe(sha(pieces.join('\n')));
      expect(c.text).toEqual(pieces);
      expect(CLIPS.clipFor(manifest, step, pieces)).toBe(c.file);
      const file = readFileSync(join(DIR, c.file));
      expect(file.length).toBe(c.bytes);
      expect(sha(file)).toBe(c.sha256);
    });
  }

  it('is the Emma voice, and the service worker keeps every clip for offline use', () => {
    expect(manifest.voice).toBe('bf_emma');
    const sw = readFileSync(join(PUBLIC, 'v2/sw.js'), 'utf8');
    const listed = JSON.parse(/const VOICE = (\[[^\]]*\]);/.exec(sw)![1]!.replace(/'/g, '"'));
    expect(new Set(listed)).toEqual(new Set(['/v2/voice/en/manifest.json', ...Object.values(manifest.clips).map((c: any) => `/v2/voice/en/${c.file}`)]));
  });
});

describe('Listen clips', () => {
  const manifest = { clips: { welcome: { file: 'welcome.ogg', text: ['Hello.', 'Two.'] } } };

  it('a clip plays only for exactly the words it was recorded from', () => {
    expect(CLIPS.clipFor(manifest, 'welcome', ['Hello.', 'Two.'])).toBe('welcome.ogg');
    expect(CLIPS.clipFor(manifest, 'welcome', ['Hello.', 'Two, changed.'])).toBeNull();
    expect(CLIPS.clipFor(manifest, 'pay', ['Hello.'])).toBeNull();
    expect(CLIPS.clipFor({ clips: { welcome: { file: '../x.ogg', text: ['Hello.', 'Two.'] } } }, 'welcome', ['Hello.', 'Two.'])).toBeNull();
    expect(CLIPS.clipFor(null, 'welcome', [])).toBeNull();
  });

  /** A player with a stand-in fetch and audio element. */
  function player({ playFails = false } = {}) {
    const audios: any[] = [];
    const fetched: string[] = [];
    const clips = CLIPS.createClips({
      base: 'https://forge.test/v2/voice/en/',
      fetch: async (url: string) => {
        fetched.push(url);
        if (url.endsWith('manifest.json')) return { ok: true, json: async () => manifest };
        return { ok: true, blob: async () => new Blob(['x']) };
      },
      makeAudio: (src: string) => {
        const handlers: Record<string, () => void> = {};
        const a = { src, paused: false, addEventListener: (k: string, f: () => void) => (handlers[k] = f), pause: () => (a.paused = true), play: async () => (playFails ? Promise.reject(new Error('NotSupportedError')) : undefined), fire: (k: string) => handlers[k]?.() };
        audios.push(a);
        return a;
      },
      objectUrl: { createObjectURL: () => 'blob:clip', revokeObjectURL: () => {} },
    });
    return { clips, audios, fetched };
  }

  it('plays the clip to its end, stops on Stop, and says when it cannot play', async () => {
    const p = player();
    expect(p.clips.has('welcome', ['Hello.', 'Two.'])).toBe(false); // manifest not read yet
    await p.clips.load();
    expect(p.clips.has('welcome', ['Hello.', 'Two.'])).toBe(true);
    const r = p.clips.play('welcome', ['Hello.', 'Two.']);
    await expect.poll(() => p.audios.length).toBe(1);
    expect(p.fetched.at(-1)).toBe('https://forge.test/v2/voice/en/welcome.ogg');
    p.audios[0].fire('ended');
    await r.done;

    const s = p.clips.play('welcome', ['Hello.', 'Two.']);
    await expect.poll(() => p.audios.length).toBe(2);
    s.stop();
    await s.done;
    expect(p.audios[1].paused).toBe(true);

    const bad = player({ playFails: true });
    await bad.clips.load();
    await expect(bad.clips.play('welcome', ['Hello.', 'Two.']).done).rejects.toThrow();
    expect(bad.clips.play('welcome', ['Other words.'])).toBeNull();
  });

  it("ships Kokoro's licence", () => {
    expect(readFileSync(join(PUBLIC, 'vendor/licenses/kokoro.txt'), 'utf8')).toMatch(/Apache License[\s\S]*Version 2\.0/);
  });
});
