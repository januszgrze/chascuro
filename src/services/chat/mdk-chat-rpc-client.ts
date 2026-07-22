import { ChatError } from '../../domain';
import type {
  MdkTwoProfileCommand,
  MdkTwoProfileResult,
  MdkTwoProfileWorkerRequest,
} from './mdk-two-profile-rpc';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 60_000;
const MAX_RECEIVED_MESSAGES = 256;
const MAX_RECEIVED_MESSAGE_BYTES = 16_384;

export interface MdkChatWorker {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: 'error',
    listener: (event: ErrorEvent) => void,
  ): void;
  postMessage(message: unknown): void;
  terminate(): void;
}

export type MdkChatWorkerFactory = () => MdkChatWorker;

export interface MdkChatRpcCommandOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

export class MdkChatRpcClient {
  private worker: MdkChatWorker | undefined;
  private nextId = 1;
  private quiesced = true;
  private disposed = false;

  constructor(
    private readonly workerFactory: MdkChatWorkerFactory = () =>
      new Worker(new URL('./mdk-two-profile-worker.ts', import.meta.url), {
        name: 'marmot-mdk-application',
        type: 'module',
      }),
  ) {}

  async open(
    input: {
      readonly relayEndpoint: string;
      readonly role: 'alice' | 'bob';
      readonly storageKey: Uint8Array;
    },
    options: MdkChatRpcCommandOptions,
  ): Promise<MdkTwoProfileResult> {
    if (input.storageKey.length !== 32) throw new ChatError('storage_corrupt');
    if (this.disposed) throw new ChatError('locked');
    this.quiesced = false;
    try {
      return await this.execute(
        {
          method: 'open',
          relayEndpoint: input.relayEndpoint,
          role: input.role,
          storageKeyHex: bytesToHex(input.storageKey),
        },
        options,
      );
    } catch (error) {
      this.quiesced = true;
      this.terminate();
      throw error;
    }
  }

  execute(
    command: Exclude<MdkTwoProfileCommand, { method: 'open' }>,
    options: MdkChatRpcCommandOptions,
  ): Promise<MdkTwoProfileResult>;
  execute(
    command: MdkTwoProfileCommand,
    options: MdkChatRpcCommandOptions,
  ): Promise<MdkTwoProfileResult>;
  execute(
    command: MdkTwoProfileCommand,
    options: MdkChatRpcCommandOptions,
  ): Promise<MdkTwoProfileResult> {
    if (this.disposed || (this.quiesced && command.method !== 'close')) {
      return Promise.reject(new ChatError('locked'));
    }
    options.signal.throwIfAborted();
    const timeoutMs = parseTimeout(options.timeoutMs);
    const id = this.nextId++;
    const worker = (this.worker ??= this.workerFactory());
    const workerCommand = toWorkerCommand(command);
    const request: MdkTwoProfileWorkerRequest = { id, command: workerCommand };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if ('storageKey' in workerCommand) workerCommand.storageKey.fill(0);
      };
      const failAndTerminate = (error: unknown): void => {
        finish();
        this.quiesced = true;
        this.terminate();
        reject(error);
      };
      const onAbort = (): void => {
        failAndTerminate(options.signal.reason);
      };
      const onError = (): void => {
        failAndTerminate(new ChatError('internal', { retryable: true }));
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        let response;
        try {
          response = parseWorkerResponse(event.data, id);
        } catch {
          failAndTerminate(new ChatError('internal'));
          return;
        }
        if (response === undefined) return;
        finish();
        if (!response.ok) {
          reject(normalizeWorkerError(response.error));
          return;
        }
        try {
          resolve(parseMdkChatResult(response.result));
        } catch {
          this.quiesced = true;
          this.terminate();
          reject(new ChatError('internal'));
        }
      };
      const timeout = setTimeout(() => {
        failAndTerminate(new ChatError('internal', { retryable: true }));
      }, timeoutMs);
      options.signal.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(request);
    });
  }

  quiesce(): void {
    this.quiesced = true;
  }

  async stop(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    if (this.worker === undefined) return;
    try {
      await this.execute({ method: 'close' }, { signal, timeoutMs: 5_000 });
    } catch {
      // Termination below is the mandatory fail-closed stop boundary.
    } finally {
      this.quiesced = true;
      this.terminate();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.quiesced = true;
    this.terminate();
  }

  private terminate(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }
}

