import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The v2 module registry (public/v2/core/registry.js): manifest checks and kind isolation.
const R: any = await import('../../../public/v2/core/registry.js' as string);
const MODULES = resolve(import.meta.dirname, '../../../public/v2/modules');

const good = (over: object = {}) => ({ id: 'org.example.thing', kind: 'fund', version: '1.0.0', name: { en: 'Thing' }, permissions: [], entry: 'index.js', publisher: null, sig: null, ...over });

describe('manifest checks', () => {
  it('accepts a well-formed manifest', () => {
    expect(R.checkManifest(good(), 'fund')).toEqual([]);
    expect(R.checkManifest(good({ publisher: 'npub1abc', sig: 'deadbeef' }), 'fund')).toEqual([]);
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['a bad id', good({ id: 'Bad Id!' })],
    ['an unknown kind', good({ kind: 'wallet' })],
    ['a kind that does not match its folder', good({ kind: 'look' })],
    ['a loose version', good({ version: '1' })],
    ['no English name', good({ name: { fr: 'Chose' } })],
    ['an entry outside the folder', good({ entry: '../core/engine.js' })],
    ['an entry in a subfolder', good({ entry: 'lib/index.js' })],
    ['a network permission', good({ permissions: ['network'] })],
    ['permissions that are not a list', good({ permissions: 'none' })],
    ['no publisher field', (({ publisher, ...m }) => m)(good())],
    ['no sig field', (({ sig, ...m }) => m)(good())],
    ['a sig that is not a string', good({ sig: 42 })],
  ])('refuses %s', (_label, m) => {
    expect(R.checkManifest(m, 'fund').length).toBeGreaterThan(0);
  });
});

describe('kind isolation', () => {
  const all = { t: 1, ui: 2, state: 3, nav: 4, actions: 5, format: 6, engine: 7, wallet: 8, vault: 9, scan: 10, qr: 11, conversation: 12, db: 13 };

  it('hands each kind only its own inputs', () => {
    expect(Object.keys(R.inputsFor('look', all))).toEqual([]);
    const fund = R.inputsFor('fund', all);
    expect(Object.keys(fund).sort()).toEqual(['engine', 'format', 'qr', 'scan', 't', 'ui', 'vault', 'wallet']);
    for (const k of ['state', 'actions', 'nav', 'conversation', 'db']) expect(fund).not.toHaveProperty(k);
    const mode = R.inputsFor('mode', all);
    for (const k of ['engine', 'wallet', 'vault', 'db']) expect(mode).not.toHaveProperty(k);
    expect(Object.keys(R.inputsFor('filter', all))).toEqual(['t']);
    expect(Object.isFrozen(fund)).toBe(true);
  });

  it('loads good modules, refuses bad ones, and passes only kind inputs to create()', async () => {
    const seen: Record<string, string[]> = {};
    const manifests: Record<string, unknown> = {
      'fund/a': good({ id: 'x.fund.a' }),
      'look/b': good({ id: 'x.look.b', kind: 'look' }),
      'fund/bad': good({ id: 'x.fund.bad', permissions: ['network'] }),
      'fund/wrongkind': good({ id: 'x.fund.wrong', kind: 'look' }),
      'fund/nocreate': good({ id: 'x.fund.nocreate' }),
      'fund/dupe': good({ id: 'x.fund.a' }),
      'fund/throws': good({ id: 'x.fund.throws' }),
    };
    const imported: string[] = [];
    const reg = R.createRegistry({
      load: async (kind: string, folder: string) => {
        const m = manifests[`${kind}/${folder}`];
        if (!m) throw new Error('not found');
        return m;
      },
      importEntry: async (kind: string, folder: string) => {
        imported.push(`${kind}/${folder}`);
        if (folder === 'nocreate') return {};
        if (folder === 'throws') return { create: () => { throw new Error('boom'); } };
        return {
          create: (inputs: object) => {
            seen[`${kind}/${folder}`] = Object.keys(inputs);
            return { id: folder };
          },
        };
      },
      inputs: all,
    });
    await reg.loadAll([
      { kind: 'fund', folder: 'a' },
      { kind: 'look', folder: 'b' },
      { kind: 'fund', folder: 'bad' },
      { kind: 'fund', folder: 'wrongkind' },
      { kind: 'fund', folder: 'nocreate' },
      { kind: 'fund', folder: 'dupe' },
      { kind: 'fund', folder: 'throws' },
      { kind: 'fund', folder: 'missing' },
    ]);
    expect(reg.list('fund').map((x: any) => x.manifest.id)).toEqual(['x.fund.a']);
    expect(reg.list('look').map((x: any) => x.manifest.id)).toEqual(['x.look.b']);
    expect(reg.refused.map((r: any) => r.folder).sort()).toEqual(['bad', 'dupe', 'missing', 'nocreate', 'throws', 'wrongkind']);
    // A refused manifest is never imported.
    expect(imported).not.toContain('fund/bad');
    expect(imported).not.toContain('fund/wrongkind');
    expect(seen['look/b']).toEqual([]);
    expect(seen['fund/a']).not.toContain('conversation');
    expect(seen['fund/a']).not.toContain('state');
    expect(reg.get('fund', 'x.fund.a').instance).toEqual({ id: 'a' });
  });
});

describe('bundled modules', () => {
  it('every bundled manifest passes the checks and sits in its kind folder', () => {
    for (const { kind, folder } of R.BUNDLED) {
      const m = JSON.parse(readFileSync(join(MODULES, kind, folder, 'manifest.json'), 'utf8'));
      expect(R.checkManifest(m, kind), `${kind}/${folder}`).toEqual([]);
      expect(readdirSync(join(MODULES, kind, folder))).toContain(m.entry);
    }
  });

  it('says plainly that signatures and the sandbox are not checked yet', () => {
    const src = readFileSync(resolve(MODULES, '../core/registry.js'), 'utf8');
    expect(src).toMatch(/does NOT do yet: it does not check the `publisher` and `sig` fields, and it does not run a\s+\/\/ module in a sandbox/);
  });
});
