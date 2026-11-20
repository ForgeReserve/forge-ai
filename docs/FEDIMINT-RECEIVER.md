# Fedimint receiver

> **Off unless the operator turns it on.** `docker compose up` does not start the service, and the gateway calls it only once `FORGE_FEDIMINT_URL` is set ([Turning it on](#turning-it-on)). Then `POST /v1/wallet/topup` takes Fedimint notes as well as Cashu ([PAYMENTS.md, Fedimint notes](PAYMENTS.md#fedimint-notes)). The app does not offer it yet.

`services/fedimint-receiver` is a small Rust service that holds Fedimint eCash for the gateway. The gateway hands it notes a user pastes; the service checks them, reissues them into its own wallet, and says how much arrived. One process holds any number of federations. A federation is accepted once it has been joined: the joined federations are the allowlist.

It is built on `fedimint-client` 0.13.0 with the mint v1 and mintv2 client modules, pinned to exact versions, with `Cargo.lock` committed.

## What it does

- **Join** a federation by invite code. The service reads the federation's config from its guardians and refuses a federation with no mint module it speaks.
- **Parse** notes without contacting any federation: their kind, value, federation, and a stable `notes_id`.
- **Receive** notes: reissue them into the wallet, once. The record of a receive is written to disk before the notes are submitted, so a crash at any point resumes after a restart without counting the notes twice.
- **Report balances**, per federation.

It does not send, pay invoices, leave a federation or recover a wallet from its seed. Those come later.

### The notes it reads

| Module | What it is | Where it comes from |
| --- | --- | --- |
| `mint` | mint v1 `OOBNotes`: base64url, base64 or `fedimint...` base32, with or without the federation's invite inside | `send_oob_notes` in fedimint's mint v1 client. A Fedimint card till's wallet makes notes this way. |
| `mintv2` | mintv2 `ECash`: `fedimint...` base32 | `send` in the mintv2 client, the default mint of a federation made with fedimint 0.13 |

Whitespace anywhere in a string is ignored, as fedimint's own parsers ignore it. A string that carries the same note twice, no notes, or no value is refused.

## Configuration

All from the environment.

| Variable | Default | |
| --- | --- | --- |
| `FEDIMINT_RECEIVER_TOKEN` | (required) | Bearer token every request must carry. At least 32 printable characters. Without it the service does not start. |
| `FEDIMINT_RECEIVER_LISTEN` | `127.0.0.1:8790` | Address to listen on. The Docker image sets `0.0.0.0:8790`; publish no port. |
| `FEDIMINT_RECEIVER_DATA_DIR` | `./data` | Client databases, receive records and, when generated, the mnemonic. The image uses `/data`. |
| `FEDIMINT_RECEIVER_MNEMONIC` | (unset) | The wallet's 12 BIP39 words. Unset: generated once into the data directory. |
| `RUST_LOG` | `info` | Log filter. |

The log never carries notes, the mnemonic or the token. A receive is logged by its `notes_id`.

## The API

JSON in and out. Every route, `/health` included, needs `Authorization: Bearer <FEDIMINT_RECEIVER_TOKEN>`; without it the answer is `401`. Errors have one shape:

```json
{ "error": { "code": "not_joined", "message": "the federation that issued these notes has not been joined" } }
```

Branch on `code`; the message is for people and may change.

| Code | Status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | No bearer token, or the wrong one. |
| `bad_request` | 400 | The body is not JSON, misses a field, or `key` is not 1 to 128 characters of `A-Z a-z 0-9 - _ : .`. |
| `bad_invite` | 422 | Not an invite code, or the federation's config does not match it. |
| `bad_notes` | 422 | Not notes this service reads, or their signatures do not verify under the federation they name. Nothing was recorded. |
| `not_joined` | 409 | The notes' federation has not been joined. Nothing was spent or recorded. |
| `ambiguous_federation` | 409 | The notes carry only a 4-byte federation id prefix and more than one joined federation has it. Nothing was spent or recorded. |
| `module_unsupported` | 422 | The federation has no mint module this service speaks, or not the one that issued these notes. |
| `fee_exceeds_value` | 422 | The federation's fee to reissue the notes is at least what they are worth, or a mintv2 note is worth no more than the federation's base fee (the mintv2 client refuses such a note). Nothing was recorded. |
| `unreachable` | 502 | The federation did not answer (joining needs its guardians). |
| `not_found` | 404 | No such receive, federation or route. |
| `internal` | 500 | Anything else; the service log says what. |

### `GET /health`

`{"ok": true, "version": "0.1.0", "federations": 1}`. The container's health check is `fedimint-receiver healthcheck`, which asks this route with the token from the environment (the image has no shell or curl).

### `POST /federations`

`{"invite": "fed11..."}` joins the federation, or returns it when it is joined already (`already_joined: true`):

```json
{ "id": "5eb868aa...", "name": "Example", "modules": ["dummy", "ln", "mint", "wallet"], "receives": ["mint"], "already_joined": false }
```

`modules` is every module in the federation's config; `receives` is the kinds of notes this service takes from it.

### `GET /federations`

`{"federations": [{"id", "name", "modules", "receives", "balance_msat"}, ...]}`, oldest join first.

### `GET /federations/{id}/balance`

`{"id": "...", "balance_msat": 49876}`: the sum over the federation's mint modules. A client counts only its primary module in its own balance; with both mints, the change of a reissue can land in either, so both are counted.

### `POST /parse`

`{"notes": "..."}`. Contacts no federation and spends nothing.

```json
{
  "notes_id": "9c1e...64 hex",
  "module": "mint",
  "amount_msat": 50176,
  "count": 3,
  "federation_id": "5eb868aa...",
  "federation_prefix": "5eb868aa",
  "joined": true,
  "resolution": "joined",
  "module_supported": true,
  "signatures_valid": true,
  "received": null
}
```

- `notes_id`: SHA-256 over a fixed label, the module kind, the federation id prefix and the notes' nonces in sorted order. The nonces are what the federation marks spent, so the same notes give the same id however the string was encoded, in whatever order, with or without an invite.
- `federation_id`: the full id when the notes carry it (always for mintv2; for mint v1 only when the invite rides along) or when the prefix matches exactly one joined federation; otherwise `null`. `federation_prefix` is always there.
- `resolution`: `joined` (exactly one joined federation), `not_joined`, or `ambiguous` (several joined federations share the prefix).
- `module_supported` and `signatures_valid`: checked against the joined federation's config; `null` when it is not joined.
- `received`: the state of a receive of these notes, if there is one.

### `POST /receive`

`{"notes": "...", "key": "acct-123:topup-456"}` starts the receive, or returns the receive started earlier for the same notes. Idempotent on `notes_id`: a repeat, with any key, gets the same record back with `"repeat": true`, and `key` is always the key of the first request.

```json
{
  "notes_id": "9c1e...",
  "key": "acct-123:topup-456",
  "federation_id": "5eb868aa...",
  "module": "mint",
  "operation_id": "3f0a...",
  "state": "pending",
  "gross_msat": 50176,
  "fee_msat": 300,
  "net_msat": 49876,
  "created_at": 1795000000,
  "updated_at": 1795000000,
  "repeat": false
}
```

Before anything is written: the federation must be joined, have the notes' module, the signatures must verify, and the fee must be below the value. Then the record is written and synced, the notes are handed to the fedimint client, and the answer comes back, normally `pending`.

### `GET /receive/{notes_id}`

The same record, without `repeat`. States:

| State | Meaning |
| --- | --- |
| `pending` | Submitted, or waiting to be. While a federation is down a receive stays pending; the client keeps trying. |
| `done` | The federation took the notes and issued the wallet's new notes. The balance rose by `net_msat`. `fee_msat` and `net_msat` are final only now: while pending they are the client's quote. |
| `failed` | `failure` says which: `rejected` (the federation refused the notes: spent elsewhere first, or invalid), `refused` (this client refused to submit them), or `issuance_failed` (the federation took the notes but the new ones could not be issued: value may be stuck, an operator must look). `reason` is the client's text. |

## What the gateway must do to call it safely

The service is safe to call twice; the gateway's job is to credit once and only the right account. The gateway's top-up (`src/fedimint.ts`, [PAYMENTS.md, Fedimint notes](PAYMENTS.md#fedimint-notes)) follows these rules; its key for a top-up is `forge:<balance id>`, so the same balance giving the same notes again resumes its own receive.

1. **Credit only on `done`, and credit `net_msat` from the `done` record**, never the pending quote and never `gross_msat`.
2. **Compare `key`.** A repeat with a different key gets the first caller's record. If `key` is not the gateway's own key for this top-up, the notes were already given by someone else: refuse, do not credit.
3. **Key the gateway's own row by `notes_id`** (the plan's `fm:<notes_id>`) and write it before calling `/receive`, so the gateway's crash recovery can ask `GET /receive/{notes_id}` with nothing but its own row.
4. **`pending` is not a failure.** Answer `503 topup_pending` and ask again later; a sweep that asks every pending row is enough. A restart of the service does not lose a pending receive.
5. **`not_joined`, `ambiguous_federation`, `bad_notes`, `module_unsupported`, `fee_exceeds_value` spent nothing**: tell the user, and the notes are still theirs.
6. **`failed` with `issuance_failed`** needs an operator; never credit it and never tell the user the notes are lost.
7. **Network errors and `5xx` are unknowns.** Retry `POST /receive` with the same notes and key: it returns the existing record if the first call got through.
8. Run `/parse` first to show the amount and federation before taking the notes; it is cheap and touches nothing.

## Turning it on

What the operator does, on the gateway's host, with the Docker setup in `docker-compose.yml`. No step prints the receiver's token, its words or an invite code; keep them out of shell history and chat.

1. **The receiver's secrets**, in `.env`: `FEDIMINT_RECEIVER_TOKEN` (for example `openssl rand -hex 24`), and `FEDIMINT_RECEIVER_MNEMONIC`, 12 BIP39 words with an offline copy ([Storage, the seed and recovery](#storage-the-seed-and-recovery)). Without the words the service makes its own in its volume, and the volume becomes the only backup.
2. **Start the receiver:** `docker build -t forge-fedimint-receiver services/fedimint-receiver`, then `docker compose --profile fedimint up -d fedimint-receiver`. It has no published port; the gateway reaches it on the compose network.
3. **Point the gateway at it**, in `.env`: `FORGE_FEDIMINT_URL=http://fedimint-receiver:8790`. The compose file gives the gateway the receiver's own token as `FORGE_FEDIMINT_TOKEN` unless that is set too. Optional: `FORGE_FEDIMINT_MAX_SAT` (largest top-up, default 100,000 sat) and `FORGE_FEDIMINT_FEDERATION_CAP_SAT` (most Forge holds of one federation, default 1,000,000 sat). Then recreate the gateway so it reads them: `docker compose --profile fedimint up -d`. The gateway refuses to start with a URL and no token, or with no `sat` in `FORGE_UNITS`.
4. **Join a federation.** With its invite code on stdin, so it stays out of the command line: `docker compose exec -T gateway node src/admin.ts fedimint:join < invite.txt` (or `--max-sat N` and `--cap-sat N` for this federation's own lower caps). The gateway asks the receiver to join (the receiver reads the federation's config from its guardians and refuses one with no mint module it takes), then writes the federation's row, active. It prints the federation's id, name, the notes it takes and its caps, never the invite. Joining again refreshes the name and modules and keeps the state and caps unless new ones are given.
5. **Check:** `docker compose exec gateway node src/admin.ts fedimint:list` shows each federation with `joined: true` and its balance at the receiver, and `GET /v1/wallet/fund/methods` lists it under `fedimint.federations`. Try one small top-up and watch for the `fedimint_topup_credited` log line before telling anyone.
6. **Stop taking one federation's notes:** `fedimint:pause <federation id>`; `fedimint:resume <federation id>` takes them again. Notes already on their way are finished.

**Turning it off.** Unset `FORGE_FEDIMINT_URL` and recreate the gateway: notes are no longer taken and the methods no longer list `fedimint`. Keep the receiver running while any Fedimint top-up is still `prepared` (`fedimint:list`, `pending`): with the URL unset the gateway does not ask about them, and they are finished only once it is set again.

**What each refusal means** for the person and the operator is in [PAYMENTS.md, Fedimint notes](PAYMENTS.md#fedimint-notes), with the solvency rule: take out stays Cashu, so Fedimint-funded sat balances are backed by Fedimint notes at the receiver, and Cashu take outs can fail with `wallet_insufficient` until the operator moves value from the receiver into Cashu. The admin page's Fedimint section warns when that can happen and suggests the amount; the move itself needs a pay route this service does not have yet ([ADMIN.md, Fedimint](ADMIN.md#fedimint)).

## Compatibility

**Fedimint client version:** 0.13.0 from crates.io, every fedimint crate the same release.

**Server versions:** the client negotiates API versions with the guardians at join and on start. This client asks for core API 0.0, mint v1 module API 0.0 and mintv2 module API 0.1 (read from the 0.13.0 sources). A federation whose guardians offer those majors at or above those minors negotiates. That says what the negotiation accepts, not that every older server answers every call this client makes: **no older fedimintd was run against it**, so the oldest working federation version is not established.

What is established for the federation Fedimint card tills use: a till's wallet runs fedimint 0.13.0-beta.1 against it. Compared file by file, the mint v1 client, the mintv2 client, `fedimint-api-client` and `fedimint-connectors` sources of 0.13.0 are identical to 0.13.0-beta.1, `fedimint-client` differs only in overflow checks on transaction amounts, and `fedimint-core` only in a supply cap on parsed amounts and in refusing non-empty vectors of zero-sized items. One change can refuse a federation: 0.13.0's mint v1 and mintv2 configs now accept a mint fee only of zero, or of a 100 msat base with at most 1,000 parts per million. A federation set up with other fees would fail to load in this client although the till's client loads it. The upstream code calls this the existing invariant of configs fedimintd makes, so it should not occur; it is not verified against that federation.

**The fedimint-sdk crate was not used.** `fedimint-sdk` 0.1.0 is published and pins fedimint 0.13.0, but its `Ecash::receive` picks the mintv2 module whenever a federation has one, so on a federation with both mints it refuses mint v1 notes (`NotSupported`); it submits and returns the operation in one call, so recording the operation id first would mean deriving fedimint's id outside the SDK anyway; it does not expose the notes' federation id prefix; and it reports a second receive of the same notes with the same code as malformed notes (`InvalidInput`). Each of these is something this service must get right. It uses the same seed derivation as fedimint-sdk and fedimint's own clients (12-word BIP39, `StandardDoubleDerive`), so the words work there too.

## Storage, the seed and recovery

```text
<data>/
  mnemonic                   only when the seed was generated here (mode 0600)
  seed-check                 fingerprint of the seed: a hash, not the words
  federations/<id>/
    federation.json          the invite it was joined with, its name, when
    client.db/               the fedimint client's RocksDB
  receives/<notes_id>.json   one record per receive; holds the notes only while pending
```

Directories are mode 0700 and files 0600. Each small file is written whole (temporary file, sync, rename), so a crash leaves the old version or the new one.

**The seed.** In production set `FEDIMINT_RECEIVER_MNEMONIC` and keep an offline copy; the words are then never on the volume. Without it the service generates words into `<data>/mnemonic` on first start. `seed-check` makes the service refuse to start with a different seed than the directory was made with, or with none after it was made with one from the environment.

**What the seed and the invite codes can restore, and what was not verified.** The notes are derived from the seed, so in fedimint's design the seed plus each federation's invite code is enough to recover the balance through fedimint's recovery (the client scans the federation's history for notes the seed owns, or restores a backup the client stored with the guardians). **This service does not run that recovery yet, and it was not tested.** Two consequences:

- Do not point a fresh data directory at a seed that already holds notes and join the same federation again: a plain join starts the note counters from zero and is not a recovery. Restoring is a later step (the plan's step 5), with a drill.
- Until then the data volume is the backup. Copying RocksDB while the service runs is likely to give an inconsistent copy (inferred, not tested); stop the service, or snapshot the volume, before copying.

## Running it

```sh
cd services/fedimint-receiver
FEDIMINT_RECEIVER_TOKEN=$(openssl rand -hex 24) cargo run
```

In Docker, from the repository root:

```sh
docker build -t forge-fedimint-receiver services/fedimint-receiver
docker compose --profile fedimint up -d fedimint-receiver
```

`docker-compose.yml` defines the `fedimint-receiver` service under the `fedimint` profile, so `docker compose up -d` without the profile starts nothing new and the gateway is unchanged. It joins the compose network with no published port and keeps its data in the `fedimint-data` volume. Set `FEDIMINT_RECEIVER_TOKEN` (and `FEDIMINT_RECEIVER_MNEMONIC`) in `.env`. The image runs as a non-root user on distroless Debian 12.

## devfed: a federation for end to end tests

The `devfed` binary (feature `devfed`) runs a federation in one process: four guardians from `fedimint-testing` on loopback ports, a fake bitcoin backend, and an issuing client that makes notes from nothing through fedimint's test-only dummy module. No devimint, nix or bitcoind, and no real money.

```sh
cd services/fedimint-receiver
cargo run --features devfed --bin devfed -- --mints mint      # or mintv2, or both; --no-fees for zero fees
```

It prints one JSON line, then serves until killed:

```json
{"invite":"fed11...","federation_id":"...","url":"http://127.0.0.1:53817","mints":"mint"}
```

- `GET /invite`: `{"invite": "..."}`
- `POST /notes` `{"amount_msat": 50000, "module": "mint", "include_invite": false}`: `{"notes": "...", "amount_msat": 50176}`. The wallet rounds the amount up to what its notes can make; `amount_msat` is the notes' value. `module` matters only with `--mints both`.
- `POST /spend` `{"notes": "..."}`: spends the notes into the issuer's own wallet, so a later receive of them fails as spent elsewhere.

It listens on loopback only and takes no token. Mint v1 is the default because it is what a Fedimint card till's wallet needs.

## Tests

```sh
cd services/fedimint-receiver
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Clippy and the tests need `protoc` (the protocol buffer compiler) on the machine: a test dependency builds with it. The service itself builds without it.

The tests run the real binary in a child process and speak to it over HTTP, against federations of four guardians started in the test process (`src/devfed.rs`). Notes come from a separate client of the federation, made with `send_oob_notes` (mint v1, as a till's wallet makes them) or mintv2's `send`. A restart is a real one: the child is killed with SIGKILL, or aborts at a crash point (the `test-hooks` feature, built only for tests), and a new process opens the same data directory.

| Test | What it shows |
| --- | --- |
| `every_route_needs_the_bearer_token` | Every route, and an unknown one, answers 401 without the token, with a wrong one and with one a character short; a short token refuses to start. |
| `joins_by_invite_once_and_receives_mint_v1_notes_for_their_net_value_once` | Join, join again (same federation, `already_joined`), a bad invite; mint v1 notes parsed, received, `done`, the balance up by exactly `net_msat = gross - fee` with a non-zero fee; the same notes again with other keys and re-encoded with the invite inside give the same record and the first key, and no second credit; bad input codes; no notes in the log; the operation ran under the id recorded before it was submitted. |
| `notes_spent_elsewhere_end_failed_and_credit_nothing` | Notes another wallet took first end `failed`, `rejected`, with no credit; asking again returns the same record. |
| `notes_of_a_federation_not_joined_are_refused_and_left_unspent` | With and without the invite inside: `/parse` says `not_joined` (the full id only when the invite rides along), `/receive` answers `not_joined`, nothing is recorded, and the notes still go to another wallet afterwards. |
| `notes_whose_signatures_do_not_verify_are_refused_before_anything_is_recorded` | Real notes of another federation relabelled with a joined federation's prefix: `signatures_valid: false`, `bad_notes`, nothing recorded, the real notes untouched. |
| `mintv2_notes_are_received_once` | The same for mintv2: done, net credited once, a repeat is the same record, and the notes can no longer be spent elsewhere. |
| `two_federations_at_once_keep_their_own_balances` | A mint v1 and a mintv2 federation joined in one process; each receive lands in its own federation and balance. |
| `a_federation_with_both_mints_receives_both_kinds_of_notes` | One federation with both mints: v1 and v2 notes both arrive, and the balance counts both. |
| `a_crash_after_the_record_is_written_and_before_the_notes_are_submitted` | The process aborts after the record is synced and before the client sees the notes; the restart submits them and the receive ends `done` once (and stays so over a further restart). |
| `a_crash_after_the_notes_are_submitted_and_before_the_answer` | The process aborts after the client has the notes, before answering; the restart only follows the operation; `done` once. |
| `a_kill_right_after_a_pending_answer_and_while_the_federation_works` | SIGKILL right after a `pending` answer, for mint v1 and mintv2: `done` once after the restart, same operation id, notes spent. Whether the federation had finished before the kill is not controlled. |
| `the_seed_from_the_environment_is_never_written_and_never_swapped` | An environment seed is never written; another seed, or none, does not open the directory; the right one does, with the balance intact; the words never reach the log. |
| `a_generated_seed_is_kept_private_in_the_data_directory` | A generated seed is 12 words in a 0600 file in a 0700 directory, kept across restarts, never logged. |
| `devfed_hands_out_notes_the_receiver_takes` | The `devfed` binary as a process: the receiver joins by its invite, receives its notes, and notes passed to `/spend` fail as spent. |

Unit tests cover reading notes (encodings, ids, a repeated note, junk) and the seed rules.

**Not covered by a test:** `ambiguous_federation` (it needs two federations whose ids share 4 bytes); `fee_exceeds_value` (the test federations' wallets round notes up to economical sizes); `unreachable` on join; `issuance_failed`; a federation that is down while a receive is pending; any federation older than 0.13.0; a real federation of any kind.

### The gateway against it

`test/fedimint/topup.fedimint.test.ts` runs the gateway (in the test process, on a SQLite file) against the receiver binary as a child process and two `devfed` federations, with the admin CLI as a child process too:

```sh
cd services/fedimint-receiver && cargo build --features devfed --bins && cd ../..
pnpm test:fedimint        # FORGE_FEDIMINT_BIN_DIR: where the two binaries are (default: target/debug)
```

| Test | What it shows |
| --- | --- |
| joins the federation through `pnpm admin fedimint:join` | The invite on stdin; the row written active with the default caps; the invite in neither the CLI's output nor the receiver's log; the federation listed in `GET /v1/wallet/fund/methods`. |
| credits a top-up once, for exactly the net value | Real notes from the federation's own client; the receiver's record is `done` under the balance's key with a fee above 0; the balance, the answer and the receiver's balance all rose by `net_msat`, not the face value. |
| the same notes again | From the same balance: a replay, nothing more credited. From another balance (with its own invite): `token_spent`, no balance opened, the invite still open. |
| notes of a federation not joined | `federation_not_joined`; the notes are then spent by their own federation, so nothing took them. |
| a paused federation | Refused while paused, through the CLI; taken after `fedimint:resume`. |
| the caps | A federation's own `--max-sat` refuses larger notes (`amount_too_large`); a `--cap-sat` just above what the receiver holds refuses notes that would go over (`federation_full`) and the receiver's balance is unchanged; raised again, the same notes go in. |
| the gateway dies after its row, and after the receive | A crash point in the gateway, then a new gateway on the same database: startup recovery and the sweep credit the `done` record once, a retry is a replay, and a further restart credits nothing more. |
| the receiver down, then back | A top-up answered `topup_pending` while the federation works, the notes already dropped from the gateway's row; the receiver killed (SIGKILL): a sweep credits nothing, the same notes sent again answer `topup_pending` (the gateway finds its row by the notes id it works out itself), and new notes are refused with `fedimint_unavailable`, untouched; the receiver restarted on the same data and address: the sweep credits once, and the refused notes then go in. |
| the v2 app's top-up client | The app's own code (`public/v2/core/fedinote.js`, `engine.js`, `vault.js`, as the eCash box uses it) against the same gateway: it reads the methods and real notes as the gateway and the receiver do (the same amount and the same notes id), is credited once and then gets a replay with nothing left on the phone; notes of a federation it was not given are decided not taken on the phone and refused by the gateway the same way, then spent by their own federation; notes answered `topup_pending` stay on the phone through a receiver that goes down (the gateway answers `topup_pending` for notes already on their way, receiver down or not) and are credited once when it is back. |
| the operator's admin | `GET /admin/api/fedimint` against the real receiver: after real top-ups with real fees the receiver holds exactly what the gateway credited (reading Agrees, difference 0 msat), the fees are face value less credited, and take out coverage warns with the gateway holding no Cashu sat; joining a second federation by invite, its holdings cap, pause and resume through the admin API, each followed by the top-up; Check now finishing a top-up left on its way, once. |

A missing binary fails the file: nothing in it is skipped. Every branch of the gateway's side, including what the real receiver cannot be made to do on demand (`issuance_failed`, a lost answer, a 5xx, a pending record that waits), is in `test/unit/fedimint.test.ts` against a stand-in receiver.

In CI the `receiver` job runs the three cargo commands above, then builds the two binaries and runs `pnpm test:fedimint` on them, when anything under `services/fedimint-receiver/`, `src/fedimint.ts`, `src/fedimint-admin.ts` or `test/fedimint/` changes, and on every push to `main` ([CI.md](CI.md)).
