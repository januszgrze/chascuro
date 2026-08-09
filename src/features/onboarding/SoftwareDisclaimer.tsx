export function SoftwareDisclaimer() {
  return (
    <div
      className="onb-install-hint onb-software-disclaimer"
      role="note"
      aria-label="Experimental software warning"
    >
      <span className="onb-install-copy">
        <strong>Experimental software</strong>
        <span>
          Chascuro’s developers and contributors provide no guarantees of
          security, reliability, or recovery. You could lose some or all of your
          funds. Only use amounts you can afford to lose.
        </span>
      </span>
    </div>
  );
}
