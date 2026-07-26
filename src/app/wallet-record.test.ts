import { describe, expect, it } from 'vitest';

import { clientName, federationId, type ActiveFederation } from '../domain';
import {
  createPersistedWalletRecord,
  createWalletProfileV2,
  readWalletProfileV2,
  serializeBigInts,
} from './wallet-record';

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

  it('restores legacy and multi-federation profiles through one record shape', () => {
    const primary = testFederation('fed-a', 'client-a');
    const secondary = testFederation('fed-b', 'client-b');
    const legacy = createWalletProfileV2('fake', {
      adapterVersion: 'fake-wallet@2',
      identity: { status: 'initialized' },
      activeFederation: primary,
    });
    const portfolio = createWalletProfileV2('fake', {
      adapterVersion: 'fake-wallet@2',
      identity: { status: 'initialized' },
      activeFederation: primary,
      primaryFederationId: primary.federationId,
      federations: [primary, secondary],
    });

    expect(readWalletProfileV2(legacy).federations).toHaveLength(1);
    expect(readWalletProfileV2(portfolio)).toMatchObject({
      activeFederation: { federationId: 'fed-a' },
      primaryFederationId: 'fed-a',
      federations: [
        { federationId: 'fed-a', clientName: 'client-a' },
        { federationId: 'fed-b', clientName: 'client-b' },
      ],
    });
  });
});

function testFederation(id: string, name: string): ActiveFederation {
  return Object.freeze({
    federationId: federationId(id),
    displayName: `Federation ${id}`,
    network: 'signet',
    modules: Object.freeze(['ln', 'mint']),
    guardianCount: 3,
    clientName: clientName(name),
    joinedAtMs: 1_000,
  });
}
