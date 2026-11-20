// Paper notes: the pure parts of scripts/print-notes.ts (arguments, splitting a paid batch into notes,
// the printable sheet). Nothing here talks to a mint or touches a file.
import { randomBytes } from 'node:crypto';
import { getEncodedToken, type Proof } from '@cashu/cashu-ts';
import { qrSvg } from './qr.ts';

// The web app's own formatter and string table, so a printed note uses the app's words.
const { fmtUnits } = (await import('../../public/js/ui.js' as string)) as { fmtUnits(n: number, unit: string): string };
const { t } = (await import('../../public/v2/core/i18n.js' as string)) as { t(key: string, params?: Record<string, unknown>): string };

/** The mint the engine trusts by default (FORGE_TRUSTED_MINTS in src/config.ts). */
export const DEFAULT_MINT = 'https://forge.flashapp.me';
export const MAX_COUNT = 500;
/** The most outputs one mint request asks for (Nutshell's default max_array_length is 1000). */
export const MAX_OUTPUTS = 1000;

export type Unit = 'usd' | 'sat';

export interface Args {
  help: boolean;
  mint: string;
  unit: Unit;
  /** Per note, in the unit's smallest amount (cents or sats). */
  amount: number;
  count: number;
  out: string;
  resume: string | null;
  /** How often to ask the mint whether the invoice is paid, in ms. */
  poll: number;
}

export class UsageError extends Error {}

/** Reads an amount as the owner types it: dollars like 1 or 2.50, or whole sats. Returns cents or sats. */
export function parseAmount(s: string, unit: Unit): number {
  const v = String(s ?? '').trim().replace(/^\$/, '');
  if (unit === 'usd') {
    if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new UsageError(`--amount must be dollars like 1 or 2.50, not ${s}`);
    return Math.round(Number(v) * 100);
  }
  if (!/^\d+$/.test(v)) throw new UsageError(`--amount must be a whole number of sats, not ${s}`);
  return Number(v);
}

export function parseArgs(argv: string[], today = new Date()): Args {
  const raw = new Map<string, string>();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      help = true;
      continue;
    }
    if (a === '--') continue;
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m || !['mint', 'unit', 'amount', 'count', 'out', 'resume', 'poll'].includes(m[1]!)) throw new UsageError(`unknown argument ${a}`);
    const v = m[2] ?? argv[++i];
    if (v == null) throw new UsageError(`--${m[1]} needs a value`);
    raw.set(m[1]!, v);
  }
  const unit = (raw.get('unit') ?? 'usd') as Unit;
  if (unit !== 'usd' && unit !== 'sat') throw new UsageError('--unit must be usd or sat');
  const mint = (raw.get('mint') ?? DEFAULT_MINT).trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(mint);
  } catch {
    throw new UsageError(`--mint is not an address: ${mint}`);
  }
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UsageError('--mint must be https (http only for a mint on this computer)');
  // Ten seconds: a mint's own limit on status checks can be as low as 20 a minute for one address, and a
  // check it refuses tells this script nothing, so a faster poll only makes a paid invoice look unpaid.
  const poll = Number(raw.get('poll') ?? 10_000);
  if (!Number.isInteger(poll) || poll < 100 || poll > 60_000) throw new UsageError('--poll must be 100 to 60000 ms');
  const resume = raw.get('resume') ?? null;
  const date = today.toISOString().slice(0, 10);
  if (resume || help) return { help, mint, unit, amount: 0, count: 0, out: raw.get('out') ?? '', resume, poll };
  const count = Number(raw.get('count'));
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new UsageError(`--count must be 1 to ${MAX_COUNT}`);
  if (!raw.has('amount')) throw new UsageError('--amount is needed');
  const amount = parseAmount(raw.get('amount')!, unit);
  if (amount < 1) throw new UsageError('--amount must be more than zero');
  if (denominations(amount, count).length > MAX_OUTPUTS) throw new UsageError('That batch needs too many pieces for one mint request. Make fewer notes, or round amounts.');
  return { help, mint, unit, amount, count, out: raw.get('out') ?? `notes-${date}.html`, resume: null, poll };
}

/** An amount as powers of two, largest first: the pieces one note is made of. */
export function split(amount: number): number[] {
  const out: number[] = [];
  for (let bit = 2 ** Math.floor(Math.log2(amount)); bit >= 1; bit /= 2) if (amount >= bit) (out.push(bit), (amount -= bit));
  return out;
}

/** The pieces to ask the mint for: one note's pieces, `count` times. */
export const denominations = (amount: number, count: number): number[] => Array.from({ length: count }, () => split(amount)).flat();

/** A proof's amount as a number (cashu-ts 4 hands amounts out as Amount objects). */
export const amountOf = (p: Proof): number => {
  const a = p.amount as unknown;
  return typeof a === 'number' ? a : typeof a === 'bigint' ? Number(a) : (a as { toNumber(): number }).toNumber();
};

