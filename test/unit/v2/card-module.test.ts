import { describe, expect, it } from 'vitest';
import { provision } from '../../support/cards.ts';
import { CardSim } from '../../support/cardsim.ts';
import { FakeMint } from '../../support/fakemint.ts';

// The Tap a card module's own decisions (public/v2/modules/fund/card/index.js), the Android bridge to
// the ForgeNfc plugin (public/v2/core/native.js), handing a card's eCash to the vault
// (core/card/flow.js handToken), and the two ways a signature can fail: refused or garbled.
const M: any = await import('../../../public/v2/modules/fund/card/index.js' as string);
const NATIVE: any = await import('../../../public/v2/core/native.js' as string);
const F: any = await import('../../../public/v2/core/card/flow.js' as string);
const V: any = await import('../../../public/v2/core/vault.js' as string);
const R: any = await import('../../../public/v2/core/registry.js' as string);
const ADAPTERS: any = await import('../../../public/v2/core/adapters.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
const I18N: any = await import('../../../public/v2/core/i18n.js' as string);
const t = (k: string, v?: object) => I18N.t(k, v);

function memStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('the Tap a card module', () => {
  it('is bundled after Scan a note, gets the reader and the card flow, and has its words', () => {
    const order = R.BUNDLED.filter((b: any) => b.kind === 'fund').map((b: any) => b.folder);
    expect(order.indexOf('card')).toBe(order.indexOf('note') + 1);
    const inputs = R.inputsFor('fund', { t: 1, nfc: 2, card: 3, state: 4 });
    expect(Object.keys(inputs).sort()).toEqual(['card', 'nfc', 't']);
    for (const k of ['name', 'sub']) expect(en[`fund.card.${k}`]).toBeTruthy();
    expect(en['fund.card.name']).toBe('Tap a card');
  });

  it('is listed everywhere, but usable (and so in How you pay) only where there is a reader', () => {
    const web = M.create({ t, nfc: ADAPTERS.adapters.nfc });
    expect(web.available()).toBe(true);
    expect(web.usable()).toBe(false);
    expect(M.create({ t, nfc: { supported: () => true } }).usable()).toBe(true);
  });

  it('decides where the eCash goes before the card signs', () => {
    expect(M.routeFor({ trusted: true }, { unit: 'sat', units: ['usd', 'sat'] })).toBe('topup');
    // A dollar balance cannot hold sats from the engine's own mint.
    expect(M.routeFor({ trusted: true }, { unit: 'sat', units: ['usd', 'sat'], balanceUnit: 'usd' })).toBe('wrong_unit');
    expect(M.routeFor({ trusted: true }, { unit: 'sat', units: ['usd'] })).toBe('wrong_unit');
    expect(M.routeFor({ trusted: true }, { unit: null })).toBe('wrong_unit');
    expect(M.routeFor({ trusted: false }, { unit: 'sat', otherMint: true })).toBe('othermint');
    expect(M.routeFor({ trusted: false }, { unit: 'sat', otherMint: false })).toBe('wrong_mint');
  });

  it('says what went wrong in plain words, with the PIN tries left', () => {
    expect(M.wordsFor({ code: 'pin_wrong', triesLeft: 2 }, t)).toBe('Wrong PIN. 2 tries left.');
    expect(M.wordsFor({ code: 'pin_wrong', triesLeft: 1 }, t)).toBe('Wrong PIN. 1 try left.');
    expect(M.wordsFor({ code: 'pin_blocked' }, t)).toMatch(/blocked\. Nothing was taken/);
    expect(M.wordsFor({ code: 'unfinished', kept: true }, t)).toMatch(/Nothing is lost/);
    expect(M.wordsFor({ code: 'mint_unavailable', kept: true }, t)).toMatch(/kept on this phone/);
    expect(M.wordsFor({ code: 'something new' }, t)).toBe(en['fund.card.failed']);
    for (const code of ['pin_needed', 'over_limit', 'other_card', 'not_ecash', 'needs_update', 'not_genuine', 'locked', 'empty', 'too_small', 'all_only', 'not_taken', 'not_stored', 'tap_lost']) expect(M.wordsFor({ code }, t)).not.toBe(en['fund.card.failed']);
  });

  it('on the website there is no reader', async () => {
    expect(ADAPTERS.adapters.nfc.supported()).toBe(false);
    expect(await ADAPTERS.adapters.nfc.status()).toEqual({ available: false, enabled: false });
  });
});

describe('the Android bridge to ForgeNfc (core/native.js)', () => {
  it('numbers each card and sends hex both ways, so a command for one card never reaches the next', async () => {
    const calls: any[] = [];
    const listeners: Record<string, (ev: any) => void> = {};
    const call = async (plugin: string, method: string, opts: any = {}) => {
      calls.push([plugin, method, opts]);
      if (method === 'status') return { available: true, enabled: false };
      if (method === 'transceive') return { data: '02019000' };
      return undefined;
    };
    const on = (plugin: string, event: string, fn: (ev: any) => void) => {
      listeners[`${plugin}/${event}`] = fn;
      return Promise.resolve({ remove: () => calls.push(['removed']) });
    };
    const nfc = NATIVE.nativeNfc(call, on);
    expect(nfc.supported()).toBe(true);
    expect(await nfc.status()).toEqual({ available: true, enabled: false });
    const seen: any[] = [];
    const r = nfc.start((c: any) => seen.push(c));
    expect(calls.map((c) => c[1])).toContain('start');
    listeners['ForgeNfc/card']!({ id: 7, isoDep: true });
    listeners['ForgeNfc/card']!({ id: 0, isoDep: false });
    expect(seen[1]).toBeNull();
    expect(await seen[0].transceive([0x00, 0xa4, 0x04, 0x00])).toEqual([0x02, 0x01, 0x90, 0x00]);
    expect(calls.find((c) => c[1] === 'transceive')[2]).toEqual({ id: 7, apdu: '00a40400' });
    r.stop();
    await new Promise((res) => setTimeout(res, 0));
    expect(calls.map((c) => c[1] ?? c[0])).toEqual(expect.arrayContaining(['stop', 'removed']));
  });

  it('is part of the app natives, and absent on the website', () => {
    expect(NATIVE.createNative({})).toBeNull();
    const n = NATIVE.createNative({ Capacitor: { isNativePlatform: () => true, nativePromise: async () => ({}), addListener: () => ({}) } });
    expect(n.nfc.supported()).toBe(true);
  });
});

describe("handing a card's eCash on (core/card/flow.js handToken)", () => {
  it("the engine's own mint: through the wallet's top-up, which holds it in the vault", async () => {
    const vault = V.createVault(memStorage());
    const wallet = { invite: () => 'inv', topup: async (token: string, invite: string) => (vault.hold(token), { credited: 5, unit: 'sat', invite }) };
    expect(await F.handToken({ route: 'topup', token: 'cashuBx' }, { wallet, vault })).toEqual({ route: 'topup', credited: 5, unit: 'sat', invite: 'inv' });
  });

  it('a refusal or no answer after the vault has it still counts as handed; a vault that never got it does not', async () => {
    const vault = V.createVault(memStorage());
    const held = { topup: async (token: string) => (vault.hold(token), Promise.reject(new Error('offline'))) };
    expect((await F.handToken({ route: 'topup', token: 'cashuBy' }, { wallet: held, vault })).error.message).toBe('offline');
    const never = { topup: async () => Promise.reject(new Error('storage')) };
    await expect(F.handToken({ route: 'topup', token: 'cashuBz' }, { wallet: never, vault })).rejects.toThrow('storage');
  });

  it('another mint: kept in the vault, marked not added, for Other mint', async () => {
    const vault = V.createVault(memStorage());
    expect(await F.handToken({ route: 'othermint', token: 'cashuBo' }, { wallet: {}, vault, engineBase: 'https://e', message: 'Add it through Other mint.' })).toEqual({ route: 'othermint' });
    expect(vault.incoming()).toMatchObject([{ token: 'cashuBo', via: 'card', engine: 'https://e', state: 'refused', code: 'card_other_mint', message: 'Add it through Other mint.' }]);
  });
});

describe('a signature that does not come back clean', () => {
  async function ready(pin: string | null = '1234') {
    const mint = new FakeMint();
    const card = new CardSim({ pin, mint: mint.url });
    await provision(card, { keysetId: mint.active.id, keys: mint.keys(mint.active), sign: (o) => mint.mintFor(o) }, [16, 8]);
    const flow = F.createCardFunding({ storage: memStorage(), relay: mint.relay });
    card.tap();
    const summary = await flow.read(card.transceive);
    const info = await flow.mintInfo(summary);
    return { mint, card, flow, summary, info, plan: flow.plan(summary, info, 24) };
  }

  it('the card refuses before its commit (a status word): nothing is kept, nothing was burned', async () => {
    const s = await ready();
    const refusing = async (apdu: number[]) => (apdu[1] === 0x24 ? [0x6a, 0x8f] : s.card.transceive(apdu));
    const e = await s.flow.pay(refusing, { summary: s.summary, info: s.info, plan: s.plan, pin: '1234' }).catch((x: any) => x);
    expect(e.code).toBe('over_limit');
    expect(s.flow.pending()).toEqual([]);
    expect(s.card.balance()).toBe(24);
  });

  it('a garbled answer after the card signed: kept, and the next tap gets the signature again', async () => {
    const s = await ready();
    const garbling = async (apdu: number[]) => {
      const r = await s.card.transceive(apdu);
      return apdu[1] === 0x24 ? [0x01, 0x02, 0x90, 0x00] : r;
    };
    const e = await s.flow.pay(garbling, { summary: s.summary, info: s.info, plan: s.plan, pin: '1234' }).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'unfinished', kept: true });
    expect(s.card.balance()).toBe(0);
    s.card.lift();
    s.card.tap();
    const again = await s.flow.read(s.card.transceive);
    expect(again.unfinished).toBe(true);
    s.card.tap();
    await s.flow.finish(s.card.transceive, { summary: again, pin: '1234' });
    expect(s.flow.pending()[0]).toMatchObject({ state: 'swapped', received: 24 });
  });
});
