// Forge AI API guide (/docs/): copy buttons, the section menu on phones, and the current section in the
// nav. The page works without it: the nav is then shown in full and code is selected by hand.
(() => {
  const side = document.getElementById('toc');
  const menu = document.querySelector('.menu-btn');

  // Copy buttons.
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  };
  for (const btn of document.querySelectorAll('.code .copy')) {
    btn.addEventListener('click', async () => {
      const code = btn.parentElement.querySelector('pre code');
      const ok = await copyText(code ? code.textContent : '');
      btn.textContent = ok ? 'Copied' : 'Select and copy';
      btn.classList.toggle('done', ok);
      btn.classList.toggle('failed', !ok);
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('done', 'failed');
      }, 1600);
    });
  }

  // The section menu on narrow screens.
  const setOpen = (open) => {
    side.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.textContent = open ? 'Close' : 'Sections';
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) reveal();
  };
  menu.addEventListener('click', () => setOpen(!side.classList.contains('open')));
  side.addEventListener('click', (e) => {
    if (e.target.closest('a') && side.classList.contains('open')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && side.classList.contains('open')) {
      setOpen(false);
      menu.focus();
    }
  });
  matchMedia('(min-width: 961px)').addEventListener('change', (e) => e.matches && setOpen(false));

  // The section being read, marked in the nav.
  const links = new Map();
  for (const a of side.querySelectorAll('a[href^="#"]')) links.set(a.getAttribute('href').slice(1), a);
  const heads = [...document.querySelectorAll('.doc h2[id], .doc h3[id]')].filter((h) => links.has(h.id));
  let current = null;
  const mark = () => {
    const line = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 72;
    let pick = heads[0];
    for (const h of heads) {
      if (h.getBoundingClientRect().top - line <= 8) pick = h;
      else break;
    }
    const a = pick && links.get(pick.id);
    if (!a || a === current) return;
    current?.removeAttribute('aria-current');
    a.setAttribute('aria-current', 'true');
    current = a;
    reveal();
  };
  // Keep the current link in view inside the sidebar, without moving the page.
  function reveal() {
    if (!current || side.scrollHeight <= side.clientHeight) return;
    const top = current.getBoundingClientRect().top - side.getBoundingClientRect().top + side.scrollTop;
    if (top < side.scrollTop + 40 || top > side.scrollTop + side.clientHeight - 80) side.scrollTop = Math.max(0, top - side.clientHeight / 3);
  }
  let queued = false;
  addEventListener(
    'scroll',
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        mark();
      });
    },
    { passive: true },
  );
  addEventListener('hashchange', mark);
  addEventListener('load', mark);
  mark();
})();
