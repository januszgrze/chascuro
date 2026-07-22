import { BitcoinMark } from '../shared/BitcoinMark';
import { RefreshIcon, ShareIcon } from '../shared/icons';
import { ScreenError } from '../shared/ScreenFrame';

interface WelcomeScreenProps {
  mode: 'install' | 'wallet';
  error?: string;
  onInstallConfirmed(): void;
  onCreate(): void;
  onRestore(): void;
}

export function WelcomeScreen({
  mode,
  error,
  onInstallConfirmed,
  onCreate,
  onRestore,
}: WelcomeScreenProps) {
  const isInstall = mode === 'install';

  return (
    <section className="onb-welcome" aria-labelledby="welcome-title">
      <div className="onb-welcome-hero">
        <div className="onb-brand-mark" aria-hidden="true">
          <BitcoinMark />
        </div>
        <h1 id="welcome-title">Chascuro</h1>
        <p>Private chat and Bitcoin payments, held by a community you trust.</p>
      </div>

      {isInstall ? (
        <div className="onb-install-hint">
          <span className="onb-install-icon">
            <ShareIcon />
          </span>
          <span className="onb-install-copy">
            <strong>Add Chascuro to your Home Screen</strong>
            <span>
              Tap Share, then Add to Home Screen, so your wallet stays saved on
              this device.
            </span>
          </span>
        </div>
      ) : (
        <button
          className="onb-restore-action"
          type="button"
          onClick={onRestore}
        >
          <RefreshIcon size={16} />
          Restore another wallet
        </button>
      )}

      <div
        className={
          isInstall ? 'onb-welcome-footer is-install' : 'onb-welcome-footer'
        }
      >
        <ScreenError message={error} />
        <button
          className="cta-pill"
          type="button"
          onClick={isInstall ? onInstallConfirmed : onCreate}
        >
          {isInstall ? 'App is added to home' : 'Create a wallet'}
        </button>
      </div>
    </section>
  );
}
