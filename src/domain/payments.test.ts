import { describe, expect, it } from 'vitest';

import { msats } from './money';
import {
  clearableSecretText,
  confirmEcashSpend,
  confirmLightningQuote,
  normalizeMnemonicWords,
  paymentFingerprint,
  quoteId,
  secretMnemonic,
  sensitiveInput,
  type LightningQuote,
} from './payments';

describe('payment domain', () => {
  it('bounds and normalizes sensitive input', () => {
    expect(sensitiveInput('  lntb1example  ')).toBe('lntb1example');
    expect(() => sensitiveInput('')).toThrow(TypeError);
    expect(() => sensitiveInput('abcd', 3)).toThrow(TypeError);
    expect(() => sensitiveInput('abc\0def')).toThrow(TypeError);
  });

  it('keeps clearable secrets out of JSON and rejects reads after clear', () => {
    const secret = clearableSecretText('bearer-secret');

    expect(secret.reveal()).toBe('bearer-secret');
    expect(JSON.stringify({ secret })).not.toContain('bearer-secret');
    secret.clear();
    expect(secret.length).toBe(0);
    expect(() => secret.reveal()).toThrow();
  });

  it('normalizes supported mnemonic shapes without serializing words', () => {
    const words = Array.from({ length: 12 }, (_, index) => `word${index}`);
    expect(() => normalizeMnemonicWords(words)).toThrow(TypeError);

    const valid = Array.from({ length: 12 }, () => 'abandon');
    const mnemonic = secretMnemonic(valid);
    expect(mnemonic.wordCount).toBe(12);
    expect(mnemonic.reveal()).toEqual(valid);
    expect(JSON.stringify(mnemonic)).toBe('"[redacted]"');
    mnemonic.clear();
    expect(() => mnemonic.reveal()).toThrow();
  });

  it('binds Lightning confirmation to a live fingerprint and fee bound', () => {
    const fingerprint = paymentFingerprint('invoice-fingerprint');
    const quote: LightningQuote = {
      quoteId: quoteId('quote-1'),
      invoiceFingerprint: fingerprint,
      amountMsats: msats(10_000n),
      feeMsats: msats(100n),
      maximumFeeMsats: msats(200n),
      expiresAtMs: 2_000,
    };

    expect(confirmLightningQuote(quote, fingerprint, 1_000).quote).toBe(quote);
    expect(() =>
      confirmLightningQuote(
        quote,
        paymentFingerprint('different-invoice'),
        1_000,
      ),
    ).toThrow(RangeError);
    expect(() => confirmLightningQuote(quote, fingerprint, 2_000)).toThrow(
      RangeError,
    );
    expect(() =>
      confirmLightningQuote(
        { ...quote, amountMsats: msats(0n) },
        fingerprint,
        1_000,
      ),
    ).toThrow(RangeError);
  });

  it('rejects a zero-value ecash spend intent', () => {
    expect(() =>
      confirmEcashSpend(
        {
          amountMsats: msats(0n),
          includeFederationInvite: true,
        },
        1_000,
      ),
    ).toThrow(RangeError);
  });
});
