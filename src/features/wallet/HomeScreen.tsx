import { useEffect, useRef, useState } from 'react';

import {
  classifyWalletInput,
  formatMsatsAsSats,
  isTerminalOperationStatus,
  parsePositiveSats,
  type ClearableSecretText,
  type EcashExport,
  type EcashPreview,
  type FederationCandidate,
  type LightningInvoicePreview,
  type LightningQuote,
  type LightningReceive,
  type LnurlPaymentReview,
  type LnurlPayOffer,
  type LnurlPayOfferId,
  type LnurlSuccessAction,
  type OperationKey,
  type SecretMnemonic,
  type TrackedOperation,
  type WalletOperation,
} from '../../domain';
import type { WalletSnapshot } from '../../services/wallet';
import { FederationInviteScreen } from '../onboarding/FederationInviteScreen';
import { FederationReviewScreen } from '../onboarding/FederationReviewScreen';
import { AmountKeypad } from '../shared/AmountKeypad';
import { BitcoinMark } from '../shared/BitcoinMark';
import {
  ArrowDownIcon,
  ArrowDownLeftIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  BoltIcon,
  ChatIcon,
  CheckIcon,
  ChevronLeftIcon,
  GearIcon,
  HistoryIcon,
  PasteIcon,
  ShieldIcon,
} from '../shared/icons';
import { QrCode } from '../shared/QrCode';
import { QrScanner } from '../shared/QrScanner';
import { ScreenError } from '../shared/ScreenFrame';
import {
  SendReceiveShell,
  type PaymentDirection,
  type PaymentRail,
} from '../shared/SendReceiveShell';
import {
  ChooseMintScreen,
  mintDisplayName,
  MintPickerSheet,
  PayFromCard,
  selectedMintAccount,
  totalJoinedBalance,
} from './mint-screens';
import {
  runViewTransition,
  type ViewTransitionDirection,
} from './screen-transition';
import {
  ChevronRightGlyph,
  ClockGlyph,
  CloseGlyph,
  CopyButton,
  RecoveryGlyph,
  ResultScreen,
  SeedGlyph,
  SettingsNavRow,
  ShareButton,
  WalletDock,
  WalletGlyph,
} from './wallet-screen-components';
import {
  ACTIVITY_PAGE_SIZE,
  findOperation,
  formatCountdown,
  formatOperationDirection,
  formatOperationStatus,
  isSecretRecoveryRelevant,
  lightningInvoiceUnavailableTitle,
  operationLabel,
  useCurrentTime,
} from './wallet-screen-helpers';

interface PaymentNavProps {
  onNavigate(rail: PaymentRail, direction: PaymentDirection): void;
  onHome(): void;
  snapshot: WalletSnapshot;
  onSelectFederation?(federationId: string): Promise<void>;
  onConnectMint?(): void;
}

type FeatureResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

interface HomeScreenProps {
  snapshot: WalletSnapshot;
  refreshing: boolean;
  error?: string;
  onRefresh(): Promise<void>;
  onLock(): Promise<void>;
  onParseEcash(rawNotes: string): Promise<FeatureResult<EcashPreview>>;
  onRedeemEcash(
    preview: EcashPreview,
  ): Promise<FeatureResult<TrackedOperation>>;
  onCreateEcashSpend(amountSats: string): Promise<FeatureResult<EcashExport>>;
  onCreateLightningInvoice(
    amountSats: string,
    description: string,
  ): Promise<FeatureResult<LightningReceive>>;
  onQuoteLightningPayment(
    invoice: string,
    maximumFeeSats: string,
  ): Promise<
    FeatureResult<{
      preview: LightningInvoicePreview;
      quote: LightningQuote;
    }>
  >;
  onResolveLnurlPay(input: string): Promise<FeatureResult<LnurlPayOffer>>;
  onQuoteLnurlPayment(
    offerId: LnurlPayOfferId,
    amountSats: string | undefined,
    maximumFeeSats: string,
  ): Promise<FeatureResult<LnurlPaymentReview>>;
  onPayLightningQuote(
    preview: LightningInvoicePreview,
    quote: LightningQuote,
  ): Promise<FeatureResult<TrackedOperation>>;
  onReconcile(): Promise<FeatureResult<void>>;
  onRevealMnemonic(): Promise<FeatureResult<SecretMnemonic>>;
  onRecoverEcashExport(
    key: OperationKey,
  ): Promise<FeatureResult<ClearableSecretText>>;
  onRecoverLightningInvoice(
    key: OperationKey,
  ): Promise<FeatureResult<ClearableSecretText>>;
  onErase(typedConfirmation: string): Promise<FeatureResult<void>>;
  onOpenChat?: () => void;
  autoFocusChat?: boolean;
  candidate?: FederationCandidate;
  previewBusy?: boolean;
  joinBusy?: boolean;
  onPreviewFederation?(inviteCode: string): Promise<void>;
  onJoinFederation?(
    trustAcknowledged: boolean,
    mainnetRiskAcknowledged: boolean,
  ): Promise<void>;
  onSelectFederation?(federationId: string): Promise<void>;
  onCancelAddMint?(): void;
}

function ChatTopbarSlot({
  onOpenChat,
  autoFocus = false,
}: {
  onOpenChat?: () => void;
  autoFocus?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (autoFocus && onOpenChat !== undefined) {
      buttonRef.current?.focus();
    }
  }, [autoFocus, onOpenChat]);

  if (onOpenChat === undefined) {
    return (
      <span className="home-icon-btn" aria-hidden="true">
        <ChatIcon />
      </span>
    );
  }

  return (
    <button
      ref={buttonRef}
      className="home-icon-btn"
      type="button"
      aria-label="Chat"
      onClick={onOpenChat}
    >
      <ChatIcon />
    </button>
  );
}

type HomeView =
  | 'home'
  | 'ecash-receive'
  | 'ecash-send'
  | 'lightning-receive'
  | 'lightning-send'
  | 'activity'
  | 'settings'
  | 'settings-seed'
  | 'settings-recovery'
  | 'add-mint'
  | 'add-mint-review'
  | 'manage-mints';

const HOME_VIEW_DEPTH: Record<HomeView, number> = {
  home: 0,
  'ecash-receive': 1,
  'ecash-send': 1,
  'lightning-receive': 1,
  'lightning-send': 1,
  activity: 1,
  settings: 1,
  'manage-mints': 2,
  'settings-seed': 2,
  'settings-recovery': 2,
  'add-mint': 2,
  'add-mint-review': 3,
};

// Send and receive sit at the same position: switching between them is a
// lateral move (soft crossfade) rather than a sideways push, which otherwise
// reads as a hard, shaky shove between two peer screens. Home still enters
// send/receive as a forward push via the depth fallback below.
const HOME_VIEW_POSITION: Partial<Record<HomeView, number>> = {
  home: 0,
  'ecash-send': 1,
  'lightning-send': 1,
  'ecash-receive': 1,
  'lightning-receive': 1,
};

function resolveDirection(
  from: HomeView,
  to: HomeView,
): ViewTransitionDirection {
  const fromPosition = HOME_VIEW_POSITION[from];
  const toPosition = HOME_VIEW_POSITION[to];
  if (
    fromPosition !== undefined &&
    toPosition !== undefined &&
    fromPosition !== toPosition
  ) {
    return toPosition > fromPosition ? 'forward' : 'back';
  }

  const delta = HOME_VIEW_DEPTH[to] - HOME_VIEW_DEPTH[from];
  if (delta > 0) {
    return 'forward';
  }
  if (delta < 0) {
    return 'back';
  }
  return 'lateral';
}

