import type { ReactNode } from 'react';

import type { CapabilityName } from '../../services/security/capabilities';
import { BitcoinMark } from '../shared/BitcoinMark';
import { WarningTriangleIcon } from '../shared/icons';

const CAPABILITY_LABELS: Record<CapabilityName, string> = {
  'secure-context': 'Secure connection (HTTPS)',
  'web-crypto': 'Browser encryption (Web Crypto)',
  'indexed-db': 'Local database (IndexedDB)',
  'service-worker': 'Offline support (Service Worker)',
  'web-locks': 'Single-tab ownership (Web Locks)',
  opfs: 'Encrypted storage (OPFS)',
};

const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS) as CapabilityName[];

function StatusSplash({
  titleId,
  title,
  subtitle,
}: {
  titleId: string;
  title: string;
  subtitle: string;
}) {
  return (
    <section className="status-splash" aria-labelledby={titleId}>
      <div className="status-splash-body">
        <div className="onb-brand-mark">
          <BitcoinMark />
        </div>
        <span className="spinner" aria-hidden="true" />
        <div className="status-splash-copy">
          <h1 id={titleId}>{title}</h1>
          <p role="status">{subtitle}</p>
        </div>
      </div>
    </section>
  );
}

export function BootScreen() {
  return (
    <StatusSplash
      titleId="boot-title"
      title="Starting wallet"
      subtitle="Checking this browser and encrypted storage…"
    />
  );
}

export function OpeningScreen() {
  return (
    <StatusSplash
      titleId="opening-title"
      title="Opening wallet"
      subtitle="Starting the wallet engine…"
    />
  );
}

export function LockingScreen() {
  return (
    <StatusSplash
      titleId="locking-title"
      title="Locking wallet"
      subtitle="Closing the wallet engine and clearing the session…"
    />
  );
}

function CheckGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20 6 9 17l-5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CrossGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M18 6 6 18M6 6l12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface UnsupportedScreenProps {
  error?: string;
  missingCapabilities: readonly CapabilityName[];
}

export function UnsupportedScreen({
  error,
  missingCapabilities,
}: UnsupportedScreenProps) {
  return (
    <section className="status-unsupported" aria-labelledby="unsupported-title">
      <div className="status-unsupported-body">
        <div className="status-warn-icon" aria-hidden="true">
          <WarningTriangleIcon size={34} />
        </div>
        <div className="status-splash-copy">
          <h1 id="unsupported-title">This browser isn&apos;t supported</h1>
          <p>
            {error ??
              'Chascuro needs a few modern browser features to keep your wallet secure and available offline.'}
          </p>
        </div>
        <ul className="req-list">
          {ALL_CAPABILITIES.map((capability): ReactNode => {
            const supported = !missingCapabilities.includes(capability);
            return (
              <li className="req-row" key={capability}>
                <span
                  className={supported ? 'req-icon is-ok' : 'req-icon is-bad'}
                >
                  {supported ? <CheckGlyph /> : <CrossGlyph />}
                </span>
                <span className="req-label">
                  {CAPABILITY_LABELS[capability]}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="status-hint">
          Try the latest version of Safari or Chrome, over HTTPS. Wallet safety
          checks can&apos;t be bypassed.
        </p>
      </div>
    </section>
  );
}
