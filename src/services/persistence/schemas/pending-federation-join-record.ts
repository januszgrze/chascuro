import type { EncryptedRecordSchema } from '../encrypted-record-store';
import type { PersistedBitcoinNetwork } from './wallet-profile';

export const PENDING_FEDERATION_JOIN_RECORD_KIND = 'pending-federation-join';
export const PENDING_FEDERATION_JOIN_RECORD_VERSION = 1 as const;
export const PENDING_FEDERATION_JOIN_RECORD_ID = 'current';

export interface PendingFederationJoinRecord {
  readonly version: typeof PENDING_FEDERATION_JOIN_RECORD_VERSION;
  readonly federationId: string;
  readonly displayName: string;
  readonly network: PersistedBitcoinNetwork;
  readonly modules: readonly string[];
  readonly guardianCount: number;
  readonly clientName?: string;
  readonly submittedAtMs: number;
}

export const pendingFederationJoinRecordSchema: EncryptedRecordSchema<PendingFederationJoinRecord> =
  Object.freeze({
    kind: PENDING_FEDERATION_JOIN_RECORD_KIND,
    version: PENDING_FEDERATION_JOIN_RECORD_VERSION,
    parse: parsePendingFederationJoinRecord,
  });

export function parsePendingFederationJoinRecord(
  value: unknown,
): PendingFederationJoinRecord {
  if (
    !isRecord(value) ||
    !hasAllowedExactKeys(
      value,
      [
        'version',
        'federationId',
        'displayName',
        'network',
        'modules',
        'guardianCount',
        'submittedAtMs',
      ],
      ['clientName'],
    ) ||
    value.version !== PENDING_FEDERATION_JOIN_RECORD_VERSION ||
    !isIdentifier(value.federationId) ||
    !isIdentifier(value.displayName) ||
    !isBitcoinNetwork(value.network) ||
    !Array.isArray(value.modules) ||
    !value.modules.every(isIdentifier) ||
    new Set(value.modules).size !== value.modules.length ||
    !isNonNegativeSafeInteger(value.guardianCount) ||
    (value.clientName !== undefined && !isUuid(value.clientName)) ||
    !isNonNegativeSafeInteger(value.submittedAtMs)
  ) {
    throw new TypeError('Stored pending federation join is invalid.');
  }

  return Object.freeze({
    version: PENDING_FEDERATION_JOIN_RECORD_VERSION,
    federationId: value.federationId,
    displayName: value.displayName,
    network: value.network,
    modules: Object.freeze([...value.modules]),
    guardianCount: value.guardianCount,
    ...(value.clientName === undefined ? {} : { clientName: value.clientName }),
    submittedAtMs: value.submittedAtMs,
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function hasAllowedExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isBitcoinNetwork(value: unknown): value is PersistedBitcoinNetwork {
  return (
    value === 'bitcoin' ||
    value === 'testnet' ||
    value === 'signet' ||
    value === 'regtest' ||
    value === 'unknown'
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
