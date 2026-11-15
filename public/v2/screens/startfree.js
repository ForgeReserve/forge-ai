// Start free (docs/PAYMENTS.md, Free models): an invite code opens a balance with nothing on it, for
// the free models, and then one question, in plain words, before Private only is turned off for them.
// Free models are Standard models, so Private only (on by default) hides them: it is never turned off
// without that question. startFree() is the first run's invite sheet; startFreeScreen() is the Start
// free card's own screen on Add money (AddFunds-C2 and C3 in docs/design/canvas). With a balance key
// already (at $0) there is no invite field: the one button chooses a free model.
import { el, icon, toast } from '../core/ui.js';
import { listenButton, listenHeader } from './parts.js';
import { cardArt } from './wallet-art.js';

/** What a refused invite code means, in words. */
const inviteError = (e, t) => (e?.code === 'invite_used' ? t('fund.invite.used') : e?.code === 'invite_required' || e?.code === 'invite_invalid' ? t('fund.invite.bad') : t('fund.failed', { message: e?.message ?? String(e) }));

/**
 * ctx: t, state, actions, wallet. id: the prefix of the element ids ('intro', 'funds', 'addFunds').
 * field: {input, box}, the invite field the caller already lays out (the first run's sheet shares its
 * own) and the box shown and hidden with it; else one is made, inside the returned node.
 * after(): called once the question is answered (or not needed), with the words shown.
 * Returns {node, update, busy()}: busy() is true while a result or the question is on show, so a card
 * that would hide once the model is free stays until the person moves on.
 */
