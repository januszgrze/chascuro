import { ChatError, type ChatErrorCode } from '../../domain';
import type {
  MdkProductCommand,
  MdkProductGroupStatus,
  MdkProductInvite,
  MdkProductReceivedMessage,
  MdkProductResult,
  MdkProductWorkerRequest,
} from './mdk-product-rpc';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_EVENT_BYTES = 1_048_576;
const HEX_16 = /^[0-9a-f]{32}$/u;
const HEX_32 = /^[0-9a-f]{64}$/u;
const ERROR_CODES: ReadonlySet<ChatErrorCode> = new Set([
  'internal',
  'invalid_input',
  'invite_invalid',
  'locked',
  'relay_unavailable',
  'storage_unavailable',
]);

export interface MdkProductWorker {
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

export type MdkProductWorkerFactory = () => MdkProductWorker;

export class MdkProductRpcClient {
  private worker: MdkProductWorker | undefined;
  private nextId = 1;
  private quiesced = true;
  private disposed = false;

  constructor(
    private readonly workerFactory: MdkProductWorkerFactory = () =>
      new Worker(new URL('./mdk-product-worker.ts', import.meta.url), {
        name: 'marmot-mdk-product',
        type: 'module',
      }),
  ) {}

  async open(
    input: {
      readonly relayEndpoints: readonly string[];
      readonly storageKey: Uint8Array;
      readonly identitySecret: Uint8Array;
    },
    signal: AbortSignal,
  ): Promise<MdkProductResult> {
    if (input.storageKey.length !== 32 || input.identitySecret.length !== 32) {
      throw new ChatError('storage_corrupt');
    }
    if (this.disposed) throw new ChatError('locked');
    this.quiesced = false;
    try {
      return await this.execute(
        {
          method: 'open',
          relayEndpoints: [...input.relayEndpoints],
          storageKey: input.storageKey.slice(),
          identitySecret: input.identitySecret.slice(),
        },
        signal,
      );
    } catch (error) {
      this.quiesced = true;
      this.terminate();
      throw error;
    }
  }

