import { describe, expect, it } from 'vitest';

import { parsePendingFederationJoinRecord } from './pending-federation-join-record';

describe('pending federation join schema', () => {
  it('round-trips only sanitized join metadata', () => {
    expect(
      parsePendingFederationJoinRecord({
        version: 1,
        federationId: 'fed-id',
        clientName: '00000000-0000-4000-8000-000000000001',
        displayName: 'Test federation',
        network: 'signet',
        modules: ['ln', 'mint'],
        guardianCount: 3,
        submittedAtMs: 123,
      }),
    ).toMatchObject({
      federationId: 'fed-id',
      network: 'signet',
      submittedAtMs: 123,
    });
  });

  it('rejects secret or unexpected fields', () => {
    expect(() =>
      parsePendingFederationJoinRecord({
        version: 1,
        federationId: 'fed-id',
        clientName: '00000000-0000-4000-8000-000000000001',
        displayName: 'Test federation',
        network: 'signet',
        modules: ['mint'],
        guardianCount: 1,
        submittedAtMs: 123,
        inviteCode: 'secret',
      }),
    ).toThrow(TypeError);
  });

  it('accepts a legacy pending join without a client name', () => {
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
});
