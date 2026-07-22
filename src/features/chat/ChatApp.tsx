import { ChatContactsScreen } from './ChatContactsScreen';
import { ChatDetailsScreen } from './ChatDetailsScreen';
import { ChatInviteReviewScreen } from './ChatInviteReviewScreen';
import { ChatListScreen } from './ChatListScreen';
import { ChatScanScreen } from './ChatScanScreen';
import { ConversationScreen } from './ConversationScreen';
import { ChatSetupScreen } from './ChatSetupScreen';
import { useChat } from './chat-context';

export function ChatApp() {
  const { location } = useChat();

  switch (location.route) {
    case 'chat-setup':
      return <ChatSetupScreen />;
    case 'chat-contacts':
      return <ChatContactsScreen />;
    case 'chat-scan':
      return <ChatScanScreen />;
    case 'chat-invite-review':
      return <ChatInviteReviewScreen />;
    case 'chat-conversation':
      return (
        <ConversationScreen
          key={location.selectedConversationId ?? 'missing'}
        />
      );
    case 'chat-details':
      return <ChatDetailsScreen />;
    case 'chat-list':
      return <ChatListScreen />;
  }
}
