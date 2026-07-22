import type { ReactNode } from 'react';

import type { ClearableSecretText } from '../../domain';
import { BitcoinMark } from '../shared/BitcoinMark';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ShareIcon,
} from '../shared/icons';
import { ScreenError } from '../shared/ScreenFrame';
import { shareText } from '../shared/share';
import type { PaymentDirection, PaymentRail } from '../shared/SendReceiveShell';

export function ClockGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M12 7v5l3 2"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WalletDock({
  active,
  onNavigate,
  onHome,
}: {
  active: PaymentDirection;
  onNavigate(rail: PaymentRail, direction: PaymentDirection): void;
  onHome(): void;
}) {
  return (
    <nav className="wallet-dock" aria-label="Wallet navigation">
      <button
        className="wallet-dock-btn wallet-dock-home"
        type="button"
        aria-label="Wallet home"
        onClick={onHome}
      >
        <BitcoinMark />
      </button>
      <button
        className={`wallet-dock-btn${active === 'send' ? ' is-active' : ''}`}
        type="button"
        aria-pressed={active === 'send'}
        aria-label="Send"
        onClick={() => onNavigate('lightning', 'send')}
      >
        <ArrowUpIcon />
      </button>
      <button
        className={`wallet-dock-btn${active === 'receive' ? ' is-active' : ''}`}
        type="button"
        aria-pressed={active === 'receive'}
        aria-label="Receive"
        onClick={() => onNavigate('ecash', 'receive')}
      >
        <ArrowDownIcon />
      </button>
    </nav>
  );
}

export function ResultScreen({
  titleId,
  tone,
  direction,
  title,
  amountSats,
  subtitle,
  onBack,
  error,
  children,
}: {
  titleId: string;
  tone: 'success' | 'pending';
  direction: 'in' | 'out';
  title: string;
  amountSats?: string;
  subtitle?: ReactNode;
  onBack?: () => void;
  error?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`result-screen result-screen--${tone}`}
      aria-labelledby={titleId}
    >
      {onBack !== undefined && (
        <div className="confirm-topbar result-topbar">
          <button
            className="confirm-back"
            type="button"
            aria-label="Back"
            onClick={onBack}
          >
            <ChevronLeftIcon />
          </button>
        </div>
      )}
      <div className="result-body">
        <div className="result-group">
          <div className={`result-icon result-icon--${tone}`}>
            {direction === 'in' ? (
              <ArrowDownIcon size={52} />
            ) : (
              <ArrowUpIcon size={52} />
            )}
          </div>
          <div className="result-copy">
            <h1 id={titleId} className="result-title">
              {title}
            </h1>
            {amountSats !== undefined && (
              <p className="result-amount">
                <span className="amount-value">{amountSats}</span>
              </p>
            )}
            {subtitle !== undefined && <p className="result-sub">{subtitle}</p>}
          </div>
        </div>
        <ScreenError message={error} />
        {children}
      </div>
    </section>
  );
}

export function ShareButton({
  secret,
  label,
  title,
  onStatus,
}: {
  secret: ClearableSecretText;
  label: string;
  title?: string;
  onStatus(status: string): void;
}) {
  async function share() {
    const outcome = await shareText(secret.reveal(), { title });
    if (outcome === 'copied') {
      onStatus('Copied. Clear or replace the clipboard after sharing.');
    } else if (outcome === 'failed') {
      onStatus('Sharing failed. Use the copy control below.');
    }
  }

  return (
    <button className="cta-share" type="button" onClick={() => void share()}>
      <ShareIcon size={20} />
      {label}
    </button>
  );
}

export function CopyButton({
  secret,
  disabled = false,
  label = 'Copy',
  onStatus,
}: {
  secret: ClearableSecretText;
  disabled?: boolean;
  label?: string;
  onStatus(status: string): void;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret.reveal());
      onStatus('Copied. Clear or replace the clipboard after sharing.');
    } catch {
      onStatus('Clipboard access failed. Select and copy the value manually.');
    }
  }

  return (
    <button
      className="primary-button"
      type="button"
      disabled={disabled}
      onClick={() => void copy()}
    >
      {label}
    </button>
  );
}

export function SettingsRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="settings-row">
      <summary className="settings-summary">
        <span className="settings-row-icon">{icon}</span>
        <span className="settings-row-label">{label}</span>
        <span className="settings-chevron">
          <ChevronDownGlyph />
        </span>
      </summary>
      <div className="settings-panel">{children}</div>
    </details>
  );
}

export function CloseGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronRightGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9 6l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 9l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WalletGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1h1a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16.5" cy="12.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function SeedGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20 6 9 17l-5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RecoveryGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
