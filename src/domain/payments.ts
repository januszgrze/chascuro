import type { BitcoinNetwork, FederationId } from './federation';
import type { Msats } from './money';
import type { OperationId, WalletOperation } from './operation';

declare const sensitiveInputBrand: unique symbol;
declare const paymentFingerprintBrand: unique symbol;
declare const quoteIdBrand: unique symbol;
declare const secretRecordRefBrand: unique symbol;
declare const confirmedEcashRedeemBrand: unique symbol;
declare const confirmedEcashSpendBrand: unique symbol;
declare const confirmedLightningQuoteBrand: unique symbol;

export const DEFAULT_SENSITIVE_INPUT_LIMIT_BYTES = 64 * 1024;

export type SensitiveInput = string & {
  readonly [sensitiveInputBrand]: 'SensitiveInput';
};

export type PaymentFingerprint = string & {
  readonly [paymentFingerprintBrand]: 'PaymentFingerprint';
};

export type QuoteId = string & {
  readonly [quoteIdBrand]: 'QuoteId';
};

export type SecretRecordRef = string & {
  readonly [secretRecordRefBrand]: 'SecretRecordRef';
};

export interface ClearableSecretText {
  readonly length: number;
  reveal(): string;
  clear(): void;
  toJSON(): '[redacted]';
}

export interface SecretMnemonic {
  readonly wordCount: number;
  reveal(): readonly string[];
  clear(): void;
  toJSON(): '[redacted]';
}

export interface FederationCapabilities {
  readonly mint: boolean;
  readonly lightning: boolean;
  readonly onchain: boolean;
  readonly gatewayAvailable: boolean;
  readonly recovery: 'supported' | 'unsupported' | 'unknown';
  readonly lightningSend:
    | 'enabled'
    | 'disabled_fee_quote_unavailable'
    | 'disabled_gateway_unavailable'
    | 'unsupported';
}

export interface EcashPreview {
  readonly fingerprint: PaymentFingerprint;
  readonly amountMsats: Msats;
  readonly federationId?: FederationId;
  readonly compatible: boolean;
}

export interface ConfirmedEcashRedeem {
  readonly preview: EcashPreview;
  readonly confirmedAtMs: number;
  readonly [confirmedEcashRedeemBrand]: 'ConfirmedEcashRedeem';
}

export interface EcashSpendIntent {
  readonly amountMsats: Msats;
  readonly includeFederationInvite: boolean;
  readonly cancellationWindowSeconds?: number;
}

export interface ConfirmedEcashSpend {
  readonly intent: EcashSpendIntent;
  readonly confirmedAtMs: number;
  readonly [confirmedEcashSpendBrand]: 'ConfirmedEcashSpend';
}

export interface EcashExport {
  readonly operation: WalletOperation;
  readonly notes: ClearableSecretText;
  readonly secretRecordRef: SecretRecordRef;
  /**
   * Set by the application boundary after encrypted persistence is attempted.
   * A memory-only result must remain visible because clearing the only bearer
   * note copy would lose funds.
   */
  readonly secretStorage?: 'encrypted' | 'memory_only';
}

export interface LightningInvoicePreview {
  readonly fingerprint: PaymentFingerprint;
  readonly network: BitcoinNetwork;
  readonly amountMsats?: Msats;
  readonly expiresAtMs: number;
  readonly description?: string;
  readonly payeeHint?: string;
}

export interface LightningReceiveIntent {
  readonly amountMsats: Msats;
  readonly description?: string;
  readonly expirySeconds: number;
}

export interface LightningReceive {
  readonly operation: WalletOperation;
  readonly invoice: ClearableSecretText;
  readonly expiresAtMs: number;
  readonly secretRecordRef: SecretRecordRef;
  readonly secretStorage?: 'encrypted' | 'memory_only';
}

export interface LightningPaymentIntent {
  readonly preview: LightningInvoicePreview;
  readonly maximumFeeMsats: Msats;
}

export interface LightningQuote {
  readonly quoteId: QuoteId;
  readonly invoiceFingerprint: PaymentFingerprint;
  readonly amountMsats: Msats;
  readonly feeMsats: Msats;
  readonly maximumFeeMsats: Msats;
  readonly expiresAtMs: number;
  readonly gatewayId?: string;
}

export interface ConfirmedLightningQuote {
  readonly quote: LightningQuote;
  readonly confirmedAtMs: number;
  readonly [confirmedLightningQuoteBrand]: 'ConfirmedLightningQuote';
}

export interface TrackedOperation {
  readonly operationId: OperationId;
  readonly operation: WalletOperation;
}

class ClearableSecretTextValue implements ClearableSecretText {
  private value: string | undefined;

