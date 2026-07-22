import { describe, expect, it, vi } from 'vitest';

import { WalletError, publicWalletError } from '../../domain';
import {
  ExclusiveWalletOwner,
  type ExclusiveLock,
  type ExclusiveLockManager,
  type ExclusiveLockRequestOptions,
} from './exclusive-wallet-owner';

interface LockRequestRecord {
  readonly name: string;
  readonly options: ExclusiveLockRequestOptions;
}

class TestLockManager implements ExclusiveLockManager {
  readonly requests: LockRequestRecord[] = [];
  private held = false;

  async request(
    name: string,
    options: ExclusiveLockRequestOptions,
    callback: (lock: ExclusiveLock | null) => Promise<void>,
  ): Promise<void> {
    this.requests.push({ name, options });
    if (this.held) {
      await callback(null);
      return;
    }

    this.held = true;
    try {
      await callback({ name, mode: 'exclusive' });
    } finally {
      this.held = false;
    }
  }
}

describe('ExclusiveWalletOwner', () => {
  it('holds one exclusive Web Lock and fails closed for another owner', async () => {
    const lockManager = new TestLockManager();
    const first = new ExclusiveWalletOwner({ lockManager });
    const second = new ExclusiveWalletOwner({ lockManager });

    await first.acquire();

    expect(first.ownsWallet).toBe(true);
    expect(lockManager.requests[0]).toMatchObject({
      options: {
        mode: 'exclusive',
        ifAvailable: true,
      },
    });
    await expect(second.acquire()).rejects.toMatchObject({
      code: 'another_wallet_tab_active',
      message: publicWalletError('another_wallet_tab_active').message,
    });
    expect(second.ownsWallet).toBe(false);

    await first.release();
    await second.acquire();
    expect(second.ownsWallet).toBe(true);
    await second.dispose();
  });

  it('deduplicates concurrent acquisition on the same owner', async () => {
    const lockManager = new TestLockManager();
    const owner = new ExclusiveWalletOwner({ lockManager });

    await Promise.all([owner.acquire(), owner.acquire()]);

    expect(lockManager.requests).toHaveLength(1);
    expect(owner.ownsWallet).toBe(true);
    await owner.dispose();
  });

  it('requires a real lock manager instead of an unsafe coordination fallback', async () => {
    const owner = new ExclusiveWalletOwner({ lockManager: null });

    await expect(owner.acquire()).rejects.toMatchObject({
      code: 'unsupported_environment',
    });
    expect(owner.ownsWallet).toBe(false);
  });

  it('normalizes opaque lock failures without leaking their details', async () => {
    const secret = 'backend owner token: do-not-expose';
    const lockManager: ExclusiveLockManager = {
      request: vi.fn().mockRejectedValue(new Error(secret)),
    };
    const owner = new ExclusiveWalletOwner({ lockManager });

    const error = await owner.acquire().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(WalletError);
    expect(error).toMatchObject({ code: 'another_wallet_tab_active' });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify((error as WalletError).toJSON())).not.toContain(
      secret,
    );
  });

  it('normalizes a synchronous lock-manager throw', async () => {
    const lockManager: ExclusiveLockManager = {
      request() {
        throw new Error('synchronous implementation detail');
      },
    };
    const owner = new ExclusiveWalletOwner({ lockManager });

    await expect(owner.acquire()).rejects.toMatchObject({
      code: 'another_wallet_tab_active',
    });
    expect(owner.ownsWallet).toBe(false);
  });

  it('fails closed if a lock request resolves without invoking its callback', async () => {
    const lockManager: ExclusiveLockManager = {
      request: vi.fn().mockResolvedValue(undefined),
    };
    const owner = new ExclusiveWalletOwner({ lockManager });

    await expect(owner.acquire()).rejects.toMatchObject({
      code: 'another_wallet_tab_active',
    });
    expect(owner.ownsWallet).toBe(false);
  });

  it('releases ownership and becomes permanently inert on disposal', async () => {
    const lockManager = new TestLockManager();
    const owner = new ExclusiveWalletOwner({ lockManager });

    await owner.acquire();
    await owner.dispose();
    await owner.dispose();

    expect(owner.ownsWallet).toBe(false);
    await expect(owner.acquire()).rejects.toMatchObject({
      code: 'wallet_locked',
    });

    const replacement = new ExclusiveWalletOwner({ lockManager });
    await replacement.acquire();
    expect(replacement.ownsWallet).toBe(true);
    await replacement.dispose();
  });

  it('rejects a pending acquisition and ignores a late grant after disposal', async () => {
    let callback: ((lock: ExclusiveLock | null) => Promise<void>) | undefined;
    let finishRequest: (() => void) | undefined;
    const lockManager: ExclusiveLockManager = {
      request(_name, _options, grantedCallback) {
        callback = grantedCallback;
        return new Promise<void>((resolve) => {
          finishRequest = resolve;
        });
      },
    };
    const owner = new ExclusiveWalletOwner({ lockManager });
    const acquisition = owner.acquire().catch((error: unknown) => error);

    const disposing = owner.dispose();
    const acquisitionError = await acquisition;
    expect(acquisitionError).toMatchObject({ code: 'wallet_locked' });

    await callback?.({
      name: 'fedimint-wallet-exclusive-owner-v1',
      mode: 'exclusive',
    });
    finishRequest?.();
    await disposing;

    expect(owner.ownsWallet).toBe(false);
  });
});
