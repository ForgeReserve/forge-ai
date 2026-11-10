import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, startGateway } from './helpers.ts';

const signup = (g: Gateway, body: object) =>
  fetch(`${g.url}/v1/beta/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('beta waitlist signup', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway();
  });
  afterAll(() => g.close());
  const rows = () => g.deps.db.prepare('SELECT contact, kind, note FROM beta_signups ORDER BY created_at').all();

  it('stores one row per contact, ignores the honeypot, rejects junk, and rate limits per client', async () => {
    expect((await signup(g, { contact: 'Ana@Example.org', note: 'reporting from the field' })).status).toBe(200);
    expect((await signup(g, { contact: 'ana@example.org' })).status).toBe(200); // duplicate: accepted, no second row
    expect((await signup(g, { contact: 'bot@example.org', website: 'http://spam' })).status).toBe(200); // honeypot: not stored
    expect(rows()).toEqual([{ contact: 'ana@example.org', kind: 'email', note: 'reporting from the field' }]);
    const r = await signup(g, { contact: 'still allowed?' });
    // 3 per minute per client: the fourth request is limited before validation.
    expect(r.status).toBe(429);
    const cols = (g.deps.db.prepare('PRAGMA table_info(beta_signups)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'contact', 'kind', 'note', 'created_at', 'invited_at']);
  });

  it('serves the signup page', async () => {
    const res = await fetch(`${g.url}/beta/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Join the Forge AI waitlist');
    // Static files revalidate on every load, so a new page never runs with a cached older script.
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`${g.url}/app.js`)).headers.get('cache-control')).toBe('no-cache');
  });
});
