// Shared parts for the bundled fund modules. Every function takes the inputs a fund module was handed,
// so a module that uses the kit still sees nothing beyond its kind's inputs.

/** The invite code field, shown while the engine needs one to open a balance. */
export function inviteField({ t, ui, wallet }) {
  if (wallet.key() || !wallet.inviteOnly()) return { node: null, missing: () => false, value: () => undefined };
  const input = ui.el('input', { id: 'invite', class: 'field-input', placeholder: t('invite.placeholder'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: wallet.invite() ?? '' });
  input.addEventListener('input', () => wallet.setInvite(input.value.trim()));
  const node = ui.el('div', { class: 'field' }, ui.el('label', { for: 'invite', class: 'label', text: t('invite.label') }), input, ui.sayEl('p', { class: 'note' }, t('invite.hint')));
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
 * 404 must never mark a token the first engine may still be working on (core/vault.js).
 */
export async function settlePendingForeign({ engine, vault, key }) {
  if (!key) return 0;
  let n = 0;
  for (const e of vault.incoming().filter((x) => x.via === 'othermint' && x.state === 'pending' && x.fundingId && (x.engine ?? '') === (engine?.base ?? ''))) {
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
 * the steps until the outcome. Other mint uses it, and so does eCash from the engine's own mint in the
 * unit these funds do not hold (foreign.convert), which also says what is changed into what and has a
 * No (onNo). The token goes into the vault on Yes only, with the funding id, so the outcome lands even
 * when the person leaves (settlePendingForeign); No takes nothing, the token stays the person's.
 * Fills body and foot. Returns {stop} for the poller.
 */
export function foreignQuote(inputs, { body, foot, f, token, done, onNo }) {
  const { t, ui, engine, wallet, vault, format } = inputs;
  const q = f.foreign;
  let poller = null;
  const st = ui.el('p', { class: 'status-line', id: 'foreignStatus', role: 'status' });
  const confirm = ui.el('button', { type: 'button', class: 'btn primary block', id: 'foreignConfirm' }, ui.icon('check', 20), ui.el('span', { text: t('fund.othermint.confirm', { amount: format.units(q.credit, f.unit) }) }));
  const no = onNo ? ui.el('button', { type: 'button', class: 'btn block', id: 'foreignNo', onclick: onNo }, ui.icon('x', 20), ui.el('span', { text: t('fund.convert.no') })) : null;
  const returned = ui.el('div', { class: 'returned' });
  const words = (u) => t(UNIT_WORD[u] ?? 'unit.other');
  body.replaceChildren(
    ...[
      q.convert ? ui.sayEl('p', { id: 'convertWhat' }, t('fund.convert.what', { to: words(f.unit), from: words(q.unit) }), '', 'swap') : null,
      ui.el('div', { class: 'amount-tag', id: 'foreignCredit', text: format.units(q.credit, f.unit) }),
      q.convert ? ui.sayEl('p', { class: 'note', id: 'convertFrom' }, t('fund.convert.from', { amount: format.units(q.token_amount, q.unit) }), '', 'coins') : null,
      ui.sayEl('p', { class: 'note' }, t('fund.othermint.fees', { amount: format.units(q.fee_max, q.unit) })),
      st,
      returned,
    ].filter(Boolean),
  );
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
      ui.say(st, t('fund.othermint.done', { amount: format.units(x.credited, x.unit) }));
      if (xf.change_token) returned.replaceChildren(ui.sayEl('p', { class: 'note' }, t('fund.othermint.change')));
      if (!refreshed) wallet.refresh();
      refreshed = true;
      finish();
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
    if (steps[x.state]) ui.say(st, t(steps[x.state]));
    return false;
  };
  const watch = (ms) =>
    (poller = poll(async () => {
      const s = await engine.funding(wallet.key(), f.id);
      return s.ok ? update(s.body) : false;
    }, ms));
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    no?.remove();
    st.className = 'status-line';
    ui.say(st, t('fund.othermint.receiving'));
    // Tied to this engine: only it is asked about the funding later (settlePendingForeign).
    held = vault.hold(token, 'othermint', { fundingId: f.id, engine: engine.base ?? '' });
    try {
      const r = await engine.foreignConfirm(wallet.key(), { id: f.id, token, pubkey: wallet.lockKey() || undefined });
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
        ui.say(st, t('fund.othermint.receiving'));
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

/** A paste box with an optional Scan button (the camera adapter). */
export function tokenBox({ t, ui, scan }, { id, label, onScanned }) {
  const ta = ui.el('textarea', { id, rows: '4', class: 'field-input mono', placeholder: 'cashuB...', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
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
              job = await scan.open(video);
              const text = await job.promise;
              stop();
              ta.value = text;
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
  const node = ui.el('div', { class: 'field' }, ui.el('label', { for: id, class: 'label', text: label }), ta, btn, box);
  return { node, value: () => ta.value.replace(/\s+/g, '').replace(/^cashu:(?=cashu)/i, ''), clear: () => (ta.value = ''), stop, input: ta };
}

/** The QR code of a payment request, with Copy and an Open in wallet link. */
export function requestQR({ t, ui, qr }, { uri, copyText, copyLabel, qrLabel, openLabel }) {
  const box = ui.el('div', { class: 'qr', role: 'img', 'aria-label': qrLabel });
  qr.renderQR(box, uri.toUpperCase().startsWith('LIGHTNING:') ? uri.toUpperCase() : uri, 'M').catch(() => {});
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