  constructor(value: string) {
    this.value = value;
  }

  get length(): number {
    return this.value?.length ?? 0;
  }

  reveal(): string {
    if (this.value === undefined) {
      throw new Error('Secret value has been cleared.');
    }
    return this.value;
  }

  clear(): void {
    this.value = undefined;
  }

  toJSON(): '[redacted]' {
    return '[redacted]';
  }
}

class SecretMnemonicValue implements SecretMnemonic {
  private words: string[] | undefined;

  constructor(words: readonly string[]) {
    this.words = [...words];
  }

  get wordCount(): number {
    return this.words?.length ?? 0;
  }

  reveal(): readonly string[] {
    if (this.words === undefined) {
      throw new Error('Mnemonic has been cleared.');
    }
    return Object.freeze([...this.words]);
  }

  clear(): void {
    this.words?.fill('');
    this.words = undefined;
  }

  toJSON(): '[redacted]' {
    return '[redacted]';
  }
}

function opaqueIdentifier<T extends string>(value: string): T {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(
      'Identifier must be non-empty and have no outer whitespace.',
    );
  }
  return value as T;
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Timestamp must be a non-negative safe integer.');
  }
}

export function sensitiveInput(
  value: string,
  maximumBytes = DEFAULT_SENSITIVE_INPUT_LIMIT_BYTES,
): SensitiveInput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError('Sensitive input limit must be a positive integer.');
  }

  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    new TextEncoder().encode(normalized).byteLength > maximumBytes
  ) {
    throw new TypeError('Sensitive input is empty, invalid, or too large.');
  }

  return normalized as SensitiveInput;
}

export function paymentFingerprint(value: string): PaymentFingerprint {
  return opaqueIdentifier<PaymentFingerprint>(value);
}

export function quoteId(value: string): QuoteId {
  return opaqueIdentifier<QuoteId>(value);
}

export function secretRecordRef(value: string): SecretRecordRef {
  return opaqueIdentifier<SecretRecordRef>(value);
}

export function clearableSecretText(value: string): ClearableSecretText {
  if (value.length === 0) {
    throw new TypeError('Secret value must not be empty.');
  }
  return new ClearableSecretTextValue(value);
}

export function normalizeMnemonicWords(
  value: string | readonly string[],
): readonly string[] {
  const words = (typeof value === 'string' ? value.trim().split(/\s+/) : value)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
  const supportedCounts = new Set([12, 15, 18, 21, 24]);

  if (
    !supportedCounts.has(words.length) ||
    !words.every((word) => /^[a-z]+$/.test(word))
  ) {
    throw new TypeError('Mnemonic words are not in a supported local format.');
  }

  return Object.freeze([...words]);
}

export function secretMnemonic(
  value: string | readonly string[],
): SecretMnemonic {
  return new SecretMnemonicValue(normalizeMnemonicWords(value));
}

export function confirmEcashRedeem(
  preview: EcashPreview,
  confirmedAtMs: number,
): ConfirmedEcashRedeem {
  assertTimestamp(confirmedAtMs);
  if (!preview.compatible) {
    throw new RangeError('Ecash does not belong to the active federation.');
  }

  return Object.freeze({
    preview,
    confirmedAtMs,
  }) as ConfirmedEcashRedeem;
}

export function confirmEcashSpend(
  intent: EcashSpendIntent,
  confirmedAtMs: number,
): ConfirmedEcashSpend {
  assertTimestamp(confirmedAtMs);
  if (intent.amountMsats <= 0n) {
    throw new RangeError('Ecash spend amount must be greater than zero.');
  }
  if (
    intent.cancellationWindowSeconds !== undefined &&
    (!Number.isSafeInteger(intent.cancellationWindowSeconds) ||
      intent.cancellationWindowSeconds < 0)
  ) {
    throw new RangeError('Cancellation window is invalid.');
  }

  return Object.freeze({
    intent: Object.freeze({ ...intent }),
    confirmedAtMs,
  }) as ConfirmedEcashSpend;
}

export function confirmLightningQuote(
  quote: LightningQuote,
  invoiceFingerprint: PaymentFingerprint,
  confirmedAtMs: number,
): ConfirmedLightningQuote {
  assertTimestamp(confirmedAtMs);

  if (
    quote.invoiceFingerprint !== invoiceFingerprint ||
    quote.amountMsats <= 0n ||
    confirmedAtMs >= quote.expiresAtMs ||
    quote.feeMsats > quote.maximumFeeMsats
  ) {
    throw new RangeError('Lightning quote is stale or no longer valid.');
  }

  return Object.freeze({
    quote,
    confirmedAtMs,
  }) as ConfirmedLightningQuote;
}
