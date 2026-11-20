import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { looksLikeFedimintNotes } from '../../../src/fedimint.ts';

// Fedimint notes read on the phone (public/v2/core/fedinote.js), against real notes from local devfed
// federations and what the real receiver read in each (test/unit/fixtures/fedimint/notes.json, made by
// scripts/fedimint-fixtures.ts), against Cashu tokens and against junk. And what the eCash box does with
// the engine's answers: the vault's states for Fedimint notes (core/vault.js) and the words for each.
const F: any = await import('../../../public/v2/core/fedinote.js' as string);
const V: any = await import('../../../public/v2/core/vault.js' as string);
const E: any = await import('../../../public/v2/core/engine.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;

interface Fixture {
  name: string;
  notes: string;
  module: 'mint' | 'mintv2';
  amount_msat: number;
  count: number;
  federation_id: string;
  carries_federation_id: boolean;
  federation_prefix: string;
  notes_id: string;
  joined: boolean;
}
const FIX: Fixture[] = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/fedimint/notes.json'), 'utf8')).notes;
const fx = (name: string) => FIX.find((f) => f.name === name)!;

/** fedimint's base32 (base32hex, lowercase, low bits first), to re-encode mint v1 notes as the receiver's own test does. */
function base32(bytes: Uint8Array): string {
  const A = '0123456789abcdefghijklmnopqrstuv';
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf |= b << bits;
    bits += 8;
    while (bits >= 5) {
      out += A[buf & 31];
      buf >>>= 5;
      bits -= 5;
    }
  }
  if (bits > 0) out += A[buf & 31];
  return out;
}
const bytesOf = (b64url: string) => new Uint8Array(Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
const CASHU_B = 'cashuBo2FteBtodHRwczovL21pbnQuZXhhbXBsZS5jb20vYXBpYXVjc2F0YXSBomFpSAC0yxw5u2C8YXCBo2FhAmFzeEAzZDc5ZmRiYzE4ZTY2OGIzYmI2MzE5MzJkMjU4ZDBiNjI2ZmY1MGRmNDIyNzc5ZDM0YWQ4NmJjYWYxN2JjM2VhYWNYIQKgfflDtZpmeVuJ5rp9lrTxkRqhGvxpHu6zm7YZ0jx4wg';

describe('reading Fedimint notes', () => {
  it('has real notes of both kinds, with and without the invite, in one tier and several', () => {
    expect(FIX.map((f) => f.name)).toEqual(['v1', 'v1-small', 'v1-tiers', 'v1-invite', 'v2', 'v2-tiers', 'v2-invite', 'v1-not-joined']);
    expect(new Set(FIX.map((f) => f.module))).toEqual(new Set(['mint', 'mintv2']));
    expect(fx('v1-tiers').count).toBeGreaterThan(3);
  });

  it.each(FIX.map((f) => [f.name, f]))('reads %s as the receiver does: kind, amount, count, federation', (_n, f: Fixture) => {
    const r = F.readFedimint(f.notes);
    expect(r).toEqual({
      ok: true,
      notes: f.notes,
      module: f.module,
      amountMsat: f.amount_msat,
      count: f.count,
      prefix: f.federation_prefix,
      // The full id only where the notes carry it: mintv2 always, mint v1 with the invite inside.
      federationId: f.carries_federation_id ? f.federation_id : null,
    });
    expect(f.federation_id.startsWith(f.federation_prefix)).toBe(true);
    expect(F.tokenKind(f.notes)).toBe('fedimint');
  });

  it.each(FIX.map((f) => [f.name, f]))('names %s by the id the receiver gives it', async (_n, f: Fixture) => {
    expect(await F.notesIdOf(f.notes)).toBe(f.notes_id);
  });

  it('reads mint v1 notes however they are written: base64, base32, upper case, wrapped', async () => {
    const f = fx('v1-tiers');
    const bytes = bytesOf(f.notes);
    const forms = {
      base64: Buffer.from(bytes).toString('base64'),
      base64NoPad: f.notes.replace(/=+$/, ''),
      base32: 'fedimint' + base32(bytes),
      base32Upper: ('fedimint' + base32(bytes)).toUpperCase(),
      wrapped: f.notes.replace(/(.{40})/g, '$1\n  '),
    };
    for (const [form, text] of Object.entries(forms)) {
      const r = F.readFedimint(text);
      expect(r, form).toMatchObject({ ok: true, module: 'mint', amountMsat: f.amount_msat, count: f.count, prefix: f.federation_prefix });
      expect(await F.notesIdOf(text), form).toBe(f.notes_id);
    }
    // The notes are sent as written, less the whitespace, and base32 in lower case.
    expect(F.readFedimint(forms.wrapped).notes).toBe(f.notes);
    expect(F.readFedimint(forms.base32Upper).notes).toBe(forms.base32);
  });

  it('reads mintv2 notes in upper case and wrapped', async () => {
    const f = fx('v2-tiers');
    for (const text of [f.notes.toUpperCase(), f.notes.replace(/(.{50})/g, '$1 \n')]) {
      expect(F.readFedimint(text)).toMatchObject({ ok: true, module: 'mintv2', amountMsat: f.amount_msat, federationId: f.federation_id });
      expect(await F.notesIdOf(text)).toBe(f.notes_id);
    }
  });

  it('tells Cashu tokens from notes', () => {
    for (const t of [CASHU_B, `cashu:${CASHU_B}`, 'cashuAeyJ0b2tlbiI6W119', ` ${CASHU_B}\n`]) {
      expect(F.tokenKind(t), t.slice(0, 12)).toBe('cashu');
      expect(F.readFedimint(t).ok).toBe(false);
    }
  });

  it('takes nothing else for notes, including text the engine would send its receiver to read', () => {
    const v1 = fx('v1').notes;
    const v2 = fx('v2').notes;
    const junk = [
      '',
      '   ',
      'hello world',
      'not a token',
      'lnbc10u1pjexample0000000000000000000000000000',
      'sk-forge-0123456789abcdefghijklmnop',
      'https://mint.example.com',
      'fedimint1qqqq',
      'fedimint',
      'A'.repeat(64),
      Buffer.from('x'.repeat(300)).toString('base64'),
      Buffer.from(Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256)).toString('base64url'),
      v1.slice(0, -12), // cut short
      'B' + v1.slice(1), // the count of its parts changed
      v1 + 'AAAA', // more after the notes
      v2.slice(0, -8),
      v2.replace(/^fedimint/, 'fedimintw'), // a letter outside base32hex
      'fedimint' + 'x'.repeat(100),
      v1.slice(0, 20) + '+' + v1.slice(21), // both base64 alphabets at once
      'x'.repeat(200_001),
    ];
    for (const t of junk) {
      expect(F.tokenKind(t), t.slice(0, 30)).toBe('none');
      expect(F.readFedimint(t), t.slice(0, 30)).toEqual({ ok: false });
    }
    // A changed signature still reads as notes: only the receiver checks signatures (invalid_token).
    expect(F.tokenKind(v1.slice(0, 40) + (v1[40] === 'Z' ? 'Y' : 'Z') + v1.slice(41))).toBe('fedimint');
    // Stricter than the engine's quick test, which sends anything shaped like notes on to its receiver.
    expect(looksLikeFedimintNotes('A'.repeat(64))).toBe(true);
    expect(looksLikeFedimintNotes(v1)).toBe(true);
    expect(looksLikeFedimintNotes(v2)).toBe(true);
  });

  it('has no id for text that is not notes', async () => {
    expect(await F.notesIdOf('hello')).toBe(null);
    expect(F.shortId('0123456789abcdef0123')).toBe('0123456789ab');
  });
});

