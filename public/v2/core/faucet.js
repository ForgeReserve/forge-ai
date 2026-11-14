// The faucet client (docs/FREE-TIER.md, layer 3): asks the engine for a puzzle, solves it on the phone,
// and claims a voucher of free questions. Shared by the Free questions fund module and the /free page.
// Pure apart from the `call` it is given (engine.call: JSON in, {status, ok, body} out) and the solver.
import { solvePow } from './pow.js';

export class FaucetError extends Error {
  constructor(code, message, { status = 0, nextAt = null } = {}) {
    super(message);
    this.name = 'FaucetError';
    this.code = code;
    this.status = status;
    this.nextAt = nextAt;
  }
}

const refuse = (r) => {
  const e = r.body?.error ?? {};
  return new FaucetError(e.code ?? `http_${r.status}`, e.message ?? `The engine answered HTTP ${r.status}.`, { status: r.status, nextAt: r.body?.next_at ?? null });
};

/** The faucet's state: {questions, questions_left_today, available_now, next_at}. Throws when it is off. */
export async function faucetStatus(call) {
  const r = await call('/v1/free');
  if (!r.ok) throw refuse(r);
  return r.body;
}

/**
 * Gets one voucher: puzzle, answer, claim. onStep('puzzle' | 'working' | 'claiming'), onProgress(0..1).
 * Returns {token, questions}. Throws FaucetError (faucet_empty and faucet_limit carry nextAt).
 */
export async function getVoucher({ call, solve = solvePow, onStep, onProgress, signal }) {
  onStep?.('puzzle');
  const c = await call('/v1/free/challenge', { json: {}, signal });
  if (!c.ok) throw refuse(c);
  onStep?.('working');
  const solution = await solve(c.body.challenge, c.body.bits, { signal, onProgress });
  const v = await call('/v1/free/verify', { json: { solution }, signal });
  if (!v.ok) throw refuse(v);
  onStep?.('claiming');
  // A claim that failed on the engine's side (503) can be sent again with the same ticket.
  for (let i = 0; ; i++) {
    const r = await call('/v1/free/claim', { json: { ticket: v.body.ticket }, signal });
    if (r.ok) return { token: r.body.token, questions: r.body.questions };
    if (r.status !== 503 || i >= 2) throw refuse(r);
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
}

/**
 * The words for the faucet's state: {key, count, time, now} for the string table.
 *   faucet.left: free questions left today. faucet.waitDrip: none right now, more at the next drip.
 *   faucet.waitDay: none left today, more tomorrow.
 * `count` is written with thousands separators, `time` is when more come, in the phone's own clock
 * (hours and minutes). `now` is true when one can be claimed right now.
 */
export function faucetLine(status, { timeFmt = defaultTime, numFmt = (n) => n.toLocaleString('en-US') } = {}) {
  const time = status?.next_at ? timeFmt(status.next_at) : '';
  if (!status || !(status.questions_left_today > 0)) return { key: 'faucet.waitDay', count: numFmt(0), time, now: false };
  if (!(status.available_now > 0)) return { key: 'faucet.waitDrip', count: numFmt(status.questions_left_today), time, now: false };
  return { key: 'faucet.left', count: numFmt(status.questions_left_today), time, now: true };
}

/** What a refusal means, as a string key: when more come, or a plain failure. */
export function faucetRefusal(err) {
  switch (err?.code) {
    case 'faucet_empty':
      return 'faucet.empty';
    case 'faucet_limit':
      return 'faucet.limit';
    case 'not_found':
      return 'faucet.off';
    case 'offline':
      return 'faucet.offline';
    default:
      return 'faucet.failed';
  }
}

const defaultTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
