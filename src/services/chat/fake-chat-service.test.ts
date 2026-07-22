import { describe, expect, it } from 'vitest';

import {
  ChatError,
  chatInviteId,
  chatMessageId,
  clearableSecretText,
  conversationId,
  federationId,
  operationId,
} from '../../domain';
import { FakeChatService } from './fake-chat-service';

const KEY = new Uint8Array(32).fill(7);

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function open(service: FakeChatService): Promise<void> {
  await service.open({ storageKey: KEY, signal: signal() });
}

describe('FakeChatService', () => {
  it('transitions from setup-required to an available independent identity', async () => {
    const service = new FakeChatService({ scenario: 'setup-required' });
    await expect(
      service.open({ storageKey: KEY, signal: signal() }),
    ).resolves.toEqual({ status: 'setup_required' });

    await expect(service.initializeIdentity(signal())).resolves.toMatchObject({
      fingerprint: 'FAKE-CHAT-0001',
    });
    expect(service.getSnapshot().availability.status).toBe('available');
  });

  it('creates conversations and accepts or declines bounded pending invites', async () => {
    const service = new FakeChatService({ scenario: 'pending-invite' });
    await open(service);
    const accepted = await service.acceptInvite(
      chatInviteId('invite-primary'),
      signal(),
    );
    expect(service.getSnapshot()).toMatchObject({
      conversations: [{ id: accepted, title: 'New conversation' }],
      pendingInvites: [],
    });
    await expect(
      service.declineInvite(chatInviteId('invite-primary'), signal()),
    ).rejects.toMatchObject({ code: 'invite_invalid' });

    const created = await service.createConversation({
      title: 'Direct chat',
      inviteAddress: 'npub1boundedfixture',
      signal: signal(),
    });
    expect(
      service.getSnapshot().conversations.some(({ id }) => id === created),
    ).toBe(true);
  });

  it('records publish failure and retries the exact message once', async () => {
    const service = new FakeChatService({
      scenario: 'retryable-publish-failure',
    });
    await open(service);
    const conversation = conversationId('conversation-primary');
    const failed = await service.sendMessage({
      conversationId: conversation,
      text: 'retry me',
      signal: signal(),
    });
    expect(failed.delivery).toBe('failed');
    await expect(
      service.retryMessage(failed.id, signal()),
    ).resolves.toMatchObject({
      id: failed.id,
      delivery: 'published',
    });
    await expect(
      service.retryMessage(chatMessageId('message-missing'), signal()),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('deduplicates and orders received messages before pagination', async () => {
    const service = new FakeChatService({ scenario: 'duplicate-reordered' });
    await open(service);
    await service.synchronize(signal());
    const conversation = conversationId('conversation-primary');
    const first = await service.listMessages({
      conversationId: conversation,
      limit: 1,
      signal: signal(),
    });
    expect(first.messages.map(({ text }) => text)).toEqual(['first']);
    expect(first.nextCursor).toBe('offset:1');
    const second = await service.listMessages({
      conversationId: conversation,
      cursor: first.nextCursor,
      limit: 10,
      signal: signal(),
    });
    expect(second.messages.map(({ text }) => text)).toEqual(['second']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('backs deterministic payment cards with clearable ecash claims', async () => {
    const service = new FakeChatService({ scenario: 'two-groups' });
    await open(service);
    const conversation = conversationId('conversation-primary');
    const initial = await service.listPayments(conversation, signal());
    const claimable = initial.find(({ status }) => status === 'claimable')!;
    const prepared = await service.preparePaymentClaim(claimable.id, signal());
    expect(prepared.notes.reveal()).toContain('fedimint-ecash:20000000');
    prepared.notes.clear();
    await service.markPaymentClaimed(claimable.id, signal());
    await expect(service.listPayments(conversation, signal())).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: claimable.id, status: 'claimed' }),
      ]),
    );

    const notes = clearableSecretText(
      'fedimint-ecash:5000:demo-fedimint-federation:outgoing',
    );
    await expect(
      service.sendPayment({
        conversationId: conversation,
        amountSats: 5,
        notes,
        operationKey: {
          federationId: federationId('demo-fedimint-federation'),
          operationId: operationId('payment-operation'),
        },
        signal: signal(),
      }),
    ).resolves.toMatchObject({ amountSats: 5, status: 'pending' });
    expect(notes.length).toBe(0);
  });

  it('fails closed for offline, removed, degraded, aborted, and locked states', async () => {
    const offline = new FakeChatService({ scenario: 'offline' });
    await open(offline);
    await expect(offline.synchronize(signal())).rejects.toMatchObject({
      code: 'offline',
    });

    const removed = new FakeChatService({ scenario: 'removed-member' });
    await open(removed);
    await expect(
      removed.sendMessage({
        conversationId: conversationId('conversation-primary'),
        text: 'blocked',
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: 'removed_member' });

    const degraded = new FakeChatService({ scenario: 'degraded-storage' });
    await open(degraded);
    await expect(degraded.synchronize(signal())).rejects.toMatchObject({
      code: 'storage_corrupt',
    });

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      new FakeChatService().open({ storageKey: KEY, signal: aborted.signal }),
    ).rejects.toHaveProperty('name', 'AbortError');

    removed.quiesce();
    await expect(removed.synchronize(signal())).rejects.toBeInstanceOf(
      ChatError,
    );
    await removed.stop();
    removed.lock();
    await expect(removed.initializeIdentity(signal())).rejects.toMatchObject({
      code: 'locked',
    });
  });
});
