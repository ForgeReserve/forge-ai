// Share unseen, first filter: the hidden details in the photo file (where, when, which phone, a small
// copy of the picture). analyse() reads which ones the original holds, for the list of changes. The
// photo is always made into a new file on the phone (core/photo.js draws it again), and finish() then
// takes every place for notes out of that new JPEG, so none of them can travel with it.
// Handed only t (core/registry.js). It sees the photo being shared, never chats or the wallet.
import { readDetails, stripJpeg } from '../../../core/photometa.js';

export function create() {
  return {
    id: 'strip-details',
    what: 'details',
    /** {found: ['location', 'device', 'time', 'thumbnail', 'other'], known} for the original file. */
    async analyse(photo) {
      const r = readDetails(photo.bytes);
      return { found: r.found, known: r.known };
    },
    /** The new JPEG with no Exif, XMP, IPTC, colour profile, comment or trailing data. */
    finish: (bytes) => stripJpeg(bytes),
  };
}
