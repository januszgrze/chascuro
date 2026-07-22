declare const federationIdBrand: unique symbol;
declare const candidateIdBrand: unique symbol;
declare const clientNameBrand: unique symbol;
declare const joinApprovalBrand: unique symbol;

export type FederationId = string & {
  readonly [federationIdBrand]: 'FederationId';
};

export type CandidateId = string & {
  readonly [candidateIdBrand]: 'CandidateId';
};

export type ClientName = string & {
  readonly [clientNameBrand]: 'ClientName';
};

export type BitcoinNetwork =
  'bitcoin' | 'testnet' | 'signet' | 'regtest' | 'unknown';

export type KnownFederationModule = 'mint' | 'ln' | 'wallet';

export interface FederationDescriptor {
  readonly federationId: FederationId;
  readonly displayName: string;
  readonly network: BitcoinNetwork;
  readonly modules: readonly string[];
  readonly guardianCount: number;
}

/**
 * A sanitized preview of a federation. It deliberately has no invite-code
 * field: the raw code belongs in short-lived service memory only.
 */
export interface FederationCandidate extends FederationDescriptor {
  readonly candidateId: CandidateId;
  readonly expiresAtMs: number;
  /**
   * Display-safe origins only. Paths, query strings, credentials, and other
   * endpoint details must never be carried into application state.
   */
  readonly guardianOrigins?: readonly string[];
}

export interface ActiveFederation extends FederationDescriptor {
  readonly clientName: ClientName;
  readonly joinedAtMs: number;
}

export interface ActiveClientRef {
  readonly federationId: FederationId;
  readonly clientName: ClientName;
}

/**
 * An approval is bound to the exact preview the user saw. Services should still
 * validate candidate expiry immediately before joining.
 */
export type FederationJoinApproval = Readonly<{
  candidateId: CandidateId;
  federationId: FederationId;
  network: BitcoinNetwork;
  mainnetRiskAcknowledged: boolean;
  acknowledgedAtMs: number;
  [joinApprovalBrand]: 'FederationJoinApproval';
}>;

export type FederationJoinBlockReason = 'missing_mint_module';

function opaqueIdentifier<T extends string>(value: string): T {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(
      'Identifier must be non-empty and have no outer whitespace.',
    );
  }

  return value as T;
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Timestamp must be a non-negative safe integer.');
  }
}

export function federationId(value: string): FederationId {
  return opaqueIdentifier<FederationId>(value);
}

export function candidateId(value: string): CandidateId {
  return opaqueIdentifier<CandidateId>(value);
}

export function clientName(value: string): ClientName {
  return opaqueIdentifier<ClientName>(value);
}

export function normalizeBitcoinNetwork(value: unknown): BitcoinNetwork {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim().toLowerCase();
  const unquoted =
    normalized.length >= 2 &&
    normalized.startsWith('"') &&
    normalized.endsWith('"')
      ? normalized.slice(1, -1).trim()
      : normalized;

  switch (unquoted) {
    case 'bitcoin':
    case 'btc':
    case 'main':
    case 'mainnet':
      return 'bitcoin';
    case 'testnet':
    case 'testnet3':
    case 'testnet4':
      return 'testnet';
    case 'signet':
      return 'signet';
    case 'regtest':
      return 'regtest';
    default:
      return 'unknown';
  }
}

export function normalizeFederationModules(
  modules: Iterable<string>,
): readonly string[] {
  const normalized = new Set<string>();

  for (const module of modules) {
    const name = module.trim().toLowerCase();
    if (name.length > 0) {
      normalized.add(name);
    }
  }

  return Object.freeze([...normalized].sort());
}

export function sanitizeGuardianOrigins(
  endpoints: Iterable<unknown>,
): readonly string[] {
  const origins = new Set<string>();

  for (const endpoint of endpoints) {
    const value =
      typeof endpoint === 'string'
        ? endpoint
        : typeof endpoint === 'object' &&
            endpoint !== null &&
            'url' in endpoint &&
            typeof endpoint.url === 'string'
          ? endpoint.url
          : undefined;
    if (value === undefined) {
      continue;
    }

    try {
      const url = new URL(value);
      if (
        !['https:', 'wss:'].includes(url.protocol) ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.origin === 'null'
      ) {
        continue;
      }
      origins.add(url.origin);
    } catch {
      // Invalid endpoint metadata is omitted from the display-safe summary.
    }
  }

  return Object.freeze([...origins].sort());
}

export function getFederationJoinBlockReason(
  candidate: FederationCandidate,
): FederationJoinBlockReason | undefined {
  if (
    !candidate.modules.some((module) => module.trim().toLowerCase() === 'mint')
  ) {
    return 'missing_mint_module';
  }
  return undefined;
}

export function isCandidateExpired(
  candidate: FederationCandidate,
  nowMs: number,
): boolean {
  assertTimestamp(candidate.expiresAtMs);
  assertTimestamp(nowMs);
  return nowMs >= candidate.expiresAtMs;
}

export function approveFederationJoin(
  candidate: FederationCandidate,
  acknowledgedAtMs: number,
  mainnetRiskAcknowledged = false,
): FederationJoinApproval {
  assertTimestamp(acknowledgedAtMs);

  const blockReason = getFederationJoinBlockReason(candidate);
  if (blockReason !== undefined) {
    throw new RangeError(`Federation join is blocked: ${blockReason}.`);
  }

  if (candidate.network === 'bitcoin' && !mainnetRiskAcknowledged) {
    throw new RangeError('Mainnet risk acknowledgement is required.');
  }

  if (isCandidateExpired(candidate, acknowledgedAtMs)) {
    throw new RangeError('Federation preview has expired.');
  }

  return Object.freeze({
    candidateId: candidate.candidateId,
    federationId: candidate.federationId,
    network: candidate.network,
    mainnetRiskAcknowledged,
    acknowledgedAtMs,
  }) as FederationJoinApproval;
}

export function isJoinApprovalValid(
  approval: FederationJoinApproval,
  candidate: FederationCandidate,
  nowMs: number,
): boolean {
  assertTimestamp(nowMs);

  return (
    getFederationJoinBlockReason(candidate) === undefined &&
    !isCandidateExpired(candidate, nowMs) &&
    approval.acknowledgedAtMs <= nowMs &&
    approval.candidateId === candidate.candidateId &&
    approval.federationId === candidate.federationId &&
    approval.network === candidate.network &&
    (candidate.network !== 'bitcoin' || approval.mainnetRiskAcknowledged)
  );
}
