# Security

Forge AI handles money (eCash and Lightning payments) and private questions. Reports of security problems are welcome and are taken seriously.

## Reporting a problem

Write to **security@forge-reserve.com**. Please do not open a public issue or pull request for a security problem.

Include what you can:

- what the problem is and what someone could do with it;
- the steps to reproduce it, or a proof of concept;
- the commit or release you tested, and whether you tested the hosted gateway at `ai.forge-reserve.com` or your own copy;
- how to reach you, and whether you would like to be credited.

## What to expect

- We answer within three working days to say the report arrived.
- We tell you what we found and what we plan to do, and keep you informed until it is fixed.
- When a fix is released we credit you, if you want that.

## Testing

- Test against your own copy where you can. The README and `docs/modules/first-module.md` say how to run the gateway and the test mints on your computer.
- On the hosted gateway, use only balances and eCash that are yours, keep the traffic low, and stop as soon as you have shown the problem. Do not read, change or spend anything that belongs to someone else.

## Scope

This repository: the gateway (`src/`), the web app (`public/`), and the Android and iPhone apps (`android/`, `ios/`). The mint, the model suppliers and the sealed hardware they run in are separate projects; a problem there is best reported to them, and we are glad to hear of it too.

`docs/PRIVACY.md` says what the gateway can and cannot see. A gap between that page and what the code does is a security problem: please report it.