/** Sorts minted proofs into `count` notes of `amount` each. Throws if the proofs do not make them up exactly. */
export function assignNotes(proofs: Proof[], amount: number, count: number): Proof[][] {
  const pool = new Map<number, Proof[]>();
  for (const p of proofs) pool.set(amountOf(p), [...(pool.get(amountOf(p)) ?? []), p]);
  const notes: Proof[][] = [];
  for (let i = 0; i < count; i++) {
    const note: Proof[] = [];
    for (const d of split(amount)) {
      const p = pool.get(d)?.pop();
      if (!p) throw new Error('the minted pieces do not make up the notes');
      note.push(p);
    }
    notes.push(note);
  }
  if ([...pool.values()].some((l) => l.length)) throw new Error('the mint returned more pieces than the notes need');
  return notes;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base 32: no I, L, O or U

/** A serial for a printed note: random, so it says nothing about the note or the batch. */
export function serial(bytes: Buffer = randomBytes(8)): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i]! & 31];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export interface Note {
  token: string;
  amount: number;
  serial: string;
}

/** The notes of a batch: one token each, with a fresh serial. */
export function makeNotes(mint: string, unit: Unit, amount: number, groups: Proof[][]): Note[] {
  const seen = new Set<string>();
  return groups.map((proofs) => {
    let s = serial();
    while (seen.has(s)) s = serial();
    seen.add(s);
    // Without the DLEQ proofs: the code stays small enough to scan from paper, and the engine checks
    // the note with the mint when it is added.
    return { token: getEncodedToken({ mint, unit, proofs }, { removeDleq: true }), amount, serial: s };
  });
}

/** Notes for tokens that are already made (free question vouchers): one fresh serial each. */
export function makeNoteRecords(tokens: string[], amount: number): Note[] {
  const seen = new Set<string>();
  return tokens.map((token) => {
    let s = serial();
    while (seen.has(s)) s = serial();
    seen.add(s);
    return { token, amount, serial: s };
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface SheetWords {
  title: string;
  help: string;
  qr: string;
  howTo: string;
  keep: string;
  amount?: string;
}
const NOTE_WORDS: SheetWords = { title: 'note.print.title', help: 'note.print.help', qr: 'note.print.qr', howTo: 'note.print.howTo', keep: 'note.print.keep' };
const CREDIT_WORDS: SheetWords = { title: 'credit.print.title', help: 'credit.print.help', qr: 'credit.print.qr', howTo: 'credit.print.howTo', keep: 'credit.print.keep', amount: 'credit.print.amount' };
const CREDIT_WORDS_ONE: SheetWords = { ...CREDIT_WORDS, qr: 'credit.print.qrOne', howTo: 'credit.print.howToOne', amount: 'credit.print.amountOne' };

/**
 * The printable sheet: one card per note with its QR code, amount, a short how-to line and its serial.
 * Self-contained (no script, no font, nothing fetched), and its Content-Security-Policy forbids loading
 * anything. Each card carries its token in data-token too, so the sheet can be checked by a program.
 * kind 'credits': the notes are free question vouchers (scripts/issue-credits.ts): each amount is a
 * number of free questions, and the words say they are not money.
 */
export function sheetHtml(notes: Note[], unit: Unit, kind: 'money' | 'credits' = 'money'): string {
  const w0 = kind === 'credits' ? CREDIT_WORDS : NOTE_WORDS;
  const cards = notes
    .map((n) => {
      // One free question reads as one, not "1 free questions".
      const w = kind === 'credits' && n.amount === 1 ? CREDIT_WORDS_ONE : w0;
      const amount = kind === 'credits' ? t(w.amount!, { count: n.amount }) : fmtUnits(n.amount, unit);
      return `<section class="note" data-token="${esc(n.token)}" data-serial="${esc(n.serial)}">
<div class="qr">${qrSvg(n.token, 'L', t(w.qr, { amount, count: n.amount }))}</div>
<div class="text"><p class="amount">${esc(amount)}</p><p class="how">${esc(t(w.howTo, { amount, count: n.amount }))}</p><p class="keep">${esc(t(w.keep))}</p><p class="serial">${esc(t('note.print.serial', { serial: n.serial }))}</p></div>
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>${esc(t(w0.title))}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #14161A; background: #fff; }
  .help { max-width: 760px; margin: 0 auto 16px; padding: 12px 14px; border: 1px solid #D9B45A; border-radius: 12px; background: #F6E9C8; }
  .help p { margin: 0; }
  .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(88mm, 1fr)); gap: 0; max-width: 200mm; margin: 0 auto; }
  .note { display: flex; gap: 3mm; align-items: center; padding: 4mm; border: 1px dashed #8C8A84; break-inside: avoid; page-break-inside: avoid; }
  .qr { flex: none; width: 42mm; height: 42mm; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .text p { margin: 0 0 1.5mm; }
  .amount { font-size: 20px; font-weight: 700; }
  .how { font-size: 11px; font-weight: 600; }
  .keep { font-size: 10px; color: #3F4348; }
  .serial { font: 10px ui-monospace, Menlo, monospace; color: #5B6068; }
  @page { margin: 10mm; }
  @media print { body { padding: 0; } .help { display: none; } }
</style>
</head>
<body>
<div class="help"><p>${esc(t(w0.help, { count: notes.length }))}</p></div>
<main class="sheet">
${cards}
</main>
</body>
</html>
`;
}

/** Hides anything shaped like an eCash token in text for the terminal (an error message, say). */
export const scrub = (text: string): string => String(text).replace(/cashu[AB][A-Za-z0-9_\-+/=]{8,}/g, 'cashu[hidden]');
