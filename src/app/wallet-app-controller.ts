import {
  approveFederationJoin,
  confirmEcashRedeem,
  confirmEcashSpend,
  confirmLightningQuote,
  federationId,
  isTerminalOperationStatus,
  MAX_CHAT_PAYMENT_SATS,
  type LnurlPaymentReview,
  type LnurlPayOffer,
  type LnurlPayOfferId,
  normalizeBitcoinNetwork,
  parsePositiveSats,
  parseSats,
  publicWalletError,
  sensitiveInput,
  toPublicWalletError,
  WalletError,
  type EcashExport,
  type EcashPreview,
  type ClearableSecretText,
  type LightningInvoicePreview,
  type LightningQuote,
  type LightningReceive,
  type Msats,
  type OperationKey,
  type SecretMnemonic,
  type TrackedOperation,
  type WalletOperation,
  type ChatAvailability,
  type ChatMessageId,
  type ChatPaymentSendOutcome,
  type ConversationId,
} from '../domain';
import type { ChatController } from '../services/chat/chat-controller';
import {
  DisabledChatSessionLifecycle,
  type ChatSessionLifecycle,
} from '../services/chat/chat-session-lifecycle';
import {
  BrowserLnurlPayResolver,
  type LnurlPayResolver,
} from '../services/lnurl';
import {
  VaultUnlockError,
  type VaultOptions,
} from '../services/persistence/vault';
import {
  EncryptedRecordCorruptError,
  EncryptedRecordStore,
  EncryptedRecordStoreNotFoundError,
  encryptedRecordKeyringStorageId,
} from '../services/persistence/encrypted-record-store';
import {
  eraseWalletData,
  WalletDataEraseError,
  type WalletDataEraseReport,
} from '../services/persistence/erase-wallet-data';
import {
  migrateV1ProfileToV2,
  ProductionFakeProfileError,
} from '../services/persistence/migrations/v1-profile-to-v2';
import {
  PENDING_FEDERATION_JOIN_RECORD_ID,
  pendingFederationJoinRecordSchema,
} from '../services/persistence/schemas/pending-federation-join-record';
import {
  walletProfileV2Schema,
  type WalletProfileV2,
} from '../services/persistence/schemas/wallet-profile';
import {
  DEFAULT_WALLET_SECURITY_SETTINGS,
  parseWalletSecuritySettings,
  WALLET_SETTINGS_RECORD_ID,
  walletSecuritySettingsSchema,
  type WalletSecuritySettings,
} from '../services/persistence/schemas/wallet-settings-record';
import { WalletActivityRepository } from '../services/persistence/wallet-activity-repository';
import {
  IndexedDbVaultStore,
  type VaultStore,
} from '../services/persistence/vault-store';
import {
  inspectCapabilities,
  type CapabilityReport,
} from '../services/security/capabilities';
import { ExclusiveWalletOwner } from '../services/security/exclusive-wallet-owner';
import { InactivityLock } from '../services/security/inactivity-lock';
import {
  SessionGuard,
  type SessionToken,
} from '../services/security/session-guard';
import {
  createWalletService,
  OperationCoordinator,
  type WalletService,
  type WalletServiceKind,
} from '../services/wallet';
import {
  createWalletProfileV2,
  readWalletProfileV2,
  WALLET_RECORD_ID,
  walletAdapterVersion,
} from './wallet-record';
import {
  MIN_PASSPHRASE_LENGTH,
  type SessionInactivityLock,
  type WalletAppDependencies,
  type WalletAppState,
  type WalletFeatureResult,
  type WalletOwnership,
  type WalletVisibilitySource,
} from './wallet-app-types';

export {
  MIN_PASSPHRASE_LENGTH,
  type SessionInactivityLock,
  type WalletAppAction,
  type WalletAppDependencies,
  type WalletAppPhase,
  type WalletAppState,
  type WalletFeatureResult,
  type WalletOwnership,
  type WalletVisibilitySource,
} from './wallet-app-types';

type Listener = () => void;

export class WalletAppController {
  private readonly listeners = new Set<Listener>();
  private readonly guard = new SessionGuard();
  private readonly capabilityReport: CapabilityReport;
  private readonly serviceFactory: (kind?: WalletServiceKind) => WalletService;
  private readonly vaultOptions: VaultOptions;
  private readonly now: () => number;
  private readonly walletDataEraser: (
    storage: VaultStore,
  ) => Promise<WalletDataEraseReport | void>;
  private readonly chatLifecycle: ChatSessionLifecycle;
  private readonly chatController: ChatController | undefined;
  private readonly walletOwner: WalletOwnership;
  private readonly inactivityLock: SessionInactivityLock;
  private readonly visibilitySource: WalletVisibilitySource | undefined;
  private readonly visibilityListener: EventListener;
  private readonly disposableTestWallet: boolean;
  private readonly lnurlPayResolver: LnurlPayResolver;
  private readonly providedStore?: VaultStore;
  private storeInstance: VaultStore | undefined;
  private service: WalletService;
  private unsubscribeService: (() => void) | undefined;
  private operationCoordinator: OperationCoordinator | undefined;
  private unsubscribeCoordinator: (() => void) | undefined;
  private operationPersistenceTail: Promise<void> = Promise.resolve();
  private recordStore: EncryptedRecordStore | undefined;
  private activityRepository: WalletActivityRepository | undefined;
  private profile: WalletProfileV2 | undefined;
  private joinInFlight: Promise<void> | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private resumeInFlight: Promise<void> | undefined;
  private readonly featureSubmissions = new Map<
    string,
    Promise<WalletFeatureResult<unknown>>
  >();
  private readonly irreversibleFeatureSubmissions = new Set<
    Promise<WalletFeatureResult<unknown>>
  >();
  private identityCreationPending = false;
  private preSetupIdentityConfirmedAtMs: number | undefined;
  private bootStarted = false;
  private disposed = false;
  private state: WalletAppState;

  constructor(dependencies: WalletAppDependencies = {}) {
    this.serviceFactory =
      dependencies.walletServiceFactory ?? createWalletService;
    this.service = dependencies.walletService ?? this.serviceFactory(undefined);
    this.providedStore = dependencies.vaultStore;
    this.capabilityReport =
      dependencies.capabilityReport ?? inspectCapabilities();
    this.vaultOptions = dependencies.vaultOptions ?? {};
    this.now = dependencies.now ?? Date.now;
    this.walletDataEraser =
      dependencies.walletDataEraser ??
      ((storage) => eraseWalletData({ storage }));
    this.chatLifecycle =
      dependencies.chatLifecycle ?? new DisabledChatSessionLifecycle();
    this.chatController = dependencies.chatController;
    this.walletOwner = dependencies.walletOwner ?? new ExclusiveWalletOwner();
    this.inactivityLock =
      dependencies.inactivityLock ??
      new InactivityLock({
        inactivityTimeoutMs: 5 * 60 * 1000,
        backgroundTimeoutMs: 30 * 1000,
        onExpire: () => {
          void this.lock();
        },
      });
    this.visibilitySource =
      dependencies.visibilitySource === undefined
        ? typeof document === 'undefined'
          ? undefined
          : (document as unknown as WalletVisibilitySource)
        : (dependencies.visibilitySource ?? undefined);
    this.disposableTestWallet =
      dependencies.disposableTestWallet ??
      ((import.meta.env.DEV || import.meta.env.MODE === 'e2e') &&
        import.meta.env.VITE_TEST_WALLET_BYPASS === 'true');
    this.lnurlPayResolver =
      dependencies.lnurlPayResolver ?? new BrowserLnurlPayResolver();
    this.visibilityListener = () => {
      if (this.visibilitySource?.visibilityState === 'visible') {
        queueMicrotask(() => {
          void this.resumeWallet();
        });
      }
    };
    this.visibilitySource?.addEventListener(
      'visibilitychange',
      this.visibilityListener,
    );
    this.state = Object.freeze({
      phase: 'booting',
      serviceKind: this.service.kind,
      disposableTestWallet: this.disposableTestWallet,
      walletSnapshot: this.service.getSnapshot(),
      chatAvailability: this.chatLifecycle.getAvailability(),
      missingCapabilities: Object.freeze([...this.capabilityReport.missing]),
      securitySettings: DEFAULT_WALLET_SECURITY_SETTINGS,
    });
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): WalletAppState => this.state;