describe('what the phone decides before sending notes', () => {
  const fed = fx('v1');
  const read = F.readFedimint(fed.notes); // mint v1 without the invite: only the prefix is known
  const v2 = F.readFedimint(fx('v2').notes);
  const on = (federations: object[], max = 100_000) => ({ fedimint: { enabled: true, unit: 'sat', max, federations } });

  it('sends nothing while the engine takes no Fedimint notes, or its ways are not known yet', () => {
    for (const m of [null, undefined, {}, { fedimint: { enabled: false, unit: 'sat', max: 100_000, federations: [] } }]) {
      expect(F.fedimintCheck(read, m).verdict).toBe('off');
    }
  });

  it('finds the federation by its full id, or by the prefix mint v1 notes carry', () => {
    const f = { id: fed.federation_id, name: 'Island Fed', max: 100_000 };
    expect(F.fedimintCheck(read, on([f]))).toEqual({ verdict: 'send', federation: f, maxSat: 100_000 });
    expect(F.fedimintCheck(v2, on([{ id: 'ff' + fed.federation_id.slice(2), name: 'Near', max: 1 }, f])).federation).toBe(f);
    expect(F.federationOf(v2, [{ id: fed.federation_id.toUpperCase(), name: 'Upper', max: 1 }])).toMatchObject({ name: 'Upper' });
  });

  it('sends nothing for notes of a federation the engine does not list', () => {
    expect(F.fedimintCheck(read, on([{ id: 'ab'.repeat(32), name: 'Other', max: 100_000 }]))).toEqual({ verdict: 'not_taken', federation: null, maxSat: null });
    expect(F.fedimintCheck(read, on([])).verdict).toBe('not_taken');
  });

  it('leaves two federations with the same prefix to the engine', () => {
    const a = { id: fed.federation_id.slice(0, 8) + 'a'.repeat(56), name: 'A', max: 100_000 };
    const b = { id: fed.federation_id.slice(0, 8) + 'b'.repeat(56), name: 'B', max: 100_000 };
    expect(F.fedimintCheck(read, on([a, b]))).toEqual({ verdict: 'send', federation: null, maxSat: 100_000 });
  });

  it('sends nothing over the most taken at once: the federation’s own, else the engine’s', () => {
    const sat = Math.floor(fed.amount_msat / 1000); // the notes are worth a little more than this
    expect(F.fedimintCheck(read, on([{ id: fed.federation_id, name: 'F', max: sat }])).verdict).toBe('too_large');
    expect(F.fedimintCheck(read, on([{ id: fed.federation_id, name: 'F', max: sat + 1 }])).verdict).toBe('send');
    // A federation with no max of its own: the engine's.
    expect(F.fedimintCheck(read, on([{ id: fed.federation_id, name: 'F' }], sat))).toMatchObject({ verdict: 'too_large', maxSat: sat });
  });
});

