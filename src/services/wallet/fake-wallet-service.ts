import {
  addMsats,
  candidateId,
  clearableSecretText,
  clientName,
  createWalletOperation,
  federationId,
  isJoinApprovalValid,
  msats,
  normalizeMnemonicWords,
  operationId,
  paymentFingerprint,
  publicWalletError,
  quoteId,
  recoveryStatus,
  secretMnemonic,
  secretRecordRef,
  subtractMsats,
  transitionOperation,
  WalletError,
  type ActiveFederation,
  type ConfirmedEcashRedeem,
  type ConfirmedEcashSpend,
  type ConfirmedLightningQuote,
  type EcashExport,
  type EcashPreview,
  type FederationCandidate,
  type FederationCapabilities,
  type FederationDescriptor,
  type FederationJoinApproval,
  type LightningInvoicePreview,
  type LightningPaymentIntent,
  type LightningQuote,
  type LightningReceive,
  type LightningReceiveIntent,
  type Msats,
  type OperationKey,
  type PaymentFingerprint,
  type RecoveryListener,
  type RecoveryResult,
  type RecoveryStatus,
  type SecretMnemonic,
  type SensitiveInput,
  type TrackedOperation,
  type WalletOperation,
} from '../../domain';
import type {
  OpenWalletInput,
  OperationCursor,
  OperationListener,
  OperationPage,
  ReconciliationResult,
  WalletService,
  WalletSnapshot,
  WalletSnapshotListener,
} from './wallet-service';

export interface FakeWalletOptions {
  clock?: () => number;
  idFactory?: () => string;
  latencyMs?: number;
  initialBalanceMsats?: Msats;
  preview?: Omit<FederationCandidate, 'candidateId' | 'expiresAtMs'>;
  lightningFeeQuoteAvailable?: boolean;
  autoSettlePayments?: boolean;
  mnemonicWords?: readonly string[];
}

interface PendingCandidate {
  candidate: FederationCandidate;
  inviteCode: string;
}

interface ParsedSecret {
  input: SensitiveInput;
  fingerprint: PaymentFingerprint;
}

interface PendingQuote {
  quote: LightningQuote;
  invoice: SensitiveInput;
}

const DEFAULT_PREVIEW = {
  federationId: federationId('demo-fedimint-federation'),
  displayName: 'Demo Federation',
  network: 'signet',
  modules: Object.freeze(['ln', 'mint', 'wallet']),
  guardianCount: 4,
  guardianOrigins: Object.freeze([
    'wss://guardian-1.demo.invalid',
    'wss://guardian-2.demo.invalid',
    'wss://guardian-3.demo.invalid',
    'wss://guardian-4.demo.invalid',
  ]),
} as const;

const DEFAULT_MNEMONIC = Object.freeze([
  'abandon',
  'ability',
  'able',
  'about',
  'above',
  'absent',
  'absorb',
  'abstract',
  'absurd',
  'abuse',
  'access',
  'accident',
]);

export class FakeWalletService implements WalletService {
  readonly kind = 'fake' as const;

  readonly identity = {
    createMnemonic: (): Promise<SecretMnemonic> => this.createMnemonic(),
    setMnemonic: (words: readonly string[]): Promise<void> =>
      this.setMnemonic(words),
    revealMnemonic: (
      reason: 'initial-backup' | 'settings-backup',
    ): Promise<SecretMnemonic> => {
      void reason;
      return this.revealMnemonic();
    },
  };

  readonly federation = {
    preview: (
      inviteCode: SensitiveInput,
      signal?: AbortSignal,
    ): Promise<FederationCandidate> =>
      this.previewFederation(inviteCode, signal),
    join: (
      approval: FederationJoinApproval,
      signal?: AbortSignal,
    ): Promise<ActiveFederation> => this.joinFederation(approval, signal),
    reconcilePendingJoin: (
      pending: FederationDescriptor,
      signal?: AbortSignal,
    ): Promise<ActiveFederation | undefined> =>
      this.reconcilePendingJoin(pending, signal),
    getCapabilities: (signal?: AbortSignal): Promise<FederationCapabilities> =>
      this.getCapabilities(signal),
  };

  readonly balance = {
    refresh: (signal?: AbortSignal): Promise<void> =>
      this.refreshBalance(signal),
  };

