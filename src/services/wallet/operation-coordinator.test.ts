import { describe, expect, it, vi } from 'vitest';

import {
  createWalletOperation,
  federationId,
  operationId,
  type OperationKey,
  type OperationStatus,
  type WalletOperation,
} from '../../domain';
import {
  OperationCoordinator,
  OperationSubscriptionRegistry,
  type OperationObservationListener,
} from './operation-coordinator';

function operationKey(name: string): OperationKey {
  return {
    federationId: federationId('federation-a'),
    operationId: operationId(name),
  };
}

function operation(
  name: string,
  status: OperationStatus = 'created',
  updatedAtMs = 1_000,
): WalletOperation {
  return createWalletOperation({
    key: operationKey(name),
    kind: 'lightning_send',
    direction: 'outgoing',
    status,
    createdAtMs: 1_000,
    updatedAtMs,
  });
}

describe('OperationSubscriptionRegistry', () => {
  it('shares one source subscription and tears it down after the last lease', () => {
    const callbacks: OperationObservationListener[] = [];
    const teardown = vi.fn();
    const subscribeToOperation = vi.fn((_key, listener) => {
      callbacks.push(listener);
      return teardown;
    });
    const registry = new OperationSubscriptionRegistry(subscribeToOperation);
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    const releaseFirst = registry.subscribe(
      operationKey('operation-a'),
      firstListener,
    );
    const releaseSecond = registry.subscribe(
      operationKey('operation-a'),
      secondListener,
    );

    expect(subscribeToOperation).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);

    callbacks[0]?.({ status: 'pending', observedAtMs: 2_000 });
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(teardown).not.toHaveBeenCalled();
    releaseSecond();
    releaseSecond();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);

    callbacks[0]?.({ status: 'settled', observedAtMs: 3_000 });
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);
  });

  it('delivers synchronous source observations and rejects old callbacks', () => {
    const callbacks: OperationObservationListener[] = [];
    const teardowns: ReturnType<typeof vi.fn>[] = [];
    const subscribeToOperation = vi.fn((_key, listener) => {
      callbacks.push(listener);
      const teardown = vi.fn();
      teardowns.push(teardown);
      if (callbacks.length === 1) {
        listener({ status: 'pending', observedAtMs: 2_000 });
      }
      return teardown;
    });
    const registry = new OperationSubscriptionRegistry(subscribeToOperation);
    const listener = vi.fn();

    const release = registry.subscribe(operationKey('operation-a'), listener);
    expect(listener).toHaveBeenCalledWith({
      status: 'pending',
      observedAtMs: 2_000,
    });

    release();
    registry.subscribe(operationKey('operation-a'), listener);
    callbacks[0]?.({ status: 'settled', observedAtMs: 3_000 });
    expect(listener).toHaveBeenCalledTimes(1);

    callbacks[1]?.({ status: 'settled', observedAtMs: 3_000 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(teardowns[0]).toHaveBeenCalledTimes(1);
  });
});

