// Mode and look (XThemes) and Choose a model (DPrivateOnly), both reached from More.
import { isFreeModel } from '../core/price.js';
import { isPrivate, visibleModels } from '../core/state.js';
import { backHeader, el, icon } from '../core/ui.js';

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
  const group = el('div', { class: 'look-list', role: 'radiogroup', 'aria-label': t('look.look') });
  const follow = el('button', { type: 'button', class: 'setting-row', id: 'followSystem', role: 'switch' });
  const draw = () => {
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
    follow.setAttribute('aria-checked', String(!!S.settings.followSystem));
    follow.replaceChildren(el('span', { text: t('look.follow') }), el('span', { class: 'value', text: S.settings.followSystem ? t('look.on') : t('look.off') }));
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
      el('div', { class: 'mode-on', 'aria-current': 'true' }, icon('grid', 30), el('span', {}, el('b', { text: t('look.default') }), el('small', { text: t('look.defaultSub') })), el('span', { class: 'on-dot', 'aria-hidden': 'true' })),
      // Classic is the v1 chat page; Playful comes with a later slice and is not listed.
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

export function modelScreen({ t, state, back, actions, format }) {
  const S = state.S;
  const sw = el('button', { type: 'button', role: 'switch', class: 'switch', id: 'privateOnly', 'aria-label': t('model.privateOnly') }, el('span', { class: 'track' }, el('span', { class: 'knob' })));
  sw.addEventListener('click', () => actions.setPrivateOnly(!S.settings.privateOnly));
  const list = el('div', { class: 'model-list', role: 'radiogroup', 'aria-label': t('model.title') });
  const hidden = el('div', { class: 'dashed-box', id: 'hiddenNote' }, el('b', { text: t('model.hidden') }), el('p', { text: t('model.hiddenSub') }));
  const tag = (ico, text, cls = '') => el('span', { class: `tag ${cls}`.trim() }, icon(ico, 14), el('span', { text }));
  const draw = () => {
    sw.setAttribute('aria-checked', String(!!S.settings.privateOnly));
    const v = state.view();
    const models = visibleModels(S.models, S.settings);
    list.replaceChildren(
      ...(models.length
        ? models.map((m) => {
            const on = v.model?.id === m.id;
            const priv = isPrivate(m);
            // A free model (core/price.js isFreeModel) shows Free in place of a price.
            const free = isFreeModel(m);
            const p = free ? null : format.modelPrice(m);
            return el(
              'button',
              { type: 'button', class: `model-card${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), 'data-model': m.id, onclick: () => actions.chooseModel(m.id) },
              el('b', { text: m.name ?? m.id }),
              el(
                'span',
                { class: 'tags' },
                priv ? tag('lock', t('model.private'), 'teal') : tag('unlock', t('model.standard'), 'warn'),
                free ? tag('gift', t('model.free'), 'free') : null,
                m.speed === 'fast' ? tag('gauge', t('model.fast')) : null,
                m.capabilities?.vision ? tag('image', t('model.images')) : null,
                m.capabilities?.reasoning ? tag('bulb', t('model.reasoning')) : null,
              ),
              free ? el('small', { class: 'free-text', text: t('model.freeSub') }) : p ? el('small', { text: t('model.price', p) }) : null,
              priv ? null : el('small', { class: 'warn-text', text: t('model.standardWarn') }),
            );
          })
        : [el('p', { class: 'hint', text: t('model.none') })]),
    );
    hidden.hidden = !(S.settings.privateOnly && v.hiddenCount > 0);
  };
  draw();
  const main = el(
    'main',
    { class: 'screen sub model', 'data-screen': 'model' },
    backHeader(t('model.title'), back, t('common.back')),
    el(
      'div',
      { class: 'scroll' },
      el('div', { class: 'teal-panel' }, el('span', {}, el('b', { text: t('model.privateOnly') }), el('small', { text: t('model.privateOnlySub') })), sw),
      list,
      hidden,
    ),
  );
  return { node: main, update: draw, focus: main.querySelector('h1') };
}

/**
 * Voice (from More): how talking becomes words, and how answers are read aloud. Only ways that work here
 * are listed (On this phone only in the Android app, where its recogniser has the language); the
 * browser's recogniser is shown but cannot be chosen while Private only is on.
 */
export function voiceScreen({ t, state, back, actions, voice, native = null }) {
  const S = state.S;
  const option = (group, id, title, sub, { on, disabled = false } = {}) =>
    el(
      'button',
      { type: 'button', class: `model-card${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), 'aria-disabled': String(disabled), disabled, id: `${group}-${id}`, onclick: () => (group === 'voiceIn' ? actions.setVoiceIn(id) : actions.setVoiceOut(id)) },
      el('b', { text: title }),
      el('small', { text: sub }),
    );
  const inList = el('div', { class: 'model-list', role: 'radiogroup', 'aria-labelledby': 'voiceInHead' });
  const outList = el('div', { class: 'model-list', role: 'radiogroup', 'aria-labelledby': 'voiceOutHead' });
  const naturalHead = el('h2', { class: 'caps', id: 'naturalVoiceHead', text: t('voice.natural'), hidden: true });
  const naturalList = el('div', { class: 'model-list', role: 'radiogroup', id: 'naturalVoices', 'aria-labelledby': 'naturalVoiceHead', hidden: true });
  // Keep the natural voice on a phone that makes it slowly (answers then wait longer before they start).
  const prefer = el('button', { type: 'button', class: 'setting-row', id: 'preferNatural', role: 'switch', hidden: true });
  prefer.addEventListener('click', () => actions.setPreferNatural(!S.settings.preferNatural));
  const preferSub = el('p', { class: 'hint', id: 'preferNaturalSub', hidden: true, text: t('voice.preferNaturalSub') });
  const draw = () => {
    const v = state.view();
    const ins = voice.inMods();
    const outs = voice.outMods();
    const inUsed = v.talk.route;
    const engineSub = (kind) => (voice.audio.model(kind)?.tier === 'enclave' ? t(`voice.${kind === 'transcription' ? 'in' : 'out'}.engineSub`) : t(`voice.${kind === 'transcription' ? 'in' : 'out'}.engineStdSub`));
    const inRows = [];
    // On this phone: Forge Private Voice's own speech to text, else the phone's own recogniser in the Android
    // app where it has the language. Free, and the sound stays on the phone. One row for either.
    if (ins.bundled?.available() || ins.phone?.available()) inRows.push(option('voiceIn', 'phone', t('voice.in.phone'), t('voice.in.phoneSub'), { on: inUsed === 'phone' }));
    if (ins.engine?.available()) inRows.push(option('voiceIn', 'engine', t('voice.in.engine'), engineSub('transcription'), { on: inUsed?.startsWith('engine') }));
    if (ins.device?.available()) {
      const blocked = !!S.settings.privateOnly;
      inRows.push(option('voiceIn', 'device', t('voice.in.device'), blocked ? t('voice.in.deviceOff') : t('voice.in.deviceSub'), { on: inUsed === 'device', disabled: blocked }));
    }
    inList.replaceChildren(...(inRows.length ? inRows : [el('p', { class: 'hint', id: 'voiceInNone', text: t('voice.in.none') })]));
    // Automatic (the setting until one is picked) shows as the voice it reads with: the natural voice
    // where this phone runs it, else the phone's own voice, else the engine's.
    const choice = (S.settings.voiceOut ?? 'auto') === 'auto' ? (voice.outUsed?.() ?? 'auto') : S.settings.voiceOut;
    const outRows = [];
    if (outs.phonon?.available()) outRows.push(option('voiceOut', 'phonon', t('voice.out.phonon'), native ? t('voice.out.phononSubApp') : t('voice.out.phononSub'), { on: choice === 'phonon' }));
    if (outs.device?.available()) outRows.push(option('voiceOut', 'device', t('voice.out.device'), t('voice.out.deviceSub'), { on: choice === 'device' }));
    if (outs.engine?.available()) outRows.push(option('voiceOut', 'engine', t('voice.out.engine'), engineSub('speech'), { on: choice === 'engine' }));
    outRows.push(option('voiceOut', 'off', t('voice.out.off'), t('voice.out.offSub'), { on: choice === 'off' }));
    outList.replaceChildren(...outRows);
    // Which speaker the natural voice reads with, while it is the voice in use: Maeve or Freya.
    const speakers = choice === 'phonon' && outs.phonon?.available() ? (voice.natural?.voices() ?? []) : [];
    const picked = voice.natural?.picked();
    naturalHead.hidden = naturalList.hidden = speakers.length < 2;
    const naturalOn = choice === 'phonon' && !!outs.phonon?.available();
    prefer.hidden = preferSub.hidden = !naturalOn;
    prefer.setAttribute('aria-checked', String(!!S.settings.preferNatural));
    prefer.replaceChildren(el('span', { text: t('voice.preferNatural') }), el('span', { class: 'value', text: S.settings.preferNatural ? t('look.on') : t('look.off') }));
    naturalList.replaceChildren(
      ...(speakers.length < 2 ? [] : speakers).map((v) =>
        el(
          'button',
          { type: 'button', class: `model-card${v.name === picked ? ' on' : ''}`, role: 'radio', 'aria-checked': String(v.name === picked), id: `naturalVoice-${v.name}`, onclick: () => actions.setNaturalVoice(v.name) },
          el('b', { text: v.name }),
          el('small', { text: t(`voice.natural.${v.name}`) }),
        ),
      ),
    );
  };
  draw();
  const main = el(
    'main',
    { class: 'screen sub voice', 'data-screen': 'voice' },
    backHeader(t('voice.title'), back, t('common.back')),
    el('div', { class: 'scroll' }, el('h2', { class: 'caps', id: 'voiceInHead', text: t('voice.in') }), inList, el('h2', { class: 'caps', id: 'voiceOutHead', text: t('voice.out') }), outList, naturalHead, naturalList, prefer, preferSub),
  );
  return { node: main, update: draw, focus: main.querySelector('h1') };
}
