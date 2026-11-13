// Shared parts for the bundled fund modules. Every function takes the inputs a fund module was handed,
// so a module that uses the kit still sees nothing beyond its kind's inputs.

/** The invite code field, shown while the engine needs one to open a balance. */
export function inviteField({ t, ui, wallet }) {
  if (wallet.key() || !wallet.inviteOnly()) return { node: null, missing: () => false, value: () => undefined };
  const input = ui.el('input', { id: 'invite', class: 'field-input', placeholder: t('invite.placeholder'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: wallet.invite() ?? '' });
  input.addEventListener('input', () => wallet.setInvite(input.value.trim()));
  const node = ui.el('div', { class: 'field' }, ui.el('label', { for: 'invite', class: 'label', text: t('invite.label') }), input, ui.el('p', { class: 'note', text: t('invite.hint') }));
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
  const box = ui.el('div', { class: 'scanner', hidden: true }, video, ui.el('p', { class: 'note', text: t('fund.scanHint') }));
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
