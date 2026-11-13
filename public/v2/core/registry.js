// The module registry. Every swappable part of the app is a module: a folder with a manifest.json and
// an entry file, loaded through here (docs/MODULES.md).
//
// What this does today: it checks each manifest's shape, refuses a bad one, imports the entry and hands
// the module only the inputs of its kind (a look gets nothing, a fund module never sees the conversation).
// What it does NOT do yet: it does not check the `publisher` and `sig` fields, and it does not run a
// module in a sandbox. Only the modules bundled with this release load, and they run as ordinary code
// in the page. Signature checks and the sandbox come with slice B2.

export const KINDS = ['fund', 'voice-in', 'voice-out', 'filter', 'cover', 'guides', 'protect', 'language', 'look', 'mode'];

/** The inputs each kind is handed. Anything not listed for a kind never reaches a module of that kind. */
export const INPUTS = {
  look: [],
  language: [],
  mode: ['t', 'ui', 'state', 'nav', 'actions', 'format'],
  fund: ['t', 'ui', 'engine', 'wallet', 'vault', 'format', 'scan', 'qr'],
  filter: ['t'],
  'voice-in': ['t'],
  'voice-out': ['t'],
  cover: ['t', 'ui'],
  guides: ['t', 'ui'],
  protect: ['t', 'ui'],
};

/** Permissions a manifest may ask for in this release. None: a module that asks for one is refused. */
export const PERMISSIONS = [];

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ENTRY = /^[a-z0-9][a-z0-9-]*\.js$/;

/** Checks a manifest. `kind` is the kind the module was listed under. Returns the list of problems. */
export function checkManifest(m, kind) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest is not an object'];
  if (typeof m.id !== 'string' || m.id.length > 100 || !ID.test(m.id)) errors.push('id is missing or malformed');
  if (!KINDS.includes(m.kind)) errors.push(`unknown kind ${String(m.kind)}`);
  else if (kind && m.kind !== kind) errors.push(`kind ${m.kind} does not match ${kind}`);
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) errors.push('version must look like 1.0.0');
  if (!m.name || typeof m.name.en !== 'string' || !m.name.en.trim()) errors.push('name.en is missing');
  if (typeof m.entry !== 'string' || !ENTRY.test(m.entry)) errors.push('entry must be a file name ending in .js in the module folder');
  if (!Array.isArray(m.permissions)) errors.push('permissions must be a list');
  else for (const p of m.permissions) if (!PERMISSIONS.includes(p)) errors.push(`permission ${String(p)} is not available`);
  for (const f of ['publisher', 'sig']) if (!(f in m) || (m[f] !== null && typeof m[f] !== 'string')) errors.push(`${f} must be present (a string or null)`);
  return errors;
}

/** The inputs for one kind, taken from everything the app offers. Frozen, so a module cannot add to them. */
export function inputsFor(kind, all) {
  const out = {};
  for (const k of INPUTS[kind] ?? []) if (k in all) out[k] = all[k];
  return Object.freeze(out);
}

/**
 * Creates a registry. `load(kind, folder)` returns the manifest; `importEntry(kind, folder, entry)`
 * returns the module namespace, which must export create(inputs).
 */
export function createRegistry({ load, importEntry, inputs = {} }) {
  const loaded = new Map(); // kind -> [{manifest, instance}]
  const refused = [];
  return {
    refused,
    async loadAll(list) {
      for (const { kind, folder } of list) {
        try {
          const manifest = await load(kind, folder);
          const errors = checkManifest(manifest, kind);
          if (errors.length) {
            refused.push({ kind, folder, errors });
            continue;
          }
          if (loaded.get(kind)?.some((x) => x.manifest.id === manifest.id)) {
            refused.push({ kind, folder, errors: [`id ${manifest.id} is already loaded`] });
            continue;
          }
          const mod = await importEntry(kind, folder, manifest.entry);
          if (typeof mod?.create !== 'function') {
            refused.push({ kind, folder, errors: ['entry does not export create()'] });
            continue;
          }
          const instance = await mod.create(inputsFor(kind, inputs));
          if (!loaded.has(kind)) loaded.set(kind, []);
          loaded.get(kind).push({ manifest: Object.freeze({ ...manifest }), instance });
        } catch (e) {
          refused.push({ kind, folder, errors: [String(e?.message ?? e)] });
        }
      }
      return this;
    },
    list(kind) {
      return [...(loaded.get(kind) ?? [])];
    },
    get(kind, id) {
      return (loaded.get(kind) ?? []).find((x) => x.manifest.id === id);
    },
  };
}

/** Loads bundled modules from public/v2/modules/<kind>/<folder>/ over HTTP (same origin only). */
export function bundledLoader(base = new URL('../modules/', import.meta.url)) {
  const dir = (kind, folder) => new URL(`${encodeURIComponent(kind)}/${encodeURIComponent(folder)}/`, base);
  return {
    async load(kind, folder) {
      const res = await fetch(new URL('manifest.json', dir(kind, folder)), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`manifest not found (HTTP ${res.status})`);
      return res.json();
    },
    importEntry: (kind, folder, entry) => import(new URL(entry, dir(kind, folder)).href),
  };
}

/** The modules bundled with this release, in the order they are listed in the app. */
export const BUNDLED = [
  { kind: 'look', folder: 'light' },
  { kind: 'look', folder: 'dark' },
  { kind: 'look', folder: 'midnight' },
  { kind: 'mode', folder: 'default' },
  { kind: 'fund', folder: 'ecash' },
  { kind: 'fund', folder: 'lightning' },
  { kind: 'fund', folder: 'onchain' },
  { kind: 'fund', folder: 'othermint' },
];
