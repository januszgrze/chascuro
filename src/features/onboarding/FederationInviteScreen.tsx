import { useState, type FormEvent } from 'react';

import { classifyWalletInput } from '../../domain';
import { ScanIcon } from '../shared/icons';
import { OnboardingProgress } from '../shared/OnboardingProgress';
import { QrScanner } from '../shared/QrScanner';
import { ScreenError } from '../shared/ScreenFrame';

interface FederationInviteScreenProps {
  busy: boolean;
  error?: string;
  onPreview(inviteCode: string): Promise<void>;
  onLock(): Promise<void>;
}

export function FederationInviteScreen({
  busy,
  error,
  onPreview,
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
    setScanning(false);
    try {
      const classified = classifyWalletInput(value);
      if (classified.kind !== 'federation_invite') {
        setScanError('That QR code is not a Fedimint federation invite.');
        return;
      }
      setScanError(undefined);
      setInviteCode(classified.input);
    } catch {
      setScanError('That QR code is not a valid federation invite.');
    }
  }

  return (
    <section aria-labelledby="invite-title">
      <OnboardingProgress step={3} />
      <h1 id="invite-title" className="onb-title">
        Choose a federation
      </h1>
      <p className="onb-subtitle">Paste or scan a federation invite to join.</p>
      <form className="onb-form" onSubmit={submit}>
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
        <div className="onb-footer">
          <button className="cta-pill" type="submit" disabled={busy}>
            {busy ? 'Checking federation…' : 'Preview federation'}
          </button>
        </div>
      </form>
    </section>
  );
}
