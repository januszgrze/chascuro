import type { GatewayInfo } from '@fedimint/core';

import {
  candidateId,
  createWalletOperation,
  federationId,
  msats,
  normalizeBitcoinNetwork,
  normalizeFederationModules,
  operationId,
  paymentFingerprint,
  sanitizeGuardianOrigins,
  WalletError,
  type ActiveFederation,
  type BitcoinNetwork,
  type FederationCandidate,
  type Msats,
  type OperationKey,
  type OperationStatus,
  type PaymentFingerprint,
  type SensitiveInput,
  type TrackedOperation,
  type WalletOperation,
} from '../../domain';

export type SdkOperationFlow =
  | 'ecash-redeem'
  | 'ecash-spend'
  | 'lightning-receive'
  | 'lightning-pay'
  | 'lightning-internal-pay';

export function sanitizeFederationPreview(
  preview: {
    config: unknown;
    federation_id: string;
  },
  id: string,
  expiresAtMs: number,
): FederationCandidate {
  const config = asRecord(preview.config) ?? {};
  const modules = federationModuleEntries(
    config.modules ?? asRecord(config.consensus)?.modules,
  );
  const moduleNames = modules
    .map((module) => module.kind)
    .filter((kind): kind is string => typeof kind === 'string');
  const endpoints =
    asRecord(asRecord(config.global)?.api_endpoints) ??
    asRecord(config.api_endpoints);
  const name =
    readString(config, ['global', 'meta', 'federation_name']) ??
    readString(config, ['meta', 'federation_name']) ??
    'Fedimint federation';
  const network = findFederationNetwork(config, modules);

  return Object.freeze({
    candidateId: candidateId(id),
    federationId: federationId(preview.federation_id),
    displayName: name,
    network,
    modules: normalizeFederationModules(moduleNames),
    guardianCount: endpoints === undefined ? 0 : Object.keys(endpoints).length,
    guardianOrigins: sanitizeGuardianOrigins(
      endpoints === undefined ? [] : Object.values(endpoints),
    ),
    expiresAtMs,
  });
}

function federationModuleEntries(value: unknown): Record<string, unknown>[] {
  const entries = Array.isArray(value)
    ? value
    : Object.values(asRecord(value) ?? {});
  return entries
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

function findFederationNetwork(
  config: Record<string, unknown>,
  modules: readonly Record<string, unknown>[],
): BitcoinNetwork {
  const moduleNetworks = new Set<BitcoinNetwork>();
  for (const module of modules) {
    const kind = typeof module.kind === 'string' ? module.kind : '';
    if (!['wallet', 'walletv2', 'ln', 'lnv2'].includes(kind.toLowerCase())) {
      continue;
    }
    collectNetworkValues(module.config ?? module, moduleNetworks);
  }

  if (moduleNetworks.size === 1) {
    return [...moduleNetworks][0] ?? 'unknown';
  }
  if (moduleNetworks.size > 1) {
    return 'unknown';
  }

  const configNetworks = new Set<BitcoinNetwork>();
  collectNetworkValues(config, configNetworks);
  return configNetworks.size === 1
    ? ([...configNetworks][0] ?? 'unknown')
    : 'unknown';
}

function collectNetworkValues(
  value: unknown,
  networks: Set<BitcoinNetwork>,
  depth = 0,
): void {
  if (depth > 10) {
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      collectNetworkValues(child, networks, depth + 1);
    }
    return;
  }

  const record = asRecord(value);
  if (record === undefined) {
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[-_]/g, '');
    if (normalizedKey === 'network' || normalizedKey === 'bitcoinnetwork') {
      const network = normalizeBitcoinNetwork(child);
      if (network !== 'unknown') {
        networks.add(network);
      }
    }
    collectNetworkValues(child, networks, depth + 1);
  }
}

interface FederationNetworkDiagnostic {
  readonly path: string;
  readonly valueType: string;
  readonly recognizedNetwork: BitcoinNetwork;
}

interface FederationModuleNetworkDiagnostic {
  readonly kind?: string;
  readonly configType: string;
  readonly configKeys?: readonly string[];
  readonly networkFields: readonly FederationNetworkDiagnostic[];
}

