// The engine address setting (More, Engine). Pure, tested in Node.
//
// An engine is reached over HTTPS only. Plain http is taken only for this computer (localhost and
// 127.x.x.x), for testing; the Android app refuses it anyway. The address is kept without a trailing
// slash, so the engine client adds its /v1/... paths to it.

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Checks what the person typed. Returns {ok: true, value} or {ok: false, why}, why one of 'empty',
 * 'invalid' (not an address), 'insecure' (http to another computer) or 'extra' (a login, query or
 * fragment, which an engine address never has).
 */
export function normalizeEngine(input) {
  let s = String(input ?? '').trim();
  if (!s) return { ok: false, why: 'empty' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, why: 'invalid' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'invalid' };
  if (!u.hostname || /\s/.test(s)) return { ok: false, why: 'invalid' };
  if (u.username || u.password || u.search || u.hash) return { ok: false, why: 'extra' };
  if (u.protocol === 'http:' && !LOOPBACK.test(u.hostname)) return { ok: false, why: 'insecure' };
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, value: `${u.protocol}//${u.host}${path}` };
}

/** The address as the screens show it: the host (and path), without https://. '' means this site. */
export function engineLabel(base) {
  if (!base) return '';
  try {
    const u = new URL(base);
    return (u.protocol === 'https:' ? '' : `${u.protocol}//`) + u.host + u.pathname.replace(/\/+$/, '');
  } catch {
    return String(base);
  }
}
