import type { VaultStore } from './vault-store';

export interface WalletDataEraseReport {
  readonly appRecordsCleared: boolean;
  readonly sdkDatabaseRemoved: boolean;
  readonly chatDatabaseRemoved: boolean;
  readonly cachesCleared: boolean;
  readonly cachesDeleted: number;
  readonly serviceWorkersCleared: boolean;
  readonly serviceWorkersUnregistered: number;
}

export interface WalletDataEraseOptions {
  readonly storage: VaultStore;
  readonly opfsRoot?: Pick<FileSystemDirectoryHandle, 'removeEntry'>;
  readonly cacheStorage?: Pick<CacheStorage, 'keys' | 'delete'>;
  readonly serviceWorkerContainer?: Pick<
    ServiceWorkerContainer,
    'getRegistrations'
  >;
}

export class WalletDataEraseError extends Error {
  readonly report: WalletDataEraseReport;

  constructor(report: WalletDataEraseReport, options: ErrorOptions = {}) {
    super('Wallet data could not be erased completely.', options);
    this.name = 'WalletDataEraseError';
    this.report = report;
  }
}

export async function eraseWalletData(
  options: WalletDataEraseOptions,
): Promise<WalletDataEraseReport> {
  const failures: unknown[] = [];
  let sdkDatabaseRemoved = false;
  let chatDatabaseRemoved = false;
  let appRecordsCleared = false;
  let cachesCleared = false;
  let cachesDeleted = 0;
  let serviceWorkersCleared = false;
  let serviceWorkersUnregistered = 0;

  let opfsRoot: Pick<FileSystemDirectoryHandle, 'removeEntry'> | undefined;
  try {
    opfsRoot = options.opfsRoot ?? (await navigator.storage.getDirectory());
  } catch (error) {
    failures.push(error);
  }
  if (opfsRoot !== undefined) {
    sdkDatabaseRemoved = await removeOpfsEntry(
      opfsRoot,
      'fedimint.db',
      false,
      failures,
    );
    chatDatabaseRemoved = await removeOpfsEntry(
      opfsRoot,
      'marmot-mdk-runtime',
      true,
      failures,
    );
  }

  try {
    if (options.storage.clear === undefined) {
      throw new TypeError('Application record storage cannot be cleared.');
    }
    await options.storage.clear();
    appRecordsCleared = true;
  } catch (error) {
    failures.push(error);
  }

  try {
    const cacheStorage = options.cacheStorage ?? globalThis.caches;
    if (cacheStorage !== undefined) {
      const cacheNames = await cacheStorage.keys();
      const results = await Promise.all(
        cacheNames.map((cacheName) => cacheStorage.delete(cacheName)),
      );
      cachesDeleted = results.filter(Boolean).length;
      if (cachesDeleted !== cacheNames.length) {
        throw new Error('One or more caches could not be deleted.');
      }
    }
    cachesCleared = true;
  } catch (error) {
    failures.push(error);
  }

  try {
    const serviceWorkerContainer =
      options.serviceWorkerContainer ?? navigator.serviceWorker;
    if (serviceWorkerContainer !== undefined) {
      const registrations = await serviceWorkerContainer.getRegistrations();
      const results = await Promise.all(
        registrations.map((registration) => registration.unregister()),
      );
      serviceWorkersUnregistered = results.filter(Boolean).length;
      if (serviceWorkersUnregistered !== registrations.length) {
        throw new Error(
          'One or more service workers could not be unregistered.',
        );
      }
    }
    serviceWorkersCleared = true;
  } catch (error) {
    failures.push(error);
  }

  const report = Object.freeze({
    appRecordsCleared,
    sdkDatabaseRemoved,
    chatDatabaseRemoved,
    cachesCleared,
    cachesDeleted,
    serviceWorkersCleared,
    serviceWorkersUnregistered,
  });
  if (failures.length > 0) {
    throw new WalletDataEraseError(report, { cause: failures[0] });
  }
  return report;
}

async function removeOpfsEntry(
  root: Pick<FileSystemDirectoryHandle, 'removeEntry'>,
  name: string,
  recursive: boolean,
  failures: unknown[],
): Promise<boolean> {
  try {
    await root.removeEntry(name, recursive ? { recursive: true } : undefined);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return true;
    failures.push(error);
    return false;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'NotFoundError';
}
