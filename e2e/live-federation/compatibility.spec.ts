import { expect, test } from '@playwright/test';

const INVITE = process.env.FEDIMINT_TEST_INVITE;
const PASSPHRASE = 'live federation browser test passphrase';

test.describe.serial('live federation compatibility', () => {
  test('creates identity, previews, joins, and reopens the selected federation', async ({
    page,
  }) => {
    test.skip(
      INVITE === undefined || INVITE.length === 0,
      'FEDIMINT_TEST_INVITE is required outside source control.',
    );
    test.setTimeout(120_000);

    await page.goto('/');
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Create wallet' }).click();
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Unlock wallet' }).click();

    await page.getByRole('button', { name: 'Create new wallet' }).click();
    const recoveryWords = await page
      .locator('.mnemonic-grid li strong')
      .allTextContents();
    await page.getByLabel('Word 3').fill(recoveryWords[2] ?? '');
    await page.getByLabel('Word 7').fill(recoveryWords[6] ?? '');
    await page.getByLabel('Word 11').fill(recoveryWords[10] ?? '');
    await page.getByRole('button', { name: 'Confirm backup' }).click();

    await page.getByLabel('Federation invite').fill(INVITE!);
    await page.getByRole('button', { name: 'Preview federation' }).click();
    await expect(
      page.getByRole('heading', { name: 'Review federation' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText(INVITE!);
    await page
      .getByRole('checkbox', {
        name: /I trust this federation’s guardians/,
      })
      .check();
    await page.getByRole('button', { name: 'Join federation' }).click();
    await expect(
      page.getByRole('heading', { name: 'Wallet balance' }),
    ).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'Lock wallet' }).click();
    await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Unlock wallet' }).click();
    await expect(
      page.getByRole('heading', { name: 'Wallet balance' }),
    ).toBeVisible({ timeout: 60_000 });
  });
});
