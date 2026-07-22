interface OnboardingProgressProps {
  step: number;
  total?: number;
}

export function OnboardingProgress({
  step,
  total = 3,
}: OnboardingProgressProps) {
  return (
    <div className="onb-progress" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={
            index < step ? 'onb-progress-seg is-active' : 'onb-progress-seg'
          }
        />
      ))}
    </div>
  );
}
