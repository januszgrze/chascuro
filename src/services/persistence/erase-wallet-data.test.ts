import { describe, expect, it, vi } from 'vitest';

import { MemoryVaultStore } from './vault-store';
import { eraseWalletData, WalletDataEraseError } from './erase-wallet-data';

describe('eraseWalletData', () => {
  it('removes wallet and chat databases, app records, caches, and workers', async () => {
    const storage = new MemoryVaultStore();
    const removeEntry = vi.fn().mockResolvedValue(undefined);
    const cacheStorage = {
      keys: vi.fn().mockResolvedValue(['wallet-a', 'wallet-b']),
      delete: vi.fn().mockResolvedValue(true),
    };
    const unregister = vi.fn().mockResolvedValue(true);
    const serviceWorkerContainer = {
      getRegistrations: vi
        .fn()
        .mockResolvedValue([{ unregister }, { unregister }]),
    };

    const report = await eraseWalletData({
      storage,
      opfsRoot: { removeEntry },
      cacheStorage,
      serviceWorkerContainer,
    });

    expect(removeEntry).toHaveBeenCalledWith('fedimint.db', undefined);
    expect(removeEntry).toHaveBeenCalledWith('marmot-mdk-runtime', {
      recursive: true,
    });
    expect(cacheStorage.delete).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(report).toEqual({
      appRecordsCleared: true,
      sdkDatabaseRemoved: true,
      chatDatabaseRemoved: true,
      cachesCleared: true,
      cachesDeleted: 2,
      serviceWorkersCleared: true,
      serviceWorkersUnregistered: 2,
    });
  });

  it('treats an already absent SDK database as an idempotent success', async () => {
    const storage = new MemoryVaultStore();

    await expect(
      eraseWalletData({
        storage,
        opfsRoot: {
          removeEntry: vi
            .fn()
            .mockRejectedValue(new DOMException('missing', 'NotFoundError')),
        },
        cacheStorage: {
          keys: vi.fn().mockResolvedValue([]),
          delete: vi.fn(),
        },
        serviceWorkerContainer: {
          getRegistrations: vi.fn().mockResolvedValue([]),
        },
      }),
    ).resolves.toMatchObject({
      sdkDatabaseRemoved: true,
      chatDatabaseRemoved: true,
    });
  });

  it('attempts every erase domain and reports failures independently', async () => {
    const storage = new MemoryVaultStore();
    const clear = vi.spyOn(storage, 'clear');
    const removeEntry = vi
      .fn()
      .mockRejectedValueOnce(new Error('wallet database busy'))
      .mockResolvedValueOnce(undefined);
    const deleteCache = vi.fn().mockResolvedValue(false);
    const unregister = vi.fn().mockResolvedValue(true);

    const error = await eraseWalletData({
      storage,
      opfsRoot: { removeEntry },
      cacheStorage: {
        keys: vi.fn().mockResolvedValue(['wallet-cache']),
        delete: deleteCache,
      },
      serviceWorkerContainer: {
        getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WalletDataEraseError);
    expect(error).toMatchObject({
      report: {
        appRecordsCleared: true,
        sdkDatabaseRemoved: false,
        chatDatabaseRemoved: true,
        cachesCleared: false,
        cachesDeleted: 0,
        serviceWorkersCleared: true,
        serviceWorkersUnregistered: 1,
      },
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('fails closed when application record storage cannot be cleared', async () => {
    await expect(
      eraseWalletData({
        storage: {
          get: vi.fn(),
          put: vi.fn(),
          delete: vi.fn(),
        },
        opfsRoot: {
          removeEntry: vi.fn().mockResolvedValue(undefined),
        },
        cacheStorage: {
          keys: vi.fn().mockResolvedValue([]),
          delete: vi.fn(),
        },
        serviceWorkerContainer: {
          getRegistrations: vi.fn().mockResolvedValue([]),
        },
      }),
    ).rejects.toBeInstanceOf(WalletDataEraseError);
  });
});
