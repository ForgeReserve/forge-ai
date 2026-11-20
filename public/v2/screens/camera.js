// Take a photo, inside the app: Share unseen's Take a photo (route #/photo/camera). The camera plays on
// the screen, the big round button takes the photo, and the photo goes to Share unseen as a picked one
// would. The phone's own camera app is not opened: on a phone short of memory Android stopped Forge
// while it was open, and the photo was lost (core/camera.js).
//
// The camera is on only while this screen shows: it is turned off once the photo is taken, when the
// screen closes (the arrow, or the phone's Back) and while the app is in the background. The photo is held
// in memory only; nothing stores it or sends it.
import { el, icon } from '../core/ui.js';
import { otherFacing } from '../core/camera.js';

/**
 * camera: the camera adapter (core/adapters.js still()). taken(file): the photo, as a File. failed(error):
 * the camera could not be opened (refused, none, busy); Share unseen then uses the phone's own picker.
 */
export function cameraScreen({ t, back, camera, taken, failed }) {
  let job = null; // the open camera: {id, facing, faces, mirror, cameras, take(), stop()}
  let taking = null; // the camera while it takes the photo
  let runs = 0; // each close() ends the opening in progress; a camera it opens later is turned off
  let facing = 'environment';
  let device = null; // a camera chosen by its id, where cameras do not say which way they face
  let busy = false;
  let gone = false;

  const video = el('video', { class: 'cam-video', id: 'camVideo', muted: true, playsinline: true, 'aria-label': t('cam.view') });
  const status = el('p', { class: 'cam-status', id: 'camStatus', role: 'status', text: t('cam.opening') });
  const shutter = el('button', { type: 'button', class: 'cam-shutter', id: 'camShutter', 'aria-label': t('cam.take'), disabled: true, onclick: () => shoot() }, el('span', { class: 'cam-shutter-in' }, icon('camera', 34)));
  const flip = el('button', { type: 'button', class: 'round cam-flip', id: 'camFlip', 'aria-label': t('cam.flip'), hidden: true, onclick: () => turn() }, icon('flip', 26));
  const main = el(
    'main',
    { class: 'screen cam', 'data-screen': 'camera', 'data-state': 'opening' },
    el('header', { class: 'cam-head' }, el('button', { type: 'button', class: 'round', id: 'camBack', 'aria-label': t('common.back'), onclick: () => back() }, icon('back', 22)), el('h1', { text: t('cam.title'), tabindex: '-1' }), el('span')),
    el('div', { class: 'cam-stage' }, video, status),
    el('div', { class: 'cam-bar' }, el('span'), shutter, flip),
  );

  function close() {
    runs++;
    job?.stop();
    job = null;
    shutter.disabled = true;
  }

  /**
   * Opens the `facing` camera (or the camera `device`). With `before`, a camera that will not open puts
   * that one back instead.
   */
  async function open(before = null) {
    close();
    const mine = runs;
    main.dataset.state = 'opening';
    status.hidden = false;
    try {
      const c = await camera.still(video, { facing, device });
      if (mine !== runs || gone) return c.stop();
      // Asked for the other camera and given the same one: there is no other to turn to.
      if (before && c.id && c.id === before.id) flip.dataset.none = '1';
      job = c;
      facing = c.facing;
      video.classList.toggle('mirror', !!c.mirror);
      flip.hidden = c.cameras.length < 2 || flip.dataset.none === '1';
      flip.disabled = false;
      shutter.disabled = false;
      status.hidden = true;
      main.dataset.state = 'ready';
      main.dataset.facing = facing;
    } catch (e) {
      if (mine !== runs || gone) return;
      if (before) {
        ({ facing, device } = before);
        flip.dataset.none = '1';
        return open();
      }
      failed(e);
    }
  }

  /** The other camera: the one facing the other way, or where cameras do not say so, the next one. */
  function turn() {
    if (!job || busy) return;
    const before = { facing, device, id: job.id };
    if (job.faces) {
      facing = otherFacing(job.facing);
      device = null;
    } else device = job.cameras[(job.cameras.indexOf(job.id) + 1) % job.cameras.length] ?? null;
    flip.disabled = true;
    open(before);
  }

  async function shoot() {
    if (!job || busy) return;
    busy = true;
    const c = job;
    taking = c;
    job = null;
    runs++;
    shutter.disabled = true;
    flip.disabled = true;
    main.dataset.state = 'taking';
    try {
      // take() turns the camera off once it has the photo, before Share unseen's checks start.
      const blob = await c.take();
      if (gone) return;
      const png = blob.type === 'image/png';
      taken(new File([blob], png ? 'photo.png' : 'photo.jpg', { type: png ? 'image/png' : 'image/jpeg' }));
    } catch {
      c.stop();
      // No photo came: the camera again, to try once more.
      if (!gone) open();
    } finally {
      taking = null;
      busy = false;
    }
  }

  // In the background the camera is off; back in front it opens again.
  const onVisible = () => {
    if (gone || busy) return;
    if (document.visibilityState === 'visible') {
      if (!job) open();
    } else close();
  };
  document.addEventListener('visibilitychange', onVisible);

  open();
  return {
    node: main,
    focus: main.querySelector('h1'),
    destroy() {
      gone = true;
      document.removeEventListener('visibilitychange', onVisible);
      // Left while the photo was being taken: the camera goes off now, and that photo is dropped.
      taking?.stop();
      close();
    },
  };
}
