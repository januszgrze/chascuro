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

async function synchronize(page: Page): Promise<void> {
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
  await expect(chat).toHaveAttribute('aria-busy', 'false', {
    timeout: 10_000,
  });
}

async function createConversation(page: Page, address: string): Promise<void> {
  if (await page.getByRole('button', { name: 'New chat' }).isVisible()) {
    await page.getByRole('button', { name: 'New chat' }).click();
  } else {
    await page.getByRole('button', { name: 'Scan a contact' }).click();
  }
  await page
    .getByRole('searchbox', { name: 'Search a name or paste an invite' })
    .fill(address);
  await page.getByRole('button', { name: 'Start a chat' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review contact' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create invite' }).click();
  await expect(
    page.getByRole('heading', { name: 'Encrypted conversation' }),
  ).toBeVisible();
}

function conversationRow(page: Page, index: number) {
  return page
    .locator('ul.chat-conversation-list > li > button.chat-row-button')
    .nth(index);
}

async function acceptOnlyInvite(page: Page): Promise<void> {
  await openChatList(page);
  await synchronize(page);
  await page.getByRole('button', { name: /Encrypted conversation/u }).click();
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(
    page.getByRole('heading', { name: 'Encrypted conversation' }),
  ).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  const message = page
    .getByRole('listitem')
    .filter({ has: page.getByText(text, { exact: true }) });
  await expect(message).toBeVisible({ timeout: 15_000 });
  await expect(message.getByText('Published to relay')).toBeVisible();
}