  readonly ecash = {
    parse: (
      notes: SensitiveInput,
      signal?: AbortSignal,
    ): Promise<EcashPreview> => this.parseEcash(notes, signal),
    redeem: (
      intent: ConfirmedEcashRedeem,
      signal?: AbortSignal,
    ): Promise<TrackedOperation> => this.redeemEcash(intent, signal),
    createSpend: (
      intent: ConfirmedEcashSpend,
      signal?: AbortSignal,
    ): Promise<EcashExport> => this.createEcashSpend(intent, signal),
    requestCancellation: (
      id: OperationKey['operationId'],
      signal?: AbortSignal,
    ): Promise<void> => this.cancelEcashSpend(id, signal),
  };

  readonly lightning = {
    parseInvoice: (
      invoice: SensitiveInput,
      signal?: AbortSignal,
    ): Promise<LightningInvoicePreview> =>
      this.parseLightningInvoice(invoice, signal),
    createInvoice: (
      intent: LightningReceiveIntent,
      signal?: AbortSignal,
    ): Promise<LightningReceive> => this.createLightningInvoice(intent, signal),
    quotePayment: (
      intent: LightningPaymentIntent,
      signal?: AbortSignal,
    ): Promise<LightningQuote> => this.quoteLightningPayment(intent, signal),
    pay: (
      confirmedQuote: ConfirmedLightningQuote,
      signal?: AbortSignal,
    ): Promise<TrackedOperation> =>
      this.payLightningInvoice(confirmedQuote, signal),
  };

  readonly operations = {
    list: (cursor?: OperationCursor, limit?: number): Promise<OperationPage> =>
      this.listOperations(cursor, limit),
    get: (key: OperationKey): Promise<WalletOperation | undefined> =>
      this.getOperation(key),
    subscribe: (key: OperationKey, listener: OperationListener): (() => void) =>
      this.subscribeOperation(key, listener),
    reconcile: (signal?: AbortSignal): Promise<ReconciliationResult> =>
      this.reconcileOperations(signal),
  };

  readonly recovery = {
    getStatus: (): Promise<RecoveryStatus> =>
      Promise.resolve(this.recoveryState),
    subscribe: (listener: RecoveryListener): (() => void) =>
      this.subscribeRecovery(listener),
    waitForCompletion: (signal?: AbortSignal): Promise<RecoveryResult> =>
      this.waitForRecovery(signal),
  };

  private readonly listeners = new Set<WalletSnapshotListener>();
  private readonly operationListeners = new Map<
    string,
    Set<OperationListener>
  >();
  private readonly recoveryListeners = new Set<RecoveryListener>();
  private readonly candidates = new Map<string, PendingCandidate>();
  private readonly parsedEcash = new Map<PaymentFingerprint, ParsedSecret>();
  private readonly parsedInvoices = new Map<PaymentFingerprint, ParsedSecret>();
  private readonly quotes = new Map<string, PendingQuote>();
  private readonly redeemedFingerprints = new Set<PaymentFingerprint>();
  private readonly submittedQuotes = new Map<string, TrackedOperation>();
  private readonly operationRecords = new Map<string, WalletOperation>();
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly latencyMs: number;
  private readonly initialBalanceMsats: Msats;
  private readonly preview: Omit<
    FederationCandidate,
    'candidateId' | 'expiresAtMs'
  >;
  private readonly lightningFeeQuoteAvailable: boolean;
  private readonly autoSettlePayments: boolean;
  private readonly defaultMnemonicWords: readonly string[];
  private lifetime = new AbortController();
  private joinInFlight:
    | {
        candidateId: string;
        promise: Promise<ActiveFederation>;
      }
    | undefined;
  private mnemonicWords: string[] | undefined;
  private recoveryState = recoveryStatus({ phase: 'idle', completed: 0 });
  private snapshot: WalletSnapshot;

  constructor(options: FakeWalletOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.latencyMs = options.latencyMs ?? 150;
    this.initialBalanceMsats =
      options.initialBalanceMsats ?? msats(25_000_000n);
    this.preview = options.preview ?? DEFAULT_PREVIEW;
    this.lightningFeeQuoteAvailable =
      options.lightningFeeQuoteAvailable ?? true;
    this.autoSettlePayments = options.autoSettlePayments ?? true;
    this.defaultMnemonicWords = normalizeMnemonicWords(
      options.mnemonicWords ?? DEFAULT_MNEMONIC,
    );
    this.snapshot = this.makeSnapshot({
      lifecycle: 'closed',
      connection: 'offline',
      balanceMsats: msats(0n),
      operations: [],
    });
  }

