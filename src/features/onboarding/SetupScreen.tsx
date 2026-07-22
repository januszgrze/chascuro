import { useState } from 'react';

import { PinPad } from '../shared/PinPad';
import { OnboardingProgress } from '../shared/OnboardingProgress';
import { ScreenError } from '../shared/ScreenFrame';

interface SetupScreenProps {
  busy: boolean;
  error?: string;
  onSetup(passphrase: string): Promise<void>;
}

const PIN_LENGTH = 4;

export function SetupScreen({ busy, error, onSetup }: SetupScreenProps) {
  const [step, setStep] = useState<'create' | 'confirm'>('create');
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validationError, setValidationError] = useState<string>();

  const isConfirm = step === 'confirm';
  const value = isConfirm ? confirmation : pin;
  const setValue = isConfirm ? setConfirmation : setPin;
  const ready = value.length === PIN_LENGTH;

  function resetToCreate() {
    setStep('create');
    setPin('');
    setConfirmation('');
  }

  function advance() {
    if (!ready || busy) {
      return;
    }

    if (!isConfirm) {
      setValidationError(undefined);
      setStep('confirm');
      return;
    }

    if (confirmation !== pin) {
      setValidationError('Those PINs did not match. Try again.');
      resetToCreate();
      return;
    }

    setValidationError(undefined);
    void onSetup(pin).then(resetToCreate);
  }

  return (
    <section aria-labelledby="setup-title">
      <OnboardingProgress step={2} />
      <h1 id="setup-title" className="onb-title is-centered">
        {isConfirm ? 'Confirm PIN' : 'Create PIN'}
      </h1>
      <PinPad
        value={value}
        onChange={setValue}
        length={PIN_LENGTH}
        disabled={busy}
      />
      <div className="onb-footer">
        <ScreenError message={validationError ?? error} />
        <button
          className="cta-pill"
          type="button"
          disabled={!ready || busy}
          onClick={advance}
        >
          {isConfirm ? 'Confirm PIN' : 'Create PIN'}
        </button>
      </div>
    </section>
  );
}
