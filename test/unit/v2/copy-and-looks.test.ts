import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The string table and its copy rules, and the three looks (tokens and text contrast).
const V2 = resolve(import.meta.dirname, '../../../public/v2');
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;
const I18N: any = await import('../../../public/v2/core/i18n.js' as string);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (n.endsWith('.js') && !p.includes('/strings/')) out.push(p);
  }
  return out;
}

describe('string table', () => {
  it('has every key the screens and modules use', () => {
    const missing: string[] = [];
    for (const f of sources(V2)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9.]+)'/g)) if (!(m[1]! in en)) missing.push(`${f.slice(V2.length)}: ${m[1]}`);
      for (const m of src.matchAll(/\bt\(\s*`([a-zA-Z0-9.]+)\$\{/g)) if (!Object.keys(en).some((k) => k.startsWith(m[1]!))) missing.push(`${f.slice(V2.length)}: ${m[1]}*`);
    }
    expect(missing).toEqual([]);
  });

  it('has a name and a line for every bundled fund module and look', () => {
    for (const id of ['ecash', 'lightning', 'onchain', 'othermint']) for (const k of ['name', 'sub']) expect(en[`fund.${id}.${k}`], `${id}.${k}`).toBeTruthy();
    for (const id of ['light', 'dark', 'midnight']) for (const k of ['name', 'sub']) expect(en[`look.${id}.${k}`]).toBeTruthy();
  });

  it('follows the copy rules', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(v.trim(), k).not.toBe('');
      expect(v, k).not.toMatch(/[–—]/); // no long dashes
      expect(v, k).not.toMatch(/\[[A-Z ]+\]/); // no bracketed placeholders
      for (const m of v.matchAll(/\becash\b/gi)) expect(m[0], k).toBe('eCash');
      // Default mode has no chat wording; the Classic card names the chat layout it switches to.
      if (k !== 'look.classicSub') expect(v, k).not.toMatch(/\b(chat|chatting)\b/i);
    }
  });

  it('makes no privacy or deletion claim the code does not back', () => {
    const all = Object.values(en).join('\n');
    expect(all).not.toMatch(/\b(anonymous|untraceable|deleted forever|nobody can see|no one can see)\b/i);
    expect(all).not.toMatch(/faces are covered/i); // face covering comes with Share unseen (A5)
  });

  it('fills slots and refuses unknown keys', () => {
    expect(I18N.t('price.under', { amount: '$0.01' })).toBe('Under $0.01');
    expect(() => I18N.t('no.such.key')).toThrow(/missing string/);
  });
});

/** WCAG relative luminance contrast of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const looks: Record<string, any> = {};
for (const id of ['light', 'dark', 'midnight']) looks[id] = ((await import(`../../../public/v2/modules/look/${id}/index.js` as string)) as any).create();

describe('looks', () => {
  it('Light uses the canvas tokens, with the memory ring in #0E7C6B', () => {
    const t = looks.light.tokens;
    expect(t).toMatchObject({ bg: '#F6F5F1', ink: '#14161A', gold: '#D4A544', 'gold-track': '#F3E3BC', memory: '#0E7C6B', 'memory-track': '#D5F2EA', teal: '#0D7A69' });
    expect(looks.dark.tokens).toMatchObject({ bg: '#161B24', surface: '#1E2530', memory: '#3FCFB4', 'memory-track': '#16302C', 'gold-track': '#3A3320' });
    expect(looks.midnight.tokens).toMatchObject({ bg: '#0B0D10', surface: '#111317', teal: '#3FCFB4', danger: '#F0685A' });
  });

  it('every look defines the same tokens', () => {
    const keys = Object.keys(looks.light.tokens).sort();
    for (const id of ['dark', 'midnight']) expect(Object.keys(looks[id].tokens).sort(), id).toEqual(keys);
  });

  it.each(['light', 'dark', 'midnight'])('%s keeps text at 4.5 to 1 or more', (id) => {
    const t = looks[id].tokens;
    const pairs: Array<[string, string]> = [
      ['ink', 'bg'],
      ['ink', 'surface'],
      ['text-2', 'bg'],
      ['text-2', 'surface'],
      ['text-body', 'surface'],
      ['teal', 'teal-tint'],
      ['gold-ink', 'surface'],
      ['danger', 'surface'],
      ['low-ink', 'low-tint'],
      ['primary-ink', 'primary'],
      ['talk-ink', 'talk'],
      ['blue', 'blue-tint'],
      ['violet', 'violet-tint'],
    ];
    for (const [fg, bg] of pairs) expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    // Icons on their tinted tiles are graphics: 3 to 1.
    for (const [fg, bg] of [['gold-ink', 'gold-tint'], ['teal', 'memory-track'], ['danger', 'danger-tint']] as const) expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
  });
});
