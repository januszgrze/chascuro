import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  candidateId,
  federationId,
  type FederationCandidate,
} from '../../domain';
import { FederationInviteScreen } from './FederationInviteScreen';
import { FederationReviewScreen } from './FederationReviewScreen';

const scanner = vi.hoisted(() => ({
  payload: 'fed1example',
}));

vi.mock('../shared/QrScanner', () => ({
  QrScanner: ({ onScan }: { onScan(value: string): void }) => (
    <button type="button" onClick={() => onScan(scanner.payload)}>
      Scan test QR
    </button>
  ),
}));

function candidate(
  overrides: Partial<FederationCandidate> = {},
): FederationCandidate {
  return {
    candidateId: candidateId('candidate-a'),
    federationId: federationId('federation-a'),
    displayName: 'Community federation',
    network: 'signet',
    modules: ['ln', 'mint'],
    guardianCount: 2,
    guardianOrigins: [
      'wss://guardian-one.example',
      'wss://guardian-two.example',
    ],
    expiresAtMs: 10_000,
    ...overrides,
  };
}

describe('Federation onboarding screens', () => {
  it('accepts only federation invites from QR scans without auto-previewing', async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn().mockResolvedValue(undefined);
    render(
      <FederationInviteScreen
        busy={false}
        onPreview={onPreview}
        onLock={vi.fn()}
      />,
    );

    scanner.payload = 'lntb1example';
    await user.click(
      screen.getByRole('button', { name: 'Scan federation invite' }),
    );
    await user.click(screen.getByRole('button', { name: 'Scan test QR' }));
    expect(
      screen.getByText('That QR code is not a Fedimint federation invite.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Federation invite')).toHaveValue('');
    expect(onPreview).not.toHaveBeenCalled();

    scanner.payload = 'fed1example';
    await user.click(
      screen.getByRole('button', { name: 'Scan federation invite' }),
    );
    await user.click(screen.getByRole('button', { name: 'Scan test QR' }));
    expect(screen.getByLabelText('Federation invite')).toHaveValue(
      'fed1example',
    );
    expect(onPreview).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Federation invite'));
    await user.type(
      screen.getByLabelText('Federation invite'),
      'manually entered invite',
    );
    await user.click(
      screen.getByRole('button', { name: 'Preview federation' }),
    );
    expect(onPreview).toHaveBeenCalledWith('manually entered invite');
  });

  it('shows the federation name, guardian count, and custody note', () => {
    render(
      <FederationReviewScreen
        candidate={candidate()}
        busy={false}
        onBack={vi.fn()}
        onJoin={vi.fn()}
        onLock={vi.fn()}
      />,
    );

    expect(screen.getByText('Community federation')).toBeVisible();
    expect(screen.getByText('2 guardians online')).toBeVisible();
    expect(
      screen.getByText('No single guardian can freeze or take your funds.'),
    ).toBeVisible();
  });

  it('allows an unknown-network federation to be joined', async () => {
    const user = userEvent.setup();
    const onJoin = vi.fn().mockResolvedValue(undefined);
    render(
      <FederationReviewScreen
        candidate={candidate({ network: 'unknown' })}
        busy={false}
        onBack={vi.fn()}
        onJoin={onJoin}
        onLock={vi.fn()}
      />,
    );

    expect(screen.queryByText('Joining is disabled')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join federation' }));
    expect(onJoin).toHaveBeenCalledWith(true, true);
  });

  it('disables joining a federation without a mint module', () => {
    render(
      <FederationReviewScreen
        candidate={candidate({ modules: ['ln', 'wallet'] })}
        busy={false}
        onBack={vi.fn()}
        onJoin={vi.fn()}
        onLock={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'This federation does not report the mint module required for ecash.',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Join federation' }),
    ).toBeDisabled();
  });

  it('uses one join confirmation for a mainnet federation', async () => {
    const user = userEvent.setup();
    const onJoin = vi.fn().mockResolvedValue(undefined);
    render(
      <FederationReviewScreen
        candidate={candidate({ network: 'bitcoin' })}
        busy={false}
        onBack={vi.fn()}
        onJoin={onJoin}
        onLock={vi.fn()}
      />,
    );

    const join = screen.getByRole('button', { name: 'Join federation' });
    expect(join).toBeEnabled();
    await user.click(join);
    expect(onJoin).toHaveBeenCalledWith(true, true);
  });
});
