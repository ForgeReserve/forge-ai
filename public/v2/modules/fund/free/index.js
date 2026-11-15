// Fund module: Free questions (docs/FREE-TIER.md). Opens the engine's daily faucet in the app: the phone
// works a short puzzle (proof of work, no name, no email), the engine hands out a voucher of free
// questions, and it is added at once through wallet.topupFree, which keeps it on the phone until the engine
// confirms it (core/vault.js) and puts it on the free balance, apart from any money.
// Listed only while the engine gives out free questions.
import { faucetLine, faucetRefusal, faucetStatus, getVoucher } from '../../../core/faucet.js';

export function create(inputs) {
  const { t, ui, engine, wallet } = inputs;
  return {
    id: 'free',
    group: 'unlinked',
    icon: 'gift',
    available: (methods) => !!methods?.free?.enabled,
    view({ done }) {
      const msg = ui.msgLine();
      const today = ui.el('p', { class: 'free-today', id: 'freeToday', role: 'status' });
      const ring = ui.el('div', { class: 'pow-ring', id: 'freeWork', role: 'progressbar', 'aria-label': t('fund.free.working'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, ui.el('span', { class: 'pow-pct' }));
      const working = ui.sayEl('p', { class: 'note', id: 'freeWorking', hidden: true }, t('fund.free.working'));
      const get = ui.el('button', { type: 'button', class: 'btn primary block', id: 'freeGet' }, ui.icon('gift', 20), ui.el('span', { text: t('fund.free.getSome') }));
      const stop = ui.el('button', { type: 'button', class: 'btn block', id: 'freeStop', hidden: true, text: t('fund.free.stop') });
      let ctrl = null;
      let questions = null;

      const progress = (p) => {
        const pct = Math.round(p * 100);
        ring.style.setProperty('--p', String(p));
        ring.setAttribute('aria-valuenow', String(pct));
        ring.firstChild.textContent = `${pct}%`;
      };
      const busy = (on) => {
        ring.hidden = !on;
        working.hidden = !on;
        stop.hidden = !on;
        get.hidden = on;
      };
      const showStatus = (s) => {
        questions = s.questions;
        const l = faucetLine(s);
        ui.say(today, t(l.key, l));
        get.querySelector('span').textContent = t('fund.free.get', { count: s.questions });
        get.disabled = !(s.available_now > 0);
      };
      faucetStatus(engine.call)
        .then(showStatus)
        .catch((e) => msg.set(t(faucetRefusal(e), { time: '' }), 'err'));

      get.addEventListener('click', async () => {
        if (ctrl) return;
        ctrl = new AbortController();
        msg.set('');
        progress(0);
        busy(true);
        let voucher;
        try {
          voucher = await getVoucher({ call: engine.call, onProgress: progress, signal: ctrl.signal });
        } catch (e) {
          busy(false);
          ctrl = null;
          if (e?.name === 'AbortError') return msg.set(t('fund.free.stopped'));
          const time = e?.nextAt ? new Date(e.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          msg.set(t(faucetRefusal(e), { time }), 'err');
          faucetStatus(engine.call).then(showStatus).catch(() => {});
          return;
        }
        ctrl = null;
        msg.set(t('fund.free.adding'));
        try {
          // A faucet voucher is always free questions: it goes to the free balance even when the
          // engine's credit mint has not been read yet.
          const r = await (wallet.topupFree ?? wallet.topup)(voucher.token);
          const words = t('fund.free.added', { count: r.credited ?? voucher.questions ?? questions });
          ui.toast(words);
          msg.set(words, 'ok');
          await wallet.refresh();
          done();
        } catch (e) {
          // The voucher is kept on the phone and sent again later (core/vault.js).
          msg.set(e?.retryable ? t('fund.free.kept') : t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          busy(false);
        }
      });
      stop.addEventListener('click', () => ctrl?.abort());

      const body = ui.el('div', { class: 'scroll fund-body' }, ui.sayEl('p', {}, t('fund.free.what')), today, ring, working, msg, ui.sayEl('p', { class: 'note' }, t('fund.free.notMoney')));
      const node = ui.el('div', { class: 'fund-view' }, body, ui.el('div', { class: 'foot' }, get, stop));
      return { node, destroy: () => ctrl?.abort() };
    },
  };
}
