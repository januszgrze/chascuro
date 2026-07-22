import { webcrypto } from 'node:crypto';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chatMessageId,
  clearableSecretText,
  conversationId,
  federationId,
  lnurlPayOfferId,
  MAX_CHAT_PAYMENT_SATS,
  msats,
  sensitiveInput,
  WalletError,
  type ChatAvailability,
  type LnurlPayOffer,
} from '../domain';
import { HomeScreen } from '../features/wallet/HomeScreen';
import { ChatController } from '../services/chat/chat-controller';
import { FakeChatService } from '../services/chat/fake-chat-service';
import type { ChatSessionLifecycle } from '../services/chat/chat-session-lifecycle';
import { encryptedRecordStorageId } from '../services/persistence/encrypted-record-store';
import type { WalletDataEraseReport } from '../services/persistence/erase-wallet-data';
import {
  PENDING_FEDERATION_JOIN_RECORD_ID,
  PENDING_FEDERATION_JOIN_RECORD_KIND,
} from '../services/persistence/schemas/pending-federation-join-record';
import { WALLET_PROFILE_RECORD_KIND } from '../services/persistence/schemas/wallet-profile';
import type { VaultEnvelope } from '../services/persistence/vault';
import {
  MemoryVaultStore,
  type VaultStore,
} from '../services/persistence/vault-store';
import type { CapabilityReport } from '../services/security/capabilities';
import type { LnurlPayResolver } from '../services/lnurl';
import { FakeWalletService, type WalletService } from '../services/wallet';
import {
  WalletAppController,
  type SessionInactivityLock,
  type WalletOwnership,
  type WalletVisibilitySource,
} from './wallet-app-controller';
import { WALLET_RECORD_ID } from './wallet-record';

const PASSPHRASE = 'correct horse battery staple';
const INVITE = 'fedimint test invite code';
const TEST_CRYPTO = webcrypto as unknown as Crypto;
const SUPPORTED: CapabilityReport = {
  supported: true,
  missing: [],
};

const controllers: WalletAppController[] = [];

class FaultInjectingVaultStore extends MemoryVaultStore {
  readonly failedPutIds: string[] = [];
  private failNextPutPredicate: ((recordId: string) => boolean) | undefined;
  private delayedPut:
    | {
        predicate: (recordId: string) => boolean;
        entered: ReturnType<typeof deferred>;
        release: ReturnType<typeof deferred>;
      }
    | undefined;

  failNextPutMatching(predicate: (recordId: string) => boolean): void {
    this.failNextPutPredicate = predicate;
  }

  delayNextPutMatching(predicate: (recordId: string) => boolean) {
    const delayedPut = {
      predicate,
      entered: deferred(),
      release: deferred(),
    };
    this.delayedPut = delayedPut;
    return delayedPut;
  }

  override async put(recordId: string, envelope: VaultEnvelope): Promise<void> {
    if (this.failNextPutPredicate?.(recordId) === true) {
      this.failNextPutPredicate = undefined;
      this.failedPutIds.push(recordId);
      throw new Error('Injected record write failure.');
    }
    if (this.delayedPut?.predicate(recordId) === true) {
      const delayedPut = this.delayedPut;
      this.delayedPut = undefined;
      delayedPut.entered.resolve();
      await delayedPut.release.promise;
    }
    await super.put(recordId, envelope);
  }
}

class TestVisibilitySource implements WalletVisibilitySource {
  visibilityState: DocumentVisibilityState = 'hidden';
  private readonly listeners = new Set<EventListener>();

  addEventListener(_type: 'visibilitychange', listener: EventListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'visibilitychange',
    listener: EventListener,
  ): void {
    this.listeners.delete(listener);
  }

