// The Add and More menus (ZAdd, ZMore): a floating card over the faded home. Only entries that work
// in this release are listed (Link, Guide and Protection come with later slices).
import { ACCEPT } from '../../js/files.js';
import { engineLabel } from '../core/engineaddr.js';
import { el, listRow } from '../core/ui.js';

export function addSheet({ t, nav, actions }) {
  const file = el('input', { type: 'file', accept: ACCEPT.split(',').filter((x) => x !== 'image/*').join(','), id: 'fileInput', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', multiple: true });
  file.addEventListener('change', () => {
    if (file.files?.length) actions.attach([...file.files], 'doc');
    file.value = '';
  });
  return el(
    'section',
    { class: 'float-card', 'aria-label': t('add.title'), id: 'addSheet' },
    // Photo opens Share unseen: the photo is cleaned on the phone before it can be asked about or shared.
    listRow({ ico: 'camera', tint: 'gold', title: t('add.photo'), sub: t('add.photoSub'), id: 'addPhoto', onclick: () => nav('photo') }),
    listRow({ ico: 'file', tint: 'blue', title: t('add.file'), sub: t('add.fileSub'), id: 'addFile', onclick: () => file.click() }),
    file,
  );
}

/** engineBase: the engine in use ('' for this site). native: set in the Android app, which has no Classic mode. */
export function moreSheet({ t, state, nav, registry, engineBase = '', native = null }) {
  // Voice is listed only when some way of talking or listening works here.
  const voice = ['voice-in', 'voice-out'].some((k) => registry.list(k).some((x) => x.instance.available()));
  return el(
    'section',
    { class: 'float-card', 'aria-label': t('more.title'), id: 'moreSheet' },
    listRow({ ico: 'clock', tint: 'gold', title: t('more.history'), sub: t('more.historySub'), id: 'moreHistory', onclick: () => nav('history') }),
    listRow({ ico: 'lock', tint: 'teal', title: t('more.model'), sub: state.S.settings.privateOnly ? t('more.modelSub') : t('more.modelSubOff'), id: 'moreModel', onclick: () => nav('model') }),
    voice ? listRow({ ico: 'mic', tint: 'violet', title: t('more.voice'), sub: t('more.voiceSub'), id: 'moreVoice', onclick: () => nav('voice') }) : null,
    listRow({ ico: 'server', tint: 'teal', title: t('more.engine'), sub: engineLabel(engineBase) || t('more.engineSite'), id: 'moreEngine', onclick: () => nav('engine') }),
    listRow({ ico: 'sun', tint: 'blue', title: t('more.look'), sub: native ? t('more.lookSubApp') : t('more.lookSub'), id: 'moreLook', onclick: () => nav('look') }),
    // The first run again: how paying works, what Forge can and cannot hide, Private only.
    listRow({ ico: 'shield', tint: 'teal', title: t('more.intro'), sub: t('more.introSub'), id: 'moreIntro', onclick: () => nav('intro') }),
    listRow({ ico: 'trash', tint: 'danger', title: t('more.erase'), sub: t('more.eraseSub'), id: 'moreErase', cls: 'danger-row', onclick: () => nav('erase') }),
  );
}
