import {
  chatInviteId,
  chatMessageId,
  conversationId,
  federationId,
  operationId,
  sanitizeChatText,
  type ChatDeliveryState,
  type ChatIdentitySummary,
  type ChatMessage,
  type ChatPaymentStatus,
  type ConversationSummary,
  type PendingChatInvite,
} from '../../../domain';
import type { DurableChatState } from '../../chat/chat-service';
import type { EncryptedRecordSchema } from '../encrypted-record-store';

export const CHAT_PRODUCT_STATE_RECORD_ID = 'product-state';
export const CHAT_PRODUCT_STATE_RECORD_KIND = 'chat-product-state';

const MAX_CONVERSATIONS = 256;
const MAX_INVITES = 256;
const MAX_HANDLED_INVITES = 1_024;
const MAX_MESSAGES = 10_000;
const MAX_PAYMENTS = 10_000;
const MAX_OUTBOX = 256;
const MAX_EVENT_BYTES = 1_048_576;

export const chatProductStateRecordSchema: EncryptedRecordSchema<DurableChatState> =
  Object.freeze({
    kind: CHAT_PRODUCT_STATE_RECORD_KIND,
    version: 1,
    parse(value: unknown): DurableChatState {
      if (
        !isRecord(value) ||
        (value.formatVersion !== 1 &&
          value.formatVersion !== 2 &&
          value.formatVersion !== 3)
      ) {
        invalid();
      }
      const legacy = value.formatVersion === 1;
      const stateKeys = legacy
        ? [
            'conversations',
            'formatVersion',
            'handledInviteIds',
            'identityInitialized',
            'messages',
            'outbox',
            'pendingInvites',
          ]
        : value.formatVersion === 2
          ? [
              'conversations',
              'formatVersion',
              'groupBindings',
              'handledInviteIds',
              'identityInitialized',
              'messages',
              'outbox',
              'pendingInvites',
            ]
          : [
              'conversations',
              'formatVersion',
              'groupBindings',
              'handledInviteIds',
              'identityInitialized',
              'messages',
              'outbox',
              'payments',
              'pendingInvites',
            ];
      exactKeys(
        value,
        value.identity === undefined
          ? stateKeys
          : [...stateKeys, 'identity'].sort(),
      );
      if (
        typeof value.identityInitialized !== 'boolean' ||
        !Array.isArray(value.conversations) ||
        value.conversations.length > MAX_CONVERSATIONS ||
        !Array.isArray(value.pendingInvites) ||
        value.pendingInvites.length > MAX_INVITES ||
        !Array.isArray(value.handledInviteIds) ||
        value.handledInviteIds.length > MAX_HANDLED_INVITES ||
        !Array.isArray(value.messages) ||
        value.messages.length > MAX_MESSAGES ||
        !Array.isArray(value.outbox) ||
        value.outbox.length > MAX_OUTBOX ||
        (value.formatVersion === 3 &&
          (!Array.isArray(value.payments) ||
            value.payments.length > MAX_PAYMENTS))
      ) {
        invalid();
      }
      const identity =
        value.identity === undefined
          ? undefined
          : parseIdentity(value.identity);
      if (value.identityInitialized !== (identity !== undefined)) invalid();
      const conversations = value.conversations.map(parseConversation);
      const conversationIds = new Set(conversations.map(({ id }) => id));
      if (conversationIds.size !== conversations.length) invalid();
      const groupBindings = legacy
        ? []
        : Array.isArray(value.groupBindings) &&
            value.groupBindings.length <= MAX_CONVERSATIONS
          ? value.groupBindings.map(parseGroupBinding)
          : invalid();
      if (
        new Set(groupBindings.map(({ conversationId }) => conversationId))
          .size !== groupBindings.length ||
        new Set(groupBindings.map(({ groupId }) => groupId)).size !==
          groupBindings.length ||
        groupBindings.some(
          ({ conversationId }) => !conversationIds.has(conversationId),
        )
      ) {
        invalid();
      }
      const pendingInvites = value.pendingInvites.map(parseInvite);
      if (
        new Set(pendingInvites.map(({ id }) => id)).size !==
        pendingInvites.length
      ) {
        invalid();
      }
      const handledInviteIds = value.handledInviteIds.map((id) => {
        if (typeof id !== 'string') invalid();
        return chatInviteId(id);
      });
      if (new Set(handledInviteIds).size !== handledInviteIds.length) invalid();
      const messages = value.messages.map(parseMessage);
      if (
        new Set(messages.map(({ id }) => id)).size !== messages.length ||
        messages.some(({ conversationId: id }) => !conversationIds.has(id))
      ) {
        invalid();
      }
      const payments =
        value.formatVersion === 3
          ? (value.payments as unknown[]).map(parsePayment)
          : [];
      if (
        new Set(payments.map(({ id }) => id)).size !== payments.length ||
        payments.some(({ conversationId: id }) => !conversationIds.has(id)) ||
        payments.some(({ id }) => messages.some((message) => message.id === id))
      ) {
        invalid();
      }
      const failedMessageIds = new Set([
        ...messages
          .filter(({ delivery }) => delivery === 'failed')
          .map(({ id }) => id),
        ...payments
          .filter(({ status }) => status === 'failed')
          .map(({ id }) => id),
      ]);
      const outbox = value.outbox.map(parseOutboxEntry);
      if (
        new Set(outbox.map(({ messageId }) => messageId)).size !==
          outbox.length ||
        new Set(outbox.map(({ eventId }) => eventId)).size !== outbox.length ||
        outbox.some(({ messageId }) => !failedMessageIds.has(messageId))
      ) {
        invalid();
      }
      return Object.freeze({
        formatVersion: 3,
        identityInitialized: value.identityInitialized,
        ...(identity === undefined ? {} : { identity }),
        conversations: Object.freeze(conversations),
        groupBindings: Object.freeze(groupBindings),
        pendingInvites: Object.freeze(pendingInvites),
        handledInviteIds: Object.freeze(handledInviteIds),
        messages: Object.freeze(messages),
        payments: Object.freeze(payments),
        outbox: Object.freeze(outbox),
      });
    },
  });

