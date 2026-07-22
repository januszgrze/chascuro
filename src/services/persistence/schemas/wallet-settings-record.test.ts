import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WALLET_SECURITY_SETTINGS,
  parseWalletSecuritySettings,
} from './wallet-settings-record';

describe('wallet security settings schema', () => {
  it('accepts bounded timeouts and the defaults', () => {
    expect(
      parseWalletSecuritySettings(DEFAULT_WALLET_SECURITY_SETTINGS),
    ).toEqual(DEFAULT_WALLET_SECURITY_SETTINGS);
    expect(
      parseWalletSecuritySettings({
        version: 1,
        inactivityTimeoutMs: 60_000,
        backgroundTimeoutMs: null,
      }),
    ).toMatchObject({
      inactivityTimeoutMs: 60_000,
      backgroundTimeoutMs: null,
    });
  });

  it('rejects disabling both controls and unsafe timeout values', () => {
    expect(() =>
      parseWalletSecuritySettings({
        version: 1,
        inactivityTimeoutMs: null,
        backgroundTimeoutMs: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseWalletSecuritySettings({
        version: 1,
        inactivityTimeoutMs: 1,
        backgroundTimeoutMs: 30_000,
      }),
    ).toThrow(TypeError);
  });
});
