// Free questions used up (docs/FREE-TIER.md, In the app): the three ways forward, with no pressure.
// Wait for tomorrow's free questions (when the engine gives them out), scan a note, or add money.
// Share unseen, History and Erase keep working without funds. The canvas draws no such screen
// (Decision 5): it is built from Add funds' rows.
import { faucetLine, faucetStatus } from '../core/faucet.js';
import { backHeader, el, listRow } from '../core/ui.js';

export function freeOutScreen({ t, state, nav, back, registry, engine }) {
  const S = state.S;
  const faucetOn = () => !!S.methods?.free?.enabled && registry.list('fund').some((x) => x.instance.id === 'free');
  // When more free questions come, once the engine's faucet says (the row keeps its plain words until then).
  let waitText = null;
  let canGet = false;
  const rows = el('div', { class: 'fund-groups', id: 'freeOutWays' });
  const draw = () => {
    const list = [];
    if (faucetOn()) {
      list.push(listRow({ ico: 'gift', tint: 'teal', title: canGet ? t('freeOut.get') : t('freeOut.wait'), sub: waitText ?? t('freeOut.waitSub'), id: 'freeOutWait', cls: 'teal-border', onclick: () => nav('fund', { id: 'free' }) }));
    }
    if (registry.list('fund').some((x) => x.instance.id === 'note')) list.push(listRow({ ico: 'qr', tint: 'gold', title: t('freeOut.note'), sub: t('freeOut.noteSub'), id: 'freeOutNote', onclick: () => nav('fund', { id: 'note' }) }));
    list.push(listRow({ ico: 'plus', tint: 'gold', title: t('freeOut.money'), sub: t('freeOut.moneySub'), id: 'freeOutMoney', onclick: () => nav('addFunds') }));
    rows.replaceChildren(...list);
  };
  draw();
  if (faucetOn() && engine) {
    faucetStatus(engine.call)
      .then((s) => {
        const l = faucetLine(s);
        waitText = t(l.key, l);
        canGet = l.now;
        draw();
      })
      .catch(() => {});
  }
  const main = el(
    'main',
    { class: 'screen sub free-out', 'data-screen': 'freeOut' },
    backHeader(t('freeOut.title'), back, t('common.back')),
    el('div', { class: 'scroll' }, el('p', { id: 'freeOutSub', text: t('freeOut.sub') }), el('p', { class: 'note', text: t('freeOut.stillFree') }), rows),
  );
  return { node: main, update: draw, focus: main.querySelector('h1') };
}
