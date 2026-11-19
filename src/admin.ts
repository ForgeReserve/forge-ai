/**
 * Admin CLI. Talks to the database directly; run it on the gateway host (or inside the container).
 *   pnpm admin invites:create [--count N] [--label TEXT]
 *   pnpm admin invites:list
 *   pnpm admin invites:revoke <invite-id|code>
 *   pnpm admin passes:create --uses N --expires YYYY-MM-DD[THH:MMZ] [--label TEXT] [--site URL]
 *   pnpm admin passes:list
 *   pnpm admin passes:revoke <pass-id|code>
 *   pnpm admin balances:list
 *   pnpm admin revenue:show
 *   pnpm admin revenue:export --unit usd|sat [--mint URL] [--amount N]
 *   pnpm admin prices:show [--unit usd|sat]
 *   pnpm admin fedimint:join [<invite>] [--max-sat N] [--cap-sat N]   (no invite: read from stdin)
 *   pnpm admin fedimint:list
 *   pnpm admin fedimint:pause <federation-id>
 *   pnpm admin fedimint:resume <federation-id>
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, type Unit } from './config.ts';
import { BetaWaitlist } from './beta.ts';
import { buildDeps } from './deps.ts';
import type { FederationRow, FedimintService } from './fedimint.ts';
import { setLogSilent } from './log.ts';
import { passExpiry } from './ledger.ts';
import { displayPrice, MSUB_PER_UNIT } from './pricing.ts';
import { ExportError, issueExport, oweExport, planExport, revenue } from './revenue.ts';

setLogSilent(true);
const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    count: { type: 'string' },
    label: { type: 'string' },
    unit: { type: 'string' },
    mint: { type: 'string' },
    amount: { type: 'string' },
    json: { type: 'boolean' },
    uses: { type: 'string' },
    expires: { type: 'string' },
    site: { type: 'string' },
    'max-sat': { type: 'string' },
    'cap-sat': { type: 'string' },
  },
});

/** The site an event link points to (passes:create --site), without a trailing slash. */
const SITE = 'https://ai.forge-reserve.com';

const config = loadConfig();
const d = buildDeps(config);

function fedimintOrExit() {
  if (!d.fedimint) {
    console.error('Fedimint is off: set FORGE_FEDIMINT_URL and FORGE_FEDIMINT_TOKEN (docs/FEDIMINT-RECEIVER.md, Turning it on)');
    process.exit(1);
  }
  return d.fedimint;
}

/** A federation's row as the operator sees it: never its invite code. */
function federationView(fm: FedimintService, f: FederationRow) {
  const c = fm.counts(f.id);
  return {
    id: f.id,
    name: f.name,
    state: f.state,
    receives: JSON.parse(f.receives).join(','),
    max_sat: f.max_sat ?? config.env.FORGE_FEDIMINT_MAX_SAT,
    cap_sat: f.cap_sat ?? config.env.FORGE_FEDIMINT_FEDERATION_CAP_SAT,
    credited_msat: c.credited_msat,
    pending: c.pending,
    stuck: c.stuck,
    joined_at: new Date(f.joined_at).toISOString(),
  };
}

function table(rows: object[]) {
  if (values.json) console.log(JSON.stringify(rows, null, 2));
  else console.table(rows);
}

