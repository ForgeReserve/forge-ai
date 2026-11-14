// Fund module: Tap a card. A Cashu eCash card (the card protocol 2.0 that flash-pos speaks) gives its
// eCash to this phone: the card proves its key, the person enters its PIN and picks how much (all of it
// by default), the card signs one swap at its own mint, and the eCash that comes back is added to the
// funds. The work is core/card/flow.js; this file is the screen.
//
// Only the Android app can read these cards (the nfc input is its reader). On the website the row says
// so and points to the app. The card can stay on the phone for the whole thing: read, PIN and amount,
// signature, swap and the card's change. If it leaves early, the screen asks for it again and goes on
// from where it was; what the card already signed is kept on the phone and finished then (flow.js).
//
// Where the eCash goes: a card from the engine's own mint tops up the funds through the vault (stored
// first, removed once credited). A card from another mint the engine takes through other-mint funding:
// the eCash is kept in the vault, marked not added, and the Other mint screen opens with it.
import { inviteField } from '../kit.js';

const UNIT_WORD = { usd: 'unit.usd', sat: 'unit.sat' };

/** The children to put in a node, without the empty ones (replaceChildren would write "null"). */
const kids = (...list) => list.filter((x) => x != null && x !== '' && x !== false);

/**
 * Where a card's eCash can go, decided before the card signs. info is the relay's answer about the
 * card's mint ({trusted}). 'topup', 'othermint', 'wrong_unit' or 'wrong_mint'.
 */
export function routeFor(info, { unit, units = [], balanceUnit = null, otherMint = false }) {
  if (!unit) return 'wrong_unit';
  if (info?.trusted) return (units.length && !units.includes(unit)) || (balanceUnit && balanceUnit !== unit) ? 'wrong_unit' : 'topup';
  return otherMint ? 'othermint' : 'wrong_mint';
}

/** The words for a card flow failure (core/card/flow.js CardFlowError codes). */
export function wordsFor(e, t) {
  switch (e?.code) {
    case 'pin_wrong':
      return t('fund.card.wrongPin', { tries: e.triesLeft === 1 ? t('fund.card.tryLeft') : t('fund.card.triesLeft', { count: e.triesLeft }) });
    case 'pin_blocked':
      return t('fund.card.pinBlocked');
    case 'pin_needed':
      return t('fund.card.pinNeeded');
    case 'over_limit':
      return t('fund.card.overLimit');
    case 'other_card':
      return t('fund.card.otherCard');
    case 'not_ecash':
      return t('fund.card.notEcash');
    case 'needs_update':
      return t('fund.card.needsUpdate');
    case 'not_genuine':
      return t('fund.card.notGenuine');
    case 'locked':
      return t('fund.card.locked');
    case 'empty':
      return t('fund.card.empty');
    case 'too_small':
      return t('fund.card.tooSmall');
    case 'all_only':
      return t('fund.card.allOnly');
    case 'unfinished':
      return t('fund.card.unfinished');
    case 'mint_unavailable':
      return e.kept ? t('fund.card.kept') : t('fund.failed', { message: e.message });
    case 'mint_refused':
      return e.kept ? t('fund.card.refused') : t('fund.failed', { message: e.message });
    case 'not_taken':
      return t('fund.card.wrongMint');
    case 'not_stored':
      return t('fund.card.notStored');
    case 'tap_lost':
      return t('fund.card.holdAgain');
    default:
      return t('fund.card.failed');
  }
}

