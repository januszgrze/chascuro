export type ViewTransitionDirection = 'forward' | 'back' | 'lateral';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function runViewTransition(
  direction: ViewTransitionDirection,
  update: () => void,
): void {
  if (
    typeof document.startViewTransition !== 'function' ||
    prefersReducedMotion()
  ) {
    update();
    return;
  }

  const root = document.documentElement;
  root.dataset.vtDir = direction;

  const transition = document.startViewTransition(update);
  void transition.finished.finally(() => {
    if (root.dataset.vtDir === direction) {
      delete root.dataset.vtDir;
    }
  });
}