interface FederationNetworkDiagnostics {
  readonly configType: string;
  readonly configKeys?: readonly string[];
  readonly moduleSource: 'modules' | 'consensus.modules' | 'unavailable';
  readonly modules: readonly FederationModuleNetworkDiagnostic[];
  readonly configNetworkFields: readonly FederationNetworkDiagnostic[];
}

export function describeFederationNetworkDiagnostics(
  rawConfig: unknown,
): FederationNetworkDiagnostics {
  const config = asRecord(rawConfig);
  const moduleValue = config?.modules ?? asRecord(config?.consensus)?.modules;
  const moduleSource =
    config?.modules !== undefined
      ? 'modules'
      : asRecord(config?.consensus)?.modules !== undefined
        ? 'consensus.modules'
        : 'unavailable';
  const modules = federationModuleEntries(moduleValue).map((module) => {
    const moduleConfig = module.config ?? module;
    return Object.freeze({
      ...(typeof module.kind === 'string' ? { kind: module.kind } : {}),
      configType: describeValueType(moduleConfig),
      ...(asRecord(moduleConfig) === undefined
        ? {}
        : { configKeys: Object.keys(asRecord(moduleConfig) ?? {}).sort() }),
      networkFields: Object.freeze(collectNetworkDiagnostics(moduleConfig)),
    });
  });

  return Object.freeze({
    configType: describeValueType(rawConfig),
    ...(config === undefined ? {} : { configKeys: Object.keys(config).sort() }),
    moduleSource,
    modules: Object.freeze(modules),
    configNetworkFields: Object.freeze(collectNetworkDiagnostics(rawConfig)),
  });
}

function collectNetworkDiagnostics(
  value: unknown,
  path = 'config',
  depth = 0,
): FederationNetworkDiagnostic[] {
  if (depth > 10) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      collectNetworkDiagnostics(child, `${path}[${index}]`, depth + 1),
    );
  }

  const record = asRecord(value);
  if (record === undefined) {
    return [];
  }

  const diagnostics: FederationNetworkDiagnostic[] = [];
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    const normalizedKey = key.toLowerCase().replaceAll(/[-_]/g, '');
    if (normalizedKey === 'network' || normalizedKey === 'bitcoinnetwork') {
      diagnostics.push(
        Object.freeze({
          path: childPath,
          valueType: describeValueType(child),
          recognizedNetwork: normalizeBitcoinNetwork(child),
        }),
      );
    }
    diagnostics.push(...collectNetworkDiagnostics(child, childPath, depth + 1));
  }
  return diagnostics;
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

export function describeBolt11ParseResponse(value: unknown): {
  readonly type: string;
  readonly keys?: readonly string[];
  readonly amountType?: string;
  readonly expiryType?: string;
  readonly memoType?: string;
} {
  const record = asRecord(value);
  if (record === undefined) {
    return Object.freeze({ type: describeValueType(value) });
  }
  return Object.freeze({
    type: 'object',
    keys: Object.freeze(Object.keys(record).sort()),
    amountType: describeValueType(record.amount),
    expiryType: describeValueType(record.expiry),
    memoType: describeValueType(record.memo),
  });
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  value: Record<string, unknown>,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === 'string' ? current : undefined;
}

