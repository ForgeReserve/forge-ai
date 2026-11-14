/**
 * Issues a batch of free question vouchers (credits, docs/FREE-TIER.md) for printing.
 *
 *   pnpm issue-credits --mint http://127.0.0.1:3338 --public-mint https://credits.example --count 50 [--questions 3] [--out file.html]
 *
 * Localhost only: --mint must be the credit mint on this computer, where minting is open (nginx blocks
 * it everywhere else, deploy/credit-mint/). The vouchers carry --public-mint, the address people's
 * engines reach. Credits cost nothing to make (the credit mint pays its own quotes) and pay only for
 * free questions, so nothing is paid here.
 *
 * It writes one printable HTML sheet in the paper note layout (scripts/lib/notes.ts), file mode 0600.
 * Vouchers never go to the terminal or a log: only the file holds them.
 */
import { closeSync, existsSync, fchmodSync, openSync, statSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mintCredits } from '../src/credits.ts';
import { makeNoteRecords, scrub, sheetHtml, UsageError } from './lib/notes.ts';
import { parseVoucherArgs } from './lib/vouchers.ts';

const USAGE = `Issues printable free question vouchers from the credit mint on this computer.

  pnpm issue-credits --mint <url> [--public-mint <url>] --count <n> [--questions <q>] [--out <file.html>]

  --mint         the credit mint on this computer (http://127.0.0.1:... or http://localhost:...)
  --public-mint  the credit mint's public address, written in the vouchers (default: --mint)
  --count        how many vouchers (1 to 500)
  --questions    free questions per voucher (default 3)
  --out          the sheet to write (default free-questions-<date>.html); it must not exist yet
`;

const say = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s: string): never => {
  process.stderr.write(`${scrub(s)}\n`);
  process.exit(1);
};

async function main() {
  let args;
  try {
    args = parseVoucherArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw e;
  }
  if (args.help) return say(USAGE);
  if (existsSync(args.out)) fail(`${args.out} already exists. Choose another --out. Nothing was issued.`);
  const dir = dirname(resolve(args.out));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`The folder for ${args.out} does not exist. Nothing was issued.`);
  // The file is made first (mode 0600, never replacing one), so vouchers are only ever made for a file that exists.
  let fd: number;
  try {
    fd = openSync(args.out, 'wx', 0o600);
    fchmodSync(fd, 0o600);
  } catch (e) {
    return fail(`Could not create ${args.out}: ${(e as Error)?.message ?? e}. Nothing was issued.`);
  }
  try {
    let tokens: string[];
    try {
      tokens = await mintCredits({ issueUrl: args.mint, publicUrl: args.publicMint, unit: 'usd', amounts: Array.from({ length: args.count }, () => args.questions) });
    } catch (e) {
      return fail(`The credit mint at ${args.mint} did not issue the vouchers: ${(e as Error)?.message ?? e}. ${args.out} is empty: delete it and try again.`);
    }
    writeSync(fd, sheetHtml(makeNoteRecords(tokens, args.questions), 'usd', 'credits'));
  } finally {
    closeSync(fd);
  }
  say(`Wrote ${args.count} vouchers of ${args.questions} free questions to ${args.out}. Only your user account on this computer can open it.`);
  say('Print it, cut the vouchers apart, then delete the file. They are free questions, not money.');
}

main().catch((e) => fail(`issue-credits stopped: ${(e as Error)?.message ?? e}`));
