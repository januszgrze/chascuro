import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const TEST_FEDERATION_INVITE = 'fedimint browser test invite';

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

async function openDisposableWallet(
  context: BrowserContext,
  errors: string[],
): Promise<Page> {
  const page = await context.newPage();
  captureUnexpectedErrors(page, errors);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Choose a federation' }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Federation invite' })
    .fill(TEST_FEDERATION_INVITE);
  await page.getByRole('button', { name: 'Preview federation' }).click();
  await expect(page.getByText('Demo Federation')).toBeVisible();
  await page.getByRole('button', { name: 'Join federation' }).click();
  await expect(
    page.getByRole('heading', { name: "You're ready" }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to wallet' }).click();
  await expect(
    page.getByRole('heading', { name: 'Wallet home' }),
  ).toBeVisible();
  return page;
}

async function createChatIdentity(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await page.getByRole('button', { name: 'Set up chat' }).click();
  await page
    .getByLabel(
      'I understand chat is experimental and has no backup or recovery yet.',
    )
    .check();
  await page.getByRole('button', { name: 'Create chat identity' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your chat address' }),
  ).toBeVisible();
  return (
    (await page
      .locator('.chat-detail-chip')
      .filter({ hasText: 'Public address' })
      .locator('.chat-chip-value')
      .textContent()) ?? ''
  ).trim();
}

async function openChatList(page: Page): Promise<void> {
  await page.bringToFront();
  if (
    await page.getByRole('button', { name: 'Back to conversation' }).isVisible()
  ) {
    await page.getByRole('button', { name: 'Back to conversation' }).click();
  }
  if (await page.getByRole('button', { name: 'Chats' }).isVisible()) {
    await page.getByRole('button', { name: 'Chats' }).click();
  } else if (
    await page.getByRole('button', { name: 'Back to chats' }).isVisible()
  ) {
    await page.getByRole('button', { name: 'Back to chats' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
}

async function syncChat(page: Page): Promise<void> {
  const chat = page.getByRole('region', { name: 'Chats' });
  await expect(chat).toHaveAttribute('aria-busy', 'false', {
    timeout: 10_000,
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(100);
  await expect(chat).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
}

test('two product profiles set up, invite, exchange, reload, and catch up', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const aliceErrors: string[] = [];
  const bobErrors: string[] = [];

  try {
    const alicePage = await openDisposableWallet(aliceContext, aliceErrors);
    const bobPage = await openDisposableWallet(bobContext, bobErrors);
    const aliceAddress = await createChatIdentity(alicePage);
    const bobAddress = await createChatIdentity(bobPage);

    expect(aliceAddress).toMatch(/^npub1/u);
    expect(bobAddress).toMatch(/^npub1/u);
    expect(aliceAddress).not.toBe(bobAddress);

    await alicePage.getByRole('button', { name: 'Scan a contact' }).click();
    await alicePage
      .getByRole('searchbox', { name: 'Search a name or paste an invite' })
      .fill(bobAddress);
    await alicePage.getByRole('button', { name: 'Start a chat' }).click();
    await expect(
      alicePage.getByRole('heading', { name: 'Review contact' }),
    ).toBeVisible();
    await alicePage.getByRole('button', { name: 'Create invite' }).click();
    await expect(
      alicePage.getByRole('heading', { name: 'Encrypted conversation' }),
    ).toBeVisible();

    await openChatList(bobPage);
    await syncChat(bobPage);
    await bobPage
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await bobPage.getByRole('button', { name: 'Accept invite' }).click();
    await expect(
      bobPage.getByRole('heading', { name: 'Encrypted conversation' }),
    ).toBeVisible();

    await alicePage.getByRole('button', { name: 'More actions' }).click();
    await alicePage.getByRole('menuitem', { name: /Pay/u }).click();
    await alicePage.getByRole('button', { name: '1', exact: true }).click();
    await alicePage.getByRole('button', { name: '0', exact: true }).click();
    await alicePage.getByRole('button', { name: '0', exact: true }).click();
    await alicePage.getByRole('button', { name: 'Send payment' }).click();
    await expect(
      alicePage.getByRole('dialog', { name: 'Payment sent' }),
    ).toBeVisible();
    await alicePage.getByRole('button', { name: 'Done' }).click();

    await alicePage
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('hello from Alice');
    await alicePage.getByRole('button', { name: 'Send message' }).click();
    await expect(alicePage.getByText('hello from Alice')).toBeVisible();

    await openChatList(bobPage);
    await syncChat(bobPage);
    await bobPage
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await expect(bobPage.getByText('hello from Alice')).toBeVisible();
    await expect(bobPage.getByRole('button', { name: 'Claim' })).toBeVisible();
    await bobPage.getByRole('button', { name: 'Claim' }).click();
    await expect(bobPage.getByText('Claimed')).toBeVisible();

    await bobPage
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('hello from Bob');
    await bobPage.getByRole('button', { name: 'Send message' }).click();
    await expect(bobPage.getByText('hello from Bob')).toBeVisible();

    await openChatList(alicePage);
    await syncChat(alicePage);
    await alicePage
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await expect(alicePage.getByText('hello from Bob')).toBeVisible();

    await bobPage.reload();
    await expect(
      bobPage.getByRole('heading', { name: 'Wallet home' }),
    ).toBeVisible();
    await bobPage.getByRole('button', { name: 'Chat' }).click();
    await bobPage
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await expect(bobPage.getByText('hello from Alice')).toBeVisible();
    await expect(bobPage.getByText('hello from Bob')).toBeVisible();

    await alicePage
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('after Bob reload');
    await alicePage.getByRole('button', { name: 'Send message' }).click();
    await openChatList(bobPage);
    await syncChat(bobPage);
    await bobPage
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await expect(bobPage.getByText('after Bob reload')).toBeVisible();

    await bobPage.getByRole('button', { name: 'Conversation details' }).click();
    await bobPage
      .getByLabel('I understand I cannot undo leaving from this device.')
      .check();
    await bobPage.getByRole('button', { name: 'Leave conversation' }).click();
    await expect(bobPage.getByRole('heading', { name: 'Chats' })).toBeVisible();
    await expect(bobPage.getByText('You left this conversation')).toBeVisible();

    await openChatList(alicePage);
    await syncChat(alicePage);
    await alicePage
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await alicePage
      .getByRole('button', { name: 'Conversation details' })
      .click();
    await expect(alicePage.locator('.chat-details-card')).toContainText('1');

    await syncFromConversation(bobPage);
    await bobPage
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await expect(
      bobPage.getByText(
        'You can read saved history, but you can no longer send messages here.',
      ),
    ).toBeVisible();
    await expect(
      bobPage.getByRole('textbox', { name: 'Message', exact: true }),
    ).toHaveCount(0);

    expect(aliceErrors).toEqual([]);
    expect(bobErrors).toEqual([]);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

async function syncFromConversation(page: Page): Promise<void> {
  await openChatList(page);
  await syncChat(page);
}
