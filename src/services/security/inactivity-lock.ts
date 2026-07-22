export type InactivityLockReason = 'background' | 'inactivity';

export interface InactivityLockExpiry {
  readonly reason: InactivityLockReason;
  readonly generation: number;
  readonly expiredAtMs: number;
  readonly observedAtMs: number;
}

export interface LifecycleEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface VisibilityStateSource extends LifecycleEventTarget {
  readonly visibilityState: DocumentVisibilityState;
}

export interface InactivityLockScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface InactivityLockOptions {
  readonly inactivityTimeoutMs: number | null;
  readonly backgroundTimeoutMs: number | null;
  readonly onExpire: (expiry: InactivityLockExpiry) => void;
  readonly clock?: () => number;
  readonly scheduler?: InactivityLockScheduler;
  readonly activityTarget?: LifecycleEventTarget | null;
  readonly visibilitySource?: VisibilityStateSource | null;
  readonly activityEvents?: readonly string[];
}

export interface InactivityLockPolicy {
  readonly inactivityTimeoutMs: number | null;
  readonly backgroundTimeoutMs: number | null;
}

interface ScheduledCheck {
  readonly generation: number;
  readonly handle: unknown;
}

interface ExpiryCandidate {
  readonly reason: InactivityLockReason;
  readonly expiredAtMs: number;
}

interface ClockObservation {
  readonly now: number;
  readonly regressed: boolean;
}

const DEFAULT_ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'touchstart',
] as const;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const BROWSER_SCHEDULER: InactivityLockScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * Tracks one unlocked-session generation at a time.
 *
 * Browser timers are only wake-up hints. Every timer, activity event, and
 * visibility transition compares elapsed timestamps before it mutates policy
 * state, so a suspended tab cannot extend its session by resuming late.
 */
export class InactivityLock {
  private inactivityTimeoutMs: number | undefined;
  private backgroundTimeoutMs: number | undefined;
  private readonly onExpire: (expiry: InactivityLockExpiry) => void;
  private readonly clock: () => number;
  private readonly scheduler: InactivityLockScheduler;
  private readonly activityTarget: LifecycleEventTarget | undefined;
  private readonly visibilitySource: VisibilityStateSource | undefined;
  private readonly activityEvents: readonly string[];
  private readonly activityListener: EventListener;
  private readonly visibilityListener: EventListener;

  private generation = 0;
  private armed = false;
  private disposed = false;
  private expiredGeneration: number | undefined;
  private lastActivityAtMs = 0;
  private backgroundedAtMs: number | undefined;
  private lastObservedAtMs: number | undefined;
  private scheduledCheck: ScheduledCheck | undefined;

