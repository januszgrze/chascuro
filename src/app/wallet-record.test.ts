import { describe, expect, it } from 'vitest';

import { createPersistedWalletRecord, serializeBigInts } from './wallet-record';

describe('wallet record serialization', () => {
  it('stores the wallet mode and omits an absent federation', () => {
    expect(createPersistedWalletRecord('fake')).toEqual({
      version: 1,
      mode: 'fake',
    });
  });

  it('serializes bigint values as decimal strings before vault encryption', () => {
    expect(
      serializeBigInts({
        amountMsats: 25_000_000n,
        nested: [1n, { value: 2n }],
      }),
    ).toEqual({
      amountMsats: '25000000',
      nested: ['1', { value: '2' }],
    });
  });
});
