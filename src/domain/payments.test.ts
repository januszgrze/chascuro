import { describe, expect, it } from 'vitest';

import { federationId } from './federation';
import { msats } from './money';
import {
  clearableSecretText,
  confirmEcashSpend,
  confirmLightningQuote,
  confirmPortfolioLightningPaymentPlan,
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

  it('binds a combined payment confirmation to its invoice and aggregate fee', () => {
    const fingerprint = paymentFingerprint('portfolio-target');
    const route = (id: string) => ({
      federationId: federationId(id),
      federationDisplayName: id,
      gatewayId: `gateway-${id}`,
      balanceMsats: msats(20_000n),
      feeMsats: msats(1_000n),
      vetted: true,
    });
    const plan = {
      planId: quoteId('portfolio-plan'),
      targetFingerprint: fingerprint,
      amountMsats: msats(100_000n),
      expiresAtMs: 2_000,
      maximumTotalFeeMsats: msats(3_000n),
      estimatedTotalFeeMsats: msats(2_000n),
      transferAmountMsats: msats(31_000n),
      transferFeeMsats: msats(1_000n),
      finalPaymentFeeMsats: msats(1_000n),
      sinkRoute: route('fed-a'),
      sourceRoute: route('fed-b'),
    };

    expect(
      confirmPortfolioLightningPaymentPlan(plan, fingerprint, 1_000).plan,
    ).toBe(plan);
    expect(() =>
      confirmPortfolioLightningPaymentPlan(
        { ...plan, estimatedTotalFeeMsats: msats(4_000n) },
        fingerprint,
        1_000,
      ),
    ).toThrow(RangeError);
  });
});
