import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const WALLET_SECRET_RECORD_KIND = 'secret';
export const WALLET_SECRET_RECORD_VERSION = 1 as const;

export type WalletSecretPurpose = 'ecash-export' | 'lightning-invoice';

export interface WalletSecretRecord {
  readonly version: typeof WALLET_SECRET_RECORD_VERSION;
  readonly purpose: WalletSecretPurpose;
  readonly federationId: string;
  readonly operationId: string;
  readonly value: string;
}

export const walletSecretRecordSchema: EncryptedRecordSchema<WalletSecretRecord> =
  Object.freeze({
    kind: WALLET_SECRET_RECORD_KIND,
    version: WALLET_SECRET_RECORD_VERSION,
    parse: parseWalletSecretRecord,
  });

export function parseWalletSecretRecord(value: unknown): WalletSecretRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    value.version !== WALLET_SECRET_RECORD_VERSION ||
    (value.purpose !== 'ecash-export' &&
      value.purpose !== 'lightning-invoice') ||
    !isIdentifier(value.federationId) ||
    !isIdentifier(value.operationId) ||
    typeof value.value !== 'string' ||
    value.value.length === 0
  ) {
    throw new TypeError('Stored wallet secret is invalid.');
  }

  return Object.freeze({
    version: WALLET_SECRET_RECORD_VERSION,
    purpose: value.purpose,
    federationId: value.federationId,
    operationId: value.operationId,
    value: value.value,
  });
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
