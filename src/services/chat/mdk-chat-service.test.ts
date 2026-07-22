import { bech32 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';

import {
  chatMessageId,
  clearableSecretText,
  conversationId,
  federationId,
  operationId,
  type ChatMessage,
} from '../../domain';
import { chatProductStateRecordSchema } from '../persistence/schemas/chat-product-state-record';
import type { ChatStateStore, DurableChatState } from './chat-service';
import { MdkChatService } from './mdk-chat-service';
import type {
  MdkProductCommand,
  MdkProductResult,
  MdkProductWorkerRequest,
} from './mdk-product-rpc';
import type { MdkProductWorker } from './mdk-product-rpc-client';
import { encodeChatPaymentEnvelope } from './chat-payment-envelope';

const SELF = '11'.repeat(32);
const PEER = '22'.repeat(32);
const GROUP = '33'.repeat(16);
const GROUP_TWO = '34'.repeat(16);
const ROUTE = '44'.repeat(32);
const ROUTE_TWO = '45'.repeat(32);
const EVENT = '55'.repeat(32);
const EVENT_JSON = JSON.stringify({ id: EVENT });

class MemoryChatStateStore implements ChatStateStore {
  state: DurableChatState | undefined;
  readonly saved: DurableChatState[] = [];
  failNextSave = false;

  async load(): Promise<DurableChatState | undefined> {
    return this.state;
  }

  async save(state: DurableChatState): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('opaque storage failure');
    }
    this.state = structuredClone(state);
    this.saved.push(this.state);
  }
}

class ProductWorkerFixture implements MdkProductWorker {
  private readonly messageListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();
  readonly commands: MdkProductCommand[] = [];
  private readonly groupIds: string[] = [];
  failNextSend = false;
  crashNextMethod: MdkProductCommand['method'] | undefined;
  hangNextMethod: MdkProductCommand['method'] | undefined;
  failNextSyncGroup: string | undefined;
  incoming = false;
  incomingContent: string | undefined;
  terminated = false;

  get groupOpen(): boolean {
    return this.groupIds.length > 0;
  }