export function HomeScreen(props: HomeScreenProps) {
  const [view, setView] = useState<HomeView>('home');
  const viewRef = useRef<HomeView>('home');
  const addMintReturnRef = useRef<HomeView>('manage-mints');
  const transitionTo = (
    next: HomeView,
    direction?: ViewTransitionDirection,
  ) => {
    if (next === viewRef.current) {
      return;
    }
    runViewTransition(
      direction ?? resolveDirection(viewRef.current, next),
      () => {
        viewRef.current = next;
        setView(next);
      },
    );
  };
  const navigate = (rail: PaymentRail, direction: PaymentDirection) =>
    transitionTo(`${rail}-${direction}` as HomeView);
  const goHome = () => transitionTo('home');
  const goHomeDismiss = () => transitionTo('home', 'dismiss');
  const openAddMint = (from: HomeView) => {
    addMintReturnRef.current = from;
    transitionTo('add-mint');
  };
  const mintProps = {
    snapshot: props.snapshot,
    onSelectFederation: props.onSelectFederation,
    onConnectMint: () => openAddMint(viewRef.current),
  };

  useEffect(() => {
    if (props.candidate !== undefined && viewRef.current === 'add-mint') {
      transitionTo('add-mint-review');
    }
    if (
      props.candidate === undefined &&
      viewRef.current === 'add-mint-review'
    ) {
      transitionTo(addMintReturnRef.current);
    }
  }, [props.candidate]);

  switch (view) {
    case 'ecash-receive':
      return (
        <EcashReceiveScreen
          onNavigate={navigate}
          onHome={goHome}
          onDone={goHomeDismiss}
          onParse={props.onParseEcash}
          onRedeem={props.onRedeemEcash}
        />
      );
    case 'ecash-send':
      return (
        <EcashSendScreen
          {...mintProps}
          onNavigate={navigate}
          onHome={goHome}
          onCreate={props.onCreateEcashSpend}
        />
      );
    case 'lightning-receive':
      return (
        <LightningReceiveScreen
          {...mintProps}
          enabled={
            props.snapshot.capabilities?.lightning === true &&
            props.snapshot.capabilities.gatewayAvailable === true
          }
          operations={props.snapshot.operations}
          onNavigate={navigate}
          onHome={goHome}
          onDone={goHomeDismiss}
          onCreate={props.onCreateLightningInvoice}
        />
      );
    case 'lightning-send':
      return (
        <LightningSendScreen
          {...mintProps}
          enabled={props.snapshot.capabilities?.lightningSend === 'enabled'}
          operations={props.snapshot.operations}
          onNavigate={navigate}
          onHome={goHome}
          onDone={goHomeDismiss}
          onQuote={props.onQuoteLightningPayment}
          onResolveLnurl={props.onResolveLnurlPay}
          onQuoteLnurl={props.onQuoteLnurlPayment}
          onPay={props.onPayLightningQuote}
        />
      );
    case 'activity':
      return (
        <ActivityScreen
          operations={props.snapshot.operations}
          federations={props.snapshot.federations}
          onBack={goHome}
          onReconcile={props.onReconcile}
          onRecoverEcashExport={props.onRecoverEcashExport}
          onRecoverLightningInvoice={props.onRecoverLightningInvoice}
          onOpenChat={props.onOpenChat}
        />
      );
    case 'settings':
      return (
        <SettingsScreen
          snapshot={props.snapshot}
          onBack={goHome}
          onLock={props.onLock}
          onOpenMints={() => transitionTo('manage-mints')}
          onOpenSeed={() => transitionTo('settings-seed')}
          onOpenRecovery={() => transitionTo('settings-recovery')}
        />
      );
    case 'settings-seed':
      return (
        <SeedSettingsScreen
          onBack={() => transitionTo('settings')}
          onRevealMnemonic={props.onRevealMnemonic}
        />
      );
    case 'settings-recovery':
      return (
        <RecoverySettingsScreen
          onBack={() => transitionTo('settings')}
          onErase={props.onErase}
        />
      );
    case 'manage-mints':
      return (
        <ChooseMintScreen
          snapshot={props.snapshot}
          intent="manage"
          selectedId={props.snapshot.activeFederation?.federationId}
          onConfirm={async (federationId) => {
            await props.onSelectFederation?.(federationId);
            transitionTo('settings');
          }}
          onClose={() => transitionTo('settings')}
          onConnectMint={() => openAddMint('manage-mints')}
        />
      );
    case 'add-mint':
      return (
        <FederationInviteScreen
          variant="add"
          busy={props.previewBusy === true}
          error={props.error}
          onPreview={async (inviteCode) => {
            await props.onPreviewFederation?.(inviteCode);
          }}
          onLock={props.onLock}
          onBack={() => {
            props.onCancelAddMint?.();
            transitionTo(addMintReturnRef.current);
          }}
        />
      );
    case 'add-mint-review':
      return props.candidate === undefined ? (
        <FederationInviteScreen
          variant="add"
          busy={props.previewBusy === true}
          error={props.error}
          onPreview={async (inviteCode) => {
            await props.onPreviewFederation?.(inviteCode);
          }}
          onLock={props.onLock}
          onBack={() => {
            props.onCancelAddMint?.();
            transitionTo('add-mint');
          }}
        />
      ) : (
        <FederationReviewScreen
          variant="add"
          candidate={props.candidate}
          busy={props.joinBusy === true}
          error={props.error}
          onBack={() => {
            props.onCancelAddMint?.();
            transitionTo('add-mint');
          }}
          onJoin={async (trustAcknowledged, mainnetRiskAcknowledged) => {
            await props.onJoinFederation?.(
              trustAcknowledged,
              mainnetRiskAcknowledged,
            );
          }}
          onLock={props.onLock}
        />
      );
    case 'home':
      return <WalletOverview {...props} onNavigate={transitionTo} />;
  }
}

