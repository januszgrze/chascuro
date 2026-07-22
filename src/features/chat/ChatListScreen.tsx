import { useLayoutEffect, useState } from 'react';

import type { ConversationSummary } from '../../domain';
import { ScreenError } from '../shared/ScreenFrame';
import { useChat } from './chat-context';

const AVATAR_COLORS = [
  '#D9E3D5',
  '#EFE6CC',
  '#EADBCD',
  '#E1E0CE',
  '#ECDCD2',
  '#DDE1E6',
] as const;
const FOREGROUND_SYNC_INTERVAL_MS = 5_000;

export function ChatListScreen() {
  const { controller, state, navigate, exit } = useChat();
  const { snapshot, busy, error } = state;
  const [query, setQuery] = useState('');
  const syncing =
    busy.includes('synchronize') || snapshot.syncState === 'syncing';
  const degraded = snapshot.availability.status === 'degraded';
  const available = snapshot.availability.status === 'available';

  useLayoutEffect(() => {
    if (!available) return;
    const signal = new AbortController().signal;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scheduled = false;
    const synchronize = (): void => {
      if (stopped || scheduled || document.visibilityState === 'hidden') return;
      scheduled = true;
      void controller
        .synchronize(signal)
        .catch(() => undefined)
        .finally(() => {
          scheduled = false;
          if (!stopped) {
            timer = setTimeout(synchronize, FOREGROUND_SYNC_INTERVAL_MS);
          }
        });
    };
    const resume = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      synchronize();
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') resume();
    };
    synchronize();
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [available, controller]);

  if (snapshot.availability.status === 'setup_required') {
    return (
      <section className="chat-shell" aria-labelledby="chat-list-title">
        <ChatListTopbar onExit={exit} />
        <h1 id="chat-list-title" className="page-title">
          Chats
        </h1>
        <div className="chat-setup-prompt">
          <p className="chat-setup-prompt-copy">
            Set up your chat identity to start sending encrypted messages.
          </p>
          <button
            className="chat-new"
            type="button"
            onClick={() => navigate('chat-setup')}
          >
            Set up chat
          </button>
        </div>
      </section>
    );
  }

  const retry =
    available &&
    (snapshot.syncState === 'offline' || snapshot.syncState === 'error')
      ? () => {
          void controller
            .synchronize(new AbortController().signal)
            .catch(() => undefined);
        }
      : undefined;

  const normalizedQuery = query.trim().toLowerCase();
  const conversations =
    normalizedQuery === ''
      ? snapshot.conversations
      : snapshot.conversations.filter(
          (conversation) =>
            conversation.title.toLowerCase().includes(normalizedQuery) ||
            (conversation.lastMessagePreview
              ?.toLowerCase()
              .includes(normalizedQuery) ??
              false),
        );

  if (
    available &&
    snapshot.conversations.length === 0 &&
    snapshot.pendingInvites.length === 0 &&
    normalizedQuery === ''
  ) {
    return (
      <ChatsEmptyState
        onExit={exit}
        onStart={() => navigate('chat-contacts')}
      />
    );
  }

  return (
    <section
      className="chat-shell"
      aria-labelledby="chat-list-title"
      aria-busy={syncing}
    >
      <ChatListTopbar onExit={exit} />
      <h1 id="chat-list-title" className="page-title">
        Chats
      </h1>

      {available && (
        <label className="chat-search">
          <SearchGlyph />
          <input
            type="search"
            className="chat-search-input"
            placeholder="Search chats"
            aria-label="Search chats"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}

      <ChatSyncStatus
        degraded={degraded}
        syncing={syncing}
        syncState={snapshot.syncState}
        onRetry={retry}
      />

      {degraded && (
        <div className="notice" role="alert">
          <strong>Chat is unavailable.</strong>
          <p>
            {snapshot.availability.status === 'degraded' &&
            snapshot.availability.retryable
              ? 'A temporary problem interrupted chat. Try again in a moment.'
              : 'Chat storage could not be opened on this device.'}
          </p>
        </div>
      )}

      {snapshot.pendingInvites.length > 0 && (
        <div className="chat-section">
          <div className="chat-section-head">
            <span className="chat-section-title">Pending invites</span>
            <span className="chat-badge">{snapshot.pendingInvites.length}</span>
          </div>
          <ul className="chat-conversation-list">
            {snapshot.pendingInvites.map((invite) => (
              <li key={invite.id}>
                <button
                  className="chat-row chat-row-button"
                  type="button"
                  onClick={() =>
                    navigate('chat-invite-review', { inviteId: invite.id })
                  }
                >
                  <span
                    className="chat-avatar"
                    style={{ backgroundColor: avatarColor(invite.id) }}
                    aria-hidden="true"
                  >
                    {initials(invite.title)}
                  </span>
                  <span className="chat-row-info">
                    <span className="chat-row-title">{invite.title}</span>
                    <span className="chat-row-subtitle is-muted">
                      Invite from {invite.inviterLabel}
                    </span>
                  </span>
                  <ChevronGlyph />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ScreenError message={error?.message} />

      {conversations.length === 0 ? (
        <p className="home-empty">
          {snapshot.conversations.length === 0
            ? 'No conversations yet.'
            : `No chats match “${query.trim()}”.`}
        </p>
      ) : (
        <ul className="chat-conversation-list">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                className="chat-row chat-row-button"
                type="button"
                onClick={() =>
                  navigate('chat-conversation', {
                    conversationId: conversation.id,
                  })
                }
              >
                <span
                  className="chat-avatar"
                  style={{ backgroundColor: avatarColor(conversation.id) }}
                  aria-hidden="true"
                >
                  {initials(conversation.title)}
                </span>
                <span className="chat-row-info">
                  <span className="chat-row-title">{conversation.title}</span>
                  <ConversationPreview conversation={conversation} />
                </span>
                <span className="chat-row-meta">
                  {conversation.lastMessageAtMs !== undefined && (
                    <span
                      className={`chat-row-time${
                        conversation.unreadCount > 0 ? ' is-attention' : ''
                      }`}
                    >
                      {formatRelativeTime(conversation.lastMessageAtMs)}
                    </span>
                  )}
                  {conversation.unreadCount > 0 && (
                    <span className="chat-unread-dot" aria-hidden="true" />
                  )}
                  {conversation.unreadCount > 0 && (
                    <span className="visually-hidden">
                      {conversation.unreadCount} unread
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        className="chat-new"
        type="button"
        disabled={degraded}
        onClick={() => navigate('chat-contacts')}
      >
        <PlusGlyph />
        New chat
      </button>
    </section>
  );
}

function ChatsEmptyState({
  onExit,
  onStart,
}: {
  onExit: () => void;
  onStart: () => void;
}) {
  return (
    <section className="chat-shell" aria-labelledby="chat-list-title">
      <ChatListTopbar onExit={onExit} />
      <h1 id="chat-list-title" className="page-title">
        Chats
      </h1>
      <div className="chat-empty">
        <div className="chat-empty-art" aria-hidden="true">
          <span className="chat-empty-tile">
            <BubbleGlyph />
          </span>
          <span className="chat-empty-badge">₿</span>
        </div>
        <div className="chat-empty-copy">
          <h2 className="chat-empty-title">No chats yet</h2>
          <p className="chat-empty-text">
            Private, end-to-end messages with payments built in. Start a
            conversation to send or request money.
          </p>
        </div>
      </div>
      <button className="chat-new" type="button" onClick={onStart}>
        <PlusGlyph />
        Start a chat
      </button>
    </section>
  );
}

function BubbleGlyph() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6a8.5 8.5 0 0 1-.9-3.9A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatListTopbar({ onExit }: { onExit: () => void }) {
  return (
    <div className="page-topbar chat-topbar">
      <button
        className="home-icon-btn"
        type="button"
        aria-label="Back to wallet"
        onClick={onExit}
      >
        <WalletGlyph />
      </button>
    </div>
  );
}

function ChatSyncStatus({
  degraded,
  syncing,
  syncState,
  onRetry,
}: {
  degraded: boolean;
  syncing: boolean;
  syncState: 'idle' | 'syncing' | 'offline' | 'error';
  onRetry?: () => void;
}) {
  if (degraded) {
    return (
      <p className="chat-sync-status" role="status" aria-live="polite">
        Chat unavailable
      </p>
    );
  }
  if (syncing) {
    return (
      <p className="chat-sync-status" role="status" aria-live="polite">
        Syncing…
      </p>
    );
  }
  if (syncState === 'offline' || syncState === 'error') {
    const label =
      syncState === 'offline'
        ? 'Offline — messages send when you reconnect'
        : 'Could not sync';
    return (
      <p className="chat-sync-status is-alert" role="status" aria-live="polite">
        {label}
        {onRetry !== undefined && (
          <button className="chat-sync-retry" type="button" onClick={onRetry}>
            Retry
          </button>
        )}
      </p>
    );
  }
  return null;
}

function ConversationPreview({
  conversation,
}: {
  conversation: ConversationSummary;
}) {
  if (conversation.removed) {
    return (
      <span className="chat-row-subtitle is-muted">
        You left this conversation
      </span>
    );
  }
  if (conversation.lastMessagePreview !== undefined) {
    const own = conversation.lastMessageDirection === 'outgoing';
    return (
      <span className={`chat-row-subtitle${own ? ' is-own' : ' is-muted'}`}>
        {own
          ? `You: ${conversation.lastMessagePreview}`
          : conversation.lastMessagePreview}
      </span>
    );
  }
  return (
    <span className="chat-row-subtitle is-muted">
      {conversation.memberCount > 2
        ? `${conversation.memberCount} members`
        : 'Direct message'}
    </span>
  );
}

function avatarColor(id: string): string {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function initials(title: string): string {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]!.charAt(0);
  const second = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + second).toUpperCase();
}

function formatRelativeTime(atMs: number): string {
  const deltaMs = Date.now() - atMs;
  if (deltaMs < 60_000) return 'now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return new Date(atMs).toLocaleDateString(undefined, { weekday: 'short' });
  }
  return new Date(atMs).toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
  });
}

function WalletGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1h1a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        fill="none"
        stroke="var(--color-accent-ink)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16.5" cy="12.5" r="1.3" fill="var(--color-accent-ink)" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg
      className="chat-search-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        cx="11"
        cy="11"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 21l-4.3-4.3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg
      className="chat-row-chevron"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M9 6l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