test('one product profile keeps two MDK conversations isolated across reload and leave', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const carolContext = await browser.newContext();
  const aliceErrors: string[] = [];
  const bobErrors: string[] = [];
  const carolErrors: string[] = [];

  try {
    const alice = await openDisposableWallet(aliceContext, aliceErrors);
    const bob = await openDisposableWallet(bobContext, bobErrors);
    const carol = await openDisposableWallet(carolContext, carolErrors);
    const aliceAddress = await createChatIdentity(alice);
    const bobAddress = await createChatIdentity(bob);
    const carolAddress = await createChatIdentity(carol);
    expect(new Set([aliceAddress, bobAddress, carolAddress]).size).toBe(3);

    await createConversation(alice, bobAddress);
    await openChatList(alice);
    await createConversation(alice, carolAddress);
    await acceptOnlyInvite(bob);
    await acceptOnlyInvite(carol);

    await openChatList(alice);
    await conversationRow(alice, 0).click();
    await send(alice, 'private for Bob');
    await openChatList(alice);
    await conversationRow(alice, 1).click();
    await send(alice, 'private for Carol');

    await openChatList(bob);
    await synchronize(bob);
    await bob.getByRole('button', { name: /Encrypted conversation/u }).click();
    await expect(bob.getByText('private for Bob')).toBeVisible();
    await expect(bob.getByText('private for Carol')).toHaveCount(0);

    await openChatList(carol);
    await synchronize(carol);
    await carol
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await expect(carol.getByText('private for Carol')).toBeVisible();
    await expect(carol.getByText('private for Bob')).toHaveCount(0);

    await alice.reload();
    await expect(
      alice.getByRole('heading', { name: 'Wallet home' }),
    ).toBeVisible();
    await alice.getByRole('button', { name: 'Chat' }).click();
    await expect(conversationRow(alice, 0)).toBeVisible();
    await expect(conversationRow(alice, 1)).toBeVisible();
    await conversationRow(alice, 0).click();
    await send(alice, 'Bob after Alice reload');

    await openChatList(bob);
    await synchronize(bob);
    await bob.getByRole('button', { name: /Encrypted conversation/u }).click();
    await expect(bob.getByText('Bob after Alice reload')).toBeVisible();

    for (let index = 1; index <= 12; index += 1) {
      await send(alice, `volume message ${index.toString().padStart(2, '0')}`);
    }
    await openChatList(bob);
    await synchronize(bob);
    await bob.getByRole('button', { name: /Encrypted conversation/u }).click();
    await expect(bob.getByText('volume message 01')).toBeVisible();
    await expect(bob.getByText('volume message 12')).toBeVisible();

    await openChatList(carol);
    await carol
      .getByRole('button', { name: /Encrypted conversation/u })
      .click();
    await send(carol, 'Carol to reloaded Alice');
    await openChatList(alice);
    await synchronize(alice);
    await conversationRow(alice, 1).click();
    await expect(alice.getByText('Carol to reloaded Alice')).toBeVisible();

    await carol.getByRole('button', { name: 'Conversation details' }).click();
    await carol
      .getByLabel('I understand I cannot undo leaving from this device.')
      .check();
    await carol.getByRole('button', { name: 'Leave conversation' }).click();
    await openChatList(alice);
    await synchronize(alice);
    await conversationRow(alice, 1).click();
    await alice.getByRole('button', { name: 'Conversation details' }).click();
    await expect(alice.locator('.chat-details-card')).toContainText('1');

    await openChatList(alice);
    await conversationRow(alice, 0).click();
    await alice.getByRole('button', { name: 'Conversation details' }).click();
    await expect(alice.locator('.chat-details-card')).toContainText('2');

    const duplicate = await aliceContext.newPage();
    captureUnexpectedErrors(duplicate, aliceErrors);
    await duplicate.goto('/');
    await expect(
      duplicate.getByText(
        'Close the wallet in the other tab before continuing.',
      ),
    ).toBeVisible({ timeout: 15_000 });
    await duplicate.close();

    await openChatList(alice);
    await alice.getByRole('button', { name: 'Back to wallet' }).click();
    await alice.getByRole('button', { name: 'Backup and settings' }).click();
    await alice.getByText('Wallet', { exact: true }).click();
    await alice.getByRole('button', { name: 'Lock wallet' }).click();
    await expect(
      alice.getByRole('heading', { name: 'Wallet home' }),
    ).toBeVisible({ timeout: 15_000 });
    await alice.getByRole('button', { name: 'Chat' }).click();
    await expect(conversationRow(alice, 0)).toBeVisible();
    await expect(conversationRow(alice, 1)).toBeVisible();
    await conversationRow(alice, 0).click();
    await expect(alice.getByText('Bob after Alice reload')).toBeVisible();

    const storageEvidence = await alice.evaluate(async () => {
      const serialized: string[] = [
        ...Object.entries(localStorage).flat(),
        ...Object.entries(sessionStorage).flat(),
      ];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          serialized.push(request.url);
          const response = await cache.match(request);
          if (response !== undefined) serialized.push(await response.text());
        }
      }
      for (const database of await indexedDB.databases()) {
        if (database.name === undefined) continue;
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const opening = indexedDB.open(database.name!);
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const db = opening.result;
            const stores = [...db.objectStoreNames];
            if (stores.length === 0) {
              db.close();
              resolve([]);
              return;
            }
            const transaction = db.transaction(stores, 'readonly');
            const collected: unknown[] = [];
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => {
              db.close();
              resolve(collected);
            };
            for (const storeName of stores) {
              const request = transaction.objectStore(storeName).getAll();
              request.onsuccess = () => collected.push(...request.result);
            }
          };
        });
        serialized.push(JSON.stringify(values));
      }
      const memory = performance as Performance & {
        readonly memory?: { readonly usedJSHeapSize: number };
      };
      return {
        serialized: serialized.join('\n'),
        usage: (await navigator.storage.estimate()).usage ?? 0,
        usedJsHeapSize: memory.memory?.usedJSHeapSize ?? 0,
      };
    });
    expect(storageEvidence.serialized).not.toContain('private for Bob');
    expect(storageEvidence.serialized).not.toContain('private for Carol');
    expect(storageEvidence.serialized).not.toContain('Bob after Alice reload');
    expect(storageEvidence.serialized).not.toContain('Carol to reloaded Alice');
    expect(storageEvidence.serialized).not.toContain('volume message 01');
    expect(storageEvidence.serialized).not.toContain('volume message 12');
    expect(storageEvidence.usage).toBeLessThan(64 * 1024 * 1024);
    expect(storageEvidence.usedJsHeapSize).toBeGreaterThan(0);
    expect(storageEvidence.usedJsHeapSize).toBeLessThan(256 * 1024 * 1024);

    await openChatList(alice);
    await alice.getByRole('button', { name: 'Back to wallet' }).click();
    await alice.getByRole('button', { name: 'Backup and settings' }).click();
    await alice.getByText('Wallet Recovery', { exact: true }).click();
    await alice.getByLabel('Type ERASE').fill('ERASE');
    await alice.getByRole('button', { name: 'Erase wallet data' }).click();
    await expect(
      alice.getByRole('heading', { name: 'Choose a federation' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      alice.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        let chatDatabasePresent = true;
        try {
          await root.getDirectoryHandle('marmot-mdk-runtime');
        } catch (error) {
          chatDatabasePresent =
            !(error instanceof DOMException) || error.name !== 'NotFoundError';
        }
        return {
          cacheCount: (await caches.keys()).length,
          chatDatabasePresent,
          registrationCount: (await navigator.serviceWorker.getRegistrations())
            .length,
        };
      }),
    ).resolves.toEqual({
      cacheCount: 0,
      chatDatabasePresent: false,
      registrationCount: 0,
    });

    expect(aliceErrors).toEqual([]);
    expect(bobErrors).toEqual([]);
    expect(carolErrors).toEqual([]);
  } finally {
    await aliceContext.close();
    await bobContext.close();
    await carolContext.close();
  }
});
