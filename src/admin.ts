/**
 * Admin CLI. Talks to the database directly; run it on the gateway host (or inside the container).
 *   pnpm admin invites:create [--count N] [--label TEXT]
 *   pnpm admin invites:list
 *   pnpm admin invites:revoke <invite-id|code>
 *   pnpm admin balances:list
 *   pnpm admin revenue:show
 *   pnpm admin revenue:export --unit usd|sat [--mint URL] [--amount N]
 *   pnpm admin prices:show [--unit usd|sat]
 */
import { parseArgs } from 'node:util';
import { loadConfig, type Unit } from './config.ts';
import { buildDeps } from './deps.ts';
import { setLogSilent } from './log.ts';
import { displayPrice, MSUB_PER_UNIT, msubToUnitsCeil } from './pricing.ts';

setLogSilent(true);
const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: { count: { type: 'string' }, label: { type: 'string' }, unit: { type: 'string' }, mint: { type: 'string' }, amount: { type: 'string' }, json: { type: 'boolean' } },
});

const config = loadConfig();
const d = buildDeps(config);

function table(rows: object[]) {
  if (values.json) console.log(JSON.stringify(rows, null, 2));
  else console.table(rows);
}

function revenue(unit: Unit) {
  const holdings = d.wallet.holdings().filter((h) => h.unit === unit);
  const unspent = holdings.reduce((s, h) => s + h.unspent, 0);
  const owed = holdings.reduce((s, h) => s + h.owed, 0);
  const liabilities = msubToUnitsCeil(d.ledger.liabilities()[unit] ?? 0);
  return { unit, holdings, unspent, owed, liabilities, sweepable: Math.max(0, unspent - owed - liabilities) };
}

switch (cmd) {
  case 'invites:create': {
    const n = Number(values.count ?? 1);
    const out = Array.from({ length: n }, () => d.invites.create(values.label));
    table(out.map((o) => ({ id: o.id, code: o.code })));
    console.error('Codes are shown once; only their hashes are stored.');
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
        created: new Date(a.created_at).toISOString(),
      })),
    );
    break;
  case 'revenue:show':
    table(
      config.env.FORGE_UNITS.map((u) => {
        const r = revenue(u);
        return { unit: u, wallet: r.unspent, owed_payouts: r.owed, customer_balances: r.liabilities, sweepable: r.sweepable };
      }),
    );
    break;
  case 'revenue:export': {
    const unit = (values.unit ?? 'usd') as Unit;
    const r = revenue(unit);
    const mint = values.mint ?? r.holdings.sort((a, b) => b.unspent - a.unspent)[0]?.mint;
    if (!mint) {
      console.error('no eCash held for this unit');
      process.exit(1);
    }
    const atMint = r.holdings.find((h) => h.mint === mint)?.unspent ?? 0;
    const max = Math.min(atMint, r.sweepable);
    const amount = values.amount ? Number(values.amount) : max;
    if (!Number.isInteger(amount) || amount < 1 || amount > max) {
      console.error(`amount must be 1..${max} ${unit} (wallet ${r.unspent}, owed ${r.owed}, customer balances ${r.liabilities})`);
      process.exit(1);
    }
    const id = d.wallet.oweRaw({ mint, unit, amount, purpose: 'export' });
    const token = await d.wallet.issue(id);
    console.error(`Exported ${amount} ${unit} from ${mint} (payout ${id}). Store this token safely:`);
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
        uncensored: m.uncensored,
      })),
    );
    if (rate) console.error(`BTC/USD ${rate} (markup ${config.env.FORGE_MARKUP})`);
    break;
  }
  default:
    console.error('commands: invites:create invites:list invites:revoke balances:list revenue:show revenue:export prices:show');
    process.exit(cmd ? 1 : 0);
}
d.db.close();
