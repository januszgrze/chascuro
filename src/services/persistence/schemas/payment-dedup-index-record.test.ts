import { describe, expect, it } from 'vitest';

import { parsePaymentDedupIndexRecord } from './payment-dedup-index-record';

describe('payment deduplication index schema', () => {
  it('accepts unique encrypted ecash redemption fingerprints', () => {
    expect(
      parsePaymentDedupIndexRecord({
        version: 1,
        ecashRedemptions: [
          {
            fingerprint: 'sha256:abc',
            federationId: 'fed-a',
            operationId: 'operation-a',
            submittedAtMs: 123,
          },
        ],
      }).ecashRedemptions,
    ).toHaveLength(1);
  });

  it('rejects duplicate fingerprints and unexpected fields', () => {
    const entry = {
      fingerprint: 'sha256:abc',
      federationId: 'fed-a',
      operationId: 'operation-a',
      submittedAtMs: 123,
    };
    expect(() =>
      parsePaymentDedupIndexRecord({
        version: 1,
        ecashRedemptions: [entry, { ...entry, operationId: 'operation-b' }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      parsePaymentDedupIndexRecord({
        version: 1,
        ecashRedemptions: [{ ...entry, notes: 'secret' }],
      }),
    ).toThrow(TypeError);
  });
});
