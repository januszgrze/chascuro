import {
  createWalletOperation,
  deserializeMsats,
  federationId,
  operationId,
  serializeMsats,
  type OperationDirection,
  type OperationGuidanceCode,
  type OperationKind,
  type OperationStatus,
  type WalletOperation,
} from '../../../domain';
import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const WALLET_OPERATION_RECORD_KIND = 'operation';
export const WALLET_OPERATION_RECORD_VERSION = 1 as const;

export interface PersistedWalletOperation {
  readonly version: typeof WALLET_OPERATION_RECORD_VERSION;
  readonly federationId: string;
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly direction?: OperationDirection;
  readonly status: OperationStatus;
  readonly amountMsats?: string;
  readonly feeMsats?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs?: number;
  readonly localDescription?: string;
  readonly guidanceCode?: OperationGuidanceCode;
  readonly secretRecordRef?: string;
  readonly reconciliationCursor?: string;
  readonly schemaVersion?: number;
  readonly adapterVersion?: string;
}

export const walletOperationRecordSchema: EncryptedRecordSchema<PersistedWalletOperation> =
  Object.freeze({
    kind: WALLET_OPERATION_RECORD_KIND,
    version: WALLET_OPERATION_RECORD_VERSION,
    parse: parsePersistedWalletOperation,
  });

export function persistWalletOperation(
  operation: WalletOperation,
): PersistedWalletOperation {
  return parsePersistedWalletOperation({
    version: WALLET_OPERATION_RECORD_VERSION,
    federationId: operation.key.federationId,
    operationId: operation.key.operationId,
    kind: operation.kind,
    direction: operation.direction,
    status: operation.status,
    amountMsats:
      operation.amountMsats === undefined
        ? undefined
        : serializeMsats(operation.amountMsats),
    feeMsats:
      operation.feeMsats === undefined
        ? undefined
        : serializeMsats(operation.feeMsats),
    createdAtMs: operation.createdAtMs,
    updatedAtMs: operation.updatedAtMs,
    expiresAtMs: operation.expiresAtMs,
    localDescription: operation.localDescription,
    guidanceCode: operation.guidanceCode,
    secretRecordRef: operation.secretRecordRef,
    reconciliationCursor: operation.reconciliationCursor,
    schemaVersion: operation.schemaVersion,
    adapterVersion: operation.adapterVersion,
  });
}

export function restoreWalletOperation(
  value: PersistedWalletOperation,
): WalletOperation {
  const parsed = parsePersistedWalletOperation(value);
  return createWalletOperation({
    key: {
      federationId: federationId(parsed.federationId),
      operationId: operationId(parsed.operationId),
    },
    kind: parsed.kind,
    direction: parsed.direction,
    status: parsed.status,
    createdAtMs: parsed.createdAtMs,
    updatedAtMs: parsed.updatedAtMs,
    ...(parsed.amountMsats === undefined
      ? {}
      : { amountMsats: deserializeMsats(parsed.amountMsats) }),
    ...(parsed.feeMsats === undefined
      ? {}
      : { feeMsats: deserializeMsats(parsed.feeMsats) }),
    ...(parsed.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: parsed.expiresAtMs }),
    ...(parsed.localDescription === undefined
      ? {}
      : { localDescription: parsed.localDescription }),
    ...(parsed.guidanceCode === undefined
      ? {}
      : { guidanceCode: parsed.guidanceCode }),
    ...(parsed.secretRecordRef === undefined
      ? {}
      : { secretRecordRef: parsed.secretRecordRef }),
    ...(parsed.reconciliationCursor === undefined
      ? {}
      : { reconciliationCursor: parsed.reconciliationCursor }),
    ...(parsed.schemaVersion === undefined
      ? {}
      : { schemaVersion: parsed.schemaVersion }),
    ...(parsed.adapterVersion === undefined
      ? {}
      : { adapterVersion: parsed.adapterVersion }),
  });
}

