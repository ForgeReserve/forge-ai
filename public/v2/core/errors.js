// Engine error codes in plain words, each with one next step. Pure, tested in Node.

/** Plain words and one next step for an engine error code. */
export function errorView(code, message) {
  switch (code) {
    case 'insufficient_balance':
    case 'payment_required':
      return { key: 'error.funds', next: 'addFunds' };
    case 'invalid_key':
      return { key: 'error.key', next: 'addFunds' };
    case 'offline':
      return { key: 'error.offline', next: 'retry' };
    case 'rate_limited':
    case 'token_in_flight':
      return { key: 'error.busy', next: 'retry' };
    case 'upstream_error':
    case 'stream_failed':
      return { key: 'error.model', next: 'retry' };
    case 'model_not_found':
      return { key: 'error.gone', next: 'chooseModel' };
    case 'request_too_large':
      return { key: 'error.tooLarge', next: 'startFresh' };
    case 'encryption_unavailable':
    case 'encryption_required':
      return { key: 'error.encryption', next: 'retry' };
    case 'account_frozen':
      return { key: 'error.frozen', next: 'takeOut' };
    default:
      return { key: 'error.other', next: 'retry', message };
  }
}
