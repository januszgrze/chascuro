import type {
  ActiveFederation,
  ClearableSecretText,
  ConfirmedEcashRedeem,
  ConfirmedEcashSpend,
  ConfirmedLightningQuote,
  EcashExport,
  EcashPreview,
  FederationCandidate,
  FederationCapabilities,
  FederationDescriptor,
  FederationJoinApproval,
  LightningInvoicePreview,
  LightningPaymentIntent,
  LightningQuote,
  LightningReceive,
  LightningReceiveIntent,
  Msats,
  OperationKey,
  PublicWalletError,
  RecoveryListener,
  RecoveryResult,
  RecoveryStatus,
  SecretMnemonic,
  SensitiveInput,
  TrackedOperation,
  WalletOperation,
} from '../../domain';

export type WalletServiceKind = 'fake' | 'fedimint';
export type WalletLifecycle =
  'closed' | 'opening' | 'ready' | 'joining' | 'error';
export type WalletConnection = 'offline' | 'online' | 'unknown';

export interface WalletSnapshot {
  readonly serviceKind: WalletServiceKind;
  readonly lifecycle: WalletLifecycle;
  readonly connection: WalletConnection;
  readonly activeFederation?: ActiveFederation;
  readonly balanceMsats: Msats;
  readonly operations: readonly WalletOperation[];
  readonly capabilities?: FederationCapabilities;
  readonly error?: PublicWalletError;
}

export interface OpenWalletInput {
  activeFederation?: ActiveFederation;
  signal?: AbortSignal;
}

export type WalletSnapshotListener = (snapshot: WalletSnapshot) => void;

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
  ): Promise<ActiveFederation>;
  /**
   * Reopens the SDK's fixed client after a submitted join was interrupted
   * before the app profile could durably record success. Returns undefined when
   * no joined client exists for the pending descriptor.
   */
  reconcilePendingJoin(
    pending: FederationDescriptor,
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
