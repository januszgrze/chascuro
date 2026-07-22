import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  FakeChatService,
  type FakeChatScenario,
} from '../../services/chat/fake-chat-service';
import { ChatController } from '../../services/chat/chat-controller';
import { ChatApp } from './ChatApp';
import { ChatProvider } from './ChatProvider';
import type { ChatRoute } from './chat-route';

async function mountChat(
  scenario: FakeChatScenario,
  route: ChatRoute = 'chat-list',
  configure?: (service: FakeChatService) => void,
) {
  const service = new FakeChatService({ scenario });
  await service.open({
    storageKey: new Uint8Array(32),
    signal: new AbortController().signal,
  });
  configure?.(service);
  const controller = new ChatController(service);
  controller.start();
  const onNavigate = vi.fn();
  const onExit = vi.fn();
  const utils = render(
    <ChatProvider
      controller={controller}
      location={{ route }}
      onNavigate={onNavigate}
      onExit={onExit}
    >
      <ChatApp />
    </ChatProvider>,
  );
  return { service, controller, onNavigate, onExit, ...utils };
}

describe('ChatListScreen', () => {
  it('prompts to set up chat when an identity is required', async () => {
    const user = userEvent.setup();
    const { onNavigate } = await mountChat('setup-required');

    await user.click(screen.getByRole('button', { name: 'Set up chat' }));

    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'chat-setup' }),
    );
  });

  it('shows the no-chats-yet empty state with a start-a-chat action', async () => {
    const user = userEvent.setup();
    const { onNavigate } = await mountChat('empty');

    expect(screen.getByText('No chats yet')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText('Up to date')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Start a chat' }));
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'chat-contacts' }),
    );
  });

  it('filters conversations by the search query', async () => {
    const user = userEvent.setup();
    await mountChat('two-groups');

    await user.type(
      screen.getByRole('searchbox', { name: 'Search chats' }),
      'project',
    );

    expect(screen.getByText('Project group')).toBeInTheDocument();
    expect(screen.queryByText('Primary chat')).toBeNull();
  });

  it('renders conversations and opens one without exposing its id in a link', async () => {
    const user = userEvent.setup();
    const { onNavigate } = await mountChat('two-groups');

    expect(screen.getByText('Primary chat')).toBeInTheDocument();
    expect(screen.getByText('Project group')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Primary chat/u }));

    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'chat-conversation',
        selectedConversationId: 'conversation-primary',
      }),
    );
  });

  it('lets an in-flight sync settle when the list route unmounts', async () => {
    let signal: AbortSignal | undefined;
    let settle: (() => void) | undefined;
    let synchronize: ReturnType<typeof vi.spyOn> | undefined;
    const { unmount } = await mountChat('empty', 'chat-list', (service) => {
      synchronize = vi
        .spyOn(service, 'synchronize')
        .mockImplementation((nextSignal) => {
          signal = nextSignal;
          return new Promise<void>((resolve) => {
            settle = resolve;
          });
        });
    });

    await vi.waitFor(() => expect(signal).toBeDefined());
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('focus'));
    expect(synchronize).toHaveBeenCalledTimes(1);
    unmount();

    expect(signal?.aborted).toBe(false);
    settle?.();
  });

  it('does not start foreground synchronization while the page is hidden', async () => {
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    let synchronize: ReturnType<typeof vi.spyOn> | undefined;

    const { unmount } = await mountChat('empty', 'chat-list', (service) => {
      synchronize = vi.spyOn(service, 'synchronize');
    });
    await Promise.resolve();

    expect(synchronize).not.toHaveBeenCalled();
    unmount();
    visibility.mockRestore();
  });

  it('surfaces pending invites with a count', async () => {
    await mountChat('pending-invite');

    expect(screen.getByText('Pending invites')).toBeInTheDocument();
    expect(screen.getByText('New conversation')).toBeInTheDocument();
  });

  it('announces the offline sync state', async () => {
    await mountChat('offline');

    await screen.findByText('Offline — messages send when you reconnect');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Offline — messages send when you reconnect',
    );
  });

  it('shows a degraded notice when chat storage is unavailable', async () => {
    await mountChat('degraded-storage');

    expect(screen.getByRole('alert')).toHaveTextContent('Chat is unavailable.');
    expect(screen.getByRole('status')).toHaveTextContent('Chat unavailable');
    expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
  });

  it('returns to the wallet from the list', async () => {
    const user = userEvent.setup();
    const { onExit } = await mountChat('empty');

    await user.click(screen.getByRole('button', { name: 'Back to wallet' }));

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
