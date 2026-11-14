import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qrMatrix } from '../../scripts/lib/qr.ts';

// A fake camera for the phone-sized browser. Chrome plays a Y4M file as the camera when started with
// --use-file-for-fake-video-capture, so the app's real camera adapter and v1's scanner read the QR code
// from it as they would from a phone camera pointed at a paper note.

const W = 640;
const H = 480;

/** One greyscale frame (YUV 4:2:0, chroma neutral) showing the QR code of `text`. */
function frame(text: string): Buffer {
  const m = qrMatrix(text, 'L');
  const n = m.length + 8; // with a quiet zone
  const cell = Math.max(1, Math.floor((H - 40) / n));
  const ox = Math.floor((W - n * cell) / 2);
  const oy = Math.floor((H - n * cell) / 2);
  const y = Buffer.alloc(W * H, 200);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const dark = !!m[r - 4]?.[c - 4];
      const v = dark ? 16 : 235;
      for (let dy = 0; dy < cell; dy++) y.fill(v, (oy + r * cell + dy) * W + ox + c * cell, (oy + r * cell + dy) * W + ox + (c + 1) * cell);
    }
  const uv = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  return Buffer.concat([Buffer.from('FRAME\n'), y, uv]);
}

/**
 * Writes a Y4M video that shows each text's QR code in turn (one text: a still code; several: an
 * animated code, each part held for `hold` frames). Returns the file path.
 */
export function cameraFile(texts: string[], { fps = 10, hold = 3 } = {}): string {
  const frames = texts.flatMap((t) => Array(hold).fill(frame(t)) as Buffer[]);
  const dir = mkdtempSync(join(tmpdir(), 'forge-camera-'));
  const path = join(dir, 'camera.y4m');
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`), ...frames]));
  return path;
}

/** Chrome flags that make `file` the camera and grant it without a prompt. */
export const cameraArgs = (file: string) => ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${file}`];
