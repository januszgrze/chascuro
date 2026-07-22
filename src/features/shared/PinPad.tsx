import { Keypad } from './Keypad';

interface PinPadProps {
  value: string;
  onChange(next: string): void;
  length?: number;
  disabled?: boolean;
}

export function PinPad({
  value,
  onChange,
  length = 4,
  disabled = false,
}: PinPadProps) {
  function press(digit: string) {
    if (disabled || value.length >= length) {
      return;
    }
    onChange(value + digit);
  }

  function backspace() {
    if (disabled || value.length === 0) {
      return;
    }
    onChange(value.slice(0, -1));
  }

  return (
    <div className="pinpad">
      <div className="pin-dots" aria-hidden="true">
        {Array.from({ length }, (_, index) => (
          <span
            key={index}
            className={index < value.length ? 'pin-dot is-filled' : 'pin-dot'}
          />
        ))}
      </div>
      <p className="visually-hidden" role="status">
        {value.length} of {length} digits entered
      </p>
      <Keypad
        onDigit={press}
        onBackspace={backspace}
        disabled={disabled}
        backspaceDisabled={value.length === 0}
      />
    </div>
  );
}
