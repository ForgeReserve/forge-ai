/**
 * Builds the public docs under public/docs/ from the Markdown in docs/: the API guide (docs/API.md, served
 * at /docs/) and the module guide (docs/modules/*.md, served at /docs/modules/).
 *
 *   pnpm build:docs          # node scripts/build-docs.ts: writes every page in PAGES
 *
 * Each page is its Markdown rendered with the vendored marked (public/vendor/marked.js), code highlighted
 * at build time with the vendored highlight.js, inside a fixed page shell: the list of pages and the
 * page's own sections on the left, anchor links on every heading, a copy button on every code block. The
 * pages share public/docs/docs.css and public/docs/docs.js; they load nothing from another origin.
 * test/unit/api-docs.test.ts and test/unit/module-docs.test.ts fail when a checked-in page and its
 * Markdown drift.
 *
 * Links between pages are written in the Markdown as relative links to the other Markdown file
 * (`[Fund](fund.md#inputs)`), so they work on GitHub too; the build turns them into the pages' addresses
 * and fails on a link to a page or a heading that does not exist.
 *
 * An endpoint is documented by a level-3 heading of the form ### `GET /v1/models`. The API test checks
 * those headings against the gateway's routes, both ways.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const abs = (rel: string) => fileURLToPath(new URL(rel, ROOT));
export const API_MD = abs('docs/API.md');
export const DOCS_HTML = abs('public/docs/index.html');

const { Marked }: { Marked: new (...a: any[]) => { parse(md: string): string; use(ext: object): unknown } } = await import(new URL('public/vendor/marked.js', ROOT).href as string);
const hljs: { highlight(code: string, o: { language: string }): { value: string }; getLanguage(l: string): unknown } = (
  await import(new URL('public/vendor/highlight.js', ROOT).href as string)
).default;

/** One page of the docs: its Markdown source, the file it is built into and the address it is served at. */
export interface Page {
  /** The Markdown source, from the repository root. */
  src: string;
  /** The page it is built into, from the repository root. */
  out: string;
  /** Where the gateway serves it. */
  url: string;
  /** The group it is listed under in the list of pages. */
  group: 'API' | 'Modules';
  /** Its name in the list of pages. */
  nav: string;
  /** The word beside the logo in the top bar. */
  crumb: string;
  /** The page's meta description. */
  description: string;
}

/** Every page, in the order the list of pages shows them. */
export const PAGES: Page[] = [
  {
    src: 'docs/API.md',
    out: 'public/docs/index.html',
    url: '/docs/',
    group: 'API',
    nav: 'API guide',
    crumb: 'API',
    description: 'Build on Forge AI: an OpenAI-compatible AI gateway paid with eCash. Quickstart, payments, private models and the full API reference.',
  },
  ...(
    [
      ['README', '', 'Overview', 'What a module of the Forge app is, the six kinds, how the registry loads them, and what is built and what is designed.'],
      ['first-module', 'first-module', 'Write your first module', 'Build a look and a photo filter for the Forge app, run the app on your computer, test them and send them as a pull request.'],
      ['list', 'list', 'Module list', 'Every module bundled with the Forge app: what it does, what it needs, where it works and what it costs.'],
      ['fund', 'fund', 'Fund', 'Reference for fund modules: the ways to put money into a Forge balance.'],
      ['voice-in', 'voice-in', 'Voice in', 'Reference for voice-in modules: how Hold to talk turns speech into words.'],
      ['voice-out', 'voice-out', 'Voice out', 'Reference for voice-out modules: how the Forge app reads an answer aloud.'],
      ['filter', 'filter', 'Filter', 'Reference for filter modules: the photo checks of Share unseen.'],
      ['look', 'look', 'Look', 'Reference for look modules: the colours of the Forge app.'],
      ['mode', 'mode', 'Mode', 'Reference for mode modules: the home and the answer screen of the Forge app.'],
      ['engine', 'engine', 'Engine modules', 'The gateway side: the supplier interface for AI models and the funding methods.'],
    ] as const
  ).map(([file, path, nav, description]) => ({
    src: `docs/modules/${file}.md`,
    out: path ? `public/docs/modules/${path}/index.html` : 'public/docs/modules/index.html',
    url: path ? `/docs/modules/${path}` : '/docs/modules/',
    group: 'Modules' as const,
    nav,
    crumb: 'Modules',
    description,
  })),
];

