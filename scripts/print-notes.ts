/**
 * Makes a batch of paper notes: eCash for printing, to hand out at an event.
 *
 *   pnpm print-notes --count 20 --amount 1.00 [--unit usd] [--mint https://forge.flashapp.me] [--out notes.html]
 *   pnpm print-notes --resume notes.html.pending.json
 *
 * It asks the mint for one Lightning invoice for the whole batch, shows it, and waits until the owner
 * pays it. Then it mints the eCash, splits it into one token per note and writes one printable HTML
 * sheet (each note a QR code with its amount, a short how-to line and a serial with no meaning), with
 * file mode 0600.
 *
 * Tokens never go to the terminal or a log: only the file holds them. Errors are printed with anything
 * shaped like a token hidden.
 *
 * Money is never lost on the way. Before the invoice is shown, the batch (the quote, and a fresh seed the
 * eCash is made from) is written to <out>.pending.json, mode 0600. If the script stops after the payment,
 * --resume <that file> carries on; if the mint signed but its answer was lost, the eCash is restored from
 * the seed (NUT-09). The pending file holds secrets: it is removed once the sheet is written.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Wallet, type MintQuoteBolt11Response, type Proof } from '@cashu/cashu-ts';
import { amountOf, assignNotes, denominations, makeNotes, type Note, parseArgs, scrub, sheetHtml, type Unit, UsageError } from './lib/notes.ts';
import { qrText } from './lib/qr.ts';

const USAGE = `Makes printable paper notes of eCash.

  pnpm print-notes --count <n> --amount <a> [--unit usd|sat] [--mint <url>] [--out <file.html>]
  pnpm print-notes --resume <file.html.pending.json> [--out <file.html>]

  --count    how many notes (1 to 500)
  --amount   each note's value: dollars like 1 or 2.50 for usd, whole sats for sat
  --unit     usd (default) or sat
  --mint     the mint to make them at (default: the Forge mint the engine trusts)
  --out      the sheet to write (default notes-<date>.html); it must not exist yet
  --resume   carry on with a batch that was stopped
  --poll     how often to check the invoice, in ms (default 2000)
`;

interface Pending {
  v: 1;
  mint: string;
  unit: Unit;
  amount: number;
  count: number;
  out: string;
  quote: string;
  request: string;
  expiry: number | null;
  /** Hex. The eCash is made from this seed, so it can be restored if the mint's answer is lost. */
  seed: string;
  keysetId: string;
  counter: number;
  /** Set only when the eCash was minted but the sheet could not be written. */
  notes?: Note[];
}

const say = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s: string): never => {
  process.stderr.write(`${scrub(s)}\n`);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const units = (n: number, unit: Unit) => (unit === 'usd' ? `$${(n / 100).toFixed(2)}` : `${n.toLocaleString('en-US')} sat`);

/** Writes a new file with mode 0600, refusing to replace one. */
function writeNew(path: string, text: string) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600); // whatever the umask
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Writes or replaces the pending file (mode 0600) in one step, so it is never half written. */
function savePending(path: string, p: Pending) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeNew(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, path);
}

let pendingPath = '';

function loadPending(path: string): Pending {
  let p: Pending;
  try {
    p = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail(`Could not read ${path}.`);
  }
  if (p?.v !== 1 || !p.mint || !p.quote || !p.seed || !p.keysetId || !Number.isInteger(p.amount) || !Number.isInteger(p.count) || (p.unit !== 'usd' && p.unit !== 'sat')) fail(`${path} is not a pending batch.`);
  return p;
}

