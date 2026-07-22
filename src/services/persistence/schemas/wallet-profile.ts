import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const WALLET_PROFILE_V1_VERSION = 1 as const;
export const WALLET_PROFILE_V2_VERSION = 2 as const;
export const WALLET_PROFILE_RECORD_KIND = 'profile';

export type PersistedWalletMode = 'fake' | 'fedimint';

export type PersistedBitcoinNetwork =
  'bitcoin' | 'testnet' | 'signet' | 'regtest' | 'unknown';

export interface PersistedActiveFederation {
  readonly federationId: string;
  readonly displayName: string;
  readonly network: PersistedBitcoinNetwork;
  readonly modules: readonly string[];
  readonly guardianCount: number;
  readonly clientName: string;
  readonly joinedAtMs: number;
}

export interface WalletProfileV1 {
  readonly version: typeof WALLET_PROFILE_V1_VERSION;
  readonly mode: PersistedWalletMode;
  readonly activeFederation?: PersistedActiveFederation;
}

export type WalletIdentityStateV2 =
  | Readonly<{
      status: 'not-initialized';
    }>
  | Readonly<{
      status: 'initialized';
      backupConfirmedAtMs?: number;
    }>;

export interface WalletProfileV2 {
  readonly version: typeof WALLET_PROFILE_V2_VERSION;
  readonly mode: PersistedWalletMode;
  readonly adapterVersion: string;
  readonly identity: WalletIdentityStateV2;
  readonly activeFederation?: PersistedActiveFederation;
}

export const walletProfileV2Schema: EncryptedRecordSchema<WalletProfileV2> =
  Object.freeze({
    kind: WALLET_PROFILE_RECORD_KIND,
    version: WALLET_PROFILE_V2_VERSION,
    parse: parseWalletProfileV2,
  });

export function parseWalletProfileV1(value: unknown): WalletProfileV1 {
  if (
    !isPlainRecord(value) ||
    !hasAllowedExactKeys(value, ['version', 'mode'], ['activeFederation']) ||
    value.version !== WALLET_PROFILE_V1_VERSION ||
    !isWalletMode(value.mode)
  ) {
    throw new TypeError('Unsupported Version 1 wallet profile.');
  }

  const activeFederation =
    value.activeFederation === undefined
      ? undefined
      : parseActiveFederation(value.activeFederation);

  return Object.freeze({
    version: WALLET_PROFILE_V1_VERSION,
    mode: value.mode,
    ...(activeFederation === undefined ? {} : { activeFederation }),
  });
}

export function parseWalletProfileV2(value: unknown): WalletProfileV2 {
  if (
    !isPlainRecord(value) ||
    !hasAllowedExactKeys(
      value,
      ['version', 'mode', 'adapterVersion', 'identity'],
      ['activeFederation'],
    ) ||
    value.version !== WALLET_PROFILE_V2_VERSION ||
    !isWalletMode(value.mode) ||
    !isIdentifier(value.adapterVersion)
  ) {
    throw new TypeError('Unsupported Version 2 wallet profile.');
  }

  const identity = parseWalletIdentity(value.identity);
  const activeFederation =
    value.activeFederation === undefined
      ? undefined
      : parseActiveFederation(value.activeFederation);

  return Object.freeze({
    version: WALLET_PROFILE_V2_VERSION,
    mode: value.mode,
    adapterVersion: value.adapterVersion,
    identity,
    ...(activeFederation === undefined ? {} : { activeFederation }),
  });
}

export function upgradeWalletProfileV1(
  profile: WalletProfileV1,
  adapterVersion: string,
): WalletProfileV2 {
  if (!isIdentifier(adapterVersion)) {
    throw new TypeError('Adapter version is required.');
  }

  return parseWalletProfileV2({
    version: WALLET_PROFILE_V2_VERSION,
    mode: profile.mode,
    adapterVersion,
    identity:
      profile.activeFederation === undefined
        ? {
            status: 'not-initialized',
          }
        : {
            status: 'initialized',
          },
    ...(profile.activeFederation === undefined
      ? {}
      : { activeFederation: profile.activeFederation }),
  });
}

function parseWalletIdentity(value: unknown): WalletIdentityStateV2 {
  if (
    !isPlainRecord(value) ||
    !hasAllowedExactKeys(value, ['status'], ['backupConfirmedAtMs']) ||
    (value.status !== 'not-initialized' && value.status !== 'initialized') ||
    (value.backupConfirmedAtMs !== undefined &&
      !isTimestamp(value.backupConfirmedAtMs)) ||
    (value.status === 'not-initialized' &&
      value.backupConfirmedAtMs !== undefined)
  ) {
    throw new TypeError('Stored wallet identity state is invalid.');
  }

  return Object.freeze({
    status: value.status,
    ...(value.backupConfirmedAtMs === undefined
      ? {}
      : { backupConfirmedAtMs: value.backupConfirmedAtMs }),
  });
}

function parseActiveFederation(value: unknown): PersistedActiveFederation {
  if (
    !isPlainRecord(value) ||
    !hasAllowedExactKeys(
      value,
      [
        'federationId',
        'displayName',
        'network',
        'modules',
        'guardianCount',
        'clientName',
        'joinedAtMs',
      ],
      [],
    ) ||
    !isIdentifier(value.federationId) ||
    !isIdentifier(value.displayName) ||
    !isBitcoinNetwork(value.network) ||
    !Array.isArray(value.modules) ||
    !value.modules.every(isIdentifier) ||
    new Set(value.modules).size !== value.modules.length ||
    !isNonNegativeSafeInteger(value.guardianCount) ||
    !isIdentifier(value.clientName) ||
    !isTimestamp(value.joinedAtMs)
  ) {
    throw new TypeError('Stored federation selection is invalid.');
  }

  return Object.freeze({
    federationId: value.federationId,
    displayName: value.displayName,
    network: value.network,
    modules: Object.freeze([...value.modules]),
    guardianCount: value.guardianCount,
    clientName: value.clientName,
    joinedAtMs: value.joinedAtMs,
  });
}

function hasAllowedExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isWalletMode(value: unknown): value is PersistedWalletMode {
  return value === 'fake' || value === 'fedimint';
}

function isBitcoinNetwork(value: unknown): value is PersistedBitcoinNetwork {
  return (
    value === 'bitcoin' ||
    value === 'testnet' ||
    value === 'signet' ||
    value === 'regtest' ||
    value === 'unknown'
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
