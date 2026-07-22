import { expect, test } from '@playwright/test';

test('serves only the application shell from cache while offline', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();

  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);

  const cachedUrls = await page.evaluate(async () => {
    const groups = await Promise.all(
      (await caches.keys()).map(async (name) => {
        const cache = await caches.open(name);
        return (await cache.keys()).map((request) => request.url);
      }),
    );
    return groups.flat();
  });

  expect(
    cachedUrls.every((url) => new URL(url).origin === 'http://127.0.0.1:4173'),
  ).toBe(true);
  expect(cachedUrls.join(' ')).not.toMatch(/invoice|invite|ecash|\/api\//i);

  await context.setOffline(true);
  const response = await page.reload({ waitUntil: 'domcontentloaded' });

  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page.getByRole('main')).toBeVisible();
});