  async boot(): Promise<void> {
    if (this.bootStarted || this.disposed) {
      return;
    }
    this.bootStarted = true;

    if (!this.capabilityReport.supported) {
      this.update({
        phase: 'unsupported',
        error: publicWalletError('unsupported_environment').message,
      });
      return;
    }

    this.attachService();

    try {
      const [legacyEnvelope, keyringEnvelope] = await Promise.all([
        this.getStore().get(WALLET_RECORD_ID),
        this.getStore().get(encryptedRecordKeyringStorageId(WALLET_RECORD_ID)),
      ]);
      if (this.disposed) {
        return;
      }
      this.update({
        phase:
          legacyEnvelope === undefined && keyringEnvelope === undefined
            ? 'setup'
            : 'locked',
        error: undefined,
      });
    } catch {
      this.update({
        phase: 'unsupported',
        error: publicWalletError('storage_unavailable').message,
      });
    }
  }

  async setup(passphrase: string): Promise<void> {
    if (
      this.state.phase !== 'setup' ||
      this.state.busy !== undefined ||
      passphrase.length < MIN_PASSPHRASE_LENGTH
    ) {
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        this.update({
          error: `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`,
        });
      }
      return;
    }

    const token = this.guard.renew();
    this.update({ busy: 'setup', error: undefined });
    let records: EncryptedRecordStore | undefined;

