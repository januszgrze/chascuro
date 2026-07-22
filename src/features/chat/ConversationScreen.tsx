import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import {
  sanitizeChatText,
  type ChatMessage,
  type ChatMessageId,
  type ChatPayment,
  type ChatPaymentStatus,
  type EcashExport,
  type WalletOperation,
} from '../../domain';
import { BitcoinMark } from '../shared/BitcoinMark';
import { Keypad } from '../shared/Keypad';
import { QrCode } from '../shared/QrCode';
import { ScreenError } from '../shared/ScreenFrame';
import { shareText } from '../shared/share';
import { useChat } from './chat-context';

const MESSAGE_PAGE_SIZE = 20;
const MAX_MESSAGE_BYTES = 4_096;
const BYTE_COUNTER_THRESHOLD = 3_500;

type ComposerPanel = 'none' | 'tray' | 'stickers';

export function ConversationScreen() {
  const { controller, location, navigate, state, walletPayments } = useChat();
  const conversationId = location.selectedConversationId;
  const conversation = state.snapshot.conversations.find(
    ({ id }) => id === conversationId,
  );
  const conversationExists = conversation !== undefined;
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [draft, setDraft] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const [panel, setPanel] = useState<ComposerPanel>('none');
  const [payments, setPayments] = useState<readonly ChatPayment[]>([]);
  const [paySheetOpen, setPaySheetOpen] = useState(false);
  const [paySuccess, setPaySuccess] = useState<number>();
  const [recoveryExport, setRecoveryExport] = useState<EcashExport>();
  const recoveryExportRef = useRef<EcashExport | undefined>(undefined);
  const pageAbort = useRef<AbortController | undefined>(undefined);
  const submissionAbort = useRef<AbortController | undefined>(undefined);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messageBytes = useMemo(
    () => new TextEncoder().encode(draft.normalize('NFC')).length,
    [draft],
  );
  const sending =
    conversationId !== undefined && state.busy.includes(conversationId);
  const loadingPage = state.busy.some((key) =>
    key.startsWith(`page:${conversationId ?? 'missing'}:`),
  );
  const offline = state.snapshot.syncState === 'offline';

  useEffect(() => {
    if (conversationId === undefined || !conversationExists) return;
    const abort = new AbortController();
    pageAbort.current?.abort();
    pageAbort.current = abort;
    void Promise.all([
      controller.listMessages(
        conversationId,
        undefined,
        MESSAGE_PAGE_SIZE,
        abort.signal,
      ),
      controller.listPayments(conversationId, abort.signal),
    ])
      .then(([page, loadedPayments]) => {
        if (abort.signal.aborted) return;
        setMessages(normalizeMessages(page.messages));
        setPayments(loadedPayments);
        setNextCursor(page.nextCursor);
      })
      .catch(() => undefined);
    return () => {
      abort.abort();
      submissionAbort.current?.abort();
    };
  }, [controller, conversationExists, conversationId]);

  useEffect(
    () => () => {
      recoveryExportRef.current?.notes.clear();
      recoveryExportRef.current = undefined;
    },
    [],
  );

  if (conversationId === undefined || conversation === undefined) {
    return (
      <section className="chat-shell" aria-labelledby="conversation-title">
        <div className="page-topbar chat-topbar">
          <button
            className="home-icon-btn"
            type="button"
            aria-label="Back to chats"
            onClick={() => navigate('chat-list')}
          >
            <ChevronGlyph />
          </button>
        </div>
        <div className="chat-conversation-unavailable">
          <h1 id="conversation-title" className="page-title">
            Conversation unavailable
          </h1>
          <p className="home-empty">
            This conversation is no longer available on this device.
          </p>
          <button
            className="cta-pill"
            type="button"
            onClick={() => navigate('chat-list')}
          >
            Back to chats
          </button>
        </div>
      </section>
    );
  }

  const activeConversationId = conversationId;
  const activeConversation = conversation;
  const draftValid = isValidMessageDraft(draft);
  const statusLabel = conversationStatus(
    activeConversation.removed,
    offline,
    state.snapshot.syncState,
  );

  async function loadNextPage() {
    if (nextCursor === undefined || loadingPage) return;
    const abort = new AbortController();
    pageAbort.current?.abort();
    pageAbort.current = abort;
    try {
      const page = await controller.listMessages(
        activeConversationId,
        nextCursor,
        MESSAGE_PAGE_SIZE,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setMessages((current) =>
        normalizeMessages([...current, ...page.messages]),
      );
      setNextCursor(page.nextCursor);
    } catch {
      // The controller exposes the bounded public error.
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || activeConversation.removed) return;
    let text: string;
    try {
      text = readMessageDraft(draft);
    } catch {
      setValidationError(messageValidationError(draft));
      return;
    }
    const abort = new AbortController();
    submissionAbort.current?.abort();
    submissionAbort.current = abort;
    setValidationError(undefined);
    try {
      const sent = await controller.sendMessage(
        activeConversationId,
        text,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setMessages((current) => normalizeMessages([...current, sent]));
      setDraft('');
      queueMicrotask(() => composerRef.current?.focus());
    } catch {
      // The controller exposes the bounded public error.
    }
  }

  async function retryMessage(messageId: ChatMessageId) {
    if (sending || activeConversation.removed) return;
    const abort = new AbortController();
    submissionAbort.current?.abort();
    submissionAbort.current = abort;
    try {
      const retried = await controller.retryMessage(
        activeConversationId,
        messageId,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setMessages((current) =>
        normalizeMessages(
          current.map((message) =>
            message.id === retried.id ? retried : message,
          ),
        ),
      );
    } catch {
      // The controller exposes the bounded public error.
    }
  }

  async function sendSticker(sticker: string) {
    if (sending || activeConversation.removed) return;
    const abort = new AbortController();
    submissionAbort.current?.abort();
    submissionAbort.current = abort;
    try {
      const sent = await controller.sendMessage(
        activeConversationId,
        sticker,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setMessages((current) => normalizeMessages([...current, sent]));
      setPanel('none');
    } catch {
      // The controller exposes the bounded public error.
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function completePayment(amountSats: number) {
    if (walletPayments === undefined) return;
    setValidationError(undefined);
    const result = await walletPayments.send(
      activeConversation.id,
      String(amountSats),
    );
    if (!result.ok) {
      setValidationError(result.error);
      return;
    }
    setPaySheetOpen(false);
    setPanel('none');
    if (result.value.kind === 'recovery_required') {
      recoveryExportRef.current?.notes.clear();
      recoveryExportRef.current = result.value.export;
      setRecoveryExport(result.value.export);
      return;
    }
    const payment = result.value.payment;
    setPayments((current) => normalizePayments([...current, payment]));
    if (payment.status === 'failed') {
      setValidationError(
        'Ecash was created but could not be published. Retry from the payment card.',
      );
      return;
    }
    setPaySuccess(amountSats);
  }

  function closeRecoveryExport() {
    recoveryExportRef.current?.notes.clear();
    recoveryExportRef.current = undefined;
    setRecoveryExport(undefined);
  }

  async function claimPayment(payment: ChatPayment) {
    if (walletPayments === undefined) return;
    setValidationError(undefined);
    const result = await walletPayments.claim(payment.id);
    if (!result.ok) {
      setValidationError(result.error);
      return;
    }
    setPayments((current) =>
      current.map((item) =>
        item.id === payment.id ? { ...item, status: 'claimed' } : item,
      ),
    );
  }

  async function retryPayment(payment: ChatPayment) {
    try {
      const retried = await controller.retryPayment(
        activeConversation.id,
        payment.id,
        new AbortController().signal,
      );
      setPayments((current) =>
        normalizePayments(
          current.map((item) => (item.id === payment.id ? retried : item)),
        ),
      );
    } catch {
      // The controller exposes the bounded public error.
    }
  }

  return (
    <section className="chat-conversation" aria-labelledby="conversation-title">
      <ConversationHeader
        title={activeConversation.title}
        onBack={() => navigate('chat-list')}
        onDetails={() =>
          navigate('chat-details', { conversationId: activeConversation.id })
        }
      />

      {statusLabel !== undefined && (
        <p
          className="chat-conversation-status"
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </p>
      )}
      {activeConversation.removed && (
        <div className="notice chat-conversation-notice" role="note">
          You can read saved history, but you can no longer send messages here.
        </div>
      )}
      <ScreenError message={validationError ?? state.error?.message} />

      <div className="chat-message-scroll">
        <h1 id="conversation-title" className="visually-hidden">
          Conversation with {activeConversation.title}
        </h1>
        {nextCursor !== undefined && (
          <button
            className="chat-load-more"
            type="button"
            disabled={loadingPage}
            onClick={() => void loadNextPage()}
          >
            {loadingPage ? 'Loading…' : 'Load more messages'}
          </button>
        )}
        {loadingPage && (
          <p className="chat-history-status" role="status">
            Loading messages…
          </p>
        )}
        {messages.length === 0 && !loadingPage ? (
          <p className="home-empty">No messages yet. Say hello.</p>
        ) : (
          <>
            <DateDivider atMs={messages[0]?.sentAtMs} />
            <ol className="chat-message-list" aria-label="Message history">
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  offline={offline}
                  retrying={sending}
                  onRetry={() => void retryMessage(message.id)}
                />
              ))}
            </ol>
          </>
        )}
        <ul className="chat-payment-list" aria-label="Payments">
          {payments.map((payment) => (
            <PaymentCard
              key={payment.id}
              payment={payment}
              counterparty={activeConversation.title}
              status={paymentStatus(payment, walletPayments?.operations ?? [])}
              onClaim={() => void claimPayment(payment)}
              onRetry={() => void retryPayment(payment)}
            />
          ))}
        </ul>
      </div>

      {!activeConversation.removed && (
        <div className="chat-composer-dock">
          {panel === 'stickers' && (
            <StickerPanel onSend={(sticker) => void sendSticker(sticker)} />
          )}
          {panel === 'tray' && (
            <ComposerTray
              paymentEnabled={walletPayments !== undefined}
              onPay={() => setPaySheetOpen(true)}
              onStickers={() => setPanel('stickers')}
            />
          )}
          <form
            className="chat-composer"
            onSubmit={(event) => void submitMessage(event)}
          >
            <button
              className={`chat-composer-plus${panel !== 'none' ? ' is-open' : ''}`}
              type="button"
              aria-label={panel === 'none' ? 'More actions' : 'Close actions'}
              aria-expanded={panel !== 'none'}
              onClick={() =>
                setPanel((current) => (current === 'none' ? 'tray' : 'none'))
              }
            >
              <PlusGlyph />
            </button>
            <div className="chat-composer-field">
              <label className="visually-hidden" htmlFor="chat-message-draft">
                Message
              </label>
              <textarea
                ref={composerRef}
                id="chat-message-draft"
                className="chat-composer-input"
                placeholder={
                  offline ? 'Message will send when online' : 'Message'
                }
                rows={1}
                value={draft}
                disabled={sending}
                aria-describedby="chat-message-limit"
                onFocus={() => setPanel('none')}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setValidationError(undefined);
                  controller.clearError();
                }}
                onKeyDown={handleComposerKeyDown}
              />
              <button
                className="chat-send-button"
                type="submit"
                aria-label="Send message"
                disabled={!draftValid || sending}
              >
                <SendArrowGlyph />
              </button>
            </div>
            <span
              id="chat-message-limit"
              className={`chat-message-limit${
                messageBytes > MAX_MESSAGE_BYTES
                  ? ' is-over'
                  : messageBytes > BYTE_COUNTER_THRESHOLD
                    ? ' is-warn'
                    : ''
              }`}
            >
              {messageBytes} / {MAX_MESSAGE_BYTES} bytes
            </span>
          </form>
        </div>
      )}

      {paySheetOpen && (
        <PaySheet
          counterparty={activeConversation.title}
          onClose={() => setPaySheetOpen(false)}
          onSend={(amountSats) => void completePayment(amountSats)}
        />
      )}
      {paySuccess !== undefined && (
        <PaySuccessSheet
          amountSats={paySuccess}
          counterparty={activeConversation.title}
          onDone={() => setPaySuccess(undefined)}
        />
      )}
      {recoveryExport !== undefined && (
        <EcashRecoverySheet
          exported={recoveryExport}
          onDone={closeRecoveryExport}
        />
      )}
    </section>
  );
}

function ConversationHeader({
  title,
  onBack,
  onDetails,
}: {
  title: string;
  onBack: () => void;
  onDetails: () => void;
}) {
  return (
    <div className="chat-conv-header">
      <button
        className="chat-conv-back"
        type="button"
        aria-label="Back to chats"
        onClick={onBack}
      >
        <ChevronGlyph />
      </button>
      <button
        className="chat-conv-identity"
        type="button"
        aria-label={`${title} details`}
        onClick={onDetails}
      >
        <span className="chat-conv-avatar" aria-hidden="true">
          {initials(title)}
        </span>
        <span className="chat-conv-name">{title}</span>
      </button>
      <span className="chat-conv-spacer" aria-hidden="true" />
    </div>
  );
}

function DateDivider({ atMs }: { atMs?: number }) {
  const label =
    atMs === undefined
      ? 'Today'
      : `Today ${new Intl.DateTimeFormat(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(atMs))}`;
  return <div className="chat-date-divider">{label}</div>;
}

function MessageBubble({
  message,
  offline,
  retrying,
  onRetry,
}: {
  message: ChatMessage;
  offline: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const outgoing = message.direction === 'outgoing';
  return (
    <li className={`chat-message ${outgoing ? 'is-outgoing' : 'is-incoming'}`}>
      <div className="chat-message-bubble">{message.text}</div>
      {outgoing && (
        <div className="chat-delivery" aria-live="polite">
          <span>{deliveryLabel(message, offline)}</span>
          {message.delivery === 'failed' && (
            <button type="button" disabled={retrying} onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function PaymentCard({
  payment,
  counterparty,
  status,
  onClaim,
  onRetry,
}: {
  payment: ChatPayment;
  counterparty: string;
  status: ChatPaymentStatus;
  onClaim: () => void;
  onRetry: () => void;
}) {
  const outgoing = payment.direction === 'outgoing';
  const firstName = counterparty.split(/\s+/u)[0] ?? 'they';
  return (
    <li className={`chat-payment ${outgoing ? 'is-outgoing' : 'is-incoming'}`}>
      <div className="chat-payment-card">
        <span className="chat-payment-label">
          {outgoing ? 'You sent' : `${firstName} sent you`}
        </span>
        <span className="chat-payment-amount">
          <BitcoinMark className="chat-payment-symbol" />
          {formatSats(payment.amountSats)}
        </span>
        {status === 'claimed' && (
          <span className="chat-payment-status">
            <ClaimedGlyph />
            Claimed
          </span>
        )}
        {status === 'pending' && (
          <span className="chat-payment-status is-pending">
            <ClockGlyph />
            Waiting to claim
          </span>
        )}
        {status === 'claimable' && (
          <button
            className="chat-payment-claim"
            type="button"
            onClick={onClaim}
          >
            <ClaimArrowGlyph />
            Claim
          </button>
        )}
        {status === 'failed' && (
          <button
            className="chat-payment-claim"
            type="button"
            onClick={onRetry}
          >
            Retry sending
          </button>
        )}
      </div>
    </li>
  );
}

function ComposerTray({
  paymentEnabled,
  onPay,
  onStickers,
}: {
  paymentEnabled: boolean;
  onPay: () => void;
  onStickers: () => void;
}) {
  return (
    <div className="chat-tray" role="menu" aria-label="Message actions">
      <button
        className="chat-tray-item"
        type="button"
        role="menuitem"
        disabled={!paymentEnabled}
        onClick={onPay}
      >
        <span className="chat-tray-icon is-primary" aria-hidden="true">
          <BitcoinMark className="chat-tray-btc" />
        </span>
        <span className="chat-tray-label">Pay</span>
      </button>
      <button
        className="chat-tray-item"
        type="button"
        role="menuitem"
        onClick={onStickers}
      >
        <span className="chat-tray-icon" aria-hidden="true">
          <StickerGlyph />
        </span>
        <span className="chat-tray-label">Stickers</span>
      </button>
      <button className="chat-tray-item" type="button" role="menuitem" disabled>
        <span className="chat-tray-icon" aria-hidden="true">
          <PhotosGlyph />
        </span>
        <span className="chat-tray-label">Photos</span>
      </button>
      <button className="chat-tray-item" type="button" role="menuitem" disabled>
        <span className="chat-tray-icon" aria-hidden="true">
          <CameraGlyph />
        </span>
        <span className="chat-tray-label">Camera</span>
      </button>
    </div>
  );
}

function normalizePayments(
  payments: readonly ChatPayment[],
): readonly ChatPayment[] {
  const unique = new Map<ChatMessageId, ChatPayment>();
  for (const payment of payments) unique.set(payment.id, payment);
  return [...unique.values()].sort(
    (left, right) =>
      left.sentAtMs - right.sentAtMs || left.id.localeCompare(right.id),
  );
}

function paymentStatus(
  payment: ChatPayment,
  operations: readonly WalletOperation[],
): ChatPaymentStatus {
  if (payment.direction !== 'outgoing' || payment.operationKey === undefined) {
    return payment.status;
  }
  const operation = operations.find(
    ({ key }) =>
      key.federationId === payment.operationKey?.federationId &&
      key.operationId === payment.operationKey.operationId,
  );
  if (operation?.status === 'settled') return 'claimed';
  if (
    operation?.status === 'refunded' ||
    operation?.status === 'failed' ||
    operation?.status === 'expired' ||
    operation?.status === 'cancelled'
  ) {
    return 'failed';
  }
  return payment.status;
}

const STICKERS = [
  '₿',
  '⚡',
  '🚀',
  '🔥',
  '💎',
  '❤️',
  '⭐',
  '💰',
  'HODL',
  '👍',
  'GM',
  '🎉',
];

function StickerPanel({ onSend }: { onSend: (sticker: string) => void }) {
  return (
    <div className="chat-sticker-panel" aria-label="Stickers">
      {STICKERS.map((sticker) => (
        <button
          key={sticker}
          className="chat-sticker"
          type="button"
          aria-label={`Send ${sticker} sticker`}
          onClick={() => onSend(sticker)}
        >
          {sticker}
        </button>
      ))}
    </div>
  );
}

function PaySheet({
  counterparty,
  onClose,
  onSend,
}: {
  counterparty: string;
  onClose: () => void;
  onSend: (amountSats: number) => void;
}) {
  const [amount, setAmount] = useState('');
  const amountSats = amount.length === 0 ? 0 : Number.parseInt(amount, 10);
  const ready = Number.isSafeInteger(amountSats) && amountSats > 0;

  function press(digit: string) {
    if (amount.length >= 15) return;
    setAmount((amount + digit).replace(/^0+(?=\d)/u, ''));
  }

  return (
    <div className="chat-sheet-overlay" role="presentation" onClick={onClose}>
      <div
        className="chat-sheet chat-pay-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Send payment to ${counterparty}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="chat-sheet-grip" aria-hidden="true" />
        <div className="chat-pay-head">
          <span className="chat-pay-avatar" aria-hidden="true">
            {initials(counterparty)}
          </span>
          <div className="chat-pay-to">
            <span className="chat-pay-to-label">Send to</span>
            <span className="chat-pay-to-name">{counterparty}</span>
          </div>
          <button
            className="chat-pay-close"
            type="button"
            aria-label="Cancel payment"
            onClick={onClose}
          >
            <CloseGlyph />
          </button>
        </div>
        <div className="chat-pay-amount">
          <BitcoinMark className="chat-pay-symbol" />
          <span className="chat-pay-value">{groupDigits(amount)}</span>
          <span className="visually-hidden" role="status">
            {groupDigits(amount)} sats entered
          </span>
        </div>
        <div className="chat-pay-note-row">
          <button
            className="chat-pay-note"
            type="button"
            disabled
            title="Payment notes are not supported yet"
          >
            <PencilGlyph />
            Add a note
          </button>
        </div>
        <Keypad
          onDigit={press}
          onBackspace={() => setAmount(amount.slice(0, -1))}
          backspaceDisabled={amount.length === 0}
        />
        <button
          className="chat-pay-send"
          type="button"
          disabled={!ready}
          onClick={() => onSend(amountSats)}
        >
          <BoltGlyph />
          Send payment
        </button>
      </div>
    </div>
  );
}

function groupDigits(digits: string): string {
  const normalized = digits.replace(/^0+(?=\d)/u, '') || '0';
  return normalized.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

function PaySuccessSheet({
  amountSats,
  counterparty,
  onDone,
}: {
  amountSats: number;
  counterparty: string;
  onDone: () => void;
}) {
  const firstName = counterparty.split(/\s+/u)[0] ?? 'them';
  return (
    <div className="chat-sheet-overlay" role="presentation">
      <div
        className="chat-sheet chat-pay-success"
        role="dialog"
        aria-modal="true"
        aria-label="Payment sent"
      >
        <div className="chat-sheet-grip" aria-hidden="true" />
        <span className="chat-success-check" aria-hidden="true">
          <BigCheckGlyph />
        </span>
        <h2 className="chat-success-title">Payment sent</h2>
        <p className="chat-success-amount">
          <BitcoinMark className="chat-payment-symbol" />
          {formatSats(amountSats)}
        </p>
        <p className="chat-success-to">to {counterparty}</p>
        <p className="chat-success-wait">
          <ClockGlyph />
          Waiting for {firstName} to claim
        </p>
        <button className="chat-pay-send" type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function EcashRecoverySheet({
  exported,
  onDone,
}: {
  exported: EcashExport;
  onDone: () => void;
}) {
  const notes = exported.notes.reveal();
  const [shareOutcome, setShareOutcome] = useState<
    'shared' | 'copied' | 'failed'
  >();

  return (
    <div className="chat-sheet-overlay" role="presentation">
      <div
        className="chat-sheet chat-ecash-recovery"
        role="dialog"
        aria-modal="true"
        aria-label="Ecash recovery required"
      >
        <div className="chat-sheet-grip" aria-hidden="true" />
        <h2 className="chat-success-title">Save this ecash</h2>
        <p className="chat-ecash-recovery-warning" role="alert">
          Encrypted recovery failed, so this payment was not sent. Save or share
          this bearer ecash now; closing this sheet removes the app's only copy.
        </p>
        <QrCode value={notes} label="Unsent ecash recovery QR code" />
        <button
          className="chat-pay-send"
          type="button"
          onClick={() => {
            void shareText(notes, { title: 'Unsent Fedimint ecash' }).then(
              setShareOutcome,
            );
          }}
        >
          Share ecash
        </button>
        {shareOutcome !== undefined && (
          <p className="fine-print" role="status">
            {shareOutcome === 'shared'
              ? 'Share sheet opened.'
              : shareOutcome === 'copied'
                ? 'Ecash copied.'
                : 'Could not share or copy ecash.'}
          </p>
        )}
        <button className="secondary-button" type="button" onClick={onDone}>
          I saved it — close
        </button>
      </div>
    </div>
  );
}

function readMessageDraft(value: string): string {
  const normalized = sanitizeChatText(value);
  if (
    normalized.trim().length === 0 ||
    new TextEncoder().encode(normalized).length > MAX_MESSAGE_BYTES
  ) {
    throw new TypeError('Invalid message draft.');
  }
  return normalized;
}

function isValidMessageDraft(value: string): boolean {
  try {
    readMessageDraft(value);
    return true;
  } catch {
    return false;
  }
}

function messageValidationError(value: string): string {
  return new TextEncoder().encode(value.normalize('NFC')).length >
    MAX_MESSAGE_BYTES
    ? 'Messages must be 4 KiB or less.'
    : 'Write a message before sending.';
}

function normalizeMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const unique = new Map<ChatMessageId, ChatMessage>();
  for (const message of messages) unique.set(message.id, message);
  return [...unique.values()].sort(
    (left, right) =>
      left.sentAtMs - right.sentAtMs || left.id.localeCompare(right.id),
  );
}

function conversationStatus(
  removed: boolean,
  offline: boolean,
  syncState: string,
): string | undefined {
  if (removed) return 'You left this conversation';
  if (offline) return 'Offline — new messages wait for a connection';
  if (syncState === 'syncing') return 'Synchronizing messages…';
  return undefined;
}

function deliveryLabel(message: ChatMessage, offline: boolean): string {
  switch (message.delivery) {
    case 'pending':
      return offline ? 'Queued until online' : 'Waiting for relay';
    case 'published':
      return 'Published to relay';
    case 'failed':
      return 'Not published';
    case 'received':
      return 'Received';
  }
}

function formatSats(value: number): string {
  return value.toLocaleString('en-US');
}

function initials(title: string): string {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]!.charAt(0);
  const second = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + second).toUpperCase();
}

function ChevronGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M15 5l-7 7 7 7"
        fill="none"
        stroke="var(--color-accent-ink)"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClaimedGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="var(--color-positive)" />
      <path
        d="M8.5 12l2.3 2.3 4.7-4.6"
        fill="none"
        stroke="#fff"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M12 7v5l3 2"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClaimArrowGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4v11M6 11l6 6 6-6"
        fill="none"
        stroke="var(--color-on-primary)"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 6v12M6 12h12"
        fill="none"
        stroke="var(--color-muted)"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SendArrowGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 19V6M6 12l6-6 6 6"
        fill="none"
        stroke="var(--color-on-primary)"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StickerGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8l-6 6H6a2 2 0 0 1-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path
        d="M14 20v-4a2 2 0 0 1 2-2h4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <circle cx="9" cy="10" r="1" fill="currentColor" />
      <circle cx="14" cy="10" r="1" fill="currentColor" />
      <path
        d="M9 13.5s1 1.5 2.5 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  );
}

function PhotosGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
      <path
        d="M4 17l5-4 4 3 3-2 4 3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 8a2 2 0 0 1 2-2h1.5l1-2h7l1 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <circle
        cx="12"
        cy="12.5"
        r="3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 20l4-1 10-10-3-3L5 16z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path
        d="M13.5 6.5l3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

function BoltGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="var(--color-on-primary)" />
    </svg>
  );
}

function BigCheckGlyph() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 12l5 5L19 7"
        fill="none"
        stroke="#fff"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
