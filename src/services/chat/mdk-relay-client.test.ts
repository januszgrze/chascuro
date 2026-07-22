import { describe, expect, it } from 'vitest';

import {
  BrowserNostrRelayClient,
  type RelaySocketFactory,
} from './mdk-relay-client';

const EVENT_ID = 'ab'.repeat(32);
const EVENT_JSON = JSON.stringify({
  content: 'ciphertext',
  created_at: 1_700_000_000,
  id: EVENT_ID,
  kind: 445,
  pubkey: 'cd'.repeat(32),
  sig: 'ef'.repeat(64),
  tags: [['h', '01'.repeat(32)]],
});

describe('BrowserNostrRelayClient', () => {
  it('returns endpoint receipts and a met acknowledgement threshold', async () => {
    const client = clientFor({
      'wss://accepted.example/': ['OK', EVENT_ID, true, ''],
      'wss://rejected.example/': ['OK', EVENT_ID, false, 'secret reason'],
    });

    await expect(
      client.publish({
        endpoints: ['wss://accepted.example', 'wss://rejected.example'],
        eventId: EVENT_ID,
        eventJson: EVENT_JSON,
        requiredAcks: 1,
      }),
    ).resolves.toEqual({
      accepted: [{ acceptedAt: 1234, endpoint: 'wss://accepted.example/' }],
      eventId: EVENT_ID,
      failed: [
        {
          code: 'publish_rejected',
          endpoint: 'wss://rejected.example/',
          message: 'The relay rejected publication.',
        },
      ],
      metRequiredAcks: true,
      requiredAcks: 1,
    });
  });

  it('fails closed on invalid targets, thresholds, and inconsistent Rust events', async () => {
    const client = clientFor({});
    await expect(
      client.publish({
        endpoints: ['ws://public.example'],
        eventId: EVENT_ID,
        eventJson: EVENT_JSON,
        requiredAcks: 1,
      }),
    ).rejects.toThrow('not permitted');
    await expect(
      client.publish({
        endpoints: ['wss://one.example'],
        eventId: EVENT_ID,
        eventJson: EVENT_JSON,
        requiredAcks: 2,
      }),
    ).rejects.toThrow('threshold');
    await expect(
      client.publish({
        endpoints: ['wss://one.example'],
        eventId: '01'.repeat(32),
        eventJson: EVENT_JSON,
        requiredAcks: 1,
      }),
    ).rejects.toThrow('inconsistent');
  });

  it('reports bounded failures without returning arbitrary relay text', async () => {
    const client = clientFor({
      'wss://malformed.example/': ['OK', EVENT_ID, 'yes', 'private details'],
    });
    const report = await client.publish({
      endpoints: ['wss://malformed.example'],
      eventId: EVENT_ID,
      eventJson: EVENT_JSON,
      requiredAcks: 1,
    });

    expect(report.metRequiredAcks).toBe(false);
    expect(report.failed).toEqual([
      {
        code: 'invalid_response',
        endpoint: 'wss://malformed.example/',
        message: 'The relay returned an invalid acknowledgement.',
      },
    ]);
    expect(JSON.stringify(report)).not.toContain('private details');
  });

  it('times out or cancels each endpoint with stable failure codes', async () => {
    const client = clientFor({ 'wss://silent.example/': undefined });
    const timedOut = await client.publish({
      endpoints: ['wss://silent.example'],
      eventId: EVENT_ID,
      eventJson: EVENT_JSON,
      requiredAcks: 1,
      timeoutMs: 5,
    });
    expect(timedOut.failed[0]?.code).toBe('receipt_timeout');

    const controller = new AbortController();
    controller.abort();
    const aborted = await client.publish({
      endpoints: ['wss://silent.example'],
      eventId: EVENT_ID,
      eventJson: EVENT_JSON,
      requiredAcks: 1,
      signal: controller.signal,
    });
    expect(aborted.failed[0]?.code).toBe('aborted');
  });

  it('collects catch-up events through EOSE and deduplicates across relays', async () => {
    const event = JSON.parse(EVENT_JSON) as Record<string, unknown>;
    const client = catchUpClientFor({
      'wss://one.example/': (subscriptionId) => [
        ['EVENT', subscriptionId, event],
        ['EOSE', subscriptionId],
      ],
      'wss://two.example/': (subscriptionId) => [
        ['EVENT', subscriptionId, { ...event }],
        ['EVENT', subscriptionId, { ...event }],
        ['EOSE', subscriptionId],
      ],
    });

    const report = await client.catchUp({
      endpoints: ['wss://one.example', 'wss://two.example'],
      filtersJson: JSON.stringify([{ kinds: [445], since: 1_700_000_000 }]),
    });

    expect(report.failed).toEqual([]);
    expect(report.completed).toHaveLength(2);
    expect(report.events).toEqual([
      {
        eventId: EVENT_ID,
        eventJson: EVENT_JSON,
        sourceEndpoints: ['wss://one.example/', 'wss://two.example/'],
      },
    ]);
  });

  it('fails a conflicting duplicate without exposing relay text', async () => {
    const event = JSON.parse(EVENT_JSON) as Record<string, unknown>;
    const client = catchUpClientFor({
      'wss://original.example/': (subscriptionId) => [
        ['EVENT', subscriptionId, event],
        ['EOSE', subscriptionId],
      ],
      'wss://conflict.example/': (subscriptionId) => [
        [
          'EVENT',
          subscriptionId,
          { ...event, content: 'different ciphertext with the same id' },
        ],
        ['CLOSED', subscriptionId, 'relay-private reason'],
      ],
    });

    const report = await client.catchUp({
      endpoints: ['wss://original.example', 'wss://conflict.example'],
      filtersJson: '[{"kinds":[445]}]',
    });

    expect(report.failed).toContainEqual({
      code: 'conflicting_event',
      endpoint: 'wss://conflict.example/',
      message: 'Relays returned conflicting copies of one event.',
    });
    expect(JSON.stringify(report)).not.toContain('relay-private reason');
  });

  it('bounds subscription filters, events, deadlines, and cancellation', async () => {
    const event = JSON.parse(EVENT_JSON) as Record<string, unknown>;
    const secondEvent = { ...event, id: '12'.repeat(32) };
    const client = catchUpClientFor({
      'wss://overflow.example/': (subscriptionId) => [
        ['EVENT', subscriptionId, event],
        ['EVENT', subscriptionId, secondEvent],
        ['EOSE', subscriptionId],
      ],
      'wss://silent.example/': () => [],
    });

    await expect(
      client.catchUp({
        endpoints: ['wss://overflow.example'],
        filtersJson: '{}',
      }),
    ).rejects.toThrow('unsupported');
    const overflow = await client.catchUp({
      endpoints: ['wss://overflow.example'],
      filtersJson: '[{"kinds":[445]}]',
      maxEvents: 1,
    });
    expect(overflow.failed[0]?.code).toBe('event_limit_exceeded');

    const timedOut = await client.catchUp({
      endpoints: ['wss://silent.example'],
      filtersJson: '[{"kinds":[445]}]',
      timeoutMs: 5,
    });
    expect(timedOut.failed[0]?.code).toBe('subscription_timeout');

    const controller = new AbortController();
    controller.abort();
    const aborted = await client.catchUp({
      endpoints: ['wss://silent.example'],
      filtersJson: '[{"kinds":[445]}]',
      signal: controller.signal,
    });
    expect(aborted.failed[0]?.code).toBe('aborted');
  });
});

