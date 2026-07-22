import {
  ChatError,
  chatAddressFromPublicKey,
  chatCursor,
  chatInviteId,
  chatMessageId,
  clearableSecretText,
  conversationId,
  parseChatAddress,
  sanitizeChatText,
  type ChatAvailability,
  type ChatIdentitySummary,
  type ChatMessage,
  type ChatMessageId,
  type ChatMessagePage,
  type ChatPayment,
  type ChatSnapshot,
  type ConversationId,
  type ConversationSummary,
} from '../../domain';
import type {
  ChatService,
  ChatServiceListener,
  ChatStateStore,
  CreateConversationInput,
  DurableChatState,
  ListChatMessagesInput,
  OpenChatInput,
  PreparedChatPaymentClaim,
  SendChatPaymentInput,
  SendChatMessageInput,
} from './chat-service';
import {
  encodeChatPaymentEnvelope,
  parseChatContent,
} from './chat-payment-envelope';
import type { MdkProductResult } from './mdk-product-rpc';
import {
  MdkProductRpcClient,
  type MdkProductWorkerFactory,
} from './mdk-product-rpc-client';

const CAPABILITIES = Object.freeze([
  'text',
  'invites',
  'offline-outbox',
  'ecash-payments',
] as const);
const EMPTY_AVAILABILITY: ChatAvailability = Object.freeze({
  status: 'setup_required',
});
const MAX_MESSAGES = 10_000;
const MAX_HANDLED_INVITES = 1_024;
const MAX_OUTBOX = 256;

