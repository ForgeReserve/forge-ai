// Share unseen (photos), from Add, Photo, or shared in from another app. Built from the canvas tokens and
// the Photo check sheet (DPhoto), as the plan's decisions say: pick or take a photo, the filter modules
// run on the phone, then the person sees the photo before and after, with the list of what changed,
// adds or takes away blocks by hand, and chooses Share, Ask about it or Save. Free: no balance needed.
//
// The photo lives in this screen's memory only. Leaving the screen lets go of it; nothing stores it.
import { countKinds, dragBox, hitCover, tapBox } from '../core/covers.js';
import { changeRows, runFilters, withId } from '../core/filters.js';
import { clearPicking, markPicking } from '../core/camera.js';
import { closePhoto, drawCovered, makeFile, openPhoto, saveOutcome, shareOrSave, takeShared } from '../core/photo.js';
import { el, icon, msgLine, say, sayEl } from '../core/ui.js';
import { listenHeader, screenListen } from './parts.js';

const STATE_TEXT = { removed: 'photo.state.removed', covered: 'photo.state.covered', none: 'photo.state.none', failed: 'photo.state.failed', uncovered: 'photo.state.uncovered', unsure: 'photo.state.unsure' };
const STEP_TEXT = { running: 'photo.stepState.running', done: 'photo.stepState.done', failed: 'photo.stepState.failed', waiting: 'photo.stepState.waiting' };
const BLOCK_LABEL = { face: 'photo.block.face', writing: 'photo.block.writing', mine: 'photo.block.mine' };
const ERRORS = { too_big: 'photo.tooBig', not_image: 'photo.bad', bad_image: 'photo.bad', unsafe: 'photo.unsafe', denied: 'photo.saveDenied', save_failed: 'photo.saveFailed' };
// What the screen says once the photo went out. Saved only for a save the phone confirmed; a web page
// says only that the download started (core/photo.js saveOutcome).
const DONE_TEXT = { shared: 'photo.shared', saved: 'photo.saved', savedPhotos: 'photo.savedPhotos', downloading: 'photo.downloading' };
/** A press that moves less than this (CSS pixels) is a tap. */
const TAP_SLOP = 10;

/**
 * take: where a photo shared in comes from (the service worker's cache on the website, the app's
 * ForgeShareIn plugin in the Android app). forget: in the app, removes the photo files the app wrote
 * (a photo the phone's camera app took for this screen) once the screen closes.
 *
 * Take a photo opens the camera inside the app (openCamera, screens/camera.js), and took() hands back the
 * photo it took. With no openCamera (no camera the page can use, or it could not be opened) it opens the
 * phone's own camera through the file input, as Pick a photo opens its picker; with pickNow that happens
 * at once, inside the tap that asked for the camera. While either is up a mark is kept in `storage`
 * (core/camera.js markPicking), so a phone that stops the app meanwhile opens Share unseen again.
 */