export function parsePersistedWalletOperation(
  value: unknown,
): PersistedWalletOperation {
  if (
    !isRecord(value) ||
    value.version !== WALLET_OPERATION_RECORD_VERSION ||
    !isIdentifier(value.federationId) ||
    !isIdentifier(value.operationId) ||
    !isOperationKind(value.kind) ||
    (value.direction !== undefined && !isOperationDirection(value.direction)) ||
    !isOperationStatus(value.status) ||
    (value.amountMsats !== undefined &&
      !isCanonicalAmount(value.amountMsats)) ||
    (value.feeMsats !== undefined && !isCanonicalAmount(value.feeMsats)) ||
    !isTimestamp(value.createdAtMs) ||
    !isTimestamp(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs ||
    (value.expiresAtMs !== undefined &&
      (!isTimestamp(value.expiresAtMs) ||
        value.expiresAtMs < value.createdAtMs)) ||
    !isOptionalIdentifier(value.localDescription) ||
    (value.guidanceCode !== undefined && !isGuidanceCode(value.guidanceCode)) ||
    !isOptionalIdentifier(value.secretRecordRef) ||
    !isOptionalIdentifier(value.reconciliationCursor) ||
    (value.schemaVersion !== undefined &&
      (typeof value.schemaVersion !== 'number' ||
        !Number.isSafeInteger(value.schemaVersion) ||
        Number(value.schemaVersion) < 1)) ||
    !isOptionalIdentifier(value.adapterVersion)
  ) {
    throw new TypeError('Stored wallet operation is invalid.');
  }

  const allowed = new Set([
    'version',
    'federationId',
    'operationId',
    'kind',
    'direction',
    'status',
    'amountMsats',
    'feeMsats',
    'createdAtMs',
    'updatedAtMs',
    'expiresAtMs',
    'localDescription',
    'guidanceCode',
    'secretRecordRef',
    'reconciliationCursor',
    'schemaVersion',
    'adapterVersion',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError('Stored wallet operation has unexpected fields.');
  }

  return Object.freeze({
    version: WALLET_OPERATION_RECORD_VERSION,
    federationId: value.federationId,
    operationId: value.operationId,
    kind: value.kind,
    status: value.status,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
    ...(value.direction === undefined ? {} : { direction: value.direction }),
    ...(value.amountMsats === undefined
      ? {}
      : { amountMsats: value.amountMsats }),
    ...(value.feeMsats === undefined ? {} : { feeMsats: value.feeMsats }),
    ...(value.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: value.expiresAtMs }),
    ...(value.localDescription === undefined
      ? {}
      : { localDescription: value.localDescription }),
    ...(value.guidanceCode === undefined
      ? {}
      : { guidanceCode: value.guidanceCode }),
    ...(value.secretRecordRef === undefined
      ? {}
      : { secretRecordRef: value.secretRecordRef }),
    ...(value.reconciliationCursor === undefined
      ? {}
      : { reconciliationCursor: value.reconciliationCursor }),
    ...(value.schemaVersion === undefined
      ? {}
      : { schemaVersion: value.schemaVersion }),
    ...(value.adapterVersion === undefined
      ? {}
      : { adapterVersion: value.adapterVersion }),
  });
}

function isOperationKind(value: unknown): value is OperationKind {
  return [
    'federation_join',
    'ecash_receive',
    'ecash_send',
    'lightning_receive',
    'lightning_send',
    'unknown',
  ].includes(value as OperationKind);
}

function isOperationDirection(value: unknown): value is OperationDirection {
  return ['incoming', 'outgoing', 'neutral', 'unknown'].includes(
    value as OperationDirection,
  );
}

function isOperationStatus(value: unknown): value is OperationStatus {
  return [
    'created',
    'awaiting_external_payment',
    'pending',
    'refunding',
    'settled',
    'refunded',
    'failed',
    'expired',
    'cancelled',
    'unknown',
  ].includes(value as OperationStatus);
}

function isGuidanceCode(value: unknown): value is OperationGuidanceCode {
  return [
    'retry',
    'reconcile',
    'await_external_payment',
    'await_refund',
    'contact_support',
    'unknown',
  ].includes(value as OperationGuidanceCode);
}

function isCanonicalAmount(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    deserializeMsats(value);
    return true;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isIdentifier(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
