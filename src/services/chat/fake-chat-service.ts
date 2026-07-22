import {
  ChatError,
  chatCursor,
  chatInviteId,
  chatMessageId,
  conversationId,
  sanitizeChatText,
  type ChatAvailability,
  type ChatIdentitySummary,
  type ChatInviteId,
  type ChatMessage,
  type ChatMessageId,
  type ChatMessagePage,
  type ChatPayment,
  type ChatSnapshot,
  type ConversationId,
  type ConversationSummary,
  type PendingChatInvite,
  clearableSecretText,
} from '../../domain';
import type {
  ChatService,
  ChatServiceListener,
  CreateConversationInput,
  ListChatMessagesInput,
  OpenChatInput,
  PreparedChatPaymentClaim,
  SendChatPaymentInput,
  SendChatMessageInput,
} from './chat-service';

export type FakeChatScenario =
  | 'empty'
  | 'setup-required'
  | 'two-groups'
  | 'pending-invite'
  | 'offline'
  | 'duplicate-reordered'
  | 'removed-member'
  | 'degraded-storage'
  | 'retryable-publish-failure';

export interface FakeChatServiceOptions {
  readonly scenario?: FakeChatScenario;
  readonly latencyMs?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly relayEndpoints?: readonly string[];
}

const FAKE_IDENTITY: ChatIdentitySummary = Object.freeze({
  address: 'npub1fakechatapplicationboundary',
  fingerprint: 'FAKE-CHAT-0001',
});
const CAPABILITIES = Object.freeze([
  'text',
  'groups',
  'invites',
  'offline-outbox',
  'ecash-payments',
] as const);

export class FakeChatService implements ChatService {
  readonly kind = 'fake' as const;
  private readonly listeners = new Set<ChatServiceListener>();
  private readonly latencyMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly scenario: FakeChatScenario;
  private readonly relayEndpoints: readonly string[];
  private conversations: ConversationSummary[];
  private invites: PendingChatInvite[];
  private readonly messages = new Map<ConversationId, ChatMessage[]>();
  private readonly payments = new Map<ConversationId, ChatPayment[]>();
  private readonly paymentNotes = new Map<ChatMessageId, string>();
  private availability: ChatAvailability = Object.freeze({
    status: 'disabled',
  });
  private syncState: ChatSnapshot['syncState'] = 'idle';
  private opened = false;
  private quiesced = true;
  private disposed = false;
  private nextId = 0;

