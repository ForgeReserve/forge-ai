import { describe, expect, it } from 'vitest';

// Pure v2 logic: ring maths, prices, routes, model rules, the conversation view and error wording.
const RINGS: any = await import('../../../public/v2/core/rings.js' as string);
const PRICE: any = await import('../../../public/v2/core/price.js' as string);
const ROUTER: any = await import('../../../public/v2/core/router.js' as string);
const STATE: any = await import('../../../public/v2/core/state.js' as string);
const CONV: any = await import('../../../public/v2/core/conversation.js' as string);
const ERR: any = await import('../../../public/v2/core/errors.js' as string);

describe('ring maths', () => {
  it('matches the canvas home: funds 85% and memory 70%', () => {
    expect(RINGS.dash(0.85, 150).dasharray).toBe('801 942');
    expect(RINGS.dash(0.7, 121).dasharray).toBe('532 760');
    expect(RINGS.dash(0.2, 150).dasharray).toBe('188 942');
    expect(RINGS.dash(0.1, 121).dasharray).toBe('76 760');
  });

  it('clamps fractions and treats nonsense as empty', () => {
    expect(RINGS.dash(1.7, 10).length).toBeCloseTo(2 * Math.PI * 10);
    expect(RINGS.dash(-1, 10).length).toBe(0);
    expect(RINGS.dash(NaN, 10).length).toBe(0);
  });

  it('fills the gold ring against the balance after money last came in', () => {
    let peak = RINGS.nextPeak(null, 500_000);
    expect(peak).toBe(500_000);
    expect(RINGS.fundsFraction(500_000, peak)).toBe(1);
    peak = RINGS.nextPeak(peak, 400_000); // a question was paid
    expect(peak).toBe(500_000);
    expect(RINGS.fundsFraction(400_000, peak)).toBeCloseTo(0.8);
    peak = RINGS.nextPeak(peak, 900_000); // funds were added
    expect(RINGS.fundsFraction(900_000, peak)).toBe(1);
    expect(RINGS.fundsFraction(0, peak)).toBe(0);
    expect(RINGS.fundsFraction(null, peak)).toBe(0);
    expect(RINGS.fundsFraction(5, null)).toBe(1);
    expect(RINGS.nextPeak(7, null)).toBe(7);
  });

  it('shows memory as the free share of the context, low below a fifth', () => {
    expect(RINGS.memory(0, 1000)).toMatchObject({ free: 1, percentFree: 100, low: false });
    expect(RINGS.memory(300, 1000)).toMatchObject({ percentFree: 70, low: false });
    expect(RINGS.memory(900, 1000)).toMatchObject({ percentFree: 10, low: true });
    expect(RINGS.memory(5000, 1000)).toMatchObject({ free: 0, low: true });
    expect(RINGS.memory(0, undefined).free).toBe(1);
    expect(RINGS.memory(RINGS.DEFAULT_CONTEXT / 2, null).percentFree).toBe(50);
  });

  it('counts how many typical questions a balance pays for', () => {
    expect(RINGS.questionsLeft(999_000, 1_000)).toBe(999);
    expect(RINGS.questionsLeft(0, 1_000)).toBe(0);
    expect(RINGS.questionsLeft(1_000, 0)).toBe(0);
  });
});

describe('prices before sending', () => {
  const model = { pricing: { usd_per_mtok: { input: 0.19, output: 0.75 }, sat_per_mtok: { input: 190, output: 750 } } };

  it('converts the listed price per million tokens to msub per token', () => {
    expect(PRICE.perToken(model, 'usd')).toEqual({ in: 0.019, out: 0.075 });
    expect(PRICE.perToken(model, 'sat')).toEqual({ in: 0.19, out: 0.75 });
    expect(PRICE.perToken({ pricing: { usd_per_mtok: { input: 1, output: 1 }, sat_per_mtok: null } }, 'sat')).toBeNull();
    expect(PRICE.perToken({}, 'usd')).toBeNull();
  });

  it('estimates the most a question can cost and a likely cost', () => {
    const e = PRICE.estimate(model, 'usd', 1000, 4096);
    expect(e.max).toBe(Math.ceil(1000 * 0.019 + 4096 * 0.075));
    expect(e.likely).toBeLessThan(e.max);
    expect(PRICE.perQuestion(model, 'usd')).toBe(Math.ceil(1000 * 0.019 + 400 * 0.075));
  });

  it('reads Under $0.01 below a cent and Up to the most otherwise', () => {
    expect(PRICE.priceLine(999, 'usd')).toEqual({ key: 'price.under', amount: '$0.01' });
    expect(PRICE.priceLine(1000, 'usd')).toEqual({ key: 'price.upTo', amount: '$0.01' });
    expect(PRICE.priceLine(26_700, 'usd')).toEqual({ key: 'price.upTo', amount: '$0.27' });
    expect(PRICE.priceLine(500, 'sat')).toEqual({ key: 'price.under', amount: '1 sat' });
    expect(PRICE.priceLine(1_234_001, 'sat')).toEqual({ key: 'price.upTo', amount: '1,235 sat' });
    expect(PRICE.priceLine(null, 'usd').key).toBe('price.unknown');
  });
});

