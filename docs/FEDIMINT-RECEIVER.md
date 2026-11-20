# Fedimint receiver

> **Off unless the operator turns it on.** `docker compose up` does not start the service, and the gateway calls it only once `FORGE_FEDIMINT_URL` is set ([Turning it on](#turning-it-on)). Then `POST /v1/wallet/topup` takes Fedimint notes as well as Cashu ([PAYMENTS.md, Fedimint notes](PAYMENTS.md#fedimint-notes)). The app does not offer it yet.

`services/fedimint-receiver` is a small Rust service that holds Fedimint eCash for the gateway. The gateway hands it notes a user pastes; the service checks them, reissues them into its own wallet, and says how much arrived. One process holds any number of federations. A federation is accepted once it has been joined: the joined federations are the allowlist.

It is built on `fedimint-client` 0.13.0 with the mint v1 and mintv2 client modules, pinned to exact versions, with `Cargo.lock` committed.

## What it does

- **Join** a federation by invite code. The service reads the federation's config from its guardians and refuses a federation with no mint module it speaks. Every join runs Fedimint's recovery for the wallet's seed, so a seed that held notes in that federation before gets them back.
- **Parse** notes without contacting any federation: their kind, value, federation, and a stable `notes_id`.
- **Receive** notes: reissue them into the wallet, once. The record of a receive is written to disk before the notes are submitted, so a crash at any point resumes after a restart without counting the notes twice.
- **Report balances**, per federation.
- **Back up and recover**: `fedimint-receiver backup`, `recover` and `restore-done` ([Backup and recovery](#backup-and-recovery)).

It does not send, pay invoices or leave a federation. Those come later. Its wallet can be rebuilt from its seed and the federations' invites ([Backup and recovery](#backup-and-recovery)).

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
{ "id": "5eb868aa...", "name": "Example", "modules": ["dummy", "ln", "mint", "wallet"], "receives": ["mint"], "restored_at": null, "restore_open": false, "already_joined": false }
```

`modules` is every module in the federation's config; `receives` is the kinds of notes this service takes from it. `restored_at` and `restore_open` say whether the federation's wallet was rebuilt from the seed, and whether that restore is still open ([The restore rule](#the-restore-rule)).

The join makes the federation's client with Fedimint's recovery and answers once the recovery has finished: a few seconds on a young federation, longer on one with a long history. It runs to its end even when the caller stops waiting (the gateway's client gives up after 15 seconds); asked again, it waits for that join or answers `already_joined`. When the recovery finds notes the seed already held, the data directory had lost them, and the federation is marked restored.

### `GET /federations`

`{"federations": [{"id", "name", "modules", "receives", "restored_at", "restore_open", "balance_msat"}, ...]}`, oldest join first.

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
| `failed` | `failure` says which: `rejected` (the federation refused the notes: spent elsewhere first, or invalid), `refused` (this client refused to submit them), or `issuance_failed` (the federation took the notes and this wallet cannot show that their value arrived: the new notes could not be issued, or, after a restore, the notes were found spent and this wallet may have spent them itself before its data was lost; an operator must look). `reason` is the client's text. |

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

1. **The receiver's secrets**, in `.env`: `FEDIMINT_RECEIVER_TOKEN` (for example `openssl rand -hex 24`), and `FEDIMINT_RECEIVER_MNEMONIC`, 12 BIP39 words with an offline copy ([The words](#the-words)). Without the variable the service makes its own words in its volume, and only the volume and its backups hold them.
2. **Start the receiver:** `docker compose --profile fedimint up -d --build fedimint-receiver` builds the image on the host and starts it. Compiling fedimint needs several GB of memory, so a small host uses the image CI publishes for every change to the receiver on `main` (the `Receiver image` workflow, [CI.md](CI.md#the-receivers-image)): `docker pull ghcr.io/forgereserve/forge-ai-fedimint-receiver@sha256:<digest>` with the digest that workflow run printed, `docker tag` it as `forge-ai-fedimint-receiver` (the name Compose gives the service's own build in a directory called `forge-ai`), then `docker compose --profile fedimint up -d --no-build fedimint-receiver`. It has no published port; the gateway reaches it on the compose network.
3. **Point the gateway at it**, in `.env`: `FORGE_FEDIMINT_URL=http://fedimint-receiver:8790`. The compose file gives the gateway the receiver's own token as `FORGE_FEDIMINT_TOKEN` unless that is set too. Optional: `FORGE_FEDIMINT_MAX_SAT` (largest top-up, default 100,000 sat) and `FORGE_FEDIMINT_FEDERATION_CAP_SAT` (most Forge holds of one federation, default 1,000,000 sat). Then recreate the gateway so it reads them: `docker compose --profile fedimint up -d`. The gateway refuses to start with a URL and no token, or with no `sat` in `FORGE_UNITS`.
4. **Join a federation.** With its invite code on stdin, so it stays out of the command line: `docker compose exec -T gateway node src/admin.ts fedimint:join < invite.txt` (or `--max-sat N` and `--cap-sat N` for this federation's own lower caps). On a federation with a long history the receiver's join can outlast the gateway's wait: the command then fails with `unreachable_receiver` while the receiver finishes, and run again a little later it completes. The gateway asks the receiver to join (the receiver reads the federation's config from its guardians and refuses one with no mint module it takes), then writes the federation's row, active. It prints the federation's id, name, the notes it takes and its caps, never the invite. Joining again refreshes the name and modules and keeps the state and caps unless new ones are given.
5. **Back up** the receiver and the invites ([Runbook](#runbook)), now and after every join.
6. **Check:** `docker compose exec gateway node src/admin.ts fedimint:list` shows each federation with `joined: true` and its balance at the receiver, and `GET /v1/wallet/fund/methods` lists it under `fedimint.federations`. Try one small top-up and watch for the `fedimint_topup_credited` log line before telling anyone.
7. **Stop taking one federation's notes:** `fedimint:pause <federation id>`; `fedimint:resume <federation id>` takes them again. Notes already on their way are finished.

**Turning it off.** Unset `FORGE_FEDIMINT_URL` and recreate the gateway: notes are no longer taken and the methods no longer list `fedimint`. Keep the receiver running while any Fedimint top-up is still `prepared` (`fedimint:list`, `pending`): with the URL unset the gateway does not ask about them, and they are finished only once it is set again.

**What each refusal means** for the person and the operator is in [PAYMENTS.md, Fedimint notes](PAYMENTS.md#fedimint-notes), with the solvency rule: take out stays Cashu, so Fedimint-funded sat balances are backed by Fedimint notes at the receiver, and Cashu take outs can fail with `wallet_insufficient` until the operator moves value from the receiver into Cashu. The admin page's Fedimint section warns when that can happen and suggests the amount; the move itself needs a pay route this service does not have yet ([ADMIN.md, Fedimint](ADMIN.md#fedimint)).

## Compatibility

**Fedimint client version:** 0.13.0 from crates.io, every fedimint crate the same release.

**Server versions:** the client negotiates API versions with the guardians at join and on start. This client asks for core API 0.0, mint v1 module API 0.0 and mintv2 module API 0.1 (read from the 0.13.0 sources). A federation whose guardians offer those majors at or above those minors negotiates. That says what the negotiation accepts, not that every older server answers every call this client makes: **no older fedimintd was run against it**, so the oldest working federation version is not established.

What is established for the federation Fedimint card tills use: a till's wallet runs fedimint 0.13.0-beta.1 against it. Compared file by file, the mint v1 client, the mintv2 client, `fedimint-api-client` and `fedimint-connectors` sources of 0.13.0 are identical to 0.13.0-beta.1, `fedimint-client` differs only in overflow checks on transaction amounts, and `fedimint-core` only in a supply cap on parsed amounts and in refusing non-empty vectors of zero-sized items. One change can refuse a federation: 0.13.0's mint v1 and mintv2 configs now accept a mint fee only of zero, or of a 100 msat base with at most 1,000 parts per million. A federation set up with other fees would fail to load in this client although the till's client loads it. The upstream code calls this the existing invariant of configs fedimintd makes, so it should not occur; it is not verified against that federation.

**The fedimint-sdk crate was not used.** `fedimint-sdk` 0.1.0 is published and pins fedimint 0.13.0, but its `Ecash::receive` picks the mintv2 module whenever a federation has one, so on a federation with both mints it refuses mint v1 notes (`NotSupported`); it submits and returns the operation in one call, so recording the operation id first would mean deriving fedimint's id outside the SDK anyway; it does not expose the notes' federation id prefix; and it reports a second receive of the same notes with the same code as malformed notes (`InvalidInput`). Each of these is something this service must get right. It uses the same seed derivation as fedimint-sdk and fedimint's own clients (12-word BIP39, `StandardDoubleDerive`), so the words work there too.

**Recovery** uses the mint modules' recovery endpoints (`recovery_count`, `recovery_slice`, `recovery_slice_hash`, `recovery_blind_nonce_outpoints`), which 0.13.0 guardians serve. A federation without them gets the older scan of signed sessions instead ([How recovery works](#how-recovery-works)); that path was not run.

## Storage and the seed

```text
<data>/
  lock                       held by the one process that serves or recovers the directory
  mnemonic                   only when the seed was generated here (mode 0600)
  seed-check                 fingerprint of the seed: a hash, not the words
  federations/<id>/
    federation.json          the invite it was joined with, its name, when, and any restore
    restore.json             only while `recover` rebuilds this federation
    client.db/               the fedimint client's RocksDB
  receives/<notes_id>.json   one record per receive; holds the notes only while pending
```

Directories are mode 0700 and files 0600. Each small file is written whole (temporary file, sync, rename), so a crash leaves the old version or the new one. A second service, or `recover`, on a directory in use is refused (the `lock` file).

**The seed.** In production set `FEDIMINT_RECEIVER_MNEMONIC` and keep an offline copy; the words are then never on the volume. Without it the service generates words into `<data>/mnemonic` on first start. `seed-check` makes the service refuse to start with a different seed than the directory was made with, or with none after it was made with one from the environment.

## Backup and recovery

Every note the receiver holds is derived from the wallet's seed. The value comes back from the seed and the federations' invite codes through Fedimint's own recovery. A backup carries what the seed cannot give back: the receive records the gateway's idempotency rests on, and the list of federations.

### How recovery works

Read from the fedimint 0.13.0 sources:

- `ClientPreview::recover` (`fedimint-client`, `src/client/builder.rs`) makes the federation's client and runs each module's recovery. Mint v1 (`fedimint-mint-client`, `recover_from_slices` in `src/lib.rs`) downloads the federation's recovery items (every note issued and every note spent, in order, from the `recovery_count` and `recovery_slice` endpoints) and keeps the issued notes whose blinded nonces it derives from the seed, looking 100 note indices past the last one found in each denomination. It then fetches their signatures and sets the note counters past them. Mintv2 (`fedimint-mintv2-client`, `src/lib.rs`) does the same over its own items and recognises its notes by a filter derived from the seed. A federation without the recovery endpoints gets the older scan of signed sessions, which is slower and sees only completed sessions.
- Fedimint's backups kept by the guardians (`backup_to_federation`, `download_backup_from_federation`) are not used: 0.13.0 marks them deprecated, as recovery made them unnecessary. The receiver passes no such backup to `recover`.
- Mint v1 cannot be used while it recovers (`RecoveryMode::Unusable`). When the recovery is done the receiver reopens the client with `ClientBuilder::open` and waits for the recovered notes' signatures before it reports a balance. Mintv2 recovers while usable, and the receiver waits for it the same way. Progress is saved in the client database, so a recovery that stops resumes on the next `recover`, join or start.
- `ClientHandle::restart` is not used for that reopen. In 0.13.0 it hands the client's federation-level secret to the builder as if it were the root secret: the federation key is derived a second time, and every note issued after it comes from keys the seed's recovery never looks at. The drill below found this.
- Every join runs the recovery. A plain join (`ClientPreview::join`) starts the note counters from zero, and fedimint's documentation warns against it for a seed that may have been used before. For a seed never used with the federation, the recovery finds nothing.

### What comes back

| | From the words and the invites | From a backup and the words |
| --- | --- | --- |
| Every note received, to the msat | yes | yes (the value always comes from the seed) |
| The federations | those whose invites are given | those in the backup |
| The receive records | none | as they were when the backup was made |
| A receive pending when the data was lost | its value, if the federation had finished it | its record too, which is submitted again |
| A generated mnemonic | (the words are the seed) | yes |

A backup does not hold the client databases, and they are never restored from a copy. The mint v1 client derives each new note from a counter kept in its database: a copy older than the last receive would offer the federation notes it has already seen (the federation refuses such a transaction, `BlindNonceAlreadyUsed`), and it would lack the notes received after it was made. Mintv2 picks its notes at random, but an old copy still lacks the newer ones. Recovery rebuilds both from the federation.

### A backup of a live directory

The receiver keeps two kinds of state: one RocksDB client database per federation, and its own small JSON files. A plain copy of a running RocksDB can catch its files between writes, and a consistent copy of a live one needs RocksDB's checkpoint. The backup leaves the databases out, so that question does not arise. Each small file is written whole (temporary file, sync, rename), so reading them while the service runs gets one whole version of each, and the files do not depend on one another. `fedimint-receiver backup` reads them into one JSON document:

```json
{ "format": "forge-fedimint-receiver-backup/1", "created_at": 1795000000, "version": "0.1.0", "seed_check": "...", "mnemonic": "(only for a generated seed)", "federations": [], "receives": [] }
```

It holds the invites, the notes of receives still pending and, for a generated seed, the words: keep it as carefully as the words. It goes to a new file with mode 0600 (`--out FILE`) or to standard output, which must not be a terminal; a summary with counts goes to standard error. A record the backup caught while pending is settled again after a restore, under the restore rule.

### After a restore: the gateway

What the gateway's sweep sees for each of its Fedimint top-ups once the receiver is rebuilt from the words alone. With a backup, the records it holds answer as they did before.

| The gateway's row | The gateway asks | The receiver answers | The row ends |
| --- | --- | --- | --- |
| `done` | nothing: the same notes again are a replay for the same balance and `token_spent` for another | | `done`, credited once |
| `prepared`, holding its notes (no answer had reached the gateway) | `POST /receive` with the notes | no record, so it receives them: `done` when the federation had not taken them; when it had, the federation calls them spent and the restore rule ends the receive `failed` with `issuance_failed` | credited once, or `stuck` |
| `prepared`, its notes dropped (the gateway had been told `pending`) | `GET /receive/{notes_id}` | `404` | stays `prepared`; the gateway logs `fedimint_receive_missing` at each sweep |
| `rejected` or `stuck` | nothing | | as it was |

Nothing is credited twice: the gateway credits only on a `done` record, in the step that moves its row from `prepared` to `done`. No credit is lost: no row whose notes this wallet may hold ends `rejected`, and their value is in the recovered balance. The receiver never sends, so its balance in a federation is the sum of `net_msat` over every receive that went through. `fedimint:list` shows that balance next to what the gateway credited (`credited_msat`); the difference is the value of the stuck and pending top-ups that reached the wallet. The gateway has no command yet to settle such a row by hand. Until it has one, those rows stay `stuck` or `prepared`, counted in `fedimint:list`.

### The restore rule

After a restore the receiver cannot tell its own spend of a set of notes from someone else's: the records that would say so are gone. So while a federation's restore is open, a receive the federation rejects as spent ends `failed` with `issuance_failed`, a reason that names the restore, and no credit. A record older than the restore (one a backup brought back) ends that way even after the restore is closed. `recover` opens the restore, and so does a join whose recovery finds notes the seed already held. `fedimint-receiver restore-done FEDERATION_ID` (or `--all`) closes it; from then on, notes someone else spent are `rejected` again. While it is open, notes a person spent elsewhere also end `stuck` at the gateway: safe, and more work for the operator, so close it once the reconciliation is done.

### The words

`FEDIMINT_RECEIVER_MNEMONIC` holds 12 BIP39 words, the seed of every federation's wallet, derived the way fedimint's own clients derive it (`StandardDoubleDerive`). Make them with a BIP39 tool you trust on a machine kept offline, write them down, and keep that copy offline and apart from the backups. The receiver can also make them: started without the variable on an empty volume, it writes them to `/data/mnemonic` (mode 0600); `docker compose cp fedimint-receiver:/data/mnemonic ./words` copies them out to be written down, and the copy is then deleted. Such words stay in the volume and every backup holds them.

The words never reach a log or an API answer, and a backup holds them only when they were generated in the volume. `seed-check` keeps a hash of them, and a receiver started with other words than its directory was made with refuses to start. `recover` never makes new words: without the variable or a backup holding generated words, it stops.

### Runbook

The commands below run on the gateway's host, from the repository root. None of them prints the words, an invite or a note.

**Back up.** After every join, and on a schedule (hourly is plenty: a backup's age bounds how many receive records a restore lacks, never the balance).

1. `(umask 077; docker compose --profile fedimint exec -T fedimint-receiver fedimint-receiver backup > fedimint-backup-$(date -u +%Y%m%dT%H%M%SZ).json)`. The receiver keeps running. Standard error shows the counts.
2. `(umask 077; docker compose exec -T gateway node src/fedimint-invites.ts > fedimint-invites.txt)`. The gateway's federations, paused ones too, one invite a line after a comment with its id.
3. Move both files off the host, to a place apart from the written words. Keep several generations.

**Restore from a backup and the words.** The receiver's volume is lost or damaged.

1. Stop the receiver: `docker compose --profile fedimint stop fedimint-receiver`. Leave the gateway running: it answers `fedimint_unavailable` to new notes, which spends nothing, and its sweep waits.
2. Start from an empty volume: `docker compose --profile fedimint rm -f fedimint-receiver`, then `docker volume rm <project>_fedimint-data` (`docker volume ls` shows the name).
3. Check that `.env` has the same `FEDIMINT_RECEIVER_MNEMONIC` as before. For words the receiver generated, the backup holds them and the variable stays unset.
4. `docker compose --profile fedimint run --rm -T fedimint-receiver recover --backup - < fedimint-backup-<time>.json`. The federations must be reachable. It prints one JSON line per federation (`rebuilt`, `balance_msat`, `restore_open`), then the number of records. For a line with `error`, run `docker compose --profile fedimint run --rm -T fedimint-receiver recover` again once that federation answers: it resumes.
5. For a federation joined after the backup was made, run `recover --invites - < fedimint-invites.txt` the same way.
6. Start the receiver: `docker compose --profile fedimint up -d fedimint-receiver`. Then the checks below.

**Restore from the words alone.** No backup is at hand.

1. Steps 1 to 3 above.
2. Export the invites from the gateway (step 2 of the backup) unless a recent copy is at hand.
3. `docker compose --profile fedimint run --rm -T fedimint-receiver recover --invites - < fedimint-invites.txt`
4. Start the receiver, then the checks below. The receive records are gone: [After a restore: the gateway](#after-a-restore-the-gateway) says what follows.

**Check afterwards.**

1. `docker compose exec gateway node src/admin.ts fedimint:list`: every federation `joined: true`, with the `balance_msat` that `recover` printed.
2. In each federation, `balance_msat` is at least `credited_msat`. The difference is the value of the top-ups that reached the wallet without a credit: after the next sweep (every 30 seconds) they are the `stuck` and `pending` counts.
3. In the gateway's log, `fedimint_issuance_failed` names each top-up the restore rule held, and `fedimint_receive_missing` each pending one whose record was lost. Note them with their amounts; they are what the difference in step 2 is made of.
4. One small top-up, and watch for `fedimint_topup_credited`.
5. Once a few sweeps have run and every top-up from before the restore is `done`, `stuck` or in your notes, close the restore: `docker compose --profile fedimint exec fedimint-receiver fedimint-receiver restore-done --all`.
6. Make a new backup.

**Moving the receiver to another host** with its state: stop it, copy the whole volume (the databases are final once it has stopped), start it on the new host, and never start the old copy again, as its note counters would fall behind. In every other case, restore as above.

**What was not verified.** Recovery against a real federation, or one older than 0.13.0; how long it takes on a federation with a long history; the older scan of signed sessions; a federation going down while `recover` runs (the command waits for it); Fedimint's guardian backups, which are not used.

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
| `the_seed_and_the_invites_bring_every_note_back_and_old_notes_credit_nothing` | The drill from the words alone: mint v1 and mintv2 notes received in two federations, the data directory deleted, `recover --invites -` with both invites (comments and blank lines in the file) prints each balance back to the msat and no invite or word; a second `recover` only reports. On the rebuilt directory the old notes end `failed`, `issuance_failed`, with no credit, and a repeat gives the same record; new notes of both kinds go in (the recovered counters reuse no note); notes spent elsewhere are uncertain while the restore is open and `rejected` once `restore-done --all` closes it. |
| `a_backup_and_the_seed_bring_the_records_back_too` | A generated seed. A receive cut off between its record and its submission; `backup --out` with the service stopped (0600, counts on standard error, the words never printed, an existing file never overwritten); the directory deleted; `recover --backup` brings the words, the records and the balance back; the cut off receive is submitted and ends `done`; a done record answers a repeat with its first key and nothing more. Then a backup of the running service, edited as if it had caught a receive while pending: after the restore that receive's notes are spent (by this wallet, before the loss), and the record ends `issuance_failed` even with the restore closed; the balance is whole. |
| `a_join_with_a_seed_that_already_holds_notes_recovers_them` | The same words on an empty directory, joined again over HTTP: the join runs on after its caller gives up at 200 ms and is there when asked again; the balance is back, the federation is marked restored, the old notes end uncertain and new notes go in. |
| `the_recovery_commands_refuse_what_could_lose_track_of_value` | `recover` with no words makes none and stops; an invite that is not one; a second service and `recover` on a directory in use are refused; `backup` of a running service to a pipe holds no words from the environment; a backup goes only into an empty directory, and not under other words; `restore-done` of a federation not joined; `backup` of what is no data directory. |

Unit tests cover reading notes (encodings, ids, a repeated note, junk) and the seed rules.

**Not covered by a test:** `ambiguous_federation` (it needs two federations whose ids share 4 bytes); `fee_exceeds_value` (the test federations' wallets round notes up to economical sizes); `unreachable` on join; `issuance_failed` from a failed issuance (the restore rule's is covered); a federation that is down while a receive is pending, or while `recover` runs; recovery from the older scan of signed sessions; any federation older than 0.13.0; a real federation of any kind.

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

`test/fedimint/recovery.fedimint.test.ts` is the recovery drill with the gateway, the receiver (with its words from the environment) and one `devfed` federation:

| Test | What it shows |
| --- | --- |
| takes top-ups, and leaves two of them on their way | One top-up credited; one whose answer the gateway never handled (a crash point after the receive: its row keeps the notes); one answered `topup_pending` (its row drops the notes). No sweep runs until the loss, and both receives end `done` at the receiver. |
| exports the invites | `node src/fedimint-invites.ts --out FILE`: a new 0600 file, the invite after a comment with the federation's id and state, nothing printed, an existing file refused. |
| rebuilds the wallet from the words and the invites | The receiver's data directory deleted; `fedimint-receiver recover --invites FILE` prints the balance from before the loss, to the msat, with the restore open; the receiver starts on it at the same address. |
| credits nothing twice and refuses nothing the wallet holds | The sweep: the row that held its notes ends `stuck` (the restore rule), the other stays `prepared`; no balance moves; the credited notes again are a replay from their balance and `token_spent` from another; `fedimint:list` shows one pending and one stuck, and the receiver's balance less what was credited is exactly the two undecided top-ups; new notes are credited as before. |

A missing binary fails either file: nothing in them is skipped. Every branch of the gateway's side, including what the real receiver cannot be made to do on demand (`issuance_failed`, a lost answer, a 5xx, a pending record that waits), is in `test/unit/fedimint.test.ts` against a stand-in receiver.

In CI the `receiver` job runs the three cargo commands above, then builds the two binaries and runs `pnpm test:fedimint` on them, when anything under `services/fedimint-receiver/`, `src/fedimint.ts`, `src/fedimint-admin.ts`, `src/fedimint-invites.ts` or `test/fedimint/` changes, and on every push to `main` ([CI.md](CI.md)). The recovery drill rides in that job, with no build step of its own: `tests/recovery.rs` is one more test binary of the crate, and the gateway's drill one more file in `test/fedimint/`.
