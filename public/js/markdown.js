// Markdown for model output. Model text is untrusted: raw HTML in it is shown as text, remote images
// become links (loading them would leak the reader's IP to whoever the model names), and the HTML that
// marked produces is sanitized by DOMPurify before it touches the page.
import { Marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return esc(text);
    },
    image({ href, text }) {
      const label = text || 'image';
      return /^https?:/i.test(href ?? '') ? `<a class="md-img" href="${esc(href)}">[${esc(label)}]</a>` : `[${esc(label)}]`;
    },
    code({ text, lang }) {
      const l = (lang ?? '').trim().split(/\s+/)[0].replace(/[^\w+#.-]/g, '').slice(0, 24);
      return `<div class="code"><div class="code-head"><span>${esc(l || 'text')}</span></div><pre><code${l ? ` class="language-${esc(l)}"` : ''}>${esc(text.replace(/\n$/, ''))}</code></pre></div>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

const PURIFY = {
  ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'input', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
  ALLOWED_ATTR: ['href', 'class', 'checked', 'disabled', 'type', 'align', 'start'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
};

export function renderMarkdown(text) {
  const html = marked.parse(text ?? '').replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  return DOMPurify.sanitize(html, PURIFY);
}

let hljsP = null;
/** Adds copy buttons and (lazily loaded) syntax highlighting to finished code blocks. */
export function enhance(root) {
  const blocks = root.querySelectorAll('.code');
  for (const b of blocks) {
    const head = b.querySelector('.code-head');
    if (head && !head.querySelector('button')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn copy-code';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code');
      head.append(btn);
    }
  }
  const todo = [...root.querySelectorAll('pre code:not([data-hl])')];
  if (!todo.length) return;
  hljsP ??= import('../vendor/highlight.js').then((m) => m.default ?? m.hljs ?? m);
  hljsP
    .then((hljs) => {
      for (const c of todo) {
        if (!c.isConnected) continue;
        c.setAttribute('data-hl', '1');
        const lang = /language-([\w+#.-]+)/.exec(c.className)?.[1];
        try {
          const out = lang && hljs.getLanguage(lang) ? hljs.highlight(c.textContent, { language: lang, ignoreIllegals: true }) : c.textContent.length < 20000 ? hljs.highlightAuto(c.textContent) : null;
          if (out) c.innerHTML = DOMPurify.sanitize(out.value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
        } catch {
          /* leave it plain */
        }
      }
    })
    .catch(() => {});
}
