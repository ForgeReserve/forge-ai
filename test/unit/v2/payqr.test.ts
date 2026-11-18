import { describe, expect, it } from 'vitest';

// What a payment request's QR code carries (public/v2/modules/fund/kit.js requestQR). A Lightning
// invoice goes as `lightning:<invoice>` in lowercase, the same string as its Open in wallet link: Primal
// on the iPhone strips only a lowercase `lightning:` and read `LIGHTNING:LNBC...` as an invalid checksum.
const KIT: any = await import('../../../public/v2/modules/fund/kit.js' as string);

// BOLT 11's first test vector (lightning/bolts 11-payment-encoding.md).
const INVOICE =
  'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';

/** requestQR with stand-ins: what the code was drawn with, the Open link and what Copy copies. */
function drawn(uri: string, openLabel: string | null = 'Open') {
  const rendered: Array<[string, string]> = [];
  const copied: string[] = [];
  const nodes: any[] = [];
  const el = (tag: string, attrs: any = {}, ...kids: any[]) => {
    const n = { tag, attrs, kids };
    nodes.push(n);
    return n;
  };
  const ui = { el, icon: () => null, toast() {}, copy: async (x: string) => (copied.push(x), true) };
  const qr = { renderQR: async (_box: unknown, text: string, level: string) => void rendered.push([text, level]) };
  KIT.requestQR({ t: (k: string) => k, ui, qr }, { uri, copyText: uri.replace(/^[a-z]+:/i, ''), copyLabel: 'Copy', qrLabel: 'QR', openLabel });
  const open = nodes.find((n) => n.tag === 'a');
  const copy = nodes.find((n) => n.tag === 'button');
  return { rendered, open: open?.attrs.href ?? null, copy: () => copy.attrs.onclick().then(() => copied[0]) };
}

describe('the QR code of a payment request', () => {
  it('carries a Lightning invoice as lowercase lightning:<invoice>, the same string as the Open link', async () => {
    const d = drawn('lightning:' + INVOICE);
    expect(d.rendered).toEqual([['lightning:' + INVOICE, 'M']]);
    expect(d.open).toBe('lightning:' + INVOICE);
    expect(await d.copy()).toBe(INVOICE);
  });

  it('turns an invoice given in upper case, or with an upper case scheme, into lowercase', () => {
    expect(drawn('LIGHTNING:' + INVOICE.toUpperCase()).rendered[0]![0]).toBe('lightning:' + INVOICE);
    expect(drawn('Lightning:' + INVOICE).open).toBe('lightning:' + INVOICE);
    expect(KIT.qrPayload('LIGHTNING:' + INVOICE.toUpperCase())).toBe('lightning:' + INVOICE);
  });

  it('leaves a bitcoin: address as given (on-chain, BIP 21)', () => {
    const uri = 'bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
    expect(drawn(uri, null).rendered).toEqual([[uri, 'M']]);
    expect(drawn(uri, null).open).toBeNull();
    expect(KIT.qrPayload(uri)).toBe(uri);
  });
});
