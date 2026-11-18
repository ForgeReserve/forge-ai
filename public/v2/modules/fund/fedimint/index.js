// Fund module: Tap a Fedimint card (slice A14). A Fedimint card's notes can only be redeemed by a
// till, so the card pays the engine's Lightning invoice through one (fedimintcard-pay docs/PAY.md):
// the engine makes the invoice, the price is shown, the person holds the card to the phone, the phone
// passes the till's card commands to the card over the card link, the till charges the card and pays
// the invoice, and the engine credits the funds. The work is core/till.js; this file is the screen.
//
// Only the Android app can do this: a web page cannot talk to the card, and the till's pay token is
// kept by the app (ForgeTill). The till is paired once, by scanning the pay code the till shows.
//
// Every payment is stored on the phone before the till hears of it, and stays until the engine
// credited it or the till gave the card its money back. A failed payment is listed with Get it back.
import { fundIn, inviteField, lightningUnit, poll } from '../kit.js';
import { cardFace } from '../../../screens/brands/cards.js';
import { wayHero } from '../../../screens/wallet-art.js';
import { tillLabel } from '../../../core/till.js';
import { showOffer } from '../../../core/getapp.js';

const kids = (...list) => list.filter((x) => x != null && x !== '' && x !== false);
const sats = (msat) => Math.ceil(msat / 1000);

/** The words for a till's refusal of a pay (core/till.js readPay), or null for one handled elsewhere. */
export function wordsFor(out, t) {
  switch (out?.code) {
    case 'wrong_pin':
      // The tries left stay in view, after a comma: "Wrong PIN, 2 tries left." Unknown: "Wrong PIN."
      if (out.triesLeft == null) return t('fund.fedimint.wrongPinOnly');
      return t('fund.fedimint.wrongPin', { tries: out.triesLeft === 1 ? t('fund.fedimint.tryLeft') : t('fund.fedimint.triesLeft', { count: out.triesLeft }) });
    case 'pin_blocked':
      return t('fund.fedimint.pinBlocked');
    case 'pin_required':
      return t('fund.fedimint.pinNeeded');
    case 'insufficient':
    case 'no_exact_plan':
      return t('fund.fedimint.insufficient');
    case 'no_card':
    case 'card_link_gone':
      return t('fund.fedimint.tapLost');
    case 'busy':
    case 'recovering':
      return t('fund.fedimint.busy');
    case 'unknown_card':
      return t('fund.fedimint.unknownCard');
    case 'fee_reserve_too_low':
      // A larger fee the phone can ask comes back as a new price (kind 'requote'); this is the till
      // asking the same fee again, above its own cap.
      return t('fund.fedimint.feeTooHigh');
    case 'invoice_expired':
      return t('fund.fedimint.expired');
    case 'wrong_network':
      return t('fund.fedimint.wrongNetwork');
    case 'daily_cap':
      return t('fund.fedimint.dailyCap');
    case 'pay_disabled':
      return t('fund.fedimint.payDisabled');
    case 'lightning_unavailable':
    case 'lightning_error':
      return t('fund.fedimint.lnDown');
    case 'over_limit':
      return t('fund.fedimint.overLimit');
    case 'invoice_in_use':
      return t('fund.fedimint.inUse');
    case 'unauthorized':
    case 'forbidden':
      return t('fund.fedimint.auth');
    default:
      return out?.kind === 'card' ? t('fund.fedimint.cardRefused') : t('fund.fedimint.tillRefused');
  }
}

/**
 * The words for an error core/till.js threw while paying or giving back (TillError codes), for a
 * payment rec. 'auth' is handled by pairing again.
 */
export function thrownWords(code, t, rec = null) {
  switch (code) {
    case 'not_stored':
      return t('fund.fedimint.notStored');
    case 'not_stored_after':
      // The till has the request, and the card may have paid: the payment is kept as sent.
      return t('fund.fedimint.noAnswer');
    case 'other_till':
      return t('fund.fedimint.otherTill', { till: tillLabel(rec?.till ?? '') });
    default:
      return t('fund.fedimint.unreachable');
  }
}

