import { useState } from 'react';

import { ScreenError } from '../shared/ScreenFrame';
import { useChat } from './chat-context';

export function ChatDetailsScreen() {
  const { controller, state, location, navigate } = useChat();
  const [confirmed, setConfirmed] = useState(false);
  const conversation = state.snapshot.conversations.find(
    ({ id }) => id === location.selectedConversationId,
  );

  if (conversation === undefined) {
    return (
      <section className="chat-shell" aria-labelledby="chat-details-title">
        <DetailsTopbar onBack={() => navigate('chat-list')} />
        <h1 id="chat-details-title" className="page-title">
          Conversation unavailable
        </h1>
      </section>
    );
  }

  const leaving = state.busy.includes(`leave:${conversation.id}`);
  return (
    <section className="chat-shell" aria-labelledby="chat-details-title">
      <DetailsTopbar
        onBack={() =>
          navigate('chat-conversation', { conversationId: conversation.id })
        }
      />
      <h1 id="chat-details-title" className="page-title">
        {conversation.title}
      </h1>
      <div className="chat-details-card">
        <span className="chat-chip-label">Members</span>
        <strong>{conversation.memberCount}</strong>
        <span className="chat-chip-label">State</span>
        <span>{conversation.removed ? 'You left this group' : 'Active'}</span>
      </div>
      {!conversation.removed && (
        <div className="chat-danger-zone">
          <h2>Leave conversation</h2>
          <p>
            Saved history remains on this device, but you will no longer be able
            to send messages to this group.
          </p>
          <label className="chat-consent chat-light-consent">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={leaving}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>I understand I cannot undo leaving from this device.</span>
          </label>
          <ScreenError message={state.error?.message} />
          <button
            className="danger-button"
            type="button"
            disabled={!confirmed || leaving}
            onClick={() => {
              void controller
                .leaveConversation(
                  conversation.id,
                  new AbortController().signal,
                )
                .then(() => navigate('chat-list'))
                .catch(() => undefined);
            }}
          >
            {leaving ? 'Leaving…' : 'Leave conversation'}
          </button>
        </div>
      )}
    </section>
  );
}

function DetailsTopbar({ onBack }: { onBack: () => void }) {
  return (
    <div className="page-topbar">
      <button
        className="home-icon-btn"
        type="button"
        aria-label="Back to conversation"
        onClick={onBack}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M15 19l-7-7 7-7"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
