import {
  isOperationInFlight,
  transitionOperation,
  type OperationKey,
  type OperationStatus,
  type OperationTransitionResult,
  type WalletOperation,
} from '../../domain';

export interface OperationObservation {
  readonly status: OperationStatus;
  readonly observedAtMs: number;
}

export type OperationObservationListener = (
  observation: OperationObservation,
) => void;

export type SubscribeToOperation = (
  key: OperationKey,
  listener: OperationObservationListener,
) => () => void;

interface RegistryEntry {
  readonly key: OperationKey;
  readonly listeners: Map<symbol, OperationObservationListener>;
  active: boolean;
  teardown?: () => void;
  teardownCalled: boolean;
}

function operationKeyId(key: OperationKey): string {
  return JSON.stringify([key.federationId, key.operationId]);
}

/**
 * Shares one adapter subscription between all listeners for an operation key.
 * Entries are identity-gated so a callback from a detached subscription cannot
 * affect a later subscription for the same operation.
 */
export class OperationSubscriptionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(private readonly subscribeToOperation: SubscribeToOperation) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: OperationKey): boolean {
    return this.entries.has(operationKeyId(key));
  }

  subscribe(
    key: OperationKey,
    listener: OperationObservationListener,
  ): () => void {
    const id = operationKeyId(key);
    const lease = Symbol('operation-subscription');
    let entry = this.entries.get(id);

    if (entry === undefined) {
      entry = {
        key: Object.freeze({ ...key }),
        listeners: new Map([[lease, listener]]),
        active: true,
        teardownCalled: false,
      };
      this.entries.set(id, entry);

      try {
        const teardown = this.subscribeToOperation(entry.key, (observation) => {
          if (!entry?.active || this.entries.get(id) !== entry) {
            return;
          }

          for (const activeListener of [...entry.listeners.values()]) {
            activeListener(observation);
          }
        });
        entry.teardown = teardown;

        if (!entry.active) {
          this.callTeardown(entry);
        }
      } catch (error) {
        this.deactivate(id, entry);
        throw error;
      }
    } else {
      entry.listeners.set(lease, listener);
    }

    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;

      if (!entry?.active) {
        return;
      }

      entry.listeners.delete(lease);
      if (entry.listeners.size === 0) {
        this.deactivate(id, entry);
      }
    };
  }

  stop(key: OperationKey): boolean {
    const id = operationKeyId(key);
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return false;
    }

    this.deactivate(id, entry);
    return true;
  }

  stopAll(): void {
    const errors: unknown[] = [];

    for (const [id, entry] of [...this.entries]) {
      try {
        this.deactivate(id, entry);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Multiple operation subscriptions failed to stop.',
      );
    }
  }

  private deactivate(id: string, entry: RegistryEntry): void {
    if (!entry.active) {
      return;
    }

    entry.active = false;
    entry.listeners.clear();
    if (this.entries.get(id) === entry) {
      this.entries.delete(id);
    }
    this.callTeardown(entry);
  }

  private callTeardown(entry: RegistryEntry): void {
    if (entry.teardownCalled || entry.teardown === undefined) {
      return;
    }

    entry.teardownCalled = true;
    entry.teardown();
  }
}

export type OperationCoordinatorChangeSource =
  'tracking' | 'subscription' | 'reconciliation';

export interface OperationCoordinatorChange {
  readonly source: OperationCoordinatorChangeSource;
  readonly operation: WalletOperation;
  readonly previous?: WalletOperation;
}

export type OperationCoordinatorListener = (
  change: OperationCoordinatorChange,
) => void;

export type ReconcileOperations = (
  knownOperations: readonly WalletOperation[],
  signal: AbortSignal,
) => Promise<readonly WalletOperation[]>;

export interface OperationCoordinatorOptions {
  readonly subscribeToOperation: SubscribeToOperation;
  readonly reconcileOperations?: ReconcileOperations;
}

export type OperationTrackResult =
  | {
      readonly outcome: 'registered';
      readonly operation: WalletOperation;
    }
  | OperationTransitionResult;

export type OperationObservationResult =
  | OperationTransitionResult
  | {
      readonly outcome: 'ignored';
      readonly reason: 'not_tracked' | 'coordinator_closed';
    };

export interface OperationCoordinatorReconciliationReport {
  readonly received: number;
  readonly registered: number;
  readonly applied: number;
  readonly duplicate: number;
  readonly rejected: number;
  readonly ignoredBecauseClosed: boolean;
}

function reconciliationReport(
  input: OperationCoordinatorReconciliationReport,
): OperationCoordinatorReconciliationReport {
  return Object.freeze({ ...input });
}

/**
 * Owns normalized operation state for one unlocked wallet session.
 *
 * Subscription callbacks and reconciliation results both pass through the
 * domain transition function, so terminal states are idempotent and stale or
 * regressive observations cannot overwrite newer state.
 */
export class OperationCoordinator {
  private readonly operations = new Map<string, WalletOperation>();
  private readonly listeners = new Set<OperationCoordinatorListener>();
  private readonly registry: OperationSubscriptionRegistry;
  private readonly abortController = new AbortController();
  private reconciliationInFlight:
    Promise<OperationCoordinatorReconciliationReport> | undefined;
  private epoch = 0;
  private closed = false;

  constructor(private readonly options: OperationCoordinatorOptions) {
    this.registry = new OperationSubscriptionRegistry(
      options.subscribeToOperation,
    );
  }