  async open(input: OpenWalletInput = {}): Promise<void> {
    if (this.snapshot.lifecycle !== 'closed') {
      return;
    }

    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.updateSnapshot({
      lifecycle: 'opening',
      connection: 'unknown',
      activeFederation: input.activeFederation,
      balanceMsats:
        input.activeFederation === undefined
          ? msats(0n)
          : this.snapshot.balanceMsats === 0n
            ? this.initialBalanceMsats
            : this.snapshot.balanceMsats,
      error: undefined,
    });

    await wait(this.latencyMs, [input.signal, this.lifetime.signal]);

    const capabilities =
      input.activeFederation === undefined
        ? undefined
        : this.capabilitiesFor(input.activeFederation);
    this.updateSnapshot({
      lifecycle: 'ready',
      connection: input.activeFederation === undefined ? 'unknown' : 'online',
      activeFederation: input.activeFederation,
      balanceMsats:
        input.activeFederation === undefined
          ? msats(0n)
          : this.snapshot.balanceMsats === 0n
            ? this.initialBalanceMsats
            : this.snapshot.balanceMsats,
      capabilities,
      error: undefined,
    });
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    this.candidates.clear();
    this.parsedEcash.clear();
    this.parsedInvoices.clear();
    this.quotes.clear();
    this.submittedQuotes.clear();
    this.joinInFlight = undefined;
    this.operationListeners.clear();
    this.updateSnapshot({
      lifecycle: 'closed',
      connection: 'offline',
      activeFederation: undefined,
      capabilities: undefined,
      balanceMsats: msats(0n),
      error: undefined,
    });
  }

  getSnapshot(): WalletSnapshot {
    return this.snapshot;
  }