export function parseMdkChatResult(value: unknown): MdkTwoProfileResult {
  if (!isRecord(value)) throw new TypeError('Invalid MDK result.');
  const epoch = boundedInteger(value.epoch, 0, Number.MAX_SAFE_INTEGER);
  const groupCount = boundedInteger(value.groupCount, 0, 1_024);
  const memberCount = boundedInteger(value.memberCount, 0, 4_096);
  const storageGeneration = boundedInteger(
    value.storageGeneration,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const role = value.role;
  if (role !== 'alice' && role !== 'bob') throw new TypeError('Invalid role.');
  const nostrPubkey = hexOrThrow(value.nostrPubkey, 32);
  const groupId = nullableHex(value.groupId, 1, 255);
  const routingGroupId = nullableHex(value.routingGroupId, 32, 32);
  if (typeof value.pendingPublishRecovered !== 'boolean') {
    throw new TypeError('Invalid recovery state.');
  }
  const eventId =
    value.eventId === undefined ? undefined : hexOrThrow(value.eventId, 32);
  let received: readonly string[] | undefined;
  if (value.received !== undefined) {
    if (
      !Array.isArray(value.received) ||
      value.received.length > MAX_RECEIVED_MESSAGES ||
      value.received.some(
        (message) =>
          typeof message !== 'string' ||
          new TextEncoder().encode(message).length > MAX_RECEIVED_MESSAGE_BYTES,
      )
    ) {
      throw new TypeError('Invalid received messages.');
    }
    received = Object.freeze([...value.received]);
  }
  return Object.freeze({
    epoch,
    groupCount,
    groupId,
    memberCount,
    nostrPubkey,
    pendingPublishRecovered: value.pendingPublishRecovered,
    role,
    routingGroupId,
    storageGeneration,
    eventId,
    received,
  });
}

function toWorkerCommand(
  command: MdkTwoProfileCommand,
): MdkTwoProfileWorkerRequest['command'] {
  if (command.method !== 'open') return command;
  const storageKey = hexToBytes(command.storageKeyHex);
  return {
    method: 'open',
    relayEndpoint: command.relayEndpoint,
    role: command.role,
    storageKey,
  };
}

function parseWorkerResponse(
  value: unknown,
  expectedId: number,
):
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string }
  | undefined {
  if (!isRecord(value) || value.id !== expectedId) return undefined;
  if (value.ok === true && 'result' in value) {
    return { ok: true, result: value.result };
  }
  if (
    value.ok === false &&
    isRecord(value.error) &&
    typeof value.error.message === 'string'
  ) {
    return { ok: false, error: value.error.message.slice(0, 512) };
  }
  throw new TypeError('Invalid MDK Worker response.');
}

function normalizeWorkerError(message: string): ChatError {
  const normalized = message.toLowerCase();
  if (normalized.includes('relay') || normalized.includes('timed out')) {
    return new ChatError('relay_unavailable');
  }
  if (normalized.includes('storage') || normalized.includes('opfs')) {
    return new ChatError('storage_unavailable');
  }
  if (normalized.includes('no marmot keypackage')) {
    return new ChatError('invite_invalid');
  }
  if (normalized.includes('not open') || normalized.includes('locked')) {
    return new ChatError('locked');
  }
  return new ChatError('internal');
}

function parseTimeout(value = DEFAULT_COMMAND_TIMEOUT_MS): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_COMMAND_TIMEOUT_MS) {
    throw new TypeError('The MDK command timeout is invalid.');
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError('Invalid bounded integer.');
  }
  return value;
}

function nullableHex(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length < minimumBytes * 2 ||
    value.length > maximumBytes * 2 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/iu.test(value)
  ) {
    throw new TypeError('Invalid nullable hex value.');
  }
  return value.toLowerCase();
}

function hexOrThrow(value: unknown, bytes: number): string {
  const parsed = nullableHex(value, bytes, bytes);
  if (parsed === null) throw new TypeError('Hex value is required.');
  return parsed;
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/iu.test(value)) throw new ChatError('storage_corrupt');
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
