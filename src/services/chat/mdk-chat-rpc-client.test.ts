import { describe, expect, it } from 'vitest';

import type { MdkTwoProfileWorkerRequest } from './mdk-two-profile-rpc';
import {
  MdkChatRpcClient,
  parseMdkChatResult,
  type MdkChatWorker,
} from './mdk-chat-rpc-client';

const VALID_RESULT = Object.freeze({
  epoch: 1,
  groupCount: 1,
  groupId: 'aa',
  memberCount: 2,
  nostrPubkey: '11'.repeat(32),
  pendingPublishRecovered: false,
  role: 'alice',
  routingGroupId: '22'.repeat(32),
  storageGeneration: 4,
  received: ['hello'],
});

class FakeWorker implements MdkChatWorker {
  readonly messages: unknown[] = [];
  terminated = false;
  onPost?: (message: unknown) => void;
  private readonly messageListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  addEventListener(
    type: 'message' | 'error',
    listener:
      ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.add(
        listener as (event: MessageEvent<unknown>) => void,
      );
    } else {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    }
  }

  removeEventListener(
    type: 'message' | 'error',
    listener:
      ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(
        listener as (event: MessageEvent<unknown>) => void,
      );
    } else {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void);
    }
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
    this.onPost?.(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(data: unknown): void {
    const event = new MessageEvent('message', { data });
    for (const listener of this.messageListeners) listener(event);
  }
}

function request(value: unknown): MdkTwoProfileWorkerRequest {
  return value as MdkTwoProfileWorkerRequest;
}

describe('MdkChatRpcClient', () => {
  it('validates a bounded Worker result before returning it', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      const current = request(message);
      queueMicrotask(() =>
        worker.respond({ id: current.id, ok: true, result: VALID_RESULT }),
      );
    };
    const client = new MdkChatRpcClient(() => worker);
    await expect(
      client.open(
        {
          relayEndpoint: 'wss://relay.example',
          role: 'alice',
          storageKey: new Uint8Array(32).fill(3),
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual(VALID_RESULT);
  });

  it('terminates on invalid responses instead of trusting structural casts', async () => {
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      const current = request(message);
      queueMicrotask(() =>
        worker.respond({
          id: current.id,
          ok: true,
          result: { ...VALID_RESULT, memberCount: -1 },
        }),
      );
    };
    const client = new MdkChatRpcClient(() => worker);
    await expect(
      client.open(
        {
          relayEndpoint: 'wss://relay.example',
          role: 'alice',
          storageKey: new Uint8Array(32),
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(worker.terminated).toBe(true);
  });

  it('cancels by terminating the Worker and wiping the posted key copy', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const client = new MdkChatRpcClient(() => worker);
    const opened = client.open(
      {
        relayEndpoint: 'wss://relay.example',
        role: 'alice',
        storageKey: new Uint8Array(32).fill(9),
      },
      { signal: controller.signal },
    );
    const posted = request(worker.messages[0]);
    expect('storageKey' in posted.command).toBe(true);
    controller.abort();
    await expect(opened).rejects.toHaveProperty('name', 'AbortError');
    expect(worker.terminated).toBe(true);
    if ('storageKey' in posted.command) {
      expect([...posted.command.storageKey]).toEqual(new Array(32).fill(0));
    }
  });

  it('rejects oversized or malformed projected fields', () => {
    expect(() =>
      parseMdkChatResult({
        ...VALID_RESULT,
        received: new Array(257).fill('message'),
      }),
    ).toThrow('Invalid received messages.');
    expect(() =>
      parseMdkChatResult({ ...VALID_RESULT, nostrPubkey: 'not-a-key' }),
    ).toThrow();
  });
});
