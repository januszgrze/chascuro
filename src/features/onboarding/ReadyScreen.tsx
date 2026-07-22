import { CheckIcon } from '../shared/icons';

interface ReadyScreenProps {
  onContinue(): void;
}

export function ReadyScreen({ onContinue }: ReadyScreenProps) {
  return (
    <section className="onb-ready" aria-labelledby="ready-title">
      <div className="onb-ready-body">
        <div className="onb-ready-glyph" aria-hidden="true">
          <CheckIcon />
        </div>
        <h1 id="ready-title">You're ready</h1>
      </div>
      <div className="onb-ready-footer">
        <button className="cta-pill" type="button" onClick={onContinue}>
          Go to wallet
        </button>
      </div>
    </section>
  );
}
