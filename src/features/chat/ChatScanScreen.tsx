import { useState } from 'react';

import { parseChatAddress } from '../../domain';
import { QrScanner } from '../shared/QrScanner';
import { useChat } from './chat-context';

export function ChatScanScreen() {
  const { navigate } = useChat();
  const [error, setError] = useState<string>();

  async function pasteAddress() {
    setError(undefined);
    if (navigator.clipboard === undefined) {
      navigate('chat-contacts');
      return;
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      const parsed = parseChatAddress(text);
      navigate('chat-invite-review', { contactAddress: parsed.address });
    } catch {
      setError('The clipboard did not contain a valid chat address.');
    }
  }

  function acceptAddress(value: string) {
    setError(undefined);
    try {
      const parsed = parseChatAddress(value.trim());
      navigate('chat-invite-review', { contactAddress: parsed.address });
    } catch {
      setError('The QR code did not contain a valid chat address.');
    }
  }

  return (
    <section className="chat-scan chat-dark" aria-labelledby="chat-scan-title">
      <div className="chat-dark-topbar chat-scan-topbar">
        <button
          className="chat-dark-icon"
          type="button"
          aria-label="Back to new chat"
          onClick={() => navigate('chat-contacts')}
        >
          <BackGlyph />
        </button>
        <h1 id="chat-scan-title" className="chat-scan-heading">
          Add contact
        </h1>
        <span className="chat-scan-spacer" aria-hidden="true" />
      </div>

      <div className="chat-scan-body">
        <p className="chat-scan-copy">
          Point at a contact&rsquo;s chat QR to add them securely.
        </p>
        <QrScanner variant="chat" onScan={acceptAddress} />
        {error !== undefined && (
          <p className="chat-scan-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="chat-setup-actions">
        <button
          className="chat-dark-primary"
          type="button"
          onClick={() => void pasteAddress()}
        >
          <PasteGlyph />
          Paste chat address
        </button>
        <button
          className="chat-dark-text"
          type="button"
          onClick={() => navigate('chat-contacts')}
        >
          Enter address manually
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

function PasteGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="5"
        y="4"
        width="14"
        height="17"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M9 4h6v3H9z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}
