// The voice lab (#/voice-lab): a developer page, linked from no menu. It reads the fixed corpus
// (core/voicelab.js) with each voice this phone can run and records, per line, the time to the first
// sound, the real-time factor, gaps a listener would hear, and broken sound (NaN or silence), plus the
// model's load time and the memory the browser reports. The results are saved as a JSON file the owner
// sends on. Nothing here is sent anywhere.
import { gpuInfo, meterNumbers, soundCheck } from '../core/phonon.js';
import { backHeader, copy, el, meterBar, toast } from '../core/ui.js';
import { CANDIDATES, CORPUS, candidateError, nativeRow, phoneVoices, readLine, report, speakLine, summarize, untilAborted, virtualUnderruns, waitForVoices } from '../core/voicelab.js';

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

/** Speaks a silent utterance inside a tap, as iOS wants before a page may speak later; asks for the voice list. */
function unlockSpeech() {
  try {
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance !== 'function') return;
    synth.getVoices();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
  } catch {
    /* no speech here */
  }
}

/**
 * nativeVoice: the Android app's native voice (core/native.js), or null on the website. Its candidates
 * show only when this phone runs it. A debug build of the app can start a run from adb
 * (MainActivity, forge.labAuto): it sets globalThis.__forgeLabAuto = {candidates, lines}, and the
 * results are then kept in the app's own files (ForgeVoice saveLab) for adb to read (docs/VOICE.md).
 */
