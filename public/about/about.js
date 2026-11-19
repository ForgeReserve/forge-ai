// The landing page at /about: the look this phone keeps from the app (else Midnight), and the two
// download buttons. Each button's link is its data-href in index.html. While that is empty the button
// shows Soon and is no link; once it is set the button links there and Soon goes.
import { applyPageLook } from '/v2/core/pagelook.js';

applyPageLook();

for (const a of document.querySelectorAll('a[data-download]')) {
  const href = (a.dataset.href ?? '').trim();
  if (!href) {
    a.removeAttribute('href');
    continue;
  }
  a.href = href;
  a.querySelector('.soon')?.remove();
}