function WalletOverview({
  snapshot,
  error,
  onNavigate,
  onOpenChat,
  autoFocusChat,
}: HomeScreenProps & { onNavigate(view: HomeView): void }) {
  const totalMsats = totalJoinedBalance(snapshot);
  return (
    <section className="home-shell" aria-labelledby="home-title">
      <div className="home-topbar">
        <ChatTopbarSlot onOpenChat={onOpenChat} autoFocus={autoFocusChat} />
        <div className="home-tools">
          <button
            className="home-tool"
            type="button"
            aria-label="Activity"
            onClick={() => onNavigate('activity')}
          >
            <HistoryIcon />
          </button>
          <button
            className="home-tool"
            type="button"
            aria-label="Backup and settings"
            onClick={() => onNavigate('settings')}
          >
            <GearIcon />
          </button>
        </div>
      </div>
      <div className="balance-card">
        <span className="balance-label">TOTAL</span>
        <p className="balance-amount" aria-live="polite">
          <BitcoinMark className="amount-symbol" />
          <span className="amount-value">{formatMsatsAsSats(totalMsats)}</span>
          <span className="visually-hidden">
            Total balance {formatMsatsAsSats(totalMsats)} sats
          </span>
        </p>
      </div>
      <h1 id="home-title" className="visually-hidden">
        Wallet home
      </h1>
      <ScreenError message={error} />
      {snapshot.operations.length === 0 ? (
        <p className="home-empty">No activity yet.</p>
      ) : (
        <ol className="activity-feed">
          {snapshot.operations.map((operation) => {
            const incoming = formatOperationDirection(operation) === 'incoming';
            return (
              <li
                className="activity-row"
                key={`${operation.key.federationId}:${operation.key.operationId}`}
              >
                <span
                  className={`activity-icon ${incoming ? 'is-in' : 'is-out'}`}
                >
                  {incoming ? <ArrowDownLeftIcon /> : <ArrowUpRightIcon />}
                </span>
                <span className="activity-info">
                  <span className="activity-title">
                    {operationLabel(operation)}
                  </span>
                  <span className="activity-status">
                    {snapshot.federations.length > 1
                      ? `${mintDisplayName(snapshot, operation.key.federationId)} · ${formatOperationStatus(operation.status)}`
                      : formatOperationStatus(operation.status)}
                  </span>
                </span>
                <span
                  className={`activity-amount ${incoming ? 'is-in' : 'is-out'}`}
                >
                  {formatSignedAmount(operation, incoming)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <nav className="home-nav" aria-label="Wallet navigation">
        <span
          className="home-nav-btn home-nav-balance is-active"
          aria-hidden="true"
        >
          <span className="wallet-nav-indicator" />
          <span className="wallet-nav-brand">
            <BitcoinMark />
          </span>
        </span>
        <button
          className="home-nav-btn"
          type="button"
          aria-label="Send"
          onClick={() => onNavigate('lightning-send')}
        >
          <span className="wallet-nav-icon">
            <ArrowUpIcon />
          </span>
        </button>
        <button
          className="home-nav-btn"
          type="button"
          aria-label="Receive"
          onClick={() => onNavigate('ecash-receive')}
        >
          <span className="wallet-nav-icon">
            <ArrowDownIcon />
          </span>
        </button>
      </nav>
    </section>
  );
}

function formatSignedAmount(
  operation: WalletOperation,
  incoming: boolean,
): string {
  if (operation.amountMsats === undefined) {
    return '—';
  }
  const sign = incoming ? '+' : '−';
  return `${sign}${formatMsatsAsSats(operation.amountMsats)}`;
}

function EcashReceiveScreen({
  onNavigate,
  onHome,
  onDone,
  onParse,
  onRedeem,
}: {
  onNavigate: PaymentNavProps['onNavigate'];
  onHome(): void;
  onDone(): void;
  onParse(rawNotes: string): Promise<FeatureResult<EcashPreview>>;
  onRedeem(preview: EcashPreview): Promise<FeatureResult<TrackedOperation>>;
}) {
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [preview, setPreview] = useState<EcashPreview>();
  const [operation, setOperation] = useState<WalletOperation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const manualInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (showManual) {
      manualInputRef.current?.focus();
    }
  }, [showManual]);

  function openManualEntry() {
    if (!showManual) {
      runViewTransition('lateral', () => setShowManual(true));
    }
  }

  function toggleManualEntry() {
    runViewTransition('lateral', () => setShowManual((current) => !current));
  }

  async function runParse(input: string) {
    setError(undefined);
    setBusy(true);
    const result = await onParse(input);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    runViewTransition('forward', () => {
      setManual('');
      setShowManual(false);
      setPreview(result.value);
    });
  }

  async function capture(value: string) {
    try {
      const classified = classifyWalletInput(value);
      if (classified.kind === 'bolt11') {
        setError('That looks like a Lightning invoice, not ecash.');
        return;
      }
      if (classified.kind === 'federation_invite') {
        setError('That looks like a federation invite, not ecash.');
        return;
      }
      await runParse(classified.input);
    } catch {
      setError('That code could not be read as ecash.');
    }
  }

  async function pasteFromClipboard() {
    if (navigator.clipboard === undefined) {
      openManualEntry();
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length > 0) {
        await capture(text);
      }
    } catch {
      openManualEntry();
    }
  }

  async function redeem() {
    if (preview === undefined) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await onRedeem(preview);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Redeem and Received share the same layout; a slow crossfade reads as the
    // title and button changing while the icon and amount hold still.
    runViewTransition('settle', () => setOperation(result.value.operation));
  }

  if (operation !== undefined) {
    return (
      <ResultScreen
        titleId="ecash-receive-title"
        tone="success"
        direction="in"
        title="Received"
        hold
        amountSats={
          operation.amountMsats === undefined
            ? undefined
            : formatMsatsAsSats(operation.amountMsats)
        }
        action={
          <button
            className="flow-primary-action"
            type="button"
            onClick={onDone}
          >
            <CheckIcon size={20} />
            Done
          </button>
        }
      />
    );
  }

  if (preview !== undefined) {
    return (
      <ResultScreen
        titleId="ecash-receive-title"
        tone="success"
        direction="in"
        title="Redeem"
        amountSats={formatMsatsAsSats(preview.amountMsats)}
        subtitle={
          preview.compatible
            ? undefined
            : "Different federation — can't redeem here"
        }
        onBack={() => runViewTransition('back', () => setPreview(undefined))}
        error={error}
        action={
          <button
            className="flow-primary-action"
            type="button"
            disabled={busy || !preview.compatible}
            onClick={() => void redeem()}
          >
            <ArrowDownIcon size={20} />
            {busy ? 'Redeeming…' : 'Redeem'}
          </button>
        }
      />
    );
  }

  return (
    <SendReceiveShell
      rail="ecash"
      direction="receive"
      variant="dark"
      onNavigate={onNavigate}
      onHome={onHome}
      onKeyboard={toggleManualEntry}
      hideNavigation={showManual}
    >
      <div className={`scan-body${showManual ? ' scan-body--manual' : ''}`}>
        {showManual ? (
          <div className="scan-manual">
            <textarea
              ref={manualInputRef}
              aria-label="Ecash notes"
              autoComplete="off"
              spellCheck={false}
              placeholder="Type in ecash note"
              value={manual}
              onChange={(event) => {
                setError(undefined);
                setManual(event.target.value);
              }}
            />
            <button
              className="scan-paste"
              type="button"
              disabled={busy || manual.trim().length === 0}
              onClick={() => void runParse(manual)}
            >
              Continue
            </button>
          </div>
        ) : (
          <>
            <QrScanner
              variant="framed"
              disabled={busy}
              onScan={(value) => void capture(value)}
            />
            <button
              className="scan-paste"
              type="button"
              disabled={busy}
              onClick={() => void pasteFromClipboard()}
            >
              <PasteIcon />
              Paste ecash note
            </button>
          </>
        )}
        {error !== undefined && (
          <p className="scan-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </SendReceiveShell>
  );
}

function EcashSendScreen({
  onNavigate,
  onHome,
  onCreate,
  snapshot,
  onSelectFederation,
  onConnectMint,
}: PaymentNavProps & {
  onCreate(amountSats: string): Promise<FeatureResult<EcashExport>>;
}) {
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pickingMint, setPickingMint] = useState(false);
  const [sentAmount, setSentAmount] = useState<string>();
  const [exported, setExported] = useState<EcashExport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copyStatus, setCopyStatus] = useState<string>();
  const ready = /^[1-9]\d*$/.test(amount);

  useEffect(
    () => () => {
      exported?.notes.clear();
    },
    [exported],
  );

  // The check key on the keypad commits the amount and moves to a review step;
  // the link is only minted once "Create link" is pressed on that screen.
  function review() {
    if (!ready) {
      return;
    }
    setError(undefined);
    runViewTransition('forward', () => setConfirming(true));
  }

  async function create() {
    setBusy(true);
    setError(undefined);
    const result = await onCreate(amount);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    runViewTransition('forward', () => {
      setSentAmount(amount);
      setExported(result.value);
      setConfirming(false);
      setAmount('');
    });
  }

  function discard() {
    runViewTransition('back', () => {
      exported?.notes.clear();
      setExported(undefined);
      setSentAmount(undefined);
      setCopyStatus(undefined);
    });
  }

  if (exported !== undefined) {
    return (
      <section className="qr-share" aria-labelledby="ecash-send-title">
        <div className="confirm-topbar qr-share-topbar">
          <button
            className="confirm-back"
            type="button"
            aria-label="Back"
            onClick={discard}
          >
            <ChevronLeftIcon />
          </button>
        </div>
        <div className="qr-share-body">
          <h1 id="ecash-send-title" className="visually-hidden">
            Ecash link
          </h1>
          {sentAmount !== undefined && (
            <p className="qr-share-amount">
              <BitcoinMark className="amount-symbol" />
              <span className="amount-value">{sentAmount}</span>
            </p>
          )}
          {exported.secretStorage === 'memory_only' && (
            <div className="notice" role="alert">
              <strong>Encrypted recovery failed.</strong>
              <p>
                Share these notes now. They will be lost if you leave, lock the
                wallet, reload, or close this page.
              </p>
            </div>
          )}
          <div className="qr-card">
            <QrCode
              allowMultipart
              contentType="ecash"
              value={exported.notes.reveal()}
              label="Ecash notes QR code"
            />
          </div>
          <ShareButton
            secret={exported.notes}
            label="Share link"
            onStatus={setCopyStatus}
          />
          <p className="visually-hidden" aria-live="polite">
            {copyStatus}
          </p>
        </div>
        <WalletDock active="send" onNavigate={onNavigate} onHome={onHome} />
      </section>
    );
  }

  if (confirming) {
    return (
      <ResultScreen
        titleId="ecash-send-title"
        tone="success"
        direction="out"
        title="Send"
        amountSats={amount}
        error={error}
        onBack={
          busy
            ? undefined
            : () => runViewTransition('back', () => setConfirming(false))
        }
        action={
          <button
            className="flow-primary-action"
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void create()}
          >
            {busy ? (
              <span className="pending-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : null}
            {busy ? 'Creating…' : 'Create link'}
          </button>
        }
      >
        <MintPickerSheet
          snapshot={snapshot}
          direction="send"
          open={pickingMint}
          onOpenChange={setPickingMint}
          onSelect={async (federationId) => {
            await onSelectFederation?.(federationId);
          }}
          onConnectMint={() => onConnectMint?.()}
        />
      </ResultScreen>
    );
  }

  return (
    <SendReceiveShell
      rail="ecash"
      direction="send"
      variant="light"
      onNavigate={onNavigate}
      onHome={onHome}
    >
      <AmountKeypad
        value={amount}
        onChange={setAmount}
        onConfirm={review}
        confirmDisabled={!ready}
        confirmLabel="Review send"
      />
      <ScreenError message={error} />
    </SendReceiveShell>
  );
}

function LightningReceiveScreen({
  enabled,
  operations,
  onNavigate,
  onHome,
  onDone,
  onCreate,
  snapshot,
  onSelectFederation,
  onConnectMint,
}: PaymentNavProps & {
  enabled: boolean;
  operations: readonly WalletOperation[];
  onDone(): void;
  onCreate(
    amountSats: string,
    description: string,
  ): Promise<FeatureResult<LightningReceive>>;
}) {
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pickingMint, setPickingMint] = useState(false);
  const [receive, setReceive] = useState<LightningReceive>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copyStatus, setCopyStatus] = useState<string>();
  const ready = /^[1-9]\d*$/.test(amount);
  const liveOperation =
    receive === undefined
      ? undefined
      : (findOperation(operations, receive.operation.key) ?? receive.operation);
  const expiresAtMs = liveOperation?.expiresAtMs ?? receive?.expiresAtMs;
  const terminal =
    liveOperation === undefined
      ? false
      : isTerminalOperationStatus(liveOperation.status);
  const nowMs = useCurrentTime(
    receive !== undefined && !terminal && expiresAtMs !== undefined,
  );
  const expired = expiresAtMs !== undefined && nowMs >= expiresAtMs;
  const shareable =
    receive !== undefined &&
    !terminal &&
    !expired &&
    receive.invoice.length > 0;

  useEffect(
    () => () => {
      receive?.invoice.clear();
    },
    [receive],
  );

  useEffect(() => {
    if (receive !== undefined && !shareable) {
      receive.invoice.clear();
    }
  }, [receive, shareable]);

  async function create() {
    setBusy(true);
    setError(undefined);
    const result = await onCreate(amount, '');
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    runViewTransition('forward', () => {
      setPickingMint(false);
      setConfirming(false);
      setReceive(result.value);
      setAmount('');
    });
  }

  function review() {
    if (!ready) {
      return;
    }
    setError(undefined);
    runViewTransition('forward', () => setConfirming(true));
  }

  function discard() {
    runViewTransition('back', () => {
      receive?.invoice.clear();
      setReceive(undefined);
      setCopyStatus(undefined);
    });
  }

  if (!enabled) {
    return (
      <section
        className="confirm-shell"
        aria-labelledby="lightning-receive-title"
      >
        <div className="confirm-topbar">
          <button
            className="confirm-back"
            type="button"
            aria-label="Back"
            onClick={onHome}
          >
            <ChevronLeftIcon />
          </button>
          <h1 id="lightning-receive-title" className="confirm-title">
            Your invoice
          </h1>
        </div>
        <div className="notice">
          <strong>Lightning receive is unavailable.</strong>
          <p>This federation has no usable Lightning gateway right now.</p>
        </div>
      </section>
    );
  }

  if (receive !== undefined) {
    const displayOperation = liveOperation ?? receive.operation;

    if (displayOperation.status === 'settled') {
      return (
        <ResultScreen
          titleId="lightning-receive-title"
          tone="success"
          direction="in"
          title="Received"
          amountSats={
            displayOperation.amountMsats === undefined
              ? undefined
              : formatMsatsAsSats(displayOperation.amountMsats)
          }
          action={
            <button
              className="flow-primary-action"
              type="button"
              onClick={onDone}
            >
              <CheckIcon size={20} />
              Done
            </button>
          }
        />
      );
    }

    return (
      <section className="qr-share" aria-labelledby="lightning-receive-title">
        <div className="confirm-topbar qr-share-topbar">
          <button
            className="confirm-back"
            type="button"
            aria-label="Back"
            onClick={discard}
          >
            <ChevronLeftIcon />
          </button>
        </div>
        <div className="qr-share-body">
          <h1 id="lightning-receive-title" className="visually-hidden">
            Your invoice
          </h1>
          {displayOperation.amountMsats !== undefined && (
            <p className="qr-share-amount">
              <BitcoinMark className="amount-symbol" />
              <span className="amount-value">
                {formatMsatsAsSats(displayOperation.amountMsats)}
              </span>
            </p>
          )}
          {receive.secretStorage === 'memory_only' && shareable && (
            <div className="notice" role="alert">
              <strong>Encrypted recovery failed.</strong>
              <p>
                Share this invoice now. It will not be recoverable after you
                leave, lock the wallet, reload, or close this page.
              </p>
            </div>
          )}
          {shareable && expiresAtMs !== undefined ? (
            <>
              <p className="qr-expiry" role="timer" aria-live="polite">
                <ClockGlyph />
                Expires in {formatCountdown(expiresAtMs - nowMs)}
              </p>
              <div className="qr-card">
                <QrCode
                  contentType="bolt11"
                  value={receive.invoice.reveal()}
                  label="Lightning invoice QR code"
                />
              </div>
              <ShareButton
                secret={receive.invoice}
                label="Share invoice"
                title="Lightning invoice"
                onStatus={setCopyStatus}
              />
            </>
          ) : (
            <div className="notice" role="status">
              <strong>{lightningInvoiceUnavailableTitle(liveOperation)}</strong>
              <p>
                The invoice has been cleared from this screen and can no longer
                be presented as payable.
              </p>
            </div>
          )}
          <p className="visually-hidden" aria-live="polite">
            {copyStatus}
          </p>
        </div>
        <WalletDock active="receive" onNavigate={onNavigate} onHome={onHome} />
      </section>
    );
  }

  if (confirming) {
    return (
      <ResultScreen
        titleId="lightning-receive-title"
        tone="success"
        direction="in"
        title="Receive"
        amountSats={amount}
        error={error}
        onBack={
          busy
            ? undefined
            : () => runViewTransition('back', () => setConfirming(false))
        }
        action={
          <button
            className="flow-primary-action"
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void create()}
          >
            {busy ? (
              <span className="pending-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <BoltIcon size={20} />
            )}
            {busy ? 'Creating…' : 'Create invoice'}
          </button>
        }
      >
        <MintPickerSheet
          snapshot={snapshot}
          direction="receive"
          open={pickingMint}
          onOpenChange={setPickingMint}
          onSelect={async (federationId) => {
            await onSelectFederation?.(federationId);
          }}
          onConnectMint={() => onConnectMint?.()}
        />
      </ResultScreen>
    );
  }

  return (
    <SendReceiveShell
      rail="lightning"
      direction="receive"
      variant="light"
      onNavigate={onNavigate}
      onHome={onHome}
    >
      <AmountKeypad
        value={amount}
        onChange={setAmount}
        disabled={busy}
        onConfirm={review}
        confirmDisabled={!ready || busy}
        confirmLabel="Review receive"
      />
      <ScreenError message={error} />
    </SendReceiveShell>
  );
}

function LightningSendScreen({
  enabled,
  operations,
  onNavigate,
  onHome,
  onDone,
  onQuote,
  onResolveLnurl,
  onQuoteLnurl,
  onPay,
  snapshot,
  onSelectFederation,
  onConnectMint,
}: PaymentNavProps & {
  enabled: boolean;
  operations: readonly WalletOperation[];
  onDone(): void;
  onQuote(
    invoice: string,
    maximumFeeSats: string,
  ): Promise<
    FeatureResult<{
      preview: LightningInvoicePreview;
      quote: LightningQuote;
    }>
  >;
  onResolveLnurl(input: string): Promise<FeatureResult<LnurlPayOffer>>;
  onQuoteLnurl(
    offerId: LnurlPayOfferId,
    amountSats: string | undefined,
    maximumFeeSats: string,
  ): Promise<FeatureResult<LnurlPaymentReview>>;
  onPay(
    preview: LightningInvoicePreview,
    quote: LightningQuote,
  ): Promise<FeatureResult<TrackedOperation>>;
}) {
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [offer, setOffer] = useState<LnurlPayOffer>();
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<{
    preview: LightningInvoicePreview;
    quote: LightningQuote;
    successAction?: LnurlSuccessAction;
  }>();
  const [operation, setOperation] = useState<WalletOperation>();
  const [revealResult, setRevealResult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pickingMint, setPickingMint] = useState(false);
  const manualInputRef = useRef<HTMLTextAreaElement>(null);
  const feeLimitSats = '10';

  // While a submitted payment is still in flight we stay on the review screen
  // with the Pay button animating, rather than showing a separate "pending"
  // screen. The result screen appears only once the operation is terminal, and
  // we flip into it inside a view transition so the review screen slides out.
  const liveOperation =
    operation === undefined
      ? undefined
      : (findOperation(operations, operation.key) ?? operation);
  const operationTerminal =
    liveOperation !== undefined &&
    isTerminalOperationStatus(liveOperation.status);
  const paying = operation !== undefined && !revealResult;

  useEffect(() => {
    if (operationTerminal && !revealResult) {
      runViewTransition('forward', () => setRevealResult(true));
    }
  }, [operationTerminal, revealResult]);

  useEffect(() => {
    if (showManual) {
      manualInputRef.current?.focus();
    }
  }, [showManual]);

  function openManualEntry() {
    if (!showManual) {
      runViewTransition('lateral', () => setShowManual(true));
    }
  }

  function toggleManualEntry() {
    runViewTransition('lateral', () => setShowManual((current) => !current));
  }

  async function runQuote(input: string) {
    setError(undefined);
    setBusy(true);
    const result = await onQuote(input, feeLimitSats);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    runViewTransition('forward', () => {
      setManual('');
      setShowManual(false);
      setReview(result.value);
    });
  }

  async function resolveLnurl(input: string) {
    setError(undefined);
    setBusy(true);
    const result = await onResolveLnurl(input);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    runViewTransition('forward', () => {
      setManual('');
      setShowManual(false);
      setAmount('');
      setOffer(result.value);
    });
  }

  async function submitPaymentTarget(value: string) {
    try {
      const classified = classifyWalletInput(value);
      switch (classified.kind) {
        case 'bolt11':
          setOffer(undefined);
          await runQuote(classified.input);
          return;
        case 'lightning_address':
        case 'lnurl':
          await resolveLnurl(classified.input);
          return;
        default:
          setError(
            'Enter a BOLT11 invoice, Lightning Address, or LNURL-pay request.',
          );
      }
    } catch {
      setError('That Lightning payment request is not valid.');
    }
  }

  async function quoteLnurl() {
    if (offer === undefined) {
      return;
    }
    const selectedAmount =
      offer.fixedAmountMsats === undefined ? amount : undefined;
    if (lnurlAmountError(offer, selectedAmount) !== undefined) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await onQuoteLnurl(
      offer.offerId,
      selectedAmount,
      feeLimitSats,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    runViewTransition('forward', () => setReview(result.value));
  }

  async function pasteFromClipboard() {
    if (navigator.clipboard === undefined) {
      openManualEntry();
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length > 0) {
        await submitPaymentTarget(text);
      }
    } catch {
      openManualEntry();
    }
  }

  async function pay() {
    if (review === undefined) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await onPay(review.preview, review.quote);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Keep the user on the review screen with the Pay button animating; the
    // settle-watching effect promotes this to the result screen once terminal.
    setOperation(result.value.operation);
  }

  if (pickingMint) {
    return (
      <ChooseMintScreen
        snapshot={snapshot}
        intent="lightning-send"
        amountMsats={review?.quote.amountMsats}
        selectedId={snapshot.activeFederation?.federationId}
        onConfirm={async (federationId) => {
          await onSelectFederation?.(federationId);
          setPickingMint(false);
        }}
        onClose={() => setPickingMint(false)}
        onConnectMint={() => onConnectMint?.()}
      />
    );
  }

  if (!enabled) {
    return (
      <section className="confirm-shell" aria-labelledby="lightning-send-title">
        <div className="confirm-topbar">
          <button
            className="confirm-back"
            type="button"
            aria-label="Back"
            onClick={onHome}
          >
            <ChevronLeftIcon />
          </button>
          <h1 id="lightning-send-title" className="confirm-title">
            Pay invoice
          </h1>
        </div>
        <div className="notice">
          <strong>Payment submission is disabled.</strong>
          <p>
            The active adapter cannot prove a fee bound before payment. The
            wallet will not submit an invoice without that protection.
          </p>
        </div>
      </section>
    );
  }

  if (revealResult && liveOperation !== undefined) {
    const settled = liveOperation.status === 'settled';
    const successAction = settled ? review?.successAction : undefined;
    return (
      <ResultScreen
        titleId="lightning-send-title"
        tone={settled ? 'success' : 'pending'}
        direction="out"
        title={settled ? 'Sent' : 'Payment not completed'}
        amountSats={
          liveOperation.amountMsats === undefined
            ? undefined
            : formatMsatsAsSats(liveOperation.amountMsats)
        }
        subtitle={
          settled
            ? undefined
            : 'Review Activity before trying this payment again.'
        }
        action={
          <button
            className="flow-primary-action"
            type="button"
            onClick={onDone}
          >
            <CheckIcon size={20} />
            Done
          </button>
        }
      >
        {successAction?.tag === 'message' && (
          <div className="notice" role="status">
            <strong>Message from recipient</strong>
            <p>{successAction.message}</p>
          </div>
        )}
        {successAction?.tag === 'url' && (
          <div className="notice" role="status">
            <strong>{successAction.description}</strong>
            <p>
              <a href={successAction.url} target="_blank" rel="noreferrer">
                Open recipient link
              </a>
            </p>
          </div>
        )}
      </ResultScreen>
    );
  }

  if (offer !== undefined && review === undefined) {
    const selectedAmount =
      offer.fixedAmountMsats === undefined ? amount : undefined;
    const amountError = lnurlAmountError(offer, selectedAmount);
    const fixedAmountLabel =
      offer.fixedAmountMsats === undefined
        ? undefined
        : formatMsatsAsSats(offer.fixedAmountMsats);
    return (
      <section
        className="confirm-shell flow-screen"
        aria-labelledby="lightning-send-title"
      >
        <div className="flow-screen-content">
          <div className="confirm-topbar">
            <button
              className="confirm-back"
              type="button"
              aria-label="Back"
              disabled={busy}
              onClick={() =>
                runViewTransition('back', () => {
                  setOffer(undefined);
                  setAmount('');
                  setError(undefined);
                })
              }
            >
              <ChevronLeftIcon />
            </button>
            <h1 id="lightning-send-title" className="confirm-title">
              Choose amount
            </h1>
          </div>
          <p className="lnurl-recipient">
            <span>To:</span> <strong>{offer.destination}</strong>
          </p>
          {fixedAmountLabel === undefined ? (
            <AmountKeypad
              value={amount}
              onChange={(next) => {
                setAmount(next);
                setError(undefined);
              }}
              disabled={busy}
            />
          ) : (
            <div className="confirm-amount">
              <BitcoinMark className="amount-symbol" />
              <span className="amount-value">{fixedAmountLabel}</span>
            </div>
          )}
        </div>
        <div className="screen-actions">
          {amount.length > 0 && amountError !== undefined && (
            <p className="scan-error" role="alert">
              {amountError}
            </p>
          )}
          <ScreenError message={error} />
          <button
            className="flow-primary-action"
            type="button"
            disabled={busy || amountError !== undefined}
            onClick={() => void quoteLnurl()}
          >
            <BoltIcon size={20} />
            {busy ? 'Requesting invoice…' : 'Review payment'}
          </button>
        </div>
      </section>
    );
  }

  if (review !== undefined) {
    const amountLabel = formatMsatsAsSats(review.quote.amountMsats);
    return (
      <ResultScreen
        titleId="lightning-send-title"
        tone="success"
        direction="out"
        title="Pay"
        amountSats={amountLabel}
        error={error}
        icon={<BoltIcon size={52} />}
        onBack={
          busy || paying
            ? undefined
            : () =>
                runViewTransition('back', () => {
                  setReview(undefined);
                  setError(undefined);
                })
        }
        action={
          <button
            className="flow-primary-action"
            type="button"
            disabled={busy || paying}
            aria-busy={busy || paying}
            onClick={() => void pay()}
          >
            {busy || paying ? (
              <span className="pending-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : null}
            Pay invoice
          </button>
        }
      >
        <PayFromCard
          account={selectedMintAccount(snapshot)}
          onPick={() => setPickingMint(true)}
        />
        <div className="pay-card pay-card--compact">
          <div className="pay-row">
            <span className="pay-label">Network fee</span>
            <span className="pay-value">
              <BitcoinMark className="btc-symbol" />{' '}
              {formatMsatsAsSats(review.quote.feeMsats)}
            </span>
          </div>
        </div>
      </ResultScreen>
    );
  }

  return (
    <SendReceiveShell
      rail="lightning"
      direction="send"
      variant="dark"
      onNavigate={onNavigate}
      onHome={onHome}
      onKeyboard={toggleManualEntry}
      hideNavigation={showManual}
    >
      <div className={`scan-body${showManual ? ' scan-body--manual' : ''}`}>
        {showManual ? (
          <div className="scan-manual">
            <textarea
              ref={manualInputRef}
              aria-label="Lightning payment request"
              autoComplete="off"
              spellCheck={false}
              placeholder="Type in payment URL"
              value={manual}
              onChange={(event) => {
                setError(undefined);
                setManual(event.target.value);
              }}
            />
            <button
              className="scan-paste"
              type="button"
              disabled={busy || manual.trim().length === 0}
              onClick={() => void submitPaymentTarget(manual)}
            >
              Continue
            </button>
          </div>
        ) : (
          <>
            <QrScanner
              variant="framed"
              disabled={busy}
              onScan={(value) => void submitPaymentTarget(value)}
            />
            <button
              className="scan-paste"
              type="button"
              disabled={busy}
              onClick={() => void pasteFromClipboard()}
            >
              <PasteIcon />
              Paste payment URL
            </button>
          </>
        )}
        {error !== undefined && (
          <p className="scan-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </SendReceiveShell>
  );
}

function lnurlAmountError(
  offer: LnurlPayOffer,
  amountSats: string | undefined,
): string | undefined {
  if (offer.fixedAmountMsats !== undefined) {
    return undefined;
  }
  if (amountSats === undefined || amountSats.trim().length === 0) {
    return 'Enter a whole-satoshi amount.';
  }
  try {
    const amountMsats = parsePositiveSats(amountSats);
    if (
      amountMsats < offer.minSendableMsats ||
      amountMsats > offer.maxSendableMsats
    ) {
      return `Choose an amount from ${formatMsatsAsSats(offer.minSendableMsats)} to ${formatMsatsAsSats(offer.maxSendableMsats)} sats.`;
    }
    return undefined;
  } catch {
    return 'Enter a whole-satoshi amount.';
  }
}

function ActivityScreen({
  operations,
  federations,
  onBack,
  onReconcile,
  onRecoverEcashExport,
  onRecoverLightningInvoice,
  onOpenChat,
}: {
  operations: readonly WalletOperation[];
  federations: WalletSnapshot['federations'];
  onBack(): void;
  onOpenChat?: () => void;
  onReconcile(): Promise<FeatureResult<void>>;
  onRecoverEcashExport(
    key: OperationKey,
  ): Promise<FeatureResult<ClearableSecretText>>;
  onRecoverLightningInvoice(
    key: OperationKey,
  ): Promise<FeatureResult<ClearableSecretText>>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE);
  const [selectedKey, setSelectedKey] = useState<OperationKey>();

  const selectedOperation =
    selectedKey === undefined
      ? undefined
      : findOperation(operations, selectedKey);

  async function reconcile() {
    setBusy(true);
    setError(undefined);
    const result = await onReconcile();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
    }
  }

  if (selectedOperation !== undefined) {
    return (
      <TransactionDetailScreen
        operation={selectedOperation}
        onBack={() => setSelectedKey(undefined)}
        onRecoverEcashExport={onRecoverEcashExport}
        onRecoverLightningInvoice={onRecoverLightningInvoice}
      />
    );
  }

  const visibleOperations = operations.slice(0, visibleCount);

  return (
    <section className="page-shell" aria-labelledby="activity-title">
      <div className="page-topbar">
        <ChatTopbarSlot onOpenChat={onOpenChat} />
        <button
          className="page-close"
          type="button"
          aria-label="Back to wallet"
          onClick={onBack}
        >
          <CloseGlyph />
        </button>
      </div>
      <h1 id="activity-title" className="page-title">
        Activity
      </h1>
      {operations.length === 0 ? (
        <p className="home-empty">No activity yet.</p>
      ) : (
        <ol className="activity-feed">
          {visibleOperations.map((operation) => {
            const incoming = formatOperationDirection(operation) === 'incoming';
            return (
              <li
                className="activity-item"
                key={`${operation.key.federationId}:${operation.key.operationId}`}
              >
                <button
                  className="activity-row activity-row-button"
                  type="button"
                  aria-label={`View details for ${operationLabel(operation)}`}
                  onClick={() => setSelectedKey(operation.key)}
                >
                  <span
                    className={`activity-icon ${incoming ? 'is-in' : 'is-out'}`}
                  >
                    {incoming ? <ArrowDownLeftIcon /> : <ArrowUpRightIcon />}
                  </span>
                  <span className="activity-info">
                    <span className="activity-title">
                      {operationLabel(operation)}
                    </span>
                    <span
                      className={`activity-status${
                        operation.status === 'settled' ? ' is-positive' : ''
                      }`}
                    >
                      {federations.length > 1
                        ? `${mintNameFromAccounts(federations, operation.key.federationId)} · ${formatOperationStatus(operation.status)}`
                        : formatOperationStatus(operation.status)}
                    </span>
                  </span>
                  <span
                    className={`activity-amount ${incoming ? 'is-in' : 'is-out'}`}
                  >
                    {formatSignedAmount(operation, incoming)}
                  </span>
                  <span className="activity-chevron" aria-hidden="true">
                    <ChevronRightGlyph />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <ScreenError message={error} />
      <div className="stack activity-controls">
        {visibleCount < operations.length && (
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() =>
              setVisibleCount((count) => count + ACTIVITY_PAGE_SIZE)
            }
          >
            Load more activity ({operations.length - visibleCount} remaining)
          </button>
        )}
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => void reconcile()}
        >
          {busy ? 'Reconciling…' : 'Reconcile activity'}
        </button>
      </div>
    </section>
  );
}

function TransactionDetailScreen({
  operation,
  onBack,
  onRecoverEcashExport,
  onRecoverLightningInvoice,
}: {
  operation: WalletOperation;
  onBack(): void;
  onRecoverEcashExport(
    key: OperationKey,
  ): Promise<FeatureResult<ClearableSecretText>>;
  onRecoverLightningInvoice(
    key: OperationKey,
  ): Promise<FeatureResult<ClearableSecretText>>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recovered, setRecovered] = useState<{
    purpose: 'ecash-export' | 'lightning-invoice';
    secret: ClearableSecretText;
  }>();
  const [copyStatus, setCopyStatus] = useState<string>();

  const needsClock =
    operation.kind === 'lightning_receive' &&
    !isTerminalOperationStatus(operation.status) &&
    operation.expiresAtMs !== undefined;
  const nowMs = useCurrentTime(needsClock || recovered !== undefined);

  const incoming = formatOperationDirection(operation) === 'incoming';
  const canRecoverEcash =
    operation.kind === 'ecash_send' &&
    isSecretRecoveryRelevant(operation, nowMs);
  const canRecoverInvoice =
    operation.kind === 'lightning_receive' &&
    isSecretRecoveryRelevant(operation, nowMs);
  const recoveredRelevant =
    recovered !== undefined && isSecretRecoveryRelevant(operation, nowMs);
  const createdAt = new Date(operation.createdAtMs);

  useEffect(
    () => () => {
      recovered?.secret.clear();
    },
    [recovered],
  );

  useEffect(() => {
    if (recovered !== undefined && !recoveredRelevant) {
      recovered.secret.clear();
    }
  }, [recovered, recoveredRelevant]);

  async function recover(purpose: 'ecash-export' | 'lightning-invoice') {
    setBusy(true);
    setError(undefined);
    const result =
      purpose === 'ecash-export'
        ? await onRecoverEcashExport(operation.key)
        : await onRecoverLightningInvoice(operation.key);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    recovered?.secret.clear();
    setRecovered({ purpose, secret: result.value });
    setCopyStatus(undefined);
  }

  return (
    <section
      className="page-shell tx-detail-shell"
      aria-labelledby="tx-detail-title"
    >
      <div className="page-topbar">
        <button
          className="page-close"
          type="button"
          aria-label="Back to activity"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </button>
      </div>
      <div className="tx-detail-hero">
        <span className={`tx-detail-chip ${incoming ? 'is-in' : 'is-out'}`}>
          {incoming ? <ArrowDownLeftIcon /> : <ArrowUpRightIcon />}
        </span>
        <div className="tx-detail-heading">
          <span className="tx-detail-eyebrow">Type</span>
          <h1 id="tx-detail-title" className="tx-detail-type">
            {operationLabel(operation)}
          </h1>
        </div>
      </div>
      <dl className="details-list tx-detail-list">
        <div>
          <dt>Date</dt>
          <dd>
            {createdAt.toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>
            {createdAt.toLocaleTimeString(undefined, {
              hour: 'numeric',
              minute: '2-digit',
            })}
          </dd>
        </div>
      </dl>
      {recovered === undefined && (canRecoverEcash || canRecoverInvoice) && (
        <div className="stack tx-detail-actions">
          {canRecoverEcash && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void recover('ecash-export')}
            >
              {busy ? 'Recovering…' : 'Recover notes'}
            </button>
          )}
          {canRecoverInvoice && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void recover('lightning-invoice')}
            >
              {busy ? 'Recovering…' : 'Recover invoice'}
            </button>
          )}
        </div>
      )}
      {recovered !== undefined && recoveredRelevant && (
        <div className="secret-recovery">
          {recovered.purpose === 'lightning-invoice' && (
            <>
              <p className="fine-print" role="timer" aria-live="polite">
                Expires in{' '}
                {formatCountdown((operation.expiresAtMs ?? nowMs) - nowMs)}.
              </p>
              <QrCode
                contentType="bolt11"
                value={recovered.secret.reveal()}
                label="Recovered Lightning invoice QR code"
              />
            </>
          )}
          <label>
            {recovered.purpose === 'ecash-export'
              ? 'Recovered bearer ecash'
              : 'Recovered Lightning invoice'}
            <textarea
              readOnly
              spellCheck={false}
              value={recovered.secret.reveal()}
            />
          </label>
          <p className="fine-print" aria-live="polite">
            {copyStatus ??
              (recovered.purpose === 'ecash-export'
                ? 'These notes were restored from the encrypted secret record.'
                : 'This invoice was restored from the encrypted secret record.')}
          </p>
          <div className="stack">
            <CopyButton
              secret={recovered.secret}
              label={
                recovered.purpose === 'ecash-export'
                  ? 'Copy recovered notes'
                  : 'Copy recovered invoice'
              }
              onStatus={setCopyStatus}
            />
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                recovered.secret.clear();
                setRecovered(undefined);
              }}
            >
              {recovered.purpose === 'ecash-export'
                ? 'Hide recovered notes'
                : 'Hide recovered invoice'}
            </button>
          </div>
        </div>
      )}
      <ScreenError message={error} />
    </section>
  );
}

const SEED_PLACEHOLDER_COLUMNS = [
  Array.from({ length: 6 }, () => 'secret'),
  Array.from({ length: 6 }, () => 'secret'),
] as const;

function SettingsScreen({
  snapshot,
  onBack,
  onLock,
  onOpenMints,
  onOpenSeed,
  onOpenRecovery,
}: {
  snapshot: WalletSnapshot;
  onBack(): void;
  onLock(): Promise<void>;
  onOpenMints(): void;
  onOpenSeed(): void;
  onOpenRecovery(): void;
}) {
  return (
    <section
      className="page-shell settings-shell"
      aria-labelledby="settings-title"
    >
      <div className="page-topbar">
        <button
          className="page-close"
          type="button"
          aria-label="Back to wallet"
          onClick={onBack}
        >
          <CloseGlyph />
        </button>
      </div>
      <div className="settings-intro">
        <h1 id="settings-title" className="page-title">
          Settings
        </h1>
      </div>
      <div className="settings-list">
        <div className="settings-group">
          <SettingsNavRow
            icon={<WalletGlyph />}
            label="Mints"
            hint={
              snapshot.activeFederation !== undefined
                ? snapshot.activeFederation.displayName
                : 'No mint selected'
            }
            onClick={onOpenMints}
          />
          <SettingsNavRow
            icon={<SeedGlyph />}
            label="Seed & PIN"
            hint="Reveal recovery words"
            onClick={onOpenSeed}
          />
          <SettingsNavRow
            icon={<RecoveryGlyph />}
            label="Erase Wallet"
            hint="Remove this device's data"
            onClick={onOpenRecovery}
          />
          <SettingsNavRow
            icon={<ShieldIcon size={22} />}
            label="Lock wallet"
            hint="Require PIN to unlock"
            trailing="none"
            onClick={() => {
              void onLock();
            }}
          />
        </div>
      </div>
    </section>
  );
}

function SeedWordColumns({
  columns,
  blurred,
}: {
  columns: readonly (readonly string[])[];
  blurred?: boolean;
}) {
  return (
    <div
      className={`word-grid settings-word-grid${blurred === true ? ' is-blurred' : ''}`}
      aria-hidden={blurred === true ? true : undefined}
    >
      {columns.map((column, columnIndex) => (
        <ol
          className="word-col"
          key={columnIndex}
          start={columnIndex * 6 + 1}
          aria-label={
            blurred === true
              ? undefined
              : `Recovery words ${columnIndex * 6 + 1} to ${columnIndex * 6 + column.length}`
          }
        >
          {column.map((word, wordIndex) => {
            const position = columnIndex * 6 + wordIndex + 1;
            return (
              <li className="word-row" key={`${position}-${word}`}>
                <span className="word-num">{position}</span>
                <span className="word-text">{word}</span>
              </li>
            );
          })}
        </ol>
      ))}
    </div>
  );
}

function SeedSettingsScreen({
  onBack,
  onRevealMnemonic,
}: {
  onBack(): void;
  onRevealMnemonic(): Promise<FeatureResult<SecretMnemonic>>;
}) {
  const [mnemonic, setMnemonic] = useState<SecretMnemonic>();
  const aliveRef = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const words = mnemonic?.reveal() ?? [];
  const wordColumns = [words.slice(0, 6), words.slice(6)];

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(
    () => () => {
      mnemonic?.clear();
    },
    [mnemonic],
  );

  async function reveal() {
    setBusy(true);
    setError(undefined);
    const result = await onRevealMnemonic();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!aliveRef.current) {
      result.value.clear();
      return;
    }
    setMnemonic(result.value);
  }

  return (
    <section
      className="page-shell settings-shell"
      aria-labelledby="settings-seed-title"
    >
      <div className="page-topbar">
        <button
          className="page-close"
          type="button"
          aria-label="Back to settings"
          onClick={onBack}
        >
          <CloseGlyph />
        </button>
      </div>
      <div className="settings-intro">
        <h1 id="settings-seed-title" className="page-title">
          Seed & PIN
        </h1>
        <p className="settings-subtitle">
          Write these down in order. Anyone with them can take your money —
          Chascuro can't recover them.
        </p>
      </div>
      <div className="settings-page-body">
        {mnemonic === undefined ? (
          <button
            className="settings-word-reveal"
            type="button"
            disabled={busy}
            aria-label="Reveal recovery words"
            onClick={() => void reveal()}
          >
            <SeedWordColumns columns={SEED_PLACEHOLDER_COLUMNS} blurred />
            <span className="settings-word-reveal-label">
              {busy ? 'Revealing…' : 'Tap to reveal'}
            </span>
          </button>
        ) : (
          <>
            <SeedWordColumns columns={wordColumns} />
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                mnemonic.clear();
                setMnemonic(undefined);
              }}
            >
              Hide recovery words
            </button>
          </>
        )}
        <ScreenError message={error} />
      </div>
    </section>
  );
}

function RecoverySettingsScreen({
  onBack,
  onErase,
}: {
  onBack(): void;
  onErase(typedConfirmation: string): Promise<FeatureResult<void>>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [eraseConfirmation, setEraseConfirmation] = useState('');

  async function erase() {
    setBusy(true);
    setError(undefined);
    const result = await onErase(eraseConfirmation);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
    }
  }

  return (
    <section
      className="page-shell settings-shell"
      aria-labelledby="settings-recovery-title"
    >
      <div className="page-topbar">
        <button
          className="page-close"
          type="button"
          aria-label="Back to settings"
          onClick={onBack}
        >
          <CloseGlyph />
        </button>
      </div>
      <div className="settings-intro">
        <h1 id="settings-recovery-title" className="page-title">
          Erase Wallet
        </h1>
        <p className="settings-subtitle">
          This removes app records, the verified SDK database file, caches, and
          service workers. It cannot revoke ecash already exported.
        </p>
      </div>
      <div className="settings-page-body">
        <div className="settings-danger">
          <label className="settings-field">
            <span>Type ERASE to confirm</span>
            <input
              autoComplete="off"
              value={eraseConfirmation}
              onChange={(event) => setEraseConfirmation(event.target.value)}
            />
          </label>
          <button
            className="settings-danger-action"
            type="button"
            disabled={busy || eraseConfirmation !== 'ERASE'}
            onClick={() => void erase()}
          >
            {busy ? 'Erasing…' : 'Erase wallet data'}
          </button>
        </div>
        <ScreenError message={error} />
      </div>
    </section>
  );
}

function mintNameFromAccounts(
  federations: WalletSnapshot['federations'],
  federationId: string,
): string {
  return (
    federations.find(
      (account) => account.federation.federationId === federationId,
    )?.federation.displayName ?? 'Mint'
  );
}
