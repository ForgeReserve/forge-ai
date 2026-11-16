// A mode module: a plain home with the balance, one big Type button and More, and an answer screen with
// the question, the answer as plain text, Stop while it comes in, and Back. It uses only its inputs and
// the app's existing strings.
export function create({ t, ui, state, nav, actions }) {
  const btn = (id, icon, word, onclick, primary = false) => ui.el('button', { type: 'button', class: `btn block${primary ? ' primary' : ''}`, id, onclick }, ui.icon(icon, 22), ui.el('span', { text: word }));

  /** The home. With `sheet` (the Add or More menu) it shows the menu and a Close button. */
  function home({ sheet = null } = {}) {
    const balance = ui.el('p', { class: 'hint', id: 'plainBalance' });
    const type = btn('plainType', 'keyboard', t('home.type'), () => nav('type'), true);
    const more = sheet ? btn('plainClose', 'x', t('home.close'), () => nav('home')) : btn('plainMore', 'dots', t('home.more'), () => nav('more'));
    const node = ui.el('main', { class: 'screen sub', 'data-screen': 'home' }, ui.el('div', { class: 'scroll' }, balance, type, sheet), ui.el('div', { class: 'foot' }, more));
    const update = () => {
      balance.textContent = state.view().balanceText ?? '';
    };
    update();
    return { node, update, focus: type };
  }

  /** The answer to the last question, as it streams in. */
  function answer() {
    const question = ui.el('p', { class: 'hint', id: 'plainQuestion' });
    const text = ui.el('p', { id: 'plainAnswer' });
    const stop = btn('plainStop', 'stop', t('answer.stop'), () => actions.stop());
    const back = btn('plainBack', 'back', t('common.back'), () => nav('home'), true);
    const node = ui.el('main', { class: 'screen sub', 'data-screen': 'answer' }, ui.el('div', { class: 'scroll' }, question, text), ui.el('div', { class: 'foot' }, stop, back));
    const update = () => {
      const v = state.view();
      const ex = v.lastExchange;
      question.textContent = typeof ex?.question === 'string' ? ex.question : '';
      text.textContent = ex?.answer.meta?.error?.message ?? ex?.answer.content ?? '';
      stop.hidden = !v.streaming;
    };
    update();
    return { node, update, focus: back };
  }

  return { id: 'plain', home, answer };
}
