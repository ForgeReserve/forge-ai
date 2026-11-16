# Forge AI API

Forge AI is an AI gateway that speaks the OpenAI chat completions API and is paid with eCash (Cashu). Point any OpenAI client at it, send a balance key as the API key, and each request is paid from that balance. A request can also pay for itself with an eCash token in a header, with no account at all.

The hosted gateway is at `https://ai.forge-reserve.com`. Every API route is under `/v1`.

This page is generated from `docs/API.md` in the Forge AI repository by `scripts/build-docs.ts`. Everything on it is read from the gateway's code.

## Quickstart

Five steps from nothing to an answer. You need `curl` and an invite code. The hosted gateway opens new balances only with an invite code (`invite_only: true` in `GET /v1/models`); ask for one on the waitlist at [/beta/](/beta/).

### 1. List the models

```bash
curl -s https://ai.forge-reserve.com/v1/models
```

Each model has an `id`, a `tier` (`enclave` for private models, `standard` for the rest) and a `pricing` block. Models with `pricing.free: true` cost nothing on a balance key.

### 2. Open a balance

```bash
curl -s https://ai.forge-reserve.com/v1/wallet/open \
  -H 'Content-Type: application/json' \
  -d '{"invite": "inv-YOUR_INVITE_CODE"}'
```

```json
{
  "key": "sk-forge-YOUR_BALANCE_KEY",
  "account_id": "acct_...",
  "unit": "usd",
  "created": true,
  "balance_msub": 0,
  "free_models": ["glm-5.3-flash", "..."]
}
```

Keep the `key`. It is shown once and it is the only way to spend the balance. The gateway stores only a SHA-256 of it.

### 3. Ask a free model

```bash
export FORGE_KEY=sk-forge-YOUR_BALANCE_KEY

curl -s https://ai.forge-reserve.com/v1/chat/completions \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model": "glm-5.3-flash", "messages": [{"role": "user", "content": "Say hello in five words."}]}'
```

The answer is a normal OpenAI chat completion. The response headers say what it cost: `X-Forge-Charged-Msub: 0` on a free model.

### 4. Add funds

Ask for a Lightning invoice for 100 cents ($1.00). The amount goes onto the balance of the key you send.

```bash
curl -s https://ai.forge-reserve.com/v1/wallet/fund/lightning \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"amount": 100, "unit": "usd"}'
```

A balance has one unit for life, set when it is opened: `usd` unless you send `"unit": "sat"` to `/v1/wallet/open`. A funding in another unit is refused with `wrong_unit`, so fund a `usd` balance in `usd` and a `sat` balance in `sat`.

Pay the `request` field (a BOLT11 invoice) from any Lightning wallet, then poll the funding until its `state` is `done`:

```bash
curl -s https://ai.forge-reserve.com/v1/wallet/fund/fund_YOUR_FUNDING_ID \
  -H "Authorization: Bearer $FORGE_KEY"
```

If you already hold eCash from an accepted mint, add it in one call instead:

```bash
curl -s https://ai.forge-reserve.com/v1/wallet/topup \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"token": "cashuB..."}'
```

### 5. Ask a private model

```bash
curl -s https://ai.forge-reserve.com/v1/chat/completions \
  -H "Authorization: Bearer $FORGE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model": "tinfoil/gpt-oss-120b", "max_tokens": 500,
       "messages": [{"role": "user", "content": "What is eCash?"}]}'

curl -s https://ai.forge-reserve.com/v1/wallet -H "Authorization: Bearer $FORGE_KEY"
```

`X-Forge-Charged-Msub` and `X-Forge-Balance-Msub` on the answer say what was charged and what is left. `GET /v1/wallet` reads the balance at any time.

## OpenAI SDKs

The balance key is the API key. Set the base URL to the gateway's `/v1`. Nothing else changes.

### JavaScript

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://ai.forge-reserve.com/v1',
  apiKey: process.env.FORGE_KEY, // sk-forge-...
});

const completion = await client.chat.completions.create({
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: 'Write a haiku about eCash.' }],
});
console.log(completion.choices[0].message.content);

