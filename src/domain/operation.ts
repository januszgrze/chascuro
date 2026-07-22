import type { FederationId } from './federation';
import type { Msats } from './money';

declare const operationIdBrand: unique symbol;

export type OperationId = string & {
  readonly [operationIdBrand]: 'OperationId';
};

export type OperationKind =
  | 'federation_join'
  | 'ecash_receive'
  | 'ecash_send'
  | 'lightning_receive'
  | 'lightning_send'
  | 'unknown';

export type OperationDirection =
  'incoming' | 'outgoing' | 'neutral' | 'unknown';

export type OperationStatus =
  | 'created'
  | 'awaiting_external_payment'
  | 'pending'
  | 'refunding'
  | 'settled'
  | 'refunded'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'unknown';

export type TerminalOperationStatus =
  'settled' | 'refunded' | 'failed' | 'expired' | 'cancelled';

export type InFlightOperationStatus = Exclude<
  OperationStatus,
  TerminalOperationStatus
>;

export type OperationGuidanceCode =
  | 'retry'
  | 'reconcile'
  | 'await_external_payment'
  | 'await_refund'
  | 'contact_support'
  | 'unknown';

export interface OperationKey {
  readonly federationId: FederationId;
  readonly operationId: OperationId;
}

export interface WalletOperation {
  readonly key: OperationKey;
  readonly kind: OperationKind;
  readonly direction?: OperationDirection;
  readonly status: OperationStatus;
  readonly amountMsats?: Msats;
  readonly feeMsats?: Msats;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly expiresAtMs?: number;
  readonly localDescription?: string;
  readonly guidanceCode?: OperationGuidanceCode;
  readonly secretRecordRef?: string;
  readonly reconciliationCursor?: string;
  readonly schemaVersion?: number;
  readonly adapterVersion?: string;
}

export type OperationTransitionResult =
  | {
      readonly outcome: 'applied';
      readonly operation: WalletOperation;
    }
  | {
      readonly outcome: 'duplicate';
      readonly operation: WalletOperation;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason:
        'terminal_state' | 'invalid_transition' | 'stale_timestamp';
      readonly operation: WalletOperation;
    };

const TERMINAL_STATUSES: ReadonlySet<TerminalOperationStatus> = new Set([
  'settled',
  'refunded',
  'failed',
  'expired',
  'cancelled',
]);

const TERMINAL_STATUS_SET: ReadonlySet<OperationStatus> = TERMINAL_STATUSES;

const ALLOWED_NEXT_STATUSES: Readonly<
  Record<InFlightOperationStatus, ReadonlySet<OperationStatus>>
> = {
  created: new Set([
    'awaiting_external_payment',
    'pending',
    'refunding',
    'settled',
    'refunded',
    'failed',
    'expired',
    'cancelled',
    'unknown',
  ]),
  awaiting_external_payment: new Set([
    'pending',
    'refunding',
    'settled',
    'refunded',
    'failed',
    'expired',
    'cancelled',
    'unknown',
  ]),
  pending: new Set([
    'refunding',
    'settled',
    'refunded',
    'failed',
    'expired',
    'cancelled',
    'unknown',
  ]),
  refunding: new Set(TERMINAL_STATUS_SET),
  unknown: new Set([
    'awaiting_external_payment',
    'pending',
    'refunding',
    'settled',
    'refunded',
    'failed',
    'expired',
    'cancelled',
  ]),
};

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Timestamp must be a non-negative safe integer.');
  }
}

function assertOptionalNonEmptyString(
  value: string | undefined,
  fieldName: string,
): void {
  if (value !== undefined && (value.length === 0 || value.trim() !== value)) {
    throw new TypeError(
      `${fieldName} must be non-empty with no outer whitespace.`,
    );
  }
}

export function operationId(value: string): OperationId {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(
      'Operation identifier must be non-empty and have no outer whitespace.',
    );
  }

  return value as OperationId;
}

export function isTerminalOperationStatus(
  status: OperationStatus,
): status is TerminalOperationStatus {
  return TERMINAL_STATUSES.has(status as TerminalOperationStatus);
}

export function isOperationInFlight(status: OperationStatus): boolean {
  return !isTerminalOperationStatus(status);
}

