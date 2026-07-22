import { describe, expect, it } from 'vitest';

import type { VaultEnvelope } from './vault';
import { MemoryVaultStore } from './vault-store';

const envelope: VaultEnvelope = {
  version: 1,
  kdf: {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 10,
    salt: 'c2FsdA==',
  },
  cipher: {
    name: 'AES-GCM',
    iv: 'aXY=',
  },
  ciphertext: 'Y2lwaGVydGV4dA==',
};

describe('MemoryVaultStore', () => {
  it('stores defensive copies and deletes records', async () => {
    const store = new MemoryVaultStore();

    await store.put('primary', envelope);
    const stored = await store.get('primary');
    expect(stored).toEqual(envelope);

    if (stored !== undefined) {
      stored.ciphertext = 'changed';
    }

    expect((await store.get('primary'))?.ciphertext).toBe(envelope.ciphertext);

    await store.delete('primary');
    expect(await store.get('primary')).toBeUndefined();
  });
});
