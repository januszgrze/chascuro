import { describe, expect, it } from 'vitest';

import { parseMdkProductResult } from './mdk-product-rpc-client';

describe('parseMdkProductResult', () => {
  it('keeps MDK group ids distinct from 32-byte Nostr identifiers', () => {
    const groupId = '11'.repeat(16);
    const nostrIdentifier = '22'.repeat(32);

    expect(
      parseMdkProductResult({
        epoch: 1,
        groupCount: 1,
        groupId,
        memberCount: 2,
        nostrPubkey: nostrIdentifier,
        pendingPublishRecovered: false,
        routingGroupId: nostrIdentifier,
        groups: [
          {
            epoch: 1,
            groupId,
            memberCount: 2,
            routingGroupId: nostrIdentifier,
          },
        ],
        storageGeneration: 3,
        received: [
          {
            groupId,
            id: nostrIdentifier,
            sender: nostrIdentifier,
            createdAt: 1_700_000_000,
            content: 'hello',
          },
        ],
      }),
    ).toMatchObject({
      groupId,
      routingGroupId: nostrIdentifier,
      received: [{ groupId }],
    });
  });

  it('rejects a Nostr-sized value in the MDK group-id field', () => {
    const nostrIdentifier = '22'.repeat(32);
    expect(() =>
      parseMdkProductResult({
        epoch: 1,
        groupCount: 1,
        groupId: nostrIdentifier,
        memberCount: 2,
        nostrPubkey: nostrIdentifier,
        pendingPublishRecovered: false,
        routingGroupId: nostrIdentifier,
        groups: [],
        storageGeneration: 3,
      }),
    ).toThrow('Invalid 16-byte group identifier.');
  });

  it('validates the exact opaque event retained for durable retry', () => {
    const eventId = '22'.repeat(32);
    const eventJson = JSON.stringify({ id: eventId, kind: 445 });
    expect(
      parseMdkProductResult({
        epoch: 1,
        groupCount: 1,
        groupId: '11'.repeat(16),
        memberCount: 2,
        nostrPubkey: eventId,
        pendingPublishRecovered: false,
        routingGroupId: eventId,
        groups: [
          {
            epoch: 1,
            groupId: '11'.repeat(16),
            memberCount: 2,
            routingGroupId: eventId,
          },
        ],
        storageGeneration: 3,
        eventId,
        eventJson,
        published: false,
      }),
    ).toMatchObject({ eventId, eventJson, published: false });
  });
});
