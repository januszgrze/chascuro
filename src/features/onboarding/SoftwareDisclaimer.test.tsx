import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReadyScreen } from './ReadyScreen';

const DISCLAIMER = /developers and contributors provide no guarantees/i;

describe('onboarding software disclaimer', () => {
  it('warns on the ready screen', () => {
    render(<ReadyScreen onContinue={vi.fn()} />);

    const warning = screen.getByRole('note', {
      name: 'Experimental software warning',
    });
    expect(warning).toHaveTextContent(DISCLAIMER);
    expect(warning).toHaveTextContent(
      /only use amounts you can afford to lose/i,
    );
  });
});
