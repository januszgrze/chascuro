import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const OPERATION_INDEX_RECORD_KIND = 'operation-index';
export const OPERATION_INDEX_RECORD_VERSION = 1 as const;

export interface OperationIndexRecord {
  readonly version: typeof OPERATION_INDEX_RECORD_VERSION;
  readonly operationRecordIds: readonly string[];
}

export const operationIndexRecordSchema: EncryptedRecordSchema<OperationIndexRecord> =
  Object.freeze({
    kind: OPERATION_INDEX_RECORD_KIND,
    version: OPERATION_INDEX_RECORD_VERSION,
    parse: parseOperationIndexRecord,
  });

export function parseOperationIndexRecord(
  value: unknown,
): OperationIndexRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== OPERATION_INDEX_RECORD_VERSION ||
    !Array.isArray(value.operationRecordIds) ||
    !value.operationRecordIds.every(isIdentifier) ||
    new Set(value.operationRecordIds).size !== value.operationRecordIds.length
  ) {
    throw new TypeError('Stored operation index is invalid.');
  }

  return Object.freeze({
    version: OPERATION_INDEX_RECORD_VERSION,
    operationRecordIds: Object.freeze([...value.operationRecordIds]),
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
