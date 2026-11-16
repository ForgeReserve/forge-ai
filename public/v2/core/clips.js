// Listen on the first run: clips recorded once, offline, in the app's natural voice (Phonon 31m English,
// voice Maeve; scripts/record-voice), one per step, in public/v2/voice/en/. They play on the phone, cost nothing and
// send nothing anywhere; the service worker keeps them for offline use. A clip plays only when it was
// recorded from exactly the words the step shows now (its manifest keeps them); otherwise, or when it
// cannot play, Listen falls back to the phone's own voice.

/** The clip file for a step, when the manifest has one recorded from exactly these words. Pure. */
export function clipFor(manifest, step, pieces) {
  const c = manifest?.clips?.[step];
  if (!c || typeof c.file !== 'string' || !/^[a-z0-9-]+\.(ogg|m4a|mp3|wav)$/.test(c.file)) return null;
  if (!Array.isArray(c.text) || c.text.length !== pieces.length || c.text.some((x, i) => x !== pieces[i])) return null;
  return c.file;
}

/**
 * The clip player. base: the clips' folder URL. fetch and makeAudio are replaceable for tests.
 * load() reads the manifest once (a missing one means no clips: Listen uses the phone's voice).
 */
export function createClips({ base, fetch: f = (...a) => globalThis.fetch(...a), makeAudio = (src) => new Audio(src), objectUrl = globalThis.URL } = {}) {
  let manifest = null;
  let loading = null;
  return {
    load() {
      loading ??= (async () => {
        try {
          const res = await f(new URL('manifest.json', base).href);
          manifest = res.ok ? await res.json() : null;
        } catch {
          manifest = null;
        }
        return manifest;
      })();
      return loading;
    },
    has: (step, pieces) => !!clipFor(manifest, step, pieces),
    /**
     * Plays the step's clip. Returns {done, stop()}, or null when there is no clip for these words.
     * done settles when the clip ends or is stopped, and rejects when it cannot be played.
     */
    play(step, pieces) {
      const file = clipFor(manifest, step, pieces);
      if (!file) return null;
      let audio = null;
      let url = null;
      let stopped = false;
      let finish;
      const done = new Promise((resolve, reject) => {
        finish = { resolve, reject };
      });
      const clean = () => {
        if (audio) {
          audio.pause();
          audio.removeAttribute?.('src');
        }
        if (url) objectUrl.revokeObjectURL(url);
        audio = null;
        url = null;
      };
      (async () => {
        try {
          // Fetched whole (not streamed by the media element), so the service worker's copy serves it offline.
          const res = await f(new URL(file, base).href);
          if (!res.ok) throw new Error(`clip ${file}: HTTP ${res.status}`);
          // Typed here too: a copy cached before the server sent audio/ogg says octet-stream, which Safari will not play.
          const raw = await res.blob();
          const blob = file.endsWith('.ogg') && raw.type !== 'audio/ogg' ? new Blob([raw], { type: 'audio/ogg' }) : raw;
          if (stopped) return;
          url = objectUrl.createObjectURL(blob);
          audio = makeAudio(url);
          audio.addEventListener('ended', () => (clean(), finish.resolve()));
          audio.addEventListener('error', () => (clean(), finish.reject(new Error(`clip ${file} cannot be played here`))));
          await audio.play();
        } catch (e) {
          clean();
          if (stopped) finish.resolve();
          else finish.reject(e);
        }
      })();
      return {
        done,
        stop() {
          stopped = true;
          clean();
          finish.resolve();
        },
      };
    },
  };
}
