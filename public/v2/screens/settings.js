// Mode and look (XThemes) and Choose a model (DPrivateOnly), both reached from More.
import { isFreeModel } from '../core/price.js';
import { isPrivate, modelGroups } from '../core/state.js';
import { backHeader, el, icon, infoToggle, sayEl } from '../core/ui.js';
import { listenHeader, screenListen } from './parts.js';

/**
 * A choice that reads at a glance (reading load, owner 2026-11-15): the radio card holds the name and
 * small picture tags, and the round info button beside it opens the full words under it.
 */
function option(card, info, label) {
  if (!info) return card;
  const more = el('div', {}, ...[].concat(info).filter(Boolean).map((x) => el('p', { text: x })));
  return el('div', { class: 'opt' }, el('div', { class: 'opt-row' }, card, infoToggle(more, label, card.id ? `${card.id}Info` : null)), more);
}

export function lookScreen({ t, state, back, actions, registry, native = null }) {
  const S = state.S;
  const looks = registry.list('look');
  // Colours from a look module go into SVG markup, so only plain hex colours are used.
  const hex = (v) => (/^#[0-9a-f]{3,8}$/i.test(String(v)) ? v : '#888888');
  const thumb = (tokens) => {
    const c = (k) => hex(tokens[k]);
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 60 84');
    s.setAttribute('width', '60');
    s.setAttribute('height', '84');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = `<rect width="60" height="84" rx="10" fill="${c('bg')}" stroke="${c('line')}"/><circle cx="30" cy="38" r="17" fill="none" stroke="${c('gold-track')}" stroke-width="5"/><circle cx="30" cy="38" r="17" fill="none" stroke="${c('gold')}" stroke-width="5" stroke-dasharray="80 107" stroke-linecap="round" transform="rotate(-90 30 38)"/><circle cx="30" cy="38" r="11" fill="none" stroke="${c('memory-track')}" stroke-width="5"/><circle cx="30" cy="38" r="11" fill="none" stroke="${c('memory')}" stroke-width="5" stroke-dasharray="48 69" stroke-linecap="round" transform="rotate(-90 30 38)"/><circle cx="30" cy="38" r="6" fill="${c('talk')}"/><rect x="10" y="66" width="40" height="8" rx="4" fill="${c('surface')}" stroke="${c('line')}"/>`;
    return s;
  };
  // The modes (core/registry.js, kind mode): the one in use is the big card, the others under it. The
  // name and line of a bundled mode are in the string table; a later one shows its manifest's name.
  const MODE_TEXT = { default: ['look.default', 'look.defaultSub', 'grid'], playful: ['look.playful', 'look.playfulSub', 'star'] };
  const modes = el('div', { class: 'mode-list', role: 'radiogroup', 'aria-label': t('look.mode') });
  const group = el('div', { class: 'look-list', role: 'radiogroup', 'aria-label': t('look.look') });
  const follow = el('button', { type: 'button', class: 'setting-row', id: 'followSystem', role: 'switch', 'aria-label': t('look.followLabel') });
  // Playful only: open on its cover game, the helper behind it (docs/PLAYFUL.md), and what that does not hide.
  const gameFirst = el('button', { type: 'button', class: 'setting-row', id: 'gameFirst', role: 'switch', 'aria-label': t('look.gameFirstLabel') });
  gameFirst.addEventListener('click', () => actions.setGameFirst(S.settings.gameFirst === false));
  const coverNote = el(
    'div',
    { class: 'cover-note', id: 'coverNote' },
    el('p', { class: 'hint' }, el('span', { text: t('look.gameFirstHow') }), el('span', { class: 'sr-only', text: ` ${t('look.gameFirstReader')}` })),
    el('p', { class: 'cover-warn', id: 'coverWarn' }, icon('eye', 18), el('span', { text: t('look.coverWarn') })),
  );
  const draw = () => {
    const using = S.settings.mode ?? 'default';
    modes.replaceChildren(
      ...registry.list('mode').map(({ manifest, instance }) => {
        const on = instance.id === using;
        const [name, sub, ico] = MODE_TEXT[instance.id] ?? [null, null, 'grid'];
        const line = sub ? t(sub) : '';
        return el(
          'button',
          { type: 'button', class: on ? 'mode-on' : 'mode-card', role: 'radio', 'aria-checked': String(on), id: `mode-${instance.id}`, onclick: () => !on && actions.setMode(instance.id) },
          icon(ico, on ? 30 : 22),
          el('span', {}, el('b', { text: name ? t(name) : manifest.name.en }), line || on ? el('small', { text: on ? `${line} ${t('look.onNow')}`.trim() : line }) : null),
          on ? el('span', { class: 'on-dot', 'aria-hidden': 'true' }) : null,
        );
      }),
    );
    group.replaceChildren(
      ...looks.map(({ instance }) => {
        const on = S.settings.look === instance.id;
        return el(
          'button',
          { type: 'button', class: `look-card${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), id: `look-${instance.id}`, onclick: () => actions.setLook(instance.id) },
          thumb(instance.tokens),
          el('span', { class: 'look-text' }, el('b', { text: t(`look.${instance.id}.name`) }), el('small', { text: t(`look.${instance.id}.sub`) })),
          el('span', { class: 'radio', 'aria-hidden': 'true' }),
        );
      }),
    );
    const playful = (S.settings.mode ?? 'default') === 'playful';
    const on = S.settings.gameFirst !== false;
    gameFirst.hidden = coverNote.hidden = !playful;
    gameFirst.setAttribute('aria-checked', String(on));
    gameFirst.replaceChildren(el('span', {}, icon('grid', 20), el('span', { text: t('look.gameFirst') })), el('span', { class: 'value', text: on ? t('look.on') : t('look.off') }));
    coverNote.querySelector('.hint').hidden = !on;
    follow.setAttribute('aria-checked', String(!!S.settings.followSystem));
    follow.replaceChildren(el('span', {}, icon('phone', 20), el('span', { text: t('look.follow') })), el('span', { class: 'value', text: S.settings.followSystem ? t('look.on') : t('look.off') }));
  };
  follow.addEventListener('click', () => actions.setFollowSystem(!S.settings.followSystem));
  draw();
  const main = el(
    'main',
    { class: 'screen sub look', 'data-screen': 'look' },
    backHeader(t('look.title'), back, t('common.back')),
    el(
      'div',
      { class: 'scroll' },
      el('h2', { class: 'caps', text: t('look.mode') }),
      modes,
      gameFirst,
      coverNote,
      // Classic is the v1 chat page, a link rather than a mode module.
      // The Android app carries only this app, so it has no Classic to open.
      native ? null : el('a', { class: 'mode-card', href: '/', id: 'modeClassic' }, icon('chat', 22), el('span', {}, el('b', { text: t('look.classic') }), el('small', { text: t('look.classicSub') }))),
      el('h2', { class: 'caps', text: t('look.look') }),
      group,
      follow,
    ),
    el('div', { class: 'foot' }, el('button', { type: 'button', class: 'btn primary block', id: 'lookDone', onclick: back, text: t('look.done') })),
  );
  return { node: main, update: draw, focus: main.querySelector('h1') };
}

export function modelScreen({ t, state, back, actions, format, reader, done = back }) {
  const S = state.S;
  const sw = el('button', { type: 'button', role: 'switch', class: 'switch', id: 'privateOnly', 'aria-label': t('model.privateOnly') }, el('span', { class: 'track' }, el('span', { class: 'knob' })));
  sw.addEventListener('click', () => actions.setPrivateOnly(!S.settings.privateOnly));
  const list = el('div', { class: 'model-list', role: 'radiogroup', 'aria-label': t('model.title') });
  const hiddenMore = el('p', { text: t('model.hiddenSub') });
  const hidden = el('div', { class: 'dashed-box', id: 'hiddenNote' }, el('div', { class: 'with-info' }, el('b', { class: 'ib' }, icon('eye', 18), el('span', { text: t('model.hidden') })), infoToggle(hiddenMore, t('model.info', { name: t('model.hidden') }), 'hiddenInfo')), hiddenMore);
  const tag = (ico, text, cls = '') => el('span', { class: `tag ${cls}`.trim() }, icon(ico, 14), el('span', { text }));
  // Each group under its heading, with its picture: the rabbit, the lock, the open lock, the turtle.
  const GROUP_ICON = { fast: 'rabbit', private: 'lock', standard: 'unlock', slow: 'turtle' };
  /** One model: a radio card with the name and small picture tags; the chosen one carries a check. */
  const modelCard = (m, v) => {
    const on = v.model?.id === m.id;
    const priv = isPrivate(m);
    // A free model (core/price.js isFreeModel) shows Free in place of a price.
    const free = isFreeModel(m);
    const p = free ? null : format.modelPrice(m);
    // The card: the name and its tags. What it costs, who can read it and how fast it is: behind its info
    // button. Choosing a model closes the list.
    const card = el(
      'button',
      { type: 'button', class: `model-card${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), 'data-model': m.id, 'data-speed': m.speed ?? '', onclick: () => (actions.chooseModel(m.id), done()) },
      el('span', { class: 'model-name' }, el('b', { text: m.name ?? m.id }), on ? el('span', { class: 'model-on', role: 'img', 'aria-label': t('model.chosenMark') }, icon('check', 18, 3)) : null),
      el(
        'span',
        { class: 'tags' },
        m.speed === 'fast' ? tag('rabbit', t('model.fast'), 'speed') : m.speed === 'slow' ? tag('turtle', t('model.slow'), 'slow') : null,
        priv ? tag('lock', t('model.private'), 'teal') : tag('unlock', t('model.standard'), 'warn'),
        free ? tag('gift', t('model.free'), 'free') : null,
        m.capabilities?.vision ? tag('image', t('model.images')) : null,
        m.capabilities?.reasoning ? tag('bulb', t('model.reasoning')) : null,
      ),
    );
    const speed = m.speed === 'fast' ? t('model.fastSub') : m.speed === 'slow' ? t('model.slowSub') : null;
    return option(card, [speed, free ? t('model.freeSub') : p ? t('model.price', p) : null, priv ? null : t('model.standardWarn')].filter(Boolean), t('model.info', { name: m.name ?? m.id }));
  };
  // What Private and Standard mean, behind the info mark beside their headings (the words the Private chip
  // at the top left of the home describes itself with).
  const ABOUT = { private: 'status.privateLabel', standard: 'status.standardLabel' };
  const groupHead = (id) => {
    const head = el('h2', { class: 'caps group-head', id: `groupHead-${id}` }, icon(GROUP_ICON[id], 20), el('span', { text: t(`model.group.${id}`) }));
    if (!ABOUT[id]) return [head];
    const more = el('p', { class: 'group-about', text: t(ABOUT[id]) });
    return [el('div', { class: 'with-info' }, head, infoToggle(more, t('model.info', { name: t(`model.group.${id}`) }), `groupInfo-${id}`)), more];
  };
  const draw = () => {
    sw.setAttribute('aria-checked', String(!!S.settings.privateOnly));
    const v = state.view();
    const groups = modelGroups(S.models, S.settings);
    list.replaceChildren(
      ...(groups.length
        ? groups.map((g) =>
            el(
              'section',
              { class: `model-group group-${g.id}`, id: `group-${g.id}`, 'aria-labelledby': `groupHead-${g.id}` },
              ...groupHead(g.id),
              ...g.models.map((m) => modelCard(m, v)),
            ),
          )
        : [el('p', { class: 'hint', text: t('model.none') })]),
    );
    hidden.hidden = !(S.settings.privateOnly && v.hiddenCount > 0);
  };
  draw();
  const listen = screenListen({ t, reader, id: 'modelListen', root: () => main });
  const main = el(
    'main',
    { class: 'screen sub model', 'data-screen': 'model' },
    listenHeader(t('model.title'), back, t('common.back'), listen.node),
    el(
      'div',
      { class: 'scroll' },
      el('div', { class: 'teal-panel' }, el('span', {}, el('b', { class: 'ib' }, icon('lock', 18), el('span', { text: t('model.privateOnly') })), sayEl('small', { id: 'privateOnlySub' }, t('model.privateOnlySub'))), sw),
      list,
      hidden,
    ),
  );
  listen.update();
  return { node: main, update: draw, destroy: listen.destroy, focus: main.querySelector('h1') };
}

/**
 * Voice (from More): how talking becomes words, and how answers are read aloud. Only ways that work here
 * are listed (On this phone only in the apps, where the phone's recogniser has the language); the
 * browser's recogniser is shown but cannot be chosen while Private only is on.
 */
export function voiceScreen({ t, state, back, actions, voice, reader, native = null }) {
  const S = state.S;
  // Each way's tags: what it costs and who can hear it, as pictures with one or two words.
  const TAG = { free: ['gift', 'voice.tag.free', ''], paid: ['coins', 'voice.tag.paid', ''], phone: ['phone', 'voice.tag.phone', 'teal'], engine: ['server', 'voice.tag.engine', 'warn'], provider: ['eye', 'voice.tag.provider', 'warn'], maker: ['eye', 'voice.tag.maker', 'warn'], blocked: ['lock', 'voice.tag.blocked', ''] };
  const tagsOf = (keys) => el('span', { class: 'tags' }, ...keys.map((k) => el('span', { class: `tag ${TAG[k][2]}`.trim() }, icon(TAG[k][0], 14), el('span', { text: t(TAG[k][1]) }))));
  const choice = (group, id, title, sub, { on, disabled = false, tags = [] } = {}) =>
    option(
      el(
        'button',
        { type: 'button', class: `model-card${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), 'aria-disabled': String(disabled), 'aria-description': sub, disabled, id: `${group}-${id}`, onclick: () => (group === 'voiceIn' ? actions.setVoiceIn(id) : actions.setVoiceOut(id)) },
        el('b', { text: title }),
        tags.length ? tagsOf(tags) : null,
      ),
      sub,
      t('voice.info', { name: title }),
    );
  const inList = el('div', { class: 'model-list', role: 'radiogroup', 'aria-labelledby': 'voiceInHead' });
  const outList = el('div', { class: 'model-list', role: 'radiogroup', 'aria-labelledby': 'voiceOutHead' });
  // The phone's recogniser heard nothing twice while the sound was there, so the engine hears this phone
  // (core/talk.js); On this phone above takes it back.
  const phoneOff = sayEl('p', { class: 'hint', id: 'voicePhoneOff', hidden: true }, t('voice.in.phoneOff'), '', 'ear');
  const naturalHead = el('h2', { class: 'caps', id: 'naturalVoiceHead', text: t('voice.natural'), hidden: true });
  const naturalList = el('div', { class: 'model-list', role: 'radiogroup', id: 'naturalVoices', 'aria-labelledby': 'naturalVoiceHead', hidden: true });
  // Keep the natural voice on a phone that makes it slowly (answers then wait longer before they start).
  const prefer = el('button', { type: 'button', class: 'setting-row', id: 'preferNatural', role: 'switch', hidden: true });
  prefer.addEventListener('click', () => actions.setPreferNatural(!S.settings.preferNatural));
  const preferSub = el('p', { class: 'hint', id: 'preferNaturalSub', text: t('voice.preferNaturalSub') });
  const preferInfo = infoToggle(preferSub, t('voice.info', { name: t('voice.preferNatural') }), 'preferNaturalInfo');
  const preferRow = el('div', { class: 'with-info', hidden: true }, prefer, preferInfo);
  const draw = () => {
    const v = state.view();
    const ins = voice.inMods();
    const outs = voice.outMods();
    const inUsed = v.talk.route;
    const enclave = (kind) => voice.audio.model(kind)?.tier === 'enclave';
    const engineSub = (kind) => (enclave(kind) ? t(`voice.${kind === 'transcription' ? 'in' : 'out'}.engineSub`) : t(`voice.${kind === 'transcription' ? 'in' : 'out'}.engineStdSub`));
    const engineTags = (kind) => ['paid', enclave(kind) ? 'engine' : 'provider'];
    const inRows = [];
    // On this phone: Forge Private Voice's own speech to text, else the phone's own recogniser in the
    // Android or iPhone app where it has the language. Free, and the sound stays on the phone. One row for either.
    if (ins.bundled?.available() || ins.phone?.available()) inRows.push(choice('voiceIn', 'phone', t('voice.in.phone'), t('voice.in.phoneSub'), { on: inUsed === 'phone', tags: ['free', 'phone'] }));
    if (ins.engine?.available()) inRows.push(choice('voiceIn', 'engine', t('voice.in.engine'), engineSub('transcription'), { on: inUsed?.startsWith('engine'), tags: engineTags('transcription') }));
    if (ins.device?.available()) {
      const blocked = !!S.settings.privateOnly;
      inRows.push(choice('voiceIn', 'device', t('voice.in.device'), blocked ? t('voice.in.deviceOff') : t('voice.in.deviceSub'), { on: inUsed === 'device', disabled: blocked, tags: blocked ? ['blocked', 'maker'] : ['free', 'maker'] }));
    }
    inList.replaceChildren(...(inRows.length ? inRows : [sayEl('p', { class: 'hint', id: 'voiceInNone' }, t('voice.in.none'), '', 'alert')]));
    phoneOff.hidden = !(S.settings.phoneOff && ins.phone?.available() && inUsed && inUsed !== 'phone');
    // Automatic (the setting until one is picked) shows as the voice it reads with: the natural voice
    // where this phone runs it, else the phone's own voice, else the engine's.
    const picked = (S.settings.voiceOut ?? 'auto') === 'auto' ? (voice.outUsed?.() ?? 'auto') : S.settings.voiceOut;
    const outRows = [];
    if (outs.phonon?.available()) outRows.push(choice('voiceOut', 'phonon', t('voice.out.phonon'), native ? t('voice.out.phononSubApp') : t('voice.out.phononSub'), { on: picked === 'phonon', tags: ['free', 'phone'] }));
    if (outs.device?.available()) outRows.push(choice('voiceOut', 'device', t('voice.out.device'), t('voice.out.deviceSub'), { on: picked === 'device', tags: ['free', 'phone'] }));
    if (outs.engine?.available()) outRows.push(choice('voiceOut', 'engine', t('voice.out.engine'), engineSub('speech'), { on: picked === 'engine', tags: engineTags('speech') }));
    outRows.push(choice('voiceOut', 'off', t('voice.out.off'), t('voice.out.offSub'), { on: picked === 'off' }));
    outList.replaceChildren(...outRows);
    // Which speaker the natural voice reads with, while it is the voice in use: Maeve or Freya.
    const speakers = picked === 'phonon' && outs.phonon?.available() ? (voice.natural?.voices() ?? []) : [];
    const speaker = voice.natural?.picked();
    naturalHead.hidden = naturalList.hidden = speakers.length < 2;
    const naturalOn = picked === 'phonon' && !!outs.phonon?.available();
    prefer.hidden = preferRow.hidden = !naturalOn;
    if (!naturalOn) preferSub.hidden = true;
    prefer.setAttribute('aria-checked', String(!!S.settings.preferNatural));
    prefer.replaceChildren(el('span', {}, icon('speaker', 20), el('span', { text: t('voice.preferNatural') })), el('span', { class: 'value', text: S.settings.preferNatural ? t('look.on') : t('look.off') }));
    naturalList.replaceChildren(
      ...(speakers.length < 2 ? [] : speakers).map((v) =>
        option(
          el(
            'button',
            { type: 'button', class: `model-card${v.name === speaker ? ' on' : ''}`, role: 'radio', 'aria-checked': String(v.name === speaker), 'aria-description': t(`voice.natural.${v.name}`), id: `naturalVoice-${v.name}`, onclick: () => actions.setNaturalVoice(v.name) },
            el('b', { class: 'ib' }, icon('speaker', 18), el('span', { text: v.name })),
          ),
          t(`voice.natural.${v.name}`),
          t('voice.info', { name: v.name }),
        ),
      ),
    );
  };
  draw();
  const listen = screenListen({ t, reader, id: 'voiceListen', root: () => main });
  const main = el(
    'main',
    { class: 'screen sub voice', 'data-screen': 'voice' },
    listenHeader(t('voice.title'), back, t('common.back'), listen.node),
    el('div', { class: 'scroll' }, el('h2', { class: 'caps', id: 'voiceInHead', text: t('voice.in') }), inList, phoneOff, el('h2', { class: 'caps', id: 'voiceOutHead', text: t('voice.out') }), outList, naturalHead, naturalList, preferRow, preferSub),
  );
  listen.update();
  return { node: main, update: draw, destroy: listen.destroy, focus: main.querySelector('h1') };
}