  subscribe(listener: WalletSnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private async createMnemonic(): Promise<SecretMnemonic> {
    this.assertReady();
    if (this.mnemonicWords === undefined) {
      this.mnemonicWords = [...this.defaultMnemonicWords];
    }
    return secretMnemonic(this.mnemonicWords);
  }

  private async setMnemonic(words: readonly string[]): Promise<void> {
    this.assertReady();
    this.mnemonicWords = [...normalizeMnemonicWords(words)];
  }

  private async revealMnemonic(): Promise<SecretMnemonic> {
    this.assertReady();
    if (this.mnemonicWords === undefined) {
      throw new WalletError('backup_unconfirmed');
    }
    return secretMnemonic(this.mnemonicWords);
  }

  private async previewFederation(
    inviteCode: SensitiveInput,
    signal?: AbortSignal,
  ): Promise<FederationCandidate> {
    this.assertReady();
    const normalizedInvite = inviteCode.trim();

    if (normalizedInvite.length < 8) {
      throw new WalletError('invalid_invite_code');
    }

    await wait(this.latencyMs, [signal, this.lifetime.signal]);

    this.candidates.clear();
    const candidate: FederationCandidate = Object.freeze({
      ...this.preview,
      candidateId: candidateId(this.idFactory()),
      expiresAtMs: this.clock() + 5 * 60 * 1000,
    });

    this.candidates.set(candidate.candidateId, {
      candidate,
      inviteCode: normalizedInvite,
    });

    return candidate;
  }

  private async joinFederation(
    approval: FederationJoinApproval,
    signal?: AbortSignal,
  ): Promise<ActiveFederation> {
    if (this.joinInFlight?.candidateId === approval.candidateId) {
      return this.joinInFlight.promise;
    }

    this.assertReady();

    if (this.joinInFlight !== undefined) {
      throw new WalletError('wallet_busy');
    }

    const pending = this.candidates.get(approval.candidateId);

    if (
      pending === undefined ||
      !isJoinApprovalValid(approval, pending.candidate, this.clock())
    ) {
      throw new WalletError('candidate_expired');
    }

    const promise = this.performJoin(pending, signal);
    this.joinInFlight = {
      candidateId: approval.candidateId,
      promise,
    };

    const clearInFlight = () => {
      if (this.joinInFlight?.promise === promise) {
        this.joinInFlight = undefined;
      }
    };
    void promise.then(clearInFlight, clearInFlight);

    return promise;
  }

  private async performJoin(
    pending: PendingCandidate,
    signal?: AbortSignal,
  ): Promise<ActiveFederation> {
    this.updateSnapshot({
      lifecycle: 'joining',
      error: undefined,
    });

    try {
      await wait(this.latencyMs, [signal, this.lifetime.signal]);

      const activeFederation: ActiveFederation = Object.freeze({
        federationId: pending.candidate.federationId,
        displayName: pending.candidate.displayName,
        network: pending.candidate.network,
        modules: pending.candidate.modules,
        guardianCount: pending.candidate.guardianCount,
        clientName: clientName(this.idFactory()),
        joinedAtMs: this.clock(),
      });

      this.candidates.clear();
      this.updateSnapshot({
        lifecycle: 'ready',
        connection: 'online',
        activeFederation,
        balanceMsats: this.initialBalanceMsats,
        capabilities: this.capabilitiesFor(activeFederation),
        error: undefined,
      });
      return activeFederation;
    } catch (error) {
      if (this.snapshot.lifecycle !== 'closed') {
        this.updateSnapshot({
          lifecycle: 'ready',
          error: publicWalletError(
            error instanceof DOMException && error.name === 'AbortError'
              ? 'operation_failed'
              : 'unknown',
          ),
        });
      }
      throw error;
    }
  }

  private async getCapabilities(
    signal?: AbortSignal,
  ): Promise<FederationCapabilities> {
    this.assertReady();
    signal?.throwIfAborted();
    return this.capabilitiesFor(this.requireActiveFederation());
  }

  private async reconcilePendingJoin(
    pending: FederationDescriptor,
    signal?: AbortSignal,
  ): Promise<ActiveFederation | undefined> {
    this.assertReady();
    signal?.throwIfAborted();
    await wait(this.latencyMs, [signal, this.lifetime.signal]);
    const activeFederation: ActiveFederation = Object.freeze({
      ...pending,
      clientName: clientName(`reconciled-${this.safeId()}`),
      joinedAtMs: this.clock(),
    });
    this.updateSnapshot({
      lifecycle: 'ready',
      connection: 'online',
      activeFederation,
      balanceMsats: this.initialBalanceMsats,
      capabilities: this.capabilitiesFor(activeFederation),
      error: undefined,
    });
    return activeFederation;
  }

  private capabilitiesFor(
    federation: ActiveFederation,
  ): FederationCapabilities {
    const mint = federation.modules.includes('mint');
    const lightning = federation.modules.includes('ln');
    const gatewayAvailable = lightning;
    return Object.freeze({
      mint,
      lightning,
      onchain: federation.modules.includes('wallet'),
      gatewayAvailable,
      recovery: 'unknown',
      lightningSend: !lightning
        ? 'unsupported'
        : !gatewayAvailable
          ? 'disabled_gateway_unavailable'
          : this.lightningFeeQuoteAvailable
            ? 'enabled'
            : 'disabled_fee_quote_unavailable',
    });
  }

  private async refreshBalance(signal?: AbortSignal): Promise<void> {
    this.assertReady();
    this.requireActiveFederation();
    await wait(this.latencyMs, [signal, this.lifetime.signal]);
    this.updateSnapshot({
      connection: 'online',
      error: undefined,
    });
  }

  private async parseEcash(
    notes: SensitiveInput,
    signal?: AbortSignal,
  ): Promise<EcashPreview> {
    this.assertReady();
    const activeFederation = this.requireActiveFederation();
    await wait(this.latencyMs, [signal, this.lifetime.signal]);

    const match = /^fedimint-ecash:([0-9]+):([a-z0-9-]+):([a-z0-9-]+)$/i.exec(
      notes,
    );
    if (match === null) {
      throw new WalletError('invalid_ecash');
    }

    const amountMsats = msats(BigInt(match[1]));
    if (amountMsats === 0n) {
      throw new WalletError('invalid_ecash');
    }
    const encodedFederation = federationId(match[2]);
    const fingerprint = paymentFingerprint(`fake:${fingerprintText(notes)}`);
    const compatible = encodedFederation === activeFederation.federationId;
    this.parsedEcash.set(fingerprint, { input: notes, fingerprint });

    return Object.freeze({
      fingerprint,
      amountMsats,
      federationId: encodedFederation,
      compatible,
    });
  }

  private async redeemEcash(
    intent: ConfirmedEcashRedeem,
    signal?: AbortSignal,
  ): Promise<TrackedOperation> {
    this.assertReady();
    const activeFederation = this.requireActiveFederation();
    const parsed = this.parsedEcash.get(intent.preview.fingerprint);

    if (parsed === undefined) {
      throw new WalletError('invalid_ecash');
    }
    if (!intent.preview.compatible) {
      throw new WalletError('ecash_wrong_federation');
    }
    if (this.redeemedFingerprints.has(parsed.fingerprint)) {
      throw new WalletError('ecash_already_redeemed');
    }

    signal?.throwIfAborted();
    this.redeemedFingerprints.add(parsed.fingerprint);
    this.parsedEcash.delete(parsed.fingerprint);
    const operation = this.createOperation(
      activeFederation,
      'ecash_receive',
      intent.preview.amountMsats,
      'pending',
    );
    const tracked = this.tracked(operation);

    if (this.autoSettlePayments) {
      this.scheduleTerminal(operation.key, 'settled', () => {
        this.updateSnapshot({
          balanceMsats: addMsats(
            this.snapshot.balanceMsats,
            intent.preview.amountMsats,
          ),
        });
      });
    }

    return tracked;
  }

  private async createEcashSpend(
    confirmed: ConfirmedEcashSpend,
    signal?: AbortSignal,
  ): Promise<EcashExport> {
    this.assertReady();
    const activeFederation = this.requireActiveFederation();
    signal?.throwIfAborted();

    if (confirmed.intent.amountMsats === 0n) {
      throw new WalletError('invalid_input');
    }
    if (confirmed.intent.amountMsats > this.snapshot.balanceMsats) {
      throw new WalletError('insufficient_balance');
    }

    const operation = this.createOperation(
      activeFederation,
      'ecash_send',
      confirmed.intent.amountMsats,
      'pending',
    );
    const nonce = this.safeId();
    const notes = `fedimint-ecash:${confirmed.intent.amountMsats.toString()}:${activeFederation.federationId}:${nonce}`;
    const recordRef = secretRecordRef(
      `secret:ecash-export:${operation.key.operationId}`,
    );
    this.updateSnapshot({
      balanceMsats: subtractMsats(
        this.snapshot.balanceMsats,
        confirmed.intent.amountMsats,
      ),
    });

    if (this.autoSettlePayments) {
      this.scheduleTerminal(operation.key, 'settled');
    }

    return Object.freeze({
      operation,
      notes: clearableSecretText(notes),
      secretRecordRef: recordRef,
    });
  }

  private async cancelEcashSpend(
    id: OperationKey['operationId'],
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertReady();
    const activeFederation = this.requireActiveFederation();
    signal?.throwIfAborted();
    const key = {
      federationId: activeFederation.federationId,
      operationId: id,
    };
    const current = this.operationRecords.get(operationMapKey(key));

    if (current === undefined || current.kind !== 'ecash_send') {
      throw new WalletError('operation_failed');
    }
    if (
      current.status === 'settled' ||
      current.status === 'refunded' ||
      current.status === 'failed' ||
      current.status === 'cancelled'
    ) {
      return;
    }

    this.updateOperation(key, 'refunding');
    this.scheduleTerminal(key, 'refunded', () => {
      if (current.amountMsats !== undefined) {
        this.updateSnapshot({
          balanceMsats: addMsats(
            this.snapshot.balanceMsats,
            current.amountMsats,
          ),
        });
      }
    });
  }

  private async parseLightningInvoice(
    invoice: SensitiveInput,
    signal?: AbortSignal,
  ): Promise<LightningInvoicePreview> {
    this.assertReady();
    await wait(this.latencyMs, [signal, this.lifetime.signal]);

    const match =
      /^(lnbc|lntb|lntbs|lnbcrt)1fake([0-9]+)x([0-9]+)x([a-z0-9]+)$/i.exec(
        invoice,
      );
    if (match === null) {
      throw new WalletError('invalid_input');
    }

    const amountMsats = msats(BigInt(match[2]));
    if (amountMsats === 0n) {
      throw new WalletError('invalid_input');
    }
    const expiresAtMs = Number(match[3]);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) {
      throw new WalletError('invalid_input');
    }

    const network =
      match[1].toLowerCase() === 'lnbc'
        ? 'bitcoin'
        : match[1].toLowerCase() === 'lnbcrt'
          ? 'regtest'
          : 'signet';
    const fingerprint = paymentFingerprint(`fake:${fingerprintText(invoice)}`);
    this.parsedInvoices.set(fingerprint, { input: invoice, fingerprint });

    return Object.freeze({
      fingerprint,
      network,
      amountMsats,
      expiresAtMs,
      description: 'Simulated Lightning payment',
    });
  }

