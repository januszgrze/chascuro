import { WalletError } from '../../domain';

export interface ExclusiveLock {
  readonly name: string;
  readonly mode: 'exclusive';
}

export interface ExclusiveLockRequestOptions {
  readonly mode: 'exclusive';
  readonly ifAvailable: true;
}

/**
 * Minimal injectable subset of the Web Locks API used by wallet ownership.
 */
export interface ExclusiveLockManager {
  request(
    name: string,
    options: ExclusiveLockRequestOptions,
    callback: (lock: ExclusiveLock | null) => Promise<void>,
  ): Promise<void>;
}

export interface ExclusiveWalletOwnerOptions {
  readonly lockName?: string;
  /**
   * `undefined` selects `navigator.locks`; `null` explicitly disables it.
   */
  readonly lockManager?: ExclusiveLockManager | LockManager | null;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface OwnershipAttempt {
  readonly acquired: Deferred<void>;
  readonly releaseGate: Deferred<void>;
  requestCompletion: Promise<void> | undefined;
  releaseCompletion: Promise<void> | undefined;
  granted: boolean;
  releaseRequested: boolean;
}

export const DEFAULT_WALLET_OWNERSHIP_LOCK_NAME =
  'fedimint-wallet-exclusive-owner-v1';

/**
 * Holds an origin-scoped exclusive Web Lock for the unlocked wallet lifetime.
 *
 * No BroadcastChannel/local-storage fallback is provided: those mechanisms
 * cannot safely act as the wallet database mutex.
 */
export class ExclusiveWalletOwner {
  private readonly lockName: string;
  private readonly lockManager: ExclusiveLockManager | undefined;

  private attempt: OwnershipAttempt | undefined;
  private disposed = false;
  private disposeCompletion: Promise<void> | undefined;

  constructor(options: ExclusiveWalletOwnerOptions = {}) {
    const lockName =
      options.lockName?.trim() || DEFAULT_WALLET_OWNERSHIP_LOCK_NAME;
    this.lockName = lockName;
    this.lockManager =
      options.lockManager === undefined
        ? browserLockManager()
        : ((options.lockManager as ExclusiveLockManager | null) ?? undefined);
  }

  get ownsWallet(): boolean {
    return this.attempt?.granted === true && !this.attempt.releaseRequested;
  }

  acquire(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new WalletError('wallet_locked'));
    }

    if (this.lockManager === undefined) {
      return Promise.reject(new WalletError('unsupported_environment'));
    }

    const currentAttempt = this.attempt;
    if (currentAttempt !== undefined) {
      if (currentAttempt.releaseRequested) {
        return (currentAttempt.releaseCompletion ?? Promise.resolve()).then(
          () => this.acquire(),
        );
      }
      return currentAttempt.acquired.promise;
    }

    const attempt: OwnershipAttempt = {
      acquired: createDeferred<void>(),
      releaseGate: createDeferred<void>(),
      requestCompletion: undefined,
      releaseCompletion: undefined,
      granted: false,
      releaseRequested: false,
    };
    this.attempt = attempt;

    let request: Promise<void>;
    try {
      request = this.lockManager.request(
        this.lockName,
        {
          mode: 'exclusive',
          ifAvailable: true,
        },
        async (lock) => {
          await this.holdGrantedLock(attempt, lock);
        },
      );
    } catch {
      this.rejectAcquisition(attempt, 'another_wallet_tab_active');
      return attempt.acquired.promise;
    }

    attempt.requestCompletion = request.then(
      () => {
        this.finishRequest(attempt);
      },
      () => {
        this.finishRequest(attempt);
      },
    );

    return attempt.acquired.promise;
  }

  release(): Promise<void> {
    const attempt = this.attempt;
    if (attempt === undefined) {
      return Promise.resolve();
    }
    return this.releaseAttempt(attempt);
  }

  dispose(): Promise<void> {
    if (this.disposeCompletion !== undefined) {
      return this.disposeCompletion;
    }

    this.disposed = true;
    const attempt = this.attempt;
    this.disposeCompletion =
      attempt === undefined ? Promise.resolve() : this.releaseAttempt(attempt);
    return this.disposeCompletion;
  }

  private async holdGrantedLock(
    attempt: OwnershipAttempt,
    lock: ExclusiveLock | null,
  ): Promise<void> {
    if (this.disposed || this.attempt !== attempt || attempt.releaseRequested) {
      return;
    }

    if (lock === null) {
      this.rejectAcquisition(attempt, 'another_wallet_tab_active');
      return;
    }

    attempt.granted = true;
    attempt.acquired.resolve();

    try {
      await attempt.releaseGate.promise;
    } finally {
      attempt.granted = false;
    }
  }

  private rejectAcquisition(
    attempt: OwnershipAttempt,
    code: 'another_wallet_tab_active' | 'wallet_locked',
  ): void {
    if (this.attempt === attempt) {
      this.attempt = undefined;
    }
    attempt.acquired.reject(new WalletError(code));
  }

  private finishRequest(attempt: OwnershipAttempt): void {
    attempt.granted = false;

    if (!attempt.acquired.settled) {
      this.rejectAcquisition(
        attempt,
        attempt.releaseRequested || this.disposed
          ? 'wallet_locked'
          : 'another_wallet_tab_active',
      );
      return;
    }

    if (this.attempt === attempt) {
      this.attempt = undefined;
    }
  }

  private releaseAttempt(attempt: OwnershipAttempt): Promise<void> {
    if (attempt.releaseCompletion !== undefined) {
      return attempt.releaseCompletion;
    }

    attempt.releaseRequested = true;
    if (!attempt.acquired.settled) {
      attempt.acquired.reject(new WalletError('wallet_locked'));
    }
    attempt.releaseGate.resolve();

    attempt.releaseCompletion = (
      attempt.requestCompletion ?? Promise.resolve()
    ).then(() => {
      attempt.granted = false;
      if (this.attempt === attempt) {
        this.attempt = undefined;
      }
    });
    return attempt.releaseCompletion;
  }
}

function browserLockManager(): ExclusiveLockManager | undefined {
  try {
    if (typeof navigator === 'undefined' || navigator.locks === undefined) {
      return undefined;
    }
    return navigator.locks as unknown as ExclusiveLockManager;
  } catch {
    return undefined;
  }
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise(value);
    },
    reject(reason) {
      if (settled) {
        return;
      }
      settled = true;
      rejectPromise(reason);
    },
  };
}
