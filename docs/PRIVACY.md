# Privacy

What the gateway can see depends on the tier and on whether the client encrypts.

## Never stored or logged, any tier

- Prompt and completion content. Logs and the `requests` table hold only request id, model, supplier, token counts, how usage was measured, cost, status and latency.
- Balance keys (only a SHA-256 is stored) and invite codes (same).

Streams are read in memory as they pass, to count tokens when the supplier does not report usage. Only counters are kept.

## Per tier

| | Standard (Token Factory) | Enclave, plaintext | Enclave, encrypted (EHBP) |
| - | - | - | - |
| `X-Forge-Privacy` header | `standard` | `enclave-plaintext` | `enclave-encrypted` |
| Gateway sees prompt and reply | Yes, in memory while relaying | Yes, in memory while relaying | No: bodies are HPKE ciphertext end to end |
| Supplier sees prompt and reply | Yes | Only inside an attested enclave | Only inside an attested enclave |
| Gateway sees | Model, sizes, usage, timing, client IP | Same | Model name, body size, max output tokens, frame count, timing, client IP, usage numbers reported by Tinfoil |
| How usage is measured | Upstream `usage` | Upstream `usage` | `X-Tinfoil-Usage-Metrics` response header (non-streaming) or HTTP trailer (streaming); else flat schedule |

Payment links: with a balance key, every request on that key is linkable to the others. With NUT-24, requests are not linked by the gateway, but the mint knows its own swaps. Client IPs reach the gateway (and Caddy); use Tor or a VPN to hide them.

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

- The balance key is kept in `localStorage` (wrapped in try/catch). Nothing else is stored in the browser; conversations live in page memory only.
- For enclave models, "Encrypt in browser" (on by default) uses Tinfoil's SDK: it verifies the enclave attestation in the browser, then encrypts each request to the enclave's key. The gateway origin proxies `/attestation` and `/.well-known/hpke-keys`, and over HTTPS the SDK fetches the attestation bundle through it. The SDK is loaded from a CDN at a pinned version; self-hosting it (with subresource integrity) is a follow-up.
- Unchecking it sends plaintext to the gateway, labelled as such in the page.
