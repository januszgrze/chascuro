import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import type {
  MdkTwoProfileCommand,
  MdkTwoProfileResult,
} from '../../src/services/chat/mdk-two-profile-rpc';

const RELAY = 'ws://127.0.0.1:4877/accept';
const ALICE_KEY = 'c3'.repeat(32);
const NATIVE_TARGET =
  process.env.MARMOT_NATIVE_TARGET_DIR ?? '/tmp/mdk-v094-cli-target';
const WN = join(NATIVE_TARGET, 'debug', 'wn');
const WND = join(NATIVE_TARGET, 'debug', 'wnd');

interface NativeEnvelope {
  readonly ok: boolean;
  readonly result?: unknown;
}

function nativeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WN_ALLOW_LOOPBACK_RELAYS: '1',
    WN_DEV_SETTLEMENT_QUIESCENCE_MS: '0',
    WN_RELAY: RELAY,
  };
}

function nativeCommand(
  home: string,
  args: readonly string[],
  timeout = 30_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      WN,
      [
        '--home',
        home,
        '--secret-store',
        'file',
        '--relay',
        RELAY,
        '--json',
        ...args,
      ],
      {
        encoding: 'utf8',
        env: nativeEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              `The native White Noise command failed: ${stderr.slice(-2048)}`,
            ),
          );
          return;
        }
        try {
          const envelope = JSON.parse(stdout) as NativeEnvelope;
          if (!envelope.ok || envelope.result === undefined) {
            reject(
              new Error(
                'The native White Noise command returned an invalid result.',
              ),
            );
            return;
          }
          resolve(envelope.result);
        } catch {
          reject(
            new Error('The native White Noise command returned invalid JSON.'),
          );
        }
      },
    );
  });
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function stringField(value: unknown, name: string): string {
  const candidate = field(value, name);
  if (typeof candidate !== 'string') {
    throw new Error(`The native White Noise ${name} field is invalid.`);
  }
  return candidate;
}

function messagesWithPlaintext(value: unknown, plaintext: string): number {
  const messages = field(value, 'messages');
  return Array.isArray(messages)
    ? messages.filter((message) => field(message, 'plaintext') === plaintext)
        .length
    : 0;
}

function startDaemon(home: string): {
  readonly child: ChildProcess;
  readonly diagnostics: () => string;
} {
  let output = '';
  const child = spawn(
    WND,
    [
      '--home',
      home,
      '--socket',
      join(home, 'dev', 'wnd.sock'),
      '--secret-store',
      'file',
      '--discovery-relays',
      RELAY,
      '--default-account-relays',
      RELAY,
    ],
    { env: nativeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const retain = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-16_384);
  };
  child.stdout?.on('data', retain);
  child.stderr?.on('data', retain);
  return { child, diagnostics: () => output };
}

async function waitForDaemon(
  home: string,
  child: ChildProcess,
  diagnostics: () => string,
): Promise<void> {
  const socket = join(home, 'dev', 'wnd.sock');
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null || !existsSync(socket)) return false;
          try {
            return (
              field(
                await nativeCommand(home, ['daemon', 'status'], 750),
                'running',
              ) === true
            );
          } catch {
            return false;
          }
        },
        { message: 'native daemon did not become ready', timeout: 30_000 },
      )
      .toBe(true);
  } catch {
    throw new Error(
      `The native daemon did not become ready. ${diagnostics().trim()}`,
    );
  }
}

async function stopDaemon(home: string, child: ChildProcess): Promise<void> {
  try {
    await nativeCommand(home, ['daemon', 'stop'], 5_000);
  } catch {
    child.kill('SIGTERM');
  }
  await expect
    .poll(() => child.exitCode !== null, { timeout: 10_000 })
    .toBe(true);
}

async function browserCommand(
  page: Page,
  command: MdkTwoProfileCommand,
): Promise<MdkTwoProfileResult> {
  return page.evaluate(async (request) => {
    if (window.__marmotTwoProfileProbe === undefined) {
      throw new Error('The Marmot two-profile probe is not installed.');
    }
    return window.__marmotTwoProfileProbe(request);
  }, command);
}

function captureUnexpectedErrors(page: Page, errors: string[]): void {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const knownFontError =
      text.includes('font-src') && text.includes('data:font/');
    if (!knownFontError) errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(error.message));
}

