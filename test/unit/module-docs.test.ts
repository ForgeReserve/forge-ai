// The module guide (docs/modules/*.md, served as /docs/modules/) must not rot: each page is its Markdown as
// scripts/build-docs.ts builds it, every file it names exists, each kind's documented inputs are the ones
// the registry hands that kind, the module list matches the module folders, and the example modules load
// through the real registry. Plus the copy rules the owner enforces on public text.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSite, PAGES, slug } from '../../scripts/build-docs.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const MODULES = join(ROOT, 'public/v2/modules');
const EXAMPLES = join(ROOT, 'docs/modules/examples');
const R: any = await import('../../public/v2/core/registry.js' as string);
const { t }: any = await import('../../public/v2/core/i18n.js' as string);
const { runFilters }: any = await import('../../public/v2/core/filters.js' as string);

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const modulePages = PAGES.filter((p) => p.group === 'Modules');
const md = Object.fromEntries(modulePages.map((p) => [p.src, read(p.src)]));
/** The kinds that have modules, each with its reference page. */
const KIND_PAGES = ['fund', 'voice-in', 'voice-out', 'filter', 'look', 'mode'];
const prose = (s: string) => s.replace(/```[\s\S]*?```/g, '');

/** The level-2 section of a page under the heading `title`, up to the next level-2 heading. */
function section(page: string, title: string): string {
  const m = new RegExp(`^## ${title}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(page);
  if (!m) throw new Error(`no section "## ${title}"`);
  return m[1]!;
}

/** The level-3 parts of a section: {heading text: body}. */
function parts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^### (.+)$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((h, i) => (out[h[1]!.trim()] = text.slice(h.index! + h[0].length, heads[i + 1]?.index ?? text.length)));
  return out;
}

/** The function names in the first column of a section's table rows: `name(...)` code spans. */
const tableFunctions = (text: string) =>
  [...text.matchAll(/^\| ([^|]+) \|/gm)].flatMap((row) => [...row[1]!.matchAll(/`([a-zA-Z]+)\(/g)].map((m) => m[1]!));

/** Every module folder on disk: [kind, folder]. */
const folders = readdirSync(MODULES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((k) =>
    readdirSync(join(MODULES, k.name), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(MODULES, k.name, d.name, 'manifest.json')))
      .map((d) => [k.name, d.name] as const),
  );
const manifest = (kind: string, folder: string) => JSON.parse(readFileSync(join(MODULES, kind, folder, 'manifest.json'), 'utf8'));

/** The test files Write your first module tells a reader to add. They are not in the repository. */
const GUIDE_TESTS = ['test/unit/v2/contrast-look.test.ts', 'test/unit/v2/date-stamp.test.ts', 'test/ui/date-stamp.ui.test.ts'];
/** A path a page tells the reader to make: an example module's folder in the app, or one of the guide's tests. */
const createdByGuide = (p: string) => {
  const m = /^public\/v2\/modules\/([a-z-]+)\/([a-z-]+)\/$/.exec(p);
  return m ? existsSync(join(EXAMPLES, m[1]!, m[2]!)) : GUIDE_TESTS.includes(p);
};

