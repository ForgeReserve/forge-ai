import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Private (or Standard) chip at the top left (owner, 2026-11-17): one tap switches the kind of model in
// use. The choice is a pure function (core/state.js kindSwitch); every choice of a model remembers the
// last one of its kind (choiceOf), which the chip goes back to.
const STATE: any = await import('../../../public/v2/core/state.js' as string);
const R: any = await import('../../../public/v2/core/registry.js' as string);
const { default: en }: any = await import('../../../public/v2/strings/en.js' as string);
const APP = readFileSync(resolve(import.meta.dirname, '../../../public/v2/app.js'), 'utf8');

/** A model as GET /v1/models lists it: private ones run in sealed hardware and are encrypted to. */
const usd = (input: number, output: number, sat: object | null = null) => ({ free: false, usd_per_mtok: { input, output }, sat_per_mtok: sat });
const priv = (id: string, input: number, output: number, extra: object = {}) => ({ id, name: id, tier: 'enclave', encrypted_passthrough: true, pricing: usd(input, output), ...extra });
const std = (id: string, pricing: object, extra: object = {}) => ({ id, name: id, tier: 'standard', pricing, ...extra });
const FREE = { free: true, usd_per_mtok: { input: 0, output: 0 }, sat_per_mtok: { input: 0, output: 0 } };

const big = priv('tinfoil/big', 2, 8);
const small = priv('tinfoil/small', 0.2, 0.8);
const smallTwin = priv('tinfoil/small-twin', 0.2, 0.8);
const paid = std('mock-echo', usd(0.1, 0.4));
const pricey = std('mock-pricey', usd(1, 4));
const plainFree = std('plain-free', FREE);
const fastFree = std('glm-5.3-flash', FREE, { speed: 'fast' });
const wild = std('mock-uncensored', FREE, { uncensored: true });
// The engine's order: the pricier ones first, so "cheapest" is never just the first listed.
const ALL = [wild, big, pricey, small, smallTwin, paid, plainFree, fastFree];

const settings = (patch: object = {}) => STATE.loadedSettings(patch);
const to = (toPrivate: boolean, models: any[] = ALL, s: object = {}, unit = 'usd') => STATE.kindSwitch(models, settings(s), { toPrivate, unit });

describe('the Private chip: which model one tap chooses', () => {
  it('to Private: the cheapest Private model for a typical question, never touching Private only', () => {
    expect(to(true).model.id).toBe('tinfoil/small');
    expect(to(true, ALL, { privateOnly: false }).privateOnly).toBe(false);
    expect(to(true, ALL, { privateOnly: true }).privateOnly).toBe(true);
  });

  it('to Private: ties go to the engine order; the last Private one chosen wins while it is listed', () => {
    expect(to(true, [big, smallTwin, small]).model.id).toBe('tinfoil/small-twin');
    expect(to(true, ALL, { lastPrivate: 'tinfoil/big' }).model.id).toBe('tinfoil/big');
    // A Standard id kept as the last Private one is not a Private model: the cheapest instead.
    expect(to(true, ALL, { lastPrivate: 'mock-echo' }).model.id).toBe('tinfoil/small');
  });

  it('a remembered model the engine no longer lists falls back to the default of its kind', () => {
    expect(to(true, [big, small], { lastPrivate: 'tinfoil/gone' }).model.id).toBe('tinfoil/small');
    expect(to(false, ALL, { lastStandard: 'gone-model' }).model.id).toBe('glm-5.3-flash');
  });

  it('to Standard: the last Standard one chosen, else the free default (the fast one first), else the cheapest', () => {
    expect(to(false, ALL, { lastStandard: 'mock-pricey' }).model.id).toBe('mock-pricey');
    expect(to(false).model.id).toBe('glm-5.3-flash');
    expect(to(false, [paid, plainFree]).model.id).toBe('plain-free');
    expect(to(false, [pricey, paid, big]).model.id).toBe('mock-echo');
  });

  it('to Standard: Private only goes off, since it hides every Standard model', () => {
    expect(to(false, ALL, { privateOnly: true }).privateOnly).toBe(false);
    expect(to(false, ALL, { privateOnly: false }).privateOnly).toBe(false);
  });

  it('uncensored models are never chosen, even as the only free one', () => {
    expect(to(false, [wild, pricey, paid]).model.id).toBe('mock-echo');
    expect(to(false, [wild, paid], { lastStandard: 'mock-uncensored' }).model.id).toBe('mock-echo');
    expect(to(false, [wild])).toBeNull();
  });

  it('with no model of the other kind listed, nothing is chosen', () => {
    expect(to(true, [paid, plainFree])).toBeNull();
    expect(to(false, [big, small])).toBeNull();
    expect(to(true, [])).toBeNull();
    expect(STATE.kindSwitch(undefined, settings(), { toPrivate: false })).toBeNull();
  });

  it('prices in the balance unit; in dollars when no model of the kind has a price in that unit', () => {
    // No sat prices: the dollar prices decide.
    expect(to(true, [big, small], {}, 'sat').model.id).toBe('tinfoil/small');
    // Sat prices that disagree with the dollar ones: the sat ones decide on a sat balance.
    const satCheap = priv('tinfoil/sat-cheap', 2, 8, { pricing: usd(2, 8, { input: 1, output: 1 }) });
    const satDear = priv('tinfoil/sat-dear', 0.2, 0.8, { pricing: usd(0.2, 0.8, { input: 500, output: 500 }) });
    expect(to(true, [satDear, satCheap], {}, 'sat').model.id).toBe('tinfoil/sat-cheap');
    expect(to(true, [satDear, satCheap], {}, 'usd').model.id).toBe('tinfoil/sat-dear');
    // A model with no price at all comes after the priced ones.
    const unpriced = priv('tinfoil/unpriced', 0, 0, { pricing: null });
    expect(to(true, [unpriced, big]).model.id).toBe('tinfoil/big');
    expect(to(true, [unpriced]).model.id).toBe('tinfoil/unpriced');
  });
});