  private async createLightningInvoice(
    intent: LightningReceiveIntent,
    signal?: AbortSignal,
  ): Promise<LightningReceive> {
    this.assertReady();
    const activeFederation = this.requireActiveFederation();
    const capabilities = this.capabilitiesFor(activeFederation);
    if (!capabilities.lightning || !capabilities.gatewayAvailable) {
      throw new WalletError('gateway_unavailable');
    }
    if (
      intent.amountMsats === 0n ||
      !Number.isSafeInteger(intent.expirySeconds) ||
      intent.expirySeconds < 60
    ) {
      throw new WalletError('invalid_input');
    }

    signal?.throwIfAborted();
    const expiresAtMs = this.clock() + intent.expirySeconds * 1000;
    const operation = this.createOperation(
      activeFederation,
      'lightning_receive',
      intent.amountMsats,
      'awaiting_external_payment',
      expiresAtMs,
    );
    const prefix =
      activeFederation.network === 'bitcoin'
        ? 'lnbc'
        : activeFederation.network === 'regtest'
          ? 'lnbcrt'
          : 'lntb';
    const invoice = `${prefix}1fake${intent.amountMsats.toString()}x${expiresAtMs}x${this.safeId()}`;

    if (this.autoSettlePayments) {
      this.scheduleTerminal(operation.key, 'settled', () => {
        this.updateSnapshot({
          balanceMsats: addMsats(
            this.snapshot.balanceMsats,
            intent.amountMsats,
          ),
        });
      });
    }

    return Object.freeze({
      operation,
      invoice: clearableSecretText(invoice),
      expiresAtMs,
      secretRecordRef: secretRecordRef(
        `secret:lightning-invoice:${operation.key.operationId}`,
      ),
    });
  }