export function create(inputs) {
  const { t, ui, wallet, vault, format, nfc, card, engine } = inputs;
  return {
    id: 'card',
    group: 'unlinked',
    icon: 'card',
    available: () => true,
    view({ done, open }) {
      const msg = ui.msgLine();
      const body = ui.el('div', { class: 'scroll fund-body' });
      const foot = ui.el('div', { class: 'foot' });
      const node = ui.el('div', { class: 'fund-view card-view' }, body, foot);
      const btn = (attrs, ico, label) => ui.el('button', { type: 'button', ...attrs }, ico ? ui.icon(ico, 20) : null, ui.el('span', { text: label }));
      let gone = false;
      let reader = null;
      let cards = null; // {flow, handToken}, loaded on first use
      let current = null; // the card in the field now
      let busy = false;
      // What a card coming into the field is for: 'read', 'pay' or 'finish'.
      let next = 'read';
      // What the read found, and what the person chose.
      let summary = null;
      let info = null;
      let acceptUnlisted = false;
      let route = null;
      let choice = null; // {plan, pin}
      let changeWaiting = false; // the last payment's change goes back on the card at its next read

      const art = (amountText) =>
        ui.el(
          'div',
          { class: 'card-art', role: 'img', 'aria-label': t('fund.card.picture') },
          ui.el('span', { class: 'card-art-word', text: t('fund.card.artWord') }),
          ui.el('span', { class: 'card-art-waves' }, ui.icon('nfc', 28)),
          amountText ? ui.el('span', { class: 'card-art-amount', text: amountText }) : null,
        );

      // ------------------------------------------------------------ the website: no reader

      if (!nfc?.supported?.()) {
        body.replaceChildren(...kids(art(), ui.el('p', { id: 'cardAppOnly', text: t('fund.card.appOnly') }), ui.el('p', { class: 'note', text: t('fund.card.what') })));
        foot.replaceChildren(...kids(ui.el('a', { class: 'btn primary block', id: 'cardGetApp', href: '/download' }, ui.icon('download', 20), ui.el('span', { text: t('fund.card.getApp') }))));
        return { node, destroy() {} };
      }

      // ------------------------------------------------------------ the app

      const hold = (line = t('fund.card.keep')) => {
        body.replaceChildren(...kids(art(), ui.el('p', { class: 'card-hold', id: 'cardHold', text: t('fund.card.hold') }), ui.el('p', { class: 'note', id: 'cardHoldLine', text: line }), msg));
        foot.replaceChildren();
      };

      const working = (text) => {
        msg.set('');
        body.replaceChildren(...kids(art(summary ? format.units(summary.balance, summary.unit) : null), ui.el('p', { class: 'status-line', id: 'cardStatus', role: 'status', text })));
        foot.replaceChildren();
      };

      /** A card came into the field: whatever this screen was waiting for goes on with it. */
      const onCard = async (c) => {
        if (gone || busy) return;
        if (!c) return msg.set(t('fund.card.notEcash'), 'err');
        current = c;
        busy = true;
        try {
          if (next === 'pay') await pay();
          else if (next === 'finish') await finish();
          else await read();
        } finally {
          busy = false;
        }
      };

      const startReading = async () => {
        msg.set('');
        const s = await nfc.status();
        if (!s.available) {
          body.replaceChildren(...kids(art(), ui.el('p', { class: 'msg err', id: 'cardNoNfc', text: t('fund.card.noNfc') })));
          return;
        }
        if (!s.enabled) {
          body.replaceChildren(...kids(art(), ui.el('p', { class: 'msg err', id: 'cardNfcOff', text: t('fund.card.nfcOff') })));
          foot.replaceChildren(...kids(btn({ class: 'btn primary block', id: 'cardRetry', onclick: startReading }, 'again', t('fund.card.tryAgain'))));
          return;
        }
        cards ??= await card.load();
        if (gone) return;
        hold();
        reader?.stop();
        reader = nfc.start((c) => onCard(c));
      };

      /** A card this engine cannot take from: said once, nothing asked of the card. */
      const refuse = (text) => {
        body.replaceChildren(...kids(art(), ui.el('p', { class: 'msg err', id: 'cardResult', role: 'status', text })));
        foot.replaceChildren(...kids(btn({ class: 'btn block', id: 'cardAgain', onclick: () => ((next = 'read'), (summary = null), hold()) }, 'again', t('fund.card.tryAgain'))));
      };

      /** The words for a failure; the card waits for the next tap where one can help. */
      const failed = (e) => {
        const words = wordsFor(e, t);
        if (e?.code === 'tap_lost' || e?.code === 'unfinished' || e?.code === 'other_card') {
          if (e.code === 'unfinished') next = 'read';
          hold(words);
          return;
        }
        if (summary && ['pin_wrong', 'pin_needed', 'too_small', 'all_only'].includes(e?.code)) {
          showForm();
          msg.set(words, 'err');
          return;
        }
        body.replaceChildren(...kids(art(), ui.el('p', { class: 'msg err', id: 'cardResult', role: 'status', text: words })));
        foot.replaceChildren(...kids(btn({ class: 'btn block', id: 'cardAgain', onclick: () => ((next = 'read'), (summary = null), hold()) }, 'again', t('fund.card.tryAgain'))));
      };

      /** Tokens the read finished (a tap that broke earlier) go where they belong. */
      const handFinished = async () => {
        await cards.flow.resume((job) => cards.handToken(job, { wallet, vault, engineBase: engine.base ?? '', message: t('fund.card.toOtherMint') }));
        await wallet.refresh();
      };

      const read = async () => {
        working(t('fund.card.reading'));
        try {
          summary = await cards.flow.read(current.transceive);
          await handFinished().catch(() => {});
          if (summary.unfinished) {
            next = 'finish';
            // The PIN was given for the payment this tap finishes: use it, the card is here.
            if (choice?.pin || summary.pinState !== 'set') return finish();
            return showFinish();
          }
          if (!summary.balance) throw Object.assign(new Error('empty'), { code: 'empty' });
          info = await cards.flow.mintInfo(summary, { acceptUnlisted });
        } catch (e) {
          if (e?.code === 'mint_unlisted') return showUnlisted(e);
          summary = e?.code === 'empty' ? summary : null;
          return failed(e);
        }
        route = routeFor(info, { unit: summary.unit, units: wallet.units(), balanceUnit: wallet.key() ? wallet.unit() : null, otherMint: !!wallet.methods()?.foreign?.enabled });
        if (route === 'wrong_unit') return refuse(t('fund.card.wrongUnit', { unit: t(UNIT_WORD[summary.unit] ?? 'unit.other') }));
        if (route === 'wrong_mint') return refuse(t('fund.card.wrongMint'));
        showForm();
        if (changeWaiting) msg.set(t('fund.card.changeBack'), 'ok');
        changeWaiting = false;
      };

      const showUnlisted = (e) => {
        body.replaceChildren(...kids(art(), ui.el('div', { class: 'notice', id: 'cardUnlisted' }, ui.el('p', { text: t('fund.othermint.unlisted') }), ui.el('p', { class: 'mono note', text: e.mint ?? '' }))));
        foot.replaceChildren(...kids(
          btn({ class: 'btn primary block', id: 'cardGoOn', onclick: () => ((acceptUnlisted = true), (next = 'read'), hold(t('fund.card.holdAgain'))) }, null, t('fund.othermint.goOn')),
        ));
      };

      const pinField = (id) => {
        if (summary.pinState !== 'set') return { node: null, value: () => '' };
        const input = ui.el('input', { id, class: 'field-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', pattern: '[0-9]*' });
        const tries = summary.triesLeft < 3 ? ui.el('p', { class: 'note', id: 'cardTries', text: summary.triesLeft === 1 ? t('fund.card.tryLeft') : t('fund.card.triesLeft', { count: summary.triesLeft }) }) : null;
        return { node: ui.el('div', { class: 'field' }, ui.el('label', { for: id, class: 'label', text: t('fund.card.pinLabel') }), input, tries), value: () => input.value.trim(), input };
      };

      /** A card left something unfinished with this phone: its PIN, then a tap, finishes it. */
      const showFinish = () => {
        const pin = pinField('cardFinishPin');
        body.replaceChildren(...kids(art(format.units(summary.balance, summary.unit)), ui.el('p', { id: 'cardToFinish', text: t('fund.card.toFinish') }), pin.node, msg));
        foot.replaceChildren(...kids(
          btn(
            {
              class: 'btn primary block',
              id: 'cardFinish',
              onclick: () => {
                if (summary.pinState === 'set' && !/^[0-9]{4,8}$/.test(pin.value())) return msg.set(t('fund.card.pinBad'), 'err');
                choice = { pin: pin.value() };
                next = 'finish';
                go();
              },
            },
            'check',
            t('fund.card.finish'),
          ),
        ));
      };

      const finish = async () => {
        working(t('fund.card.moving'));
        try {
          summary = await cards.flow.finish(current.transceive, { summary, pin: choice?.pin ?? '' });
          await handFinished();
          next = 'read';
          if (!summary.balance) {
            toastAndDone(null);
            return;
          }
          info = await cards.flow.mintInfo(summary, { acceptUnlisted });
          showForm();
        } catch (e) {
          failed(e);
        }
      };

      /** How much and the PIN, and what the person gets, before the card signs anything. */
      const showForm = () => {
        const unit = summary.unit;
        const all = ui.el('button', { type: 'button', role: 'radio', 'aria-checked': 'true', id: 'cardAll', text: t('fund.card.all') });
        const some = ui.el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', id: 'cardSome', text: t('fund.card.some') });
        const amountInput = ui.el('input', { id: 'cardAmount', class: 'field-input', inputmode: 'numeric', autocomplete: 'off', hidden: true, 'aria-label': t('fund.card.amountLabel') });
        const pin = pinField('cardPin');
        const preview = ui.el('div', { class: 'card-preview', id: 'cardPreview' });
        const moveBtn = btn({ class: 'btn primary block', id: 'cardMove' }, 'plus', '');
        let plan = null;
        const amount = () => (all.getAttribute('aria-checked') === 'true' ? summary.max : Number(amountInput.value.trim()));
        const update = () => {
          plan = null;
          const a = amount();
          if (!Number.isSafeInteger(a) || a < 1 || a > summary.max) {
            preview.replaceChildren(...kids(ui.el('p', { class: 'note', text: t('fund.card.badAmount', { amount: format.units(summary.max, unit) }) })));
            moveBtn.disabled = true;
            moveBtn.lastChild.textContent = t('fund.card.move', { amount: '' }).trim();
            return;
          }
          try {
            plan = cards.flow.plan(summary, info, a);
          } catch (e) {
            preview.replaceChildren(...kids(ui.el('p', { class: 'msg err', text: wordsFor(e, t) })));
            moveBtn.disabled = true;
            return;
          }
          const back = plan.selected - plan.amount;
          preview.replaceChildren(...kids(
            ui.el('p', { class: 'card-get', id: 'cardGet', text: t('fund.card.youGet', { amount: format.units(plan.receive, unit) }) }),
            plan.fee ? ui.el('p', { class: 'note', id: 'cardFee', text: t('fund.card.fee', { amount: format.units(plan.fee, unit) }) }) : null,
            back ? ui.el('p', { class: 'note', id: 'cardBack', text: t('fund.card.backToCard', { amount: format.units(back, unit) }) }) : null,
          ));
          moveBtn.disabled = false;
          moveBtn.lastChild.textContent = t('fund.card.move', { amount: format.units(plan.amount, unit) });
        };
        const pick = (which) => {
          all.setAttribute('aria-checked', String(which === all));
          some.setAttribute('aria-checked', String(which === some));
          amountInput.hidden = which === all;
          if (which === some) amountInput.focus();
          update();
        };
        all.addEventListener('click', () => pick(all));
        some.addEventListener('click', () => pick(some));
        amountInput.addEventListener('input', update);
        const invite = route === 'topup' ? inviteField(inputs) : { node: null, missing: () => false };
        body.replaceChildren(...kids(
          art(format.units(summary.balance, unit)),
          ui.el('p', { class: 'note note-mint', id: 'cardMint', text: t('fund.card.from', { mint: mintLabel(summary.mint) }) }),
          summary.max < summary.balance ? ui.el('p', { class: 'note', id: 'cardPart', text: t('fund.card.partOnly', { amount: format.units(summary.max, unit) }) }) : null,
          invite.node,
          ui.el('div', { class: 'field' }, ui.el('p', { class: 'label', id: 'cardHowMuch', text: t('fund.card.howMuch') }), ui.el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'cardHowMuch' }, all, some), amountInput),
          pin.node,
          preview,
          msg,
        ));
        foot.replaceChildren(...kids(moveBtn));
        moveBtn.addEventListener('click', () => {
          if (!plan || invite.missing(msg)) return;
          if (summary.pinState === 'set' && !/^[0-9]{4,8}$/.test(pin.value())) {
            msg.set(t('fund.card.pinBad'), 'err');
            return pin.input?.focus();
          }
          choice = { plan, pin: pin.value() };
          next = 'pay';
          go();
        });
        update();
      };

      /** Goes on with the card in the field now, or waits for it. */
      const go = async () => {
        if (busy) return;
        if (!current) return hold(t('fund.card.holdAgain'));
        busy = true;
        try {
          if (next === 'pay') await pay();
          else if (next === 'finish') await finish();
        } finally {
          busy = false;
        }
      };

      const pay = async () => {
        working(t('fund.card.moving'));
        let job;
        try {
          job = await cards.flow.pay(current.transceive, { summary, info, plan: choice.plan, pin: choice.pin, acceptUnlisted, route });
        } catch (e) {
          // The card left before anything was asked of it: wait for it, the choice stands.
          if (e?.code === 'tap_lost') {
            current = null;
            return hold(t('fund.card.holdAgain'));
          }
          if (e?.code === 'unfinished') current = null;
          return failed(e);
        }
        next = 'read';
        working(t('fund.card.adding'));
        let r;
        try {
          r = await cards.handToken(job, { wallet, vault, engineBase: engine.base ?? '', message: t('fund.card.toOtherMint') });
          cards.flow.handed(job.id);
        } catch (e) {
          return failed({ code: 'mint_unavailable', kept: true, message: e?.message });
        }
        if (r.route === 'othermint') return open('othermint', { token: job.token });
        await wallet.refresh();
        if (r.error) return failed({ code: 'mint_unavailable', kept: true });
        const words = r.replay ? t('fund.ecash.replay') : t('fund.card.added', { amount: format.units(r.credited, r.unit) });
        if (job.changeOwed) {
          // The eCash is here; the card's change waits for one more tap (it is read again then).
          summary = null;
          changeWaiting = true;
          current = null;
          ui.toast(words);
          hold(t('fund.card.changeOwed'));
          return;
        }
        toastAndDone(words, choice.plan.amount === summary.balance);
      };

      const toastAndDone = (words, empty = false) => {
        if (words) ui.toast(empty ? `${words} ${t('fund.card.emptyNow')}` : words);
        done();
      };

      startReading().catch((e) => failed(e));
      return {
        node,
        destroy() {
          gone = true;
          reader?.stop();
        },
      };
    },
  };
}

function mintLabel(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
