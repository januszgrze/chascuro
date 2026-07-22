import { describe, expect, it } from 'vitest';

import {
  chatMessageId,
  conversationId,
  federationId,
  operationId,
} from '../../../domain';
import { EncryptedRecordStore } from '../encrypted-record-store';
import { MemoryVaultStore } from '../vault-store';
import {
  CHAT_PRODUCT_STATE_RECORD_ID,
  chatProductStateRecordSchema,
} from './chat-product-state-record';

describe('chatProductStateRecordSchema', () => {
  it('accepts a new conversation before it has a last message timestamp', () => {
    const state = chatProductStateRecordSchema.parse({
      formatVersion: 1,
      identityInitialized: true,
      identity: {
        address: 'npub1validpublicchatidentity',
        fingerprint: '1234 5678',
      },
      conversations: [
        {
          id: 'conversation:new',
          title: 'New conversation',
          memberCount: 2,
          unreadCount: 0,
          removed: false,
        },
      ],
      pendingInvites: [],
      handledInviteIds: [],
      messages: [],
      outbox: [],
    });
    expect(state.conversations).toEqual([
      {
        id: conversationId('conversation:new'),
        title: 'New conversation',
        memberCount: 2,
        unreadCount: 0,
        removed: false,
      },
    ]);
    expect(Object.hasOwn(state.conversations[0]!, 'lastMessageAtMs')).toBe(
      false,
    );
    expect(state).toMatchObject({
      formatVersion: 3,
      groupBindings: [],
      payments: [],
    });
  });

  it('accepts a bounded encrypted conversation-to-group binding', () => {
    const groupId = '11'.repeat(16);
    const state = chatProductStateRecordSchema.parse({
      formatVersion: 2,
      identityInitialized: true,
      identity: {
        address: 'npub1validpublicchatidentity',
        fingerprint: '1234 5678',
      },
      conversations: [
        {
          id: 'conversation:new',
          title: 'New conversation',
          memberCount: 2,
          unreadCount: 0,
          removed: false,
        },
      ],
      groupBindings: [{ conversationId: 'conversation:new', groupId }],
      pendingInvites: [],
      handledInviteIds: [],
      messages: [],
      outbox: [],
    });
    expect(state.groupBindings).toEqual([
      { conversationId: conversationId('conversation:new'), groupId },
    ]);
  });

  it('accepts Version 3 sanitized and secret-bearing payment records', () => {
    const state = chatProductStateRecordSchema.parse({
      formatVersion: 3,
      identityInitialized: true,
      identity: {
        address: 'npub1validpublicchatidentity',
        fingerprint: '1234 5678',
      },
      conversations: [
        {
          id: 'conversation:new',
          title: 'New conversation',
          memberCount: 2,
          unreadCount: 0,
          removed: false,
        },
      ],
      groupBindings: [],
      pendingInvites: [],
      handledInviteIds: [],
      messages: [],
      payments: [
        {
          id: 'payment:outgoing',
          conversationId: 'conversation:new',
          direction: 'outgoing',
          amountSats: 21,
          sentAtMs: 1_000,
          status: 'pending',
          operationKey: {
            federationId: 'federation-fixture',
            operationId: 'operation-fixture',
          },
        },
        {
          id: 'payment:incoming',
          conversationId: 'conversation:new',
          direction: 'incoming',
          amountSats: 34,
          sentAtMs: 2_000,
          status: 'claimable',
          ecashNotes: 'fedimint-ecash:34000:fixture:secret',
        },
      ],
      outbox: [],
    });

    expect(state.payments).toEqual([
      {
        id: chatMessageId('payment:outgoing'),
        conversationId: conversationId('conversation:new'),
        direction: 'outgoing',
        amountSats: 21,
        sentAtMs: 1_000,
        status: 'pending',
        operationKey: {
          federationId: federationId('federation-fixture'),
          operationId: operationId('operation-fixture'),
        },
      },
      {
        id: chatMessageId('payment:incoming'),
        conversationId: conversationId('conversation:new'),
        direction: 'incoming',
        amountSats: 34,
        sentAtMs: 2_000,
        status: 'claimable',
        ecashNotes: 'fedimint-ecash:34000:fixture:secret',
      },
    ]);
  });

  it('persists the pre-message shape as canonical encrypted JSON', async () => {
    const records = await EncryptedRecordStore.create({
      storage: new MemoryVaultStore(),
      passphrase: 'chat state schema test passphrase',
      namespace: 'chat-schema-test',
      vaultOptions: { iterations: 1 },
      recordKdfIterations: 1,
    });

    await expect(
      records.put(chatProductStateRecordSchema, CHAT_PRODUCT_STATE_RECORD_ID, {
        formatVersion: 1,
        identityInitialized: true,
        identity: {
          address: 'npub1validpublicchatidentity',
          fingerprint: '1234 5678',
        },
        conversations: [
          {
            id: 'conversation:new',
            title: 'New conversation',
            memberCount: 2,
            unreadCount: 0,
            removed: false,
          },
        ],
        pendingInvites: [],
        handledInviteIds: [],
        messages: [],
        outbox: [],
      }),
    ).resolves.toMatchObject({
      payload: { conversations: [{ id: 'conversation:new' }] },
    });
  });

  it('accepts only an exact retry event attached to a failed message', () => {
    const eventId = '22'.repeat(32);
    const eventJson = JSON.stringify({ id: eventId, kind: 445 });
    expect(
      chatProductStateRecordSchema.parse({
        formatVersion: 1,
        identityInitialized: true,
        identity: {
          address: 'npub1validpublicchatidentity',
          fingerprint: '1234 5678',
        },
        conversations: [
          {
            id: 'conversation:new',
            title: 'New conversation',
            memberCount: 2,
            unreadCount: 0,
            removed: false,
          },
        ],
        pendingInvites: [],
        handledInviteIds: [],
        messages: [
          {
            id: 'message:failed',
            conversationId: 'conversation:new',
            direction: 'outgoing',
            text: 'retry me',
            sentAtMs: 1,
            delivery: 'failed',
          },
        ],
        outbox: [
          {
            messageId: 'message:failed',
            eventId,
            eventJson,
          },
        ],
      }).outbox,
    ).toEqual([{ messageId: 'message:failed', eventId, eventJson }]);
  });
});
