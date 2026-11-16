// Playful mode (docs/PLAYFUL.md): Pip, bright colours and big buttons on the home and the answer screen.
// A mode module is handed what the Default mode is (modules/mode/default/index.js): t, ui, nav and format,
// the screens' view and change notice, the answer actions and the voice actions. Never the engine, the
// wallet, storage, the microphone itself or an action that takes money out.
//
// Nothing of Playful loads with the app: this file has no imports, so a phone in Default mode fetches
// only it. ready() loads the screens, the stylesheet and the two typefaces (public/v2/vendor/baloo-2 and
// nunito), and the app calls it before it draws a Playful screen: once Playful is chosen, and at start on
// a phone where it is.
let screens = null;
let loading = null;

/** Puts the Playful stylesheet in the page once; resolves when it is in. */
function styles() {
  const href = new URL('./playful.css', import.meta.url).href;
  const there = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href === href);
  if (there?.sheet) return Promise.resolve();
  const link = there ?? Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
  const done = new Promise((resolve, reject) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', () => reject(new Error('playful.css did not load')), { once: true });
  });
  // After the app's stylesheet (in the body), so Playful's rules win over the ones they restyle.
  if (!there) document.body.append(link);
  return done;
}

/** The two typefaces, waited for a short while so the first frame is laid out with them; else it swaps. */
function fonts() {
  const f = document.fonts;
  if (!f?.load) return Promise.resolve();
  const all = Promise.all(['800 20px "Baloo 2"', '700 16px Nunito'].map((x) => f.load(x))).catch(() => {});
  return Promise.race([all, new Promise((r) => setTimeout(r, 1500))]);
}

export function create(inputs) {
  return {
    id: 'playful',
    ready: () =>
      (loading ??= Promise.all([import('./home.js'), import('./answer.js'), styles()])
        .then(async ([h, a]) => {
          await fonts();
          screens = { home: h.home, answer: a.answer };
        })
        .catch((e) => {
          loading = null; // offline and not kept yet: try again when it is chosen again
          throw e;
        })),
    home: (opts) => screens.home(inputs, opts),
    answer: () => screens.answer(inputs),
  };
}