switch (cmd) {
  case 'invites:create': {
    const n = Number(values.count ?? 1);
    const out = Array.from({ length: n }, () => d.invites.create(values.label));
    table(out.map((o) => ({ id: o.id, code: o.code })));
    console.error('Codes are shown once; only their hashes are stored.');
    break;
  }
  case 'beta:list':
    table(new BetaWaitlist(d.db).list().map((s) => ({ ...s, created_at: new Date(s.created_at).toISOString(), invited_at: s.invited_at ? new Date(s.invited_at).toISOString() : '' })));
    break;
  case 'beta:invited': {
    const ok = new BetaWaitlist(d.db).markInvited(positionals[0] ?? '');
    console.log(ok ? 'marked invited' : 'not found or already invited');
    break;
  }
  case 'passes:create': {
    const uses = Number(values.uses);
    const expiresAt = passExpiry(values.expires);
    if (!Number.isInteger(uses) || uses < 1 || !Number.isFinite(expiresAt)) {
      console.error('usage: passes:create --uses N --expires YYYY-MM-DD[THH:MMZ] [--label TEXT] [--site URL]');
      process.exit(1);
    }
    let p;
    try {
      p = d.passes.create({ maxUses: uses, expiresAt, label: values.label });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    const site = (values.site ?? SITE).replace(/\/+$/, '');
    table([{ id: p.id, code: p.code, uses, expires: new Date(p.expires_at).toISOString(), link: `${site}/j#${p.code}` }]);
    console.error('The code and link are shown once; only a hash of the code is stored. Put the link in the QR code.');
    break;
  }
  case 'passes:list':
    table(d.passes.list().map((p) => ({ ...p, expires_at: new Date(p.expires_at).toISOString(), created_at: new Date(p.created_at).toISOString() })));
    break;
  case 'passes:revoke': {
    const ok = d.passes.revoke(positionals[0] ?? '');
    console.log(ok ? 'revoked' : 'not found');
    break;
  }
  case 'invites:list':
    table(d.invites.list() as object[]);
    break;
  case 'invites:revoke': {
    const ok = d.invites.revoke(positionals[0] ?? '');
    console.log(ok ? 'revoked' : 'not found');
    break;
  }
  case 'balances:list':
    table(
      d.ledger.list().map((a) => ({
        id: a.id,
        unit: a.unit,
        balance: a.balance_msub / MSUB_PER_UNIT,
        reserved: a.reserved_msub / MSUB_PER_UNIT,
        frozen: d.ledger.isFrozen(a.id),
        created: new Date(a.created_at).toISOString(),
      })),
    );
    break;
  case 'revenue:show':
    table(
      config.env.FORGE_UNITS.map((u) => {
        const r = revenue(d, u);
        return { unit: u, wallet: r.unspent, other_mints: r.other_unspent, owed_payouts: r.owed, customer_balances: r.liabilities, sweepable: r.sweepable };
      }),
    );
    break;
  case 'revenue:export': {
    const unit = (values.unit ?? 'usd') as Unit;
    let plan;
    try {
      plan = planExport(d, unit, { mint: values.mint, amount: values.amount ? Number(values.amount) : undefined });
    } catch (e) {
      console.error(e instanceof ExportError ? e.message : String(e));
      process.exit(1);
    }
    const { id } = oweExport(d, { unit, mint: plan.mint, amount: plan.amount, source: 'cli' });
    const token = await issueExport(d, id);
    console.error(`Exported ${plan.amount} ${unit} from ${plan.mint} (export ${id}). Store this token safely:`);
    console.log(token);
    break;
  }
  case 'prices:show': {
    const unit = (values.unit ?? 'usd') as Unit;
    const rate = unit === 'sat' ? await d.rates.get() : undefined;
    if (unit === 'sat' && !rate) console.error('BTC/USD rate unavailable');
    table(
      config.catalog.models.map((m) => ({
        id: m.id,
        tier: config.catalog.suppliers[m.supplier]!.tier,
        [`in_${unit}_per_mtok`]: displayPrice(m.input_usd_per_mtok, config.env.FORGE_MARKUP, unit, rate)?.toFixed(unit === 'usd' ? 4 : 1),
        [`out_${unit}_per_mtok`]: displayPrice(m.output_usd_per_mtok, config.env.FORGE_MARKUP, unit, rate)?.toFixed(unit === 'usd' ? 4 : 1),
        verified: m.price_verified,
        pricing: m.pricing,
        uncensored: m.uncensored,
      })),
    );
    if (rate) console.error(`BTC/USD ${rate} (markup ${config.env.FORGE_MARKUP})`);
    break;
  }
  case 'fedimint:join': {
    // The invite code is a secret of sorts: it is never printed or logged. Read from stdin when not given,
    // so it stays out of the shell's history.
    const fm = fedimintOrExit();
    const invite = (positionals[0] ?? readFileSync(0, 'utf8')).trim();
    const sats = (v: string | undefined, name: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`--${name} must be a whole number of sats`);
        process.exit(1);
      }
      return n;
    };
    const caps = { maxSat: sats(values['max-sat'], 'max-sat'), capSat: sats(values['cap-sat'], 'cap-sat') };
    if (!invite) {
      console.error('usage: fedimint:join <invite> [--max-sat N] [--cap-sat N] (or the invite on stdin)');
      process.exit(1);
    }
    try {
      const r = await fm.join(invite, caps);
      table([federationView(fm, r.row)]);
      console.error(r.created ? 'Joined; Fedimint notes of this federation are taken from now on.' : `Already in the list (state ${r.row.state}); name and modules refreshed.`);
    } catch (e) {
      console.error(`could not join: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    break;
  }
  case 'fedimint:list': {
    const fm = fedimintOrExit();
    const joined = await fm.client.federations().catch((e) => (console.error(`the receiver did not answer: ${e instanceof Error ? e.message : String(e)}`), undefined));
    table(
      fm.federations().map((f) => {
        const j = joined?.find((x) => x.id === f.id);
        return { ...federationView(fm, f), joined: joined ? !!j : 'unknown', balance_msat: j?.balance_msat ?? null };
      }),
    );
    break;
  }
  case 'fedimint:pause':
  case 'fedimint:resume': {
    const fm = fedimintOrExit();
    const ok = fm.setState(positionals[0] ?? '', cmd === 'fedimint:pause' ? 'paused' : 'active');
    console.log(ok ? (cmd === 'fedimint:pause' ? 'paused' : 'active') : 'not found');
    if (!ok) process.exit(1);
    break;
  }
  default:
    console.error(
      'commands: beta:list beta:invited invites:create invites:list invites:revoke passes:create passes:list passes:revoke balances:list revenue:show revenue:export prices:show fedimint:join fedimint:list fedimint:pause fedimint:resume',
    );
    process.exit(cmd ? 1 : 0);
}
d.db.close();
