// The /free page (docs/FREE-TIER.md, layer 3): free questions for anyone, every day, without a name.
// It asks the engine for a puzzle, the phone works it (proof of work), and the engine hands out a voucher
// of free questions as a QR code. Add to Forge keeps the voucher on this phone (the v2 app's vault, the
// same storage the app uses) and opens the app, which adds it to the free balance. The voucher can also
// be copied, printed or passed on. Nothing here is sent anywhere but this site's engine.
import * as QR from '../../js/qr.js';
import { createEngine } from '../core/engine.js';
import { faucetLine, faucetRefusal, faucetStatus, getVoucher } from '../core/faucet.js';
import { t } from '../core/i18n.js';
import { applyPageLook } from '../core/pagelook.js';
import { copy, el, icon, msgLine, toast } from '../core/ui.js';
import { createVault } from '../core/vault.js';

applyPageLook();
document.title = t('faucet.title');

const engine = createEngine({ base: '' });
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

const root = document.getElementById('free');
const today = el('p', { class: 'free-today', id: 'freeToday', role: 'status' });
const msg = msgLine();
const ring = el('div', { class: 'pow-ring', id: 'freeWork', role: 'progressbar', 'aria-label': t('fund.free.working'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, el('span', { class: 'pow-pct' }));
const working = el('p', { class: 'note', id: 'freeWorking', hidden: true, text: t('fund.free.working') });
const get = el('button', { type: 'button', class: 'btn primary block no-print', id: 'freeGet', disabled: true }, icon('gift', 20), el('span', { text: t('fund.free.getSome') }));
const stop = el('button', { type: 'button', class: 'btn block no-print', id: 'freeStop', hidden: true, text: t('fund.free.stop') });
const out = el('div', { id: 'voucherBox' });
const main = el(
  'main',
  { class: 'screen free-page', 'data-screen': 'free' },
  el('h1', { text: t('faucet.title') }),
  el('p', { class: 'lead no-print', text: t('faucet.sub') }),
  el('div', { class: 'no-print' }, today),
  ring,
  working,
  msg,
  out,
  get,
  stop,
);
root.replaceChildren(main);

let ctrl = null;
const progress = (p) => {
  ring.style.setProperty('--p', String(p));
  ring.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  ring.firstChild.textContent = `${Math.round(p * 100)}%`;
};
const busy = (on) => {
  ring.hidden = !on;
  working.hidden = !on;
  stop.hidden = !on;
  get.hidden = on;
};

async function refresh() {
  try {
    const s = await faucetStatus(engine.call);
    const l = faucetLine(s);
    today.textContent = t(l.key, l);
    get.querySelector('span').textContent = t('fund.free.get', { count: s.questions });
    get.disabled = !(s.available_now > 0);
  } catch (e) {
    today.textContent = '';
    get.disabled = true;
    msg.set(t(faucetRefusal(e), { time: time(e?.nextAt) }), 'err');
  }
}

/** The voucher: its QR code, how many questions, and Add to Forge, Copy and Print. */
function showVoucher(v) {
  const box = el('div', { class: 'qr', role: 'img', 'aria-label': t('faucet.qr', { count: v.questions }) });
  QR.renderQR(box, v.token, 'L').catch(() => {});
  const add = el('button', { type: 'button', class: 'btn primary block no-print', id: 'voucherAdd' }, icon('plus', 20), el('span', { text: t('faucet.add') }));
  add.addEventListener('click', () => {
    try {
      // Kept on this phone first; the app sends it to the free balance when it opens (core/vault.js).
      createVault(localStorage).hold(v.token, 'free');
    } catch (e) {
      return msg.set(String(e?.message ?? e), 'err');
    }
    msg.set(t('faucet.adding'), 'ok');
    location.href = '/v2/#/funds';
  });
  out.replaceChildren(
    el(
      'section',
      { class: 'voucher', id: 'voucher', 'data-token': v.token },
      el('b', { text: t('faucet.voucher', { count: v.questions }) }),
      box,
      el('p', { class: 'note', text: t('faucet.keep') }),
      add,
      el(
        'div',
        { class: 'row-btns no-print' },
        el('button', { type: 'button', class: 'btn', id: 'voucherCopy', onclick: async () => toast((await copy(v.token)) ? t('faucet.copied') : t('faucet.copyFailed')) }, icon('copy', 18), el('span', { text: t('faucet.copy') })),
        el('button', { type: 'button', class: 'btn', id: 'voucherPrint', onclick: () => window.print() }, el('span', { text: t('faucet.print') })),
      ),
    ),
  );
}

get.addEventListener('click', async () => {
  if (ctrl) return;
  ctrl = new AbortController();
  msg.set('');
  progress(0);
  busy(true);
  try {
    const v = await getVoucher({ call: engine.call, onProgress: progress, signal: ctrl.signal });
    showVoucher(v);
    get.hidden = true;
    stop.hidden = true;
    ring.hidden = true;
    working.hidden = true;
  } catch (e) {
    busy(false);
    msg.set(e?.name === 'AbortError' ? t('fund.free.stopped') : t(faucetRefusal(e), { time: time(e?.nextAt) }), e?.name === 'AbortError' ? '' : 'err');
    refresh();
  } finally {
    ctrl = null;
  }
});
stop.addEventListener('click', () => ctrl?.abort());

refresh();
