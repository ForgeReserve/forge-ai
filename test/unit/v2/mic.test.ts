import { describe, expect, it } from 'vitest';

const A: any = await import('../../../public/v2/core/adapters.js' as string);

describe('how the microphone is asked for', () => {
  // A Galaxy A16's web view gives pure silence to a page that asks for echo cancelling, so every
  // recording read as "nothing was heard". Nothing plays while a person records, so it is not needed.
  it('never asks for echo cancelling, and keeps noise suppression and automatic gain', () => {
    expect(A.MIC_SOUND).toEqual({ channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true });
  });
});
