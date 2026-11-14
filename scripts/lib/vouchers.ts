// Free question vouchers: the pure parts of scripts/issue-credits.ts (arguments). Nothing here talks to
// a mint or touches a file.
import { MAX_OUTPUTS, split, UsageError } from './notes.ts';

export const MAX_VOUCHERS = 500;
export const MAX_QUESTIONS = 100;

export interface VoucherArgs {
  help: boolean;
  /** Where minting is open: the credit mint on this computer. */
  mint: string;
  /** The address written in the vouchers (the credit mint's public address). */
  publicMint: string;
  count: number;
  questions: number;
  out: string;
}

/** True for an address on this computer. */
export const isLoopback = (u: URL): boolean => /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname);

const url = (flag: string, v: string): URL => {
  try {
    return new URL(v);
  } catch {
    throw new UsageError(`${flag} is not an address: ${v}`);
  }
};

export function parseVoucherArgs(argv: string[], today = new Date()): VoucherArgs {
  const raw = new Map<string, string>();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      help = true;
      continue;
    }
    if (a === '--') continue;
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !['mint', 'public-mint', 'count', 'questions', 'out'].includes(m[1]!)) throw new UsageError(`unknown argument ${a}`);
    const v = m[2] ?? argv[++i];
    if (v == null) throw new UsageError(`--${m[1]} needs a value`);
    raw.set(m[1]!, v);
  }
  const mint = (raw.get('mint') ?? '').trim().replace(/\/+$/, '');
  if (help) return { help, mint, publicMint: mint, count: 0, questions: 0, out: '' };
  if (!mint) throw new UsageError('--mint is needed: the credit mint on this computer, such as http://127.0.0.1:3338');
  // Minting is open only on the credit mint's own host (nginx blocks it everywhere else), so the tool
  // talks to a mint on this computer only.
  if (!isLoopback(url('--mint', mint))) throw new UsageError('--mint must be on this computer (127.0.0.1, localhost or [::1]): credits are issued from localhost only');
  const publicMint = (raw.get('public-mint') ?? mint).trim().replace(/\/+$/, '');
  const pu = url('--public-mint', publicMint);
  if (pu.protocol !== 'https:' && !(pu.protocol === 'http:' && isLoopback(pu))) throw new UsageError('--public-mint must be https (http only for a mint on this computer)');
  const count = Number(raw.get('count'));
  if (!Number.isInteger(count) || count < 1 || count > MAX_VOUCHERS) throw new UsageError(`--count must be 1 to ${MAX_VOUCHERS}`);
  const questions = Number(raw.get('questions') ?? 3);
  if (!Number.isInteger(questions) || questions < 1 || questions > MAX_QUESTIONS) throw new UsageError(`--questions must be 1 to ${MAX_QUESTIONS}`);
  if (split(questions).length * count > MAX_OUTPUTS) throw new UsageError('That batch needs too many pieces for one mint request. Make fewer vouchers.');
  return { help, mint, publicMint, count, questions, out: raw.get('out') ?? `free-questions-${today.toISOString().slice(0, 10)}.html` };
}
