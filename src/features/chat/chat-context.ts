import { createContext, useContext } from 'react';

import type {
  ChatInviteId,
  ChatMessageId,
  ChatPaymentSendOutcome,
  ConversationId,
  WalletOperation,
} from '../../domain';
import type {
  ChatController,
  ChatControllerState,
} from '../../services/chat/chat-controller';
import type { ChatLocation, ChatRoute } from './chat-route';

export interface ChatContextValue {
  readonly controller: ChatController;
  readonly state: ChatControllerState;
  readonly location: ChatLocation;
  readonly walletPayments?: ChatWalletPaymentBridge;
  navigate(
    route: ChatRoute,
    options?: {
      conversationId?: ConversationId;
      inviteId?: ChatInviteId;
      contactAddress?: string;
      contactLabel?: string;
    },
  ): void;
  exit(): void;
}

export type ChatPaymentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export interface ChatWalletPaymentBridge {
  readonly operations: readonly WalletOperation[];
  send(
    conversationId: ConversationId,
    amountSats: string,
  ): Promise<ChatPaymentResult<ChatPaymentSendOutcome>>;
  claim(paymentId: ChatMessageId): Promise<ChatPaymentResult<void>>;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext);
  if (value === null) {
    throw new Error('useChat must be used within a ChatProvider.');
  }
  return value;
}
