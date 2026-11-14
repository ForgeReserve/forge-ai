// The conversation and what is attached to the next question, as the engine will see it. Uses v1's
// file helpers (files.js) for message building, budgets and size estimates. Pure, tested in Node.
import { applyBudget, estimateRequest, toApiMessages } from '../../js/files.js';
import { DEFAULT_CONTEXT, memory } from './rings.js';

/** The user message for typed text plus the attachments waiting for the next question. */
export function pendingMessage(text, pending, { vision = false } = {}) {
  const images = vision ? pending.filter((a) => a.kind === 'image').map((a) => a.url) : [];
  const docs = pending.filter((a) => a.kind !== 'image' && a.status === 'ready');
  const msg = { role: 'user', content: text ?? '' };
  if (images.length) msg.images = images;
  if (docs.length) msg.files = applyBudget(docs.map((d) => ({ name: d.name, kind: d.kind, size: d.size, pages: d.pages, text: d.text })));
  return msg;
}

export const apiMessages = (messages, { systemPrompt = '', vision = false } = {}) => toApiMessages(messages, { systemPrompt, vision });

/** Input tokens of a request for these messages (about four characters a token, as v1 counts). */
export function tokensOf(messages, opts) {
  return estimateRequest(apiMessages(messages, opts)).tokens;
}

/**
 * What the model would hold for the next question: the conversation plus the attachments. Returns the
 * memory meter and the list of held things, each with its share of the model's context.
 */
export function memoryView(messages, pending, { systemPrompt = '', vision = false, contextLength } = {}) {
  const live = messages.filter((m) => !m.meta?.error);
  const next = pending.length ? [...live, pendingMessage('', pending, { vision })] : live;
  const total = next.length ? tokensOf(next, { systemPrompt, vision }) : 0;
  const m = memory(total, contextLength);
  const ctx = contextLength && contextLength > 0 ? contextLength : DEFAULT_CONTEXT;
  const held = [];
  for (const a of pending) {
    const tokens = a.kind === 'image' ? 800 : Math.ceil((a.text?.length ?? 0) / 4);
    held.push({ id: a.id, kind: a.kind === 'image' ? 'image' : 'file', name: a.name, share: Math.min(1, tokens / ctx) });
  }
  if (live.length) held.push({ id: 'conversation', kind: 'conversation', name: '', share: Math.min(1, tokensOf(live, { vision }) / ctx) });
  return { ...m, tokens: total, held };
}

/**
 * What Ask again and Try again send: the conversation up to its last question, without the answers
 * after it and without failed replies. Empty when there is no question to ask again. Its last message
 * is the question asked again.
 */
export function againHistory(messages) {
  let end = messages.length;
  while (end && messages[end - 1].role === 'assistant') end--;
  return messages.slice(0, end).filter((m) => !m.meta?.error);
}

/** The last question and its answer, for the answer screen. Null before the first question. */
export function lastExchange(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const answer = messages.slice(i + 1).find((m) => m.role === 'assistant') ?? { role: 'assistant', content: '', meta: {} };
    return { question: messages[i].content, answer };
  }
  return null;
}
