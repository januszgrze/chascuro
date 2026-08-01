import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WALLET_DISPLAY_SETTINGS,
  parseWalletDisplaySettings,
} from './wallet-display-settings-record';

describe('wallet display settings schema', () => {
  it('accepts the default and compact hybrid modes', () => {
    expect(parseWalletDisplaySettings(DEFAULT_WALLET_DISPLAY_SETTINGS)).toEqual(
      DEFAULT_WALLET_DISPLAY_SETTINGS,
    );
    expect(
      parseWalletDisplaySettings({
        version: 1,
        amountDisplayMode: 'compact-hybrid',
      }),
    ).toEqual({ version: 1, amountDisplayMode: 'compact-hybrid' });
  });

  it('rejects unknown modes and extra fields', () => {
    expect(() =>
      parseWalletDisplaySettings({ version: 1, amountDisplayMode: 'btc' }),
    ).toThrow(TypeError);
    expect(() =>
      parseWalletDisplaySettings({
        version: 1,
        amountDisplayMode: 'bip177',
        unexpected: true,
      }),
    ).toThrow(TypeError);
  });
});