export function voiceLabScreen({ t, back, phonon, speaker, native = null, nativeVoice = null }) {
  const yes = (b) => (b == null ? t('lab.unknown') : b ? t('lab.yes') : t('lab.no'));
  const envList = el('ul', { class: 'lab-env', id: 'labEnv' });
  const voiceSel = el('select', { id: 'labVoice', class: 'lab-select', 'aria-label': t('lab.voice') });
  // Under the list: what an accent-test voice is, with its description from the voice catalog.
  const voiceNote = el('p', { class: 'hint', id: 'labVoiceNote', hidden: true });
  /** The lab voice picked (index.labVoices: lab-only or accent-test), or null for one of the app's voices. */
  const labVoice = () => phonon.index()?.labVoices?.find((v) => v.name === voiceSel.value) ?? null;
  const showVoiceNote = () => {
    const v = labVoice()?.use === 'accent-test' ? labVoice() : null;
    voiceNote.hidden = !v;
    voiceNote.textContent = v ? t('lab.accentNote', { locale: t(`lab.locale.${v.locale}`), description: v.description }) : '';
  };
  voiceSel.addEventListener('change', showVoiceNote);
  const boxes = Object.fromEntries(CANDIDATES.map((c) => [c.id, el('input', { type: 'checkbox', id: `lab-${c.id}`, checked: true })]));
  // The native candidates and the app's thread count: shown once the app says this phone runs it.
  let nativeOn = false;
  const nativeRows = [];
  const threadsSel = el('select', { id: 'labAppThreads', class: 'lab-select', 'aria-label': t('lab.appThreads') });
  threadsSel.addEventListener('change', () => nativeVoice?.config(Number(threadsSel.value) || 0).catch(() => {}));
  const threadsRow = el('label', { class: 'lab-check', for: 'labAppThreads', hidden: true }, el('span', { text: t('lab.appThreads') }), threadsSel);
  nativeRows.push(threadsRow);
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

  const ready = (async () => {
    const index = await phonon.init().catch(() => null);
    const gpu = await gpuInfo();
    // Where the app itself reads with the natural voice on this phone (core/phonon.js chooseVoiceDevice).
    const appDevice = await phonon.device?.().catch(() => null);
    const nst = nativeVoice ? await nativeVoice.status().catch(() => null) : null;
    nativeOn = nst?.available === true;
    env = {
      userAgent: navigator.userAgent,
      app: native ? 'android' : 'web',
      native: nst,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      cores: navigator.hardwareConcurrency ?? null,
      deviceMemoryGb: navigator.deviceMemory ?? null,
      webgpu: gpu,
      appDevice: appDevice ?? null,
      phononFiles: index ? { revision: index.model.revision, firstBytes: index.firstBytes } : null,
      kokoro: 'not in this build',
    };
    // replaceChildren writes a null as the word "null": the rows this phone does not have are left out.
    const rows = [
      el('li', { text: t('lab.isolated', { value: yes(env.crossOriginIsolated) }) }),
      el('li', { text: t('lab.cores', { value: env.cores ?? t('lab.unknown') }) }),
      el('li', { text: t('lab.memory', { value: env.deviceMemoryGb ?? t('lab.unknown') }) }),
      el('li', { text: t('lab.webgpu', { value: yes(!!gpu && !gpu.fallback) }) }),
      appDevice ? el('li', { id: 'labAppDevice', text: t('lab.appDevice', { value: t(appDevice.device === 'webgpu' ? 'lab.dev.webgpu' : appDevice.threads === 1 ? 'lab.dev.single' : 'lab.dev.threads') }) }) : null,
      el('li', { text: index ? t('lab.files', { size: Math.round(index.firstBytes / 1e6) }) : t('lab.none') }),
      el('li', { text: t('lab.kokoro') }),
      nst ? el('li', { id: 'labNative', text: t('lab.native', { value: nativeOn ? t('lab.nativeYes', { cores: nst.cores ?? '?', big: (nst.bigCores ?? []).join(', ') || '-', threads: nst.threads ?? '?' }) : t('lab.nativeNo', { reason: nst.reason ?? '' }) }) }) : null,
    ];
    envList.replaceChildren(...rows.filter(Boolean));
    for (const r of nativeRows) r.hidden = !nativeOn;
    for (const c of CANDIDATES) if (c.engine === 'native' && !nativeOn) boxes[c.id].checked = false;
    if (nativeOn) {
      threadsSel.replaceChildren(
        el('option', { value: '0', text: t('lab.appThreadsDefault', { n: nst.defaultThreads ?? '?' }), selected: !nst.chosenThreads }),
        ...[1, 2, 3, 4, 6, 8].filter((n) => n <= (nst.cores ?? 8)).map((n) => el('option', { value: String(n), text: String(n), selected: nst.chosenThreads === n })),
      );
    }
    // The app's voices, then the accent test: other locales' speakers read by the English model, which
    // only this page offers.
    const appVoices = (index?.voices ?? []).map((v) => el('option', { value: v.name, text: v.name, selected: v.name === index.defaultVoice }));
    const accent = (index?.labVoices ?? []).filter((v) => v.use === 'accent-test');
    const others = (index?.labVoices ?? []).filter((v) => v.use === 'lab-only');
    voiceSel.replaceChildren(
      el('optgroup', { label: t('lab.voicesApp') }, ...appVoices),
      others.length ? el('optgroup', { label: t('lab.voicesOther'), 'data-group': 'other' }, ...others.map((v) => el('option', { value: v.name, text: v.name }))) : null,
      accent.length ? el('optgroup', { label: t('lab.voicesAccent'), 'data-group': 'accent' }, ...accent.map((v) => el('option', { value: v.name, text: t('lab.accentVoice', { name: v.name, locale: t(`lab.locale.${v.locale}`) }) }))) : null,
    );
    showVoiceNote();
    runBtn.disabled = !index && !phoneVoices(await waitForVoices(globalThis.speechSynthesis)).length;
  })().catch((e) => (status.textContent = t('lab.failed', { message: message(e) })));

  /** The lab's own model options for a candidate: a lab voice is only in the model the lab loads for itself. */
  const phononOpts = (c) => ({ device: c.device, threads: c.threads, lab: !!labVoice() });

  /**
   * One natural-voice candidate, filling out (already in the results, so what is done so far can be
   * saved at any time). Every wait gives way to Stop (untilAborted, readLine): Stop never waits on a
   * load, a sound or a model that does not answer.
   */
  async function runPhonon(c, voice, signal, onRow, out) {
    Object.assign(out, { device: c.device, threads: c.threads });
    const opts = phononOpts(c);
    const wait = (p) => untilAborted(p, signal);
    await wait(phonon.unload(opts));
    let tts;
    let downloaded = false;
    const amount = (m) => t('dl.amount', meterNumbers(m));
    try {
      status.textContent = t('lab.loading', { name: t(`lab.c.${c.id}`) });
      meter.hidden = false;
      meter.set({ fraction: 0, text: amount({ total: phonon.index()?.firstBytes ?? 0 }), phase: t('dl.downloading') });
      let t0 = now();
      tts = await wait(
        phonon.load({
          ...opts,
          onProgress: (p) => p.cached === false && (downloaded = true),
          onMeter: (m) => meter.set({ fraction: m.fraction, text: amount(m), phase: t(m.fraction >= 1 ? 'dl.ready' : 'dl.downloading') }),
        }),
      );
      out.loadColdMs = Math.round(now() - t0);
      out.downloaded = downloaded;
      meter.set({ fraction: 1, phase: t('dl.ready') });
      // phonon-tts keeps a download in the cache once the model has it, without waiting: give it a
      // moment, so the second load reads from the phone rather than downloading it all again.
      if (downloaded) await inCache(30_000, signal);
      await wait(phonon.unload(opts));
      t0 = now();
      tts = await wait(phonon.load(opts));
      out.loadWarmMs = Math.round(now() - t0);
    } catch (e) {
      if (signal.aborted) throw e;
      out.error = message(e);
      out.loadFailed = true;
      return;
    }
    out.got = { device: tts.device, deviceReason: tts.deviceReason, threads: tts.threads, threadsReason: tts.threadsReason, features: tts.features };
    // The Run tap unlocked the sound (speaker.unlock). If the phone still keeps it off, measure without
    // playing and say so, rather than wait for sound that never ends.
    let playing = play.checked;
    if (playing && speaker.ready && !(await wait(speaker.ready(1500)))) {
      playing = false;
      out.audioBlocked = true;
      blockedNote.hidden = false;
    }
    for (const [i, item] of lines.entries()) {
      if (signal.aborted) break;
      meter.set({ phase: t('dl.reading', { n: i + 1, total: lines.length }) });
      const sp = playing ? speaker.stream({ sampleRate: tts.sampleRate }) : null;
      const silence = () => sp?.stop();
      signal.addEventListener('abort', silence, { once: true });
      let row;
      try {
        // Fails a line that stalls or ends with no sound and no error, rather than hang or count it
        // as a silent line (core/voicelab.js readLine).
        const { arrivals, durations, chunks, totalMs, stopped } = await readLine(tts, item.text, { voice, signal, now, onPcm: (pcm) => sp?.push(pcm) });
        if (stopped) break;
        sp?.end();
        if (sp) await wait(sp.done);
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
        if (signal.aborted && e?.name === 'AbortError') break;
        // Kept even after Stop: an error is a result, and dropping it left a run with no rows and no
        // error to show.
        row = { id: item.id, kind: item.kind, error: message(e), ...(e?.code ? { code: e.code } : {}) };
      } finally {
        signal.removeEventListener('abort', silence);
      }
      out.rows.push(row);
      onRow(out.rows.length);
      // A model that stalled may never answer again: the lines after it would only queue behind it.
      if (row.code === 'stalled') {
        out.stalled = true;
        break;
      }
    }
    if (signal.aborted) return;
    out.memory = await wait(pageMemory());
    await wait(phonon.unload(opts));
  }

  /**
   * The Android app's native voice, at one thread count (its own voice process, started afresh): each
   * line made without playing (ForgeVoice bench). The first line's wait includes starting the process,
   * copying the model out of the APK the first time, and loading it.
   */
  async function runNative(c, voice, signal, onRow, out) {
    Object.assign(out, { device: 'native', threads: c.threads });
    const wait = (p) => untilAborted(p, signal);
    await wait(nativeVoice.release());
    status.textContent = t('lab.loading', { name: t(`lab.c.${c.id}`) });
    meter.hidden = false;
    for (const [i, item] of lines.entries()) {
      if (signal.aborted) break;
      meter.set({ fraction: i / lines.length, phase: t('dl.reading', { n: i + 1, total: lines.length }) });
      const t0 = now();
      let r;
      try {
        if (play.checked) {
          // Played through the app's own speaker (AudioTrack), as answers are: its gaps are counted there.
          const h = await wait(nativeVoice.speak({ pieces: [item.text], voice, threads: c.threads }));
          signal.addEventListener('abort', () => h.stop(), { once: true });
          const e = await wait(h.done);
          r = { ...e, genMs: e.rtf > 0 ? e.rtf * e.audioS * 1000 : null, played: true };
        } else r = await wait(nativeVoice.bench({ text: item.text, voice, threads: c.threads }));
      } catch (e) {
        if (signal.aborted) break;
        if (i === 0) {
          out.error = message(e);
          out.loadFailed = true;
          return;
        }
        out.rows.push({ id: item.id, kind: item.kind, error: message(e), ...(e?.code ? { code: e.code } : {}) });
        onRow(out.rows.length);
        if (e?.code === 'crashed') break;
        continue;
      }
      if (i === 0) {
        out.loadColdMs = Math.max(0, Math.round(now() - t0 - (r.genMs ?? 0)));
        out.got = { device: 'native', threads: r.threads, pinned: r.pinned ?? [], pinError: r.pinError ?? 0, modelLoadMs: r.loadMs, copyMs: r.copyMs };
        if (!(r.copyMs > 0)) out.loadWarmMs = r.loadMs ?? null;
      }
      out.rows.push(r.played ? { ...nativeRow(item, r), played: true, silent: !(r.audioS > 0), peak: null, underruns: r.gaps ?? 0, trackUnderruns: r.underruns ?? null, waitMs: r.waitMs ?? null } : nativeRow(item, r));
      onRow(out.rows.length);
    }
    if (signal.aborted) return;
    await wait(nativeVoice.release());
  }

  /**
   * The phone's own voice (speechSynthesis, voices that run on the phone): time to the first sound only.
   * The list is often empty until the browser has loaded it (iOS Safari): wait for it before saying
   * there is none. Each line is said in pieces of at most 200 characters, and a piece whose end never
   * comes (iOS often drops it) is cancelled at its deadline and its line marked timedOut
   * (core/voicelab.js speakLine), so the run always ends.
   */
  async function runPhoneVoice(signal, onRow, out) {
    const synth = globalThis.speechSynthesis;
    const all = await untilAborted(waitForVoices(synth), signal);
    const voices = phoneVoices(all);
    // What the browser listed, to see why a voice did or did not count (name, language, local).
    out.listed = all.slice(0, 40).map((v) => ({ name: v.name, lang: v.lang, localService: v.localService, default: v.default }));
    if (!voices.length) {
      out.error = all.length ? 'no English voice of the phone runs on the phone' : 'no voice of the phone runs on the phone';
      return;
    }
    out.voice = `${voices[0].name} (${voices[0].lang})`;
    for (const item of lines) {
      if (signal.aborted) break;
      const r = await speakLine({ synth, Utterance: globalThis.SpeechSynthesisUtterance, voice: voices[0], text: item.text, signal, now });
      // A line Stop cut short is not a result.
      if (r.stopped) break;
      const row = { id: item.id, kind: item.kind, chars: item.text.length, pieces: r.pieces, firstMs: r1(r.firstMs), totalMs: r1(r.totalMs), audioS: r.timedOut || r.firstMs == null ? null : r1((r.totalMs - r.firstMs) / 1000), rtf: null };
      if (r.timedOut) row.timedOut = true;
      if (r.error) row.error = r.error;
      out.rows.push(row);
      onRow(out.rows.length);
      // A voice that never even started (sound blocked, or no engine behind the list) will not start
      // on the next line either.
      if (r.timedOut && !r.started) {
        out.error = 'the phone voice did not start';
        break;
      }
    }
  }

  const fmt = (x, unit = '') => (x == null ? '-' : `${x}${unit}`);
  function draw(cands) {
    const head = el('tr', {}, ...['lab.col.voice', 'lab.col.loadCold', 'lab.col.loadWarm', 'lab.col.first', 'lab.col.rtf', 'lab.col.gaps', 'lab.col.bad'].map((k) => el('th', { text: t(k) })));
    const rows = cands.map((c) => {
      const why = c.error ? t(c.loadFailed || !c.rows?.length ? 'lab.failed' : 'lab.readFailed', { message: c.error }) : !c.rows?.length && c.stopped ? t('lab.stoppedEarly') : null;
      if (why) return el('tr', { 'data-candidate': c.id, class: c.error ? 'lab-failed' : '' }, el('td', { text: t(`lab.c.${c.id}`) }), el('td', { colspan: '6', text: why }));
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

  /** Resolves once the model is in the phone's cache (phonon.download says nothing is needed), or after ms or Stop. */
  async function inCache(ms, signal) {
    const end = now() + ms;
    while (now() < end && !signal?.aborted) {
      if (!(await untilAborted(phonon.download().catch(() => ({ needed: false })), signal)).needed) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /** The results of the run, whole or so far: every candidate started, with the rows it has. */
  let live = null; // {voice, done}
  const currentReport = () => {
    if (!live) return result;
    const lv = labVoice();
    return report({ env, voice: live.voice, voiceLocale: lv?.locale ?? phonon.index()?.voices?.find((v) => v.name === live.voice)?.locale ?? null, accentTest: lv?.use === 'accent-test', candidates: live.done });
  };

  /** Stop: ends the run at once, whatever it waits on, and frees what it started. */
  function stopRun() {
    if (!ctrl) return;
    ctrl.abort();
    try {
      globalThis.speechSynthesis?.cancel();
    } catch {
      /* no speech here */
    }
  }

  async function run() {
    // First, before any await: iPhone Safari starts sound only inside the tap itself.
    speaker.unlock?.();
    if (ctrl) return;
    // The phone's own voice too: iOS lets a page speak only once it spoke inside a tap, so a silent
    // utterance now lets the lines spoken minutes later (after the natural voice's runs) be heard.
    if (boxes['phone-voice']?.checked) unlockSpeech();
    blockedNote.hidden = true;
    errorLine.hidden = retryBtn.hidden = true;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    runBtn.hidden = true;
    stopBtn.hidden = false;
    // What is done so far can be saved while it runs.
    saveBtn.textContent = t('lab.saveSoFar');
    copyBtn.textContent = t('lab.copySoFar');
    saveBtn.hidden = copyBtn.hidden = false;
    const voice = voiceSel.value || null;
    lines = CORPUS.slice(0, Number(linesSel.value) || CORPUS.length);
    const chosen = CANDIDATES.filter((c) => boxes[c.id].checked && (c.engine !== 'native' || nativeOn));
    const done = [];
    live = { voice, done };
    for (const c of chosen) {
      if (signal.aborted) break;
      // In the results from its start: its rows are kept as each one finishes.
      const out = { id: c.id, rows: [] };
      done.push(out);
      const onRow = (n) => {
        status.textContent = t('lab.progress', { done: n, total: lines.length, name: t(`lab.c.${c.id}`) });
        draw(done);
      };
      try {
        // untilAborted: the run goes on (or ends) at Stop even if the candidate never returns.
        const go = c.engine === 'phonon' ? runPhonon(c, voice, signal, onRow, out) : c.engine === 'native' ? runNative(c, voice, signal, onRow, out) : runPhoneVoice(signal, onRow, out);
        await untilAborted(go, signal);
      } catch (e) {
        if (!signal.aborted) out.error = message(e);
      }
      if (signal.aborted) {
        out.stopped = true;
        // A model left waiting is freed, so a hung worker does not keep running.
        if (c.engine === 'phonon') phonon.unload(phononOpts(c)).catch(() => {});
        if (c.engine === 'native') nativeVoice?.release();
      }
      const failed = candidateError(out, { stopped: !!out.stopped });
      if (failed) out.error = failed;
      draw(done);
      // A failed load says why at once, with Try again, rather than only in the table at the end.
      if (out.loadFailed && !signal.aborted) {
        errorLine.textContent = t('dl.failed', { message: out.error });
        errorLine.hidden = retryBtn.hidden = false;
        meter.set({ phase: '' });
        // The other ways read the same files: stop here, and Try again starts the run over.
        break;
      }
    }
    if (errorLine.hidden) meter.hidden = true;
    result = currentReport();
    live = null;
    status.textContent = signal.aborted ? t('lab.stopped') : errorLine.hidden ? t('lab.done') : t('lab.notDone');
    ctrl = null;
    runBtn.hidden = false;
    stopBtn.hidden = true;
    saveBtn.textContent = t('lab.save');
    copyBtn.textContent = t('lab.copy');
    saveBtn.hidden = copyBtn.hidden = false;
  }
  runBtn.addEventListener('click', run);
  retryBtn.addEventListener('click', run);
  stopBtn.addEventListener('click', stopRun);
  /** In the app: the results kept in its own files (for adb), and the system's save screen. */
  async function saveInApp(r, { ask = true } = {}) {
    const name = `forge-voice-lab-${r.at.replace(/[:.]/g, '-')}.json`;
    const text = JSON.stringify(r, null, 2);
    const kept = await nativeVoice?.saveLab?.(name, text).catch(() => null);
    if (kept) status.textContent = t('lab.savedApp', { name });
    if (ask) await native.share.save(new File([text], name, { type: 'application/json' })).catch(() => null);
    return kept ? name : null;
  }
  saveBtn.addEventListener('click', () => {
    const r = currentReport();
    if (!r) return;
    if (live) r.partial = true;
    if (native?.share) return void saveInApp(r);
    const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `forge-voice-lab-${r.at.replace(/[:.]/g, '-')}.json`, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  copyBtn.addEventListener('click', async () => {
    const r = currentReport();
    if (!r) return;
    if (live) r.partial = true;
    toast((await copy(JSON.stringify(r))) ? t('lab.copied') : t('lab.copyFailed'));
  });

  const label = (input, text) => el('label', { class: 'lab-check' }, input, el('span', { text }));
  const main = el(
    'main',
    { class: 'screen sub voicelab', 'data-screen': 'voiceLab' },
    backHeader(t('lab.title'), () => {
      stopRun();
      back();
    }, t('common.back')),
    el(
      'div',
      { class: 'scroll' },
      el('p', { class: 'hint', text: t('lab.lead', { count: CORPUS.length }) }),
      envList,
      el('label', { class: 'lab-check', for: 'labVoice' }, el('span', { text: t('lab.voice') }), voiceSel),
      voiceNote,
      el('label', { class: 'lab-check', for: 'labLines' }, el('span', { text: t('lab.lines') }), linesSel),
      el('h2', { class: 'caps', text: t('lab.candidates') }),
      ...CANDIDATES.map((c) => {
        const l = label(boxes[c.id], t(`lab.c.${c.id}`));
        if (c.engine === 'native') {
          l.hidden = true;
          nativeRows.push(l);
        }
        return l;
      }),
      threadsRow,
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
  // A run started from adb in a debug build of the app (MainActivity, forge.labAuto): the candidates
  // and lines it names, then the results kept in the app's files, where adb reads them.
  const auto = native ? globalThis.__forgeLabAuto : null;
  if (auto) {
    globalThis.__forgeLabAuto = null;
    ready.then(async () => {
      const want = auto.candidates === 'native' ? CANDIDATES.filter((c) => c.engine === 'native').map((c) => c.id) : [].concat(auto.candidates ?? []);
      for (const c of CANDIDATES) boxes[c.id].checked = want.includes(c.id);
      if ([...linesSel.options].some((o) => o.value === String(auto.lines))) linesSel.value = String(auto.lines);
      play.checked = auto.play === true;
      await run();
      const r = currentReport();
      globalThis.__forgeLabDone = (r && (await saveInApp(r, { ask: false }))) || 'failed';
    });
  }
  return { node: main, update: () => {}, focus: main.querySelector('h1') };
}
