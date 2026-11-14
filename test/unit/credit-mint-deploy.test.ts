import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// deploy/credit-mint: nothing is deployed from here, but the files must say what docs/FREE-TIER.md says.
const dir = resolve(import.meta.dirname, '../../deploy/credit-mint');
const nginx = readFileSync(resolve(dir, 'nginx-credit-mint.conf'), 'utf8');
const compose = readFileSync(resolve(dir, 'docker-compose.yml'), 'utf8');

describe('credit mint deployment files', () => {
  it('make only info, keys, keysets, swap and checkstate public', () => {
    const open = [...nginx.matchAll(/^location\s+(=|~)\s+(\S+)\s.*proxy_pass/gm)].map((m) => m[2]);
    expect(open).toEqual(['/v1/info', '/v1/keys', '^/v1/keys/[0-9a-fA-F]+$', '/v1/keysets', '/v1/swap', '/v1/checkstate']);
    expect(nginx).toMatch(/^location \/ \{ return 404; \}$/m);
    expect(nginx).not.toMatch(/^location[^\n]*(mint|melt|restore)[^\n]*proxy_pass/m);
  });

  it('run Nutshell 0.22.1 in usd on this host only, with no secret in the file', () => {
    expect(compose).toContain('image: cashubtc/nutshell:0.22.1');
    expect(compose).toContain('ports: ["127.0.0.1:3348:3338"]');
    expect(compose).toContain('MINT_BACKEND_BOLT11_USD: FakeWallet');
    expect(compose).toContain('MINT_BACKEND_BOLT11_SAT: ""');
    expect(compose).not.toMatch(/MINT_MNEMONIC:/);
    expect(compose).not.toMatch(/MINT_PRIVATE_KEY/);
  });
});
