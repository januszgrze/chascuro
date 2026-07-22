import { useMemo } from 'react';

import { parseChatAddress, type ParsedChatAddress } from '../../domain';
import { ScreenError } from '../shared/ScreenFrame';
import { useChat } from './chat-context';

export function ChatInviteReviewScreen() {
  const { controller, state, location, navigate } = useChat();

  const pendingContact = useMemo<ParsedChatAddress | undefined>(() => {
    if (location.pendingContactAddress === undefined) return undefined;
    try {
      return parseChatAddress(location.pendingContactAddress);
    } catch {
      return undefined;
    }
  }, [location.pendingContactAddress]);

  const invite = state.snapshot.pendingInvites.find(
    ({ id }) => id === location.selectedInviteId,
  );

  if (pendingContact === undefined && invite === undefined) {
    return (
      <section className="chat-shell" aria-labelledby="chat-invite-title">
        <ReviewTopbar
          title="Review contact"
          onBack={() => navigate('chat-list')}
        />
        <p className="home-empty">This contact is no longer available.</p>
      </section>
    );
  }

  if (pendingContact !== undefined) {
    const label = location.pendingContactLabel?.trim();
    const name = label && label.length > 0 ? label : 'New contact';
    const creating = state.busy.includes('create-conversation');
    return (
      <ReviewLayout
        title="Review contact"
        name={name}
        address={pendingContact.address}
        fingerprint={pendingContact.fingerprint}
        relayLabel={formatRelayLabel(state.snapshot.relayEndpoints)}
        note={`Compare this with ${name} over a call or in person before you continue.`}
        error={state.error?.message}
        onBack={() => navigate('chat-contacts')}
        primaryLabel={creating ? 'Creating invite…' : 'Create invite'}
        primaryBusy={creating}
        onPrimary={() => {
          const title =
            label && label.length > 0 ? label : 'Encrypted conversation';
          void controller
            .createConversation(
              title,
              pendingContact.address,
              new AbortController().signal,
            )
            .then((conversationId) =>
              navigate('chat-conversation', { conversationId }),
            )
            .catch(() => undefined);
        }}
        onDecline={() => navigate('chat-contacts')}
      />
    );
  }

  const activeInvite = invite!;
  const accepting = state.busy.includes(`accept:${activeInvite.id}`);
  const declining = state.busy.includes(`decline:${activeInvite.id}`);
  return (
    <ReviewLayout
      title="Review invite"
      name={activeInvite.inviterLabel}
      subtitle={activeInvite.title}
      note="Accepting joins the encrypted group on this device. Chat still has no backup or recovery."
      relayLabel={formatRelayLabel(state.snapshot.relayEndpoints)}
      error={state.error?.message}
      onBack={() => navigate('chat-list')}
      primaryLabel={accepting ? 'Joining…' : 'Accept invite'}
      primaryBusy={accepting || declining}
      onPrimary={() => {
        void controller
          .acceptInvite(activeInvite.id, new AbortController().signal)
          .then((conversationId) =>
            navigate('chat-conversation', { conversationId }),
          )
          .catch(() => undefined);
      }}
      declineBusy={accepting || declining}
      declineLabel={declining ? 'Declining…' : 'Decline'}
      onDecline={() => {
        void controller
          .declineInvite(activeInvite.id, new AbortController().signal)
          .then(() => navigate('chat-list'))
          .catch(() => undefined);
      }}
    />
  );
}

interface ReviewLayoutProps {
  readonly title: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly address?: string;
  readonly fingerprint?: string;
  readonly relayLabel?: string;
  readonly note: string;
  readonly error?: string;
  readonly onBack: () => void;
  readonly primaryLabel: string;
  readonly primaryBusy: boolean;
  readonly onPrimary: () => void;
  readonly declineLabel?: string;
  readonly declineBusy?: boolean;
  readonly onDecline: () => void;
}

function ReviewLayout({
  title,
  name,
  subtitle,
  address,
  fingerprint,
  relayLabel,
  note,
  error,
  onBack,
  primaryLabel,
  primaryBusy,
  onPrimary,
  declineLabel = 'Decline',
  declineBusy = false,
  onDecline,
}: ReviewLayoutProps) {
  return (
    <section
      className="chat-shell chat-review"
      aria-labelledby="chat-invite-title"
    >
      <ReviewTopbar title={title} onBack={onBack} />

      <div className="chat-review-identity">
        <span className="chat-review-avatar" aria-hidden="true">
          {initials(name)}
        </span>
        <div className="chat-review-name-group">
          <span className="chat-review-name">{name}</span>
          {address !== undefined && (
            <span className="chat-review-address chat-mono">
              {truncateAddress(address)}
            </span>
          )}
          {subtitle !== undefined && (
            <span className="chat-review-address">{subtitle}</span>
          )}
        </div>
      </div>

      <div className="chat-review-card" role="group" aria-label="Verification">
        {fingerprint !== undefined && (
          <div className="chat-review-fp-head">
            <FingerprintGlyph />
            <span className="chat-chip-label">Verification fingerprint</span>
          </div>
        )}
        {fingerprint !== undefined && (
          <strong className="chat-mono chat-fingerprint chat-review-fp">
            {fingerprint}
          </strong>
        )}
        <p className="chat-review-note">{note}</p>
      </div>

      {relayLabel !== undefined && (
        <p className="chat-review-relay">
          <GlobeGlyph />
          {relayLabel}
        </p>
      )}

      <ScreenError message={error} />

      <div className="chat-review-actions">
        <button
          className="cta-pill chat-review-primary"
          type="button"
          disabled={primaryBusy}
          onClick={onPrimary}
        >
          <CheckGlyph />
          {primaryLabel}
        </button>
        <button
          className="secondary-button chat-review-decline"
          type="button"
          disabled={declineBusy}
          onClick={onDecline}
        >
          {declineLabel}
        </button>
      </div>
    </section>
  );
}

function formatRelayLabel(endpoints: readonly string[]): string | undefined {
  if (endpoints.length === 0) return undefined;
  const first = endpoints[0]!;
  const suffix = endpoints.length > 1 ? ` +${endpoints.length - 1}` : '';
  try {
    const url = new URL(first);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}${suffix}`;
  } catch {
    return `${first}${suffix}`;
  }
}

function ReviewTopbar({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <div className="page-topbar chat-review-topbar">
      <button
        className="home-icon-btn"
        type="button"
        aria-label="Back"
        onClick={onBack}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M15 19l-7-7 7-7"
            fill="none"
            stroke="var(--color-accent-ink)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <h1 id="chat-invite-title" className="chat-review-heading">
        {title}
      </h1>
      <span className="chat-review-spacer" aria-hidden="true" />
    </div>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]!.charAt(0);
  const second = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + second).toUpperCase();
}

function truncateAddress(address: string): string {
  if (address.length <= 22) return address;
  return `${address.slice(0, 12)}…${address.slice(-8)}`;
}

function FingerprintGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3a9 9 0 0 1 9 9v3a4 4 0 0 1-4 4M12 3a9 9 0 0 0-9 9v6M8 12a4 4 0 0 1 8 0v4a3 3 0 0 0 3 3M12 12v5a3 3 0 0 1-3 3"
        fill="none"
        stroke="var(--color-accent-ink)"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GlobeGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="var(--color-muted)"
        strokeWidth={1.8}
      />
      <path
        d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"
        fill="none"
        stroke="var(--color-muted)"
        strokeWidth={1.8}
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 12l5 5L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
