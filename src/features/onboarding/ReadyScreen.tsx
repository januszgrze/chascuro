import { CheckIcon } from '../shared/icons';
import { SoftwareDisclaimer } from './SoftwareDisclaimer';

interface ReadyScreenProps {
  onContinue(): void;
}

export function ReadyScreen({ onContinue }: ReadyScreenProps) {
  return (
    <section className="onb-ready flow-screen" aria-labelledby="ready-title">
      <div className="onb-ready-body flow-screen-content">
        <div className="onb-ready-glyph" aria-hidden="true">
          <CheckIcon />
        </div>
        <h1 id="ready-title">You're ready</h1>
        <SoftwareDisclaimer />
      </div>
      <div className="screen-actions">
        <button
          className="flow-primary-action"
          type="button"
          onClick={onContinue}
        >
          Go to wallet
        </button>
      </div>
    </section>
  );
}
