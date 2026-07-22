import {
  EncryptedRecordStore,
  encryptedRecordKeyringStorageId,
  type EncryptedRecord,
} from '../encrypted-record-store';
import {
  completedMigrationRecordSchema,
  type CompletedMigrationRecord,
} from '../schemas/migration-record';
import {
  parseWalletProfileV1,
  upgradeWalletProfileV1,
  walletProfileV2Schema,
  type WalletProfileV1,
  type WalletProfileV2,
} from '../schemas/wallet-profile';
import { unlockVault, type VaultOptions } from '../vault';
import type { VaultStore } from '../vault-store';

export const V1_PROFILE_MIGRATION_ID = 'wallet-profile-v1-to-v2';
export const DEFAULT_V1_PROFILE_RECORD_ID = 'primary-wallet';
export const DEFAULT_V2_PROFILE_ID = 'primary-wallet';
export const FEDIMINT_V1_ADAPTER_VERSION = '@fedimint/core@0.1.3';
export const FAKE_V1_ADAPTER_VERSION = 'fake-wallet@1';

export type V1ProfileMigrationStatus =
  'migrated' | 'resumed' | 'already-migrated';

export interface MigrateV1ProfileToV2Options {
  readonly storage: VaultStore;
  readonly passphrase: string;
  readonly legacyRecordId?: string;
  readonly profileId?: string;
  readonly namespace?: string;
  readonly migrationId?: string;
  readonly adapterVersion?: string;
  readonly runtime?: 'production' | 'development' | 'test';
  readonly now?: () => number;
  readonly vaultOptions?: VaultOptions;
  readonly recordKdfIterations?: number;
}

export interface V1ProfileMigrationResult {
  readonly status: V1ProfileMigrationStatus;
  readonly store: EncryptedRecordStore;
  readonly profile: EncryptedRecord<WalletProfileV2>;
  readonly migration: EncryptedRecord<CompletedMigrationRecord>;
}

export class ProductionFakeProfileError extends Error {
  constructor() {
    super('Simulated wallet profiles cannot be migrated in production.');
    this.name = 'ProductionFakeProfileError';
  }
}

export class WalletProfileMigrationMissingError extends Error {
  constructor() {
    super('No complete wallet profile is available to migrate or resume.');
    this.name = 'WalletProfileMigrationMissingError';
  }
}

export class WalletProfileMigrationConflictError extends Error {
  constructor() {
    super('Existing Version 2 migration data conflicts with Version 1.');
    this.name = 'WalletProfileMigrationConflictError';
  }
}

export class WalletProfileMigrationDeleteError extends Error {
  constructor() {
    super('Version 1 wallet profile could not be deleted after verification.');
    this.name = 'WalletProfileMigrationDeleteError';
  }
}

/**
 * Migrates the legacy single-envelope profile into the independently encrypted
 * Version 2 record store. The returned store remains unlocked on success and
 * must be locked by its owner. All failure paths lock any opened V2 keyring.
 */
