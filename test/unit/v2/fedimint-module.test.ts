import { describe, expect, it } from 'vitest';
import { FakeFedimintCard } from '../../support/mocktill.ts';

// The Tap a Fedimint card module's own decisions (public/v2/modules/fund/fedimint/index.js), and the
// Android bridge to the ForgeTill plugin (public/v2/core/native.js nativeTill).
const M: any = await import('../../../public/v2/modules/fund/fedimint/index.js' as string);
const NATIVE: any = await import('../../../public/v2/core/native.js' as string);
const R: any = await import('../../../public/v2/core/registry.js' as string);
const T: any = await import('../../../public/v2/core/till.js' as string);
const ADAPTERS: any = await import('../../../public/v2/core/adapters.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
const I18N: any = await import('../../../public/v2/core/i18n.js' as string);
const t = (k: string, v?: object) => I18N.t(k, v);

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('the Tap a Fedimint card module', () => {
  it('is bundled after Tap a card, gets the till, and has its words', () => {
    const order = R.BUNDLED.filter((b: any) => b.kind === 'fund').map((b: any) => b.folder);
    expect(order.indexOf('fedimint')).toBe(order.indexOf('card') + 1);
    expect(Object.keys(R.inputsFor('fund', { t: 1, nfc: 2, till: 3, state: 4 })).sort()).toEqual(['nfc', 't', 'till']);
    expect(en['fund.fedimint.name']).toBe('Tap a Fedimint card');
    for (const k of ['sub', 'subNoTill', 'appOnly', 'needTill']) expect(en[`fund.fedimint.${k}`]).toBeTruthy();
  });

  it('is listed where the engine takes Lightning, usable only in the app, and says when a till is needed', () => {
    const settings = T.createTillSettings(memStorage());
    const web = M.create({ t, nfc: ADAPTERS.adapters.nfc, till: { ...ADAPTERS.adapters.till, settings } });
    expect(web.available({ lightning: { enabled: true } })).toBe(true);
    expect(web.available({ lightning: { enabled: false } })).toBe(false);
    expect(web.available(null)).toBe(false);
    expect(web.usable()).toBe(false);
    expect(web.sub()).toBe('fund.fedimint.sub');
    const app = M.create({ t, nfc: { supported: () => true }, till: { supported: () => true, settings } });
    expect(app.usable()).toBe(true);
    expect(app.sub()).toBe('fund.fedimint.subNoTill');
    settings.paired('https://till.example.org');
    expect(app.sub()).toBe('fund.fedimint.sub');
    // The iPhone app has no reader yet: the row is left out, Lightning or not.
    const ios = M.create({ t, nfc: NATIVE.NO_READER, till: { ...ADAPTERS.adapters.till, settings } });
    expect(ios.available({ lightning: { enabled: true } })).toBe(false);
  });

  it('says what the till refused in plain words, with the PIN tries left', () => {
    expect(M.wordsFor({ kind: 'card', code: 'wrong_pin', triesLeft: 2 }, t)).toBe('Wrong PIN, 2 tries left.');
    expect(M.wordsFor({ kind: 'card', code: 'wrong_pin', triesLeft: 1 }, t)).toBe('Wrong PIN, 1 try left.');
    expect(M.wordsFor({ kind: 'card', code: 'wrong_pin', triesLeft: null }, t)).toBe('Wrong PIN.');
    expect(M.wordsFor({ kind: 'card', code: 'pin_blocked' }, t)).toMatch(/blocked\. Nothing was taken/);
    expect(M.wordsFor({ kind: 'card', code: 'insufficient' }, t)).toBe(en['fund.fedimint.insufficient']);
    expect(M.wordsFor({ kind: 'card', code: 'something new' }, t)).toBe(en['fund.fedimint.cardRefused']);
    expect(M.wordsFor({ kind: 'before', code: 'something new' }, t)).toBe(en['fund.fedimint.tillRefused']);
    for (const code of ['pin_required', 'no_card', 'busy', 'unknown_card', 'fee_reserve_too_low', 'invoice_expired', 'wrong_network', 'daily_cap', 'pay_disabled', 'lightning_unavailable', 'over_limit', 'invoice_in_use', 'unauthorized'])
      expect(M.wordsFor({ kind: 'before', code }, t), code).not.toBe(en['fund.fedimint.tillRefused']);
  });

  it('a fee the till asks again, above its own cap, is said as such, never as a new price', () => {
    expect(M.wordsFor({ kind: 'before', code: 'fee_reserve_too_low' }, t)).toBe('Till cannot pay now. This till cannot pay this invoice now. Its Lightning fee is above its limit. Try again later.');
  });

  it('says what an error while paying means, and never that nothing was sent once it was', () => {
    expect(M.thrownWords('not_stored', t)).toBe(en['fund.fedimint.notStored']);
    // The request reached the till: the card may have paid.
    expect(M.thrownWords('not_stored_after', t)).toBe(en['fund.fedimint.noAnswer']);
    expect(M.thrownWords('not_stored_after', t)).not.toMatch(/Nothing was sent/);
    expect(M.thrownWords('other_till', t, { till: 'https://till.example.org' })).toBe("Another till. This payment went through the till till.example.org. Scan that till's pay code again to finish it.");
    expect(M.thrownWords('link', t)).toBe(en['fund.fedimint.unreachable']);
    for (const k of ['cardPaysPlusMargin', 'splitPlusMargin', 'feeTooHigh', 'tillBusy', 'otherTill']) expect(en[`fund.fedimint.${k}`], k).toBeTruthy();
  });
});

describe('the ForgeTill bridge', () => {
  function fakeBridge(answers: Record<string, (o: any) => any> = {}) {
    const calls: { method: string; opts: any }[] = [];
    const listeners = new Map<string, (ev: any) => any>();
    const call = async (plugin: string, method: string, opts: any = {}) => {
      expect(plugin).toBe('ForgeTill');
      calls.push({ method, opts });
      const a = answers[method];
      return a ? a(opts) : undefined;
    };
    const on = (plugin: string, event: string, fn: (ev: any) => any) => {
      listeners.set(`${plugin}.${event}`, fn);
      return Promise.resolve({ remove: async () => {} });
    };
    return { calls, listeners, till: NATIVE.nativeTill(call, on) };
  }

  it('sends a request to the paired till, the body as JSON text, and reads the answer', async () => {
    const b = fakeBridge({ request: () => ({ status: 202, body: '{"ok":false,"error":"undecided","pay_id":4}' }) });
    const r = await b.till.request({ method: 'POST', path: '/v1/pay', link: '0123456789abcdef', body: { client_ref: 'x' }, timeoutMs: 130_000 });
    expect(r).toEqual({ status: 202, body: { ok: false, error: 'undecided', pay_id: 4 } });
    expect(b.calls[0]).toEqual({ method: 'request', opts: { method: 'POST', path: '/v1/pay', link: '0123456789abcdef', body: '{"client_ref":"x"}', timeoutMs: 130_000 } });
    // No token from the page: the app adds it.
    expect(JSON.stringify(b.calls)).not.toMatch(/token|authorization/i);
  });

  it('opens the card link and answers each command from the card, then closes it', async () => {
    const b = fakeBridge({ linkOpen: (o) => ({ sock: o.sock, link: '0123456789abcdef' }) });
    const card = new FakeFedimintCard();
    const link = await b.till.openLink({ onApdu: T.cardRelay(card) });
    expect(link.id).toBe('0123456789abcdef');
    const sock = b.calls.find((c) => c.method === 'linkOpen')!.opts.sock;
    await b.listeners.get('ForgeTill.apdu')!({ sock, id: 1, apdu: '00a4040008f0464d4341524401' });
    // A command for another link is never answered from this card.
    await b.listeners.get('ForgeTill.apdu')!({ sock: sock + 1, id: 2, apdu: '8010000004' });
    expect(b.calls.filter((c) => c.method === 'linkSend').map((c) => c.opts)).toEqual([{ sock, type: 'rapdu', id: 1, rapdu: '9000' }]);
    link.close();
    expect(b.calls.at(-1)).toEqual({ method: 'linkClose', opts: { sock } });
    await b.listeners.get('ForgeTill.apdu')!({ sock, id: 3, apdu: '8010000004' });
    expect(b.calls.filter((c) => c.method === 'linkSend')).toHaveLength(1);
  });

  it('pairs through the app, passes on why a code was refused, and reads the status', async () => {
    const b = fakeBridge({
      pair: (o) => {
        if (!o.text.startsWith('fedimintcard-till-pay:')) throw Object.assign(new Error('no'), { code: 'pos' });
        return { url: 'https://till.example.org' };
      },
      status: () => ({ paired: true, url: 'https://till.example.org' }),
    });
    expect(await b.till.pair(`fedimintcard-till-pay:https://till.example.org?t=${'ab'.repeat(32)}`)).toEqual({ url: 'https://till.example.org' });
    await expect(b.till.pair('fedimintcard-till:x')).rejects.toMatchObject({ code: 'pos' });
    expect(await b.till.status()).toEqual({ paired: true, url: 'https://till.example.org' });
    expect(await fakeBridge({ status: () => { throw new Error('gone'); } }).till.status()).toEqual({ paired: false, url: null });
  });

  it('is part of the app bridge, and the website has no till', async () => {
    const win = { Capacitor: { isNativePlatform: () => true, nativePromise: async () => undefined, addListener: () => ({}) } };
    expect(NATIVE.createNative(win).till.supported()).toBe(true);
    expect(ADAPTERS.adapters.till.supported()).toBe(false);
    await expect(ADAPTERS.adapters.till.pair('x')).rejects.toMatchObject({ code: 'app_only' });
  });
});
