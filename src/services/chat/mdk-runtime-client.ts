import {
  isMdkRuntimeResponse,
  MDK_RUNTIME_RPC_SCHEMA_VERSION,
  parseMdkRuntimeInfo,
  type MdkRuntimeInfo,
  type MdkRuntimeInfoRequest,
} from './mdk-runtime-rpc';

const RUNTIME_START_TIMEOUT_MS = 15_000;

/**
 * Loads the Rust MDK module in a dedicated worker and returns its build
 * identity. The worker is intentionally one-shot until WP1 adds a long-lived
 * command queue and lifecycle owner.
 */
export function probeMdkRuntime(
  storageKey: Uint8Array,
): Promise<MdkRuntimeInfo> {
  if (storageKey.length !== 32) {
    return Promise.reject(
      new Error('The MDK runtime requires a 32-byte chat database key.'),
    );
  }
  const worker = new Worker(new URL('./mdk-worker.ts', import.meta.url), {
    name: 'marmot-mdk-runtime',
    type: 'module',
  });
  const request: MdkRuntimeInfoRequest = {
    id: 1,
    method: 'runtime_info',
    schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
    storageKey: storageKey.slice(),
  };

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('The MDK runtime did not start in time.'));
    }, RUNTIME_START_TIMEOUT_MS);

    worker.addEventListener(
      'message',
      (event: MessageEvent<unknown>) => {
        window.clearTimeout(timeout);
        worker.terminate();

        if (!isMdkRuntimeResponse(event.data) || event.data.id !== request.id) {
          reject(new Error('The MDK runtime returned an invalid response.'));
          return;
        }

        if (!event.data.ok) {
          reject(new Error(event.data.error.message));
          return;
        }

        resolve(parseMdkRuntimeInfo(event.data.result));
      },
      { once: true },
    );

    worker.addEventListener(
      'error',
      (event: ErrorEvent) => {
        window.clearTimeout(timeout);
        worker.terminate();
        reject(
          new Error(
            event.message.length > 0
              ? `The MDK runtime worker failed: ${event.message}`
              : 'The MDK runtime worker failed to load.',
          ),
        );
      },
      { once: true },
    );

    worker.postMessage(request);
  });
}