export function canTransitionOperationStatus(
  current: OperationStatus,
  next: OperationStatus,
): boolean {
  if (current === next) {
    return true;
  }

  if (isTerminalOperationStatus(current)) {
    return false;
  }

  return ALLOWED_NEXT_STATUSES[current].has(next);
}

export function createWalletOperation(input: {
  key: OperationKey;
  kind: OperationKind;
  direction?: OperationDirection;
  status?: OperationStatus;
  amountMsats?: Msats;
  feeMsats?: Msats;
  createdAtMs: number;
  updatedAtMs?: number;
  expiresAtMs?: number;
  localDescription?: string;
  guidanceCode?: OperationGuidanceCode;
  secretRecordRef?: string;
  reconciliationCursor?: string;
  schemaVersion?: number;
  adapterVersion?: string;
}): WalletOperation {
  assertTimestamp(input.createdAtMs);
  const updatedAtMs = input.updatedAtMs ?? input.createdAtMs;
  assertTimestamp(updatedAtMs);

  if (updatedAtMs < input.createdAtMs) {
    throw new RangeError('Updated timestamp must not precede creation.');
  }

  if (input.expiresAtMs !== undefined) {
    assertTimestamp(input.expiresAtMs);
    if (input.expiresAtMs < input.createdAtMs) {
      throw new RangeError('Expiry timestamp must not precede creation.');
    }
  }

  if (
    input.schemaVersion !== undefined &&
    (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1)
  ) {
    throw new RangeError('Schema version must be a positive safe integer.');
  }

  assertOptionalNonEmptyString(input.localDescription, 'Local description');
  assertOptionalNonEmptyString(
    input.secretRecordRef,
    'Secret record reference',
  );
  assertOptionalNonEmptyString(
    input.reconciliationCursor,
    'Reconciliation cursor',
  );
  assertOptionalNonEmptyString(input.adapterVersion, 'Adapter version');

  return Object.freeze({
    key: Object.freeze({ ...input.key }),
    kind: input.kind,
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    status: input.status ?? 'created',
    ...(input.amountMsats === undefined
      ? {}
      : { amountMsats: input.amountMsats }),
    ...(input.feeMsats === undefined ? {} : { feeMsats: input.feeMsats }),
    createdAtMs: input.createdAtMs,
    updatedAtMs,
    ...(input.expiresAtMs === undefined
      ? {}
      : { expiresAtMs: input.expiresAtMs }),
    ...(input.localDescription === undefined
      ? {}
      : { localDescription: input.localDescription }),
    ...(input.guidanceCode === undefined
      ? {}
      : { guidanceCode: input.guidanceCode }),
    ...(input.secretRecordRef === undefined
      ? {}
      : { secretRecordRef: input.secretRecordRef }),
    ...(input.reconciliationCursor === undefined
      ? {}
      : { reconciliationCursor: input.reconciliationCursor }),
    ...(input.schemaVersion === undefined
      ? {}
      : { schemaVersion: input.schemaVersion }),
    ...(input.adapterVersion === undefined
      ? {}
      : { adapterVersion: input.adapterVersion }),
  });
}

/**
 * Applies an observed status without allowing late callbacks to regress a
 * terminal or later-stage operation. Duplicate observations are idempotent and
 * retain the existing object reference.
 */
export function transitionOperation(
  operation: WalletOperation,
  nextStatus: OperationStatus,
  observedAtMs: number,
): OperationTransitionResult {
  assertTimestamp(observedAtMs);

  if (nextStatus === operation.status) {
    return { outcome: 'duplicate', operation };
  }

  if (observedAtMs < operation.updatedAtMs) {
    return {
      outcome: 'rejected',
      reason: 'stale_timestamp',
      operation,
    };
  }

  if (isTerminalOperationStatus(operation.status)) {
    return {
      outcome: 'rejected',
      reason: 'terminal_state',
      operation,
    };
  }

  if (!canTransitionOperationStatus(operation.status, nextStatus)) {
    return {
      outcome: 'rejected',
      reason: 'invalid_transition',
      operation,
    };
  }

  return {
    outcome: 'applied',
    operation: Object.freeze({
      ...operation,
      status: nextStatus,
      updatedAtMs: observedAtMs,
    }),
  };
}