  set groupOpen(value: boolean) {
    if (value && this.groupIds.length === 0) this.groupIds.push(GROUP);
    if (!value) this.groupIds.splice(0);
  }

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
    const request = message as MdkProductWorkerRequest;
    this.commands.push(request.command);
    if (this.hangNextMethod === request.command.method) {
      this.hangNextMethod = undefined;
      return;
    }
    queueMicrotask(() => {
      if (this.crashNextMethod === request.command.method) {
        this.crashNextMethod = undefined;
        for (const listener of this.errorListeners) {
          listener(new ErrorEvent('error'));
        }
        return;
      }
      if (
        request.command.method === 'sync' &&
        this.failNextSyncGroup === request.command.groupId
      ) {
        this.failNextSyncGroup = undefined;
        for (const listener of this.messageListeners) {
          listener(
            new MessageEvent('message', {
              data: {
                id: request.id,
                ok: false,
                error: { code: 'relay_unavailable' },
              },
            }),
          );
        }
        return;
      }
      const result = this.result(request.command);
      for (const listener of this.messageListeners) {
        listener(
          new MessageEvent('message', {
            data: { id: request.id, ok: true, result },
          }),
        );
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private result(command: MdkProductCommand): MdkProductResult {
    if (
      command.method === 'create_conversation' ||
      command.method === 'accept_invite'
    ) {
      this.groupIds.push(this.groupIds.length === 0 ? GROUP : GROUP_TWO);
    }
    const groups = this.groupIds.map((groupId, index) => ({
      epoch: 1,
      groupId,
      memberCount: 2,
      routingGroupId: index === 0 ? ROUTE : ROUTE_TWO,
    }));
    const first = groups[0];
    const base: MdkProductResult = {
      epoch: first?.epoch ?? 0,
      groupCount: groups.length,
      groupId: first?.groupId ?? null,
      memberCount: first?.memberCount ?? 0,
      nostrPubkey: SELF,
      pendingPublishRecovered: false,
      routingGroupId: first?.routingGroupId ?? null,
      groups,
      storageGeneration: this.commands.length,
    };
    if (command.method === 'send') {
      const published = !this.failNextSend;
      this.failNextSend = false;
      return { ...base, eventId: EVENT, eventJson: EVENT_JSON, published };
    }
    if (command.method === 'retry')
      return { ...base, eventId: EVENT, published: true };
    if (command.method === 'list_invites') return { ...base, invites: [] };
    if (command.method === 'sync') {
      return {
        ...base,
        received:
          this.incoming || this.incomingContent !== undefined
            ? [
                {
                  groupId: command.groupId,
                  id: (command.groupId === GROUP ? '66' : '67').repeat(32),
                  sender: PEER,
                  createdAt: 1_700_000_010,
                  content: this.incomingContent ?? 'hello from peer',
                },
              ]
            : [],
      };
    }
    return base;
  }
}

function input(store: ChatStateStore) {
  return {
    storageKey: new Uint8Array(32).fill(7),
    identitySecret: new Uint8Array(32).fill(8),
    stateStore: store,
    signal: new AbortController().signal,
  };
}

function npub(hex: string): string {
  const bytes = Uint8Array.from(hex.match(/.{2}/gu)!, (value) =>
    Number.parseInt(value, 16),
  );
  return bech32.encode('npub', bech32.toWords(bytes), false);
}

describe('MdkChatService', () => {
  it('creates a random-secret-backed identity and persists only sanitized state', async () => {
    const worker = new ProductWorkerFixture();
    const store = new MemoryChatStateStore();
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => worker,
      idFactory: () => 'fixture',
    });

    await expect(service.open(input(store))).resolves.toEqual({
      status: 'setup_required',
    });
    const identity = await service.initializeIdentity(
      new AbortController().signal,
    );

    expect(identity.address).toBe(npub(SELF));
    expect(store.state).toMatchObject({
      identityInitialized: true,
      identity,
      conversations: [],
      messages: [],
    });
    expect(JSON.stringify(store.state)).not.toContain('storageKey');
    expect(JSON.stringify(store.state)).not.toContain('identitySecret');
  });

  it('creates, sends, retries, synchronizes, paginates, and locks one real group binding', async () => {
    const worker = new ProductWorkerFixture();
    const store = new MemoryChatStateStore();
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => worker,
      now: () => 1_700_000_000_000,
      idFactory: () => 'fixture',
    });
    await service.open(input(store));
    await service.initializeIdentity(new AbortController().signal);
    const id = await service.createConversation({
      title: 'Peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });
    expect(id).toBe(conversationId('conversation:fixture'));

    worker.failNextSend = true;
    const failed = await service.sendMessage({
      conversationId: id,
      text: 'retry this',
      signal: new AbortController().signal,
    });
    expect(failed.delivery).toBe('failed');
    await expect(
      service.retryMessage(failed.id, new AbortController().signal),
    ).resolves.toMatchObject({ delivery: 'published' });

    worker.incoming = true;
    await service.synchronize(new AbortController().signal);
    const page = await service.listMessages({
      conversationId: id,
      limit: 20,
      signal: new AbortController().signal,
    });
    expect(page.messages.map((message: ChatMessage) => message.text)).toEqual([
      'retry this',
      'hello from peer',
    ]);

    await service.leaveConversation(id, new AbortController().signal);
    expect(service.getSnapshot().conversations[0]?.removed).toBe(true);
    expect(worker.commands.at(-1)).toEqual({ method: 'leave', groupId: GROUP });

    service.quiesce();
    await service.stop();
    service.lock();
    expect(service.getSnapshot().availability).toEqual({ status: 'disabled' });
    expect(worker.terminated).toBe(true);
  });

  it('projects ecash cards without exposing incoming bearer notes', async () => {
    const worker = new ProductWorkerFixture();
    const store = new MemoryChatStateStore();
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => worker,
      now: () => 1_700_000_000_000,
      idFactory: () => 'fixture',
    });
    await service.open(input(store));
    await service.initializeIdentity(new AbortController().signal);
    const conversation = await service.createConversation({
      title: 'Peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });
    const outgoingSecret =
      'fedimint-ecash:21000:federation-fixture:outgoing-secret';
    const outgoingNotes = clearableSecretText(outgoingSecret);
    const outgoing = await service.sendPayment({
      conversationId: conversation,
      amountSats: 21,
      notes: outgoingNotes,
      operationKey: {
        federationId: federationId('federation-fixture'),
        operationId: operationId('operation-fixture'),
      },
      signal: new AbortController().signal,
    });
    expect(outgoing).toMatchObject({
      direction: 'outgoing',
      amountSats: 21,
      status: 'pending',
    });
    expect(outgoingNotes.length).toBe(0);
    expect(JSON.stringify(store.state)).not.toContain(outgoingSecret);

    const incomingId = chatMessageId('payment:incoming');
    const incomingNotes =
      'fedimint-ecash:34000:federation-fixture:incoming-secret';
    worker.incomingContent = encodeChatPaymentEnvelope(
      incomingId,
      34,
      incomingNotes,
    );
    await service.synchronize(new AbortController().signal);

    const payments = await service.listPayments(
      conversation,
      new AbortController().signal,
    );
    expect(payments).toContainEqual({
      id: incomingId,
      conversationId: conversation,
      direction: 'incoming',
      amountSats: 34,
      sentAtMs: 1_700_000_010_000,
      status: 'claimable',
    });
    expect(JSON.stringify(payments)).not.toContain(incomingNotes);

    const prepared = await service.preparePaymentClaim(
      incomingId,
      new AbortController().signal,
    );
    expect(prepared.notes.reveal()).toBe(incomingNotes);
    prepared.notes.clear();
    await service.markPaymentClaimed(incomingId, new AbortController().signal);
    expect(JSON.stringify(store.state)).not.toContain(incomingNotes);
  });

  it('retries the exact encrypted outbox event after a service reload', async () => {
    const store = new MemoryChatStateStore();
    const firstWorker = new ProductWorkerFixture();
    const first = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => firstWorker,
      now: () => 1_700_000_000_000,
      idFactory: () => 'durable',
    });
    await first.open(input(store));
    await first.initializeIdentity(new AbortController().signal);
    const conversation = await first.createConversation({
      title: 'Peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });
    firstWorker.failNextSend = true;
    const failed = await first.sendMessage({
      conversationId: conversation,
      text: 'survive reload',
      signal: new AbortController().signal,
    });
    expect(store.state?.outbox).toEqual([
      { messageId: failed.id, eventId: EVENT, eventJson: EVENT_JSON },
    ]);
    first.quiesce();
    await first.stop();
    first.lock();

    const reopenedWorker = new ProductWorkerFixture();
    reopenedWorker.groupOpen = true;
    const reopened = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => reopenedWorker,
    });
    await reopened.open(input(store));
    await expect(
      reopened.retryMessage(failed.id, new AbortController().signal),
    ).resolves.toMatchObject({ delivery: 'published' });
    expect(reopenedWorker.commands.at(-1)).toEqual({
      method: 'retry',
      eventId: EVENT,
      eventJson: EVENT_JSON,
    });
    expect(store.state?.outbox).toEqual([]);
  });