  get activeSubscriptionCount(): number {
    return this.registry.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  subscribe(listener: OperationCoordinatorListener): () => void {
    if (this.closed) {
      return () => undefined;
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get(key: OperationKey): WalletOperation | undefined {
    return this.operations.get(operationKeyId(key));
  }

  list(): readonly WalletOperation[] {
    return Object.freeze(
      [...this.operations.values()].sort((left, right) => {
        const timestampOrder =
          right.updatedAtMs - left.updatedAtMs ||
          right.createdAtMs - left.createdAtMs;
        if (timestampOrder !== 0) {
          return timestampOrder;
        }

        return operationKeyId(left.key).localeCompare(
          operationKeyId(right.key),
        );
      }),
    );
  }

  track(operation: WalletOperation): OperationTrackResult {
    if (this.closed) {
      throw new Error('Cannot track an operation after coordinator close.');
    }

    return this.ingest(operation, 'tracking');
  }

  observe(
    key: OperationKey,
    observation: OperationObservation,
  ): OperationObservationResult {
    return this.applyObservation(key, observation, 'subscription');
  }

  stop(key: OperationKey): boolean {
    return this.registry.stop(key);
  }

  stopAll(): void {
    this.registry.stopAll();
  }

  reconcile(): Promise<OperationCoordinatorReconciliationReport> {
    if (this.reconciliationInFlight !== undefined) {
      return this.reconciliationInFlight;
    }

    if (this.closed) {
      return Promise.resolve(
        reconciliationReport({
          received: 0,
          registered: 0,
          applied: 0,
          duplicate: 0,
          rejected: 0,
          ignoredBecauseClosed: true,
        }),
      );
    }

    if (this.options.reconcileOperations === undefined) {
      return Promise.resolve(
        reconciliationReport({
          received: 0,
          registered: 0,
          applied: 0,
          duplicate: 0,
          rejected: 0,
          ignoredBecauseClosed: false,
        }),
      );
    }

    const epoch = this.epoch;
    const work = this.performReconciliation(epoch);
    this.reconciliationInFlight = work;
    void work.then(
      () => {
        if (this.reconciliationInFlight === work) {
          this.reconciliationInFlight = undefined;
        }
      },
      () => {
        if (this.reconciliationInFlight === work) {
          this.reconciliationInFlight = undefined;
        }
      },
    );
    return work;
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.epoch += 1;
    this.abortController.abort();

    try {
      this.registry.stopAll();
    } finally {
      this.listeners.clear();
    }
  }

  private ingest(
    operation: WalletOperation,
    source: OperationCoordinatorChangeSource,
  ): OperationTrackResult {
    const id = operationKeyId(operation.key);
    const current = this.operations.get(id);

    if (current !== undefined) {
      const result = this.applyObservation(
        current.key,
        {
          status: operation.status,
          observedAtMs: operation.updatedAtMs,
        },
        source,
      );

      if (result.outcome === 'ignored') {
        throw new Error('Tracked operation unexpectedly became unavailable.');
      }

      this.ensureTracked(this.operations.get(id) ?? current);
      return result;
    }

    this.operations.set(id, operation);
    this.emit({
      source,
      operation,
    });
    this.ensureTracked(operation);
    return {
      outcome: 'registered',
      operation,
    };
  }

  private applyObservation(
    key: OperationKey,
    observation: OperationObservation,
    source: OperationCoordinatorChangeSource,
  ): OperationObservationResult {
    if (this.closed) {
      return {
        outcome: 'ignored',
        reason: 'coordinator_closed',
      };
    }

    const id = operationKeyId(key);
    const current = this.operations.get(id);
    if (current === undefined) {
      return {
        outcome: 'ignored',
        reason: 'not_tracked',
      };
    }

    const result = transitionOperation(
      current,
      observation.status,
      observation.observedAtMs,
    );

    if (result.outcome !== 'applied') {
      return result;
    }

    this.operations.set(id, result.operation);
    if (!isOperationInFlight(result.operation.status)) {
      this.registry.stop(result.operation.key);
    }

    this.emit({
      source,
      operation: result.operation,
      previous: current,
    });
    return result;
  }

  private ensureTracked(operation: WalletOperation): void {
    if (
      this.closed ||
      !isOperationInFlight(operation.status) ||
      this.registry.has(operation.key)
    ) {
      return;
    }

    this.registry.subscribe(operation.key, (observation) => {
      this.applyObservation(operation.key, observation, 'subscription');
    });
  }

  private async performReconciliation(
    epoch: number,
  ): Promise<OperationCoordinatorReconciliationReport> {
    const reconciled = await this.options.reconcileOperations!(
      this.list(),
      this.abortController.signal,
    );

    if (this.closed || epoch !== this.epoch) {
      return reconciliationReport({
        received: reconciled.length,
        registered: 0,
        applied: 0,
        duplicate: 0,
        rejected: 0,
        ignoredBecauseClosed: true,
      });
    }

    let registered = 0;
    let applied = 0;
    let duplicate = 0;
    let rejected = 0;

    for (const operation of reconciled) {
      const result = this.ingest(operation, 'reconciliation');
      switch (result.outcome) {
        case 'registered':
          registered += 1;
          break;
        case 'applied':
          applied += 1;
          break;
        case 'duplicate':
          duplicate += 1;
          break;
        case 'rejected':
          rejected += 1;
          break;
      }
    }

    return reconciliationReport({
      received: reconciled.length,
      registered,
      applied,
      duplicate,
      rejected,
      ignoredBecauseClosed: false,
    });
  }

  private emit(change: OperationCoordinatorChange): void {
    const frozenChange = Object.freeze({ ...change });
    for (const listener of [...this.listeners]) {
      listener(frozenChange);
    }
  }
}