describe('what each answer means for the notes', () => {
  const answer = (code: string, status: number) => F.fedimintAnswer(E.errorFrom(status, { error: { code, message: code } }));

  it('says the notes are still the person’s for every refusal that took nothing', () => {
    for (const [code, status] of [
      ['federation_not_joined', 400],
      ['federation_paused', 400],
      ['notes_unsupported', 400],
      ['invalid_token', 400],
      ['amount_too_large', 400],
      ['federation_full', 400],
      ['insufficient_amount', 400],
      ['fedimint_unavailable', 503],
      ['wrong_unit', 400],
      ['sibling_refused', 400],
      ['invalid_key', 401],
    ] as const) {
      expect(answer(code, status).kind, code).toBe('yours');
    }
    expect(new Set(['federation_not_joined', 'federation_paused', 'federation_full', 'amount_too_large', 'insufficient_amount', 'notes_unsupported', 'fedimint_unavailable'].map((c) => answer(c, 400).key)).size).toBe(7);
  });

  it('keeps them pending while the outcome is open, and marks spent and stuck notes apart', () => {
    expect(answer('topup_pending', 503)).toEqual({ kind: 'pending', key: 'fund.ecash.fm.pending' });
    expect(answer('token_in_flight', 409).kind).toBe('pending');
    expect(answer('internal', 500).kind).toBe('pending');
    expect(F.fedimintAnswer(new E.EngineError('offline', 'no answer', { retryable: true })).kind).toBe('pending');
    expect(answer('token_spent', 400)).toEqual({ kind: 'spent', key: 'fund.ecash.fm.spent' });
    expect(answer('issuance_failed', 502)).toEqual({ kind: 'stuck', key: 'fund.ecash.fm.stuck' });
  });

  it('has words for every answer, and says the notes are theirs only where they are', () => {
    const codes = ['federation_not_joined', 'federation_paused', 'notes_unsupported', 'invalid_token', 'amount_too_large', 'federation_full', 'insufficient_amount', 'fedimint_unavailable', 'token_spent', 'issuance_failed', 'topup_pending', 'wrong_unit', 'nope'];
    for (const c of codes) {
      const a = answer(c, c === 'topup_pending' || c === 'fedimint_unavailable' ? 503 : c === 'issuance_failed' ? 502 : 400);
      expect(en[a.key], c).toBeTruthy();
      expect(/still yours/.test(en[a.key]!), c).toBe(a.kind === 'yours' && c !== 'invalid_token');
    }
    expect(en['fund.ecash.fm.off']).toMatch(/Nothing was sent/);
    expect(en['fund.ecash.fm.stuck']).toMatch(/\{id\}/);
  });
});

