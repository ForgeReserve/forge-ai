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
});
