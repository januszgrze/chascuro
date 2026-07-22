export type CapabilityName =
  | 'secure-context'
  | 'web-crypto'
  | 'indexed-db'
  | 'service-worker'
  | 'web-locks'
  | 'opfs';

export interface CapabilityReport {
  supported: boolean;
  missing: CapabilityName[];
}

export interface CapabilityEnvironment {
  isSecureContext: boolean;
  crypto?: Crypto;
  indexedDB?: IDBFactory;
  serviceWorker?: ServiceWorkerContainer;
  locks?: LockManager;
  storage?: Pick<StorageManager, 'getDirectory'>;
}

export function inspectCapabilities(
  environment: CapabilityEnvironment = {
    isSecureContext: globalThis.isSecureContext,
    crypto: globalThis.crypto,
    indexedDB: globalThis.indexedDB,
    serviceWorker:
      typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
    locks: typeof navigator === 'undefined' ? undefined : navigator.locks,
    storage: typeof navigator === 'undefined' ? undefined : navigator.storage,
  },
): CapabilityReport {
  const missing: CapabilityName[] = [];

  if (!environment.isSecureContext) {
    missing.push('secure-context');
  }

  if (
    environment.crypto === undefined ||
    environment.crypto.subtle === undefined ||
    typeof environment.crypto.getRandomValues !== 'function'
  ) {
    missing.push('web-crypto');
  }

  if (environment.indexedDB === undefined) {
    missing.push('indexed-db');
  }

  if (environment.serviceWorker === undefined) {
    missing.push('service-worker');
  }

  if (environment.locks === undefined) {
    missing.push('web-locks');
  }

  if (
    environment.storage === undefined ||
    typeof environment.storage.getDirectory !== 'function'
  ) {
    missing.push('opfs');
  }

  return {
    supported: missing.length === 0,
    missing,
  };
}
