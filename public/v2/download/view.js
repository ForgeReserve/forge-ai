// What the /download page shows, from GET /download/info. Pure, tested in Node.

/** {available, size, sha256} -> the parts the page draws. fallback is the file's address when info has none. */
export function apkView(info, fallback = '/download/forge.apk') {
  const ok = !!info?.available && typeof info.sha256 === 'string' && /^[0-9a-f]{64}$/.test(info.sha256) && Number.isFinite(info.size) && info.size > 0;
  if (!ok) return { available: false };
  return {
    available: true,
    url: typeof info.url === 'string' && info.url.startsWith('/') ? info.url : fallback,
    // Megabytes with one decimal, never 0.0.
    mb: Math.max(0.1, Math.round(info.size / 104857.6) / 10).toFixed(1),
    // In groups of eight, so it can be read out and compared.
    hash: info.sha256.match(/.{8}/g).join(' '),
  };
}

/**
 * The APKs to offer, in order: Android (Forge, for every phone) and GrapheneOS (Forge Private Voice, with
 * its own speech to text; only when the site has it, info.privateVoice). Each is {id, icon, file, ...apkView}.
 */
export function apkChoices(info) {
  const out = [];
  const android = apkView(info);
  if (android.available) out.push({ id: 'android', icon: 'phone', file: 'forge.apk', ...android });
  const graphene = apkView(info?.privateVoice, '/download/forge-private-voice.apk');
  if (graphene.available) out.push({ id: 'graphene', icon: 'shield', file: 'forge-private-voice.apk', ...graphene });
  return out;
}
