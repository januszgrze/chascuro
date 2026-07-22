import { describe, expect, it } from 'vitest';

import { classifyWalletInput } from './input';

describe('wallet input classifier', () => {
  it('classifies supported payload families without acting on them', () => {
    expect(classifyWalletInput('lntb1example').kind).toBe('bolt11');
    expect(classifyWalletInput('fed1example').kind).toBe('federation_invite');
    expect(classifyWalletInput('fedimint-ecash:example').kind).toBe('ecash');
    expect(classifyWalletInput('https://example.com').kind).toBe('unsupported');
  });

  it('classifies Lightning Addresses and LNURL-pay inputs lexically', () => {
    expect(classifyWalletInput('alice@example.com')).toMatchObject({
      kind: 'lightning_address',
      input: 'alice@example.com',
    });
    expect(classifyWalletInput('alice+tips@example.com').kind).toBe(
      'lightning_address',
    );
    expect(classifyWalletInput('LNURL1DP68GURN8GHJ7').kind).toBe('lnurl');
    expect(classifyWalletInput('lightning:LNURL1DP68GURN8GHJ7')).toMatchObject({
      kind: 'lnurl',
      input: 'LNURL1DP68GURN8GHJ7',
    });
    expect(classifyWalletInput('lnurlp://pay.example/callback').kind).toBe(
      'lnurl',
    );
    expect(classifyWalletInput('lightning:lntb1example')).toMatchObject({
      kind: 'bolt11',
      input: 'lntb1example',
    });
  });

  it('rejects email-like values outside the Lightning Address grammar', () => {
    expect(classifyWalletInput('Alice@example.com').kind).toBe('unsupported');
    expect(classifyWalletInput('alice@example').kind).toBe('unsupported');
    expect(classifyWalletInput('alice@example..com').kind).toBe('unsupported');
    expect(classifyWalletInput('alice+@example.com').kind).toBe('unsupported');
    expect(classifyWalletInput('alice@example_com').kind).toBe('unsupported');
  });

  it('rejects empty and oversized payloads before parser work', () => {
    expect(() => classifyWalletInput('  ')).toThrow(TypeError);
    expect(() => classifyWalletInput('x'.repeat(64 * 1024 + 1))).toThrow(
      TypeError,
    );
  });
});