export interface MdkChatServiceOptions {
  readonly relayEndpoints: readonly string[];
  readonly workerFactory?: MdkProductWorkerFactory;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export class MdkChatService implements ChatService {
  readonly kind = 'mdk' as const;
  private readonly listeners = new Set<ChatServiceListener>();
  private readonly rpc: MdkProductRpcClient;
  private readonly relayEndpoints: readonly string[];
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private stateStore: ChatStateStore | undefined;
  private durableState: DurableChatState = emptyState();
  private availability: ChatAvailability = EMPTY_AVAILABILITY;
  private syncState: ChatSnapshot['syncState'] = 'idle';
  private storageKey: Uint8Array | undefined;
  private identitySecret: Uint8Array | undefined;
  private operationTail: Promise<unknown> = Promise.resolve();
  private opened = false;
  private quiesced = true;
  private disposed = false;

  constructor(options: MdkChatServiceOptions) {
    if (
      options.relayEndpoints.length < 1 ||
      options.relayEndpoints.length > 8
    ) {
      throw new TypeError('The MDK relay endpoint count is invalid.');
    }
    this.relayEndpoints = Object.freeze([...options.relayEndpoints]);
    this.rpc = new MdkProductRpcClient(options.workerFactory);
    this.now = options.now ?? Date.now;
    this.idFactory =
      options.idFactory ?? (() => crypto.randomUUID().replaceAll('-', ''));
  }

  readonly subscribe = (listener: ChatServiceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ChatSnapshot =>
    Object.freeze({
      availability: this.availability,
      relayEndpoints: this.relayEndpoints,
      conversations: this.durableState.conversations,
      pendingInvites: this.durableState.pendingInvites,
      syncState: this.syncState,
    });

  async open(input: OpenChatInput): Promise<ChatAvailability> {
    if (this.disposed) throw new ChatError('locked');
    if (
      input.identitySecret === undefined ||
      input.identitySecret.length !== 32 ||
      input.stateStore === undefined
    ) {
      throw new ChatError('storage_corrupt');
    }
    input.signal.throwIfAborted();
    this.wipeSessionKeys();
    this.storageKey = input.storageKey.slice();
    this.identitySecret = input.identitySecret.slice();
    this.stateStore = input.stateStore;
    this.durableState = (await input.stateStore.load()) ?? emptyState();
    this.quiesced = false;
    this.opened = true;
    if (!this.durableState.identityInitialized) {
      this.availability = EMPTY_AVAILABILITY;
      this.emit();
      return this.availability;
    }
    const result = await this.openRuntime(input.signal);
    const identity = identityFromPubkey(result.nostrPubkey);
    if (
      this.durableState.identity === undefined ||
      this.durableState.identity.address !== identity.address
    ) {
      throw new ChatError('storage_corrupt');
    }
    if (this.reconcileBindings(result.groups)) await this.persist();
    this.availability = available(identity);
    this.emit();
    return this.availability;
  }

  initializeIdentity(signal: AbortSignal): Promise<ChatIdentitySummary> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (this.durableState.identityInitialized) {
        return this.durableState.identity!;
      }
      const opened = await this.openRuntime(signal);
      await this.rpc.execute({ method: 'initialize_identity' }, signal);
      const identity = identityFromPubkey(opened.nostrPubkey);
      this.durableState = Object.freeze({
        ...this.durableState,
        identityInitialized: true,
        identity,
      });
      await this.persist();
      this.availability = available(identity);
      this.emit();
      return identity;
    });
  }

  createConversation(input: CreateConversationInput): Promise<ConversationId> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const title = sanitizeChatText(input.title, 80);
      const targetPubkey = parseChatAddress(input.inviteAddress).publicKeyHex;
      const result = await this.rpc.execute(
        { method: 'create_conversation', targetPubkey },
        input.signal,
      );
      const group = this.newGroup(result.groups);
      const id = conversationId(`conversation:${this.idFactory()}`);
      const conversation = conversationSummary(id, title, group.memberCount);
      this.durableState = appendConversation(
        this.durableState,
        conversation,
        group.groupId,
      );
      await this.persist();
      this.emit();
      return id;
    });
  }

  acceptInvite(
    id: ReturnType<typeof chatInviteId>,
    signal: AbortSignal,
  ): Promise<ConversationId> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const invite = this.durableState.pendingInvites.find(
        (item) => item.id === id,
      );
      if (invite === undefined) throw new ChatError('invite_invalid');
      const result = await this.rpc.execute(
        { method: 'accept_invite', inviteId: relayInviteId(id) },
        signal,
      );
      const group = this.newGroup(result.groups);
      const conversation = conversationSummary(
        conversationId(`conversation:${this.idFactory()}`),
        invite.title,
        group.memberCount,
      );
      const withConversation = appendConversation(
        this.durableState,
        conversation,
        group.groupId,
      );
      this.durableState = Object.freeze({
        ...withConversation,
        pendingInvites: Object.freeze(
          this.durableState.pendingInvites.filter((item) => item.id !== id),
        ),
        handledInviteIds: appendHandledInvite(
          this.durableState.handledInviteIds,
          id,
        ),
      });
      await this.persist();
      this.emit();
      return conversation.id;
    });
  }

  declineInvite(
    id: ReturnType<typeof chatInviteId>,
    signal: AbortSignal,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.assertAvailable();
      signal.throwIfAborted();
      if (!this.durableState.pendingInvites.some((item) => item.id === id)) {
        throw new ChatError('invite_invalid');
      }
      this.durableState = Object.freeze({
        ...this.durableState,
        pendingInvites: Object.freeze(
          this.durableState.pendingInvites.filter((item) => item.id !== id),
        ),
        handledInviteIds: appendHandledInvite(
          this.durableState.handledInviteIds,
          id,
        ),
      });
      await this.persist();
      this.emit();
    });
  }

  sendMessage(input: SendChatMessageInput): Promise<ChatMessage> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const conversation = this.requireConversation(input.conversationId);
      if (conversation.removed) throw new ChatError('removed_member');
      const groupId = this.groupIdFor(conversation.id);
      const text = sanitizeChatText(input.text);
      if (new TextEncoder().encode(text).length > 4_096) {
        throw new ChatError('invalid_input');
      }
      const pending = Object.freeze({
        id: chatMessageId(`message:${this.idFactory()}`),
        conversationId: conversation.id,
        direction: 'outgoing' as const,
        text,
        sentAtMs: this.now(),
        delivery: 'pending' as const,
      });
      this.addOrReplaceMessage(pending);
      await this.persist();
      this.emit();
      try {
        const result = await this.rpc.execute(
          {
            method: 'send',
            groupId,
            content: text,
            createdAt: Math.floor(pending.sentAtMs / 1_000),
          },
          input.signal,
        );
        if (result.published === undefined) throw new ChatError('internal');
        if (!result.published) {
          if (result.eventId === undefined || result.eventJson === undefined) {
            throw new ChatError('internal');
          }
          this.putOutbox({
            messageId: pending.id,
            eventId: result.eventId,
            eventJson: result.eventJson,
          });
        } else {
          this.removeOutbox(pending.id);
        }
        const settled = Object.freeze({
          ...pending,
          delivery: result.published
            ? ('published' as const)
            : ('failed' as const),
        });
        this.addOrReplaceMessage(settled);
        await this.persist();
        this.emit();
        return settled;
      } catch (error) {
        const failed = Object.freeze({
          ...pending,
          delivery: 'failed' as const,
        });
        this.addOrReplaceMessage(failed);
        await this.persist();
        this.emit();
        throw error;
      }
    });
  }

  retryMessage(id: ChatMessageId, signal: AbortSignal): Promise<ChatMessage> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const message = this.durableState.messages.find((item) => item.id === id);
      const outbox = this.durableState.outbox.find(
        (entry) => entry.messageId === id,
      );
      if (message?.delivery !== 'failed' || outbox === undefined) {
        throw new ChatError('invalid_input');
      }
      const result = await this.rpc.execute(
        {
          method: 'retry',
          eventId: outbox.eventId,
          eventJson: outbox.eventJson,
        },
        signal,
      );
      if (result.published === undefined) throw new ChatError('internal');
      const settled = Object.freeze({
        ...message,
        delivery: result.published
          ? ('published' as const)
          : ('failed' as const),
      });
      if (result.published) this.removeOutbox(id);
      this.addOrReplaceMessage(settled);
      await this.persist();
      this.emit();
      return settled;
    });
  }

  sendPayment(input: SendChatPaymentInput): Promise<ChatPayment> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const conversation = this.requireConversation(input.conversationId);
      if (conversation.removed) throw new ChatError('removed_member');
      const paymentId = chatMessageId(`payment:${this.idFactory()}`);
      let content: string;
      try {
        content = encodeChatPaymentEnvelope(
          paymentId,
          input.amountSats,
          input.notes.reveal(),
        );
      } catch {
        throw new ChatError('invalid_input');
      } finally {
        input.notes.clear();
      }
      const pending = Object.freeze({
        id: paymentId,
        conversationId: conversation.id,
        direction: 'outgoing' as const,
        amountSats: input.amountSats,
        sentAtMs: this.now(),
        status: 'pending' as const,
        operationKey: input.operationKey,
      });
      this.addOrReplacePayment(pending);
      await this.persist();
      this.emit();
      try {
        const result = await this.rpc.execute(
          {
            method: 'send',
            groupId: this.groupIdFor(conversation.id),
            content,
            createdAt: Math.floor(pending.sentAtMs / 1_000),
          },
          input.signal,
        );
        if (result.published === undefined) throw new ChatError('internal');
        if (!result.published) {
          if (result.eventId === undefined || result.eventJson === undefined) {
            throw new ChatError('internal');
          }
          this.putOutbox({
            messageId: pending.id,
            eventId: result.eventId,
            eventJson: result.eventJson,
          });
        } else {
          this.removeOutbox(pending.id);
        }
        const settled = Object.freeze({
          ...pending,
          status: result.published ? ('pending' as const) : ('failed' as const),
        });
        this.addOrReplacePayment(settled);
        await this.persist();
        this.emit();
        return settled;
      } catch (error) {
        const failed = Object.freeze({ ...pending, status: 'failed' as const });
        this.addOrReplacePayment(failed);
        await this.persist();
        this.emit();
        throw error;
      }
    });
  }

  retryPayment(id: ChatMessageId, signal: AbortSignal): Promise<ChatPayment> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const payment = this.durableState.payments.find((item) => item.id === id);
      const outbox = this.durableState.outbox.find(
        (entry) => entry.messageId === id,
      );
      if (payment?.status !== 'failed' || outbox === undefined) {
        throw new ChatError('invalid_input');
      }
      const result = await this.rpc.execute(
        {
          method: 'retry',
          eventId: outbox.eventId,
          eventJson: outbox.eventJson,
        },
        signal,
      );
      if (result.published === undefined) throw new ChatError('internal');
      const settled = Object.freeze({
        ...payment,
        status: result.published ? ('pending' as const) : ('failed' as const),
      });
      if (result.published) this.removeOutbox(id);
      this.addOrReplacePayment(settled);
      await this.persist();
      this.emit();
      return publicPayment(settled);
    });
  }

  async listPayments(
    conversation: ConversationId,
    signal: AbortSignal,
  ): Promise<readonly ChatPayment[]> {
    this.assertAvailable();
    this.requireConversation(conversation);
    signal.throwIfAborted();
    return Object.freeze(
      this.durableState.payments
        .filter(({ conversationId }) => conversationId === conversation)
        .sort(
          (left, right) =>
            left.sentAtMs - right.sentAtMs || left.id.localeCompare(right.id),
        )
        .map(publicPayment),
    );
  }

  preparePaymentClaim(
    id: ChatMessageId,
    signal: AbortSignal,
  ): Promise<PreparedChatPaymentClaim> {
    return this.enqueue(async () => {
      this.assertAvailable();
      signal.throwIfAborted();
      const payment = this.durableState.payments.find((item) => item.id === id);
      if (
        payment === undefined ||
        payment.direction !== 'incoming' ||
        payment.status !== 'claimable' ||
        payment.ecashNotes === undefined
      ) {
        throw new ChatError('invalid_input');
      }
      return Object.freeze({
        payment: publicPayment(payment),
        notes: clearableSecretText(payment.ecashNotes),
      });
    });
  }

  markPaymentClaimed(id: ChatMessageId, signal: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      this.assertAvailable();
      signal.throwIfAborted();
      const payment = this.durableState.payments.find((item) => item.id === id);
      if (payment === undefined || payment.direction !== 'incoming') {
        throw new ChatError('invalid_input');
      }
      this.addOrReplacePayment(
        Object.freeze({
          id: payment.id,
          conversationId: payment.conversationId,
          direction: payment.direction,
          amountSats: payment.amountSats,
          sentAtMs: payment.sentAtMs,
          status: 'claimed',
        }),
      );
      await this.persist();
      this.emit();
    });
  }

  leaveConversation(id: ConversationId, signal: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const conversation = this.requireConversation(id);
      if (conversation.removed) throw new ChatError('removed_member');
      await this.rpc.execute(
        { method: 'leave', groupId: this.groupIdFor(id) },
        signal,
      );
      this.durableState = Object.freeze({
        ...this.durableState,
        conversations: Object.freeze(
          this.durableState.conversations.map((item) =>
            item.id === id ? Object.freeze({ ...item, removed: true }) : item,
          ),
        ),
      });
      await this.persist();
      this.emit();
    });
  }

  synchronize(signal: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      this.assertAvailable();
      this.syncState = 'syncing';
      this.emit();
      try {
        const inviteResult = await this.rpc.execute(
          { method: 'list_invites' },
          signal,
        );
        const handledInvites = new Set(this.durableState.handledInviteIds);
        const pendingInvites = Object.freeze(
          (inviteResult.invites ?? [])
            .map((invite) =>
              Object.freeze({
                id: chatInviteId(`invite:${invite.id}`),
                title: 'Encrypted conversation',
                inviterLabel: 'Marmot contact',
                receivedAtMs: invite.receivedAt * 1_000,
              }),
            )
            .filter(({ id }) => !handledInvites.has(id)),
        );
        const memberCounts = new Map<ConversationId, number>();
        let groupError: unknown;
        for (const binding of this.durableState.groupBindings) {
          let result: MdkProductResult;
          try {
            result = await this.rpc.execute(
              { method: 'sync', groupId: binding.groupId },
              signal,
            );
          } catch (error) {
            if (signal.aborted) throw error;
            groupError ??= error;
            continue;
          }
          for (const received of result.received ?? []) {
            const receivedBinding = this.durableState.groupBindings.find(
              ({ groupId }) => groupId === received.groupId,
            );
            if (receivedBinding === undefined) continue;
            const content = parseChatContent(received.content);
            if (content.kind === 'payment') {
              this.addIncomingPayment(
                receivedBinding.conversationId,
                content.payment.paymentId,
                content.payment.amountSats,
                content.payment.notes,
                received.createdAt * 1_000,
              );
            } else if (content.kind === 'text') {
              this.addOrReplaceMessage(
                Object.freeze({
                  id: chatMessageId(`event:${received.id}`),
                  conversationId: receivedBinding.conversationId,
                  direction: 'incoming' as const,
                  text: sanitizeChatText(content.text),
                  sentAtMs: received.createdAt * 1_000,
                  delivery: 'received' as const,
                }),
              );
            }
          }
          const status = result.groups.find(
            ({ groupId }) => groupId === binding.groupId,
          );
          if (status !== undefined) {
            memberCounts.set(binding.conversationId, status.memberCount);
          }
        }
        this.durableState = Object.freeze({
          ...this.durableState,
          conversations: Object.freeze(
            this.durableState.conversations.map((item) =>
              memberCounts.has(item.id)
                ? Object.freeze({
                    ...item,
                    memberCount: memberCounts.get(item.id)!,
                  })
                : item,
            ),
          ),
          pendingInvites,
        });
        await this.persist();
        if (groupError !== undefined) throw groupError;
        this.syncState = 'idle';
      } catch (error) {
        this.syncState =
          error instanceof ChatError && error.code === 'relay_unavailable'
            ? 'offline'
            : 'error';
        throw error;
      } finally {
        this.emit();
      }
    });
  }

  async listMessages(input: ListChatMessagesInput): Promise<ChatMessagePage> {
    this.assertAvailable();
    this.requireConversation(input.conversationId);
    input.signal.throwIfAborted();
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new ChatError('invalid_input');
    }
    const messages = this.durableState.messages
      .filter(({ conversationId: id }) => id === input.conversationId)
      .sort(
        (left, right) =>
          left.sentAtMs - right.sentAtMs || left.id.localeCompare(right.id),
      );
    const offset = parseCursor(input.cursor, messages.length);
    const page = messages.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    return Object.freeze({
      messages: Object.freeze(page),
      nextCursor:
        nextOffset < messages.length
          ? chatCursor(`offset:${nextOffset}`)
          : undefined,
    });
  }

  quiesce(): void {
    this.quiesced = true;
    this.rpc.quiesce();
  }

  async stop(): Promise<void> {
    await this.operationTail.catch(() => undefined);
    await this.rpc.stop();
    this.opened = false;
  }

  lock(): void {
    this.quiesced = true;
    this.opened = false;
    this.stateStore = undefined;
    this.wipeSessionKeys();
    this.availability = Object.freeze({ status: 'disabled' });
    this.syncState = 'idle';
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.quiesce();
    await this.stop();
    this.lock();
    this.rpc.dispose();
    this.listeners.clear();
  }

  private async openRuntime(signal: AbortSignal) {
    if (this.storageKey === undefined || this.identitySecret === undefined) {
      throw new ChatError('locked');
    }
    const result = await this.rpc.open(
      {
        relayEndpoints: this.relayEndpoints,
        storageKey: this.storageKey,
        identitySecret: this.identitySecret,
      },
      signal,
    );
    return result;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.operationTail.then(operation, operation);
    this.operationTail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private assertOpen(): void {
    if (this.disposed || this.quiesced || !this.opened)
      throw new ChatError('locked');
  }

  private assertAvailable(): void {
    this.assertOpen();
    if (this.availability.status !== 'available') {
      throw new ChatError('identity_unavailable');
    }
  }

  private requireConversation(id: ConversationId): ConversationSummary {
    const conversation = this.durableState.conversations.find(
      (item) => item.id === id,
    );
    if (conversation === undefined) throw new ChatError('invalid_input');
    return conversation;
  }

  private groupIdFor(conversationId: ConversationId): string {
    const binding = this.durableState.groupBindings.find(
      (item) => item.conversationId === conversationId,
    );
    if (binding === undefined) throw new ChatError('storage_corrupt');
    return binding.groupId;
  }

  private newGroup<T extends { readonly groupId: string }>(
    groups: readonly T[],
  ): T {
    const known = new Set(
      this.durableState.groupBindings.map(({ groupId }) => groupId),
    );
    const added = groups.filter(({ groupId }) => !known.has(groupId));
    if (added.length !== 1) throw new ChatError('storage_corrupt');
    return added[0]!;
  }

  private reconcileBindings(
    groups: readonly { readonly groupId: string }[],
  ): boolean {
    const runtimeIds = new Set(groups.map(({ groupId }) => groupId));
    const bindings = this.durableState.groupBindings;
    if (
      bindings.some(({ groupId }) => !runtimeIds.has(groupId)) ||
      groups.length !== this.durableState.conversations.length
    ) {
      throw new ChatError('storage_corrupt');
    }
    if (bindings.length === groups.length) return false;
    if (
      bindings.length === 0 &&
      groups.length === 1 &&
      this.durableState.conversations.length === 1
    ) {
      this.durableState = Object.freeze({
        ...this.durableState,
        groupBindings: Object.freeze([
          Object.freeze({
            conversationId: this.durableState.conversations[0]!.id,
            groupId: groups[0]!.groupId,
          }),
        ]),
      });
      return true;
    }
    throw new ChatError('storage_corrupt');
  }

  private addOrReplaceMessage(message: ChatMessage): void {
    const messages = this.durableState.messages.filter(
      ({ id }) => id !== message.id,
    );
    messages.push(message);
    messages.sort(
      (left, right) =>
        left.sentAtMs - right.sentAtMs || left.id.localeCompare(right.id),
    );
    if (messages.length > MAX_MESSAGES)
      messages.splice(0, messages.length - MAX_MESSAGES);
    const conversations = this.durableState.conversations.map((conversation) =>
      conversation.id === message.conversationId
        ? Object.freeze({ ...conversation, lastMessageAtMs: message.sentAtMs })
        : conversation,
    );
    this.durableState = Object.freeze({
      ...this.durableState,
      conversations: Object.freeze(conversations),
      messages: Object.freeze(messages),
      outbox: Object.freeze(
        this.durableState.outbox.filter(({ messageId }) =>
          messages.some(({ id }) => id === messageId),
        ),
      ),
    });
  }

  private addIncomingPayment(
    conversationId: ConversationId,
    id: ChatMessageId,
    amountSats: number,
    ecashNotes: string,
    sentAtMs: number,
  ): void {
    const existing = this.durableState.payments.find(
      (payment) => payment.id === id,
    );
    if (existing !== undefined) {
      if (
        existing.conversationId !== conversationId ||
        existing.direction !== 'incoming' ||
        existing.amountSats !== amountSats
      ) {
        return;
      }
      if (existing.status === 'claimed') return;
    }
    this.addOrReplacePayment(
      Object.freeze({
        id,
        conversationId,
        direction: 'incoming',
        amountSats,
        sentAtMs,
        status: 'claimable',
        ecashNotes,
      }),
    );
  }

  private addOrReplacePayment(
    payment: DurableChatState['payments'][number],
  ): void {
    const payments = this.durableState.payments.filter(
      ({ id }) => id !== payment.id,
    );
    payments.push(payment);
    payments.sort(
      (left, right) =>
        left.sentAtMs - right.sentAtMs || left.id.localeCompare(right.id),
    );
    if (payments.length > MAX_MESSAGES) {
      payments.splice(0, payments.length - MAX_MESSAGES);
    }
    this.durableState = Object.freeze({
      ...this.durableState,
      conversations: Object.freeze(
        this.durableState.conversations.map((conversation) =>
          conversation.id === payment.conversationId
            ? Object.freeze({
                ...conversation,
                lastMessageAtMs: payment.sentAtMs,
              })
            : conversation,
        ),
      ),
      payments: Object.freeze(payments),
      outbox: Object.freeze(
        this.durableState.outbox.filter(
          ({ messageId }) =>
            payments.some(({ id }) => id === messageId) ||
            this.durableState.messages.some(({ id }) => id === messageId),
        ),
      ),
    });
  }

  private putOutbox(entry: DurableChatState['outbox'][number]): void {
    const outbox = [
      ...this.durableState.outbox.filter(
        ({ messageId }) => messageId !== entry.messageId,
      ),
      Object.freeze(entry),
    ].slice(-MAX_OUTBOX);
    this.durableState = Object.freeze({
      ...this.durableState,
      outbox: Object.freeze(outbox),
    });
  }

  private removeOutbox(messageId: ChatMessageId): void {
    this.durableState = Object.freeze({
      ...this.durableState,
      outbox: Object.freeze(
        this.durableState.outbox.filter(
          (entry) => entry.messageId !== messageId,
        ),
      ),
    });
  }

  private async persist(): Promise<void> {
    if (this.stateStore === undefined) throw new ChatError('locked');
    try {
      await this.stateStore.save(this.durableState);
    } catch {
      this.quiesced = true;
      this.rpc.quiesce();
      throw new ChatError('storage_unavailable');
    }
  }

  private wipeSessionKeys(): void {
    this.storageKey?.fill(0);
    this.identitySecret?.fill(0);
    this.storageKey = undefined;
    this.identitySecret = undefined;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function emptyState(): DurableChatState {
  return Object.freeze({
    formatVersion: 3,
    identityInitialized: false,
    conversations: Object.freeze([]),
    groupBindings: Object.freeze([]),
    pendingInvites: Object.freeze([]),
    handledInviteIds: Object.freeze([]),
    messages: Object.freeze([]),
    payments: Object.freeze([]),
    outbox: Object.freeze([]),
  });
}

function publicPayment(
  payment: DurableChatState['payments'][number],
): ChatPayment {
  return Object.freeze({
    id: payment.id,
    conversationId: payment.conversationId,
    direction: payment.direction,
    amountSats: payment.amountSats,
    sentAtMs: payment.sentAtMs,
    status: payment.status,
    ...(payment.operationKey === undefined
      ? {}
      : { operationKey: payment.operationKey }),
  });
}

function appendHandledInvite(
  current: DurableChatState['handledInviteIds'],
  id: DurableChatState['handledInviteIds'][number],
): DurableChatState['handledInviteIds'] {
  const values = [...current.filter((candidate) => candidate !== id), id];
  return Object.freeze(values.slice(-MAX_HANDLED_INVITES));
}

function available(identity: ChatIdentitySummary): ChatAvailability {
  return Object.freeze({
    status: 'available',
    identity,
    capabilities: CAPABILITIES,
  });
}

function conversationSummary(
  id: ConversationId,
  title: string,
  memberCount: number,
): ConversationSummary {
  return Object.freeze({
    id,
    title,
    memberCount,
    unreadCount: 0,
    removed: false,
  });
}

function appendConversation(
  state: DurableChatState,
  conversation: ConversationSummary,
  groupId: string,
): DurableChatState {
  return Object.freeze({
    ...state,
    conversations: Object.freeze([...state.conversations, conversation]),
    groupBindings: Object.freeze([
      ...state.groupBindings,
      Object.freeze({ conversationId: conversation.id, groupId }),
    ]),
  });
}

function identityFromPubkey(pubkey: string): ChatIdentitySummary {
  try {
    const { address, fingerprint } = chatAddressFromPublicKey(pubkey);
    return Object.freeze({ address, fingerprint });
  } catch {
    throw new ChatError('internal');
  }
}

function relayInviteId(id: ReturnType<typeof chatInviteId>): string {
  const value = id.startsWith('invite:') ? id.slice('invite:'.length) : '';
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new ChatError('invite_invalid');
  return value;
}

function parseCursor(value: string | undefined, length: number): number {
  if (value === undefined) return 0;
  const match = /^offset:(\d+)$/u.exec(value);
  const offset = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new ChatError('invalid_input');
  }
  return offset;
}