/** The heading form that documents an endpoint: `METHOD /path`. */
export const ENDPOINT = /^(GET|POST) (\/\S*)$/;

/** Every `METHOD /path` documented by a level-3 heading in the Markdown, in order. */
export function documentedRoutes(md: string): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const m of md.matchAll(/^### `([^`]+)`\s*$/gm)) {
    const e = ENDPOINT.exec(m[1]!);
    if (e) out.push({ method: e[1]!, path: e[2]! });
  }
  return out;
}

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** The id a heading gets: its text in lower case, words joined by dashes. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface NavItem {
  depth: number;
  id: string;
  html: string;
}

/** A link in a page's Markdown as the page writes it: another page's address, or the link as it was. */
function pageLink(page: Page, href: string): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return href;
  const [path = '', hash = ''] = href.split('#');
  const target = PAGES.find((p) => p.src === posix.normalize(posix.join(posix.dirname(page.src), path)));
  if (!target) throw new Error(`${page.src}: the link ${href} is not to a page of the docs (link a file in the repository by its GitHub address)`);
  return target.url + (hash ? `#${hash}` : '');
}

/** The list of pages on the left, the page shown marked. */
function pagesNav(current: Page): string {
  const out: string[] = ['<nav class="pages" aria-label="Pages">'];
  for (const group of ['API', 'Modules'] as const) {
    out.push(`<p class="pages-head">${group}</p><ul>`);
    for (const p of PAGES.filter((x) => x.group === group)) out.push(`<li><a href="${p.url}"${p === current ? ' aria-current="page"' : ''}>${esc(p.nav)}</a></li>`);
    out.push('</ul>');
  }
  out.push('</nav>');
  return out.join('\n');
}

/** A page rendered: its HTML and the ids of its headings. */
export interface Rendered {
  page: Page;
  html: string;
  ids: Set<string>;
}

