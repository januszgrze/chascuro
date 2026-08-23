import {
  getFederationJoinBlockReason,
  type FederationCandidate,
} from '../../domain';
import { GuardiansIcon, ScanIcon, ShieldIcon } from '../shared/icons';
import { OnboardingProgress } from '../shared/OnboardingProgress';
import { ScreenError } from '../shared/ScreenFrame';

interface FederationReviewScreenProps {
  candidate: FederationCandidate;
  busy: boolean;
  error?: string;
  variant?: 'onboard' | 'add';
  onBack(): void;
  onJoin(
    trustAcknowledged: boolean,
    mainnetRiskAcknowledged: boolean,
  ): Promise<void>;
  onLock(): Promise<void>;
}

export function FederationReviewScreen({
  candidate,
  busy,
  error,
  variant = 'onboard',
  onBack,
  onJoin,
}: FederationReviewScreenProps) {
  const joinBlockReason = getFederationJoinBlockReason(candidate);
  const guardianLabel = `${candidate.guardianCount} guardian${
    candidate.guardianCount === 1 ? '' : 's'
  } online`;
  const blockMessage =
    joinBlockReason === 'missing_mint_module'
      ? 'This federation does not report the mint module required for ecash.'
      : undefined;

  function join() {
    if (busy || joinBlockReason !== undefined) {
      return;
    }
    // Tapping "Join federation" is the trust (and mainnet-risk) acknowledgement.
    void onJoin(true, true);
  }

  return (
    <section className="flow-screen" aria-labelledby="review-title">
      <div className="flow-screen-content">
        {variant === 'onboard' ? <OnboardingProgress step={3} /> : null}
        <h1 id="review-title" className="onb-title">
          {variant === 'add' ? 'Join this mint' : 'Choose a federation'}
        </h1>
        <p className="onb-subtitle">
          {variant === 'add'
            ? 'Confirm this federation before adding it to your wallet.'
            : 'Paste or scan a federation invite to join.'}
        </p>
        <button
          className="fed-input-row fed-input-summary"
          type="button"
          disabled={busy}
          onClick={onBack}
        >
          <span>fed11qgqpw9thwvaz7te...</span>
          <ScanIcon />
        </button>
        <div className="fed-card">
          <div className="fed-card-head">
            <span className="fed-badge">
              <ShieldIcon />
            </span>
            <span className="fed-card-meta">
              <span className="fed-card-title">{candidate.displayName}</span>
              <span className="fed-card-status">{guardianLabel}</span>
            </span>
          </div>
          <div className="fed-card-note">
            <GuardiansIcon />
            <span>No single guardian can freeze or take your funds.</span>
          </div>
        </div>
      </div>
      <div className="screen-actions">
        <ScreenError message={blockMessage ?? error} />
        <button
          className="flow-primary-action"
          type="button"
          disabled={busy || joinBlockReason !== undefined}
          onClick={join}
        >
          {busy
            ? 'Joining mint…'
            : variant === 'add'
              ? 'Join mint'
              : 'Join federation'}
        </button>
      </div>
    </section>
  );
}
