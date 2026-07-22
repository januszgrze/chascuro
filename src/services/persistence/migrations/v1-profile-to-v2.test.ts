import { describe, expect, it } from 'vitest';

import {
  EncryptedRecordWriteError,
  encryptedRecordKeyringStorageId,
  encryptedRecordStorageId,
} from '../encrypted-record-store';
import { walletProfileV2Schema } from '../schemas/wallet-profile';
import { createVault, type VaultEnvelope } from '../vault';
import { MemoryVaultStore, type VaultStore } from '../vault-store';
import {
  DEFAULT_V1_PROFILE_RECORD_ID,
  DEFAULT_V2_PROFILE_ID,
  FEDIMINT_V1_ADAPTER_VERSION,
  migrateV1ProfileToV2,
  ProductionFakeProfileError,
  V1_PROFILE_MIGRATION_ID,
  WalletProfileMigrationConflictError,
} from './v1-profile-to-v2';

const PASSPHRASE = 'a sufficiently strong migration passphrase';
const NAMESPACE = DEFAULT_V1_PROFILE_RECORD_ID;
const PROFILE_STORAGE_ID = encryptedRecordStorageId(
  NAMESPACE,
  walletProfileV2Schema.kind,
  DEFAULT_V2_PROFILE_ID,
);
const MIGRATION_STORAGE_ID = encryptedRecordStorageId(
  NAMESPACE,
  'migration',
  V1_PROFILE_MIGRATION_ID,
);
const KEYRING_STORAGE_ID = encryptedRecordKeyringStorageId(NAMESPACE);

const MIGRATION_OPTIONS = {
  passphrase: PASSPHRASE,
  runtime: 'test',
  now: () => 1_000,
  vaultOptions: { iterations: 1 },
  recordKdfIterations: 1,
} as const;

