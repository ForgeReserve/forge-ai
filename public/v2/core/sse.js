// Reads an OpenAI-style server-sent event stream from the engine: answer text, reasoning, usage, and
// the gateway's final `forge` event (charge and new balance). Pure: no DOM, tested in Node.

/** Splits SSE text into events as it arrives. push() returns the complete events, flush() the rest. */
export function createSseParser() {
  let buf = '';
  const take = (block) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? 'message';
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    return data ? { event, data } : null;
  };
  return {
    push(text) {
      buf += text;
      const out = [];
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const ev = take(buf.slice(0, i));
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        if (ev) out.push(ev);
      }
      return out;
    },
    flush() {
      const ev = buf.trim() ? take(buf) : null;
      buf = '';
      return ev ? [ev] : [];
    },
  };
}

export class StreamError extends Error {
  constructor(message, code = 'stream_failed') {
    super(message);
    this.code = code;
  }
}

/**
 * Applies one event to the handlers. Throws StreamError when the engine reports an error in the stream.
 * handlers: {onText(s), onReasoning(s), onUsage(u), onForge(f)}
 */
export function applyEvent(ev, h) {
  if (ev.data === '[DONE]') return;
  let o;
  try {
    o = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (ev.event === 'forge') {
    h.onForge?.(o);
    return;
  }
  if (o?.error) throw new StreamError(o.error.message ?? 'The stream failed.', o.error.code ?? o.error.type ?? 'stream_failed');
  if (o?.usage) h.onUsage?.(o.usage);
  const d = o?.choices?.[0]?.delta;
  if (!d) return;
  const r = d.reasoning_content ?? d.reasoning;
  if (typeof r === 'string' && r) h.onReasoning?.(r);
  if (typeof d.content === 'string' && d.content) h.onText?.(d.content);
}

/**
 * Reads a fetch Response body to the end, calling the handlers as events arrive. An error inside the
 * stream does not stop the reading: the gateway sends its `forge` event (what it charged) right after
 * the error, and the app needs it to say what the failure cost. The first error is thrown at the end.
 */
export async function readStream(body, h) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const parser = createSseParser();
  let failed = null;
  const apply = (ev) => {
    try {
      applyEvent(ev, failed ? { onForge: h.onForge } : h);
    } catch (e) {
      if (!(e instanceof StreamError)) throw e;
      failed ??= e;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.push(dec.decode(value, { stream: true }))) apply(ev);
  }
  for (const ev of parser.push(dec.decode())) apply(ev);
  for (const ev of parser.flush()) apply(ev);
  if (failed) throw failed;
}