describe('routes', () => {
  it('parses and formats every route', () => {
    for (const name of Object.keys(ROUTER.ROUTES)) {
      const params = name === 'fund' ? { id: 'ecash' } : name === 'takeOutUnit' ? { unit: 'sat' } : {};
      expect(ROUTER.parse(ROUTER.href(name, params)), name).toEqual({ name, params });
    }
    expect(ROUTER.parse('')).toEqual({ name: 'home', params: {} });
    expect(ROUTER.parse('#/funds/')).toEqual({ name: 'funds', params: {} });
  });

  it('sends unknown or malformed routes home', () => {
    expect(ROUTER.parse('#/nowhere').name).toBe('home');
    expect(ROUTER.parse('#/funds/add/<script>').name).toBe('home');
    expect(ROUTER.parse('#/funds/add/a/b').name).toBe('home');
  });

  it('knows where Back goes without history', () => {
    expect(ROUTER.parentOf('fund')).toBe('addFunds');
    expect(ROUTER.parentOf('addFunds')).toBe('funds');
    expect(ROUTER.parentOf('model')).toBe('more');
    expect(ROUTER.parentOf('answer')).toBe('home');
  });
});

describe('models and Private only', () => {
  const models = [
    { id: 'tinfoil/a', tier: 'enclave', encrypted_passthrough: true },
    { id: 'plain-enclave', tier: 'enclave', encrypted_passthrough: false },
    { id: 'std', tier: 'standard' },
    { id: 'unc', tier: 'standard', uncensored: true },
  ];

  it('counts a model as private only when the request is encrypted to an enclave', () => {
    expect(STATE.isPrivate(models[0])).toBe(true);
    expect(STATE.isPrivate(models[1])).toBe(false);
    expect(STATE.isPrivate(models[2])).toBe(false);
    expect(STATE.isPrivate(null)).toBe(false);
  });

  it('is on by default and hides models that are not private', () => {
    expect(STATE.DEFAULT_SETTINGS.privateOnly).toBe(true);
    expect(STATE.visibleModels(models, { privateOnly: true }).map((m: any) => m.id)).toEqual(['tinfoil/a']);
    expect(STATE.visibleModels(models, { privateOnly: false }).map((m: any) => m.id)).toEqual(['tinfoil/a', 'plain-enclave', 'std']);
    expect(STATE.hiddenCount(models, { privateOnly: true })).toBe(2);
    expect(STATE.pickModel(models, { privateOnly: true, model: 'std' }).id).toBe('tinfoil/a');
    expect(STATE.pickModel(models, { privateOnly: false, model: 'std' }).id).toBe('std');
    expect(STATE.pickModel([], { privateOnly: true })).toBeNull();
  });

  it('shares the v1 balance key on the same origin', () => {
    expect(STATE.KEY_STORE).toBe('forge.balanceKey');
    expect(STATE.keyName('', 'https://ai.forge-reserve.com')).toBe('forge.balanceKey');
    expect(STATE.keyName('https://ai.forge-reserve.com', 'https://ai.forge-reserve.com')).toBe('forge.balanceKey');
    expect(STATE.keyName('https://bellows.example', 'https://ai.forge-reserve.com')).toBe('forge.balanceKey@https://bellows.example');
  });
});

