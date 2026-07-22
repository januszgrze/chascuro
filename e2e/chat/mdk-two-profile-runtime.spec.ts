import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import type {
  MdkTwoProfileCommand,
  MdkTwoProfileResult,
} from '../../src/services/chat/mdk-two-profile-rpc';

const RELAY = 'ws://127.0.0.1:4877/accept';
const ALICE_KEY = 'a1'.repeat(32);
const BOB_KEY = 'b2'.repeat(32);

async function command(
  page: Page,
  value: MdkTwoProfileCommand,
): Promise<MdkTwoProfileResult> {
  return page.evaluate(async (request) => {
    if (window.__marmotTwoProfileProbe === undefined) {
      throw new Error('The Marmot two-profile probe is not installed.');
    }
    return window.__marmotTwoProfileProbe(request);
  }, value);
}

function captureUnexpectedErrors(page: Page, errors: string[]): void {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const knownFontCspError =
      text.includes('Content-Security-Policy') &&
      text.includes('font-src') &&
      text.includes('data:font/');
    const knownFontLoadError =
      text.startsWith("Loading the font 'data:font/") &&
      text.includes(`Content Security Policy directive: "font-src 'self'"`);
    if (!knownFontCspError && !knownFontLoadError) errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(error.message));
}

async function newProfilePage(
  context: BrowserContext,
  errors: string[],
): Promise<Page> {
  const page = await context.newPage();
  captureUnexpectedErrors(page, errors);
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain(
    'ws://127.0.0.1:4877',
  );
  return page;
}

test('two clean Chromium profiles exchange, reload, and catch up exactly once', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const aliceErrors: string[] = [];
  const bobErrors: string[] = [];

  try {
    const alicePage = await newProfilePage(aliceContext, aliceErrors);
    let bobPage = await newProfilePage(bobContext, bobErrors);

    await expect(
      command(bobPage, {
        method: 'open',
        relayEndpoint: RELAY,
        role: 'bob',
        storageKeyHex: BOB_KEY,
      }),
    ).resolves.toMatchObject({ groupCount: 0, role: 'bob' });
    await expect(
      command(bobPage, { method: 'publish_key_package' }),
    ).resolves.toMatchObject({ groupCount: 0, role: 'bob' });

    await expect(
      command(alicePage, {
        method: 'open',
        relayEndpoint: RELAY,
        role: 'alice',
        storageKeyHex: ALICE_KEY,
      }),
    ).resolves.toMatchObject({ groupCount: 0, role: 'alice' });
    await expect(
      command(alicePage, { method: 'create_group' }),
    ).resolves.toMatchObject({
      epoch: 1,
      groupCount: 1,
      memberCount: 2,
      role: 'alice',
    });
    await expect(command(bobPage, { method: 'join' })).resolves.toMatchObject({
      epoch: 1,
      groupCount: 1,
      memberCount: 2,
      role: 'bob',
    });

    await command(alicePage, { content: 'hello Bob', method: 'send' });
    await expect(command(bobPage, { method: 'sync' })).resolves.toMatchObject({
      received: ['hello Bob'],
      role: 'bob',
    });
    await expect(command(bobPage, { method: 'sync' })).resolves.toMatchObject({
      received: [],
      role: 'bob',
    });

    await command(bobPage, { content: 'hello Alice', method: 'send' });
    await expect(command(alicePage, { method: 'sync' })).resolves.toMatchObject(
      {
        received: ['hello Alice'],
        role: 'alice',
      },
    );

    const aliceBeforeBobReload = await command(alicePage, { method: 'status' });
    await command(bobPage, { method: 'close' });
    await bobPage.close();

    await command(alicePage, {
      content: 'offline after Bob reload',
      method: 'send',
    });

    bobPage = await newProfilePage(bobContext, bobErrors);
    const bobReopened = await command(bobPage, {
      method: 'open',
      relayEndpoint: RELAY,
      role: 'bob',
      storageKeyHex: BOB_KEY,
    });
    expect(bobReopened).toMatchObject({
      epoch: 1,
      groupCount: 1,
      memberCount: 2,
      pendingPublishRecovered: false,
      role: 'bob',
    });
    await expect(command(bobPage, { method: 'sync' })).resolves.toMatchObject({
      received: ['offline after Bob reload'],
      role: 'bob',
    });
    await expect(command(bobPage, { method: 'sync' })).resolves.toMatchObject({
      received: [],
      role: 'bob',
    });

    const [aliceFinal, bobFinal] = await Promise.all([
      command(alicePage, { method: 'status' }),
      command(bobPage, { method: 'status' }),
    ]);
    expect(aliceFinal).toMatchObject({
      epoch: 1,
      groupCount: 1,
      memberCount: 2,
      pendingPublishRecovered: false,
      role: 'alice',
    });
    expect(bobFinal).toMatchObject({
      epoch: 1,
      groupCount: 1,
      memberCount: 2,
      pendingPublishRecovered: false,
      role: 'bob',
    });
    expect(aliceFinal.storageGeneration).toBeGreaterThan(
      aliceBeforeBobReload.storageGeneration,
    );
    expect(bobFinal.storageGeneration).toBeGreaterThan(
      bobReopened.storageGeneration,
    );
    expect(aliceErrors).toEqual([]);
    expect(bobErrors).toEqual([]);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
