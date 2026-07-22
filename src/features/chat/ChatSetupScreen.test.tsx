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

vi.mock('../shared/QrCode', () => ({
  QrCode: ({ value, label }: { value: string; label: string }) => (
    <output aria-label={label}>{value}</output>
  ),
}));

async function mountSetup(scenario: FakeChatScenario) {
  const service = new FakeChatService({ scenario });
  await service.open({
    storageKey: new Uint8Array(32),
    signal: new AbortController().signal,
  });
  const controller = new ChatController(service);
  controller.start();
  const onNavigate = vi.fn();
  const onExit = vi.fn();
  render(
    <ChatProvider
      controller={controller}
      location={{ route: 'chat-setup' }}
      onNavigate={onNavigate}
      onExit={onExit}
    >
      <ChatApp />
    </ChatProvider>,
  );
  return { service, controller, onNavigate, onExit };
}

describe('ChatSetupScreen', () => {
  it('shows the public address and fingerprint once available, never secret material', async () => {
    await mountSetup('empty');

    expect(
      screen.getByRole('heading', { name: 'Your chat address' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText('npub1fakechatapplicationboundary').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('FAKE-CHAT-0001')).toBeInTheDocument();
  });

  it('requires explicit consent before creating an identity', async () => {
    const user = userEvent.setup();
    await mountSetup('setup-required');

    expect(screen.getByText('No backup yet')).toBeInTheDocument();

    const create = screen.getByRole('button', { name: 'Create chat identity' });
    expect(create).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(create).toBeEnabled();

    await user.click(create);

    expect(
      await screen.findByRole('heading', { name: 'Your chat address' }),
    ).toBeInTheDocument();
  });
});
