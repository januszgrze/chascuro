import { expect, test } from '@playwright/test';

import { onboardNewWallet } from './onboarding';

test('initializes the real Fedimint worker and OPFS database', async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.goto('/');
  await expect(page.getByText('Simulation — no real funds')).toHaveCount(0);
  await onboardNewWallet(page);

  const databaseExists = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getFileHandle('fedimint.db');
      return true;
    } catch {
      return false;
    }
  });
  expect(databaseExists).toBe(true);
});