function parseGroupBinding(
  value: unknown,
): DurableChatState['groupBindings'][number] {
  if (!isRecord(value)) invalid();
  exactKeys(value, ['conversationId', 'groupId']);
  if (
    typeof value.conversationId !== 'string' ||
    typeof value.groupId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(value.groupId)
  ) {
    invalid();
  }
  return Object.freeze({
    conversationId: conversationId(value.conversationId),
    groupId: value.groupId,
  });
}

function parsePayment(value: unknown): DurableChatState['payments'][number] {
  if (!isRecord(value)) invalid();
  const hasNotes = value.ecashNotes !== undefined;
  const hasOperation = value.operationKey !== undefined;
  exactKeys(value, [
    'amountSats',
    'conversationId',
    'direction',
    ...(hasNotes ? ['ecashNotes'] : []),
    'id',
    ...(hasOperation ? ['operationKey'] : []),
    'sentAtMs',
    'status',
  ]);
  if (
    typeof value.id !== 'string' ||
    typeof value.conversationId !== 'string' ||
    (value.direction !== 'incoming' && value.direction !== 'outgoing') ||
    !isInteger(value.amountSats, 1, 2_100_000_000_000_000) ||
    !isTimestamp(value.sentAtMs) ||
    !isPaymentStatus(value.status) ||
    (hasNotes &&
      (typeof value.ecashNotes !== 'string' ||
        value.ecashNotes.length < 1 ||
        new TextEncoder().encode(value.ecashNotes).length > 15_000))
  ) {
    invalid();
  }
  if (
    (value.direction === 'incoming' &&
      ((value.status === 'claimable') !== hasNotes || hasOperation)) ||
    (value.direction === 'outgoing' &&
      (!hasOperation || hasNotes || value.status === 'claimable'))
  ) {
    invalid();
  }
  let operationKey;
  if (hasOperation) {
    if (!isRecord(value.operationKey)) invalid();
    exactKeys(value.operationKey, ['federationId', 'operationId']);
    if (
      typeof value.operationKey.federationId !== 'string' ||
      typeof value.operationKey.operationId !== 'string'
    ) {
      invalid();
    }
    operationKey = Object.freeze({
      federationId: federationId(value.operationKey.federationId),
      operationId: operationId(value.operationKey.operationId),
    });
  }
  return Object.freeze({
    id: chatMessageId(value.id),
    conversationId: conversationId(value.conversationId),
    direction: value.direction,
    amountSats: value.amountSats,
    sentAtMs: value.sentAtMs,
    status: value.status,
    ...(operationKey === undefined ? {} : { operationKey }),
    ...(hasNotes ? { ecashNotes: value.ecashNotes as string } : {}),
  });
}

