import {
  publicChatError,
  toPublicChatError,
  type ChatInviteId,
  type ChatMessage,
  type ChatMessageId,
  type ChatMessagePage,
  type ChatPayment,
  type ClearableSecretText,
  type ChatSnapshot,
  type ConversationId,
  type PublicChatError,
  type OperationKey,
} from '../../domain';
import type { ChatService, PreparedChatPaymentClaim } from './chat-service';

export interface ChatControllerState {
  readonly snapshot: ChatSnapshot;
  readonly busy: readonly string[];
  readonly error?: PublicChatError;
}

type Listener = () => void;

/** Headless application coordinator; WP6 may bind this state to React. */
export class ChatController {
  private readonly listeners = new Set<Listener>();
  private readonly submissions = new Map<string, Promise<unknown>>();
  private unsubscribeService: (() => void) | undefined;
  private generation = 0;
  private disposed = false;
  private state: ChatControllerState;

  constructor(private readonly service: ChatService) {
    this.state = freezeState({
      snapshot: service.getSnapshot(),
      busy: [],
    });
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): ChatControllerState => this.state;

  start(): void {
    if (this.disposed || this.unsubscribeService !== undefined) return;
    const generation = ++this.generation;
    this.unsubscribeService = this.service.subscribe(() => {
      if (generation !== this.generation || this.disposed) return;
      this.update({ snapshot: this.service.getSnapshot() });
    });
    this.update({ snapshot: this.service.getSnapshot(), error: undefined });
  }

  initializeIdentity(signal: AbortSignal): Promise<void> {
    return this.submit('identity', undefined, async () => {
      await this.service.initializeIdentity(signal);
    });
  }

  createConversation(
    title: string,
    inviteAddress: string,
    signal: AbortSignal,
  ): Promise<ConversationId> {
    return this.submit('create-conversation', undefined, () =>
      this.service.createConversation({ title, inviteAddress, signal }),
    );
  }

  acceptInvite(id: ChatInviteId, signal: AbortSignal): Promise<ConversationId> {
    return this.submit(`accept:${id}`, undefined, () =>
      this.service.acceptInvite(id, signal),
    );
  }

  declineInvite(id: ChatInviteId, signal: AbortSignal): Promise<void> {
    return this.submit(`decline:${id}`, undefined, () =>
      this.service.declineInvite(id, signal),
    );
  }

  sendMessage(
    conversation: ConversationId,
    text: string,
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    return this.submit(`send:${conversation}`, conversation, () =>
      this.service.sendMessage({ conversationId: conversation, text, signal }),
    );
  }

  retryMessage(
    conversation: ConversationId,
    message: ChatMessageId,
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    return this.submit(`retry:${message}`, conversation, () =>
      this.service.retryMessage(message, signal),
    );
  }

  sendPayment(
    conversation: ConversationId,
    amountSats: number,
    notes: ClearableSecretText,
    operationKey: OperationKey,
    signal: AbortSignal,
  ): Promise<ChatPayment> {
    return this.submit(`payment:${conversation}`, conversation, () =>
      this.service.sendPayment({
        conversationId: conversation,
        amountSats,
        notes,
        operationKey,
        signal,
      }),
    );
  }

  retryPayment(
    conversation: ConversationId,
    payment: ChatMessageId,
    signal: AbortSignal,
  ): Promise<ChatPayment> {
    return this.submit(`retry-payment:${payment}`, conversation, () =>
      this.service.retryPayment(payment, signal),
    );
  }

  listPayments(
    conversation: ConversationId,
    signal: AbortSignal,
  ): Promise<readonly ChatPayment[]> {
    return this.submit(`payments:${conversation}`, undefined, () =>
      this.service.listPayments(conversation, signal),
    );
  }

  preparePaymentClaim(
    payment: ChatMessageId,
    signal: AbortSignal,
  ): Promise<PreparedChatPaymentClaim> {
    return this.submit(`prepare-payment:${payment}`, undefined, () =>
      this.service.preparePaymentClaim(payment, signal),
    );
  }

  markPaymentClaimed(
    conversation: ConversationId,
    payment: ChatMessageId,
    signal: AbortSignal,
  ): Promise<void> {
    return this.submit(`claim-payment:${payment}`, conversation, () =>
      this.service.markPaymentClaimed(payment, signal),
    );
  }

  leaveConversation(
    conversation: ConversationId,
    signal: AbortSignal,
  ): Promise<void> {
    return this.submit(`leave:${conversation}`, conversation, () =>
      this.service.leaveConversation(conversation, signal),
    );
  }

  synchronize(signal: AbortSignal): Promise<void> {
    return this.submit('synchronize', undefined, () =>
      this.service.synchronize(signal),
    );
  }

  listMessages(
    conversation: ConversationId,
    cursor: string | undefined,
    limit: number,
    signal: AbortSignal,
  ): Promise<ChatMessagePage> {
    return this.submit(
      `page:${conversation}:${cursor ?? 'first'}`,
      undefined,
      () =>
        this.service.listMessages({
          conversationId: conversation,
          cursor,
          limit,
          signal,
        }),
    );
  }

  clearError(): void {
    this.update({ error: undefined });
  }

  stop(): void {
    this.generation += 1;
    this.unsubscribeService?.();
    this.unsubscribeService = undefined;
    this.submissions.clear();
    this.update({ busy: [] });
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.listeners.clear();
  }

  private submit<T>(
    key: string,
    conversation: ConversationId | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.disposed || this.unsubscribeService === undefined) {
      return Promise.reject(new Error(publicChatError('locked').message));
    }
    const existing = this.submissions.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return existing;
    const generation = this.generation;
    const busyKey = conversation ?? key;
    this.update({
      busy: [...new Set([...this.state.busy, busyKey])],
      error: undefined,
    });
    const work = operation().then(
      (value) => {
        if (generation === this.generation && !this.disposed) {
          this.update({ snapshot: this.service.getSnapshot() });
        }
        return value;
      },
      (error: unknown) => {
        if (generation === this.generation && !this.disposed) {
          this.update({ error: toPublicChatError(error) });
        }
        throw error;
      },
    );
    this.submissions.set(key, work);
    const settle = (): void => {
      if (this.submissions.get(key) === work) this.submissions.delete(key);
      if (generation === this.generation && !this.disposed) {
        this.update({
          busy: this.state.busy.filter((candidate) => candidate !== busyKey),
        });
      }
    };
    void work.then(settle, settle);
    return work;
  }

  private update(patch: Partial<ChatControllerState>): void {
    this.state = freezeState({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
}

function freezeState(state: ChatControllerState): ChatControllerState {
  return Object.freeze({
    snapshot: state.snapshot,
    busy: Object.freeze([...state.busy]),
    error: state.error,
  });
}
