/**
 * An agent that pays for its own inference with eCash, using NUT-24 (HTTP 402) end to end.
 *
 *   FORGE_URL=http://localhost:8787 FORGE_INVITE=inv-... MODEL=mock-echo \
 *   CASHU_TOKEN=cashuB...            # eCash to spend from (any trusted mint), or:
 *   DEMO_FAKE_MINT=1                 # mint test eCash from a FakeWallet mint named in the 402
 *   pnpm demo:agent "What is eCash?"
 *
 * Steps: call with no credentials -> 402 + X-Cashu payment request (NUT-18 creqA) -> build a token
 * for the requested amount at an accepted mint -> retry with X-Cashu: cashuB... -> answer + change.
 */
import { getEncodedToken, getTokenMetadata, PaymentRequest, type Proof, Wallet } from '@cashu/cashu-ts';

const FORGE = process.env.FORGE_URL ?? 'http://localhost:8787';
const MODEL = process.env.MODEL ?? 'mock-echo';
const prompt = process.argv[2] ?? 'In one sentence, what is eCash?';
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (process.env.FORGE_INVITE) headers['X-Forge-Invite'] = process.env.FORGE_INVITE;
const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 128 });

// 1. Ask without paying.
const first = await fetch(`${FORGE}/v1/chat/completions`, { method: 'POST', headers, body });
if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${await first.text()}`);
const pr = PaymentRequest.fromEncodedRequest(first.headers.get('x-cashu')!);
const amount = pr.amount!.toNumber();
console.log(`402 Payment Required: ${amount} ${pr.unit === "usd" ? "cents (usd)" : "sat"} from one of ${pr.mints?.join(', ')}`);

// 2. Get proofs worth exactly `amount` at an accepted mint.
async function fundedProofs(): Promise<{ wallet: Wallet; proofs: Proof[] }> {
  if (process.env.CASHU_TOKEN) {
    const meta = getTokenMetadata(process.env.CASHU_TOKEN);
    if (!pr.includesMint(meta.mint)) throw new Error(`CASHU_TOKEN is from ${meta.mint}, not an accepted mint`);
    const wallet = new Wallet(meta.mint, { unit: pr.unit });
    await wallet.loadMint();
    return { wallet, proofs: await wallet.receive(process.env.CASHU_TOKEN) };
  }
  if (process.env.DEMO_FAKE_MINT) {
    const wallet = new Wallet(pr.mints![0]!, { unit: pr.unit });
    await wallet.loadMint();
    const q = await wallet.createMintQuoteBolt11(amount + 10);
    await new Promise((r) => setTimeout(r, 300)); // FakeWallet pays the quote itself
    return { wallet, proofs: await wallet.mintProofsBolt11(amount + 10, q.quote) };
  }
  throw new Error('set CASHU_TOKEN (or DEMO_FAKE_MINT=1 against a FakeWallet test mint)');
}
const { wallet, proofs } = await fundedProofs();
const { send, keep } = await wallet.send(amount, proofs, { includeFees: true });
const payment = getEncodedToken({ mint: wallet.mint.mintUrl, unit: pr.unit, proofs: send });

// 3. Retry with the payment.
const paid = await fetch(`${FORGE}/v1/chat/completions`, { method: 'POST', headers: { ...headers, 'X-Cashu': payment }, body });
const json = await paid.json();
if (!paid.ok) throw new Error(`payment rejected: ${paid.status} ${JSON.stringify(json)}`);
console.log(`\nAnswer: ${json.choices[0].message.content}`);
const unitName = pr.unit === "usd" ? "cents" : "sat";
console.log(`Charged: ${Number(paid.headers.get("x-forge-charged-msub")) / 1000} ${unitName}`);

// 4. Take the change back.
let change = 0;
const changeToken = paid.headers.get('x-cashu-change');
if (changeToken) {
  const back = await wallet.receive(changeToken);
  change = back.reduce((s, p) => s + p.amount.toNumber(), 0);
  keep.push(...back);
}
console.log(`Change returned: ${change} ${unitName}; wallet now holds ${keep.reduce((s, p) => s + p.amount.toNumber(), 0)} ${unitName}`);