function clientFor(
  responses: Record<string, readonly unknown[] | undefined>,
): BrowserNostrRelayClient {
  const socketFactory: RelaySocketFactory = (endpoint) => {
    const listeners = new Map<
      string,
      Set<(event: Event | MessageEvent) => void>
    >();
    const emit = (type: string, event: Event | MessageEvent): void => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    queueMicrotask(() => emit('open', new Event('open')));
    return {
      readyState: 0,
      addEventListener(type, listener): void {
        const registered = listeners.get(type) ?? new Set();
        registered.add(listener);
        listeners.set(type, registered);
      },
      close(): void {},
      removeEventListener(type, listener): void {
        listeners.get(type)?.delete(listener);
      },
      send(): void {
        const response = responses[endpoint];
        if (response !== undefined) {
          queueMicrotask(() =>
            emit(
              'message',
              new MessageEvent('message', { data: JSON.stringify(response) }),
            ),
          );
        }
      },
    };
  };
  return new BrowserNostrRelayClient({ now: () => 1234, socketFactory });
}

function catchUpClientFor(
  responses: Record<
    string,
    (subscriptionId: string) => readonly (readonly unknown[])[]
  >,
): BrowserNostrRelayClient {
  const socketFactory: RelaySocketFactory = (endpoint) => {
    const listeners = new Map<
      string,
      Set<(event: Event | MessageEvent) => void>
    >();
    const emit = (type: string, event: Event | MessageEvent): void => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    queueMicrotask(() => emit('open', new Event('open')));
    return {
      readyState: 0,
      addEventListener(type, listener): void {
        const registered = listeners.get(type) ?? new Set();
        registered.add(listener);
        listeners.set(type, registered);
      },
      close(): void {},
      removeEventListener(type, listener): void {
        listeners.get(type)?.delete(listener);
      },
      send(data): void {
        const request = JSON.parse(data) as unknown;
        if (!Array.isArray(request) || request[0] !== 'REQ') return;
        const subscriptionId = request[1];
        if (typeof subscriptionId !== 'string') return;
        for (const response of responses[endpoint]?.(subscriptionId) ?? []) {
          queueMicrotask(() =>
            emit(
              'message',
              new MessageEvent('message', { data: JSON.stringify(response) }),
            ),
          );
        }
      },
    };
  };
  return new BrowserNostrRelayClient({
    now: () => 1234,
    socketFactory,
    subscriptionIdFactory: () => 'marmot-test-subscription',
  });
}