function isPaymentStatus(value: unknown): value is ChatPaymentStatus {
  return (
    value === 'pending' ||
    value === 'claimable' ||
    value === 'claimed' ||
    value === 'failed'
  );
}

function parseIdentity(value: unknown): ChatIdentitySummary {
  if (!isRecord(value)) invalid();
  exactKeys(value, ['address', 'fingerprint']);
  if (
    typeof value.address !== 'string' ||
    value.address.length < 10 ||
    value.address.length > 512 ||
    typeof value.fingerprint !== 'string' ||
    value.fingerprint.length < 8 ||
    value.fingerprint.length > 128
  ) {
    invalid();
  }
  return Object.freeze({
    address: value.address,
    fingerprint: value.fingerprint,
  });
}

function parseOutboxEntry(value: unknown): DurableChatState['outbox'][number] {
  if (!isRecord(value)) invalid();
  exactKeys(value, ['eventId', 'eventJson', 'messageId']);
  if (
    typeof value.messageId !== 'string' ||
    typeof value.eventId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.eventId) ||
    typeof value.eventJson !== 'string' ||
    new TextEncoder().encode(value.eventJson).length > MAX_EVENT_BYTES
  ) {
    invalid();
  }
  let event: unknown;
  try {
    event = JSON.parse(value.eventJson);
  } catch {
    invalid();
  }
  if (!isRecord(event) || event.id !== value.eventId) invalid();
  return Object.freeze({
    messageId: chatMessageId(value.messageId),
    eventId: value.eventId,
    eventJson: value.eventJson,
  });
}

function parseConversation(value: unknown): ConversationSummary {
  if (!isRecord(value)) invalid();
  exactKeys(
    value,
    value.lastMessageAtMs === undefined
      ? ['id', 'memberCount', 'removed', 'title', 'unreadCount']
      : [
          'id',
          'lastMessageAtMs',
          'memberCount',
          'removed',
          'title',
          'unreadCount',
        ],
  );
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    value.title.length < 1 ||
    value.title.length > 80 ||
    !isInteger(value.memberCount, 1, 256) ||
    !isInteger(value.unreadCount, 0, 100_000) ||
    typeof value.removed !== 'boolean' ||
    (value.lastMessageAtMs !== undefined && !isTimestamp(value.lastMessageAtMs))
  ) {
    invalid();
  }
  return Object.freeze({
    id: conversationId(value.id),
    title: sanitizeChatText(value.title, 80),
    memberCount: value.memberCount,
    unreadCount: value.unreadCount,
    ...(value.lastMessageAtMs === undefined
      ? {}
      : { lastMessageAtMs: value.lastMessageAtMs }),
    removed: value.removed,
  });
}

function parseInvite(value: unknown): PendingChatInvite {
  if (!isRecord(value)) invalid();
  exactKeys(value, ['id', 'inviterLabel', 'receivedAtMs', 'title']);
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    value.title.length < 1 ||
    value.title.length > 80 ||
    typeof value.inviterLabel !== 'string' ||
    value.inviterLabel.length < 1 ||
    value.inviterLabel.length > 128 ||
    !isTimestamp(value.receivedAtMs)
  ) {
    invalid();
  }
  return Object.freeze({
    id: chatInviteId(value.id),
    title: sanitizeChatText(value.title, 80),
    inviterLabel: sanitizeChatText(value.inviterLabel, 128),
    receivedAtMs: value.receivedAtMs,
  });
}

function parseMessage(value: unknown): ChatMessage {
  if (!isRecord(value)) invalid();
  exactKeys(value, [
    'conversationId',
    'delivery',
    'direction',
    'id',
    'sentAtMs',
    'text',
  ]);
  if (
    typeof value.id !== 'string' ||
    typeof value.conversationId !== 'string' ||
    (value.direction !== 'incoming' && value.direction !== 'outgoing') ||
    typeof value.text !== 'string' ||
    !isTimestamp(value.sentAtMs) ||
    !isDelivery(value.delivery)
  ) {
    invalid();
  }
  return Object.freeze({
    id: chatMessageId(value.id),
    conversationId: conversationId(value.conversationId),
    direction: value.direction,
    text: sanitizeChatText(value.text),
    sentAtMs: value.sentAtMs,
    delivery: value.delivery,
  });
}

function isDelivery(value: unknown): value is ChatDeliveryState {
  return (
    value === 'pending' ||
    value === 'published' ||
    value === 'failed' ||
    value === 'received'
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
}

function isInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new TypeError('Invalid durable chat product state.');
}
