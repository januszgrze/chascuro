import { describe, expect, it } from 'vitest';

import { federationId } from './federation';
import { msats } from './money';
import {
  canTransitionOperationStatus,
  createWalletOperation,
  isOperationInFlight,
  isTerminalOperationStatus,
  operationId,
  transitionOperation,
} from './operation';

function operation(
  status: Parameters<typeof createWalletOperation>[0]['status'] = 'created',
) {
  return createWalletOperation({
    key: {
      federationId: federationId('federation-a'),
      operationId: operationId('operation-a'),
    },
    kind: 'lightning_send',
    status,
    createdAtMs: 1_000,
  });
}

describe('operation domain', () => {
  it('supports forward progress to a terminal state', () => {
    const pending = transitionOperation(operation(), 'pending', 2_000);
    expect(pending.outcome).toBe('applied');

    const settled = transitionOperation(pending.operation, 'settled', 3_000);
    expect(settled.outcome).toBe('applied');
    expect(settled.operation.status).toBe('settled');
    expect(isTerminalOperationStatus(settled.operation.status)).toBe(true);
  });

  it('tracks refund progress separately from failure or cancellation', () => {
    const refunding = transitionOperation(
      operation('pending'),
      'refunding',
      2_000,
    );
    expect(refunding.outcome).toBe('applied');
    expect(isOperationInFlight(refunding.operation.status)).toBe(true);

    const refunded = transitionOperation(
      refunding.operation,
      'refunded',
      3_000,
    );
    expect(refunded.outcome).toBe('applied');
    expect(refunded.operation.status).toBe('refunded');
    expect(isTerminalOperationStatus(refunded.operation.status)).toBe(true);
    expect(
      transitionOperation(refunded.operation, 'failed', 4_000),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'terminal_state',
    });
  });

  it('treats duplicate observations idempotently', () => {
    const current = operation('pending');
    const result = transitionOperation(current, 'pending', 2_000);

    expect(result.outcome).toBe('duplicate');
    expect(result.operation).toBe(current);
  });

  it('refuses to regress a terminal operation', () => {
    const settled = operation('settled');
    const result = transitionOperation(settled, 'pending', 2_000);

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'terminal_state',
      operation: settled,
    });
  });

  it('rejects stale and invalid transitions without mutating the operation', () => {
    const pending = createWalletOperation({
      key: {
        federationId: federationId('federation-a'),
        operationId: operationId('operation-a'),
      },
      kind: 'ecash_receive',
      status: 'pending',
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
    });

    expect(transitionOperation(pending, 'settled', 1_999)).toEqual({
      outcome: 'rejected',
      reason: 'stale_timestamp',
      operation: pending,
    });
    expect(
      transitionOperation(pending, 'awaiting_external_payment', 3_000),
    ).toEqual({
      outcome: 'rejected',
      reason: 'invalid_transition',
      operation: pending,
    });
    expect(
      transitionOperation(operation('refunding'), 'pending', 3_000),
    ).toEqual({
      outcome: 'rejected',
      reason: 'invalid_transition',
      operation: operation('refunding'),
    });
  });

  it('keeps unknown non-terminal so later evidence can reconcile it', () => {
    expect(isTerminalOperationStatus('unknown')).toBe(false);
    expect(isOperationInFlight('unknown')).toBe(true);
    expect(canTransitionOperationStatus('unknown', 'settled')).toBe(true);
    expect(canTransitionOperationStatus('unknown', 'created')).toBe(false);
  });

  it('retains sanitized activity and reconciliation metadata', () => {
    const current = createWalletOperation({
      key: {
        federationId: federationId('federation-a'),
        operationId: operationId('operation-a'),
      },
      kind: 'lightning_send',
      direction: 'outgoing',
      status: 'pending',
      amountMsats: msats(10_000n),
      feeMsats: msats(100n),
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      expiresAtMs: 60_000,
      localDescription: 'Coffee',
      guidanceCode: 'reconcile',
      secretRecordRef: 'secret:payment:operation-a',
      reconciliationCursor: 'cursor-a',
      schemaVersion: 2,
      adapterVersion: 'fedimint-0.1.3',
    });

    expect(current).toMatchObject({
      direction: 'outgoing',
      feeMsats: msats(100n),
      expiresAtMs: 60_000,
      localDescription: 'Coffee',
      guidanceCode: 'reconcile',
      secretRecordRef: 'secret:payment:operation-a',
      reconciliationCursor: 'cursor-a',
      schemaVersion: 2,
      adapterVersion: 'fedimint-0.1.3',
    });

    const settled = transitionOperation(current, 'settled', 3_000);
    expect(settled.operation).toMatchObject({
      status: 'settled',
      localDescription: 'Coffee',
      reconciliationCursor: 'cursor-a',
    });
  });

  it('validates operation identifiers and timestamps', () => {
    expect(() => operationId(' ')).toThrow(TypeError);
    expect(() =>
      createWalletOperation({
        key: {
          federationId: federationId('federation-a'),
          operationId: operationId('operation-a'),
        },
        kind: 'unknown',
        createdAtMs: 2_000,
        updatedAtMs: 1_000,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createWalletOperation({
        key: {
          federationId: federationId('federation-a'),
          operationId: operationId('operation-a'),
        },
        kind: 'unknown',
        createdAtMs: 2_000,
        expiresAtMs: 1_000,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createWalletOperation({
        key: {
          federationId: federationId('federation-a'),
          operationId: operationId('operation-a'),
        },
        kind: 'unknown',
        createdAtMs: 1_000,
        schemaVersion: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createWalletOperation({
        key: {
          federationId: federationId('federation-a'),
          operationId: operationId('operation-a'),
        },
        kind: 'unknown',
        createdAtMs: 1_000,
        localDescription: ' unsafe ',
      }),
    ).toThrow(TypeError);
  });
});
