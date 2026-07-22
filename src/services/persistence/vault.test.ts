import { describe, expect, it } from 'vitest';

import {
  createVault,
  unlockVault,
  VaultUnlockError,
  type VaultEnvelope,
} from './vault';

const TEST_ITERATIONS = 10;

describe('vault', () => {
  it('round-trips encrypted data and drops access after lock', async () => {
    const created = await createVault(
      'primary',
      'a strong test passphrase',
      {
        mode: 'fake',
        federationId: 'test-federation',
      },
      { iterations: TEST_ITERATIONS },
    );

    expect(JSON.stringify(created.envelope)).not.toContain('test-federation');

    const unlocked = await unlockVault<{
      mode: string;
      federationId: string;
    }>('primary', 'a strong test passphrase', created.envelope);

    expect(unlocked.read()).toEqual({
      mode: 'fake',
      federationId: 'test-federation',
    });

    unlocked.lock();
    expect(() => unlocked.read()).toThrow('Vault session is locked.');
  });

  it('uses a fresh IV and ciphertext for each seal', async () => {
    const created = await createVault(
      'primary',
      'a strong test passphrase',
      { value: 1 },
      { iterations: TEST_ITERATIONS },
    );

    const first = await created.session.seal({ value: 1 });
    const second = await created.session.seal({ value: 1 });

    expect(first.cipher.iv).not.toBe(second.cipher.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('returns the same generic error for a wrong passphrase or corruption', async () => {
    const created = await createVault(
      'primary',
      'the correct passphrase',
      { value: 1 },
      { iterations: TEST_ITERATIONS },
    );

    await expect(
      unlockVault('primary', 'the wrong passphrase', created.envelope),
    ).rejects.toBeInstanceOf(VaultUnlockError);

    const corrupted: VaultEnvelope = {
      ...created.envelope,
      ciphertext: `${created.envelope.ciphertext.slice(0, -2)}AA`,
    };

    await expect(
      unlockVault('primary', 'the correct passphrase', corrupted),
    ).rejects.toBeInstanceOf(VaultUnlockError);
  });

  it('binds ciphertext to its record identity with authenticated data', async () => {
    const created = await createVault(
      'primary',
      'a strong test passphrase',
      { value: 1 },
      { iterations: TEST_ITERATIONS },
    );

    await expect(
      unlockVault(
        'another-record',
        'a strong test passphrase',
        created.envelope,
      ),
    ).rejects.toBeInstanceOf(VaultUnlockError);
  });
});
