import { BitcoinMark } from './BitcoinMark';
import { Keypad } from './Keypad';

interface AmountKeypadProps {
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
  maxDigits?: number;
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
}: AmountKeypadProps) {
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
    <div>
      <div className="amount-display">
        <BitcoinMark className="amount-symbol" />
        <span className="amount-value">{groupDigits(value)}</span>
        <span className="visually-hidden" role="status">
          {groupDigits(value)} sats entered
        </span>
      </div>
      <Keypad
        onDigit={press}
        onBackspace={backspace}
        disabled={disabled}
        backspaceDisabled={value.length === 0}
      />
    </div>
  );
}
