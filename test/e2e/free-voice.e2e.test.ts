import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentWav } from '../../src/audio.ts';
import { setLogSilent } from '../../src/log.ts';
import { MOCK_TRANSCRIPT } from '../../src/suppliers/mock.ts';
import { AUDIO_PRICES, type Gateway, startGateway } from './helpers.ts';

// Free voice questions (docs/PAYMENTS.md, Free voice questions): a transcription a balance cannot pay
// for is served free while the balance's daily allowance and the operator's daily budget last; funded
// balances pay as before; speech output is never free; nothing identifying is stored.

const gateways: Gateway[] = [];
let g: Gateway;

beforeAll(async () => {
  setLogSilent(true);
  // The defaults: 20 a balance a day, a $5.00 budget.
  g = await startGateway({ audio: true });
  gateways.push(g);
});
afterAll(async () => {
  setLogSilent(false);
  await Promise.all(gateways.map((x) => x.close()));
});

function balance(gw: Gateway, msub: number): { key: string; id: string } {
  const key = 'sk-forge-' + crypto.randomUUID().replaceAll('-', '');
  const a = gw.deps.ledger.createAccountRaw(key, 'usd', null);
  gw.deps.ledger.creditRaw(a.id, msub, msub ? 'test' : 'open', null);
  return { key, id: a.id };
}

