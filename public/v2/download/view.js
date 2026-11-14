// What the /download page shows, from GET /download/info. Pure, tested in Node.

/** {available, size, sha256} -> the parts the page draws. */
export function apkView(info) {
  const ok = !!info?.available && typeof info.sha256 === 'string' && /^[0-9a-f]{64}$/.test(info.sha256) && Number.isFinite(info.size) && info.size > 0;
  if (!ok) return { available: false };
  return {
    available: true,
    url: typeof info.url === 'string' && info.url.startsWith('/') ? info.url : '/download/forge.apk',
    // Megabytes with one decimal, never 0.0.
    mb: Math.max(0.1, Math.round(info.size / 104857.6) / 10).toFixed(1),
    // In groups of eight, so it can be read out and compared.
    hash: info.sha256.match(/.{8}/g).join(' '),
  };
}
