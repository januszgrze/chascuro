import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearableSecretText,
  createWalletOperation,
  federationId,
  lnurlPayOfferId,
  msats,
  operationId,
  paymentFingerprint,
  quoteId,
  satsToMsats,
  secretRecordRef,
  type OperationDirection,
  type OperationGuidanceCode,
  type OperationKind,
  type OperationStatus,
  type WalletOperation,
} from '../../domain';
import type { WalletSnapshot } from '../../services/wallet';
import { HomeScreen } from './HomeScreen';

const scanner = vi.hoisted(() => ({
  payload: 'fedimint-ecash:example',
}));

vi.mock('../shared/QrScanner', () => ({
  QrScanner: ({ onScan }: { onScan(value: string): void }) => (
    <button type="button" onClick={() => onScan(scanner.payload)}>
      Scan test QR
    </button>
  ),
}));

vi.mock('../shared/QrCode', () => ({
  QrCode: ({ value, label }: { value: string; label: string }) => (
    <output aria-label={label}>{value}</output>
  ),
}));

const SNAPSHOT: WalletSnapshot = {
  serviceKind: 'fake',
  lifecycle: 'ready',
  connection: 'online',
  balanceMsats: msats(0n),
  operations: [],
  capabilities: {
    mint: true,
    lightning: true,
    onchain: false,
    gatewayAvailable: true,
    recovery: 'supported',
    lightningSend: 'enabled',
  },
};

type HomeProps = ComponentProps<typeof HomeScreen>;

function createHomeProps(overrides: Partial<HomeProps> = {}): HomeProps {
  return {
    snapshot: SNAPSHOT,
    securitySettings: {
      version: 1,
      inactivityTimeoutMs: 5 * 60_000,
      backgroundTimeoutMs: 30_000,
    },
    refreshing: false,
    onRefresh: vi.fn(async () => undefined),
    onLock: vi.fn(async () => undefined),
    onParseEcash: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Manual ecash parse failed.' }),
    onRedeemEcash: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    onCreateEcashSpend: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    onCreateLightningInvoice: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    onQuoteLightningPayment: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Manual invoice parse failed.' }),
    onResolveLnurlPay: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Payment service unavailable.' }),
    onQuoteLnurlPayment: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Payment service unavailable.' }),
    onPayLightningQuote: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    onReconcile: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    onRevealMnemonic: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    onRecoverEcashExport: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    onRecoverLightningInvoice: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    onUpdateSecuritySettings: vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    onErase: vi.fn().mockResolvedValue({ ok: false, error: 'Unavailable.' }),
    ...overrides,
  };
}

function renderHome(overrides: Partial<HomeProps> = {}) {
  const props = createHomeProps(overrides);
  render(<HomeScreen {...props} />);
  return props;
}

const TEST_FEDERATION_ID = federationId('test-federation');