export function photoScreen({ t, ui, back, actions, reader, params = {}, filters, share, take = takeShared, forget = null, openCamera = null, took = () => null, pickNow = false, storage = null }) {
  let photo = null;
  let result = null; // {steps, covers}
  let covers = [];
  let showing = 'after';
  let busy = false;
  let gone = false;
  // Places a filter was not sure of (small faces in a crowd): offered as blocks the person adds with one
  // tap, until they do or pick another photo.
  let maybe = [];
  // A check did not run (say the face detector could not load): the first tap on Share, Ask about it or
  // Save only warns, so the photo never goes out with that part unchecked on a single tap.
  let confirmedFailed = false;

  const main = el('main', { class: 'screen sub photo', 'data-screen': 'photo' });
  const listen = screenListen({ t, reader, id: 'photoListen', root: () => main });
  const head = listenHeader(t('photo.title'), back, t('common.back'), listen.node);
  const body = el('div', { class: 'scroll' });
  const foot = el('div', { class: 'foot' });
  main.append(head, body, foot);

  // ---------------------------------------------------------------- start: take or pick a photo

  const camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'photoCamera', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const picker = el('input', { type: 'file', accept: 'image/*', id: 'photoFile', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  for (const input of [camera, picker]) {
    input.addEventListener('change', () => {
      clearPicking(storage);
      const f = input.files?.[0];
      input.value = '';
      if (f) check(f);
    });
    input.addEventListener('cancel', () => clearPicking(storage));
  }
  const choose = (input) => {
    markPicking(storage);
    input.click();
  };
  // The picker closed with the app still running (a photo picked or not): the mark goes.
  const pickerClosed = () => document.visibilityState === 'visible' && clearPicking(storage);
  document.addEventListener('visibilitychange', pickerClosed);
  addEventListener('focus', pickerClosed);

  /** alertKey: a problem, in the red box. noteKey: a plain line under the lead. */
  function drawStart(alertKey = null, noteKey = null) {
    const alert = alertKey ? [el('div', { class: 'error-box', role: 'alert', id: 'photoAlert' }, sayEl('p', { id: 'photoAlertText' }, t(alertKey), 'err'))] : [];
    const note = noteKey ? [sayEl('p', { class: 'note', id: 'photoNote', role: 'status' }, t(noteKey), '', 'info')] : [];
    // The phone already sent the shared photo to the server (photo.sent), so "it does not leave this
    // phone" is not said there.
    const free = alertKey === 'photo.sent' ? [] : [sayEl('p', { class: 'note', id: 'photoFree' }, t('photo.free'), '', 'gift')];
    body.replaceChildren(
      sayEl('p', { class: 'lead', id: 'photoLead' }, t('photo.lead'), '', 'shield'),
      ...alert,
      ...note,
      el(
        'div',
        { class: 'photo-pick' },
        el('button', { type: 'button', class: 'pick-btn', id: 'photoTake', onclick: () => (openCamera ? openCamera() : choose(camera)) }, el('span', { class: 'tile-ico tint-gold' }, icon('camera', 26)), el('b', { text: t('photo.take') })),
        el('button', { type: 'button', class: 'pick-btn', id: 'photoPick', onclick: () => choose(picker) }, el('span', { class: 'tile-ico tint-blue' }, icon('image', 26)), el('b', { text: t('photo.pick') })),
      ),
      ...free,
      camera,
      picker,
    );
    foot.replaceChildren();
  }

  // ---------------------------------------------------------------- working: the filters run

  const stepList = el('ul', { class: 'changes', id: 'photoSteps' });
  const stepState = new Map();
  function drawSteps() {
    stepList.replaceChildren(
      ...filters.map((f) => {
        const s = stepState.get(f.id) ?? 'waiting';
        return el('li', { class: 'change-row', 'data-state': s, 'data-step': f.id }, el('span', { text: t(`photo.step.${f.what}`) }), el('b', { text: t(STEP_TEXT[s]) }));
      }),
    );
  }

  /** Lets go of the photo, and of the picture of it the screen drew (a canvas of the photo's size). */
  function dropPhoto() {
    closePhoto(photo);
    photo = null;
    view.width = view.height = 0;
  }

  async function check(file) {
    if (busy) return;
    busy = true;
    dropPhoto();
    confirmedFailed = false;
    stepState.clear();
    body.replaceChildren(el('p', { class: 'lead', id: 'photoWorking', role: 'status', text: t('photo.working') }), stepList);
    foot.replaceChildren();
    drawSteps();
    try {
      photo = await openPhoto(file);
      if (gone) return closePhoto(photo);
      // Let the screen show the steps before the work starts.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      result = await runFilters(filters, photo, {
        onStep: ({ id, state }) => {
          stepState.set(id, state);
          if (!gone) drawSteps();
        },
      });
      if (gone) return closePhoto(photo);
      // Only the filters read these (a copy of every pixel, and the original file); the new file is drawn
      // from the canvas. So they go now, while the person looks at the photo.
      photo.pixels = null;
      photo.bytes = null;
      covers = result.covers.map(withId);
      maybe = result.steps.flatMap((s) => s.maybe ?? []);
      showing = 'after';
      drawReview();
    } catch (e) {
      closePhoto(photo);
      photo = null;
      drawStart(ERRORS[e?.code] ?? 'photo.bad');
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- review: before and after

  const view = el('canvas', { id: 'photoCanvas', class: 'photo-canvas' });
  const layer = el('div', { class: 'cover-layer', id: 'coverLayer' });
  const draft = el('div', { class: 'cover-draft', hidden: true });
  const stage = el('div', { class: 'photo-stage', id: 'photoStage', role: 'group' }, view, layer, draft);
  const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('photo.view'), id: 'photoView' });
  const hint = el('p', { class: 'hint', id: 'photoHint' });
  const changes = el('ul', { class: 'changes', id: 'photoChanges' });
  const failedNote = sayEl('p', { class: 'note warn-text', id: 'photoFailed', hidden: true }, t('photo.failedNote'), '', 'alert');
  const maybeNote = sayEl('p', { class: 'note warn-text', id: 'photoMaybe' }, t('photo.maybe'), '', 'eye');
  const maybeBtn = el('button', { type: 'button', class: 'btn small', id: 'photoCoverMaybe', onclick: () => coverMaybe() }, icon('shield', 18), el('span'));
  const maybeBox = el('div', { class: 'photo-maybe', id: 'photoMaybeBox', hidden: true }, maybeNote, maybeBtn);

  function drawSeg() {
    seg.replaceChildren(
      ...['after', 'before'].map((v) =>
        el('button', { type: 'button', role: 'radio', 'aria-checked': String(showing === v), id: `photo-${v}`, onclick: () => ((showing = v), drawPicture()) }, icon(v === 'after' ? 'shield' : 'eye', 16), el('span', { text: t(`photo.${v}`) })),
      ),
    );
  }

  function drawPicture() {
    drawSeg();
    if (!photo) return;
    stage.dataset.size = `${photo.width}x${photo.height}`;
    if (showing === 'before') {
      view.width = photo.width;
      view.height = photo.height;
      view.getContext('2d').drawImage(photo.canvas, 0, 0);
      layer.replaceChildren();
      stage.dataset.view = 'before';
      stage.setAttribute('aria-label', t('photo.beforeLabel'));
      say(hint, t('photo.beforeNote'), '', 'eye');
      return;
    }
    drawCovered(photo, covers, view);
    stage.dataset.view = 'after';
    stage.setAttribute('aria-label', t('photo.afterLabel'));
    say(hint, t('photo.hint'), '', 'xCircle');
    // One button per cover, its outline over the painted cover: tap (or Enter) takes it away.
    const pc = (v, of) => `${(v / of) * 100}%`;
    layer.replaceChildren(
      ...covers.map((c) => {
        // In the photo's pixels: data-box the cover's bounds, data-ellipse an ellipse's centre and radii,
        // data-found what the filter found under it.
        const f = c.found;
        const btn = el('button', { type: 'button', class: 'cover-box', 'data-kind': c.kind, 'data-cover': c.id, 'data-shape': c.shape ?? 'box', 'data-box': `${c.x},${c.y},${c.w},${c.h}`, ...(c.shape === 'ellipse' ? { 'data-ellipse': `${c.cx},${c.cy},${c.rx},${c.ry}` } : {}), ...(f ? { 'data-found': `${Math.floor(f.x)},${Math.floor(f.y)},${Math.ceil(f.x + f.w) - Math.floor(f.x)},${Math.ceil(f.y + f.h) - Math.floor(f.y)}` } : {}), 'aria-label': t(BLOCK_LABEL[c.kind] ?? BLOCK_LABEL.mine), onclick: () => removeCover(c.id) });
        // An ellipse's outline is drawn whole; the photo's edge cuts it where the cover is cut.
        const o = c.shape === 'ellipse' ? { x: c.cx - c.rx, y: c.cy - c.ry, w: 2 * c.rx, h: 2 * c.ry } : c;
        Object.assign(btn.style, { left: pc(o.x, photo.width), top: pc(o.y, photo.height), width: pc(o.w, photo.width), height: pc(o.h, photo.height) });
        return btn;
      }),
      // A cross on each cover's top right edge, over every cover: a 48 px touch area round a small mark,
      // kept inside the photo (style.css). Letting go on it takes the cover away (the pointer handlers
      // below). Its button above is what a screen reader offers.
      ...covers.map((c) => {
        const at = c.shape === 'ellipse' ? { x: c.cx + c.rx * Math.SQRT1_2, y: c.cy - c.ry * Math.SQRT1_2 } : { x: c.x + c.w, y: c.y };
        const mark = el('span', { class: 'cover-x', 'data-cover': c.id, 'aria-hidden': 'true' }, el('span', { class: 'cover-x-dot' }, icon('x', 14, 3)));
        mark.style.setProperty('--mx', pc(at.x, photo.width));
        mark.style.setProperty('--my', pc(at.y, photo.height));
        return mark;
      }),
    );
    stage.dataset.covers = String(covers.length);
  }

  function drawChanges() {
    const rows = changeRows(result.steps, covers);
    changes.replaceChildren(
      ...rows.map((r) => {
        const key = r.n == null ? r.key : `${r.key}.${r.n === 1 ? 'one' : 'many'}`;
        return el('li', { class: 'change-row', 'data-state': r.state, 'data-key': r.key }, el('span', { text: t(key, { n: r.n }) }), el('b', { text: t(STATE_TEXT[r.state]) }));
      }),
    );
    failedNote.hidden = !result.steps.some((s) => !s.ok);
    maybeBox.hidden = !maybe.length;
    maybeBtn.lastChild.textContent = t(`photo.coverMaybe.${maybe.length === 1 ? 'one' : 'many'}`, { n: maybe.length });
  }

  function setCovers(next) {
    covers = next;
    drawPicture();
    drawChanges();
  }
  const removeCover = (id) => setCovers(covers.filter((c) => c.id !== id));
  const addCover = (box) => box && setCovers([...covers, withId(box)]);
  // The spots the finder was not sure of become the person's own blocks: they chose to cover them.
  function coverMaybe() {
    const add = maybe.map((c) => withId({ ...c, kind: 'mine', id: undefined }));
    maybe = [];
    setCovers([...covers, ...add]);
  }

  // Taps and drags on the photo, in the photo's own pixels.
  let press = null;
  const toPhoto = (e) => {
    const r = view.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * photo.width, y: ((e.clientY - r.top) / r.height) * photo.height, scale: photo.width / r.width };
  };
  // A finger's tap that adds a block, or takes one away with its cross, is followed by a click, and Chrome
  // sends it to whatever is under the finger by then: a block, whose click takes it away. That one click is
  // let go.
  let skipClickUntil = 0;
  stage.addEventListener(
    'click',
    (e) => {
      if (performance.now() < skipClickUntil && e.target.closest('.cover-box, .cover-x')) e.stopPropagation();
      skipClickUntil = 0;
    },
    true,
  );
  // A cross takes its cover away when the finger or mouse lets go on it, by pointer events as for taps on
  // the photo: after a drag a phone's browser does not always send the click that follows a touch.
  let crossDown = null;
  stage.addEventListener('pointerdown', (e) => {
    skipClickUntil = 0;
    crossDown = null;
    const cross = e.target.closest('.cover-x');
    if (cross && e.button <= 0) crossDown = { id: cross.dataset.cover, pointer: e.pointerId, cx: e.clientX, cy: e.clientY };
    if (showing !== 'after' || !photo || e.target.closest('.cover-box, .cover-x') || e.button > 0) return;
    press = { ...toPhoto(e), cx: e.clientX, cy: e.clientY, moved: false, id: e.pointerId };
    stage.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.cx, e.clientY - press.cy) > TAP_SLOP) press.moved = true;
    if (!press.moved) return;
    const r = view.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    Object.assign(draft.style, {
      left: `${Math.min(press.cx, e.clientX) - sr.left}px`,
      top: `${Math.min(press.cy, e.clientY) - sr.top}px`,
      width: `${Math.abs(e.clientX - press.cx)}px`,
      height: `${Math.abs(e.clientY - press.cy)}px`,
    });
    draft.hidden = !(r.width > 0);
  });
  const endPress = (e, cancelled) => {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    draft.hidden = true;
    if (cancelled || !photo) return;
    const q = toPhoto(e);
    if (p.moved) return addCover(dragBox(p.x, p.y, q.x, q.y, photo.width, photo.height));
    const hit = hitCover(covers, p.x, p.y, 4 * p.scale);
    if (hit >= 0) return removeCover(covers[hit].id);
    skipClickUntil = performance.now() + 800;
    addCover(tapBox(p.x, p.y, photo.width, photo.height));
  };
  stage.addEventListener('pointerup', (e) => {
    const d = crossDown;
    crossDown = null;
    if (d && d.pointer === e.pointerId && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) <= 24) {
      // The click that may follow lands on whatever is under the finger once the cover is gone.
      skipClickUntil = performance.now() + 800;
      return removeCover(d.id);
    }
    endPress(e, false);
  });
  stage.addEventListener('pointercancel', (e) => ((crossDown = null), endPress(e, true)));

  const addBlock = el('button', { type: 'button', class: 'btn small', id: 'photoAddBlock', onclick: () => addCover(tapBox(photo.width / 2, photo.height / 2, photo.width, photo.height)) }, icon('plus', 18), el('span', { text: t('photo.addBlock') }));
  const status = msgLine();
  status.id = 'photoStatus';

  /** The new file, made fresh from the photo and the blocks as they are now. */
  async function file() {
    return makeFile(photo, covers, filters);
  }

  // While one of Share, Ask about it and Save is under way (the new file is made, the sheet or the save
  // screen is up) those three and Another photo show as not ready: a tap on one then is not lost without
  // a sign, and the photo being made into a file is not let go of under it.
  const actionBtns = () => [shareBtn, askBtn, saveBtn, another];
  const act = (fn, failed = 'photo.shareFailed') => async () => {
    if (busy || !photo) return;
    if (result?.steps.some((s) => !s.ok) && !confirmedFailed) {
      confirmedFailed = true;
      status.set(t('photo.confirmFailed'), 'err');
      return;
    }
    busy = true;
    for (const b of actionBtns()) b.disabled = true;
    status.set('');
    try {
      await fn();
    } catch (e) {
      status.set(t(ERRORS[e?.code] ?? failed), 'err');
    } finally {
      busy = false;
      for (const b of actionBtns()) b.disabled = false;
    }
  };
  const shareBtn = el(
    'button',
    {
      type: 'button',
      class: 'btn primary block',
      id: 'photoShare',
      onclick: act(async () => {
        const r = await shareOrSave(await file(), share);
        if (DONE_TEXT[r]) ui.toast(t(DONE_TEXT[r]), r === 'shared' ? undefined : 3500);
      }),
    },
    icon('send', 20),
    el('span', { text: t('photo.share') }),
  );
  const askBtn = el('button', { type: 'button', class: 'btn', id: 'photoAsk', onclick: act(async () => actions.attachPhoto(await file())) }, icon('chat', 20), el('span', { text: t('photo.ask') }));
  const saveBtn = el(
    'button',
    {
      type: 'button',
      class: 'btn',
      id: 'photoSave',
      // In the Android app the person picks where to save, and may close that screen instead (nothing is
      // said then). In the iPhone app it goes to Photos, once allowed. A refusal or a failure is said in
      // the line above the buttons, with what to do.
      onclick: act(async () => {
        const r = saveOutcome(await share.save(await file()));
        if (DONE_TEXT[r]) ui.toast(t(DONE_TEXT[r]), 3500);
      }, 'photo.saveFailed'),
    },
    icon('download', 20),
    el('span', { text: t('photo.save') }),
  );
  const another = el('button', { type: 'button', class: 'btn small', id: 'photoAnother', onclick: () => (dropPhoto(), (maybe = []), drawStart()) }, icon('camera', 18), el('span', { text: t('photo.another') }));

  function drawReview() {
    status.set('');
    body.replaceChildren(
      sayEl('p', { class: 'lead', id: 'photoReviewLead' }, t('photo.reviewLead'), '', 'hand'),
      seg,
      stage,
      hint,
      maybeBox,
      el('div', { class: 'row-btns' }, addBlock, another),
      el('h2', { class: 'caps', text: t('photo.changes') }),
      changes,
      sayEl('p', { class: 'note', id: 'photoMiss' }, t('photo.miss'), '', 'eye'),
      failedNote,
    );
    foot.replaceChildren(status, shareBtn, el('div', { class: 'row-btns' }, askBtn, saveBtn), sayEl('p', { class: 'note centre-text', id: 'photoFreeShort' }, t('photo.freeShort'), '', 'gift'));
    drawPicture();
    drawChanges();
    main.querySelector('h1')?.focus?.({ preventScroll: true });
  }

  // ---------------------------------------------------------------- open

  const from = params.from;
  if (from === 'shared') {
    drawStart();
    // Once the shared copy is taken (it is deleted then), the address no longer says one is waiting: a
    // tab reopened after the phone closed it shows Share unseen, not "did not reach Forge".
    const taken = () => !gone && history.replaceState(history.state, '', '#/photo');
    take()
      .then((f) => (taken(), gone ? null : f ? check(f) : drawStart('photo.missed')))
      .catch((e) => (taken(), !gone && drawStart(e?.code === 'none' ? 'photo.none' : 'photo.missed')));
  } else if (from === 'again' || from === 'saveDone' || from === 'saveLost') {
    // After the phone stopped the app while a picker or the save screen was up (app.js start).
    if (from === 'saveLost') drawStart('photo.saveLost');
    else drawStart(null, from === 'again' ? 'photo.again' : 'photo.saveDone');
    // Said once: a reload shows Share unseen as it is.
    history.replaceState(history.state, '', '#/photo');
  } else {
    // A photo the in-app camera took: checked at once.
    const taken = took();
    if (taken) check(taken);
    else {
      drawStart({ missed: 'photo.missed', none: 'photo.none', sent: 'photo.sent' }[from] ?? null);
      // The in-app camera could not open (not refused): the phone's own camera, in the same tap.
      if (pickNow) choose(camera);
    }
  }
  // Start loading the face model now, so the check is quicker once a photo is picked.
  setTimeout(() => !gone && filters.forEach((f) => f.prepare?.().catch(() => {})), 300);

  listen.update();
  return {
    node: main,
    focus: main.querySelector('h1'),
    destroy() {
      gone = true;
      document.removeEventListener('visibilitychange', pickerClosed);
      removeEventListener('focus', pickerClosed);
      listen.destroy();
      forget?.();
      dropPhoto();
      result = null;
      covers = [];
      maybe = [];
    },
    /** For the tests: how many blocks of each kind are on the photo now. */
    counts: () => countKinds(covers),
  };
}
