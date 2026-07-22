import { describe, expect, it, vi } from 'vitest';

import {
  InactivityLock,
  type InactivityLockScheduler,
  type LifecycleEventTarget,
  type VisibilityStateSource,
} from './inactivity-lock';

class TestDocument implements VisibilityStateSource {
  visibilityState: DocumentVisibilityState = 'visible';
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface ScheduledTask {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
}

class TestScheduler implements InactivityLockScheduler {
  private nextHandle = 1;
  readonly tasks = new Map<number, ScheduledTask>();

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.tasks.set(handle, {
      callback,
      delayMs,
      cleared: false,
    });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    const task = this.tasks.get(handle as number);
    if (task !== undefined) {
      task.cleared = true;
    }
  }

  latestHandle(): number {
    return Math.max(...this.tasks.keys());
  }

  fire(handle: number, includeCleared = false): void {
    const task = this.tasks.get(handle);
    if (task !== undefined && (!task.cleared || includeCleared)) {
      task.callback();
    }
  }
}

describe('InactivityLock', () => {
  it('expires from elapsed background time when a suspended tab resumes', () => {
    let now = 0;
    const document = new TestDocument();
    const scheduler = new TestScheduler();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 10_000,
      backgroundTimeoutMs: 1_000,
      onExpire,
      clock: () => now,
      scheduler,
      activityTarget: document,
      visibilitySource: document,
    });

    expect(lock.arm()).toBe(1);
    now = 100;
    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');

    // No scheduled callback runs while the simulated page is suspended.
    now = 1_100;
    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');

    expect(onExpire).toHaveBeenCalledOnce();
    expect(onExpire).toHaveBeenCalledWith({
      reason: 'background',
      generation: 1,
      expiredAtMs: 1_100,
      observedAtMs: 1_100,
    });
    expect(lock.isArmed).toBe(false);
  });

  it('checks the old activity timestamp before a late event can reset it', () => {
    let now = 0;
    const document = new TestDocument();
    const scheduler = new TestScheduler();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 1_000,
      backgroundTimeoutMs: null,
      onExpire,
      clock: () => now,
      scheduler,
      activityTarget: document,
      visibilitySource: document,
    });

    lock.arm();
    const staleTimer = scheduler.latestHandle();
    now = 1_000;
    document.dispatch('pointerdown');

    lock.checkNow();
    document.dispatch('keydown');
    scheduler.fire(staleTimer, true);

    expect(onExpire).toHaveBeenCalledOnce();
    expect(onExpire).toHaveBeenCalledWith({
      reason: 'inactivity',
      generation: 1,
      expiredAtMs: 1_000,
      observedAtMs: 1_000,
    });
  });

  it('resets inactivity before the boundary and expires the new deadline', () => {
    let now = 0;
    const document = new TestDocument();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 1_000,
      backgroundTimeoutMs: null,
      onExpire,
      clock: () => now,
      activityTarget: document,
      visibilitySource: document,
    });

    lock.arm();
    now = 999;
    document.dispatch('keydown');
    now = 1_998;
    expect(lock.checkNow()).toBe(false);
    now = 1_999;
    expect(lock.checkNow()).toBe(true);

    expect(onExpire).toHaveBeenCalledWith({
      reason: 'inactivity',
      generation: 1,
      expiredAtMs: 1_999,
      observedAtMs: 1_999,
    });
    lock.dispose();
  });

  it('applies a stricter configured policy to the current session', () => {
    let now = 0;
    const document = new TestDocument();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 10_000,
      backgroundTimeoutMs: 5_000,
      onExpire,
      clock: () => now,
      activityTarget: document,
      visibilitySource: document,
    });

    lock.arm();
    now = 2_000;
    lock.configure({
      inactivityTimeoutMs: 1_000,
      backgroundTimeoutMs: 500,
    });

    expect(lock.policy).toEqual({
      inactivityTimeoutMs: 1_000,
      backgroundTimeoutMs: 500,
    });
    expect(onExpire).toHaveBeenCalledWith({
      reason: 'inactivity',
      generation: 1,
      expiredAtMs: 1_000,
      observedAtMs: 2_000,
    });
  });

  it('invokes the callback once for each explicitly armed generation', () => {
    let now = 0;
    const scheduler = new TestScheduler();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 100,
      backgroundTimeoutMs: null,
      onExpire,
      clock: () => now,
      scheduler,
      activityTarget: null,
      visibilitySource: null,
    });

    lock.arm();
    now = 100;
    scheduler.fire(scheduler.latestHandle());
    lock.checkNow();

    now = 200;
    expect(lock.arm()).toBe(2);
    now = 300;
    scheduler.fire(scheduler.latestHandle());

    expect(onExpire).toHaveBeenCalledTimes(2);
    expect(onExpire.mock.calls.map(([expiry]) => expiry.generation)).toEqual([
      1, 2,
    ]);
  });

  it('ignores a stale timer from an earlier armed generation', () => {
    let now = 0;
    const scheduler = new TestScheduler();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 100,
      backgroundTimeoutMs: null,
      onExpire,
      clock: () => now,
      scheduler,
      activityTarget: null,
      visibilitySource: null,
    });

    lock.arm();
    const firstGenerationTimer = scheduler.latestHandle();
    now = 50;
    lock.arm();
    const secondGenerationTimer = scheduler.latestHandle();

    now = 100;
    scheduler.fire(firstGenerationTimer, true);
    expect(onExpire).not.toHaveBeenCalled();

    now = 150;
    scheduler.fire(secondGenerationTimer);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(onExpire).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2 }),
    );
  });

  it('removes listeners and ignores stale callbacks after disposal', () => {
    let now = 0;
    const document = new TestDocument();
    const scheduler = new TestScheduler();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 1_000,
      backgroundTimeoutMs: 100,
      onExpire,
      clock: () => now,
      scheduler,
      activityTarget: document,
      visibilitySource: document,
    });

    lock.arm();
    const staleTimer = scheduler.latestHandle();
    expect(document.listenerCount('pointerdown')).toBe(1);
    expect(document.listenerCount('visibilitychange')).toBe(1);

    lock.dispose();
    lock.dispose();
    now = 10_000;
    document.dispatch('pointerdown');
    document.dispatch('visibilitychange');
    scheduler.fire(staleTimer, true);

    expect(onExpire).not.toHaveBeenCalled();
    expect(document.listenerCount('pointerdown')).toBe(0);
    expect(document.listenerCount('visibilitychange')).toBe(0);
    expect(() => lock.arm()).toThrowError(
      expect.objectContaining({ name: 'InvalidStateError' }),
    );
  });

  it('accepts a separate activity event target', () => {
    let now = 0;
    const activityTarget = new TestDocument() as LifecycleEventTarget;
    const visibilitySource = new TestDocument();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 500,
      backgroundTimeoutMs: 5_000,
      onExpire,
      clock: () => now,
      activityTarget,
      visibilitySource,
    });

    lock.arm();
    now = 400;
    (activityTarget as TestDocument).dispatch('touchstart');
    now = 899;
    expect(lock.checkNow()).toBe(false);
    now = 900;
    expect(lock.checkNow()).toBe(true);
    lock.dispose();
  });

  it('fails closed when background locking cannot observe visibility', () => {
    expect(
      () =>
        new InactivityLock({
          inactivityTimeoutMs: null,
          backgroundTimeoutMs: 1_000,
          onExpire: vi.fn(),
          activityTarget: null,
          visibilitySource: null,
        }),
    ).toThrowError(/visibility source/i);
  });

  it('fails closed on clock rollback before clearing background state', () => {
    let now = 1_000;
    const document = new TestDocument();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 10_000,
      backgroundTimeoutMs: 1_000,
      onExpire,
      clock: () => now,
      activityTarget: document,
      visibilitySource: document,
    });

    lock.arm();
    now = 1_100;
    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    now = 1_050;
    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');

    expect(onExpire).toHaveBeenCalledOnce();
    expect(onExpire).toHaveBeenCalledWith({
      reason: 'background',
      generation: 1,
      expiredAtMs: 1_100,
      observedAtMs: 1_100,
    });
    lock.dispose();
  });

  it('fails closed when an activity timestamp moves backward', () => {
    let now = 1_000;
    const document = new TestDocument();
    const onExpire = vi.fn();
    const lock = new InactivityLock({
      inactivityTimeoutMs: 10_000,
      backgroundTimeoutMs: null,
      onExpire,
      clock: () => now,
      activityTarget: document,
      visibilitySource: document,
    });

    lock.arm();
    now = 1_100;
    document.dispatch('pointerdown');
    now = 1_050;
    document.dispatch('keydown');

    expect(onExpire).toHaveBeenCalledOnce();
    expect(onExpire).toHaveBeenCalledWith({
      reason: 'inactivity',
      generation: 1,
      expiredAtMs: 1_100,
      observedAtMs: 1_100,
    });
    lock.dispose();
  });
});
