import { describe, expect, it } from 'vitest';

// The first run's rules (core/firstrun.js), the routes of its steps, the price line's Free wording, and
// what Ask again and Try again are priced on (core/conversation.js).
const FR: any = await import('../../../public/v2/core/firstrun.js' as string);
const ROUTER: any = await import('../../../public/v2/core/router.js' as string);
const PRICE: any = await import('../../../public/v2/core/price.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
const I18N: any = await import('../../../public/v2/core/i18n.js' as string);
const CONV: any = await import('../../../public/v2/core/conversation.js' as string);

describe('first run steps', () => {
  it('runs Welcome, How you pay, the limits, then Private only', () => {
    expect(FR.STEPS).toEqual(['welcome', 'pay', 'limits', 'private']);
    expect(FR.nextStep('welcome')).toBe('pay');
    expect(FR.nextStep('pay')).toBe('limits');
    expect(FR.nextStep('limits')).toBe('private');
    expect(FR.nextStep('private')).toBeNull(); // the last step leads home
    expect(FR.prevStep('welcome')).toBeNull();
    expect(FR.prevStep('private')).toBe('limits');
    expect(FR.STEPS.map(FR.stepNumber)).toEqual([1, 2, 3, 4]);
  });

  it('treats an unknown step as the first', () => {
    expect(FR.stepOf('nope')).toBe('welcome');
    expect(FR.stepOf(undefined)).toBe('welcome');
    expect(FR.stepNumber('nope')).toBe(1);
  });

  it('has one route per step, each going home when there is no history', () => {
    for (const step of FR.STEPS) {
      const name = FR.STEP_ROUTES[step];
      expect(ROUTER.parse(ROUTER.href(name)), step).toEqual({ name, params: {} });
      expect(FR.stepOfRoute(name)).toBe(step);
      expect(ROUTER.parentOf(name)).toBe('home');
    }
    expect(ROUTER.href('intro')).toBe('#/start');
    expect(ROUTER.href('introPrivate')).toBe('#/start/private');
    expect(FR.stepOfRoute('home')).toBeNull();
    expect(ROUTER.parse('#/start/elsewhere').name).toBe('home');
  });

  it('shows once, only on a plain open of the home', () => {
    expect(FR.shouldShow({ seen: false, route: 'home' })).toBe(true);
    expect(FR.shouldShow({ seen: true, route: 'home' })).toBe(false);
    // A photo shared in, or an address that names a screen, opens that screen.
    for (const route of ['photoShared', 'photoSent', 'funds', 'fund', 'answer', 'more', 'intro']) expect(FR.shouldShow({ seen: false, route }), route).toBe(false);
  });

  it('remembers it under a key that Erase everything clears with the rest of localStorage', () => {
    expect(FR.SEEN_KEY).toBe('forge2.firstRun');
    expect(FR.SEEN_VALUE).toBe('done');
  });
});

describe('How you pay', () => {
  it('shows only the ways a loaded fund module offers, in a fixed order', () => {
    expect(FR.payWays(['ecash', 'lightning', 'note', 'onchain', 'othermint']).map((w: any) => w.id)).toEqual(['note', 'lightning']);
    // Free questions and cards appear once their fund modules exist (later slices).
    expect(FR.payWays(['lightning', 'card', 'free', 'note']).map((w: any) => w.id)).toEqual(['note', 'free', 'card', 'lightning']);
    expect(FR.payWays([])).toEqual([]);
    expect(FR.payWays(['onchain'])).toEqual([]);
  });

  it('names every way and gives it an icon', () => {
    const ICONS: string[] = [];
    for (const w of FR.PAY_WAYS) {
      expect(en[w.key], w.id).toBeTruthy();
      expect(w.icon, w.id).toMatch(/^[a-z]+$/);
      ICONS.push(w.icon);
    }
    expect(new Set(ICONS).size).toBe(FR.PAY_WAYS.length);
  });
});

describe('price line', () => {
  it('reads Free when a free question pays, with what is left when known', () => {
    const p = PRICE.priceLine(5000, 'usd', { left: 2, total: 3 });
    expect(p.key).toBe('price.freeLeft');
    expect(I18N.t(p.key, p)).toBe('Free, 2 of 3 left');
    expect(I18N.t(PRICE.priceLine(5000, 'usd', true).key)).toBe('Free');
    expect(I18N.t(PRICE.priceLine(null, 'usd', { left: 0, total: 3 }).key, PRICE.priceLine(null, 'usd', { left: 0, total: 3 }))).toBe('Free, 0 of 3 left');
    // Counts that make no sense still say Free, never a wrong number.
    for (const bad of [{ left: 4, total: 3 }, { left: -1, total: 3 }, { left: 1, total: 0 }, { left: 1.5, total: 3 }, {}]) expect(PRICE.priceLine(10, 'usd', bad).key).toBe('price.free');
  });

  it('is the paid price when no free question is used', () => {
    for (const free of [null, undefined, false]) {
      const p = PRICE.priceLine(500, 'usd', free);
      expect(I18N.t(p.key, p)).toBe('Under $0.01');
    }
    const p = PRICE.priceLine(12_345, 'usd', null);
    expect(I18N.t(p.key, p)).toBe('Up to $0.13');
    expect(PRICE.priceLine(null, 'sat').key).toBe('price.unknown');
  });
});

describe('Ask again and Try again', () => {
  const u = (content: string, meta?: object) => ({ role: 'user', content, ...(meta ? { meta } : {}) });
  const a = (content: string, meta?: object) => ({ role: 'assistant', content, ...(meta ? { meta } : {}) });

  it('prices the conversation up to the last question, without the answers after it', () => {
    const q1 = u('one');
    const a1 = a('first answer');
    const q2 = u('two', { voice: true });
    expect(CONV.againHistory([q1, a1, q2, a('second answer')])).toEqual([q1, a1, q2]);
    // Several answers after the question (an answer, then a failed one) all go.
    expect(CONV.againHistory([q1, a('x'), a('', { error: { code: 'upstream_error' } })])).toEqual([q1]);
    // The last message is the question asked again, so its voice flag decides whether reading is priced.
    expect(CONV.againHistory([q1, a1, q2, a('y')]).at(-1).meta.voice).toBe(true);
  });

  it('leaves out failed replies earlier in the conversation, as the engine request does', () => {
    const q1 = u('one');
    const q2 = u('two');
    const failed = a('', { error: { code: 'stream_failed' } });
    expect(CONV.againHistory([q1, failed, q2, a('z')])).toEqual([q1, q2]);
    // Try again after a failure prices the same as the question did before it was sent.
    expect(CONV.againHistory([q1, failed])).toEqual([q1]);
  });

  it('is empty with no question to ask again', () => {
    expect(CONV.againHistory([])).toEqual([]);
    expect(CONV.againHistory([a('only an answer')])).toEqual([]);
  });
});

describe('first run copy', () => {
  it('claims no proof check, language picker or protection steps that this run does not build', () => {
    const intro = Object.entries(en)
      .filter(([k]) => k.startsWith('intro.'))
      .map(([, v]) => v)
      .join('\n');
    expect(intro).not.toMatch(/check the proof|English|Protect this phone|6 steps/i);
    // Network address and timing are hidden only through a relay or Tor; voice passes the engine.
    expect(en['intro.limits.addressSub']).toMatch(/Only Tor or a relay hides it/);
    expect(en['intro.limits.voiceSub']).toMatch(/could hear it/);
    expect(en['intro.private.voice']).toMatch(/could hear or read them/);
  });
});

describe('first run: one idea a step', () => {
  it('each step has a short heading and a short lead in short sentences, and Listen reads exactly those', () => {
    // Every step, and Private only once more for Off: its lead says what the switch is set to.
    expect(Object.keys(FR.SPOKEN)).toEqual([...FR.STEPS, 'private-off']);
    for (const [clip, keys] of Object.entries(FR.SPOKEN) as [string, string[]][]) {
      const [title, lead] = keys.map((k: string) => en[k]!) as [string, string];
      expect(title.length, clip).toBeLessThanOrEqual(40);
      expect(lead.length, clip).toBeLessThanOrEqual(80);
      // Short sentences: at most three, of at most eight words each, each ending in a full stop.
      const sentences = lead.split(/(?<=\.) /);
      expect(sentences.length, clip).toBeLessThanOrEqual(3);
      for (const x of sentences) {
        expect(x, clip).toMatch(/\.$/);
        expect(x.split(' ').length, x).toBeLessThanOrEqual(8);
      }
      expect(`${title} ${lead}`).not.toMatch(/—|–/);
    }
  });

  it('uses the approved words', () => {
    const words = (keys: string[]) => keys.map((k) => en[k]);
    expect(words(FR.SPOKEN.welcome)).toEqual(["AI that doesn't know who you are.", 'No account. No name. You pay like cash.']);
    expect(words(FR.SPOKEN.pay)).toEqual(['Pay a little, per question.', 'You see the price before you send.']);
    expect(words(FR.SPOKEN.limits)).toEqual(['Know what it hides.', 'Only the AI can read what you type. Your connection shows, unless you use Tor.']);
    expect(words(FR.SPOKEN.private)).toEqual(['Private by default.', 'Only private models. Forge cannot read what you type.']);
    expect(words(FR.SPOKEN['private-off'])).toEqual(['Private by default.', 'Standard models are shown too. They can read what you type.']);
  });

  it("reads Private only's lead as the switch is set", () => {
    expect(FR.spokenFor('private', true)).toEqual({ clip: 'private', keys: FR.SPOKEN.private });
    expect(FR.spokenFor('private', false)).toEqual({ clip: 'private-off', keys: FR.SPOKEN['private-off'] });
    // The switch is on Private only alone; the other steps read the same either way.
    expect(FR.spokenFor('pay', false)).toEqual({ clip: 'pay', keys: FR.SPOKEN.pay });
    expect(FR.spokenFor('nope').clip).toBe('welcome');
  });
});
