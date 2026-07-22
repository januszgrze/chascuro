import { useEffect, useRef, useState } from 'react';

import {
  classifyWalletInput,
  formatMsatsAsSats,
  isTerminalOperationStatus,
  parsePositiveSats,
  type ClearableSecretText,
  type EcashExport,
  type EcashPreview,
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
import type { WalletSecuritySettings } from '../../services/persistence/schemas/wallet-settings-record';
import type { WalletSnapshot } from '../../services/wallet';
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
  LinkIcon,
  PasteIcon,
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
  SettingsRow,
  ShareButton,
  WalletDock,
  WalletGlyph,
} from './wallet-screen-components';
import {
  ACTIVITY_PAGE_SIZE,
  BACKGROUND_TIMEOUT_OPTIONS,
  findOperation,
  formatCountdown,
  formatOperationDirection,
  formatOperationStatus,
  INACTIVITY_TIMEOUT_OPTIONS,
  isSecretRecoveryRelevant,
  lightningInvoiceUnavailableTitle,
  operationLabel,
  parseTimeoutSelectValue,
  timeoutSelectValue,
  useCurrentTime,
} from './wallet-screen-helpers';

interface PaymentNavProps {
  onNavigate(rail: PaymentRail, direction: PaymentDirection): void;
  onHome(): void;
}

type FeatureResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

