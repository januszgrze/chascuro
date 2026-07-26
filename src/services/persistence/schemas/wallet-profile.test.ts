import { describe, expect, it } from 'vitest';

import { parseWalletProfileV1, parseWalletProfileV2 } from './wallet-profile';

describe('wallet profile persistence schemas', () => {
  const federation = (id: string, clientName: string, network = 'signet') => ({
    federationId: id,
    displayName: `Federation ${id}`,
    network,
    modules: ['ln', 'mint'],
    guardianCount: 3,
    clientName,
    joinedAtMs: 1_000,
  });

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

  it('round-trips a bounded same-network federation portfolio', () => {
    const primary = federation('fed-a', 'client-a');
    const secondary = federation('fed-b', 'client-b');

    expect(
      parseWalletProfileV2({
        version: 2,
        mode: 'fedimint',
        adapterVersion: '@fedimint/core@0.1.3',
        identity: { status: 'initialized' },
        activeFederation: primary,
        primaryFederationId: primary.federationId,
        federations: [primary, secondary],
      }),
    ).toMatchObject({
      primaryFederationId: 'fed-a',
      federations: [
        { federationId: 'fed-a', clientName: 'client-a' },
        { federationId: 'fed-b', clientName: 'client-b' },
      ],
    });
  });

  it('rejects duplicate clients, mixed networks, and portfolios over three', () => {
    const primary = federation('fed-a', 'client-a');
    const profile = (federations: readonly unknown[]) => ({
      version: 2,
      mode: 'fedimint',
      adapterVersion: '@fedimint/core@0.1.3',
      identity: { status: 'initialized' },
      activeFederation: primary,
      primaryFederationId: primary.federationId,
      federations,
    });

    expect(() =>
      parseWalletProfileV2(profile([primary, federation('fed-b', 'client-a')])),
    ).toThrow('Stored federation portfolio is invalid.');
    expect(() =>
      parseWalletProfileV2(
        profile([primary, federation('fed-b', 'client-b', 'bitcoin')]),
      ),
    ).toThrow('Stored federation portfolio is invalid.');
    expect(() =>
      parseWalletProfileV2(
        profile([
          primary,
          federation('fed-b', 'client-b'),
          federation('fed-c', 'client-c'),
          federation('fed-d', 'client-d'),
        ]),
      ),
    ).toThrow('Stored federation portfolio is invalid.');
  });

  it('rejects an active federation that differs from the primary entry', () => {
    const primary = federation('fed-a', 'client-a');

    expect(() =>
      parseWalletProfileV2({
        version: 2,
        mode: 'fedimint',
        adapterVersion: '@fedimint/core@0.1.3',
        identity: { status: 'initialized' },
        activeFederation: {
          ...primary,
          displayName: 'Conflicting federation',
        },
        primaryFederationId: primary.federationId,
        federations: [primary],
      }),
    ).toThrow('Stored primary federation is inconsistent.');
  });
});
