import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { createSecurityHeaders } from './src/config/security-headers';

function deploymentHeadersFile(
  headers: Readonly<Record<string, string>>,
): string {
  return `/*\n${Object.entries(headers)
    .map(([name, value]) => `  ${name}: ${value}`)
    .join('\n')}\n`;
}

function deploymentBasePath(): string {
  const base = process.env.VITE_BASE_PATH ?? '/';
  if (!base.startsWith('/') || !base.endsWith('/')) {
    throw new Error('VITE_BASE_PATH must start and end with "/".');
  }
  return base;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default defineConfig(({ mode }) => {
  const base = deploymentBasePath();
  const escapedBase = escapeRegExp(base);
  const productionSecurityHeaders = createSecurityHeaders();
  const securityHeaders =
    mode === 'e2e'
      ? {
          ...productionSecurityHeaders,
          'Content-Security-Policy': productionSecurityHeaders[
            'Content-Security-Policy'
          ].replace(
            "connect-src 'self' https: wss:",
            "connect-src 'self' https: wss: ws://127.0.0.1:4877",
          ),
        }
      : productionSecurityHeaders;
  const developmentHeaders = {
    'Cross-Origin-Opener-Policy':
      productionSecurityHeaders['Cross-Origin-Opener-Policy'],
    'Permissions-Policy': productionSecurityHeaders['Permissions-Policy'],
    'Referrer-Policy': productionSecurityHeaders['Referrer-Policy'],
    'X-Content-Type-Options':
      productionSecurityHeaders['X-Content-Type-Options'],
  };

  return {
    plugins: [
      {
        name: 'wallet-deployment-security-headers',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: '_headers',
            source: deploymentHeadersFile(securityHeaders),
          });
        },
      },
      react(),
      VitePWA({
        strategies: 'generateSW',
        registerType: 'prompt',
        injectRegister: false,
        includeAssets: [
          'icons/wallet.svg',
          'icons/wallet-192.png',
          'icons/wallet-512.png',
          'icons/wallet-maskable-512.png',
          'icons/apple-touch-icon.png',
        ],
        manifest: {
          id: base,
          name: 'Chascuro',
          short_name: 'Chascuro',
          description: 'A Fedimint wallet with experimental Marmot chat.',
          start_url: base,
          scope: base,
          display: 'standalone',
          background_color: '#ffffff',
          theme_color: '#000000',
          orientation: 'portrait-primary',
          icons: [
            {
              src: `${base}icons/wallet-192.png`,
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: `${base}icons/wallet-512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: `${base}icons/wallet-maskable-512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          cleanupOutdatedCaches: true,
          globPatterns: ['**/*.{css,html,js,json,svg,wasm}'],
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          navigateFallback: `${base}index.html`,
          navigateFallbackDenylist: [
            new RegExp(`^${escapedBase}api(?:/|$)`),
            new RegExp(`^${escapedBase}health(?:/|$)`),
          ],
          runtimeCaching: [],
          sourcemap: false,
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    base,
    build: {
      sourcemap: false,
    },
    worker: {
      format: 'es',
    },
    preview: {
      headers: securityHeaders,
    },
    server: {
      // Vite's React refresh preamble and error overlay use development-only
      // inline script/style injection. The strict production CSP remains active
      // for `vite preview` and the generated deployment `_headers` file.
      headers: developmentHeaders,
    },
  };
});
