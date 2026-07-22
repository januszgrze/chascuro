import { describe, expect, it } from 'vitest';

import { createSecurityHeaders } from './security-headers';

describe('deployment security headers', () => {
  it('allows code-discovered secure federation endpoints without remote code', () => {
    const csp = createSecurityHeaders()['Content-Security-Policy'];

    expect(csp).toContain("connect-src 'self' https: wss:");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toContain('http:');
    expect(csp).not.toContain('ws:;');
    expect(csp).not.toContain('script-src https:');
  });
});
