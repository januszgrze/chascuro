import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const MIGRATION_RECORD_KIND = 'migration';
export const MIGRATION_RECORD_SCHEMA_VERSION = 1 as const;

export interface CompletedMigrationRecord {
  readonly version: typeof MIGRATION_RECORD_SCHEMA_VERSION;
  readonly migrationId: string;
  readonly sourceRecordId: string;
  readonly target: {
    readonly kind: string;
    readonly id: string;
    readonly schemaVersion: number;
  };
  readonly checkpoints: readonly ['profile-written', 'profile-verified'];
  readonly completedAtMs: number;
}

export const completedMigrationRecordSchema: EncryptedRecordSchema<CompletedMigrationRecord> =
  Object.freeze({
    kind: MIGRATION_RECORD_KIND,
    version: MIGRATION_RECORD_SCHEMA_VERSION,
    parse: parseCompletedMigrationRecord,
  });

export function parseCompletedMigrationRecord(
  value: unknown,
): CompletedMigrationRecord {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'migrationId',
      'sourceRecordId',
      'target',
      'checkpoints',
      'completedAtMs',
    ]) ||
    value.version !== MIGRATION_RECORD_SCHEMA_VERSION ||
    !isIdentifier(value.migrationId) ||
    !isIdentifier(value.sourceRecordId) ||
    !isTarget(value.target) ||
    !isCheckpoints(value.checkpoints) ||
    !isTimestamp(value.completedAtMs)
  ) {
    throw new TypeError('Unsupported migration record.');
  }

  return Object.freeze({
    version: MIGRATION_RECORD_SCHEMA_VERSION,
    migrationId: value.migrationId,
    sourceRecordId: value.sourceRecordId,
    target: Object.freeze({
      kind: value.target.kind,
      id: value.target.id,
      schemaVersion: value.target.schemaVersion,
    }),
    checkpoints: Object.freeze([
      'profile-written',
      'profile-verified',
    ]) as readonly ['profile-written', 'profile-verified'],
    completedAtMs: value.completedAtMs,
  });
}

function isTarget(value: unknown): value is {
  kind: string;
  id: string;
  schemaVersion: number;
} {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['kind', 'id', 'schemaVersion']) &&
    isIdentifier(value.kind) &&
    isIdentifier(value.id) &&
    Number.isSafeInteger(value.schemaVersion) &&
    Number(value.schemaVersion) >= 1
  );
}

function isCheckpoints(
  value: unknown,
): value is ['profile-written', 'profile-verified'] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === 'profile-written' &&
    value[1] === 'profile-verified'
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
