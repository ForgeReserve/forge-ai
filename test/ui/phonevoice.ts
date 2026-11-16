import type { BrowserContext } from 'playwright-core';

/**
 * The phone's own voice (speechSynthesis), faked so a test decides whether the phone has one: `has`
 * gives it one English voice on the phone. Each utterance "speaks" for 250 ms and is kept in
 * window.__spoken, in order.
 */
export async function fakePhoneVoice(ctx: BrowserContext, has: boolean) {
  await ctx.addInitScript((has) => {
    const w = window as any;
    w.__spoken = [];
    class Utterance {
      text: string;
      lang = '';
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    let queue: Utterance[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const next = () => {
      if (timer) return;
      const u = queue.shift();
      if (!u) return;
      w.__spoken.push(u.text);
      timer = setTimeout(() => {
        timer = null;
        u.onend?.();
        next();
      }, 250);
    };
    w.SpeechSynthesisUtterance = Utterance;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => (has ? [{ name: 'Phone voice', lang: 'en-US', localService: true }] : []),
        addEventListener: () => {},
        removeEventListener: () => {},
        speak: (u: Utterance) => {
          queue.push(u);
          next();
        },
        cancel: () => {
          if (timer) clearTimeout(timer);
          timer = null;
          for (const u of queue) u.onend?.();
          queue = [];
        },
      },
    });
  }, has);
}