export function startFree({ t, state, actions, wallet }, { id, field: given = null, after = () => {} }) {
  const S = state.S;
  const field = given?.input ?? el('input', { id: `${id}FreeInvite`, class: 'field-input', placeholder: t('invite.placeholder'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: wallet.invite() ?? '' });
  if (!given) field.addEventListener('input', () => wallet.setInvite(field.value.trim()));
  const note = el('p', { class: 'note', id: `${id}FreeNote`, text: t('startFree.note') });
  const msg = el('p', { class: 'msg', id: `${id}FreeMsg`, role: 'status' });
  const go = el('button', { type: 'button', class: 'btn primary block', id: `${id}StartFree` }, icon('gift', 20), el('span', { text: t('startFree.go') }));
  const useModel = el('button', { type: 'button', class: 'btn primary block', id: `${id}UseFreeModel`, hidden: true }, icon('gift', 20), el('span', { text: t('startFree.useModel') }));
  const useBtn = el('button', { type: 'button', class: 'btn primary', id: `${id}UseFree`, text: t('startFree.use') });
  const keepBtn = el('button', { type: 'button', class: 'btn', id: `${id}KeepPrivate`, text: t('startFree.keep') });
  const ask = el('div', { class: 'free-ask', id: `${id}FreeAsk`, role: 'group', 'aria-labelledby': `${id}FreeAskText`, hidden: true }, el('p', { id: `${id}FreeAskText`, text: t('startFree.ask') }), el('div', { class: 'row-btns' }, useBtn, keepBtn));
  const invite = given?.box ?? el('div', { class: 'field' }, el('label', { for: field.id, class: 'sr-only', text: t('invite.label') }), field);
  const node = el('div', { class: 'start-free', id: `${id}StartFreeBox` }, given ? null : invite, note, go, useModel, ask, msg);

  // 'form': the invite field (or the one button); 'opening': the invite is being spent; 'ask': the
  // question; 'done': the result.
  let phase = 'form';
  /** The status line under the flow; kind 'ok' or 'err' colours it. */
  const say = (text, kind = '') => {
    msg.textContent = text;
    msg.className = `msg ${kind}`.trim();
  };

  /** Chooses the free model (Private only goes off: only after the question, or when it is off already). */
  const use = (wasOn) => {
    const m = actions.useFreeModels();
    const words = m ? t(wasOn ? 'startFree.using' : 'startFree.ready', { name: m.name ?? m.id }) : t('startFree.noModel');
    say(words, m ? 'ok' : 'err');
    phase = 'done';
    draw();
    after(words);
  };
  /** The next step once there is a balance key: the question while Private only is on, else the model. */
  const next = () => {
    if (S.settings.privateOnly) {
      phase = 'ask';
      draw();
      useBtn.focus();
    } else use(false);
  };

  go.addEventListener('click', async () => {
    const code = field.value.trim();
    if (!code) {
      say(t('invite.missing'), 'err');
      field.focus();
      return;
    }
    go.disabled = true;
    say(t('fund.invite.opening'));
    // Busy from here: the key arrives before the answer does, and the screens keep showing this flow.
    phase = 'opening';
    try {
      await wallet.open(code);
      say(t('startFree.opened'), 'ok');
      next();
    } catch (e) {
      phase = 'form';
      say(inviteError(e, t), 'err');
    } finally {
      go.disabled = false;
    }
  });
  // A new code clears what was said about the last one.
  field.addEventListener('input', () => phase === 'form' && say(''));
  useModel.addEventListener('click', next);
  useBtn.addEventListener('click', () => use(true));
  keepBtn.addEventListener('click', () => {
    const words = t('startFree.kept');
    say(words, 'ok');
    phase = 'done';
    draw();
    after(words);
  });

  const draw = () => {
    const key = !!wallet.key();
    const form = phase === 'form' || phase === 'opening';
    invite.hidden = go.hidden = (key && phase === 'form') || !form;
    useModel.hidden = !key || phase !== 'form';
    note.hidden = !form;
    ask.hidden = phase !== 'ask';
    if (!field.value && wallet.invite()) field.value = wallet.invite();
  };
  draw();
  return { node, update: draw, busy: () => phase !== 'form' };
}

/** Whether Add money shows the Start free card first (state.view()): free models, and no key or $0 on a paid model. */
export const startFreeWanted = (v) => !!v.startFree && (!v.hasKey || (v.balanceMsub === 0 && !v.modelFree));


// What Start free said when it chose the free model, shown once on Funds (AddFunds-C4).
let said = null;
/** The words Start free left for Funds, once. */
export function takeSaid() {
  const s = said;
  said = null;
  return s;
}

/**
 * Start free's own screen (AddFunds-C2 and C3): the invite code, with Paste and Scan, three icon tiles
 * (no name, no email, no money), and the one button. Then the question, over the screen, while Private
 * only is on, in the same words as everywhere else. A yes chooses the free model and goes to Funds,
 * which says so (AddFunds-C4); Keep Private only goes back.
 */
export function startFreeScreen({ t, state, back, backTo, actions, wallet, reader, scan }) {
  const S = state.S;
  let phase = 'form'; // 'form', 'opening', 'ask'
  let job = null;
  const msg = el('p', { class: 'msg', id: 'startFreeMsg', role: 'status' });
  const say = (text, kind = '') => {
    msg.textContent = text;
    msg.className = `msg ${kind}`.trim();
  };

  // The hero: the ticket, with the info button.
  const infoLine = el('p', { class: 'sf-info', id: 'startFreeInfo', hidden: true, text: t('startFree.note') });
  const infoBtn = el('button', { type: 'button', class: 'way-info-btn', id: 'startFreeInfoBtn', 'aria-label': t('ways.info', { name: t('startFree.title') }), 'aria-expanded': 'false', 'aria-controls': 'startFreeInfo' }, icon('info', 22));
  infoBtn.addEventListener('click', () => {
    infoLine.hidden = !infoLine.hidden;
    infoBtn.setAttribute('aria-expanded', String(!infoLine.hidden));
  });
  const hero = el('div', { class: 'sf-hero', 'data-way': 'start' }, cardArt('start', null, t('startFree.title')), infoBtn);

  // The code: typed, pasted, or scanned from a printed invite.
  const input = el('input', { id: 'startFreeCode', class: 'field-input sf-code', placeholder: t('invite.placeholder'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: wallet.invite() ?? '' });
  const setCode = (text) => {
    input.value = String(text ?? '').trim();
    wallet.setInvite(input.value);
    if (phase === 'form') say('');
  };
  input.addEventListener('input', () => setCode(input.value));
  const paste = el('button', { type: 'button', class: 'btn sf-btn', id: 'startFreePaste' }, icon('paste', 22), el('span', { text: t('startFree.paste') }));
  paste.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text?.trim()) setCode(text);
    } catch {
      /* no clipboard here: the field takes a long press instead */
    }
    input.focus();
  });
  const video = el('video', { muted: true, playsinline: true, 'aria-label': t('fund.scanHint') });
  const scanner = el('div', { class: 'scanner', id: 'startFreeScanner', hidden: true }, video);
  const stopScan = () => {
    job?.stop();
    job = null;
    scanner.hidden = true;
  };
  const scanBtn = scan?.available()
    ? el('button', { type: 'button', class: 'btn sf-btn', id: 'startFreeScan' }, icon('camera', 22), el('span', { text: t('startFree.scan') }))
    : null;
  scanBtn?.addEventListener('click', async () => {
    if (job) return stopScan();
    scanner.hidden = false;
    try {
      job = await scan.open(video);
      const text = await job.promise;
      stopScan();
      setCode(text);
    } catch {
      stopScan();
    }
  });
  const field = el(
    'div',
    { class: 'sf-field', id: 'startFreeField' },
    el('label', { for: 'startFreeCode', class: 'label', text: t('invite.label') }),
    input,
    el('div', { class: 'sf-row' }, paste, scanBtn),
    scanner,
  );
  const tile = (ico, key) => el('li', { class: 'sf-tile' }, icon(ico, 26), el('span', { text: t(key) }));
  const tiles = el('ul', { class: 'sf-tiles', id: 'startFreeTiles' }, tile('noName', 'startFree.noName'), tile('noEmail', 'startFree.noEmail'), tile('noMoney', 'startFree.noMoney'));
  const go = el('button', { type: 'button', class: 'btn primary block sf-go', id: 'startFreeGo' }, icon('gift', 22), el('span', { text: t('startFree.go') }));

  // The question (AddFunds-C3): over the screen, in the same words as the first run's.
  const opened = el('p', { class: 'sf-opened', id: 'startFreeOpened', role: 'status', hidden: true }, icon('check', 20, 2.8), el('span', { text: t('startFree.opened') }));
  const choice = (ico, word, tag, kind) => el('div', { class: `sf-choice ${kind}` }, el('span', { class: 'sf-choice-ico' }, icon(ico, 34)), el('b', { text: t(word) }), el('span', { class: `sf-tag ${kind}` }, icon(kind === 'standard' ? 'check' : 'coins', 13), el('span', { text: t(tag) })));
  const useBtn = el('button', { type: 'button', class: 'btn primary block', id: 'startFreeUse' }, icon('check', 22, 2.8), el('span', { text: t('startFree.use') }));
  const keepBtn = el('button', { type: 'button', class: 'btn block', id: 'startFreeKeep' }, icon('lock', 20), el('span', { text: t('startFree.keep') }));
  const sheet = el(
    'div',
    { class: 'sf-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'startFreeAskText' },
    el('span', { class: 'sf-grabber', 'aria-hidden': 'true' }),
    el('div', { class: 'sf-choices' }, choice('lock', 'startFree.private', 'startFree.needsMoney', 'private'), choice('eye', 'startFree.standard', 'startFree.free', 'standard')),
    el('p', { class: 'sf-callout', id: 'startFreeAskText' }, icon('eye', 24), el('span', { text: t('startFree.ask') })),
    el('div', { class: 'foot' }, useBtn, keepBtn),
  );
  const ask = el('div', { class: 'sf-ask', id: 'startFreeAsk', hidden: true }, opened, sheet);

  const listen = listenButton({ t, reader, id: 'startFreeListen', pieces: () => (phase === 'ask' ? [t('startFree.ask')] : [t('startFree.title'), t('startFree.note')]) });
  const main = el(
    'main',
    { class: 'screen sub start-free-screen', 'data-screen': 'startFree' },
    listenHeader(t('startFree.title'), back, t('common.back'), listen.node),
    hero,
    infoLine,
    field,
    tiles,
    msg,
    el('div', { class: 'foot' }, go),
    ask,
  );

  /** Chooses the free model, then Funds says so. wasOn: Private only was on, and the person said yes. */
  const use = (wasOn) => {
    const m = actions.useFreeModels();
    if (!m) {
      phase = 'form';
      draw();
      return say(t('startFree.noModel'), 'err');
    }
    said = t(wasOn ? 'startFree.using' : 'startFree.ready', { name: m.name ?? m.id });
    backTo('funds');
  };
  /** Once there is a balance key: the question while Private only is on, else the model. */
  const next = (justOpened) => {
    if (!S.settings.privateOnly) return use(false);
    phase = 'ask';
    opened.hidden = !justOpened;
    draw();
    listen.update();
    useBtn.focus();
  };
  go.addEventListener('click', async () => {
    if (wallet.key()) return next(false);
    const code = input.value.trim();
    if (!code) {
      say(t('invite.missing'), 'err');
      input.focus();
      return;
    }
    go.disabled = true;
    phase = 'opening';
    say(t('fund.invite.opening'));
    try {
      await wallet.open(code);
      say('');
      next(true);
    } catch (e) {
      phase = 'form';
      say(inviteError(e, t), 'err');
    } finally {
      go.disabled = false;
    }
  });
  useBtn.addEventListener('click', () => use(true));
  keepBtn.addEventListener('click', () => {
    toast(t('startFree.kept'), 4000);
    back();
  });

  const draw = () => {
    // With a balance key already, there is no code to give: the one button chooses a free model.
    field.hidden = !!wallet.key() && phase === 'form';
    ask.hidden = phase !== 'ask';
    main.classList.toggle('asking', phase === 'ask');
    if (!input.value && wallet.invite()) input.value = wallet.invite();
  };
  draw();
  return {
    node: main,
    update: draw,
    destroy: () => {
      stopScan();
      listen.destroy();
    },
    focus: main.querySelector('h1'),
  };
}
