import { copyFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iconsDirectory = join(root, 'public', 'icons');
const svg = await readFile(join(iconsDirectory, 'wallet.svg'), 'utf8');
const browser = await chromium.launch({ headless: true });

try {
  for (const [size, filename] of [
    [180, 'apple-touch-icon.png'],
    [192, 'wallet-192.png'],
    [512, 'wallet-512.png'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(`
      <!doctype html>
      <style>
        html, body, svg {
          display: block;
          width: 100%;
          height: 100%;
          margin: 0;
          overflow: hidden;
        }
      </style>
      ${svg}
    `);
    await page.screenshot({
      path: join(iconsDirectory, filename),
      fullPage: false,
    });
    await page.close();
  }

  await copyFile(
    join(iconsDirectory, 'wallet-512.png'),
    join(iconsDirectory, 'wallet-maskable-512.png'),
  );
} finally {
  await browser.close();
}
