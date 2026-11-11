/**
 * Publishes the Forge mint's NIP-87 announcement (kind 38172), signed by the mint's Nostr account.
 *
 *   node scripts/announce-mint.ts            prints the event it would publish
 *   node scripts/announce-mint.ts --publish  asks for the nsec (hidden), signs and publishes
 *
 * Only forge.flashapp.me is announced. The mint also answers at mint.forge-reserve.com, but cashu.me and
 * Minibits refuse a second address whose keysets match a mint they already hold, so tokens stamped with it
 * cannot be received by existing Forge holders there. cashu.me also files reviews by exact URL.
 * The `d` tag is the mint's pubkey, which reviews that name the mint by key match.
 * The nsec is read from the terminal, used in memory and never written or printed.
 */
import { createInterface } from 'node:readline';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const URLS = ['https://forge.flashapp.me'];
// damus and primal are two of cashu.me's three discovery relays. nos.lol (the third) times out on writes from
// this account, and relay.cashumints.space refuses kind 38172, so neither is used.
const RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://offchain.pub'];

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Decode(s: string, hrp: string): Uint8Array {
  const str = s.trim().toLowerCase();
  const pos = str.lastIndexOf('1');
  if (str.slice(0, pos) !== hrp) throw new Error(`expected a ${hrp}`);
  const words = [...str.slice(pos + 1, -6)].map((c) => {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error('bad bech32 character');
    return v;
  });
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length !== 32) throw new Error(`${hrp} must hold 32 bytes`);
  return Uint8Array.from(out);
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let asked = false;
    out._writeToOutput = (s: string) => {
      if (!asked) {
        process.stdout.write(s);
        asked = true;
      }
    };
    rl.question(prompt, (v) => {
      rl.close();
      process.stdout.write('\n');
      resolve(v);
    });
  });
}

async function publish(ev: object, url: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      resolve('timeout');
    }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]));
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d[0] === 'OK') {
        clearTimeout(t);
        ws.close();
        resolve(d[2] ? 'ok' : `refused: ${d[3]}`);
      }
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve('connection failed');
    };
  });
}

const info = (await (await fetch(`${URLS[0]}/v1/info`)).json()) as {
  pubkey: string;
  name?: string;
  description?: string;
  icon_url?: string;
  nuts: Record<string, unknown>;
  contact?: Array<{ method: string; info: string }>;
};
const npub = info.contact?.find((c) => c.method === 'nostr')?.info;
if (!npub) throw new Error('mint info names no nostr contact');
const expected = bytesToHex(bech32Decode(npub, 'npub'));

const content = JSON.stringify({ name: info.name, about: info.description, ...(info.icon_url ? { picture: info.icon_url } : {}) });
const tags = [
  ['d', info.pubkey],
  ...URLS.map((u) => ['u', u, 'cashu']),
  ['nuts', Object.keys(info.nuts).sort((a, b) => Number(a) - Number(b)).join(',')],
  ['n', 'mainnet'],
];
const draft = { kind: 38172, pubkey: expected, created_at: Math.floor(Date.now() / 1000), tags, content };

if (!process.argv.includes('--publish')) {
  console.log(JSON.stringify(draft, null, 2));
  console.log(`\nSigner must be ${npub}. Run with --publish to sign and send.`);
  process.exit(0);
}

const sk = bech32Decode(await askHidden(`nsec for ${npub.slice(0, 16)}…: `), 'nsec');
const pub = bytesToHex(schnorr.getPublicKey(sk));
if (pub !== expected) throw new Error('that nsec does not belong to the mint’s Nostr account; nothing published');
const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, pub, draft.created_at, draft.kind, draft.tags, draft.content]))));
const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
sk.fill(0);
const ev = { ...draft, id, sig };
const results = await Promise.all(RELAYS.map(async (r) => [r, await publish(ev, r)] as const));
for (const [r, s] of results) console.log(`${r}: ${s}`);
console.log(`event id ${id}`);
process.exit(results.some(([, s]) => s === 'ok') ? 0 : 1);