interface Bolt11Header {
  readonly network: BitcoinNetwork;
  readonly timestampSeconds: number;
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export function parseBolt11Header(invoice: string): Bolt11Header | undefined {
  if (
    invoice.length === 0 ||
    (invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase())
  ) {
    return undefined;
  }
  const normalized = invoice.toLowerCase();
  const separator = normalized.lastIndexOf('1');
  if (separator < 4 || normalized.length - separator - 1 < 7) {
    return undefined;
  }
  const hrp = normalized.slice(0, separator);
  const network: BitcoinNetwork = hrp.startsWith('lnbcrt')
    ? 'regtest'
    : hrp.startsWith('lnbc')
      ? 'bitcoin'
      : hrp.startsWith('lntb')
        ? 'testnet'
        : 'unknown';
  if (network === 'unknown') {
    return undefined;
  }

  let timestampSeconds = 0;
  for (const character of normalized.slice(separator + 1, separator + 8)) {
    const value = BECH32_CHARSET.indexOf(character);
    if (value < 0) {
      return undefined;
    }
    timestampSeconds = timestampSeconds * 32 + value;
  }
  return Number.isSafeInteger(timestampSeconds)
    ? Object.freeze({ network, timestampSeconds })
    : undefined;
}

export function isInvoiceNetworkCompatible(
  invoiceNetwork: BitcoinNetwork,
  federationNetwork: BitcoinNetwork,
): boolean {
  return (
    // Some federation configurations do not expose a network in their SDK
    // preview. Once the user has explicitly trusted and joined one, defer
    // enforcement to its Lightning gateway rather than blocking every invoice
    // client-side. Known networks retain strict mismatch protection below.
    federationNetwork === 'unknown' ||
    invoiceNetwork === federationNetwork ||
    (invoiceNetwork === 'testnet' && federationNetwork === 'signet') ||
    (invoiceNetwork === 'signet' && federationNetwork === 'testnet')
  );
}

interface GatewayFeePolicy {
  readonly baseMsats: bigint;
  readonly partsPerMillion: bigint;
}

export function parseGatewayFeePolicy(
  value: unknown,
): GatewayFeePolicy | undefined {
  const fees = asRecord(value);
  if (fees === undefined) {
    return undefined;
  }
  const base = firstSafeNonNegativeInteger(fees, [
    'base_msat',
    'base_msats',
    'base',
  ]);
  const partsPerMillion = firstSafeNonNegativeInteger(fees, [
    'proportional_millionths',
    'parts_per_million',
    'ppm',
  ]);
  return base === undefined || partsPerMillion === undefined
    ? undefined
    : Object.freeze({
        baseMsats: BigInt(base),
        partsPerMillion: BigInt(partsPerMillion),
      });
}

function firstSafeNonNegativeInteger(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (
      typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
    ) {
      return candidate;
    }
  }
  return undefined;
}

export function quoteGatewayFee(
  gateway: GatewayInfo | undefined,
  amountMsats: Msats,
): Msats | undefined {
  if (
    gateway === undefined ||
    typeof gateway.gateway_id !== 'string' ||
    gateway.gateway_id.length === 0
  ) {
    return undefined;
  }
  const policy = parseGatewayFeePolicy(gateway.fees);
  if (policy === undefined) {
    return undefined;
  }
  const proportional =
    (amountMsats * policy.partsPerMillion + 999_999n) / 1_000_000n;
  return msats(policy.baseMsats + proportional);
}

export function checkedSdkMsats(value: number): Msats {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WalletError('sdk_unavailable');
  }
  return msats(BigInt(value));
}

export function checkedMsatsToSdkNumber(value: Msats): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new WalletError('invalid_input');
  }
  return amount;
}

export async function fingerprintSensitiveInput(
  value: SensitiveInput,
): Promise<PaymentFingerprint> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  const encoded = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return paymentFingerprint(`sha256:${encoded}`);
}

export function operationMapKey(key: OperationKey): string {
  return `${key.federationId}:${key.operationId}`;
}

export function sdkOperationFlow(
  operation: WalletOperation,
): SdkOperationFlow | undefined {
  switch (operation.kind) {
    case 'ecash_receive':
      return 'ecash-redeem';
    case 'ecash_send':
      return 'ecash-spend';
    case 'lightning_receive':
      return 'lightning-receive';
    case 'lightning_send':
      return operation.reconciliationCursor === 'lightning:internal'
        ? 'lightning-internal-pay'
        : 'lightning-pay';
    default:
      return undefined;
  }
}

export function trackedOperation(operation: WalletOperation): TrackedOperation {
  return Object.freeze({
    operationId: operation.key.operationId,
    operation,
  });
}

export function normalizeReissueState(
  state: 'Created' | 'Issuing' | 'Done',
): OperationStatus {
  switch (state) {
    case 'Created':
      return 'created';
    case 'Issuing':
      return 'pending';
    case 'Done':
      return 'settled';
  }
}

