# Admin page

`/admin/` is the operator page: revenue and liabilities, revenue export as eCash, invites, the beta waitlist, balances (with freeze), fundings, the request log and a read-only view of the settings. It is a plain page in `public/admin/` that talks to `/admin/api/*` (`src/admin-api.ts`). The CLI (`pnpm admin ...`) keeps working and shares the revenue code (`src/revenue.ts`).

## Access control

Money moves through this page, so it sits behind two independent locks:

1. **Caddy basic auth** on `/admin*` (production). The bcrypt hash comes from the environment at deploy time and is never committed. Caddy refuses to start without it, and `docker compose` stops with an error before starting anything.
2. **The gateway's admin token.** `FORGE_ADMIN_TOKEN_HASH` is the SHA-256 (hex) of a random token. Without it, everything under `/admin` answers 404. With it, every `/admin/api` request must send the token, or it gets 401. The page asks for the token once and keeps it in `sessionStorage` (that tab only). It sends it as `X-Forge-Admin-Token`, because the browser uses the `Authorization` header for Caddy's basic auth. `Authorization: Bearer <token>` is also accepted for scripts that reach the gateway without Caddy.

Also enforced by the gateway, whatever the proxy does:

- Changes (POST, DELETE) need a same-origin `Origin` header (`FORGE_ADMIN_ORIGIN` when set, else the request's `Host`) and a JSON body. A `Sec-Fetch-Site` other than `same-origin` is refused.
- No CORS: admin routes never send `Access-Control-*` headers.
- A separate rate limit (`FORGE_ADMIN_RATE_LIMIT_RPM`, default 120 per IP) and at most 10 failed token checks a minute per IP.
- `Cache-Control: no-store`, `X-Frame-Options: DENY` and a strict CSP (no inline script or style, nothing from other origins) on the page.
- Every action is logged as `admin_action` with its name, ids, counts and amounts. Tokens, invite codes and contacts are never logged.

## Deploy

On the droplet, in the repo directory:

```sh
# 1. Admin token: keep it in your password manager. Only its hash goes into .env.
TOKEN=$(openssl rand -base64 32 | tr -d '=+/')
echo "admin token: $TOKEN"
printf 'FORGE_ADMIN_TOKEN_HASH=%s\n' "$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)" >> .env
echo 'FORGE_ADMIN_ORIGIN=https://ai.forge-reserve.com' >> .env
unset TOKEN

# 2. Basic auth password: also in your password manager. Caddy prompts for it twice.
HASH=$(docker run --rm -it caddy:2 caddy hash-password | tr -d '\r')
echo 'FORGE_ADMIN_BASIC_AUTH_USER=forge' >> .env
# Single quotes: a bcrypt hash contains "$", which compose would otherwise expand.
printf "FORGE_ADMIN_BASIC_AUTH_HASH='%s'\n" "$HASH" >> .env
unset HASH

# 3. Restart both containers with the new Caddyfile and environment.
docker compose up -d --build
```

Then open `https://ai.forge-reserve.com/admin/`, sign in to the browser prompt (basic auth), and paste the admin token.

Checks after deploying:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://ai.forge-reserve.com/admin/                 # 401 (basic auth)
curl -s -o /dev/null -w '%{http_code}\n' -u forge:<password> https://ai.forge-reserve.com/admin/api/session   # 401 (no token)
curl -s -o /dev/null -w '%{http_code}\n' https://ai.forge-reserve.com/v1/models              # 200 (public API untouched)
```

To rotate the token, replace `FORGE_ADMIN_TOKEN_HASH` and run `docker compose up -d gateway`. To turn the admin page off, remove it: everything under `/admin` then answers 404.

## What each section does

- **Overview:** per unit: revenue collected (settled requests), sweepable, customer balances (and active reservations), owed payouts by purpose, and the wallet at trusted mints and at other mints (eCash held for other-mint fundings, never sweepable). Requests, tokens and revenue for today (UTC), 7 and 30 days by model, tier and supplier, from the `requests` table. Supplier cost is estimated as revenue / `FORGE_MARKUP`, since catalog prices include the markup. Health: the BTC/USD rate and its age, supplier keys (a supplier whose key env var is unset has no models), each mint's `GET /v1/info` (cached 30 s), open and due fundings, the shared quote-check budget and any 429 pause, unfinished exports.
- **Export:** the same computation as `pnpm admin revenue:export`: sweepable = eCash at trusted mints - owed payouts - customer balances (rounded up). Preview shows the exact amount, mint and lock; the export call must echo them back. The export becomes an owed payout and a `revenue_exports` row in one transaction that re-checks the amount, then goes through the normal payout machinery (NUT-19 replay, NUT-09 restore). An export interrupted by a crash counts as owed, is finished by startup recovery, and its token can be fetched once with **Finish**. A delivered token is never shown again. Optional P2PK lock to your key (`02.../03...` or `npub`): only that key can redeem it. History keeps time, unit, amount, lock and the token's SHA-256, never the token. (As for every payout, the `outgoing` row keeps the token for crash re-delivery.)
- **Invites:** create (codes shown once, stored hashed), list with status and usage, revoke. A revoked invite cannot open a balance or pay per request.
- **Waitlist:** **Invite** makes one invite code (labelled with the signup id, not the contact), marks the signup invited and shows a message with the code and `https://ai.forge-reserve.com`: an email draft (`mailto:`) for addresses, a copyable message for npubs. **Delete** removes the signup row on request.
- **Balances:** id, unit, balance, reserved, created, last used, funding and request counts, search by balance or invite id. **Freeze** blocks all spending from the balance (`account_frozen`, 403); topups, fundings and refunds still work. Keys are not stored and never shown.
- **Fundings:** unfinished, failed and expired fundings with method, amount, state, error and age. **Re-check now** advances one funding; for an unpaid quote it uses the same shared quote-check budget as the poller and answers 429 while the budget is used up or the mint has asked us to slow down.
- **Requests:** the latest requests (id, time, model, tier, encrypted, tokens, charged, status, latency). No content is stored, so none is shown.
- **Settings:** read-only: invite-only, units, markup, mints, funding caps and methods, rate limits, suppliers with key status, models with cost and sale prices.