describe('conversation view', () => {
  it('is empty and fully free before the first question', () => {
    const m = CONV.memoryView([], [], { contextLength: 1000 });
    expect(m).toMatchObject({ percentFree: 100, tokens: 0, held: [] });
    expect(CONV.lastExchange([])).toBeNull();
  });

  it('counts the conversation and attachments, and lists what is held', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b'.repeat(400), meta: {} },
    ];
    const pending = [{ id: 'd1', kind: 'text', name: 'notes.txt', status: 'ready', text: 'c'.repeat(800) }];
    const m = CONV.memoryView(messages, pending, { contextLength: 1000 });
    expect(m.tokens).toBeGreaterThan(400);
    expect(m.free).toBeLessThan(0.6);
    expect(m.held.map((h: any) => h.kind)).toEqual(['file', 'conversation']);
    expect(m.held[0].share).toBeCloseTo(0.2);
  });

  it('leaves out failed answers and shows the last question with its answer', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one', meta: {} },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: '', meta: { error: { code: 'upstream_error' } } },
    ];
    expect(CONV.lastExchange(messages)).toMatchObject({ question: 'second', answer: { meta: { error: { code: 'upstream_error' } } } });
    const api = CONV.apiMessages(messages, { systemPrompt: 'sys' });
    expect(api.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('sends photos only to models that read them, and file text as v1 does', () => {
    const pending = [
      { id: 'i', kind: 'image', name: 'p.jpg', status: 'ready', url: 'data:image/jpeg;base64,AAAA' },
      { id: 'f', kind: 'text', name: 'a.txt', status: 'ready', text: 'hello' },
      { id: 'r', kind: 'pdf', name: 'b.pdf', status: 'reading' },
    ];
    const withVision = CONV.pendingMessage('Q', pending, { vision: true });
    expect(withVision.images).toEqual(['data:image/jpeg;base64,AAAA']);
    expect(withVision.files.map((f: any) => f.name)).toEqual(['a.txt']);
    expect(CONV.pendingMessage('Q', pending, { vision: false }).images).toBeUndefined();
    const api = CONV.apiMessages([withVision], { vision: true });
    expect(api[0].content[0].text).toContain('<file name="a.txt">');
  });
});

describe('errors in plain words', () => {
  it.each([
    ['insufficient_balance', 'error.funds', 'addFunds'],
    ['payment_required', 'error.funds', 'addFunds'],
    ['invalid_key', 'error.key', 'addFunds'],
    ['offline', 'error.offline', 'retry'],
    ['rate_limited', 'error.busy', 'retry'],
    ['upstream_error', 'error.modelWhy', 'retry'],
    ['model_not_found', 'error.gone', 'chooseModel'],
    ['request_too_large', 'error.tooLarge', 'startFresh'],
    ['encryption_unavailable', 'error.encryption', 'retry'],
    ['account_frozen', 'error.frozen', 'takeOut'],
    ['audio_too_short', 'talk.empty', 'retry'],
    ['audio_too_long', 'talk.tooLong', 'retry'],
    ['unsupported_audio', 'talk.cannotUse', 'retry'],
    ['something_new', 'error.other', 'retry'],
  ])('%s has one next step', (code, key, next) => {
    expect(ERR.errorView(code, 'm')).toMatchObject({ key, next });
  });

  it("carries the engine's reason for a failed answer, short and on one line", () => {
    expect(ERR.errorView('upstream_error', '', 0)).toEqual({ key: 'error.model', next: 'retry' });
    expect(ERR.errorView('upstream_error', 'upstream returned HTTP 500: Cannot connect to host.\n. You were not charged.', 0)).toEqual({
      key: 'error.modelWhy',
      next: 'retry',
      message: 'upstream returned HTTP 500: Cannot connect to host',
    });
    expect(ERR.reasonOf(undefined)).toBe('');
    expect(ERR.reasonOf('x'.repeat(400))).toHaveLength(160);
    // A charged or unknown failure keeps its own words.
    expect(ERR.errorView('upstream_error', 'boom', 5).key).toBe('error.modelCharged');
    expect(ERR.errorView('upstream_error', 'boom', null).key).toBe('error.modelUnknown');
  });

  it('says "not charged" only when the engine charged nothing', async () => {
    const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
    const words = (code: string, forge: unknown, err: unknown) => {
      const ev = ERR.errorView(code, '', ERR.chargedFor(forge, err));
      return { key: ev.key, text: en[ev.key]!.replace('{amount}', ev.charged > 0 ? `${ev.charged} msub` : '') };
    };
    const streamErr = { code: 'upstream_error' }; // a StreamError: no HTTP status
    const httpErr = { code: 'upstream_error', status: 502 }; // refused before any answer
    // An error in the stream, then the engine's final event with a partial charge.
    expect(words('upstream_error', { charged_msub: 1234 }, streamErr)).toEqual({ key: 'error.modelCharged', text: 'Stopped early, cost 1234 msub. The model stopped before the answer was done.' });
    // An empty answer the engine charged for (a reasoning model spent its output on reasoning).
    expect(words('stream_failed', { charged_msub: 50 }, null).key).toBe('error.modelCharged');
    // The engine said it charged nothing.
    expect(words('upstream_error', { charged_msub: 0 }, streamErr)).toEqual({ key: 'error.model', text: 'No answer, not charged. The model did not answer, so you were not charged.' });
    // An HTTP upstream error before any stream: the engine charges nothing for that.
    expect(words('upstream_error', null, httpErr).key).toBe('error.model');
    // No final event (the encrypted path, or a cut connection): no claim either way.
    const unknown = words('upstream_error', null, streamErr);
    expect(unknown.key).toBe('error.modelUnknown');
    expect(unknown.text).not.toMatch(/not charged/);
    expect(words('stream_failed', null, null).key).toBe('error.modelUnknown');
    for (const k of ['error.modelCharged', 'error.modelUnknown']) expect(en[k]).not.toMatch(/not charged/);
  });
});

