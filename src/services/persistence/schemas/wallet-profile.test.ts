import { describe, expect, it } from 'vitest';

import { parseWalletProfileV1, parseWalletProfileV2 } from './wallet-profile';

describe('wallet profile persistence schemas', () => {
  it('accepts initialized V2 identity metadata without storing a mnemonic', () => {
    expect(
      parseWalletProfileV2({
        version: 2,
        mode: 'fedimint',
        adapterVersion: '@fedimint/core@0.1.3',
        identity: {
          status: 'initialized',
          backupConfirmedAtMs: 1_000,
        },
      }),
    ).toEqual({
      version: 2,
      mode: 'fedimint',
      adapterVersion: '@fedimint/core@0.1.3',
      identity: {
        status: 'initialized',
        backupConfirmedAtMs: 1_000,
      },
    });
  });

  it('rejects backup confirmation for an uninitialized identity', () => {
    expect(() =>
      parseWalletProfileV2({
        version: 2,
        mode: 'fedimint',
        adapterVersion: '@fedimint/core@0.1.3',
        identity: {
          status: 'not-initialized',
          backupConfirmedAtMs: 1_000,
        },
      }),
    ).toThrow('Stored wallet identity state is invalid.');
  });

  it('rejects unknown fields in legacy profiles rather than guessing', () => {
    expect(() =>
      parseWalletProfileV1({
        version: 1,
        mode: 'fedimint',
        simulatedBalanceMsats: '1000000',
      }),
    ).toThrow('Unsupported Version 1 wallet profile.');
  });
});