  setVisibility(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState;
    const event = new Event('visibilitychange');
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

interface ControllerHarness {
  controller: WalletAppController;
  service: FakeWalletService;
  store: FaultInjectingVaultStore;
  inactivityLock: TestInactivityLock;
}

type TestInactivityLock = SessionInactivityLock & {
  configure: NonNullable<SessionInactivityLock['configure']>;
};

interface HarnessOptions {
  store?: FaultInjectingVaultStore;
  service?: FakeWalletService;
  visibilitySource?: WalletVisibilitySource | null;
  inactivityLock?: TestInactivityLock;
  walletServiceFactory?: (kind?: 'fake' | 'fedimint') => WalletService;
  disposableTestWallet?: boolean;
  lnurlPayResolver?: LnurlPayResolver;
  chatLifecycle?: ChatSessionLifecycle;
  chatController?: ChatController;
  walletOwner?: WalletOwnership;
  walletDataEraser?: (
    storage: VaultStore,
  ) => Promise<WalletDataEraseReport | void>;
}

class RecordingChatLifecycle implements ChatSessionLifecycle {
  private availability: ChatAvailability;

  constructor(
    private readonly events: string[] = [],
    availability: ChatAvailability = {
      status: 'available',
      identity: {
        address: 'npub1controllerfixture',
        fingerprint: 'CONTROLLER-FIXTURE',
      },
      capabilities: ['text'],
    },
    private readonly openFailure?: unknown,
  ) {
    this.availability = availability;
  }

  readonly getAvailability = (): ChatAvailability => this.availability;

  async openOrCreate(): Promise<ChatAvailability> {
    this.events.push('chat-open');
    if (this.openFailure !== undefined) throw this.openFailure;
    return this.availability;
  }

  quiesce(): void {
    this.events.push('chat-quiesce');
  }

  async stop(): Promise<void> {
    this.events.push('chat-stop');
  }

  lock(): void {
    this.events.push('chat-lock');
    this.availability = { status: 'disabled' };
  }

  async dispose(): Promise<void> {
    this.events.push('chat-dispose');
    this.availability = { status: 'disabled' };
  }
}

function createInactivityLock(): TestInactivityLock {
  return {
    arm: vi.fn(() => 1),
    disarm: vi.fn(),
    dispose: vi.fn(),
    configure: vi.fn<NonNullable<SessionInactivityLock['configure']>>(),
  };
}

function createService(latencyMs = 0): FakeWalletService {
  let nextId = 0;
  return new FakeWalletService({
    latencyMs,
    clock: () => 1_000,
    idFactory: () => `controller-test-${++nextId}`,
    autoSettlePayments: false,
  });
}

function createController(options: HarnessOptions = {}): ControllerHarness {
  const store = options.store ?? new FaultInjectingVaultStore();
  const service = options.service ?? createService();
  const inactivityLock = options.inactivityLock ?? createInactivityLock();
  const controller = new WalletAppController({
    walletService: service,
    walletServiceFactory: options.walletServiceFactory,
    vaultStore: store,
    capabilityReport: SUPPORTED,
    vaultOptions: { crypto: TEST_CRYPTO, iterations: 1 },
    now: () => 1_000,
    walletDataEraser:
      options.walletDataEraser ?? (async (storage) => storage.clear?.()),
    walletOwner: options.walletOwner ?? {
      acquire: async () => undefined,
      release: async () => undefined,
      dispose: async () => undefined,
    },
    chatLifecycle: options.chatLifecycle,
    chatController: options.chatController,
    inactivityLock,
    visibilitySource: options.visibilitySource ?? null,
    disposableTestWallet: options.disposableTestWallet,
    lnurlPayResolver: options.lnurlPayResolver,
  });
  controllers.push(controller);
  return { controller, service, store, inactivityLock };
}

async function createInitializedController(
  options: HarnessOptions = {},
): Promise<ControllerHarness> {
  const harness = createController(options);
  await harness.controller.boot();
  expect(harness.controller.getState().phase).toBe('setup');
  await harness.controller.setup(PASSPHRASE);
  expect(harness.controller.getState().phase).toBe('identity');
  const mnemonic = await harness.controller.createIdentity();
  mnemonic.clear();
  await harness.controller.confirmIdentityBackup();
  expect(harness.controller.getState().phase).toBe('invite');
  return harness;
}

async function createJoinedController(
  options: HarnessOptions = {},
): Promise<ControllerHarness> {
  const harness = await createInitializedController(options);
  await harness.controller.previewFederation(INVITE);
  expect(harness.controller.getState().phase).toBe('review');
  await harness.controller.joinFederation(true);
  expect(harness.controller.getState().phase).toBe('home');
  return harness;
}

async function openStoredController(
  store: FaultInjectingVaultStore,
  options: Omit<HarnessOptions, 'store'> = {},
): Promise<ControllerHarness> {
  const harness = createController({ ...options, store });
  await harness.controller.boot();
  expect(harness.controller.getState().phase).toBe('locked');
  await harness.controller.unlock(PASSPHRASE);
  return harness;
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  cleanup();
  const active = controllers.splice(0);
  await Promise.allSettled(active.map((controller) => controller.dispose()));
});

describe('WalletAppController feature safety', () => {
  it('keeps wallet unlock usable when chat alone is unavailable', async () => {
    const degraded = await createInitializedController({
      chatLifecycle: new RecordingChatLifecycle(
        [],
        { status: 'disabled' },
        new Error('unbounded implementation detail'),
      ),
    });

    expect(degraded.controller.getState()).toMatchObject({
      phase: 'invite',
      chatAvailability: {
        status: 'degraded',
        reason: 'internal',
        retryable: true,
      },
      error: undefined,
    });
  });

  it('quiesces and locks chat before wallet close and ownership release', async () => {
    const events: string[] = [];
    const chatLifecycle = new RecordingChatLifecycle(events);
    const walletOwner: WalletOwnership = {
      acquire: async () => undefined,
      release: async () => {
        events.push('owner-release');
      },
      dispose: async () => undefined,
    };
    const harness = await createInitializedController({
      chatLifecycle,
      walletOwner,
    });
    const close = harness.service.close.bind(harness.service);
    vi.spyOn(harness.service, 'close').mockImplementation(async () => {
      events.push('wallet-close');
      await close();
    });
    events.length = 0;

    await harness.controller.lock();

    expect(events).toEqual([
      'chat-quiesce',
      'chat-stop',
      'chat-lock',
      'wallet-close',
      'owner-release',
    ]);
    expect(harness.controller.getState()).toMatchObject({
      phase: 'locked',
      chatAvailability: { status: 'disabled' },
    });
  });

  it('exposes chat only while unlocked and clears its controller on lock', async () => {
    const chatController = new ChatController(new FakeChatService());
    const stop = vi.spyOn(chatController, 'stop');
    const harness = await createInitializedController({ chatController });

    expect(harness.controller.getState().chat).toBe(chatController);

    await harness.controller.lock();

    expect(stop).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toMatchObject({
      phase: 'locked',
      chat: undefined,
    });
  });

  it('stops both runtimes before erase and retains independent erase evidence', async () => {
    const events: string[] = [];
    const report: WalletDataEraseReport = Object.freeze({
      appRecordsCleared: true,
      sdkDatabaseRemoved: true,
      chatDatabaseRemoved: true,
      cachesCleared: true,
      cachesDeleted: 1,
      serviceWorkersCleared: true,
      serviceWorkersUnregistered: 1,
    });
    const harness = await createJoinedController({
      chatLifecycle: new RecordingChatLifecycle(events),
      walletDataEraser: async () => {
        events.push('erase-data');
        return report;
      },
      walletOwner: {
        acquire: async () => undefined,
        release: async () => {
          events.push('owner-release');
        },
        dispose: async () => undefined,
      },
    });
    const close = harness.service.close.bind(harness.service);
    vi.spyOn(harness.service, 'close').mockImplementation(async () => {
      events.push('wallet-close');
      await close();
    });
    events.length = 0;

    await expect(harness.controller.eraseWallet('ERASE')).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    expect(events).toEqual([
      'chat-quiesce',
      'chat-stop',
      'chat-lock',
      'wallet-close',
      'erase-data',
      'owner-release',
    ]);
    expect(harness.controller.getState()).toMatchObject({
      phase: 'setup',
      chatAvailability: { status: 'disabled' },
      eraseReport: report,
    });
  });

  it('requires four characters to create an encrypted wallet', async () => {
    const harness = createController();
    await harness.controller.boot();

    await harness.controller.setup('123');
    expect(harness.controller.getState()).toMatchObject({
      phase: 'setup',
      error: 'Use at least 4 characters.',
    });

    await harness.controller.setup('1234');
    expect(harness.controller.getState().phase).toBe('identity');
  });

  it('creates a disposable identity only when the test bypass is explicit', async () => {
    const normal = createController();
    await normal.controller.boot();
    await normal.controller.setup(PASSPHRASE);
    await normal.controller.unlock(PASSPHRASE);
    await expect(
      normal.controller.createDisposableTestIdentity(),
    ).rejects.toThrow('Disposable test identity creation is disabled.');

    const disposable = createController({ disposableTestWallet: true });
    await disposable.controller.boot();
    await disposable.controller.setup(PASSPHRASE);
    await disposable.controller.unlock(PASSPHRASE);
    await disposable.controller.createDisposableTestIdentity();

    expect(disposable.controller.getState()).toMatchObject({
      phase: 'invite',
      disposableTestWallet: true,
    });
  });

  it('requires explicit mainnet recovery-risk acknowledgement before joining', async () => {
    let nextId = 0;
    const service = new FakeWalletService({
      latencyMs: 0,
      clock: () => 1_000,
      idFactory: () => `mainnet-controller-test-${++nextId}`,
      autoSettlePayments: false,
      preview: {
        federationId: federationId('mainnet-federation'),
        displayName: 'Mainnet federation',
        network: 'bitcoin',
        modules: Object.freeze(['ln', 'mint', 'wallet']),
        guardianCount: 4,
        guardianOrigins: Object.freeze(['wss://guardian.example']),
      },
    });
    const harness = await createInitializedController({ service });
    await harness.controller.previewFederation(INVITE);

    await harness.controller.joinFederation(true);
    expect(harness.controller.getState()).toMatchObject({
      phase: 'review',
      error: expect.stringContaining('experimental mainnet'),
    });

    await harness.controller.joinFederation(true, true);
    expect(harness.controller.getState()).toMatchObject({
      phase: 'home',
      walletSnapshot: {
        activeFederation: { network: 'bitcoin' },
      },
    });
  });

  it('attempts to join a federation with an unknown preview network', async () => {
    let nextId = 0;
    const service = new FakeWalletService({
      latencyMs: 0,
      clock: () => 1_000,
      idFactory: () => `unknown-network-controller-test-${++nextId}`,
      autoSettlePayments: false,
      preview: {
        federationId: federationId('unknown-network-federation'),
        displayName: 'Unknown network federation',
        network: 'unknown',
        modules: Object.freeze(['ln', 'mint', 'wallet']),
        guardianCount: 4,
        guardianOrigins: Object.freeze(['wss://guardian.example']),
      },
    });
    const harness = await createInitializedController({ service });
    const joinSpy = vi.spyOn(service.federation, 'join');
    await harness.controller.previewFederation(INVITE);

    await harness.controller.joinFederation(true);

    expect(joinSpy).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toMatchObject({
      phase: 'home',
      walletSnapshot: {
        activeFederation: { network: 'unknown' },
      },
    });
  });

  it('suppresses only concurrent duplicate ecash spends and Lightning invoices', async () => {
    const harness = await createJoinedController({
      service: createService(5),
    });
    const originalSpend = harness.service.ecash.createSpend;
    const spendGate = deferred();
    const spendSpy = vi
      .spyOn(harness.service.ecash, 'createSpend')
      .mockImplementation(async (intent, signal) => {
        await spendGate.promise;
        return originalSpend(intent, signal);
      });

    const firstSpend = harness.controller.createEcashSpend('5');
    const duplicateSpend = harness.controller.createEcashSpend('5');
    expect(spendSpy).toHaveBeenCalledTimes(1);
    spendGate.resolve();
    const [firstSpendResult, duplicateSpendResult] = await Promise.all([
      firstSpend,
      duplicateSpend,
    ]);
    expect(firstSpendResult).toBe(duplicateSpendResult);
    expect(firstSpendResult).toMatchObject({
      ok: true,
      value: { secretStorage: 'encrypted' },
    });

    await harness.controller.createEcashSpend('5');
    expect(spendSpy).toHaveBeenCalledTimes(2);

    const originalInvoice = harness.service.lightning.createInvoice;
    const invoiceGate = deferred();
    const invoiceSpy = vi
      .spyOn(harness.service.lightning, 'createInvoice')
      .mockImplementation(async (intent, signal) => {
        await invoiceGate.promise;
        return originalInvoice(intent, signal);
      });

    const firstInvoice = harness.controller.createLightningInvoice(
      '7',
      'coffee',
    );
    const duplicateInvoice = harness.controller.createLightningInvoice(
      '7',
      'coffee',
    );
    expect(invoiceSpy).toHaveBeenCalledTimes(1);
    invoiceGate.resolve();
    const [firstInvoiceResult, duplicateInvoiceResult] = await Promise.all([
      firstInvoice,
      duplicateInvoice,
    ]);
    expect(firstInvoiceResult).toBe(duplicateInvoiceResult);
    expect(firstInvoiceResult).toMatchObject({
      ok: true,
      value: { secretStorage: 'encrypted' },
    });

    await harness.controller.createLightningInvoice('7', 'coffee');
    expect(invoiceSpy).toHaveBeenCalledTimes(2);
  });

  it('routes chat ecash send and claim through wallet operations without exposing notes to React', async () => {
    const chatService = new FakeChatService({ scenario: 'two-groups' });
    await chatService.open({
      storageKey: new Uint8Array(32),
      signal: new AbortController().signal,
    });
    const chatController = new ChatController(chatService);
    chatController.start();
    const harness = await createJoinedController({
      chatController,
      chatLifecycle: new RecordingChatLifecycle(),
    });
    const createSpend = vi.spyOn(harness.service.ecash, 'createSpend');
    await expect(
      harness.controller.sendChatPayment(
        conversationId('conversation-primary'),
        String(MAX_CHAT_PAYMENT_SATS + 1),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'The entered value is not valid.',
    });
    expect(createSpend).not.toHaveBeenCalled();

    const sent = await harness.controller.sendChatPayment(
      conversationId('conversation-primary'),
      '5',
    );
    expect(sent).toMatchObject({
      ok: true,
      value: {
        kind: 'sent',
        payment: {
          direction: 'outgoing',
          amountSats: 5,
          status: 'pending',
        },
      },
    });
    const listed = await chatService.listPayments(
      conversationId('conversation-primary'),
      new AbortController().signal,
    );
    expect(listed.some(({ amountSats }) => amountSats === 5)).toBe(true);

    harness.store.failNextPutMatching((recordId) =>
      recordId.includes(':record:secret:'),
    );
    const unsent = await harness.controller.sendChatPayment(
      conversationId('conversation-primary'),
      '6',
    );
    expect(unsent).toMatchObject({
      ok: true,
      value: {
        kind: 'recovery_required',
        export: { secretStorage: 'memory_only' },
      },
    });
    const unsentExport =
      unsent.ok && unsent.value.kind === 'recovery_required'
        ? unsent.value.export
        : undefined;
    expect(unsentExport?.notes.reveal()).toContain('fedimint-ecash:6000:');
    const afterFailedRecovery = await chatService.listPayments(
      conversationId('conversation-primary'),
      new AbortController().signal,
    );
    expect(afterFailedRecovery.some(({ amountSats }) => amountSats === 6)).toBe(
      false,
    );
    unsentExport?.notes.clear();

    const activeFederation =
      harness.controller.getState().walletSnapshot.activeFederation!;
    const incomingId = chatMessageId('payment:wallet-claim');
    const incomingPayment = Object.freeze({
      id: incomingId,
      conversationId: conversationId('conversation-primary'),
      direction: 'incoming' as const,
      amountSats: 7,
      sentAtMs: 1_000,
      status: 'claimable' as const,
    });
    const notes = clearableSecretText(
      `fedimint-ecash:7000:${activeFederation.federationId}:chat-claim`,
    );
    vi.spyOn(chatController, 'preparePaymentClaim').mockResolvedValue({
      payment: incomingPayment,
      notes,
    });
    const markClaimed = vi
      .spyOn(chatController, 'markPaymentClaimed')
      .mockResolvedValue();

    await expect(
      harness.controller.claimChatPayment(incomingId),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(markClaimed).toHaveBeenCalledWith(
      incomingPayment.conversationId,
      incomingId,
      expect.any(AbortSignal),
    );
    expect(notes.length).toBe(0);
  });

  it('does not mark a chat payment claimed from an ambiguous redemption reservation', async () => {
    const chatService = new FakeChatService({ scenario: 'two-groups' });
    await chatService.open({
      storageKey: new Uint8Array(32),
      signal: new AbortController().signal,
    });
    const chatController = new ChatController(chatService);
    chatController.start();
    const harness = await createJoinedController({
      chatController,
      chatLifecycle: new RecordingChatLifecycle(),
    });
    const activeFederation =
      harness.controller.getState().walletSnapshot.activeFederation!;
    const incomingId = chatMessageId('payment:ambiguous-claim');
    const incomingPayment = Object.freeze({
      id: incomingId,
      conversationId: conversationId('conversation-primary'),
      direction: 'incoming' as const,
      amountSats: 8,
      sentAtMs: 1_000,
      status: 'claimable' as const,
    });
    vi.spyOn(chatController, 'preparePaymentClaim').mockImplementation(() =>
      Promise.resolve({
        payment: incomingPayment,
        notes: clearableSecretText(
          `fedimint-ecash:8000:${activeFederation.federationId}:ambiguous`,
        ),
      }),
    );
    const markClaimed = vi.spyOn(chatController, 'markPaymentClaimed');
    vi.spyOn(harness.service.ecash, 'redeem').mockRejectedValue(
      new WalletError('operation_failed'),
    );

    await expect(
      harness.controller.claimChatPayment(incomingId),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      harness.controller.claimChatPayment(incomingId),
    ).resolves.toMatchObject({ ok: false });
    expect(markClaimed).not.toHaveBeenCalled();
  });

  it('resolves and quotes opaque LNURL-pay offers through the existing Lightning boundary', async () => {
    const offer: LnurlPayOffer = Object.freeze({
      offerId: lnurlPayOfferId('lnurl-controller-offer'),
      destination: 'alice@example.com',
      domain: 'example.com',
      description: 'Coffee for Alice',
      minSendableMsats: msats(1_000n),
      maxSendableMsats: msats(100_000n),
      expiresAtMs: 100_000,
    });
    const resolver: LnurlPayResolver = {
      resolve: vi.fn().mockResolvedValue(offer),
      requestInvoice: vi.fn().mockResolvedValue({
        invoice: sensitiveInput('lntb1fake21000x100000xlnurl'),
        offer,
        successAction: { tag: 'message', message: 'Thanks!' },
      }),
      clear: vi.fn(),
    };
    const harness = await createJoinedController({
      lnurlPayResolver: resolver,
    });

    await expect(
      harness.controller.resolveLnurlPay('alice@example.com'),
    ).resolves.toMatchObject({ ok: true, value: offer });
    const result = await harness.controller.quoteLnurlPayment(
      offer.offerId,
      '21',
      '10',
    );

    expect(resolver.requestInvoice).toHaveBeenCalledWith(
      offer.offerId,
      21_000n,
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        offer,
        preview: {
          amountMsats: 21_000n,
          payeeHint: 'alice@example.com',
          description: 'Coffee for Alice',
        },
        quote: { amountMsats: 21_000n },
        successAction: { tag: 'message', message: 'Thanks!' },
      },
    });
  });

  it('deduplicates concurrent LNURL invoice requests and clears offers on lock', async () => {
    const offer: LnurlPayOffer = Object.freeze({
      offerId: lnurlPayOfferId('lnurl-controller-fixed'),
      destination: 'pay.example',
      domain: 'pay.example',
      description: 'Fixed payment',
      minSendableMsats: msats(5_000n),
      maxSendableMsats: msats(5_000n),
      fixedAmountMsats: msats(5_000n),
      expiresAtMs: 100_000,
    });
    const invoiceGate = deferred();
    const resolver: LnurlPayResolver = {
      resolve: vi.fn().mockResolvedValue(offer),
      requestInvoice: vi.fn().mockImplementation(async () => {
        await invoiceGate.promise;
        return {
          invoice: sensitiveInput('lntb1fake5000x100000xfixed'),
          offer,
        };
      }),
      clear: vi.fn(),
    };
    const harness = await createJoinedController({
      lnurlPayResolver: resolver,
    });

    const first = harness.controller.quoteLnurlPayment(
      offer.offerId,
      undefined,
      '10',
    );
    const duplicate = harness.controller.quoteLnurlPayment(
      offer.offerId,
      undefined,
      '10',
    );
    expect(resolver.requestInvoice).toHaveBeenCalledTimes(1);
    invoiceGate.resolve();
    const [firstResult, duplicateResult] = await Promise.all([
      first,
      duplicate,
    ]);
    expect(firstResult).toBe(duplicateResult);

    await harness.controller.lock();
    expect(resolver.clear).toHaveBeenCalled();
  });

  it('maps LNURL resolver failures to the static public error', async () => {
    const resolver: LnurlPayResolver = {
      resolve: vi.fn().mockRejectedValue(new WalletError('lnurl_unreachable')),
      requestInvoice: vi.fn(),
      clear: vi.fn(),
    };
    const harness = await createJoinedController({
      lnurlPayResolver: resolver,
    });

    await expect(
      harness.controller.resolveLnurlPay('alice@example.com'),
    ).resolves.toEqual({
      ok: false,
      error:
        "Couldn't reach the Lightning address service. It may not support browser wallets.",
    });
  });

  it('keeps bearer notes visible with a memory-only warning after encrypted secret persistence fails', async () => {
    const user = userEvent.setup();
    const harness = await createJoinedController();
    harness.store.failNextPutMatching((recordId) =>
      recordId.includes(':record:secret:'),
    );
    const state = harness.controller.getState();

    render(
      <HomeScreen
        snapshot={state.walletSnapshot}
        securitySettings={state.securitySettings}
        refreshing={false}
        error={state.error}
        onRefresh={() => harness.controller.refreshBalance()}
        onLock={() => harness.controller.lock()}
        onParseEcash={(rawNotes) => harness.controller.parseEcash(rawNotes)}
        onRedeemEcash={(preview) => harness.controller.redeemEcash(preview)}
        onCreateEcashSpend={(amountSats) =>
          harness.controller.createEcashSpend(amountSats)
        }
        onCreateLightningInvoice={(amountSats, description) =>
          harness.controller.createLightningInvoice(amountSats, description)
        }
        onQuoteLightningPayment={(invoice, maximumFeeSats) =>
          harness.controller.quoteLightningPayment(invoice, maximumFeeSats)
        }
        onResolveLnurlPay={(input) => harness.controller.resolveLnurlPay(input)}
        onQuoteLnurlPayment={(offerId, amountSats, maximumFeeSats) =>
          harness.controller.quoteLnurlPayment(
            offerId,
            amountSats,
            maximumFeeSats,
          )
        }
        onPayLightningQuote={(preview, quote) =>
          harness.controller.payLightningQuote(preview, quote)
        }
        onReconcile={() => harness.controller.reconcileOperations()}
        onRevealMnemonic={() => harness.controller.revealMnemonic()}
        onRecoverEcashExport={(key) =>
          harness.controller.recoverEcashExport(key)
        }
        onRecoverLightningInvoice={(key) =>
          harness.controller.recoverLightningInvoice(key)
        }
        onUpdateSecuritySettings={(inactivityTimeoutMs, backgroundTimeoutMs) =>
          harness.controller.updateSecuritySettings(
            inactivityTimeoutMs,
            backgroundTimeoutMs,
          )
        }
        onErase={(confirmation) => harness.controller.eraseWallet(confirmation)}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('button', { name: 'Ecash' }));
    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(
      await screen.findByRole('img', { name: 'Ecash notes QR code' }),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Encrypted recovery failed.',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Share these notes now.',
    );
    expect(harness.store.failedPutIds).toHaveLength(1);
  });

  it('waits for bearer ecash persistence before locking the wallet', async () => {
    const harness = await createJoinedController();
    const delayedSecret = harness.store.delayNextPutMatching((recordId) =>
      recordId.includes(':record:secret:'),
    );

    const spend = harness.controller.createEcashSpend('1');
    await delayedSecret.entered.promise;
    const lock = harness.controller.lock();

    expect(harness.controller.getState()).toMatchObject({
      phase: 'locking',
      busy: 'lock',
    });
    delayedSecret.release.resolve();
    await expect(spend).resolves.toMatchObject({
      ok: true,
      value: { secretStorage: 'encrypted' },
    });
    await lock;
    expect(harness.controller.getState().phase).toBe('locked');
  });

  it('uses a fresh stateful wallet service after successful erase', async () => {
    const initialService = createService();
    const replacementService = createService();
    const factory = vi.fn(() => replacementService);
    const harness = await createJoinedController({
      service: initialService,
      walletServiceFactory: factory,
    });
    await harness.controller.createEcashSpend('1');
    expect(initialService.getSnapshot().operations).toHaveLength(1);

    await expect(harness.controller.eraseWallet('ERASE')).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    expect(factory).toHaveBeenCalledWith('fake');
    expect(harness.controller.getState()).toMatchObject({
      phase: 'setup',
      walletSnapshot: { operations: [] },
    });
  });

  it('refreshes balance and reconciles operations once when the wallet becomes visible', async () => {
    const visibilitySource = new TestVisibilitySource();
    const harness = await createJoinedController({
      service: createService(10),
      visibilitySource,
    });
    const refreshSpy = vi.spyOn(harness.service.balance, 'refresh');
    const reconcileSpy = vi.spyOn(harness.service.operations, 'reconcile');

    visibilitySource.setVisibility('visible');
    visibilitySource.setVisibility('visible');

    await vi.waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('persists automatic-lock settings and reloads them into a fresh controller', async () => {
    const first = await createJoinedController();
    const updated = await first.controller.updateSecuritySettings(null, 60_000);
    expect(updated).toEqual({
      ok: true,
      value: {
        version: 1,
        inactivityTimeoutMs: null,
        backgroundTimeoutMs: 60_000,
      },
    });
    await first.controller.lock();

    const reloadedInactivityLock = createInactivityLock();
    const reloaded = await openStoredController(first.store, {
      service: createService(),
      inactivityLock: reloadedInactivityLock,
    });

    expect(reloaded.controller.getState()).toMatchObject({
      phase: 'home',
      securitySettings: {
        version: 1,
        inactivityTimeoutMs: null,
        backgroundTimeoutMs: 60_000,
      },
    });
    expect(reloadedInactivityLock.configure).toHaveBeenCalledWith({
      version: 1,
      inactivityTimeoutMs: null,
      backgroundTimeoutMs: 60_000,
    });
  });

  it('reconciles a durable pending join after the SDK joined but the profile write failed', async () => {
    const first = await createInitializedController();
    await first.controller.previewFederation(INVITE);
    expect(first.controller.getState().phase).toBe('review');

    const profileStorageId = encryptedRecordStorageId(
      WALLET_RECORD_ID,
      WALLET_PROFILE_RECORD_KIND,
      WALLET_RECORD_ID,
    );
    first.store.failNextPutMatching(
      (recordId) => recordId === profileStorageId,
    );
    await first.controller.joinFederation(true);

    expect(first.controller.getState()).toMatchObject({
      phase: 'locked',
      error: expect.stringContaining('reconcile'),
    });
    expect(first.store.failedPutIds).toEqual([profileStorageId]);
    const pendingStorageId = encryptedRecordStorageId(
      WALLET_RECORD_ID,
      PENDING_FEDERATION_JOIN_RECORD_KIND,
      PENDING_FEDERATION_JOIN_RECORD_ID,
    );
    expect(await first.store.get(pendingStorageId)).toBeDefined();

    const restoredService = createService();
    const reconcileSpy = vi.spyOn(
      restoredService.federation,
      'reconcilePendingJoin',
    );
    const restored = await openStoredController(first.store, {
      service: restoredService,
    });

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(restored.controller.getState()).toMatchObject({
      phase: 'home',
      walletSnapshot: {
        activeFederation: {
          federationId: 'demo-fedimint-federation',
        },
      },
    });
    expect(await first.store.get(pendingStorageId)).toBeUndefined();
  });

  it('retains an ambiguous pending join marker when reconciliation cannot prove success', async () => {
    const first = await createInitializedController();
    await first.controller.previewFederation(INVITE);
    const profileStorageId = encryptedRecordStorageId(
      WALLET_RECORD_ID,
      WALLET_PROFILE_RECORD_KIND,
      WALLET_RECORD_ID,
    );
    first.store.failNextPutMatching(
      (recordId) => recordId === profileStorageId,
    );
    await first.controller.joinFederation(true);
    const pendingStorageId = encryptedRecordStorageId(
      WALLET_RECORD_ID,
      PENDING_FEDERATION_JOIN_RECORD_KIND,
      PENDING_FEDERATION_JOIN_RECORD_ID,
    );

    const restoredService = createService();
    vi.spyOn(
      restoredService.federation,
      'reconcilePendingJoin',
    ).mockResolvedValue(undefined);
    const restored = await openStoredController(first.store, {
      service: restoredService,
    });

    expect(restored.controller.getState()).toMatchObject({
      phase: 'locked',
      error: expect.stringContaining('reconcile'),
    });
    expect(await first.store.get(pendingStorageId)).toBeDefined();
  });
});
