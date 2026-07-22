import { describe, expect, it } from 'vitest';

import { resolveWalletServiceKind } from './create-wallet-service';

describe('resolveWalletServiceKind', () => {
  it('defaults normal development to the real Fedimint adapter', () => {
    expect(
      resolveWalletServiceKind({
        production: false,
        mode: 'development',
      }),
    ).toBe('fedimint');
  });

  it('keeps test and dedicated E2E modes deterministic by default', () => {
    expect(resolveWalletServiceKind({ production: false, mode: 'test' })).toBe(
      'fake',
    );
    expect(resolveWalletServiceKind({ production: true, mode: 'e2e' })).toBe(
      'fake',
    );
  });

  it('allows an explicit development simulation', () => {
    expect(
      resolveWalletServiceKind({
        configured: 'fake',
        production: false,
        mode: 'development',
      }),
    ).toBe('fake');
  });

  it('rejects explicit fake mode in a normal production build', () => {
    expect(() =>
      resolveWalletServiceKind({
        configured: 'fake',
        production: true,
        mode: 'production',
      }),
    ).toThrow('Fake wallet mode is unavailable in production builds.');
  });
});
