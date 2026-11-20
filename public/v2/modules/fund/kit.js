// Shared parts for the bundled fund modules. Every function takes the inputs a fund module was handed,
// so a module that uses the kit still sees nothing beyond its kind's inputs.
import { bitnoteText } from '../../core/bitnote.js';

/**
 * The invite code field, shown while the engine needs one to open a balance. A phone with a balance
 * needs none: a second balance is opened with the first one's key, or the money goes on the first.
 */
export function inviteField({ t, ui, wallet }) {
  if (wallet.key() || !wallet.inviteOnly()) return { node: null, missing: () => false, value: () => undefined };
  const input = ui.el('input', { id: 'invite', class: 'field-input', placeholder: t('invite.placeholder'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: wallet.invite() ?? '' });
  input.addEventListener('input', () => wallet.setInvite(input.value.trim()));
  const node = ui.el('div', { class: 'field' }, ui.el('label', { for: 'invite', class: 'label' }, ui.icon('ticket', 20), ui.el('span', { text: t('invite.label') })), input, ui.sayEl('p', { class: 'note' }, t('invite.hint')));
  return {
    node,
    value: () => (wallet.key() ? undefined : wallet.invite() || undefined),
    missing(msg) {
      if (wallet.key() || wallet.invite()) return false;
      msg.set(t('invite.missing'), 'err');
      input.focus();
      return true;
    },
  };
}

/**
 * The unit Lightning money is asked in (docs/PAYMENTS.md, Two balances): sats, so it lands in the sat
 * balance, opened with the dollar balance's key when the phone has none. Dollars only where the engine
 * takes no sats by Lightning, or cannot open a second balance and the phone holds dollars.
 */
export function lightningUnit(wallet) {
  const units = wallet.methods()?.lightning?.units ?? ['usd'];
  const want = units.includes('sat') ? 'sat' : units[0];
  const to = wallet.landsIn ? wallet.landsIn(want) : (wallet.unit() ?? want);
  return units.includes(to) ? to : want;
}

/**
 * Sends a funding request for a balance in `unit`: with its key. For a second balance that key was made
 * and kept on the phone before this (app.js makeKey) and goes with the other balance's key (sibling),
 * which opens it; for a first balance, the invite goes instead. A key the engine makes is kept at once,
 * with its unit. send(key, invite, sibling) makes the request. When the engine
 * will not open the second balance (sibling_refused), the wallet is told, so the next try takes the way
 * an engine without two balances offers. Returns the engine's answer.
 */
export async function fundIn(wallet, unit, invite, send) {
  const f = wallet.fundingFor ? await wallet.fundingFor(unit) : { key: wallet.key() };
  const r = await send(f.key, f.key || f.sibling ? undefined : invite, f.sibling);
  if (r.body?.key) wallet.setKey(r.body.key, r.body.unit ?? unit);
  if (r.body?.error?.code === 'sibling_refused') wallet.siblingRefused?.();
  return r;
}

/**
 * What a failed other-mint confirm means for the token held on the phone. 'refused' only when the
 * engine said for certain it did not take this token (wrong token, expired price, unknown funding, or
 * another refusal it makes before touching the token). 'wait' when the outcome is open: a server error,
 * a busy engine, or `in_flight` (the funding is being processed with this token right now).
 */
export function confirmOutcome(status, body) {
  const code = body?.error?.code;
  if (status >= 500 || status === 429 || status === 0 || code === 'in_flight' || code === 'token_in_flight' || code === 'mint_unavailable') return 'wait';
  return status >= 400 ? 'refused' : 'wait';
}

/**
 * Applies an other-mint funding's state (GET /v1/wallet/fund/:id) to the vault entry that holds its
 * token. Pure apart from the vault it is given; used by the fund screen while it polls and by the app
 * on start and on Funds, so the outcome lands even when the person left the screen.
 *   done: the token was credited; unused fees come back as eCash, kept until saved.
 *   refunded: the payment failed; the eCash that came back is kept until saved. A locked refund the
 *     mint has not issued yet keeps the entry pending until it arrives.
 *   failed, expired: the engine did not take the token; it is kept, marked, so it can be copied.
 * The amount of returned eCash is not known on the phone (no token decoder here), so it is stored as null.
 * Returns {final, state}: final when nothing more is coming for this funding.
 */
export function settleForeign(vault, entry, x) {
  const f = x?.foreign ?? {};
  const unit = f.unit ?? x?.unit ?? null;
  const keep = (token, kind) => vault.keepRefund({ id: `${x.id}_${kind}`, token, amount: null, unit });
  switch (x?.state) {
    case 'done':
      if (f.change_token) keep(f.change_token, 'change');
      if (entry) {
        // Credited. A locked change the mint has not issued yet is still to come.
        if (f.payout_pending && !f.change_token) vault.pending(entry.id, 'change_pending');
        else vault.credited(entry.id);
      }
      return { final: !f.payout_pending, state: 'done' };
    case 'refunded':
      if (f.refund_token) {
        keep(f.refund_token, 'refund');
        if (entry) vault.credited(entry.id);
        return { final: true, state: 'refunded' };
      }
      if (f.payout_pending) {
        if (entry) vault.pending(entry.id, 'refund_pending');
        return { final: false, state: 'refunded' };
      }
      if (entry) vault.refused(entry.id, 'refunded', x.error ?? 'refunded');
      return { final: true, state: 'refunded' };
    case 'failed':
    case 'expired':
      if (entry) vault.refused(entry.id, x.state, x.error ?? x.state);
      return { final: true, state: x.state };
    default:
      return { final: false, state: x?.state ?? 'unknown' };
  }
}

/**
 * Looks up every other-mint token still pending on the phone and settles it (see settleForeign).
 * Returns how many entries changed. An unknown funding (404) means the engine never took the token.
 * Only entries sent to this engine are looked up: another engine does not know the funding, and its
 * 404 must never mark a token the first engine may still be working on (core/vault.js). For the same
 * reason, with two balances, only the entries of the balance `key` opens (mine): a funding is one
 * balance's, and the other key's 404 says nothing about it.
 */
export async function settlePendingForeign({ engine, vault, key, mine = () => true }) {
  if (!key) return 0;
  let n = 0;
  for (const e of vault.incoming().filter((x) => x.via === 'othermint' && x.state === 'pending' && x.fundingId && (x.engine ?? '') === (engine?.base ?? '') && mine(x))) {
    let r;
    try {
      r = await engine.funding(key, e.fundingId);
    } catch {
      break; // offline: try again next time
    }
    if (r.ok) {
      const before = JSON.stringify(vault.incoming()) + JSON.stringify(vault.outgoing());
      settleForeign(vault, e, r.body);
      if (JSON.stringify(vault.incoming()) + JSON.stringify(vault.outgoing()) !== before) n++;
    } else if (r.status === 404) {
      vault.refused(e.id, 'not_found', r.body?.error?.message ?? 'not_found');
      n++;
    }
  }
  return n;
}

const UNIT_WORD = { usd: 'unit.usd', sat: 'unit.sat' };

/**
 * The price the engine quoted for eCash it changes (POST /v1/wallet/fund/foreign/quote), with Yes, then
 * the steps until the outcome. The eCash box uses it for eCash from another mint, and for eCash from the
 * engine's own mint in the unit these funds do not hold (foreign.convert), which says what is changed
 * into what. Both say where the amount comes from and have a No (onNo). The token goes into the vault on
 * Yes only, with the funding id, so the outcome lands even when the person leaves
 * (settlePendingForeign); No takes nothing, the token stays the person's.
 * Fills body and foot; once the money is in, the success panel takes the screen (added, screens/funds.js).
 * Returns {stop} for the poller.
 */
export function foreignQuote(inputs, { body, foot, f, token, done, added, onNo }) {
  const { t, ui, engine, wallet, vault, format } = inputs;
  const q = f.foreign;
  let poller = null;
  const st = ui.el('p', { class: 'status-line', id: 'foreignStatus', role: 'status' });
  const confirm = ui.el('button', { type: 'button', class: 'btn primary block', id: 'foreignConfirm' }, ui.icon('check', 20), ui.el('span', { text: t('fund.othermint.confirm', { amount: format.units(q.credit, f.unit) }) }));
  const no = onNo ? ui.el('button', { type: 'button', class: 'btn block', id: 'foreignNo', onclick: onNo }, ui.icon('x', 20), ui.el('span', { text: t('fund.convert.no') })) : null;
  const returned = ui.el('div', { class: 'returned' });
  const words = (u) => t(UNIT_WORD[u] ?? 'unit.other');
  // The price as one card: what is changed into what, the amount added in large type, and under it where
  // it comes from and the most the fees take.
  const price = ui.el(
    'section',
    { class: 'card price-card' },
    ...[
      q.convert ? ui.sayEl('p', { id: 'convertWhat' }, t('fund.convert.what', { to: words(f.unit), from: words(q.unit) }), '', 'swap') : ui.sayEl('p', { id: 'foreignWhat' }, t('fund.ecash.otherWhat'), '', 'swap'),
      ui.el('div', { class: 'amount-tag', id: 'foreignCredit', text: format.units(q.credit, f.unit) }),
      ui.sayEl('p', { class: 'note', id: q.convert ? 'convertFrom' : 'foreignFrom' }, t('fund.convert.from', { amount: format.units(q.token_amount, q.unit) }), '', 'coins'),
      ui.sayEl('p', { class: 'note' }, t('fund.othermint.fees', { amount: format.units(q.fee_max, q.unit) }), '', 'gauge'),
    ].filter(Boolean),
  );
  body.replaceChildren(price, st, returned);
  foot.replaceChildren(...[confirm, no].filter(Boolean));
  let held = null;
  let refreshed = false;
  /** What went wrong, said as an error. */
  const fail = (text) => {
    st.className = 'status-line err';
    ui.say(st, text, 'err');
  };
  const finish = () => foot.replaceChildren(ui.el('button', { type: 'button', class: 'btn primary block', id: 'fundDone', text: t('fund.done'), onclick: done }));
  const update = (x) => {
    const xf = x.foreign ?? q;
    const steps = { receiving: 'fund.othermint.receiving', melting: 'fund.othermint.melting', pending: 'fund.othermint.pending', minting: 'fund.othermint.minting' };
    // The vault first: the outcome is stored before anything is shown.
    const r = settleForeign(vault, held, x);
    if (x.state === 'done') {
      if (!refreshed) wallet.refresh();
      refreshed = true;
      const extra = xf.change_token ? [ui.sayEl('p', { class: 'note added-note' }, t('fund.othermint.change'), '', 'coins')] : [];
      added({ amount: format.units(x.credited, x.unit), words: t('fund.othermint.done', { amount: format.units(x.credited, x.unit) }), wordsAttrs: { id: 'foreignStatus' }, extra });
      return r.final;
    }
    if (x.state === 'refunded') {
      fail(xf.refund_token || xf.payout_pending ? t('fund.othermint.refunded') : t('fund.failed', { message: x.error ?? '' }));
      if (xf.refund_token) returned.replaceChildren(ui.el('textarea', { class: 'field-input mono', readonly: true, rows: '3', text: xf.refund_token }));
      finish();
      return r.final;
    }
    if (x.state === 'failed' || x.state === 'expired') {
      fail(x.state === 'expired' ? t('fund.othermint.expired') : t('fund.failed', { message: x.error ?? '' }));
      finish();
      return true;
    }
    if (steps[x.state]) ui.say(st, t(steps[x.state]), 'wait');
    return false;
  };
  // The funding is the balance's in its unit (f.unit): that key asks about it.
  const keyNow = () => wallet.keyFor?.(f.unit) ?? wallet.key();
  const watch = (ms) =>
    (poller = poll(async () => {
      const s = await engine.funding(keyNow(), f.id);
      return s.ok ? update(s.body) : false;
    }, ms));
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    no?.remove();
    st.className = 'status-line';
    ui.say(st, t('fund.othermint.receiving'), 'wait');
    // Tied to this engine and this balance: only they are asked about the funding later (settlePendingForeign).
    held = vault.hold(token, 'othermint', { fundingId: f.id, engine: engine.base ?? '', unit: f.unit });
    try {
      const r = await engine.foreignConfirm(keyNow(), { id: f.id, token, pubkey: wallet.lockKey() || undefined });
      if (!r.ok) {
        const message = r.body?.error?.message ?? `HTTP ${r.status}`;
        if (confirmOutcome(r.status, r.body) === 'refused') {
          // Not taken: the eCash stays on the phone, listed under Funds as not added, so it can be copied.
          vault.refused(held.id, r.body?.error?.code ?? `http_${r.status}`, message);
          fail(t('fund.failed', { message }));
          confirm.disabled = false;
          return;
        }
        // The outcome is open (busy, a server error, or being processed now): keep the token pending
        // and watch the funding.
        vault.pending(held.id, r.body?.error?.code ?? `http_${r.status}`);
        ui.say(st, t('fund.othermint.receiving'), 'wait');
        return watch(2000);
      }
      if (!update(r.body)) watch(2000);
    } catch {
      watch(3000);
    }
  });
  return { stop: () => poller?.stop() };
}

