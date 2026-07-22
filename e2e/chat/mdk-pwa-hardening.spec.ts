import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('MDK production assets remain bounded, cacheable, and CSP-confined', async ({
  context,
  page,
}) => {
  const response = await page.goto('/');
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toContain("worker-src 'self'");
  expect(headers['content-security-policy']).toContain('ws://127.0.0.1:4877');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['x-content-type-options']).toBe('nosniff');

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);

  const evidence = await page.evaluate(async () => {
    const manifest = (await (
      await fetch('/manifest.webmanifest')
    ).json()) as Record<string, unknown>;
    const cacheNames = await caches.keys();
    const entries = (
      await Promise.all(
        cacheNames.map(async (cacheName) => {
          const cache = await caches.open(cacheName);
          return Promise.all(
            (await cache.keys()).map(async (request) => {
              const cached = await cache.match(request);
              return {
                bytes: cached === undefined ? 0 : (await cached.blob()).size,
                url: request.url,
              };
            }),
          );
        }),
      )
    ).flat();
    const navigation = performance.getEntriesByType(
      'navigation',
    )[0] as PerformanceNavigationTiming;
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
    return {
      cachedBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      cachedUrls: entries.map(({ url }) => url),
      display: manifest.display,
      domContentLoadedMs:
        navigation.domContentLoadedEventEnd - navigation.startTime,
      hasHorizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      registrationCount: (await navigator.serviceWorker.getRegistrations())
        .length,
    };
  });

  expect(evidence.display).toBe('standalone');
  expect(evidence.registrationCount).toBe(1);
  expect(
    evidence.cachedUrls.some((url) => url.includes('mdk-product-worker')),
  ).toBe(true);
  expect(
    evidence.cachedUrls.some((url) => url.includes('marmot_web_wasi_engine')),
  ).toBe(true);
  expect(evidence.cachedUrls.join(' ')).not.toMatch(
    /invoice|invite|ecash|message:|conversation:/iu,
  );
  expect(evidence.cachedBytes).toBeLessThan(32 * 1024 * 1024);
  expect(evidence.domContentLoadedMs).toBeLessThan(10_000);
  expect(evidence.hasHorizontalOverflow).toBe(false);
  await expect(page.getByRole('main')).toBeVisible();

  const workerPath = resolve(process.cwd(), 'dist/sw.js');
  const currentWorker = await readFile(workerPath, 'utf8');
  const updateAvailable = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const timeout = window.setTimeout(() => resolve('timed-out'), 10_000);
        window.addEventListener(
          'wallet-pwa-update-available',
          () => {
            window.clearTimeout(timeout);
            resolve('available');
          },
          { once: true },
        );
      }),
  );
  try {
    await writeFile(workerPath, `${currentWorker}\n// wp7-update-probe`);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await expect(updateAvailable).resolves.toBe('available');
  } finally {
    await writeFile(workerPath, currentWorker);
  }
  await expect(page.getByRole('main')).toBeVisible();

  await context.setOffline(true);
  const offline = await page.reload({ waitUntil: 'domcontentloaded' });
  expect(offline?.fromServiceWorker()).toBe(true);
  await expect(page.getByRole('main')).toBeVisible();
  await context.setOffline(false);
});