  execute(
    command: MdkProductCommand,
    signal: AbortSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<MdkProductResult> {
    if (this.disposed || this.quiesced) {
      return Promise.reject(new ChatError('locked'));
    }
    signal.throwIfAborted();
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new TypeError('The MDK command timeout is invalid.');
    }
    const id = this.nextId++;
    const worker = (this.worker ??= this.workerFactory());
    const request: MdkProductWorkerRequest = { id, command };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (command.method === 'open') {
          command.storageKey.fill(0);
          command.identitySecret.fill(0);
        }
      };
      const failAndTerminate = (error: unknown): void => {
        finish();
        this.quiesced = true;
        this.terminate();
        reject(error);
      };
      const onAbort = (): void => failAndTerminate(signal.reason);
      const onError = (): void =>
        failAndTerminate(new ChatError('internal', { retryable: true }));
      const onMessage = (event: MessageEvent<unknown>): void => {
        const response = parseResponse(event.data, id);
        if (response === undefined) return;
        finish();
        if (!response.ok) {
          reject(workerError(response.code));
          return;
        }
        try {
          resolve(parseMdkProductResult(response.result));
        } catch {
          this.quiesced = true;
          this.terminate();
          reject(new ChatError('internal'));
        }
      };
      const timeout = setTimeout(
        () => failAndTerminate(new ChatError('internal', { retryable: true })),
        timeoutMs,
      );
      signal.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(request);
    });
  }

  quiesce(): void {
    this.quiesced = true;
  }

  async stop(): Promise<void> {
    if (this.worker === undefined) return;
    this.quiesced = false;
    try {
      await this.execute(
        { method: 'close' },
        new AbortController().signal,
        5_000,
      );
    } catch {
      // Fail-closed termination below is mandatory.
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

type ParsedResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string };

function parseResponse(value: unknown, id: number): ParsedResponse | undefined {
  if (!isRecord(value) || value.id !== id) return undefined;
  if (value.ok === true && 'result' in value)
    return { ok: true, result: value.result };
  if (
    value.ok === false &&
    isRecord(value.error) &&
    typeof value.error.code === 'string'
  ) {
    return { ok: false, code: value.error.code };
  }
  throw new TypeError('Invalid MDK product Worker response.');
}

export function parseMdkProductResult(value: unknown): MdkProductResult {
  if (!isRecord(value)) throw new TypeError('Invalid MDK product result.');
  const eventId = value.eventId === undefined ? undefined : hex(value.eventId);
  const result: MdkProductResult = {
    epoch: integer(value.epoch, 0, Number.MAX_SAFE_INTEGER),
    groupCount: integer(value.groupCount, 0, 256),
    groupId: nullableGroupHex(value.groupId),
    memberCount: integer(value.memberCount, 0, 256),
    nostrPubkey: hex(value.nostrPubkey),
    pendingPublishRecovered: boolean(value.pendingPublishRecovered),
    routingGroupId: nullableHex(value.routingGroupId),
    groups: parseGroups(value.groups),
    storageGeneration: integer(
      value.storageGeneration,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    eventId,
    eventJson:
      value.eventJson === undefined
        ? undefined
        : relayEventJson(value.eventJson, eventId),
    published:
      value.published === undefined ? undefined : boolean(value.published),
    invites:
      value.invites === undefined ? undefined : parseInvites(value.invites),
    received:
      value.received === undefined ? undefined : parseReceived(value.received),
  };
  return Object.freeze(result);
}

function parseGroups(value: unknown): readonly MdkProductGroupStatus[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError('Invalid groups.');
  }
  const groups = value.map((group) => {
    if (!isRecord(group)) throw new TypeError('Invalid group.');
    return Object.freeze({
      epoch: integer(group.epoch, 0, Number.MAX_SAFE_INTEGER),
      groupId: groupHex(group.groupId),
      memberCount: integer(group.memberCount, 1, 256),
      routingGroupId: hex(group.routingGroupId),
    });
  });
  if (new Set(groups.map(({ groupId }) => groupId)).size !== groups.length) {
    throw new TypeError('Invalid groups.');
  }
  return Object.freeze(groups);
}

function relayEventJson(value: unknown, eventId: string | undefined): string {
  if (
    typeof value !== 'string' ||
    eventId === undefined ||
    new TextEncoder().encode(value).length > MAX_EVENT_BYTES
  ) {
    throw new TypeError('Invalid retry event.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('Invalid retry event.');
  }
  if (!isRecord(parsed) || parsed.id !== eventId) {
    throw new TypeError('Invalid retry event.');
  }
  return value;
}

function parseInvites(value: unknown): readonly MdkProductInvite[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new TypeError('Invalid invites.');
  return Object.freeze(
    value.map((invite) => {
      if (!isRecord(invite)) throw new TypeError('Invalid invite.');
      return Object.freeze({
        id: hex(invite.id),
        receivedAt: integer(invite.receivedAt, 0, Number.MAX_SAFE_INTEGER),
      });
    }),
  );
}

function parseReceived(value: unknown): readonly MdkProductReceivedMessage[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new TypeError('Invalid messages.');
  return Object.freeze(
    value.map((message) => {
      if (!isRecord(message) || typeof message.content !== 'string') {
        throw new TypeError('Invalid message.');
      }
      const contentBytes = new TextEncoder().encode(message.content).length;
      if (contentBytes < 1 || contentBytes > 16_384) {
        throw new TypeError('Invalid message content.');
      }
      return Object.freeze({
        groupId: groupHex(message.groupId),
        id: hex(message.id),
        sender: hex(message.sender),
        createdAt: integer(message.createdAt, 0, Number.MAX_SAFE_INTEGER),
        content: message.content,
      });
    }),
  );
}

function workerError(code: string): ChatError {
  return ERROR_CODES.has(code as ChatErrorCode)
    ? new ChatError(code as ChatErrorCode)
    : new ChatError('internal');
}

function hex(value: unknown): string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new TypeError('Invalid 32-byte hex value.');
  }
  return value;
}

function nullableHex(value: unknown): string | null {
  return value === null ? null : hex(value);
}

function groupHex(value: unknown): string {
  if (typeof value !== 'string' || !HEX_16.test(value)) {
    throw new TypeError('Invalid 16-byte group identifier.');
  }
  return value;
}

function nullableGroupHex(value: unknown): string | null {
  return value === null ? null : groupHex(value);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new TypeError('Invalid integer.');
  }
  return Number(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Invalid boolean.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
