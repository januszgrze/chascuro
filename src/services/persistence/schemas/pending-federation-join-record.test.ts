import { describe, expect, it } from 'vitest';

import { parsePendingFederationJoinRecord } from './pending-federation-join-record';

describe('pending federation join schema', () => {
  it('round-trips only sanitized join metadata', () => {
    expect(
      parsePendingFederationJoinRecord({
        version: 1,
        federationId: 'fed-id',
        displayName: 'Test federation',
        network: 'signet',
        modules: ['ln', 'mint'],
        guardianCount: 3,
        clientName: 'client-b',
        submittedAtMs: 123,
      }),
    ).toMatchObject({
      federationId: 'fed-id',
      network: 'signet',
      clientName: 'client-b',
      submittedAtMs: 123,
    });
  });

  it('accepts a legacy first-mint marker without a client name', () => {
    expect(
      parsePendingFederationJoinRecord({
        version: 1,
        federationId: 'fed-id',
        displayName: 'Test federation',
        network: 'signet',
        modules: ['mint'],
        guardianCount: 1,
        submittedAtMs: 123,
      }),
    ).not.toHaveProperty('clientName');
  });

  it('rejects secret or unexpected fields', () => {
    expect(() =>
      parsePendingFederationJoinRecord({
        version: 1,
        federationId: 'fed-id',
        displayName: 'Test federation',
        network: 'signet',
        modules: ['mint'],
        guardianCount: 1,
        submittedAtMs: 123,
        inviteCode: 'secret',
      }),
    ).toThrow(TypeError);
  });
});
