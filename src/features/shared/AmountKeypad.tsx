import { formatCoinsCoinStandard } from '../../domain';
import { Keypad } from './Keypad';

interface AmountKeypadProps {
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
  maxDigits?: number;
}

function coinsFromDigits(digits: string): bigint {
  const normalized = digits.replace(/^0+(?=\d)/, '') || '0';
  return BigInt(normalized);
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

  const amountLabel = formatCoinsCoinStandard(coinsFromDigits(value));

  return (
    <div>
      <div className="amount-display">
        <span className="amount-value">{amountLabel}</span>
        <span className="visually-hidden" role="status">
          {amountLabel} entered
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
