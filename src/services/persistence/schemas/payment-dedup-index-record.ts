import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const PAYMENT_DEDUP_INDEX_RECORD_KIND = 'payment-dedup-index';
export const PAYMENT_DEDUP_INDEX_RECORD_VERSION = 1 as const;
export const PAYMENT_DEDUP_INDEX_RECORD_ID = 'ecash-redemptions';

export interface EcashRedemptionDedupEntry {
  readonly fingerprint: string;
  readonly federationId: string;
  readonly operationId: string;
  readonly submittedAtMs: number;
}

export interface PaymentDedupIndexRecord {
  readonly version: typeof PAYMENT_DEDUP_INDEX_RECORD_VERSION;
  readonly ecashRedemptions: readonly EcashRedemptionDedupEntry[];
}

export const paymentDedupIndexRecordSchema: EncryptedRecordSchema<PaymentDedupIndexRecord> =
  Object.freeze({
    kind: PAYMENT_DEDUP_INDEX_RECORD_KIND,
    version: PAYMENT_DEDUP_INDEX_RECORD_VERSION,
    parse: parsePaymentDedupIndexRecord,
  });

export function parsePaymentDedupIndexRecord(
  value: unknown,
): PaymentDedupIndexRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== PAYMENT_DEDUP_INDEX_RECORD_VERSION ||
    !Array.isArray(value.ecashRedemptions)
  ) {
    throw new TypeError('Stored payment deduplication index is invalid.');
  }

  const fingerprints = new Set<string>();
  const ecashRedemptions = value.ecashRedemptions.map((entry) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 4 ||
      !isIdentifier(entry.fingerprint) ||
      !isIdentifier(entry.federationId) ||
      !isIdentifier(entry.operationId) ||
      !isTimestamp(entry.submittedAtMs) ||
      fingerprints.has(entry.fingerprint)
    ) {
      throw new TypeError('Stored ecash redemption marker is invalid.');
    }
    fingerprints.add(entry.fingerprint);
    return Object.freeze({
      fingerprint: entry.fingerprint,
      federationId: entry.federationId,
      operationId: entry.operationId,
      submittedAtMs: entry.submittedAtMs,
    });
  });

  return Object.freeze({
    version: PAYMENT_DEDUP_INDEX_RECORD_VERSION,
    ecashRedemptions: Object.freeze(ecashRedemptions),
  });
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
