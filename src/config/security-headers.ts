/**
 * Federation invite codes discover guardian endpoints at runtime. A static PWA
 * cannot know those origins before its CSP is delivered, so invite-code-only
 * joining requires secure-scheme network access rather than a build-time
 * origin list.
 *
 * Executable content, frames, fonts, forms, and workers remain same-origin.
 */
export function createSecurityHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    'Content-Security-Policy':
      "default-src 'self'; base-uri 'none'; connect-src 'self' https: wss:; font-src 'self'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' data: blob:; manifest-src 'self'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; worker-src 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy':
      'camera=(self), geolocation=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}
