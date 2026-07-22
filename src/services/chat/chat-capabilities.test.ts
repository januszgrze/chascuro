import { describe, expect, it } from 'vitest';

import { inspectChatRuntimeCapabilities } from './chat-capabilities';

describe('inspectChatRuntimeCapabilities', () => {
  it('reports each missing chat runtime dependency without disabling the wallet', () => {
    expect(inspectChatRuntimeCapabilities({ isSecureContext: false })).toEqual({
      supported: false,
      missing: [
        'secure-context',
        'web-crypto',
        'web-assembly',
        'module-worker',
        'web-socket',
        'opfs',
      ],
    });
  });

  it('accepts the complete Chromium runtime surface', () => {
    expect(
      inspectChatRuntimeCapabilities({
        isSecureContext: true,
        crypto,
        webAssembly: WebAssembly,
        worker: class {} as unknown as typeof Worker,
        webSocket: class {} as unknown as typeof WebSocket,
        storage: {
          getDirectory: async () => ({}) as FileSystemDirectoryHandle,
        },
      }),
    ).toEqual({ supported: true, missing: [] });
  });
});
