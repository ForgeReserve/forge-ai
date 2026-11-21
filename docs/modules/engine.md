# Engine modules

The engine is the gateway in [`src/`](https://github.com/ForgeReserve/forge-ai/blob/main/src): the server the app sends questions and payments to. It has modules too. Each part sits behind a small interface, so a different module can replace it without touching the rest. This page covers the two an outside contributor is most likely to add: a supplier, which brings AI models, and a funding method, which brings a way to pay. The public routes they serve are in the [API guide](../API.md).

## The engine's parts

| Part | Interface | File |
| - | - | - |
| Suppliers | `Supplier`: `chat`, and optional `forwardEncrypted`, `transcribe`, `speech`, `attestation`, `hpkeKeys` | [`src/suppliers/types.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/suppliers/types.ts) |
| Funding methods | `FundingService` with `methods()` and a create step per method | [`src/funding.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/funding.ts) |
| Cashu card relay | The routes that carry a card's swap to its mint | [`src/cardrelay.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/cardrelay.ts) |
| Mint policy | `vetForeignMint` in `FundingService`, and discovery of reviewed mints | [`src/mint-discovery.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/mint-discovery.ts) |
| Pricing | The model catalog's prices, with a markup | [`src/pricing.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/pricing.ts) |
| Exchange rates | `RateSource`: `name` and `fetchBtcUsd(signal)` | [`src/rates.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/rates.ts) |
| Storage | One SQLite file | [`src/db.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/db.ts) |

## Suppliers

A supplier is an AI provider the engine forwards questions to. The engine ships with three kinds: any OpenAI-compatible API ([`src/suppliers/openai.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/suppliers/openai.ts)), Tinfoil's enclaves, which also take encrypted requests ([`src/suppliers/tinfoil.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/suppliers/tinfoil.ts)), and an in-process mock for tests and local work ([`src/suppliers/mock.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/suppliers/mock.ts)).

### The interface

From `src/suppliers/types.ts`:

```ts
export interface Supplier {
  readonly id: string;
  readonly config: SupplierConfig;
  /** Plaintext OpenAI-compatible call. Returns the upstream Response (any status). */
  chat(call: ChatCall): Promise<Response>;
  /** Encrypted pass-through (EHBP). Only suppliers that support it implement this. */
  forwardEncrypted?(call: EncryptedCall): Promise<EncryptedResponse>;
  /** OpenAI-compatible POST /audio/transcriptions. Returns the upstream Response (any status). */
  transcribe?(call: TranscribeCall): Promise<Response>;
  /** OpenAI-compatible POST /audio/speech. Returns the upstream Response (any status). */
  speech?(call: SpeechCall): Promise<Response>;
  /** Proxy for the supplier's attestation bundle, if any. */
  attestation?(): Promise<Response>;
  /** Proxy for the enclave's HPKE key config (/.well-known/hpke-keys), if any. */
  hpkeKeys?(): Promise<Response>;
}
```

| Member | What the engine does with it |
| - | - |
| `id` | The supplier's name in the catalog. |
| `config` | Its catalog entry (below). |
| `chat(call)` | Every plain question. `call` is `{model, body, stream, signal}`: `model` is the catalog entry, `body` the OpenAI request already rewritten for the upstream (its model name, its output limit, and `stream_options.include_usage` when streaming). Return the upstream's `Response` whatever its status. For a metered supplier the engine reads the usage from the answer (the last chunk of a stream) and charges for it. |
| `forwardEncrypted(call)` | Encrypted questions, which the engine passes on without reading. Only a supplier with it can serve them; without it the engine answers `400`. |
| `transcribe(call)`, `speech(call)` | Speech to text and text to speech. `call.audio` and `call.input` are held in memory only and never logged. Only a supplier with them can serve audio models. |
| `attestation()`, `hpkeKeys()` | Proxies for an enclave's attestation bundle and key config, served at [`GET /attestation`](../API.md#get-attestation) and [`GET /.well-known/hpke-keys`](../API.md#get-well-known-hpke-keys). |

Throw `UpstreamError(message, status)` from `types.ts` for a failure before any answer. The engine charges nothing for a request that fails before the answer starts.

### How the engine builds them

`buildSuppliers` in [`src/suppliers/index.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/suppliers/index.ts) makes one supplier per catalog entry, by its `type`:

```ts
for (const [id, s] of Object.entries(config.catalog.suppliers)) {
  if (s.type === 'mock') out.set(id, new MockSupplier(id, s));
  else if (s.type === 'tinfoil') out.set(id, new TinfoilSupplier(id, s, env, retry));
  else out.set(id, new OpenAISupplier(id, s, env, retry));
}
```

### Configuring one

Suppliers and models live in the model catalog, a JSON file: [`config/models.json`](https://github.com/ForgeReserve/forge-ai/blob/main/config/models.json), or the file `FORGE_MODELS_FILE` names. [`config/models.dev.json`](https://github.com/ForgeReserve/forge-ai/blob/main/config/models.dev.json) is the catalog for local work, with the mock supplier. `CatalogSchema` in [`src/config.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/config.ts) checks it when the engine starts and refuses a bad one.

A supplier entry:

| Field | What it is |
| - | - |
| `type` | `openai`, `tinfoil` or `mock`. |
| `baseUrl` | The API's address, such as `https://inference.tinfoil.sh/v1`. |
| `apiKeyEnv` | The name of the environment variable that holds the API key. The key itself never goes in the catalog. |
| `tier` | `enclave` for models in sealed hardware whose operator cannot read the questions, else `standard`. The app shows `enclave` models as Private and Private only allows only them. |
| `pricing` | `metered` (charge the usage the supplier reports) or `flat` (charge a fixed schedule, `flat`). |
| `idempotencyHeader` | The header the supplier honours as an idempotency key, when it documents one. With it, failed requests are retried. |
| `allowPlaintext`, `enclaveHosts`, `enclaveUrl`, `attestationUrl`, `allowInsecureEnclave`, `web_search` | Tinfoil only: plain requests, the enclave hosts allowed, attestation, and the web search fee. |

A model entry names its supplier and the model's name there:

```json
{
  "id": "mock-echo",
  "supplier": "mock",
  "upstream": "mock-echo",
  "input_usd_per_mtok": 10,
  "output_usd_per_mtok": 100,
  "price_verified": true,
  "max_output_tokens": 512,
  "uncensored": false
}
```

Its other fields are `name`, `pricing` (`paid` or `free`, with `free_reason`), `cached_input_usd_per_mtok` (the supplier's price for input served from its prompt cache, at most the input price), `context_length`, `vision`, `reasoning`, `reasoning_efforts`, `speed` and `web_search`. Prices are the supplier's cost per million tokens in US dollars; the engine adds `FORGE_MARKUP`. An audio model goes in the catalog's `audio` list, with `kind` (`transcription` or `speech`), its prices per request and per second or per thousand characters, `max_seconds` or `max_chars`, and `voices`.

### Adding a supplier

An OpenAI-compatible API needs no code: add a supplier entry with `"type": "openai"`, its `baseUrl`, `apiKeyEnv` and `tier`, then its models, and set the key in that environment variable.

Any other API needs a supplier of its own:

1. Write a class that implements `Supplier` in a new file in `src/suppliers/`. `MockSupplier` is the shortest working one; `OpenAISupplier` shows retries and timeouts (`fetchWithRetry`). `chat` must return an OpenAI-compatible answer, a JSON body or an SSE stream that ends with a usage chunk, because the engine charges from it.
2. Add its `type` to `SupplierSchema` in `src/config.ts` and a branch for it in `buildSuppliers`.
3. Add tests in `test/unit/` with a stub upstream, and a catalog entry in a test catalog. [`test/unit/tinfoil.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/tinfoil.test.ts) tests a supplier this way.
4. Mark a supplier `enclave` only when its models run in attested sealed hardware. The app tells people those models are private.

## Funding methods

A funding method turns a payment into credit on a balance. The engine has three, built into one service, `FundingService` in `src/funding.ts`:

```ts
export type FundingMethod = 'lightning' | 'onchain' | 'foreign';
export type FundingState = 'quoted' | 'receiving' | 'melting' | 'pending' | 'minting' | 'done' | 'expired' | 'failed' | 'refunded';
```

Topping up with eCash from a mint the engine takes ([`POST /v1/wallet/topup`](../API.md#post-v1-wallet-topup)), the faucet's vouchers among them, needs no funding: the engine takes the token in the same request.

### What the app sees

`methods()` returns what [`GET /v1/wallet/fund/methods`](../API.md#get-v1-wallet-fund-methods) sends, which every fund module's `available(methods)` reads:

```ts
export interface FundingMethods {
  ecash: { mints: string[]; units: Unit[] };
  lightning: { enabled: boolean; units: Unit[]; min: Partial<Record<Unit, number>>; max: Partial<Record<Unit, number>> };
  onchain: { enabled: boolean; unit: 'sat'; min_amount: number; confirmations: number };
  foreign: {
    enabled: boolean;
    max: { sat: number; usd: number };
    policy: ForeignPolicy;
    mints: string[];
    mints_url: string;
    /** Mints that are not accepted may still be used after a warning, up to max (sat / cents). */
    unlisted: { enabled: boolean; max: { sat: number; usd: number } };
  };
}
```

The route adds `invite_only`, `free_voice`, `free` (the faucet) and `open` (free models) from the engine's other settings. Each method is on or off from the engine's configuration (`FORGE_LIGHTNING_ENABLED`, `FORGE_ONCHAIN_ENABLED`, `FORGE_FOREIGN_ENABLED` and their limits, in the README's configuration table) and from what the engine's own mint offers.

### How a funding runs

| Step | `FundingService` | Route |
| - | - | - |
| Create | `createLightning(accountId, unit, amount)`, `createOnchain(accountId)`, `quoteForeign(accountId, unit, token, lockPubkey, opts)` | [`POST /v1/wallet/fund/lightning`](../API.md#post-v1-wallet-fund-lightning), [`.../onchain`](../API.md#post-v1-wallet-fund-onchain), [`.../foreign/quote`](../API.md#post-v1-wallet-fund-foreign-quote) |
| Confirm | `confirmForeign(id, token, lockPubkey)` | [`POST /v1/wallet/fund/foreign/confirm`](../API.md#post-v1-wallet-fund-foreign-confirm) |
| Move on | `advance(id)`: checks the mint and moves the funding to its next state, crediting the balance at `done` | [`GET /v1/wallet/fund/{id}`](../API.md#get-v1-wallet-fund-id), and a background `tick()` every few seconds |
| Show | `view(row)`: the funding as the routes send it | [`GET /v1/wallet/fund`](../API.md#get-v1-wallet-fund) |

Every funding is a row in the `fundings` table, written before the invoice or address is shown, so a restart picks it up where it was.

### Adding a funding method

The three methods are built inline in `FundingService`. Splitting them into one file per method behind one interface is planned ([`docs/MODULES.md`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/MODULES.md), What changes in the code) and not done. Today a new method means, in one pull request:

1. A new `FundingMethod` value and a create step in `FundingService`, with its states in `advance`.
2. A route in [`src/app.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/src/app.ts) and a field in `FundingMethods`, so the app can tell when it is on.
3. The route documented in [`docs/API.md`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/API.md) under a ``### `POST /v1/...` `` heading: [`test/unit/api-docs.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/api-docs.test.ts) fails while a public route is undocumented.
4. Tests against the local test mints in [`test/e2e/`](https://github.com/ForgeReserve/forge-ai/blob/main/test/e2e), as [`test/e2e/funding.e2e.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/e2e/funding.e2e.test.ts) does.
5. A [fund module](fund.md) in the app that offers it.

## Running the engine locally

[Write your first module](first-module.md#run-the-app-on-your-computer) shows how to run the engine with the mock supplier and the local test mints.
