// Share unseen (photos), from Add, Photo, or shared in from another app. Built from the canvas tokens and
// the Photo check sheet (DPhoto), as the plan's decisions say: pick or take a photo, the filter modules
// run on the phone, then the person sees the photo before and after, with the list of what changed,
// adds or takes away blocks by hand, and chooses Share, Ask about it or Save. Free: no balance needed.
//
// The photo lives in this screen's memory only. Leaving the screen lets go of it; nothing stores it.
import { countKinds, dragBox, hitCover, tapBox, alignBox } from '../core/covers.js';
import { changeRows, runFilters, withId } from '../core/filters.js';
import { closePhoto, drawCovered, makeFile, openPhoto, shareOrSave, takeShared } from '../core/photo.js';
import { backHeader, el, icon } from '../core/ui.js';

const STATE_TEXT = { removed: 'photo.state.removed', covered: 'photo.state.covered', none: 'photo.state.none', failed: 'photo.state.failed', uncovered: 'photo.state.uncovered' };
const STEP_TEXT = { running: 'photo.stepState.running', done: 'photo.stepState.done', failed: 'photo.stepState.failed', waiting: 'photo.stepState.waiting' };
const BLOCK_LABEL = { face: 'photo.block.face', writing: 'photo.block.writing', mine: 'photo.block.mine' };
const ERRORS = { too_big: 'photo.tooBig', not_image: 'photo.bad', bad_image: 'photo.bad', unsafe: 'photo.unsafe' };
/** A press that moves less than this (CSS pixels) is a tap. */
const TAP_SLOP = 10;

