import {
  WalletDirector,
  type FedimintWallet,
  type GatewayInfo,
} from '@fedimint/core';
import { FedimintWallet as ClientScopedFedimintWallet } from '@fedimint/core/testing';
import { WasmWorkerTransport } from '@fedimint/transport-web';

import {
  clearableSecretText,
  clientName,
  createWalletOperation,
  isJoinApprovalValid,
  isOperationInFlight,
  msats,
  normalizeMnemonicWords,
  operationId,
  publicWalletError,
  quoteId,
  recoveryStatus,
  secretMnemonic,
  secretRecordRef,
  transitionOperation,
  WalletError,
  type ActiveFederation,
  type ConfirmedEcashRedeem,
  type ConfirmedEcashSpend,
  type ConfirmedLightningQuote,
  type ClientName,
  type EcashExport,
  type EcashPreview,
  type FederationCandidate,
  type FederationCapabilities,
  type FederationDescriptor,
  type FederationJoinApproval,
  type LightningInvoicePreview,
  type LightningPaymentRoute,
  type LightningPaymentIntent,
  type LightningQuote,
  type LightningReceive,
  type LightningReceiveIntent,
  type Msats,
  type OperationKey,
  type OperationStatus,
  type PaymentFingerprint,
  type RecoveryListener,
  type RecoveryResult,
  type RecoveryStatus,
  type SecretMnemonic,
  type SensitiveInput,
  type TrackedOperation,
  type WalletOperation,
} from '../../domain';
import {
  asRecord,
  checkedMsatsToSdkNumber,
  checkedSdkMsats,
  classifyLightningPaySubmissionError,
  describeBolt11ParseResponse,
  describeFederationNetworkDiagnostics,
  fingerprintSensitiveInput,
  isInvoiceNetworkCompatible,
  isTerminalAdapterStatus,
  normalizeInternalPayState,
  normalizeLnPayState,
  normalizeLnReceiveState,
  normalizeReissueState,
  normalizeSpendState,
  operationMapKey,
  parseBolt11Header,
  parseGatewayFeePolicy,
  quoteGatewayFee,
  sanitizeFederationPreview,
  sanitizeSdkOperation,
  sdkOperationFlow,
  trackedOperation,
  type SdkOperationFlow,
} from './fedimint-wallet-helpers';
import {
  summarizeConnectedFederations,
  type OpenWalletInput,
  type OperationCursor,
  type OperationListener,
  type OperationPage,
  type ReconciliationResult,
  type WalletService,
  type WalletSnapshot,
  type WalletSnapshotListener,
} from './wallet-service';
import { selectLightningReceiveFederationId } from './lightning-receive-router';

export {
  classifyLightningPaySubmissionError,
  normalizeInternalPayState,
  normalizeLnPayState,
  normalizeLnReceiveState,
  normalizeReissueState,
  normalizeSpendState,
  parseBolt11Header,
  parseGatewayFeePolicy,
  quoteGatewayFee,
  sanitizeFederationPreview,
  sanitizeSdkOperation,
} from './fedimint-wallet-helpers';

// In SDK 0.1.3, services are constructed against this default name even when
// open/join receives a custom name. The adapter constructs every wallet with
// its persisted client name until the public director exposes that parameter.
export const SDK_DEFAULT_CLIENT_NAME = 'dd5135b2-c228-41b7-a4f9-3b6e7afe3088';

/**
 * SDK 0.1.3's public parseBolt11Invoice method sends `{ invoiceStr }`, while
 * its Wasm RPC accepts `{ invoice }`. Keep this narrow compatibility shim in
 * the adapter rather than patching node_modules.
 */
class FedimintWebWalletDirector extends WalletDirector {
  /**
   * SDK 0.1.3 exposes the constructor only from its pinned testing entrypoint,
   * while production `createWallet()` always binds services to the default
   * client. Isolate that packaging gap here until the public director accepts
   * a client name.
   */
  async createNamedWallet(name: ClientName): Promise<FedimintWallet> {
    await this.initialize();
    return new ClientScopedFedimintWallet(this._client, name);
  }

  async parseBolt11InvoicePayload(invoice: string): Promise<unknown> {
    await this.initialize();
    return this._client.sendSingleMessage('parse_bolt11_invoice', { invoice });
  }
}

function validateOperationMetadata(
  metadata: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(metadata);
  if (
    entries.length > 4 ||
    entries.some(
      ([key, value]) =>
        key.length === 0 ||
        key.length > 64 ||
        value.length === 0 ||
        value.length > 128,
    )
  ) {
    throw new WalletError('invalid_input');
  }
  return Object.freeze(Object.fromEntries(entries));
}

function gatewayDiagnosticHint(gatewayId: string): string {
  return gatewayId.length <= 12 ? gatewayId : `${gatewayId.slice(0, 12)}…`;
}

function gatewayCacheTtlStatus(
  gateway: unknown,
): 'positive' | 'zero' | 'unknown' {
  const ttl = asRecord(asRecord(gateway)?.ttl);
  const seconds = ttl?.secs;
  const nanos = ttl?.nanos;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    typeof nanos !== 'number' ||
    !Number.isSafeInteger(nanos) ||
    nanos < 0
  ) {
    return 'unknown';
  }
  return seconds > 0 || nanos > 0 ? 'positive' : 'zero';
}

interface PendingCandidate {
  candidate: FederationCandidate;
  inviteCode: string;
}

interface PendingLightningQuote {
  readonly quote: LightningQuote;
  readonly invoice: SensitiveInput;
  readonly gateway: GatewayInfo;
  readonly gatewayCacheTtl: 'positive' | 'zero' | 'unknown';
  readonly gatewayVetted: boolean;
  readonly federationId: ActiveFederation['federationId'];
}

interface LightningReceiveRoute {
  readonly federation: ActiveFederation;
  readonly wallet: FedimintWallet;
  readonly gateway: GatewayInfo;
}

interface SdkOperationSubscription {
  readonly key: OperationKey;
  readonly flow: SdkOperationFlow;
  readonly generation: number;
  active: boolean;
  cancel?: () => void;
  cancelCalled: boolean;
}