  it('addresses and synchronizes two durable groups independently', async () => {
    const worker = new ProductWorkerFixture();
    const store = new MemoryChatStateStore();
    const ids = ['first', 'second'];
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => worker,
      idFactory: () => ids.shift()!,
      now: () => 1_700_000_000_000,
    });
    await service.open(input(store));
    await service.initializeIdentity(new AbortController().signal);
    const first = await service.createConversation({
      title: 'First peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });
    const second = await service.createConversation({
      title: 'Second peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });

    expect(store.state?.groupBindings).toEqual([
      { conversationId: first, groupId: GROUP },
      { conversationId: second, groupId: GROUP_TWO },
    ]);
    await service.sendMessage({
      conversationId: second,
      text: 'second group only',
      signal: new AbortController().signal,
    });
    expect(worker.commands.at(-1)).toMatchObject({
      method: 'send',
      groupId: GROUP_TWO,
    });

    worker.incoming = true;
    await service.synchronize(new AbortController().signal);
    await service.synchronize(new AbortController().signal);
    expect(worker.commands.filter(({ method }) => method === 'sync')).toEqual([
      { method: 'sync', groupId: GROUP },
      { method: 'sync', groupId: GROUP_TWO },
      { method: 'sync', groupId: GROUP },
      { method: 'sync', groupId: GROUP_TWO },
    ]);
    await expect(
      service.listMessages({
        conversationId: first,
        limit: 20,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      messages: [{ conversationId: first, text: 'hello from peer' }],
    });
    await expect(
      service.listMessages({
        conversationId: second,
        limit: 20,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      messages: [
        { conversationId: second, text: 'second group only' },
        { conversationId: second, text: 'hello from peer' },
      ],
    });
  });

  it('fails closed on a Worker crash and reopens with durable state intact', async () => {
    const store = new MemoryChatStateStore();
    const crashedWorker = new ProductWorkerFixture();
    const reopenedWorker = new ProductWorkerFixture();
    reopenedWorker.groupOpen = true;
    const workers = [crashedWorker, reopenedWorker];
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => workers.shift()!,
      idFactory: () => 'crash-recovery',
    });
    await service.open(input(store));
    await service.initializeIdentity(new AbortController().signal);
    const conversation = await service.createConversation({
      title: 'Peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });

    crashedWorker.crashNextMethod = 'send';
    await expect(
      service.sendMessage({
        conversationId: conversation,
        text: 'interrupted',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(crashedWorker.terminated).toBe(true);
    await expect(
      service.sendMessage({
        conversationId: conversation,
        text: 'must reopen first',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'locked' });

    service.quiesce();
    await service.stop();
    service.lock();
    await expect(service.open(input(store))).resolves.toMatchObject({
      status: 'available',
    });
    await expect(
      service.sendMessage({
        conversationId: conversation,
        text: 'after recovery',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ delivery: 'published' });
  });

  it('continues syncing independent groups after one group fails', async () => {
    const worker = new ProductWorkerFixture();
    const store = new MemoryChatStateStore();
    const ids = ['first', 'second'];
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => worker,
      idFactory: () => ids.shift()!,
    });
    await service.open(input(store));
    await service.initializeIdentity(new AbortController().signal);
    const first = await service.createConversation({
      title: 'First peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });
    const second = await service.createConversation({
      title: 'Second peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });
    worker.incoming = true;
    worker.failNextSyncGroup = GROUP;

    await expect(
      service.synchronize(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'relay_unavailable' });
    expect(service.getSnapshot().syncState).toBe('offline');
    expect(worker.commands.filter(({ method }) => method === 'sync')).toEqual([
      { method: 'sync', groupId: GROUP },
      { method: 'sync', groupId: GROUP_TWO },
    ]);
    await expect(
      service.listMessages({
        conversationId: first,
        limit: 20,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ messages: [] });
    await expect(
      service.listMessages({
        conversationId: second,
        limit: 20,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      messages: [{ conversationId: second, text: 'hello from peer' }],
    });
  });

  it('terminates an aborted Worker command and requires an explicit reopen', async () => {
    const store = new MemoryChatStateStore();
    const worker = new ProductWorkerFixture();
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => worker,
      idFactory: () => 'aborted-command',
    });
    await service.open(input(store));
    await service.initializeIdentity(new AbortController().signal);
    const conversation = await service.createConversation({
      title: 'Peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });
    const abort = new AbortController();
    worker.hangNextMethod = 'send';
    const sending = service.sendMessage({
      conversationId: conversation,
      text: 'cancel safely',
      signal: abort.signal,
    });

    await vi.waitFor(() => expect(worker.commands.at(-1)?.method).toBe('send'));
    abort.abort();

    await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    await expect(
      service.synchronize(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'locked' });
  });

  it('does not advance MDK after a durable product-state write failure', async () => {
    const store = new MemoryChatStateStore();
    const worker = new ProductWorkerFixture();
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => worker,
      idFactory: () => 'write-failure',
    });
    await service.open(input(store));
    await service.initializeIdentity(new AbortController().signal);
    const conversation = await service.createConversation({
      title: 'Peer',
      inviteAddress: npub(PEER),
      signal: new AbortController().signal,
    });
    const sendsBefore = worker.commands.filter(
      ({ method }) => method === 'send',
    ).length;
    store.failNextSave = true;

    await expect(
      service.sendMessage({
        conversationId: conversation,
        text: 'must not reach MDK',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(
      worker.commands.filter(({ method }) => method === 'send'),
    ).toHaveLength(sendsBefore);
    await expect(
      service.synchronize(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'locked' });
  });

  it('binds an unambiguous legacy product record to its restored MDK group', async () => {
    const worker = new ProductWorkerFixture();
    worker.groupOpen = true;
    const store = new MemoryChatStateStore();
    store.state = chatProductStateRecordSchema.parse({
      formatVersion: 1,
      identityInitialized: true,
      identity: {
        address: npub(SELF),
        fingerprint: '1111 1111 1111 1111',
      },
      conversations: [
        {
          id: 'conversation:legacy',
          title: 'Legacy peer',
          memberCount: 2,
          unreadCount: 0,
          removed: false,
        },
      ],
      pendingInvites: [],
      handledInviteIds: [],
      messages: [],
      outbox: [],
    });
    const service = new MdkChatService({
      relayEndpoints: ['wss://relay.example'],
      workerFactory: () => worker,
    });

    await expect(service.open(input(store))).resolves.toMatchObject({
      status: 'available',
    });
    expect(store.state?.groupBindings).toEqual([
      { conversationId: 'conversation:legacy', groupId: GROUP },
    ]);
  });
});
