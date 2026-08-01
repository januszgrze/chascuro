import {
  DEFAULT_AMOUNT_DISPLAY_MODE,
  type AmountDisplayMode,
} from '../../../domain';
import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const WALLET_DISPLAY_SETTINGS_RECORD_KIND = 'settings';
export const WALLET_DISPLAY_SETTINGS_RECORD_VERSION = 1 as const;
export const WALLET_DISPLAY_SETTINGS_RECORD_ID = 'display';

export interface WalletDisplaySettings {
  readonly version: typeof WALLET_DISPLAY_SETTINGS_RECORD_VERSION;
  readonly amountDisplayMode: AmountDisplayMode;
}

export const DEFAULT_WALLET_DISPLAY_SETTINGS: WalletDisplaySettings =
  Object.freeze({
    version: WALLET_DISPLAY_SETTINGS_RECORD_VERSION,
    amountDisplayMode: DEFAULT_AMOUNT_DISPLAY_MODE,
  });

export const walletDisplaySettingsSchema: EncryptedRecordSchema<WalletDisplaySettings> =
  Object.freeze({
    kind: WALLET_DISPLAY_SETTINGS_RECORD_KIND,
    version: WALLET_DISPLAY_SETTINGS_RECORD_VERSION,
    parse: parseWalletDisplaySettings,
  });

export function parseWalletDisplaySettings(
  value: unknown,
): WalletDisplaySettings {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== WALLET_DISPLAY_SETTINGS_RECORD_VERSION ||
    (value.amountDisplayMode !== 'bip177' &&
      value.amountDisplayMode !== 'compact-hybrid')
  ) {
    throw new TypeError('Stored wallet display settings are invalid.');
  }

  return Object.freeze({
    version: WALLET_DISPLAY_SETTINGS_RECORD_VERSION,
    amountDisplayMode: value.amountDisplayMode,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
