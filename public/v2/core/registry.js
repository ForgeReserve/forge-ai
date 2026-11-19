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
  fund: ['t', 'ui', 'engine', 'wallet', 'vault', 'format', 'scan', 'qr', 'nfc', 'card', 'till'],
  filter: ['t'],
  'voice-in': ['t', 'mic', 'recognizer', 'audio', 'speech', 'asr'],
  'voice-out': ['t', 'speaker', 'synth', 'audio', 'phonon'],
  cover: ['t', 'ui'],
  guides: ['t', 'ui'],
  protect: ['t', 'ui'],
};

/**
 * Inputs a kind gets only part of. A mode draws the screens: it gets the view (what the screens show,
 * never the balance key) and the answer and voice actions, never the app's raw state or an action that
 * takes money out. Burn (remove this conversation from the phone) is one of the answer actions. A mode
 * with a cover game also gets the game's own record on the phone (coverProgress, saveCoverProgress).
 * A voice module gets the engine's audio calls for its direction only, which the app makes with the
 * balance key the module never sees. A voice-in module also gets the phone's on-device recogniser in the
 * Android and iPhone apps (core/native.js nativeSpeech: available and start only; empty on the website) and Forge
 * Private Voice's own speech to text (nativeAsr: available and start only). A
 * voice-out module also gets the phone's own Phonon engine (core/phonon.js): whether it can run, what a first use downloads, the loaded model, the native voice
 * in the Android app, the voice picked, and how fast this phone makes it (core/voicepace.js).
 */
export const PROJECTIONS = {
  mode: {
    state: ['view', 'subscribe'],
    actions: ['ask', 'stop', 'again', 'copyAnswer', 'startFresh', 'burn', 'talkDown', 'talkMove', 'talkUp', 'talkCancel', 'speak', 'stopSpeaking', 'setSearch', 'togglePrivate', 'useFastModel', 'getNaturalVoice', 'naturalNotNow', 'coverProgress', 'saveCoverProgress'],
  },
  'voice-in': { audio: ['model', 'price', 'transcribe'], speech: ['available', 'start'], asr: ['available', 'start'] },
  'voice-out': { audio: ['model', 'price', 'speak'], phonon: ['available', 'download', 'load', 'native', 'nativeFailed', 'voice', 'paceKey', 'pace', 'notePace', 'preferNatural'] },
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
  for (const k of INPUTS[kind] ?? []) {
    if (!(k in all)) continue;
    const only = PROJECTIONS[kind]?.[k];
    if (!only) out[k] = all[k];
    else {
      const part = {};
      for (const p of only) if (all[k] != null && typeof all[k][p] === 'function') part[p] = all[k][p];
      out[k] = Object.freeze(part);
    }
  }
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
    /**
     * Loads the listed modules. The manifests and entries are fetched at the same time (one round trip
     * each, not one per module: on a slow phone network the modules one after another took most of
     * the first paint), then registered in list order, so the order, the duplicate check and the
     * refusals are the same as loading them one by one.
     */
    async loadAll(list) {
      const settled = await Promise.all(
        list.map(async ({ kind, folder }) => {
          try {
            const manifest = await load(kind, folder);
            const errors = checkManifest(manifest, kind);
            if (errors.length) return { kind, folder, errors };
            const mod = Promise.resolve().then(() => importEntry(kind, folder, manifest.entry));
            mod.catch(() => {}); // a refused duplicate's import is never awaited
            return { kind, folder, manifest, mod };
          } catch (e) {
            return { kind, folder, errors: [String(e?.message ?? e)] };
          }
        }),
      );
      // Duplicates are refused before their entry runs (create is only called for the first one).
      const taken = new Set([...loaded.values()].flat().map((x) => `${x.manifest.kind}|${x.manifest.id}`));
      const keep = settled.map((r) => {
        if (r.errors) return r;
        const id = `${r.kind}|${r.manifest.id}`;
        if (taken.has(id)) return { kind: r.kind, folder: r.folder, errors: [`id ${r.manifest.id} is already loaded`] };
        taken.add(id);
        return r;
      });
      const made = await Promise.all(
        keep.map(async (r) => {
          if (r.errors) return r;
          try {
            const mod = await r.mod;
            if (typeof mod?.create !== 'function') return { kind: r.kind, folder: r.folder, errors: ['entry does not export create()'] };
            return { ...r, instance: await mod.create(inputsFor(r.kind, inputs)) };
          } catch (e) {
            return { kind: r.kind, folder: r.folder, errors: [String(e?.message ?? e)] };
          }
        }),
      );
      for (const r of made) {
        if (r.errors) {
          refused.push({ kind: r.kind, folder: r.folder, errors: r.errors });
          continue;
        }
        if (!loaded.has(r.kind)) loaded.set(r.kind, []);
        loaded.get(r.kind).push({ manifest: Object.freeze({ ...r.manifest }), instance: r.instance });
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
  // Playful (docs/PLAYFUL.md): its screens, styles and fonts load only once it is chosen (its ready()).
  { kind: 'mode', folder: 'playful' },
  // Free questions first in Add funds (docs/FREE-TIER.md); listed only while the engine gives them out.
  { kind: 'fund', folder: 'free' },
  // Open a balance with an invite code and nothing on it, for the free models; listed only while there are some.
  { kind: 'fund', folder: 'invite' },
  { kind: 'fund', folder: 'note' },
  { kind: 'fund', folder: 'card' },
  { kind: 'fund', folder: 'fedimint' },
  { kind: 'fund', folder: 'ecash' },
  { kind: 'fund', folder: 'lightning' },
  { kind: 'fund', folder: 'onchain' },
  // Forge Private Voice's own speech to text first (its APK only), then the phone's own on-device
  // recogniser in the Android or iPhone app where it has the language: both free and private.
  { kind: 'voice-in', folder: 'bundled' },
  { kind: 'voice-in', folder: 'phone' },
  { kind: 'voice-in', folder: 'engine' },
  { kind: 'voice-in', folder: 'device' },
  // The natural voice made on the phone first: it is the default where the phone can run it.
  { kind: 'voice-out', folder: 'phonon' },
  { kind: 'voice-out', folder: 'device' },
  { kind: 'voice-out', folder: 'engine' },
  // Share unseen runs the filters in this order: hidden details, then faces, then writing.
  { kind: 'filter', folder: 'strip-details' },
  { kind: 'filter', folder: 'cover-faces' },
  { kind: 'filter', folder: 'cover-numbers' },
];
