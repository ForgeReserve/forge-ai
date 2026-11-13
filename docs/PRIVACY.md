# Privacy

What the gateway can see depends on the tier and on whether the client encrypts.

## Never stored or logged, any tier

- Prompt and completion content. Logs and the `requests` table hold only request id, model, supplier, token counts, how usage was measured, cost, status and latency.
- Balance keys (only a SHA-256 is stored) and invite codes (same).
- P2PK lock keys (`X-Cashu-Pubkey`, `pubkey`) are not logged. They are public keys, stored with the request, payout or funding they lock (`requests.lock_pubkey`, `outgoing.lock_pubkey`, `fundings.f_lock_pubkey`) so a payout made after a crash is still locked, and returned to the payer as `locked_to`.

Streams are read in memory as they pass, to count tokens when the supplier does not report usage. Only counters are kept.

## Per tier

| | Standard (Token Factory) | Enclave, plaintext | Enclave, encrypted (EHBP) |
| - | - | - | - |
| `X-Forge-Privacy` header | `standard` | `enclave-plaintext` | `enclave-encrypted` |
| Gateway sees prompt and reply | Yes, in memory while relaying | Yes, in memory while relaying | No: bodies are HPKE ciphertext end to end |
| Supplier sees prompt and reply | Yes | Only inside an attested enclave | Only inside an attested enclave |
| Gateway sees | Model, sizes, usage, timing, client IP | Same | Model name, body size, max output tokens, frame count, timing, client IP, usage numbers reported by Tinfoil |
| How usage is measured | Upstream `usage` | Upstream `usage` | `X-Tinfoil-Usage-Metrics` response header (non-streaming) or HTTP trailer (streaming); else flat schedule |

Payment links: with a balance key, every request on that key is linkable to the others. A P2PK lock key is a stable identifier: reusing one key links the payouts locked to it, at the gateway and at the mint, which sees the key in the locked proofs when they are redeemed. Use a fresh key per payout (cashu.me warns when a key was used before) if that matters. With NUT-24, requests are not linked by the gateway, but the mint knows its own swaps. Client IPs reach the gateway (and Caddy); use Tor or a VPN to hide them.

## Funding

- Lightning and on-chain funding go through the Forge mint. The mint sees the quote, the invoice or address and when it is paid; the gateway's mint requests are not linked to the balance key on the mint's side. The gateway stores the quote id, invoice or address, and amounts with the balance id, never the key.
- On-chain status comes from the mint only, unless `FORGE_ESPLORA_URL` is set; then the gateway asks that Esplora server about the deposit address (point it at your own node to keep addresses private).
- eCash from another mint: the gateway contacts that mint from its own IP address to swap and melt the token. That mint learns the Forge invoice it paid. The change or refund token handed back is fresh eCash from that mint.

## Audio (speech to text, text to speech)

- `POST /v1/audio/transcriptions` and `POST /v1/audio/speech` are not encrypted end to end. The gateway receives the recording or the text in plain form, holds it in memory while it relays it to the supplier, and drops it when the request ends. It is never logged or stored: the log line and the `requests` row carry the model, seconds or characters, price and status.
- With an enclave supplier (Tinfoil) the sound and text are read by the model inside an attested enclave, so the supplier's staff cannot read them; the gateway operator could, while they pass. A Tinfoil supplier set to `allowPlaintext: false` refuses audio.
- In the v2 app, Private only sends voice only to an enclave audio model, and never uses the browser's own recogniser, which may send the voice to the browser's maker. The phone's own voices are used only when they run on the phone (`localService`).

## Encrypted pass-through (Tinfoil EHBP)

Tinfoil's Encrypted HTTP Body Protocol encrypts request and response bodies with HPKE to a key held inside an attested enclave, and leaves headers readable. Forge AI follows Tinfoil's proxy guide (docs.tinfoil.sh/guides/proxy-server):

- A request carrying `Ehbp-Encapsulated-Key` is treated as encrypted. The gateway never parses its body.
- It needs `X-Tinfoil-Model` to price and route. The enclave rejects a body whose model does not match that header.
- The gateway sets `X-Tinfoil-Max-Output-Tokens` (client value, capped per model) and `X-Tinfoil-Completion-Count: 1`; the enclave enforces both, so the worst-case price holds.
- It forwards the body byte for byte with `Content-Type`, `Accept` and `Ehbp-Encapsulated-Key`, replaces the client's credentials with the gateway's Tinfoil key, and adds `X-Tinfoil-Request-Usage-Metrics: true`.
- `X-Tinfoil-Enclave-Url` from the client is allowed only for `https` hosts under `tinfoil.sh` without credentials.
- The response is streamed back unchanged with `Ehbp-Response-Nonce`. Usage arrives as `X-Tinfoil-Usage-Metrics` (`prompt=..,completion=..`), as a header or as a trailer after a stream; the gateway settles on it.
- If the client disconnects, the gateway counts the EHBP frames it relayed (each length-prefixed frame is visible without decryption) as the output estimate.
- NUT-24 change cannot be put into an encrypted stream; it is at `GET /v1/change/{request_id}` (the `X-Forge-Change-Url` header).

