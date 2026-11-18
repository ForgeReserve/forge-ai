// Fund module: eCash. Paste (or scan) a Cashu token from an accepted mint. It wraps POST
// /v1/wallet/topup through wallet.topup, which stores the token on the phone before sending it and
// removes it only after the engine confirms the credit (core/vault.js).
//
// eCash from the engine's own mint in the unit these funds do not hold (sats for dollar funds, or the
// reverse) is not added as it is: when the engine changes it (methods.convert), the price comes first
// (the other-mint quote, kit.js foreignQuote), with Yes and No. The phone reads the token's unit before
// sending it; a top-up the engine refuses with wrong_unit and a pointer to the change gets the same offer.
// A token handed over by another fund module (a scanned note, a card tap) fills the box and is sent at once.
import { noteVerdict, readNote } from '../../../core/note.js';
import { foreignQuote, inviteField, tokenBox } from '../kit.js';

export function create(inputs) {
  const { t, ui, wallet, engine, format } = inputs;
  return {
    id: 'ecash',
    group: 'unlinked',
    icon: 'coins',
    available: () => true,
    view({ done, added, open, token: given }) {
      const msg = ui.msgLine();
      // A way on from a refusal: eCash from another mint goes to Other mint, with the token.
      const onward = ui.el('div', { class: 'onward', hidden: true });
      const invite = inviteField(inputs);
      const add = ui.el('button', { type: 'button', class: 'btn primary block', id: 'ecashAdd' }, ui.icon('addMoney', 22), ui.el('span', { text: t('fund.ecash.add') }));
      // Which mints are taken: detail, behind the info button at the box's label.
      const mints = wallet.mints();
      const box = tokenBox(inputs, { id: 'ecashToken', label: t('fund.ecash.label'), onScanned: () => add.click(), info: mints.length ? t('fund.ecash.mints', { mints: mints.join(', ') }) : null });
      const form = [invite.node, box.node, msg, onward].filter(Boolean);
      const body = ui.el('div', { class: 'scroll fund-body' }, ...form);
      const foot = ui.el('div', { class: 'foot' }, add);
      let quote = null;

      /** The engine changes eCash from its own mint into the unit of the funds on this phone. */
      const canConvert = () => !!wallet.key() && !!wallet.unit() && !!wallet.methods()?.convert?.units?.includes(wallet.unit());
      /** No: back to the box with the token in it, nothing sent and nothing kept. */
      const keep = () => {
        quote?.stop();
        quote = null;
        body.replaceChildren(...form);
        foot.replaceChildren(add);
        msg.set(t('fund.convert.kept'), 'ok');
      };
      const convert = async (token, unit) => {
        msg.set(t('fund.othermint.checking'));
        const r = await engine.foreignQuote(wallet.key(), { token, unit, pubkey: wallet.lockKey() || undefined });
        if (!r.ok) return msg.set(t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
        msg.set('');
        quote = foreignQuote(inputs, { body, foot, f: r.body, token, done, added, onNo: keep });
      };

      add.addEventListener('click', async () => {
        const token = box.value();
        onward.hidden = true;
        if (!/^cashu[AB]/.test(token)) return msg.set(t('fund.ecash.bad'), 'err');
        add.disabled = true;
        try {
          // Read before sending: from the engine's own mint, in the other unit, goes to the price.
          const note = readNote(token);
          if (note.ok && canConvert() && noteVerdict(note, { mints: wallet.mints(), aliases: wallet.mintAliases(), units: wallet.units(), balanceUnit: wallet.unit(), convert: true }) === 'convert') return await convert(token, wallet.unit());
          if (invite.missing(msg)) return;
          msg.set(t('fund.ecash.sending'));
          const r = await wallet.topup(token, invite.value());
          box.clear();
          // A voucher of free questions is counted in questions, never as an amount of money.
          const text = r.replay ? t('fund.ecash.replay') : r.free ? t('fund.free.added', { count: r.credited }) : t('fund.ecash.added', { amount: format.units(r.credited, r.unit) });
          msg.set(text, 'ok');
          await wallet.refresh();
          // Funds says it in its success panel.
          done({ words: text, amount: r.replay ? '' : r.free ? t('fund.note.free', { count: r.credited }) : format.units(r.credited, r.unit), plus: !r.free });
        } catch (e) {
          // The engine read it for the phone: its unit is not these funds', and it says it can change it.
          if (e?.code === 'wrong_unit' && e.body?.convert?.unit && wallet.key()) await convert(token, e.body.convert.unit).catch((x) => msg.set(t('fund.failed', { message: x?.message ?? String(x) }), 'err'));
          else if (e?.code === 'untrusted_mint') {
            msg.set(t('fund.ecash.otherMint'), 'err');
            if (wallet.methods()?.foreign?.enabled) {
              onward.replaceChildren(ui.el('button', { type: 'button', class: 'btn block', id: 'ecashOtherMint', onclick: () => open('othermint', { token }) }, ui.icon('swap', 20), ui.el('span', { text: t('fund.note.useOtherMint') })));
              onward.hidden = false;
            }
          }
          else if (e?.code === 'token_spent') msg.set(t('fund.ecash.spent'), 'err');
          else if (e?.retryable) msg.set(t('fund.ecash.kept'), 'err');
          else msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          add.disabled = false;
        }
      });
      if (given) {
        box.input.value = given;
        queueMicrotask(() => add.click());
      }
      const node = ui.el('div', { class: 'fund-view' }, body, foot);
      return {
        node,
        destroy: () => {
          quote?.stop();
          box.stop();
        },
      };
    },
  };
}
