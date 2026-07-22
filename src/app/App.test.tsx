import { webcrypto } from 'node:crypto';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  EncryptedRecordStore,
  encryptedRecordKeyringStorageId,
} from '../services/persistence/encrypted-record-store';
import { walletProfileV2Schema } from '../services/persistence/schemas/wallet-profile';
import { VaultSession } from '../services/persistence/vault';
import { MemoryVaultStore } from '../services/persistence/vault-store';
import type { CapabilityReport } from '../services/security/capabilities';
import { FakeWalletService } from '../services/wallet';
import { WalletError } from '../domain';
import { WalletApp } from './App';
import type { WalletOwnership } from './wallet-app-controller';
import { WALLET_RECORD_ID } from './wallet-record';

const PIN = '1234';
const INVITE = 'fedimint test invite code';
const SUPPORTED: CapabilityReport = {
  supported: true,
  missing: [],
};
const TEST_CRYPTO = webcrypto as unknown as Crypto;

interface AppHarness {
  service: FakeWalletService;
  store: MemoryVaultStore;
  user: ReturnType<typeof userEvent.setup>;
  unmount(): void;
}

async function enterPin(
  user: ReturnType<typeof userEvent.setup>,
  pin = PIN,
): Promise<void> {
  for (const digit of pin) {
    await user.click(screen.getByRole('button', { name: digit }));
  }
}

async function continuePastReady(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await screen.findByRole('heading', { name: "You're ready" });
  await user.click(screen.getByRole('button', { name: 'Go to wallet' }));
  await screen.findByRole('heading', { name: 'Wallet home' });
}

async function renderUnlockedApp(latencyMs = 0): Promise<AppHarness> {
  let nextId = 0;
  const service = new FakeWalletService({
    latencyMs,
    clock: () => 1_000,
    idFactory: () => `test-id-${++nextId}`,
  });
  const store = new MemoryVaultStore();
  const user = userEvent.setup();

  const rendered = render(
    <WalletApp
      walletService={service}
      vaultStore={store}
      capabilityReport={SUPPORTED}
      vaultOptions={{ crypto: TEST_CRYPTO, iterations: 1 }}
      now={() => 1_000}
      walletDataEraser={async (storage) => storage.clear?.()}
      walletOwner={{
        acquire: async () => undefined,
        release: async () => undefined,
        dispose: async () => undefined,
      }}
      inactivityLock={{
        arm: () => 1,
        disarm: () => undefined,
        dispose: () => undefined,
      }}
    />,
  );

  await screen.findByRole('heading', { name: 'Chascuro' });
  await user.click(
    screen.getByRole('button', { name: 'App is added to home' }),
  );
  await screen.findByRole('heading', { name: 'Chascuro' });
  await user.click(screen.getByRole('button', { name: 'Create a wallet' }));
  await screen.findByRole('heading', { name: 'Your recovery phrase' });
  await user.click(
    screen.getByRole('button', { name: "I've written it down" }),
  );

  await screen.findByRole('heading', { name: 'Create PIN' });
  await enterPin(user);
  await user.click(screen.getByRole('button', { name: 'Create PIN' }));
  await screen.findByRole('heading', { name: 'Confirm PIN' });
  await enterPin(user);
  await user.click(screen.getByRole('button', { name: 'Confirm PIN' }));

  await screen.findByRole('heading', { name: 'Choose a federation' });

  return { service, store, user, unmount: rendered.unmount };
}

async function renderStoredApp(
  store: MemoryVaultStore,
  walletOwner: WalletOwnership = {
    acquire: async () => undefined,
    release: async () => undefined,
    dispose: async () => undefined,
  },
): Promise<AppHarness> {
  const service = new FakeWalletService({
    latencyMs: 0,
    clock: () => 2_000,
    idFactory: () => 'restored-id',
  });
  const user = userEvent.setup();
  const rendered = render(
    <WalletApp
      walletService={service}
      vaultStore={store}
      capabilityReport={SUPPORTED}
      vaultOptions={{ crypto: TEST_CRYPTO, iterations: 1 }}
      now={() => 2_000}
      walletDataEraser={async (storage) => storage.clear?.()}
      walletOwner={walletOwner}
      inactivityLock={{
        arm: () => 1,
        disarm: () => undefined,
        dispose: () => undefined,
      }}
    />,
  );

  await screen.findByRole('heading', { name: 'Enter PIN' });
  return { service, store, user, unmount: rendered.unmount };
}

