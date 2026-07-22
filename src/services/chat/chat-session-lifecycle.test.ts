import { describe, expect, it, vi } from 'vitest';

import { ChatError } from '../../domain';
import {
  EncryptedRecordStore,
  encryptedRecordKeyringStorageId,
} from '../persistence/encrypted-record-store';
import type { VaultEnvelope } from '../persistence/vault';
import { MemoryVaultStore } from '../persistence/vault-store';
import { FakeChatService } from './fake-chat-service';
import {
  CHAT_RECORD_NAMESPACE,
  EncryptedChatSessionLifecycle,
  type ChatLifecycleEvent,
} from './chat-session-lifecycle';

const PASSPHRASE = 'a sufficiently strong test passphrase';

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('EncryptedChatSessionLifecycle', () => {
  it('creates a separate encrypted namespace and wipes the handed-off key copy', async () => {
    const storage = new MemoryVaultStore();
    const walletRecords = await EncryptedRecordStore.create({
      storage,
      passphrase: PASSPHRASE,
      namespace: 'primary-wallet',
      vaultOptions: { iterations: 1 },
    });
    walletRecords.lock();
    const service = new FakeChatService();
    let handedOffKey: Uint8Array | undefined;
    let handedOffIdentitySecret: Uint8Array | undefined;
    const open = service.open.bind(service);
    vi.spyOn(service, 'open').mockImplementation(async (input) => {
      handedOffKey = input.storageKey;
      handedOffIdentitySecret = input.identitySecret;
      return open(input);
    });
    const lifecycle = new EncryptedChatSessionLifecycle({
      service,
      vaultIterations: 1,
    });

    await expect(
      lifecycle.openOrCreate({
        storage,
        passphrase: PASSPHRASE,
        signal: signal(),
      }),
    ).resolves.toMatchObject({ status: 'available' });

    expect(
      await storage.get(encryptedRecordKeyringStorageId(CHAT_RECORD_NAMESPACE)),
    ).toBeDefined();
    expect(
      await storage.get(encryptedRecordKeyringStorageId('primary-wallet')),
    ).toBeDefined();
    expect(CHAT_RECORD_NAMESPACE).not.toBe('primary-wallet');
    expect(handedOffKey).toBeDefined();
    expect([...(handedOffKey ?? [])]).toEqual(new Array(32).fill(0));
    expect(handedOffIdentitySecret).toBeDefined();
    expect([...(handedOffIdentitySecret ?? [])]).toEqual(new Array(32).fill(0));
  });

  it('reopens with the same chat database key without sharing wallet key material', async () => {
    const storage = new MemoryVaultStore();
    const service = new FakeChatService();
    const observedKeys: number[][] = [];
    const observedIdentitySecrets: number[][] = [];
    const open = service.open.bind(service);
    vi.spyOn(service, 'open').mockImplementation(async (input) => {
      observedKeys.push([...input.storageKey]);
      observedIdentitySecrets.push([...(input.identitySecret ?? [])]);
      return open(input);
    });
    const lifecycle = new EncryptedChatSessionLifecycle({
      service,
      vaultIterations: 1,
    });

    await lifecycle.openOrCreate({
      storage,
      passphrase: PASSPHRASE,
      signal: signal(),
    });
    lifecycle.quiesce();
    await lifecycle.stop();
    lifecycle.lock();
    await lifecycle.openOrCreate({
      storage,
      passphrase: PASSPHRASE,
      signal: signal(),
    });

    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toEqual(observedKeys[1]);
    expect(new Set(observedKeys[0])).not.toEqual(new Set([0]));
    expect(observedIdentitySecrets).toHaveLength(2);
    expect(observedIdentitySecrets[0]).toEqual(observedIdentitySecrets[1]);
    expect(new Set(observedIdentitySecrets[0])).not.toEqual(new Set([0]));
  });

  it('contains corrupt chat storage as a chat-only degraded state', async () => {
    const storage = new MemoryVaultStore();
    const first = new EncryptedChatSessionLifecycle({
      service: new FakeChatService(),
      vaultIterations: 1,
    });
    await first.openOrCreate({
      storage,
      passphrase: PASSPHRASE,
      signal: signal(),
    });
    first.lock();

    const keyringId = encryptedRecordKeyringStorageId(CHAT_RECORD_NAMESPACE);
    const envelope = await storage.get(keyringId);
    expect(envelope).toBeDefined();
    await storage.put(keyringId, corrupt(envelope as VaultEnvelope));

    const lifecycle = new EncryptedChatSessionLifecycle({
      service: new FakeChatService(),
      vaultIterations: 1,
    });
    await expect(
      lifecycle.openOrCreate({
        storage,
        passphrase: PASSPHRASE,
        signal: signal(),
      }),
    ).resolves.toEqual({
      status: 'degraded',
      reason: 'storage_corrupt',
      retryable: false,
    });
  });

  it('preserves bounded service failures and emits only static lifecycle events', async () => {
    const events: ChatLifecycleEvent[] = [];
    const service = new FakeChatService();
    vi.spyOn(service, 'open').mockRejectedValue(
      new ChatError('relay_unavailable'),
    );
    const lifecycle = new EncryptedChatSessionLifecycle({
      service,
      vaultIterations: 1,
      logger: { event: (event) => events.push(event) },
    });

    await expect(
      lifecycle.openOrCreate({
        storage: new MemoryVaultStore(),
        passphrase: PASSPHRASE,
        signal: signal(),
      }),
    ).resolves.toEqual({
      status: 'degraded',
      reason: 'relay_unavailable',
      retryable: true,
    });
    expect(events).toEqual(['open_started', 'open_degraded']);
  });

  it('quiesces, stops, locks, and disposes in fail-closed order', async () => {
    const events: ChatLifecycleEvent[] = [];
    const lifecycle = new EncryptedChatSessionLifecycle({
      service: new FakeChatService(),
      vaultIterations: 1,
      logger: { event: (event) => events.push(event) },
    });
    await lifecycle.openOrCreate({
      storage: new MemoryVaultStore(),
      passphrase: PASSPHRASE,
      signal: signal(),
    });

    lifecycle.quiesce();
    await lifecycle.stop();
    lifecycle.lock();
    await lifecycle.dispose();

    expect(events.slice(0, 5)).toEqual([
      'open_started',
      'open_available',
      'quiesced',
      'stopped',
      'locked',
    ]);
    expect(events.at(-1)).toBe('disposed');
    expect(lifecycle.getAvailability()).toEqual({ status: 'disabled' });
  });
});

function corrupt(envelope: VaultEnvelope): VaultEnvelope {
  const first = envelope.ciphertext[0] === 'A' ? 'B' : 'A';
  return { ...envelope, ciphertext: `${first}${envelope.ciphertext.slice(1)}` };
}