function walletOperation({
  id,
  kind = 'lightning_receive',
  direction = 'incoming',
  status = 'awaiting_external_payment',
  amountMsats = satsToMsats(100n),
  feeMsats,
  createdAtMs = Date.now() - 10_000,
  updatedAtMs = createdAtMs,
  expiresAtMs,
  guidanceCode,
  localDescription,
}: {
  id: string;
  kind?: OperationKind;
  direction?: OperationDirection;
  status?: OperationStatus;
  amountMsats?: WalletOperation['amountMsats'];
  feeMsats?: WalletOperation['feeMsats'];
  createdAtMs?: number;
  updatedAtMs?: number;
  expiresAtMs?: number;
  guidanceCode?: OperationGuidanceCode;
  localDescription?: string;
}): WalletOperation {
  return createWalletOperation({
    key: {
      federationId: TEST_FEDERATION_ID,
      operationId: operationId(id),
    },
    kind,
    direction,
    status,
    amountMsats,
    feeMsats,
    createdAtMs,
    updatedAtMs,
    expiresAtMs,
    guidanceCode,
    localDescription,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HomeScreen scanned wallet input', () => {
  it('rejects non-ecash scans and auto-parses (never auto-redeems) a valid scan', async () => {
    const user = userEvent.setup();
    const onParseEcash = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Manual ecash parse failed.' });
    const props = renderHome({ onParseEcash });
    await user.click(screen.getByRole('button', { name: 'Receive' }));

    scanner.payload = 'lntb1example';
    await user.click(screen.getByRole('button', { name: 'Scan test QR' }));
    expect(
      screen.getByText('That looks like a Lightning invoice, not ecash.'),
    ).toBeVisible();
    expect(onParseEcash).not.toHaveBeenCalled();

    scanner.payload = 'fedimint-ecash:example';
    await user.click(screen.getByRole('button', { name: 'Scan test QR' }));
    expect(onParseEcash).toHaveBeenCalledWith('fedimint-ecash:example');
    expect(props.onRedeemEcash).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Enter manually' }));
    expect(screen.getByLabelText('Ecash notes')).toHaveFocus();
    await user.type(screen.getByLabelText('Ecash notes'), 'manual ecash notes');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onParseEcash).toHaveBeenCalledWith('manual ecash notes');
  });

  it('rejects unrelated scans and auto-quotes (never auto-pays) a BOLT11 invoice', async () => {
    const user = userEvent.setup();
    const onQuoteLightningPayment = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Manual invoice parse failed.' });
    const props = renderHome({ onQuoteLightningPayment });
    await user.click(screen.getByRole('button', { name: 'Send' }));

    scanner.payload = 'fedimint-ecash:example';
    await user.click(screen.getByRole('button', { name: 'Scan test QR' }));
    expect(
      screen.getByText(
        'Enter a BOLT11 invoice, Lightning Address, or LNURL-pay request.',
      ),
    ).toBeVisible();
    expect(onQuoteLightningPayment).not.toHaveBeenCalled();

    scanner.payload = 'lntb1example';
    await user.click(screen.getByRole('button', { name: 'Scan test QR' }));
    expect(onQuoteLightningPayment).toHaveBeenCalledWith('lntb1example', '10');
    expect(props.onPayLightningQuote).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Enter manually' }));
    expect(screen.getByLabelText('Lightning payment request')).toHaveFocus();
    await user.type(
      screen.getByLabelText('Lightning payment request'),
      'lntb1manualinvoice',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onQuoteLightningPayment).toHaveBeenCalledWith(
      'lntb1manualinvoice',
      '10',
    );
  });

  it('resolves a Lightning Address, validates a chosen amount, and quotes before payment', async () => {
    const user = userEvent.setup();
    const offer = {
      offerId: lnurlPayOfferId('offer-dynamic'),
      destination: 'alice@example.com',
      domain: 'example.com',
      description: 'Coffee for Alice',
      minSendableMsats: satsToMsats(10n),
      maxSendableMsats: satsToMsats(100n),
      expiresAtMs: Date.now() + 60_000,
    };
    const preview = {
      fingerprint: paymentFingerprint('lnurl-invoice'),
      network: 'regtest' as const,
      amountMsats: satsToMsats(50n),
      expiresAtMs: Date.now() + 60_000,
      description: offer.description,
      payeeHint: offer.destination,
    };
    const quote = {
      quoteId: quoteId('lnurl-quote'),
      invoiceFingerprint: preview.fingerprint,
      amountMsats: satsToMsats(50n),
      feeMsats: satsToMsats(1n),
      maximumFeeMsats: satsToMsats(10n),
      expiresAtMs: Date.now() + 60_000,
    };
    const onResolveLnurlPay = vi
      .fn()
      .mockResolvedValue({ ok: true, value: offer });
    const onQuoteLnurlPayment = vi.fn().mockResolvedValue({
      ok: true,
      value: { preview, quote, offer },
    });
    const props = renderHome({
      onResolveLnurlPay,
      onQuoteLnurlPayment,
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('button', { name: 'Enter manually' }));
    await user.type(
      screen.getByLabelText('Lightning payment request'),
      'alice@example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onResolveLnurlPay).toHaveBeenCalledWith('alice@example.com');
    expect(
      screen.getByRole('heading', { name: 'Choose amount' }),
    ).toBeVisible();
    expect(screen.getByText('To:')).toBeVisible();
    expect(screen.getByText('alice@example.com')).toBeVisible();
    expect(screen.queryByText('Coffee for Alice')).not.toBeInTheDocument();
    expect(screen.queryByText('Allowed amount')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '5' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose an amount from 10 to 100 sats.',
    );
    expect(
      screen.getByRole('button', { name: 'Review payment' }),
    ).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: 'Review payment' }));

    expect(onQuoteLnurlPayment).toHaveBeenCalledWith(offer.offerId, '50', '10');
    expect(screen.getByRole('heading', { name: 'Pay invoice' })).toBeVisible();
    expect(screen.getByText('alice@example.com')).toBeVisible();
    expect(props.onPayLightningQuote).not.toHaveBeenCalled();
  });

  it('shows a fixed LNURL amount but still requires explicit review', async () => {
    const user = userEvent.setup();
    const fixedAmount = satsToMsats(21_000n);
    const offer = {
      offerId: lnurlPayOfferId('offer-fixed'),
      destination: 'pay.example.com',
      domain: 'pay.example.com',
      description: 'Fixed purchase',
      minSendableMsats: fixedAmount,
      maxSendableMsats: fixedAmount,
      fixedAmountMsats: fixedAmount,
      expiresAtMs: Date.now() + 60_000,
    };
    const onQuoteLnurlPayment = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Quote stopped for test.',
    });
    renderHome({
      onResolveLnurlPay: vi.fn().mockResolvedValue({ ok: true, value: offer }),
      onQuoteLnurlPayment,
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('button', { name: 'Enter manually' }));
    await user.type(
      screen.getByLabelText('Lightning payment request'),
      'lnurlp://pay.example.com/request',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.queryByRole('group', { name: 'Number keypad' })).toBeNull();
    expect(screen.getAllByText('21000').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Review payment' }));
    expect(onQuoteLnurlPayment).toHaveBeenCalledWith(
      offer.offerId,
      undefined,
      '10',
    );
  });

  it('reveals a supported success action only after the payment settles', async () => {
    const user = userEvent.setup();
    const fixedAmount = satsToMsats(100n);
    const offer = {
      offerId: lnurlPayOfferId('offer-action'),
      destination: 'alice@example.com',
      domain: 'example.com',
      description: 'Thank-you payment',
      minSendableMsats: fixedAmount,
      maxSendableMsats: fixedAmount,
      fixedAmountMsats: fixedAmount,
      expiresAtMs: Date.now() + 60_000,
    };
    const preview = {
      fingerprint: paymentFingerprint('action-invoice'),
      network: 'regtest' as const,
      amountMsats: fixedAmount,
      expiresAtMs: Date.now() + 60_000,
      description: offer.description,
      payeeHint: offer.destination,
    };
    const quote = {
      quoteId: quoteId('action-quote'),
      invoiceFingerprint: preview.fingerprint,
      amountMsats: fixedAmount,
      feeMsats: satsToMsats(1n),
      maximumFeeMsats: satsToMsats(10n),
      expiresAtMs: Date.now() + 60_000,
    };
    const pending = walletOperation({
      id: 'lnurl-action-payment',
      kind: 'lightning_send',
      direction: 'outgoing',
      status: 'pending',
      amountMsats: fixedAmount,
    });
    const props = createHomeProps({
      onResolveLnurlPay: vi.fn().mockResolvedValue({ ok: true, value: offer }),
      onQuoteLnurlPayment: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          preview,
          quote,
          offer,
          successAction: { tag: 'message', message: 'Thanks, paid!' },
        },
      }),
      onPayLightningQuote: vi.fn().mockResolvedValue({
        ok: true,
        value: { operationId: pending.key.operationId, operation: pending },
      }),
    });
    const rendered = render(<HomeScreen {...props} />);

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('button', { name: 'Enter manually' }));
    await user.type(
      screen.getByLabelText('Lightning payment request'),
      'alice@example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Review payment' }));
    await user.click(screen.getByRole('button', { name: /Pay.*100/ }));

    expect(
      screen.getByRole('heading', { name: 'Payment pending' }),
    ).toBeVisible();
    expect(screen.queryByText('Thanks, paid!')).not.toBeInTheDocument();

    const settled = walletOperation({
      id: 'lnurl-action-payment',
      kind: 'lightning_send',
      direction: 'outgoing',
      status: 'settled',
      amountMsats: fixedAmount,
      createdAtMs: pending.createdAtMs,
      updatedAtMs: pending.updatedAtMs + 1,
    });
    rendered.rerender(
      <HomeScreen
        {...props}
        snapshot={{ ...SNAPSHOT, operations: [settled] }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Sent' })).toBeVisible();
    expect(screen.getByText('Thanks, paid!')).toBeVisible();
  });

  it('keeps LNURL network failures on the entry screen', async () => {
    const user = userEvent.setup();
    renderHome({
      onResolveLnurlPay: vi.fn().mockResolvedValue({
        ok: false,
        error: 'The payment service could not be reached.',
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('button', { name: 'Enter manually' }));
    await user.type(
      screen.getByLabelText('Lightning payment request'),
      'alice@example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The payment service could not be reached.',
    );
    expect(
      screen.queryByRole('heading', { name: 'Choose amount' }),
    ).not.toBeInTheDocument();
  });
});

describe('HomeScreen Lightning receive', () => {
  it('shows receive unavailable copy when the federation has no usable Lightning gateway', async () => {
    const user = userEvent.setup();
    renderHome({
      snapshot: {
        ...SNAPSHOT,
        capabilities: {
          ...SNAPSHOT.capabilities!,
          lightning: false,
          gatewayAvailable: false,
          lightningSend: 'unsupported',
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Receive' }));
    await user.click(screen.getByRole('button', { name: 'Lightning' }));

    expect(screen.getByText('Lightning receive is unavailable.')).toBeVisible();
  });

  it('uses the live snapshot operation and clears a terminal invoice', async () => {
    const user = userEvent.setup();
    const rawInvoice = 'lntb1liveinvoice';
    const invoice = clearableSecretText(rawInvoice);
    const expiresAtMs = Date.now() + 60_000;
    const initial = walletOperation({
      id: 'lightning-live',
      expiresAtMs,
    });
    const receive = {
      operation: initial,
      invoice,
      expiresAtMs,
      secretRecordRef: secretRecordRef('secret:lightning-live'),
      secretStorage: 'memory_only' as const,
    };
    const props = createHomeProps({
      snapshot: { ...SNAPSHOT, operations: [initial] },
      onCreateLightningInvoice: vi
        .fn()
        .mockResolvedValue({ ok: true, value: receive }),
    });
    const rendered = render(<HomeScreen {...props} />);

    await user.click(screen.getByRole('button', { name: 'Receive' }));
    await user.click(screen.getByRole('button', { name: 'Lightning' }));
    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: 'Create invoice' }));

    expect(
      await screen.findByLabelText('Lightning invoice QR code'),
    ).toHaveTextContent(rawInvoice);
    expect(screen.getByRole('button', { name: 'Share invoice' })).toBeVisible();
    expect(screen.getByRole('timer')).toHaveTextContent('Expires in');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Encrypted recovery failed.',
    );

    const settled = walletOperation({
      id: 'lightning-live',
      status: 'settled',
      createdAtMs: initial.createdAtMs,
      updatedAtMs: initial.updatedAtMs + 1,
      expiresAtMs,
    });
    rendered.rerender(
      <HomeScreen
        {...props}
        snapshot={{ ...SNAPSHOT, operations: [settled] }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Received' })).toBeVisible();
    expect(
      screen.queryByLabelText('Lightning invoice QR code'),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(invoice.length).toBe(0));
  });

  it('counts down in real time and stops presenting an expired invoice', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const rawInvoice = 'lntb1countdown';
    const invoice = clearableSecretText(rawInvoice);
    const expiresAtMs = Date.now() + 65_000;
    const operation = walletOperation({
      id: 'lightning-countdown',
      createdAtMs: Date.now(),
      expiresAtMs,
    });
    const props = createHomeProps({
      snapshot: { ...SNAPSHOT, operations: [operation] },
      onCreateLightningInvoice: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          operation,
          invoice,
          expiresAtMs,
          secretRecordRef: secretRecordRef('secret:lightning-countdown'),
          secretStorage: 'encrypted',
        },
      }),
    });
    render(<HomeScreen {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Receive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lightning' }));
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create invoice' }));
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(0));

    expect(screen.getByRole('timer')).toHaveTextContent('Expires in 1:05');
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByRole('timer')).toHaveTextContent('Expires in 0:59');

    act(() => vi.advanceTimersByTime(59_000));
    expect(
      screen.queryByLabelText('Lightning invoice QR code'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Invoice expired or no longer payable.'),
    ).toBeVisible();
    expect(invoice.length).toBe(0);
  });
});

