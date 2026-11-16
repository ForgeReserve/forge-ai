import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Slice A4: History, burn, auto-delete (with a fake clock) and Erase everything (against fake browser
// storage). The real browser paths are proven in test/ui/history.ui.test.ts.
const H: any = await import('../../../public/v2/core/history.js' as string);
const E: any = await import('../../../public/v2/core/erase.js' as string);
const ROUTER: any = await import('../../../public/v2/core/router.js' as string);
const R: any = await import('../../../public/v2/core/registry.js' as string);
const STATE: any = await import('../../../public/v2/core/state.js' as string);
const VOUT: any = await import('../../../public/v2/modules/voice-out/engine/index.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const conv = (id: string, at: number, msgs: any[] = [{ role: 'user', content: `Question ${id}` }]) => ({ id, createdAt: at - 1000, updatedAt: at, messages: msgs });

describe('auto-delete rules', () => {
  const now = 10 * DAY;
  const items = [
    { id: 'new', at: now - 5 * MIN },
    { id: 'hourOld', at: now - HOUR },
    { id: 'dayOld', at: now - DAY - 1 },
    { id: 'weekOld', at: now - 8 * DAY },
  ];

  it('lists the five choices in order, and is one day by default', () => {
    expect(H.AUTO_DELETE_IDS).toEqual(['off', 'close', 'hour', 'day', 'week']);
    expect(STATE.DEFAULT_SETTINGS.autoDelete).toBe('day');
    for (const id of H.AUTO_DELETE_IDS) expect(en[`auto.${id}`], id).toBeTruthy();
  });

  it('removes what was last used longer ago than the window', () => {
    expect(H.due(items, 'hour', now)).toEqual(['hourOld', 'dayOld', 'weekOld']);
    expect(H.due(items, 'day', now)).toEqual(['dayOld', 'weekOld']);
    expect(H.due(items, 'week', now)).toEqual(['weekOld']);
  });

  it('never removes anything when off, or for an unknown setting', () => {
    expect(H.due(items, 'off', now, { opening: true })).toEqual([]);
    expect(H.due(items, 'sometimes', now, { opening: true })).toEqual([]);
    expect(H.nextCheck(items, 'off', now)).toBeNull();
  });

  it('on close removes everything when the app opens, and nothing while it is open', () => {
    expect(H.due(items, 'close', now, { opening: true })).toEqual(['new', 'hourOld', 'dayOld', 'weekOld']);
    expect(H.due(items, 'close', now)).toEqual([]);
    expect(H.nextCheck(items, 'close', now)).toBeNull();
  });

  it('checks again exactly when the next one is due, and never later than one window away', () => {
    expect(H.nextCheck([{ id: 'a', at: now - 50 * MIN }], 'hour', now)).toBe(10 * MIN);
    expect(H.nextCheck([], 'hour', now)).toBe(HOUR);
    expect(H.nextCheck([{ id: 'a', at: now - 2 * HOUR }], 'hour', now)).toBe(0);
    expect(H.nextCheck([{ id: 'a', at: now }], 'week', now)).toBe(7 * DAY);
  });

  it('shows the time left with its urgency colour', () => {
    const c = conv('a', now - 1 * HOUR);
    expect(H.timeLeft(c, 'off', now)).toBeNull();
    expect(H.timeLeft(c, 'close', now)).toBeNull();
    expect(H.timeLeft(c, 'day', now)).toMatchObject({ ms: 23 * HOUR, urgency: 'plenty' });
    expect(H.timeLeft(conv('b', now - 14 * HOUR), 'day', now).urgency).toBe('half');
    expect(H.timeLeft(conv('c', now - 23 * HOUR), 'day', now).urgency).toBe('soon');
    expect(H.timeLeft(conv('d', now - 2 * DAY), 'day', now)).toMatchObject({ ms: 0, fraction: 0 });
    expect(H.leftText(23 * HOUR)).toEqual({ key: 'left.hour', n: 23 });
    expect(H.leftText(40 * MIN)).toEqual({ key: 'left.min', n: 40 });
    expect(H.leftText(20_000)).toEqual({ key: 'left.soon', n: 0 });
    expect(H.leftText(6 * DAY + HOUR)).toEqual({ key: 'left.day', n: 6 });
    expect(en['left.hour']!.replace('{n}', '23')).toBe('23h left');
  });

  it('says how long ago', () => {
    expect(H.agoText(10_000).key).toBe('ago.now');
    expect(H.agoText(5 * MIN)).toEqual({ key: 'ago.min', n: 5 });
    expect(H.agoText(3 * HOUR)).toEqual({ key: 'ago.hour', n: 3 });
    expect(H.agoText(DAY + HOUR)).toEqual({ key: 'ago.dayOne', n: 1 });
    expect(H.agoText(3 * DAY)).toEqual({ key: 'ago.day', n: 3 });
  });
});

describe('History list', () => {
  it('lists conversations newest first, with first words, the kind of question and the first answer', () => {
    const now = 5 * DAY;
    const convs = [
      conv('old', now - 3 * HOUR, [
        { role: 'user', content: 'What should I bring on Saturday?' },
        { role: 'assistant', content: 'Water, your ID and a paper map.' },
      ]),
      conv('photo', now - MIN, [{ role: 'user', content: '', images: ['data:image/jpeg;base64,AA'] }]),
      conv('file', now - 2 * MIN, [{ role: 'user', content: '', files: [{ name: 'letter.txt', text: 'x' }] }]),
      conv('voice', now - HOUR, [{ role: 'user', content: 'Is the square closed?', meta: { voice: true } }]),
      { id: 'empty', updatedAt: now, messages: [] },
    ];
    const list = H.listHistory(convs, 'day', now);
    expect(list.map((x: any) => x.id)).toEqual(['photo', 'file', 'voice', 'old']);
    expect(list.map((x: any) => x.kind)).toEqual(['image', 'file', 'voice', 'text']);
    expect(list[1].fileName).toBe('letter.txt');
    expect(list[3]).toMatchObject({ words: 'What should I bring on Saturday?', answer: 'Water, your ID and a paper map.', at: now - 3 * HOUR });
    expect(list[3].left.ms).toBe(21 * HOUR);
    expect(H.listHistory(convs, 'off', now)[0].left).toBeNull();
  });

  it('cuts long first words at a word', () => {
    const long = 'Does the notice I photographed this morning apply to the side streets as well as the main square, and what should I bring?';
    const w = H.firstWords(long);
    expect(w.length).toBeLessThanOrEqual(83);
    expect(w.endsWith('...')).toBe(true);
    expect(long.startsWith(w.slice(0, -3))).toBe(true);
    expect(H.firstWords('  two\n\nlines  ')).toBe('two lines');
  });
});

describe('auto-delete timing with a fake clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-02T09:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  /** A phone's conversations in memory, and a sweeper over them on the fake clock. */
  const phone = (setting: { v: string }, convs: Array<{ id: string; at: number }>) => {
    const store = new Map(convs.map((c) => [c.id, c]));
    const burnedLog: string[][] = [];
    const s = H.createSweeper({
      setting: () => setting.v,
      list: async () => [...store.values()],
      burn: async (ids: string[]) => {
        burnedLog.push(ids);
        for (const id of ids) store.delete(id);
      },
    });
    return { store, burnedLog, s };
  };

  it('1 hour: kept at 59 minutes, gone at 60, while the app stays open', async () => {
    const { store, s } = phone({ v: 'hour' }, [{ id: 'a', at: Date.now() }]);
    expect(await s.sweep({ opening: true })).toEqual([]);
    expect(s.waiting()).toBe(true);
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(store.has('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(store.has('a')).toBe(false);
  });

  it('1 day and 1 week remove each conversation at its own time', async () => {
    const t0 = Date.now();
    const { store, s } = phone({ v: 'day' }, [
      { id: 'old', at: t0 - 20 * HOUR },
      { id: 'new', at: t0 },
    ]);
    await s.sweep({ opening: true });
    await vi.advanceTimersByTimeAsync(4 * HOUR - 1);
    expect([...store.keys()]).toEqual(['old', 'new']);
    await vi.advanceTimersByTimeAsync(1);
    expect([...store.keys()]).toEqual(['new']);
    await vi.advanceTimersByTimeAsync(20 * HOUR);
    expect(store.size).toBe(0);

    const w = phone({ v: 'week' }, [{ id: 'x', at: Date.now() }]);
    await w.s.sweep();
    await vi.advanceTimersByTimeAsync(7 * DAY - MIN);
    expect(w.store.has('x')).toBe(true);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(w.store.has('x')).toBe(false);
  });

  it('on opening, removes what ran out while the app was closed', async () => {
    const { store, s } = phone({ v: 'hour' }, [
      { id: 'stale', at: Date.now() - 3 * HOUR },
      { id: 'fresh', at: Date.now() - 10 * MIN },
    ]);
    expect(await s.sweep({ opening: true })).toEqual(['stale']);
    expect([...store.keys()]).toEqual(['fresh']);
  });

  it('a conversation started after the last check is still removed on time', async () => {
    const { store, s } = phone({ v: 'hour' }, []);
    await s.sweep({ opening: true });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    store.set('late', { id: 'late', at: Date.now() });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(store.has('late')).toBe(false);
  });

  it('on close removes everything when the app opens, never by a timer', async () => {
    const { store, s, burnedLog } = phone({ v: 'close' }, [
      { id: 'a', at: Date.now() },
      { id: 'b', at: Date.now() - DAY },
    ]);
    expect(await s.sweep()).toEqual([]);
    expect(s.waiting()).toBe(false);
    expect(await s.sweep({ opening: true })).toEqual(['a', 'b']);
    expect(store.size).toBe(0);
    expect(burnedLog).toEqual([['a', 'b']]);
  });

  it('off keeps everything and sets no timer; turning it on applies at once', async () => {
    const setting = { v: 'off' };
    const { store, s } = phone(setting, [{ id: 'a', at: Date.now() - 2 * DAY }]);
    await s.sweep({ opening: true });
    expect(s.waiting()).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * DAY);
    expect(store.has('a')).toBe(true);
    setting.v = 'day';
    expect(await s.sweep()).toEqual(['a']);
  });

  it('stops for good when the app is erased', async () => {
    const { store, s } = phone({ v: 'hour' }, [{ id: 'a', at: Date.now() }]);
    await s.sweep();
    s.stop();
    expect(s.waiting()).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(store.has('a')).toBe(true);
    expect(await s.sweep()).toEqual([]);
  });
});

/** A browser's storage for this site, in memory: localStorage, sessionStorage, IndexedDB, caches, workers. */
function fakeBrowser({ databases = ['forge2', 'forge-chat', 'other'], canList = true, blocked = [] as string[] } = {}) {
  const ls = new Map<string, string>([
    ['forge.balanceKey', 'sk-forge-x'],
    ['forge2.vault', '{"in":[],"out":[]}'],
  ]);
  const ss = new Map<string, string>([['s', '1']]);
  const storage = (m: Map<string, string>) => ({
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
  });
  const dbs = new Set(databases);
  const cacheNames = new Set(['forge2-runtime-v1', 'forge-shell-abc']);
  let workers: Array<{ unregister: () => Promise<boolean> }> = [];
  const registration = () => {
    const r = { unregister: async () => ((workers = workers.filter((w) => w !== r)), true) };
    return r;
  };
  workers = [registration(), registration()];
  const indexedDB: any = {
    deleteDatabase(name: string) {
      const req: any = {};
      setTimeout(() => {
        if (blocked.includes(name)) req.onblocked?.();
        else {
          dbs.delete(name);
          req.onsuccess?.();
        }
      }, 0);
      return req;
    },
  };
  if (canList) indexedDB.databases = async () => [...dbs].map((name) => ({ name, version: 1 }));
  return {
    env: {
      localStorage: storage(ls),
      sessionStorage: storage(ss),
      indexedDB,
      caches: { keys: async () => [...cacheNames], delete: async (k: string) => cacheNames.delete(k) },
      serviceWorker: { getRegistrations: async () => workers },
    },
    dbs,
    ls,
    cacheNames,
  };
}

describe('Erase everything', () => {
  it('leaves nothing in localStorage, sessionStorage, IndexedDB, caches or service workers', async () => {
    const b = fakeBrowser();
    const closed: string[] = [];
    expect(E.isEmpty(await E.leftovers(b.env))).toBe(false);
    const r = await E.eraseEverything(b.env, { closeOwn: async () => closed.push('forge2') });
    expect(closed).toEqual(['forge2']);
    expect(r).toEqual({ ok: true, left: { localStorage: 0, sessionStorage: 0, databases: [], caches: [], workers: 0 }, blocked: [] });
    expect(b.ls.size).toBe(0);
    expect(b.dbs.size).toBe(0);
    expect(b.cacheNames.size).toBe(0);
  });

  it('deletes the known databases when the browser cannot list them', async () => {
    const b = fakeBrowser({ canList: false });
    const r = await E.eraseEverything(b.env);
    expect([...b.dbs]).toEqual(['other']); // not listed and not known: the browser gave no way to find it
    expect(E.KNOWN_DATABASES).toEqual(['forge2', 'forge-chat']);
    expect(r.ok).toBe(true);
  });

  it('never says it is done when a database stays open in another tab', async () => {
    const b = fakeBrowser({ blocked: ['forge-chat'] });
    const r = await E.eraseEverything(b.env, { waitMs: 20 });
    expect(r.ok).toBe(false);
    expect(r.blocked).toEqual(['forge-chat']);
    expect(r.left.databases).toEqual(['forge-chat']);
    // The rest is gone all the same, the balance key first of all.
    expect(r.left.localStorage).toBe(0);
    expect(r.left.caches).toEqual([]);
  });
});

describe('wiring', () => {
  it('routes History and Erase under More', () => {
    expect(ROUTER.parse('#/more/history')).toEqual({ name: 'history', params: {} });
    expect(ROUTER.parse('#/more/erase')).toEqual({ name: 'erase', params: {} });
    expect(ROUTER.parentOf('history')).toBe('more');
    expect(ROUTER.parentOf('erase')).toBe('more');
  });

  it('gives a mode Burn, but never Burn all, Erase everything or taking funds out', () => {
    const fns = Object.fromEntries(['ask', 'burn', 'burnAll', 'burnConversation', 'eraseEverything', 'takeOut', 'setAutoDelete'].map((k) => [k, () => {}]));
    const mode = R.inputsFor('mode', { actions: fns });
    expect(Object.keys(mode.actions).sort()).toEqual(['ask', 'burn']);
  });

  it('drops the sound kept for a burned answer, so nothing of it stays in memory', async () => {
    const audio = {
      model: () => ({ id: 'tts', tier: 'enclave', max_chars: 100 }),
      price: (_k: string, u: { requests: number }) => u.requests * 10,
      speak: async (input: string) => ({ blob: new Blob([input]), chargedMsub: 10 }),
    };
    const speaker = { play: () => ({ done: Promise.resolve(), stop: () => {} }) };
    const m = VOUT.create({ audio, speaker });
    await m.speak(['One.'], { key: 'a1' }).done;
    await m.speak(['Two.'], { key: 'a2' }).done;
    expect(m.cached('a1') && m.cached('a2')).toBe(true);
    m.forget('a1');
    expect(m.cached('a1')).toBe(false);
    expect(m.cached('a2')).toBe(true);
    m.forget();
    expect(m.cached('a2')).toBe(false);
  });
});

describe('words about deleting', () => {
  it('say what burn and erase do and do not do', () => {
    expect(en['history.what']).toMatch(/from this phone/);
    expect(en['history.what']).toMatch(/private models/);
    expect(en['history.what']).toMatch(/standard model/);
    expect(en['erase.moneySub']).toMatch(/no account/i);
    expect(en['erase.hold']).toBe('Hold to erase everything');
    expect(en['history.burnAll']).toBe('Burn all now');
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

describe('the red erase button', () => {
  it.each(['light', 'dark', 'midnight'])('%s keeps its words at 4.5 to 1 on red', async (id) => {
    const t = ((await import(`../../../public/v2/modules/look/${id}/index.js` as string)) as any).create().tokens;
    expect(contrast(t['danger-ink'], t.danger)).toBeGreaterThanOrEqual(4.5);
  });
});

// History's preview is the answer's first words without its Markdown (owner, 2026-11-15).
describe('the answer preview', () => {
  it('reads plain: no stars, hashes, list marks, link targets or table rules', () => {
    const p = (md: string) => H.firstWords(H.plainText(md), 90);
    expect(p('**The safest option** is to cross')).toBe('The safest option is to cross');
    expect(p('# Title\n- item one\n- *two* and `code`')).toBe('Title item one two and code');
    expect(p('See [the docs](https://x.test) now')).toBe('See the docs now');
    expect(p('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a b 1 2');
    expect(p('Keep snake_case and 2 * 3 * 4 = 24')).toBe('Keep snake_case and 2 * 3 * 4 = 24');
  });
  it('is what a History card shows', () => {
    const c = { id: 'c1', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: '**Here is what to do:**\n\n* Back up' }] };
    expect(H.listHistory([c], 'off', 3)[0].answer).toBe('Here is what to do: Back up');
  });
});
