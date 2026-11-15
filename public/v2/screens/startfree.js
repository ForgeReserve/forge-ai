// Start free (docs/PAYMENTS.md, Free models): an invite code opens a balance with nothing on it, for
// the free models, and then one question, in plain words, before Private only is turned off for them.
// Free models are Standard models, so Private only (on by default) hides them: it is never turned off
// without that question. Used by the first run's invite sheet and the Start free card on Funds and Add
// funds. With a balance key already (at $0) there is no invite field: one button chooses a free model.
import { el, icon } from '../core/ui.js';

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
      say(e?.code === 'invite_used' ? t('fund.invite.used') : e?.code === 'invite_required' || e?.code === 'invite_invalid' ? t('fund.invite.bad') : t('fund.failed', { message: e?.message ?? String(e) }), 'err');
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

/** Whether Funds and Add funds show the Start free card (state.view()): free models, and no key or $0 on a paid model. */
export const startFreeWanted = (v) => !!v.startFree && (!v.hasKey || (v.balanceMsub === 0 && !v.modelFree));

/** The Start free card at the top of Funds and Add funds. Returns {node, update}. */
export function startFreeCard(ctx, id) {
  const flow = startFree(ctx, { id });
  const node = el('section', { class: 'card start-free-card', id: `${id}StartFreeCard`, 'aria-labelledby': `${id}StartFreeCap` }, el('h2', { class: 'caps gold', id: `${id}StartFreeCap`, text: ctx.t('startFree.title') }), flow.node);
  const update = () => {
    node.hidden = !(startFreeWanted(ctx.state.view()) || flow.busy());
    if (!node.hidden) flow.update();
  };
  update();
  return { node, update };
}
