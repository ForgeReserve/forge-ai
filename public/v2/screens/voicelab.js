// The voice lab (#/voice-lab): a developer page, linked from no menu. It reads the fixed corpus
// (core/voicelab.js) with each voice this phone can run and records, per line, the time to the first
// sound, the real-time factor, gaps a listener would hear, and broken sound (NaN or silence), plus the
// model's load time and the memory the browser reports. The results are saved as a JSON file the owner
// sends on. Nothing here is sent anywhere.
import { meterNumbers, soundCheck } from '../core/phonon.js';
import { backHeader, copy, el, meterBar, toast } from '../core/ui.js';
import { CANDIDATES, CORPUS, report, summarize, virtualUnderruns } from '../core/voicelab.js';

const now = () => performance.now();
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const message = (e) => String(e?.message ?? e).slice(0, 300);

/** Memory the browser measures for this page (needs a cross-origin isolated page), or null. */
async function pageMemory() {
  const heap = performance.memory?.usedJSHeapSize ?? null;
  let total = null;
  if (globalThis.crossOriginIsolated && typeof performance.measureUserAgentSpecificMemory === 'function') {
    total = await Promise.race([performance.measureUserAgentSpecificMemory().then((m) => m.bytes), new Promise((res) => setTimeout(() => res(null), 20_000))]).catch(() => null);
  }
  return { jsHeapBytes: heap, pageBytes: total };
}

async function gpuInfo() {
  try {
    const a = await navigator.gpu?.requestAdapter();
    if (!a) return null;
    const i = a.info ?? {};
    return { vendor: i.vendor ?? '', architecture: i.architecture ?? '', fallback: !!(i.isFallbackAdapter ?? a.isFallbackAdapter) };
  } catch {
    return null;
  }
}

