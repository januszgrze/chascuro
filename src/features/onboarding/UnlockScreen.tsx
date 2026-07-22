import { useState } from 'react';

import { PinPad } from '../shared/PinPad';
import { ScreenError } from '../shared/ScreenFrame';

interface UnlockScreenProps {
  busy: boolean;
  error?: string;
  onUnlock(passphrase: string): Promise<void>;
  onCreateNewWallet(): void;
}

const PIN_LENGTH = 4;

export function UnlockScreen({
  busy,
  error,
  onUnlock,
  onCreateNewWallet,
}: UnlockScreenProps) {
  const [pin, setPin] = useState('');

  function handleChange(next: string) {
    setPin(next);
    if (next.length === PIN_LENGTH && !busy) {
      void onUnlock(next).finally(() => setPin(''));
    }
  }

  return (
    <section className="unlock-screen" aria-labelledby="unlock-title">
      <div className="unlock-body">
        <h1 id="unlock-title" className="onb-title is-centered">
          Enter PIN
        </h1>
        <PinPad
          value={pin}
          onChange={handleChange}
          length={PIN_LENGTH}
          disabled={busy}
        />
        <ScreenError message={error} />
      </div>
      <button
        className="unlock-new-wallet"
        type="button"
        disabled={busy}
        onClick={onCreateNewWallet}
      >
        Create a new wallet
      </button>
    </section>
  );
}
