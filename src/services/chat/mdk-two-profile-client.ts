import type {
  MdkTwoProfileCommand,
  MdkTwoProfileResult,
  MdkTwoProfileWorkerRequest,
  MdkTwoProfileWorkerResponse,
} from './mdk-two-profile-rpc';

const COMMAND_TIMEOUT_MS = 30_000;
let worker: Worker | undefined;
let nextId = 1;

export function runMdkTwoProfileCommand(
  command: MdkTwoProfileCommand,
): Promise<MdkTwoProfileResult> {
  worker ??= new Worker(
    new URL('./mdk-two-profile-worker.ts', import.meta.url),
    {
      name: 'marmot-mdk-two-profile',
      type: 'module',
    },
  );
  const id = nextId++;
  let workerCommand: MdkTwoProfileWorkerRequest['command'];
  if (command.method === 'open') {
    if (!/^[0-9a-f]{64}$/iu.test(command.storageKeyHex)) {
      return Promise.reject(new Error('The profile storage key is invalid.'));
    }
    workerCommand = {
      method: 'open',
      relayEndpoint: command.relayEndpoint,
      role: command.role,
      storageKey: Uint8Array.from(
        command.storageKeyHex.match(/.{2}/gu) ?? [],
        (byte) => Number.parseInt(byte, 16),
      ),
    };
  } else {
    workerCommand = command;
  }
  const request: MdkTwoProfileWorkerRequest = { command: workerCommand, id };

  return new Promise((resolve, reject) => {
    const activeWorker = worker!;
    const finish = (): void => {
      window.clearTimeout(timeout);
      activeWorker.removeEventListener('message', onMessage);
      activeWorker.removeEventListener('error', onError);
      if ('storageKey' in workerCommand) workerCommand.storageKey.fill(0);
      if (command.method === 'close') {
        activeWorker.terminate();
        if (worker === activeWorker) worker = undefined;
      }
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      const response = event.data as Partial<MdkTwoProfileWorkerResponse>;
      if (response.id !== id || typeof response.ok !== 'boolean') return;
      finish();
      if (!response.ok) {
        const message =
          'error' in response ? response.error?.message : undefined;
        reject(new Error(message ?? 'The profile Worker failed.'));
        return;
      }
      resolve(response.result as MdkTwoProfileResult);
    };
    const onError = (): void => {
      finish();
      reject(new Error('The two-profile MDK Worker failed.'));
    };
    const timeout = window.setTimeout(() => {
      finish();
      reject(new Error('The two-profile MDK command timed out.'));
    }, COMMAND_TIMEOUT_MS);
    activeWorker.addEventListener('message', onMessage);
    activeWorker.addEventListener('error', onError);
    activeWorker.postMessage(request);
  });
}
