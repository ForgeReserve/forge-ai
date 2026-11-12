# Modules and protocols

Status: design. Written 2026-11-12.

Forge AI is a **reference build**: one working set of choices, made so anyone can swap any part of it. Two rules make that possible:

1. **Protocols at the seams.** Wherever two parts meet, they speak an open, written protocol. Nothing depends on Forge running the other side.
2. **Modules behind the seams.** Each part sits behind a small interface, so a different module can replace it without touching the rest. A group that dislikes one part changes that module, not the app.

## The seams

| Seam | Protocol | Forge's default | What someone might swap in |
|---|---|---|---|
| App to engine | OpenAI chat completions API | Bellows | Any compatible engine |
| Engine to AI models | OpenAI API, encrypted pass-through with attestation | Tinfoil, Token Factory | Another enclave provider, a local model |
| Paying | Cashu (NUTs), Lightning | Forge mint, discovered mints | Their own mint, a community mint |
| Finding engines | Signed announcements over Nostr | Forge's list of Bellows operators | Their own operator list |
| Finding mints | NIP-87 announcements and reviews | Reviewed mints with 2 or more reviewers | Their own allowlist |
| Guides | Signed guide packages | A short starting list | Their own organisation's guides |
| Free questions | Credit vouchers (FREE-TIER.md) | Forge's daily faucet | Their own faucet or sponsored batches |

## Engine modules (Bellows)

| Module | Interface | Today |
|---|---|---|
| Suppliers | `Supplier` in `src/suppliers/types.ts`: `chat`, optional `forwardEncrypted`, `attestation`, `hpkeKeys` | Built: Tinfoil, OpenAI-compatible, mock |
| Funding methods | `methods()` and per-method handlers in `src/funding.ts` | Built inline: Lightning, on-chain, other mints. To split into one file per method behind one interface |
| Mint policy | `vetForeignMint` and discovery in `src/mint-discovery.ts` | Built: discovered, allowlist, any, deny list |
| Pricing | `src/pricing.ts`, the model catalog JSON | Built: catalog plus markup |
| Exchange rates | rate sources in `src/rates.ts` | Built: several exchanges, median |
| Storage | `src/db.ts` on SQLite | Built. Stays one file: an operator should not need a database server |

Swapping an engine module is a config change plus, at most, one new file implementing the interface.

## App modules

Each app module is a **plugin**: a folder with a manifest and code, loaded from the bundled set or added later.

| Kind | What it does | Interface (input to output) | Default set |
|---|---|---|---|
| `voice-in` | Speech to text | audio to text | On-device recogniser; enclave transcription as an option |
| `voice-out` | Text to speech | text to audio | On-device Kokoro voices (from flash-speech) |
| `filter` | Share unseen: removes identity from anything sent on | file to file plus a report of what changed | Faces covered, numbers covered, location and metadata stripped, voice changed |
| `cover` | The disguise game | a game screen plus a hidden way in | One puzzle under several names and icons |
| `guides` | Trusted knowledge to answer from | a signed package of documents plus an index | A short starting list |
| `protect` | Phone protection steps | a checklist per platform with deep links | Android and iPhone lists from published advice |
| `language` | Interface text and voices | string table plus voice choices | The December language list |
| `look` | Colours and type | design tokens | Light, Dark, Midnight |
| `mode` | The main layout | a home screen plus an answer screen | Default (rings), Classic (chat), Playful |

### The manifest

```json
{
  "id": "org.example.blur-faces",
  "kind": "filter",
  "version": "1.2.0",
  "name": { "en": "Cover faces" },
  "permissions": [],
  "entry": "index.js",
  "publisher": "npub1...",
  "sig": "..."
}
```

- **Signed by its publisher** with a Nostr key. The app shows who published a plugin and refuses a package whose signature fails.
- **No network by default.** A plugin runs in a sandbox (a web worker or sandboxed frame, the same in the web app and the native shell) and can reach the network only if its manifest asks and the person agrees. A filter or cover never needs it, so one that asks is a warning sign.
- **Declares its kind**, and the app hands it only that kind's inputs. A filter sees the file being shared, never chats or the wallet.

### Safety

Plugins are also a way to attack the people this app serves. So:

- The default set is reviewed and pinned in each release.
- Adding a plugin is deliberate: scan a code or open a file, see the publisher and the permissions, confirm.
- "Reviewed only" is on by default and turns off only in settings, with a plain warning.
- A plugin can never read the wallet, the passphrase or other plugins' data.

## What changes in the code

1. Split `src/funding.ts` into one module per funding method behind a shared interface.
2. Add the plugin loader, manifest checks and sandbox to the web app, then the native shell.
3. Move filters, covers, guides and protection lists into plugins from the start, since none are built yet.
4. Move voice in and out behind `voice-in` and `voice-out` when flash-speech comes over from flash-mobile.
5. Publish the Bellows operator announcement and the guide package format as short written specs, so others can implement them without reading Forge's code.

## Open questions

- Which sandbox gives the same guarantees in the web app and the native shell.
- Whether guide packages reuse an existing format (for example a signed ZIM file) or need their own.
- Who reviews plugins for the default set, and how often.
