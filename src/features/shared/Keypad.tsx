import { BackspaceIcon } from './icons';

interface KeypadProps {
  onDigit(digit: string): void;
  onBackspace(): void;
  disabled?: boolean;
  backspaceDisabled?: boolean;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function Keypad({
  onDigit,
  onBackspace,
  disabled = false,
  backspaceDisabled = false,
}: KeypadProps) {
  return (
    <div className="keypad" role="group" aria-label="Number keypad">
      {[KEYS.slice(0, 3), KEYS.slice(3, 6), KEYS.slice(6, 9)].map(
        (row, rowIndex) => (
          <div className="keypad-row" key={rowIndex}>
            {row.map((digit) => (
              <button
                key={digit}
                className="keypad-key"
                type="button"
                disabled={disabled}
                aria-label={digit}
                onClick={() => onDigit(digit)}
              >
                {digit}
              </button>
            ))}
          </div>
        ),
      )}
      <div className="keypad-row">
        <span className="keypad-key-empty" />
        <button
          className="keypad-key"
          type="button"
          disabled={disabled}
          aria-label="0"
          onClick={() => onDigit('0')}
        >
          0
        </button>
        <button
          className="keypad-key"
          type="button"
          disabled={disabled || backspaceDisabled}
          aria-label="Delete"
          onClick={onBackspace}
        >
          <BackspaceIcon />
        </button>
      </div>
    </div>
  );
}