export class FedimintWalletService implements WalletService {
  readonly kind = 'fedimint' as const;

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
      requestedClientName?: ClientName,
    ): Promise<ActiveFederation> =>
      this.joinFederation(approval, signal, requestedClientName),
    reconcilePendingJoin: (
      pending: FederationDescriptor & { readonly clientName?: ClientName },
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
      quote: ConfirmedLightningQuote,
      signal?: AbortSignal,
    ): Promise<TrackedOperation> => this.payLightningInvoice(quote, signal),
    inspectPaymentRoutes: (
      amountMsats: Msats,
      signal?: AbortSignal,
    ): Promise<readonly LightningPaymentRoute[]> =>
      this.inspectLightningPaymentRoutes(amountMsats, signal),
    createInvoiceForRoute: (
      intent: LightningReceiveIntent,
      route: Pick<LightningPaymentRoute, 'federationId' | 'gatewayId'>,
      metadata: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ): Promise<LightningReceive> =>
      this.createLightningInvoiceForRoute(intent, route, metadata, signal),
    quotePaymentForRoute: (
      intent: LightningPaymentIntent,
      route: Pick<LightningPaymentRoute, 'federationId' | 'gatewayId'>,
      signal?: AbortSignal,
    ): Promise<LightningQuote> =>
      this.quoteLightningPaymentForRoute(intent, route, signal),
    payForRoute: (
      quote: ConfirmedLightningQuote,
      route: Pick<LightningPaymentRoute, 'federationId' | 'gatewayId'>,
      metadata: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ): Promise<TrackedOperation> =>
      this.payLightningInvoiceForRoute(quote, route, metadata, signal),
  };

  readonly operations = {
    list: (cursor?: OperationCursor, limit?: number): Promise<OperationPage> =>
      this.listOperations(cursor, limit),
    get: (key: OperationKey): Promise<WalletOperation | undefined> =>
      this.getNormalizedOperation(key),
    subscribe: (key: OperationKey, listener: OperationListener): (() => void) =>
      this.subscribeOperation(key, listener),
    reconcile: (signal?: AbortSignal): Promise<ReconciliationResult> =>
      this.reconcileOperations(signal),
  };

  readonly recovery = {
    getStatus: (): Promise<RecoveryStatus> => this.getRecoveryStatus(),
    subscribe: (listener: RecoveryListener): (() => void) =>
      this.subscribeRecovery(listener),
    waitForCompletion: (signal?: AbortSignal): Promise<RecoveryResult> =>
      this.waitForRecovery(signal),
  };

  private readonly listeners = new Set<WalletSnapshotListener>();
  private readonly candidates = new Map<string, PendingCandidate>();
  private readonly parsedEcash = new Map<
    PaymentFingerprint,
    { notes: SensitiveInput; preview: EcashPreview }
  >();
  private readonly submittedEcashRedemptions = new Set<PaymentFingerprint>();
  private readonly parsedLightningInvoices = new Map<
    PaymentFingerprint,
    {
      readonly invoice: SensitiveInput;
      readonly preview: LightningInvoicePreview;
    }
  >();
  private readonly lightningQuotes = new Map<string, PendingLightningQuote>();
  private readonly submittedLightningQuotes = new Map<
    string,
    TrackedOperation
  >();
  private readonly operationRecords = new Map<string, WalletOperation>();
  private readonly operationListeners = new Map<
    string,
    Map<symbol, OperationListener>
  >();
  private readonly operationSubscriptions = new Map<
    string,
    SdkOperationSubscription
  >();
  private readonly operationLoads = new Map<
    string,
    Promise<WalletOperation | undefined>
  >();
  private readonly internallyTrackedOperations = new Set<string>();
  private readonly recoveryListeners = new Set<RecoveryListener>();
  private director: FedimintWebWalletDirector | undefined;
  private readonly wallets = new Map<string, FedimintWallet>();
  private readonly federations = new Map<string, ActiveFederation>();
  private readonly federationBalances = new Map<string, Msats>();
  private readonly cancelBalanceSubscriptions = new Map<string, () => void>();
  private cancelRecoverySubscription: (() => void) | undefined;
  private joinInFlight:
    | {
        candidateId: string;
        promise: Promise<ActiveFederation>;
      }
    | undefined;
  private generation = 0;
  private recoveryState = recoveryStatus({ phase: 'idle', completed: 0 });
  private snapshot = this.makeSnapshot({
    lifecycle: 'closed',
    connection: 'offline',
    balanceMsats: msats(0n),
  });

  async open(input: OpenWalletInput = {}): Promise<void> {
    if (this.snapshot.lifecycle !== 'closed') {
      return;
    }

    const generation = ++this.generation;
    let cleanupWallet: FedimintWallet | undefined;
    let handedToService = false;
    this.setSnapshot({
      lifecycle: 'opening',
      connection: 'unknown',
      activeFederation: input.activeFederation,
      balanceMsats: msats(0n),
    });

    try {
      input.signal?.throwIfAborted();
      const director = new FedimintWebWalletDirector(
        new WasmWorkerTransport(),
        true,
      );
      director.setLogLevel('none');
      await director.initialize();
      input.signal?.throwIfAborted();

      const restoredFederations = [
        ...(input.federations ??
          (input.activeFederation === undefined
            ? []
            : [input.activeFederation])),
      ];
      const openedWallets = new Map<string, FedimintWallet>();
      const balances = new Map<string, Msats>();
      for (const federation of restoredFederations) {
        input.signal?.throwIfAborted();
        const wallet = await director.createNamedWallet(federation.clientName);
        cleanupWallet ??= wallet;
        const opened = await wallet.open(federation.clientName);
        if (!opened) {
          throw new WalletError('sdk_unavailable');
        }
        openedWallets.set(federation.federationId, wallet);
        balances.set(federation.federationId, await this.readBalance(wallet));
      }

      if (generation !== this.generation) {
        await cleanupWallet?.cleanup();
        return;
      }

      this.director = director;
      this.wallets.clear();
      this.federations.clear();
      this.federationBalances.clear();
      for (const federation of restoredFederations) {
        const wallet = openedWallets.get(federation.federationId);
        const balance = balances.get(federation.federationId);
        if (wallet === undefined || balance === undefined) {
          throw new WalletError('sdk_unavailable');
        }
        this.wallets.set(federation.federationId, wallet);
        this.federations.set(federation.federationId, federation);
        this.federationBalances.set(federation.federationId, balance);
      }
      const primaryFederation =
        input.activeFederation ?? restoredFederations[0];
      handedToService = true;

      this.setSnapshot({
        lifecycle: 'ready',
        connection: primaryFederation === undefined ? 'unknown' : 'online',
        activeFederation: primaryFederation,
        balanceMsats: this.combinedBalance(),
      });

      for (const federation of restoredFederations) {
        const wallet = this.wallets.get(federation.federationId);
        if (wallet !== undefined) {
          this.subscribeToBalance(federation, wallet, generation);
        }
      }
    } catch (error) {
      this.cancelAllBalanceSubscriptions();
      this.wallets.clear();
      this.federations.clear();
      this.federationBalances.clear();
      this.director = undefined;
      if (!handedToService || generation === this.generation) {
        try {
          await cleanupWallet?.cleanup();
        } catch {
          // Preserve the original initialization/open error. The next attempt
          // creates a fresh one-shot director and worker.
        }
      }

      if (generation === this.generation) {
        this.setSnapshot({
          lifecycle: 'error',
          connection: 'offline',
          activeFederation: input.activeFederation,
          balanceMsats: msats(0n),
          error: publicWalletError(
            error instanceof WalletError ? error.code : 'sdk_unavailable',
          ),
        });
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.cancelAllBalanceSubscriptions();
    this.cancelRecoverySubscription?.();
    this.cancelRecoverySubscription = undefined;
    for (const [mapKey, subscription] of [
      ...this.operationSubscriptions.entries(),
    ]) {
      this.stopSdkOperationSubscription(mapKey, subscription);
    }
    this.operationSubscriptions.clear();
    this.operationLoads.clear();
    this.internallyTrackedOperations.clear();
    this.operationListeners.clear();
    this.candidates.clear();
    this.parsedEcash.clear();
    this.parsedLightningInvoices.clear();
    this.lightningQuotes.clear();
    this.submittedLightningQuotes.clear();
    this.joinInFlight = undefined;

    const cleanupWallet = this.wallets.values().next().value;
    this.wallets.clear();
    this.federations.clear();
    this.federationBalances.clear();
    this.director = undefined;

    try {
      await cleanupWallet?.cleanup();
    } finally {
      this.setSnapshot({
        lifecycle: 'closed',
        connection: 'offline',
        balanceMsats: msats(0n),
      });
    }
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
    const director = this.requireDirector();
    const generation = this.generation;
    const words = await director.generateMnemonic();
    this.assertGeneration(generation);
    return secretMnemonic(words);
  }

  private async setMnemonic(words: readonly string[]): Promise<void> {
    const director = this.requireDirector();
    const generation = this.generation;
    const normalized = [...normalizeMnemonicWords(words)];
    const success = await director.setMnemonic(normalized);
    this.assertGeneration(generation);
    if (!success) {
      throw new WalletError('sdk_unavailable');
    }
  }

  private async revealMnemonic(): Promise<SecretMnemonic> {
    const director = this.requireDirector();
    const generation = this.generation;
    const words = await director.getMnemonic();
    this.assertGeneration(generation);
    return secretMnemonic(words);
  }

  private async getCapabilities(
    signal?: AbortSignal,
  ): Promise<FederationCapabilities> {
    if (this.federations.size === 0) {
      throw new WalletError('wallet_locked');
    }

    const primaryFederation = this.requireActiveFederation();
    const generation = this.generation;
    signal?.throwIfAborted();
    const entries = await Promise.all(
      [...this.federations.values()].map(async (federation) => {
        const wallet = this.wallets.get(federation.federationId);
        if (wallet === undefined) {
          throw new WalletError('sdk_unavailable');
        }
        return {
          federationId: federation.federationId,
          capabilities: await this.readCapabilities(federation, wallet),
        };
      }),
    );
    signal?.throwIfAborted();
    this.assertGeneration(generation);
    const primaryCapabilities = entries.find(
      (entry) => entry.federationId === primaryFederation.federationId,
    )?.capabilities;
    if (primaryCapabilities === undefined) {
      throw new WalletError('sdk_unavailable');
    }
    const capabilities = entries.map((entry) => entry.capabilities);
    const combined: FederationCapabilities = Object.freeze({
      mint: primaryCapabilities.mint,
      lightning: capabilities.some((entry) => entry.lightning),
      onchain: primaryCapabilities.onchain,
      gatewayAvailable: capabilities.some((entry) => entry.gatewayAvailable),
      recovery: 'unknown',
      lightningSend: capabilities.some(
        (entry) => entry.lightningSend === 'enabled',
      )
        ? 'enabled'
        : capabilities.some(
              (entry) =>
                entry.lightningSend === 'disabled_fee_quote_unavailable',
            )
          ? 'disabled_fee_quote_unavailable'
          : capabilities.some(
                (entry) =>
                  entry.lightningSend === 'disabled_gateway_unavailable',
              )
            ? 'disabled_gateway_unavailable'
            : 'unsupported',
    });
    this.setSnapshot({ ...this.snapshot, capabilities: combined });
    return combined;
  }

  private async readCapabilities(
    federation: ActiveFederation,
    wallet: FedimintWallet,
  ): Promise<FederationCapabilities> {
    const lightning = federation.modules.includes('ln');
    let gatewayAvailable = false;
    let feeQuoteAvailable = false;
    if (lightning) {
      try {
        await wallet.lightning.updateGatewayCache();
        const gateways = await wallet.lightning.listGateways();
        gatewayAvailable = gateways.some(
          (gateway) =>
            typeof gateway?.info?.gateway_id === 'string' &&
            gateway.info.gateway_id.length > 0,
        );
        feeQuoteAvailable = gateways.some(
          (gateway) => parseGatewayFeePolicy(gateway?.info?.fees) !== undefined,
        );
      } catch {
        gatewayAvailable = false;
      }
    }
    return Object.freeze({
      mint: federation.modules.includes('mint'),
      lightning,
      onchain: federation.modules.includes('wallet'),
      gatewayAvailable,
      recovery: 'unknown',
      lightningSend: !lightning
        ? 'unsupported'
        : !gatewayAvailable
          ? 'disabled_gateway_unavailable'
          : feeQuoteAvailable
            ? 'enabled'
            : 'disabled_fee_quote_unavailable',
    });
  }

  private async parseEcash(
    notes: SensitiveInput,
    signal?: AbortSignal,
  ): Promise<EcashPreview> {
    const wallet = this.requireWallet();
    const federation = this.requireActiveFederation();
    const generation = this.generation;
    signal?.throwIfAborted();

    try {
      const amount = await wallet.mint.parseNotes(notes);
      signal?.throwIfAborted();
      this.assertGeneration(generation);
      const amountMsats = checkedSdkMsats(amount);
      if (amountMsats === 0n) {
        throw new WalletError('invalid_ecash');
      }
      const fingerprint = await fingerprintSensitiveInput(notes);
      const preview: EcashPreview = Object.freeze({
        fingerprint,
        amountMsats,
        federationId: federation.federationId,
        compatible: true,
      });
      this.parsedEcash.set(fingerprint, { notes, preview });
      return preview;
    } catch (error) {
      if (error instanceof DOMException || error instanceof WalletError) {
        throw error;
      }
      throw new WalletError('invalid_ecash');
    }
  }

  private async redeemEcash(
    intent: ConfirmedEcashRedeem,
    signal?: AbortSignal,
  ): Promise<TrackedOperation> {
    const wallet = this.requireWallet();
    const federation = this.requireActiveFederation();
    const parsed = this.parsedEcash.get(intent.preview.fingerprint);
    if (parsed === undefined) {
      throw new WalletError('invalid_ecash');
    }
    if (!intent.preview.compatible) {
      throw new WalletError('ecash_wrong_federation');
    }
    if (this.submittedEcashRedemptions.has(intent.preview.fingerprint)) {
      throw new WalletError('ecash_already_redeemed');
    }

    const generation = this.generation;
    signal?.throwIfAborted();
    this.submittedEcashRedemptions.add(intent.preview.fingerprint);
    let sdkOperationId: string;
    try {
      sdkOperationId = await wallet.mint.redeemEcash(parsed.notes);
    } catch {
      this.submittedEcashRedemptions.delete(intent.preview.fingerprint);
      throw new WalletError('operation_failed');
    }
    this.assertGeneration(generation);
    this.parsedEcash.delete(intent.preview.fingerprint);
    const operation = this.recordOperation({
      federationId: federation.federationId,
      sdkOperationId,
      kind: 'ecash_receive',
      direction: 'incoming',
      amountMsats: intent.preview.amountMsats,
      status: 'created',
    });
    this.trackSdkOperation(wallet, operation, generation);
    return trackedOperation(operation);
  }

  private async createEcashSpend(
    confirmed: ConfirmedEcashSpend,
    signal?: AbortSignal,
  ): Promise<EcashExport> {
    const wallet = this.requireWallet();
    const federation = this.requireActiveFederation();
    if (confirmed.intent.amountMsats === 0n) {
      throw new WalletError('invalid_input');
    }
    if (confirmed.intent.amountMsats > this.snapshot.balanceMsats) {
      throw new WalletError('insufficient_balance');
    }

    const generation = this.generation;
    signal?.throwIfAborted();
    const amount = checkedMsatsToSdkNumber(confirmed.intent.amountMsats);
    const cancellationWindow =
      confirmed.intent.cancellationWindowSeconds ?? 86_400;
    let response: { notes: string; operation_id: string };
    try {
      response = await wallet.mint.spendNotes(
        amount,
        cancellationWindow,
        confirmed.intent.includeFederationInvite,
        {},
      );
    } catch {
      throw new WalletError('operation_failed');
    }
    this.assertGeneration(generation);

    if (
      typeof response.notes !== 'string' ||
      response.notes.length === 0 ||
      typeof response.operation_id !== 'string' ||
      response.operation_id.length === 0
    ) {
      throw new WalletError('sdk_unavailable');
    }

    const recordRef = secretRecordRef(
      `secret:ecash-export:${response.operation_id}`,
    );
    const operation = this.recordOperation({
      federationId: federation.federationId,
      sdkOperationId: response.operation_id,
      kind: 'ecash_send',
      direction: 'outgoing',
      amountMsats: confirmed.intent.amountMsats,
      status: 'created',
      secretRecordRef: recordRef,
    });
    this.trackSdkOperation(wallet, operation, generation);

    return Object.freeze({
      operation,
      notes: clearableSecretText(response.notes),
      secretRecordRef: recordRef,
    });
  }

  private async cancelEcashSpend(
    id: OperationKey['operationId'],
    signal?: AbortSignal,
  ): Promise<void> {
    const wallet = this.requireWallet();
    const generation = this.generation;
    signal?.throwIfAborted();
    try {
      await wallet.mint.tryCancelSpendNotes(id);
    } catch {
      throw new WalletError('operation_failed');
    }
    this.assertGeneration(generation);
  }

  private async parseLightningInvoice(
    invoice: SensitiveInput,
    signal?: AbortSignal,
  ): Promise<LightningInvoicePreview> {
    const director = this.requireDirector();
    const federation = this.requireActiveFederation();
    const generation = this.generation;
    const normalizedInvoice = invoice.trim() as SensitiveInput;
    if (normalizedInvoice.length < 20) {
      throw new WalletError('invalid_input');
    }
    const invoiceHeader = parseBolt11Header(normalizedInvoice);
    signal?.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = await director.parseBolt11InvoicePayload(normalizedInvoice);
    } catch {
      if (import.meta.env.DEV) {
        console.info('Fedimint Lightning invoice diagnostics', {
          stage: 'sdk_parse_failed',
          invoiceNetwork: invoiceHeader?.network ?? 'unknown',
        });
      }
      throw new WalletError('invalid_input');
    }
    signal?.throwIfAborted();
    this.assertGeneration(generation);

    const parsedRecord = asRecord(parsed);
    const amountSats = parsedRecord?.amount;
    const expirySeconds = parsedRecord?.expiry;
    const memo = parsedRecord?.memo;
    if (
      invoiceHeader === undefined ||
      !Number.isSafeInteger(expirySeconds) ||
      Number(expirySeconds) < 0
    ) {
      if (import.meta.env.DEV) {
        console.info('Fedimint Lightning invoice diagnostics', {
          stage: 'invalid_sdk_parse_response',
          invoiceNetwork: invoiceHeader?.network ?? 'unknown',
          sdkResponse: describeBolt11ParseResponse(parsed),
        });
      }
      throw new WalletError('invalid_input');
    }
    if (
      !isInvoiceNetworkCompatible(invoiceHeader.network, federation.network)
    ) {
      throw new WalletError('invoice_wrong_network');
    }

    let amountMsats: Msats | undefined;
    if (typeof amountSats === 'number' && amountSats > 0) {
      const rawMsats = amountSats * 1000;
      if (!Number.isSafeInteger(rawMsats)) {
        throw new WalletError('invalid_input');
      }
      amountMsats = msats(BigInt(rawMsats));
    }
    const expiresAtMs =
      (invoiceHeader.timestampSeconds + Number(expirySeconds)) * 1000;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new WalletError('invoice_expired');
    }

    const fingerprint = await fingerprintSensitiveInput(normalizedInvoice);
    const preview: LightningInvoicePreview = Object.freeze({
      fingerprint,
      network: federation.network,
      ...(amountMsats === undefined ? {} : { amountMsats }),
      expiresAtMs,
      ...(typeof memo !== 'string' || memo.trim().length === 0
        ? {}
        : { description: memo.trim() }),
    });
    this.parsedLightningInvoices.set(fingerprint, {
      invoice: normalizedInvoice,
      preview,
    });
    return preview;
  }

  private async createLightningInvoice(
    intent: LightningReceiveIntent,
    signal?: AbortSignal,
  ): Promise<LightningReceive> {
    if (
      intent.amountMsats === 0n ||
      !Number.isSafeInteger(intent.expirySeconds) ||
      intent.expirySeconds < 60
    ) {
      throw new WalletError('invalid_input');
    }

    const generation = this.generation;
    signal?.throwIfAborted();
    const route = await this.selectLightningReceiveRoute(
      intent.amountMsats,
      signal,
      generation,
    );
    signal?.throwIfAborted();
    return this.createLightningInvoiceOnRoute(
      intent,
      route,
      {},
      signal,
      generation,
    );
  }

  private async createLightningInvoiceForRoute(
    intent: LightningReceiveIntent,
    routeRef: Pick<LightningPaymentRoute, 'federationId' | 'gatewayId'>,
    metadata: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<LightningReceive> {
    if (
      intent.amountMsats === 0n ||
      !Number.isSafeInteger(intent.expirySeconds) ||
      intent.expirySeconds < 60
    ) {
      throw new WalletError('invalid_input');
    }
    const safeMetadata = validateOperationMetadata(metadata);
    const generation = this.generation;
    const route = await this.resolveLightningReceiveRoute(
      routeRef,
      signal,
      generation,
    );
    return this.createLightningInvoiceOnRoute(
      intent,
      route,
      safeMetadata,
      signal,
      generation,
    );
  }

  private async createLightningInvoiceOnRoute(
    intent: LightningReceiveIntent,
    route: LightningReceiveRoute,
    metadata: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<LightningReceive> {
    let response: { operation_id: string; invoice: string };
    try {
      response = await route.wallet.lightning.createInvoice(
        checkedMsatsToSdkNumber(intent.amountMsats),
        intent.description ?? '',
        intent.expirySeconds,
        route.gateway,
        { ...metadata },
      );
    } catch {
      signal?.throwIfAborted();
      this.assertGeneration(generation);
      throw new WalletError('operation_failed');
    }
    this.assertGeneration(generation);
    if (
      typeof response.operation_id !== 'string' ||
      response.operation_id.length === 0 ||
      typeof response.invoice !== 'string' ||
      response.invoice.length === 0
    ) {
      throw new WalletError('sdk_unavailable');
    }

    const expiresAtMs = Date.now() + intent.expirySeconds * 1000;
    const recordRef = secretRecordRef(
      `secret:lightning-invoice:${response.operation_id}`,
    );
    const operation = this.recordOperation({
      federationId: route.federation.federationId,
      sdkOperationId: response.operation_id,
      kind: 'lightning_receive',
      direction: 'incoming',
      amountMsats: intent.amountMsats,
      status: 'awaiting_external_payment',
      expiresAtMs,
      secretRecordRef: recordRef,
      localDescription: intent.description,
    });
    this.trackSdkOperation(route.wallet, operation, generation);

    return Object.freeze({
      operation,
      invoice: clearableSecretText(response.invoice),
      expiresAtMs,
      secretRecordRef: recordRef,
    });
  }

  private async resolveLightningReceiveRoute(
    routeRef: Pick<LightningPaymentRoute, 'federationId' | 'gatewayId'>,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<LightningReceiveRoute> {
    const federation = this.federations.get(routeRef.federationId);
    const wallet = this.wallets.get(routeRef.federationId);
    if (
      federation === undefined ||
      wallet === undefined ||
      !federation.modules.includes('ln')
    ) {
      throw new WalletError('gateway_unavailable');
    }

    try {
      await wallet.lightning.updateGatewayCache();
      signal?.throwIfAborted();
      this.assertGeneration(generation);
      const gateways = await wallet.lightning.listGateways();
      const gatewayRegistration = gateways.find(
        (candidate) => candidate?.info?.gateway_id === routeRef.gatewayId,
      );
      const gateway = gatewayRegistration?.info;
      if (gateway === undefined) {
        throw new WalletError('gateway_unavailable');
      }
      if (import.meta.env.DEV) {
        console.info('Fedimint Lightning receive route diagnostics', {
          event: 'receive_route_selected',
          selectionMode: 'exact-route',
          gatewayHint: gatewayDiagnosticHint(gateway.gateway_id),
          gatewayVetted: gatewayRegistration?.vetted === true,
          gatewayCacheTtl: gatewayCacheTtlStatus(gatewayRegistration),
        });
      }
      return Object.freeze({ federation, wallet, gateway });
    } catch (error) {
      signal?.throwIfAborted();
      this.assertGeneration(generation);
      if (error instanceof WalletError) {
        throw error;
      }
      throw new WalletError('gateway_unavailable');
    }
  }

  private async selectLightningReceiveRoute(
    amountMsats: Msats,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<LightningReceiveRoute> {
    const primaryFederation = this.requireActiveFederation();
    const available = await Promise.all(
      [...this.federations.values()].map(async (federation) => {
        signal?.throwIfAborted();
        const wallet = this.wallets.get(federation.federationId);
        if (wallet === undefined) {
          throw new WalletError('sdk_unavailable');
        }
        const balanceMsats = await this.readBalance(wallet);
        return Object.freeze({ federation, wallet, balanceMsats });
      }),
    );

    signal?.throwIfAborted();
    this.assertGeneration(generation);
    for (const entry of available) {
      this.federationBalances.set(
        entry.federation.federationId,
        entry.balanceMsats,
      );
    }
    this.setSnapshot({ balanceMsats: this.combinedBalance() });

    const receivable = available.filter((entry) =>
      entry.federation.modules.includes('ln'),
    );
    const selectedFederationId = selectLightningReceiveFederationId(
      receivable.map((entry) => ({
        federationId: entry.federation.federationId,
        balanceMsats: entry.balanceMsats,
      })),
      primaryFederation.federationId,
      amountMsats,
      this.combinedBalance(),
    );
    const selected = receivable.find(
      (entry) => entry.federation.federationId === selectedFederationId,
    );
    if (selected === undefined) {
      throw new WalletError('gateway_unavailable');
    }

    try {
      await selected.wallet.lightning.updateGatewayCache();
      signal?.throwIfAborted();
      this.assertGeneration(generation);
      const gateways = await selected.wallet.lightning.listGateways();
      const usableGateways = gateways.filter(
        (candidate) =>
          typeof candidate?.info?.gateway_id === 'string' &&
          candidate.info.gateway_id.length > 0,
      );
      const selectedGateway =
        usableGateways.find((candidate) => candidate.vetted) ??
        usableGateways[0];
      const gateway = selectedGateway?.info;
      if (gateway === undefined) {
        throw new WalletError('gateway_unavailable');
      }
      signal?.throwIfAborted();
      this.assertGeneration(generation);
      if (import.meta.env.DEV) {
        console.info('Fedimint Lightning receive route diagnostics', {
          event: 'receive_route_selected',
          selectionMode: 'balance-router',
          gatewayHint: gatewayDiagnosticHint(gateway.gateway_id),
          gatewayVetted: selectedGateway?.vetted === true,
          gatewayCacheTtl: gatewayCacheTtlStatus(selectedGateway),
        });
      }
      return Object.freeze({
        federation: selected.federation,
        wallet: selected.wallet,
        gateway,
      });
    } catch (error) {
      signal?.throwIfAborted();
      this.assertGeneration(generation);
      if (error instanceof WalletError) {
        throw error;
      }
      throw new WalletError('gateway_unavailable');
    }
  }

  private async inspectLightningPaymentRoutes(
    amountMsats: Msats,
    signal?: AbortSignal,
  ): Promise<readonly LightningPaymentRoute[]> {
    if (amountMsats <= 0n) {
      throw new WalletError('invalid_input');
    }
    this.requireActiveFederation();
    const generation = this.generation;
    const inspected = await Promise.all(
      [...this.federations.values()].map(async (federation) => {
        signal?.throwIfAborted();
        if (!federation.modules.includes('ln')) {
          return undefined;
        }
        const wallet = this.wallets.get(federation.federationId);
        if (wallet === undefined) {
          return undefined;
        }
        try {
          const balanceMsats = await this.readBalance(wallet);
          await wallet.lightning.updateGatewayCache();
          signal?.throwIfAborted();
          this.assertGeneration(generation);
          const gateways = await wallet.lightning.listGateways();
          return {
            federation,
            balanceMsats,
            routes: gateways
              .map((gateway) => {
                const info = gateway?.info;
                const feeMsats = quoteGatewayFee(info, amountMsats);
                if (info === undefined || feeMsats === undefined) {
                  return undefined;
                }
                return Object.freeze({
                  federationId: federation.federationId,
                  federationDisplayName: federation.displayName,
                  gatewayId: info.gateway_id,
                  balanceMsats,
                  feeMsats,
                  vetted: gateway.vetted === true,
                });
              })
              .filter((route) => route !== undefined),
          };
        } catch {
          return undefined;
        }
      }),
    );
    signal?.throwIfAborted();
    this.assertGeneration(generation);

    for (const entry of inspected) {
      if (entry !== undefined) {
        this.federationBalances.set(
          entry.federation.federationId,
          entry.balanceMsats,
        );
      }
    }
    this.setSnapshot({ balanceMsats: this.combinedBalance() });

    const routes = inspected
      .flatMap((entry) => entry?.routes ?? [])
      .sort(
        (left, right) =>
          Number(right.vetted) - Number(left.vetted) ||
          (left.feeMsats < right.feeMsats
            ? -1
            : left.feeMsats > right.feeMsats
              ? 1
              : left.federationId.localeCompare(right.federationId) ||
                left.gatewayId.localeCompare(right.gatewayId)),
      );
    if (routes.length === 0) {
      throw new WalletError('fee_quote_unavailable');
    }
    return Object.freeze(routes);
  }

  private async quoteLightningPayment(
    intent: LightningPaymentIntent,
    signal?: AbortSignal,
  ): Promise<LightningQuote> {
    const primaryFederation = this.requireActiveFederation();
    const parsed = this.parsedLightningInvoices.get(intent.preview.fingerprint);
    if (
      parsed === undefined ||
      parsed.preview.amountMsats === undefined ||
      parsed.preview.amountMsats !== intent.preview.amountMsats ||
      parsed.preview.expiresAtMs <= Date.now() ||
      !isInvoiceNetworkCompatible(
        intent.preview.network,
        primaryFederation.network,
      )
    ) {
      throw new WalletError('invalid_input');
    }
    if (intent.maximumFeeMsats < 0n) {
      throw new WalletError('invalid_input');
    }
    const generation = this.generation;
    signal?.throwIfAborted();
    const quotedCandidates = (
      await Promise.all(
        [...this.federations.values()].map(async (federation) => {
          signal?.throwIfAborted();
          if (!federation.modules.includes('ln')) {
            return [];
          }
          const wallet = this.wallets.get(federation.federationId);
          if (wallet === undefined) {
            return [];
          }
          try {
            await wallet.lightning.updateGatewayCache();
            const gateways = await wallet.lightning.listGateways();
            return gateways
              .map((gateway) => {
                const info = gateway?.info;
                const feeMsats = quoteGatewayFee(
                  info,
                  intent.preview.amountMsats!,
                );
                if (info === undefined || feeMsats === undefined) {
                  return undefined;
                }
                const balance =
                  this.federationBalances.get(federation.federationId) ?? 0n;
                return {
                  federation,
                  info,
                  feeMsats,
                  balance,
                  vetted: gateway.vetted === true,
                  gatewayCacheTtl: gatewayCacheTtlStatus(gateway),
                };
              })
              .filter((candidate) => candidate !== undefined);
          } catch {
            return [];
          }
        }),
      )
    ).flat();
    signal?.throwIfAborted();
    this.assertGeneration(generation);
    if (quotedCandidates.length === 0) {
      throw new WalletError('fee_quote_unavailable');
    }
    const withinFeeLimit = quotedCandidates.filter(
      (candidate) => candidate.feeMsats <= intent.maximumFeeMsats,
    );
    if (withinFeeLimit.length === 0) {
      throw new WalletError('fee_limit_exceeded');
    }
    const candidates = withinFeeLimit
      .filter(
        (candidate) =>
          candidate.balance >= intent.preview.amountMsats! + candidate.feeMsats,
      )
      .filter((candidate) => candidate !== undefined)
      .sort(
        (left, right) =>
          Number(right.vetted) - Number(left.vetted) ||
          (left.balance > right.balance
            ? -1
            : left.balance < right.balance
              ? 1
              : left.feeMsats < right.feeMsats
                ? -1
                : left.feeMsats > right.feeMsats
                  ? 1
                  : left.federation.federationId.localeCompare(
                      right.federation.federationId,
                    )),
      );
    const selected = candidates[0];
    if (selected === undefined) {
      throw new WalletError('insufficient_balance');
    }

    const quote: LightningQuote = Object.freeze({
      quoteId: quoteId(`fedimint-ln-${crypto.randomUUID()}`),
      invoiceFingerprint: intent.preview.fingerprint,
      amountMsats: intent.preview.amountMsats,
      feeMsats: selected.feeMsats,
      maximumFeeMsats: intent.maximumFeeMsats,
      expiresAtMs: Math.min(intent.preview.expiresAtMs, Date.now() + 60_000),
      federationId: selected.federation.federationId,
      gatewayId: selected.info.gateway_id,
    });
    this.lightningQuotes.set(quote.quoteId, {
      quote,
      invoice: parsed.invoice,
      gateway: selected.info,
      gatewayCacheTtl: selected.gatewayCacheTtl,
      gatewayVetted: selected.vetted,
      federationId: selected.federation.federationId,
    });
    return quote;
  }

  private async quoteLightningPaymentForRoute(
    intent: LightningPaymentIntent,
    routeRef: Pick<LightningPaymentRoute, 'federationId' | 'gatewayId'>,
    signal?: AbortSignal,
  ): Promise<LightningQuote> {
    const primaryFederation = this.requireActiveFederation();
    const parsed = this.parsedLightningInvoices.get(intent.preview.fingerprint);
    if (
      parsed === undefined ||
      parsed.preview.amountMsats === undefined ||
      parsed.preview.amountMsats !== intent.preview.amountMsats ||
      parsed.preview.expiresAtMs <= Date.now() ||
      !isInvoiceNetworkCompatible(
        intent.preview.network,
        primaryFederation.network,
      )
    ) {
      throw new WalletError('invalid_input');
    }
    if (intent.maximumFeeMsats < 0n) {
      throw new WalletError('invalid_input');
    }

    const route = (
      await this.inspectLightningPaymentRoutes(
        intent.preview.amountMsats,
        signal,
      )
    ).find(
      (candidate) =>
        candidate.federationId === routeRef.federationId &&
        candidate.gatewayId === routeRef.gatewayId,
    );
    if (route === undefined) {
      throw new WalletError('gateway_unavailable');
    }
    if (route.feeMsats > intent.maximumFeeMsats) {
      throw new WalletError('fee_limit_exceeded');
    }

    const wallet = this.wallets.get(route.federationId);
    if (wallet === undefined) {
      throw new WalletError('federation_unavailable');
    }
    await wallet.lightning.updateGatewayCache();
    const gatewayRegistration = (await wallet.lightning.listGateways()).find(
      (candidate) => candidate?.info?.gateway_id === route.gatewayId,
    );
    const gateway = gatewayRegistration?.info;
    if (gateway === undefined) {
      throw new WalletError('gateway_unavailable');
    }
    const freshFeeMsats = quoteGatewayFee(gateway, intent.preview.amountMsats);
    if (freshFeeMsats === undefined) {
      throw new WalletError('fee_quote_unavailable');
    }
    if (freshFeeMsats > intent.maximumFeeMsats) {
      throw new WalletError('fee_limit_exceeded');
    }

    const quote: LightningQuote = Object.freeze({
      quoteId: quoteId(`fedimint-ln-${crypto.randomUUID()}`),
      invoiceFingerprint: intent.preview.fingerprint,
      amountMsats: intent.preview.amountMsats,
      feeMsats: freshFeeMsats,
      maximumFeeMsats: intent.maximumFeeMsats,
      expiresAtMs: Math.min(intent.preview.expiresAtMs, Date.now() + 60_000),
      federationId: route.federationId,
      gatewayId: route.gatewayId,
    });
    this.lightningQuotes.set(quote.quoteId, {
      quote,
      invoice: parsed.invoice,
      gateway,
      gatewayCacheTtl: gatewayCacheTtlStatus(gatewayRegistration),
      gatewayVetted: gatewayRegistration?.vetted === true,
      federationId: route.federationId,
    });
    return quote;
  }

  private async payLightningInvoice(
    confirmed: ConfirmedLightningQuote,
    signal?: AbortSignal,
    expectedRoute?: Pick<LightningPaymentRoute, 'federationId' | 'gatewayId'>,
    metadata: Readonly<Record<string, string>> = {},
  ): Promise<TrackedOperation> {
    const duplicate = this.submittedLightningQuotes.get(
      confirmed.quote.quoteId,
    );
    if (duplicate !== undefined) {
      return duplicate;
    }
    const pending = this.lightningQuotes.get(confirmed.quote.quoteId);
    if (
      pending === undefined ||
      pending.quote.invoiceFingerprint !== confirmed.quote.invoiceFingerprint ||
      pending.quote.expiresAtMs <= Date.now() ||
      pending.quote.feeMsats > confirmed.quote.maximumFeeMsats ||
      (expectedRoute !== undefined &&
        (pending.federationId !== expectedRoute.federationId ||
          pending.gateway.gateway_id !== expectedRoute.gatewayId))
    ) {
      throw new WalletError('fee_quote_unavailable');
    }
    const wallet = this.wallets.get(pending.federationId);
    const federation = this.federations.get(pending.federationId);
    if (wallet === undefined || federation === undefined) {
      throw new WalletError('operation_reconciliation_required');
    }
    signal?.throwIfAborted();
    const generation = this.generation;
    let response;
    try {
      response = await wallet.lightning.payInvoice(
        pending.invoice,
        pending.gateway,
        { ...metadata },
      );
    } catch (error) {
      if (import.meta.env.DEV) {
        console.info('Fedimint Lightning payment diagnostics', {
          event: 'pay_invoice_rejected',
          paymentStep:
            metadata.chascuro_step === 'rebalance-send'
              ? 'rebalance-send'
              : metadata.chascuro_step === 'merchant-send'
                ? 'merchant-send'
                : 'standard',
          gatewayHint: gatewayDiagnosticHint(pending.gateway.gateway_id),
          gatewayVetted: pending.gatewayVetted,
          gatewayCacheTtl: pending.gatewayCacheTtl,
          errorCategory: classifyLightningPaySubmissionError(error),
        });
      }
      throw new WalletError('operation_failed');
    }
    this.assertGeneration(generation);
    const feeMsats = checkedSdkMsats(response.fee);
    const paymentType = asRecord(response.payment_type);
    const externalId = paymentType?.lightning;
    const internalId = paymentType?.internal;
    const sdkOperationId =
      typeof externalId === 'string' && externalId.length > 0
        ? externalId
        : typeof internalId === 'string' && internalId.length > 0
          ? internalId
          : undefined;
    if (sdkOperationId === undefined) {
      throw new WalletError('operation_reconciliation_required');
    }

    const operation = this.recordOperation({
      federationId: federation.federationId,
      sdkOperationId,
      kind: 'lightning_send',
      direction: 'outgoing',
      amountMsats: confirmed.quote.amountMsats,
      feeMsats,
      status: 'pending',
      reconciliationCursor:
        typeof internalId === 'string'
          ? 'lightning:internal'
          : 'lightning:external',
    });
    this.trackSdkOperation(wallet, operation, generation);
    const tracked = trackedOperation(operation);
    this.submittedLightningQuotes.set(confirmed.quote.quoteId, tracked);
    this.lightningQuotes.delete(confirmed.quote.quoteId);
    if (feeMsats > confirmed.quote.maximumFeeMsats) {
      throw new WalletError('fee_limit_exceeded');
    }
    return tracked;
  }

  private payLightningInvoiceForRoute(
    confirmed: ConfirmedLightningQuote,
    route: Pick<LightningPaymentRoute, 'federationId' | 'gatewayId'>,
    metadata: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<TrackedOperation> {
    const safeMetadata = validateOperationMetadata(metadata);
    return this.payLightningInvoice(confirmed, signal, route, safeMetadata);
  }

  async previewFederation(
    inviteCode: string,
    signal?: AbortSignal,
  ): Promise<FederationCandidate> {
    const director = this.requireDirector();
    const generation = this.generation;
    const normalizedInvite = inviteCode.trim();

    if (normalizedInvite.length < 8) {
      throw new WalletError('invalid_invite_code');
    }

    signal?.throwIfAborted();
    const preview = await director.previewFederation(normalizedInvite);
    signal?.throwIfAborted();
    if (generation !== this.generation) {
      throw new DOMException('Request aborted.', 'AbortError');
    }

    if (import.meta.env.DEV) {
      // Do not log the invite or raw configuration. This is intentionally
      // limited to schema and recognized-network evidence for local adapter
      // compatibility work.
      console.info(
        'Fedimint federation network diagnostics',
        describeFederationNetworkDiagnostics(preview.config),
      );
    }

    const candidate = sanitizeFederationPreview(
      preview,
      crypto.randomUUID(),
      Date.now() + 5 * 60 * 1000,
    );
    this.candidates.clear();
    this.candidates.set(candidate.candidateId, {
      candidate,
      inviteCode: normalizedInvite,
    });
    return candidate;
  }

  async joinFederation(
    approval: FederationJoinApproval,
    signal?: AbortSignal,
    requestedClientName?: ClientName,
  ): Promise<ActiveFederation> {
    if (this.joinInFlight?.candidateId === approval.candidateId) {
      return this.joinInFlight.promise;
    }

    if (this.joinInFlight !== undefined) {
      throw new WalletError('wallet_busy');
    }

    const pending = this.candidates.get(approval.candidateId);

    if (
      pending === undefined ||
      !isJoinApprovalValid(approval, pending.candidate, Date.now())
    ) {
      throw new WalletError('candidate_expired');
    }

    const name =
      requestedClientName ??
      clientName(
        this.federations.size === 0
          ? SDK_DEFAULT_CLIENT_NAME
          : crypto.randomUUID(),
      );
    const promise = this.performJoin(pending, name, signal);
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
    name: ClientName,
    signal?: AbortSignal,
  ): Promise<ActiveFederation> {
    const generation = this.generation;
    const director = this.requireDirector();
    this.setSnapshot({
      ...this.snapshot,
      lifecycle: 'joining',
      error: undefined,
    });

    try {
      signal?.throwIfAborted();
      const wallet = await director.createNamedWallet(name);
      const joined = await wallet.joinFederation(pending.inviteCode, name);
      if (generation !== this.generation) {
        throw new DOMException('Request aborted.', 'AbortError');
      }

      if (!joined) {
        throw new WalletError('federation_unavailable');
      }

      const activeFederation: ActiveFederation = Object.freeze({
        federationId: pending.candidate.federationId,
        displayName: pending.candidate.displayName,
        network: pending.candidate.network,
        modules: pending.candidate.modules,
        guardianCount: pending.candidate.guardianCount,
        clientName: name,
        joinedAtMs: Date.now(),
      });
      this.candidates.clear();
      this.wallets.set(activeFederation.federationId, wallet);
      this.federations.set(activeFederation.federationId, activeFederation);
      this.federationBalances.set(activeFederation.federationId, msats(0n));
      this.setSnapshot({
        lifecycle: 'ready',
        connection: 'unknown',
        activeFederation: this.snapshot.activeFederation ?? activeFederation,
        balanceMsats: this.combinedBalance(),
      });
      const balanceMsats = await this.readBalance(wallet);
      if (generation !== this.generation) {
        throw new DOMException('Request aborted.', 'AbortError');
      }

      this.setSnapshot({
        lifecycle: 'ready',
        connection: 'online',
        activeFederation: this.snapshot.activeFederation ?? activeFederation,
        balanceMsats: this.combinedBalance(),
      });
      this.federationBalances.set(activeFederation.federationId, balanceMsats);
      this.setSnapshot({ balanceMsats: this.combinedBalance() });
      this.subscribeToBalance(activeFederation, wallet, generation);
      return activeFederation;
    } catch (error) {
      if (generation === this.generation) {
        this.setSnapshot({
          ...this.snapshot,
          lifecycle: 'ready',
          error: publicWalletError(
            error instanceof WalletError ? error.code : 'operation_failed',
          ),
        });
      }
      throw error;
    }
  }

  private async reconcilePendingJoin(
    pending: FederationDescriptor & { readonly clientName?: ClientName },
    signal?: AbortSignal,
  ): Promise<ActiveFederation | undefined> {
    const name =
      pending.clientName ??
      clientName(
        this.federations.size === 0
          ? SDK_DEFAULT_CLIENT_NAME
          : crypto.randomUUID(),
      );
    const wallet = await this.requireDirector().createNamedWallet(name);
    const generation = this.generation;
    signal?.throwIfAborted();
    let opened: boolean;
    try {
      opened = await wallet.open(name);
    } catch {
      throw new WalletError('operation_reconciliation_required');
    }
    if (!opened) {
      throw new WalletError('operation_reconciliation_required');
    }
    signal?.throwIfAborted();
    this.assertGeneration(generation);

    let actualFederationId: string;
    try {
      actualFederationId = await wallet.federation.getFederationId();
    } catch {
      throw new WalletError('operation_reconciliation_required');
    }
    this.assertGeneration(generation);
    if (actualFederationId !== pending.federationId) {
      throw new WalletError('operation_reconciliation_required');
    }

    const activeFederation: ActiveFederation = Object.freeze({
      ...pending,
      clientName: name,
      joinedAtMs: Date.now(),
    });
    this.wallets.set(activeFederation.federationId, wallet);
    this.federations.set(activeFederation.federationId, activeFederation);
    this.federationBalances.set(activeFederation.federationId, msats(0n));
    this.setSnapshot({
      lifecycle: 'ready',
      connection: 'unknown',
      activeFederation: this.snapshot.activeFederation ?? activeFederation,
      balanceMsats: this.combinedBalance(),
      error: undefined,
    });
    const balanceMsats = await this.readBalance(wallet);
    this.assertGeneration(generation);
    this.setSnapshot({
      lifecycle: 'ready',
      connection: 'online',
      activeFederation: this.snapshot.activeFederation ?? activeFederation,
      balanceMsats: this.combinedBalance(),
      error: undefined,
    });
    this.federationBalances.set(activeFederation.federationId, balanceMsats);
    this.setSnapshot({ balanceMsats: this.combinedBalance() });
    this.subscribeToBalance(activeFederation, wallet, generation);
    return activeFederation;
  }

  async refreshBalance(signal?: AbortSignal): Promise<void> {
    const generation = this.generation;

    if (this.federations.size === 0) {
      throw new WalletError('wallet_locked');
    }

    signal?.throwIfAborted();
    const balances = await Promise.all(
      [...this.federations.values()].map(async (federation) => {
        const wallet = this.wallets.get(federation.federationId);
        if (wallet === undefined) {
          throw new WalletError('sdk_unavailable');
        }
        return {
          federationId: federation.federationId,
          balance: await this.readBalance(wallet),
        };
      }),
    );
    signal?.throwIfAborted();
    if (generation !== this.generation) {
      throw new DOMException('Request aborted.', 'AbortError');
    }
    for (const entry of balances) {
      this.federationBalances.set(entry.federationId, entry.balance);
    }
    this.setSnapshot({
      ...this.snapshot,
      connection: 'online',
      balanceMsats: this.combinedBalance(),
    });
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

  private async getNormalizedOperation(
    key: OperationKey,
  ): Promise<WalletOperation | undefined> {
    const local = this.operationRecords.get(operationMapKey(key));
    if (local !== undefined) {
      return local;
    }

    return this.loadOperationFromSdk(key);
  }

  private subscribeOperation(
    key: OperationKey,
    listener: OperationListener,
  ): () => void {
    const mapKey = operationMapKey(key);
    const lease = Symbol('operation-listener');
    const listeners =
      this.operationListeners.get(mapKey) ??
      new Map<symbol, OperationListener>();
    listeners.set(lease, listener);
    this.operationListeners.set(mapKey, listeners);
    const current = this.operationRecords.get(mapKey);
    if (current !== undefined) {
      listener(current);
      this.ensureSdkOperationSubscription(current);
    } else {
      void this.loadOperationFromSdk(key)
        .then((operation) => {
          if (
            operation === undefined ||
            this.operationListeners.get(mapKey)?.has(lease) !== true
          ) {
            return;
          }
          listener(operation);
          this.ensureSdkOperationSubscription(operation);
        })
        .catch(() => {
          // Reconciliation or a later reconnect can retry this lookup.
        });
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      listeners.delete(lease);
      if (listeners.size === 0) {
        this.operationListeners.delete(mapKey);
      }
      this.syncSdkOperationSubscriptionDemand(key);
    };
  }

  private loadOperationFromSdk(
    key: OperationKey,
  ): Promise<WalletOperation | undefined> {
    const mapKey = operationMapKey(key);
    const current = this.operationRecords.get(mapKey);
    if (current !== undefined) {
      return Promise.resolve(current);
    }

    const existing = this.operationLoads.get(mapKey);
    if (existing !== undefined) {
      return existing;
    }

    const work = this.fetchOperationFromSdk(key);
    const tracked = work.finally(() => {
      if (this.operationLoads.get(mapKey) === tracked) {
        this.operationLoads.delete(mapKey);
      }
    });
    this.operationLoads.set(mapKey, tracked);
    return tracked;
  }

  private async fetchOperationFromSdk(
    key: OperationKey,
  ): Promise<WalletOperation | undefined> {
    const wallet = this.wallets.get(key.federationId);
    const federation = this.federations.get(key.federationId);
    if (wallet === undefined || federation === undefined) {
      return undefined;
    }

    const generation = this.generation;
    const observedAtMs = Date.now();
    let rawEntry: unknown;
    try {
      const entries = await wallet.federation.listOperations(100);
      if (Array.isArray(entries)) {
        rawEntry = entries.find((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2) {
            return false;
          }
          return asRecord(entry[0])?.operation_id === key.operationId;
        });
      }
    } catch {
      // The exact operation lookup below is a narrower retry path.
    }

    if (rawEntry === undefined) {
      const raw = await wallet.federation.getOperation(key.operationId);
      if (raw === null) {
        return undefined;
      }
      rawEntry = [
        {
          operation_id: key.operationId,
          creation_time: {
            secs_since_epoch: Math.floor(observedAtMs / 1000),
            nanos_since_epoch: (observedAtMs % 1000) * 1_000_000,
          },
        },
        raw,
      ];
    }

    this.assertGeneration(generation);
    const normalized = sanitizeSdkOperation(
      rawEntry,
      federation.federationId,
      observedAtMs,
    );
    if (normalized === undefined) {
      return undefined;
    }

    const result = this.mergeOperation(normalized);
    if (result !== 'unchanged') {
      this.publishOperations();
    }
    return this.operationRecords.get(operationMapKey(key));
  }

  private async reconcileOperations(
    signal?: AbortSignal,
  ): Promise<ReconciliationResult> {
    const generation = this.generation;
    signal?.throwIfAborted();
    const observedAtMs = Date.now();
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let observed = 0;
    for (const federation of this.federations.values()) {
      const wallet = this.wallets.get(federation.federationId);
      if (wallet === undefined) {
        throw new WalletError('operation_reconciliation_required');
      }
      let entries: unknown;
      try {
        entries = await wallet.federation.listOperations(100);
      } catch {
        throw new WalletError('operation_reconciliation_required');
      }
      signal?.throwIfAborted();
      this.assertGeneration(generation);
      if (!Array.isArray(entries)) {
        throw new WalletError('sdk_unavailable');
      }
      observed += entries.length;
      for (const entry of entries) {
        const operation = sanitizeSdkOperation(
          entry,
          federation.federationId,
          observedAtMs,
        );
        if (operation === undefined) {
          continue;
        }
        const result = this.mergeOperation(operation);
        if (result === 'added') {
          added += 1;
        } else if (result === 'updated') {
          updated += 1;
        } else {
          unchanged += 1;
        }
      }
    }
    this.resumeSdkOperationSubscriptions();
    this.publishOperations();
    return Object.freeze({
      observed,
      added,
      updated,
      unchanged,
    });
  }

  private async getRecoveryStatus(): Promise<RecoveryStatus> {
    const wallet = this.requireWallet();
    try {
      const pending = await wallet.recovery.hasPendingRecoveries();
      this.setRecoveryState(
        pending
          ? {
              phase: 'recovering',
              completed: 0,
              messageCode: 'recovering_modules',
            }
          : {
              phase: 'idle',
              completed: 0,
            },
      );
      return this.recoveryState;
    } catch {
      throw new WalletError('recovery_failed');
    }
  }

  private subscribeRecovery(listener: RecoveryListener): () => void {
    this.recoveryListeners.add(listener);
    listener(this.recoveryState);
    this.ensureRecoverySubscription();

    return () => {
      this.recoveryListeners.delete(listener);
      if (this.recoveryListeners.size === 0) {
        this.cancelRecoverySubscription?.();
        this.cancelRecoverySubscription = undefined;
      }
    };
  }

  private ensureRecoverySubscription(): void {
    const activeFederation = this.snapshot.activeFederation;
    const wallet =
      activeFederation === undefined
        ? undefined
        : this.wallets.get(activeFederation.federationId);
    if (this.cancelRecoverySubscription !== undefined || wallet === undefined) {
      return;
    }

    const generation = this.generation;
    this.cancelRecoverySubscription =
      wallet.recovery.subscribeToRecoveryProgress(
        () => {
          if (generation !== this.generation) {
            return;
          }
          this.setRecoveryState({
            phase: 'recovering',
            completed: this.recoveryState.completed + 1,
            messageCode: 'recovering_modules',
          });
        },
        () => {
          if (generation === this.generation) {
            this.setRecoveryState({
              phase: 'failed',
              completed: this.recoveryState.completed,
              messageCode: 'failed',
            });
          }
        },
      );
  }

  private async waitForRecovery(signal?: AbortSignal): Promise<RecoveryResult> {
    const wallet = this.requireWallet();
    const generation = this.generation;
    signal?.throwIfAborted();
    this.ensureRecoverySubscription();

    try {
      const pending = await wallet.recovery.hasPendingRecoveries();
      if (pending) {
        this.setRecoveryState({
          phase: 'recovering',
          completed: this.recoveryState.completed,
          messageCode: 'recovering_modules',
        });
        await wallet.recovery.waitForAllRecoveries();
      }
    } catch {
      this.setRecoveryState({
        phase: 'failed',
        completed: this.recoveryState.completed,
        messageCode: 'failed',
      });
      throw new WalletError('recovery_failed');
    }

    signal?.throwIfAborted();
    this.assertGeneration(generation);
    this.setRecoveryState({
      phase: 'complete',
      completed: this.recoveryState.completed,
      messageCode: 'complete',
    });
    return Object.freeze({
      completedAtMs: Date.now(),
      recoveredModules: this.recoveryState.completed,
      pendingOperationsReconciled: 0,
    });
  }

  private setRecoveryState(status: RecoveryStatus): void {
    this.recoveryState = recoveryStatus(status);
    for (const listener of this.recoveryListeners) {
      listener(this.recoveryState);
    }
  }

  private recordOperation(input: {
    federationId: ActiveFederation['federationId'];
    sdkOperationId: string;
    kind: WalletOperation['kind'];
    direction: NonNullable<WalletOperation['direction']>;
    amountMsats?: Msats;
    feeMsats?: Msats;
    status: OperationStatus;
    expiresAtMs?: number;
    localDescription?: string;
    secretRecordRef?: string;
    reconciliationCursor?: string;
  }): WalletOperation {
    const createdAtMs = Date.now();
    const operation = createWalletOperation({
      key: {
        federationId: input.federationId,
        operationId: operationId(input.sdkOperationId),
      },
      kind: input.kind,
      direction: input.direction,
      status: input.status,
      createdAtMs,
      updatedAtMs: createdAtMs,
      schemaVersion: 2,
      adapterVersion: 'fedimint-core-0.1.3',
      ...(input.amountMsats === undefined
        ? {}
        : { amountMsats: input.amountMsats }),
      ...(input.feeMsats === undefined ? {} : { feeMsats: input.feeMsats }),
      ...(input.expiresAtMs === undefined
        ? {}
        : { expiresAtMs: input.expiresAtMs }),
      ...(input.localDescription === undefined ||
      input.localDescription.trim().length === 0
        ? {}
        : { localDescription: input.localDescription.trim() }),
      ...(input.secretRecordRef === undefined
        ? {}
        : { secretRecordRef: input.secretRecordRef }),
      ...(input.reconciliationCursor === undefined
        ? {}
        : { reconciliationCursor: input.reconciliationCursor }),
    });
    this.operationRecords.set(operationMapKey(operation.key), operation);
    this.publishOperations();
    return operation;
  }

  private mergeOperation(
    observed: WalletOperation,
  ): 'added' | 'updated' | 'unchanged' {
    const key = operationMapKey(observed.key);
    const current = this.operationRecords.get(key);
    if (current === undefined) {
      this.operationRecords.set(key, observed);
      return 'added';
    }

    const transition = transitionOperation(
      current,
      observed.status,
      Math.max(current.updatedAtMs, observed.updatedAtMs),
    );
    if (transition.outcome !== 'applied') {
      return 'unchanged';
    }
    this.operationRecords.set(key, transition.operation);
    if (!isOperationInFlight(transition.operation.status)) {
      this.internallyTrackedOperations.delete(key);
      this.stopSdkOperationSubscription(key);
    }
    this.notifyOperation(transition.operation);
    return 'updated';
  }

  private updateOperation(key: OperationKey, status: OperationStatus): void {
    const mapKey = operationMapKey(key);
    const current = this.operationRecords.get(mapKey);
    if (current === undefined) {
      return;
    }
    const transition = transitionOperation(current, status, Date.now());
    if (transition.outcome !== 'applied') {
      return;
    }
    this.operationRecords.set(mapKey, transition.operation);
    if (!isOperationInFlight(transition.operation.status)) {
      this.internallyTrackedOperations.delete(mapKey);
      this.stopSdkOperationSubscription(mapKey);
    }
    this.publishOperations();
    this.notifyOperation(transition.operation);
  }

  private notifyOperation(operation: WalletOperation): void {
    for (const listener of this.operationListeners
      .get(operationMapKey(operation.key))
      ?.values() ?? []) {
      listener(operation);
    }
  }

  private publishOperations(): void {
    this.setSnapshot({
      operations: this.sortedOperations(),
    });
  }

  private sortedOperations(): readonly WalletOperation[] {
    return [...this.operationRecords.values()].sort(
      (left, right) =>
        right.updatedAtMs - left.updatedAtMs ||
        right.createdAtMs - left.createdAtMs,
    );
  }

  private trackSdkOperation(
    wallet: FedimintWallet,
    operation: WalletOperation,
    generation: number,
  ): void {
    if (sdkOperationFlow(operation) === undefined) {
      return;
    }
    this.internallyTrackedOperations.add(operationMapKey(operation.key));
    this.ensureSdkOperationSubscription(operation, wallet, generation);
  }

  private ensureSdkOperationSubscription(
    operation: WalletOperation,
    wallet: FedimintWallet | undefined = this.wallets.get(
      operation.key.federationId,
    ),
    generation = this.generation,
  ): void {
    const flow = sdkOperationFlow(operation);
    if (
      wallet === undefined ||
      flow === undefined ||
      !isOperationInFlight(operation.status)
    ) {
      return;
    }

    const mapKey = operationMapKey(operation.key);
    const listenerCount = this.operationListeners.get(mapKey)?.size ?? 0;
    if (listenerCount === 0 && !this.internallyTrackedOperations.has(mapKey)) {
      return;
    }

    const existing = this.operationSubscriptions.get(mapKey);
    if (
      existing?.active === true &&
      existing.flow === flow &&
      existing.generation === generation
    ) {
      return;
    }
    if (existing !== undefined) {
      this.stopSdkOperationSubscription(mapKey, existing);
    }

    const subscription: SdkOperationSubscription = {
      key: operation.key,
      flow,
      generation,
      active: true,
      cancelCalled: false,
    };
    this.operationSubscriptions.set(mapKey, subscription);

    const onError = () => {
      if (!this.isCurrentSdkOperationSubscription(mapKey, subscription)) {
        return;
      }
      this.setSnapshot({
        ...this.snapshot,
        connection: 'offline',
      });
      this.stopSdkOperationSubscription(mapKey, subscription);
    };

    try {
      switch (flow) {
        case 'ecash-redeem':
          subscription.cancel = wallet.mint.subscribeReissueExternalNotes(
            operation.key.operationId,
            (state) => {
              this.handleSdkOperationState(
                mapKey,
                subscription,
                normalizeReissueState(state),
              );
            },
            onError,
          );
          break;
        case 'ecash-spend':
          subscription.cancel = wallet.mint.subscribeSpendNotes(
            operation.key.operationId,
            (state) => {
              this.handleSdkOperationState(
                mapKey,
                subscription,
                normalizeSpendState(state),
              );
            },
            onError,
          );
          break;
        case 'lightning-receive':
          subscription.cancel = wallet.lightning.subscribeLnReceive(
            operation.key.operationId,
            (state) => {
              this.handleSdkOperationState(
                mapKey,
                subscription,
                normalizeLnReceiveState(state),
              );
            },
            onError,
          );
          break;
        case 'lightning-pay':
          subscription.cancel = wallet.lightning.subscribeLnPay(
            operation.key.operationId,
            (state) => {
              this.handleSdkOperationState(
                mapKey,
                subscription,
                normalizeLnPayState(state),
              );
            },
            onError,
          );
          break;
        case 'lightning-internal-pay':
          subscription.cancel = wallet.lightning.subscribeInternalPayment(
            operation.key.operationId,
            (state) => {
              this.handleSdkOperationState(
                mapKey,
                subscription,
                normalizeInternalPayState(state),
              );
            },
            onError,
          );
          break;
      }
    } catch {
      if (generation === this.generation) {
        this.setSnapshot({
          ...this.snapshot,
          connection: 'offline',
        });
      }
      this.stopSdkOperationSubscription(mapKey, subscription);
      return;
    }

    if (!subscription.active) {
      this.callSdkOperationCancel(subscription);
    }
  }

  private handleSdkOperationState(
    mapKey: string,
    subscription: SdkOperationSubscription,
    status: OperationStatus,
  ): void {
    if (!this.isCurrentSdkOperationSubscription(mapKey, subscription)) {
      return;
    }

    this.updateOperation(subscription.key, status);
    if (isTerminalAdapterStatus(status)) {
      this.internallyTrackedOperations.delete(mapKey);
      this.stopSdkOperationSubscription(mapKey, subscription);
    }
  }

  private isCurrentSdkOperationSubscription(
    mapKey: string,
    subscription: SdkOperationSubscription,
  ): boolean {
    return (
      subscription.active &&
      subscription.generation === this.generation &&
      this.operationSubscriptions.get(mapKey) === subscription
    );
  }

  private syncSdkOperationSubscriptionDemand(key: OperationKey): void {
    const mapKey = operationMapKey(key);
    if (
      (this.operationListeners.get(mapKey)?.size ?? 0) > 0 ||
      this.internallyTrackedOperations.has(mapKey)
    ) {
      const operation = this.operationRecords.get(mapKey);
      if (operation !== undefined) {
        this.ensureSdkOperationSubscription(operation);
      }
      return;
    }

    this.stopSdkOperationSubscription(mapKey);
  }

  private resumeSdkOperationSubscriptions(): void {
    for (const operation of this.operationRecords.values()) {
      if (isOperationInFlight(operation.status)) {
        this.ensureSdkOperationSubscription(operation);
      }
    }
  }

  private stopSdkOperationSubscription(
    mapKey: string,
    expected?: SdkOperationSubscription,
  ): void {
    const subscription = this.operationSubscriptions.get(mapKey);
    if (subscription === undefined || (expected && subscription !== expected)) {
      return;
    }

    subscription.active = false;
    this.operationSubscriptions.delete(mapKey);
    this.callSdkOperationCancel(subscription);
  }

  private callSdkOperationCancel(subscription: SdkOperationSubscription): void {
    if (subscription.cancelCalled || subscription.cancel === undefined) {
      return;
    }
    subscription.cancelCalled = true;
    try {
      subscription.cancel();
    } catch {
      // Cleanup remains best-effort; identity gating rejects late callbacks.
    }
  }

  private requireActiveFederation(): ActiveFederation {
    const federation = this.snapshot.activeFederation;
    if (federation === undefined) {
      throw new WalletError('wallet_locked');
    }
    return federation;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new DOMException('Request aborted.', 'AbortError');
    }
  }

  private requireDirector(): FedimintWebWalletDirector {
    if (this.snapshot.lifecycle !== 'ready' || this.director === undefined) {
      throw new WalletError('wallet_locked');
    }
    return this.director;
  }

  private requireWallet(): FedimintWallet {
    const activeFederation = this.snapshot.activeFederation;
    const wallet =
      activeFederation === undefined
        ? undefined
        : this.wallets.get(activeFederation.federationId);
    if (wallet === undefined) {
      throw new WalletError('wallet_locked');
    }
    return wallet;
  }

  private async readBalance(wallet: FedimintWallet): Promise<Msats> {
    const value = await wallet.balance.getBalance();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WalletError('sdk_unavailable');
    }
    return msats(BigInt(value));
  }

  private combinedBalance(): Msats {
    let total = 0n;
    for (const balance of this.federationBalances.values()) {
      total += balance;
    }
    return msats(total);
  }

  private subscribeToBalance(
    federation: ActiveFederation,
    wallet: FedimintWallet,
    generation: number,
  ): void {
    this.cancelBalanceSubscriptions.get(federation.federationId)?.();
    const cancel = wallet.balance.subscribeBalance(
      (value) => {
        if (
          generation !== this.generation ||
          !Number.isSafeInteger(value) ||
          value < 0
        ) {
          return;
        }

        this.federationBalances.set(
          federation.federationId,
          msats(BigInt(value)),
        );
        this.setSnapshot({
          ...this.snapshot,
          connection: 'online',
          balanceMsats: this.combinedBalance(),
        });
      },
      () => {
        if (generation === this.generation) {
          this.setSnapshot({
            ...this.snapshot,
            connection: 'offline',
          });
        }
      },
    );
    this.cancelBalanceSubscriptions.set(federation.federationId, cancel);
  }

  private cancelAllBalanceSubscriptions(): void {
    for (const cancel of this.cancelBalanceSubscriptions.values()) {
      try {
        cancel();
      } catch {
        // Generation checks reject late callbacks from a failed teardown.
      }
    }
    this.cancelBalanceSubscriptions.clear();
  }

  private setSnapshot(
    input: Partial<
      Omit<WalletSnapshot, 'serviceKind' | 'connectedFederations'>
    >,
  ): void {
    this.snapshot = this.makeSnapshot({
      ...this.snapshot,
      ...input,
    });
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private makeSnapshot(
    input: Omit<
      WalletSnapshot,
      'serviceKind' | 'operations' | 'connectedFederations'
    > &
      Partial<Pick<WalletSnapshot, 'operations'>>,
  ): WalletSnapshot {
    return Object.freeze({
      serviceKind: this.kind,
      ...input,
      connectedFederations: summarizeConnectedFederations(
        this.federations.values(),
        this.federationBalances,
      ),
      operations: Object.freeze([...(input.operations ?? [])]),
    });
  }
}
