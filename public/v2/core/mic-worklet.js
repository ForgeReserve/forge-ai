// The microphone's capture, run on the audio thread (an AudioWorklet; core/adapters.js mic.open loads
// it once per recording context). It gathers the microphone's samples into chunks of `size` (4096, as the
// ScriptProcessorNode it replaces gave) and posts each one to the page. Nothing here keeps the sound:
// each chunk is handed over and let go. 'stop' from the page ends it.
class ForgeMic extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options?.processorOptions?.size ?? 4096;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.on = false;
    };
  }

  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.size - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('forge-mic', ForgeMic);
