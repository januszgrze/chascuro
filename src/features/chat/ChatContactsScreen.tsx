import { useState } from 'react';

import { useChat } from './chat-context';

export function ChatContactsScreen() {
  const { navigate } = useChat();
  const [query, setQuery] = useState('');
  const canStart = query.trim().length > 0;

  function startChat() {
    if (query.trim().length > 0) {
      navigate('chat-invite-review', { contactAddress: query.trim() });
    }
  }

  return (
    <section className="chat-shell" aria-labelledby="chat-contacts-title">
      <div className="page-topbar chat-topbar">
        <button
          className="home-icon-btn"
          type="button"
          aria-label="Back to chats"
          onClick={() => navigate('chat-list')}
        >
          <WalletGlyph />
        </button>
      </div>
      <h1 id="chat-contacts-title" className="page-title">
        New chat
      </h1>

      <label className="chat-search chat-search--spaced">
        <SearchGlyph />
        <input
          type="search"
          className="chat-search-input"
          placeholder="Search a name or paste an invite"
          aria-label="Search a name or paste an invite"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="chat-action-list">
        <button
          className="chat-action-row"
          type="button"
          onClick={() => navigate('chat-scan')}
        >
          <span className="chat-action-icon" aria-hidden="true">
            <ScanGlyph />
          </span>
          <span className="chat-action-info">
            <span className="chat-action-title">Scan a QR code</span>
            <span className="chat-action-sub">
              Connect in person, instantly
            </span>
          </span>
          <ChevronGlyph />
        </button>
        <button
          className="chat-action-row"
          type="button"
          onClick={() => navigate('chat-setup')}
        >
          <span className="chat-action-icon" aria-hidden="true">
            <ShareGlyph />
          </span>
          <span className="chat-action-info">
            <span className="chat-action-title">Share your invite</span>
            <span className="chat-action-sub">Send a link they can open</span>
          </span>
          <ChevronGlyph />
        </button>
      </div>

      <div className="chat-recent-head">
        <span className="chat-section-title">Recent</span>
      </div>
      <p className="home-empty">
        Saved contacts are not available yet. Paste or scan a chat address to
        start a conversation.
      </p>

      <button
        className="chat-new"
        type="button"
        disabled={!canStart}
        onClick={startChat}
      >
        <PlusGlyph />
        Start a chat
      </button>
    </section>
  );
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

function ScanGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"
        fill="none"
        stroke="var(--color-accent-ink)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ShareGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="18"
        cy="5"
        r="3"
        fill="none"
        stroke="var(--color-accent-ink)"
        strokeWidth={2}
      />
      <circle
        cx="6"
        cy="12"
        r="3"
        fill="none"
        stroke="var(--color-accent-ink)"
        strokeWidth={2}
      />
      <circle
        cx="18"
        cy="19"
        r="3"
        fill="none"
        stroke="var(--color-accent-ink)"
        strokeWidth={2}
      />
      <path
        d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"
        fill="none"
        stroke="var(--color-accent-ink)"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg
      className="chat-action-chevron"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M9 6l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
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
