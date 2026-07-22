import type { ChatInviteId, ConversationId } from '../../domain';

export type ChatRoute =
  | 'chat-list'
  | 'chat-setup'
  | 'chat-contacts'
  | 'chat-scan'
  | 'chat-invite-review'
  | 'chat-conversation'
  | 'chat-details';

/**
 * In-memory chat location. Conversation identifiers live here and never enter
 * the URL or browser history.
 */
export interface ChatLocation {
  readonly route: ChatRoute;
  readonly selectedConversationId?: ConversationId;
  readonly selectedInviteId?: ChatInviteId;
  readonly pendingContactAddress?: string;
  readonly pendingContactLabel?: string;
}

export const INITIAL_CHAT_LOCATION: ChatLocation = Object.freeze({
  route: 'chat-list',
});

const ROUTES_REQUIRING_CONVERSATION: ReadonlySet<ChatRoute> = new Set([
  'chat-conversation',
  'chat-details',
]);

/**
 * Normalizes a requested location so a route that needs a selected conversation
 * or contact can never render without one. Falls back to the conversation list.
 */
export function resolveChatLocation(location: ChatLocation): ChatLocation {
  if (
    ROUTES_REQUIRING_CONVERSATION.has(location.route) &&
    location.selectedConversationId === undefined
  ) {
    return INITIAL_CHAT_LOCATION;
  }
  if (
    location.route === 'chat-invite-review' &&
    location.selectedInviteId === undefined &&
    location.pendingContactAddress === undefined
  ) {
    return INITIAL_CHAT_LOCATION;
  }
  return location;
}