function checkOut(out: string) {
  if (existsSync(out)) fail(`${out} already exists. Choose another --out. Nothing was paid or minted.`);
  const dir = dirname(resolve(out));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`The folder for ${out} does not exist. Nothing was paid or minted.`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw e;
  }
  if (args.help) return say(USAGE);

  let pending: Pending;
  if (args.resume) {
    pendingPath = args.resume;
    pending = loadPending(pendingPath);
    if (args.out) pending.out = args.out;
    checkOut(pending.out);
  } else {
    checkOut(args.out);
    pendingPath = `${args.out}.pending.json`;
    if (existsSync(pendingPath)) fail(`${pendingPath} exists: a batch is unfinished. Run with --resume ${pendingPath}.`);
    const seed = randomBytes(32);
    const w = new Wallet(args.mint, { unit: args.unit, bip39seed: seed });
    try {
      await w.loadMint();
    } catch (e) {
      fail(`Could not reach the mint at ${args.mint}: ${(e as Error)?.message ?? e}. Nothing was paid or minted.`);
    }
    const total = args.amount * args.count;
    let q: MintQuoteBolt11Response;
    try {
      q = await w.createMintQuoteBolt11(total);
    } catch (e) {
      return fail(`The mint did not create an invoice: ${(e as Error)?.message ?? e}. Nothing was paid or minted.`);
    }
    pending = { v: 1, mint: args.mint, unit: args.unit, amount: args.amount, count: args.count, out: args.out, quote: q.quote, request: q.request, expiry: q.expiry ?? null, seed: seed.toString('hex'), keysetId: w.keysetId, counter: 1 };
    // Before the invoice is shown: a payment can always be finished from this file.
    savePending(pendingPath, pending);
  }

  if (!pending.notes) {
    const w = new Wallet(pending.mint, { unit: pending.unit, bip39seed: Buffer.from(pending.seed, 'hex'), keysetId: pending.keysetId });
    try {
      await w.loadMint();
    } catch (e) {
      fail(`Could not reach the mint at ${pending.mint}: ${(e as Error)?.message ?? e}. Run again with --resume ${pendingPath}.`);
    }
    const total = pending.amount * pending.count;
    let state = (await w.checkMintQuoteBolt11(pending.quote)).state;
    // A new batch always shows its invoice (a test mint may report it paid at once).
    if (state === 'UNPAID' || !args.resume) {
      say(`${pending.count} notes of ${units(pending.amount, pending.unit)}: pay ${units(total, pending.unit)} with this Lightning invoice.`);
      say();
      say(qrText(`lightning:${pending.request}`.toUpperCase()));
      say(pending.request);
      say();
      say(`Waiting for the payment. If you stop this, run: pnpm print-notes --resume ${pendingPath}`);
    }
    while (state === 'UNPAID') {
      if (pending.expiry && Date.now() / 1000 > pending.expiry + 30) {
        rmSync(pendingPath, { force: true });
        fail('The invoice expired before it was paid. Nothing was minted. Run the command again for a new invoice.');
      }
      await sleep(args.poll);
      try {
        state = (await w.checkMintQuoteBolt11(pending.quote)).state;
      } catch {
        /* the mint did not answer: ask again */
      }
    }
    say('Paid. Making the notes.');
    const proofs = await mint(w, pending, total);
    const groups = assignNotes(proofs, pending.amount, pending.count);
    pending.notes = makeNotes(pending.mint, pending.unit, pending.amount, groups);
  }

  try {
    writeNew(pending.out, sheetHtml(pending.notes, pending.unit));
  } catch (e) {
    // The eCash exists only here now: keep it in the pending file (0600), never on the terminal.
    savePending(pendingPath, pending);
    fail(`Could not write ${pending.out}: ${(e as Error)?.message ?? e}. The notes are kept in ${pendingPath}. Run again with --resume ${pendingPath} --out <another file>.`);
  }
  rmSync(pendingPath, { force: true });
  say(`Wrote ${pending.count} notes of ${units(pending.amount, pending.unit)} to ${pending.out}. Only you can read the file.`);
  say('Print it, cut the notes apart, then delete the file. Anyone who has the file can spend the notes.');
}

/**
 * Mints the batch from the paid quote, made from the seed so it can be restored. When the mint's answer
 * is lost (the quote shows as issued, or minting fails after the mint signed), the eCash is restored.
 */
async function mint(w: Wallet, p: Pending, total: number): Promise<Proof[]> {
  const pieces = denominations(p.amount, p.count);
  for (let attempt = 1; ; attempt++) {
    const state = (await w.checkMintQuoteBolt11(p.quote).catch(() => null))?.state;
    if (state === 'ISSUED') return restore(w, p, pieces.length, total);
    try {
      return await w.mintProofsBolt11(total, p.quote, { keysetId: p.keysetId }, { type: 'deterministic', counter: p.counter, denominations: pieces });
    } catch (e) {
      if (attempt >= 5) fail(`The mint did not hand out the eCash: ${(e as Error)?.message ?? e}. The payment is safe. Run again with --resume ${pendingPath}.`);
      await sleep(1000 * attempt);
    }
  }
}

async function restore(w: Wallet, p: Pending, n: number, total: number): Promise<Proof[]> {
  const { proofs } = await w.restore(p.counter, n, { keysetId: p.keysetId });
  const sum = proofs.reduce((s, x) => s + amountOf(x), 0);
  if (proofs.length !== n || sum !== total) fail(`The mint says the notes were already made, and only part could be restored. The batch file ${pendingPath} is kept.`);
  // Restored proofs may have been taken by whoever had them before; check they are still unspent.
  const states = await w.checkProofsStates(proofs);
  if (states.some((s) => s.state !== 'UNSPENT')) fail(`The mint says some of these notes were already spent. The batch file ${pendingPath} is kept.`);
  return proofs;
}

main().catch((e) => fail(`print-notes stopped: ${(e as Error)?.message ?? e}`));
