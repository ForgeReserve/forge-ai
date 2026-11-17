// Share unseen, third filter: covers places that look like writing (number plates, signs, papers, name
// tags) with flat blocks fitted to each line. Runs on the phone in plain JavaScript (textfind.js), with
// no model file. It can miss writing; the person sees every block before anything is shared and can
// add more.
// Handed only t (core/registry.js). It sees the photo being shared, never chats or the wallet.
import { findWriting } from './textfind.js';

export function create() {
  return {
    id: 'cover-numbers',
    what: 'writing',
    async analyse(photo) {
      return { covers: findWriting(photo.pixels).map((b) => ({ kind: 'writing', x: b.x, y: b.y, w: b.w, h: b.h, found: b.found })) };
    },
  };
}
