import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PressableButton } from './PressableButton';

afterEach(() => {
  vi.useRealTimers();
});

describe('PressableButton', () => {
  it('keeps touch feedback visible for a minimum duration', () => {
    vi.useFakeTimers();
    render(<PressableButton>Pay</PressableButton>);
    const button = screen.getByRole('button', { name: 'Pay' });

    fireEvent.pointerDown(button, { button: 0, pointerType: 'touch' });
    expect(button).toHaveClass('is-pressed');

    fireEvent.pointerUp(button, { button: 0, pointerType: 'touch' });
    expect(button).toHaveClass('is-pressed');

    act(() => vi.advanceTimersByTime(120));
    expect(button).not.toHaveClass('is-pressed');
  });

  it('preserves click behavior and ignores disabled buttons', () => {
    const onClick = vi.fn();
    const rendered = render(
      <PressableButton onClick={onClick}>Pay</PressableButton>,
    );
    const button = screen.getByRole('button', { name: 'Pay' });

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rendered.rerender(<PressableButton disabled>Pay</PressableButton>);
    fireEvent.pointerDown(button, { button: 0, pointerType: 'touch' });
    expect(button).not.toHaveClass('is-pressed');
  });
});
