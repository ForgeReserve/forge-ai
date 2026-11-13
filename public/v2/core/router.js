// Hash routes, one screen at a time. The route lives in the URL, so the back button works and a page
// reloaded after the tab was killed opens on the same screen. Pure parse and format, tested in Node.

export const ROUTES = {
  home: '',
  type: 'type',
  answer: 'answer',
  add: 'add',
  more: 'more',
  funds: 'funds',
  addFunds: 'funds/add',
  fund: 'funds/add/:id',
  takeOut: 'funds/out',
  look: 'more/look',
  model: 'more/model',
  voice: 'more/voice',
};

/** '#/funds/add/ecash' -> {name: 'fund', params: {id: 'ecash'}}. Unknown routes go home. */
export function parse(hash) {
  const path = String(hash ?? '')
    .replace(/^#\/?/, '')
    .replace(/\/+$/, '');
  const parts = path ? path.split('/') : [];
  for (const [name, pattern] of Object.entries(ROUTES)) {
    const pp = pattern ? pattern.split('/') : [];
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) {
        if (!/^[a-z0-9-]{1,40}$/.test(parts[i])) ok = false;
        else params[pp[i].slice(1)] = parts[i];
      } else if (pp[i] !== parts[i]) ok = false;
    }
    if (ok) return { name, params };
  }
  return { name: 'home', params: {} };
}

/** {name, params} -> '#/funds/add/ecash' */
export function href(name, params = {}) {
  const pattern = ROUTES[name];
  if (pattern == null) throw new Error(`unknown route ${name}`);
  const path = pattern
    .split('/')
    .map((p) => (p.startsWith(':') ? encodeURIComponent(params[p.slice(1)] ?? '') : p))
    .join('/');
  return '#/' + path;
}

/** The route Back goes to when there is no history (a page opened straight on a sub screen). */
export function parentOf(name) {
  return { fund: 'addFunds', addFunds: 'funds', takeOut: 'funds', look: 'more', model: 'more', voice: 'more' }[name] ?? 'home';
}