  constructor(options: InactivityLockOptions) {
    this.inactivityTimeoutMs = validateTimeout(
      options.inactivityTimeoutMs,
      'inactivityTimeoutMs',
    );
    this.backgroundTimeoutMs = validateTimeout(
      options.backgroundTimeoutMs,
      'backgroundTimeoutMs',
    );

    if (
      this.inactivityTimeoutMs === undefined &&
      this.backgroundTimeoutMs === undefined
    ) {
      throw new RangeError('At least one lock timeout must be enabled.');
    }

    const browserDocument =
      typeof document === 'undefined'
        ? undefined
        : (document as unknown as VisibilityStateSource);

    this.onExpire = options.onExpire;
    this.clock = options.clock ?? createBrowserClock();
    this.scheduler = options.scheduler ?? BROWSER_SCHEDULER;
    this.visibilitySource =
      options.visibilitySource === undefined
        ? browserDocument
        : (options.visibilitySource ?? undefined);
    this.activityTarget =
      options.activityTarget === undefined
        ? (this.visibilitySource ?? browserDocument)
        : (options.activityTarget ?? undefined);

    if (
      this.backgroundTimeoutMs !== undefined &&
      this.visibilitySource === undefined
    ) {
      throw new RangeError(
        'A visibility source is required when background locking is enabled.',
      );
    }

    this.activityEvents = Object.freeze([
      ...new Set(options.activityEvents ?? DEFAULT_ACTIVITY_EVENTS),
    ]);
    this.activityListener = () => {
      this.recordActivity();
    };
    this.visibilityListener = () => {
      this.recordVisibilityChange();
    };

    for (const eventName of this.activityEvents) {
      this.activityTarget?.addEventListener(eventName, this.activityListener);
    }
    this.visibilitySource?.addEventListener(
      'visibilitychange',
      this.visibilityListener,
    );
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get policy(): InactivityLockPolicy {
    return Object.freeze({
      inactivityTimeoutMs: this.inactivityTimeoutMs ?? null,
      backgroundTimeoutMs: this.backgroundTimeoutMs ?? null,
    });
  }

  configure(policy: InactivityLockPolicy): void {
    this.assertNotDisposed();
    const inactivityTimeoutMs = validateTimeout(
      policy.inactivityTimeoutMs,
      'inactivityTimeoutMs',
    );
    const backgroundTimeoutMs = validateTimeout(
      policy.backgroundTimeoutMs,
      'backgroundTimeoutMs',
    );
    if (
      inactivityTimeoutMs === undefined &&
      backgroundTimeoutMs === undefined
    ) {
      throw new RangeError('At least one lock timeout must be enabled.');
    }
    if (
      backgroundTimeoutMs !== undefined &&
      this.visibilitySource === undefined
    ) {
      throw new RangeError(
        'A visibility source is required when background locking is enabled.',
      );
    }

    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.backgroundTimeoutMs = backgroundTimeoutMs;
    if (!this.armed) {
      return;
    }

    const generation = this.generation;
    const observation = this.observeClock();
    if (observation.regressed) {
      this.expireForClockRegression(generation, observation.now);
      return;
    }
    if (this.isBackgrounded()) {
      this.backgroundedAtMs ??= observation.now;
    } else {
      this.backgroundedAtMs = undefined;
    }
    if (!this.expireIfNeeded(generation, observation.now)) {
      this.scheduleNextCheck(observation.now);
    }
  }

  arm(): number {
    this.assertNotDisposed();
    this.clearScheduledCheck();

    const now = this.observeClock(true).now;
    this.generation += 1;
    this.armed = true;
    this.expiredGeneration = undefined;
    this.lastActivityAtMs = now;
    this.backgroundedAtMs = this.isBackgrounded() ? now : undefined;
    this.scheduleNextCheck(now);

    return this.generation;
  }

  disarm(): void {
    this.clearScheduledCheck();
    this.armed = false;
    this.expiredGeneration = undefined;
    this.backgroundedAtMs = undefined;
  }

  recordActivity(): void {
    if (!this.armed || this.disposed) {
      return;
    }

    const generation = this.generation;
    const observation = this.observeClock();
    if (observation.regressed) {
      this.expireForClockRegression(generation, observation.now);
      return;
    }
    const now = observation.now;
    if (this.expireIfNeeded(generation, now)) {
      return;
    }

    this.lastActivityAtMs = now;
    this.scheduleNextCheck(now);
  }

  recordVisibilityChange(): void {
    if (!this.armed || this.disposed) {
      return;
    }

    const generation = this.generation;
    const observation = this.observeClock();
    if (observation.regressed) {
      this.expireForClockRegression(generation, observation.now);
      return;
    }
    const now = observation.now;

    // Check before clearing the background timestamp on resume.
    if (this.expireIfNeeded(generation, now)) {
      return;
    }

    if (this.isBackgrounded()) {
      this.backgroundedAtMs ??= now;
    } else {
      this.backgroundedAtMs = undefined;
    }

    this.scheduleNextCheck(now);
  }

  checkNow(): boolean {
    if (this.disposed) {
      return false;
    }

    if (!this.armed) {
      return this.expiredGeneration === this.generation;
    }

    const generation = this.generation;
    const observation = this.observeClock();
    if (observation.regressed) {
      return this.expireForClockRegression(generation, observation.now);
    }
    const now = observation.now;
    const expired = this.expireIfNeeded(generation, now);
    if (!expired) {
      this.scheduleNextCheck(now);
    }
    return expired;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.disarm();

    for (const eventName of this.activityEvents) {
      this.activityTarget?.removeEventListener(
        eventName,
        this.activityListener,
      );
    }
    this.visibilitySource?.removeEventListener(
      'visibilitychange',
      this.visibilityListener,
    );
  }

  private expireIfNeeded(generation: number, now: number): boolean {
    if (
      !this.armed ||
      this.disposed ||
      generation !== this.generation ||
      this.expiredGeneration === generation
    ) {
      return this.expiredGeneration === generation;
    }

    const expiry = this.findExpiry(now);
    if (expiry === undefined) {
      return false;
    }

    return this.expire(generation, expiry, now);
  }

  private findExpiry(now: number): ExpiryCandidate | undefined {
    let candidate: ExpiryCandidate | undefined;

    if (
      this.backgroundTimeoutMs !== undefined &&
      this.backgroundedAtMs !== undefined &&
      elapsedSince(this.backgroundedAtMs, now) >= this.backgroundTimeoutMs
    ) {
      candidate = {
        reason: 'background',
        expiredAtMs: this.backgroundedAtMs + this.backgroundTimeoutMs,
      };
    }

    if (
      this.inactivityTimeoutMs !== undefined &&
      elapsedSince(this.lastActivityAtMs, now) >= this.inactivityTimeoutMs
    ) {
      const inactivityExpiry = {
        reason: 'inactivity',
        expiredAtMs: this.lastActivityAtMs + this.inactivityTimeoutMs,
      } as const;

      // A background expiry wins deterministic ties.
      if (
        candidate === undefined ||
        inactivityExpiry.expiredAtMs < candidate.expiredAtMs
      ) {
        candidate = inactivityExpiry;
      }
    }

    return candidate;
  }

  private scheduleNextCheck(now: number): void {
    this.clearScheduledCheck();
    if (!this.armed || this.disposed) {
      return;
    }

    let delayMs: number | undefined;

    if (this.inactivityTimeoutMs !== undefined) {
      delayMs = remainingUntil(
        this.lastActivityAtMs,
        this.inactivityTimeoutMs,
        now,
      );
    }

    if (
      this.backgroundTimeoutMs !== undefined &&
      this.backgroundedAtMs !== undefined
    ) {
      const backgroundDelay = remainingUntil(
        this.backgroundedAtMs,
        this.backgroundTimeoutMs,
        now,
      );
      delayMs =
        delayMs === undefined
          ? backgroundDelay
          : Math.min(delayMs, backgroundDelay);
    }

    if (delayMs === undefined) {
      return;
    }

    const generation = this.generation;
    const handle = this.scheduler.setTimeout(
      () => {
        if (
          this.scheduledCheck?.generation === generation &&
          this.scheduledCheck.handle === handle
        ) {
          this.scheduledCheck = undefined;
        }

        if (!this.armed || this.disposed || generation !== this.generation) {
          return;
        }

        const observation = this.observeClock();
        if (observation.regressed) {
          this.expireForClockRegression(generation, observation.now);
          return;
        }

        if (!this.expireIfNeeded(generation, observation.now)) {
          this.scheduleNextCheck(observation.now);
        }
      },
      Math.min(delayMs, MAX_TIMER_DELAY_MS),
    );

    this.scheduledCheck = { generation, handle };
  }

  private clearScheduledCheck(): void {
    if (this.scheduledCheck === undefined) {
      return;
    }

    this.scheduler.clearTimeout(this.scheduledCheck.handle);
    this.scheduledCheck = undefined;
  }

  private isBackgrounded(): boolean {
    return this.visibilitySource?.visibilityState === 'hidden';
  }

  private expireForClockRegression(
    generation: number,
    observedAtMs: number,
  ): boolean {
    const reason =
      this.backgroundTimeoutMs !== undefined &&
      this.backgroundedAtMs !== undefined
        ? 'background'
        : 'inactivity';
    return this.expire(
      generation,
      {
        reason,
        expiredAtMs: observedAtMs,
      },
      observedAtMs,
    );
  }

  private expire(
    generation: number,
    expiry: ExpiryCandidate,
    observedAtMs: number,
  ): boolean {
    if (
      !this.armed ||
      this.disposed ||
      generation !== this.generation ||
      this.expiredGeneration === generation
    ) {
      return this.expiredGeneration === generation;
    }

    this.expiredGeneration = generation;
    this.armed = false;
    this.clearScheduledCheck();
    this.onExpire(
      Object.freeze({
        reason: expiry.reason,
        generation,
        expiredAtMs: expiry.expiredAtMs,
        observedAtMs,
      }),
    );
    return true;
  }

  private observeClock(reset = false): ClockObservation {
    const value = this.clock();
    if (!Number.isFinite(value)) {
      throw new RangeError('The inactivity clock must return a finite value.');
    }

    if (reset || this.lastObservedAtMs === undefined) {
      this.lastObservedAtMs = value;
      return { now: value, regressed: false };
    }

    if (value < this.lastObservedAtMs) {
      return { now: this.lastObservedAtMs, regressed: true };
    }

    this.lastObservedAtMs = value;
    return { now: value, regressed: false };
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new DOMException(
        'The inactivity lock has been disposed.',
        'InvalidStateError',
      );
    }
  }
}

function validateTimeout(
  timeoutMs: number | null,
  name: string,
): number | undefined {
  if (timeoutMs === null) {
    return undefined;
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      `${name} must be a non-negative safe integer or null.`,
    );
  }

  return timeoutMs;
}

function createBrowserClock(): () => number {
  const wallStartedAtMs = Date.now();
  const readMonotonic =
    typeof performance === 'undefined'
      ? undefined
      : performance.now.bind(performance);
  const monotonicStartedAtMs = readMonotonic?.();

  if (readMonotonic === undefined || monotonicStartedAtMs === undefined) {
    return Date.now;
  }

  return () =>
    Math.max(
      Date.now(),
      wallStartedAtMs + Math.max(0, readMonotonic() - monotonicStartedAtMs),
    );
}

function elapsedSince(startedAtMs: number, observedAtMs: number): number {
  return Math.max(0, observedAtMs - startedAtMs);
}

function remainingUntil(
  startedAtMs: number,
  timeoutMs: number,
  observedAtMs: number,
): number {
  return Math.max(0, timeoutMs - elapsedSince(startedAtMs, observedAtMs));
}