/** Renders one page from its Markdown. Pure: the same Markdown gives the same bytes. */
export function renderPage(page: Page, md: string): Rendered {
  const nav: NavItem[] = [];
  const ids = new Set<string>();
  let title = '';
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(t: { type: string; href?: string }) {
      if (t.type === 'link' && t.href) t.href = pageLink(page, t.href);
    },
    renderer: {
      heading(this: any, t: { tokens: unknown[]; depth: number; text: string }) {
        const inner: string = this.parser.parseInline(t.tokens);
        if (t.depth === 1) {
          title = t.text;
          return `<h1 id="top">${inner}</h1>\n`;
        }
        const endpoint = /^`([^`]+)`$/.test(t.text.trim()) ? ENDPOINT.exec(t.text.trim().slice(1, -1)) : null;
        const id = slug(endpoint ? `${endpoint[1]} ${endpoint[2]}` : t.text);
        if (!id || ids.has(id)) throw new Error(`${page.src}: heading id "${id}" is empty or used twice: ${t.text}`);
        ids.add(id);
        const body = endpoint ? `<span class="verb verb-${endpoint[1]!.toLowerCase()}">${endpoint[1]}</span> <code>${esc(endpoint[2]!)}</code>` : inner;
        if (t.depth <= 3) nav.push({ depth: t.depth, id, html: body });
        const cls = endpoint ? ' class="endpoint"' : '';
        return `<h${t.depth} id="${id}"${cls}>${body}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${t.depth}>\n`;
      },
      code(t: { text: string; lang?: string }) {
        const lang = (t.lang ?? '').trim().split(/\s+/)[0] ?? '';
        const known = lang && lang !== 'text' && hljs.getLanguage(lang);
        const code = known ? hljs.highlight(t.text, { language: lang }).value : esc(t.text);
        const label = lang && lang !== 'text' ? `<span class="lang">${esc(lang)}</span>` : '';
        return `<div class="code">${label}<button type="button" class="copy" aria-label="Copy code">Copy</button><pre><code class="hljs${known ? ` language-${lang}` : ''}">${code}</code></pre></div>\n`;
      },
    },
  });
  let body = marked.parse(md);
  body = body.replaceAll('<table>', '<div class="table-wrap"><table>').replaceAll('</table>', '</table></div>');

  // Every link inside the page must land on a heading.
  for (const m of body.matchAll(/href="#([^"]+)"/g)) {
    if (m[1] !== 'top' && !ids.has(m[1]!)) throw new Error(`${page.src}: link to #${m[1]} has no heading`);
  }

  const navHtml: string[] = [];
  let open = false;
  for (const n of nav) {
    if (n.depth === 2) {
      if (open) navHtml.push('</ul></li>');
      navHtml.push(`<li><a href="#${n.id}">${n.html}</a><ul>`);
      open = true;
    } else {
      navHtml.push(`<li><a href="#${n.id}">${n.html}</a></li>`);
    }
  }
  if (open) navHtml.push('</ul></li>');

  const plainTitle = title.replace(/`/g, '');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(page.group === 'API' ? plainTitle : `${plainTitle} | Forge AI`)}</title>
<meta name="description" content="${esc(page.description)}">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0B0D10">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/docs/docs.css">
<noscript><style>@media (max-width: 960px) { .side { display: block; position: static; } .menu-btn { display: none; } }</style></noscript>
<script src="/docs/docs.js" defer></script>
</head>
<body>
<!-- Generated from ${page.src} by scripts/build-docs.ts. Edit the Markdown, then run: node scripts/build-docs.ts -->
<a class="skip" href="#content">Skip to the content</a>
<header class="top">
<a class="brand" href="/" aria-label="Forge AI home"><svg viewBox="0 0 26 18" aria-hidden="true"><path fill="currentColor" d="M0 2.6 6.2 0H25v5.2h-4.6c-1.5 1.3-2.1 3.6-2.1 5.9H23V18H6v-6.9h5.1c0-2.3-.6-4.6-2.1-5.9H6.2Z"/></svg><span>FORGE</span><span class="ai">AI</span></a>
<span class="crumb">${esc(page.crumb)}</span>
<span class="spacer"></span>
<a class="top-link" href="/v2/">Open the app</a>
<button type="button" class="menu-btn" aria-controls="toc" aria-expanded="false">Sections</button>
</header>
<div class="layout">
<aside class="side" id="toc">
${pagesNav(page)}
<nav aria-label="Sections"><ul>
${navHtml.join('\n')}
</ul></nav>
</aside>
<main class="doc" id="content">
${body}
<footer class="foot"><p>Forge AI. Generated from <code>${esc(page.src)}</code>. <a href="#top">Back to the top</a></p></footer>
</main>
</div>
</body>
</html>
`;
  return { page, html, ids };
}

/** Renders docs/API.md into the full API page. */
export function renderApiDocs(md: string): string {
  return renderPage(PAGES[0]!, md).html;
}

/**
 * Renders every page from its Markdown (read with `read`, given the source's path from the repository
 * root) and checks that every link from one page to another lands on a heading there.
 */
export function buildSite(read: (src: string) => string = (src) => readFileSync(abs(src), 'utf8')): Rendered[] {
  const all = PAGES.map((p) => renderPage(p, read(p.src)));
  const byUrl = new Map(all.map((r) => [r.page.url, r]));
  for (const r of all) {
    for (const m of r.html.matchAll(/href="(\/docs\/[^"#]*)(?:#([^"]*))?"/g)) {
      if (m[1] === '/docs/docs.css') continue;
      const target = byUrl.get(m[1]!);
      if (!target) throw new Error(`${r.page.src}: link to ${m[1]} is not a page of the docs`);
      if (m[2] && m[2] !== 'top' && !target.ids.has(m[2])) throw new Error(`${r.page.src}: link to ${m[1]}#${m[2]} has no heading there`);
    }
  }
  return all;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const r of buildSite()) {
    const out = abs(r.page.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.html);
    console.log(`wrote ${r.page.out}`);
  }
}