describe('remembering the last model of each kind', () => {
  it('a choice writes the model in use and the last one of its kind, never the other kind', () => {
    expect(STATE.choiceOf(small)).toEqual({ model: 'tinfoil/small', lastPrivate: 'tinfoil/small' });
    expect(STATE.choiceOf(paid)).toEqual({ model: 'mock-echo', lastStandard: 'mock-echo' });
  });

  it('round trip: Standard, Private and back return to the ones chosen last', () => {
    let s = settings();
    const step = (toPrivate: boolean) => {
      const n = STATE.kindSwitch(ALL, s, { toPrivate, unit: 'usd' });
      s = { ...s, privateOnly: n.privateOnly, ...STATE.choiceOf(n.model) };
      return n.model.id;
    };
    // Chosen on Choose a model: a pricey Standard one, then the big Private one.
    s = { ...s, privateOnly: false, ...STATE.choiceOf(pricey) };
    s = { ...s, ...STATE.choiceOf(big) };
    expect(STATE.pickModel(ALL, s).id).toBe('tinfoil/big');
    expect(step(false)).toBe('mock-pricey');
    expect(step(true)).toBe('tinfoil/big');
    expect(step(false)).toBe('mock-pricey');
  });

  it('the settings start with nothing remembered and no yes, and a phone saved before them gets the same', () => {
    expect(STATE.DEFAULT_SETTINGS).toMatchObject({ lastPrivate: '', lastStandard: '', standardOk: false });
    expect(STATE.loadedSettings({ model: 'mock-echo', privateOnly: false })).toMatchObject({ lastPrivate: '', lastStandard: '', standardOk: false, model: 'mock-echo' });
  });

  it('every place that chooses a model in app.js records it through choiceOf', () => {
    // Choose a model (an id the list does not have yet is kept as it is), Start free (two places), the
    // Private chip and the slow-answer switch.
    expect(APP.match(/Object\.assign\(S\.settings, choiceOf\(/g)?.length).toBe(5);
    expect(APP.match(/S\.settings\.model = /g)).toEqual(['S.settings.model = ']);
    expect(APP).toMatch(/if \(m\) Object\.assign\(S\.settings, choiceOf\(m\)\);\s*else S\.settings\.model = id;/);
  });
});

describe('the chip and its question', () => {
  it('mode modules get the toggle; the chip says its kind and what a tap does', () => {
    expect(R.PROJECTIONS.mode.actions).toContain('togglePrivate');
    expect(en['status.privateTap']).toBe('Private model. Tap for Standard.');
    expect(en['status.standardTap']).toBe('Standard model. Tap for Private.');
  });

  it('reuses Start free question as it is; for a paid Standard model, the same words without the free part', () => {
    expect(en['startFree.ask']).toBe('Free models are Standard models: the company running them can read what you type. Use them?');
    expect(en['startFree.ask'].endsWith(en['privacy.ask'].replace(/^Standard models: /, ''))).toBe(true);
    for (const k of ['privacy.use', 'privacy.keep', 'privacy.noPrivate', 'privacy.noStandard', 'model.chosenNext']) expect(en[k], k).toBeTruthy();
  });
});
