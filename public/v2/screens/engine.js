// Engine (More, Engine): where Forge sends questions and payments. The canvas does not draw it; it is
// built from the settings screens' parts (the plan's decision 4). The website uses its own engine
// unless the person sets another; the Android app uses Forge's engine (core/native.js DEFAULT_ENGINE).
import { engineLabel, normalizeEngine } from '../core/engineaddr.js';
import { backHeader, el, msgLine } from '../core/ui.js';

const WHY = { empty: 'engine.err.empty', invalid: 'engine.err.invalid', insecure: 'engine.err.insecure', extra: 'engine.err.extra' };

/**
 * engine: {current() -> the base in use ('' for this site), fallback -> the default base, set(base|null)
 * -> Promise<{ok} | {why}>}. set checks that the engine answers before it switches, then reopens the
 * app on the new engine.
 */
export function engineScreen({ t, back, engine }) {
  const name = (base) => engineLabel(base) || t('engine.site');
  const input = el('input', {
    id: 'engineAddress',
    class: 'field-input',
    type: 'url',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: t('engine.placeholder'),
    value: engine.current() && engine.current() !== engine.fallback ? engine.current() : '',
  });
  const msg = msgLine();
  msg.id = 'engineMsg';
  let busy = false;

  async function apply(value) {
    if (busy) return;
    let base = null;
    if (value !== null) {
      const n = normalizeEngine(value);
      if (!n.ok) return msg.set(t(WHY[n.why]), 'err');
      base = n.value;
    }
    if ((base ?? engine.fallback) === engine.current()) return msg.set(t('engine.same'));
    busy = true;
    msg.set(t('engine.checking'));
    const r = await engine.set(base).catch(() => ({ why: 'offline' }));
    busy = false;
    if (!r?.ok) msg.set(t('engine.err.offline'), 'err');
  }

  const useBtn = el('button', { type: 'button', class: 'btn primary block', id: 'engineUse', onclick: () => apply(input.value), text: t('engine.use') });
  const defaultBtn = el('button', { type: 'button', class: 'btn block', id: 'engineDefault', onclick: () => apply(null), text: t('engine.default') });
  defaultBtn.hidden = engine.current() === engine.fallback;
  input.addEventListener('keydown', (e) => e.key === 'Enter' && apply(input.value));

  const main = el(
    'main',
    { class: 'screen sub engine', 'data-screen': 'engine' },
    backHeader(t('engine.title'), back, t('common.back')),
    el(
      'div',
      { class: 'scroll' },
      el('p', { class: 'lead', text: t('engine.lead') }),
      el('p', { class: 'note', id: 'engineNow', text: t('engine.now', { address: name(engine.current()) }) }),
      el('div', { class: 'field' }, el('label', { for: 'engineAddress', class: 'label', text: t('engine.label') }), input),
      el('p', { class: 'note', text: t('engine.defaultIs', { address: name(engine.fallback) }) }),
      el('p', { class: 'note', text: t('engine.balance') }),
      msg,
    ),
    el('div', { class: 'foot' }, useBtn, defaultBtn),
  );
  return { node: main, focus: main.querySelector('h1') };
}