describe('Version 1 profile migration', () => {
  it('writes and verifies V2 profile and migration records before deleting V1', async () => {
    const storage = new MemoryVaultStore();
    await putLegacyProfile(storage, {
      version: 1,
      mode: 'fedimint',
      activeFederation: {
        federationId: 'fed1',
        displayName: 'Test federation',
        network: 'signet',
        modules: ['ln', 'mint'],
        guardianCount: 4,
        clientName: 'default',
        joinedAtMs: 900,
      },
    });

    const result = await migrateV1ProfileToV2({
      ...MIGRATION_OPTIONS,
      storage,
    });

    expect(result.status).toBe('migrated');
    expect(result.profile.payload).toEqual({
      version: 2,
      mode: 'fedimint',
      adapterVersion: FEDIMINT_V1_ADAPTER_VERSION,
      identity: { status: 'initialized' },
      activeFederation: {
        federationId: 'fed1',
        displayName: 'Test federation',
        network: 'signet',
        modules: ['ln', 'mint'],
        guardianCount: 4,
        clientName: 'default',
        joinedAtMs: 900,
      },
    });
    expect(result.migration.payload).toMatchObject({
      migrationId: V1_PROFILE_MIGRATION_ID,
      sourceRecordId: DEFAULT_V1_PROFILE_RECORD_ID,
      target: {
        kind: 'profile',
        id: DEFAULT_V2_PROFILE_ID,
        schemaVersion: 2,
      },
      checkpoints: ['profile-written', 'profile-verified'],
    });
    expect(await storage.get(DEFAULT_V1_PROFILE_RECORD_ID)).toBeUndefined();
    expect(await storage.get(KEYRING_STORAGE_ID)).toBeDefined();
    expect(await storage.get(PROFILE_STORAGE_ID)).toBeDefined();
    expect(await storage.get(MIGRATION_STORAGE_ID)).toBeDefined();
    result.store.lock();
  });

  it('is idempotent after completion and does not rewrite verified V2 records', async () => {
    const storage = new MemoryVaultStore();
    await putLegacyProfile(storage, {
      version: 1,
      mode: 'fedimint',
    });
    const first = await migrateV1ProfileToV2({
      ...MIGRATION_OPTIONS,
      storage,
    });
    first.store.lock();
    const firstProfileEnvelope = await storage.get(PROFILE_STORAGE_ID);
    const firstMigrationEnvelope = await storage.get(MIGRATION_STORAGE_ID);

    const second = await migrateV1ProfileToV2({
      ...MIGRATION_OPTIONS,
      storage,
    });

    expect(second.status).toBe('already-migrated');
    expect(await storage.get(PROFILE_STORAGE_ID)).toEqual(firstProfileEnvelope);
    expect(await storage.get(MIGRATION_STORAGE_ID)).toEqual(
      firstMigrationEnvelope,
    );
    second.store.lock();
  });

  it.each([
    ['keyring write', 'put', KEYRING_STORAGE_ID],
    ['profile write', 'put', PROFILE_STORAGE_ID],
    ['migration marker write', 'put', MIGRATION_STORAGE_ID],
    ['legacy deletion', 'delete', DEFAULT_V1_PROFILE_RECORD_ID],
  ] as const)(
    'resumes safely after interruption during %s',
    async (_label, operation, recordId) => {
      const storage = new FailOnceVaultStore(operation, recordId);
      await putLegacyProfile(storage, {
        version: 1,
        mode: 'fedimint',
      });
      storage.arm();

      await expect(
        migrateV1ProfileToV2({
          ...MIGRATION_OPTIONS,
          storage,
        }),
      ).rejects.toThrow('Injected storage interruption.');
      expect(await storage.get(DEFAULT_V1_PROFILE_RECORD_ID)).toBeDefined();

      const resumed = await migrateV1ProfileToV2({
        ...MIGRATION_OPTIONS,
        storage,
      });

      expect(['migrated', 'resumed']).toContain(resumed.status);
      expect(await storage.get(DEFAULT_V1_PROFILE_RECORD_ID)).toBeUndefined();
      expect(resumed.profile.payload.mode).toBe('fedimint');
      resumed.store.lock();
    },
  );

  it('keeps V1 when V2 write-back verification detects corruption', async () => {
    const storage = new CorruptOnceVaultStore(PROFILE_STORAGE_ID);
    await putLegacyProfile(storage, {
      version: 1,
      mode: 'fedimint',
    });
    storage.arm();

    await expect(
      migrateV1ProfileToV2({
        ...MIGRATION_OPTIONS,
        storage,
      }),
    ).rejects.toBeInstanceOf(EncryptedRecordWriteError);

    expect(await storage.get(DEFAULT_V1_PROFILE_RECORD_ID)).toBeDefined();
    expect(await storage.get(PROFILE_STORAGE_ID)).toBeUndefined();

    const resumed = await migrateV1ProfileToV2({
      ...MIGRATION_OPTIONS,
      storage,
    });
    expect(resumed.status).toBe('resumed');
    expect(await storage.get(DEFAULT_V1_PROFILE_RECORD_ID)).toBeUndefined();
    resumed.store.lock();
  });

  it('does not delete a V1 envelope that changed during migration', async () => {
    const replacementEnvelope = await createLegacyEnvelope({
      version: 1,
      mode: 'fedimint',
      activeFederation: {
        federationId: 'different-fed',
        displayName: 'Different federation',
        network: 'signet',
        modules: ['mint'],
        guardianCount: 3,
        clientName: 'default',
        joinedAtMs: 999,
      },
    });
    const storage = new MutatingLegacyVaultStore(replacementEnvelope);
    await putLegacyProfile(storage, {
      version: 1,
      mode: 'fedimint',
    });
    storage.arm();

    await expect(
      migrateV1ProfileToV2({
        ...MIGRATION_OPTIONS,
        storage,
      }),
    ).rejects.toBeInstanceOf(WalletProfileMigrationConflictError);

    expect(await storage.get(DEFAULT_V1_PROFILE_RECORD_ID)).toEqual(
      replacementEnvelope,
    );
  });

  it('rejects fake V1 profiles in production before writing any V2 state', async () => {
    const storage = new MemoryVaultStore();
    await putLegacyProfile(storage, {
      version: 1,
      mode: 'fake',
    });

    await expect(
      migrateV1ProfileToV2({
        ...MIGRATION_OPTIONS,
        runtime: 'production',
        storage,
      }),
    ).rejects.toBeInstanceOf(ProductionFakeProfileError);

    expect(await storage.get(DEFAULT_V1_PROFILE_RECORD_ID)).toBeDefined();
    expect(await storage.get(KEYRING_STORAGE_ID)).toBeUndefined();
  });

  it('also rejects an already-migrated fake profile when opened in production', async () => {
    const storage = new MemoryVaultStore();
    await putLegacyProfile(storage, {
      version: 1,
      mode: 'fake',
    });
    const developmentMigration = await migrateV1ProfileToV2({
      ...MIGRATION_OPTIONS,
      runtime: 'development',
      storage,
    });
    developmentMigration.store.lock();

    await expect(
      migrateV1ProfileToV2({
        ...MIGRATION_OPTIONS,
        runtime: 'production',
        storage,
      }),
    ).rejects.toBeInstanceOf(ProductionFakeProfileError);
  });

  it('strictly rejects malformed V1 profiles without creating V2 state', async () => {
    const storage = new MemoryVaultStore();
    await putLegacyProfile(storage, {
      version: 1,
      mode: 'fedimint',
      unexpected: true,
    });

    await expect(
      migrateV1ProfileToV2({
        ...MIGRATION_OPTIONS,
        storage,
      }),
    ).rejects.toThrow('Unsupported Version 1 wallet profile.');

    expect(await storage.get(DEFAULT_V1_PROFILE_RECORD_ID)).toBeDefined();
    expect(await storage.get(KEYRING_STORAGE_ID)).toBeUndefined();
  });
});

