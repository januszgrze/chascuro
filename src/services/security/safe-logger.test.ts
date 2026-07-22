import { describe, expect, it, vi } from 'vitest';

import { createSafeLogger } from './safe-logger';

describe('safe logger', () => {
  it('emits only the allowlisted structured fields', () => {
    const sink = vi.fn();
    const logger = createSafeLogger(sink);

    logger.event({
      code: 'federation_preview_finished',
      result: 'failure',
      errorClass: 'network',
    });

    expect(sink).toHaveBeenCalledWith({
      code: 'federation_preview_finished',
      result: 'failure',
      errorClass: 'network',
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain('invite');
  });

  it('drops unexpected runtime fields instead of trusting TypeScript alone', () => {
    const sink = vi.fn();
    const logger = createSafeLogger(sink);

    logger.event({
      code: 'operation_rejected',
      secret: 'fedimint-invite-code',
    } as never);

    expect(sink).toHaveBeenCalledWith({
      code: 'operation_rejected',
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(
      'fedimint-invite-code',
    );
  });
});
