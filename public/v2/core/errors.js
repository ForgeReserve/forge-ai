// Engine error codes in plain words, each with one next step. Pure, tested in Node.

/**
 * What a failed or empty answer cost, in msub, for errorView. The engine's final `forge` event says it
 * exactly. Without one: a question refused with an HTTP error before any answer is not charged (0);
 * a stream that broke without the final event is not known (null).
 */
export function chargedFor(forge, err) {
  if (typeof forge?.charged_msub === 'number') return forge.charged_msub;
  if (err && Number(err.status) > 0) return 0;
  return null;
}

/**
 * Plain words and one next step for an engine error code.
 * charged: what the engine says the failed question cost, in msub. 0 (the default) when the engine
 * refused the question before any answer, as it does for an upstream failure, which it does not charge.
 * null when nobody knows: the stream ended without the engine's final event. The words never claim
 * "not charged" unless the engine said so.
 */
export function errorView(code, message, charged = 0) {
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
      if (charged == null) return { key: 'error.modelUnknown', next: 'retry' };
      if (charged > 0) return { key: 'error.modelCharged', next: 'retry', charged };
      return { key: 'error.model', next: 'retry' };
    case 'model_not_found':
      return { key: 'error.gone', next: 'chooseModel' };
    case 'request_too_large':
      return { key: 'error.tooLarge', next: 'startFresh' };
    case 'encryption_unavailable':
    case 'encryption_required':
      return { key: 'error.encryption', next: 'retry' };
    // A voice question the engine refused before any charge: hold the button again.
    case 'audio_too_short':
      return { key: 'talk.empty', next: 'retry' };
    case 'audio_too_long':
      return { key: 'talk.tooLong', next: 'retry' };
    case 'unsupported_audio':
      return { key: 'talk.cannotUse', next: 'retry' };
    case 'account_frozen':
      return { key: 'error.frozen', next: 'takeOut' };
    default:
      return { key: 'error.other', next: 'retry', message };
  }
}