export function normalizeSpendState(
  state:
    | 'Created'
    | 'UserCanceledProcessing'
    | 'UserCanceledSuccess'
    | 'UserCanceledFailure'
    | 'Success'
    | 'Refunded',
): OperationStatus {
  switch (state) {
    case 'Created':
      return 'created';
    case 'UserCanceledProcessing':
      return 'refunding';
    case 'UserCanceledSuccess':
    case 'Refunded':
      return 'refunded';
    case 'UserCanceledFailure':
      return 'failed';
    case 'Success':
      // Live fixtures are required before treating this as recipient redemption.
      return 'unknown';
  }
}

export function normalizeLnReceiveState(
  state:
    | 'created'
    | { waiting_for_payment: { invoice: string; timeout: number } }
    | { canceled: { reason: string } }
    | 'funded'
    | 'awaiting_funds'
    | 'claimed',
): OperationStatus {
  if (
    state === 'created' ||
    asRecord(state)?.waiting_for_payment !== undefined
  ) {
    return 'awaiting_external_payment';
  }
  if (state === 'funded' || state === 'awaiting_funds') {
    return 'pending';
  }
  if (state === 'claimed') {
    return 'settled';
  }
  if (asRecord(state)?.canceled !== undefined) {
    return 'cancelled';
  }
  return 'unknown';
}

export function normalizeLnPayState(
  state:
    | 'created'
    | 'canceled'
    | { funded: { block_height: number } }
    | { waiting_for_refund: { error_reason: string } }
    | 'awaiting_change'
    | { success: { preimage: string } }
    | { refunded: { gateway_error: string } }
    | { unexpected_error: { error_message: string } },
): OperationStatus {
  if (state === 'created' || state === 'awaiting_change') {
    return 'pending';
  }
  if (state === 'canceled') {
    return 'cancelled';
  }
  const record = asRecord(state);
  if (record?.funded !== undefined) {
    return 'pending';
  }
  if (record?.waiting_for_refund !== undefined) {
    return 'refunding';
  }
  if (record?.success !== undefined) {
    return 'settled';
  }
  if (record?.refunded !== undefined) {
    return 'refunded';
  }
  if (record?.unexpected_error !== undefined) {
    return 'failed';
  }
  return 'unknown';
}

export function normalizeInternalPayState(
  state:
    | 'funding'
    | { preimage: string }
    | { refund_success: { out_points: unknown[]; error: string } }
    | { refund_error: { error_message: string; error: string } }
    | { funding_failed: { error: string } }
    | { unexpected_error: string },
): OperationStatus {
  if (state === 'funding') {
    return 'pending';
  }
  const record = asRecord(state);
  if (record?.preimage !== undefined) {
    return 'settled';
  }
  if (record?.refund_success !== undefined) {
    return 'refunded';
  }
  if (
    record?.refund_error !== undefined ||
    record?.funding_failed !== undefined ||
    record?.unexpected_error !== undefined
  ) {
    return 'failed';
  }
  return 'unknown';
}

export function isTerminalAdapterStatus(status: OperationStatus): boolean {
  return (
    status === 'settled' ||
    status === 'refunded' ||
    status === 'failed' ||
    status === 'expired' ||
    status === 'cancelled'
  );
}

