import { useState } from 'react';

import type { ChatIdentitySummary } from '../../domain';
import { QrCode } from '../shared/QrCode';
import { ScreenError } from '../shared/ScreenFrame';
import { shareText } from '../shared/share';
import { useChat } from './chat-context';

export function ChatSetupScreen() {
  const { state, controller, navigate, exit } = useChat();
  const { availability } = state.snapshot;
  const creating = state.busy.includes('identity');

  if (availability.status === 'available') {
    return <AvailableIdentity identity={availability.identity} />;
  }

  return (
    <section
      className="chat-setup chat-dark"
      aria-labelledby="chat-setup-title"
    >
      <div className="chat-dark-topbar">
        <button
          className="chat-dark-icon"
          type="button"
          aria-label="Back to wallet"
          onClick={exit}
        >
          <BackGlyph />
        </button>
      </div>
      <div className="chat-setup-intro">
        <h1 id="chat-setup-title" className="chat-dark-title">
          Set up chat
        </h1>
        <p className="chat-dark-subtitle">
          Chat gives you an identity separate from your wallet balance. Messages
          are end-to-end encrypted and stored only on this device.
        </p>
      </div>
      <div className="chat-warning" role="note">
        <strong>No backup yet</strong>
        <p>
          Chat lives only on this phone. Lose it or delete the app and these
          messages are gone for good.
        </p>
      </div>
      <ScreenError message={state.error?.message} />
      <div className="chat-setup-actions">
        <ConsentAndCreate
          creating={creating}
          disabled={availability.status === 'degraded'}
          onCreate={() => {
            const signal = new AbortController().signal;
            void controller.initializeIdentity(signal).catch(() => undefined);
          }}
        />
        <button
          className="chat-dark-secondary"
          type="button"
          onClick={() => navigate('chat-list')}
        >
          Not now
        </button>
      </div>
    </section>
  );
}

function ConsentAndCreate({
  creating,
  disabled,
  onCreate,
}: {
  creating: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  const [consented, setConsented] = useState(false);
  return (
    <>
      <label className="chat-consent">
        <input
          type="checkbox"
          checked={consented}
          disabled={creating || disabled}
          onChange={(event) => setConsented(event.target.checked)}
        />
        <span>
          I understand chat is experimental and has no backup or recovery yet.
        </span>
      </label>
      <button
        className="chat-dark-primary"
        type="button"
        disabled={!consented || creating || disabled}
        onClick={onCreate}
      >
        {creating ? 'Creating identity…' : 'Create chat identity'}
      </button>
    </>
  );
}

function AvailableIdentity({ identity }: { identity: ChatIdentitySummary }) {
  const { navigate } = useChat();
  const [copyStatus, setCopyStatus] = useState<string>();

  async function copyAddress() {
    if (navigator.clipboard === undefined) return;
    try {
      await navigator.clipboard.writeText(identity.address);
      setCopyStatus('Address copied');
    } catch {
      setCopyStatus('Could not copy address');
    }
  }

  return (
    <section
      className="chat-setup chat-dark"
      aria-labelledby="chat-setup-title"
    >
      <div className="chat-dark-topbar">
        <button
          className="chat-dark-icon"
          type="button"
          aria-label="Back to chats"
          onClick={() => navigate('chat-list')}
        >
          <BackGlyph />
        </button>
      </div>
      <div className="chat-setup-intro">
        <h1 id="chat-setup-title" className="chat-dark-title">
          Your chat address
        </h1>
        <p className="chat-dark-subtitle">
          Share this so people can start an encrypted chat with you. It never
          carries your wallet balance.
        </p>
      </div>
      <div className="chat-qr">
        <div className="qr-card chat-qr-card">
          <QrCode value={identity.address} label="Your chat address QR code" />
        </div>
        <div className="chat-detail-chip">
          <div className="chat-chip-text">
            <span className="chat-chip-label">Public address</span>
            <span className="chat-chip-value chat-mono">
              {identity.address}
            </span>
          </div>
          <button
            className="chat-chip-action"
            type="button"
            aria-label="Copy chat address"
            onClick={() => void copyAddress()}
          >
            <CopyGlyph />
          </button>
        </div>
        <div className="chat-detail-chip">
          <div className="chat-chip-text">
            <span className="chat-chip-label">Verification fingerprint</span>
            <span className="chat-chip-value chat-mono chat-fingerprint">
              {identity.fingerprint}
            </span>
          </div>
        </div>
        <p className="visually-hidden" aria-live="polite">
          {copyStatus}
        </p>
      </div>
      <div className="chat-setup-actions">
        <button
          className="chat-dark-primary"
          type="button"
          onClick={() =>
            void shareText(identity.address, {
              title: 'My chat address',
            }).catch(() => undefined)
          }
        >
          <ShareGlyph />
          Share address
        </button>
        <button
          className="chat-dark-secondary"
          type="button"
          onClick={() => navigate('chat-contacts')}
        >
          Scan a contact
        </button>
      </div>
    </section>
  );
}

function BackGlyph() {
  return (
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
  );
}

function CopyGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="9"
        y="9"
        width="11"
        height="11"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M5 15V6a2 2 0 0 1 2-2h9"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

function ShareGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="18"
        cy="5"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <circle
        cx="6"
        cy="12"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <circle
        cx="18"
        cy="19"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}
