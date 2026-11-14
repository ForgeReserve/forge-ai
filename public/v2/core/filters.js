// The Share unseen chain: the `filter` modules, run in order on one photo, each reporting what it found
// or covered, and the list of changes the person sees. Pure: the modules and the photo are passed in, so
// the chain is tested in Node with fake modules.
//
// A filter module has `id`, `what` ('details', 'faces' or 'writing') and analyse(photo), which resolves
// to {found} (hidden details in the file) and, or, {covers} (blocks to paint). It may have finish(bytes),
// which gets the new JPEG and returns it cleaned, and prepare(), which starts loading a model early.
// A filter that fails or takes too long is reported as not checked; the chain goes on without it.
import { clampBox, countKinds } from './covers.js';

/** The longest one filter may take, in milliseconds. A slow phone loading the face model needs a while. */
export const STEP_TIMEOUT_MS = 45_000;

const withTimeout = (p, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('took too long')), ms);
    Promise.resolve(p).then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

let nextId = 0;
const coverId = () => `cv${++nextId}`;

/**
 * Runs each filter on the photo, in order. onStep({id, what, state}) is told when each starts
 * ('running') and ends ('done' or 'failed'). Resolves to {steps, covers}: one step per filter
 * ({id, what, ok, found, known, count}) and every block the filters asked for, inside the photo.
 */
export async function runFilters(filters, photo, { onStep = () => {}, timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const steps = [];
  const covers = [];
  for (const f of filters) {
    onStep({ id: f.id, what: f.what, state: 'running' });
    try {
      const r = (await withTimeout(f.analyse(photo), timeoutMs)) ?? {};
      const mine = (r.covers ?? [])
        .map((c) => ({ ...clampBox(c, photo.width, photo.height), kind: c.kind ?? (f.what === 'faces' ? 'face' : 'writing'), id: coverId(), by: f.id }))
        .filter((c) => c.w > 0 && c.h > 0);
      covers.push(...mine);
      steps.push({ id: f.id, what: f.what, ok: true, found: r.found ?? [], known: r.known !== false, count: mine.length });
      onStep({ id: f.id, what: f.what, state: 'done' });
    } catch (e) {
      steps.push({ id: f.id, what: f.what, ok: false, found: [], known: false, count: 0, error: String(e?.message ?? e) });
      onStep({ id: f.id, what: f.what, state: 'failed' });
    }
  }
  return { steps, covers };
}

/** The new file after each filter's finish(), in order. */
export async function finishFile(filters, bytes) {
  let out = bytes;
  for (const f of filters) if (typeof f.finish === 'function') out = await f.finish(out);
  return out;
}

/** A new block for the person's own cover, with an id. */
export const withId = (c) => ({ ...c, id: c.id ?? coverId() });

/**
 * The list of what changed, for the screen: rows of {key, n, state}. `key` is a string table key (the
 * screen picks the one or many form from `n`), `state` is 'removed', 'covered', 'none', 'failed' or
 * 'uncovered' (blocks a filter made that the person took away).
 */
export function changeRows(steps, covers) {
  const rows = [];
  const now = countKinds(covers);
  const made = (kind) => steps.filter((s) => s.ok && s.what === (kind === 'face' ? 'faces' : 'writing')).reduce((n, s) => n + s.count, 0);
  for (const s of steps) {
    if (s.what === 'details') {
      if (!s.ok) rows.push({ key: 'photo.change.details', state: 'failed' });
      else if (!s.known) rows.push({ key: 'photo.change.unknown', state: 'removed' });
      else if (!s.found.length) rows.push({ key: 'photo.change.details', state: 'none' });
      else for (const d of s.found) rows.push({ key: `photo.change.${d}`, state: 'removed' });
      continue;
    }
    const kind = s.what === 'faces' ? 'face' : s.what === 'writing' ? 'writing' : null;
    if (!kind) continue;
    if (!s.ok) {
      rows.push({ key: `photo.change.${kind}`, state: 'failed' });
      continue;
    }
    const left = Math.min(now[kind], made(kind));
    const taken = made(kind) - left;
    if (made(kind) === 0) rows.push({ key: `photo.change.${kind}`, state: 'none' });
    if (left > 0) rows.push({ key: `photo.change.${kind}`, n: left, state: 'covered' });
    if (taken > 0) rows.push({ key: `photo.change.${kind}Taken`, n: taken, state: 'uncovered' });
  }
  if (now.mine > 0) rows.push({ key: 'photo.change.mine', n: now.mine, state: 'covered' });
  return rows;
}
