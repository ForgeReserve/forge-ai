// The Add and More menus (ZAdd, ZMore): a floating card over the faded home. Only entries that work
// in this release are listed (Link, Guide, History and Protection come with later slices).
import { ACCEPT } from '../../js/files.js';
import { el, listRow } from '../core/ui.js';

export function addSheet({ t, actions }) {
  const photo = el('input', { type: 'file', accept: 'image/*', id: 'photoInput', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', multiple: true });
  const file = el('input', { type: 'file', accept: ACCEPT.split(',').filter((x) => x !== 'image/*').join(','), id: 'fileInput', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', multiple: true });
  photo.addEventListener('change', () => {
    if (photo.files?.length) actions.attach([...photo.files], 'image');
    photo.value = '';
  });
  file.addEventListener('change', () => {
    if (file.files?.length) actions.attach([...file.files], 'doc');
    file.value = '';
  });
  return el(
    'section',
    { class: 'float-card', 'aria-label': t('add.title'), id: 'addSheet' },
    listRow({ ico: 'camera', tint: 'gold', title: t('add.photo'), sub: t('add.photoSub'), id: 'addPhoto', onclick: () => photo.click() }),
    listRow({ ico: 'file', tint: 'blue', title: t('add.file'), sub: t('add.fileSub'), id: 'addFile', onclick: () => file.click() }),
    photo,
    file,
  );
}

export function moreSheet({ t, state, nav }) {
  return el(
    'section',
    { class: 'float-card', 'aria-label': t('more.title'), id: 'moreSheet' },
    listRow({ ico: 'lock', tint: 'teal', title: t('more.model'), sub: state.S.settings.privateOnly ? t('more.modelSub') : t('more.modelSubOff'), id: 'moreModel', onclick: () => nav('model') }),
    listRow({ ico: 'sun', tint: 'blue', title: t('more.look'), sub: t('more.lookSub'), id: 'moreLook', onclick: () => nav('look') }),
  );
}