export async function migrateV1ProfileToV2(
  options: MigrateV1ProfileToV2Options,
): Promise<V1ProfileMigrationResult> {
  const legacyRecordId = options.legacyRecordId ?? DEFAULT_V1_PROFILE_RECORD_ID;
  const profileId = options.profileId ?? DEFAULT_V2_PROFILE_ID;
  const migrationId = options.migrationId ?? V1_PROFILE_MIGRATION_ID;
  const namespace = options.namespace ?? DEFAULT_V1_PROFILE_RECORD_ID;
  const production =
    (import.meta.env.PROD && import.meta.env.MODE !== 'e2e') ||
    options.runtime === 'production';
  const legacyEnvelope = await options.storage.get(legacyRecordId);
  const keyringExisted =
    (await options.storage.get(encryptedRecordKeyringStorageId(namespace))) !==
    undefined;
  const sourceProfile =
    legacyEnvelope === undefined
      ? undefined
      : await readLegacyProfile(
          legacyRecordId,
          options.passphrase,
          legacyEnvelope,
          options.vaultOptions?.crypto,
        );

  if (production && sourceProfile?.mode === 'fake') {
    throw new ProductionFakeProfileError();
  }

  if (legacyEnvelope === undefined && !keyringExisted) {
    throw new WalletProfileMigrationMissingError();
  }

  let store: EncryptedRecordStore | undefined;
  try {
    store = keyringExisted
      ? await EncryptedRecordStore.open({
          storage: options.storage,
          passphrase: options.passphrase,
          namespace,
          crypto: options.vaultOptions?.crypto,
          now: options.now,
          recordKdfIterations: options.recordKdfIterations,
        })
      : await EncryptedRecordStore.create({
          storage: options.storage,
          passphrase: options.passphrase,
          namespace,
          crypto: options.vaultOptions?.crypto,
          now: options.now,
          recordKdfIterations: options.recordKdfIterations,
          vaultOptions: {
            iterations: options.vaultOptions?.iterations,
          },
        });

    const existingProfile = await store.get(walletProfileV2Schema, profileId);
    const existingMigration = await store.get(
      completedMigrationRecordSchema,
      migrationId,
    );
    const status = migrationStatus(
      legacyEnvelope !== undefined,
      keyringExisted,
      existingProfile !== undefined,
      existingMigration !== undefined,
    );

    if (
      sourceProfile === undefined &&
      (existingProfile === undefined || existingMigration === undefined)
    ) {
      throw new WalletProfileMigrationMissingError();
    }

    const expectedProfile =
      sourceProfile === undefined
        ? existingProfile?.payload
        : upgradeWalletProfileV1(
            sourceProfile,
            options.adapterVersion ?? defaultAdapterVersion(sourceProfile.mode),
          );

    if (expectedProfile === undefined) {
      throw new WalletProfileMigrationMissingError();
    }

    if (
      existingProfile !== undefined &&
      !jsonEqual(existingProfile.payload, expectedProfile)
    ) {
      throw new WalletProfileMigrationConflictError();
    }

    if (production && expectedProfile.mode === 'fake') {
      throw new ProductionFakeProfileError();
    }

    if (existingProfile === undefined) {
      await store.put(walletProfileV2Schema, profileId, expectedProfile);
    }

    const verifiedProfile = await store.get(walletProfileV2Schema, profileId);
    if (
      verifiedProfile === undefined ||
      !jsonEqual(verifiedProfile.payload, expectedProfile)
    ) {
      throw new WalletProfileMigrationConflictError();
    }

    if (existingMigration !== undefined) {
      assertMigrationMatches(
        existingMigration.payload,
        migrationId,
        legacyRecordId,
        profileId,
      );
    } else {
      if (sourceProfile === undefined) {
        throw new WalletProfileMigrationMissingError();
      }
      await store.put(
        completedMigrationRecordSchema,
        migrationId,
        createCompletedMigration(
          migrationId,
          legacyRecordId,
          profileId,
          readTimestamp(options.now ?? Date.now),
        ),
      );
    }

    const verifiedMigration = await store.get(
      completedMigrationRecordSchema,
      migrationId,
    );
    if (verifiedMigration === undefined) {
      throw new WalletProfileMigrationConflictError();
    }
    assertMigrationMatches(
      verifiedMigration.payload,
      migrationId,
      legacyRecordId,
      profileId,
    );

    const finalProfile = await store.get(walletProfileV2Schema, profileId);
    if (
      finalProfile === undefined ||
      !jsonEqual(finalProfile.payload, expectedProfile)
    ) {
      throw new WalletProfileMigrationConflictError();
    }

    if (legacyEnvelope !== undefined) {
      const currentLegacyEnvelope = await options.storage.get(legacyRecordId);
      if (!jsonEqual(currentLegacyEnvelope, legacyEnvelope)) {
        throw new WalletProfileMigrationConflictError();
      }
      await options.storage.delete(legacyRecordId);
      if ((await options.storage.get(legacyRecordId)) !== undefined) {
        throw new WalletProfileMigrationDeleteError();
      }
    }

    return Object.freeze({
      status,
      store,
      profile: finalProfile,
      migration: verifiedMigration,
    });
  } catch (error) {
    store?.lock();
    throw error;
  }
}

async function readLegacyProfile(
  recordId: string,
  passphrase: string,
  envelope: NonNullable<Awaited<ReturnType<VaultStore['get']>>>,
  crypto: Crypto | undefined,
): Promise<WalletProfileV1> {
  const session = await unlockVault<unknown>(recordId, passphrase, envelope, {
    crypto,
  });
  try {
    return parseWalletProfileV1(session.read());
  } finally {
    session.lock();
  }
}

function createCompletedMigration(
  migrationId: string,
  sourceRecordId: string,
  profileId: string,
  completedAtMs: number,
): CompletedMigrationRecord {
  return Object.freeze({
    version: 1,
    migrationId,
    sourceRecordId,
    target: Object.freeze({
      kind: walletProfileV2Schema.kind,
      id: profileId,
      schemaVersion: walletProfileV2Schema.version,
    }),
    checkpoints: Object.freeze([
      'profile-written',
      'profile-verified',
    ]) as readonly ['profile-written', 'profile-verified'],
    completedAtMs,
  });
}

function assertMigrationMatches(
  migration: CompletedMigrationRecord,
  migrationId: string,
  sourceRecordId: string,
  profileId: string,
): void {
  if (
    migration.migrationId !== migrationId ||
    migration.sourceRecordId !== sourceRecordId ||
    migration.target.kind !== walletProfileV2Schema.kind ||
    migration.target.id !== profileId ||
    migration.target.schemaVersion !== walletProfileV2Schema.version
  ) {
    throw new WalletProfileMigrationConflictError();
  }
}

function migrationStatus(
  hasLegacy: boolean,
  keyringExisted: boolean,
  profileExisted: boolean,
  migrationExisted: boolean,
): V1ProfileMigrationStatus {
  if (!hasLegacy) {
    return 'already-migrated';
  }
  return keyringExisted || profileExisted || migrationExisted
    ? 'resumed'
    : 'migrated';
}

function defaultAdapterVersion(mode: WalletProfileV1['mode']): string {
  return mode === 'fedimint'
    ? FEDIMINT_V1_ADAPTER_VERSION
    : FAKE_V1_ADAPTER_VERSION;
}

function readTimestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Clock returned an invalid timestamp.');
  }
  return value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
