export type ChatRuntimeCapabilityName =
  | 'secure-context'
  | 'web-crypto'
  | 'web-assembly'
  | 'module-worker'
  | 'web-socket'
  | 'opfs';

export interface ChatRuntimeCapabilityReport {
  readonly supported: boolean;
  readonly missing: readonly ChatRuntimeCapabilityName[];
}

export interface ChatRuntimeCapabilityEnvironment {
  readonly isSecureContext: boolean;
  readonly crypto?: Crypto;
  readonly webAssembly?: typeof WebAssembly;
  readonly worker?: typeof Worker;
  readonly webSocket?: typeof WebSocket;
  readonly storage?: Pick<StorageManager, 'getDirectory'>;
}

export function inspectChatRuntimeCapabilities(
  environment: ChatRuntimeCapabilityEnvironment = {
    isSecureContext: globalThis.isSecureContext,
    crypto: globalThis.crypto,
    webAssembly: globalThis.WebAssembly,
    worker: globalThis.Worker,
    webSocket: globalThis.WebSocket,
    storage: typeof navigator === 'undefined' ? undefined : navigator.storage,
  },
): ChatRuntimeCapabilityReport {
  const missing: ChatRuntimeCapabilityName[] = [];
  if (!environment.isSecureContext) missing.push('secure-context');
  if (
    environment.crypto?.subtle === undefined ||
    typeof environment.crypto.getRandomValues !== 'function'
  ) {
    missing.push('web-crypto');
  }
  if (environment.webAssembly === undefined) missing.push('web-assembly');
  if (environment.worker === undefined) missing.push('module-worker');
  if (environment.webSocket === undefined) missing.push('web-socket');
  if (typeof environment.storage?.getDirectory !== 'function') {
    missing.push('opfs');
  }
  return Object.freeze({
    supported: missing.length === 0,
    missing: Object.freeze(missing),
  });
}
