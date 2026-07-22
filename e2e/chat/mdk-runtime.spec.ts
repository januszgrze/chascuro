import { expect, test } from '@playwright/test';

const MDK_REVISION = 'e391adc133a9b60e420da7a0446f014a180ac8d2';
const STORAGE_KEY_HEX = 'a5'.repeat(32);
const WRONG_STORAGE_KEY_HEX = '5a'.repeat(32);

test('loads the revision-pinned Rust MDK engine in a module worker', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(message.text());
    }
  });
  await page.goto('/');
  const opfsCapability = await page.evaluate(async () => {
    if (navigator.storage?.getDirectory === undefined) {
      return {
        reason: 'navigator.storage.getDirectory is missing',
        supported: false,
      };
    }
    try {
      await navigator.storage.getDirectory();
      return { reason: '', supported: true };
    } catch (error) {
      return {
        reason:
          error instanceof DOMException
            ? `${error.name}: ${error.message}`
            : String(error),
        supported: false,
      };
    }
  });
  test.skip(
    !opfsCapability.supported,
    `OPFS is unavailable in this browser: ${opfsCapability.reason}`,
  );
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('marmot-mdk-runtime', { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') {
        throw error;
      }
    }
  });

  const probe = async (storageKeyHex = STORAGE_KEY_HEX) => {
    try {
      return await page.evaluate(async (storageKeyHex) => {
        if (window.__marmotRuntimeProbe === undefined) {
          throw new Error('The Marmot runtime browser probe is not installed.');
        }
        return window.__marmotRuntimeProbe(storageKeyHex);
      }, storageKeyHex);
    } catch (error) {
      throw new Error(
        `${String(error)}\nBrowser errors:\n${browserErrors.join('\n')}`,
        { cause: error },
      );
    }
  };

  const expected = (
    storageGeneration: number,
    mdkPreviousStateRecovered: boolean,
  ) => ({
    aliceEpoch: 2,
    aliceReceived: 'hello from browser bob',
    backend: 'rust-mdk',
    bobEpoch: 2,
    bobLeft: true,
    bobReceived: 'hello from browser alice',
    engineVector: 'passed',
    flow: 'create/invite/send/receive/leave',
    mdkRelease: 'v0.9.4',
    mdkPreviousStateRecovered,
    mdkRevision: MDK_REVISION,
    mdkStateReload: true,
    publishRollback: true,
    rpcSchemaVersion: 1,
    sqliteImageBytes: 8192,
    sqliteRecovered: 'sqlite-wasi-committed',
    sqliteVector: 'passed',
    storageDurable: 'opfs-encrypted-sqlite-image',
    storageEncryptedAtRest: true,
    storageGeneration,
    storageImageBytes: expect.any(Number),
    storageCheckpoints: 5,
    storageTornWriteRecovered: true,
    transportAdapter: 'app-owned-rust',
    transportVector: 'passed',
  });

  expect(await probe()).toEqual(expected(7, false));
  await expect(probe(WRONG_STORAGE_KEY_HEX)).rejects.toThrow(
    'The MDK runtime could not be started.',
  );
  const exclusiveOpen = await Promise.allSettled([probe(), probe()]);
  const fulfilled = exclusiveOpen.filter(
    (
      result,
    ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof probe>>> =>
      result.status === 'fulfilled',
  );
  const rejected = exclusiveOpen.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  expect(fulfilled).toHaveLength(1);
  expect(fulfilled[0]?.value).toEqual(expected(14, true));
  expect(rejected).toHaveLength(1);
  expect(String(rejected[0]?.reason)).toContain(
    'The MDK runtime could not be started.',
  );

  const atRest = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('marmot-mdk-runtime');
    return Promise.all(
      ['account-device-slot-0.bin', 'account-device-slot-1.bin'].map(
        async (name) => {
          const handle = await directory.getFileHandle(name);
          const file = await handle.getFile();
          const content = new TextDecoder().decode(await file.arrayBuffer());
          return {
            containsProbeSchema: content.includes('durable_runtime_probe'),
            containsRuntimeAccounts: content.includes('runtime_accounts'),
            containsSqliteHeader: content.includes('SQLite format 3'),
            name,
            size: file.size,
          };
        },
      ),
    );
  });
  expect(atRest.map(({ name }) => name)).toEqual([
    'account-device-slot-0.bin',
    'account-device-slot-1.bin',
  ]);
  for (const slot of atRest) {
    expect(slot.containsProbeSchema).toBe(false);
    expect(slot.containsRuntimeAccounts).toBe(false);
    expect(slot.containsSqliteHeader).toBe(false);
    expect(slot.size).toBeGreaterThan(8249);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await probe()).toEqual(expected(21, true));
  expect(
    browserErrors.filter(
      (message) =>
        !(
          message.includes('Content-Security-Policy') &&
          message.includes('font-src') &&
          message.includes('data:font/')
        ) &&
        !(
          message.startsWith("Loading the font 'data:font/") &&
          message.includes(
            `Content Security Policy directive: "font-src 'self'"`,
          )
        ),
    ),
  ).toEqual([]);

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('marmot-mdk-runtime', { recursive: true });
    try {
      await root.getDirectoryHandle('marmot-mdk-runtime');
      throw new Error('Marmot OPFS directory still exists after erase.');
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') {
        throw error;
      }
    }
  });
});
