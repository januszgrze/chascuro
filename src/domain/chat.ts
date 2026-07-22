import type { ChatErrorCode } from './chat-error';
import type { OperationKey } from './operation';
import type { EcashExport } from './payments';

declare const conversationIdBrand: unique symbol;
declare const chatMessageIdBrand: unique symbol;
declare const chatInviteIdBrand: unique symbol;
declare const chatCursorBrand: unique symbol;

export type ConversationId = string & {
  readonly [conversationIdBrand]: true;
};
export type ChatMessageId = string & { readonly [chatMessageIdBrand]: true };
export type ChatInviteId = string & { readonly [chatInviteIdBrand]: true };
export type ChatCursor = string & { readonly [chatCursorBrand]: true };

export type ChatCapability =
  'text' | 'groups' | 'invites' | 'offline-outbox' | 'ecash-payments';
export type ChatDeliveryState = 'pending' | 'published' | 'failed' | 'received';
export type ChatSyncState = 'idle' | 'syncing' | 'offline' | 'error';
export const MAX_CHAT_PAYMENT_SATS = 2_100_000_000_000_000;
export type ChatPaymentStatus = 'pending' | 'claimable' | 'claimed' | 'failed';

export interface ChatIdentitySummary {
  readonly address: string;
  readonly fingerprint: string;
}

export type ChatAvailability =
  | { readonly status: 'disabled' }
  | { readonly status: 'setup_required' }
  | {
      readonly status: 'available';
      readonly identity: ChatIdentitySummary;
      readonly capabilities: readonly ChatCapability[];
    }
  | {
      readonly status: 'degraded';
      readonly reason: ChatErrorCode;
      readonly retryable: boolean;
    };

export interface ConversationSummary {
  readonly id: ConversationId;
  readonly title: string;
  readonly memberCount: number;
  readonly unreadCount: number;
  readonly lastMessageAtMs?: number;
  readonly lastMessagePreview?: string;
  readonly lastMessageDirection?: 'incoming' | 'outgoing';
  readonly removed: boolean;
}

export interface ChatMessage {
  readonly id: ChatMessageId;
  readonly conversationId: ConversationId;
  readonly direction: 'incoming' | 'outgoing';
  readonly text: string;
  readonly sentAtMs: number;
  readonly delivery: ChatDeliveryState;
}

/** Sanitized payment metadata. Bearer ecash notes never cross this boundary. */
export interface ChatPayment {
  readonly id: ChatMessageId;
  readonly conversationId: ConversationId;
  readonly direction: 'incoming' | 'outgoing';
  readonly amountSats: number;
  readonly sentAtMs: number;
  readonly status: ChatPaymentStatus;
  /** Local wallet operation used to derive sender settlement. */
  readonly operationKey?: OperationKey;
}

export type ChatPaymentSendOutcome =
  | { readonly kind: 'sent'; readonly payment: ChatPayment }
  | { readonly kind: 'recovery_required'; readonly export: EcashExport };

export interface PendingChatInvite {
  readonly id: ChatInviteId;
  readonly title: string;
  readonly inviterLabel: string;
  readonly receivedAtMs: number;
}

export interface ChatSnapshot {
  readonly availability: ChatAvailability;
  readonly relayEndpoints: readonly string[];
  readonly conversations: readonly ConversationSummary[];
  readonly pendingInvites: readonly PendingChatInvite[];
  readonly syncState: ChatSyncState;
}

export interface ChatMessagePage {
  readonly messages: readonly ChatMessage[];
  readonly nextCursor?: ChatCursor;
}

export function conversationId(value: string): ConversationId {
  return opaqueChatId(value, 'conversation ID') as ConversationId;
}

export function chatMessageId(value: string): ChatMessageId {
  return opaqueChatId(value, 'message ID') as ChatMessageId;
}

export function chatInviteId(value: string): ChatInviteId {
  return opaqueChatId(value, 'invite ID') as ChatInviteId;
}

export function chatCursor(value: string): ChatCursor {
  return opaqueChatId(value, 'cursor') as ChatCursor;
}

export function sanitizeChatText(
  value: string,
  maximumLength = 16_384,
): string {
  const normalized = value.normalize('NFC');
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    hasDisallowedControlCharacter(normalized)
  ) {
    throw new TypeError('Chat text is invalid.');
  }
  return normalized;
}

function hasDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 127 ||
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13)
    ) {
      return true;
    }
  }
  return false;
}

function opaqueChatId(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)
  ) {
    throw new TypeError(`The ${label} is invalid.`);
  }
  return value;
}