Verified so far: the e2e suite runs these flows against a fake enclave (header and trailer usage, untouched bytes, allowlist). In a browser, the chat page loads Tinfoil's `tinfoil` SDK (1.4.0, from jsdelivr), which verified the live Tinfoil attestation and sent an EHBP request through the gateway's encrypted path. A full round trip against a real Tinfoil enclave needs a `TINFOIL_API_KEY` and has not been run.

## Chat page

The page at `/` is static files from the gateway's own origin (`public/`), with no build step and nothing loaded from another origin: no CDN, web fonts, analytics or remote images. Third-party libraries are vendored in `public/vendor/` with their licenses in `public/vendor/licenses/`, rebuilt by `scripts/vendor.sh` from versions pinned in `scripts/vendor/package-lock.json`.

What the browser stores, all of it local to that browser:

- **Chats** in IndexedDB (`forge-chat`): messages, attached images (downscaled and re-encoded, which drops EXIF data such as location), the text read from attached files (and any PDF pages sent as images), reasoning text, and per-message cost and token counts. They are never uploaded; a request carries only the messages of the chat being continued. Settings has "Delete all chats". If IndexedDB is unavailable (some private windows) chats live in page memory only.
- **Balance key and settings** in `localStorage` (`forge.balanceKey`, `forge.settings`: theme, default model, reasoning effort, system prompt, encrypt toggle, uncensored opt-in; `forge.lockPubkey`: the optional "Lock refunds to my wallet key" public key, sent with refunds and other-mint funding). If the gateway stops recognizing a stored key (a first funding that expired removes the empty balance), the page moves it to `forge.unrecognizedKey` rather than deleting it.
- **The public model list** in `localStorage` (`forge.models`, the last `GET /v1/models` answer), so model names and prices show when the app opens offline.
- **The app shell** in Cache Storage, kept by the service worker (`public/sw.js`): the page, its scripts and styles, icons, the manifest, the offline page, and vendored libraries once used. No chat content, keys, API responses or files are put there.

What the page sends:

- A default system prompt with every chat, editable or removable in Settings. It tells the model that "eCash" here means Cashu (Chaumian) eCash.
- `stream_options.include_usage` on every request, so the page can show token counts next to the cost.
- Model output is rendered as Markdown and sanitized with DOMPurify. Raw HTML in a reply is shown as text, links open with `noopener noreferrer`, and images in a reply become links, so a reply cannot make the browser fetch a third-party URL.

Encryption for enclave models:

- "Encrypt in browser" (on by default) uses Tinfoil's SDK (`tinfoil` 1.4.0, vendored as `public/vendor/tinfoil.js` and loaded only when an encrypted request is first sent). It verifies the enclave attestation in the browser, then encrypts each request to the enclave's key. The gateway origin proxies `/attestation` and `/.well-known/hpke-keys`, and over HTTPS the SDK fetches the attestation bundle through it. The bundle still contains Tinfoil's verification code paths, which can contact Tinfoil and Sigstore hosts during verification; which requests it makes behind this gateway has not been measured.
- Unchecking it sends plaintext to the gateway, labelled as such under the message box.

Camera scanning (eCash, Other mint, balance key) runs entirely in the browser with BarcodeDetector or jsQR; frames never leave the page.

### Attached files

Files are read on the device. The file itself is never uploaded: only its text, or for scanned PDF pages its page images, is sent, as part of the message.

- Text files (`.txt`, `.md`, `.csv`, `.json`, `.html`, code and similar) are decoded in the browser (UTF-8 first, then UTF-16 or Windows-1252); binary files are refused. PDFs are read with pdf.js (`pdfjs-dist` 6.5.438, vendored in `public/vendor/pdfjs/` and run in a worker from the gateway's own origin; PDF scripts and forms never run). Word `.docx` files are unzipped with the browser's built-in `DecompressionStream` and their `word/document.xml` turned into text; no library is involved.
- The text goes into the user message as a delimited block, `<file name="report.pdf" pages="12">...</file>`, before what was typed. At most 200,000 characters of file text go into one message; anything over that is cut, with a note saying so in the block. The page shows the estimated tokens and input cost before sending, and warns when the request is longer than the model's context.
- PDF pages without a text layer (scans) are listed as such. For vision models the page offers to send up to 4 of them as images, rendered on the device to JPEG at most 1280 px on the long side.
- The same tier rules as typed text apply: with "Encrypt in browser" on an enclave model, the file text is inside the HPKE-encrypted body and the gateway cannot read it; on a standard model or with encryption off, the gateway relays it in memory like any prompt. It is never logged or stored by the gateway (`test/e2e/files-privacy.e2e.test.ts` checks the logs and the database for it on both paths).
- The thread shows file chips (name, size, pages), not the text. The text is kept with the chat in IndexedDB, because every later message in that chat sends the conversation again, files included.

### Installed app and offline use

The page is an installable web app (`manifest.webmanifest`). A service worker (`/sw.js`) keeps the app shell so the app opens without a connection: the chat history, stored on the device, can be read offline, and sending waits for a connection. The service worker never caches or intercepts `/v1/*`, `/admin`, `/beta`, POST requests, or any request with an `Authorization` or `X-Cashu` header; those always go to the network.
