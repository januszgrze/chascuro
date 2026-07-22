import {
  clientName,
  federationId,
  normalizeBitcoinNetwork,
  type ActiveFederation,
} from '../domain';
import type { WalletServiceKind } from '../services/wallet';
import {
  parseWalletProfileV2,
  type WalletIdentityStateV2,
  type WalletProfileV2,
} from '../services/persistence/schemas/wallet-profile';

export const WALLET_RECORD_ID = 'primary-wallet';

interface PersistedActiveFederation {
  federationId: string;
  displayName: string;
  network: string;
  modules: readonly string[];
  guardianCount: number;
  clientName: string;
  joinedAtMs: number;
}

export interface PersistedWalletRecord {
  version: 1;
  mode: WalletServiceKind;
  activeFederation?: PersistedActiveFederation;
}

export interface WalletRecord {
  mode: WalletServiceKind;
  identity?: WalletIdentityStateV2;
  activeFederation?: ActiveFederation;
}

/**
 * Vault payloads must remain JSON-safe. This recursively converts future
 * bigint fields to their canonical decimal-string representation before the
 * persistence layer calls JSON.stringify.
 */
export function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  if (Array.isArray(value)) {
    return value.map(serializeBigInts);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, serializeBigInts(entry)]),
    );
  }

  return value;
}

export function createPersistedWalletRecord(
  mode: WalletServiceKind,
  activeFederation?: ActiveFederation,
): PersistedWalletRecord {
  const value = serializeBigInts({
    version: 1,
    mode,
    activeFederation:
      activeFederation === undefined
        ? undefined
        : {
            federationId: activeFederation.federationId,
            displayName: activeFederation.displayName,
            network: activeFederation.network,
            modules: [...activeFederation.modules],
            guardianCount: activeFederation.guardianCount,
            clientName: activeFederation.clientName,
            joinedAtMs: activeFederation.joinedAtMs,
          },
  });

  return parsePersistedWalletRecord(value);
}

export function parsePersistedWalletRecord(
  value: unknown,
): PersistedWalletRecord {
  if (!isRecord(value) || value.version !== 1 || !isMode(value.mode)) {
    throw new TypeError('Unsupported wallet record.');
  }

  if (value.activeFederation === undefined) {
    return Object.freeze({
      version: 1,
      mode: value.mode,
    });
  }

  const activeFederation = parseActiveFederation(value.activeFederation);
  return Object.freeze({
    version: 1,
    mode: value.mode,
    activeFederation: Object.freeze({
      federationId: activeFederation.federationId,
      displayName: activeFederation.displayName,
      network: activeFederation.network,
      modules: activeFederation.modules,
      guardianCount: activeFederation.guardianCount,
      clientName: activeFederation.clientName,
      joinedAtMs: activeFederation.joinedAtMs,
    }),
  });
}

export function readWalletRecord(value: unknown): WalletRecord {
  const persisted = parsePersistedWalletRecord(value);
  return Object.freeze({
    mode: persisted.mode,
    activeFederation:
      persisted.activeFederation === undefined
        ? undefined
        : parseActiveFederation(persisted.activeFederation),
  });
}

export function createWalletProfileV2(
  mode: WalletServiceKind,
  input: {
    adapterVersion: string;
    identity?: WalletIdentityStateV2;
    activeFederation?: ActiveFederation;
  },
): WalletProfileV2 {
  return parseWalletProfileV2(
    serializeBigInts({
      version: 2,
      mode,
      adapterVersion: input.adapterVersion,
      identity: input.identity ?? { status: 'not-initialized' },
      activeFederation:
        input.activeFederation === undefined
          ? undefined
          : serializeActiveFederation(input.activeFederation),
    }),
  );
}

export function readWalletProfileV2(value: unknown): WalletRecord {
  const persisted = parseWalletProfileV2(value);
  return Object.freeze({
    mode: persisted.mode,
    identity: persisted.identity,
    activeFederation:
      persisted.activeFederation === undefined
        ? undefined
        : parseActiveFederation(persisted.activeFederation),
  });
}

export function walletAdapterVersion(kind: WalletServiceKind): string {
  return kind === 'fedimint' ? '@fedimint/core@0.1.3' : 'fake-wallet@2';
}

function serializeActiveFederation(
  activeFederation: ActiveFederation,
): PersistedActiveFederation {
  return {
    federationId: activeFederation.federationId,
    displayName: activeFederation.displayName,
    network: activeFederation.network,
    modules: [...activeFederation.modules],
    guardianCount: activeFederation.guardianCount,
    clientName: activeFederation.clientName,
    joinedAtMs: activeFederation.joinedAtMs,
  };
}

function parseActiveFederation(value: unknown): ActiveFederation {
  if (
    !isRecord(value) ||
    typeof value.federationId !== 'string' ||
    typeof value.displayName !== 'string' ||
    typeof value.network !== 'string' ||
    !Array.isArray(value.modules) ||
    !value.modules.every((module) => typeof module === 'string') ||
    !isNonNegativeSafeInteger(value.guardianCount) ||
    typeof value.clientName !== 'string' ||
    !isNonNegativeSafeInteger(value.joinedAtMs)
  ) {
    throw new TypeError('Stored federation selection is invalid.');
  }

  return Object.freeze({
    federationId: federationId(value.federationId),
    displayName: value.displayName,
    network: normalizeBitcoinNetwork(value.network),
    modules: Object.freeze([...value.modules]),
    guardianCount: value.guardianCount,
    clientName: clientName(value.clientName),
    joinedAtMs: value.joinedAtMs,
  });
}

function isMode(value: unknown): value is WalletServiceKind {
  return value === 'fake' || value === 'fedimint';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
