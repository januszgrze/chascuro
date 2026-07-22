import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import baseConfig from '../../playwright.config';

export default defineConfig({
  ...baseConfig,
  testDir: fileURLToPath(new URL('../', import.meta.url)),
  projects: [
    {
      name: 'marmot-firefox',
      use: {
        ...devices['Desktop Firefox'],
      },
    },
    {
      name: 'marmot-webkit',
      use: {
        ...devices['iPhone 13'],
      },
    },
  ],
});