export function photoScreen({ t, ui, back, actions, params = {}, filters, share }) {
  let photo = null;
  let result = null; // {steps, covers}
  let covers = [];
  let showing = 'after';
  let busy = false;
  let gone = false;
  // A check did not run (say the face detector could not load): the first tap on Share, Ask about it or
  // Save only warns, so the photo never goes out with that part unchecked on a single tap.
  let confirmedFailed = false;

  const main = el('main', { class: 'screen sub photo', 'data-screen': 'photo' });
  const head = backHeader(t('photo.title'), back, t('common.back'));
  const body = el('div', { class: 'scroll' });
  const foot = el('div', { class: 'foot' });
  main.append(head, body, foot);

  // ---------------------------------------------------------------- start: take or pick a photo

  const camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'photoCamera', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const picker = el('input', { type: 'file', accept: 'image/*', id: 'photoFile', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  for (const input of [camera, picker])
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) check(f);
    });

  function drawStart(alertKey = null) {
    const alert = alertKey ? [el('div', { class: 'error-box', role: 'alert', id: 'photoAlert' }, el('p', { text: t(alertKey) }))] : [];
    // The phone already sent the shared photo to the server (photo.sent), so "it does not leave this
    // phone" is not said there.
    const free = alertKey === 'photo.sent' ? [] : [el('p', { class: 'note', id: 'photoFree', text: t('photo.free') })];
    body.replaceChildren(
      el('p', { class: 'lead', id: 'photoLead', text: t('photo.lead') }),
      ...alert,
      el(
        'div',
        { class: 'photo-pick' },
        el('button', { type: 'button', class: 'pick-btn', id: 'photoTake', onclick: () => camera.click() }, el('span', { class: 'tile-ico tint-gold' }, icon('camera', 26)), el('b', { text: t('photo.take') })),
        el('button', { type: 'button', class: 'pick-btn', id: 'photoPick', onclick: () => picker.click() }, el('span', { class: 'tile-ico tint-blue' }, icon('image', 26)), el('b', { text: t('photo.pick') })),
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

  async function check(file) {
    if (busy) return;
    busy = true;
    closePhoto(photo);
    photo = null;
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
      covers = result.covers.map(withId);
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
  const failedNote = el('p', { class: 'note warn-text', id: 'photoFailed', text: t('photo.failedNote'), hidden: true });

  function drawSeg() {
    seg.replaceChildren(
      ...['after', 'before'].map((v) =>
        el('button', { type: 'button', role: 'radio', 'aria-checked': String(showing === v), id: `photo-${v}`, onclick: () => ((showing = v), drawPicture()), text: t(`photo.${v}`) }),
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
      hint.textContent = t('photo.beforeNote');
      return;
    }
    drawCovered(photo, covers, view);
    stage.dataset.view = 'after';
    stage.setAttribute('aria-label', t('photo.afterLabel'));
    hint.textContent = t('photo.hint');
    // One button per block, over the painted block: tap (or Enter) takes it away.
    layer.replaceChildren(
      ...covers.map((c) => {
        const b = alignBox(c, photo.width, photo.height);
        // data-box: the block in the photo's pixels, as it is painted.
        const btn = el('button', { type: 'button', class: 'cover-box', 'data-kind': c.kind, 'data-cover': c.id, 'data-box': `${b.x},${b.y},${b.w},${b.h}`, 'aria-label': t(BLOCK_LABEL[c.kind] ?? BLOCK_LABEL.mine), onclick: () => removeCover(c.id) });
        Object.assign(btn.style, { left: `${(b.x / photo.width) * 100}%`, top: `${(b.y / photo.height) * 100}%`, width: `${(b.w / photo.width) * 100}%`, height: `${(b.h / photo.height) * 100}%` });
        return btn;
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
  }

  function setCovers(next) {
    covers = next;
    drawPicture();
    drawChanges();
  }
  const removeCover = (id) => setCovers(covers.filter((c) => c.id !== id));
  const addCover = (box) => box && setCovers([...covers, withId(box)]);

  // Taps and drags on the photo, in the photo's own pixels.
  let press = null;
  const toPhoto = (e) => {
    const r = view.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * photo.width, y: ((e.clientY - r.top) / r.height) * photo.height, scale: photo.width / r.width };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (showing !== 'after' || !photo || e.target.closest('.cover-box') || e.button > 0) return;
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
    const hit = hitCover(covers.map((c) => alignBox(c, photo.width, photo.height)), p.x, p.y, 4 * p.scale);
    if (hit >= 0) removeCover(covers[hit].id);
    else addCover(tapBox(p.x, p.y, photo.width, photo.height));
  };
  stage.addEventListener('pointerup', (e) => endPress(e, false));
  stage.addEventListener('pointercancel', (e) => endPress(e, true));

  const addBlock = el('button', { type: 'button', class: 'btn small', id: 'photoAddBlock', onclick: () => addCover(tapBox(photo.width / 2, photo.height / 2, photo.width, photo.height)) }, icon('plus', 18), el('span', { text: t('photo.addBlock') }));
  const status = el('p', { class: 'msg', role: 'status', id: 'photoStatus' });

  /** The new file, made fresh from the photo and the blocks as they are now. */
  async function file() {
    return makeFile(photo, covers, filters);
  }

  const act = (fn) => async () => {
    if (busy || !photo) return;
    if (result?.steps.some((s) => !s.ok) && !confirmedFailed) {
      confirmedFailed = true;
      status.textContent = t('photo.confirmFailed');
      status.className = 'msg err';
      return;
    }
    busy = true;
    status.textContent = '';
    status.className = 'msg';
    try {
      await fn();
    } catch (e) {
      status.textContent = t(ERRORS[e?.code] ?? 'photo.shareFailed');
      status.className = 'msg err';
    } finally {
      busy = false;
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
        if (r === 'shared') ui.toast(t('photo.shared'));
        if (r === 'saved') ui.toast(t('photo.saved'), 3500);
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
      onclick: act(async () => {
        share.save(await file());
        ui.toast(t('photo.saved'), 3500);
      }),
    },
    icon('download', 20),
    el('span', { text: t('photo.save') }),
  );
  const another = el('button', { type: 'button', class: 'btn small', id: 'photoAnother', onclick: () => (closePhoto(photo), (photo = null), drawStart()) }, icon('camera', 18), el('span', { text: t('photo.another') }));

  function drawReview() {
    status.textContent = '';
    status.className = 'msg';
    body.replaceChildren(
      el('p', { class: 'lead', id: 'photoReviewLead', text: t('photo.reviewLead') }),
      seg,
      stage,
      hint,
      el('div', { class: 'row-btns' }, addBlock, another),
      el('h2', { class: 'caps', text: t('photo.changes') }),
      changes,
      el('p', { class: 'note', id: 'photoMiss', text: t('photo.miss') }),
      failedNote,
    );
    foot.replaceChildren(status, shareBtn, el('div', { class: 'row-btns' }, askBtn, saveBtn), el('p', { class: 'note centre-text', text: t('photo.freeShort') }));
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
    takeShared()
      .then((f) => (taken(), gone ? null : f ? check(f) : drawStart('photo.missed')))
      .catch(() => (taken(), !gone && drawStart('photo.missed')));
  } else drawStart({ missed: 'photo.missed', none: 'photo.none', sent: 'photo.sent' }[from] ?? null);
  // Start loading the face model now, so the check is quicker once a photo is picked.
  setTimeout(() => !gone && filters.forEach((f) => f.prepare?.().catch(() => {})), 300);

  return {
    node: main,
    focus: main.querySelector('h1'),
    destroy() {
      gone = true;
      closePhoto(photo);
      photo = null;
      result = null;
      covers = [];
      view.width = view.height = 0;
    },
    /** For the tests: how many blocks of each kind are on the photo now. */
    counts: () => countKinds(covers),
  };
}
