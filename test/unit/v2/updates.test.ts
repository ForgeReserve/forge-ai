import { describe, expect, it } from 'vitest';

// A new build shows without asking anyone to reload (public/v2/core/updates.js): one reload when a new
// worker takes over, never a loop, and never in the middle of something.
const U: any = await import('../../../public/v2/core/updates.js' as string);

function setup({ hadController = true, busy = false, storage = new Map<string, string>() as Map<string, string> | null } = {}) {
  let clock = 1_000_000;
  const state = { busy, reloads: 0 };
  const store = storage && { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
  const up = U.createUpdater({ storage: store, hadController, busy: () => state.busy, reload: () => state.reloads++, now: () => clock });
  return { up, state, storage, tick: (ms: number) => (clock += ms) };
}

describe('reloading into a new build', () => {
  it('reloads once when a new worker takes over a page an older one served', () => {
    const { up, state, storage } = setup();
    expect(up.controllerChanged()).toBe(true);
    expect(state.reloads).toBe(1);
    expect(storage!.get(U.RELOAD_KEY)).toBeTruthy();
  });

  it('never loops: after a reload, a worker taking over again does nothing within the hour', () => {
    const storage = new Map<string, string>();
    const first = setup({ storage });
    first.up.controllerChanged();
    // The reloaded page: the same session storage, and the new worker claims it again.
    const again = setup({ storage });
    expect(again.up.controllerChanged()).toBe(false);
    expect(again.up.screenChanged()).toBe(false);
    expect(again.state.reloads).toBe(0);
    // Much later (another deploy in the same tab), one reload again.
    again.tick(U.RELOAD_GAP_MS + 1);
    expect(again.up.controllerChanged()).toBe(true);
    expect(again.state.reloads).toBe(1);
  });

  it('waits while the person is busy, then reloads at the next screen change', () => {
    const { up, state } = setup({ busy: true });
    expect(up.controllerChanged()).toBe(false);
    expect(up.pending()).toBe(true);
    expect(up.screenChanged()).toBe(false); // still recording, say
    expect(state.reloads).toBe(0);
    state.busy = false;
    expect(up.screenChanged()).toBe(true);
    expect(state.reloads).toBe(1);
    expect(up.screenChanged()).toBe(false); // once only
    expect(state.reloads).toBe(1);
  });

  it('does not reload when the first worker claims a page that had none, but does for the next one', () => {
    const { up, state } = setup({ hadController: false });
    expect(up.controllerChanged()).toBe(false);
    expect(up.screenChanged()).toBe(false);
    expect(state.reloads).toBe(0);
    expect(up.controllerChanged()).toBe(true);
    expect(state.reloads).toBe(1);
  });

  it('never reloads on its own without session storage to guard it', () => {
    const { up, state } = setup({ storage: null });
    expect(up.controllerChanged()).toBe(false);
    expect(up.screenChanged()).toBe(false);
    expect(state.reloads).toBe(0);
  });
  it('reloads once for each new build, however soon one deploy follows another, and never twice for the same build', () => {
    const storage = new Map<string, string>();
    // The first deploy: the tab reloads for build A.
    const one = setup({ storage });
    expect(one.up.controllerChanged('build-a')).toBe(true);
    // The reloaded page: the same worker claiming it again does nothing.
    const two = setup({ storage });
    expect(two.up.controllerChanged('build-a')).toBe(false);
    // A second deploy five minutes later: one reload for build B (the owner's iPhone, 2026-11-21, stayed on A).
    two.tick(5 * 60 * 1000);
    expect(two.up.controllerChanged('build-b')).toBe(true);
    expect(two.state.reloads).toBe(1);
    // Two engines answering in turn with A and B cannot make a loop: both were reloaded for.
    const three = setup({ storage });
    expect(three.up.controllerChanged('build-a')).toBe(false);
    expect(three.up.controllerChanged('build-b')).toBe(false);
    expect(three.state.reloads).toBe(0);
    // After the hour, the same build may reload the tab once more.
    three.tick(U.RELOAD_GAP_MS + 1);
    expect(three.up.controllerChanged('build-a')).toBe(true);
  });

  it('a busy person gets the newest build at the next screen change, once', () => {
    const storage = new Map<string, string>();
    const { up, state } = setup({ storage, busy: true });
    expect(up.controllerChanged('build-a')).toBe(false);
    expect(up.controllerChanged('build-b')).toBe(false);
    state.busy = false;
    expect(up.screenChanged()).toBe(true);
    expect(state.reloads).toBe(1);
    expect(Object.keys(JSON.parse(storage.get(U.RELOAD_KEY)!))).toEqual(['build-b']);
  });

  it('a worker whose build changes every time cannot reload a tab more than a few times an hour', () => {
    const storage = new Map<string, string>();
    let reloads = 0;
    for (let i = 0; i < 20; i++) {
      const page = setup({ storage });
      page.up.controllerChanged(`build-${i}`);
      reloads += page.state.reloads;
    }
    expect(reloads).toBe(U.RELOAD_MAX);
  });

  it('without a build id the old rule holds, and a value an older build stored still guards', () => {
    const storage = new Map<string, string>([[U.RELOAD_KEY, String(1_000_000 - 1000)]]);
    const page = setup({ storage });
    expect(page.up.controllerChanged()).toBe(false);
    // A named build the tab has not reloaded for still reloads it.
    expect(page.up.controllerChanged('build-a')).toBe(true);
    // Storage holding something unreadable: no automatic reload.
    const broken = setup({ storage: new Map([[U.RELOAD_KEY, '{not json']]) });
    expect(broken.up.controllerChanged('build-a')).toBe(false);
    expect(broken.state.reloads).toBe(0);
  });
});