  constructor(options: FakeChatServiceOptions = {}) {
    this.scenario = options.scenario ?? 'empty';
    this.relayEndpoints = Object.freeze([
      ...(options.relayEndpoints ?? ['wss://relay.example']),
    ]);
    this.latencyMs = options.latencyMs ?? 0;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `fake-${++this.nextId}`);
    const seeded = seedScenario(this.scenario, this.now());
    this.conversations = seeded.conversations;
    this.invites = seeded.invites;
    for (const [id, messages] of seeded.messages) {
      this.messages.set(id, normalizeMessages(messages));
    }
    for (const [id, payments] of seeded.payments) {
      this.payments.set(id, [...payments]);
      for (const payment of payments) {
        if (
          payment.direction === 'incoming' &&
          payment.status === 'claimable'
        ) {
          this.paymentNotes.set(
            payment.id,
            `fedimint-ecash:${payment.amountSats * 1_000}:demo-fedimint-federation:${payment.id}`,
          );
        }
      }
    }
  }

  readonly subscribe = (listener: ChatServiceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ChatSnapshot =>
    freezeSnapshot({
      availability: this.availability,
      relayEndpoints: this.relayEndpoints,
      conversations: this.conversations,
      pendingInvites: this.invites,
      syncState: this.syncState,
    });

  async open(input: OpenChatInput): Promise<ChatAvailability> {
    this.assertNotDisposed();
    if (input.storageKey.length !== 32) {
      throw new ChatError('storage_corrupt');
    }
    await this.wait(input.signal);
    this.opened = true;
    this.quiesced = false;
    this.availability =
      this.scenario === 'setup-required'
        ? Object.freeze({ status: 'setup_required' })
        : this.scenario === 'degraded-storage'
          ? Object.freeze({
              status: 'degraded',
              reason: 'storage_corrupt',
              retryable: false,
            })
          : available();
    this.syncState = this.scenario === 'offline' ? 'offline' : 'idle';
    this.emit();
    return this.availability;
  }

  async initializeIdentity(signal: AbortSignal): Promise<ChatIdentitySummary> {
    this.assertOperational();
    await this.wait(signal);
    this.availability = available();
    this.emit();
    return FAKE_IDENTITY;
  }

  async createConversation(
    input: CreateConversationInput,
  ): Promise<ConversationId> {
    this.assertAvailable();
    await this.wait(input.signal);
    const title = sanitizeChatText(input.title.trim(), 120);
    sanitizeChatText(input.inviteAddress.trim(), 512);
    const id = conversationId(this.idFactory());
    this.conversations = [
      ...this.conversations,
      Object.freeze({
        id,
        title,
        memberCount: 2,
        unreadCount: 0,
        removed: false,
      }),
    ];
    this.messages.set(id, []);
    this.emit();
    return id;
  }

  async acceptInvite(
    id: ChatInviteId,
    signal: AbortSignal,
  ): Promise<ConversationId> {
    this.assertAvailable();
    await this.wait(signal);
    const invite = this.invites.find((candidate) => candidate.id === id);
    if (invite === undefined) throw new ChatError('invite_invalid');
    const conversation = conversationId(this.idFactory());
    this.invites = this.invites.filter((candidate) => candidate.id !== id);
    this.conversations = [
      ...this.conversations,
      Object.freeze({
        id: conversation,
        title: invite.title,
        memberCount: 2,
        unreadCount: 0,
        removed: false,
      }),
    ];
    this.messages.set(conversation, []);
    this.emit();
    return conversation;
  }

  async declineInvite(id: ChatInviteId, signal: AbortSignal): Promise<void> {
    this.assertAvailable();
    await this.wait(signal);
    if (!this.invites.some((candidate) => candidate.id === id)) {
      throw new ChatError('invite_invalid');
    }
    this.invites = this.invites.filter((candidate) => candidate.id !== id);
    this.emit();
  }

  async sendMessage(input: SendChatMessageInput): Promise<ChatMessage> {
    this.assertAvailable();
    const conversation = this.requireConversation(input.conversationId);
    if (conversation.removed) throw new ChatError('removed_member');
    await this.wait(input.signal);
    const message = Object.freeze({
      id: chatMessageId(this.idFactory()),
      conversationId: conversation.id,
      direction: 'outgoing' as const,
      text: sanitizeChatText(input.text),
      sentAtMs: this.now(),
      delivery:
        this.scenario === 'offline'
          ? ('pending' as const)
          : this.scenario === 'retryable-publish-failure'
            ? ('failed' as const)
            : ('published' as const),
    });
    this.messages.set(conversation.id, [
      ...(this.messages.get(conversation.id) ?? []),
      message,
    ]);
    this.touchConversation(
      conversation.id,
      message.sentAtMs,
      message.text,
      'outgoing',
    );
    this.emit();
    return message;
  }

  async retryMessage(
    id: ChatMessageId,
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    this.assertAvailable();
    await this.wait(signal);
    for (const [conversationId, messages] of this.messages) {
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0 || messages[index]?.delivery !== 'failed') continue;
      const updated = Object.freeze({
        ...messages[index]!,
        delivery: 'published' as const,
      });
      const next = [...messages];
      next[index] = updated;
      this.messages.set(conversationId, next);
      this.emit();
      return updated;
    }
    throw new ChatError('invalid_input');
  }

  async sendPayment(input: SendChatPaymentInput): Promise<ChatPayment> {
    this.assertAvailable();
    const conversation = this.requireConversation(input.conversationId);
    if (conversation.removed) throw new ChatError('removed_member');
    if (!Number.isSafeInteger(input.amountSats) || input.amountSats < 1) {
      throw new ChatError('invalid_input');
    }
    input.notes.clear();
    await this.wait(input.signal);
    const payment = Object.freeze({
      id: chatMessageId(`payment:${this.idFactory()}`),
      conversationId: conversation.id,
      direction: 'outgoing' as const,
      amountSats: input.amountSats,
      sentAtMs: this.now(),
      status:
        this.scenario === 'retryable-publish-failure'
          ? ('failed' as const)
          : ('pending' as const),
      operationKey: input.operationKey,
    });
    this.putPayment(payment);
    this.emit();
    return payment;
  }

  async retryPayment(
    id: ChatMessageId,
    signal: AbortSignal,
  ): Promise<ChatPayment> {
    this.assertAvailable();
    await this.wait(signal);
    for (const [conversation, payments] of this.payments) {
      const index = payments.findIndex((payment) => payment.id === id);
      if (index < 0 || payments[index]?.status !== 'failed') continue;
      const updated = Object.freeze({
        ...payments[index]!,
        status: 'pending' as const,
      });
      const next = [...payments];
      next[index] = updated;
      this.payments.set(conversation, next);
      this.emit();
      return updated;
    }
    throw new ChatError('invalid_input');
  }

  async listPayments(
    conversation: ConversationId,
    signal: AbortSignal,
  ): Promise<readonly ChatPayment[]> {
    this.assertAvailable();
    this.requireConversation(conversation);
    await this.wait(signal);
    return Object.freeze([...(this.payments.get(conversation) ?? [])]);
  }

  async preparePaymentClaim(
    id: ChatMessageId,
    signal: AbortSignal,
  ): Promise<PreparedChatPaymentClaim> {
    this.assertAvailable();
    await this.wait(signal);
    const payment = [...this.payments.values()]
      .flat()
      .find((candidate) => candidate.id === id);
    const notes = this.paymentNotes.get(id);
    if (
      payment === undefined ||
      payment.direction !== 'incoming' ||
      payment.status !== 'claimable' ||
      notes === undefined
    ) {
      throw new ChatError('invalid_input');
    }
    return Object.freeze({ payment, notes: clearableSecretText(notes) });
  }

  async markPaymentClaimed(
    id: ChatMessageId,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertAvailable();
    await this.wait(signal);
    const payment = [...this.payments.values()]
      .flat()
      .find((candidate) => candidate.id === id);
    if (payment === undefined || payment.direction !== 'incoming') {
      throw new ChatError('invalid_input');
    }
    this.putPayment(Object.freeze({ ...payment, status: 'claimed' }));
    this.paymentNotes.delete(id);
    this.emit();
  }

  async leaveConversation(
    id: ConversationId,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertAvailable();
    const conversation = this.requireConversation(id);
    if (conversation.removed) throw new ChatError('removed_member');
    await this.wait(signal);
    this.conversations = this.conversations.map((item) =>
      item.id === id ? Object.freeze({ ...item, removed: true }) : item,
    );
    this.emit();
  }

  async synchronize(signal: AbortSignal): Promise<void> {
    this.assertAvailable();
    this.syncState = 'syncing';
    this.emit();
    try {
      await this.wait(signal);
      if (this.scenario === 'offline') throw new ChatError('offline');
      for (const [id, messages] of this.messages) {
        this.messages.set(id, normalizeMessages(messages));
      }
      this.syncState = 'idle';
    } catch (error) {
      this.syncState = error instanceof ChatError ? 'offline' : 'error';
      throw error;
    } finally {
      this.emit();
    }
  }

  async listMessages(input: ListChatMessagesInput): Promise<ChatMessagePage> {
    this.assertAvailable();
    this.requireConversation(input.conversationId);
    await this.wait(input.signal);
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new ChatError('invalid_input');
    }
    const messages = this.messages.get(input.conversationId) ?? [];
    const offset = parseCursor(input.cursor, messages.length);
    const page = messages.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    return Object.freeze({
      messages: Object.freeze([...page]),
      nextCursor:
        nextOffset < messages.length
          ? chatCursor(`offset:${nextOffset}`)
          : undefined,
    });
  }

  quiesce(): void {
    this.quiesced = true;
  }

  async stop(): Promise<void> {
    this.quiesced = true;
    this.opened = false;
    this.syncState = 'idle';
  }

  lock(): void {
    this.quiesced = true;
    this.opened = false;
    this.availability = Object.freeze({ status: 'disabled' });
    this.emit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.stop();
    this.lock();
    this.disposed = true;
    this.listeners.clear();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new ChatError('internal');
  }

  private assertOperational(): void {
    this.assertNotDisposed();
    if (!this.opened || this.quiesced) throw new ChatError('locked');
    if (this.availability.status === 'degraded') {
      throw new ChatError(this.availability.reason);
    }
  }

  private assertAvailable(): void {
    this.assertOperational();
    if (this.availability.status !== 'available') {
      throw new ChatError('identity_unavailable');
    }
  }

  private requireConversation(id: ConversationId): ConversationSummary {
    const conversation = this.conversations.find((item) => item.id === id);
    if (conversation === undefined) throw new ChatError('invalid_input');
    return conversation;
  }

  private touchConversation(
    id: ConversationId,
    atMs: number,
    preview?: string,
    direction?: 'incoming' | 'outgoing',
  ): void {
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === id
        ? Object.freeze({
            ...conversation,
            lastMessageAtMs: atMs,
            lastMessagePreview: preview ?? conversation.lastMessagePreview,
            lastMessageDirection:
              direction ?? conversation.lastMessageDirection,
          })
        : conversation,
    );
  }

  private putPayment(payment: ChatPayment): void {
    const current = this.payments.get(payment.conversationId) ?? [];
    this.payments.set(payment.conversationId, [
      ...current.filter(({ id }) => id !== payment.id),
      payment,
    ]);
    this.touchConversation(payment.conversationId, payment.sentAtMs);
  }

  private async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.latencyMs === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, this.latencyMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function available(): ChatAvailability {
  return Object.freeze({
    status: 'available',
    identity: FAKE_IDENTITY,
    capabilities: CAPABILITIES,
  });
}

