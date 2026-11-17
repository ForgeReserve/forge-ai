import type { BrowserContext } from 'playwright-core';

/**
 * The phone's own voice (speechSynthesis), faked so a test decides whether the phone has one: `has`
 * gives it one English voice on the phone. Each utterance "speaks" for 250 ms and is kept in
 * window.__spoken, in order; the silent one the app speaks inside a tap to unlock the voice (a blank
 * text) is counted in window.__unlocks instead.
 *
 * Two ways a real browser keeps that voice quiet, on request:
 * - late: the voice is listed only 400 ms after the page first asks for the list (getVoices) once the
 *   test called window.__voicesLate(), with a voiceschanged event, as Chrome and iPhone Safari list them
 *   a moment after the page opens.
 * - tapOnly: as iPhone Safari (WebKit SpeechSynthesis::speak), an utterance started outside a tap is
 *   dropped with no event at all, until the page has spoken once inside a tap. Dropped ones are counted
 *   in window.__dropped.
 */
export async function fakePhoneVoice(ctx: BrowserContext, has: boolean, { late = false, tapOnly = false } = {}) {
  await ctx.addInitScript(
    ({ has, late, tapOnly }) => {
      const w = window as any;
      w.__spoken = [];
      w.__unlocks = 0;
      w.__dropped = 0;
      class Utterance {
        text: string;
        lang = '';
        volume = 1;
        voice: unknown = null;
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      }
      const VOICE = { name: 'Phone voice', lang: 'en-US', localService: true, default: true };
      // Late: nothing is listed until 400 ms after the first ask once armed.
      let listed = has && !late;
      let armed = false;
      let asked = false;
      const changed = new Set<() => void>();
      w.__voicesLate = () => {
        armed = true;
      };
      // A tap is the handling of a trusted pointerup, click, key or touchend (and what it queues at once).
      let inTap = false;
      let unlocked = !tapOnly;
      for (const type of ['pointerup', 'pointerdown', 'click', 'keydown', 'keyup', 'touchend', 'mouseup']) {
        addEventListener(
          type,
          (e) => {
            if (!e.isTrusted) return;
            inTap = true;
            setTimeout(() => (inTap = false), 0);
          },
          true,
        );
      }
      let queue: Utterance[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const synth: any = {
        speaking: false,
        pending: false,
        getVoices: () => {
          if (has && late && armed && !asked) {
            asked = true;
            setTimeout(() => {
              listed = true;
              for (const f of changed) f();
            }, 400);
          }
          return listed ? [VOICE] : [];
        },
        addEventListener: (type: string, f: () => void) => type === 'voiceschanged' && changed.add(f),
        removeEventListener: (type: string, f: () => void) => changed.delete(f),
        speak: (u: Utterance) => {
          if (inTap) unlocked = true;
          else if (!unlocked) {
            w.__dropped++;
            return;
          }
          queue.push(u);
          next();
        },
        cancel: () => {
          if (timer) clearTimeout(timer);
          timer = null;
          synth.speaking = false;
          for (const u of queue) u.onend?.();
          queue = [];
        },
      };
      const next = () => {
        if (timer) return;
        const u = queue.shift();
        synth.pending = queue.length > 0;
        if (!u) return void (synth.speaking = false);
        if (u.text.trim()) w.__spoken.push(u.text);
        else w.__unlocks++;
        synth.speaking = true;
        u.onstart?.();
        timer = setTimeout(() => {
          timer = null;
          u.onend?.();
          next();
        }, 250);
      };
      w.SpeechSynthesisUtterance = Utterance;
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    },
    { has, late, tapOnly },
  );
}