/** Calls fn every `ms` until it returns true or stop() is called. Skips a tick while the page is hidden. */
export function poll(fn, ms) {
  let stopped = false;
  let timer;
  const tick = async () => {
    if (stopped) return;
    let done = false;
    if (!document.hidden) {
      try {
        done = await fn();
      } catch {
        /* offline: keep trying */
      }
    }
    if (!stopped && !done) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** What the token box shows in place of a code it holds: a fixed row, so not even its length shows. */
const DOT = '•';
const DOTS = DOT.repeat(24);

/**
 * A paste box with an optional Scan button (the camera adapter). Its label leads with the paste picture;
 * info: detail behind an info button beside it (which mints are taken), a line or a list of lines, or
 * null. accept(text): a code the scanner takes besides Cashu tokens (Fedimint notes, core/fedinote.js).
 * value(): the box's text with its whitespace taken out, except a BitNotes code (core/bitnote.js), whose
 * spaces are part of it.
 *
 * eCash is spent by whoever reads it, so a code the person did not type or paste (scanned, or handed over
 * by another way with hold(text)) is never written into the page: the box keeps it in memory and shows
 * a row of dots, marked data-held. value() gives the held code; any edit or clear() lets it go, and the
 * box is plain text again. A failed Add leaves it held, so Add tries the same code again.
 */
export function tokenBox({ t, ui, scan }, { id, label, onScanned, info = null, accept = null }) {
  const ta = ui.el('textarea', { id, rows: '4', class: 'field-input mono', placeholder: 'cashuB...', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
  let held = null;
  /** Keeps the code off the page: dots in the box instead. Setting the value fires no input event. */
  const hold = (text) => {
    held = text;
    ta.value = DOTS;
    ta.toggleAttribute('data-held', true);
  };
  const drop = () => {
    held = null;
    ta.removeAttribute('data-held');
  };
  // The person edits the box: the held code goes, and so do its dots, leaving what they typed.
  ta.addEventListener('input', () => {
    if (held === null) return;
    drop();
    ta.value = ta.value.replaceAll(DOT, '');
  });
  const video = ui.el('video', { muted: true, playsinline: true, 'aria-label': t('fund.scanHint') });
  const box = ui.el('div', { class: 'scanner', hidden: true }, video, ui.sayEl('p', { class: 'note' }, t('fund.scanHint')));
  let job = null;
  const stop = () => {
    job?.stop();
    job = null;
    box.hidden = true;
  };
  const btn = scan?.available()
    ? ui.el(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            box.hidden = false;
            try {
              job = await scan.open(video, undefined, accept ? { accept } : undefined);
              const text = await job.promise;
              stop();
              hold(text);
              onScanned?.(text);
            } catch {
              stop();
            }
          },
        },
        ui.icon('qr', 20),
        ui.el('span', { text: t('fund.scan') }),
      )
    : null;
  const lines = (x) => [x].flat().filter(Boolean);
  const more = info ? ui.el('p', { class: 'field-info' }) : null;
  const toggle = more ? ui.infoToggle(more, t('common.info')) : null;
  /** The info lines again (what the engine takes can arrive after the screen is drawn). */
  const setInfo = (x) => {
    if (!more) return;
    const l = lines(x);
    more.replaceChildren(...l.flatMap((v, i) => (i ? [ui.el('br'), v] : [v])));
    toggle.hidden = !l.length;
    if (!l.length) more.hidden = true;
  };
  setInfo(info);
  const head = ui.el('div', { class: 'field-head' }, ui.el('label', { for: id, class: 'label' }, ui.icon('paste', 20), ui.el('span', { text: label })), toggle);
  const node = ui.el('div', { class: 'field' }, head, more, ta, btn, box);
  const value = () => {
    const text = held ?? ta.value;
    return bitnoteText(text) ?? text.replace(/\s+/g, '').replace(/^cashu:(?=cashu)/i, '');
  };
  const clear = () => {
    drop();
    ta.value = '';
  };
  return { node, value, clear, hold, stop, input: ta, setInfo };
}

/**
 * What a payment request's QR code carries: the URI as given, and a Lightning one in lowercase, the same
 * string as its Open link. Some wallets read only a lowercase `lightning:` (Primal on the iPhone strips
 * only that prefix, so `LIGHTNING:LNBC...` fails its checksum), though BOLT 11 suggests upper case for
 * its smaller code. Lowercase goes in byte mode (public/js/qr.js), so the code is denser.
 */
export const qrPayload = (uri) => (/^lightning:/i.test(uri) ? uri.toLowerCase() : uri);

/** The QR code of a payment request, with Copy and an Open in wallet link. */
export function requestQR({ t, ui, qr }, { uri, copyText, copyLabel, qrLabel, openLabel }) {
  const box = ui.el('div', { class: 'qr', role: 'img', 'aria-label': qrLabel });
  uri = qrPayload(uri);
  qr.renderQR(box, uri, 'M').catch(() => {});
  return ui.el(
    'div',
    { class: 'qr-block' },
    box,
    ui.el(
      'div',
      { class: 'row-btns' },
      ui.el('button', { type: 'button', class: 'btn', onclick: async () => ui.toast((await ui.copy(copyText)) ? t('answer.copied') : t('answer.copyFailed')) }, ui.icon('copy', 18), ui.el('span', { text: copyLabel })),
      openLabel ? ui.el('a', { class: 'btn', href: uri }, ui.icon('external', 18), ui.el('span', { text: openLabel })) : null,
    ),
  );
}