describe('OperationCoordinator', () => {
  it('lists newest activity first', () => {
    const coordinator = new OperationCoordinator({
      subscribeToOperation: () => () => undefined,
    });

    coordinator.track(operation('older', 'pending', 2_000));
    coordinator.track(operation('newer', 'pending', 3_000));

    expect(coordinator.list().map((entry) => entry.key.operationId)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('deduplicates tracking and stops automatically at a refunded terminal state', () => {
    const callbacks: OperationObservationListener[] = [];
    const teardowns: ReturnType<typeof vi.fn>[] = [];
    const subscribeToOperation = vi.fn((_key, listener) => {
      callbacks.push(listener);
      const teardown = vi.fn();
      teardowns.push(teardown);
      return teardown;
    });
    const coordinator = new OperationCoordinator({
      subscribeToOperation,
    });
    const listener = vi.fn();
    coordinator.subscribe(listener);
    const initial = operation('operation-a', 'pending', 2_000);

    expect(coordinator.track(initial).outcome).toBe('registered');
    expect(coordinator.track(initial).outcome).toBe('duplicate');
    expect(subscribeToOperation).toHaveBeenCalledTimes(1);

    callbacks[0]?.({ status: 'refunding', observedAtMs: 3_000 });
    callbacks[0]?.({ status: 'refunded', observedAtMs: 4_000 });

    expect(coordinator.get(initial.key)?.status).toBe('refunded');
    expect(coordinator.activeSubscriptionCount).toBe(0);
    expect(teardowns[0]).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(3);

    callbacks[0]?.({ status: 'pending', observedAtMs: 5_000 });
    expect(coordinator.get(initial.key)?.status).toBe('refunded');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(
      coordinator.observe(initial.key, {
        status: 'refunded',
        observedAtMs: 6_000,
      }),
    ).toMatchObject({ outcome: 'duplicate' });
  });

  it('tears down a source that reaches terminal state during subscription setup', () => {
    const teardown = vi.fn();
    const coordinator = new OperationCoordinator({
      subscribeToOperation: (_key, listener) => {
        listener({ status: 'settled', observedAtMs: 2_000 });
        return teardown;
      },
    });
    const initial = operation('operation-a');

    coordinator.track(initial);

    expect(coordinator.get(initial.key)?.status).toBe('settled');
    expect(coordinator.activeSubscriptionCount).toBe(0);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('rejects stale timestamps and forward-timestamp regressions', () => {
    const coordinator = new OperationCoordinator({
      subscribeToOperation: () => () => undefined,
    });
    const initial = operation('operation-a', 'pending', 2_000);
    coordinator.track(initial);

    expect(
      coordinator.observe(initial.key, {
        status: 'settled',
        observedAtMs: 1_999,
      }),
    ).toEqual({
      outcome: 'rejected',
      reason: 'stale_timestamp',
      operation: initial,
    });
    expect(
      coordinator.observe(initial.key, {
        status: 'awaiting_external_payment',
        observedAtMs: 3_000,
      }),
    ).toEqual({
      outcome: 'rejected',
      reason: 'invalid_transition',
      operation: initial,
    });
    expect(coordinator.get(initial.key)).toBe(initial);
  });

  it('can restart tracking without accepting callbacks from the old entry', () => {
    const callbacks: OperationObservationListener[] = [];
    const teardowns: ReturnType<typeof vi.fn>[] = [];
    const subscribeToOperation = vi.fn((_key, listener) => {
      callbacks.push(listener);
      const teardown = vi.fn();
      teardowns.push(teardown);
      return teardown;
    });
    const coordinator = new OperationCoordinator({
      subscribeToOperation,
    });
    const initial = operation('operation-a');

    coordinator.track(initial);
    expect(coordinator.stop(initial.key)).toBe(true);
    expect(teardowns[0]).toHaveBeenCalledTimes(1);

    callbacks[0]?.({ status: 'settled', observedAtMs: 2_000 });
    expect(coordinator.get(initial.key)?.status).toBe('created');

    coordinator.track(initial);
    expect(subscribeToOperation).toHaveBeenCalledTimes(2);

    callbacks[0]?.({ status: 'settled', observedAtMs: 3_000 });
    expect(coordinator.get(initial.key)?.status).toBe('created');
    callbacks[1]?.({ status: 'pending', observedAtMs: 2_000 });
    expect(coordinator.get(initial.key)?.status).toBe('pending');
  });

  it('deduplicates reconciliation and merges terminal and newly found operations', async () => {
    const teardowns: ReturnType<typeof vi.fn>[] = [];
    const subscribeToOperation = vi.fn(() => {
      const teardown = vi.fn();
      teardowns.push(teardown);
      return teardown;
    });
    let resolveReconciliation:
      ((operations: readonly WalletOperation[]) => void) | undefined;
    const reconciliationPromise = new Promise<readonly WalletOperation[]>(
      (resolve) => {
        resolveReconciliation = resolve;
      },
    );
    const reconcileOperations = vi.fn((known: readonly WalletOperation[]) => {
      expect(Object.isFrozen(known)).toBe(true);
      return reconciliationPromise;
    });
    const coordinator = new OperationCoordinator({
      subscribeToOperation,
      reconcileOperations,
    });
    const existing = operation('operation-a', 'pending', 2_000);
    coordinator.track(existing);

    const first = coordinator.reconcile();
    const second = coordinator.reconcile();
    expect(second).toBe(first);
    expect(reconcileOperations).toHaveBeenCalledTimes(1);
    expect(reconcileOperations.mock.calls[0]?.[0]).toEqual([existing]);

    resolveReconciliation?.([
      operation('operation-a', 'settled', 3_000),
      operation('operation-b', 'created', 1_000),
      operation('operation-a', 'created', 1_000),
    ]);

    await expect(first).resolves.toEqual({
      received: 3,
      registered: 1,
      applied: 1,
      duplicate: 0,
      rejected: 1,
      ignoredBecauseClosed: false,
    });
    expect(coordinator.get(existing.key)?.status).toBe('settled');
    expect(coordinator.get(operationKey('operation-b'))?.status).toBe(
      'created',
    );
    expect(subscribeToOperation).toHaveBeenCalledTimes(2);
    expect(teardowns[0]).toHaveBeenCalledTimes(1);
    expect(coordinator.activeSubscriptionCount).toBe(1);
  });

  it('tears down deterministically and ignores late reconciliation after close', async () => {
    const callbacks: OperationObservationListener[] = [];
    const teardowns: ReturnType<typeof vi.fn>[] = [];
    const subscribeToOperation = vi.fn((_key, listener) => {
      callbacks.push(listener);
      const teardown = vi.fn();
      teardowns.push(teardown);
      return teardown;
    });
    let resolveReconciliation:
      ((operations: readonly WalletOperation[]) => void) | undefined;
    const reconcileOperations = vi.fn(
      (_known, signal: AbortSignal) =>
        new Promise<readonly WalletOperation[]>((resolve) => {
          expect(signal.aborted).toBe(false);
          resolveReconciliation = resolve;
        }),
    );
    const coordinator = new OperationCoordinator({
      subscribeToOperation,
      reconcileOperations,
    });
    const first = operation('operation-a');
    const second = operation('operation-b');
    coordinator.track(first);
    coordinator.track(second);
    const reconciliation = coordinator.reconcile();

    coordinator.close();
    coordinator.close();
    expect(coordinator.isClosed).toBe(true);
    expect(coordinator.activeSubscriptionCount).toBe(0);
    expect(teardowns).toHaveLength(2);
    expect(
      teardowns.every((teardown) => teardown.mock.calls.length === 1),
    ).toBe(true);

    callbacks[0]?.({ status: 'settled', observedAtMs: 2_000 });
    expect(coordinator.get(first.key)?.status).toBe('created');
    expect(
      coordinator.observe(first.key, {
        status: 'settled',
        observedAtMs: 2_000,
      }),
    ).toEqual({
      outcome: 'ignored',
      reason: 'coordinator_closed',
    });
    expect(() => coordinator.track(first)).toThrow(
      'Cannot track an operation after coordinator close.',
    );

    resolveReconciliation?.([operation('operation-c')]);
    await expect(reconciliation).resolves.toEqual({
      received: 1,
      registered: 0,
      applied: 0,
      duplicate: 0,
      rejected: 0,
      ignoredBecauseClosed: true,
    });
    expect(coordinator.get(operationKey('operation-c'))).toBeUndefined();
  });
});