describe('Fedimint notes in the vault', () => {
  function memStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const err = (code: string, status: number, extra = {}) => json({ error: { code, message: code, type: code }, ...extra }, status);
  const notes = fx('v2').notes;
  const extra = { kind: 'fedimint', notesId: fx('v2').notes_id };

  it('marks a refusal that took nothing as refused, and keeps the notes to copy', async () => {
    const vault = V.createVault(memStorage());
    const engine = E.createEngine({ fetch: async () => err('federation_paused', 400, { fedimint: { federation_id: 'x', federation_prefix: 'y' } }) });
    await expect(V.topupWithVault({ engine, vault, token: notes, key: 'sk-forge-sat', setKey: vi.fn(), extra })).rejects.toMatchObject({ code: 'federation_paused', retryable: false });
    expect(vault.incoming()).toMatchObject([{ token: notes, state: 'refused', code: 'federation_paused', kind: 'fedimint', notesId: extra.notesId }]);
    vault.discard(vault.incoming()[0].id);
    expect(vault.incoming()).toEqual([]);
  });

  it('keeps the notes pending on topup_pending, with the key the engine made, and finishes on a retry', async () => {
    const vault = V.createVault(memStorage());
    const answers = [err('topup_pending', 503, { key: 'sk-forge-made', account_id: 'a1' }), json({ key: 'sk-forge-made', unit: 'sat', credited: 48.9, credited_msub: 48_900, replay: false })];
    const seen: Array<string | null> = [];
    const engine = E.createEngine({
      fetch: async (_u: string, init: any) => {
        seen.push(init.headers.authorization ?? null);
        return answers.shift()!;
      },
    });
    let key: string | null = null;
    const setKey = (k: string) => (key = k);
    await expect(V.topupWithVault({ engine, vault, token: notes, key: null, invite: 'inv', setKey, extra })).rejects.toMatchObject({ code: 'topup_pending', retryable: true });
    expect(key).toBe('sk-forge-made');
    expect(vault.incoming()).toMatchObject([{ state: 'pending', code: 'topup_pending', kind: 'fedimint' }]);
    // A reload: a new vault on the same storage still has them, and the retry sends the same notes with the same key.
    expect(await V.retryPending({ engine, vault, getKey: () => key, setKey })).toBe(1);
    expect(seen).toEqual([null, 'Bearer sk-forge-made']);
    expect(vault.incoming()).toEqual([]);
  });

  it('refuses notes the receiver could not read on a first send, and keeps notes already on their way pending', async () => {
    const vault = V.createVault(memStorage());
    const engine = E.createEngine({ fetch: async () => err('fedimint_unavailable', 503) });
    await expect(V.topupWithVault({ engine, vault, token: notes, key: 'k', setKey: vi.fn(), extra })).rejects.toMatchObject({ code: 'fedimint_unavailable', retryable: false });
    expect(vault.incoming()).toMatchObject([{ state: 'refused' }]);

    // Sent before, outcome open: the engine reads the notes at the receiver before it finds that top-up,
    // so its fedimint_unavailable says nothing about them. They stay pending.
    const v2 = V.createVault(memStorage());
    v2.pending(v2.hold(notes, 'topup', { engine: '', ...extra }).id, 'topup_pending');
    const e = await V.topupWithVault({ engine, vault: v2, token: notes, key: 'k', setKey: vi.fn(), extra }).catch((x: any) => x);
    expect(e).toMatchObject({ code: 'fedimint_unavailable', retryable: true });
    expect(F.fedimintAnswer(e).kind).toBe('pending');
    expect(v2.incoming()).toMatchObject([{ state: 'pending', code: 'fedimint_unavailable' }]);
  });

  it('marks stuck notes apart: never sent again, removed only by hand', async () => {
    const vault = V.createVault(memStorage());
    const fetch = vi.fn(async () => err('issuance_failed', 502, { key: 'sk-forge-k', account_id: 'a1' }));
    const engine = E.createEngine({ fetch });
    await expect(V.topupWithVault({ engine, vault, token: notes, key: 'sk-forge-k', setKey: vi.fn(), extra })).rejects.toMatchObject({ code: 'issuance_failed', retryable: false });
    expect(vault.incoming()).toMatchObject([{ state: 'stuck', code: 'issuance_failed', notesId: extra.notesId }]);
    expect(await V.retryPending({ engine, vault, getKey: () => 'sk-forge-k', setKey: vi.fn() })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    vault.discard(vault.incoming()[0].id);
    expect(vault.incoming()).toEqual([]);
  });

  it('marks spent notes refused, as a spent Cashu token is', async () => {
    const vault = V.createVault(memStorage());
    const engine = E.createEngine({ fetch: async () => err('token_spent', 400) });
    await expect(V.topupWithVault({ engine, vault, token: notes, key: 'k', setKey: vi.fn(), extra })).rejects.toMatchObject({ code: 'token_spent' });
    expect(vault.incoming()).toMatchObject([{ state: 'refused', code: 'token_spent' }]);
  });
});
