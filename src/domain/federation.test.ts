import { describe, expect, it } from 'vitest';

import {
  approveFederationJoin,
  candidateId,
  clientName,
  federationId,
  getFederationJoinBlockReason,
  isCandidateExpired,
  isJoinApprovalValid,
  normalizeBitcoinNetwork,
  normalizeFederationModules,
  sanitizeGuardianOrigins,
  type FederationCandidate,
} from './federation';

function candidate(
  overrides: Partial<FederationCandidate> = {},
): FederationCandidate {
  return {
    candidateId: candidateId('candidate-a'),
    federationId: federationId('federation-a'),
    displayName: 'Community federation',
    network: 'regtest',
    modules: ['ln', 'mint'],
    guardianCount: 4,
    guardianOrigins: ['wss://guardian.example'],
    expiresAtMs: 10_000,
    ...overrides,
  };
}

describe('federation domain', () => {
  it('creates opaque identifiers without normalizing their values', () => {
    expect(federationId('Fed-A')).toBe('Fed-A');
    expect(candidateId('candidate-a')).toBe('candidate-a');
    expect(clientName('wallet-v1')).toBe('wallet-v1');
    expect(() => federationId(' ')).toThrow(TypeError);
    expect(() => candidateId(' candidate-a')).toThrow(TypeError);
  });

  it('normalizes known networks conservatively', () => {
    expect(normalizeBitcoinNetwork('mainnet')).toBe('bitcoin');
    expect(normalizeBitcoinNetwork('main')).toBe('bitcoin');
    expect(normalizeBitcoinNetwork('"bitcoin"')).toBe('bitcoin');
    expect(normalizeBitcoinNetwork('testnet4')).toBe('testnet');
    expect(normalizeBitcoinNetwork(' SIGNET ')).toBe('signet');
    expect(normalizeBitcoinNetwork('future-network')).toBe('unknown');
    expect(normalizeBitcoinNetwork(undefined)).toBe('unknown');
  });

  it('deduplicates and normalizes module names', () => {
    expect(
      normalizeFederationModules([' Mint ', 'ln', 'MINT', '', 'wallet']),
    ).toEqual(['ln', 'mint', 'wallet']);
  });

  it('reduces guardian endpoints to sorted, unique origins', () => {
    expect(
      sanitizeGuardianOrigins([
        { url: 'wss://two.example/private/path?invite=secret' },
        { url: 'https://one.example:8443/api' },
        'wss://two.example/another-path',
        { url: 'wss://user:secret@hidden.example/api' },
        { url: 'not a URL' },
      ]),
    ).toEqual(['https://one.example:8443', 'wss://two.example']);
  });

  it('blocks a federation without mint support', () => {
    const preview = candidate({ modules: ['ln', 'wallet'] });

    expect(getFederationJoinBlockReason(preview)).toBe('missing_mint_module');
    expect(() => approveFederationJoin(preview, 5_000)).toThrow(RangeError);
  });

  it('allows an unknown-network federation to reach the SDK join attempt', () => {
    const preview = candidate({ network: 'unknown' });

    expect(getFederationJoinBlockReason(preview)).toBeUndefined();
    expect(approveFederationJoin(preview, 5_000)).toMatchObject({
      network: 'unknown',
    });
  });

  it('requires a separate acknowledgement for mainnet approval', () => {
    const preview = candidate({ network: 'bitcoin' });

    expect(getFederationJoinBlockReason(preview)).toBeUndefined();
    expect(() => approveFederationJoin(preview, 5_000)).toThrow(RangeError);
    const approval = approveFederationJoin(preview, 5_000, true);
    expect(approval.mainnetRiskAcknowledged).toBe(true);
    expect(isJoinApprovalValid(approval, preview, 9_999)).toBe(true);
  });

  it('treats the candidate expiry boundary as expired', () => {
    const preview = candidate();

    expect(isCandidateExpired(preview, 9_999)).toBe(false);
    expect(isCandidateExpired(preview, 10_000)).toBe(true);
  });

  it('binds trust approval to the exact non-expired preview', () => {
    const preview = candidate();
    const approval = approveFederationJoin(preview, 5_000);

    expect(isJoinApprovalValid(approval, preview, 9_999)).toBe(true);
    expect(
      isJoinApprovalValid(
        approval,
        candidate({ candidateId: candidateId('candidate-b') }),
        9_999,
      ),
    ).toBe(false);
    expect(isJoinApprovalValid(approval, preview, 10_000)).toBe(false);
  });

  it('does not allow approval of an expired preview', () => {
    expect(() => approveFederationJoin(candidate(), 10_000)).toThrow(
      RangeError,
    );
  });

  it('rejects a candidate with an invalid expiry timestamp', () => {
    expect(() =>
      isCandidateExpired(candidate({ expiresAtMs: Number.NaN }), 5_000),
    ).toThrow(RangeError);
  });
});
