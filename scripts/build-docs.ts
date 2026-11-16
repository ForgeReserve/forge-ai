/**
 * Builds the public API guide, public/docs/index.html, from docs/API.md.
 *
 *   pnpm build:docs          # node scripts/build-docs.ts: writes public/docs/index.html
 *
 * docs/API.md is the source. The page is the Markdown rendered with the vendored marked
 * (public/vendor/marked.js), code highlighted at build time with the vendored highlight.js, inside a
 * fixed page shell: section nav, anchor links on every heading, a copy button on every code block. The
 * page's own style and script are public/docs/docs.css and public/docs/docs.js; it loads nothing from
 * another origin. test/unit/api-docs.test.ts fails when the checked-in page and the Markdown drift.
 *
 * An endpoint is documented by a level-3 heading of the form ### `GET /v1/models`. The same test checks
 * those headings against the gateway's routes, both ways.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
export const API_MD = fileURLToPath(new URL('docs/API.md', ROOT));
export const DOCS_HTML = fileURLToPath(new URL('public/docs/index.html', ROOT));

const { Marked }: { Marked: new (...a: any[]) => { parse(md: string): string; use(ext: object): unknown } } = await import(new URL('public/vendor/marked.js', ROOT).href as string);
const hljs: { highlight(code: string, o: { language: string }): { value: string }; getLanguage(l: string): unknown } = (
  await import(new URL('public/vendor/highlight.js', ROOT).href as string)
).default;

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

/** Renders docs/API.md into the full page. Pure: the same Markdown gives the same bytes. */
export function renderApiDocs(md: string): string {
  const nav: NavItem[] = [];
  const ids = new Set<string>();
  let title = '';
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: any, t: { tokens: unknown[]; depth: number; text: string }) {
        const inner: string = this.parser.parseInline(t.tokens);
        if (t.depth === 1) {
          title = t.text;
          return `<h1 id="top">${inner}</h1>\n`;
        }
        const endpoint = /^`([^`]+)`$/.test(t.text.trim()) ? ENDPOINT.exec(t.text.trim().slice(1, -1)) : null;
        const id = slug(endpoint ? `${endpoint[1]} ${endpoint[2]}` : t.text);
        if (!id || ids.has(id)) throw new Error(`heading id "${id}" is empty or used twice: ${t.text}`);
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
    if (m[1] !== 'top' && !ids.has(m[1]!)) throw new Error(`link to #${m[1]} has no heading`);
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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="Build on Forge AI: an OpenAI-compatible AI gateway paid with eCash. Quickstart, payments, private models and the full API reference.">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0B0D10">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/docs/docs.css">
<noscript><style>@media (max-width: 960px) { .side { display: block; position: static; } .menu-btn { display: none; } }</style></noscript>
<script src="/docs/docs.js" defer></script>
</head>
<body>
<!-- Generated from docs/API.md by scripts/build-docs.ts. Edit the Markdown, then run: node scripts/build-docs.ts -->
<a class="skip" href="#content">Skip to the content</a>
<header class="top">
<a class="brand" href="/" aria-label="Forge AI home"><svg viewBox="0 0 26 18" aria-hidden="true"><path fill="currentColor" d="M0 2.6 6.2 0H25v5.2h-4.6c-1.5 1.3-2.1 3.6-2.1 5.9H23V18H6v-6.9h5.1c0-2.3-.6-4.6-2.1-5.9H6.2Z"/></svg><span>FORGE</span><span class="ai">AI</span></a>
<span class="crumb">API</span>
<span class="spacer"></span>
<a class="top-link" href="/v2/">Open the app</a>
<button type="button" class="menu-btn" aria-controls="toc" aria-expanded="false">Sections</button>
</header>
<div class="layout">
<aside class="side" id="toc">
<nav aria-label="Sections"><ul>
${navHtml.join('\n')}
</ul></nav>
</aside>
<main class="doc" id="content">
${body}
<footer class="foot"><p>Forge AI. Generated from <code>docs/API.md</code>. <a href="#top">Back to the top</a></p></footer>
</main>
</div>
</body>
</html>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(DOCS_HTML, renderApiDocs(readFileSync(API_MD, 'utf8')));
  console.log(`wrote ${DOCS_HTML}`);
}
