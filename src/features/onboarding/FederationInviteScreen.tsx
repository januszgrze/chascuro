import { useState, type FormEvent } from 'react';

import { classifyWalletInput } from '../../domain';
import { ChevronLeftIcon, ScanIcon } from '../shared/icons';
import { OnboardingProgress } from '../shared/OnboardingProgress';
import { QrScanner } from '../shared/QrScanner';
import { ScreenError } from '../shared/ScreenFrame';

interface FederationInviteScreenProps {
  busy: boolean;
  error?: string;
  variant?: 'onboard' | 'add';
  onPreview(inviteCode: string): Promise<void>;
  onLock(): Promise<void>;
  onBack?: () => void;
}

export function FederationInviteScreen({
  busy,
  error,
  variant = 'onboard',
  onPreview,
  onBack,
}: FederationInviteScreenProps) {
  const [inviteCode, setInviteCode] = useState('');
  const [scanError, setScanError] = useState<string>();
  const [scanning, setScanning] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedInvite = inviteCode;

    // The raw invite leaves component state as soon as it is handed to the
    // service. Application state receives only the sanitized preview.
    setInviteCode('');
    void onPreview(submittedInvite);
  }

  function scanInvite(value: string) {
    try {
      const classified = classifyWalletInput(value);
      if (classified.kind !== 'federation_invite') {
        setScanError('That QR code is not a Fedimint federation invite.');
        return;
      }
      setScanError(undefined);
      setInviteCode(classified.input);
      setScanning(false);
    } catch {
      setScanError('That QR code is not a valid federation invite.');
    }
  }

  return (
    <section
      className={variant === 'add' ? 'choose-mint flow-screen' : 'flow-screen'}
      aria-labelledby="invite-title"
    >
      <div className="flow-screen-content">
        {variant === 'onboard' ? (
          <OnboardingProgress step={3} />
        ) : (
          <header className="choose-mint-header">
            <div className="choose-mint-topbar">
              <button
                className="choose-mint-close"
                type="button"
                aria-label="Back"
                onClick={onBack}
              >
                <ChevronLeftIcon />
              </button>
            </div>
            <div className="choose-mint-intro">
              <h1 id="invite-title" className="choose-mint-title">
                Add a mint
              </h1>
              <p className="choose-mint-subtitle">
                Paste or scan another federation invite to join.
              </p>
            </div>
          </header>
        )}
        {variant === 'onboard' ? (
          <>
            <h1 id="invite-title" className="onb-title">
              Choose a federation
            </h1>
            <p className="onb-subtitle">
              Paste or scan a federation invite to join.
            </p>
          </>
        ) : null}
        <form
          id="federation-invite-form"
          className={variant === 'add' ? 'choose-mint-form' : 'onb-form'}
          onSubmit={submit}
        >
          <div className={variant === 'add' ? 'choose-mint-body' : undefined}>
            <div className="fed-input-row">
              <input
                id="federation-invite"
                name="federation-invite"
                className="fed-input"
                aria-label="Federation invite"
                placeholder="fed11…"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                minLength={8}
                required
                value={inviteCode}
                onChange={(event) => {
                  setScanError(undefined);
                  setInviteCode(event.target.value);
                }}
              />
              <button
                className="fed-scan-btn"
                type="button"
                aria-label="Scan federation invite"
                disabled={busy}
                onClick={() => setScanning((current) => !current)}
              >
                <ScanIcon />
              </button>
            </div>
            {scanning && (
              <div className="fed-scanner">
                <QrScanner disabled={busy} onScan={scanInvite} />
              </div>
            )}
            <ScreenError message={scanError ?? error} />
          </div>
        </form>
      </div>
      <div className="screen-actions">
        <button
          className="flow-primary-action"
          type="submit"
          form="federation-invite-form"
          disabled={busy}
        >
          {busy ? 'Checking federation…' : 'Preview federation'}
        </button>
      </div>
    </section>
  );
}
