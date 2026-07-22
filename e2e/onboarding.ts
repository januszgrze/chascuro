import { expect, type Page } from '@playwright/test';

export const TEST_PIN = '1234';

async function enterPin(page: Page, pin: string): Promise<void> {
  for (const digit of pin) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
}

export async function onboardNewWallet(page: Page): Promise<string[]> {
  await expect(page.getByRole('heading', { name: 'Chascuro' })).toBeVisible();
  await page.getByRole('button', { name: 'App is added to home' }).click();

  await expect(page.getByRole('heading', { name: 'Chascuro' })).toBeVisible();
  await page.getByRole('button', { name: 'Create a wallet' }).click();

  await expect(
    page.getByRole('heading', { name: 'Your recovery phrase' }),
  ).toBeVisible({ timeout: 30_000 });
  const recoveryWords = await page.locator('.word-text').allTextContents();
  expect(recoveryWords).toHaveLength(12);
  expect(recoveryWords.every((word) => word.length > 0)).toBe(true);
  await page.getByRole('button', { name: "I've written it down" }).click();

  await expect(page.getByRole('heading', { name: 'Create PIN' })).toBeVisible();
  await enterPin(page, TEST_PIN);
  await page.getByRole('button', { name: 'Create PIN' }).click();

  await expect(
    page.getByRole('heading', { name: 'Confirm PIN' }),
  ).toBeVisible();
  await enterPin(page, TEST_PIN);
  await page.getByRole('button', { name: 'Confirm PIN' }).click();

  await expect(
    page.getByRole('heading', { name: 'Choose a federation' }),
  ).toBeVisible({ timeout: 30_000 });
  return recoveryWords;
}
