import {
  chatMessageId,
  MAX_CHAT_PAYMENT_SATS,
  type ChatMessageId,
} from '../../domain';

const PREFIX = 'chascuro-chat:1:';
const MAX_CONTENT_BYTES = 16_384;
const MAX_ECASH_BYTES = 15_000;

export interface ChatPaymentEnvelope {
  readonly kind: 'fedimint-ecash';
  readonly paymentId: ChatMessageId;
  readonly amountSats: number;
  readonly notes: string;
}

export type ParsedChatContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'payment'; readonly payment: ChatPaymentEnvelope }
  | { readonly kind: 'invalid-control' };

export function encodeChatPaymentEnvelope(
  paymentId: ChatMessageId,
  amountSats: number,
  notes: string,
): string {
  assertAmount(amountSats);
  assertNotes(notes);
  const encoded = `${PREFIX}${JSON.stringify({
    kind: 'fedimint-ecash',
    paymentId,
    amountSats,
    notes,
  })}`;
  if (byteLength(encoded) > MAX_CONTENT_BYTES) {
    throw new TypeError('The ecash payment is too large for chat transport.');
  }
  return encoded;
}

export function parseChatContent(content: string): ParsedChatContent {
  if (!content.startsWith(PREFIX)) {
    return Object.freeze({ kind: 'text', text: content });
  }
  if (byteLength(content) > MAX_CONTENT_BYTES) {
    return Object.freeze({ kind: 'invalid-control' });
  }
  let value: unknown;
  try {
    value = JSON.parse(content.slice(PREFIX.length));
  } catch {
    return Object.freeze({ kind: 'invalid-control' });
  }
  if (!isRecord(value)) return Object.freeze({ kind: 'invalid-control' });
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== 'amountSats' ||
    keys[1] !== 'kind' ||
    keys[2] !== 'notes' ||
    keys[3] !== 'paymentId' ||
    value.kind !== 'fedimint-ecash' ||
    typeof value.paymentId !== 'string' ||
    typeof value.amountSats !== 'number' ||
    typeof value.notes !== 'string'
  ) {
    return Object.freeze({ kind: 'invalid-control' });
  }
  try {
    assertAmount(value.amountSats);
    assertNotes(value.notes);
    return Object.freeze({
      kind: 'payment',
      payment: Object.freeze({
        kind: 'fedimint-ecash',
        paymentId: chatMessageId(value.paymentId),
        amountSats: value.amountSats,
        notes: value.notes,
      }),
    });
  } catch {
    return Object.freeze({ kind: 'invalid-control' });
  }
}

function assertAmount(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CHAT_PAYMENT_SATS
  ) {
    throw new TypeError('The ecash payment amount is invalid.');
  }
}

function assertNotes(value: string): void {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    byteLength(value) > MAX_ECASH_BYTES
  ) {
    throw new TypeError('The ecash payment notes are invalid or too large.');
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
