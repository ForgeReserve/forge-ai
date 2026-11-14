# Credit mint

The credit mint makes credits: Cashu eCash that pays for free questions and nothing else (docs/FREE-TIER.md). It is a separate Nutshell mint beside the Forge mint. Nothing in this folder is deployed by the repository. These are the files and the steps for the owner.

## What is here

- `docker-compose.yml`: Nutshell 0.22.1 on `127.0.0.1:3348`, usd unit, FakeWallet backend.
- `nginx-credit-mint.conf`: location blocks for the public address. Only info, keys, keysets, swap and checkstate are reachable. Minting and melting are blocked.

## The unit

Nutshell 0.22.1 takes only these units: sat, msat, usd, eur, btc and auth. There is no custom unit. So the credit mint uses usd, and 1 credit is 1 cent of usd. The gateway treats every token from this mint as credits, whatever the unit says.

This was checked by reading the `Unit` enum inside the `cashubtc/nutshell:0.22.1` image.

## Why FakeWallet

FakeWallet marks the mint's own quotes paid, so credits cost nothing to issue. That is only safe while nobody outside can reach `/v1/mint` or `/v1/melt`. Keep the nginx blocks, and never publish port 3348.

## Steps

1. On the mint host, make `credit-mint.env` in this folder with mode 0600 and one line: `MINT_MNEMONIC="<12 new words>"`. Keep the words offline. Never commit the file.
2. `docker compose up -d` in this folder. Check `curl -s http://127.0.0.1:3348/v1/keysets` shows one usd keyset.
3. Add a DNS name for the credit mint (for example `credits.forge-reserve.com`), get a certificate, and put the blocks from `nginx-credit-mint.conf` in its `server { }` block. Reload nginx.
4. From outside, check: `/v1/info` and `/v1/keysets` answer; `POST /v1/mint/quote/bolt11` and `POST /v1/melt/quote/bolt11` answer 404.
5. On the gateway, set `FORGE_CREDIT_MINT=https://credits.forge-reserve.com`. If the gateway runs on the mint host, also set `FORGE_CREDIT_MINT_ISSUE_URL=http://127.0.0.1:3348` so the faucet can mint. A gateway on another host can mint only through a private route to port 3348; without one, leave the faucet off.
6. Pick the free models (`FORGE_FREE_MODELS`) and caps (`FORGE_FREE_MAX_INPUT_TOKENS`, `FORGE_FREE_MAX_OUTPUT_TOKENS`). Free balances work from this point: vouchers made with `pnpm issue-credits` can be added.
7. To give out free questions on the website, set `FORGE_FAUCET_ENABLED=true` and the budget (`FORGE_FAUCET_DAILY_VOUCHERS`, `FORGE_FAUCET_QUESTIONS`, `FORGE_FAUCET_DRIPS_PER_DAY`, `FORGE_FAUCET_POW_BITS`, `FORGE_FAUCET_PER_ADDRESS`). The page is at `/free`.

## Printing vouchers

On the mint host: `pnpm issue-credits --mint http://127.0.0.1:3348 --public-mint https://credits.forge-reserve.com --count 50 --questions 3`. It writes a sheet in the paper note layout with file mode 0600. Print it, cut it, delete the file.

## Retiring credits

Rotate the credit mint's keyset (Nutshell's management RPC has `RotateNextKeyset`, which can also set a `final_expiry`). The gateway takes a keyset for `FORGE_CREDIT_KEYSET_DAYS` (90 by default) after it first saw it, or until the keyset's own `final_expiry`, whichever comes first. After that, credits from it are refused.

## Recovery

`/v1/restore` is not public. The gateway's crash recovery first replays an interrupted swap (NUT-19), which works through `/v1/swap`. A restore (NUT-09) would only be needed if the replay fails; a gateway on the mint host can reach it on 127.0.0.1.

## Not verified

None of this has run in production: not the DNS name, the certificate, the nginx blocks on a live server, or a gateway minting faucet vouchers there. The tests run the same Nutshell image locally (`pnpm mint:up` starts `mint-credit` on port 3341).
