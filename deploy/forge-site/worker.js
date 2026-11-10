// Cloudflare Worker "forge-site": serves the Forge website on forge-reserve.com.
// The pages come from the mint server (forge.flashapp.me); the mint's own address stays forge.flashapp.me.
const ORIGIN = 'https://forge.flashapp.me';
const CANON = 'forge-reserve.com';
const AI_SECTION = `<section id="ai"><style>#ai .ai-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:40px;align-items:center}@media (max-width:760px){#ai .ai-row{grid-template-columns:1fr;gap:22px}}#ai p:not(.kicker){color:var(--ink2);margin:0 0 12px;max-width:640px}#ai .ai-join{display:inline-flex;align-items:center;gap:10px;padding:13px 20px;border-radius:12px;font-weight:600;text-decoration:none;background:var(--ink);color:var(--bg);white-space:nowrap}#ai .ai-join:hover{opacity:.9}</style>
  <div class="wrap ai-row">
    <div>
      <p class="kicker">Private beta</p>
      <h2>Forge AI</h2>
      <p>Chat with capable open AI models and pay for each message with Forge eCash, in dollars or sats, straight from your Cashu wallet. Agents can pay the same way, one request at a time.</p>
      <p>Forge AI is invite-only while we test it. Join the waitlist and we will send you an invite.</p>
    </div>
    <a class="ai-join" href="https://ai.forge-reserve.com/beta/">Join the waitlist <span aria-hidden="true">&rarr;</span></a>
  </div>
</section>
`;
export default {
  async fetch(req) {
    const u = new URL(req.url);
    // One public name for the site: forgereserve.org and the www names redirect here.
    if (u.hostname !== CANON) return Response.redirect('https://' + CANON + u.pathname + u.search, 301);
    // The mint's address stays forge.flashapp.me, so wallets only ever see one mint URL.
    if (u.pathname.startsWith('/v1/') || u.pathname === '/v1') return Response.redirect(ORIGIN + u.pathname + u.search, 302);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    const r = await fetch(ORIGIN + u.pathname + u.search, {
      method: req.method,
      headers: { accept: req.headers.get('accept') || '*/*' },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    const h = new Headers(r.headers);
    h.delete('set-cookie');
    h.delete('content-length');
    h.set('x-served-from', 'forge.flashapp.me');
    const res = new Response(r.body, { status: r.status, headers: h });
    // The homepage gains the Forge AI section and a nav link; the page on the mint server is unchanged.
    if (u.pathname === '/' && r.ok && (h.get('content-type') || '').includes('text/html')) {
      return new HTMLRewriter()
        .on('nav.site-nav a.cta', { element(e) { e.before('<a class="opt" href="/#ai">Forge AI</a>', { html: true }); } })
        .on('section#faq', { element(e) { e.before(AI_SECTION, { html: true }); } })
        .transform(res);
    }
    return res;
  },
};
