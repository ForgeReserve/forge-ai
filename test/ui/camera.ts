import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qrMatrix } from '../../scripts/lib/qr.ts';

// A fake camera for the phone-sized browser. Chrome plays a Y4M file as the camera when started with
// --use-file-for-fake-video-capture, so the app's real camera adapter and v1's scanner read the QR code
// from it as they would from a phone camera pointed at a paper note.

type Level = 'L' | 'M' | 'Q' | 'H';

/** One greyscale frame (YUV 4:2:0, chroma neutral), W by H, showing the QR code of `text` as large as it fits. */
function frame(text: string, level: Level, W: number, H: number): Buffer {
  const m = qrMatrix(text, level);
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
 * animated code, each part held for `hold` frames), at error correction `level`, `width` by `height`
 * pixels (640 by 480, a browser's usual camera picture, unless said). Returns the file path.
 */
export function cameraFile(texts: string[], { fps = 10, hold = 3, level = 'L' as Level, width: W = 640, height: H = 480 } = {}): string {
  const frames = texts.flatMap((t) => Array(hold).fill(frame(t, level, W, H)) as Buffer[]);
  const dir = mkdtempSync(join(tmpdir(), 'forge-camera-'));
  const path = join(dir, 'camera.y4m');
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`), ...frames]));
  return path;
}

/**
 * Writes a Y4M video that shows one picture, given as RGBA pixels `width` by `height` (both even), for
 * `frames` frames: a camera pointed at a still scene. Returns the file path.
 */
export function pictureFile(rgba: Uint8Array, width: number, height: number, { fps = 10, frames = 10 } = {}): string {
  if (width % 2 || height % 2) throw new Error('the picture needs an even width and height');
  const y = Buffer.alloc(width * height);
  const u = Buffer.alloc((width / 2) * (height / 2));
  const v = Buffer.alloc((width / 2) * (height / 2));
  const at = (x: number, yy: number) => (yy * width + x) * 4;
  for (let yy = 0; yy < height; yy++)
    for (let x = 0; x < width; x++) {
      const i = at(x, yy);
      y[yy * width + x] = Math.round(0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!);
    }
  // Full range BT.601 (C420jpeg), each chroma sample from the mean of its 2 by 2 pixels.
  for (let yy = 0; yy < height; yy += 2)
    for (let x = 0; x < width; x += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const i = at(x + dx, yy + dy);
        r += rgba[i]!;
        g += rgba[i + 1]!;
        b += rgba[i + 2]!;
      }
      [r, g, b] = [r / 4, g / 4, b / 4];
      const k = (yy / 2) * (width / 2) + x / 2;
      u[k] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
      v[k] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
    }
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, u, v]);
  const dir = mkdtempSync(join(tmpdir(), 'forge-camera-'));
  const path = join(dir, 'camera.y4m');
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`), ...Array<Buffer>(frames).fill(frame)]));
  return path;
}

/** Chrome flags that make `file` the camera and grant it without a prompt. */
export const cameraArgs = (file: string) => ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${file}`];