// Streaming works the same way.
const stream = await client.chat.completions.create({
  model: 'tinfoil/gpt-oss-120b',
  max_tokens: 400,
  stream: true,
  messages: [{ role: 'user', content: 'Explain blind signatures in two sentences.' }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');

// The cost is in the response headers.
const { data, response } = await client.chat.completions
  .create({ model: 'tinfoil/gpt-oss-120b', max_tokens: 200, messages: [{ role: 'user', content: 'Hi' }] })
  .withResponse();
console.log(data.choices[0].message.content);
console.log('charged msub', response.headers.get('x-forge-charged-msub'));
console.log('balance msub', response.headers.get('x-forge-balance-msub'));
```

### Python

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://ai.forge-reserve.com/v1",
    api_key=os.environ["FORGE_KEY"],  # sk-forge-...
)

completion = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "Write a haiku about eCash."}],
)
print(completion.choices[0].message.content)

stream = client.chat.completions.create(
    model="tinfoil/gpt-oss-120b",
    max_tokens=400,
    stream=True,
    messages=[{"role": "user", "content": "Explain blind signatures in two sentences."}],
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")

# The cost is in the response headers.
raw = client.chat.completions.with_raw_response.create(
    model="tinfoil/gpt-oss-120b",
    max_tokens=200,
    messages=[{"role": "user", "content": "Hi"}],
)
print(raw.parse().choices[0].message.content)
print("charged msub", raw.headers.get("x-forge-charged-msub"))
```

A stream ends with `data: [DONE]` and then one more event from the gateway, `event: forge` (see [Streaming](#streaming)). Both SDKs stop reading at `[DONE]` (checked in `openai` 7.57.0 for JavaScript, `core/streaming.js`, and `openai` 2.48.0 for Python, `_streaming.py`), so the extra event never reaches your code. Read the stream yourself if you want it.

## Basics

### Base URL and format

- Base URL: `https://ai.forge-reserve.com/v1`.
- Request and response bodies are JSON, except speech to text (multipart form upload) and text to speech (WAV audio back).
- Times such as `expires_at`, `created_at`, `next_at` and `resets_at` are milliseconds since 1970 (UTC).

### Balance keys

A balance key looks like `sk-forge-` followed by 24 to 64 URL-safe characters. Send it as `Authorization: Bearer sk-forge-...`.

- The gateway makes one for you when it opens a balance and returns it once, in `key`.
- You may choose your own instead: send a new key of that shape as the bearer when you open or fund a balance. A lost response then never loses the key.
- The gateway stores only a SHA-256 of each key. A lost key cannot be recovered, and neither can the funds on it.
- Every request made with one key can be linked to the others by the gateway. Paying per request with eCash (below) avoids that link.

### Units and amounts

A balance is in `usd` (amounts in cents) or `sat`. Fields that end in `_msub` count thousandths of the unit: milli-cents for `usd`, millisatoshi for `sat`.

- `balance_msub: 125000` on a `usd` balance is 125 cents, $1.25.
- `amount` fields on funding, refunds and tokens are whole units (cents or sat).
- A request that costs 0.164 cents takes 164 msub. Sub-unit amounts stay on the balance and add up.

Sat prices use the gateway's BTC/USD rate (`btc_usd` in `GET /v1/models`). When the gateway has no fresh rate, sat requests answer `503 rate_unavailable` and usd requests keep working.

### Invite codes

While a gateway is invite-only, opening a new balance needs an invite code (`inv-...`), and paying per request with eCash needs one in `X-Forge-Invite` on each request.

- Opening a balance redeems the invite and binds it to that balance. One invite opens one balance. A used one answers `403 invite_used`.
- When a top-up or funding opens a balance and that first funding fails or expires before anything is credited, the empty balance is removed and its invite opens again.
- `POST /v1/wallet/open` always needs an invite, even on a gateway that is not invite-only, because it opens a balance for the free models.

### Event passes

An event pass (`pass-...`) is one code for a room full of people. It works only at `POST /v1/wallet/open`, where each use opens one balance at 0 for the free models. A pass has a number of uses and an expiry: past either, it answers `403 pass_used_up` or `403 pass_expired`. It never stands in for an invite on a funded top-up or a per-request payment. A balance opened with a pass takes funds later like any other.

The event link `https://ai.forge-reserve.com/j#pass-...` opens Forge's join page with the pass filled in. The pass stays in the URL fragment, so it never reaches the server's logs.

## Paying

There are three ways to pay for a request.

| Way | What you send | Best for |
| - | - | - |
| Balance key | `Authorization: Bearer sk-forge-...` | Apps and scripts that make many requests |
| Per request (NUT-24) | `X-Cashu: cashuB...` on each request | Agents that hold eCash and want no account |
| Free model | A balance key, even at 0 | Trying the API, events, free tiers in your own app |

### Holds and charges

Before a request is sent on, the gateway holds the most it can cost. When the answer is done, it charges what was used and releases the rest. No request is ever charged more than its hold.

The hold of a metered model, in nano-USD (billionths of a dollar), using the figures under `pricing.hold` in `GET /v1/models`:

```text
input_tokens  = ceil(request body bytes / bytes_per_token)
hold_nano_usd = input_tokens * input_nano_usd_per_token
              + max_tokens   * output_nano_usd_per_token
```

- `max_tokens` is the `max_completion_tokens` or `max_tokens` you send. Leave both out and the model's `max_output_tokens` is used for the hold and sent upstream. **Set `max_tokens` to keep the hold small.**
- The request body is the whole JSON you send, in bytes.
- With web search on (below), the hold also adds the search fee `web_search.nano_usd`, `web_search.extra_input_tokens` more input, and output multiplied by `web_search.output_factor`.
- A supplier with `basis: "flat"` holds a flat schedule instead: the `nano_usd` of the first bucket whose `max_bytes` covers the body (else the last bucket), plus `max_tokens * output_nano_usd_per_token`.
- A free model holds 0.

Converted to msub, rounded up: `usd` is `ceil(nano_usd / 10000)`, `sat` is `ceil(nano_usd * 100 / btc_usd)`. The smallest hold on a paid model is 1 msub.

An example from the listing on 16 November 2026: `tinfoil/gpt-oss-120b` had `bytes_per_token: 2`, `input_nano_usd_per_token: 188` and `output_nano_usd_per_token: 750`. A 400-byte request with `max_tokens: 1000` holds `200 * 188 + 1000 * 750 = 787600` nano-USD, which is 79 msub on a usd balance (0.079 cents). Prices change: always read them from `GET /v1/models`.

What is charged:

- The tokens the supplier reports, at the model's prices, plus the search fee when the model searched. Capped at the hold.
- No usage reported on a plaintext stream: the gateway counts the answer as it passes and charges that estimate, capped at the hold.
- No usage reported on a complete non-streaming or encrypted answer: the hold.
- A flat-priced supplier: its schedule.
- An upstream failure: nothing. The hold is released, and a per-request payment comes back in full as change.
- You disconnect mid-stream: the gateway stops the upstream call and charges what was produced so far.

On a balance, `available_msub` (the balance less holds still open) must cover the hold, or the request is refused with `402 insufficient_balance`. Holds settle exactly once.

### Pay per request (NUT-24)

A client with eCash can pay each request on its own, with no balance key ([NUT-24](https://github.com/cashubtc/nuts/blob/main/24.md)).

1. Send the request with no `Authorization` and no `X-Cashu` (and `X-Forge-Invite` while invite-only). The gateway answers `402 payment_required`:

```http
HTTP/1.1 402 Payment Required
X-Cashu: creqA...
X-Forge-Request-Id: req_0123456789abcdef0123456789abcdef

{"error": {"message": "pay 2 usd in eCash: retry with X-Cashu: cashuB... Unused value is returned as change.",
           "type": "payment_required", "code": "payment_required"},
 "payment_request": "creqA...", "amount": 2, "unit": "usd", "mints": ["https://..."]}
```

   `X-Cashu` is a NUT-18 payment request: the amount (the hold, rounded up to whole units), the unit, the accepted mints and the request id. Ask for a sat quote with `X-Forge-Unit: sat`. Sat quotes carry a small buffer for rate moves.

2. Send the same request again with `X-Cashu: cashuB...` (a token worth at least `amount`, from one of `mints`, in that unit) and `X-Forge-Request-Id` set to the id from the 402. Each id can be used for one paid attempt. Reusing one answers `409 request_id_used` before the token is touched.

3. The gateway swaps the token, runs the request, charges whole units (the cost rounded up, capped at what you paid) and returns the rest as change:
   - non-streaming: in the `X-Cashu-Change` header;
   - streaming: in the final `event: forge` (`change`);
   - always: at `GET /v1/change/{request_id}`, so change is never lost with a dropped response.

Add `X-Cashu-Pubkey` to lock the change to your own key (see [Lock payouts to your key](#lock-payouts-to-your-key)). Free models never take eCash: they need a balance key, and a token sent with them is left untouched.

### Open a balance

- `POST /v1/wallet/open` with an invite code or event pass opens a balance at 0. It can use the free models at once and take funds later.
- `POST /v1/wallet/topup` with a token, and the funding routes, open a balance on first use too (with an invite while invite-only).
- Send an existing key as the bearer to add to that balance instead.

### Top up with eCash

`POST /v1/wallet/topup` with a `cashuB` token from one of the accepted mints (`mints` in `GET /v1/models`, and `ecash.mints` in `GET /v1/wallet/fund/methods`). The token's unit must match the balance. Sending the same token again to the same key is safe: it answers `replay: true` and credits nothing more.

If the mint does not answer while a new balance is being opened, the answer is `503 topup_pending` with the new `key`. Retry with that key and the same token to finish.

### Lightning

`POST /v1/wallet/fund/lightning` returns a BOLT11 invoice from the Forge mint in `request`. Pay it from any Lightning wallet. The funding goes `pending`, then `minting`, then `done`, and the balance is credited exactly the invoice amount. Unpaid past its expiry, it ends `expired`. `lightning.min` and `lightning.max` in `GET /v1/wallet/fund/methods` give the limits per unit.

### On-chain

`POST /v1/wallet/fund/onchain` returns a bitcoin address in `request` (sat balances only). Each deposit the mint counts as paid is minted and credited, and the address stays watched for a while, so later deposits are credited too. `onchain.min_amount` and `onchain.confirmations` in `GET /v1/wallet/fund/methods` say what to expect.

### eCash from another mint

A token from another Cashu mint can still fund a balance. The gateway melts it at that mint to pay a Lightning invoice from the Forge mint, then credits what the Forge mint issues.

1. `POST /v1/wallet/fund/foreign/quote` with the token. Nothing is spent. The answer shows `foreign.credit` (what the balance gets) and `foreign.fee_max` (the most the token's mint can keep in fees).
2. `POST /v1/wallet/fund/foreign/confirm` with the funding `id` and the same token. The gateway receives it, melts it into the Forge invoice, then credits the balance. Unused fee reserve comes back as `foreign.change_token`. If the melt cannot go through, the token's value comes back as `foreign.refund_token` and the funding ends `refunded`.

Which mints are accepted is listed at `GET /v1/wallet/fund/mints`. A mint off that list answers `409 mint_unlisted` with its lower cap; send the quote again with `"accept_unlisted": true` to go ahead at your own risk. A token from one of the gateway's own mints answers `use_topup`: add it with `POST /v1/wallet/topup`.

### Read a balance

`GET /v1/wallet` returns the balance, the part not held by running requests (`available_msub`), and what can be taken out (`refundable`, whole units). Every paid response also carries `X-Forge-Balance-Msub`.

### Take funds out

`POST /v1/wallet/refund` turns whole units of the balance into a fresh eCash token from the gateway's mint. Leave out `amount` to take everything refundable. Redeem the token in any Cashu wallet. `GET /v1/wallet/refunds` lists every token issued to the key, so a token is never lost with a dropped response. If the token cannot be made at once, the answer is `202` with `status: "owed"`. The amount has left the balance and stays owed to the key: each later `POST /v1/wallet/refund` first tries again to issue what is owed.

### Lock payouts to your key

Every token the gateway hands back (change, refunds, other-mint change and refunds) is ordinary eCash until you redeem it. Give a public key and the token is locked to it ([NUT-11](https://github.com/cashubtc/nuts/blob/main/11.md) P2PK): only the holder of the private key can redeem it, and the gateway cannot spend it.

- Per-request change: the `X-Cashu-Pubkey` header. Refunds: `"pubkey"` in the body. Other-mint funding: `"pubkey"` at quote or confirm.
- Accepted: a 33-byte compressed key in hex (`02...` or `03...`), an `npub1...`, or a 64-hex x-only key. Anything else answers `400 invalid_pubkey` before any eCash moves.
- A token locked to a key you do not hold is lost for good.

### Web search

Private models with `capabilities.web_search: true` can search the web from their enclave. Add `web_search_options` (an object) to a plaintext chat body to turn it on; an encrypted request sends `X-Forge-Web-Search: 1`. The hold adds the search fee and allowance listed under `pricing.hold.web_search`, and the fee is charged only when the model searched. A model that cannot search answers `400 web_search_unavailable`.

## Free access

### Free models

A model with `pricing.free: true` costs nothing. `pricing.free_reason` says why. On the hosted gateway these are the Token Factory models, free during Token Factory's beta.

- They need a balance key, even one at 0. Open one with an invite code or event pass at `POST /v1/wallet/open`. This is what the Forge app calls Start free.
- Nothing is held or charged, in either unit, and no BTC/USD rate is needed. The response carries `X-Forge-Charged-Msub: 0`.
- Without a key the answer is `401 balance_key_required`, with no 402 and no payment request. eCash is never taken for a free model.
- The free models are standard models: their provider sees the prompt and the answer.

`GET /v1/wallet/fund/methods` lists them under `open.free_models`, and `POST /v1/wallet/open` returns the same list.

### Free voice questions

When the operator turns them on, speech to text works on a balance that cannot pay for it, a few times a day per balance, within a daily budget the operator pays. `free_voice` in `GET /v1/wallet/fund/methods` and in `GET /v1/wallet` says whether they are on and how many are left today. Used up, a transcription answers `402 free_voice_limit` with `Retry-After` (seconds to midnight UTC). Text to speech is never free.

### Free questions (credits)

A gateway can also hand out free questions as credits: eCash from a separate credit mint, worth one question each and worth nothing outside the gateway. A balance funded with credits is a free balance (`free: true`): it pays one credit per answered question, only on the models in `free.models` of `GET /v1/models`, within `free.max_input_tokens` and `free.max_output_tokens`. Credits never mix with money: they go on a free balance of their own, and a free balance is taken out only as credits.

The daily faucet gives out credit vouchers to anyone who solves a short proof-of-work puzzle (see [`GET /v1/free`](#get-v1-free)). `free` in `GET /v1/models` is `null` and `free.enabled` in `GET /v1/wallet/fund/methods` is `false` while this is off, as it is on the hosted gateway today.

## Private and standard models

Each model has a `tier`. The `X-Forge-Privacy` response header says how a request was handled.

| | Standard | Private, plaintext | Private, encrypted |
| - | - | - | - |
| `tier` | `standard` | `enclave` | `enclave` |
| `X-Forge-Privacy` | `standard` | `enclave-plaintext` | `enclave-encrypted` |
| Gateway sees the prompt | In memory while relaying | In memory while relaying | No |
| Supplier sees the prompt | Yes | Only inside an attested enclave | Only inside an attested enclave |

Private models run at Tinfoil inside attested secure enclaves. The gateway never logs or stores prompts or answers on any tier. It keeps the model, token counts, cost, status and timing.

### Encrypted requests

A model with `encrypted_passthrough: true` takes requests encrypted end to end to the enclave (Tinfoil's EHBP: the body is HPKE ciphertext, the headers stay readable). The gateway forwards the bytes without being able to read them. It serves the enclave's attestation at `/attestation` and its key config at `/.well-known/hpke-keys`, so a client can verify the enclave and encrypt through the gateway's origin.

An encrypted request must send:

| Header | Value |
| - | - |
| `Ehbp-Encapsulated-Key` | Set by the encrypting client. Marks the request as encrypted |
| `X-Tinfoil-Model` | The model's `upstream_model` (or its `id`). Required: the gateway cannot read the body |
| `X-Tinfoil-Max-Output-Tokens` | Optional. Capped at the model's `max_output_tokens`; it sets the hold |
| `X-Forge-Web-Search` | `1` if the encrypted body turns on web search |

The Forge web app does it with Tinfoil's SDK (`tinfoil` 1.4.0), which verifies the attestation and encrypts each body:

```javascript
import { SecureClient } from 'tinfoil';

const client = new SecureClient({
  baseURL: 'https://ai.forge-reserve.com/v1/',
  attestationBundleURL: 'https://ai.forge-reserve.com',
});
await client.ready();

const res = await client.fetch('chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${FORGE_KEY}`,
    'X-Tinfoil-Model': 'gpt-oss-120b',
    'X-Tinfoil-Max-Output-Tokens': '500',
  },
  body: JSON.stringify({ model: 'gpt-oss-120b', max_tokens: 500, messages: [{ role: 'user', content: 'Hi' }] }),
});
```

A per-request payment cannot put change into an encrypted stream: fetch it from `X-Forge-Change-Url` (`/v1/change/{request_id}`). A private model sent in plaintext is served as `enclave-plaintext`, unless the operator requires encryption for it, which answers `400 encryption_required`.

## Models

### `GET /v1/models`

The model list, in OpenAI's shape with extra fields. No key needed.

```json
{
  "object": "list",
  "data": [
    {
      "id": "tinfoil/gpt-oss-120b",
      "object": "model",
      "created": 0,
      "owned_by": "tinfoil",
      "name": "gpt-oss-120b",
      "tier": "enclave",
      "privacy": "enclave",
      "encrypted_passthrough": true,
      "uncensored": false,
      "capabilities": { "vision": false, "reasoning": true, "reasoning_efforts": ["low", "medium", "high"], "web_search": true },
      "speed": "fast",
      "context_length": 131072,
      "max_output_tokens": 8192,
      "pricing": {
        "free": false,
        "mode": "metered",
        "usd_per_mtok": { "input": 0.1875, "output": 0.75 },
        "sat_per_mtok": { "input": 288.4255, "output": 1153.702 },
        "verified": true,
        "hold": {
          "basis": "metered",
          "bytes_per_token": 2,
          "input_nano_usd_per_token": 188,
          "output_nano_usd_per_token": 750,
          "web_search": { "nano_usd": 62500000, "extra_input_tokens": 16000, "output_factor": 2 }
        }
      },
      "upstream_model": "gpt-oss-120b"
    }
  ],
  "audio": [ { "id": "tinfoil/whisper-large-v3-turbo", "kind": "transcription", "...": "..." } ],
  "units": ["usd", "sat"],
  "mints": ["https://..."],
  "mint_aliases": ["https://..."],
  "invite_only": true,
  "btc_usd": 65008.12,
  "free": null
}
```

| Field | Meaning |
| - | - |
| `data[].tier`, `privacy` | `enclave` (private) or `standard` |
| `data[].encrypted_passthrough` | The model takes encrypted requests |
| `data[].uncensored` | Tuned to refuse less |
| `data[].capabilities` | `vision`, `reasoning`, `reasoning_efforts`, `web_search` |
| `data[].max_output_tokens` | The most `max_tokens` can be |
| `data[].pricing.free`, `free_reason` | A free model, and why (`free_reason` only on free models) |
| `data[].pricing.mode` | `metered` or `flat` |
| `data[].pricing.usd_per_mtok`, `sat_per_mtok` | Price per million tokens, input and output, markup included. `sat_per_mtok` is `null` without a rate |
| `data[].pricing.hold` | The figures the hold is computed from (see [Holds and charges](#holds-and-charges)) |
| `data[].upstream_model` | The enclave's own name for the model (private models only) |
| `audio` | Speech to text and text to speech models, listed apart from chat |
| `units` | Units the gateway takes |
| `mints` | Mints whose eCash is accepted for top-ups and per-request payment |
| `mint_aliases` | Other addresses of the same mints |
| `invite_only` | New balances and per-request payments need an invite |
| `btc_usd` | The BTC/USD rate used for sat prices, or `null` |
| `free` | The free questions (credits) rules, or `null` while they are off |

Each `audio` entry has `id`, `kind` (`transcription` or `speech`), `name`, `tier`, `max_seconds` (transcription) or `max_chars` (speech), `formats`, `voices` (speech), `languages`, and `pricing.usd` and `pricing.sat` with `request`, `second` and `kchar` (per 1,000 characters), markup included.

## Chat

### `POST /v1/chat/completions`

OpenAI chat completions, streaming and non-streaming. Fields such as `tools`, `tool_choice`, `temperature` and `reasoning_effort` pass through to the model untouched.

| Body field | Rule |
| - | - |
| `model` | Required. An `id` from `GET /v1/models` |
| `messages` | Required. An array |
| `max_tokens` or `max_completion_tokens` | 1 to the model's `max_output_tokens`. Left out, the model's maximum is used |
| `stream` | `true` for server-sent events |
| `stream_options.include_usage` | Ask for the usage chunk. Without it the gateway still meters, and removes the usage chunk from your stream |
| `n` | Must be 1 if sent |
| `web_search_options` | Turns on web search (models with `capabilities.web_search`) |

Request headers:

| Header | Use |
| - | - |
| `Authorization: Bearer sk-forge-...` | Pay from a balance |
| `X-Cashu: cashuB...` | Pay this request with eCash (NUT-24) |
| `X-Forge-Request-Id: req_...` | With `X-Cashu`: the id from the 402 |
| `X-Forge-Invite: inv-...` | With per-request payment, while invite-only |
| `X-Forge-Unit: usd` or `sat` | Unit of the 402 quote when paying per request |
| `X-Cashu-Pubkey` | Lock per-request change to this key |
| `X-Forge-Web-Search: 1` | An encrypted body turns on web search |
| `Ehbp-Encapsulated-Key`, `X-Tinfoil-*` | Encrypted requests (see [Encrypted requests](#encrypted-requests)) |

Response headers:

| Header | Meaning |
| - | - |
| `X-Forge-Request-Id` | This request's id |
| `X-Forge-Unit` | The unit it was paid in |
| `X-Forge-Privacy` | `standard`, `enclave-plaintext` or `enclave-encrypted` |
| `X-Forge-Charged-Msub` | What was charged (non-streaming) |
| `X-Forge-Balance-Msub` | The balance after it (balance payments, non-streaming) |
| `X-Cashu-Change` | Per-request change token (non-streaming) |
| `X-Forge-Change-Url` | Where per-request change can always be fetched |

#### Streaming

A stream is the model's own server-sent events, then `data: [DONE]`, then one event from the gateway with the settlement:

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: [DONE]

event: forge
data: {"request_id":"req_...","unit":"usd","charged_msub":1280,"balance_msub":4998720}
```

The `forge` event carries `request_id`, `unit`, `charged_msub`, and `balance_msub` (balance) or `change`, `change_units` and `change_url` (per request). If the upstream stream fails midway, the gateway sends `data: {"error": {...}}`, then the `forge` event with `partial: true`, and charges only what was produced. Stream headers are sent before the answer is done, so they carry no charge: read it from the `forge` event.

#### Chat errors

`400 invalid_request` (bad JSON, missing `model` or `messages`, `n` other than 1, `max_tokens` out of range, a malformed `X-Forge-Request-Id`), `404 model_not_found`, `401 invalid_key`, `401 balance_key_required` (free model without a key), `402 payment_required`, `402 insufficient_balance`, `403 invite_required`, `403 account_frozen`, `409 request_id_used`, `400 web_search_unavailable`, `400 encryption_required`, `503 rate_unavailable`, the token errors under [Errors](#errors), and `upstream_error` when the model fails (nothing is charged).

## Audio

Speech to text and text to speech, OpenAI-compatible, paid from a balance key only. The price of the request is held first, charged when the model answers and released when it fails. Responses carry the same `X-Forge-*` headers as chat. Audio and text are held in memory for the request only, never logged or stored. They are not encrypted end to end: the gateway relays them in plain form.

### `POST /v1/audio/transcriptions`

Multipart form upload.

| Field | Rule |
| - | - |
| `file` | Required. WAV audio. Billed by the length its header gives. MP3 is refused |
| `model` | Required. A `transcription` model from `audio` in `GET /v1/models` |
| `language` | Optional. An ISO 639-1 code such as `en` |
| `response_format` | Optional. Only `json` |

```bash
curl -s https://ai.forge-reserve.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $FORGE_KEY" \
  -F model=tinfoil/whisper-large-v3-turbo -F language=en -F file=@question.wav
```

```json
{ "text": "What is eCash?", "usage": { "type": "duration", "seconds": 2.4 } }
```

Errors: `415 unsupported_audio` (not WAV), `413 audio_too_long` (over the model's `max_seconds`), `400 audio_too_short` (under 0.3 seconds), `413 request_too_large` (over the upload limit, 4,000,000 bytes by default), `402 insufficient_balance`, `402 free_voice_limit`, `403 account_frozen`, `403 not_free_model` (a free-question balance), `404 model_not_found`.

### `POST /v1/audio/speech`

JSON body: `model` (a `speech` model), `input` (the text, at most the model's `max_chars`), `voice` (one of the model's `voices`; the first is used if left out), `response_format` (only `wav`). The answer is the audio itself.

```bash
curl -s https://ai.forge-reserve.com/v1/audio/speech \
  -H "Authorization: Bearer $FORGE_KEY" -H 'Content-Type: application/json' \
  -d '{"model": "tinfoil/voxtral-tts", "input": "Hello from Forge.", "voice": "neutral_female"}' \
  -o hello.wav
```

Errors: `400 invalid_request` (no `input`, unknown `voice`), `413 text_too_long`, `402 insufficient_balance`, `403 account_frozen`, `403 not_free_model`, `404 model_not_found`.

## Wallet

### `POST /v1/wallet/open`

Opens a balance at 0 that can use the free models now and take funds later.

| Body field | Rule |
| - | - |
| `invite` | An invite code or event pass. Also accepted as the `X-Forge-Invite` header |
| `unit` | `usd` (default) or `sat` |

Send an existing balance key as the bearer and it is answered as it is (`created: false`), with no invite used. Send a new key of the right shape to choose your own.

```json
{ "key": "sk-forge-...", "account_id": "acct_...", "unit": "usd", "created": true, "balance_msub": 0, "free_models": ["..."] }
```

`key` is present only when the gateway made it. Errors: `403 invite_required`, `403 invite_used`, `403 invite_invalid`, `403 pass_expired`, `403 pass_used_up`, `409 wrong_balance` (a free-question balance key), `400 wrong_unit`, `401 invalid_key` (a bearer that is neither a known key nor the shape of one).

### `POST /v1/wallet/topup`

Adds an eCash token to a balance, or opens one with it.

| Body field | Rule |
| - | - |
| `token` | Required. A `cashuB` token from an accepted mint |
| `invite` | For a new balance while invite-only. Also accepted as `X-Forge-Invite` |

Bearer: an existing key to top up, a new key of the right shape to choose your own, or none to have one made.

```json
{ "key": "sk-forge-...", "account_id": "acct_...", "unit": "usd", "free": false, "credited": 500,
  "replay": false, "balance_msub": 500000, "balance": 500 }
```

`credited` is in whole units, after the mint's input fees. Errors: the token errors, `409 wrong_balance`, `400 wrong_unit` (the balance has another unit), `403 invite_required`, `503 topup_pending` (retry with the returned `key` and the same token).

### `GET /v1/wallet`

Bearer key required.

```json
{
  "account_id": "acct_...",
  "unit": "usd",
  "free": false,
  "balance_msub": 125000,
  "available_msub": 120000,
  "balance": 125,
  "refundable": 120,
  "free_voice": { "enabled": true, "per_day": 20, "left": 20, "resets_at": 1794873600000 }
}
```

`available_msub` is the balance less holds of requests still running. `refundable` is what `POST /v1/wallet/refund` can take out now, in whole units. `free_voice.reason` is `allowance` or `budget` when none are left.

### `POST /v1/wallet/refund`

Bearer key required. Optional body:

| Body field | Rule |
| - | - |
| `amount` | Whole units, 1 to `refundable`. Left out, everything refundable |
| `pubkey` | Lock the token to this key |

```json
{ "id": "...", "token": "cashuB...", "amount": 120, "unit": "usd", "free": false, "status": "done",
  "locked_to": null, "balance_msub": 5000, "refunds": [ { "id": "...", "amount": 120, "unit": "usd",
  "status": "done", "token": "cashuB...", "locked_to": null } ] }
```

`200` with `status: "done"` and the token, or `202` with `status: "owed"` and `token: null` when the token could not be made at once (it stays owed and is delivered later). Errors: `400 invalid_amount`, `400 invalid_pubkey`, `503 wallet_insufficient`.

### `GET /v1/wallet/refunds`

Bearer key required. Every token issued to this key, so none is lost: `{"data": [{id, amount, unit, status, token, locked_to}]}`.

## Funding

Every funding route returns a funding object. The routes that create a funding also open a balance on first use: send `invite` in the body for a new balance while invite-only (these routes read the invite from the body only), and the answer carries `key` once when the gateway made it.

```json
{
  "id": "fund_...",
  "method": "lightning",
  "state": "pending",
  "unit": "sat",
  "amount": 1000,
  "request": "lnbc...",
  "expires_at": 1794863600000,
  "credited": 0,
  "balance_msub": 0,
  "account_id": "acct_...",
  "mint": "https://...",
  "created_at": 1794860000000
}
```

| Field | Meaning |
| - | - |
| `method` | `lightning`, `onchain` or `foreign` |
| `state` | `quoted`, `receiving`, `melting`, `pending`, `minting`, then `done`, `expired`, `failed` or `refunded` |
| `request` | The invoice (Lightning) or address (on-chain) |
| `credited` | Whole units credited so far |
| `onchain` | On-chain only: `confirmations_required`, `paid_sat`, `seen_sat`, `confirmed_sat`, `confirmations`, `watch_until` |
| `foreign` | Other-mint only: `mint`, `unlisted`, `unit`, `token_amount`, `credit`, `fee_max`, `change_token`, `refund_token`, `locked_to`, `payout_pending` |
| `error` | The last error while it was moving forward, if any |

A balance can have a few unfinished fundings at once (5 by default); past that the answer is `429 too_many_pending`.

### `GET /v1/wallet/fund/methods`

What this gateway can take now. No key needed.

```json
{
  "ecash": { "mints": ["https://..."], "units": ["usd", "sat"] },
  "lightning": { "enabled": true, "units": ["sat", "usd"], "min": { "sat": 1, "usd": 1 }, "max": { "sat": 50000, "usd": 2000 } },
  "onchain": { "enabled": true, "unit": "sat", "min_amount": 10000, "confirmations": 3 },
  "foreign": {
    "enabled": true,
    "max": { "sat": 20000, "usd": 1000 },
    "policy": "discovered",
    "mints": ["https://..."],
    "mints_url": "/v1/wallet/fund/mints",
    "unlisted": { "enabled": true, "max": { "sat": 5000, "usd": 500 } }
  },
  "invite_only": true,
  "free_voice": { "enabled": true, "per_day": 20 },
  "free": { "enabled": false, "questions": null },
  "open": { "enabled": true, "free_models": ["..."] }
}
```

The figures above were read from the hosted gateway on 16 November 2026. `usd` limits are in cents.

### `GET /v1/wallet/fund/mints`

Other mints whose eCash is accepted for funding: `{"enabled", "policy", "mints": [{"url", "name"?, "reviewers"?, "source": "discovered" | "operator"}], "updated_at"}`. Discovered mints come from NIP-87 announcements and reviews on Nostr. No key needed.

### `POST /v1/wallet/fund/lightning`

Body: `amount` (whole units, within `lightning.min` and `lightning.max`), `unit`, `invite` (new balance). Returns a funding with the invoice in `request`. Errors: `400 invalid_amount`, `400 method_unavailable`, `400 wrong_unit`, `429 too_many_pending`, `503 mint_unavailable`.

### `POST /v1/wallet/fund/onchain`

Body: `invite` (new balance), or nothing. Sat balances only: a `usd` key answers `400 wrong_unit`. Returns a funding with the address in `request` and its progress in `onchain`. Errors: `400 method_unavailable`, `429 too_many_pending`, `503 mint_unavailable`.

### `POST /v1/wallet/fund/foreign/quote`

| Body field | Rule |
| - | - |
| `token` | Required. A `cashuB` token from another mint |
| `unit` | The balance unit. May differ from the token's |
| `accept_unlisted` | `true` to use a mint off the accepted list, at the lower cap |
| `pubkey` | Lock the change or refund to this key |
| `invite` | For a new balance |

Returns a funding in state `quoted`. Nothing is spent until confirm. Errors: `400 use_topup` (the token is from one of the gateway's own mints), `400 mint_not_allowed`, `409 mint_unlisted` (with `unlisted: {mint, max}`), `400 mint_check_failed`, `400 amount_too_large`, `400 insufficient_amount`, `400 foreign_mint_error`, `400 credits_not_money`, `400 method_unavailable`.

### `POST /v1/wallet/fund/foreign/confirm`

Bearer key required. Body: `id` (from the quote), `token` (the same token), optional `pubkey`. Returns the funding as it moves on; poll it until `done` or `refunded`. Errors: `400 token_mismatch`, `409 quote_expired`, `409 in_flight`, `404 not_found`.

### `GET /v1/wallet/fund`

Bearer key required. The 20 most recent fundings of this balance: `{"data": [funding, ...]}`.

### `GET /v1/wallet/fund/{id}`

Bearer key required. One funding. Polling it also moves it forward, so a funding finishes even if you only poll. `404 not_found` for a funding of another balance.

## Change

### `GET /v1/change/{request_id}`

The change of a per-request (NUT-24) payment. No key: the request id is known only to the payer.

```json
{ "request_id": "req_...", "token": "cashuB...", "data": [ { "id": "...", "amount": 3, "unit": "usd", "status": "done", "token": "cashuB...", "locked_to": null } ] }
```

`409 not_settled` with `Retry-After` while the request is still running or the mint has not answered yet. `404 not_found` when there is no change for that id.

## Free questions

These routes run the daily faucet. While it is off they answer `404 not_found`. A claim gives a voucher of credits, which `POST /v1/wallet/topup` adds to a free balance.

### `GET /v1/free`

```json
{ "enabled": true, "questions": 3, "vouchers_left_today": 412, "questions_left_today": 1236,
  "available_now": 17, "next_at": 1794863600000, "bits": 22 }
```

### `POST /v1/free/challenge`

Body: none needed. Returns `{challenge, bits, expires_at}`. Errors: `429 faucet_empty` (with `next_at` and `retry_after`), `429 faucet_limit` (this address has had its share today).

### `POST /v1/free/verify`

Body: `{"solution": "<challenge>:<nonce>"}`, where the SHA-256 of that whole string starts with `bits` zero bits and the nonce is 1 to 64 characters of `0-9a-z`. Returns `{ticket, expires_at}`. Errors: `400 pow_invalid`, `400 challenge_unknown`, `409 challenge_used`, `410 challenge_expired`.

### `POST /v1/free/claim`

Body: `{"ticket": "..."}`. Returns `{token, questions, mint, unit}`. Errors: `400 ticket_unknown`, `409 claim_used`, `429 faucet_empty`, `429 faucet_limit`, `503 faucet_unavailable` (the ticket stays good; try again).

## Cashu card relay

The Forge Android app takes eCash off a Cashu card with one swap at the card's mint. The phone talks only to the gateway, so these routes carry that swap to the card's mint and the answer back. The gateway sees only blinded outputs and cannot take the eCash. It stores nothing of the request. The mint must be one of the gateway's own, or pass the same checks as [other-mint funding](#ecash-from-another-mint). No key needed.

### `POST /v1/wallet/fund/card/mint`

Body: `mint`, `unit`, optional `accept_unlisted`. Returns `{mint, trusted, unit, keysets, keys}`, and for another mint `max`, the most other-mint funding takes from it.

### `POST /v1/wallet/fund/card/swap`

Body: `mint`, `inputs` (1 to 128 card pieces `{amount, id, secret, C}`, the first may carry `witness`), `outputs` (1 to 64 blinded messages `{amount, id, B_}`), optional `accept_unlisted`. Passed to the mint's `/v1/swap`. Returns `{signatures}`.

### `POST /v1/wallet/fund/card/restore`

Body: `mint`, `outputs`, optional `accept_unlisted`. Passed to the mint's `/v1/restore` (NUT-09). Returns `{outputs, signatures}`.

A refusal by the mint answers `400 mint_refused` with the mint's own `mint_code`. A mint that fails, times out or rate-limits answers `503 mint_unavailable`.

## Other routes

### `POST /v1/beta/signup`

Joins the waitlist for an invite. Body: `contact` (an email address or a Nostr `npub`), optional `note` (up to 500 characters). Returns `{"ok": true}`. Errors: `400 invalid_contact`, `429 rate_limited` (3 signups a minute from one address).

### `GET /healthz`

`{"ok": true, "rate": {"btc_usd", "age_s"} | null, "invite_only"}`.

### `GET /attestation`

The private models' enclave attestation bundle, proxied from Tinfoil so a browser can verify it through the gateway's origin. `404 not_found` when the gateway has no enclave supplier.

### `GET /.well-known/hpke-keys`

The enclave's HPKE key config for encrypted requests. `404 not_found` when the gateway has no enclave supplier.

## Errors

Every error from an API route has the same shape:

```json
{ "error": { "message": "balance too low: need 5410 msub, available 0 msub", "type": "insufficient_balance", "code": "insufficient_balance" } }
```

`type` and `code` are the same. Some errors add fields beside `error`: `payment_request`, `amount`, `unit` and `mints` on a 402; `free_voice` on `free_voice_limit`; `free_models` on `not_free_model`; `unlisted` on `mint_unlisted`; `next_at` and `retry_after` on faucet refusals; `key` and `account_id` on `topup_pending`; `mint_code` on `mint_refused`. A path the gateway does not know answers `404` in plain text.

| Status | Code | Meaning |
| - | - | - |
| 400 | `invalid_request` | The body or a header is malformed. The message says which |
| 400 | `invalid_amount` | An amount out of range |
| 400 | `invalid_token` | Not a `cashuB` token, too large, empty, or not decodable |
| 400 | `untrusted_mint` | The token's mint is not accepted here |
| 400 | `wrong_unit` | The unit is not taken here, or does not match the balance or quote |
| 400 | `insufficient_amount` | The token is worth less than needed, after fees |
| 400 | `token_spent` | The token was already redeemed |
| 400 | `invalid_pubkey` | The lock key is not a valid secp256k1 key or npub |
| 400 | `credits_need_balance` | Credits sent per request: add them with a top-up instead |
| 400 | `credits_expired` | Credits from a retired keyset |
| 400 | `credits_not_money` | Credits sent where money is needed |
| 400 | `encryption_required` | This model takes only encrypted requests |
| 400 | `web_search_unavailable` | Web search on a model that cannot search |
| 400 | `audio_too_short` | A recording under 0.3 seconds |
| 400 | `method_unavailable` | That funding method or unit is off |
| 400 | `use_topup` | A token from the gateway's own mint sent to other-mint funding |
| 400 | `mint_not_allowed` | That mint's eCash is not accepted |
| 400 | `mint_check_failed` | An unlisted mint failed the gateway's live check |
| 400 | `amount_too_large` | A token over the other-mint cap |
| 400 | `token_mismatch` | Confirm sent a token other than the quoted one |
| 400 | `foreign_mint_error` | The other mint cannot pay Lightning invoices (503 when it did not answer) |
| 400 | `mint_refused` | The card's mint refused the swap |
| 400 | `invalid_contact` | Not an email address or npub |
| 400 | `issue_failed` | A payout failed and cannot be issued |
| 400 | `free_too_long`, `free_too_much_output` | A free question over the caps |
| 400 | `pow_invalid`, `challenge_unknown`, `ticket_unknown` | A faucet step that does not check out |
| 401 | `invalid_key` | Missing or unknown balance key |
| 401 | `balance_key_required` | A free model without a balance key |
| 402 | `payment_required` | Pay this request: see `X-Cashu` |
| 402 | `insufficient_balance` | The available balance does not cover the hold |
| 402 | `free_voice_limit` | No free voice questions left today |
| 403 | `invite_required` | An invite code is needed |
| 403 | `invite_used`, `invite_invalid` | The invite was already redeemed, or is not valid |
| 403 | `pass_expired`, `pass_used_up` | The event pass is past its expiry or its uses |
| 403 | `balance_key_required` | A free model with a free-question balance key |
| 403 | `account_frozen` | The operator froze this balance. Refunds still work |
| 403 | `not_free_model`, `web_search_not_free` | A free-question balance used outside its rules |
| 404 | `model_not_found` | No such model |
| 404 | `not_found` | No such funding, change or feature here |
| 409 | `request_id_used` | That request id already paid once. The token was not touched |
| 409 | `not_settled` | Change is not ready yet: retry after `Retry-After` |
| 409 | `wrong_balance` | Money and credits on the wrong kind of balance |
| 409 | `token_in_flight`, `in_flight` | The same token or payout is being processed now |
| 409 | `insufficient_balance` | The balance changed during a refund: retry |
| 409 | `quote_expired` | The other-mint quote expired: ask for a new one |
| 409 | `mint_unlisted` | The mint is off the list: resend with `accept_unlisted: true` |
| 409 | `challenge_used`, `claim_used` | A faucet puzzle or ticket used twice |
| 410 | `challenge_expired` | The faucet puzzle is too old |
| 413 | `request_too_large` | The body is over the size limit |
| 413 | `audio_too_long`, `text_too_long` | Over the audio model's limits |
| 415 | `unsupported_audio` | Not a WAV recording |
| 429 | `rate_limited` | Too many requests: wait `Retry-After` seconds |
| 429 | `too_many_pending` | Too many unfinished fundings on this balance |
| 429 | `faucet_empty`, `faucet_limit` | No vouchers now, or none left for this address today |
| 500 | `internal_error` | Something failed in the gateway |
| 502 | `upstream_error` | The model's supplier failed. Nothing was charged |
| 503 | `mint_unavailable` | A mint did not answer. Retry with the same token |
| 503 | `rate_unavailable` | No BTC/USD rate: sat pricing is paused, usd works |
| 503 | `topup_pending` | The top-up's outcome is not known yet: retry with the returned key |
| 503 | `wallet_insufficient`, `wallet_inconsistent` | The gateway cannot make that payout right now |
| 503 | `payout_unknown` | A locked payout the mint has not confirmed. It stays owed and is never paid twice |
| 503 | `faucet_unavailable` | The voucher could not be made. The ticket stays good |

`upstream_error` keeps the supplier's status when it is a 4xx other than 429, so a bad request to the model comes back as that 4xx. Audio answers `503 upstream_error` while sat pricing is paused.

## Rate limits

- POST requests under `/v1` are limited per client address, and also per balance key when one is sent. GET requests are not limited.
- Each limit is a token bucket. The defaults are 60 requests a minute with a burst of 15. The operator can change them.
- Past the limit the answer is `429 rate_limited` with `Retry-After` in seconds.
- Request bodies are limited too: 1,000,000 bytes by default, and 4,000,000 bytes for speech to text uploads. Over that, `413 request_too_large`.
- The faucet adds its own daily budget and per-address limit. The waitlist takes 3 signups a minute from one address.

## CORS

Every `/v1` route answers cross-origin requests from any origin (`Access-Control-Allow-Origin: *`), for GET, POST and OPTIONS, with preflight results cached for 600 seconds. `/attestation` and `/.well-known/*` allow GET from any origin.

Request headers a browser may send: `Accept`, `Authorization`, `Content-Type`, `X-Cashu`, `X-Cashu-Pubkey`, `X-Forge-Invite`, `X-Forge-Request-Id`, `X-Forge-Unit`, `Ehbp-Encapsulated-Key`, `X-Tinfoil-Enclave-Url`, `X-Tinfoil-Model`, `X-Tinfoil-Max-Output-Tokens`, `X-Tinfoil-Completion-Count`, `X-Forge-Web-Search`, `X-Bellows-Pow`.

Response headers a browser may read: `X-Cashu`, `X-Cashu-Change`, `X-Forge-Request-Id`, `X-Forge-Unit`, `X-Forge-Charged-Msub`, `X-Forge-Balance-Msub`, `X-Forge-Change-Url`, `X-Forge-Privacy`, `X-Forge-Free-Voice-Left`, `Ehbp-Response-Nonce`, `Retry-After`, `X-Bellows-Pow-Challenge`.

A browser app can hold a balance key and call the gateway directly. Anyone who can read the page's storage can spend that balance, so keep only small amounts on a key that lives in a browser.

## Modules

Forge AI is built as a reference: one working set of choices, made so each part can be swapped. Where two parts meet they speak an open protocol, so you can replace one side without asking Forge.

| Seam | Protocol | What it means for you |
| - | - | - |
| App to gateway | OpenAI chat completions API | Any OpenAI client, agent framework or app of your own can be the app |
| Gateway to models | OpenAI API, and Tinfoil's EHBP for encrypted requests | Encrypt to the enclave in your own client. The gateway only relays the bytes |
| Paying | Cashu (NUTs) and Lightning | Your users pay from any Cashu or Lightning wallet |
| Finding mints | NIP-87 announcements and reviews on Nostr | Mints the community reviews can fund a balance (`GET /v1/wallet/fund/mints`) |
| Free questions | Credit vouchers (Cashu eCash from a credit mint) | An organisation can hand out questions on paper or a QR code |

What this means for a builder:

- **Your app is a module.** Any program that speaks the OpenAI API can call the gateway. A chat app, a voice assistant, a Telegram bot and an agent all use the same `/v1` routes.
- **Payment is a module.** Your users can pay with a Lightning wallet, with eCash they already hold, or per request with no account. Nobody needs a bank card or a sign-up.
- **Privacy is a choice per request.** Pick a private model (`tier: "enclave"`) and encrypt with Tinfoil's SDK, or use a standard model when that is enough.

Inside the Forge app, the same idea runs through app modules: each way to fund (paper note, Lightning, Cashu card, other mint), each voice in and out, each photo filter and each look is a module with a manifest and a small interface. Today only the modules bundled with the app load. Signed third-party modules, their sandbox and their permissions are designed but not built yet.