  private async quoteLightningPayment(
    intent: LightningPaymentIntent,
    signal?: AbortSignal,
  ): Promise<LightningQuote> {
    this.assertReady();
    const activeFederation = this.requireActiveFederation();
    signal?.throwIfAborted();
    const rawInvoice = this.parsedInvoices.get(intent.preview.fingerprint);
    if (rawInvoice === undefined) {
      throw new WalletError('invalid_input');
    }
    if (intent.preview.amountMsats === undefined) {
      throw new WalletError('invoice_amount_missing');
    }
    if (intent.preview.amountMsats === 0n) {
      throw new WalletError('invalid_input');
    }
    if (intent.preview.expiresAtMs <= this.clock()) {
      throw new WalletError('invoice_expired');
    }
    if (intent.preview.network !== activeFederation.network) {
      throw new WalletError('invoice_wrong_network');
    }
    if (!this.lightningFeeQuoteAvailable) {
      throw new WalletError('fee_quote_unavailable');
    }

    const feeMsats = msats(
      maxBigInt(1_000n, intent.preview.amountMsats / 100n),
    );
    if (feeMsats > intent.maximumFeeMsats) {
      throw new WalletError('fee_limit_exceeded');
    }

    const quote: LightningQuote = Object.freeze({
      quoteId: quoteId(`fake-quote-${this.safeId()}`),
      invoiceFingerprint: intent.preview.fingerprint,
      amountMsats: intent.preview.amountMsats,
      feeMsats,
      maximumFeeMsats: intent.maximumFeeMsats,
      expiresAtMs: Math.min(intent.preview.expiresAtMs, this.clock() + 60_000),
      gatewayId: 'fake-gateway',
    });
    this.quotes.set(quote.quoteId, {
      quote,
      invoice: rawInvoice.input,
    });
    return quote;
  }

