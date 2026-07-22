import type { ReactNode } from 'react';

import {
  ArrowDownIcon,
  ArrowUpIcon,
  BoltIcon,
  ChatIcon,
  KeyboardIcon,
  LinkIcon,
} from './icons';
import { BitcoinMark } from './BitcoinMark';

export type PaymentRail = 'ecash' | 'lightning';
export type PaymentDirection = 'send' | 'receive';

interface SendReceiveShellProps {
  rail: PaymentRail;
  direction: PaymentDirection;
  variant: 'light' | 'dark';
  onNavigate(rail: PaymentRail, direction: PaymentDirection): void;
  onHome(): void;
  onKeyboard?(): void;
  children: ReactNode;
}

export function SendReceiveShell({
  rail,
  direction,
  variant,
  onNavigate,
  onHome,
  onKeyboard,
  children,
}: SendReceiveShellProps) {
  return (
    <section className={`sr-shell sr-shell--${variant}`} aria-label="Payments">
      <div className="sr-topbar">
        <span className="sr-icon-circle sr-chat" aria-hidden="true">
          <ChatIcon />
        </span>
        <div className="sr-toggle" role="group" aria-label="Payment rail">
          <button
            className={`sr-toggle-btn${rail === 'lightning' ? ' is-active' : ''}`}
            type="button"
            aria-pressed={rail === 'lightning'}
            aria-label="Lightning"
            onClick={() => onNavigate('lightning', direction)}
          >
            <BoltIcon />
          </button>
          <button
            className={`sr-toggle-btn${rail === 'ecash' ? ' is-active' : ''}`}
            type="button"
            aria-pressed={rail === 'ecash'}
            aria-label="Ecash"
            onClick={() => onNavigate('ecash', direction)}
          >
            <LinkIcon />
          </button>
        </div>
        {onKeyboard !== undefined && (
          <button
            className="sr-icon-circle sr-keyboard"
            type="button"
            aria-label="Enter manually"
            onClick={onKeyboard}
          >
            <KeyboardIcon />
          </button>
        )}
      </div>
      <div className="sr-body">{children}</div>
      <nav className="sr-nav" aria-label="Wallet navigation">
        <button
          className="sr-nav-btn sr-nav-balance"
          type="button"
          aria-label="Wallet home"
          onClick={onHome}
        >
          <BitcoinMark />
        </button>
        <button
          className={`sr-nav-btn${direction === 'send' ? ' is-active' : ''}`}
          type="button"
          aria-pressed={direction === 'send'}
          aria-label="Send"
          onClick={() => onNavigate('lightning', 'send')}
        >
          <ArrowUpIcon />
        </button>
        <button
          className={`sr-nav-btn${direction === 'receive' ? ' is-active' : ''}`}
          type="button"
          aria-pressed={direction === 'receive'}
          aria-label="Receive"
          onClick={() => onNavigate('ecash', 'receive')}
        >
          <ArrowDownIcon />
        </button>
      </nav>
    </section>
  );
}
