import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake microphone for the phone-sized browser. Chrome plays a WAV file as the microphone when started
// with --use-file-for-fake-audio-capture (it loops), so a test decides what the app hears: a steady
// voice-loud tone, or silence. Chrome's own fake device only beeps now and then, and a short hold can
// fall between two beeps, which the app rightly takes for nothing said.

const RATE = 48000;

/** Writes two seconds of sound for the microphone: a steady tone (voice: true) or silence. Returns the path. */
export function micFile({ voice = true } = {}): string {
  const n = RATE * 2;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  // 200 Hz fits the two seconds a whole number of times, so the loop has no click.
  if (voice) for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 200 * i) / RATE)), 44 + i * 2);
  const path = join(mkdtempSync(join(tmpdir(), 'forge-mic-')), voice ? 'voice.wav' : 'silence.wav');
  writeFileSync(path, wav);
  return path;
}

/** Chrome flags that make `file` the microphone, grant it without a prompt and let sound play. */
export const micArgs = (file: string = micFile()) => ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--use-file-for-fake-audio-capture=${file}`];