export function sanitizeSdkOperation(
  value: unknown,
  activeFederationId: ActiveFederation['federationId'],
  observedAtMs = Date.now(),
): WalletOperation | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }
  const key = asRecord(value[0]);
  const log = asRecord(value[1]);
  const sdkOperationId = key?.operation_id;
  const creationTime = asRecord(key?.creation_time);
  const seconds = creationTime?.secs_since_epoch;
  const nanos = creationTime?.nanos_since_epoch;
  if (
    typeof sdkOperationId !== 'string' ||
    sdkOperationId.length === 0 ||
    !Number.isSafeInteger(seconds) ||
    Number(seconds) < 0 ||
    !Number.isSafeInteger(nanos) ||
    Number(nanos) < 0
  ) {
    return undefined;
  }

  const createdAtMs = Math.round(
    Number(seconds) * 1000 + Number(nanos) / 1_000_000,
  );
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    return undefined;
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    return undefined;
  }

  const meta = asRecord(log?.meta);
  const variant = asRecord(meta?.variant);
  const moduleKind = log?.operation_module_kind;
  let kind: WalletOperation['kind'] = 'unknown';
  let direction: WalletOperation['direction'] = 'unknown';
  let feeMsats: Msats | undefined;

  if (moduleKind === 'mint') {
    if (asRecord(variant?.spend_o_o_b) !== undefined) {
      kind = 'ecash_send';
      direction = 'outgoing';
    } else if (asRecord(variant?.reissuance) !== undefined) {
      kind = 'ecash_receive';
      direction = 'incoming';
    }
  } else if (moduleKind === 'ln') {
    const pay = asRecord(variant?.pay);
    if (pay !== undefined) {
      kind = 'lightning_send';
      direction = 'outgoing';
      if (typeof pay.fee === 'number') {
        try {
          feeMsats = checkedSdkMsats(pay.fee);
        } catch {
          feeMsats = undefined;
        }
      }
    } else if (asRecord(variant?.receive) !== undefined) {
      kind = 'lightning_receive';
      direction = 'incoming';
    }
  }

  let amountMsats: Msats | undefined;
  if (typeof meta?.amount === 'number') {
    try {
      amountMsats = checkedSdkMsats(meta.amount);
    } catch {
      amountMsats = undefined;
    }
  }
  const outcomeContainer = asRecord(log?.outcome);
  const rawOutcome = outcomeContainer?.outcome;
  const status =
    kind === 'ecash_send' && isGenericSdkSuccess(rawOutcome)
      ? 'unknown'
      : normalizeUnknownSdkState(rawOutcome);

  try {
    return createWalletOperation({
      key: {
        federationId: activeFederationId,
        operationId: operationId(sdkOperationId),
      },
      kind,
      direction,
      status,
      createdAtMs,
      updatedAtMs: Math.max(createdAtMs, observedAtMs),
      schemaVersion: 2,
      adapterVersion: 'fedimint-core-0.1.3',
      ...(amountMsats === undefined ? {} : { amountMsats }),
      ...(feeMsats === undefined ? {} : { feeMsats }),
    });
  } catch {
    return undefined;
  }
}

function isGenericSdkSuccess(value: unknown): boolean {
  if (value === 'success' || value === 'Success') {
    return true;
  }
  const record = asRecord(value);
  return record?.success !== undefined || record?.Success !== undefined;
}

function normalizeUnknownSdkState(value: unknown): OperationStatus {
  if (typeof value === 'string') {
    switch (value) {
      case 'Created':
      case 'created':
        return 'created';
      case 'Issuing':
      case 'funded':
      case 'awaiting_funds':
      case 'awaiting_change':
        return 'pending';
      case 'Done':
      case 'claimed':
      case 'success':
        return 'settled';
      case 'UserCanceledProcessing':
      case 'waiting_for_refund':
        return 'refunding';
      case 'UserCanceledSuccess':
      case 'Refunded':
      case 'refunded':
        return 'refunded';
      case 'UserCanceledFailure':
      case 'unexpected_error':
        return 'failed';
      case 'canceled':
        return 'cancelled';
      default:
        return 'unknown';
    }
  }

  const record = asRecord(value);
  if (record === undefined) {
    return 'unknown';
  }
  if (record.waiting_for_payment !== undefined) {
    return 'awaiting_external_payment';
  }
  if (
    record.funded !== undefined ||
    record.awaiting_funds !== undefined ||
    record.awaiting_change !== undefined
  ) {
    return 'pending';
  }
  if (record.waiting_for_refund !== undefined) {
    return 'refunding';
  }
  if (record.success !== undefined || record.claimed !== undefined) {
    return 'settled';
  }
  if (record.refunded !== undefined) {
    return 'refunded';
  }
  if (
    record.unexpected_error !== undefined ||
    record.UserCanceledFailure !== undefined
  ) {
    return 'failed';
  }
  if (record.canceled !== undefined) {
    return 'cancelled';
  }
  return 'unknown';
}
