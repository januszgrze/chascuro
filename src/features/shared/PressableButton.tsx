import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';

const MINIMUM_PRESS_MS = 120;

export type PressableButtonProps = ComponentPropsWithoutRef<'button'>;

export function PressableButton({
  className,
  disabled,
  onBlur,
  onKeyDown,
  onKeyUp,
  onPointerCancel,
  onPointerDown,
  onPointerLeave,
  onPointerUp,
  ...props
}: PressableButtonProps) {
  const [pressed, setPressed] = useState(false);
  const pressedAtMs = useRef<number | undefined>(undefined);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(
    () => () => {
      if (releaseTimer.current !== undefined) {
        clearTimeout(releaseTimer.current);
      }
    },
    [],
  );

  function beginPress() {
    if (releaseTimer.current !== undefined) {
      clearTimeout(releaseTimer.current);
      releaseTimer.current = undefined;
    }
    pressedAtMs.current = performance.now();
    setPressed(true);
  }

  function endPress() {
    if (pressedAtMs.current === undefined) {
      return;
    }
    const remainingMs = Math.max(
      0,
      MINIMUM_PRESS_MS - (performance.now() - pressedAtMs.current),
    );
    pressedAtMs.current = undefined;
    releaseTimer.current = setTimeout(() => {
      releaseTimer.current = undefined;
      setPressed(false);
    }, remainingMs);
  }

  return (
    <button
      {...props}
      className={`${className ?? ''}${pressed ? ' is-pressed' : ''}`.trim()}
      disabled={disabled}
      onBlur={(event) => {
        onBlur?.(event);
        endPress();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          !disabled &&
          !event.repeat &&
          (event.key === 'Enter' || event.key === ' ')
        ) {
          beginPress();
        }
      }}
      onKeyUp={(event) => {
        onKeyUp?.(event);
        if (event.key === 'Enter' || event.key === ' ') {
          endPress();
        }
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        endPress();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (
          !event.defaultPrevented &&
          !disabled &&
          (event.pointerType !== 'mouse' || event.button === 0)
        ) {
          beginPress();
        }
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        endPress();
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        endPress();
      }}
    />
  );
}
