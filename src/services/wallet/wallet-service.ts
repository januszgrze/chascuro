import {
  msats,
  type ActiveFederation,
  type ClientName,
  type ClearableSecretText,
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
  type PublicWalletError,
  type RecoveryListener,
  type RecoveryResult,
  type RecoveryStatus,
  type SecretMnemonic,
  type SensitiveInput,
  type TrackedOperation,
  type WalletOperation,
} from '../../domain';

export type WalletServiceKind = 'fake' | 'fedimint';
export type WalletLifecycle =
  'closed' | 'opening' | 'ready' | 'joining' | 'error';
export type WalletConnection = 'offline' | 'online' | 'unknown';

export interface ConnectedFederationSummary {
  readonly federationId: ActiveFederation['federationId'];
  readonly displayName: string;
  readonly network: ActiveFederation['network'];
  readonly balanceMsats: Msats;
}

export interface WalletSnapshot {
  readonly serviceKind: WalletServiceKind;
  readonly lifecycle: WalletLifecycle;
  readonly connection: WalletConnection;
  readonly activeFederation?: ActiveFederation;
  readonly connectedFederations: readonly ConnectedFederationSummary[];
  readonly balanceMsats: Msats;
  readonly operations: readonly WalletOperation[];
  readonly capabilities?: FederationCapabilities;
  readonly error?: PublicWalletError;
}

export interface OpenWalletInput {
  activeFederation?: ActiveFederation;
  federations?: readonly ActiveFederation[];
  signal?: AbortSignal;
}

export type WalletSnapshotListener = (snapshot: WalletSnapshot) => void;

export function summarizeConnectedFederations(
  federations: Iterable<ActiveFederation>,
  balances: ReadonlyMap<string, Msats>,
): readonly ConnectedFederationSummary[] {
  return Object.freeze(
    [...federations].map((federation) =>
      Object.freeze({
        federationId: federation.federationId,
        displayName: federation.displayName,
        network: federation.network,
        balanceMsats: balances.get(federation.federationId) ?? msats(0n),
      }),
    ),
  );
}

export interface WalletIdentityService {
  createMnemonic(): Promise<SecretMnemonic>;
  setMnemonic(words: readonly string[]): Promise<void>;
  revealMnemonic(
    reason: 'initial-backup' | 'settings-backup',
  ): Promise<SecretMnemonic>;
}

export interface WalletFederationService {
  preview(
    inviteCode: SensitiveInput,
    signal?: AbortSignal,
  ): Promise<FederationCandidate>;
  join(
    approval: FederationJoinApproval,
    signal?: AbortSignal,
    clientName?: ClientName,
  ): Promise<ActiveFederation>;
  /**
   * Reopens the SDK's fixed client after a submitted join was interrupted
   * before the app profile could durably record success. Returns undefined when
   * no joined client exists for the pending descriptor.
   */
  reconcilePendingJoin(
    pending: FederationDescriptor & { readonly clientName?: ClientName },
    signal?: AbortSignal,
  ): Promise<ActiveFederation | undefined>;
  getCapabilities(signal?: AbortSignal): Promise<FederationCapabilities>;
}

export interface WalletBalanceService {
  refresh(signal?: AbortSignal): Promise<void>;
}

export interface WalletEcashService {
  parse(notes: SensitiveInput, signal?: AbortSignal): Promise<EcashPreview>;
  redeem(
    intent: ConfirmedEcashRedeem,
    signal?: AbortSignal,
  ): Promise<TrackedOperation>;
  createSpend(
    intent: ConfirmedEcashSpend,
    signal?: AbortSignal,
  ): Promise<EcashExport>;
  requestCancellation(
    operationId: OperationKey['operationId'],
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WalletLightningService {
  parseInvoice(
    invoice: SensitiveInput,
    signal?: AbortSignal,
  ): Promise<LightningInvoicePreview>;
  createInvoice(
    intent: LightningReceiveIntent,
    signal?: AbortSignal,
  ): Promise<LightningReceive>;
  quotePayment(
    intent: LightningPaymentIntent,
    signal?: AbortSignal,
  ): Promise<LightningQuote>;
  pay(
    confirmedQuote: ConfirmedLightningQuote,
    signal?: AbortSignal,
  ): Promise<TrackedOperation>;
}

export type OperationCursor = string;

export interface OperationPage {
  readonly operations: readonly WalletOperation[];
  readonly nextCursor?: OperationCursor;
}

export interface ReconciliationResult {
  readonly observed: number;
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
}

export type OperationListener = (operation: WalletOperation) => void;

export interface WalletOperationService {
  list(cursor?: OperationCursor, limit?: number): Promise<OperationPage>;
  get(key: OperationKey): Promise<WalletOperation | undefined>;
  subscribe(key: OperationKey, listener: OperationListener): () => void;
  reconcile(signal?: AbortSignal): Promise<ReconciliationResult>;
}

export interface WalletRecoveryService {
  getStatus(): Promise<RecoveryStatus>;
  subscribe(listener: RecoveryListener): () => void;
  waitForCompletion(signal?: AbortSignal): Promise<RecoveryResult>;
}

export interface WalletService {
  readonly kind: WalletServiceKind;
  readonly identity: WalletIdentityService;
  readonly federation: WalletFederationService;
  readonly balance: WalletBalanceService;
  readonly ecash: WalletEcashService;
  readonly lightning: WalletLightningService;
  readonly operations: WalletOperationService;
  readonly recovery: WalletRecoveryService;

  open(input?: OpenWalletInput): Promise<void>;
  close(): Promise<void>;
  getSnapshot(): WalletSnapshot;
  subscribe(listener: WalletSnapshotListener): () => void;
}

export type SecretPayload = ClearableSecretText;
