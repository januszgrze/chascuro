import { expect, test } from '@playwright/test';

import { onboardNewWallet } from './onboarding';

const INVITE = 'fedimint browser test invite';

test('completes the explicit simulated onboarding flow on mobile', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await onboardNewWallet(page);
  await page.getByRole('textbox', { name: 'Federation invite' }).fill(INVITE);
  await page.getByRole('button', { name: 'Preview federation' }).click();

  await expect(page.getByText('Demo Federation')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(INVITE);

  const joinButton = page.getByRole('button', { name: 'Join federation' });
  await expect(joinButton).toBeEnabled();
  await joinButton.click();

  await expect(
    page.getByRole('heading', { name: "You're ready" }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to wallet' }).click();
  await expect(
    page.getByRole('heading', { name: 'Wallet home' }),
  ).toBeVisible();
  await expect(page.getByText('25000', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Receive' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  const visualState = await page.evaluate(() => {
    return {
      hasHorizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    };
  });
  expect(visualState).toEqual({
    hasHorizontalOverflow: false,
  });

  await page.screenshot({
    path: testInfo.outputPath('mobile-home.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Backup and settings' }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^Seed & PIN$/ })
    .click();
  await page.getByRole('button', { name: 'Reveal recovery words' }).click();
  await expect(page.locator('.settings-word-grid .word-row')).toHaveCount(12);
  await expect(
    page.getByText(/Anyone with them can take your money/),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('html').evaluate((element) => element.clientWidth),
  );
  await page.screenshot({
    path: testInfo.outputPath('mobile-settings-recovery.png'),
    fullPage: true,
  });

  await page
    .locator('summary')
    .filter({ hasText: /^Wallet$/ })
    .click();
  await page.getByRole('button', { name: 'Lock wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Enter PIN' })).toBeVisible();
});
