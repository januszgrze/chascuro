import { CheckIcon } from '../shared/icons';
import { SoftwareDisclaimer } from './SoftwareDisclaimer';

interface ReadyScreenProps {
  onContinue(): void;
  onAddFederation?(): void;
}

export function ReadyScreen({ onContinue, onAddFederation }: ReadyScreenProps) {
  return (
    <section className="onb-ready" aria-labelledby="ready-title">
      <div className="onb-ready-body">
        <div className="onb-ready-glyph" aria-hidden="true">
          <CheckIcon />
        </div>
        <h1 id="ready-title">You're ready</h1>
        <SoftwareDisclaimer />
      </div>
      <div className="onb-ready-footer">
        {onAddFederation !== undefined && (
          <button
            className="secondary-button"
            type="button"
            onClick={onAddFederation}
          >
            Add another federation
          </button>
        )}
        <button className="cta-pill" type="button" onClick={onContinue}>
          Go to wallet
        </button>
      </div>
    </section>
  );
}