describe('HomeScreen activity', () => {
  it('recovers only relevant encrypted secrets, including Lightning invoices', async () => {
    const user = userEvent.setup();
    const nowMs = Date.now();
    const pendingLightning = walletOperation({
      id: 'lightning-recoverable',
      expiresAtMs: nowMs + 60_000,
    });
    const expiredLightning = walletOperation({
      id: 'lightning-expired',
      createdAtMs: nowMs - 120_000,
      updatedAtMs: nowMs - 60_000,
      expiresAtMs: nowMs - 1,
    });
    const settledLightning = walletOperation({
      id: 'lightning-settled',
      status: 'settled',
      expiresAtMs: nowMs + 60_000,
    });
    const pendingEcash = walletOperation({
      id: 'ecash-recoverable',
      kind: 'ecash_send',
      direction: 'outgoing',
      status: 'pending',
    });
    const settledEcash = walletOperation({
      id: 'ecash-still-recoverable',
      kind: 'ecash_send',
      direction: 'outgoing',
      status: 'settled',
    });
    const refundedEcash = walletOperation({
      id: 'ecash-refunded',
      kind: 'ecash_send',
      direction: 'outgoing',
      status: 'refunded',
    });
    const cancelledEcash = walletOperation({
      id: 'ecash-cancelled-but-unverified',
      kind: 'ecash_send',
      direction: 'outgoing',
      status: 'cancelled',
    });
    const expiredEcash = walletOperation({
      id: 'ecash-expired-but-unverified',
      kind: 'ecash_send',
      direction: 'outgoing',
      status: 'expired',
    });
    const recoveredInvoice = clearableSecretText('lntb1restoredencrypted');
    const onRecoverLightningInvoice = vi.fn().mockResolvedValue({
      ok: true,
      value: recoveredInvoice,
    });

    renderHome({
      snapshot: {
        ...SNAPSHOT,
        operations: [
          pendingLightning,
          expiredLightning,
          settledLightning,
          pendingEcash,
          settledEcash,
          refundedEcash,
          cancelledEcash,
          expiredEcash,
        ],
      },
      onRecoverLightningInvoice,
    });
    await user.click(screen.getByRole('button', { name: 'Activity' }));

    const lightningRows = () =>
      screen.getAllByRole('button', {
        name: 'View details for Lightning received',
      });
    const ecashRows = () =>
      screen.getAllByRole('button', { name: 'View details for Ecash sent' });

    await user.click(lightningRows()[0]);
    await user.click(screen.getByRole('button', { name: 'Recover invoice' }));
    expect(onRecoverLightningInvoice).toHaveBeenCalledWith(
      pendingLightning.key,
    );
    expect(
      await screen.findByLabelText('Recovered Lightning invoice'),
    ).toHaveValue('lntb1restoredencrypted');
    expect(
      screen.getByLabelText('Recovered Lightning invoice QR code'),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Back to activity' }));
    await user.click(lightningRows()[1]);
    expect(
      screen.queryByRole('button', { name: 'Recover invoice' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to activity' }));
    await user.click(ecashRows()[1]);
    expect(screen.getByRole('button', { name: 'Recover notes' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Back to activity' }));
    await user.click(ecashRows()[2]);
    expect(
      screen.queryByRole('button', { name: 'Recover notes' }),
    ).not.toBeInTheDocument();
  });

  it('paginates and opens a minimal transaction detail view', async () => {
    const user = userEvent.setup();
    const nowMs = Date.now();
    const operations = Array.from({ length: 21 }, (_, index) =>
      walletOperation({
        id: `activity-${index}`,
        kind: 'ecash_receive',
        direction: 'incoming',
        status: 'settled',
        amountMsats: satsToMsats(100n),
        feeMsats: satsToMsats(1n),
        createdAtMs: nowMs - 30_000 - index,
        updatedAtMs: nowMs - index,
      }),
    );

    renderHome({
      snapshot: { ...SNAPSHOT, operations },
    });
    await user.click(screen.getByRole('button', { name: 'Activity' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(20);

    await user.click(
      screen.getAllByRole('button', {
        name: 'View details for Ecash received',
      })[0],
    );

    expect(
      screen.getByRole('heading', { name: 'Ecash received' }),
    ).toBeVisible();
    expect(screen.getByText('Date')).toBeVisible();
    expect(screen.getByText('Time')).toBeVisible();
    expect(screen.queryByText('Direction')).not.toBeInTheDocument();
    expect(screen.queryByText('Fee')).not.toBeInTheDocument();
    expect(screen.queryByText('Guidance')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to activity' }));

    await user.click(
      screen.getByRole('button', {
        name: 'Load more activity (1 remaining)',
      }),
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(21);
  });
});

describe('HomeScreen settings and secret-storage warnings', () => {
  it('requires at least one automatic lock and saves supported choices', async () => {
    const user = userEvent.setup();
    const onUpdateSecuritySettings = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        version: 1,
        inactivityTimeoutMs: null,
        backgroundTimeoutMs: 30_000,
      },
    });
    renderHome({ onUpdateSecuritySettings });

    await user.click(
      screen.getByRole('button', { name: 'Backup and settings' }),
    );
    await user.click(screen.getByText('Advanced'));
    await user.selectOptions(
      screen.getByLabelText('Lock after inactivity'),
      'never',
    );
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));
    expect(onUpdateSecuritySettings).toHaveBeenCalledWith(null, 30_000);
    expect(
      await screen.findByText('Automatic lock settings saved.'),
    ).toBeVisible();

    await user.selectOptions(
      screen.getByLabelText('Lock while in background'),
      'never',
    );
    expect(
      screen.getByText('At least one automatic lock must remain enabled.'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Save Settings' }),
    ).toBeDisabled();
  });

  it('warns when bearer ecash exists only in memory', async () => {
    const user = userEvent.setup();
    const operation = walletOperation({
      id: 'memory-only-ecash',
      kind: 'ecash_send',
      direction: 'outgoing',
      status: 'pending',
    });
    renderHome({
      onCreateEcashSpend: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          operation,
          notes: clearableSecretText('fedimint-ecash:memory-only'),
          secretRecordRef: secretRecordRef('secret:memory-only-ecash'),
          secretStorage: 'memory_only',
        },
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(screen.getByRole('button', { name: 'Ecash' }));
    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Share these notes now.',
    );
  });
});

describe('HomeScreen chat entry point', () => {
  it('exposes an accessible chat button that opens chat when enabled', async () => {
    const user = userEvent.setup();
    const onOpenChat = vi.fn();
    renderHome({ onOpenChat });

    await user.click(screen.getByRole('button', { name: 'Chat' }));

    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it('keeps the chat icon inert when chat is disabled', () => {
    renderHome();

    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
  });
});
