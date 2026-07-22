import type { ReactNode } from 'react';

import type { WalletServiceKind } from '../../services/wallet';

interface ScreenFrameProps {
  children: ReactNode;
  serviceKind: WalletServiceKind;
  disposableTestWallet?: boolean;
  busy?: boolean;
  chrome?: 'default' | 'none';
  surface?: 'light' | 'dark';
}

export function ScreenFrame({
  children,
  serviceKind,
  disposableTestWallet = false,
  busy = false,
  chrome = 'default',
  surface = 'light',
}: ScreenFrameProps) {
  return (
    <div
      className={surface === 'dark' ? 'app-frame app-frame--dark' : 'app-frame'}
    >
      {chrome === 'default' ? (
        <header className="app-header">
          <p className="wordmark" aria-label="Chascuro wallet">
            Chascuro
          </p>
          {disposableTestWallet ? (
            <p className="simulation-banner" role="status">
              Disposable test wallet — no recovery backup
            </p>
          ) : serviceKind === 'fake' ? (
            <p className="simulation-banner" role="status">
              Simulation — no real funds
            </p>
          ) : null}
        </header>
      ) : null}
      <main className="screen" aria-busy={busy}>
        {children}
      </main>
    </div>
  );
}

export function ScreenError({ message }: { message?: string }) {
  return message === undefined ? null : (
    <p className="error-message" role="alert">
      {message}
    </p>
  );
}