function transcribe(gw: Gateway, key: string, model = 'mock-transcribe', seconds = 1) {
  const form = new FormData();
  form.append('file', new Blob([silentWav(seconds, 16000) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  return fetch(`${gw.url}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
}

const wallet = async (gw: Gateway, key: string): Promise<any> => (await fetch(`${gw.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
/** Supplier cost of a transcription of `seconds`, in nano-USD (markup is 1 in the tests). */
const cost = (seconds: number) => Math.ceil((AUDIO_PRICES.transcribeRequest + seconds * AUDIO_PRICES.perSecond) * 1e9 - 1e-6);

describe('a $0 balance', () => {
  it('turns a recording into text free, and the operator pays', async () => {
    const { key, id } = balance(g, 0);
    const w0 = await wallet(g, key);
    expect(w0.free_voice).toMatchObject({ enabled: true, per_day: 20, left: 20 });
    expect(w0.free_voice.resets_at).toBeGreaterThan(Date.now());
    const methods: any = await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json();
    expect(methods.free_voice).toEqual({ enabled: true, per_day: 20 });

    const r = await transcribe(g, key);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).text).toBe(MOCK_TRANSCRIPT);
    expect(r.headers.get('x-forge-charged-msub')).toBe('0');
    expect(r.headers.get('x-forge-balance-msub')).toBe('0');
    expect(r.headers.get('x-forge-free-voice-left')).toBe('19');
    expect(g.deps.ledger.findByKey(key)!.balance_msub).toBe(0);
    expect(g.deps.ledger.reservedMsub(id)).toBe(0);
    const row: any = g.deps.db.prepare('SELECT * FROM requests WHERE id = ?').get(r.headers.get('x-forge-request-id'));
    expect(row).toMatchObject({ status: 'settled', reserved_msub: 0, charged_msub: 0, price_nusd: 0, supplier_cost_nusd: cost(1), cost_source: 'operator' });
    expect((await wallet(g, key)).free_voice.left).toBe(19);
  });

  it('refuses the 21st of the day with 402 free_voice_limit, and typing is not affected', async () => {
    const { key } = balance(g, 0);
    for (let i = 0; i < 20; i++) expect((await transcribe(g, key)).status).toBe(200);
    const r = await transcribe(g, key);
    expect(r.status).toBe(402);
    const body: any = await r.json();
    expect(body.error.code).toBe('free_voice_limit');
    expect(body.free_voice).toMatchObject({ enabled: true, per_day: 20, left: 0, reason: 'allowance' });
    expect(body.free_voice.resets_at % 86_400_000).toBe(0);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await wallet(g, key)).free_voice).toMatchObject({ left: 0, reason: 'allowance' });
    // Another $0 balance still has its own 20.
    expect((await transcribe(g, balance(g, 0).key)).status).toBe(200);
  });

  it('does not count a transcription that failed', async () => {
    const { key } = balance(g, 0);
    const r = await transcribe(g, key, 'mock-transcribe-fail');
    expect(r.status).toBe(502);
    expect(r.headers.get('x-forge-charged-msub')).toBe('0');
    expect((await wallet(g, key)).free_voice.left).toBe(20);
  });

  it('is never given speech output free', async () => {
    const { key } = balance(g, 0);
    const r = await fetch(`${g.url}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'mock-speech', input: 'hello' }) });
    expect(r.status).toBe(402);
    expect(((await r.json()) as any).error.code).toBe('insufficient_balance');
  });

  it('is not given to a frozen balance', async () => {
    const { key, id } = balance(g, 0);
    g.deps.ledger.setFrozen(id, true);
    expect((await wallet(g, key)).free_voice).toMatchObject({ enabled: false, left: 0 });
    const r = await transcribe(g, key);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe('account_frozen');
  });
});

describe('a funded balance', () => {
  it('is charged as before, and keeps its free allowance', async () => {
    const { key } = balance(g, 100_000);
    const r = await transcribe(g, key, 'mock-transcribe', 2);
    expect(r.status).toBe(200);
    const price = Math.ceil(cost(2) / 10_000);
    expect(Number(r.headers.get('x-forge-charged-msub'))).toBe(price);
    expect(r.headers.get('x-forge-free-voice-left')).toBeNull();
    expect(g.deps.ledger.findByKey(key)!.balance_msub).toBe(100_000 - price);
    const row: any = g.deps.db.prepare('SELECT cost_source, price_nusd FROM requests WHERE id = ?').get(r.headers.get('x-forge-request-id'));
    expect(row).toEqual({ cost_source: 'catalog', price_nusd: cost(2) });
    expect((await wallet(g, key)).free_voice.left).toBe(20);
  });

  it('is served free once it is short of the price, without its funds being touched', async () => {
    const { key } = balance(g, 500); // half a cent; a transcription is 1.1 cents
    const r = await transcribe(g, key);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-forge-charged-msub')).toBe('0');
    expect(g.deps.ledger.findByKey(key)!.balance_msub).toBe(500);
  });
});

describe("the operator's daily budget", () => {
  it('refuses every balance once the day is spent', async () => {
    // $0.025 pays for two 1-second transcriptions at $0.011 each, not three.
    const gw = await startGateway({ audio: true, env: { FORGE_FREE_VOICE_BUDGET_USD: '0.025' } });
    gateways.push(gw);
    expect((await transcribe(gw, balance(gw, 0).key)).status).toBe(200);
    expect((await transcribe(gw, balance(gw, 0).key)).status).toBe(200);
    const late = balance(gw, 0).key;
    // The budget left (0.003) cannot pay for the cheapest one: the app is told before recording.
    expect((await wallet(gw, late)).free_voice).toMatchObject({ enabled: true, left: 0, reason: 'budget' });
    const r = await transcribe(gw, late);
    expect(r.status).toBe(402);
    const body: any = await r.json();
    expect(body.error.code).toBe('free_voice_limit');
    expect(body.free_voice.reason).toBe('budget');
    // Funded balances are not limited by it.
    expect((await transcribe(gw, balance(gw, 100_000).key)).status).toBe(200);
    expect(gw.deps.db.prepare('SELECT used, spent_nusd FROM free_voice_days').get()).toEqual({ used: 2, spent_nusd: 2 * cost(1) });
  });
});

describe('UTC days', () => {
  it('starts the counts again at midnight UTC', async () => {
    let t = Date.UTC(2026, 10, 15, 23, 50);
    const gw = await startGateway({ audio: true, env: { FORGE_FREE_VOICE_PER_DAY: '2' }, freeVoiceNow: () => t });
    gateways.push(gw);
    const { key } = balance(gw, 0);
    expect((await transcribe(gw, key)).status).toBe(200);
    expect((await transcribe(gw, key)).status).toBe(200);
    const r = await transcribe(gw, key);
    expect(r.status).toBe(402);
    expect(((await r.json()) as any).free_voice.resets_at).toBe(Date.UTC(2026, 10, 16));
    t = Date.UTC(2026, 10, 16, 0, 0, 5);
    expect((await wallet(gw, key)).free_voice).toMatchObject({ left: 2, resets_at: Date.UTC(2026, 10, 17) });
    expect((await transcribe(gw, key)).status).toBe(200);
  });
});

describe('turned off', () => {
  it('with either setting at 0, a balance short of the price is refused as before', async () => {
    for (const env of [{ FORGE_FREE_VOICE_PER_DAY: '0' }, { FORGE_FREE_VOICE_BUDGET_USD: '0' }] as Array<Record<string, string>>) {
      const gw = await startGateway({ audio: true, env });
      gateways.push(gw);
      const { key } = balance(gw, 0);
      const r = await transcribe(gw, key);
      expect(r.status).toBe(402);
      expect(((await r.json()) as any).error.code).toBe('insufficient_balance');
      expect((await wallet(gw, key)).free_voice).toMatchObject({ enabled: false, left: 0 });
      expect(((await (await fetch(`${gw.url}/v1/wallet/fund/methods`)).json()) as any).free_voice).toEqual({ enabled: false, per_day: 0 });
    }
  });
});

describe('what is stored', () => {
  it('keeps no balance id, key, time, audio or text for free voice questions', async () => {
    const { key, id } = balance(g, 0);
    expect((await transcribe(g, key)).status).toBe(200);
    const dump = JSON.stringify([g.deps.db.prepare('SELECT * FROM free_voice_days').all(), g.deps.db.prepare('SELECT * FROM free_voice_uses').all()]);
    expect(dump).not.toContain(id);
    expect(dump).not.toContain(key);
    expect(dump).not.toContain(MOCK_TRANSCRIPT);
    for (const t of ['free_voice_days', 'free_voice_uses']) {
      const cols = (g.deps.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols.some((c) => /time|_at$|created|account|key_hash|ip/.test(c))).toBe(false);
    }
  });
});