export function voiceLabScreen({ t, back, phonon, speaker, native = null }) {
  const yes = (b) => (b == null ? t('lab.unknown') : b ? t('lab.yes') : t('lab.no'));
  const envList = el('ul', { class: 'lab-env', id: 'labEnv' });
  const voiceSel = el('select', { id: 'labVoice', class: 'lab-select', 'aria-label': t('lab.voice') });
  const boxes = Object.fromEntries(CANDIDATES.map((c) => [c.id, el('input', { type: 'checkbox', id: `lab-${c.id}`, checked: true })]));
  const play = el('input', { type: 'checkbox', id: 'labPlay' });
  // How many corpus lines a run reads: all of them by default, fewer for a quick look on a slow phone.
  const linesSel = el('select', { id: 'labLines', class: 'lab-select', 'aria-label': t('lab.lines') });
  for (const n of [CORPUS.length, 10, 3]) linesSel.append(el('option', { value: String(n), text: String(n) }));
  let lines = CORPUS;
  const runBtn = el('button', { type: 'button', class: 'btn primary block', id: 'labRun', text: t('lab.run') });
  const stopBtn = el('button', { type: 'button', class: 'btn block', id: 'labStop', text: t('lab.stop'), hidden: true });
  const status = el('p', { class: 'hint', id: 'labStatus', role: 'status' });
  // The download, then the phases in words: Downloading, Getting ready, Reading line 3 of 10.
  const meter = meterBar({ id: 'labMeter', label: t('voiceDl.label') });
  meter.hidden = true;
  const errorLine = el('p', { class: 'hint lab-error', id: 'labError', role: 'alert', hidden: true });
  const retryBtn = el('button', { type: 'button', class: 'btn', id: 'labRetry', text: t('dl.retry'), hidden: true });
  const blockedNote = el('p', { class: 'hint lab-error', id: 'labBlocked', role: 'alert', hidden: true, text: t('lab.blocked') });
  const table = el('div', { class: 'lab-results', id: 'labResults' });
  const saveBtn = el('button', { type: 'button', class: 'btn', id: 'labSave', text: t('lab.save'), hidden: true });
  const copyBtn = el('button', { type: 'button', class: 'btn', id: 'labCopy', text: t('lab.copy'), hidden: true });

  let env = null;
  let result = null;
  let ctrl = null;

  (async () => {
    const index = await phonon.init().catch(() => null);
    const gpu = await gpuInfo();
    env = {
      userAgent: navigator.userAgent,
      app: native ? 'android' : 'web',
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      cores: navigator.hardwareConcurrency ?? null,
      deviceMemoryGb: navigator.deviceMemory ?? null,
      webgpu: gpu,
      phononFiles: index ? { revision: index.model.revision, firstBytes: index.firstBytes } : null,
      kokoro: 'not in this build',
    };
    envList.replaceChildren(
      el('li', { text: t('lab.isolated', { value: yes(env.crossOriginIsolated) }) }),
      el('li', { text: t('lab.cores', { value: env.cores ?? t('lab.unknown') }) }),
      el('li', { text: t('lab.memory', { value: env.deviceMemoryGb ?? t('lab.unknown') }) }),
      el('li', { text: t('lab.webgpu', { value: yes(!!gpu && !gpu.fallback) }) }),
      el('li', { text: index ? t('lab.files', { size: Math.round(index.firstBytes / 1e6) }) : t('lab.none') }),
      el('li', { text: t('lab.kokoro') }),
    );
    voiceSel.replaceChildren(...(index?.voices ?? []).map((v) => el('option', { value: v.name, text: v.name, selected: v.name === index.defaultVoice })));
    runBtn.disabled = !index && !(globalThis.speechSynthesis?.getVoices().length > 0);
  })().catch((e) => (status.textContent = t('lab.failed', { message: message(e) })));

  async function runPhonon(c, voice, signal, onRow) {
    const out = { id: c.id, device: c.device, threads: c.threads, rows: [] };
    const opts = { device: c.device, threads: c.threads };
    await phonon.unload(opts);
    let tts;
    let downloaded = false;
    const amount = (m) => t('dl.amount', meterNumbers(m));
    try {
      status.textContent = t('lab.loading', { name: t(`lab.c.${c.id}`) });
      meter.hidden = false;
      meter.set({ fraction: 0, text: amount({ total: phonon.index()?.firstBytes ?? 0 }), phase: t('dl.downloading') });
      let t0 = now();
      tts = await phonon.load({
        ...opts,
        onProgress: (p) => p.cached === false && (downloaded = true),
        onMeter: (m) => meter.set({ fraction: m.fraction, text: amount(m), phase: t(m.fraction >= 1 ? 'dl.ready' : 'dl.downloading') }),
      });
      out.loadColdMs = Math.round(now() - t0);
      out.downloaded = downloaded;
      meter.set({ fraction: 1, phase: t('dl.ready') });
      // phonon-tts keeps a download in the cache once the model has it, without waiting: give it a
      // moment, so the second load reads from the phone rather than downloading it all again.
      if (downloaded) await inCache(30_000);
      await phonon.unload(opts);
      t0 = now();
      tts = await phonon.load(opts);
      out.loadWarmMs = Math.round(now() - t0);
    } catch (e) {
      out.error = message(e);
      return out;
    }
    out.got = { device: tts.device, deviceReason: tts.deviceReason, threads: tts.threads, threadsReason: tts.threadsReason, features: tts.features };
    // The Run tap unlocked the sound (speaker.unlock). If the phone still keeps it off, measure without
    // playing and say so, rather than wait for sound that never ends.
    let playing = play.checked;
    if (playing && speaker.ready && !(await speaker.ready(1500))) {
      playing = false;
      out.audioBlocked = true;
      blockedNote.hidden = false;
    }
    for (const [i, item] of lines.entries()) {
      if (signal.aborted) break;
      meter.set({ phase: t('dl.reading', { n: i + 1, total: lines.length }) });
      const s0 = now();
      const arrivals = [];
      const durations = [];
      const chunks = [];
      const sp = playing ? speaker.stream({ sampleRate: tts.sampleRate }) : null;
      let row;
      try {
        for await (const pcm of tts.stream(item.text, { voice, signal })) {
          arrivals.push(now() - s0);
          durations.push((pcm.length / tts.sampleRate) * 1000);
          chunks.push(pcm);
          sp?.push(pcm);
        }
        const totalMs = now() - s0;
        sp?.end();
        if (sp) await sp.done;
        const chk = soundCheck(chunks);
        const audioS = chk.samples / tts.sampleRate;
        const v = virtualUnderruns(arrivals, durations);
        row = {
          id: item.id,
          kind: item.kind,
          chars: item.text.length,
          firstMs: r1(arrivals[0] ?? null),
          totalMs: r1(totalMs),
          audioS: r1(audioS),
          rtf: audioS > 0 ? Math.round((totalMs / 1000 / audioS) * 1000) / 1000 : null,
          underruns: sp ? sp.underruns() : v.underruns,
          stallMs: v.stallMs,
          played: !!sp,
          nan: chk.nan,
          silent: chk.silent,
          clipped: chk.clipped,
          peak: Math.round(chk.peak * 1000) / 1000,
        };
      } catch (e) {
        sp?.stop();
        if (signal.aborted) break;
        row = { id: item.id, kind: item.kind, error: message(e) };
      }
      out.rows.push(row);
      onRow(out.rows.length);
    }
    out.memory = await pageMemory();
    await phonon.unload(opts);
    return out;
  }

  /** The phone's own voice (speechSynthesis, voices that run on the phone): time to the first sound only. */
  async function runPhoneVoice(signal, onRow) {
    const out = { id: 'phone-voice', rows: [] };
    const voices = (globalThis.speechSynthesis?.getVoices() ?? []).filter((v) => v.localService && v.lang?.toLowerCase().startsWith('en'));
    if (!voices.length) {
      out.error = 'no voice of the phone runs on the phone';
      return out;
    }
    out.voice = `${voices[0].name} (${voices[0].lang})`;
    for (const item of lines) {
      if (signal.aborted) break;
      const row = await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(item.text);
        u.voice = voices[0];
        u.lang = voices[0].lang;
        const s0 = now();
        let start = null;
        const stop = () => speechSynthesis.cancel();
        signal.addEventListener('abort', stop, { once: true });
        u.onstart = () => (start = now() - s0);
        u.onend = () => resolve({ id: item.id, kind: item.kind, chars: item.text.length, firstMs: r1(start), totalMs: r1(now() - s0), audioS: start == null ? null : r1((now() - s0 - start) / 1000), rtf: null });
        u.onerror = (e) => resolve({ id: item.id, kind: item.kind, error: String(e.error ?? 'error') });
        speechSynthesis.speak(u);
      });
      out.rows.push(row);
      onRow(out.rows.length);
    }
    return out;
  }

  const fmt = (x, unit = '') => (x == null ? '-' : `${x}${unit}`);
  function draw(cands) {
    const head = el('tr', {}, ...['lab.col.voice', 'lab.col.loadCold', 'lab.col.loadWarm', 'lab.col.first', 'lab.col.rtf', 'lab.col.gaps', 'lab.col.bad'].map((k) => el('th', { text: t(k) })));
    const rows = cands.map((c) => {
      if (c.error) return el('tr', { 'data-candidate': c.id }, el('td', { text: t(`lab.c.${c.id}`) }), el('td', { colspan: '6', text: t('lab.failed', { message: c.error }) }));
      const s = summarize(c.rows);
      return el(
        'tr',
        { 'data-candidate': c.id },
        el('td', { text: t(`lab.c.${c.id}`) }),
        el('td', { text: fmt(c.loadColdMs, ' ms') }),
        el('td', { text: fmt(c.loadWarmMs, ' ms') }),
        el('td', { text: `${fmt(s.firstMs.median, ' ms')} / ${fmt(s.firstMs.p90, ' ms')}` }),
        el('td', { text: `${fmt(s.rtf.median)} / ${fmt(s.rtf.p90)}` }),
        el('td', { text: String(s.underruns) }),
        el('td', { text: String(s.failed + s.nanRuns + s.silentRuns) }),
      );
    });
    table.replaceChildren(el('table', {}, el('thead', {}, head), el('tbody', {}, ...rows)), el('p', { class: 'hint', text: t('lab.legend') }));
  }

  /** Resolves once the model is in the phone's cache (phonon.download says nothing is needed), or after ms. */
  async function inCache(ms) {
    const end = now() + ms;
    while (now() < end) {
      if (!(await phonon.download().catch(() => ({ needed: false }))).needed) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async function run() {
    // First, before any await: iPhone Safari starts sound only inside the tap itself.
    speaker.unlock?.();
    if (ctrl) return;
    blockedNote.hidden = true;
    errorLine.hidden = retryBtn.hidden = true;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    runBtn.hidden = true;
    stopBtn.hidden = false;
    saveBtn.hidden = copyBtn.hidden = true;
    const voice = voiceSel.value || null;
    lines = CORPUS.slice(0, Number(linesSel.value) || CORPUS.length);
    const chosen = CANDIDATES.filter((c) => boxes[c.id].checked);
    const done = [];
    for (const c of chosen) {
      if (signal.aborted) break;
      const onRow = (n) => (status.textContent = t('lab.progress', { done: n, total: lines.length, name: t(`lab.c.${c.id}`) }));
      done.push(c.engine === 'phonon' ? await runPhonon(c, voice, signal, onRow) : await runPhoneVoice(signal, onRow));
      draw(done);
      // A failed load says why at once, with Try again, rather than only in the table at the end.
      const failed = done.at(-1);
      if (failed.error && c.engine === 'phonon' && !signal.aborted) {
        errorLine.textContent = t('dl.failed', { message: failed.error });
        errorLine.hidden = retryBtn.hidden = false;
        meter.set({ phase: '' });
        // The other ways read the same files: stop here, and Try again starts the run over.
        break;
      }
    }
    if (errorLine.hidden) meter.hidden = true;
    result = report({ env, voice, candidates: done });
    status.textContent = signal.aborted ? t('lab.stopped') : errorLine.hidden ? t('lab.done') : t('lab.notDone');
    ctrl = null;
    runBtn.hidden = false;
    stopBtn.hidden = true;
    saveBtn.hidden = copyBtn.hidden = false;
  }
  runBtn.addEventListener('click', run);
  retryBtn.addEventListener('click', run);
  stopBtn.addEventListener('click', () => ctrl?.abort());
  saveBtn.addEventListener('click', () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `forge-voice-lab-${result.at.replace(/[:.]/g, '-')}.json`, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  copyBtn.addEventListener('click', async () => result && toast((await copy(JSON.stringify(result))) ? t('lab.copied') : t('lab.copyFailed')));

  const label = (input, text) => el('label', { class: 'lab-check' }, input, el('span', { text }));
  const main = el(
    'main',
    { class: 'screen sub voicelab', 'data-screen': 'voiceLab' },
    backHeader(t('lab.title'), () => {
      ctrl?.abort();
      back();
    }, t('common.back')),
    el(
      'div',
      { class: 'scroll' },
      el('p', { class: 'hint', text: t('lab.lead', { count: CORPUS.length }) }),
      envList,
      el('label', { class: 'lab-check', for: 'labVoice' }, el('span', { text: t('lab.voice') }), voiceSel),
      el('label', { class: 'lab-check', for: 'labLines' }, el('span', { text: t('lab.lines') }), linesSel),
      el('h2', { class: 'caps', text: t('lab.candidates') }),
      ...CANDIDATES.map((c) => label(boxes[c.id], t(`lab.c.${c.id}`))),
      label(play, t('lab.play')),
      runBtn,
      stopBtn,
      status,
      meter,
      errorLine,
      retryBtn,
      blockedNote,
      table,
      el('div', { class: 'row-btns' }, saveBtn, copyBtn),
    ),
  );
  return { node: main, update: () => {}, focus: main.querySelector('h1') };
}
