import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmountKeypad } from './AmountKeypad';

const originalAnimate = HTMLElement.prototype.animate;
const cancel = vi.fn();
const animate = vi.fn(() => ({ cancel }) as unknown as Animation);

beforeEach(() => {
  animate.mockClear();
  cancel.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: animate,
  });
});

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: originalAnimate,
  });
});

describe('AmountKeypad', () => {
  it('explicitly restarts the amount animation when the value changes', () => {
    const rendered = render(
      <AmountKeypad value="" onChange={() => undefined} />,
    );

    expect(animate).toHaveBeenCalledTimes(1);
    rendered.rerender(<AmountKeypad value="21" onChange={() => undefined} />);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenLastCalledWith(
      [
        { opacity: 0.5, transform: 'translateY(3px) scale(0.9)' },
        { opacity: 1, transform: 'translateY(-1px) scale(1.04)', offset: 0.55 },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ],
      {
        duration: 260,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    );
  });
});