async function putLegacyProfile(
  storage: VaultStore,
  value: unknown,
): Promise<void> {
  await storage.put(
    DEFAULT_V1_PROFILE_RECORD_ID,
    await createLegacyEnvelope(value),
  );
}

async function createLegacyEnvelope(value: unknown): Promise<VaultEnvelope> {
  const created = await createVault(
    DEFAULT_V1_PROFILE_RECORD_ID,
    PASSPHRASE,
    value,
    { iterations: 1 },
  );
  created.session.lock();
  return created.envelope;
}

class FailOnceVaultStore implements VaultStore {
  private readonly storage = new MemoryVaultStore();
  private armed = false;

  constructor(
    private readonly operation: 'put' | 'delete',
    private readonly recordId: string,
  ) {}

  arm(): void {
    this.armed = true;
  }

  get(recordId: string): Promise<VaultEnvelope | undefined> {
    return this.storage.get(recordId);
  }

  async put(recordId: string, envelope: VaultEnvelope): Promise<void> {
    this.interrupt('put', recordId);
    await this.storage.put(recordId, envelope);
  }

  async delete(recordId: string): Promise<void> {
    this.interrupt('delete', recordId);
    await this.storage.delete(recordId);
  }

  private interrupt(operation: 'put' | 'delete', recordId: string): void {
    if (
      this.armed &&
      operation === this.operation &&
      recordId === this.recordId
    ) {
      this.armed = false;
      throw new Error('Injected storage interruption.');
    }
  }
}

class CorruptOnceVaultStore implements VaultStore {
  private readonly storage = new MemoryVaultStore();
  private armed = false;

  constructor(private readonly recordId: string) {}

  arm(): void {
    this.armed = true;
  }

  get(recordId: string): Promise<VaultEnvelope | undefined> {
    return this.storage.get(recordId);
  }

  async put(recordId: string, envelope: VaultEnvelope): Promise<void> {
    if (this.armed && recordId === this.recordId) {
      this.armed = false;
      await this.storage.put(recordId, {
        ...envelope,
        ciphertext: `${envelope.ciphertext.slice(0, -2)}AA`,
      });
      return;
    }
    await this.storage.put(recordId, envelope);
  }

  delete(recordId: string): Promise<void> {
    return this.storage.delete(recordId);
  }
}

class MutatingLegacyVaultStore implements VaultStore {
  private readonly storage = new MemoryVaultStore();
  private armed = false;
  private legacyReads = 0;

  constructor(private readonly replacementEnvelope: VaultEnvelope) {}

  arm(): void {
    this.armed = true;
  }

  async get(recordId: string): Promise<VaultEnvelope | undefined> {
    if (this.armed && recordId === DEFAULT_V1_PROFILE_RECORD_ID) {
      this.legacyReads += 1;
      if (this.legacyReads === 2) {
        this.armed = false;
        await this.storage.put(recordId, this.replacementEnvelope);
      }
    }
    return this.storage.get(recordId);
  }

  put(recordId: string, envelope: VaultEnvelope): Promise<void> {
    return this.storage.put(recordId, envelope);
  }

  delete(recordId: string): Promise<void> {
    return this.storage.delete(recordId);
  }
}
