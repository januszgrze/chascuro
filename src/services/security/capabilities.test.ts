import { describe, expect, it } from 'vitest';

import { inspectCapabilities } from './capabilities';

describe('inspectCapabilities', () => {
  it('reports every missing wallet capability', () => {
    expect(
      inspectCapabilities({
        isSecureContext: false,
      }),
    ).toEqual({
      supported: false,
      missing: [
        'secure-context',
        'web-crypto',
        'indexed-db',
        'service-worker',
        'web-locks',
        'opfs',
      ],
    });
  });

  it('accepts a complete browser environment', () => {
    expect(
      inspectCapabilities({
        isSecureContext: true,
        crypto,
        indexedDB,
        serviceWorker: {} as ServiceWorkerContainer,
        locks: {} as LockManager,
        storage: {
          getDirectory: async () => ({}) as FileSystemDirectoryHandle,
        },
      }),
    ).toEqual({
      supported: true,
      missing: [],
    });
  });
});