describe('the visible height above a keyboard', () => {
  it('follows the visual viewport, and leaves pinch zoom alone', async () => {
    const VP: any = await import('../../../public/v2/core/viewport.js' as string);
    expect(VP.viewportVars({ height: 532.4, offsetTop: 10.6, scale: 1 })).toEqual({ '--vv-h': '532px', '--vv-top': '11px' });
    expect(VP.viewportVars({ height: 500, offsetTop: -3, scale: 1 })['--vv-top']).toBe('0px');
    expect(VP.viewportVars({ height: 500, offsetTop: 0, scale: 2 })).toBeNull();
    expect(VP.viewportVars(undefined)).toBeNull();
  });
});

// Speed marks (owner, 2026-11-15): Choose a model in groups, the fast free models first and the slow ones
// under their own heading below Standard; and the one tap from a slow answer to a fast model.
describe('model groups and the fast model', () => {
  const free = { free: true };
  const M = [
    { id: 'p-fast', tier: 'enclave', encrypted_passthrough: true, speed: 'fast' },
    { id: 'p-none', tier: 'enclave', encrypted_passthrough: true },
    { id: 'kimi', tier: 'standard', speed: 'slow', pricing: free },
    { id: 'qwen', tier: 'standard', speed: 'slow', pricing: free },
    { id: 'glm', tier: 'standard', speed: 'fast', pricing: free },
    { id: 'glm-5.3-flash', tier: 'standard', speed: 'fast', pricing: free },
    { id: 'lightning', tier: 'standard', pricing: free },
    { id: 'paid-std', tier: 'standard', speed: 'fast' },
    { id: 'unc', tier: 'standard', speed: 'fast', pricing: free, uncensored: true },
  ];
  const ids = (gs: any[]) => gs.map((g) => [g.id, g.models.map((m: any) => m.id)]);
  it('puts fast free models first, then Private, Standard (fast first), then Slow', () => {
    expect(ids(STATE.modelGroups(M, { privateOnly: false }))).toEqual([
      ['fast', ['glm', 'glm-5.3-flash']],
      ['private', ['p-fast', 'p-none']],
      ['standard', ['paid-std', 'lightning']],
      ['slow', ['kimi', 'qwen']],
    ]);
    // Private only: the private group alone, nothing empty.
    expect(ids(STATE.modelGroups(M, { privateOnly: true }))).toEqual([['private', ['p-fast', 'p-none']]]);
  });
  it('picks GLM 5.3 Flash (free and fast), never the one in use, and a paid fast one only with money', () => {
    const s = { privateOnly: false };
    expect(STATE.fastPick(M, s, { current: M[2] }).id).toBe('glm-5.3-flash');
    expect(STATE.fastPick(M, s, { current: M[5] }).id).toBe('glm');
    // Private only at $0: no free fast model to switch to; with money, the fast private one.
    expect(STATE.fastPick(M, { privateOnly: true }, { current: M[1] })).toBeNull();
    expect(STATE.fastPick(M, { privateOnly: true }, { current: M[1], paid: true }).id).toBe('p-fast');
  });
});
