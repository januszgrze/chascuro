import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const WALLET_SETTINGS_RECORD_KIND = 'settings';
export const WALLET_SETTINGS_RECORD_VERSION = 1 as const;
export const WALLET_SETTINGS_RECORD_ID = 'security';

const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface WalletSecuritySettings {
  readonly version: typeof WALLET_SETTINGS_RECORD_VERSION;
  readonly inactivityTimeoutMs: number | null;
  readonly backgroundTimeoutMs: number | null;
}

export const DEFAULT_WALLET_SECURITY_SETTINGS: WalletSecuritySettings =
  Object.freeze({
    version: WALLET_SETTINGS_RECORD_VERSION,
    inactivityTimeoutMs: 5 * 60 * 1000,
    backgroundTimeoutMs: 30 * 1000,
  });

export const walletSecuritySettingsSchema: EncryptedRecordSchema<WalletSecuritySettings> =
  Object.freeze({
    kind: WALLET_SETTINGS_RECORD_KIND,
    version: WALLET_SETTINGS_RECORD_VERSION,
    parse: parseWalletSecuritySettings,
  });

export function parseWalletSecuritySettings(
  value: unknown,
): WalletSecuritySettings {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.version !== WALLET_SETTINGS_RECORD_VERSION ||
    !isTimeout(value.inactivityTimeoutMs) ||
    !isTimeout(value.backgroundTimeoutMs) ||
    (value.inactivityTimeoutMs === null && value.backgroundTimeoutMs === null)
  ) {
    throw new TypeError('Stored wallet security settings are invalid.');
  }

  return Object.freeze({
    version: WALLET_SETTINGS_RECORD_VERSION,
    inactivityTimeoutMs: value.inactivityTimeoutMs,
    backgroundTimeoutMs: value.backgroundTimeoutMs,
  });
}

function isTimeout(value: unknown): value is number | null {
  return (
    value === null ||
    (Number.isSafeInteger(value) &&
      Number(value) >= MIN_TIMEOUT_MS &&
      Number(value) <= MAX_TIMEOUT_MS)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
