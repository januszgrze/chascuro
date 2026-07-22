import { describe, expect, it } from 'vitest';

import { chatMessageId } from '../../domain';
import {
  encodeChatPaymentEnvelope,
  parseChatContent,
} from './chat-payment-envelope';

describe('chat payment envelope', () => {
  it('round-trips bounded Fedimint ecash without treating it as text', () => {
    const paymentId = chatMessageId('payment:fixture');
    const content = encodeChatPaymentEnvelope(
      paymentId,
      21_000,
      'fedimint-ecash:21000000:fixture:secret',
    );

    expect(parseChatContent(content)).toEqual({
      kind: 'payment',
      payment: {
        kind: 'fedimint-ecash',
        paymentId,
        amountSats: 21_000,
        notes: 'fedimint-ecash:21000000:fixture:secret',
      },
    });
    expect(parseChatContent('hello')).toEqual({ kind: 'text', text: 'hello' });
  });

  it('drops malformed reserved control messages instead of displaying secrets', () => {
    expect(parseChatContent('chascuro-chat:1:{"notes":"secret"}')).toEqual({
      kind: 'invalid-control',
    });
    expect(() =>
      encodeChatPaymentEnvelope(
        chatMessageId('payment:oversized'),
        1,
        'x'.repeat(15_001),
      ),
    ).toThrow(/too large/u);
  });
});