    try {
      records = await EncryptedRecordStore.create({
        storage: this.getStore(),
        passphrase,
        namespace: WALLET_RECORD_ID,
        crypto: this.vaultOptions.crypto,
        now: this.now,
        vaultOptions: {
          iterations: this.vaultOptions.iterations,
        },
      });
      const profile = createWalletProfileV2(this.service.kind, {
        adapterVersion: walletAdapterVersion(this.service.kind),
        identity:
          this.preSetupIdentityConfirmedAtMs === undefined
            ? undefined
            : {
                status: 'initialized',
                backupConfirmedAtMs: this.preSetupIdentityConfirmedAtMs,
              },
      });
      await records.put(walletProfileV2Schema, WALLET_RECORD_ID, profile);

      if (!this.guard.isCurrent(token)) {
        records.lock();
        return;
      }

      records.lock();
      this.update({ phase: 'opening', error: undefined });
      await this.openVault(passphrase);
    } catch {
      records?.lock();
      if (this.guard.isCurrent(token)) {
        this.update({
          busy: undefined,
          error: publicWalletError('storage_unavailable').message,
        });
      }
    }
  }

  async unlock(passphrase: string): Promise<void> {
    if (this.state.phase !== 'locked' || this.state.busy !== undefined) {
      return;
    }
    await this.openVault(passphrase);
  }

  private async openVault(passphrase: string): Promise<void> {
    const token = this.guard.renew();
    this.update({ busy: 'unlock', error: undefined });
    let records: EncryptedRecordStore | undefined;
    let ownershipAcquired = false;

    try {
      await this.walletOwner.acquire();
      ownershipAcquired = true;
      if (!this.guard.isCurrent(token)) {
        await this.walletOwner.release();
        return;
      }

      const keyring = await this.getStore().get(
        encryptedRecordKeyringStorageId(WALLET_RECORD_ID),
      );
      let profileRecord;
      if (keyring === undefined) {
        const migration = await migrateV1ProfileToV2({
          storage: this.getStore(),
          passphrase,
          namespace: WALLET_RECORD_ID,
          runtime:
            import.meta.env.PROD && import.meta.env.MODE !== 'e2e'
              ? 'production'
              : 'development',
          now: this.now,
          vaultOptions: this.vaultOptions,
        });
        records = migration.store;
        profileRecord = migration.profile;
      } else {
        records = await EncryptedRecordStore.open({
          storage: this.getStore(),
          passphrase,
          namespace: WALLET_RECORD_ID,
          crypto: this.vaultOptions.crypto,
          now: this.now,
        });
        profileRecord = await records.get(
          walletProfileV2Schema,
          WALLET_RECORD_ID,
        );
      }

      if (profileRecord === undefined) {
        throw new EncryptedRecordCorruptError();
      }
      let profile = profileRecord.payload;
      const pendingJoinRecord = await records.get(
        pendingFederationJoinRecordSchema,
        PENDING_FEDERATION_JOIN_RECORD_ID,
      );
      const settingsRecord = await records.get(
        walletSecuritySettingsSchema,
        WALLET_SETTINGS_RECORD_ID,
      );
      const securitySettings =
        settingsRecord?.payload ?? DEFAULT_WALLET_SECURITY_SETTINGS;
      this.inactivityLock.configure?.(securitySettings);
      if (
        import.meta.env.PROD &&
        import.meta.env.MODE !== 'e2e' &&
        profile.mode === 'fake'
      ) {
        throw new ProductionFakeProfileError();
      }

      if (!this.guard.isCurrent(token)) {
        this.detachService();
        try {
          await this.service.close();
        } finally {
          records.lock();
          await this.walletOwner.release();
        }
        return;
      }

      let record = readWalletProfileV2(profile);
      await this.selectService(record.mode, token.signal);
      if (!this.guard.isCurrent(token)) {
        records.lock();
        await this.walletOwner.release();
        return;
      }

      this.attachService();
      this.update({ phase: 'opening', busy: 'unlock', error: undefined });
      await this.service.open({
        activeFederation: record.activeFederation,
        signal: token.signal,
      });
      if (
        record.activeFederation === undefined &&
        pendingJoinRecord !== undefined
      ) {
        const pending = pendingJoinRecord.payload;
        const reconciled = await this.service.federation.reconcilePendingJoin(
          {
            federationId: federationId(pending.federationId),
            displayName: pending.displayName,
            network: normalizeBitcoinNetwork(pending.network),
            modules: pending.modules,
            guardianCount: pending.guardianCount,
          },
          token.signal,
        );
        if (reconciled !== undefined) {
          profile = createWalletProfileV2(record.mode, {
            adapterVersion: profile.adapterVersion,
            identity: profile.identity,
            activeFederation: reconciled,
          });
          await records.put(walletProfileV2Schema, WALLET_RECORD_ID, profile);
          record = readWalletProfileV2(profile);
        } else {
          throw new WalletError('operation_reconciliation_required');
        }
        if (record.activeFederation !== undefined) {
          try {
            await records.delete(
              pendingFederationJoinRecordSchema,
              PENDING_FEDERATION_JOIN_RECORD_ID,
            );
          } catch {
            // A stale sanitized marker is harmless once the active profile is
            // durable; retry deletion on the next unlock.
          }
        }
      } else if (
        record.activeFederation !== undefined &&
        pendingJoinRecord !== undefined
      ) {
        try {
          await records.delete(
            pendingFederationJoinRecordSchema,
            PENDING_FEDERATION_JOIN_RECORD_ID,
          );
        } catch {
          // The active profile remains authoritative.
        }
      }
      if (record.activeFederation !== undefined) {
        await this.service.federation.getCapabilities(token.signal);
      }

      if (!this.guard.isCurrent(token)) {
        this.detachService();
        try {
          await this.service.close();
        } finally {
          records.lock();
          await this.walletOwner.release();
        }
        return;
      }

      this.recordStore = records;
      this.profile = profile;
      this.activityRepository = new WalletActivityRepository(records);
      await this.startOperationCoordinator();
      let chatAvailability: ChatAvailability;
      try {
        chatAvailability = await this.chatLifecycle.openOrCreate({
          storage: this.getStore(),
          passphrase,
          signal: token.signal,
        });
      } catch {
        chatAvailability = degradedChatAvailability('internal');
      }
      if (!this.guard.isCurrent(token)) {
        this.chatLifecycle.quiesce();
        await this.stopAndLockChat();
        this.detachService();
        try {
          await this.service.close();
        } finally {
          records.lock();
          await this.walletOwner.release();
        }
        return;
      }
      if (record.activeFederation !== undefined) {
        void this.operationCoordinator?.reconcile().catch(() => {
          // The wallet remains usable offline; activity exposes manual retry.
        });
      }
      this.inactivityLock.arm();
      this.chatController?.start();
      this.update({
        phase:
          record.identity?.status !== 'initialized'
            ? 'identity'
            : record.activeFederation === undefined
              ? 'invite'
              : 'home',
        busy: undefined,
        candidate: undefined,
        chatAvailability,
        chat: this.chatController,
        securitySettings,
        error: undefined,
      });
    } catch (error) {
      this.chatLifecycle.quiesce();
      if (!this.guard.isCurrent(token)) {
        this.detachService();
        try {
          await this.stopAndLockChat();
          await this.service.close();
        } finally {
          records?.lock();
          if (ownershipAcquired) {
            await this.walletOwner.release();
          }
        }
        return;
      }

      this.detachService();
      try {
        await this.stopAndLockChat();
        await this.service.close();
      } finally {
        await this.operationPersistenceTail;
        records?.lock();
        if (ownershipAcquired) {
          await this.walletOwner.release();
        }
        this.recordStore = undefined;
        this.profile = undefined;
        this.activityRepository = undefined;
      }

      this.update({
        phase: 'locked',
        busy: undefined,
        chatAvailability: this.chatLifecycle.getAvailability(),
        chat: undefined,
        error:
          error instanceof VaultUnlockError
            ? publicWalletError('invalid_passphrase').message
            : error instanceof TypeError ||
                error instanceof EncryptedRecordCorruptError ||
                error instanceof EncryptedRecordStoreNotFoundError ||
                error instanceof ProductionFakeProfileError
              ? publicWalletError('storage_corrupt').message
              : toPublicWalletError(error).message,
      });
    }
  }

  async createIdentity(): Promise<SecretMnemonic> {
    if (
      (this.state.phase !== 'identity' && this.state.phase !== 'setup') ||
      this.state.busy !== undefined
    ) {
      throw new Error('Identity setup is unavailable.');
    }

    const token = this.guard.current();
    this.update({ busy: 'identity-create', error: undefined });
    try {
      await this.openServiceForIdentity(token);
      if (!this.guard.isCurrent(token)) {
        throw new DOMException('Request aborted.', 'AbortError');
      }
      const mnemonic = await this.service.identity.createMnemonic();
      if (!this.guard.isCurrent(token)) {
        mnemonic.clear();
        throw new DOMException('Request aborted.', 'AbortError');
      }
      this.identityCreationPending = true;
      this.preSetupIdentityConfirmedAtMs = undefined;
      this.update({ busy: undefined, error: undefined });
      return mnemonic;
    } catch (error) {
      if (this.guard.isCurrent(token)) {
        this.update({
          busy: undefined,
          error: toPublicWalletError(error).message,
        });
      }
      throw error;
    }
  }

  async confirmIdentityBackup(): Promise<void> {
    if (
      (this.state.phase !== 'identity' && this.state.phase !== 'setup') ||
      this.state.busy !== undefined ||
      !this.identityCreationPending
    ) {
      return;
    }

    const token = this.guard.current();
    this.update({ busy: 'backup-confirm', error: undefined });
    if (this.state.phase === 'setup') {
      this.identityCreationPending = false;
      this.preSetupIdentityConfirmedAtMs = this.now();
      this.update({ busy: undefined, error: undefined });
      return;
    }

    try {
      await this.persistIdentity({
        status: 'initialized',
        backupConfirmedAtMs: this.now(),
      });
      if (!this.guard.isCurrent(token)) {
        return;
      }
      this.identityCreationPending = false;
      this.update({
        phase: this.profile?.activeFederation === undefined ? 'invite' : 'home',
        busy: undefined,
        error: undefined,
      });
    } catch (error) {
      if (this.guard.isCurrent(token)) {
        this.update({
          busy: undefined,
          error:
            error instanceof TypeError
              ? publicWalletError('storage_unavailable').message
              : toPublicWalletError(error).message,
        });
      }
    }
  }

  async createDisposableTestIdentity(): Promise<void> {
    if (!this.disposableTestWallet) {
      throw new Error('Disposable test identity creation is disabled.');
    }
    if (this.state.phase !== 'identity' || this.state.busy !== undefined) {
      return;
    }

    const token = this.guard.current();
    this.update({ busy: 'identity-create', error: undefined });
    let mnemonic: SecretMnemonic | undefined;
    try {
      mnemonic = await this.service.identity.createMnemonic();
      mnemonic.clear();
      mnemonic = undefined;
      if (!this.guard.isCurrent(token)) {
        return;
      }

      await this.persistIdentity({ status: 'initialized' });
      if (!this.guard.isCurrent(token)) {
        return;
      }

      this.identityCreationPending = false;
      this.update({
        phase: this.profile?.activeFederation === undefined ? 'invite' : 'home',
        busy: undefined,
        error: undefined,
      });
    } catch (error) {
      if (this.guard.isCurrent(token)) {
        this.update({
          busy: undefined,
          error:
            error instanceof TypeError
              ? publicWalletError('storage_unavailable').message
              : toPublicWalletError(error).message,
        });
      }
    } finally {
      mnemonic?.clear();
    }
  }

  async restoreIdentity(words: string): Promise<void> {
    if (
      (this.state.phase !== 'identity' && this.state.phase !== 'setup') ||
      this.state.busy !== undefined
    ) {
      return;
    }

    const token = this.guard.current();
    this.update({ busy: 'identity-restore', error: undefined });
    try {
      if (this.state.phase === 'setup') {
        await this.openServiceForIdentity(token);
        if (!this.guard.isCurrent(token)) {
          return;
        }
        const normalizedWords = words.trim().split(/\s+/);
        await this.service.identity.setMnemonic(normalizedWords);
        if (!this.guard.isCurrent(token)) {
          return;
        }
        this.identityCreationPending = false;
        this.preSetupIdentityConfirmedAtMs = this.now();
        this.update({ busy: undefined, error: undefined });
        return;
      }

      if (
        this.service.kind === 'fedimint' &&
        this.profile?.activeFederation === undefined
      ) {
        this.update({
          busy: undefined,
          error: publicWalletError('recovery_start_unavailable').message,
        });
        return;
      }
      const normalizedWords = words.trim().split(/\s+/);
      await this.service.identity.setMnemonic(normalizedWords);
      if (!this.guard.isCurrent(token)) {
        return;
      }

      if (this.profile?.activeFederation !== undefined) {
        await this.service.recovery.waitForCompletion(token.signal);
        if (!this.guard.isCurrent(token)) {
          return;
        }
      }

      await this.persistIdentity({
        status: 'initialized',
        backupConfirmedAtMs: this.now(),
      });
      if (!this.guard.isCurrent(token)) {
        return;
      }

      this.identityCreationPending = false;
      this.update({
        phase: this.profile?.activeFederation === undefined ? 'invite' : 'home',
        busy: undefined,
        error: undefined,
      });
    } catch (error) {
      if (this.guard.isCurrent(token)) {
        this.update({
          busy: undefined,
          error:
            error instanceof TypeError
              ? publicWalletError('invalid_input').message
              : toPublicWalletError(error).message,
        });
      }
    }
  }

  private async openServiceForIdentity(token: SessionToken): Promise<void> {
    this.attachService();
    if (this.service.getSnapshot().lifecycle === 'closed') {
      await this.service.open({ signal: token.signal });
    }
  }

  async parseEcash(
    rawNotes: string,
  ): Promise<WalletFeatureResult<EcashPreview>> {
    return this.runWalletFeature((signal) =>
      this.service.ecash.parse(sensitiveInput(rawNotes), signal),
    );
  }

  async redeemEcash(
    preview: EcashPreview,
  ): Promise<WalletFeatureResult<TrackedOperation>> {
    return this.runWalletFeatureOnce(
      `ecash-redeem:${preview.fingerprint}`,
      (signal) => this.redeemEcashPreview(preview, signal),
    );
  }

  async createEcashSpend(
    amountSats: string,
  ): Promise<WalletFeatureResult<EcashExport>> {
    let amountMsats;
    try {
      amountMsats = parsePositiveSats(amountSats);
    } catch {
      return Object.freeze({
        ok: false,
        error: publicWalletError('invalid_input').message,
      });
    }

    return this.runIrreversibleWalletFeatureOnce(
      `ecash-spend:${amountMsats.toString(10)}`,
      (signal) => this.createEcashExport(amountMsats, signal),
    );
  }

  async sendChatPayment(
    conversationId: ConversationId,
    amountSats: string,
  ): Promise<WalletFeatureResult<ChatPaymentSendOutcome>> {
    let amountMsats;
    try {
      amountMsats = parsePositiveSats(amountSats);
      if (amountMsats / 1_000n > BigInt(MAX_CHAT_PAYMENT_SATS)) {
        throw new RangeError('Chat payment amount is too large.');
      }
    } catch {
      return Object.freeze({
        ok: false,
        error: publicWalletError('invalid_input').message,
      });
    }
    return this.runIrreversibleWalletFeatureOnce(
      `chat-ecash-send:${conversationId}:${amountMsats.toString(10)}`,
      async (signal) => {
        const chat = this.chatController;
        if (chat === undefined) {
          throw new TypeError('Chat is unavailable.');
        }
        const exported = await this.createEcashExport(amountMsats, signal);
        if (exported.secretStorage !== 'encrypted') {
          return Object.freeze({
            kind: 'recovery_required' as const,
            export: exported,
          });
        }
        try {
          const payment = await chat.sendPayment(
            conversationId,
            Number(amountMsats / 1_000n),
            exported.notes,
            exported.operation.key,
            signal,
          );
          return Object.freeze({ kind: 'sent' as const, payment });
        } finally {
          exported.notes.clear();
        }
      },
    );
  }

  async claimChatPayment(
    paymentId: ChatMessageId,
  ): Promise<WalletFeatureResult<void>> {
    return this.runIrreversibleWalletFeatureOnce(
      `chat-ecash-claim:${paymentId}`,
      async (signal) => {
        const chat = this.chatController;
        const repository = this.activityRepository;
        if (chat === undefined || repository === undefined) {
          throw new TypeError('Chat payment storage is unavailable.');
        }
        const prepared = await chat.preparePaymentClaim(paymentId, signal);
        try {
          const preview = await this.service.ecash.parse(
            sensitiveInput(prepared.notes.reveal()),
            signal,
          );
          if (
            preview.amountMsats !==
            BigInt(prepared.payment.amountSats) * 1_000n
          ) {
            throw new WalletError('invalid_ecash');
          }
          const existingRedemption =
            await repository.getEcashRedemptionOperationKey(
              preview.fingerprint,
            );
          if (existingRedemption !== undefined) {
            if (
              existingRedemption.operationId.startsWith('pending-redemption:')
            ) {
              throw new WalletError('operation_failed');
            }
            await chat.markPaymentClaimed(
              prepared.payment.conversationId,
              paymentId,
              signal,
            );
            return;
          }
          await this.redeemEcashPreview(preview, signal);
          // Redemption has already been submitted at this point. A chat-state
          // write failure must not falsely report that the wallet redemption
          // failed; a repeated Claim repairs the local card through dedup state.
          await chat
            .markPaymentClaimed(
              prepared.payment.conversationId,
              paymentId,
              signal,
            )
            .catch(() => undefined);
        } finally {
          prepared.notes.clear();
        }
      },
    );
  }

  async createLightningInvoice(
    amountSats: string,
    description: string,
  ): Promise<WalletFeatureResult<LightningReceive>> {
    let amountMsats;
    try {
      amountMsats = parsePositiveSats(amountSats);
    } catch {
      return Object.freeze({
        ok: false,
        error: publicWalletError('invalid_input').message,
      });
    }
    const normalizedDescription = description.trim();

    return this.runWalletFeatureOnce(
      `lightning-receive:${amountMsats.toString(10)}:${normalizedDescription}`,
      async (signal) => {
        const receive = await this.service.lightning.createInvoice(
          {
            amountMsats,
            description: normalizedDescription || undefined,
            expirySeconds: 3_600,
          },
          signal,
        );
        const repository = this.activityRepository;
        if (repository === undefined) {
          return Object.freeze({
            ...receive,
            secretStorage: 'memory_only',
          });
        }
        try {
          await repository.putSecret(
            'lightning-invoice',
            receive.operation.key,
            receive.invoice,
          );
          await this.deleteSecretIfTerminal(
            repository,
            'lightning-invoice',
            receive.operation.key,
          );
          return Object.freeze({
            ...receive,
            secretStorage: 'encrypted',
          });
        } catch {
          return Object.freeze({
            ...receive,
            secretStorage: 'memory_only',
          });
        }
      },
    );
  }

  async quoteLightningPayment(
    rawInvoice: string,
    maximumFeeSats: string,
  ): Promise<
    WalletFeatureResult<{
      preview: LightningInvoicePreview;
      quote: LightningQuote;
    }>
  > {
    return this.runWalletFeature(async (signal) => {
      return this.createLightningQuote(
        sensitiveInput(rawInvoice),
        parseSats(maximumFeeSats),
        signal,
      );
    });
  }

  async resolveLnurlPay(
    rawInput: string,
  ): Promise<WalletFeatureResult<LnurlPayOffer>> {
    return this.runWalletFeatureOnce(
      `lnurl-resolve:${rawInput.trim()}`,
      (signal) =>
        this.lnurlPayResolver.resolve(sensitiveInput(rawInput), signal),
    );
  }

  async quoteLnurlPayment(
    offerId: LnurlPayOfferId,
    amountSats: string | undefined,
    maximumFeeSats: string,
  ): Promise<WalletFeatureResult<LnurlPaymentReview>> {
    return this.runWalletFeatureOnce(
      `lnurl-quote:${offerId}:${amountSats ?? 'fixed'}:${maximumFeeSats}`,
      async (signal) => {
        const resolved = await this.lnurlPayResolver.requestInvoice(
          offerId,
          amountSats === undefined ? undefined : parsePositiveSats(amountSats),
          signal,
        );
        const quoted = await this.createLightningQuote(
          resolved.invoice,
          parseSats(maximumFeeSats),
          signal,
          {
            destination: resolved.offer.destination,
            description: resolved.offer.description,
          },
        );
        return Object.freeze({
          ...quoted,
          offer: resolved.offer,
          ...(resolved.successAction === undefined
            ? {}
            : { successAction: resolved.successAction }),
        });
      },
    );
  }

  async payLightningQuote(
    preview: LightningInvoicePreview,
    quote: LightningQuote,
  ): Promise<WalletFeatureResult<TrackedOperation>> {
    return this.runWalletFeatureOnce(
      `lightning-pay:${quote.quoteId}`,
      (signal) =>
        this.service.lightning.pay(
          confirmLightningQuote(quote, preview.fingerprint, this.now()),
          signal,
        ),
    );
  }

  async reconcileOperations(): Promise<WalletFeatureResult<void>> {
    return this.runWalletFeature(async () => {
      if (this.operationCoordinator === undefined) {
        throw new TypeError('Operation coordinator is unavailable.');
      }
      await this.operationCoordinator.reconcile();
    });
  }

  async revealMnemonic(): Promise<WalletFeatureResult<SecretMnemonic>> {
    return this.runWalletFeature(() =>
      this.service.identity.revealMnemonic('settings-backup'),
    );
  }

  async updateSecuritySettings(
    inactivityTimeoutMs: number | null,
    backgroundTimeoutMs: number | null,
  ): Promise<WalletFeatureResult<WalletSecuritySettings>> {
    return this.runWalletFeature(async () => {
      const records = this.recordStore;
      if (records === undefined) {
        throw new TypeError('Encrypted settings storage is unavailable.');
      }
      const settings = parseWalletSecuritySettings({
        version: 1,
        inactivityTimeoutMs,
        backgroundTimeoutMs,
      });
      await records.put(
        walletSecuritySettingsSchema,
        WALLET_SETTINGS_RECORD_ID,
        settings,
      );
      this.inactivityLock.configure?.(settings);
      this.update({ securitySettings: settings });
      return settings;
    });
  }

  async recoverEcashExport(
    key: OperationKey,
  ): Promise<WalletFeatureResult<ClearableSecretText>> {
    return this.runWalletFeature(async () => {
      const secret = await this.activityRepository?.getSecret(
        'ecash-export',
        key,
      );
      if (secret === undefined) {
        throw new TypeError('Stored ecash export is unavailable.');
      }
      return secret;
    });
  }

  async recoverLightningInvoice(
    key: OperationKey,
  ): Promise<WalletFeatureResult<ClearableSecretText>> {
    return this.runWalletFeature(async () => {
      const operation = this.operationCoordinator?.get(key);
      if (
        operation === undefined ||
        operation.kind !== 'lightning_receive' ||
        isTerminalOperationStatus(operation.status) ||
        (operation.expiresAtMs !== undefined &&
          operation.expiresAtMs <= this.now())
      ) {
        throw new TypeError('Stored Lightning invoice is no longer payable.');
      }
      const secret = await this.activityRepository?.getSecret(
        'lightning-invoice',
        key,
      );
      if (secret === undefined) {
        throw new TypeError('Stored Lightning invoice is unavailable.');
      }
      return secret;
    });
  }

  async eraseWallet(
    typedConfirmation: string,
  ): Promise<WalletFeatureResult<void>> {
    if (
      this.state.phase !== 'home' ||
      this.state.busy !== undefined ||
      typedConfirmation !== 'ERASE'
    ) {
      return {
        ok: false,
        error: publicWalletError('invalid_input').message,
      };
    }

    const records = this.recordStore;
    this.lnurlPayResolver.clear();
    this.identityCreationPending = false;
    this.preSetupIdentityConfirmedAtMs = undefined;
    this.inactivityLock.disarm();
    this.chatLifecycle.quiesce();
    this.update({ busy: 'erase', candidate: undefined, error: undefined });
    let replacementService: WalletService | undefined;

    try {
      await this.waitForIrreversibleFeatureSubmissions();
      this.guard.invalidate();
      this.detachService();
      const erasedServiceKind = this.service.kind;
      await this.stopAndLockChat();
      await this.service.close();
      replacementService = this.serviceFactory(erasedServiceKind);
      if (replacementService.kind !== erasedServiceKind) {
        throw new TypeError('Wallet mode is unavailable.');
      }
      await this.operationPersistenceTail;
      records?.lock();
      this.recordStore = undefined;
      this.profile = undefined;
      this.activityRepository = undefined;
      const eraseReport = await this.walletDataEraser(this.getStore());
      await this.walletOwner.release();
      this.service = replacementService;
      this.update({
        phase: 'setup',
        busy: undefined,
        serviceKind: this.service.kind,
        walletSnapshot: this.service.getSnapshot(),
        chatAvailability: this.chatLifecycle.getAvailability(),
        eraseReport: eraseReport ?? undefined,
        error: undefined,
      });
      return Object.freeze({ ok: true, value: undefined });
    } catch (error) {
      this.chatLifecycle.lock();
      await replacementService?.close().catch(() => undefined);
      records?.lock();
      await this.walletOwner.release();
      this.recordStore = undefined;
      this.profile = undefined;
      this.activityRepository = undefined;
      const storedProfile = await this.getStore().get(
        encryptedRecordKeyringStorageId(WALLET_RECORD_ID),
      );
      this.update({
        phase: storedProfile === undefined ? 'setup' : 'locked',
        busy: undefined,
        walletSnapshot: this.service.getSnapshot(),
        chatAvailability: this.chatLifecycle.getAvailability(),
        eraseReport:
          error instanceof WalletDataEraseError ? error.report : undefined,
        error: publicWalletError('erase_failed').message,
      });
      return Object.freeze({
        ok: false,
        error: publicWalletError('erase_failed').message,
      });
    }
  }

  async startNewWalletFromLocked(): Promise<WalletFeatureResult<void>> {
    if (this.state.phase !== 'locked' || this.state.busy !== undefined) {
      return Object.freeze({
        ok: false,
        error: publicWalletError('invalid_input').message,
      });
    }

    const records = this.recordStore;
    this.lnurlPayResolver.clear();
    this.identityCreationPending = false;
    this.preSetupIdentityConfirmedAtMs = undefined;
    this.inactivityLock.disarm();
    this.chatLifecycle.quiesce();
    this.update({ busy: 'erase', candidate: undefined, error: undefined });
    let replacementService: WalletService | undefined;

    try {
      this.guard.invalidate();
      this.detachService();
      const erasedServiceKind = this.service.kind;
      await this.stopAndLockChat();
      await this.service.close().catch(() => undefined);
      replacementService = this.serviceFactory(erasedServiceKind);
      if (replacementService.kind !== erasedServiceKind) {
        throw new TypeError('Wallet mode is unavailable.');
      }
      await this.operationPersistenceTail;
      records?.lock();
      this.recordStore = undefined;
      this.profile = undefined;
      this.activityRepository = undefined;
      const eraseReport = await this.walletDataEraser(this.getStore());
      await this.walletOwner.release();
      this.service = replacementService;
      this.update({
        phase: 'setup',
        busy: undefined,
        serviceKind: this.service.kind,
        walletSnapshot: this.service.getSnapshot(),
        chatAvailability: this.chatLifecycle.getAvailability(),
        eraseReport: eraseReport ?? undefined,
        error: undefined,
      });
      return Object.freeze({ ok: true, value: undefined });
    } catch (error) {
      this.chatLifecycle.lock();
      await replacementService?.close().catch(() => undefined);
      this.update({
        busy: undefined,
        chatAvailability: this.chatLifecycle.getAvailability(),
        eraseReport:
          error instanceof WalletDataEraseError ? error.report : undefined,
        error: publicWalletError('erase_failed').message,
      });
      return Object.freeze({
        ok: false,
        error: publicWalletError('erase_failed').message,
      });
    }
  }

  async previewFederation(inviteCode: string): Promise<void> {
    if (this.state.phase !== 'invite' || this.state.busy !== undefined) {
      return;
    }

    const token = this.guard.current();
    this.update({ busy: 'preview', error: undefined });

    try {
      const candidate = await this.service.federation.preview(
        sensitiveInput(inviteCode),
        token.signal,
      );
      if (!this.guard.isCurrent(token)) {
        return;
      }

      this.update({
        phase: 'review',
        candidate,
        busy: undefined,
        error: undefined,
      });
    } catch (error) {
      if (this.guard.isCurrent(token)) {
        this.update({
          busy: undefined,
          error: toPublicWalletError(error).message,
        });
      }
    }
  }

  returnToInvite(): void {
    if (this.state.phase !== 'review' || this.state.busy !== undefined) {
      return;
    }
    this.update({
      phase: 'invite',
      candidate: undefined,
      error: undefined,
    });
  }

  joinFederation(
    trustAcknowledged: boolean,
    mainnetRiskAcknowledged = false,
  ): Promise<void> {
    if (this.joinInFlight !== undefined) {
      return this.joinInFlight;
    }

    const work = this.performJoin(trustAcknowledged, mainnetRiskAcknowledged);
    this.joinInFlight = work;
    void work.then(
      () => {
        if (this.joinInFlight === work) {
          this.joinInFlight = undefined;
        }
      },
      () => {
        if (this.joinInFlight === work) {
          this.joinInFlight = undefined;
        }
      },
    );
    return work;
  }

  refreshBalance(): Promise<void> {
    if (this.refreshInFlight !== undefined) {
      return this.refreshInFlight;
    }

    const work = this.performRefresh();
    this.refreshInFlight = work;
    void work.then(
      () => {
        if (this.refreshInFlight === work) {
          this.refreshInFlight = undefined;
        }
      },
      () => {
        if (this.refreshInFlight === work) {
          this.refreshInFlight = undefined;
        }
      },
    );
    return work;
  }

  async lock(): Promise<void> {
    if (
      this.state.phase === 'locked' ||
      this.state.phase === 'setup' ||
      this.state.phase === 'unsupported' ||
      this.state.phase === 'booting' ||
      this.state.phase === 'locking'
    ) {
      return;
    }

    const records = this.recordStore;
    this.lnurlPayResolver.clear();
    this.identityCreationPending = false;
    this.featureSubmissions.clear();
    this.inactivityLock.disarm();
    this.chatLifecycle.quiesce();
    this.update({
      phase: 'locking',
      busy: 'lock',
      candidate: undefined,
      error: undefined,
    });

    try {
      await this.waitForIrreversibleFeatureSubmissions();
      this.guard.invalidate();
      this.detachService();
      await this.stopAndLockChat();
      await this.service.close();
    } finally {
      await this.operationPersistenceTail;
      records?.lock();
      await this.walletOwner.release();
      if (this.recordStore === records) {
        this.recordStore = undefined;
        this.profile = undefined;
        this.activityRepository = undefined;
      }
    }

    this.update({
      phase: 'locked',
      busy: undefined,
      walletSnapshot: this.service.getSnapshot(),
      chatAvailability: this.chatLifecycle.getAvailability(),
      chat: undefined,
      error: undefined,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lnurlPayResolver.clear();
    this.identityCreationPending = false;
    this.featureSubmissions.clear();
    this.visibilitySource?.removeEventListener(
      'visibilitychange',
      this.visibilityListener,
    );
    this.inactivityLock.dispose();
    this.chatLifecycle.quiesce();
    await this.waitForIrreversibleFeatureSubmissions();
    this.guard.invalidate();
    this.detachService();
    const records = this.recordStore;
    this.recordStore = undefined;
    this.profile = undefined;
    this.activityRepository = undefined;

    try {
      await this.chatLifecycle.dispose().catch(() => undefined);
      await this.service.close();
    } finally {
      await this.operationPersistenceTail;
      records?.lock();
      await this.walletOwner.dispose();
      this.listeners.clear();
    }
  }

  private async stopAndLockChat(): Promise<void> {
    this.chatController?.stop();
    try {
      await this.chatLifecycle.stop();
    } catch {
      // Chat shutdown is isolated from wallet shutdown and ownership release.
    } finally {
      this.chatLifecycle.lock();
    }
  }

  private async createLightningQuote(
    invoice: ReturnType<typeof sensitiveInput>,
    maximumFeeMsats: Msats,
    signal: AbortSignal,
    display?: {
      readonly destination: string;
      readonly description: string;
    },
  ): Promise<{
    readonly preview: LightningInvoicePreview;
    readonly quote: LightningQuote;
  }> {
    const parsedPreview = await this.service.lightning.parseInvoice(
      invoice,
      signal,
    );
    const preview: LightningInvoicePreview =
      display === undefined
        ? parsedPreview
        : Object.freeze({
            ...parsedPreview,
            payeeHint: display.destination,
            description: display.description,
          });
    const quote = await this.service.lightning.quotePayment(
      { preview, maximumFeeMsats },
      signal,
    );
    return Object.freeze({ preview, quote });
  }

  private async createEcashExport(
    amountMsats: Msats,
    signal: AbortSignal,
  ): Promise<EcashExport> {
    const exported = await this.service.ecash.createSpend(
      confirmEcashSpend(
        {
          amountMsats,
          includeFederationInvite: true,
          cancellationWindowSeconds: 86_400,
        },
        this.now(),
      ),
      signal,
    );
    const repository = this.activityRepository;
    if (repository === undefined) {
      return Object.freeze({
        ...exported,
        secretStorage: 'memory_only',
      });
    }
    try {
      await repository.putSecret(
        'ecash-export',
        exported.operation.key,
        exported.notes,
      );
      await this.deleteSecretIfTerminal(
        repository,
        'ecash-export',
        exported.operation.key,
      );
      return Object.freeze({
        ...exported,
        secretStorage: 'encrypted',
      });
    } catch {
      // The wallet already created bearer notes. Keep the only in-memory copy
      // available to the caller instead of pretending the spend did not occur.
      return Object.freeze({
        ...exported,
        secretStorage: 'memory_only',
      });
    }
  }

  private async redeemEcashPreview(
    preview: EcashPreview,
    signal: AbortSignal,
  ): Promise<TrackedOperation> {
    const repository = this.activityRepository;
    if (repository === undefined) {
      throw new TypeError('Encrypted activity storage is unavailable.');
    }
    if (await repository.hasEcashRedemptionFingerprint(preview.fingerprint)) {
      throw new WalletError('ecash_already_redeemed');
    }
    if (!preview.compatible || preview.federationId === undefined) {
      throw new WalletError('ecash_wrong_federation');
    }
    await repository.reserveEcashRedemptionFingerprint(
      preview.fingerprint,
      preview.federationId,
      this.now(),
    );
    const tracked = await this.service.ecash.redeem(
      confirmEcashRedeem(preview, this.now()),
      signal,
    );
    await repository.recordEcashRedemptionFingerprint(
      preview.fingerprint,
      tracked.operation.key,
      this.now(),
    );
    return tracked;
  }

  private async runWalletFeature<T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<WalletFeatureResult<T>> {
    if (this.state.phase !== 'home' || this.state.busy !== undefined) {
      return {
        ok: false,
        error: publicWalletError('wallet_locked').message,
      };
    }

    const token = this.guard.current();
    try {
      const value = await work(token.signal);
      if (!this.guard.isCurrent(token)) {
        clearFeatureSecrets(value);
        return {
          ok: false,
          error: publicWalletError('operation_failed').message,
        };
      }
      return Object.freeze({ ok: true, value });
    } catch (error) {
      const publicError =
        error instanceof TypeError || error instanceof RangeError
          ? publicWalletError('invalid_input')
          : toPublicWalletError(error);
      return Object.freeze({
        ok: false,
        error: publicError.message,
      });
    }
  }

  private runWalletFeatureOnce<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<WalletFeatureResult<T>> {
    const existing = this.featureSubmissions.get(key);
    if (existing !== undefined) {
      return existing as Promise<WalletFeatureResult<T>>;
    }

    const promise = this.runWalletFeature(work);
    this.featureSubmissions.set(
      key,
      promise as Promise<WalletFeatureResult<unknown>>,
    );
    void promise.then(
      () => {
        if (this.featureSubmissions.get(key) === promise) {
          this.featureSubmissions.delete(key);
        }
      },
      () => {
        if (this.featureSubmissions.get(key) === promise) {
          this.featureSubmissions.delete(key);
        }
      },
    );
    return promise;
  }

  private runIrreversibleWalletFeatureOnce<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<WalletFeatureResult<T>> {
    const promise = this.runWalletFeatureOnce(key, work);
    this.irreversibleFeatureSubmissions.add(
      promise as Promise<WalletFeatureResult<unknown>>,
    );
    const clear = () => {
      this.irreversibleFeatureSubmissions.delete(
        promise as Promise<WalletFeatureResult<unknown>>,
      );
    };
    void promise.then(clear, clear);
    return promise;
  }

  private async waitForIrreversibleFeatureSubmissions(): Promise<void> {
    while (this.irreversibleFeatureSubmissions.size > 0) {
      await Promise.allSettled([...this.irreversibleFeatureSubmissions]);
    }
  }

  private resumeWallet(): Promise<void> {
    if (this.resumeInFlight !== undefined) {
      return this.resumeInFlight;
    }
    if (
      this.disposed ||
      this.state.phase !== 'home' ||
      this.state.busy !== undefined
    ) {
      return Promise.resolve();
    }

    const token = this.guard.current();
    const coordinator = this.operationCoordinator;
    const work = Promise.allSettled([
      this.service.balance.refresh(token.signal),
      coordinator?.reconcile() ?? Promise.resolve(),
    ]).then(() => {
      if (this.guard.isCurrent(token)) {
        this.update({
          walletSnapshot: Object.freeze({
            ...this.service.getSnapshot(),
            operations: coordinator?.list() ?? [],
          }),
        });
      }
    });
    this.resumeInFlight = work;
    void work.then(
      () => {
        if (this.resumeInFlight === work) {
          this.resumeInFlight = undefined;
        }
      },
      () => {
        if (this.resumeInFlight === work) {
          this.resumeInFlight = undefined;
        }
      },
    );
    return work;
  }

  private async persistIdentity(
    identity: WalletProfileV2['identity'],
  ): Promise<void> {
    const records = this.recordStore;
    const profile = this.profile;
    if (records === undefined || profile === undefined) {
      throw new TypeError('Encrypted profile is unavailable.');
    }

    const nextProfile = createWalletProfileV2(this.service.kind, {
      adapterVersion: profile.adapterVersion,
      identity,
      activeFederation:
        profile.activeFederation === undefined
          ? undefined
          : readWalletProfileV2(profile).activeFederation,
    });
    await records.put(walletProfileV2Schema, WALLET_RECORD_ID, nextProfile);
    this.profile = nextProfile;
  }

  private async performJoin(
    trustAcknowledged: boolean,
    mainnetRiskAcknowledged: boolean,
  ): Promise<void> {
    const candidate = this.state.candidate;
    if (
      this.state.phase !== 'review' ||
      this.state.busy !== undefined ||
      candidate === undefined
    ) {
      return;
    }

    if (!trustAcknowledged) {
      this.update({ error: publicWalletError('trust_required').message });
      return;
    }
    if (candidate.network === 'bitcoin' && !mainnetRiskAcknowledged) {
      this.update({
        error: publicWalletError('mainnet_risk_acknowledgement_required')
          .message,
      });
      return;
    }
    if (!candidate.modules.includes('mint')) {
      this.update({ error: publicWalletError('unsupported_feature').message });
      return;
    }

    const token = this.guard.current();
    this.update({ busy: 'join', error: undefined });

    let pendingJoinPersisted = false;
    try {
      const records = this.recordStore;
      const profile = this.profile;
      if (records === undefined || profile === undefined) {
        throw new TypeError('Encrypted record store is unavailable.');
      }
      const approval = approveFederationJoin(
        candidate,
        this.now(),
        mainnetRiskAcknowledged,
      );
      await records.put(
        pendingFederationJoinRecordSchema,
        PENDING_FEDERATION_JOIN_RECORD_ID,
        {
          version: 1,
          federationId: candidate.federationId,
          displayName: candidate.displayName,
          network: candidate.network,
          modules: candidate.modules,
          guardianCount: candidate.guardianCount,
          submittedAtMs: this.now(),
        },
      );
      pendingJoinPersisted = true;
      const activeFederation = await this.service.federation.join(
        approval,
        token.signal,
      );
      if (!this.guard.isCurrent(token)) {
        return;
      }
      await this.service.federation.getCapabilities(token.signal);
      if (!this.guard.isCurrent(token)) {
        return;
      }

      const nextProfile = createWalletProfileV2(this.service.kind, {
        adapterVersion: profile.adapterVersion,
        identity: profile.identity,
        activeFederation,
      });
      await records.put(walletProfileV2Schema, WALLET_RECORD_ID, nextProfile);
      try {
        await records.delete(
          pendingFederationJoinRecordSchema,
          PENDING_FEDERATION_JOIN_RECORD_ID,
        );
      } catch {
        // The active profile is authoritative; stale marker cleanup retries on
        // the next unlock.
      }
      if (!this.guard.isCurrent(token)) {
        return;
      }

      this.profile = nextProfile;
      this.update({
        phase: 'home',
        busy: undefined,
        candidate: undefined,
        error: undefined,
      });
    } catch (error) {
      if (this.guard.isCurrent(token)) {
        if (pendingJoinPersisted) {
          await this.lock();
          this.update({
            error: publicWalletError('operation_reconciliation_required')
              .message,
          });
          return;
        }
        this.update({
          busy: undefined,
          error:
            error instanceof RangeError
              ? publicWalletError('candidate_expired').message
              : error instanceof TypeError
                ? publicWalletError('storage_unavailable').message
                : toPublicWalletError(error).message,
        });
      }
    }
  }

  private async performRefresh(): Promise<void> {
    if (this.state.phase !== 'home' || this.state.busy !== undefined) {
      return;
    }

    const token = this.guard.current();
    this.update({ busy: 'refresh', error: undefined });

    try {
      await this.service.balance.refresh(token.signal);
      if (this.guard.isCurrent(token)) {
        this.update({ busy: undefined, error: undefined });
      }
    } catch (error) {
      if (this.guard.isCurrent(token)) {
        this.update({
          busy: undefined,
          error: toPublicWalletError(error).message,
        });
      }
    }
  }

  private async selectService(
    kind: WalletServiceKind,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.service.kind === kind) {
      return;
    }

    this.detachService();
    await this.service.close();
    signal.throwIfAborted();

    const nextService = this.serviceFactory(kind);
    if (nextService.kind !== kind) {
      throw new TypeError('Wallet mode is unavailable.');
    }

    this.service = nextService;
    this.update({
      serviceKind: nextService.kind,
      walletSnapshot: nextService.getSnapshot(),
    });
    this.attachService();
  }

  private getStore(): VaultStore {
    this.storeInstance ??= this.providedStore ?? new IndexedDbVaultStore();
    return this.storeInstance;
  }

  private attachService(): void {
    if (this.unsubscribeService !== undefined) {
      return;
    }

    const service = this.service;
    this.unsubscribeService = service.subscribe((snapshot) => {
      if (service === this.service && !this.disposed) {
        const coordinator = this.operationCoordinator;
        if (coordinator !== undefined) {
          for (const operation of snapshot.operations) {
            coordinator.track(operation);
          }
        }
        this.update({
          serviceKind: service.kind,
          walletSnapshot:
            coordinator === undefined
              ? snapshot
              : Object.freeze({
                  ...snapshot,
                  operations: coordinator.list(),
                }),
        });
      }
    });
  }

  private detachService(): void {
    this.unsubscribeService?.();
    this.unsubscribeService = undefined;
    this.stopOperationCoordinator();
  }

  private async startOperationCoordinator(): Promise<void> {
    this.stopOperationCoordinator();
    const service = this.service;
    const coordinator = new OperationCoordinator({
      subscribeToOperation: (key, listener) =>
        service.operations.subscribe(key, (operation) => {
          listener({
            status: operation.status,
            observedAtMs: operation.updatedAtMs,
          });
        }),
      reconcileOperations: async (_known, signal) => {
        await service.operations.reconcile(signal);
        const operations: WalletOperation[] = [];
        let cursor: string | undefined;
        do {
          signal.throwIfAborted();
          const page = await service.operations.list(cursor, 100);
          operations.push(...page.operations);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return operations;
      },
    });
    this.operationCoordinator = coordinator;
    this.unsubscribeCoordinator = coordinator.subscribe((change) => {
      if (service !== this.service || this.disposed) {
        return;
      }
      this.queueOperationPersistence(change.operation);
      this.update({
        walletSnapshot: Object.freeze({
          ...service.getSnapshot(),
          operations: coordinator.list(),
        }),
      });
    });

    const repository = this.activityRepository;
    if (repository !== undefined) {
      try {
        const operations = await repository.listOperations();
        if (this.operationCoordinator !== coordinator || this.disposed) {
          return;
        }
        for (const operation of operations) {
          coordinator.track(operation);
        }
      } catch {
        // Corrupt encrypted activity is surfaced by reconciliation/manual retry.
      }
    }
    for (const operation of service.getSnapshot().operations) {
      coordinator.track(operation);
    }
    this.update({
      walletSnapshot: Object.freeze({
        ...service.getSnapshot(),
        operations: coordinator.list(),
      }),
    });
  }

  private stopOperationCoordinator(): void {
    this.unsubscribeCoordinator?.();
    this.unsubscribeCoordinator = undefined;
    this.operationCoordinator?.close();
    this.operationCoordinator = undefined;
  }

  private queueOperationPersistence(operation: WalletOperation): void {
    const repository = this.activityRepository;
    if (repository === undefined) {
      return;
    }
    this.operationPersistenceTail = this.operationPersistenceTail
      .then(async () => {
        if (this.activityRepository === repository) {
          await repository.upsertOperation(operation);
          if (isTerminalOperationStatus(operation.status)) {
            if (
              operation.kind === 'ecash_send' &&
              operation.status === 'refunded'
            ) {
              await repository.deleteSecret('ecash-export', operation.key);
            } else if (operation.kind === 'lightning_receive') {
              await repository.deleteSecret('lightning-invoice', operation.key);
            }
          }
        }
      })
      .catch(() => {
        // The operation remains in SDK/service truth and can be reconciled.
      });
  }

  private async deleteSecretIfTerminal(
    repository: WalletActivityRepository,
    purpose: 'ecash-export' | 'lightning-invoice',
    key: OperationKey,
  ): Promise<void> {
    const operation = this.operationCoordinator?.get(key);
    const shouldDelete =
      operation !== undefined &&
      (purpose === 'lightning-invoice'
        ? isTerminalOperationStatus(operation.status)
        : operation.status === 'refunded');
    if (shouldDelete) {
      await repository.deleteSecret(purpose, key);
    }
  }

  private update(patch: Partial<WalletAppState>): void {
    if (this.disposed) {
      return;
    }

    this.state = Object.freeze({
      ...this.state,
      ...patch,
    });
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function degradedChatAvailability(
  reason: Extract<ChatAvailability, { status: 'degraded' }>['reason'],
): ChatAvailability {
  return Object.freeze({
    status: 'degraded',
    reason,
    retryable:
      reason === 'offline' ||
      reason === 'relay_unavailable' ||
      reason === 'group_out_of_sync' ||
      reason === 'internal',
  });
}

function clearFeatureSecrets(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }

  for (const key of ['notes', 'invoice'] as const) {
    const secret = Reflect.get(value, key) as
      { clear?: () => void } | undefined;
    secret?.clear?.();
  }
  const direct = value as { clear?: () => void };
  direct.clear?.();
  for (const key of ['export', 'payment'] as const) {
    clearFeatureSecrets(Reflect.get(value, key));
  }
}
