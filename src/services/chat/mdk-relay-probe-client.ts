import { MDK_RUNTIME_RPC_SCHEMA_VERSION } from './mdk-runtime-rpc';
import {
  isMdkRelayCatchUpProbeResponse,
  isMdkRelayProbeResponse,
  isMdkRelayStateProbeResponse,
  type MdkRelayCatchUpProbeInfo,
  type MdkRelayCatchUpProbeRequest,
  type MdkRelayProbeInfo,
  type MdkRelayProbeRequest,
  type MdkRelayStateProbeInfo,
  type MdkRelayStateProbeRequest,
} from './mdk-relay-rpc';

const RELAY_PROBE_TIMEOUT_MS = 15_000;

export function probeMdkRelayPublish(
  endpoints: readonly string[],
  requiredAcks: number,
): Promise<MdkRelayProbeInfo> {
  const worker = new Worker(new URL('./mdk-worker.ts', import.meta.url), {
    name: 'marmot-mdk-relay-probe',
    type: 'module',
  });
  const request: MdkRelayProbeRequest = {
    endpoints: [...endpoints],
    id: 2,
    method: 'relay_publish_probe',
    requiredAcks,
    schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
  };

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('The MDK relay probe did not finish in time.'));
    }, RELAY_PROBE_TIMEOUT_MS);
    worker.addEventListener(
      'message',
      (event: MessageEvent<unknown>) => {
        window.clearTimeout(timeout);
        worker.terminate();
        if (
          !isMdkRelayProbeResponse(event.data) ||
          event.data.id !== request.id
        ) {
          reject(
            new Error('The MDK relay probe returned an invalid response.'),
          );
          return;
        }
        if (!event.data.ok) {
          reject(new Error(event.data.error.message));
          return;
        }
        resolve(event.data.result);
      },
      { once: true },
    );
    worker.addEventListener(
      'error',
      () => {
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error('The MDK relay probe Worker failed.'));
      },
      { once: true },
    );
    worker.postMessage(request);
  });
}

export function probeMdkRelayCatchUp(
  endpoints: readonly string[],
): Promise<MdkRelayCatchUpProbeInfo> {
  const worker = new Worker(new URL('./mdk-worker.ts', import.meta.url), {
    name: 'marmot-mdk-relay-catch-up-probe',
    type: 'module',
  });
  const request: MdkRelayCatchUpProbeRequest = {
    endpoints: [...endpoints],
    id: 3,
    method: 'relay_catch_up_probe',
    schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
  };

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('The MDK relay catch-up probe did not finish in time.'));
    }, RELAY_PROBE_TIMEOUT_MS);
    worker.addEventListener(
      'message',
      (event: MessageEvent<unknown>) => {
        window.clearTimeout(timeout);
        worker.terminate();
        if (
          !isMdkRelayCatchUpProbeResponse(event.data) ||
          event.data.id !== request.id
        ) {
          reject(
            new Error(
              'The MDK relay catch-up probe returned an invalid response.',
            ),
          );
          return;
        }
        if (!event.data.ok) {
          reject(new Error(event.data.error.message));
          return;
        }
        resolve(event.data.result);
      },
      { once: true },
    );
    worker.addEventListener(
      'error',
      () => {
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error('The MDK relay catch-up probe Worker failed.'));
      },
      { once: true },
    );
    worker.postMessage(request);
  });
}

export function probeMdkRelayState(
  acceptedEndpoint: string,
  rejectedEndpoint: string,
  suppliedStorageKey: Uint8Array,
): Promise<MdkRelayStateProbeInfo> {
  if (suppliedStorageKey.length !== 32) {
    return Promise.reject(
      new Error('The MDK relay state probe requires a 32-byte storage key.'),
    );
  }
  const worker = new Worker(new URL('./mdk-worker.ts', import.meta.url), {
    name: 'marmot-mdk-relay-state-probe',
    type: 'module',
  });
  const storageKey = suppliedStorageKey.slice();
  const request: MdkRelayStateProbeRequest = {
    acceptedEndpoint,
    id: 4,
    method: 'relay_state_probe',
    rejectedEndpoint,
    schemaVersion: MDK_RUNTIME_RPC_SCHEMA_VERSION,
    storageKey,
  };

  return new Promise((resolve, reject) => {
    const finish = (): void => {
      worker.terminate();
      storageKey.fill(0);
    };
    const timeout = window.setTimeout(() => {
      finish();
      reject(new Error('The MDK relay state probe did not finish in time.'));
    }, 30_000);
    worker.addEventListener(
      'message',
      (event: MessageEvent<unknown>) => {
        window.clearTimeout(timeout);
        finish();
        if (
          !isMdkRelayStateProbeResponse(event.data) ||
          event.data.id !== request.id
        ) {
          reject(
            new Error(
              'The MDK relay state probe returned an invalid response.',
            ),
          );
          return;
        }
        if (!event.data.ok) {
          reject(new Error(event.data.error.message));
          return;
        }
        resolve(event.data.result);
      },
      { once: true },
    );
    worker.addEventListener(
      'error',
      () => {
        window.clearTimeout(timeout);
        finish();
        reject(new Error('The MDK relay state probe Worker failed.'));
      },
      { once: true },
    );
    worker.postMessage(request);
  });
}