function seedScenario(
  scenario: FakeChatScenario,
  nowMs: number,
): {
  conversations: ConversationSummary[];
  invites: PendingChatInvite[];
  messages: ReadonlyMap<ConversationId, readonly ChatMessage[]>;
  payments: ReadonlyMap<ConversationId, readonly ChatPayment[]>;
} {
  const first = conversationId('conversation-primary');
  const second = conversationId('conversation-project');
  const conversations: ConversationSummary[] = [];
  const invites: PendingChatInvite[] = [];
  const messages = new Map<ConversationId, readonly ChatMessage[]>();
  const payments = new Map<ConversationId, readonly ChatPayment[]>();
  if (
    scenario === 'two-groups' ||
    scenario === 'duplicate-reordered' ||
    scenario === 'retryable-publish-failure' ||
    scenario === 'offline'
  ) {
    conversations.push(
      Object.freeze({
        id: first,
        title: scenario === 'offline' ? 'Offline chat' : 'Primary chat',
        memberCount: 2,
        unreadCount: 0,
        lastMessageAtMs: nowMs - 60_000,
        lastMessagePreview: 'Yes — testing it now.',
        lastMessageDirection: 'outgoing',
        removed: false,
      }),
    );
    if (scenario !== 'offline') {
      conversations.push(
        Object.freeze({
          id: second,
          title: 'Project group',
          memberCount: 4,
          unreadCount: 1,
          lastMessageAtMs: nowMs - 30_000,
          lastMessagePreview: 'Can you review the latest draft?',
          lastMessageDirection: 'incoming',
          removed: false,
        }),
      );
    }
  }
  if (
    scenario === 'two-groups' ||
    scenario === 'retryable-publish-failure' ||
    scenario === 'offline'
  ) {
    messages.set(first, [
      Object.freeze({
        id: chatMessageId('message-incoming'),
        conversationId: first,
        direction: 'incoming' as const,
        text: 'Did you get the latest update?',
        sentAtMs: nowMs - 120_000,
        delivery: 'received' as const,
      }),
      Object.freeze({
        id: chatMessageId('message-outgoing'),
        conversationId: first,
        direction: 'outgoing' as const,
        text: 'Yes — testing it now.',
        sentAtMs: nowMs - 60_000,
        delivery:
          scenario === 'offline'
            ? ('pending' as const)
            : ('published' as const),
      }),
    ]);
  }
  if (scenario === 'removed-member') {
    conversations.push(
      Object.freeze({
        id: first,
        title: 'Former group',
        memberCount: 3,
        unreadCount: 0,
        lastMessageAtMs: nowMs - 300_000,
        removed: true,
      }),
    );
    messages.set(first, [
      Object.freeze({
        id: chatMessageId('message-before-leave'),
        conversationId: first,
        direction: 'incoming' as const,
        text: 'This history remains visible after leaving.',
        sentAtMs: nowMs - 300_000,
        delivery: 'received' as const,
      }),
    ]);
  }
  if (scenario === 'pending-invite') {
    invites.push(
      Object.freeze({
        id: chatInviteId('invite-primary'),
        title: 'New conversation',
        inviterLabel: 'Known contact',
        receivedAtMs: 1_000,
      }),
    );
  }
  if (scenario === 'duplicate-reordered') {
    const duplicate = Object.freeze({
      id: chatMessageId('message-shared'),
      conversationId: first,
      direction: 'incoming' as const,
      text: 'second',
      sentAtMs: nowMs - 60_000,
      delivery: 'received' as const,
    });
    messages.set(first, [
      duplicate,
      Object.freeze({
        id: chatMessageId('message-first'),
        conversationId: first,
        direction: 'incoming' as const,
        text: 'first',
        sentAtMs: nowMs - 120_000,
        delivery: 'received' as const,
      }),
      duplicate,
    ]);
  }
  if (scenario === 'two-groups') {
    payments.set(first, [
      Object.freeze({
        id: chatMessageId('payment-demo-sent'),
        conversationId: first,
        direction: 'outgoing',
        amountSats: 50_000,
        sentAtMs: nowMs - 50_000,
        status: 'claimed',
      }),
      Object.freeze({
        id: chatMessageId('payment-demo-received'),
        conversationId: first,
        direction: 'incoming',
        amountSats: 20_000,
        sentAtMs: nowMs - 40_000,
        status: 'claimable',
      }),
    ]);
  }
  return { conversations, invites, messages, payments };
}

function normalizeMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const unique = new Map<ChatMessageId, ChatMessage>();
  for (const message of messages) unique.set(message.id, message);
  return [...unique.values()].sort(
    (left, right) =>
      left.sentAtMs - right.sentAtMs || left.id.localeCompare(right.id),
  );
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

function freezeSnapshot(snapshot: ChatSnapshot): ChatSnapshot {
  return Object.freeze({
    availability: snapshot.availability,
    relayEndpoints: Object.freeze([...snapshot.relayEndpoints]),
    conversations: Object.freeze([...snapshot.conversations]),
    pendingInvites: Object.freeze([...snapshot.pendingInvites]),
    syncState: snapshot.syncState,
  });
}