  private async payLightningInvoice(
    confirmed: ConfirmedLightningQuote,
    signal?: AbortSignal,
  ): Promise<TrackedOperation> {
    this.assertReady();
    const activeFederation = this.requireActiveFederation();
    const duplicate = this.submittedQuotes.get(confirmed.quote.quoteId);
    if (duplicate !== undefined) {
      return duplicate;
    }

    signal?.throwIfAborted();
    const pending = this.quotes.get(confirmed.quote.quoteId);
    if (
      pending === undefined ||
      pending.quote.invoiceFingerprint !== confirmed.quote.invoiceFingerprint ||
      confirmed.quote.expiresAtMs <= this.clock()
    ) {
      throw new WalletError('fee_quote_unavailable');
    }

    const total = addMsats(
      confirmed.quote.amountMsats,
      confirmed.quote.feeMsats,
    );
    if (total > this.snapshot.balanceMsats) {
      throw new WalletError('insufficient_balance');
    }

    const operation = this.createOperation(
      activeFederation,
      'lightning_send',
      confirmed.quote.amountMsats,
      'pending',
      undefined,
      confirmed.quote.feeMsats,
    );
    const tracked = this.tracked(operation);
    this.submittedQuotes.set(confirmed.quote.quoteId, tracked);
    this.updateSnapshot({
      balanceMsats: subtractMsats(this.snapshot.balanceMsats, total),
    });

    if (this.autoSettlePayments) {
      this.scheduleTerminal(operation.key, 'settled');
    }
    return tracked;
  }

