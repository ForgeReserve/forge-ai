// A small APK for tests: a zip holding an AndroidManifest.xml in Android's binary XML, so the gateway
// reads its version (src/download.ts apkVersion) as it does a real one's.
import { randomBytes } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

/** Android binary XML with one <manifest> element carrying versionCode and versionName, as aapt2 writes it. */
export function manifestXml(versionName: string, versionCode: number): Buffer {
  const strings = ['versionCode', 'versionName', 'manifest', versionName];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const chunk = (type: number, head: Buffer, body: Buffer) => Buffer.concat([u16(type), u16(8 + head.length), u32(8 + head.length + body.length), head, body]);
  const data = Buffer.concat(strings.map((x) => Buffer.concat([u16(x.length), Buffer.from(x, 'utf16le'), u16(0)])));
  let offset = 0;
  const offsets = strings.map((x) => {
    const o = offset;
    offset += 4 + x.length * 2;
    return u32(o);
  });
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  const pool = chunk(0x0001, Buffer.concat([u32(strings.length), u32(0), u32(0), u32(28 + 4 * strings.length), u32(0)]), Buffer.concat([...offsets, padded]));
  const map = chunk(0x0180, Buffer.alloc(0), Buffer.concat([u32(0x0101021b), u32(0x0101021c)]));
  const attr = (name: number, raw: number, type: number, value: number) => Buffer.concat([u32(0xffffffff), u32(name), u32(raw), u16(8), Buffer.from([0, type]), u32(value)]);
  const ext = Buffer.concat([u32(0xffffffff), u32(2), u16(20), u16(20), u16(2), u16(0), u16(0), u16(0)]);
  const element = chunk(0x0102, Buffer.concat([u32(1), u32(0xffffffff)]), Buffer.concat([ext, attr(0, 0xffffffff, 0x10, versionCode), attr(1, 3, 0x03, 3)]));
  return chunk(0x0003, Buffer.alloc(0), Buffer.concat([pool, map, element]));
}

/** A zip holding these files, deflated, as an APK is. */
export function zip(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const [name, raw] of Object.entries(files)) {
    const packed = deflateRawSync(raw);
    const n = Buffer.from(name);
    const fields = (b: Buffer, o: number) => {
      b.writeUInt16LE(8, o);
      b.writeUInt32LE(crc32(raw), o + 6);
      b.writeUInt32LE(packed.length, o + 10);
      b.writeUInt32LE(raw.length, o + 14);
      b.writeUInt16LE(n.length, o + 18);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    fields(local, 8);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    fields(dir, 10);
    dir.writeUInt32LE(at, 42);
    parts.push(local, n, packed);
    central.push(dir, n);
    at += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** An APK of about `size` bytes (random filler, which does not compress) that declares this version. */
export const fakeApk = (version: string, code: number, size = 300_000) => zip({ 'AndroidManifest.xml': manifestXml(version, code), 'assets/filler.bin': randomBytes(size) });
