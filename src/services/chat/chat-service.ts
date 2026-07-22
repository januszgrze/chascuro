import type {
  ChatAvailability,
  ChatIdentitySummary,
  ChatInviteId,
  ChatMessage,
  ChatMessageId,
  ChatMessagePage,
  ChatPayment,
  ChatSnapshot,
  ConversationId,
  ConversationSummary,
  PendingChatInvite,
} from '../../domain';
import type { ClearableSecretText, OperationKey } from '../../domain';

export type ChatServiceKind = 'fake' | 'mdk';
export type ChatServiceListener = () => void;

export interface OpenChatInput {
  readonly storageKey: Uint8Array;
  /** Required by the real MDK service; deterministic fakes do not consume it. */
  readonly identitySecret?: Uint8Array;
  /** Required by the real MDK service; deterministic fakes remain in-memory. */
  readonly stateStore?: ChatStateStore;
  readonly signal: AbortSignal;
}

/** Sanitized application state encrypted inside the independent chat namespace. */
export interface DurableChatState {
  readonly formatVersion: 3;
  readonly identityInitialized: boolean;
  readonly identity?: ChatIdentitySummary;
  readonly conversations: readonly ConversationSummary[];
  /** Encrypted protocol binding. Never project this through ChatSnapshot. */
  readonly groupBindings: readonly DurableChatGroupBinding[];
  readonly pendingInvites: readonly PendingChatInvite[];
  readonly handledInviteIds: readonly ChatInviteId[];
  readonly messages: readonly ChatMessage[];
  /** Encrypted at rest. `ecashNotes` is never projected through ChatPayment. */
  readonly payments: readonly DurableChatPayment[];
  readonly outbox: readonly DurableChatOutboxEntry[];
}

export interface DurableChatPayment extends ChatPayment {
  readonly ecashNotes?: string;
}

export interface DurableChatGroupBinding {
  readonly conversationId: ConversationId;
  readonly groupId: string;
}

export interface DurableChatOutboxEntry {
  readonly messageId: ChatMessageId;
  readonly eventId: string;
  readonly eventJson: string;
}

export interface ChatStateStore {
  load(): Promise<DurableChatState | undefined>;
  save(state: DurableChatState): Promise<void>;
}

export interface CreateConversationInput {
  readonly title: string;
  readonly inviteAddress: string;
  readonly signal: AbortSignal;
}

export interface SendChatMessageInput {
  readonly conversationId: ConversationId;
  readonly text: string;
  readonly signal: AbortSignal;
}

export interface SendChatPaymentInput {
  readonly conversationId: ConversationId;
  readonly amountSats: number;
  readonly notes: ClearableSecretText;
  readonly operationKey: OperationKey;
  readonly signal: AbortSignal;
}

export interface PreparedChatPaymentClaim {
  readonly payment: ChatPayment;
  readonly notes: ClearableSecretText;
}

export interface ListChatMessagesInput {
  readonly conversationId: ConversationId;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}

/**
 * Framework-neutral product boundary. Implementations must never expose MDK,
 * OpenMLS, Nostr event, relay, KeyPackage, or Welcome values through this API.
 */
export interface ChatService {
  readonly kind: ChatServiceKind;
  readonly subscribe: (listener: ChatServiceListener) => () => void;
  readonly getSnapshot: () => ChatSnapshot;
  open(input: OpenChatInput): Promise<ChatAvailability>;
  initializeIdentity(signal: AbortSignal): Promise<ChatIdentitySummary>;
  createConversation(input: CreateConversationInput): Promise<ConversationId>;
  acceptInvite(id: ChatInviteId, signal: AbortSignal): Promise<ConversationId>;
  declineInvite(id: ChatInviteId, signal: AbortSignal): Promise<void>;
  sendMessage(input: SendChatMessageInput): Promise<ChatMessage>;
  retryMessage(id: ChatMessageId, signal: AbortSignal): Promise<ChatMessage>;
  sendPayment(input: SendChatPaymentInput): Promise<ChatPayment>;
  retryPayment(id: ChatMessageId, signal: AbortSignal): Promise<ChatPayment>;
  listPayments(
    conversationId: ConversationId,
    signal: AbortSignal,
  ): Promise<readonly ChatPayment[]>;
  preparePaymentClaim(
    id: ChatMessageId,
    signal: AbortSignal,
  ): Promise<PreparedChatPaymentClaim>;
  markPaymentClaimed(id: ChatMessageId, signal: AbortSignal): Promise<void>;
  leaveConversation(id: ConversationId, signal: AbortSignal): Promise<void>;
  synchronize(signal: AbortSignal): Promise<void>;
  listMessages(input: ListChatMessagesInput): Promise<ChatMessagePage>;
  /** Synchronously rejects new state-advancing operations. */
  quiesce(): void;
  /** Closes relay/runtime work and settles durable state. */
  stop(): Promise<void>;
  /** Removes access to secret-bearing key material after stop. */
  lock(): void;
  dispose(): Promise<void>;
}