describe('module guide pages', () => {
  it('each page in public/docs/modules is its Markdown as scripts/build-docs.ts builds it (run node scripts/build-docs.ts)', () => {
    const site = buildSite();
    for (const r of site) expect(readFileSync(join(ROOT, r.page.out), 'utf8') === r.html, `${r.page.out} is out of date`).toBe(true);
    expect(site.map((r) => r.page.url)).toEqual(expect.arrayContaining(['/docs/', '/docs/modules/', '/docs/modules/list', '/docs/modules/first-module', '/docs/modules/engine', ...KIND_PAGES.map((k) => `/docs/modules/${k}`)]));
  });

  it('the API guide links every module page', () => {
    const api = read('docs/API.md');
    for (const p of modulePages) expect(api, p.src).toContain(`(${p.src.replace('docs/', '')})`);
  });

  it('follows the copy rules: eCash spelled so, no em or en dashes, no "crypto", no real keys', () => {
    for (const [src, text] of Object.entries(md)) {
      const words = prose(text).replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']');
      expect(words, src).not.toMatch(/[—–]/);
      expect(text, src).not.toMatch(/crypto/i);
      expect(words.match(/\becash\b/gi)?.filter((w) => w !== 'eCash') ?? [], src).toEqual([]);
      expect(text.match(/\b(sk-forge-|inv-|pass-)[A-Za-z0-9_-]{16,}/g) ?? [], src).toEqual([]);
      expect(text, src).not.toMatch(/\/admin/);
    }
  });

  it('every repository path the pages name exists', () => {
    const missing: string[] = [];
    for (const [src, text] of Object.entries(md)) {
      const paths = new Set<string>();
      for (const m of text.matchAll(/https:\/\/github\.com\/ForgeReserve\/forge-ai\/blob\/main\/([^)\s#]+)/g)) paths.add(m[1]!);
      for (const m of prose(text).matchAll(/`((?:public|src|docs|test|scripts|config|android|ios)\/[^`\s]*)`/g)) paths.add(m[1]!);
      for (const p of paths) if (!/[<>*]|\.\.\./.test(p) && !existsSync(join(ROOT, p)) && !createdByGuide(p)) missing.push(`${src}: ${p}`);
      expect(paths.size, src).toBeGreaterThan(0);
    }
    expect(missing).toEqual([]);
  });
});

describe('kind reference pages', () => {
  it.each(KIND_PAGES)('%s documents exactly the inputs the registry hands it', (kind) => {
    const inputs = Object.keys(parts(section(md[`docs/modules/${kind}.md`]!, 'Inputs'))).map((h) => /^`([a-z-]+)`$/i.exec(h)?.[1] ?? h);
    expect(inputs).toEqual(R.INPUTS[kind]);
  });

  it.each(KIND_PAGES)('%s documents exactly the functions of each input it gets only part of', (kind) => {
    const inputs = parts(section(md[`docs/modules/${kind}.md`]!, 'Inputs'));
    for (const [input, only] of Object.entries((R.PROJECTIONS[kind] ?? {}) as Record<string, string[]>)) {
      expect(tableFunctions(inputs[`\`${input}\``]!).sort(), `${kind} ${input}`).toEqual([...only].sort());
    }
  });

  it('the overview names each kind with its inputs, as the registry hands them', () => {
    const rows = section(md['docs/modules/README.md']!, 'The six kinds');
    for (const kind of KIND_PAGES) {
      const row = rows.split('\n').find((l) => l.startsWith(`| [\`${kind}\`]`));
      expect(row, kind).toBeTruthy();
      const handed = row!.split(' | ')[2]!;
      expect([...handed.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]), kind).toEqual(R.INPUTS[kind]);
      expect(row!.endsWith(`| ${R.BUNDLED.filter((b: any) => b.kind === kind).length} |`), `${kind}: the count of bundled modules`).toBe(true);
    }
  });

  it('documents the kinds that have modules, and those are all the kinds with modules', () => {
    expect([...new Set(folders.map(([k]) => k))].sort()).toEqual([...KIND_PAGES].sort());
  });
});

