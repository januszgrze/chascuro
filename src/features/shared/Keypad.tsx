import { BackspaceIcon, CheckIcon } from './icons';
import { PressableButton } from './PressableButton';

interface KeypadProps {
  onDigit(digit: string): void;
  onBackspace(): void;
  disabled?: boolean;
  backspaceDisabled?: boolean;
  /**
   * When provided, the bottom row shows a confirm (check) key on the right and
   * moves backspace to the left. Used by amount entry screens where the check
   * commits the amount (e.g. creating a link or invoice).
   */
  onConfirm?(): void;
  confirmDisabled?: boolean;
  confirmLabel?: string;
  /**
   * While true the confirm key shows a rippling pending indicator instead of
   * the check icon (e.g. an invoice or link is being created).
   */
  confirmBusy?: boolean;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function Keypad({
  onDigit,
  onBackspace,
  disabled = false,
  backspaceDisabled = false,
  onConfirm,
  confirmDisabled = false,
  confirmLabel = 'Confirm',
  confirmBusy = false,
}: KeypadProps) {
  const backspaceKey = (
    <PressableButton
      className="keypad-key"
      type="button"
      disabled={disabled || backspaceDisabled}
      aria-label="Delete"
      onClick={onBackspace}
    >
      <BackspaceIcon />
    </PressableButton>
  );
  return (
    <div className="keypad" role="group" aria-label="Number keypad">
      {[KEYS.slice(0, 3), KEYS.slice(3, 6), KEYS.slice(6, 9)].map(
        (row, rowIndex) => (
          <div className="keypad-row" key={rowIndex}>
            {row.map((digit) => (
              <PressableButton
                key={digit}
                className="keypad-key"
                type="button"
                disabled={disabled}
                aria-label={digit}
                onClick={() => onDigit(digit)}
              >
                {digit}
              </PressableButton>
            ))}
          </div>
        ),
      )}
      <div className="keypad-row">
        {onConfirm === undefined ? (
          <span className="keypad-key-empty" />
        ) : (
          backspaceKey
        )}
        <PressableButton
          className="keypad-key"
          type="button"
          disabled={disabled}
          aria-label="0"
          onClick={() => onDigit('0')}
        >
          0
        </PressableButton>
        {onConfirm === undefined ? (
          backspaceKey
        ) : (
          <PressableButton
            className="keypad-key keypad-key-confirm"
            type="button"
            disabled={disabled || confirmDisabled}
            aria-label={confirmLabel}
            aria-busy={confirmBusy}
            onClick={onConfirm}
          >
            {confirmBusy ? (
              <span className="pending-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <CheckIcon size={26} />
            )}
          </PressableButton>
        )}
      </div>
    </div>
  );
}
