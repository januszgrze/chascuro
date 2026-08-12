import { useLayoutEffect, useRef } from 'react';

import { BitcoinMark } from './BitcoinMark';
import { Keypad } from './Keypad';

interface AmountKeypadProps {
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
  maxDigits?: number;
  /**
   * When provided, a confirm (check) key appears on the keypad and commits the
   * entered amount (e.g. creating a link or invoice). Backspace moves left.
   */
  onConfirm?(): void;
  confirmDisabled?: boolean;
  confirmLabel?: string;
  /** While true the confirm key ripples to signal work in flight. */
  confirmBusy?: boolean;
}

function groupDigits(digits: string): string {
  const normalized = digits.replace(/^0+(?=\d)/, '') || '0';
  return normalized.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function AmountKeypad({
  value,
  onChange,
  disabled = false,
  maxDigits = 15,
  onConfirm,
  confirmDisabled = false,
  confirmLabel,
  confirmBusy = false,
}: AmountKeypadProps) {
  const amountValueRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const amountValue = amountValueRef.current;
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (
      amountValue === null ||
      reducedMotion ||
      typeof amountValue.animate !== 'function'
    ) {
      return;
    }
    // Spring "pop": the amount scales up past its target and settles, echoing
    // the SwiftUI spring(bounce:) used on list inserts in the native app.
    const animation = amountValue.animate(
      [
        { opacity: 0.5, transform: 'translateY(3px) scale(0.9)' },
        { opacity: 1, transform: 'translateY(-1px) scale(1.04)', offset: 0.55 },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ],
      {
        duration: 260,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    );
    return () => animation.cancel();
  }, [value]);

  function press(digit: string) {
    if (disabled || value.length >= maxDigits) {
      return;
    }
    const next = (value + digit).replace(/^0+(?=\d)/, '');
    onChange(next);
  }

  function backspace() {
    if (disabled || value.length === 0) {
      return;
    }
    onChange(value.slice(0, -1));
  }

  return (
    <div className="amount-keypad">
      <div className="amount-display">
        <BitcoinMark className="amount-symbol" />
        <span className="amount-value">
          <span ref={amountValueRef} className="amount-value-tick">
            {groupDigits(value)}
          </span>
        </span>
        <span className="visually-hidden" role="status">
          {groupDigits(value)} sats entered
        </span>
      </div>
      <Keypad
        onDigit={press}
        onBackspace={backspace}
        disabled={disabled}
        backspaceDisabled={value.length === 0}
        onConfirm={onConfirm}
        confirmDisabled={confirmDisabled}
        confirmLabel={confirmLabel}
        confirmBusy={confirmBusy}
      />
    </div>
  );
}