describe('module list', () => {
  const list = md['docs/modules/list.md']!;
  /** Every module the list describes: {kind (its section), id, instance, path}. */
  const described = KIND_PAGES.flatMap((kind) => {
    const heading = list.match(/^## (.+)$/gm)!.map((h) => h.slice(3)).find((h) => slug(h) === kind);
    expect(heading, `a "## ..." section for ${kind}`).toBeTruthy();
    return Object.entries(parts(section(list, heading!))).map(([name, body]) => {
      const id = /^- \*\*Id:\*\* `([^`]+)`, known in the app as `([^`]+)`\.$/m.exec(body);
      const path = /^- \*\*Folder:\*\* \[`(public\/v2\/modules\/[^`]+\/)`\]\(https:\/\/github\.com\/ForgeReserve\/forge-ai\/blob\/main\/(public\/v2\/modules\/[^)]+)\)$/m.exec(body);
      expect(id, `${kind} ${name}: its Id line`).toBeTruthy();
      expect(path, `${kind} ${name}: its Folder line`).toBeTruthy();
      expect(`${path![2]}/`, `${kind} ${name}: the folder link`).toBe(path![1]);
      for (const k of ['Needs', 'Works on', 'Costs', 'Private']) expect(body, `${kind} ${name}: ${k}`).toContain(`- **${k}:** `);
      return { kind, name, id: id![1]!, instance: id![2]!, path: path![1]! };
    });
  });

  it('describes every module folder, and only those', () => {
    expect(described.map((d) => d.path).sort()).toEqual(folders.map(([k, f]) => `public/v2/modules/${k}/${f}/`).sort());
    expect(described).toHaveLength(23);
  });

  it("gives each module its manifest's id and kind, and the id its code uses", () => {
    for (const d of described) {
      const [, , , kind, folder] = d.path.split('/');
      const m = manifest(kind!, folder!);
      expect(d.id, d.path).toBe(m.id);
      expect(d.kind, d.path).toBe(m.kind);
      expect(readFileSync(join(MODULES, kind!, folder!, m.entry), 'utf8'), `${d.path}: id '${d.instance}'`).toContain(`id: '${d.instance}'`);
    }
  });

  it('lists the same modules at a glance, with their kinds, each kind in the order the app loads them', () => {
    const rows = [...section(list, 'At a glance').matchAll(/^\| `([a-z-]+)` \| `([^`]+)` \|/gm)].map((m) => [m[1], m[2]]);
    expect(rows).toHaveLength(R.BUNDLED.length);
    for (const kind of KIND_PAGES) {
      expect(rows.filter(([k]) => k === kind), kind).toEqual(R.BUNDLED.filter((b: any) => b.kind === kind).map((b: any) => [kind, manifest(kind, b.folder).id]));
    }
  });

  it('describes each kind in the order the app loads them', () => {
    for (const kind of KIND_PAGES) {
      expect(described.filter((d) => d.kind === kind).map((d) => d.path), kind).toEqual(R.BUNDLED.filter((b: any) => b.kind === kind).map((b: any) => `public/v2/modules/${kind}/${b.folder}/`));
    }
  });

  it("the guide's tests are not in the repository, so a reader adds them as new files", () => {
    for (const p of GUIDE_TESTS) expect(existsSync(join(ROOT, p)), p).toBe(false);
  });
});

describe('example modules', () => {
  const examples = readdirSync(EXAMPLES).flatMap((kind) => readdirSync(join(EXAMPLES, kind)).map((folder) => ({ kind, folder })));
  const all = Object.values(md).join('\n');
  // Inputs for create(): the real string table, and stand-ins for the hardware. Nothing here draws.
  const inputs = { t, ui: {}, state: { view: () => ({}), subscribe: () => () => {} }, nav: () => {}, actions: {}, format: {}, engine: {}, wallet: {}, vault: {}, recognizer: { available: () => false }, synth: { voices: () => [] }, speaker: {}, mic: {}, audio: {} };

  async function loadAll() {
    const reg = R.createRegistry({
      load: async (kind: string, folder: string) => JSON.parse(readFileSync(join(EXAMPLES, kind, folder, 'manifest.json'), 'utf8')),
      importEntry: (kind: string, folder: string, entry: string) => import(join(EXAMPLES, kind, folder, entry)),
      inputs,
    });
    await reg.loadAll(examples);
    return reg;
  }

  it('has one example of each kind', () => {
    expect(examples.map((e) => e.kind).sort()).toEqual([...KIND_PAGES].sort());
  });

  it('loads every example through the registry, with what its kind must provide', async () => {
    const reg = await loadAll();
    expect(reg.refused).toEqual([]);
    const NEEDS: Record<string, Record<string, string>> = {
      fund: { id: 'string', available: 'function', view: 'function' },
      'voice-in': { id: 'string', available: 'function', private: 'function', price: 'function', maxSeconds: 'function', start: 'function' },
      'voice-out': { id: 'string', available: 'function', private: 'function', pieceSize: 'function', price: 'function', speak: 'function' },
      filter: { id: 'string', what: 'string', analyse: 'function' },
      look: { id: 'string', scheme: 'string', tokens: 'object' },
      mode: { id: 'string', home: 'function', answer: 'function' },
    };
    for (const kind of KIND_PAGES) {
      const [x] = reg.list(kind);
      expect(x, kind).toBeTruthy();
      for (const [k, type] of Object.entries(NEEDS[kind]!)) expect(typeof x.instance[k], `${kind}.${k}`).toBe(type);
    }
    expect(reg.list('fund')[0].instance.id).toMatch(/^[a-z0-9-]{1,40}$/);
  });

  it('the look has every token of the bundled looks, and its text keeps a contrast of 4.5 to 1', async () => {
    const look = (await loadAll()).list('look')[0].instance;
    const midnight = (await import(join(MODULES, 'look/midnight/index.js'))).create();
    expect(Object.keys(look.tokens).sort()).toEqual(Object.keys(midnight.tokens).sort());
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const contrast = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    for (const [fg, bg] of [['ink', 'bg'], ['text-2', 'bg'], ['text-2', 'surface'], ['text-body', 'surface'], ['teal', 'teal-tint'], ['gold-ink', 'surface'], ['danger', 'surface'], ['low-ink', 'low-tint'], ['primary-ink', 'primary'], ['talk-ink', 'talk'], ['blue', 'blue-tint'], ['violet', 'violet-tint']] as Array<[string, string]>) {
      expect(contrast(look.tokens[fg], look.tokens[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the filter covers an orange stamp in the corner, and nothing in a plain picture, through the app filter chain', async () => {
    const filter = (await loadAll()).list('filter')[0].instance;
    const picture = (stamped: boolean) => {
      const width = 400;
      const height = 300;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) data.set([40, 60, 90, 255], i * 4);
      if (stamped) for (let y = 260; y < 280; y++) for (let x = 300; x < 380; x++) if (x % 8 < 4) data.set([255, 140, 30, 255], (y * width + x) * 4);
      return { width, height, pixels: { width, height, data } };
    };
    const plain = await runFilters([filter], picture(false));
    expect(plain.steps[0]).toMatchObject({ id: 'date-stamp', what: 'writing', ok: true, count: 0 });
    const stamped = await runFilters([filter], picture(true));
    expect(stamped.covers).toEqual([expect.objectContaining({ kind: 'writing', x: 298, y: 254, w: 88, h: 32, by: 'date-stamp' })]);
  });

  it('every example file is quoted in the guide as it is', () => {
    for (const { kind, folder } of examples) {
      for (const file of readdirSync(join(EXAMPLES, kind, folder))) {
        const text = readFileSync(join(EXAMPLES, kind, folder, file), 'utf8').trimEnd();
        expect(all.includes(text), `docs/modules/examples/${kind}/${folder}/${file} is not quoted on a page`).toBe(true);
      }
    }
  });
});
