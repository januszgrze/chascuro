import { describe, expect, it } from 'vitest';

import {
  EncryptedRecordCorruptError,
  EncryptedRecordStore,
  EncryptedRecordStoreLockedError,
  EncryptedRecordWriteError,
  encryptedRecordStorageId,
  type EncryptedRecordSchema,
} from './encrypted-record-store';
import type { VaultEnvelope } from './vault';
import { MemoryVaultStore, type VaultStore } from './vault-store';

interface TestSettings {
  readonly enabled: boolean;
  readonly labels: readonly string[];
}

const settingsSchema: EncryptedRecordSchema<TestSettings> = Object.freeze({
  kind: 'settings',
  version: 1,
  parse(value: unknown): TestSettings {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      typeof value.enabled !== 'boolean' ||
      !Array.isArray(value.labels) ||
      !value.labels.every((entry) => typeof entry === 'string')
    ) {
      throw new TypeError('Invalid test settings.');
    }
    return Object.freeze({
      enabled: value.enabled,
      labels: Object.freeze([...value.labels]),
    });
  },
});

const STORE_OPTIONS = {
  passphrase: 'a sufficiently strong test passphrase',
  vaultOptions: { iterations: 1 },
  recordKdfIterations: 1,
} as const;

describe('EncryptedRecordStore', () => {
  it('stores independently encrypted typed records with versioned timestamps', async () => {
    const storage = new MemoryVaultStore();
    let nowMs = 100;
    const store = await EncryptedRecordStore.create({
      ...STORE_OPTIONS,
      storage,
      now: () => nowMs,
    });

    const first = await store.put(settingsSchema, 'primary', {
      enabled: true,
      labels: ['one'],
    });
    const firstEnvelope = await storage.get(
      encryptedRecordStorageId('primary-wallet', 'settings', 'primary'),
    );

    nowMs = 200;
    const second = await store.put(settingsSchema, 'primary', {
      enabled: true,
      labels: ['one'],
    });
    const secondEnvelope = await storage.get(
      encryptedRecordStorageId('primary-wallet', 'settings', 'primary'),
    );

    expect(first).toEqual({
      kind: 'settings',
      id: 'primary',
      schemaVersion: 1,
      createdAtMs: 100,
      updatedAtMs: 100,
      payload: { enabled: true, labels: ['one'] },
    });
    expect(second.createdAtMs).toBe(100);
    expect(second.updatedAtMs).toBe(200);
    expect(secondEnvelope?.cipher.iv).not.toBe(firstEnvelope?.cipher.iv);
    expect(secondEnvelope?.ciphertext).not.toBe(firstEnvelope?.ciphertext);
    expect(JSON.stringify(secondEnvelope)).not.toContain('"enabled"');
    expect(await store.get(settingsSchema, 'primary')).toEqual(second);
  });

  it('binds each ciphertext to its kind and record ID', async () => {
    const storage = new MemoryVaultStore();
    const store = await EncryptedRecordStore.create({
      ...STORE_OPTIONS,
      storage,
    });
    await store.put(settingsSchema, 'source', {
      enabled: true,
      labels: [],
    });

    const sourceId = encryptedRecordStorageId(
      'primary-wallet',
      'settings',
      'source',
    );
    const targetId = encryptedRecordStorageId(
      'primary-wallet',
      'settings',
      'target',
    );
    const sourceEnvelope = await storage.get(sourceId);
    expect(sourceEnvelope).toBeDefined();
    await storage.put(targetId, sourceEnvelope as VaultEnvelope);

    await expect(store.get(settingsSchema, 'target')).rejects.toBeInstanceOf(
      EncryptedRecordCorruptError,
    );
    expect((await store.get(settingsSchema, 'source'))?.payload.enabled).toBe(
      true,
    );
  });

  it('strictly validates payload and record schema versions', async () => {
    const storage = new MemoryVaultStore();
    const store = await EncryptedRecordStore.create({
      ...STORE_OPTIONS,
      storage,
    });

    await expect(
      store.put(settingsSchema, 'primary', {
        enabled: true,
        labels: [],
        unexpected: true,
      }),
    ).rejects.toThrow('Invalid test settings.');

    await store.put(settingsSchema, 'primary', {
      enabled: true,
      labels: [],
    });
    const incompatibleSchema: EncryptedRecordSchema<TestSettings> = {
      ...settingsSchema,
      version: 2,
    };
    await expect(
      store.get(incompatibleSchema, 'primary'),
    ).rejects.toBeInstanceOf(EncryptedRecordCorruptError);
  });

  it('rolls back an existing record when write-back verification fails', async () => {
    const storage = new CorruptingVaultStore();
    const store = await EncryptedRecordStore.create({
      ...STORE_OPTIONS,
      storage,
    });
    await store.put(settingsSchema, 'primary', {
      enabled: false,
      labels: ['old'],
    });

    storage.corruptNextPutFor(
      encryptedRecordStorageId('primary-wallet', 'settings', 'primary'),
    );
    await expect(
      store.put(settingsSchema, 'primary', {
        enabled: true,
        labels: ['new'],
      }),
    ).rejects.toMatchObject({
      name: EncryptedRecordWriteError.name,
      rollbackFailed: false,
    });

    expect((await store.get(settingsSchema, 'primary'))?.payload).toEqual({
      enabled: false,
      labels: ['old'],
    });
  });

  it('drops access to all records when the keyring session locks', async () => {
    const storage = new MemoryVaultStore();
    const store = await EncryptedRecordStore.create({
      ...STORE_OPTIONS,
      storage,
    });
    await store.put(settingsSchema, 'primary', {
      enabled: true,
      labels: [],
    });

    store.lock();

    expect(store.isLocked).toBe(true);
    await expect(store.get(settingsSchema, 'primary')).rejects.toBeInstanceOf(
      EncryptedRecordStoreLockedError,
    );
    await expect(
      store.put(settingsSchema, 'another', {
        enabled: false,
        labels: [],
      }),
    ).rejects.toBeInstanceOf(EncryptedRecordStoreLockedError);
  });

  it('can reopen a verified keyring without rewriting records', async () => {
    const storage = new MemoryVaultStore();
    const created = await EncryptedRecordStore.create({
      ...STORE_OPTIONS,
      storage,
    });
    await created.put(settingsSchema, 'primary', {
      enabled: true,
      labels: ['persisted'],
    });
    created.lock();

    const reopened = await EncryptedRecordStore.open({
      storage,
      passphrase: STORE_OPTIONS.passphrase,
      recordKdfIterations: 1,
    });

    expect((await reopened.get(settingsSchema, 'primary'))?.payload).toEqual({
      enabled: true,
      labels: ['persisted'],
    });
  });
});

class CorruptingVaultStore implements VaultStore {
  private readonly storage = new MemoryVaultStore();
  private corruptId: string | undefined;

  corruptNextPutFor(recordId: string): void {
    this.corruptId = recordId;
  }

  get(recordId: string): Promise<VaultEnvelope | undefined> {
    return this.storage.get(recordId);
  }

  async put(recordId: string, envelope: VaultEnvelope): Promise<void> {
    if (recordId === this.corruptId) {
      this.corruptId = undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