  private async listOperations(
    cursor?: OperationCursor,
    limit = 20,
  ): Promise<OperationPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Operation page limit is invalid.');
    }
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new TypeError('Operation cursor is invalid.');
    }

    const all = this.sortedOperations();
    const page = all.slice(start, start + limit);
    const next = start + page.length;
    return Object.freeze({
      operations: Object.freeze(page),
      ...(next < all.length ? { nextCursor: String(next) } : {}),
    });
  }

  private async getOperation(
    key: OperationKey,
  ): Promise<WalletOperation | undefined> {
    return this.operationRecords.get(operationMapKey(key));
  }

  private subscribeOperation(
    key: OperationKey,
    listener: OperationListener,
  ): () => void {
    const mapKey = operationMapKey(key);
    const listeners =
      this.operationListeners.get(mapKey) ?? new Set<OperationListener>();
    listeners.add(listener);
    this.operationListeners.set(mapKey, listeners);
    const current = this.operationRecords.get(mapKey);
    if (current !== undefined) {
      listener(current);
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.operationListeners.delete(mapKey);
      }
    };
  }

  private async reconcileOperations(
    signal?: AbortSignal,
  ): Promise<ReconciliationResult> {
    this.assertReady();
    signal?.throwIfAborted();
    return Object.freeze({
      observed: this.operationRecords.size,
      added: 0,
      updated: 0,
      unchanged: this.operationRecords.size,
    });
  }

  private subscribeRecovery(listener: RecoveryListener): () => void {
    this.recoveryListeners.add(listener);
    listener(this.recoveryState);
    return () => {
      this.recoveryListeners.delete(listener);
    };
  }

  private async waitForRecovery(signal?: AbortSignal): Promise<RecoveryResult> {
    this.assertReady();
    if (this.mnemonicWords === undefined) {
      throw new WalletError('recovery_failed');
    }

    this.setRecoveryState({
      phase: 'checking',
      completed: 0,
      total: 2,
      messageCode: 'checking_modules',
    });
    await wait(this.latencyMs, [signal, this.lifetime.signal]);
    this.setRecoveryState({
      phase: 'recovering',
      completed: 1,
      total: 2,
      messageCode: 'reconciling_operations',
    });
    await wait(this.latencyMs, [signal, this.lifetime.signal]);
    this.setRecoveryState({
      phase: 'complete',
      completed: 2,
      total: 2,
      messageCode: 'complete',
    });

    return Object.freeze({
      completedAtMs: this.clock(),
      recoveredModules: 2,
      pendingOperationsReconciled: this.operationRecords.size,
    });
  }

  private setRecoveryState(next: RecoveryStatus): void {
    this.recoveryState = recoveryStatus(next);
    for (const listener of this.recoveryListeners) {
      listener(this.recoveryState);
    }
  }

  private createOperation(
    federation: ActiveFederation,
    kind: WalletOperation['kind'],
    amountMsats: Msats,
    status: WalletOperation['status'],
    expiresAtMs?: number,
    feeMsats?: Msats,
  ): WalletOperation {
    const createdAtMs = this.clock();
    const operation = createWalletOperation({
      key: {
        federationId: federation.federationId,
        operationId: operationId(`fake-operation-${this.safeId()}`),
      },
      kind,
      status,
      amountMsats,
      createdAtMs,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      ...(feeMsats === undefined ? {} : { feeMsats }),
    });
    this.operationRecords.set(operationMapKey(operation.key), operation);
    this.publishOperations();
    return operation;
  }

  private tracked(operation: WalletOperation): TrackedOperation {
    return Object.freeze({
      operationId: operation.key.operationId,
      operation,
    });
  }

  private updateOperation(
    key: OperationKey,
    status: WalletOperation['status'],
  ): WalletOperation | undefined {
    const mapKey = operationMapKey(key);
    const current = this.operationRecords.get(mapKey);
    if (current === undefined) {
      return undefined;
    }

    const result = transitionOperation(current, status, this.clock());
    if (result.outcome !== 'applied') {
      return result.operation;
    }

    this.operationRecords.set(mapKey, result.operation);
    this.publishOperations();
    for (const listener of this.operationListeners.get(mapKey) ?? []) {
      listener(result.operation);
    }
    return result.operation;
  }

  private scheduleTerminal(
    key: OperationKey,
    status: WalletOperation['status'],
    after?: () => void,
  ): void {
    const lifetime = this.lifetime.signal;
    void wait(this.latencyMs, [lifetime]).then(
      () => {
        if (lifetime.aborted) {
          return;
        }
        const updated = this.updateOperation(key, status);
        if (updated?.status === status) {
          after?.();
        }
      },
      () => {
        // Closing the service intentionally cancels simulated completion.
      },
    );
  }

  private publishOperations(): void {
    this.updateSnapshot({ operations: this.sortedOperations() });
  }

  private sortedOperations(): readonly WalletOperation[] {
    return [...this.operationRecords.values()].sort(
      (left, right) =>
        right.updatedAtMs - left.updatedAtMs ||
        right.createdAtMs - left.createdAtMs,
    );
  }

  private assertReady(): void {
    if (this.snapshot.lifecycle === 'closed') {
      throw new WalletError('wallet_locked');
    }

    if (
      this.snapshot.lifecycle === 'opening' ||
      this.snapshot.lifecycle === 'joining'
    ) {
      throw new WalletError('wallet_busy');
    }
  }

  private requireActiveFederation(): ActiveFederation {
    const federation = this.snapshot.activeFederation;
    if (federation === undefined) {
      throw new WalletError('wallet_locked');
    }
    return federation;
  }

  private safeId(): string {
    const normalized = this.idFactory()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    return normalized.length > 0 ? normalized : 'id';
  }

  private updateSnapshot(
    patch: Partial<Omit<WalletSnapshot, 'serviceKind'>>,
  ): void {
    this.snapshot = this.makeSnapshot({
      ...this.snapshot,
      ...patch,
    });
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private makeSnapshot(
    input: Omit<WalletSnapshot, 'serviceKind'>,
  ): WalletSnapshot {
    return Object.freeze({
      serviceKind: this.kind,
      ...input,
      operations: Object.freeze([...(input.operations ?? [])]),
    });
  }
}

function operationMapKey(key: OperationKey): string {
  return `${key.federationId}:${key.operationId}`;
}

function fingerprintText(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

async function wait(
  milliseconds: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<void> {
  for (const signal of signals) {
    signal?.throwIfAborted();
  }

  if (milliseconds === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(finish, milliseconds);

    function finish() {
      cleanup();
      resolve();
    }

    function abort() {
      cleanup();
      reject(new DOMException('Request aborted.', 'AbortError'));
    }

    function cleanup() {
      globalThis.clearTimeout(timeout);
      for (const signal of signals) {
        signal?.removeEventListener('abort', abort);
      }
    }

    for (const signal of signals) {
      signal?.addEventListener('abort', abort, { once: true });
    }
  });
}
