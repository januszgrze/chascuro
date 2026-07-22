import { type DBSchema, openDB } from 'idb';

import type { VaultEnvelope } from './vault';

export interface VaultStore {
  get(recordId: string): Promise<VaultEnvelope | undefined>;
  put(recordId: string, envelope: VaultEnvelope): Promise<void>;
  delete(recordId: string): Promise<void>;
  clear?(): Promise<void>;
}

interface WalletDatabase extends DBSchema {
  vault: {
    key: string;
    value: VaultEnvelope;
  };
}

export class IndexedDbVaultStore implements VaultStore {
  private readonly database = openDB<WalletDatabase>('fedimint-wallet', 1, {
    upgrade(database) {
      database.createObjectStore('vault');
    },
  });

  async get(recordId: string): Promise<VaultEnvelope | undefined> {
    return (await this.database).get('vault', recordId);
  }

  async put(recordId: string, envelope: VaultEnvelope): Promise<void> {
    await (await this.database).put('vault', envelope, recordId);
  }

  async delete(recordId: string): Promise<void> {
    await (await this.database).delete('vault', recordId);
  }

  async clear(): Promise<void> {
    await (await this.database).clear('vault');
  }
}

export class MemoryVaultStore implements VaultStore {
  private readonly records = new Map<string, VaultEnvelope>();

  async get(recordId: string): Promise<VaultEnvelope | undefined> {
    const envelope = this.records.get(recordId);
    return envelope === undefined ? undefined : structuredClone(envelope);
  }

  async put(recordId: string, envelope: VaultEnvelope): Promise<void> {
    this.records.set(recordId, structuredClone(envelope));
  }

  async delete(recordId: string): Promise<void> {
    this.records.delete(recordId);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}
