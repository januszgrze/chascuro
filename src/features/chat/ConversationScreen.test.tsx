import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  chatMessageId,
  clearableSecretText,
  conversationId,
  federationId,
  operationId,
} from '../../domain';
import { ChatController } from '../../services/chat/chat-controller';
import {
  FakeChatService,
  type FakeChatScenario,
} from '../../services/chat/fake-chat-service';
import { ChatApp } from './ChatApp';
import { ChatProvider } from './ChatProvider';
import type { ChatWalletPaymentBridge } from './chat-context';

const PRIMARY = conversationId('conversation-primary');

async function mountConversation(
  scenario: FakeChatScenario,
  prepare?: (service: FakeChatService) => Promise<void>,
  walletPayments?: ChatWalletPaymentBridge,
) {
  const service = new FakeChatService({
    scenario,
    now: () => 1_700_000_000_000,
  });
  await service.open({
    storageKey: new Uint8Array(32),
    signal: new AbortController().signal,
  });
  await prepare?.(service);
  const controller = new ChatController(service);
  controller.start();
  const onNavigate = vi.fn();
  render(
    <ChatProvider
      controller={controller}
      location={{
        route: 'chat-conversation',
        selectedConversationId: PRIMARY,
      }}
      onNavigate={onNavigate}
      onExit={vi.fn()}
      walletPayments={walletPayments}
    >
      <ChatApp />
    </ChatProvider>,
  );
  return { service, controller, onNavigate };
}

describe('ConversationScreen', () => {
  it('loads history and returns to the conversation list', async () => {
    const user = userEvent.setup();
    const { onNavigate } = await mountConversation('two-groups');

    expect(
      await screen.findByText('Did you get the latest update?'),
    ).toBeInTheDocument();
    expect(screen.getByText('Yes — testing it now.')).toBeInTheDocument();
    expect(screen.getByText('Published to relay')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to chats' }));
    expect(onNavigate).toHaveBeenCalledWith({
      route: 'chat-list',
      selectedConversationId: undefined,
    });
  });

  it('sends bounded text and labels relay publication honestly', async () => {
    const user = userEvent.setup();
    await mountConversation('two-groups');
    await screen.findByText('Did you get the latest update?');

    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'A new message');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('A new message')).toBeInTheDocument();
    expect(screen.getAllByText('Published to relay')).toHaveLength(2);
    expect(composer).toHaveValue('');
  });

  it('uses the wallet bridge for ecash send and claim cards', async () => {
    const user = userEvent.setup();
    const send = vi.fn<ChatWalletPaymentBridge['send']>().mockResolvedValue({
      ok: true,
      value: {
        kind: 'sent',
        payment: {
          id: chatMessageId('payment:wallet-send'),
          conversationId: PRIMARY,
          direction: 'outgoing',
          amountSats: 21,
          sentAtMs: 1_700_000_000_000,
          status: 'pending',
          operationKey: {
            federationId: federationId('federation-fixture'),
            operationId: operationId('operation-fixture'),
          },
        },
      },
    });
    const claim = vi
      .fn<ChatWalletPaymentBridge['claim']>()
      .mockResolvedValue({ ok: true, value: undefined });
    await mountConversation('two-groups', undefined, {
      operations: [],
      send,
      claim,
    });
    await screen.findByText('Did you get the latest update?');

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Pay/u }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'Send payment' }));

    expect(send).toHaveBeenCalledWith(PRIMARY, '21');
    expect(
      await screen.findByRole('dialog', { name: 'Payment sent' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Claim' }));
    expect(claim).toHaveBeenCalledWith(chatMessageId('payment-demo-received'));
  });

  it('keeps an unsent memory-only ecash export visible until explicitly closed', async () => {
    const user = userEvent.setup();
    const notes = clearableSecretText('fedimint-ecash:21000:test:recovery');
    const clear = vi.spyOn(notes, 'clear');
    const send = vi.fn<ChatWalletPaymentBridge['send']>().mockResolvedValue({
      ok: true,
      value: {
        kind: 'recovery_required',
        export: {
          operation: {
            key: {
              federationId: federationId('federation-fixture'),
              operationId: operationId('operation-recovery'),
            },
            kind: 'ecash_send',
            status: 'pending',
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
          },
          notes,
          secretRecordRef: 'secret-recovery' as never,
          secretStorage: 'memory_only',
        },
      },
    });
    await mountConversation('two-groups', undefined, {
      operations: [],
      send,
      claim: vi.fn(),
    });
    await screen.findByText('Did you get the latest update?');

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Pay/u }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: 'Send payment' }));

    expect(
      await screen.findByRole('dialog', { name: 'Ecash recovery required' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Payment sent' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'this payment was not sent',
    );
    expect(clear).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: 'I saved it — close' }),
    );
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('sends with Enter while Shift+Enter keeps a draft newline', async () => {
    const user = userEvent.setup();
    await mountConversation('two-groups');
    await screen.findByText('Did you get the latest update?');

    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'First line{shift>}{enter}{/shift}Second line');
    expect(composer).toHaveValue('First line\nSecond line');

    await user.type(composer, '{enter}');
    expect(
      await screen.findByText(/First line\s+Second line/u),
    ).toBeInTheDocument();
    expect(composer).toHaveValue('');
  });

  it('shows failed publication and retries the exact message', async () => {
    const user = userEvent.setup();
    await mountConversation('retryable-publish-failure');
    await screen.findByText('Did you get the latest update?');

    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'Please retry this',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Not published')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByText('Published to relay')).toHaveLength(2);
    expect(screen.queryByText('Not published')).not.toBeInTheDocument();
  });

  it('queues offline messages without claiming delivery', async () => {
    const user = userEvent.setup();
    await mountConversation('offline');
    await screen.findByText('Did you get the latest update?');

    expect(screen.getByRole('status')).toHaveTextContent(
      'Offline — new messages wait for a connection',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'Send later',
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Send later')).toBeInTheDocument();
    expect(screen.getAllByText('Queued until online')).toHaveLength(2);
  });

  it('keeps saved history readable but disables sending after removal', async () => {
    await mountConversation('removed-member');

    expect(
      await screen.findByText('This history remains visible after leaving.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'You left this conversation',
    );
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('paginates and deduplicates message history', async () => {
    const user = userEvent.setup();
    await mountConversation('two-groups', async (service) => {
      for (let index = 0; index < 22; index += 1) {
        await service.sendMessage({
          conversationId: PRIMARY,
          text: `bulk-${index}`,
          signal: new AbortController().signal,
        });
      }
    });

    await screen.findByText('bulk-17');
    expect(screen.queryByText('bulk-21')).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Load more messages' }),
    );
    expect(await screen.findByText('bulk-21')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more messages' }),
    ).toBeNull();
  });

  it('rejects drafts over the 4 KiB UTF-8 limit', async () => {
    const user = userEvent.setup();
    await mountConversation('two-groups');
    await screen.findByText('Did you get the latest update?');

    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.click(composer);
    await user.paste('😀'.repeat(1_025));

    expect(screen.getByText('4100 / 4096 bytes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});