/** Refusals after which this invoice cannot be paid: a new one is needed. */
const NEW_INVOICE = new Set(['invoice_expired', 'invoice_in_use', 'over_limit', 'bad_invoice']);

export function create(inputs) {
  const { t, ui, engine, wallet, format, scan, nfc, till } = inputs;
  const ready = () => !!nfc?.supported?.() && !!till?.supported?.();
  return {
    id: 'fedimint',
    group: 'unlinked',
    icon: 'card',
    // The till pays the engine's Lightning invoice, so the row needs Lightning at the engine. Not in the
    // iPhone app: it reads cards but has no till yet (ForgeTill is Android's), and no app to point to.
    available: (methods) => nfc?.listed?.() !== false && !(nfc?.supported?.() && !till?.supported?.()) && !!methods?.lightning?.enabled,
    usable: () => ready(),
    /** The row's line: what is needed while no till is set. */
    sub: () => (ready() && !till.settings.get() ? 'fund.fedimint.subNoTill' : 'fund.fedimint.sub'),
    view({ done }) {
      const msg = ui.msgLine();
      const body = ui.el('div', { class: 'scroll fund-body' });
      const foot = ui.el('div', { class: 'foot' });
      const node = ui.el('div', { class: 'fund-view card-view fedimint-view' }, body, foot);
      const btn = (attrs, ico, label) => ui.el('button', { type: 'button', ...attrs }, ico ? ui.icon(ico, 20) : null, ui.el('span', { text: label }));
      const pays = till?.pays;
      let gone = false;
      let reader = null;
      let pollers = [];
      // What a card coming into the field is for: {mode: 'pay' | 'refund', id, pin}, or null.
      let want = null;
      let busy = false;

      const art = (amountText) =>
        ui.el(
          'div',
          { class: 'card-art', 'data-brand': 'fedimint', role: 'img', 'aria-label': t('fund.fedimint.picture') },
          // The card as it is printed (screens/brands/cards.js), with what it holds over it once read.
          cardFace('fedimint'),
          amountText ? ui.el('span', { class: 'card-art-amount', text: amountText }) : null,
        );
      const amountOf = (rec) => format.units(rec.amount, rec.unit);
      const stopPolls = () => {
        for (const p of pollers) p.stop();
        pollers = [];
      };

      // ------------------------------------------------------------ the website: no reader, no till

      if (!ready()) {
        body.replaceChildren(...kids(art(), ui.sayEl('p', { id: 'fedAppOnly' }, t('fund.fedimint.appOnly')), ui.sayEl('p', { class: 'note' }, t('fund.fedimint.what'))));
        // Get the app: the /download page. Not on an iPhone: its app has no till (core/getapp.js).
        showOffer(foot, ui, t, { id: 'fedGetApp', iphoneApp: false, alive: () => !gone });
        return {
          node,
          destroy() {
            gone = true;
          },
        };
      }

      // ------------------------------------------------------------ pairing with a till

      const pairView = (why = '') => {
        stopPolls();
        want = null;
        const paste = ui.el('textarea', { id: 'fedPairText', rows: '3', class: 'field-input mono', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
        const video = ui.el('video', { muted: true, playsinline: true, 'aria-label': t('fund.scanHint') });
        const box = ui.el('div', { class: 'scanner', hidden: true }, video, ui.sayEl('p', { class: 'note' }, t('fund.scanHint')));
        let job = null;
        const stopScan = () => {
          job?.stop();
          job = null;
          box.hidden = true;
        };
        const use = async (text) => {
          stopScan();
          msg.set('');
          try {
            const r = await till.pair(text);
            till.settings.paired(r.url);
            ui.toast(t('fund.fedimint.tillSet'));
            home();
          } catch (e) {
            msg.set(t(e?.code === 'pos' ? 'fund.fedimint.posCode' : e?.code === 'insecure' ? 'fund.fedimint.insecure' : 'fund.fedimint.notPayCode'), 'err');
          }
        };
        const scanBtn = scan?.available()
          ? btn(
              {
                class: 'btn primary block',
                id: 'fedScan',
                onclick: async () => {
                  box.hidden = false;
                  try {
                    job = await scan.open(video, undefined, { any: true });
                    const text = await job.promise;
                    await use(text);
                  } catch {
                    stopScan();
                  }
                },
              },
              'qr',
              t('fund.fedimint.scanTill'),
            )
          : null;
        body.replaceChildren(
          ...kids(
            art(),
            ui.sayEl('p', { id: 'fedNeedTill' }, t('fund.fedimint.needTill')),
            why ? ui.sayEl('p', { class: 'msg err' }, why, 'err') : null,
            scanBtn,
            box,
            ui.el('div', { class: 'field' }, ui.el('label', { for: 'fedPairText', class: 'label', text: t('fund.fedimint.pasteLabel') }), paste),
            msg,
          ),
        );
        // With no camera to scan the code, using the pasted one is the one lit button.
        foot.replaceChildren(btn({ class: scanBtn ? 'btn block' : 'btn primary block', id: 'fedUseTill', onclick: () => use(paste.value) }, 'check', t('fund.fedimint.useTill')));
        return { stop: stopScan };
      };

      // ------------------------------------------------------------ the till's settings

      const tillBox = () => {
        const s = till.settings.get();
        if (!s) return null;
        // A payment through this till that is not finished needs this till: its pay_id and client_ref
        // mean nothing to another one.
        const tied = pays.waiting().some((p) => p.till === s.url);
        const fixed = ui.el('input', { id: 'fedMarginSats', class: 'field-input', inputmode: 'numeric', autocomplete: 'off', value: String(Math.floor(s.margin.msat / 1000)) });
        const share = ui.el('input', { id: 'fedMarginPercent', class: 'field-input', inputmode: 'decimal', autocomplete: 'off', value: String(s.margin.bps / 100) });
        const note = ui.msgLine();
        return ui.el(
          'section',
          { class: 'till-box', id: 'fedTill', 'aria-labelledby': 'fedTillHead' },
          ui.sayEl('p', { class: 'label', id: 'fedTillHead' }, t('fund.fedimint.tillLabel')),
          ui.sayEl('p', { class: 'mono', id: 'fedTillUrl' }, tillLabel(s.url)),
          ui.el(
            'details',
            { class: 'till-margin' },
            ui.el('summary', { text: t('fund.fedimint.marginHead') }),
            ui.sayEl('p', { class: 'note' }, t('fund.fedimint.marginNote')),
            ui.el('label', { for: 'fedMarginSats', class: 'label', text: t('fund.fedimint.marginSats') }),
            fixed,
            ui.el('label', { for: 'fedMarginPercent', class: 'label', text: t('fund.fedimint.marginPercent') }),
            share,
            btn(
              {
                class: 'btn small',
                id: 'fedMarginSave',
                onclick: () => {
                  const a = fixed.value.trim();
                  const b = share.value.trim().replace(',', '.');
                  if (!/^\d{1,9}$/.test(a) || !/^\d{1,2}(\.\d{1,2})?$/.test(b)) return note.set(t('fund.fedimint.marginBad'), 'err');
                  till.settings.setMargin({ msat: Number(a) * 1000, bps: Math.round(Number(b) * 100) });
                  note.set(t('fund.fedimint.marginSaved'), 'ok');
                },
              },
              null,
              t('fund.fedimint.marginSave'),
            ),
            note,
          ),
          tied ? ui.sayEl('p', { class: 'note', id: 'fedTillBusy' }, t('fund.fedimint.tillBusy')) : null,
          ui.el(
            'div',
            { class: 'row-btns' },
            btn({ class: 'btn small', id: 'fedChangeTill', disabled: tied, onclick: () => pairView() }, 'qr', t('fund.fedimint.changeTill')),
            btn(
              {
                class: 'btn small',
                id: 'fedForgetTill',
                disabled: tied,
                onclick: async () => {
                  await till.forget();
                  till.settings.forget();
                  ui.toast(t('fund.fedimint.tillForgotten'));
                  pairView();
                },
              },
              'trash',
              t('fund.fedimint.forgetTill'),
            ),
          ),
        );
      };

      // ------------------------------------------------------------ payments not finished

      const waitingList = () => {
        const list = pays.waiting().filter((p) => (p.engine ?? '') === (engine.base ?? ''));
        if (!list.length) return null;
        const paired = till.settings.get()?.url ?? null;
        const row = (p) => {
          // Made through another till than the paired one: only that till can finish it.
          if (p.till && p.till !== paired)
            return ui.el('div', { class: 'card-failed', 'data-till-pay': p.id, 'data-state': p.state, 'data-other-till': '' }, ui.sayEl('p', {}, thrownWords('other_till', t, p)));
          const words = { sent: 'fund.fedimint.rowSent', undecided: 'fund.fedimint.rowUndecided', paid: 'fund.fedimint.rowPaid', pay_failed: 'fund.fedimint.rowFailed' }[p.state] ?? 'fund.fedimint.rowSent';
          const amount = p.state === 'pay_failed' ? format.units(sats(p.refundOwedMsat ?? p.receivedMsat ?? p.priceMsat), 'sat') : amountOf(p);
          const action =
            p.state === 'pay_failed'
              ? btn({ class: 'btn block', 'data-get-back': p.id, onclick: () => holdFor({ mode: 'refund', id: p.id }) }, 'again', t('fund.fedimint.getBack'))
              : p.state === 'sent' && !p.payId
                ? btn({ class: 'btn block', 'data-finish': p.id, onclick: () => priceView(p) }, 'card', t('fund.fedimint.finish'))
                : btn({ class: 'btn block', 'data-check': p.id, onclick: () => settle(p.id).then(() => home()) }, 'again', t('fund.fedimint.checkNow'));
          return ui.el('div', { class: 'card-failed', 'data-till-pay': p.id, 'data-state': p.state }, ui.sayEl('p', {}, t(words, { amount })), action);
        };
        return ui.el('section', { class: 'notice', id: 'fedWaiting', 'aria-labelledby': 'fedWaitingHead' }, ui.el('b', { id: 'fedWaitingHead', text: t('fund.fedimint.waitingHead') }), ...list.map(row));
      };

      /**
       * Settles one payment without the card: the engine first (its funds are the end of the story),
       * then the till. Returns the record as it is now, or null once it is done. quiet: the screen goes
       * to Funds next, whose success panel says what was added (lastAdded), so no toast here.
       */
      let lastAdded = null;
      const settle = async (id, { quiet = false } = {}) => {
        let rec = pays.get(id);
        if (!rec) return null;
        // The payment's funding is the balance's in its unit.
        const key = (wallet.keyFor && rec.unit ? wallet.keyFor(rec.unit) : null) ?? wallet.key();
        if (key && rec.fundingId && rec.state !== 'ready') {
          const f = await engine.funding(key, rec.fundingId).catch(() => null);
          if (f?.ok && f.body?.state === 'done') {
            rec = pays.credited(id);
            await wallet.refresh();
            if (!rec) {
              const amount = format.units(f.body.credited ?? f.body.amount, f.body.unit);
              const words = t('fund.fedimint.added', { amount });
              if (quiet) lastAdded = { words, amount };
              else ui.toast(words);
              return null;
            }
          }
        }
        if (rec.payId && (rec.state === 'undecided' || rec.state === 'sent')) {
          try {
            await pays.check(id);
          } catch (e) {
            // Another till is paired now: the row says which one the payment needs.
            if (e?.code !== 'other_till') throw e;
          }
        }
        return pays.get(id);
      };

      // ------------------------------------------------------------ the amount and the price

      const home = () => {
        stopPolls();
        want = null;
        msg.set('');
        const L = wallet.methods()?.lightning ?? {};
        // The till pays a Lightning invoice: in sats, for the sat balance, as Lightning is (kit.js lightningUnit).
        const units = [lightningUnit(wallet)];
        let unit = units[0];
        const invite = inviteField(inputs);
        const input = ui.el('input', { id: 'fedAmount', class: 'field-input', inputmode: 'decimal', autocomplete: 'off', 'aria-label': t('fund.fedimint.amountLabel') });
        const seg = ui.el('div', { class: 'seg', role: 'group', 'aria-label': t('fund.fedimint.amountLabel') });
        // The unit sits in the field, as on Lightning: "$" before an amount in dollars, "sat" after one in sats.
        const before = ui.el('span', { class: 'amount-unit before', 'aria-hidden': 'true', text: '$' });
        const after = ui.el('span', { class: 'amount-unit after', 'aria-hidden': 'true', text: 'sat' });
        const field = ui.el('div', { class: 'amount-field' }, before, input, after);
        const setUnit = (u) => {
          unit = u;
          before.hidden = u !== 'usd';
          after.hidden = u === 'usd';
          input.value = format.plain(u === 'usd' ? 500 : 5000, u);
          input.inputMode = u === 'usd' ? 'decimal' : 'numeric';
          for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.unit === u));
        };
        if (units.length > 1) for (const u of units) seg.append(ui.el('button', { type: 'button', 'data-unit': u, text: u === 'usd' ? 'USD' : 'sat', onclick: () => setUnit(u) }));
        setUnit(unit);
        const go = btn({ class: 'btn primary block', id: 'fedGetPrice' }, 'card', t('fund.fedimint.getPrice'));
        go.addEventListener('click', async () => {
          const amount = format.parse(input.value, unit);
          if (!Number.isInteger(amount) || amount < 1) return msg.set(unit === 'usd' ? t('fund.lightning.badAmount') : t('fund.lightning.badSats'), 'err');
          if (L.min?.[unit] && amount < L.min[unit]) return msg.set(t('fund.lightning.min', { amount: format.units(L.min[unit], unit) }), 'err');
          if (L.max?.[unit] && amount > L.max[unit]) return msg.set(t('fund.lightning.max', { amount: format.units(L.max[unit], unit) }), 'err');
          if (invite.missing(msg)) return;
          go.disabled = true;
          msg.set(t('fund.fedimint.pricing'));
          try {
            await newInvoice({ amount, unit, invite: invite.value() });
          } finally {
            go.disabled = false;
          }
        });
        body.replaceChildren(
          ...kids(
            art(),
            waitingList(),
            invite.node,
            ui.el('label', { for: 'fedAmount', class: 'label', text: t('fund.fedimint.amount') }),
            field,
            units.length > 1 ? seg : null,
            msg,
            tillBox(),
          ),
        );
        foot.replaceChildren(go);
        // Payments the till is still settling are asked about while this screen is open.
        if (pays.waiting().some((p) => p.state === 'undecided' || p.state === 'paid')) {
          pollers.push(
            poll(async () => {
              for (const p of pays.waiting().filter((x) => x.state === 'undecided' || x.state === 'paid')) await settle(p.id);
              // Only the list is drawn again, so an amount being typed stays.
              const box = body.querySelector('#fedWaiting');
              if (box && !gone && !want && !busy) {
                const now = waitingList();
                if (now) box.replaceWith(now);
                else box.remove();
              }
              return !pays.waiting().some((p) => p.state === 'undecided' || p.state === 'paid');
            }, 3000),
          );
        }
      };

      /** Asks the engine for an invoice for the amount, stores the payment, and shows its price. */
      const newInvoice = async ({ amount, unit, invite }) => {
        let r;
        try {
          r = await fundIn(wallet, unit, invite, (key, code, sibling) => engine.fundLightning(key, { amount, unit, invite: code }, sibling));
        } catch (e) {
          return msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        }
        // The engine would not open the sat balance: the amount again, in the unit the phone holds.
        if (r.body?.error?.code === 'sibling_refused') return home();
        if (!r.ok || !r.body?.request) return msg.set(t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
        const f = r.body;
        let rec;
        try {
          // An earlier price nobody paid with: nothing was sent with it, so it goes.
          for (const p of pays.all()) if (p.state === 'ready') pays.drop(p.id);
          rec = pays.start({ engine: engine.base ?? '', fundingId: f.id, bolt11: f.request, expiresAt: f.expires_at ?? null, amount: f.amount, unit: f.unit, tillUrl: till.settings.get()?.url ?? null });
        } catch (e) {
          return msg.set(e?.code === 'not_stored' ? t('fund.fedimint.notStored') : t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        }
        priceView(rec);
      };

      /** The price before the tap, and the PIN. */
      const priceView = (rec, line = '', kind = 'err') => {
        stopPolls();
        want = null;
        rec = pays.reprice(rec.id) ?? rec;
        const pin = ui.el('input', { id: 'fedPin', class: 'field-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', pattern: '[0-9]*' });
        const most = format.units(sats(rec.mostMsat), 'sat');
        // Until the till's margin is known (saved here, or seen in its answers), the most shown may be
        // below what the till charges: said so, never claimed as the most.
        const known = rec.marginKnown === true;
        body.replaceChildren(
          ...kids(
            art(amountOf(rec)),
            ui.el(
              'div',
              { class: 'card-preview', id: 'fedPrice' },
              ui.sayEl('p', { class: 'card-get', id: 'fedYouGet' }, t('fund.fedimint.youGet', { amount: amountOf(rec) })),
              ui.sayEl('p', { class: 'till-most', id: 'fedCardPays' }, t(known ? 'fund.fedimint.cardPays' : 'fund.fedimint.cardPaysPlusMargin', { amount: most })),
              ui.sayEl('p', { class: 'note', id: 'fedSplit' }, t(known ? 'fund.fedimint.split' : 'fund.fedimint.splitPlusMargin', { invoice: format.units(sats(rec.invoiceMsat), 'sat'), fee: format.units(sats(rec.tillMsat), 'sat') })),
              ui.sayEl('p', { class: 'note' }, t('fund.fedimint.feeKept')),
            ),
            ui.el('div', { class: 'field' }, ui.el('label', { for: 'fedPin', class: 'label', text: t('fund.fedimint.pinLabel') }), pin),
            msg,
          ),
        );
        msg.set(line, line ? kind : undefined);
        const payBtn = btn(
          {
            class: 'btn primary block',
            id: 'fedPay',
            onclick: () => {
              const p = pin.value.trim();
              if (p && !/^[0-9]{4,8}$/.test(p)) {
                msg.set(t('fund.fedimint.pinBad'), 'err');
                return pin.focus();
              }
              holdFor({ mode: 'pay', id: rec.id, pin: p });
            },
          },
          'card',
          t('fund.fedimint.pay', { amount: most }),
        );
        const back = rec.state === 'ready'
          ? btn(
              {
                class: 'btn block',
                id: 'fedChangeAmount',
                onclick: () => {
                  pays.drop(rec.id);
                  home();
                },
              },
              null,
              t('fund.fedimint.changeAmount'),
            )
          : null;
        foot.replaceChildren(...kids(payBtn, back));
      };

      // ------------------------------------------------------------ the tap

      const working = (text, amountText = null) => {
        msg.set('');
        body.replaceChildren(...kids(art(amountText), ui.sayEl('p', { class: 'status-line', id: 'fedStatus', role: 'status' }, text, 'wait')));
        foot.replaceChildren();
      };

      /** Waits for the card, or goes on with the one already on the phone. */
      const holdFor = (w) => {
        want = w;
        // Hold the card to the phone: the tap, as Add money's card draws it.
        body.replaceChildren(...kids(wayHero('fedimint', null), ui.sayEl('p', { class: 'card-hold', id: 'fedHold' }, t('fund.fedimint.hold')), ui.sayEl('p', { class: 'note' }, t('fund.fedimint.keep')), msg));
        foot.replaceChildren();
        if (current) run();
      };

      // The card in the field now. A card held to the phone before Pay is used; one that has left
      // fails its first command, and the till answers that nothing was taken.
      let current = null;
      const onCard = (card) => {
        if (gone || !card) return;
        current = card;
        run();
      };

      const run = async () => {
        if (gone || busy || !want || !current) return;
        const w = want;
        const card = current;
        want = null;
        busy = true;
        try {
          if (w.mode === 'refund') await refund(w.id, card);
          else await pay(w.id, card, w.pin);
        } finally {
          busy = false;
        }
      };

      const pay = async (id, card, pin) => {
        const rec0 = pays.get(id);
        if (!rec0) return home();
        working(t('fund.fedimint.paying'), amountOf(rec0));
        let out;
        try {
          out = await pays.pay(id, { card, pin });
        } catch (e) {
          if (e?.code === 'auth') return pairView(t('fund.fedimint.auth'));
          if (e?.code === 'not_stored') return priceView(rec0, thrownWords(e.code, t, rec0));
          if (e?.code === 'not_stored_after' || e?.code === 'other_till') {
            // Kept on the phone (as sent, or for its own till): listed with the payments not finished.
            home();
            return msg.set(thrownWords(e.code, t, rec0), 'err');
          }
          return priceView(pays.get(id) ?? rec0, thrownWords(e?.code, t, rec0));
        }
        const rec = out.rec;
        // The till's margin was more than the phone knew: said plainly; the next price includes it.
        if (Number.isSafeInteger(rec.tillPriceMsat) && rec.tillPriceMsat > rec.priceMsat) ui.toast(t('fund.fedimint.charged', { amount: format.units(sats(rec.tillPriceMsat), 'sat') }), 5000);
        switch (out.kind) {
          case 'paid':
            return credit(rec);
          case 'undecided':
            return undecided(rec);
          case 'pay_failed':
            return failedView(rec);
          case 'refunded':
            ui.toast(t('fund.fedimint.refunded', { amount: format.units(sats(rec.refundMsat ?? rec.receivedMsat ?? 0), 'sat') }));
            return home();
          case 'auth':
            return pairView(t('fund.fedimint.auth'));
          case 'requote':
            return priceView(rec, t('fund.fedimint.requote'), 'ok');
          case 'expired':
            pays.drop(rec.id);
            home();
            return msg.set(t('fund.fedimint.expired'), 'err');
          case 'before':
            // The till may still be finishing the request that got no answer: kept, and tried later.
            if (out.held) {
              home();
              return msg.set(t('fund.fedimint.held'), 'err');
            }
            // A payment kept as sent (an earlier request got no answer) is never dropped here.
            if (NEW_INVOICE.has(out.code) && rec.state === 'ready') {
              pays.drop(rec.id);
              home();
              return msg.set(wordsFor(out, t), 'err');
            }
            return priceView(rec, wordsFor(out, t));
          case 'card':
            if (out.code === 'no_card' || out.code === 'card_link_gone') {
              current = null;
              msg.set(wordsFor(out, t), 'err');
              return holdFor({ mode: 'pay', id, pin });
            }
            return priceView(rec, wordsFor(out, t));
          default:
            // No answer: the card may have paid. The payment is kept; the same request goes again.
            home();
            return msg.set(t('fund.fedimint.noAnswer'), 'err');
        }
      };

      /** The till is settling a pay the card paid for: asked again until it is paid or failed. */
      const undecided = (rec) => {
        working(t('fund.fedimint.undecided'), amountOf(rec));
        pollers.push(
          poll(async () => {
            const now = await settle(rec.id, { quiet: true });
            if (!now) {
              done(lastAdded ?? undefined);
              return true;
            }
            if (now.state === 'paid') {
              credit(now);
              return true;
            }
            if (now.state === 'pay_failed') {
              failedView(now);
              return true;
            }
            return false;
          }, 3000),
        );
      };

      /** The till paid the invoice: the engine credits it once it sees the payment. */
      const credit = (rec) => {
        working(t('fund.fedimint.adding'), amountOf(rec));
        pollers.push(
          poll(async () => {
            const now = await settle(rec.id, { quiet: true });
            if (!now) {
              done(lastAdded ?? undefined);
              return true;
            }
            return false;
          }, 2000),
        );
      };

      const failedView = (rec, line = '') => {
        stopPolls();
        const owed = format.units(sats(rec.refundOwedMsat ?? rec.receivedMsat ?? rec.priceMsat), 'sat');
        body.replaceChildren(
          ...kids(
            art(owed),
            ui.el('section', { class: 'notice', id: 'fedFailed' }, ui.el('b', { text: t('fund.fedimint.failedHead') }), ui.sayEl('p', { id: 'fedFailedLine' }, t('fund.fedimint.failed', { amount: owed }))),
            msg,
          ),
        );
        msg.set(line, line ? 'err' : undefined);
        foot.replaceChildren(btn({ class: 'btn primary block', id: 'fedGetBack', onclick: () => holdFor({ mode: 'refund', id: rec.id }) }, 'again', t('fund.fedimint.getBack')));
      };

      const refund = async (id, card) => {
        const rec0 = pays.get(id);
        if (!rec0) return home();
        working(t('fund.fedimint.giving'));
        let out;
        try {
          out = await pays.refund(id, { card });
        } catch (e) {
          if (e?.code === 'auth') return pairView(t('fund.fedimint.auth'));
          return failedView(pays.get(id) ?? rec0, thrownWords(e?.code, t, rec0));
        }
        const rec = out.rec;
        switch (out.kind) {
          case 'refunded':
            ui.toast(t('fund.fedimint.refunded', { amount: format.units(sats(rec.refundMsat ?? rec.receivedMsat ?? 0), 'sat') }), 4000);
            return home();
          case 'partial':
            return failedView(rec, t('fund.fedimint.partial'));
          case 'wrong_card':
            return failedView(rec, t('fund.fedimint.wrongCard'));
          case 'card_full':
            return failedView(rec, t('fund.fedimint.cardFull'));
          case 'card':
            current = null;
            return failedView(rec, t('fund.fedimint.holdAgain'));
          case 'later':
            return failedView(rec, t('fund.fedimint.later'));
          case 'stuck':
            return failedView(rec, t('fund.fedimint.stuck', { id: rec.payId }));
          case 'auth':
            return pairView(t('fund.fedimint.auth'));
          case 'settled':
            return home();
          default:
            return failedView(rec, t('fund.fedimint.giveNoAnswer'));
        }
      };

      // ------------------------------------------------------------ start

      const start = async () => {
        const s = await nfc.status();
        if (gone) return;
        if (!s.available) {
          body.replaceChildren(...kids(art(), ui.sayEl('p', { class: 'msg err', id: 'fedNoNfc' }, t('fund.card.noNfc'), 'err')));
          return;
        }
        if (!s.enabled) {
          body.replaceChildren(...kids(art(), ui.sayEl('p', { class: 'msg err', id: 'fedNfcOff' }, t('fund.card.nfcOff'), 'err')));
          foot.replaceChildren(btn({ class: 'btn primary block', id: 'fedRetry', onclick: start }, 'again', t('fund.card.tryAgain')));
          return;
        }
        // The app holds the pairing; the page's copy of the address follows it.
        const st = await till.status();
        if (gone) return;
        if (st.paired && st.url) till.settings.paired(st.url);
        else if (till.settings.get()) till.settings.forget();
        reader?.stop();
        reader = nfc.start((c) => onCard(c));
        if (!st.paired) return pairView();
        // Payments the till may have settled since: asked about once, then the screen.
        for (const p of pays.waiting()) await settle(p.id).catch(() => {});
        if (!gone) home();
      };

      start().catch(() => pairView());
      return {
        node,
        destroy() {
          gone = true;
          stopPolls();
          reader?.stop();
        },
      };
    },
  };
}