interface HomeScreenProps {
  snapshot: WalletSnapshot;
  securitySettings: WalletSecuritySettings;
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
  onUpdateSecuritySettings(
    inactivityTimeoutMs: number | null,
    backgroundTimeoutMs: number | null,
  ): Promise<FeatureResult<WalletSecuritySettings>>;
  onErase(typedConfirmation: string): Promise<FeatureResult<void>>;
  onOpenChat?: () => void;
  autoFocusChat?: boolean;
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
  | 'settings';

const HOME_VIEW_DEPTH: Record<HomeView, number> = {
  home: 0,
  'ecash-receive': 1,
  'ecash-send': 1,
  'lightning-receive': 1,
  'lightning-send': 1,
  activity: 1,
  settings: 1,
};

function resolveDirection(
  from: HomeView,
  to: HomeView,
): ViewTransitionDirection {
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
  const transitionTo = (next: HomeView) => {
    runViewTransition(resolveDirection(viewRef.current, next), () => {
      viewRef.current = next;
      setView(next);
    });
  };
  const navigate = (rail: PaymentRail, direction: PaymentDirection) =>
    transitionTo(`${rail}-${direction}` as HomeView);
  const goHome = () => transitionTo('home');

  switch (view) {
    case 'ecash-receive':
      return (
        <EcashReceiveScreen
          onNavigate={navigate}
          onHome={goHome}
          onParse={props.onParseEcash}
          onRedeem={props.onRedeemEcash}
        />
      );
    case 'ecash-send':
      return (
        <EcashSendScreen
          onNavigate={navigate}
          onHome={goHome}
          onCreate={props.onCreateEcashSpend}
        />
      );
    case 'lightning-receive':
      return (
        <LightningReceiveScreen
          enabled={
            props.snapshot.capabilities?.lightning === true &&
            props.snapshot.capabilities.gatewayAvailable === true
          }
          operations={props.snapshot.operations}
          onNavigate={navigate}
          onHome={goHome}
          onCreate={props.onCreateLightningInvoice}
        />
      );
    case 'lightning-send':
      return (
        <LightningSendScreen
          enabled={props.snapshot.capabilities?.lightningSend === 'enabled'}
          operations={props.snapshot.operations}
          onNavigate={navigate}
          onHome={goHome}
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
          securitySettings={props.securitySettings}
          onBack={goHome}
          onRevealMnemonic={props.onRevealMnemonic}
          onUpdateSecuritySettings={props.onUpdateSecuritySettings}
          onErase={props.onErase}
          onLock={props.onLock}
          onOpenChat={props.onOpenChat}
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
        <span className="balance-label">BALANCE</span>
        <p className="balance-amount" aria-live="polite">
          <BitcoinMark className="amount-symbol" />
          <span className="amount-value">
            {formatMsatsAsSats(snapshot.balanceMsats)}
          </span>
          <span className="visually-hidden">
            Balance {formatMsatsAsSats(snapshot.balanceMsats)} sats
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
                    {formatOperationStatus(operation.status)}
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
          <BitcoinMark />
        </span>
        <button
          className="home-nav-btn"
          type="button"
          aria-label="Send"
          onClick={() => onNavigate('lightning-send')}
        >
          <ArrowUpIcon />
        </button>
        <button
          className="home-nav-btn"
          type="button"
          aria-label="Receive"
          onClick={() => onNavigate('ecash-receive')}
        >
          <ArrowDownIcon />
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
  onParse,
  onRedeem,
}: PaymentNavProps & {
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

  async function runParse(input: string) {
    setError(undefined);
    setBusy(true);
    const result = await onParse(input);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setManual('');
    setShowManual(false);
    setPreview(result.value);
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
      setShowManual(true);
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length > 0) {
        await capture(text);
      }
    } catch {
      setShowManual(true);
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
    setOperation(result.value.operation);
  }

  if (operation !== undefined) {
    return (
      <ResultScreen
        titleId="ecash-receive-title"
        tone="success"
        direction="in"
        title="Received"
        amountSats={
          operation.amountMsats === undefined
            ? undefined
            : formatMsatsAsSats(operation.amountMsats)
        }
      >
        <button className="cta-pay" type="button" onClick={onHome}>
          <CheckIcon size={20} />
          Done
        </button>
      </ResultScreen>
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
            ? 'Compatible with your federation'
            : "Different federation — can't redeem here"
        }
        onBack={() => setPreview(undefined)}
        error={error}
      >
        <button
          className="cta-pay"
          type="button"
          disabled={busy || !preview.compatible}
          onClick={() => void redeem()}
        >
          <ArrowDownIcon size={20} />
          {busy ? 'Redeeming…' : 'Redeem'}
        </button>
      </ResultScreen>
    );
  }

  return (
    <SendReceiveShell
      rail="ecash"
      direction="receive"
      variant="dark"
      onNavigate={onNavigate}
      onHome={onHome}
      onKeyboard={() => setShowManual((current) => !current)}
    >
      <div className="scan-body">
        <QrScanner
          variant="framed"
          disabled={busy}
          onScan={(value) => void capture(value)}
        />
        {showManual && (
          <div className="scan-manual">
            <textarea
              ref={manualInputRef}
              aria-label="Ecash notes"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste ecash note"
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
        )}
        {error !== undefined && (
          <p className="scan-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="scan-paste"
          type="button"
          disabled={busy}
          onClick={() => void pasteFromClipboard()}
        >
          <PasteIcon />
          Paste ecash note
        </button>
      </div>
    </SendReceiveShell>
  );
}

function EcashSendScreen({
  onNavigate,
  onHome,
  onCreate,
}: PaymentNavProps & {
  onCreate(amountSats: string): Promise<FeatureResult<EcashExport>>;
}) {
  const [amount, setAmount] = useState('');
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

  async function create() {
    setBusy(true);
    setError(undefined);
    const result = await onCreate(amount);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSentAmount(amount);
    setExported(result.value);
    setAmount('');
  }

  function discard() {
    exported?.notes.clear();
    setExported(undefined);
    setSentAmount(undefined);
    setCopyStatus(undefined);
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
              value={exported.notes.reveal()}
              label="Ecash notes QR code"
            />
          </div>
          <ShareButton
            secret={exported.notes}
            label="Share link"
            title="Ecash payment"
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

  return (
    <SendReceiveShell
      rail="ecash"
      direction="send"
      variant="light"
      onNavigate={onNavigate}
      onHome={onHome}
    >
      <AmountKeypad value={amount} onChange={setAmount} disabled={busy} />
      <ScreenError message={error} />
      <button
        className="cta-send"
        type="button"
        disabled={!ready || busy}
        onClick={() => void create()}
      >
        <LinkIcon size={20} />
        {busy ? 'Generating…' : 'Create link'}
      </button>
    </SendReceiveShell>
  );
}

function LightningReceiveScreen({
  enabled,
  operations,
  onNavigate,
  onHome,
  onCreate,
}: PaymentNavProps & {
  enabled: boolean;
  operations: readonly WalletOperation[];
  onCreate(
    amountSats: string,
    description: string,
  ): Promise<FeatureResult<LightningReceive>>;
}) {
  const [amount, setAmount] = useState('');
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
    setReceive(result.value);
    setAmount('');
  }

  function discard() {
    receive?.invoice.clear();
    setReceive(undefined);
    setCopyStatus(undefined);
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

  if (receive === undefined) {
    return (
      <SendReceiveShell
        rail="lightning"
        direction="receive"
        variant="light"
        onNavigate={onNavigate}
        onHome={onHome}
      >
        <AmountKeypad value={amount} onChange={setAmount} disabled={busy} />
        <ScreenError message={error} />
        <button
          className="cta-send"
          type="button"
          disabled={!ready || busy}
          onClick={() => void create()}
        >
          <BoltIcon size={20} />
          {busy ? 'Creating…' : 'Create invoice'}
        </button>
      </SendReceiveShell>
    );
  }

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
      >
        <button className="cta-pay" type="button" onClick={onHome}>
          <CheckIcon size={20} />
          Done
        </button>
      </ResultScreen>
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
              The invoice has been cleared from this screen and can no longer be
              presented as payable.
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

function LightningSendScreen({
  enabled,
  operations,
  onNavigate,
  onHome,
  onQuote,
  onResolveLnurl,
  onQuoteLnurl,
  onPay,
}: PaymentNavProps & {
  enabled: boolean;
  operations: readonly WalletOperation[];
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const manualInputRef = useRef<HTMLTextAreaElement>(null);
  const nowMs = useCurrentTime(review !== undefined);
  const feeLimitSats = '10';

  useEffect(() => {
    if (showManual) {
      manualInputRef.current?.focus();
    }
  }, [showManual]);

  async function runQuote(input: string) {
    setError(undefined);
    setBusy(true);
    const result = await onQuote(input, feeLimitSats);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setManual('');
    setShowManual(false);
    setReview(result.value);
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
    setManual('');
    setShowManual(false);
    setAmount('');
    setOffer(result.value);
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
    setReview(result.value);
  }

  async function pasteFromClipboard() {
    if (navigator.clipboard === undefined) {
      setShowManual(true);
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length > 0) {
        await submitPaymentTarget(text);
      }
    } catch {
      setShowManual(true);
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
    setOperation(result.value.operation);
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

  if (operation !== undefined) {
    const liveOperation = findOperation(operations, operation.key) ?? operation;
    const settled = liveOperation.status === 'settled';
    const unsuccessful =
      isTerminalOperationStatus(liveOperation.status) && !settled;
    const successAction = settled ? review?.successAction : undefined;
    return (
      <ResultScreen
        titleId="lightning-send-title"
        tone={settled ? 'success' : 'pending'}
        direction="out"
        title={
          settled
            ? 'Sent'
            : unsuccessful
              ? 'Payment not completed'
              : 'Payment pending'
        }
        amountSats={
          liveOperation.amountMsats === undefined
            ? undefined
            : formatMsatsAsSats(liveOperation.amountMsats)
        }
        subtitle={
          unsuccessful
            ? 'Review Activity before trying this payment again.'
            : settled
              ? undefined
              : 'Waiting for the Lightning payment to settle.'
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
        <button className="cta-pay" type="button" onClick={onHome}>
          <CheckIcon size={20} />
          Done
        </button>
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
      <section className="confirm-shell" aria-labelledby="lightning-send-title">
        <div className="confirm-topbar">
          <button
            className="confirm-back"
            type="button"
            aria-label="Back"
            disabled={busy}
            onClick={() => {
              setOffer(undefined);
              setAmount('');
              setError(undefined);
            }}
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
        {amount.length > 0 && amountError !== undefined && (
          <p className="scan-error" role="alert">
            {amountError}
          </p>
        )}
        <ScreenError message={error} />
        <button
          className="cta-pay"
          type="button"
          disabled={busy || amountError !== undefined}
          onClick={() => void quoteLnurl()}
        >
          <BoltIcon size={20} />
          {busy ? 'Requesting invoice…' : 'Review payment'}
        </button>
      </section>
    );
  }

  if (review !== undefined) {
    const amountLabel = formatMsatsAsSats(review.quote.amountMsats);
    return (
      <section className="confirm-shell" aria-labelledby="lightning-send-title">
        <div className="confirm-topbar">
          <button
            className="confirm-back"
            type="button"
            aria-label="Back"
            disabled={busy}
            onClick={() => {
              setReview(undefined);
              setError(undefined);
            }}
          >
            <ChevronLeftIcon />
          </button>
          <h1 id="lightning-send-title" className="confirm-title">
            Pay invoice
          </h1>
        </div>
        <div className="confirm-amount">
          <BitcoinMark className="amount-symbol" />
          <span className="amount-value">{amountLabel}</span>
        </div>
        <div className="pay-card">
          <div className="pay-row">
            <span className="pay-label">To</span>
            <span className="pay-value">
              {review.preview.payeeHint ?? 'Lightning invoice'}
            </span>
          </div>
          {review.preview.description !== undefined && (
            <div className="pay-row">
              <span className="pay-label">Description</span>
              <span className="pay-value">{review.preview.description}</span>
            </div>
          )}
          <div className="pay-row">
            <span className="pay-label">Network fee</span>
            <span className="pay-value">
              <BitcoinMark className="btc-symbol" />{' '}
              {formatMsatsAsSats(review.quote.feeMsats)}
            </span>
          </div>
          <div className="pay-row">
            <span className="pay-label">Network</span>
            <span className="pay-value">{review.preview.network}</span>
          </div>
          <div className="pay-row">
            <span className="pay-label">Expires in</span>
            <span className="pay-value">
              {formatCountdown(review.quote.expiresAtMs - nowMs)}
            </span>
          </div>
        </div>
        <ScreenError message={error} />
        <button
          className="cta-pay"
          type="button"
          disabled={busy}
          onClick={() => void pay()}
        >
          <BoltIcon size={20} />
          {busy ? (
            'Submitting…'
          ) : (
            <>
              Pay <BitcoinMark className="btc-symbol" /> {amountLabel}
            </>
          )}
        </button>
      </section>
    );
  }

  return (
    <SendReceiveShell
      rail="lightning"
      direction="send"
      variant="dark"
      onNavigate={onNavigate}
      onHome={onHome}
      onKeyboard={() => setShowManual((current) => !current)}
    >
      <div className="scan-body">
        <QrScanner
          variant="framed"
          disabled={busy}
          onScan={(value) => void submitPaymentTarget(value)}
        />
        {showManual && (
          <div className="scan-manual">
            <textarea
              ref={manualInputRef}
              aria-label="Lightning payment request"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste payment URL"
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
        )}
        {error !== undefined && (
          <p className="scan-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="scan-paste"
          type="button"
          disabled={busy}
          onClick={() => void pasteFromClipboard()}
        >
          <PasteIcon />
          Paste payment URL
        </button>
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
  onBack,
  onReconcile,
  onRecoverEcashExport,
  onRecoverLightningInvoice,
  onOpenChat,
}: {
  operations: readonly WalletOperation[];
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
                      {formatOperationStatus(operation.status)}
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
    <section className="page-shell" aria-labelledby="tx-detail-title">
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

function SettingsScreen({
  snapshot,
  securitySettings,
  onBack,
  onRevealMnemonic,
  onUpdateSecuritySettings,
  onErase,
  onLock,
  onOpenChat,
}: {
  snapshot: WalletSnapshot;
  securitySettings: WalletSecuritySettings;
  onBack(): void;
  onRevealMnemonic(): Promise<FeatureResult<SecretMnemonic>>;
  onUpdateSecuritySettings(
    inactivityTimeoutMs: number | null,
    backgroundTimeoutMs: number | null,
  ): Promise<FeatureResult<WalletSecuritySettings>>;
  onErase(typedConfirmation: string): Promise<FeatureResult<void>>;
  onLock(): Promise<void>;
  onOpenChat?: () => void;
}) {
  const [mnemonic, setMnemonic] = useState<SecretMnemonic>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [eraseConfirmation, setEraseConfirmation] = useState('');
  const [inactivityTimeoutMs, setInactivityTimeoutMs] = useState<number | null>(
    securitySettings.inactivityTimeoutMs,
  );
  const [backgroundTimeoutMs, setBackgroundTimeoutMs] = useState<number | null>(
    securitySettings.backgroundTimeoutMs,
  );
  const [settingsStatus, setSettingsStatus] = useState<string>();
  const words = mnemonic?.reveal() ?? [];
  const automaticLockDisabled =
    inactivityTimeoutMs === null && backgroundTimeoutMs === null;

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
    setMnemonic(result.value);
  }

  async function erase() {
    setBusy(true);
    setError(undefined);
    const result = await onErase(eraseConfirmation);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
    }
  }

  async function updateAutomaticLock() {
    if (automaticLockDisabled) {
      return;
    }
    setBusy(true);
    setError(undefined);
    setSettingsStatus(undefined);
    const result = await onUpdateSecuritySettings(
      inactivityTimeoutMs,
      backgroundTimeoutMs,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSettingsStatus('Automatic lock settings saved.');
  }

  return (
    <section className="page-shell" aria-labelledby="settings-title">
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
      <h1 id="settings-title" className="page-title">
        Settings
      </h1>
      <div className="settings-list">
        <SettingsRow icon={<WalletGlyph />} label="Wallet">
          <dl className="details-list">
            <div>
              <dt>Federation</dt>
              <dd>{snapshot.activeFederation?.displayName ?? 'Unknown'}</dd>
            </div>
          </dl>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              mnemonic?.clear();
              setMnemonic(undefined);
              void onLock();
            }}
          >
            Lock wallet
          </button>
        </SettingsRow>
        <SettingsRow icon={<SeedGlyph />} label="Seed & PIN">
          {mnemonic === undefined ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void reveal()}
            >
              {busy ? 'Revealing…' : 'Reveal recovery words'}
            </button>
          ) : (
            <>
              <div className="notice">
                <strong>Private recovery material</strong>
                <p>
                  Hide these words before handing the device to anyone else.
                </p>
              </div>
              <ol className="mnemonic-grid">
                {words.map((word, index) => (
                  <li key={`${index}-${word}`}>
                    <span>{index + 1}</span>
                    <strong>{word}</strong>
                  </li>
                ))}
              </ol>
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
        </SettingsRow>
        <SettingsRow icon={<LinkIcon size={22} />} label="Network">
          <dl className="details-list">
            <div>
              <dt>Network</dt>
              <dd>{snapshot.activeFederation?.network ?? 'unknown'}</dd>
            </div>
            <div>
              <dt>Recovery</dt>
              <dd>{snapshot.capabilities?.recovery ?? 'unknown'}</dd>
            </div>
          </dl>
        </SettingsRow>
        <SettingsRow icon={<GearIcon size={22} />} label="Advanced">
          <div className="stack" aria-labelledby="automatic-lock-title">
            <h2 id="automatic-lock-title" className="settings-panel-title">
              Automatic lock
            </h2>
            <label>
              Lock after inactivity
              <select
                value={timeoutSelectValue(inactivityTimeoutMs)}
                onChange={(event) => {
                  setInactivityTimeoutMs(
                    parseTimeoutSelectValue(event.target.value),
                  );
                  setSettingsStatus(undefined);
                }}
              >
                {INACTIVITY_TIMEOUT_OPTIONS.map((option) => (
                  <option
                    key={option.label}
                    value={timeoutSelectValue(option.ms)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Lock while in background
              <select
                value={timeoutSelectValue(backgroundTimeoutMs)}
                onChange={(event) => {
                  setBackgroundTimeoutMs(
                    parseTimeoutSelectValue(event.target.value),
                  );
                  setSettingsStatus(undefined);
                }}
              >
                {BACKGROUND_TIMEOUT_OPTIONS.map((option) => (
                  <option
                    key={option.label}
                    value={timeoutSelectValue(option.ms)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {automaticLockDisabled && (
              <p className="fine-print" role="alert">
                At least one automatic lock must remain enabled.
              </p>
            )}
            {settingsStatus !== undefined && (
              <p className="fine-print" role="status">
                {settingsStatus}
              </p>
            )}
          </div>
        </SettingsRow>
        <SettingsRow icon={<RecoveryGlyph />} label="Wallet Recovery">
          <div className="danger-zone">
            <h2>Erase this device</h2>
            <p className="fine-print">
              This removes app records, the verified SDK database file, caches,
              and service workers. It cannot revoke ecash already exported.
            </p>
            <label>
              Type ERASE
              <input
                autoComplete="off"
                value={eraseConfirmation}
                onChange={(event) => setEraseConfirmation(event.target.value)}
              />
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || eraseConfirmation !== 'ERASE'}
              onClick={() => void erase()}
            >
              {busy ? 'Erasing…' : 'Erase wallet data'}
            </button>
          </div>
        </SettingsRow>
      </div>
      <ScreenError message={error} />
      <button
        className="cta-pill settings-save"
        type="button"
        disabled={busy || automaticLockDisabled}
        onClick={() => void updateAutomaticLock()}
      >
        {busy ? 'Saving…' : 'Save Settings'}
      </button>
    </section>
  );
}
