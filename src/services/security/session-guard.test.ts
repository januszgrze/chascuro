import { describe, expect, it } from 'vitest';

import { SessionGuard } from './session-guard';

describe('SessionGuard', () => {
  it('invalidates in-flight work when a session is renewed', () => {
    const guard = new SessionGuard();
    const first = guard.current();
    const second = guard.renew();

    expect(first.signal.aborted).toBe(true);
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });
});
