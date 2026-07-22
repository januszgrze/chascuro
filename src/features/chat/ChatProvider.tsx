import { useSyncExternalStore, type ReactNode } from 'react';

import type { ChatController } from '../../services/chat/chat-controller';
import {
  ChatContext,
  type ChatContextValue,
  type ChatWalletPaymentBridge,
} from './chat-context';
import { resolveChatLocation, type ChatLocation } from './chat-route';

export interface ChatProviderProps {
  readonly controller: ChatController;
  readonly location: ChatLocation;
  readonly onNavigate: (location: ChatLocation) => void;
  readonly onExit: () => void;
  readonly walletPayments?: ChatWalletPaymentBridge;
  readonly children: ReactNode;
}

export function ChatProvider({
  controller,
  location,
  onNavigate,
  onExit,
  walletPayments,
  children,
}: ChatProviderProps) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const value: ChatContextValue = {
    controller,
    state,
    location: resolveChatLocation(location),
    walletPayments,
    navigate: (route, options) =>
      onNavigate({
        route,
        selectedConversationId: options?.conversationId,
        selectedInviteId: options?.inviteId,
        pendingContactAddress: options?.contactAddress,
        pendingContactLabel: options?.contactLabel,
      }),
    exit: onExit,
  };
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
