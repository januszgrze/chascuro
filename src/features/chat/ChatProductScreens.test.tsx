import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  chatAddressFromPublicKey,
  chatInviteId,
  conversationId,
} from '../../domain';
import { ChatController } from '../../services/chat/chat-controller';
import {
  FakeChatService,
  type FakeChatScenario,
} from '../../services/chat/fake-chat-service';
import { ChatApp } from './ChatApp';
import { ChatProvider } from './ChatProvider';
import type { ChatLocation } from './chat-route';

async function mountChat(scenario: FakeChatScenario, location: ChatLocation) {
  const service = new FakeChatService({ scenario });
  await service.open({
    storageKey: new Uint8Array(32),
    signal: new AbortController().signal,
  });
  const controller = new ChatController(service);
  controller.start();
  const onNavigate = vi.fn();
  const utils = render(
    <ChatProvider
      controller={controller}
      location={location}
      onNavigate={onNavigate}
      onExit={vi.fn()}
    >
      <ChatApp />
    </ChatProvider>,
  );
  return { service, controller, onNavigate, ...utils };
}

describe('chat product screens', () => {
  it('opens contact review from a pasted address without sample contacts', async () => {
    const user = userEvent.setup();
    const { onNavigate } = await mountChat('empty', {
      route: 'chat-contacts',
    });
    const address = chatAddressFromPublicKey('22'.repeat(32));

    expect(screen.queryByText('Marisol Vega')).not.toBeInTheDocument();
    await user.type(
      screen.getByRole('searchbox', {
        name: 'Search a name or paste an invite',
      }),
      address.address,
    );
    await user.click(screen.getByRole('button', { name: 'Start a chat' }));

    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'chat-invite-review',
        pendingContactAddress: address.address,
      }),
    );
  });

  it('returns from the scan screen to manual entry', async () => {
    const user = userEvent.setup();
    const { onNavigate } = await mountChat('empty', { route: 'chat-scan' });

    expect(
      screen.getByRole('heading', { name: 'Add contact' }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Enter address manually' }),
    );

    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'chat-contacts' }),
    );
  });

  it('reviews a contact fingerprint and creates the invite', async () => {
    const user = userEvent.setup();
    const address = chatAddressFromPublicKey('11'.repeat(32));
    const { onNavigate } = await mountChat('empty', {
      route: 'chat-invite-review',
      pendingContactAddress: address.address,
      pendingContactLabel: 'Alice',
    });

    expect(screen.getByText(address.fingerprint)).toBeInTheDocument();
    expect(screen.getByText('relay.example')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create invite' }));

    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          route: 'chat-conversation',
          selectedConversationId: 'fake-1',
        }),
      ),
    );
  });

  it('accepts a selected pending invite and opens the joined conversation', async () => {
    const user = userEvent.setup();
    const { onNavigate } = await mountChat('pending-invite', {
      route: 'chat-invite-review',
      selectedInviteId: chatInviteId('invite-primary'),
    });

    expect(screen.getByText('Known contact')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));

    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          route: 'chat-conversation',
          selectedConversationId: 'fake-1',
        }),
      ),
    );
  });

  it('declines a selected pending invite and returns to the list', async () => {
    const user = userEvent.setup();
    const { onNavigate } = await mountChat('pending-invite', {
      route: 'chat-invite-review',
      selectedInviteId: chatInviteId('invite-primary'),
    });

    await user.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        expect.objectContaining({ route: 'chat-list' }),
      ),
    );
  });

  it('requires destructive confirmation before leaving a conversation', async () => {
    const user = userEvent.setup();
    const { service, onNavigate } = await mountChat('two-groups', {
      route: 'chat-details',
      selectedConversationId: conversationId('conversation-primary'),
    });
    const leave = vi.spyOn(service, 'leaveConversation');
    const button = screen.getByRole('button', { name: 'Leave conversation' });

    expect(button).toBeDisabled();
    await user.click(
      screen.getByLabelText(
        'I understand I cannot undo leaving from this device.',
      ),
    );
    await user.click(button);

    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        expect.objectContaining({ route: 'chat-list' }),
      ),
    );
  });
});
