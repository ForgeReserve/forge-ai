// Playful mode's rules, pure and tested in Node (test/unit/v2/playful.test.ts): the star chip's words, what
// Pip says on the home and on the answer, and where an answer's first sentence ends.
import { isFreeModel, perQuestion } from '../../../core/price.js';
import { questionsLeft } from '../../../core/rings.js';

/** At least this many typical questions left reads "Lots left"; fewer, "A little left". */
export const LOTS = 10;

/**
 * The star chip's state, in place of the money chip: never a price. One of
 *   'free'    a free model with a balance key: questions cost nothing;
 *   'start'   a free model and no balance key yet: Start free opens one;
 *   'lots'    LOTS or more typical questions left (the paid balance at the model's price, plus free questions);
 *   'little'  fewer than that, or a balance under one typical question;
 *   'some'    a paid balance on a model with no price in this unit (how many is not known);
 *   'none'    nothing to ask with.
 * The view's fields: model, unit (the unit of the total, view().unit), balanceMsub (the total of both
 * balances, null without a key), freeLeft, fundsBlock.
 */
export function starLevel({ model, unit, balanceMsub, freeLeft = 0, fundsBlock = null }) {
  if (fundsBlock === 'needKey') return 'start';
  if (isFreeModel(model)) return 'free';
  const per = perQuestion(model, unit);
  const paid = balanceMsub > 0 ? balanceMsub : 0;
  if (paid && !(per > 0)) return 'some';
  // Free questions count only where they can be used ('freeModel': they cannot on the chosen model).
  const free = fundsBlock === 'freeModel' || !(freeLeft > 0) ? 0 : freeLeft;
  const n = (paid ? questionsLeft(paid, per) : 0) + free;
  if (n >= LOTS) return 'lots';
  if (n > 0 || paid) return 'little';
  return 'none';
}

/**
 * What Pip's bubble on the home says (in place of the Default home's chips): {key, mood, go, count}.
 * key null while recording (the bubble shows the recording's line then). go: where its one button goes.
 */
export function homeMessage(v) {
  if (v.talk?.phase === 'recording') return { key: null, mood: 'listening' };
  if (!v.online) return { key: 'playful.offline', mood: 'oops' };
  if (v.fundsBlock === 'needKey') return { key: 'playful.needKey', mood: 'idle', go: v.startFree ? 'startFree' : 'addFunds' };
  // A free model with a balance key costs nothing at $0: no block, as on the Default home.
  if (v.noFunds && !v.modelFree) return v.fundsBlock === 'freeOut' ? { key: 'playful.freeOut', mood: 'idle', go: 'freeOut' } : { key: 'playful.noFunds', mood: 'idle', go: 'addFunds' };
  if (v.memory?.low) return { key: 'playful.memoryLow', mood: 'thinking', go: 'funds' };
  if (v.pendingCount) return { key: 'home.attached', mood: 'idle', count: v.pendingCount };
  return { key: 'playful.hello', mood: 'idle' };
}

/**
 * The line beside Pip on the answer card: {key, mood, reading}. reading: the answer is being read aloud
 * now (the design's green "Pip is reading it to you").
 */
export function answerLine(v) {
  const tk = v.talk ?? {};
  if (tk.phase === 'sending') return { key: 'playful.hearing', mood: 'listening' };
  if (tk.error) return { key: 'playful.oops', mood: 'oops' };
  const ex = v.lastExchange;
  if (!ex) return { key: 'playful.none', mood: 'idle' };
  const sp = v.speak ?? {};
  // As on the Default answer: the voice is being fetched or made ahead (loading, buffering), else it reads.
  if (sp.current && sp.state && sp.state !== 'idle') return sp.state === 'loading' || sp.state === 'buffering' ? { key: 'playful.gettingVoice', mood: 'reading' } : { key: 'playful.reading', mood: 'reading', reading: true };
  const a = ex.answer ?? {};
  if (v.streaming) return a.content ? { key: 'playful.writing', mood: 'thinking' } : { key: 'playful.thinking', mood: 'thinking' };
  if (a.meta?.error) return { key: 'playful.oops', mood: 'oops' };
  if (a.meta?.stopped) return { key: 'playful.stopped', mood: 'idle' };
  return { key: 'playful.found', mood: 'idle' };
}

/** Text that opens a Markdown block (a heading, a list, a quote, code, a table): no lead is split off it. */
const BLOCK = /^\s*(#|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/;
/** The longest lead: a first sentence longer than this stays in the text. */
const LEAD_MAX = 160;

/**
 * Splits an answer into its first sentence (the design's big line) and the rest: {lead, rest}, where
 * lead + rest is the text. While an answer streams the lead grows until its sentence ends. An answer that
 * opens with a Markdown block, or whose first sentence is long, has no lead.
 */
export function splitLead(text) {
  const s = String(text ?? '');
  if (!s.trim() || BLOCK.test(s)) return { lead: '', rest: s };
  const para = s.split(/\n/, 1)[0];
  // The sentence ends at . ! or ? followed by a space and a capital, a digit or a quote, or at the line's end.
  const m = /^[\s\S]*?[.!?](?=\s+["'“‘(\p{Lu}\d]|\s*$)/u.exec(para);
  const lead = m ? m[0] : para;
  if (lead.length > LEAD_MAX) return { lead: '', rest: s };
  return { lead, rest: s.slice(lead.length) };
}