async function previewFederation(harness: AppHarness) {
  const previewSpy = vi.spyOn(harness.service.federation, 'preview');
  const joinSpy = vi.spyOn(harness.service.federation, 'join');

  await harness.user.type(screen.getByLabelText('Federation invite'), INVITE);
  await harness.user.click(
    screen.getByRole('button', { name: 'Preview federation' }),
  );
  await screen.findByText('Demo Federation');

  expect(previewSpy).toHaveBeenCalledWith(INVITE, expect.any(AbortSignal));
  expect(document.body).not.toHaveTextContent(INVITE);

  return joinSpy;
}

describe('WalletApp federation flow', () => {
  it('takes an explicit disposable test wallet straight to federation input', async () => {
    const store = new MemoryVaultStore();
    render(
      <WalletApp
        walletService={new FakeWalletService({ latencyMs: 0 })}
        vaultStore={store}
        capabilityReport={SUPPORTED}
        vaultOptions={{ crypto: TEST_CRYPTO, iterations: 1 }}
        disposableTestWallet
        walletOwner={{
          acquire: async () => undefined,
          release: async () => undefined,
          dispose: async () => undefined,
        }}
        inactivityLock={{
          arm: () => 1,
          disarm: () => undefined,
          dispose: () => undefined,
        }}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Choose a federation' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Your recovery phrase' }),
    ).not.toBeInTheDocument();

    const records = await EncryptedRecordStore.open({
      storage: store,
      passphrase: 'disposable-fedimint-browser-test-wallet',
      namespace: WALLET_RECORD_ID,
      crypto: TEST_CRYPTO,
    });
    const profile = await records.get(walletProfileV2Schema, WALLET_RECORD_ID);
    expect(profile?.payload.identity).toEqual({ status: 'initialized' });
    records.lock();
  });

  it('restores a wallet from the onboarding recovery phrase screen', async () => {
    const service = new FakeWalletService({ latencyMs: 0 });
    const store = new MemoryVaultStore();
    const user = userEvent.setup();
    render(
      <WalletApp
        walletService={service}
        vaultStore={store}
        capabilityReport={SUPPORTED}
        vaultOptions={{ crypto: TEST_CRYPTO, iterations: 1 }}
        walletOwner={{
          acquire: async () => undefined,
          release: async () => undefined,
          dispose: async () => undefined,
        }}
        inactivityLock={{
          arm: () => 1,
          disarm: () => undefined,
          dispose: () => undefined,
        }}
      />,
    );

    await screen.findByRole('heading', { name: 'Chascuro' });
    await user.click(
      screen.getByRole('button', { name: 'App is added to home' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Restore another wallet' }),
    );
    await screen.findByRole('heading', { name: 'Restore your wallet' });

    const restoreButton = screen.getByRole('button', {
      name: 'Restore wallet',
    });
    expect(restoreButton).toBeDisabled();

    const recoveryWords = [
      'gravity',
      'ocean',
      'pigeon',
      'thunder',
      'velvet',
      'cactus',
      'ridge',
      'salmon',
      'hollow',
      'jungle',
      'marble',
      'tornado',
    ];
    for (const [index, word] of recoveryWords.entries()) {
      await user.type(
        screen.getByLabelText(`Recovery word ${index + 1}`),
        word,
      );
    }

    expect(restoreButton).toBeEnabled();
    await user.click(restoreButton);
    await screen.findByRole('heading', { name: 'Create PIN' });
  });

  it('fails closed with an accessible unsupported-browser screen', async () => {
    render(
      <WalletApp
        walletService={new FakeWalletService({ latencyMs: 0 })}
        capabilityReport={{
          supported: false,
          missing: ['secure-context', 'web-crypto'],
        }}
      />,
    );

    expect(
      await screen.findByRole('heading', {
        name: "This browser isn't supported",
      }),
    ).toBeVisible();
    expect(screen.getByText('Secure connection (HTTPS)')).toBeVisible();
    expect(screen.getByText('Browser encryption (Web Crypto)')).toBeVisible();
  });

  it('previews a sanitized federation without joining it', async () => {
    const harness = await renderUnlockedApp();
    const joinSpy = await previewFederation(harness);

    expect(screen.getByText('Demo Federation')).toBeVisible();
    expect(screen.getByText('4 guardians online')).toBeVisible();
    expect(joinSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Join federation' }),
    ).toBeEnabled();
  });

  it('does not expose a lock action before a federation is joined', async () => {
    const harness = await renderUnlockedApp();

    expect(
      screen.queryByRole('button', { name: 'Lock wallet' }),
    ).not.toBeInTheDocument();
    expect(harness.service.getSnapshot().lifecycle).not.toBe('closed');
  });

  it('joins a federation with the single join confirmation', async () => {
    const harness = await renderUnlockedApp();
    const joinSpy = await previewFederation(harness);
    const joinButton = screen.getByRole('button', {
      name: 'Join federation',
    });

    expect(joinButton).toBeEnabled();
    expect(joinSpy).not.toHaveBeenCalled();

    await harness.user.click(joinButton);
    await continuePastReady(harness.user);

    expect(joinSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('25000')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Wallet home' })).toBeVisible();
    const keyring = await harness.store.get(
      encryptedRecordKeyringStorageId(WALLET_RECORD_ID),
    );
    expect(keyring).toBeDefined();
    expect(JSON.stringify(keyring)).not.toContain('Demo Federation');
    const records = await EncryptedRecordStore.open({
      storage: harness.store,
      passphrase: PIN,
      namespace: WALLET_RECORD_ID,
      crypto: TEST_CRYPTO,
    });
    const storedProfile = await records.get(
      walletProfileV2Schema,
      WALLET_RECORD_ID,
    );
    expect(storedProfile?.payload).toMatchObject({
      mode: 'fake',
      identity: {
        status: 'initialized',
      },
      activeFederation: {
        displayName: 'Demo Federation',
        federationId: 'demo-fedimint-federation',
      },
    });
    records.lock();
    expect(screen.getByRole('button', { name: 'Receive' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  it('suppresses a double join submission', async () => {
    const harness = await renderUnlockedApp(10);
    const joinSpy = await previewFederation(harness);
    const joinButton = screen.getByRole('button', {
      name: 'Join federation',
    });

    fireEvent.click(joinButton);
    fireEvent.click(joinButton);

    await continuePastReady(harness.user);
    expect(joinSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts late work and closes the service before locking the vault', async () => {
    const harness = await renderUnlockedApp();
    await previewFederation(harness);
    await harness.user.click(
      screen.getByRole('button', { name: 'Join federation' }),
    );
    await continuePastReady(harness.user);

    const order: string[] = [];
    const originalClose = harness.service.close.bind(harness.service);
    vi.spyOn(harness.service, 'close').mockImplementation(async () => {
      order.push('service:close:start');
      await originalClose();
      order.push('service:close:end');
    });
    const originalLock = VaultSession.prototype.lock;
    vi.spyOn(VaultSession.prototype, 'lock').mockImplementation(function (
      this: VaultSession<unknown>,
    ) {
      order.push('vault:lock');
      originalLock.call(this);
    });
    const reconcileSpy = vi
      .spyOn(harness.service.operations, 'reconcile')
      .mockImplementation(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Request aborted.', 'AbortError')),
              { once: true },
            );
          }),
      );

    await harness.user.click(screen.getByRole('button', { name: 'Activity' }));
    await harness.user.click(
      screen.getByRole('button', { name: 'Reconcile activity' }),
    );
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    await harness.user.click(
      screen.getByRole('button', { name: 'Back to wallet' }),
    );
    await harness.user.click(
      screen.getByRole('button', { name: 'Backup and settings' }),
    );
    await harness.user.click(
      screen.getByRole('button', { name: 'Lock wallet' }),
    );

    await screen.findByRole('heading', { name: 'Enter PIN' });
    await waitFor(() => {
      expect(order).toEqual([
        'service:close:start',
        'service:close:end',
        'vault:lock',
      ]);
    });
    expect(harness.service.getSnapshot().lifecycle).toBe('closed');
  });

  it('requires explicit ecash confirmation and removes bearer notes from the DOM', async () => {
    const harness = await renderUnlockedApp();
    await previewFederation(harness);
    await harness.user.click(
      screen.getByRole('button', { name: 'Join federation' }),
    );
    await continuePastReady(harness.user);

    const createSpy = vi.spyOn(harness.service.ecash, 'createSpend');
    await harness.user.click(screen.getByRole('button', { name: 'Send' }));
    await harness.user.click(screen.getByRole('button', { name: 'Ecash' }));
    await harness.user.click(screen.getByRole('button', { name: '5' }));
    await harness.user.click(
      screen.getByRole('button', { name: 'Create link' }),
    );

    await screen.findByRole('img', { name: 'Ecash notes QR code' });
    const exported = await createSpy.mock.results[0]?.value;
    const rawNotes = exported.notes.reveal();
    expect(rawNotes).toMatch(/^fedimint-ecash:/);
    expect(document.body).not.toHaveTextContent(rawNotes);
    await harness.user.click(
      screen.getByRole('button', { name: 'Wallet home' }),
    );
    await harness.user.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByText('Ecash sent')).toBeVisible();
    expect(document.body).not.toHaveTextContent(rawNotes);
  });

  it('erases the encrypted profile only after typed destructive confirmation', async () => {
    const harness = await renderUnlockedApp();
    await previewFederation(harness);
    await harness.user.click(
      screen.getByRole('button', { name: 'Join federation' }),
    );
    await continuePastReady(harness.user);
    await harness.user.click(
      screen.getByRole('button', { name: 'Backup and settings' }),
    );

    const eraseButton = screen.getByRole('button', {
      name: 'Erase wallet data',
    });
    expect(eraseButton).toBeDisabled();
    await harness.user.type(screen.getByLabelText('Type ERASE'), 'ERASE');
    expect(eraseButton).toBeEnabled();
    await harness.user.click(eraseButton);

    await screen.findByRole('heading', { name: 'Chascuro' });
    expect(
      await harness.store.get(
        encryptedRecordKeyringStorageId(WALLET_RECORD_ID),
      ),
    ).toBeUndefined();
    expect(harness.service.getSnapshot().lifecycle).toBe('closed');
  });

  it('restores encrypted activity after a fresh app controller opens', async () => {
    const harness = await renderUnlockedApp();
    await previewFederation(harness);
    await harness.user.click(
      screen.getByRole('button', { name: 'Join federation' }),
    );
    await continuePastReady(harness.user);
    await harness.user.click(screen.getByRole('button', { name: 'Send' }));
    await harness.user.click(screen.getByRole('button', { name: 'Ecash' }));
    await harness.user.click(screen.getByRole('button', { name: '3' }));
    await harness.user.click(
      screen.getByRole('button', { name: 'Create link' }),
    );
    await screen.findByRole('img', { name: 'Ecash notes QR code' });
    await harness.user.click(
      screen.getByRole('button', { name: 'Wallet home' }),
    );
    await harness.user.click(
      screen.getByRole('button', { name: 'Backup and settings' }),
    );
    await harness.user.click(
      screen.getByRole('button', { name: 'Lock wallet' }),
    );
    await screen.findByRole('heading', { name: 'Enter PIN' });
    harness.unmount();

    const restored = await renderStoredApp(harness.store);
    await enterPin(restored.user);
    await screen.findByRole('heading', { name: 'Wallet home' });
    await restored.user.click(screen.getByRole('button', { name: 'Activity' }));

    expect(await screen.findByText('Ecash sent')).toBeVisible();
    await restored.user.click(
      screen.getByRole('button', { name: 'View details for Ecash sent' }),
    );
    await restored.user.click(
      screen.getByRole('button', { name: 'Recover notes' }),
    );
    const recovered = (await screen.findByLabelText(
      'Recovered bearer ecash',
    )) as HTMLTextAreaElement;
    expect(recovered.value).toMatch(/^fedimint-ecash:/);
  });

  it('fails closed when another tab owns the wallet lock', async () => {
    const harness = await renderUnlockedApp();
    await previewFederation(harness);
    await harness.user.click(
      screen.getByRole('button', { name: 'Join federation' }),
    );
    await continuePastReady(harness.user);
    await harness.user.click(
      screen.getByRole('button', { name: 'Backup and settings' }),
    );
    await harness.user.click(
      screen.getByRole('button', { name: 'Lock wallet' }),
    );
    await screen.findByRole('heading', { name: 'Enter PIN' });
    harness.unmount();

    const contended = await renderStoredApp(harness.store, {
      acquire: async () => {
        throw new WalletError('another_wallet_tab_active');
      },
      release: async () => undefined,
      dispose: async () => undefined,
    });
    await enterPin(contended.user);

    expect(
      await screen.findByText(
        'Close the wallet in the other tab before continuing.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Enter PIN' })).toBeVisible();
  });
});