test('Chromium interoperates bidirectionally with unmodified MDK 0.9.4 wn/wnd', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  expect(execFileSync(WN, ['--version'], { encoding: 'utf8' }).trim()).toBe(
    'wn 0.9.4',
  );

  const nativeHome = mkdtempSync('/tmp/marmot-native-peer-');
  const context = await browser.newContext();
  const browserErrors: string[] = [];
  let daemon: ReturnType<typeof startDaemon> | undefined;

  try {
    console.log('[native-interop] create native account and key package');
    const account = await nativeCommand(nativeHome, [
      'account',
      'create',
      '--default-relays',
      RELAY,
      '--bootstrap-relays',
      RELAY,
    ]);
    const nativeAccount = stringField(account, 'account_id');
    await nativeCommand(nativeHome, [
      '--account',
      nativeAccount,
      'keys',
      'rotate',
    ]);

    console.log('[native-interop] start native daemon');
    daemon = startDaemon(nativeHome);
    await waitForDaemon(nativeHome, daemon.child, daemon.diagnostics);

    console.log('[native-interop] create browser group and native join');
    let page = await context.newPage();
    captureUnexpectedErrors(page, browserErrors);
    await page.goto('/');
    await browserCommand(page, {
      method: 'open',
      relayEndpoint: RELAY,
      role: 'alice',
      storageKeyHex: ALICE_KEY,
    });
    await expect(
      browserCommand(page, { method: 'create_group' }),
    ).resolves.toMatchObject({ epoch: 1, groupCount: 1, memberCount: 2 });

    let nativeGroup = '';
    await expect
      .poll(
        async () => {
          const sync = await nativeCommand(nativeHome, [
            '--account',
            nativeAccount,
            'sync',
          ]);
          const joined = field(sync, 'joined_groups');
          if (Array.isArray(joined) && typeof joined[0] === 'string') {
            nativeGroup = joined[0];
          }
          return nativeGroup;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^[0-9a-f]+$/u);

    await browserCommand(page, {
      content: 'browser to native',
      method: 'send',
    });
    await expect
      .poll(
        async () => {
          await nativeCommand(nativeHome, ['--account', nativeAccount, 'sync']);
          return messagesWithPlaintext(
            await nativeCommand(nativeHome, [
              '--account',
              nativeAccount,
              'messages',
              'list',
              nativeGroup,
              '--limit',
              '20',
            ]),
            'browser to native',
          );
        },
        { timeout: 30_000 },
      )
      .toBe(1);

    console.log('[native-interop] native sends to browser');
    await nativeCommand(nativeHome, [
      '--account',
      nativeAccount,
      'messages',
      'send',
      nativeGroup,
      'native to browser',
    ]);
    await expect(
      browserCommand(page, { method: 'sync' }),
    ).resolves.toMatchObject({ received: ['native to browser'] });

    console.log('[native-interop] stop both peers and queue offline messages');
    await stopDaemon(nativeHome, daemon.child);
    daemon = undefined;
    await browserCommand(page, {
      content: 'browser while native offline',
      method: 'send',
    });
    await browserCommand(page, { method: 'close' });
    await page.close();

    console.log('[native-interop] restart native daemon and catch up');
    daemon = startDaemon(nativeHome);
    await waitForDaemon(nativeHome, daemon.child, daemon.diagnostics);
    await expect
      .poll(
        async () => {
          await nativeCommand(nativeHome, ['--account', nativeAccount, 'sync']);
          return messagesWithPlaintext(
            await nativeCommand(nativeHome, [
              '--account',
              nativeAccount,
              'messages',
              'list',
              nativeGroup,
              '--limit',
              '20',
            ]),
            'browser while native offline',
          );
        },
        { timeout: 30_000 },
      )
      .toBe(1);

    await nativeCommand(nativeHome, [
      '--account',
      nativeAccount,
      'messages',
      'send',
      nativeGroup,
      'native after both restart',
    ]);

    console.log('[native-interop] reopen browser and verify final parity');
    page = await context.newPage();
    captureUnexpectedErrors(page, browserErrors);
    await page.goto('/');
    await expect(
      browserCommand(page, {
        method: 'open',
        relayEndpoint: RELAY,
        role: 'alice',
        storageKeyHex: ALICE_KEY,
      }),
    ).resolves.toMatchObject({
      epoch: 1,
      groupCount: 1,
      memberCount: 2,
      pendingPublishRecovered: false,
    });
    await expect(
      browserCommand(page, { method: 'sync' }),
    ).resolves.toMatchObject({ received: ['native after both restart'] });
    await expect(
      browserCommand(page, { method: 'sync' }),
    ).resolves.toMatchObject({ received: [] });

    const nativeStatus = await nativeCommand(nativeHome, [
      '--account',
      nativeAccount,
      'groups',
      'show',
      nativeGroup,
    ]);
    expect(field(field(nativeStatus, 'mls'), 'epoch')).toBe(1);
    expect(field(field(nativeStatus, 'mls'), 'member_count')).toBe(2);
    await expect(
      browserCommand(page, { method: 'status' }),
    ).resolves.toMatchObject({ epoch: 1, groupCount: 1, memberCount: 2 });
    expect(browserErrors).toEqual([]);
  } finally {
    if (daemon !== undefined) {
      await stopDaemon(nativeHome, daemon.child);
    }
    await context.close();
    rmSync(nativeHome, { force: true, recursive: true });
  }
});
