import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import baseConfig from '../../playwright.config';

export default defineConfig({
  ...baseConfig,
  testDir: fileURLToPath(new URL('../', import.meta.url)),
  projects: [
    {
      name: 'marmot-relay-chromium',
      use: {
        ...devices['Pixel 7'],
      },
    },
  ],
  webServer: [
    {
      command: 'node scripts/nostr-test-relay.mjs --port 4877',
      port: 4877,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run preview -- --mode e2e --port 4173 --strictPort',
      port: 4173,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
